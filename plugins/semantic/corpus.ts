import YAML from 'yaml';
import type { ActionRequest } from '../../app/src/browser/proprium/authoring/types.js';
import type { GuestHost, HostCall } from '../shared/guest.js';
import { HOST_OPERATIONS, readFileVersioned, type FilePage } from '../shared/operations.ts';
import { isSemanticSourcePath, parseSemanticSourceFile, type SemanticSourceEntity, type SemanticSourcePassage } from './source.ts';

const MAX_FILES = 5000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PASSAGES = 20_000;
function failure(code: string, message: string): Error { return Object.assign(new Error(message), { code, retryable: false }); }
function safeManuscript(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && path.split('/').every(part => part && part !== '.' && part !== '..') && /\.md$/iu.test(path);
}
export interface SemanticCorpus { entities: SemanticSourceEntity[]; passages: SemanticSourcePassage[]; scanned: number }
/** Read a bounded source generation and attach prose only through explicit scene metadata. */
export function* collectSemanticCorpus(host: GuestHost, request: ActionRequest): Generator<HostCall, SemanticCorpus, unknown> {
  const entries = new Map<string, { revision: string; byte_length: number }>();
  let cursor: string | null = null; const cursors = new Set<string>(); let totalBytes = 0;
  do {
    const page = yield* host.request<FilePage>(HOST_OPERATIONS.list, { snapshot: request.snapshot, limit: 256, ...(cursor ? { cursor } : {}) });
    if (!page || !Array.isArray(page.entries) || !(page.next_cursor === null || typeof page.next_cursor === 'string')) throw failure('snapshot_stale', 'Invalid source listing');
    for (const entry of page.entries) {
      if (!entry || typeof entry.path !== 'string' || typeof entry.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.revision) || !Number.isSafeInteger(entry.byte_length) || entry.byte_length < 0 || entries.has(entry.path)) throw failure('snapshot_stale', 'Inconsistent source listing');
      entries.set(entry.path, { revision: entry.revision, byte_length: entry.byte_length });
      if (entries.size > MAX_FILES) throw failure('capacity', 'Semantic source listing exceeds the file limit');
    }
    cursor = page.next_cursor;
    if (cursor !== null) { if (!cursor || cursors.has(cursor)) throw failure('snapshot_stale', 'Source listing cursor did not advance'); cursors.add(cursor); }
  } while (cursor !== null);
  const entities: SemanticSourceEntity[] = []; const ids = new Set<string>(); const links = new Map<string, string>();
  function* read(path: string): Generator<HostCall, string, unknown> {
    const entry = entries.get(path); if (!entry) throw failure('snapshot_stale', `Linked source is missing: ${path}`);
    totalBytes += entry.byte_length; if (totalBytes > MAX_BYTES) throw failure('capacity', 'Semantic source bytes exceed the limit');
    const file = yield* readFileVersioned(host, request.snapshot, path, entry.revision);
    if (file.bytes.length !== entry.byte_length) throw failure('snapshot_stale', `Source length changed: ${path}`);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); } catch { throw failure('unsupported_format', `Source is not UTF-8: ${path}`); }
  }
  for (const path of [...entries.keys()].sort()) {
    if (!(path.startsWith("bible/") || path.startsWith("plot/")) || !isSemanticSourcePath(path) || !/\.ya?ml$/iu.test(path)) continue;
    const text = yield* read(path);
    const document = YAML.parseDocument(text, { uniqueKeys: true });
    if (document.errors.length) throw failure('unsupported_format', `Invalid source YAML: ${path}`);
    const entity = parseSemanticSourceFile(path, entries.get(path)!.revision, text);
    if (!entity) continue;
    if (ids.has(entity.id)) throw failure('invalid_input', `Ambiguous Semantic entity ID: ${entity.id}`);
    ids.add(entity.id); entities.push(entity);
    if (entity.type === 'scene') {
      const raw: unknown = document.toJS({ maxAliasCount: 100 });
      const manuscript = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).manuscript : undefined;
      if (manuscript === undefined || manuscript === null || manuscript === '') continue;
      if (!safeManuscript(manuscript)) throw failure('invalid_input', `Invalid linked manuscript path: ${path}`);
      if (links.has(manuscript)) throw failure('invalid_input', `Ambiguous linked manuscript: ${manuscript}`);
      links.set(manuscript, entity.id);
    }
  }
  for (const [path, entityId] of [...links].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const text = yield* read(path);
    const entity = parseSemanticSourceFile(path, entries.get(path)!.revision, text, { entityId, type: 'manuscript' });
    if (entity) entities.push(entity);
  }
  const passages = entities.flatMap(entity => entity.passages);
  if (passages.length > MAX_PASSAGES) throw failure('capacity', 'Semantic corpus exceeds the passage limit');
  return { entities, passages, scanned: entries.size };
}
