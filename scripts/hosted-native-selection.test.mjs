import assert from 'node:assert/strict';
import test from 'node:test';
import { hostedNativeComposeCases, hostedModuleIds, hostedNativeSelections, parseHostedNativeSelection } from './hosted-native-selection.mjs';

test('Hosted Native selection defaults to all catalog and composition checks', () => {
  assert.equal(parseHostedNativeSelection([]), 'all');
  assert.deepEqual(hostedNativeComposeCases('all').map(({ name }) => name), ['core', 'selected', 'full']);
});

test('Hosted Native matrix selections isolate catalog and each composition', () => {
  assert.deepEqual(hostedNativeSelections, ['catalog', 'core', 'selected', 'full']);
  assert.deepEqual(hostedNativeComposeCases('catalog'), []);
  assert.deepEqual(hostedNativeComposeCases('core'), [{ name: 'core', requestedModules: [] }]);
  assert.deepEqual(hostedNativeComposeCases('selected'), [{ name: 'selected', requestedModules: ['story', 'mcp', 'search'] }]);
  assert.deepEqual(hostedNativeComposeCases('full'), [{ name: 'full', requestedModules: [...hostedModuleIds] }]);
});

test('Hosted Native selection rejects malformed or unknown CLI arguments', () => {
  for (const args of [
    ['--selection'], ['--selection', 'all'], ['--selection', 'unknown'], ['--selection', 'core', '--selection', 'full'], ['--other'],
  ]) assert.throws(() => parseHostedNativeSelection(args), /Usage:/u);
  assert.throws(() => hostedNativeComposeCases('unknown'), /Unknown Hosted Native selection/u);
});
