// Canonical verification inventory: workflow matrices, coverage and release eligibility share these names.
export const WORKSPACES = [
  ...['contracts', 'module-runtime', 'migration', 'core', 'api'].map(id => ({ id, path: `packages/${id}` })),
  { id: 'app', path: 'app' },
  ...['story', 'nlp', 'diagnostics', 'semantic', 'speaker', 'assistant', 'publishing', 'mcp', 'search'].map(id => ({ id, path: `modules/${id}` })),
];
export const UNIT_TARGETS = [...WORKSPACES, { id: 'root', path: '.' }];
export const TYPECHECK_TARGETS = [
  { id: 'foundations', workspaces: ['contracts', 'module-runtime', 'migration'] },
  { id: 'core-api', workspaces: ['core', 'api'] },
  { id: 'app', workspaces: ['app'] },
  { id: 'modules-a', workspaces: ['story', 'nlp', 'diagnostics', 'semantic', 'speaker'] },
  { id: 'modules-b', workspaces: ['assistant', 'publishing', 'mcp', 'search'] },
];
export const TEST_TYPECHECK_SCOPES = ['app-e2e', 'packages', 'modules'];
export const PROFILES = ['core', 'full'];
export const BROWSER_SHARDS = [
  ...['core', 'job-inbox', 'modular-workspace', 'recent-activity', 'review-contributions', 'ui-v1'].map(id => ({ id, project: 'chromium', file: `${id}.acceptance.spec.ts` })),
  { id: 'webkit', project: 'webkit', file: 'ui-v1.acceptance.spec.ts' },
];
export const NATIVE_SELECTIONS = ['catalog', 'core', 'selected', 'full'];
export const VERIFICATION_TASKS = [
  ...UNIT_TARGETS.map(({ id }) => `unit-${id}`),
  ...TYPECHECK_TARGETS.map(({ id }) => `typecheck-${id}`),
  ...TEST_TYPECHECK_SCOPES.map(id => `test-types-${id}`),
  'safety', 'build-core', 'build-full', 'audit-core', 'oci-core', 'oci-full',
  ...PROFILES.flatMap(profile => BROWSER_SHARDS.map(({ id }) => `browser-${profile}-${id}`)),
  ...NATIVE_SELECTIONS.map(id => `hosted-native-${id}`),
  'coverage',
];
// Execution groups batch work without removing any validation obligation.
export const VERIFICATION_GROUPS = {
  'unit-core': ['contracts', 'module-runtime', 'migration', 'core', 'api', 'root'].map(id => `unit-${id}`),
  'unit-modules': ['app', ...WORKSPACES.filter(item => item.path.startsWith('modules/')).map(item => item.id)].map(id => `unit-${id}`),
  'types-sources': [...TYPECHECK_TARGETS.map(item => `typecheck-${item.id}`), 'safety'],
  'types-tests': [...TEST_TYPECHECK_SCOPES.map(id => `test-types-${id}`), 'coverage'],
  'build-core': ['build-core', 'audit-core'],
  'build-full': ['build-full'],
  'oci-core': ['oci-core'],
  'oci-full': ['oci-full'],
  ...Object.fromEntries(PROFILES.flatMap(profile => [
    [`browser-${profile}-writing`, ['core', 'job-inbox', 'recent-activity'].map(id => `browser-${profile}-${id}`)],
    [`browser-${profile}-reference`, ['modular-workspace', 'review-contributions', 'ui-v1'].map(id => `browser-${profile}-${id}`)],
    [`browser-${profile}-webkit`, [`browser-${profile}-webkit`]],
  ])),
  ...Object.fromEntries(NATIVE_SELECTIONS.map(id => [`hosted-native-${id}`, [`hosted-native-${id}`]])),
};
export const VERIFICATION_LEAF_JOBS = ['plan', ...Object.keys(VERIFICATION_GROUPS)];
export const REQUIRED_VERIFICATION_JOBS = [...VERIFICATION_LEAF_JOBS, 'certification'];
