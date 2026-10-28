import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SemanticTaskControls, parseSemanticTasks } from './SemanticTaskControls.js';

test('task controls validate lifecycle, model-loading progress and resumability', () => {
  assert.deepEqual(parseSemanticTasks({ activeTasks: [{ taskId: 'task-1', state: 'paused', phase: 'model_loading', completed: 2, total: 3, resumable: true }] }),
    [{ taskId: 'task-1', state: 'paused', phase: 'model_loading', completed: 2, total: 3, resumable: true }]);
  for (const row of [
    { taskId: 'x', state: 'other', phase: 'embedding', completed: 0, total: 1, resumable: true },
    { taskId: 'x', state: 'running', phase: 'other', completed: 0, total: 1, resumable: true },
    { taskId: 'x', state: 'running', phase: 'embedding', completed: 2, total: 1, resumable: true },
    { taskId: '', state: 'running', phase: 'embedding', completed: 0, total: 1, resumable: true },
    { taskId: 'x', state: 'paused', phase: 'embedding', completed: 0, total: 1 },
  ]) assert.throws(() => parseSemanticTasks({ activeTasks: [row] }));
});
test('task controls keep the start action hidden until the durable task read completes', () => {
  const html = renderToStaticMarkup(<SemanticTaskControls scopeKey="repo:branch" invokeRead={async () => { throw new Error('unexpected read'); }} invokeUi={async () => { throw new Error('unexpected invoke'); }} />);
  assert.match(html, /状態を更新/u);
  assert.doesNotMatch(html, /インデックスを構築・検索モデルを準備/u);
  assert.doesNotMatch(html, /実行中のタスクはありません/u);
});
