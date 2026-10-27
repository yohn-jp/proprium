/** Per-activation task state. The Host must mirror progress out of band while
 * the single guest invocation is active; this state is not shared across Workers. */
export type SemanticTaskPhase = 'source_scan' | 'embedding' | 'cache_validation' | 'cache_publish' | 'query_embedding' | 'vector_scan' | 'reranking' | 'term_embedding' | 'mention_scan' | 'candidate_scoring' | 'complete';
export interface SemanticTaskProgress { taskId: string; phase: SemanticTaskPhase; completed: number; total: number }
let active: SemanticTaskProgress | undefined;
let cancelled = false;
export function beginSemanticTask(taskId: string): void {
  if (active) throw Object.assign(new Error('A Semantic task is already active'), { code: 'capacity', details: { legacy: 'semantic_task_exists' } });
  active = { taskId, phase: 'source_scan', completed: 0, total: 0 }; cancelled = false;
}
export function semanticTasks(): SemanticTaskProgress[] { return active ? [{ ...active }] : []; }
export function updateSemanticTask(phase: SemanticTaskPhase, completed: number, total: number): SemanticTaskProgress {
  if (!active) throw new Error('No active Semantic task');
  if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || completed < 0 || completed > total || (active.phase === phase && completed < active.completed)) throw new Error('Invalid Semantic task progress');
  active = { taskId: active.taskId, phase, completed, total }; return { ...active };
}
export function cancelSemanticTask(taskId: string): boolean {
  if (!active || active.taskId !== taskId || cancelled) return false;
  cancelled = true; return true;
}
export function assertSemanticTaskActive(): void {
  if (cancelled) throw Object.assign(new Error('Semantic task was cancelled'), { code: 'cancelled' });
}
export function endSemanticTask(): void { active = undefined; cancelled = false; }
