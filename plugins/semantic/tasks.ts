/** Ephemeral progress mirror for the guest invocation. Durable task identity,
 * progress, cancellation and resume belong to the Host journal, never this module. */
export type SemanticTaskPhase = 'source_scan' | 'model_loading' | 'embedding' | 'cache_validation' | 'cache_publish' | 'query_embedding' | 'vector_scan' | 'reranking' | 'term_embedding' | 'mention_scan' | 'candidate_scoring' | 'complete';
export interface SemanticTaskProgress { taskId: string; state: 'running'; phase: SemanticTaskPhase; completed: number; total: number; resumable: boolean }
let active: SemanticTaskProgress | undefined;
let cancelled = false;
export function beginSemanticTask(taskId: string): void {
  if (active) throw Object.assign(new Error('A Semantic task is already active'), { code: 'capacity', details: { legacy: 'semantic_task_exists' } });
  active = { taskId, state: 'running', phase: 'source_scan', completed: 0, total: 0, resumable: true }; cancelled = false;
}
export function semanticTasks(): SemanticTaskProgress[] { return active ? [{ ...active }] : []; }
export function updateSemanticTask(phase: SemanticTaskPhase, completed: number, total: number): SemanticTaskProgress {
  if (!active) throw new Error('No active Semantic task');
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || completed < 0 || completed > total || (active.phase === phase && completed < active.completed)) throw new Error('Invalid Semantic task progress');
  active = { taskId: active.taskId, state: 'running', phase, completed, total, resumable: true }; return { ...active };
}
export function cancelSemanticTask(taskId: string): boolean {
  if (!active || active.taskId !== taskId || cancelled) return false;
  cancelled = true; return true;
}
export function assertSemanticTaskActive(): void {
  if (cancelled) throw Object.assign(new Error('Semantic task was cancelled'), { code: 'cancelled' });
}
export function endSemanticTask(): void { active = undefined; cancelled = false; }
