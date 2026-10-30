import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SemanticTaskControls, parseSemanticTasks, type SemanticTaskProfile } from './SemanticTaskControls.js';

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
test('BGE task profile admits only its own preparation phases and records restartable progress', () => {
  const task = { taskId: 'bge-1', state: 'running', phase: 'load_tensors', completed: 64, total: 8737, resumable: true };
  assert.deepEqual(parseSemanticTasks({ activeTasks: [task] }, 'reranker'), [task]);
  assert.throws(() => parseSemanticTasks({ activeTasks: [{ ...task, phase: 'embedding' }] }, 'reranker'));
  assert.throws(() => parseSemanticTasks({ activeTasks: [{ ...task, phase: 'load_tensors', total: 32, completed: 64 }] }, 'reranker'));
  assert.throws(() => parseSemanticTasks({ activeTasks: [{ ...task, phase: 'source_scan' }] }, 'reranker'));
});
test('task controls keep the start action hidden until the durable task read completes', () => {
  const html = renderToStaticMarkup(<SemanticTaskControls scopeKey="repo:branch" invokeRead={async () => { throw new Error('unexpected read'); }} invokeUi={async () => { throw new Error('unexpected invoke'); }} />);
  assert.match(html, /状態を更新/u);
  assert.doesNotMatch(html, /インデックスを構築・検索モデルを準備/u);
  assert.doesNotMatch(html, /実行中のタスクはありません/u);
});
test('BGE profile shows the separate model admission and local consent requirements', () => {
  const html = renderToStaticMarkup(<SemanticTaskControls profile={'reranker' satisfies SemanticTaskProfile} scopeKey="repo:branch"
    invokeRead={async () => { throw new Error('unexpected read'); }} invokeUi={async () => { throw new Error('unexpected invoke'); }} />);
  assert.match(html, /BGE 再順位付けモデル/u);
  assert.match(html, /E5 の許可では BGE を取得しません/u);
  assert.match(html, /2,288,661,281 バイト/u);
  assert.doesNotMatch(html, /インデックスを構築・検索モデルを準備/u);
});
