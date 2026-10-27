import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { ActionResult } from './types.js';

export interface ResearchCandidateControlsProps {
  /** Changes with the selected actor, workspace, branch, or pinned snapshot. */
  scopeKey: string;
  /** Host must verify expectedScope against the current selection and honor the signal. */
  invokeRead: (expectedScope: string, actionId: 'research.terms.candidates', input: Record<string, unknown>, signal: AbortSignal) => Promise<ActionResult>;
}
type Candidate = { term: string; reading?: string; occurrenceCount: number; evidence: Array<{ sourceId: string; textId: string; revision: string; range: { start: number; end: number } }> };
type Page = { candidates: Candidate[]; nextCursor: string | null };
type Request = { corpus: { kind: 'text'; items: Array<{ id: string; revision: string; texts: Array<{ id: string; text: string }> }> }; knownTerms: string[]; limit: number };

/** Detached literal evidence is identified by the exact UTF-8 bytes, never as a saved file. */
export async function literalCandidateRequest(text: string, knownTerms: string): Promise<Request> {
  if (!text ||  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw new Error('解析する文章を入力してください。');
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 64 * 1024) throw new Error('文章は UTF-8 で 64 KiB 以下にしてください。');
  const known = knownTerms.split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
  if (known.length > 2000 || known.some(value => value.length > 256)) throw new Error('既知の語句は各 256 文字以内、2000 件以内にしてください。');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const revision = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { corpus: { kind: 'text', items: [{ id: 'literal', revision, texts: [{ id: 'literal', text }] }] }, knownTerms: known, limit: 50 };
}

export function ResearchCandidateControls({ scopeKey, invokeRead }: ResearchCandidateControlsProps): ReactElement {
  const scope = useRef(scopeKey); scope.current = scopeKey;
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const [text, setText] = useState('');
  const [known, setKnown] = useState('');
  const [request, setRequest] = useState<Request | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancel = () => { generation.current++; active.current?.abort(); active.current = null; setBusy(false); };
  useEffect(() => { cancel(); setText(''); setKnown(''); setRequest(null); setPage(null); setError(''); return () => { generation.current++; active.current?.abort(); }; }, [scopeKey]);
  const run = async (next?: { request: Request; cursor: string }) => {
    cancel(); const serial = ++generation.current; const expectedScope = scopeKey; const controller = new AbortController(); active.current = controller; setBusy(true); setError('');
    try {
      const input = next?.request ?? await literalCandidateRequest(text, known);
      if (generation.current !== serial || scope.current !== expectedScope || controller.signal.aborted) return;
      const result = await invokeRead(expectedScope, 'research.terms.candidates', { ...input, ...(next ? { cursor: next.cursor } : {}) }, controller.signal);
      if (generation.current !== serial || scope.current !== expectedScope || controller.signal.aborted) return;
      if (!result.ok) throw new Error(result.error.message);
      const value = result.value as Page;
      if (!value || !Array.isArray(value.candidates) || value.candidates.length > 50 || !(value.nextCursor === null || typeof value.nextCursor === 'string')) throw new Error('候補の結果を読み取れません。');
      setRequest(input); setPage(value);
    } catch (cause) { if (generation.current === serial && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : '候補を抽出できません。'); }
    finally { if (generation.current === serial) { active.current = null; setBusy(false); } }
  };
  const invalidate = () => { cancel(); setRequest(null); setPage(null); setError(''); };
  return <section aria-label="用語候補">
    <p>貼り付けた文章のみをローカルの日本語辞書で解析します。原稿の自動取得や外部送信はありません。辞書が利用できない場合は理由を表示します。</p>
    <label>解析する文章<textarea value={text} maxLength={65536} onChange={event => { invalidate(); setText(event.target.value); }} /></label>
    <label>除外する既知の語句（1 行に 1 件）<textarea value={known} maxLength={65536} onChange={event => { invalidate(); setKnown(event.target.value); }} /></label>
    <button type="button" disabled={busy || !text} onClick={() => void run()}>候補を抽出</button>
    {busy && <button type="button" onClick={cancel}>キャンセル</button>}
    {error && <p role="alert">{error}</p>}
    {page && <><table><caption>用語候補</caption><thead><tr><th>語句</th><th>読み</th><th>出現回数</th><th>入力内の根拠（UTF-16）</th></tr></thead><tbody>{page.candidates.map((candidate, i) => <tr key={`${candidate.term}-${i}`}><td>{candidate.term}</td><td>{candidate.reading ?? '—'}</td><td>{candidate.occurrenceCount}</td><td>{candidate.evidence.map((e, j) => <span key={j}>{j ? '、' : ''}{e.range.start}–{e.range.end}: {text.slice(e.range.start, e.range.end)}</span>)}</td></tr>)}</tbody></table>
      {!page.candidates.length && <p>候補はありません。</p>}
      {page.nextCursor && request && <button type="button" disabled={busy} onClick={() => void run({ request, cursor: page.nextCursor! })}>次の候補</button>}</>}
  </section>;
}
