import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { ActionResult, Snapshot, Scope } from '../../authoring/types.js';
import type { AuthoringNavigationTarget } from './types.js';

export type ResearchSemanticMode = 'lexical' | 'exact' | 'prefix' | 'hybrid' | 'semantic' | 'expression';
export interface ResearchSemanticSearchProps {
  /** Changes whenever the selected workspace, branch or source snapshot changes. */
  readonly scopeKey: string;
  /** Whether Semantic is installed, enabled and admitted by the active Host registry. */
  readonly semanticAvailable: boolean;
  invokeRead(pluginId: string, actionId: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ActionResult>;
  navigate(event: Event, target: AuthoringNavigationTarget, intent: 'open'): Promise<void>;
}

interface SearchHit {
  path: string;
  title: string;
  fileRevision: string;
  snippet: string;
  score: number;
  source: string;
  scoreFactors: string[];
  navigationSpan: { path: string; revision: string; start: number; end: number; quote?: string } | null;
  semanticCandidate?: {
    candidateId: string; entityId: string; sourcePath: string; sourceRevision: string; sentenceIndex?: number;
    text: string; evidence: { path: string; revision: string; start: number; end: number; quote: string }[];
  };
  [key: string]: unknown;
}
interface FusedResult {
  hits: SearchHit[];
  warnings: string[];
  expressionStatus?: { state: 'ready' | 'unavailable'; reason?: string };
  [key: string]: unknown;
}

const RESEARCH = 'proprium.research';
const SEMANTIC = 'proprium.semantic';
const MAX_HITS = 30;
const SEMANTIC_MODES = new Set<ResearchSemanticMode>(['hybrid', 'semantic', 'expression']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function snapshotMatches(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  return ['id', 'local_commit', 'worktree_generation', 'draft_generation', 'remote_commit']
    .every(key => (left[key] ?? null) === (right[key] ?? null));
}

function scopeMatches(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  return ['workspace_id', 'repository_id', 'branch', 'generation']
    .every(key => (left[key] ?? null) === (right[key] ?? null));
}

export function validSourceSpan(value: unknown): value is NonNullable<SearchHit['navigationSpan']> {
  if (!isRecord(value) || typeof value.path !== 'string' || !validRelativePath(value.path) ||
      typeof value.revision !== 'string' || !value.revision || !Number.isSafeInteger(value.start) ||
      !Number.isSafeInteger(value.end) || (value.start as number) < 0 || (value.end as number) < (value.start as number) ||
      (value.quote !== undefined && (typeof value.quote !== 'string' || !value.quote.length || value.quote.length > 32_768 ||
        (value.end as number) - (value.start as number) !== value.quote.length))) return false;
  return true;
}

function validRelativePath(path: string): boolean {
  return Boolean(path) && path.length <= 1024 && !path.startsWith('/') && !path.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(path) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function validSemanticCandidate(value: unknown): SearchHit['semanticCandidate'] | undefined {
  if (!isRecord(value) || typeof value.candidateId !== 'string' || !value.candidateId || value.candidateId.length > 128 ||
      typeof value.entityId !== 'string' || !value.entityId || typeof value.sourcePath !== 'string' || !value.sourcePath ||
      typeof value.sourceRevision !== 'string' || !value.sourceRevision || typeof value.text !== 'string' || !value.text ||
      (value.sentenceIndex !== undefined && (!Number.isSafeInteger(value.sentenceIndex) || (value.sentenceIndex as number) < 0)) ||
      !Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.length > 8 ||
      value.evidence.some(span => !validSourceSpan(span) || typeof span.quote !== 'string')) return undefined;
  return value as unknown as NonNullable<SearchHit['semanticCandidate']>;
}

export function validSearchHits(value: unknown, requireSourceQuote = false): SearchHit[] {
  if (!Array.isArray(value) || value.length > MAX_HITS) throw new Error('検索結果を読み取れません。');
  return value.map((raw): SearchHit => {
    if (!isRecord(raw) || typeof raw.path !== 'string' || !validRelativePath(raw.path) || typeof raw.title !== 'string' || raw.title.length > 1024 ||
        typeof raw.fileRevision !== 'string' || !raw.fileRevision || typeof raw.snippet !== 'string' || raw.snippet.length > 32_768 ||
        typeof raw.score !== 'number' || !Number.isFinite(raw.score) ||
        (raw.source !== undefined && typeof raw.source !== 'string') ||
        (raw.scoreFactors !== undefined && (!Array.isArray(raw.scoreFactors) || raw.scoreFactors.some(item => typeof item !== 'string')))) {
      throw new Error('検索結果を読み取れません。');
    }
    if (raw.navigationSpan != null && (!validSourceSpan(raw.navigationSpan) ||
        raw.navigationSpan.path !== raw.path || raw.navigationSpan.revision !== raw.fileRevision ||
        (requireSourceQuote && !raw.navigationSpan.quote))) throw new Error('検索結果の原文位置が不正です。');
    const semanticCandidate = validSemanticCandidate(raw.semanticCandidate);
    return {
      ...raw,
      source: typeof raw.source === 'string' ? raw.source : raw.kind === 'document' ? 'lexical' : 'search',
      scoreFactors: Array.isArray(raw.scoreFactors) ? raw.scoreFactors as string[] : [],
      navigationSpan: raw.navigationSpan == null ? null : raw.navigationSpan as SearchHit['navigationSpan'],
      ...(semanticCandidate ? { semanticCandidate } : {}),
    } as SearchHit;
  });
}

function typedResult(result: ActionResult, label: string): { scope: Scope; snapshot: Snapshot; value: Record<string, unknown>; warnings: string[] } {
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  if (!result.scope || !result.snapshot || !isRecord(result.value)) throw new Error(`${label} の検索結果にワークスペース情報がありません。`);
  return { scope: result.scope, snapshot: result.snapshot, value: result.value,
    warnings: Array.isArray(result.warnings) ? result.warnings.filter((item): item is string => typeof item === 'string') : [] };
}

function resultIdentityMatches(left: { scope: Scope; snapshot: Snapshot }, right: { scope: Scope; snapshot: Snapshot }): boolean {
  return scopeMatches(left.scope, right.scope) && snapshotMatches(left.snapshot, right.snapshot);
}

/** Compose existing signed actions through Host dispatch; ranking stays Research-owned. */
export function ResearchSemanticSearch({ scopeKey, semanticAvailable, invokeRead, navigate }: ResearchSemanticSearchProps): ReactElement {
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const [query, setQuery] = useState('');
  const [pathScope, setPathScope] = useState('');
  const [mode, setMode] = useState<ResearchSemanticMode>('lexical');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const cancel = () => {
    generation.current++;
    active.current?.abort(); active.current = null;
    setBusy(false);
  };
  useEffect(() => {
    cancel(); setHits([]); setWarnings([]); setMessage('');
    return () => { generation.current++; active.current?.abort(); active.current = null; };
  }, [scopeKey, semanticAvailable]);

  async function run(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || trimmed.length > 512) { setMessage('検索語は 1〜512 文字で入力してください。'); return; }
    cancel();
    const controller = new AbortController(); active.current = controller;
    const ticket = ++generation.current;
    const expectedScope = scopeKey;
    const current = () => ticket === generation.current && !controller.signal.aborted && scopeRef.current === expectedScope;
    setBusy(true); setHits([]); setWarnings([]); setMessage('検索しています…');
    let lexicalFallback: SearchHit[] | null = null;
    try {
      const lexicalResult = typedResult(await invokeRead(RESEARCH, 'research.query', {
        query: trimmed, mode: SEMANTIC_MODES.has(mode) ? 'lexical' : mode,
        ...(pathScope.trim() ? { scope: pathScope.trim() } : {}), limit: MAX_HITS, includeTerms: false,
      }, controller.signal), '全文検索');
      if (!current()) return;
      if (lexicalResult.value.query !== trimmed || lexicalResult.value.mode !== (SEMANTIC_MODES.has(mode) ? 'lexical' : mode) ||
          !snapshotMatches(lexicalResult.value.snapshot, lexicalResult.snapshot) ||
          (lexicalResult.value.scope ?? null) !== (pathScope.trim() || null)) {
        throw Object.assign(new Error('全文検索が別のワークスペースの結果を返しました。'), { code: 'snapshot_stale' });
      }
      const lexicalHits = validSearchHits(lexicalResult.value.hits);
      lexicalFallback = lexicalHits;
      setHits(lexicalHits); setWarnings(lexicalResult.warnings); setMessage(SEMANTIC_MODES.has(mode) ? '全文検索を表示しています。意味検索を実行しています…' : '検索結果を表示しています。');
      if (!SEMANTIC_MODES.has(mode)) return;
      if (!semanticAvailable) {
        setWarnings(['Semantic が有効でないため、全文検索だけを表示しています。']);
        setMessage('全文検索は利用できます。Semantic を有効にすると意味検索も利用できます。');
        return;
      }

      const vectorResult = typedResult(await invokeRead(SEMANTIC, 'proprium.semantic.passages.query', {
        query: trimmed, granularity: 'sentence', limit: MAX_HITS,
      }, controller.signal), '意味検索');
      if (!current()) return;
      if (!resultIdentityMatches(lexicalResult, vectorResult) ||
          !snapshotMatches(vectorResult.value.snapshot, vectorResult.snapshot) || !Array.isArray(vectorResult.value.results) ||
          vectorResult.value.results.length > MAX_HITS) {
        throw Object.assign(new Error('意味検索が全文検索と異なるワークスペースを参照しました。結果を破棄しました。'), { code: 'snapshot_stale' });
      }

      const fusedResult = typedResult(await invokeRead(RESEARCH, 'research.search.fuse', {
        mode, query: trimmed, ...(pathScope.trim() ? { scope: pathScope.trim() } : {}), limit: MAX_HITS,
        lexicalResult: { scope: lexicalResult.scope, snapshot: lexicalResult.snapshot, value: lexicalResult.value },
        vectorResult: { scope: vectorResult.scope, snapshot: vectorResult.snapshot, query: trimmed, granularity: 'sentence', value: vectorResult.value },
      }, controller.signal), '検索順位の統合');
      if (!current()) return;
      if (!resultIdentityMatches(lexicalResult, fusedResult) || !snapshotMatches(fusedResult.value.snapshot, fusedResult.snapshot) ||
          fusedResult.value.query !== trimmed || fusedResult.value.mode !== mode ||
          (fusedResult.value.scope ?? null) !== (pathScope.trim() || null)) {
        throw Object.assign(new Error('統合検索結果のスナップショットが古くなりました。'), { code: 'snapshot_stale' });
      }
      const finalHits = validSearchHits(fusedResult.value.hits, true);
      const vectorWarning = typeof vectorResult.value.warning === 'string' ? [vectorResult.value.warning] : [];
      const actionWarnings = [...lexicalResult.warnings, ...vectorResult.warnings, ...fusedResult.warnings];
      const valueWarnings = Array.isArray(fusedResult.value.warnings)
        ? fusedResult.value.warnings.filter((item): item is string => typeof item === 'string') : [];
      const finalWarnings = [...new Set([...actionWarnings, ...vectorWarning, ...valueWarnings])];
      const expressionStatus = fusedResult.value.expressionStatus;
      if (mode === 'expression' && isRecord(expressionStatus) && expressionStatus.state === 'unavailable') {
        finalWarnings.push(`表現検索は利用できません: ${typeof expressionStatus.reason === 'string' ? expressionStatus.reason : 'ローカル解析器を利用できません。'}`);
      }

      if (finalHits.some(hit => hit.semanticCandidate)) {
        try {
          const settings = typedResult(await invokeRead(SEMANTIC, 'proprium.semantic.settings.read', {}, controller.signal), 'Semantic 設定');
          if (!current()) return;
          if (!resultIdentityMatches(lexicalResult, settings)) throw Object.assign(new Error('設定が別のワークスペースを参照しました。'), { code: 'snapshot_stale' });
          if (isRecord(settings.value.preferences) && settings.value.preferences.rerankerEnabled === true) {
            const candidates = finalHits.map(hit => {
              const candidate = hit.semanticCandidate;
              const span = hit.navigationSpan;
              if (!candidate || !span || candidate.sourcePath !== hit.path || candidate.sourceRevision !== hit.fileRevision ||
                  candidate.text !== span.quote || !candidate.evidence.some(evidence => evidence.path === span.path &&
                    evidence.revision === span.revision && evidence.start === span.start && evidence.end === span.end && evidence.quote === span.quote)) return undefined;
              return candidate;
            });
            if (candidates.length !== finalHits.length || candidates.some(candidate => !candidate)) {
              finalWarnings.push('再順位付けに必要な検証済み文章候補がそろっていません。元の順位を保持しました。');
            } else {
              const rerankedResult = await invokeRead(SEMANTIC, 'proprium.semantic.rerank', {
                query: trimmed, candidates, limit: Math.min(MAX_HITS, candidates.length),
              }, controller.signal);
              if (!current()) return;
              if (!rerankedResult.ok) finalWarnings.push(`再順位付けを利用できません。元の順位を保持しました: ${rerankedResult.error.message}`);
              else {
                const reranked = typedResult(rerankedResult, 'Semantic 再順位付け');
                const values = reranked.value.results;
                const candidateIds = new Set(candidates.map(candidate => candidate!.candidateId));
                if (!resultIdentityMatches(lexicalResult, reranked) || !snapshotMatches(reranked.value.snapshot, reranked.snapshot) ||
                    !Array.isArray(values) || values.length !== candidates.length ||
                    values.some(item => !isRecord(item) || typeof item.candidateId !== 'string' || !candidateIds.has(item.candidateId) ||
                      typeof item.score !== 'number' || !Number.isFinite(item.score) || !Number.isSafeInteger(item.rank))) {
                  finalWarnings.push('再順位付けの対応を検証できません。元の順位を保持しました。');
                } else {
                  const ranks = new Map(values.map(item => [(item as Record<string, unknown>).candidateId as string, (item as Record<string, unknown>).rank as number]));
                  if (new Set(ranks.values()).size !== finalHits.length || [...ranks.values()].some(rank => rank < 1 || rank > finalHits.length)) {
                    finalWarnings.push('再順位付けの順位が不正です。元の順位を保持しました。');
                  } else {
                    finalHits.sort((left, right) => ranks.get(left.semanticCandidate!.candidateId)! - ranks.get(right.semanticCandidate!.candidateId)!);
                  }
                }
              }
            }
          }
        } catch (error) {
          if (current() && !controller.signal.aborted) finalWarnings.push(`再順位付けを利用できません。元の順位を保持しました: ${error instanceof Error ? error.message : 'モデルを利用できません。'}`);
        }
      }
      if (!current()) return;
      setHits(finalHits); setWarnings(finalWarnings); setMessage(finalHits.length ? '検索結果を表示しています。' : '該当する文章はありません。');
    } catch (error) {
      if (!current()) return;
      const typed = error as { code?: unknown; message?: unknown };
      const detail = typeof typed.message === 'string' ? typed.message : '検索を完了できませんでした。';
      setHits(lexicalFallback ?? []);
      const semanticReason = typed.code === 'index_missing' ? 'Semantic インデックスがありません。タスクパネルで構築してください。'
        : typed.code === 'index_stale' ? 'Semantic インデックスが古くなっています。タスクパネルで再構築してください。'
          : typed.code === 'model_unavailable' ? 'Semantic モデルを利用できません。モデルの取得状態を確認してください。'
            : detail;
      setWarnings(SEMANTIC_MODES.has(mode) && lexicalFallback ? [`意味検索を完了できません。全文検索結果を保持しています: ${semanticReason}`] : []);
      setMessage(SEMANTIC_MODES.has(mode) && lexicalFallback ? '全文検索結果を表示しています。' : semanticReason);
    } finally {
      if (ticket === generation.current) { active.current = null; setBusy(false); }
    }
  }

  return <section className="research-semantic-search" aria-label="Research 検索">
    <h2>ワークスペース検索</h2>
    <form onSubmit={event => void run(event)}>
      <label>検索語<input value={query} maxLength={512} disabled={busy} onChange={event => setQuery(event.target.value)} required /></label>
      <label>対象パス（任意）<input value={pathScope} maxLength={1024} disabled={busy} placeholder="manuscript/" onChange={event => setPathScope(event.target.value)} /></label>
      <label>検索方法<select value={mode} disabled={busy} onChange={event => setMode(event.target.value as ResearchSemanticMode)}>
        <option value="lexical">全文</option><option value="exact">完全一致</option><option value="prefix">前方一致</option>
        <option value="hybrid">全文 + 意味</option><option value="semantic">意味のみ</option><option value="expression">表現</option>
      </select></label>
      <button type="submit" disabled={busy || !query.trim()}>検索</button>
      {busy && <button type="button" onClick={cancel}>検索をキャンセル</button>}
    </form>
    {message && <p role="status" aria-live="polite">{message}</p>}
    {warnings.length > 0 && <ul aria-label="検索の注意">{warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>}
    {hits.length > 0 && <ol aria-label="検索結果">{hits.map((hit, index) => <li key={`${hit.path}:${hit.fileRevision}:${hit.navigationSpan?.start ?? index}`}>
      <h3>{hit.title}</h3><p><code>{hit.path}</code></p><blockquote>{hit.snippet}</blockquote>
      <p>{hit.scoreFactors.join(' · ') || hit.source}</p>
      {hit.navigationSpan && <button type="button" disabled={busy} onClick={event => {
        const span = hit.navigationSpan!;
        void navigate(event.nativeEvent, { path: span.path, span: { path: span.path, revision: span.revision, start: span.start, end: span.end, ...(span.quote ? { quote: span.quote } : {}) } }, 'open')
          .catch(error => { setMessage(error instanceof Error ? error.message : '原文を開けませんでした。'); });
      }}>原文を開く</button>}
    </li>)}</ol>}
  </section>;
}
