import { useEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import type { ActionResult } from "../../authoring/types.js";
import { isValidEditorRange } from "../../../../editor/terms.js";
import {
  evidenceQuote,
  parseResearchTermCandidates,
  type ResearchTermCandidate,
} from "../../authoring/ResearchTermClusters.helpers.js";

const RESEARCH = "proprium.research";
const KNOWLEDGE = "proprium.knowledge";
const MAX_ENTITY_ROWS = 200;
const MAX_CORPUS_ENTITIES = 128;
const MAX_SOURCE_TEXTS = 64;
const MAX_SOURCE_TEXT_UTF16 = 8_192;
const MAX_SOURCE_TEXT_BYTES = 32 * 1024;

type KnowledgeEntityType = "character" | "location" | "item" | "faction" | "event" | "lore" | "thread" | "arc" | "dialogue_sketch";

const ENTITY_TYPES: readonly KnowledgeEntityType[] = [
  "character", "location", "item", "faction", "event", "lore", "thread", "arc", "dialogue_sketch",
];

export interface KnowledgeEntity {
  id: string;
  type: string;
  name: string;
  aliases: string[];
  path: string;
  revision: string;
  raw: Record<string, unknown>;
}

interface CorpusText { id: string; text: string }
interface CandidateSource { id: string; path: string; revision: string; texts: CorpusText[] }
export interface KnowledgeCorpus {
  items: CandidateSource[];
  texts: Map<string, string>;
  knownTerms: string[];
}

interface CandidatePage { candidates: ResearchTermCandidate[]; nextCursor: string | null; ignoreListRevision: string | null }
interface IgnoredTerms { fileRevision: string | null; terms: string[] }
interface LegacyFeature {
  id: string;
  label: string;
  locality: "local" | "external";
  legacyEnabled: boolean;
  requiresHostGrant: boolean;
}
interface LegacyConsent { features: LegacyFeature[]; unknownExternal: Array<{ id: string; enabled: boolean | null }> }

export interface ResearchReviewProps {
  /** Must change when the active repository, branch, manifest set, or Host snapshot changes. */
  readonly scopeKey: string;
  readonly knowledgeAvailable: boolean;
  /** Host-owned async index controls; the Research panel provides no privileged runtime path. */
  readonly taskControls?: ReactNode;
  invokeRead(expectedScope: string, pluginId: string, actionId: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ActionResult>;
  invokeUi(event: Event, pluginId: string, actionId: string, input: Record<string, unknown>): Promise<ActionResult>;
  onProposalCreated?(): void;
  /** Opens the Host's normal Plugin Manager view. It must not install, enable, or grant anything. */
  onOpenPluginManager?(event: Event, pluginId: string): void;
}

/** Host-rendered Research handoffs. All source reading and edits remain signed Host actions. */
export function ResearchReview({ scopeKey, knowledgeAvailable, taskControls, invokeRead, invokeUi, onProposalCreated, onOpenPluginManager }: ResearchReviewProps): ReactElement {
  const scopeRef = useRef(scopeKey); scopeRef.current = scopeKey;
  const readRef = useRef(invokeRead); readRef.current = invokeRead;
  const uiRef = useRef(invokeUi); uiRef.current = invokeUi;
  const proposalCallbackRef = useRef(onProposalCreated); proposalCallbackRef.current = onProposalCreated;
  const managerCallbackRef = useRef(onOpenPluginManager); managerCallbackRef.current = onOpenPluginManager;
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const [ignored, setIgnored] = useState<IgnoredTerms | null>(null);
  const [legacy, setLegacy] = useState<LegacyConsent | null>(null);
  const [legacyError, setLegacyError] = useState("");
  const [ignoreError, setIgnoreError] = useState("");
  const [entities, setEntities] = useState<KnowledgeEntity[]>([]);
  const [collectionRevision, setCollectionRevision] = useState("");
  const [entityNextCursor, setEntityNextCursor] = useState<string | null>(null);
  const [entitySnapshot, setEntitySnapshot] = useState<{ scope: ActionResult["scope"]; snapshot: ActionResult["snapshot"] } | null>(null);
  const [entityLoadState, setEntityLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [entityError, setEntityError] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [candidatePage, setCandidatePage] = useState<CandidatePage | null>(null);
  const [corpus, setCorpus] = useState<KnowledgeCorpus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [entityTypes, setEntityTypes] = useState<Record<string, KnowledgeEntityType | undefined>>({});
  const [proposalBusy, setProposalBusy] = useState<string | null>(null);
  const [proposalMessages, setProposalMessages] = useState<Record<string, string>>({});

  useEffect(() => {
    generation.current++;
    active.current?.abort(); active.current = null;
    setIgnored(null); setLegacy(null); setLegacyError(""); setIgnoreError("");
    setEntities([]); setCollectionRevision(""); setEntityNextCursor(null); setEntitySnapshot(null); setSelectedIds([]); setCandidatePage(null); setCorpus(null);
    setEntityLoadState("idle"); setEntityError(""); setBusy(false); setMessage(""); setError("");
    setProposalBusy(null); setProposalMessages({});
    const serial = generation.current;
    const expectedScope = scopeKey;
    const controller = new AbortController(); active.current = controller;
    const current = () => generation.current === serial && scopeRef.current === expectedScope && !controller.signal.aborted;
    void Promise.all([
      readAction(expectedScope, RESEARCH, "research.legacy-consent.read", {}, controller.signal),
      readAction(expectedScope, RESEARCH, "research.candidates.ignore.list", {}, controller.signal),
    ]).then(([legacyResult, ignoredResult]) => {
      if (!current()) return;
      if (legacyResult.ok) setLegacy(parseLegacyConsent(legacyResult.value));
      else setLegacyError(legacyResult.error.message);
      if (ignoredResult.ok) setIgnored(parseIgnoredTerms(ignoredResult.value));
      else setIgnoreError(ignoredResult.error.message);
    }).catch(cause => {
      if (!current()) return;
      setLegacyError(messageOf(cause)); setIgnoreError(messageOf(cause));
    }).finally(() => { if (active.current === controller) active.current = null; });
    return () => { generation.current++; controller.abort(); if (active.current === controller) active.current = null; };
  }, [scopeKey]);

  useEffect(() => {
    if (knowledgeAvailable) return;
    setEntities([]); setCollectionRevision(""); setEntityNextCursor(null); setEntitySnapshot(null); setSelectedIds([]); setCandidatePage(null); setCorpus(null);
    setEntityLoadState("idle"); setEntityError("");
  }, [knowledgeAvailable, scopeKey]);

  const cancel = () => {
    generation.current++;
    active.current?.abort(); active.current = null;
    setBusy(false);
  };

  return <section className="research-review" aria-label="Research 候補のレビュー">
    {taskControls}
    <details>
      <summary>旧 NLP 外部送信設定と Host 権限</summary>
      <p>旧設定は履歴として表示します。Git 内の値から Host 権限を付与することはありません。外部通信には、署名済みプラグインの権限確認と送信ごとの Host 承認が必要です。</p>
      {legacyError && <p role="alert">旧設定を読み込めません: {legacyError}</p>}
      {!legacy && !legacyError && <p role="status">旧設定を確認しています…</p>}
      {legacy && <>
        <ul aria-label="旧 NLP 機能と送信設定">
          {legacy.features.map(feature => {
            return <li key={feature.id} data-legacy-feature={feature.id}>
              <strong>{feature.label}</strong> · {feature.locality === "local" ? "ローカル機能" : "旧外部機能"} · 旧設定: {feature.legacyEnabled ? "有効" : "無効"}
              {feature.locality === "external" && <p>現在の有効な Proprium 機能に対応付けられていません。旧設定は実行も許可もされず、Host 権限へ引き継がれません。</p>}
            </li>;
          })}
          {legacy.unknownExternal.map(feature => <li key={`unknown:${feature.id}`} data-legacy-feature={feature.id}>
            <strong>{feature.id}</strong> · 未対応の旧外部機能 · 旧設定: {feature.enabled === null ? "不正な値（無効）" : feature.enabled ? "有効" : "無効"} · Host 権限はありません。
          </li>)}
        </ul>
        <button type="button" onClick={event => managerCallbackRef.current?.(event.nativeEvent, RESEARCH)}>Host Plugin Manager で現在の署名済み権限を確認</button>
        {!legacy.features.some(feature => feature.locality === "external") && legacy.unknownExternal.length === 0 && <p>外部送信を示す旧設定はありません。</p>}
      </>}
    </details>

    <details>
      <summary>無視した候補</summary>
      {ignoreError && <p role="alert">無視リストを読めません: {ignoreError}</p>}
      {!ignored && !ignoreError && <p role="status">無視リストを確認しています…</p>}
      {ignored && ignored.terms.length === 0 && <p>無視した候補はありません。</p>}
      {ignored && ignored.terms.length > 0 && <ul aria-label="無視した候補">
        {ignored.terms.map(term => <li key={term}>
          <span>{term}</span>
          <button type="button" disabled={proposalBusy !== null} onClick={event => void proposeIgnore(event.nativeEvent, [term], false)}>
            Host Review に復元を提案
          </button>
          {proposalMessages[term] && <span role="status">{proposalMessages[term]}</span>}
        </li>)}
      </ul>}
    </details>

    <section aria-label="Knowledge の用語候補">
      <h3>Knowledge の文章から候補を抽出</h3>
      {!knowledgeAvailable && <p>Knowledge が有効ではありません。手入力した文章の候補抽出は Research の「用語候補」から利用できます。</p>}
      {knowledgeAvailable && <>
        <p>選んだ Knowledge エンティティの文章を、現在の Git 改訂に結び付けてローカル解析します。原稿やエンティティは自動変更されません。</p>
        <button type="button" disabled={entityLoadState === "loading"} onClick={() => void loadEntities()}>
          {entityLoadState === "loading" ? "エンティティを読み込んでいます…" : entities.length ? "Knowledge エンティティを再読込" : "Knowledge エンティティを選ぶ"}
        </button>
        {entityError && <p role="alert">{entityError}</p>}
        {entities.length > 0 && <>
          <p role="status">{entities.length} 件を読み込みました。候補解析に含めるエンティティを選んでください（最大 {MAX_CORPUS_ENTITIES} 件）。</p>
          {collectionRevision && <p>Knowledge コレクション改訂: {collectionRevision.slice(0, 12)}</p>}
          <ul aria-label="解析する Knowledge エンティティ">
            {entities.map(entity => <li key={`${entity.id}:${entity.path}`}>
              <label><input type="checkbox" checked={selectedIds.includes(entity.id)} disabled={!selectedIds.includes(entity.id) && selectedIds.length >= MAX_CORPUS_ENTITIES}
                onChange={event => setSelectedIds(current => event.target.checked
                  ? current.length >= MAX_CORPUS_ENTITIES ? current : [...current, entity.id]
                  : current.filter(id => id !== entity.id))} />
                {entity.name || entity.id} · {entity.type} · {entity.path}
              </label>
            </li>)}
          </ul>
          {entityNextCursor && <button type="button" disabled={entityLoadState === "loading"} onClick={() => void loadEntities(entityNextCursor)}>次の 200 件を読み込む</button>}
          <button type="button" disabled={busy || selectedIds.length === 0 || selectedIds.length > MAX_CORPUS_ENTITIES || ignored === null}
            onClick={() => void discover()}>{busy ? "候補を解析しています…" : "選択した文章から候補を抽出"}</button>
          {busy && <button type="button" onClick={cancel}>キャンセル</button>}
          {message && <p role="status">{message}</p>}
          {error && <p role="alert">{error}</p>}
          {candidatePage && corpus && <>
            <p role="status">候補 {candidatePage.candidates.length} 件 · Research 辞書 {candidatePage.ignoreListRevision?.slice(0, 12) ?? "初期改訂"}</p>
            <ul aria-label="Knowledge から抽出した用語候補">
              {candidatePage.candidates.map(candidate => <CandidateCard key={candidate.term} candidate={candidate} texts={corpus.texts}
                entityTypes={entityTypes} onEntityTypeChange={(type) => setEntityTypes(current => ({ ...current, [candidate.term]: type }))}
                proposalBusy={proposalBusy !== null} proposalMessage={proposalMessages[candidate.term] ?? proposalMessages[`entity:${candidate.term}`]}
                canCreateEntity={collectionRevision !== "" && knowledgeAvailable} onCreateEntity={(event, type) => void proposeEntity(event, candidate, type)}
                onIgnore={event => void proposeIgnore(event.nativeEvent, [candidate.term], true)}
                onUnignore={event => void proposeIgnore(event.nativeEvent, [candidate.term], false)}
                isIgnored={ignored?.terms.includes(candidate.term) ?? false} />)}
            </ul>
            {candidatePage.nextCursor && <button type="button" disabled={busy} onClick={() => void discover(candidatePage.nextCursor!)}>次の候補</button>}
            {!candidatePage.candidates.length && <p>候補はありません。</p>}
          </>}
        </>}
      </>}
    </section>
  </section>;

  async function readAction(expectedScope: string, pluginId: string, actionId: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ActionResult> {
    const result = await readRef.current(expectedScope, pluginId, actionId, input, signal);
    if (scopeRef.current !== expectedScope || signal.aborted) throw Object.assign(new Error("選択中のワークスペースが変わりました。"), { code: "snapshot_stale" });
    return result;
  }

  async function loadEntities(cursor?: string): Promise<void> {
    const expectedScope = scopeKey;
    const append = typeof cursor === "string";
    cancel();
    const serial = ++generation.current;
    const controller = new AbortController(); active.current = controller;
    setEntityLoadState("loading"); setEntityError(""); setCandidatePage(null); setCorpus(null); setError(""); setMessage("");
    if (!append) { setSelectedIds([]); setEntityNextCursor(null); setEntitySnapshot(null); }
    try {
      const result = await readAction(expectedScope, KNOWLEDGE, "knowledge.entities.list", { limit: MAX_ENTITY_ROWS, ...(cursor ? { cursor } : {}) }, controller.signal);
      if (generation.current !== serial || controller.signal.aborted) return;
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      const page = parseKnowledgeEntityPage(result.value);
      if (append && (!entitySnapshot || !sameScopeSnapshot(entitySnapshot, result) || page.collectionRevision !== collectionRevision)) {
        throw Object.assign(new Error("Knowledge の改訂中にエンティティ一覧が変わりました。先頭から読み直してください。"), { code: "snapshot_stale" });
      }
      setEntities(current => append ? [...current, ...page.entities.filter(entity => !current.some(existing => existing.id === entity.id))] : page.entities);
      setCollectionRevision(page.collectionRevision); setEntityNextCursor(page.nextCursor); setEntitySnapshot({ scope: result.scope, snapshot: result.snapshot }); setEntityLoadState("ready");
      if (!append && page.entities.length > 0) setSelectedIds(page.entities.slice(0, MAX_CORPUS_ENTITIES).map(entity => entity.id));
      setMessage(page.nextCursor
        ? append ? `${entities.length + page.entities.length} 件を読み込みました。必要なエンティティを選択してください。`
          : `最初の ${page.entities.length} 件を表示しています。必要なエンティティを選択してください。`
        : "");
    } catch (cause) {
      if (generation.current !== serial || controller.signal.aborted) return;
      setEntityLoadState("error"); setEntityError(messageOf(cause));
      if (!append) { setEntities([]); setCollectionRevision(""); setEntityNextCursor(null); setEntitySnapshot(null); }
    } finally { if (generation.current === serial) active.current = null; }
  }

  async function discover(cursor?: string): Promise<void> {
    if (!ignored) { setIgnoreError("候補の除外状態を確認できないため解析できません。"); return; }
    const expectedScope = scopeKey;
    cancel();
    const serial = ++generation.current;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setCandidatePage(null); setError(""); setMessage("Knowledge の改訂を確認しています…");
    try {
      const selected = entities.filter(entity => selectedIds.includes(entity.id));
      if (selected.length < 1 || selected.length > MAX_CORPUS_ENTITIES) throw new Error(`解析するエンティティを 1〜${MAX_CORPUS_ENTITIES} 件選んでください。`);
      const nextCorpus = buildKnowledgeCorpus(selected, entities);
      if (nextCorpus.items.length < 1) throw new Error("選んだエンティティに解析可能な文章がありません。");
      setCorpus(nextCorpus);
      const ignoredResult = await readAction(expectedScope, RESEARCH, "research.candidates.ignore.list", {}, controller.signal);
      if (generation.current !== serial || controller.signal.aborted) return;
      if (!ignoredResult.ok) throw Object.assign(new Error(ignoredResult.error.message), { code: ignoredResult.error.code });
      const ignoreObservation = observeIgnoredTerms(ignored, parseIgnoredTerms(ignoredResult.value));
      const latestIgnored = ignoreObservation.terms;
      setIgnored(latestIgnored);
      // A reviewed ignore/unignore proposal may have changed the file since this panel mounted.
      // This explicit discovery action adopts the newly read revision; the candidate response
      // must still match it and the same Host snapshot as the selected Knowledge corpus.
      const request = {
        corpus: { kind: "knowledge-entities", items: nextCorpus.items },
        knownTerms: nextCorpus.knownTerms,
        includeReadings: true,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      };
      const result = await readAction(expectedScope, RESEARCH, "research.terms.candidates", request, controller.signal);
      if (generation.current !== serial || controller.signal.aborted) return;
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      if (!entitySnapshot || !sameScopeSnapshot(entitySnapshot, result) || !sameScopeSnapshot(ignoredResult, result)) {
        throw Object.assign(new Error("Knowledge コーパス、無視リスト、候補解析が異なる Host スナップショットを参照しました。再読込してください。"), { code: "snapshot_stale" });
      }
      const page = parseResearchTermCandidates(result.value, 50);
      const resultRevision = isRecord(result.value) && Object.hasOwn(result.value, "ignoreListRevision") &&
        (typeof result.value.ignoreListRevision === "string" || result.value.ignoreListRevision === null)
        ? result.value.ignoreListRevision as string | null : null;
      if (!isRecord(result.value) || !Object.hasOwn(result.value, "ignoreListRevision") || resultRevision !== latestIgnored.fileRevision) {
        throw Object.assign(new Error("Research は異なる無視リスト改訂を解析しました。もう一度解析してください。"), { code: "snapshot_stale" });
      }
      setCandidatePage({ ...page, ignoreListRevision: resultRevision });
      setMessage(`${ignoreObservation.changed ? "Host Review 後の無視リストを再読込しました。" : ""}解析結果は選択した Knowledge の改訂と Research の無視リスト改訂に結び付いています。`);
    } catch (cause) {
      if (generation.current !== serial || controller.signal.aborted) return;
      setError(messageOf(cause)); setMessage("");
    } finally { if (generation.current === serial) { active.current = null; setBusy(false); } }
  }

  async function proposeIgnore(event: Event, terms: string[], ignore: boolean): Promise<void> {
    if (!ignored || terms.length === 0 || proposalBusy) return;
    const expectedScope = scopeKey;
    setProposalBusy(terms[0]!); setIgnoreError("");
    try {
      const result = await uiRef.current(event, RESEARCH, "research.candidates.ignore.propose", {
        terms, ignore, expectedFileRevision: ignored.fileRevision,
      });
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      if (scopeRef.current !== expectedScope) throw Object.assign(new Error("選択中のワークスペースが変わりました。"), { code: "snapshot_stale" });
      const label = ignore ? "無視" : "復元";
      const text = `${label}を Host Review に提案しました。承認・適用後に無視リストを再読み込みしてください。`;
      for (const term of terms) setProposalMessages(current => ({ ...current, [term]: text }));
      try { proposalCallbackRef.current?.(); } catch { /* A refresh failure does not undo a submitted proposal. */ }
    } catch (cause) { setIgnoreError(messageOf(cause)); }
    finally { setProposalBusy(null); }
  }

  async function proposeEntity(event: Event, candidate: ResearchTermCandidate, type: KnowledgeEntityType): Promise<void> {
    if (!corpus || !collectionRevision || !knowledgeAvailable || proposalBusy) return;
    const expectedScope = scopeKey;
    const sourceEvidence = sourceEvidenceForCandidate(candidate, corpus);
    if (sourceEvidence.length === 0) { setError("候補の正確な出典を確認できないため、Knowledge 提案を作成できません。"); return; }
    setProposalBusy(candidate.term); setError("");
    try {
      const result = await uiRef.current(event, KNOWLEDGE, "knowledge.entities.create", {
        type,
        values: { name: candidate.term },
        expectedCollectionRevision: collectionRevision,
        evidence: sourceEvidence,
      });
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      if (scopeRef.current !== expectedScope) throw Object.assign(new Error("選択中のワークスペースが変わりました。"), { code: "snapshot_stale" });
      const value = isRecord(result.value) ? result.value : {};
      const identity = typeof value.proposalId === "string" ? value.proposalId : typeof value.changeSetId === "string" ? value.changeSetId : "";
      setProposalMessages(current => ({ ...current, [`entity:${candidate.term}`]: identity
        ? `Knowledge の Host Review に提案しました（${identity}）。`
        : "Knowledge の Host Review に提案しました。" }));
      try { proposalCallbackRef.current?.(); } catch { /* A refresh failure does not undo a submitted proposal. */ }
    } catch (cause) { setError(messageOf(cause)); }
    finally { setProposalBusy(null); }
  }
}

interface CandidateCardProps {
  candidate: ResearchTermCandidate;
  texts: ReadonlyMap<string, string>;
  entityTypes: Record<string, KnowledgeEntityType | undefined>;
  onEntityTypeChange(type: KnowledgeEntityType | undefined): void;
  proposalBusy: boolean;
  proposalMessage?: string;
  canCreateEntity: boolean;
  onCreateEntity(event: Event, type: KnowledgeEntityType): void;
  onIgnore(event: MouseEvent<HTMLButtonElement>): void;
  onUnignore(event: MouseEvent<HTMLButtonElement>): void;
  isIgnored: boolean;
}

function CandidateCard({ candidate, texts, entityTypes, onEntityTypeChange, proposalBusy, proposalMessage, canCreateEntity, onCreateEntity, onIgnore, onUnignore, isIgnored }: CandidateCardProps): ReactElement {
  const selectedType = entityTypes[candidate.term];
  const validEvidence = candidate.evidence.map(evidence => ({ evidence, quote: evidenceQuote(evidence, texts) }))
    .filter((row): row is { evidence: typeof candidate.evidence[number]; quote: string } => row.quote !== null);
  return <li data-candidate-term={candidate.term}>
    <strong>{candidate.term}</strong>{candidate.reading ? `（${candidate.reading}）` : ""} · {candidate.occurrenceCount} 回
    <ul aria-label={`${candidate.term} の出典`}>
      {validEvidence.map(({ evidence, quote }, index) => <li key={`${evidence.sourceId}:${evidence.textId}:${evidence.range.start}:${index}`}>
        <span>{evidence.path ?? evidence.sourceId} · 改訂 {evidence.revision.slice(0, 12)} · UTF-16 {evidence.range.start}–{evidence.range.end}: 「{quote}」</span>
      </li>)}
      {!validEvidence.length && <li>引用を表示できる出典がありません。</li>}
    </ul>
    <label>Knowledge の種別
      <select aria-label={`${candidate.term} の Knowledge 種別`} value={selectedType ?? ""} onChange={event => onEntityTypeChange(ENTITY_TYPES.includes(event.target.value as KnowledgeEntityType) ? event.target.value as KnowledgeEntityType : undefined)}>
        <option value="">選択してください</option>
        {ENTITY_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
      </select>
    </label>
    <button type="button" disabled={!canCreateEntity || !selectedType || !validEvidence.length || proposalBusy}
      onClick={event => { if (selectedType) onCreateEntity(event.nativeEvent, selectedType); }}>
      Knowledge にエンティティ作成を提案
    </button>
    {isIgnored
      ? <button type="button" disabled={proposalBusy} onClick={onUnignore}>Host Review に復元を提案</button>
      : <button type="button" disabled={proposalBusy} onClick={onIgnore}>Host Review に無視を提案</button>}
    {proposalMessage && <p role="status">{proposalMessage}</p>}
  </li>;
}

export function parseKnowledgeEntityPage(value: unknown): { entities: KnowledgeEntity[]; collectionRevision: string; nextCursor: string | null } {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > MAX_ENTITY_ROWS || !isSha256(value.collectionRevision) ||
      !(value.nextCursor === null || typeof value.nextCursor === "string")) throw new Error("Knowledge エンティティの応答が不正です。");
  const entities = value.items.map(raw => {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id || typeof raw.type !== "string" || typeof raw.filePath !== "string" ||
        !validRelativePath(raw.filePath) || typeof raw.fileRevision !== "string" || !isSha256(raw.fileRevision) || !isRecord(raw.raw)) throw new Error("Knowledge エンティティの改訂・パス・本文が不正です。");
    if (raw.aliases !== undefined && (!Array.isArray(raw.aliases) || raw.aliases.length > 256 || raw.aliases.some(item => typeof item !== "string" || !item.trim()))) {
      throw new Error("Knowledge エンティティの別名が不正です。");
    }
    const aliases = Array.isArray(raw.aliases) ? raw.aliases as string[] : [];
    return { id: raw.id, type: raw.type, name: typeof raw.name === "string" ? raw.name : raw.id, aliases, path: raw.filePath,
      revision: raw.fileRevision, raw: raw.raw };
  });
  if (new Set(entities.map(entity => entity.id)).size !== entities.length) throw new Error("Knowledge は重複したエンティティ ID を返しました。");
  return { entities, collectionRevision: value.collectionRevision, nextCursor: value.nextCursor };
}

export function buildKnowledgeCorpus(selected: readonly KnowledgeEntity[], allEntities: readonly KnowledgeEntity[]): KnowledgeCorpus {
  if (selected.length > MAX_CORPUS_ENTITIES) throw new Error(`解析するエンティティは最大 ${MAX_CORPUS_ENTITIES} 件です。`);
  const items: CandidateSource[] = [];
  const texts = new Map<string, string>();
  let bytesTotal = 0;
  for (const entity of selected) {
    const sourceTexts = collectEntityText(entity.raw);
    if (sourceTexts.length === 0) continue;
    const bounded: CorpusText[] = [];
    for (const item of sourceTexts) {
      if (!isWellFormedUtf16(item.text)) continue;
      const bytes = new TextEncoder().encode(item.text).byteLength;
      if (!bytes || item.text.length > MAX_SOURCE_TEXT_UTF16 || bytes > MAX_SOURCE_TEXT_BYTES) continue;
      bytesTotal += bytes;
      if (bytesTotal > 1024 * 1024) throw new Error("Knowledge 候補コーパスは UTF-8 で 1 MiB 以下にしてください。選ぶエンティティを減らしてください。");
      bounded.push(item);
      texts.set(`${entity.id}\u0000${item.id}`, item.text);
    }
    if (bounded.length) items.push({ id: entity.id, path: entity.path, revision: entity.revision, texts: bounded });
  }
  const knownTerms = [...new Set(allEntities.flatMap(entity => [entity.name, ...entity.aliases])
    .filter(term => term.trim().length > 0 && term.length <= 256 && isWellFormedUtf16(term)))].slice(0, 2_000);
  return { items, texts, knownTerms };
}

export function sourceEvidenceForCandidate(candidate: ResearchTermCandidate, corpus: KnowledgeCorpus): Array<{
  path: string; revision: string; start: number; end: number; quote: string;
}> {
  return candidate.evidence.flatMap(evidence => {
    const sourceRow = corpus.items.find(item => item.id === evidence.sourceId);
    const source = corpus.texts.get(`${evidence.sourceId}\u0000${evidence.textId}`);
    if (!sourceRow || !source || !validRelativePath(evidence.path ?? "") || evidence.path !== sourceRow.path ||
        !isSha256(evidence.revision) || evidence.revision !== sourceRow.revision || !isValidEditorRange(source, evidence.range.start, evidence.range.end)) return [];
    const quote = source.slice(evidence.range.start, evidence.range.end);
    if (quote !== candidate.term || !evidence.path || quote.length !== evidence.range.end - evidence.range.start) return [];
    return [{ path: sourceRow.path, revision: sourceRow.revision, start: evidence.range.start, end: evidence.range.end, quote }];
  });
}

function collectEntityText(raw: Record<string, unknown>): CorpusText[] {
  const blocked = new Set(["id", "type", "tags", "aliases", "name", "title", "status", "order", "filePath", "revision", "entityId", "speakerEntityId", "participantEntityIds"]);
  const rows: CorpusText[] = [];
  const visit = (value: unknown, path: string, key: string, depth: number): void => {
    if (rows.length >= MAX_SOURCE_TEXTS || depth > 12 || blocked.has(key)) return;
    if (typeof value === "string") {
      const text = value.trim();
      if (text) rows.push({ id: path.slice(0, 256) || "text", text });
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, MAX_SOURCE_TEXTS - rows.length).forEach((item, index) => visit(item, `${path}.${index}`, key, depth + 1));
      return;
    }
    if (isRecord(value)) {
      for (const childKey of Object.keys(value).sort()) visit(value[childKey], path ? `${path}.${childKey}` : childKey, childKey, depth + 1);
    }
  };
  for (const key of Object.keys(raw).sort()) visit(raw[key], key, key, 0);
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error("Knowledge の文章フィールド識別子が重複しています。");
    ids.add(row.id);
  }
  return rows;
}

export function parseIgnoredTerms(value: unknown): IgnoredTerms {
  if (!isRecord(value) || !(value.fileRevision === null || isSha256(value.fileRevision)) || !Array.isArray(value.terms) ||
      value.terms.length > 2_000 || value.terms.some(term => typeof term !== "string" || !term.trim() || term.length > 256)) {
    throw new Error("Research の無視リストを読み取れません。");
  }
  const terms = value.terms as string[];
  if (new Set(terms).size !== terms.length) throw new Error("Research の無視リストに重複した候補があります。");
  return { fileRevision: value.fileRevision, terms };
}

/** A fresh Host read is authoritative after a reviewed ignore/unignore proposal. */
export function observeIgnoredTerms(previous: IgnoredTerms, observed: IgnoredTerms): { terms: IgnoredTerms; changed: boolean } {
  return { terms: observed, changed: previous.fileRevision !== observed.fileRevision };
}

export function parseLegacyConsent(value: unknown): LegacyConsent {
  if (!isRecord(value) || !Array.isArray(value.features) || value.features.length > 256) throw new Error("旧 NLP 設定を読み取れません。");
  const features: LegacyFeature[] = value.features.map((raw): LegacyFeature => {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.label !== "string" ||
        (raw.locality !== "local" && raw.locality !== "external") || typeof raw.legacyEnabled !== "boolean" || typeof raw.requiresHostGrant !== "boolean") {
      throw new Error("旧 NLP 機能の情報が不正です。");
    }
    return { id: raw.id, label: raw.label, locality: raw.locality, legacyEnabled: raw.legacyEnabled, requiresHostGrant: raw.requiresHostGrant };
  });
  const known = new Set(features.map(feature => feature.id));
  const settings = isRecord(value.legacySettings) ? value.legacySettings : {};
  const external = isRecord(settings.externalEnabled) ? settings.externalEnabled : {};
  const unknownExternal = Object.keys(external).filter(id => !known.has(id)).sort().map(id => {
    const flag = external[id];
    return { id, enabled: typeof flag === "boolean" ? flag : null };
  });
  return { features, unknownExternal };
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function isWellFormedUtf16(text: string): boolean { return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text); }
function sameScopeSnapshot(left: { scope: ActionResult["scope"]; snapshot: ActionResult["snapshot"] }, right: ActionResult): boolean {
  return left.scope.workspace_id === right.scope.workspace_id && left.scope.repository_id === right.scope.repository_id &&
    left.scope.branch === right.scope.branch && left.scope.generation === right.scope.generation &&
    left.snapshot.id === right.snapshot.id && left.snapshot.local_commit === right.snapshot.local_commit &&
    left.snapshot.worktree_generation === right.snapshot.worktree_generation && left.snapshot.draft_generation === right.snapshot.draft_generation &&
    (left.snapshot.remote_commit ?? null) === (right.snapshot.remote_commit ?? null);
}
function validRelativePath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !path.startsWith("/") && !path.includes("\\") && !/[\u0000-\u001f\u007f]/u.test(path) &&
    path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
function messageOf(cause: unknown): string {
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" && cause.code === "snapshot_stale") return "スナップショットが変わりました。再読込してください。";
  return cause instanceof Error ? cause.message : "Research の操作を完了できませんでした。";
}
