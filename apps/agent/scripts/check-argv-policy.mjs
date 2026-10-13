#!/usr/bin/env node
// Static argv/policy gate for the agent (D13, 02 W11). Fails the build when:
//   1. a module other than the process modules imports child_process. The process
//      modules are `adapters/claude-code/spawn.ts` (starts `claude`) and the service
//      managers (D22): `adapters/launchd/launchctl.ts` (`/bin/launchctl`, M0-24),
//      `adapters/systemd/systemctl.ts` (`/usr/bin/systemctl`, `/usr/bin/loginctl`) and
//      `adapters/windows/schtasks.ts` (`C:\Windows\System32\schtasks.exe`, M1-08);
//   2. a process module imports anything but `spawn`, builds argv other than as a literal
//      array returned by an `...Argv` function, or enables a shell; a service-manager
//      module must also name every executable as one of its allowed literal paths;
//   3. any agent source contains a forbidden permission token. `--permission-mode` (M2-09)
//      is the one exception, and only in `adapters/claude-code/spawn.ts`: there it must
//      appear exactly once, as a string literal inside the array an `...Argv` builder
//      returns, and nowhere else in that file (not even in a comment);
//   4. `updatedInput` (D11, M1-01) appears outside `adapters/claude-code/decide.ts` — in
//      code, comments or strings, test files included except that module's own test and
//      this gate's test — or, inside it, other than as one object property named once,
//      in a function that compares the tool name with `ASK_USER_QUESTION`.
// Usage: node scripts/check-argv-policy.mjs [sourceDir]   (default: ../src)
// Test files (`*.test.ts`) are not shipped: only rule 4 scans them.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/**
 * Modules (paths relative to the source root, exact match) allowed to import
 * child_process, with the literal executables each may spawn (`undefined`: any command,
 * for `claude`, whose location is resolved at run time).
 */
const PROCESS_MODULES = new Map([
  ['adapters/claude-code/spawn.ts', { commands: undefined }],
  ['adapters/launchd/launchctl.ts', { commands: new Set(['/bin/launchctl']) }],
  [
    'adapters/systemd/systemctl.ts',
    { commands: new Set(['/usr/bin/systemctl', '/usr/bin/loginctl']) },
  ],
  ['adapters/windows/schtasks.ts', { commands: new Set(['C:\\Windows\\System32\\schtasks.exe']) }],
]);
const PROCESS_MODULE_LIST = [...PROCESS_MODULES.keys()].join(', ');
const DECIDE_MODULE = 'adapters/claude-code/decide.ts';
const UPDATED_INPUT = 'updatedInput';
/** Test files that may name `updatedInput`: the decide module's test and this gate's. */
const UPDATED_INPUT_TESTS = new Set(['adapters/claude-code/decide.test.ts', 'argv-policy.test.ts']);
const ASK_USER_QUESTION = new Set(['ASK_USER_QUESTION', "'AskUserQuestion'"]);
const CHILD_PROCESS = new Set(['child_process', 'node:child_process']);
const SPAWN_MODULE = 'adapters/claude-code/spawn.ts';
const PERMISSION_MODE_FLAG = '--permission-mode';
const FORBIDDEN_TOKENS = [
  '--dangerously-skip-permissions',
  'bypassPermissions',
  'dontAsk',
  '--allowedTools',
  '--settings',
  PERMISSION_MODE_FLAG,
];

function listSources(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => /\.(?:[cm]?[jt]s)$/.test(file));
}

function isTestFile(file) {
  return /\.test\.[cm]?[jt]s$/.test(file);
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

function isArgvCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text.endsWith('Argv')
  );
}

/**
 * Rule 3's exception in the spawn module: the line of the one `--permission-mode` literal
 * that is an element of the array an `...Argv` builder returns, or `undefined` (with the
 * misplaced or repeated literals reported).
 */
function permissionModeFlagLine(source, report) {
  const literals = [];
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) && node.text === PERMISSION_MODE_FLAG) literals.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (literals.length === 0) return undefined;
  if (literals.length > 1) {
    for (const literal of literals.slice(1)) {
      report(line(source, literal), `${PERMISSION_MODE_FLAG} more than once in ${SPAWN_MODULE}`);
    }
  }
  const [first] = literals;
  const array = first.parent;
  const returned = array && ts.isArrayLiteralExpression(array) ? array.parent : undefined;
  const builder = returned && ts.isReturnStatement(returned) ? returned.parent?.parent : undefined;
  if (
    !ts.isStringLiteral(first) ||
    !builder ||
    !ts.isFunctionDeclaration(builder) ||
    !builder.name?.text.endsWith('Argv')
  ) {
    report(line(source, first), `${PERMISSION_MODE_FLAG} outside an ...Argv builder's array`);
    return undefined;
  }
  return line(source, first);
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
        rule.commands !== undefined &&
        (!command || !ts.isStringLiteral(command) || !rule.commands.has(command.text))
      ) {
        const allowed = [...rule.commands].map((name) => `"${name}"`).join(' or ');
        report(line(source, node), `spawn command must be the literal ${allowed}`);
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
      // One builder, or a choice between two (`cond ? aArgv(...) : bArgv(...)`).
      const ok =
        init !== undefined &&
        (isArgvCall(init) ||
          (ts.isConditionalExpression(init) &&
            isArgvCall(init.whenTrue) &&
            isArgvCall(init.whenFalse)));
      if (!ok) report(line(source, node), '`argv` must be the result of an ...Argv builder');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return argvFunctions;
}

/** Rule 4 outside the decide module: `updatedInput` nowhere, not even in a comment. */
function checkUpdatedInputText(text, report) {
  text.split('\n').forEach((content, index) => {
    if (content.includes(UPDATED_INPUT))
      report(index + 1, `${UPDATED_INPUT} outside ${DECIDE_MODULE}`);
  });
}

/** Whether `node` is an `===`/`!==` comparison with `ASK_USER_QUESTION`. */
function comparesAskUserQuestion(source, node) {
  if (!ts.isBinaryExpression(node)) return false;
  const operator = node.operatorToken.kind;
  if (
    operator !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    return false;
  }
  return [node.left, node.right].some((side) => ASK_USER_QUESTION.has(side.getText(source)));
}

function containsNode(root, predicate) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (predicate(node)) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/**
 * Rule 4 inside the decide module: `updatedInput` only as one object property, built in a
 * function that checks the tool is `AskUserQuestion` (comments are free to name it).
 */
function checkDecideModule(source, report) {
  const uses = [];
  const visit = (node) => {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && node.text === UPDATED_INPUT) {
      uses.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (uses.length > 1) {
    report(line(source, uses[1]), `${UPDATED_INPUT} more than once in ${DECIDE_MODULE}`);
  }
  for (const use of uses) {
    if (!ts.isPropertyAssignment(use.parent) || use.parent.name !== use) {
      report(line(source, use), `${UPDATED_INPUT} other than as an object property`);
      continue;
    }
    let scope = use.parent;
    while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
    if (!scope || !containsNode(scope, (node) => comparesAskUserQuestion(source, node))) {
      report(line(source, use), `${UPDATED_INPUT} without an ASK_USER_QUESTION check`);
    }
  }
}

/** Returns the list of violations (`file:line: message`) for a source directory. */
export function checkArgvPolicy(sourceDir) {
  const violations = [];
  for (const file of listSources(sourceDir)) {
    const rel = relative(sourceDir, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    const report = (lineNo, message) => violations.push(`${rel}:${lineNo}: ${message}`);
    if (isTestFile(file)) {
      if (!UPDATED_INPUT_TESTS.has(rel)) checkUpdatedInputText(text, report);
      continue;
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const processRule = PROCESS_MODULES.get(rel);
    for (const { name, node } of moduleSpecifiers(source)) {
      if (name === '<dynamic>') report(line(source, node), 'dynamic import/require specifier');
      if (CHILD_PROCESS.has(name) && processRule === undefined) {
        report(line(source, node), `imports ${name} (only ${PROCESS_MODULE_LIST} may)`);
      }
    }
    if (processRule !== undefined) checkSpawnModule(source, report, processRule);
    if (rel === DECIDE_MODULE) checkDecideModule(source, report);
    else checkUpdatedInputText(text, report);
    const flagLine = rel === SPAWN_MODULE ? permissionModeFlagLine(source, report) : undefined;
    text.split('\n').forEach((content, index) => {
      for (const token of FORBIDDEN_TOKENS) {
        const allowed =
          token === PERMISSION_MODE_FLAG &&
          index + 1 === flagLine &&
          content.split(token).length === 2;
        if (content.includes(token) && !allowed) report(index + 1, `forbidden token ${token}`);
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
