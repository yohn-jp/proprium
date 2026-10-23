export const hostedNativeSelections = Object.freeze(['catalog', 'core', 'selected', 'full']);

export const hostedModuleIds = Object.freeze([
  'story', 'diagnostics', 'nlp', 'semantic', 'speaker', 'assistant', 'publishing', 'mcp', 'search',
]);

const composeCases = Object.freeze({
  core: Object.freeze({ name: 'core', requestedModules: Object.freeze([]) }),
  selected: Object.freeze({ name: 'selected', requestedModules: Object.freeze(['story', 'mcp', 'search']) }),
  full: Object.freeze({ name: 'full', requestedModules: hostedModuleIds }),
});

export function parseHostedNativeSelection(args) {
  if (args.length === 0) return 'all';
  if (args.length === 2 && args[0] === '--selection' && hostedNativeSelections.includes(args[1])) return args[1];
  throw new Error('Usage: verify-hosted-native.mjs [--selection <catalog|core|selected|full>]');
}

export function hostedNativeComposeCases(selection) {
  if (selection === 'catalog') return [];
  if (selection === 'all') return [composeCases.core, composeCases.selected, composeCases.full];
  const composeCase = composeCases[selection];
  if (!composeCase) throw new Error(`Unknown Hosted Native selection: ${selection}`);
  return [composeCase];
}
