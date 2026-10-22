// Metro for the monorepo (M4-03): the workspace packages ship TypeScript sources whose
// relative imports end in `.js` (NodeNext style); Metro resolves those to the `.ts` file.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = resolveRequest ?? context.resolveRequest;
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return resolve(context, `${moduleName.slice(0, -3)}.ts`, platform);
    } catch {
      // Not a TypeScript source: a real `.js` file.
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
