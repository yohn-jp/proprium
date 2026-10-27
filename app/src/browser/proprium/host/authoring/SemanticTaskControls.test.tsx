import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SemanticTaskControls, parseSemanticTasks } from './SemanticTaskControls.js';

test('task controls validate exact phase and bounded progress', () => {
  assert.deepEqual(parseSemanticTasks({ activeTasks: [{ taskId: 'task-1', phase: 'embedding', completed: 2, total: 3 }] }), [{ taskId: 'task-1', phase: 'embedding', completed: 2, total: 3 }]);
  for (const row of [{ taskId: 'x', phase: 'other', completed: 0, total: 1 }, { taskId: 'x', phase: 'embedding', completed: 2, total: 1 }, { taskId: '', phase: 'embedding', completed: 0, total: 1 }]) assert.throws(() => parseSemanticTasks({ activeTasks: [row] }));
});
test('task controls expose manual refresh without starting a read during rendering', () => {
  const html = renderToStaticMarkup(<SemanticTaskControls scopeKey="repo:branch" invokeRead={async () => { throw new Error('unexpected read'); }} invokeUi={async () => { throw new Error('unexpected invoke'); }} />);
  assert.match(html, /状態を更新/u);
  assert.doesNotMatch(html, /実行中のタスクはありません/u);
});
