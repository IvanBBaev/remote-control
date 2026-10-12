#!/usr/bin/env node
// Static argv/policy gate for the agent (D13, 02 W11). Fails the build when:
//   1. a module other than the process modules imports child_process. The process
//      modules are `adapters/claude-code/spawn.ts` (starts `claude`) and
//      `adapters/launchd/launchctl.ts` (runs `/bin/launchctl` for the service, M0-24, D22);
//   2. a process module imports anything but `spawn`, builds argv other than as a literal
//      array returned by an `...Argv` function, or enables a shell; `launchctl.ts` must
//      also name its executable as the literal `/bin/launchctl`;
//   3. any agent source contains a forbidden permission token, or `updatedInput` outside
//      `claude-code/decide.ts` (D11).
// Usage: node scripts/check-argv-policy.mjs [sourceDir]   (default: ../src)
// Test files (`*.test.ts`) are not shipped and are not scanned.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const SPAWN_MODULE = 'adapters/claude-code/spawn.ts';
const LAUNCHCTL_MODULE = 'adapters/launchd/launchctl.ts';
/**
 * Modules (paths relative to the source root, exact match) allowed to import
 * child_process, with the executable each must name when it is fixed.
 */
const PROCESS_MODULES = new Map([
  [SPAWN_MODULE, { command: undefined }],
  [LAUNCHCTL_MODULE, { command: '/bin/launchctl' }],
]);
const DECIDE_MODULE = 'claude-code/decide.ts';
const CHILD_PROCESS = new Set(['child_process', 'node:child_process']);
const FORBIDDEN_TOKENS = [
  '--dangerously-skip-permissions',
  'bypassPermissions',
  '--allowedTools',
  '--settings',
  '--permission-mode',
];

function listSources(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => /\.(?:[cm]?[jt]s)$/.test(file) && !/\.test\.[cm]?[jt]s$/.test(file));
}

function moduleSpecifiers(source) {
  const found = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push({ name: node.moduleSpecifier.text, node });
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression)) {
        found.push({ name: ref.expression.text, node });
      }
    } else if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isImport || isRequire) {
        found.push({
          name: first && ts.isStringLiteralLike(first) ? first.text : '<dynamic>',
          node,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function line(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function checkSpawnModule(source, report, rule) {
  const argvFunctions = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && CHILD_PROCESS.has(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      const names =
        bindings && ts.isNamedImports(bindings)
          ? bindings.elements.map((element) => (element.propertyName ?? element.name).text)
          : ['<default or namespace import>'];
      for (const name of names) {
        if (name !== 'spawn')
          report(line(source, node), `child_process import "${name}" (only spawn)`);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text.endsWith('Argv')) {
      argvFunctions.add(node.name.text);
      const statements = node.body?.statements ?? [];
      const [only] = statements;
      const literal =
        statements.length === 1 && ts.isReturnStatement(only) ? only.expression : undefined;
      if (!literal || !ts.isArrayLiteralExpression(literal)) {
        report(line(source, node), `${node.name.text} must be a single "return [ ... ]"`);
      } else {
        const [head] = literal.elements;
        if (!head || !ts.isStringLiteral(head)) {
          report(line(source, node), `${node.name.text}: argv must start with a literal flag`);
        }
        for (const element of literal.elements) {
          if (ts.isSpreadElement(element)) {
            report(line(source, element), `${node.name.text}: spread in argv`);
          }
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'spawn'
    ) {
      const [command, args, options] = node.arguments;
      if (
        rule.command !== undefined &&
        (!command || !ts.isStringLiteral(command) || command.text !== rule.command)
      ) {
        report(line(source, node), `spawn command must be the literal "${rule.command}"`);
      }
      if (!args || !ts.isIdentifier(args) || args.text !== 'argv') {
        report(
          line(source, node),
          'spawn argv must be the `argv` constant from an ...Argv builder',
        );
      }
      if (!options || !ts.isObjectLiteralExpression(options)) {
        report(line(source, node), 'spawn options must be an object literal with shell: false');
      } else {
        const shell = options.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === 'shell',
        );
        if (!shell || shell.initializer.kind !== ts.SyntaxKind.FalseKeyword) {
          report(line(source, node), 'spawn must pass shell: false');
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'argv') {
      const init = node.initializer;
      const ok =
        init &&
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        init.expression.text.endsWith('Argv');
      if (!ok) report(line(source, node), '`argv` must be the result of an ...Argv builder');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return argvFunctions;
}

/** Returns the list of violations (`file:line: message`) for a source directory. */
export function checkArgvPolicy(sourceDir) {
  const violations = [];
  for (const file of listSources(sourceDir)) {
    const rel = relative(sourceDir, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    const report = (lineNo, message) => violations.push(`${rel}:${lineNo}: ${message}`);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const processRule = PROCESS_MODULES.get(rel);
    for (const { name, node } of moduleSpecifiers(source)) {
      if (name === '<dynamic>') report(line(source, node), 'dynamic import/require specifier');
      if (CHILD_PROCESS.has(name) && processRule === undefined) {
        report(
          line(source, node),
          `imports ${name} (only ${SPAWN_MODULE} and ${LAUNCHCTL_MODULE} may)`,
        );
      }
    }
    if (processRule !== undefined) checkSpawnModule(source, report, processRule);
    text.split('\n').forEach((content, index) => {
      for (const token of FORBIDDEN_TOKENS) {
        if (content.includes(token)) report(index + 1, `forbidden token ${token}`);
      }
      const isDecide = rel === DECIDE_MODULE || rel.endsWith(`/${DECIDE_MODULE}`);
      if (content.includes('updatedInput') && !isDecide) {
        report(index + 1, `updatedInput outside ${DECIDE_MODULE}`);
      }
    });
  }
  return violations;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceDir = resolve(process.argv[2] ?? fileURLToPath(new URL('../src', import.meta.url)));
  const violations = checkArgvPolicy(sourceDir);
  if (violations.length > 0) {
    process.stderr.write(`argv policy: ${violations.length} violation(s)\n`);
    for (const violation of violations) process.stderr.write(`  ${violation}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`argv policy: ok (${sourceDir})\n`);
  }
}
