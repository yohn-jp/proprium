import { sha256 } from './sha256.js';
import { PairedError } from './types.js';
import { readText } from './host.js';

export interface UsageRow {
  id: string; feature: string; provider: string; model: string; startedAt: string; completedAt: string;
  state: 'completed' | 'aborted' | 'failed'; source: 'preserved-project-jsonl' | 'host-owned-store';
  inputTokens?: number; outputTokens?: number; cost?: number; cacheHit?: boolean; promptVersion?: string;
  durationMs?: number; queueWaitMs?: number; errorCode?: string; aborted?: boolean;
}
export interface UsageInput {
  legacyText: string; legacyRevision: string | null; hostEvents?: readonly unknown[]; hostAvailable?: boolean;
  month?: string; limit: number; cursor?: string;
}
const digest = (text: string) => sha256(new TextEncoder().encode(text));
const bounded = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
const nonnegative = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function normalize(raw: unknown, source: UsageRow['source'], line?: string): UsageRow | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const r = raw as Record<string, unknown>;
  const startedAt = bounded(source === 'preserved-project-jsonl' ? r.ts : r.startedAt, 64);
  const feature = bounded(r.feature, 256), model = bounded(r.model, 512);
  if (!startedAt || !Number.isFinite(Date.parse(startedAt)) || !feature || !model) return;
  const duration = nonnegative(r.durationMs);
  const completed = source === 'preserved-project-jsonl' ? new Date(Date.parse(startedAt) + (duration ?? 0)).toISOString() : bounded(r.completedAt, 64);
  if (!completed || !Number.isFinite(Date.parse(completed))) return;
  const state = source === 'preserved-project-jsonl' ? r.aborted === true ? 'aborted' : 'completed' : r.state;
  if (state !== 'completed' && state !== 'aborted' && state !== 'failed') return;
  const id = bounded(r.id, 256) ?? (line === undefined ? undefined : `legacy-${digest(line)}`);
  const provider = source === 'preserved-project-jsonl' ? bounded(r.provider,128) ?? 'legacy' : bounded(r.provider,128);
  if (!id || !provider) return;
  const row: UsageRow = { id, feature, provider, model, startedAt, completedAt: completed, state, source };
  for (const key of ['inputTokens','outputTokens','durationMs','queueWaitMs'] as const) { const n = nonnegative(r[key]); if (n !== undefined) row[key] = n; }
  if (typeof r.cost === 'number' && Number.isFinite(r.cost) && r.cost >= 0) row.cost = r.cost;
  if (typeof r.cacheHit === 'boolean') row.cacheHit = r.cacheHit;
  if (typeof r.aborted === 'boolean' && source === 'preserved-project-jsonl') row.aborted = r.aborted;
  if (typeof r.promptVersion === 'string') row.promptVersion = r.promptVersion.slice(0,256);
  if (typeof r.errorCode === 'string') row.errorCode = r.errorCode.slice(0,96);
  return row;
}
export function readUsagePage(input: UsageInput) {
  if (typeof input.legacyText !== 'string' || input.legacyText.length > 16 * 1024 * 1024 || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200 ||
      (input.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/u.test(input.month)) || (input.hostEvents?.length ?? 0) > 10000) throw new PairedError('invalid_input','Invalid usage history query');
  const rows: UsageRow[] = [];
  for (const line of input.legacyText.split(/\r?\n/u)) { if (!line.trim()) continue; try { const row = normalize(JSON.parse(line), 'preserved-project-jsonl', line); if (row) rows.push(row); } catch { /* Preserve malformed source bytes. */ } }
  for (const event of input.hostEvents ?? []) { const row = normalize(event, 'host-owned-store'); if (row) rows.push(row); }
  const seen = new Set<string>();
  const events = rows.filter(row => !input.month || row.startedAt.slice(0,7) === input.month).filter(row => { const k = `${row.id}\0${row.provider}\0${row.feature}\0${row.startedAt}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a,b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
  const aggregates: Record<string, { calls:number; inputTokens:number; outputTokens:number; aborted:number; cacheHits:number; cost:number; byFeature:Record<string,number>; bySource:Record<string,number> }> = Object.create(null);
  for (const event of events) { const month=event.startedAt.slice(0,7); const a=aggregates[month] ??= {calls:0,inputTokens:0,outputTokens:0,aborted:0,cacheHits:0,cost:0,byFeature:Object.create(null),bySource:Object.create(null)}; a.calls++; a.inputTokens+=event.inputTokens??0; a.outputTokens+=event.outputTokens??0; a.aborted+=Number(event.state==='aborted'); a.cacheHits+=Number(event.cacheHit===true); a.cost+=event.cost??0; a.byFeature[event.feature]=(a.byFeature[event.feature]??0)+1; a.bySource[event.source]=(a.bySource[event.source]??0)+1; }
  const binding = digest(JSON.stringify({legacyRevision:input.legacyRevision,legacyText:input.legacyText,month:input.month??null,events}));
  let offset=0;
  if (input.cursor !== undefined) { const m=/^usage1\.([a-f0-9]{64})\.(0|[1-9]\d*)$/u.exec(input.cursor); if (!m || m[1]!==binding || !Number.isSafeInteger(Number(m[2])) || Number(m[2])>events.length) throw new PairedError('invalid_input','Usage history cursor is invalid or stale'); offset=Number(m[2]); }
  const page=events.slice(offset,offset+input.limit), next=offset+page.length;
  return {events:page, nextCursor:next<events.length?`usage1.${binding}.${next}`:null, aggregates, total:events.length, legacyRevision:input.legacyRevision, hasHostHistory:input.hostAvailable===true, ...(input.hostAvailable===true?{}:{historyWarning:'host_usage_store_unavailable'})};
}

export interface UsageHistoryQuery { month?: string; limit: number; cursor?: string; source?: 'canonical' | 'archive' }
export type HostUsageReader = (query: { month?: string }) => Generator<import('../../shared/guest.js').HostCall, { events: readonly unknown[]; complete: boolean; available?: boolean }, unknown>;
/** Read exactly the selected legacy source at the Host-pinned snapshot; archives require explicit selection. */
export function* resolveUsageHistory(
  host: import('../../shared/guest.js').GuestHost,
  request: import('../../../app/src/browser/proprium/authoring/types.js').ActionRequest,
  query: UsageHistoryQuery,
  readHost?: HostUsageReader,
): Generator<import('../../shared/guest.js').HostCall, ReturnType<typeof readUsagePage> & { legacyPath:string; hostHistoryComplete:boolean }, unknown> {
  const source = query.source ?? 'canonical';
  if (source !== 'canonical' && source !== 'archive') throw new PairedError('invalid_input','Unknown usage history source');
  const path = source === 'canonical' ? 'meta/scriptorium/modules/assistant/usage.jsonl' : '.arcadia/llm-usage.jsonl';
  const prefix = path.slice(0,path.lastIndexOf('/')+1);
  let cursor:string|null=null; const seen=new Set<string>(); let entry:{path:string;revision:string;byte_length:number}|undefined;
  for (let pages=0;pages<64;pages++) {
    const page:{entries:Array<{path:string;revision:string;byte_length:number}>;next_cursor:string|null} = yield* host.request('workspace.file.list',{snapshot:request.snapshot,prefix,limit:256,...(cursor ? {cursor} : {})});
    if (!page || !Array.isArray(page.entries) || page.entries.length>256 || !(page.next_cursor===null || typeof page.next_cursor==='string')) throw new PairedError('invalid_input','Host returned an invalid usage file page');
    for (const item of page.entries) if (item.path===path) { if (entry) throw new PairedError('invalid_input','Host returned duplicate usage source'); entry=item; }
    if (page.next_cursor===null) break;
    if (seen.has(page.next_cursor)) throw new PairedError('invalid_input','Host usage file cursor did not advance');
    seen.add(page.next_cursor); cursor=page.next_cursor;
    if (pages===63) throw new PairedError('capacity','Usage source listing exceeds page limit');
  }
  let legacyText='', legacyRevision:string|null=null;
  if (entry) {
    if (typeof entry.revision !== 'string' || !entry.revision || !Number.isSafeInteger(entry.byte_length) || entry.byte_length < 0 || entry.byte_length > 16*1024*1024) throw new PairedError('invalid_input','Usage source metadata is invalid');
    const file = yield* readText(host,request,path);
    if (file.revision!==entry.revision || file.total_bytes!==entry.byte_length) throw new PairedError('snapshot_stale','Usage source changed during reading');
    legacyText=file.text; legacyRevision=file.revision;
  }
  let hostEvents:readonly unknown[]=[]; let hostAvailable=false; let hostHistoryComplete=false;
  if (readHost) { const result=yield* readHost({ ...(query.month ? {month:query.month} : {}) }); if (!result || !Array.isArray(result.events) || typeof result.complete!=='boolean') throw new PairedError('invalid_input','Host usage history response is malformed'); hostEvents=result.events; hostAvailable=result.available !== false; hostHistoryComplete=hostAvailable && result.complete; }
  return {...readUsagePage({legacyText,legacyRevision,hostEvents,hostAvailable,limit:query.limit,...(query.month === undefined ? {} : {month:query.month}),...(query.cursor === undefined ? {} : {cursor:query.cursor})}),legacyPath:path,hostHistoryComplete};
}

/** Query the Host-owned, scope-bound provider usage authority. Month filtering stays local. */
export function* readHostUsage(host: import('../../shared/guest.js').GuestHost, _query: { month?: string }): Generator<import('../../shared/guest.js').HostCall, { events: readonly unknown[]; complete: boolean; available: boolean }, unknown> {
  let value:unknown;
  try { value = yield* host.request('workspace.capabilities.query', { capability_id: 'provider.usage.v1' }); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'missing_capability' || code === 'capability_denied' || code === 'dependency_unavailable') return { events: [], complete: false, available: false };
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as {available?:unknown}).available !== 'boolean') throw new PairedError('invalid_input','Host usage capability response is malformed');
  const status = value as {available:boolean;events?:unknown;complete?:unknown};
  if (!status.available) return { events: [], complete: false, available: false };
  if (!Array.isArray(status.events) || status.events.length > 1000 || typeof status.complete !== 'boolean') throw new PairedError('invalid_input','Host usage capability response is malformed');
  return {events:status.events,complete:status.complete,available:true};
}
