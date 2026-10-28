import { useEffect, useRef, useState, type MouseEvent, type ReactElement } from "react";
import type { ActionResult } from "./types.js";
import { literalCandidateRequest } from "./ResearchCandidateControls.js";
import {
  evidenceQuote,
  parseResearchTermCandidates,
  parseSemanticTermClusters,
  semanticEmbeddingChoice,
  synonymProposalInput,
  toSemanticTermCandidates,
  type ResearchTermCandidate,
  type SemanticTermCluster,
  type SynonymGroupRef,
} from "./ResearchTermClusters.helpers.js";

type ReadPlugin = "proprium.research" | "proprium.semantic";
type ReadAction = "research.terms.candidates" | "research.synonyms.get" | "proprium.semantic.index.status" | "proprium.semantic.terms.cluster";
type Read = (expectedScope: string, pluginId: ReadPlugin, actionId: ReadAction, input: Record<string, unknown>, signal: AbortSignal) => Promise<ActionResult>;
type Propose = (event: Event, expectedScope: string, pluginId: "proprium.research", actionId: "research.synonyms.propose", input: Record<string, unknown>) => Promise<ActionResult>;

export interface ResearchTermClustersProps {
  /** Host identity for the selected workspace, branch, generation and snapshot. */
  scopeKey: string;
  /** Host dispatcher verifies the expected scope both before and after the action. */
  invokeRead: Read;
  /** Only called directly from the author's click on the proposal button. */
  invokeUi: Propose;
  /** Refreshes the Host Review receipt list after a proposal is created. */
  onProposalCreated?: () => void;
}

type Phase = "idle" | "extracting" | "checking-model" | "clustering" | "ready" | "error";
type ModelState = "none" | "checking" | "warm" | "cold" | "unknown";
type CandidateRequest = Awaited<ReturnType<typeof literalCandidateRequest>>;

/** Host-owned entry from bounded Research candidate discovery to one guarded Research synonym proposal. */
export function ResearchTermClusters({ scopeKey, invokeRead, invokeUi, onProposalCreated }: ResearchTermClustersProps): ReactElement {
  const scope = useRef(scopeKey); scope.current = scopeKey;
  const readRef = useRef(invokeRead); readRef.current = invokeRead;
  const uiRef = useRef(invokeUi); uiRef.current = invokeUi;
  const proposalCallbackRef = useRef(onProposalCreated); proposalCallbackRef.current = onProposalCreated;
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const [text, setText] = useState("");
  const [known, setKnown] = useState("");
  const [request, setRequest] = useState<CandidateRequest | null>(null);
  const [candidatePage, setCandidatePage] = useState<{ candidates: ResearchTermCandidate[]; nextCursor: string | null } | null>(null);
  const [pageNumber, setPageNumber] = useState(0);
  const [clusters, setClusters] = useState<SemanticTermCluster[]>([]);
  const [modelState, setModelState] = useState<ModelState>("none");
  const [modelMessage, setModelMessage] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");

  const isCurrent = (serial: number, expectedScope: string, controller: AbortController): boolean =>
    generation.current === serial && scope.current === expectedScope && !controller.signal.aborted;
  const cancel = () => {
    generation.current++;
    active.current?.abort();
    active.current = null;
    setPhase("idle"); setModelState("none"); setModelMessage("");
  };
  const clearResults = () => {
    setRequest(null); setCandidatePage(null); setPageNumber(0); setClusters([]);
    setModelState("none"); setModelMessage(""); setError("");
  };

  useEffect(() => {
    generation.current++;
    active.current?.abort(); active.current = null;
    setText(""); setKnown(""); clearResults(); setPhase("idle");
    return () => { generation.current++; active.current?.abort(); active.current = null; };
  }, [scopeKey]);

  const run = async (nextPage = false) => {
    cancel();
    const serial = ++generation.current;
    const expectedScope = scopeKey;
    const controller = new AbortController(); active.current = controller;
    setError(""); setCandidatePage(null); setClusters([]); setModelState("checking"); setModelMessage("");
    setPhase("extracting");
    try {
      const input = nextPage
        ? request
        : await literalCandidateRequest(text, known);
      if (!input) throw new Error("次の候補ページを読み込めません。もう一度候補を抽出してください。");
      if (!isCurrent(serial, expectedScope, controller)) return;
      const cursor = nextPage ? candidatePage?.nextCursor : null;
      if (nextPage && !cursor) throw new Error("次の候補ページがありません。");
      const candidateValue = await readAction(expectedScope, "proprium.research", "research.terms.candidates", {
        ...input,
        ...(cursor ? { cursor } : {}),
      }, controller.signal);
      if (!isCurrent(serial, expectedScope, controller)) return;
      const page = parseResearchTermCandidates(candidateValue, 50);
      setRequest(input); setCandidatePage(page); setPageNumber(value => nextPage ? value + 1 : 1);
      if (page.candidates.length === 0) {
        setModelState("none"); setModelMessage("候補がありません。既知の語句を除外しすぎていないか確認してください。");
        setClusters([]); setPhase("ready"); return;
      }

      setPhase("checking-model"); setModelState("checking");
      let useEmbedding = false;
      try {
        const status = await readAction(expectedScope, "proprium.semantic", "proprium.semantic.index.status", {}, controller.signal);
        const readiness = semanticEmbeddingChoice(status);
        if (readiness.state !== "unknown") {
          useEmbedding = readiness.useEmbedding;
          setModelState(readiness.state);
          setModelMessage(useEmbedding
            ? "署名済みモデルはこの実行時に読み込み済みです。埋め込みクラスタも計算します。"
            : "モデルは読み込み済みではありません。取得や起動はせず、表記・読みの決定的クラスタだけを計算します。");
        } else {
          setModelState("unknown");
          setModelMessage("モデル状態を確認できません。モデルを起動せず、決定的クラスタだけを計算します。");
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        useEmbedding = false;
        setModelState("unknown");
        setModelMessage(`モデル状態を確認できないため、モデルを起動せず決定的クラスタだけを計算します。${messageOf(cause)}`);
      }
      if (!isCurrent(serial, expectedScope, controller)) return;

      setPhase("clustering");
      const semanticCandidates = toSemanticTermCandidates(page.candidates);
      const clusterValue = await readAction(expectedScope, "proprium.semantic", "proprium.semantic.terms.cluster", {
        candidates: semanticCandidates,
        useEmbedding,
      }, controller.signal);
      if (!isCurrent(serial, expectedScope, controller)) return;
      setClusters(parseSemanticTermClusters(clusterValue)); setPhase("ready");
    } catch (cause) {
      if (!isCurrent(serial, expectedScope, controller)) return;
      setError(messageOf(cause)); setPhase("error");
    } finally {
      if (generation.current === serial) { active.current = null; }
    }
  };

  const invalidate = () => { cancel(); clearResults(); };
  const texts = new Map<string, string>();
  for (const source of request?.corpus.items ?? []) {
    for (const row of source.texts) texts.set(`${source.id}\u0000${row.id}`, row.text);
  }

  return <section aria-label="Research の用語クラスタ">
    <p>貼り付けた文章をローカルの Research と Semantic で解析します。文章は原稿に書き戻されません。モデルはすでに承認済みで実行時に読み込み済みの場合だけ使います。</p>
    <label>解析する文章<textarea aria-label="解析する文章" value={text} maxLength={65536} onChange={event => { invalidate(); setText(event.target.value); }} /></label>
    <label>除外する既知の語句（1 行に 1 件）<textarea aria-label="除外する既知の語句" value={known} maxLength={65536} onChange={event => { invalidate(); setKnown(event.target.value); }} /></label>
    <button type="button" disabled={isBusy(phase) || !text.trim()} onClick={() => void run(false)}>候補と用語クラスタを抽出</button>
    {phase === "extracting" && <p role="status">Research が候補を抽出しています…</p>}
    {phase === "checking-model" && <p role="status">モデルの読み込み状態を確認しています…</p>}
    {phase === "clustering" && <p role="status">Semantic が用語クラスタを計算しています…</p>}
    {isBusy(phase) && <button type="button" onClick={cancel}>キャンセル</button>}
    {modelMessage && <p role="status">{modelMessage}</p>}
    {modelState !== "none" && <p data-model-state={modelState}>埋め込みモデル状態: {modelStateLabel(modelState)}</p>}
    {error && <p role="alert">{error}</p>}
    {candidatePage && <>
      <p role="status">候補ページ {pageNumber} · {candidatePage.candidates.length} 件</p>
      <section aria-label="抽出した候補">
        <h3>抽出した候補</h3>
        <ul>{candidatePage.candidates.map(candidate => <li key={candidate.term}>
          <strong>{candidate.term}</strong>{candidate.reading && <>（{candidate.reading}）</>} · {candidate.occurrenceCount} 回 · {candidate.sourceIds.length} 件の出典
        </li>)}</ul>
      </section>
      <section aria-label="用語クラスタ">
        <h3>関連する語句</h3>
        {clusters.length === 0
          ? <p>この候補ページに表記または読みが近い語句のグループはありません。</p>
          : <ul>{clusters.map(cluster => <li key={`${cluster.canonical}:${cluster.variants.join("|")}`}>
            <TermClusterCard key={`${scopeKey}:${cluster.canonical}`} scopeKey={scopeKey} cluster={cluster}
              candidates={candidatePage.candidates} texts={texts} invokeRead={invokeRead} invokeUi={invokeUi} onProposalCreated={onProposalCreated} />
          </li>)}</ul>}
      </section>
      {candidatePage.nextCursor && <button type="button" disabled={isBusy(phase)} onClick={() => void run(true)}>次の候補ページ</button>}
    </>}
  </section>;

  async function readAction(expectedScope: string, pluginId: ReadPlugin, actionId: ReadAction, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const result = await readRef.current(expectedScope, pluginId, actionId, input, signal);
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.value;
  }
}

interface TermClusterCardProps {
  scopeKey: string;
  cluster: SemanticTermCluster;
  candidates: ResearchTermCandidate[];
  texts: ReadonlyMap<string, string>;
  invokeRead: Read;
  invokeUi: Propose;
  onProposalCreated?: () => void;
}

function TermClusterCard({ scopeKey, cluster, candidates, texts, invokeRead, invokeUi, onProposalCreated }: TermClusterCardProps): ReactElement {
  const readRef = useRef(invokeRead); readRef.current = invokeRead;
  const uiRef = useRef(invokeUi); uiRef.current = invokeUi;
  const callbackRef = useRef(onProposalCreated); callbackRef.current = onProposalCreated;
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [targetState, setTargetState] = useState<"idle" | "loading" | "ready" | "error" | "no-change">("idle");
  const [target, setTarget] = useState<{ expectedFileRevision: string | null; mergeGroupRef?: SynonymGroupRef; existingWords: string[] } | null>(null);
  const [targetError, setTargetError] = useState("");
  const [proposalState, setProposalState] = useState<"idle" | "submitting" | "proposed" | "error">("idle");
  const [proposalMessage, setProposalMessage] = useState("");
  const selectedKey = selected.join("\u0000");

  useEffect(() => {
    active.current?.abort(); active.current = null;
    const serial = ++generation.current;
    setTarget(null); setTargetError(""); setProposalMessage(""); setProposalState("idle");
    if (selected.length === 0) { setTargetState("idle"); return; }
    const controller = new AbortController(); active.current = controller;
    setTargetState("loading");
    const words = [cluster.canonical, ...selected];
    void (async () => {
      try {
        const values = await Promise.all(words.map(async term => {
          const result = await readRef.current(scopeKey, "proprium.research", "research.synonyms.get", { term }, controller.signal);
          if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
          return parseSynonymRead(result.value);
        }));
        if (generation.current !== serial || controller.signal.aborted) return;
        const revisions = new Set(values.map(value => value.fileRevision));
        if (revisions.size !== 1) throw new Error("辞書が読み取り中に変わりました。候補を再抽出してください。");
        const refs = uniqueGroupRefs(values.map(value => value.groupRef).filter((value): value is SynonymGroupRef => value !== undefined));
        if (refs.length > 1) throw new Error("選択語が複数の同義語グループに属しています。選択を絞るか、辞書を先に整理してください。");
        const mergeGroupRef = refs[0];
        const existingWords = mergeGroupRef ? [...mergeGroupRef.words] : [];
        const revision = values[0]?.fileRevision ?? null;
        const nextTarget = { expectedFileRevision: revision, ...(mergeGroupRef ? { mergeGroupRef } : {}), existingWords };
        setTarget(nextTarget);
        const proposedWords = [cluster.canonical, ...selected];
        const changesDictionary = proposedWords.some(word => !existingWords.includes(word));
        setTargetState(changesDictionary ? "ready" : "no-change");
      } catch (cause) {
        if (controller.signal.aborted || generation.current !== serial) return;
        setTargetError(messageOf(cause)); setTargetState("error");
      } finally {
        if (generation.current === serial) active.current = null;
      }
    })();
    return () => { generation.current++; controller.abort(); };
  // Use selectedKey because the array is recreated when authors toggle checkboxes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, cluster.canonical, selectedKey]);

  const candidateByTerm = new Map(candidates.map(candidate => [candidate.term, candidate]));
  const proposedWords = [cluster.canonical, ...selected];
  const submit = (event: MouseEvent<HTMLButtonElement>) => {
    if (!target || targetState !== "ready" || selected.length === 0 || proposalState === "submitting") return;
    const input = synonymProposalInput({ canonical: cluster.canonical, variants: selected,
      expectedFileRevision: target.expectedFileRevision, ...(target.mergeGroupRef ? { mergeGroupRef: target.mergeGroupRef } : {}) });
    setProposalState("submitting"); setProposalMessage("");
    let pending: Promise<ActionResult>;
    try {
      pending = uiRef.current(event.nativeEvent, scopeKey, "proprium.research", "research.synonyms.propose", input);
    } catch (cause) {
      setProposalState("error"); setProposalMessage(messageOf(cause)); return;
    }
    void pending.then(result => {
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      const value = isRecord(result.value) ? result.value : {};
      const id = typeof value.changeSetId === "string" ? value.changeSetId : "";
      setProposalState("proposed");
      setProposalMessage(id ? `Host Review に提案を作成しました（${id}）。` : "Host Review に提案を作成しました。");
      try { callbackRef.current?.(); } catch { /* A refresh failure does not undo a created proposal. */ }
    }).catch(cause => { setProposalState("error"); setProposalMessage(messageOf(cause)); });
  };

  return <section aria-label={`${cluster.canonical} の用語クラスタ`} className="research-term-cluster">
    <h4>代表表記: {cluster.canonical}</h4>
    <p>{cluster.semanticOnly
      ? "モデルのみの意味類似候補です。辞書に追加するかは作者が選べます。"
      : "表記または読みの規則で一致した候補です。"}</p>
    <ul aria-label={`${cluster.canonical} の根拠`}>
      {[cluster.canonical, ...cluster.variants].map(term => {
        const candidate = candidateByTerm.get(term);
        const already = target?.existingWords.includes(term) ?? false;
        return <li key={term}>
          <label><input type="checkbox" checked={selected.includes(term)} disabled={term === cluster.canonical || proposalState === "submitting" || (already && !selected.includes(term))}
            onChange={event => {
              setProposalState("idle"); setProposalMessage("");
              setSelected(current => event.target.checked
                ? [...current, term]
                : current.filter(value => value !== term));
            }} />
            {term === cluster.canonical ? <strong>{term}</strong> : term}
            {candidate?.reading ? `（${candidate.reading}）` : ""} · {candidate?.occurrenceCount ?? 0} 回
            {already ? " · 登録済み" : ""}
          </label>
          {candidate?.evidence.map((evidence, index) => {
            const quote = evidenceQuote(evidence, texts);
            return <p key={`${evidence.sourceId}:${evidence.textId}:${evidence.range.start}:${index}`}>
              根拠: {evidence.path ?? `貼り付けた文章 · ${evidence.sourceId}`} · 改訂 {evidence.revision.slice(0, 12)} · UTF-16 {evidence.range.start}–{evidence.range.end}
              {quote !== null ? <>「{quote}」</> : "（引用を表示できません）"}
            </p>;
          })}
        </li>;
      })}
    </ul>
    {selected.length > 0 && <>
      {targetState === "loading" && <p role="status">同義語辞書の改訂を確認しています…</p>}
      {targetState === "error" && <p role="alert">{targetError}</p>}
      {targetState === "no-change" && <p role="status">選択した語句はすでに同じ同義語グループに登録されています。</p>}
      {proposalState === "proposed" && <p role="status">{proposalMessage}</p>}
      {proposalState === "error" && <p role="alert">{proposalMessage}</p>}
      <button type="button" disabled={targetState !== "ready" || proposalState === "submitting" || proposalState === "proposed"}
        onClick={submit}>{proposalState === "submitting" ? "提案を作成しています…" : "選択した別名を Host Review に提案"}</button>
      {proposalState === "submitting" && <p role="status">{proposedWords.join(" · ")} を改訂ガード付きで提案しています…</p>}
    </>}
  </section>;
}

function parseSynonymRead(value: unknown): { fileRevision: string | null; groupRef?: SynonymGroupRef } {
  if (!isRecord(value) || !(value.fileRevision === null || typeof value.fileRevision === "string")) {
    throw new Error("同義語辞書の改訂を読み取れません。");
  }
  if (value.groupRef === undefined) return { fileRevision: value.fileRevision };
  if (!isRecord(value.groupRef) || typeof value.groupRef.fileRevision !== "string" ||
      !Number.isSafeInteger(value.groupRef.ordinal) || (value.groupRef.ordinal as number) < 0 ||
      !Array.isArray(value.groupRef.words) || value.groupRef.words.some(word => typeof word !== "string") ||
      !(value.groupRef.context === undefined || value.groupRef.context === "positive" || value.groupRef.context === "negative")) {
    throw new Error("同義語辞書のグループ参照が正しくありません。");
  }
  if (value.groupRef.fileRevision !== value.fileRevision) throw new Error("同義語グループと辞書の改訂が一致しません。");
  return {
    fileRevision: value.fileRevision,
    groupRef: {
      fileRevision: value.groupRef.fileRevision,
      ordinal: value.groupRef.ordinal as number,
      words: value.groupRef.words as string[],
      ...(value.groupRef.context === "positive" || value.groupRef.context === "negative" ? { context: value.groupRef.context } : {}),
    },
  };
}

function uniqueGroupRefs(refs: SynonymGroupRef[]): SynonymGroupRef[] {
  const byIdentity = new Map<string, SynonymGroupRef>();
  for (const ref of refs) byIdentity.set(JSON.stringify([ref.fileRevision, ref.ordinal, ref.words, ref.context ?? null]), ref);
  return [...byIdentity.values()];
}

function isBusy(phase: Phase): boolean { return phase === "extracting" || phase === "checking-model" || phase === "clustering"; }
function modelStateLabel(state: ModelState): string {
  return state === "warm" ? "読み込み済み" : state === "cold" ? "未読み込み" : state === "unknown" ? "確認不能" : state === "checking" ? "確認中" : "未確認";
}
function messageOf(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: unknown }).code;
    return typeof code === "string" ? `${code}: ${cause.message}` : cause.message;
  }
  return "用語候補を処理できませんでした。";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
