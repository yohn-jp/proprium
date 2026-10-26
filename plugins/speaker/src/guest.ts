import { parseDocument } from "yaml";
import { createGuest, type HostCall, type Handler } from "../../shared/guest.js";
import { HOST_OPERATIONS, invokeAction, propose, readFile } from "../../shared/operations.js";
import type { ActionRequest, ChangeSet, FileOperation, SourceSpan } from "../../../app/src/browser/proprium/authoring/types.js";
import { buildMentionDictionary, hashDialogueText, runSpeakerPipeline, splitIntoSentenceOffsets, type Entity, type SpeakerAttribution, type SpeakerOverride, type SpeakerPipelineResult, type Token } from "./index.js";
import { findMentions } from "./algorithms/mentionIndex.js";
import { extractVoiceProfiles } from "./algorithms/voice/profileLoader.js";
import { computeStyleFingerprints, computeVoiceSeparationMatrix, detectStyleDeviations, removeDialogueBrackets, type DialogueTokens } from "./algorithms/voiceStyle.js";
import { checkDeclaredVoiceConsistency } from "./algorithms/declaredVoice.js";
import { computeStylometricProfiles } from "./algorithms/stylometry/profile.js";
import { detectStylometricDeviations } from "./algorithms/stylometry/deviationDetector.js";
import { buildSpeakerEvalReport, buildSceneEvalResult, type MatchedEvalLine } from "./algorithms/speakerEval.js";
import { computeSpeakerRuleGates, emptySpeakerRuleGates, parseSpeakerRuleGates, type SpeakerRuleGates } from "./algorithms/speakerRuleStats.js";
import { parseSpeakerCorrections } from "./algorithms/speakerCorrectionLog.js";
import { applySpeakerReranker, attributionAccuracyFromPairs, buildSpeakerRerankExamples, calibrateHighProbabilityThreshold, extractSpeakerRerankFeatures, parseSpeakerModel, scoreSpeakerRerank, SPEAKER_RERANK_FEATURE_NAMES, trainSpeakerRerankModel, type SpeakerModel } from "./algorithms/speakerReranker.js";
import { SPEAKER_ENGINE_ID, SPEAKER_ENGINE_VERSION, SPEAKER_MODULE_VERSION } from "./engine.js";
import { sha256 } from "@noble/hashes/sha2.js";

const SPEAKER_PLUGIN_ID = "proprium.speaker";
const NARRATIVE_PLUGIN_ID = "proprium.narrative";
const KNOWLEDGE_PLUGIN_ID = "proprium.knowledge";
const RESEARCH_PLUGIN_ID = "proprium.research";
const SPEAKER_PREFIX = "meta/proprium/plugins/proprium.speaker";
const MAX_SCENES = 500;
const MAX_SCENE_CHARACTERS = 500_000;
const MAX_REVIEW_ROWS = 10_000;
const TREE_PAGE_SIZE = 128;
const ENTITY_PAGE_SIZE = 200;
const CONFIDENCE_RANK = { none: 0, low: 1, high: 2 } as const;

interface TreeItem {
  id: string;
  kind: "volume" | "chapter" | "scene";
  title: string;
  parent_id: string | null;
  metadata_path: string;
  metadata_revision: string;
  manuscript_path?: string | null;
  order?: number;
}
interface TreePage {
  parent_id: string | null;
  tree_revision: string;
  items: TreeItem[];
  next_cursor: string | null;
  diagnostics: unknown[];
}
interface NarrativeContext {
  scene_id: string;
  title: string;
  volume: { id: string; title: string };
  chapter: { id: string; title: string };
  manuscript_path: string;
  metadata_revision: string;
  manuscript_revision: string;
  diagnostics: unknown[];
}
interface KnowledgeSceneContext {
  sceneId: string;
  povId?: string;
  appears: unknown[];
  entityCards: Array<Record<string, unknown>>;
  sourceFiles: Array<{ path: string; revision: string }>;
}
interface LoadedScene {
  scene: Entity & { filePath: string; revision: string };
  narrative: NarrativeContext;
  knowledge: KnowledgeSceneContext;
  entities: Entity[];
  candidates: Entity[];
  text: string;
  textRevision: string;
  draftGeneration?: string;
  treeRevision: string;
  warnings: string[];
  sourceFiles: Array<{ path: string; revision: string }>;
}
interface CorpusCache { characters?: Entity[] }
interface TokenAnalysis {
  source: { kind: string; textRevision?: string; draftGeneration?: string; textDigest: string };
  sentences: Array<{ start: number; end: number }>;
  tokens: Array<{ start: number; end: number; surface: string; base?: string; reading?: string; pos?: string; sentenceIndex: number }>;
  engine: { id: string; version: string; digest: string };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error(`${label} must be an object`), { code: "invalid_input" });
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw Object.assign(new Error(`${label} has unknown field: ${extra}`), { code: "invalid_input" });
}
function requiredString(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw Object.assign(new Error(`${label} must be a non-empty string of at most ${max} characters`), { code: "invalid_input" });
  return value;
}
function decodeUtf8(bytes: Uint8Array, path: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw Object.assign(new Error(`Invalid UTF-8 in ${path}`), { code: "invalid_encoding", details: { path } }); }
}
function readYaml(bytes: Uint8Array, path: string) {
  const text = decodeUtf8(bytes, path);
  const document = parseDocument(text, { keepSourceTokens: true, uniqueKeys: true });
  if (document.errors.length) throw Object.assign(new Error(`Invalid YAML in ${path}: ${document.errors[0]?.message ?? "parse error"}`), { code: "unsupported_format", details: { path } });
  return { text, document };
}
function rawObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function referenceId(value: unknown): string | null {
  if (typeof value === "string") return value;
  const row = rawObject(value);
  const id = row.id ?? row.entityId ?? row.entity_id;
  return typeof id === "string" ? id : null;
}
function entityCard(value: Record<string, unknown>): Entity {
  const id = requiredString(value.id, "Knowledge entity id");
  const type = requiredString(value.type, `Knowledge entity ${id} type`);
  const aliases = Array.isArray(value.aliases) ? value.aliases.filter((item): item is string => typeof item === "string") : [];
  const raw = rawObject(value.raw);
  return { id, type, ...(typeof value.name === "string" ? { name: value.name } : {}), aliases, raw };
}
function fallbackTokens(text: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  for (const surface of Array.from(text)) {
    const start = offset;
    offset += surface.length;
    const pos = /[。、「」『』！？…‥,.!?]/u.test(surface) ? "記号"
      : ["は", "が", "を", "に", "へ", "と", "の", "も", "で", "から", "まで"].includes(surface) ? "助詞" : "未知語";
    tokens.push({ surface, pos, start, end: offset });
  }
  return tokens;
}
function cacheTokens(text: string, tokens: Token[], cache: Record<string, Token[]>): void { cache[text] = tokens; }
function tokensForSpan(tokens: Token[], start: number, end: number): Token[] {
  return tokens.filter((token) => token.start >= start && token.end <= end)
    .map((token) => ({ ...token, start: token.start - start, end: token.end - start }));
}

function* treePage(host: Parameters<Handler>[2], context: ActionRequest, parentId: string | null, cursor?: string, expectedTreeRevision?: string): Generator<HostCall, TreePage, unknown> {
  return yield* invokeAction<TreePage>(host, NARRATIVE_PLUGIN_ID, "proprium.narrative.hierarchy.tree", {
    parent_id: parentId,
    ...(cursor ? { cursor } : {}),
    limit: TREE_PAGE_SIZE,
    ...(expectedTreeRevision ? { expected_tree_revision: expectedTreeRevision } : {}),
  });
}

function* allChildren(host: Parameters<Handler>[2], context: ActionRequest, parentId: string | null, treeRevision?: string): Generator<HostCall, { items: TreeItem[]; treeRevision: string }, unknown> {
  const items: TreeItem[] = [];
  let cursor: string | undefined;
  let revision = treeRevision;
  do {
    const page = yield* treePage(host, context, parentId, cursor, revision);
    if (page.parent_id !== parentId || (revision !== undefined && page.tree_revision !== revision)) {
      throw Object.assign(new Error("Narrative returned a mixed hierarchy revision"), { code: "snapshot_stale" });
    }
    revision = page.tree_revision;
    if (page.diagnostics?.some((item) => rawObject(item).code === "duplicate_entity_id")) {
      throw Object.assign(new Error("Narrative hierarchy contains duplicate scene identity"), { code: "ambiguous_identity" });
    }
    items.push(...page.items);
    if (items.length > MAX_SCENES * 10) throw Object.assign(new Error("Narrative hierarchy exceeds the bounded Speaker scan"), { code: "capacity" });
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  if (!revision) throw Object.assign(new Error("Narrative did not return a hierarchy revision"), { code: "unsupported_schema" });
  return { items, treeRevision: revision };
}

function* listAllScenes(host: Parameters<Handler>[2], context: ActionRequest): Generator<HostCall, { scenes: Array<TreeItem & { volume_id: string; chapter_id: string; volume_title: string; chapter_title: string }>; treeRevision: string }, unknown> {
  const volumePage = yield* allChildren(host, context, null);
  const scenes: Array<TreeItem & { volume_id: string; chapter_id: string; volume_title: string; chapter_title: string }> = [];
  for (const volume of volumePage.items.filter((item) => item.kind === "volume")) {
    const chapters = yield* allChildren(host, context, volume.id, volumePage.treeRevision);
    for (const chapter of chapters.items.filter((item) => item.kind === "chapter")) {
      const rows = yield* allChildren(host, context, chapter.id, volumePage.treeRevision);
      scenes.push(...rows.items.filter((item) => item.kind === "scene").map((scene) => ({
        ...scene, volume_id: volume.id, chapter_id: chapter.id, volume_title: volume.title, chapter_title: chapter.title,
      })));
      if (scenes.length > MAX_SCENES) throw Object.assign(new Error(`Speaker corpus exceeds ${MAX_SCENES} scenes`), { code: "corpus_too_large" });
    }
  }
  const ids = new Set<string>();
  for (const scene of scenes) {
    if (ids.has(scene.id)) throw Object.assign(new Error(`Duplicate scene identity: ${scene.id}`), { code: "ambiguous_identity" });
    ids.add(scene.id);
  }
  return { scenes, treeRevision: volumePage.treeRevision };
}

function* allCharacters(host: Parameters<Handler>[2]): Generator<HostCall, Entity[], unknown> {
  const entities: Entity[] = [];
  let cursor: string | undefined;
  do {
    const page = yield* invokeAction<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>(host, KNOWLEDGE_PLUGIN_ID, "knowledge.entities.list", {
      type: "character", limit: ENTITY_PAGE_SIZE, ...(cursor ? { cursor } : {}),
    });
    entities.push(...page.items.map(entityCard));
    if (entities.length > 20_000) throw Object.assign(new Error("Knowledge character collection exceeds the Speaker capacity bound"), { code: "capacity" });
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return entities;
}

function* loadScene(host: Parameters<Handler>[2], context: ActionRequest, sceneId: string,
  draft?: { text: string; generation: string }, sceneNode?: TreeItem & { volume_title?: string; chapter_title?: string },
  knownTreeRevision?: string, corpusCache?: CorpusCache): Generator<HostCall, LoadedScene, unknown> {
  let narrative: NarrativeContext;
  if (sceneNode) {
    if (!sceneNode.manuscript_path) throw Object.assign(new Error(`Narrative scene has no manuscript path: ${sceneId}`), { code: "file_not_found" });
    const bodyRevision = yield* fileRevision(host, context.snapshot, sceneNode.manuscript_path);
    if (!bodyRevision) throw Object.assign(new Error(`Narrative manuscript is missing: ${sceneNode.manuscript_path}`), { code: "file_not_found" });
    narrative = {
      scene_id: sceneNode.id,
      title: sceneNode.title,
      volume: { id: "", title: sceneNode.volume_title ?? "" },
      chapter: { id: sceneNode.parent_id ?? "", title: sceneNode.chapter_title ?? "" },
      manuscript_path: sceneNode.manuscript_path,
      metadata_revision: sceneNode.metadata_revision,
      manuscript_revision: bodyRevision,
      diagnostics: [],
    };
  } else {
    narrative = yield* invokeAction<NarrativeContext>(host, NARRATIVE_PLUGIN_ID, "proprium.narrative.scene.context", { scene_id: sceneId });
  }
  const knowledge = yield* invokeAction<KnowledgeSceneContext>(host, KNOWLEDGE_PLUGIN_ID, "knowledge.scene.context", { sceneId });
  if (narrative.scene_id !== sceneId || knowledge.sceneId !== sceneId || !narrative.manuscript_path ||
      !narrative.metadata_revision || !narrative.manuscript_revision) {
    throw Object.assign(new Error("Narrative or Knowledge returned an invalid scene identity"), { code: "unsupported_schema" });
  }
  if (draft && (!context.snapshot.draft_generation || draft.generation !== context.snapshot.draft_generation)) {
    throw Object.assign(new Error("Draft text does not belong to the current Host draft generation"), { code: "snapshot_stale" });
  }
  const chapterRows = sceneNode ? null : yield* allChildren(host, context, narrative.chapter.id);
  const matching = chapterRows?.items.filter((item) => item.kind === "scene" && item.id === sceneId) ?? [];
  if (!sceneNode && matching.length === 0) throw Object.assign(new Error(`Scene is missing from Narrative hierarchy: ${sceneId}`), { code: "scene_not_found" });
  if (!sceneNode && matching.length !== 1) throw Object.assign(new Error(`Scene identity is ambiguous: ${sceneId}`), { code: "ambiguous_identity" });
  const treeItem = sceneNode ?? matching[0]!;
  if (treeItem.parent_id !== narrative.chapter.id) throw Object.assign(new Error("Scene hierarchy parent does not match Narrative scene context"), { code: "snapshot_stale" });
  if (treeItem.metadata_revision !== narrative.metadata_revision || treeItem.manuscript_path !== narrative.manuscript_path) {
    throw Object.assign(new Error("Narrative scene context and hierarchy revisions disagree"), { code: "snapshot_stale" });
  }
  const metadataBytes = yield* readFile(host, context.snapshot, treeItem.metadata_path);
  const { document: metadataDocument } = readYaml(metadataBytes, treeItem.metadata_path);
  const metadata = rawObject(metadataDocument.toJSON());
  if (metadata.id !== sceneId) throw Object.assign(new Error(`Scene metadata identity does not match ${sceneId}`), { code: "ambiguous_identity" });
  const text = draft?.text ?? decodeUtf8(yield* readFile(host, context.snapshot, narrative.manuscript_path), narrative.manuscript_path);
  if (Array.from(text).length > MAX_SCENE_CHARACTERS) throw Object.assign(new Error(`Scene exceeds ${MAX_SCENE_CHARACTERS} Unicode characters`), { code: "scene_too_large" });

  const cards = (knowledge.entityCards ?? []).map(entityCard).filter((entity) => entity.type === "character");
  const appearingIds = [...new Set((knowledge.appears ?? []).map(referenceId).filter((id): id is string => id !== null))];
  let entities = cards;
  if (appearingIds.length > 0 && appearingIds.some((id) => !cards.some((entity) => entity.id === id))) {
    corpusCache ??= {};
    corpusCache.characters ??= yield* allCharacters(host);
    entities = [...cards, ...corpusCache.characters.filter((entity) => appearingIds.includes(entity.id) && !cards.some((known) => known.id === entity.id))];
  }
  if (appearingIds.length === 0) {
    corpusCache ??= {};
    corpusCache.characters ??= yield* allCharacters(host);
    entities = corpusCache.characters;
  }
  const mentionDictionary = buildMentionDictionary(new Map(entities.map((entity) => [entity.id, entity])));
  const mentionedIds = new Set(findMentions(mentionDictionary, text));
  const candidates = appearingIds.length > 0
    ? entities.filter((entity) => appearingIds.includes(entity.id))
    : entities.filter((entity) => mentionedIds.has(entity.id));
  const scene: Entity & { filePath: string; revision: string } = {
    id: sceneId, type: "scene", name: narrative.title, raw: metadata,
    filePath: treeItem.metadata_path, revision: treeItem.metadata_revision,
  };
  const sourceEntries: Array<[string, string]> = [
    [treeItem.metadata_path, treeItem.metadata_revision],
    [narrative.manuscript_path, narrative.manuscript_revision],
    ...(knowledge.sourceFiles ?? []).map((file): [string, string] => [file.path, file.revision]),
    ...(knowledge.entityCards ?? []).map((card): [string, string] => {
      return typeof card.filePath === "string" && typeof card.fileRevision === "string"
        ? [card.filePath, card.fileRevision]
        : ["", ""];
    }),
  ];
  const sourceFiles = new Map<string, string>(sourceEntries.filter(([path, revision]) => Boolean(path && revision)));
  return {
    scene, narrative, knowledge, entities: [scene, ...entities], candidates, text,
    textRevision: draft ? `draft:${draft.generation}` : narrative.manuscript_revision,
    ...(draft ? { draftGeneration: draft.generation } : {}),
    treeRevision: knownTreeRevision ?? chapterRows?.treeRevision ?? "",
    warnings: [],
    sourceFiles: [...sourceFiles].map(([path, revision]) => ({ path, revision })),
  };
}

function* fileRevision(host: Parameters<Handler>[2], snapshot: ActionRequest["snapshot"], path: string): Generator<HostCall, string | null, unknown> {
  const page = yield* host.request<{ entries: Array<{ path: string; revision: string }>; next_cursor: string | null }>(
    HOST_OPERATIONS.list, { snapshot, prefix: path, limit: 8 });
  const matches = page.entries.filter((entry) => entry.path === path);
  if (matches.length > 1) throw Object.assign(new Error(`Ambiguous source path: ${path}`), { code: "ambiguous_identity" });
  return matches[0]?.revision ?? null;
}

function optionalProviderFailure(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  return ["dependency_unavailable", "plugin_unavailable", "missing_capability", "capability_denied"].includes(code);
}

function* tokenCacheFor(host: Parameters<Handler>[2], context: ActionRequest, loaded: LoadedScene): Generator<HostCall, { cache: Record<string, Token[]>; identity: Record<string, string>; warnings: string[] }, unknown> {
  const cache: Record<string, Token[]> = Object.create(null) as Record<string, Token[]>;
  const offsets = splitIntoSentenceOffsets(loaded.text);
  let tokenRows: TokenAnalysis["tokens"] | null = null;
  let identity = { id: "proprium.speaker.regex-fallback", version: "1", digest: "bundled" };
  const warnings: string[] = [];
  try {
    const source = loaded.draftGeneration
      ? { kind: "draft", draftGeneration: loaded.draftGeneration }
      : { kind: "saved-file", path: loaded.narrative.manuscript_path, textRevision: loaded.narrative.manuscript_revision };
    const result = yield* invokeAction<TokenAnalysis>(host, RESEARCH_PLUGIN_ID, "research.nlp.analyze", { text: loaded.text, source });
    if (!Array.isArray(result.sentences) || !Array.isArray(result.tokens) || !result.engine ||
        result.sentences.length !== offsets.length || result.sentences.some((span, index) => span.start !== offsets[index]?.start || span.end !== offsets[index]?.end)) {
      throw Object.assign(new Error("Research token spans do not match the pinned sentence segmentation"), { code: "unsupported_schema" });
    }
    const expectedDigest = utf8Digest(loaded.text);
    if (!result.source || result.source.kind !== source.kind || result.source.textDigest !== expectedDigest ||
        (loaded.draftGeneration ? result.source.draftGeneration !== loaded.draftGeneration : result.source.textRevision !== loaded.narrative.manuscript_revision) ||
        ![result.engine.id, result.engine.version, result.engine.digest].every((value) => typeof value === "string" && value.length > 0)) {
      throw Object.assign(new Error("Research did not preserve the exact source or tokenizer identity"), { code: "snapshot_stale" });
    }
    tokenRows = result.tokens;
    identity = { id: result.engine.id, version: result.engine.version, digest: result.engine.digest };
  } catch (error) {
    if (!optionalProviderFailure(error)) throw error;
    warnings.push("reduced_tokenizer");
  }

  if (!tokenRows) {
    cacheTokens(loaded.text, fallbackTokens(loaded.text), cache);
    for (const span of offsets) {
      const sentence = loaded.text.slice(span.start, span.end);
      const tokens = fallbackTokens(sentence);
      cacheTokens(sentence, tokens, cache);
      const content = removeDialogueBrackets(sentence);
      const contentStart = sentence.indexOf(content);
      cacheTokens(content, tokensForSpan(tokens, Math.max(0, contentStart), Math.max(0, contentStart) + content.length), cache);
    }
    return { cache, identity, warnings };
  }

  let priorEnd = 0;
  const normalized: Token[] = tokenRows.map((row) => {
    if (!Number.isSafeInteger(row.start) || !Number.isSafeInteger(row.end) || row.start < 0 || row.end < row.start ||
        row.start < priorEnd || row.end > loaded.text.length || typeof row.surface !== "string" || loaded.text.slice(row.start, row.end) !== row.surface ||
        !Number.isSafeInteger(row.sentenceIndex) || (row.sentenceIndex as number) < 0 || (row.sentenceIndex as number) > offsets.length) {
      throw Object.assign(new Error("Research returned a token that does not match the exact source span"), { code: "unsupported_schema" });
    }
    const sentenceCandidates = [row.sentenceIndex, row.sentenceIndex - 1].filter((index) => Number.isSafeInteger(index) && index >= 0 && index < offsets.length);
    if (!sentenceCandidates.some((index) => row.start >= offsets[index]!.start && row.end <= offsets[index]!.end)) {
      throw Object.assign(new Error("Research token sentence index does not contain its source span"), { code: "unsupported_schema" });
    }
    priorEnd = row.end;
    for (const key of ["base", "reading", "pos"] as const) if (row[key] !== undefined && (typeof row[key] !== "string" || row[key].length > 256)) {
      throw Object.assign(new Error(`Research token ${key} value is malformed`), { code: "unsupported_schema" });
    }
    return { surface: row.surface, pos: row.pos ?? "未知語", ...(row.base ? { baseForm: row.base } : {}),
      ...(row.reading ? { reading: row.reading } : {}), start: row.start, end: row.end };
  });
  cacheTokens(loaded.text, normalized, cache);
  for (const span of offsets) {
    const sentence = loaded.text.slice(span.start, span.end);
    const tokens = tokensForSpan(normalized, span.start, span.end);
    cacheTokens(sentence, tokens, cache);
    const content = removeDialogueBrackets(sentence);
    const contentStart = sentence.indexOf(content);
    cacheTokens(content, tokensForSpan(normalized, span.start + Math.max(0, contentStart), span.start + Math.max(0, contentStart) + content.length), cache);
  }
  return { cache, identity, warnings };
}

function* adoptedModel(host: Parameters<Handler>[2], context: ActionRequest): Generator<HostCall, { model: SpeakerModel | null; revision: string | null; warning?: string }, unknown> {
  const path = `${SPEAKER_PREFIX}/adopted-model.json`;
  const revision = yield* fileRevision(host, context.snapshot, path);
  if (!revision) return { model: null, revision: null };
  try {
    const bytes = yield* readFile(host, context.snapshot, path);
    const raw = JSON.parse(decodeUtf8(bytes, path)) as unknown;
    const parsed = parseSpeakerModel(raw);
    return parsed ? { model: parsed, revision } : { model: null, revision, warning: "adopted_model_invalid" };
  } catch (error) {
    if (optionalProviderFailure(error)) return { model: null, revision, warning: "adopted_model_unavailable" };
    throw error;
  }
}

function* speakerPipeline(host: Parameters<Handler>[2], request: ActionRequest, loaded: LoadedScene, options: { ignoreOverrides?: boolean; gates?: SpeakerRuleGates; skipReranker?: boolean } = {}): Generator<HostCall, {
  result: SpeakerPipelineResult; tokenizerIdentity: Record<string, string>; warnings: string[]; modelRevision: string | null; tokenCache: Record<string, Token[]>; gates: SpeakerRuleGates;
}, unknown> {
  const tokens = yield* tokenCacheFor(host, request, loaded);
  const savedModel = yield* adoptedModel(host, request);
  const gates = options.gates ?? (yield* cachedRuleGates(host, request, tokens.identity, savedModel.revision));
  const result = runSpeakerPipeline({
    scene: loaded.scene,
    text: loaded.text,
    entities: loaded.entities,
    candidates: loaded.candidates,
    tokenCache: tokens.cache,
    gates,
    model: savedModel.model,
    ignoreOverrides: options.ignoreOverrides,
    skipReranker: options.skipReranker,
  });
  return {
    result,
    tokenizerIdentity: tokens.identity,
    warnings: [...loaded.warnings, ...tokens.warnings, ...(savedModel.warning ? [savedModel.warning] : [])],
    modelRevision: savedModel.revision,
    tokenCache: tokens.cache,
    gates,
  };
}

function attributionRows(loaded: LoadedScene, pipeline: SpeakerPipelineResult): Array<Record<string, unknown>> {
  const offsets = splitIntoSentenceOffsets(loaded.text);
  return pipeline.attributions.map((row) => {
    const span = offsets[row.sentenceIndex - 1];
    if (!span || loaded.text.slice(span.start, span.end) !== row.text) {
      throw Object.assign(new Error(`Speaker attribution no longer maps to its source sentence ${row.sentenceIndex}`), { code: "snapshot_stale" });
    }
    const sourceSpan: SourceSpan = { path: loaded.narrative.manuscript_path, revision: loaded.textRevision,
      start: span.start, end: span.end, quote: row.text };
    return {
      sentence_index: row.sentenceIndex,
      start_utf16: span.start,
      end_utf16: span.end,
      text: row.text,
      text_hash: hashDialogueText(row.text),
      source_span: sourceSpan,
      ...(row.speakerEntityId !== null ? { speaker_entity_id: row.speakerEntityId } : {}),
      ...(row.speakerGroupId !== null ? { speaker_group_id: row.speakerGroupId } : {}),
      reason: row.reason,
      confidence: row.confidence,
      evidence: row.reason === "none" ? [] : [{ kind: "rule", rule: row.reason, source_span: sourceSpan }],
    };
  });
}

function pipelineProvenance(loaded: LoadedScene, pipeline: { tokenizerIdentity: Record<string, string>; warnings: string[]; modelRevision: string | null; gates: SpeakerRuleGates }): Record<string, unknown> {
  return {
    speaker_engine: SPEAKER_ENGINE_ID,
    speaker_engine_version: SPEAKER_ENGINE_VERSION,
    speaker_plugin_version: SPEAKER_MODULE_VERSION,
    adopted_model_revision: pipeline.modelRevision,
    rule_gates: Object.fromEntries(Object.entries(pipeline.gates.gates).map(([reason, gate]) => [reason, { action: gate.action, measured_precision: gate.measuredPrecision, sample_size: gate.sampleSize }])),
    tokenizer: pipeline.tokenizerIdentity,
    source_revisions: loaded.sourceFiles.map(({ path, revision }) => ({ path, revision })),
    ...(loaded.draftGeneration ? { draft_generation: loaded.draftGeneration } : {}),
    warnings: pipeline.warnings,
  };
}

function parseSceneActionInput(input: Record<string, unknown>, allowDraft: boolean): { sceneId: string; draft?: { text: string; generation: string } } {
  exactKeys(input, allowDraft ? ["scene_id", "text", "draft_generation"] : ["scene_id"], "speaker input");
  const sceneId = requiredString(input.scene_id, "scene_id");
  if (input.text === undefined) {
    if (input.draft_generation !== undefined) throw Object.assign(new Error("draft_generation requires current draft text"), { code: "invalid_input" });
    return { sceneId };
  }
  if (!allowDraft || typeof input.text !== "string" || input.text.length > MAX_SCENE_CHARACTERS * 2) {
    throw Object.assign(new Error("Draft text is invalid or exceeds the Speaker scene limit"), { code: "invalid_input" });
  }
  const generation = requiredString(input.draft_generation, "draft_generation");
  return { sceneId, draft: { text: input.text, generation } };
}

function* listScenes(input: Record<string, unknown>, context: ActionRequest, host: Parameters<Handler>[2]): Generator<HostCall, unknown, unknown> {
  exactKeys(input, [], "speaker.scenes.list input");
  const { scenes } = yield* listAllScenes(host, context);
  return {
    scenes: scenes.map((scene) => ({
      scene_id: scene.id,
      name: scene.title,
      scene_path: scene.metadata_path,
      volume_id: scene.volume_id,
      chapter_id: scene.chapter_id,
    })),
    snapshot: context.snapshot,
    source_revisions: scenes.map((scene) => ({ path: scene.metadata_path, revision: scene.metadata_revision })),
  };
}

function* attribute(input: Record<string, unknown>, context: ActionRequest, host: Parameters<Handler>[2]): Generator<HostCall, unknown, unknown> {
  const parsed = parseSceneActionInput(input, true);
  const loaded = yield* loadScene(host, context, parsed.sceneId, parsed.draft);
  const computed = yield* speakerPipeline(host, context, loaded);
  return {
    scene_id: parsed.sceneId,
    attributions: attributionRows(loaded, computed.result),
    estimated_speaker_count: computed.result.estimatedN,
    count_is_manual: computed.result.fromManual,
    count_evidence: { known_floor: computed.result.evidence.knownFloor, vocative_census: computed.result.evidence.vocativeCensus },
    cluster_trails: computed.result.clusterTrails.map((trail) => ({ sentence_index: trail.sentenceIndex, events: trail.events })),
    candidates: loaded.candidates.map((candidate) => ({ entity_id: candidate.id, name: candidate.name ?? candidate.id })),
    provenance: pipelineProvenance(loaded, computed),
  };
}

interface AnalyzedScene {
  item: TreeItem & { volume_id: string; chapter_id: string; volume_title: string; chapter_title: string };
  loaded: LoadedScene;
  computed: SpeakerPipelineResult;
  pipeline: { tokenizerIdentity: Record<string, string>; warnings: string[]; modelRevision: string | null; tokenCache: Record<string, Token[]>; gates: SpeakerRuleGates };
  rows: Array<Record<string, unknown>>;
}
function* analyzeScenes(host: Parameters<Handler>[2], context: ActionRequest, selectedSceneId?: string, options: { ignoreOverrides?: boolean; gates?: SpeakerRuleGates; skipReranker?: boolean } = {}): Generator<HostCall, AnalyzedScene[], unknown> {
  const { scenes, treeRevision } = yield* listAllScenes(host, context);
  const selected = selectedSceneId ? scenes.filter((scene) => scene.id === selectedSceneId) : scenes;
  if (selectedSceneId && selected.length === 0) throw Object.assign(new Error(`Scene not found: ${selectedSceneId}`), { code: "scene_not_found" });
  if (selectedSceneId && selected.length > 1) throw Object.assign(new Error(`Scene identity is ambiguous: ${selectedSceneId}`), { code: "ambiguous_identity" });
  const corpusCache: CorpusCache = {};
  const analyzed: AnalyzedScene[] = [];
  for (const item of selected) {
    const loaded = yield* loadScene(host, context, item.id, undefined, item, treeRevision, corpusCache);
    const computed = yield* speakerPipeline(host, context, loaded, options);
    analyzed.push({ item, loaded, computed: computed.result, pipeline: computed, rows: attributionRows(loaded, computed.result) });
  }
  return analyzed;
}

function encodeCursor(snapshotId: string, filter: string, offset: number): string {
  return [...new TextEncoder().encode(JSON.stringify({ version: 1, snapshot_id: snapshotId, filter, offset }))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function decodeCursor(cursor: unknown, snapshotId: string, filter: string): number {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string" || !/^(?:[0-9a-f]{2})+$/u.test(cursor) || cursor.length > 4096) {
    throw Object.assign(new Error("Cursor is malformed"), { code: "invalid_input" });
  }
  try {
    const bytes = new Uint8Array(cursor.match(/.{2}/gu)!.map((part) => Number.parseInt(part, 16)));
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (parsed.version !== 1 || parsed.snapshot_id !== snapshotId || parsed.filter !== filter ||
        !Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0) {
      throw Object.assign(new Error("Cursor belongs to a different snapshot or filter"), { code: "snapshot_stale" });
    }
    return parsed.offset as number;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) throw error;
    throw Object.assign(new Error("Cursor is malformed"), { code: "invalid_input" });
  }
}
function pageSize(value: unknown, defaultValue: number, maximum: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw Object.assign(new Error(`limit must be an integer from 1 to ${maximum}`), { code: "invalid_input" });
  }
  return value as number;
}

function* reviewQueue(input: Record<string, unknown>, context: ActionRequest, host: Parameters<Handler>[2]): Generator<HostCall, unknown, unknown> {
  exactKeys(input, ["cursor", "limit"], "speaker.review.queue input");
  const limit = pageSize(input.limit, 50, 200);
  const scenes = yield* analyzeScenes(host, context);
  const names = new Map<string, string>();
  const values: Array<Record<string, unknown> & { confidence_rank: number; group_count: number; scene_order: number; sentence_index: number }> = [];
  scenes.forEach((scene, sceneOrder) => {
    for (const candidate of scene.loaded.candidates) names.set(candidate.id, candidate.name ?? candidate.id);
    const unresolved = scene.computed.attributions.filter((row) => row.confidence !== "high" && row.reason !== "manual-override" && row.reason !== "mob");
    for (const row of unresolved) {
      const groupCount = row.speakerGroupId === null ? 0 : unresolved.filter((other) => other.speakerGroupId === row.speakerGroupId).length;
      const attribution = scene.rows.find((output) => output.sentence_index === row.sentenceIndex);
      if (!attribution) throw Object.assign(new Error("Attribution row is missing its source evidence"), { code: "unsupported_schema" });
      values.push({
        scene_id: scene.item.id,
        scene_name: scene.item.title,
        attribution,
        speaker_name: row.speakerEntityId ? names.get(row.speakerEntityId) ?? row.speakerEntityId : null,
        candidates: scene.loaded.candidates.map((candidate) => ({ entity_id: candidate.id, name: candidate.name ?? candidate.id })),
        unresolved_group_count: groupCount,
        other_resolvable_count: Math.max(0, groupCount - 1),
        confidence_rank: CONFIDENCE_RANK[row.confidence],
        group_count: groupCount,
        scene_order: sceneOrder,
        sentence_index: row.sentenceIndex,
      });
    }
  });
  if (values.length > MAX_REVIEW_ROWS) throw Object.assign(new Error(`Review queue exceeds ${MAX_REVIEW_ROWS} unresolved rows`), { code: "review_queue_too_large" });
  values.sort((a, b) => a.confidence_rank - b.confidence_rank || b.group_count - a.group_count || a.scene_order - b.scene_order || a.sentence_index - b.sentence_index);
  const offset = decodeCursor(input.cursor, context.snapshot.id, "speaker.review.queue:v1");
  if (offset > values.length) throw Object.assign(new Error("Review cursor is past the available queue"), { code: "snapshot_stale" });
  const rows = values.slice(offset, offset + limit).map(({ confidence_rank: _a, group_count: _b, scene_order: _c, sentence_index: _d, ...row }) => row);
  const nextOffset = offset + rows.length;
  return { rows, next_cursor: nextOffset < values.length ? encodeCursor(context.snapshot.id, "speaker.review.queue:v1", nextOffset) : null,
    provenance: { snapshot: context.snapshot, scenes_scanned: scenes.length, unresolved_rows: values.length } };
}

function* dialogueList(input: Record<string, unknown>, context: ActionRequest, host: Parameters<Handler>[2]): Generator<HostCall, unknown, unknown> {
  exactKeys(input, ["character_id", "scene_id", "limit", "min_confidence", "cursor"], "speaker.dialogue.list input");
  const characterId = requiredString(input.character_id, "character_id");
  const sceneId = input.scene_id === undefined || input.scene_id === "" ? undefined : requiredString(input.scene_id, "scene_id");
  const limit = pageSize(input.limit, 20, 2000);
  const minConfidence = input.min_confidence === undefined ? "low" : input.min_confidence;
  if (minConfidence !== "low" && minConfidence !== "high") throw Object.assign(new Error("min_confidence must be low or high"), { code: "invalid_input" });
  const character = yield* invokeAction<{ entity: Record<string, unknown> }>(host, KNOWLEDGE_PLUGIN_ID, "knowledge.entities.get", { id: characterId });
  if (rawObject(character.entity).type !== "character") throw Object.assign(new Error(`Entity is not a character: ${characterId}`), { code: "file_not_found" });
  const scenes = yield* analyzeScenes(host, context, sceneId);
  const filter = `speaker.dialogue.list:v1:${characterId}:${sceneId ?? "*"}:${minConfidence}`;
  const allLines = scenes.flatMap((scene) => scene.computed.attributions
    .filter((row) => row.speakerEntityId === characterId && (minConfidence === "low" || row.confidence === "high"))
    .map((row) => {
      const source = scene.rows.find((output) => output.sentence_index === row.sentenceIndex);
      if (!source) throw Object.assign(new Error("Dialogue row is missing its source evidence"), { code: "unsupported_schema" });
      return {
        scene_id: scene.item.id,
        scene_name: scene.item.title,
        sentence_index: row.sentenceIndex,
        start_utf16: source.start_utf16,
        end_utf16: source.end_utf16,
        text: row.text,
        text_hash: hashDialogueText(row.text),
        confidence: row.confidence,
        reason: row.reason,
        source_span: source.source_span,
      };
    }));
  const offset = decodeCursor(input.cursor, context.snapshot.id, filter);
  if (offset > allLines.length) throw Object.assign(new Error("Dialogue cursor is past the available result set"), { code: "snapshot_stale" });
  const lines = allLines.slice(offset, offset + limit);
  const nextOffset = offset + lines.length;
  return { character_id: characterId, count: allLines.length, lines,
    next_cursor: nextOffset < allLines.length ? encodeCursor(context.snapshot.id, filter, nextOffset) : null,
    provenance: { snapshot: context.snapshot, source_revisions: scenes.flatMap((scene) => scene.loaded.sourceFiles) } };
}

function canonicalScenePath(path: string): boolean {
  return /^plot\/volumes\/[^/]+\/chapters\/[^/]+\/scenes\/[^/]+\.ya?ml$/u.test(path);
}

function keyDigest(value: string): string {
  return [...sha256(new TextEncoder().encode(value))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utf8Digest(value: string): string { return keyDigest(value); }

function proposalKey(value: unknown): string {
  const key = requiredString(value, "idempotency_key", 128);
  if (!/^[A-Za-z0-9._:-]+$/u.test(key)) throw Object.assign(new Error("idempotency_key contains unsupported characters"), { code: "invalid_input" });
  return key;
}

function* hostTimestamp(host: Parameters<Handler>[2], request: ActionRequest): Generator<HostCall, string, unknown> {
  if (!request.idempotency_key) throw Object.assign(new Error("A Host idempotency key is required for timestamped Speaker proposals"), { code: "invalid_input" });
  const result = yield* host.request<{ timestamp: string }>("workspace.change.timestamp", {});
  const timestamp = requiredString(result.timestamp, "Host timestamp", 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw Object.assign(new Error("Host returned an invalid durable timestamp"), { code: "unsupported_schema" });
  }
  return timestamp;
}

function validateRequestKey(context: ActionRequest, key: string): void {
  if (context.idempotency_key !== key) throw Object.assign(new Error("ActionRequest.idempotency_key must match the Speaker input idempotency_key"), { code: "invalid_input" });
}

function byteArray(bytes: Uint8Array): number[] { return Array.from(bytes); }

function proposalReference(value: unknown): { proposal_id: string; status?: string } {
  const result = rawObject(value);
  const proposal_id = requiredString(result.proposal_id, "Host proposal_id");
  return { proposal_id, ...(typeof result.status === "string" ? { status: result.status } : {}) };
}

function makeChangeSet(context: ActionRequest, key: string, title: string, reason: string,
  reads: Array<{ path: string; revision: string | null }>, operations: FileOperation[], evidence: SourceSpan[]): ChangeSet {
  const digest = keyDigest(`${SPEAKER_PLUGIN_ID}\0${context.action_id}\0${key}`);
  const readMap = new Map<string, string | null>();
  for (const row of reads) {
    const prior = readMap.get(row.path);
    if (readMap.has(row.path) && prior !== row.revision) throw Object.assign(new Error(`Conflicting revisions for ${row.path}`), { code: "snapshot_stale" });
    readMap.set(row.path, row.revision);
  }
  return {
    id: `speaker-${digest.slice(0, 40)}`,
    idempotency_key: key,
    scope: context.scope,
    snapshot: context.snapshot,
    title,
    reason,
    read_set: [...readMap].sort(([a], [b]) => a.localeCompare(b)).map(([path, revision]) => ({ path, revision })),
    units: [{ id: `speaker-unit-${digest.slice(0, 32)}`, label: title, depends_on: [], operations }],
    evidence,
  };
}

function readOverrides(scene: LoadedScene): SpeakerOverride[] {
  const value = scene.scene.raw.speakerOverrides;
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw Object.assign(new Error("speakerOverrides must be a YAML sequence"), { code: "unsupported_format", details: { path: scene.scene.filePath } });
  return value.filter((item): item is SpeakerOverride => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    return typeof row.dialogueText === "string" && (typeof row.speakerEntityId === "string" || row.speakerEntityId === null);
  });
}

function editSceneDocument(bytes: Uint8Array, path: string, edit: (document: ReturnType<typeof readYaml>["document"]) => void): Uint8Array {
  const parsed = readYaml(bytes, path);
  if (!parsed.document.contents || parsed.document.contents === null || typeof parsed.document.contents !== "object" || !("set" in parsed.document.contents)) {
    throw Object.assign(new Error(`Scene YAML root must be a mapping: ${path}`), { code: "unsupported_format" });
  }
  edit(parsed.document);
  return new TextEncoder().encode(parsed.document.toString());
}

function* characterExists(host: Parameters<Handler>[2], id: string): Generator<HostCall, Record<string, unknown>, unknown> {
  const result = yield* invokeAction<{ entity: Record<string, unknown> }>(host, KNOWLEDGE_PLUGIN_ID, "knowledge.entities.get", { id });
  const entity = rawObject(result.entity);
  if (entity.id !== id || entity.type !== "character") throw Object.assign(new Error(`Knowledge entity is not a character: ${id}`), { code: "file_not_found" });
  return entity;
}

function lineByInput(lines: SpeakerAttribution[], item: Record<string, unknown>): SpeakerAttribution {
  const sentenceIndex = item.sentence_index;
  if (!Number.isSafeInteger(sentenceIndex) || (sentenceIndex as number) < 1) throw Object.assign(new Error("sentence_index must be a positive one-based integer"), { code: "invalid_input" });
  const dialogueText = requiredString(item.dialogue_text, "dialogue_text", 500_000);
  const textHash = requiredString(item.text_hash, "text_hash", 8);
  if (!/^[a-f0-9]{8}$/u.test(textHash) || hashDialogueText(dialogueText) !== textHash) throw Object.assign(new Error("dialogue_text and text_hash disagree"), { code: "snapshot_stale" });
  const row = lines.find((candidate) => candidate.sentenceIndex === sentenceIndex);
  if (!row || row.text !== dialogueText || hashDialogueText(row.text) !== textHash) throw Object.assign(new Error("Selected dialogue no longer matches the pinned scene"), { code: "snapshot_stale" });
  return row;
}

function correctionItems(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input) || input.length < 1 || input.length > 200) throw Object.assign(new Error("items must contain 1 to 200 corrections"), { code: "invalid_input" });
  return input.map((candidate) => {
    const item = object(candidate, "correction item");
    exactKeys(item, ["sentence_index", "dialogue_text", "text_hash", "predicted_speaker_entity_id", "predicted_reason", "speaker_group_id", "speaker_entity_id", "label"], "correction item");
    if (item.predicted_speaker_entity_id !== null && typeof item.predicted_speaker_entity_id !== "string") throw Object.assign(new Error("predicted_speaker_entity_id must be a string or null"), { code: "invalid_input" });
    if (item.speaker_group_id !== null && typeof item.speaker_group_id !== "string") throw Object.assign(new Error("speaker_group_id must be a string or null"), { code: "invalid_input" });
    if (item.speaker_entity_id !== null && typeof item.speaker_entity_id !== "string") throw Object.assign(new Error("speaker_entity_id must be a character ID or null"), { code: "invalid_input" });
    requiredString(item.predicted_reason, "predicted_reason", 80);
    if (item.label !== "direct" && item.label !== "propagated") throw Object.assign(new Error("label must be direct or propagated"), { code: "invalid_input" });
    return { ...item,
      predicted_speaker_entity_id: item.predicted_speaker_entity_id === "" ? null : item.predicted_speaker_entity_id,
      speaker_group_id: item.speaker_group_id === "" ? null : item.speaker_group_id,
      speaker_entity_id: item.speaker_entity_id === "" ? null : item.speaker_entity_id };
  });
}

function proposalEvidence(loaded: LoadedScene, row: SpeakerAttribution): SourceSpan {
  if (loaded.draftGeneration) throw Object.assign(new Error("Corrections against unsaved drafts require a fresh saved snapshot"), { code: "dirty_draft" });
  const span = splitIntoSentenceOffsets(loaded.text)[row.sentenceIndex - 1];
  if (!span || loaded.text.slice(span.start, span.end) !== row.text) throw Object.assign(new Error("Correction evidence is stale"), { code: "snapshot_stale" });
  return { path: loaded.narrative.manuscript_path, revision: loaded.narrative.manuscript_revision, start: span.start, end: span.end, quote: row.text };
}

function* speakerOverride(input: Record<string, unknown>, context: ActionRequest, host: Parameters<Handler>[2]): Generator<HostCall, unknown, unknown> {
  exactKeys(input, ["mode", "scene_id", "sentence_index", "dialogue_text", "text_hash", "speaker_entity_id", "items", "idempotency_key"], "speaker.override input");
  const mode = input.mode;
  const sceneId = requiredString(input.scene_id, "scene_id");
  if (mode === "propose") validateRequestKey(context, proposalKey(input.idempotency_key));
  const loaded = yield* loadScene(host, context, sceneId);
  if (!canonicalScenePath(loaded.scene.filePath)) throw Object.assign(new Error("Narrative returned a non-canonical scene metadata path"), { code: "invalid_scene_path" });
  const pipeline = yield* speakerPipeline(host, context, loaded);
  const rows = pipeline.result.attributions;
  if (mode === "preview-group") {
    exactKeys(input, ["mode", "scene_id", "sentence_index", "dialogue_text", "text_hash", "speaker_entity_id"], "speaker.override preview input");
    const selected = lineByInput(rows, input);
    const target = input.speaker_entity_id === "" ? null : input.speaker_entity_id;
    if (target !== null && typeof target !== "string") throw Object.assign(new Error("speaker_entity_id must be a character ID or null"), { code: "invalid_input" });
    if (typeof target === "string") yield* characterExists(host, target);
    const existing = readOverrides(loaded);
    const affected = rows.filter((row) => row.sentenceIndex === selected.sentenceIndex ||
      (selected.speakerGroupId !== null && row.speakerGroupId === selected.speakerGroupId && row.speakerEntityId === null && row.reason !== "manual-override"));
    return {
      affected_lines: affected.map((row) => ({ sentence_index: row.sentenceIndex, dialogue_text: row.text,
        text_hash: hashDialogueText(row.text), predicted_speaker_entity_id: row.speakerEntityId,
        predicted_reason: row.reason, speaker_group_id: row.speakerGroupId,
        can_propagate: row.sentenceIndex !== selected.sentenceIndex && row.speakerEntityId === null && row.reason !== "manual-override" &&
          !existing.some((override) => override.sentenceIndex === row.sentenceIndex && override.textHash === hashDialogueText(row.text) && (override.source ?? "direct") === "direct") })),
      expected_revisions: loaded.sourceFiles,
      provenance: pipelineProvenance(loaded, pipeline),
    };
  }
  if (mode !== "propose") throw Object.assign(new Error("mode must be preview-group or propose"), { code: "invalid_input" });
  exactKeys(input, ["mode", "scene_id", "items", "idempotency_key"], "speaker.override propose input");
  const key = proposalKey(input.idempotency_key);
  validateRequestKey(context, key);
  const selected = correctionItems(input.items);
  const labels = selected.map((item) => item.label);
  if (labels.filter((label) => label === "direct").length !== 1 || labels[0] !== "direct" || labels.slice(1).some((label) => label !== "propagated")) {
    throw Object.assign(new Error("Submit exactly one direct correction first, followed by explicitly selected propagated lines"), { code: "invalid_input" });
  }
  const validated: Array<{ item: Record<string, unknown>; row: SpeakerAttribution }> = [];
  const seen = new Set<number>();
  const groupId = selected[0]?.speaker_group_id;
  for (const item of selected) {
    const row = lineByInput(rows, item);
    if (seen.has(row.sentenceIndex)) throw Object.assign(new Error("Correction repeats a sentence"), { code: "invalid_input" });
    seen.add(row.sentenceIndex);
    if (row.speakerEntityId !== item.predicted_speaker_entity_id || row.reason !== item.predicted_reason || row.speakerGroupId !== item.speaker_group_id) {
      throw Object.assign(new Error("Prediction no longer matches the pinned scene"), { code: "snapshot_stale" });
    }
    if (item.label === "propagated" && (item.speaker_group_id !== groupId || row.speakerGroupId !== groupId || row.speakerEntityId !== null || row.reason === "manual-override")) {
      throw Object.assign(new Error("Only unresolved members of the initiating group may be propagated"), { code: "invalid_input" });
    }
    validated.push({ item, row });
  }
  const selectedSpeaker = selected[0]!.speaker_entity_id;
  if (selectedSpeaker !== null) yield* characterExists(host, selectedSpeaker as string);
  for (const item of selected.slice(1)) if (item.speaker_entity_id !== selectedSpeaker) throw Object.assign(new Error("All group corrections must use the explicitly selected same character or unknown"), { code: "invalid_input" });
  if (selected.slice(1).length > 0 && (typeof groupId !== "string" || !groupId)) throw Object.assign(new Error("Group propagation requires an unresolved speaker group"), { code: "invalid_input" });

  const metadataBytes = yield* readFile(host, context.snapshot, loaded.scene.filePath);
  const existing = readOverrides(loaded);
  const newOverrides = validated.map(({ item }) => ({
    sentenceIndex: item.sentence_index,
    textHash: item.text_hash,
    dialogueText: item.dialogue_text,
    speakerEntityId: item.speaker_entity_id,
    speakerGroupId: item.speaker_group_id,
    source: item.label,
  }));
  const targetIndices = new Set(newOverrides.map((row) => row.sentenceIndex));
  const targetTexts = new Set(newOverrides.map((row) => row.dialogueText));
  const targetHashes = new Set(newOverrides.map((row) => row.textHash).filter((hash) => rows.filter((row) => hashDialogueText(row.text) === hash).length === 1));
  const retained = (Array.isArray(loaded.scene.raw.speakerOverrides) ? loaded.scene.raw.speakerOverrides : []).filter((value) => {
    const row = rawObject(value);
    return !(typeof row.sentenceIndex === "number" && targetIndices.has(row.sentenceIndex)) &&
      !(typeof row.textHash === "string" && targetHashes.has(row.textHash)) &&
      !(row.sentenceIndex === undefined && typeof row.dialogueText === "string" && targetTexts.has(row.dialogueText) && rows.filter((line) => line.text === row.dialogueText).length === 1);
  });
  const updatedMetadata = editSceneDocument(metadataBytes, loaded.scene.filePath, (document) => document.set("speakerOverrides", [...retained, ...newOverrides]));

  const logPath = `${SPEAKER_PREFIX}/corrections.jsonl`;
  const logRevision = yield* fileRevision(host, context.snapshot, logPath);
  const logBefore = logRevision ? yield* readFile(host, context.snapshot, logPath) : new Uint8Array();
  const timestamp = yield* hostTimestamp(host, context);
  const events = validated.map(({ item, row }) => ({ sentenceIndex: row.sentenceIndex, textHash: hashDialogueText(row.text),
    dialogueText: row.text, predictedSpeakerEntityId: row.speakerEntityId, predictedReason: row.reason,
    speakerGroupId: row.speakerGroupId, label: item.label, sceneId, speakerEntityId: item.speaker_entity_id, timestamp }));
  const history = new TextEncoder().encode(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
  const logContent = new Uint8Array(logBefore.length + (logBefore.length > 0 && logBefore[logBefore.length - 1] !== 10 ? 1 : 0) + history.length);
  logContent.set(logBefore, 0);
  const logOffset = logBefore.length + (logBefore.length > 0 && logBefore[logBefore.length - 1] !== 10 ? 1 : 0);
  if (logOffset > logBefore.length) logContent[logBefore.length] = 10;
  logContent.set(history, logOffset);

  const evidence = validated.map(({ row }) => proposalEvidence(loaded, row));
  const digest = keyDigest(`${SPEAKER_PLUGIN_ID}\0speaker.override\0${key}`);
  const changeset = makeChangeSet(context, key, "Correct speaker attribution", `Confirm ${validated.length} dialogue speaker assignment(s) in scene ${sceneId}.`,
    [...loaded.sourceFiles, { path: logPath, revision: logRevision }, { path: loaded.scene.filePath, revision: loaded.scene.revision }],
    [
      { id: `speaker-overrides-${digest.slice(0, 20)}`, kind: "replace", path: loaded.scene.filePath, expected_revision: loaded.scene.revision, content: byteArray(updatedMetadata) },
      { id: `speaker-corrections-${digest.slice(0, 20)}`, kind: logRevision ? "replace" : "create", path: logPath, expected_revision: logRevision, content: byteArray(logContent) },
    ], evidence);
  const proposal = yield* propose(host, changeset);
  return { ...proposalReference(proposal), affected_lines: validated.map(({ item, row }) => ({ sentence_index: row.sentenceIndex,
    dialogue_text: row.text, text_hash: hashDialogueText(row.text), speaker_entity_id: item.speaker_entity_id, label: item.label })),
    expected_revisions: changeset.read_set, preview: { scene_path: loaded.scene.filePath, correction_history_path: logPath,
      line_count: validated.length, speaker: selectedSpeaker }, provenance: pipelineProvenance(loaded, pipeline) };
}

function* countUpdate(input: Record<string, unknown>, context: ActionRequest, host: Parameters<Handler>[2]): Generator<HostCall, unknown, unknown> {
  exactKeys(input, ["scene_id", "speaker_count", "idempotency_key"], "speaker.count.update input");
  const sceneId = requiredString(input.scene_id, "scene_id");
  const count = input.speaker_count;
  if (count !== null && (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 1000)) {
    throw Object.assign(new Error("speaker_count must be null or an integer from 1 to 1000"), { code: "invalid_input" });
  }
  const key = proposalKey(input.idempotency_key);
  validateRequestKey(context, key);
  const loaded = yield* loadScene(host, context, sceneId);
  if (!canonicalScenePath(loaded.scene.filePath)) throw Object.assign(new Error("Narrative returned a non-canonical scene metadata path"), { code: "invalid_scene_path" });
  const pipeline = yield* speakerPipeline(host, context, loaded);
  const metadataBytes = yield* readFile(host, context.snapshot, loaded.scene.filePath);
  const updated = editSceneDocument(metadataBytes, loaded.scene.filePath, (document) => {
    if (count === null) document.delete("speakerCount");
    else document.set("speakerCount", count);
  });
  if (updated.length === metadataBytes.length && updated.every((byte, index) => byte === metadataBytes[index])) {
    throw Object.assign(new Error("The scene speaker count already has this value"), { code: "no_change" });
  }
  const digest = keyDigest(`${SPEAKER_PLUGIN_ID}\0speaker.count.update\0${key}`);
  const changeset = makeChangeSet(context, key, count === null ? "Clear manual speaker count" : "Update manual speaker count",
    count === null ? `Restore the estimated speaker count for scene ${sceneId}.` : `Set the explicit speaker count for scene ${sceneId} to ${count}.`,
    [...loaded.sourceFiles, { path: loaded.scene.filePath, revision: loaded.scene.revision }],
    [{ id: `speaker-count-${digest.slice(0, 20)}`, kind: "replace", path: loaded.scene.filePath, expected_revision: loaded.scene.revision, content: byteArray(updated) }], []);
  const proposal = yield* propose(host, changeset);
  return { ...proposalReference(proposal), preview: { scene_id: sceneId, speaker_count: count,
    estimated_speaker_count: pipeline.result.estimatedN,
    count_evidence: { known_floor: pipeline.result.evidence.knownFloor, vocative_census: pipeline.result.evidence.vocativeCensus } }, expected_revisions: changeset.read_set,
    provenance: pipelineProvenance(loaded, pipeline) };
}

function* voiceProfiles(input: Record<string, unknown>, context: ActionRequest, host: Parameters<Handler>[2]): Generator<HostCall, unknown, unknown> {
  exactKeys(input, ["character_id"], "speaker.voice.profiles input");
  const characterId = input.character_id === undefined ? undefined : requiredString(input.character_id, "character_id");
  if (characterId) yield* characterExists(host, characterId);
  const scenes = yield* analyzeScenes(host, context);
  const dialoguesByCharacter: Record<string, DialogueTokens[]> = Object.create(null) as Record<string, DialogueTokens[]>;
  const stylometricByCharacter = new Map<string, Token[][]>();
  const countsByCharacter = new Map<string, number>();
  let utteranceCount = 0;
  let characterCount = 0;
  let reduced = false;
  const sourceRevisions: Array<{ path: string; revision: string }> = [];
  for (const scene of scenes) {
    reduced ||= scene.pipeline.warnings.includes("reduced_tokenizer");
    sourceRevisions.push(...scene.loaded.sourceFiles);
    const spans = splitIntoSentenceOffsets(scene.loaded.text);
    for (const attribution of scene.computed.attributions) {
      if (attribution.speakerEntityId === null || attribution.confidence !== "high" || (characterId && attribution.speakerEntityId !== characterId)) continue;
      utteranceCount++;
      if (utteranceCount > 500) throw Object.assign(new Error("Voice profile corpus exceeds 500 dialogue samples"), { code: "voice_corpus_too_large" });
      characterCount += Array.from(attribution.text).length;
      if (characterCount > 20_000) throw Object.assign(new Error("Voice profile corpus exceeds 20,000 Unicode characters"), { code: "voice_corpus_too_large" });
      const span = spans[attribution.sentenceIndex - 1];
      if (!span || scene.loaded.text.slice(span.start, span.end) !== attribution.text) throw Object.assign(new Error("Voice profile row is stale"), { code: "snapshot_stale" });
      const content = removeDialogueBrackets(attribution.text);
      const tokens = scene.pipeline.tokenCache[content] ?? [];
      if (!tokens.length && content.length) continue;
      countsByCharacter.set(attribution.speakerEntityId, (countsByCharacter.get(attribution.speakerEntityId) ?? 0) + 1);
      (dialoguesByCharacter[attribution.speakerEntityId] ??= []).push({ text: attribution.text, tokens });
      if (!reduced) {
        const rows = stylometricByCharacter.get(attribution.speakerEntityId) ?? [];
        rows.push(tokens);
        stylometricByCharacter.set(attribution.speakerEntityId, rows);
      }
    }
  }
  const fingerprints = computeStyleFingerprints(dialoguesByCharacter);
  const separation = computeVoiceSeparationMatrix(fingerprints);
  const profiles = reduced ? [] : computeStylometricProfiles(stylometricByCharacter);
  const declaredByCharacter = new Map<string, unknown[]>();
  for (const scene of scenes) for (const entity of scene.loaded.entities) {
    if (entity.type !== "character") continue;
    const declared = extractVoiceProfiles(entity);
    if (declared) declaredByCharacter.set(entity.id, declared as unknown[]);
  }
  return {
    ...(characterId ? { character_id: characterId } : {}),
    fingerprints: fingerprints.map((row) => ({ entity_id: row.entityId, sample_count: row.dialogueCount,
      first_person_distribution: row.firstPersonDist, ending_distribution: row.endingBigramDist,
      particle_distribution: row.particleDist, exclamation_rate: row.exclamationRate, question_rate: row.questionRate,
      average_dialogue_length: row.avgDialogueLength, dialogue_length_variance: row.dialogueLengthVariance,
      polite_ratio: row.politeRatio, katakana_rate: row.katakanaRate, minimum_samples: 3, provenance: "speaker-owned-style-fingerprint" })),
    declared_profiles: [...declaredByCharacter].filter(([id]) => !characterId || id === characterId).map(([entity_id, profiles]) => ({ entity_id, profiles })),
    character_sample_counts: [...countsByCharacter].filter(([id]) => !characterId || id === characterId).map(([entity_id, sample_count]) => ({ entity_id, sample_count,
      sufficient_for_profile: sample_count >= 3, minimum_samples: 3 })),
    separation_matrix: separation.map((pair) => ({ entity_id_a: pair.entityIdA, entity_id_b: pair.entityIdB,
      distance: Math.max(0, Math.min(1, 1 - pair.similarity)), similarity: pair.similarity, sample_counts: {
        [pair.entityIdA]: fingerprints.find((row) => row.entityId === pair.entityIdA)?.dialogueCount ?? 0,
        [pair.entityIdB]: fingerprints.find((row) => row.entityId === pair.entityIdB)?.dialogueCount ?? 0,
      }, method: "cosine-style-fingerprint", too_similar: pair.tooSimilar })),
    stylometric_profiles: profiles.map((row) => ({ entity_id: row.entityId, sample_count: row.dialogueCount, mean: row.mean, standard_deviation: row.stdDev })),
    provenance: { snapshot: context.snapshot, scenes_scanned: scenes.length, utterance_count: utteranceCount,
      source_revisions: sourceRevisions, tokenizer: scenes.map((scene) => scene.pipeline.tokenizerIdentity),
      stylometry_available: !reduced, ...(reduced ? { warning: "reduced_tokenizer_stylometry_unavailable" } : {}) },
  };
}

function warningOutput(loaded: LoadedScene, warning: { sentenceIndex: number; text: string; speakerEntityId?: string; issue: string; expected?: unknown; found?: unknown; confidence?: unknown; distance?: number; threshold?: number }, source: string): Record<string, unknown> {
  const span = splitIntoSentenceOffsets(loaded.text)[warning.sentenceIndex - 1];
  if (!span || loaded.text.slice(span.start, span.end) !== warning.text) throw Object.assign(new Error("Voice warning no longer maps to the source text"), { code: "snapshot_stale" });
  return { sentence_index: warning.sentenceIndex, start_utf16: span.start, end_utf16: span.end, text: warning.text,
    speaker_entity_id: warning.speakerEntityId ?? null, source, rule: warning.issue,
    expected: warning.expected ?? null, found: warning.found ?? null, confidence: warning.confidence ?? "low",
    ...(warning.distance !== undefined ? { distance: warning.distance, threshold: warning.threshold } : {}),
    source_span: { path: loaded.narrative.manuscript_path, revision: loaded.textRevision, start: span.start, end: span.end, quote: warning.text } };
}

function* voiceCheck(input: Record<string, unknown>, context: ActionRequest, host: Parameters<Handler>[2]): Generator<HostCall, unknown, unknown> {
  const parsed = parseSceneActionInput(input, true);
  const loaded = yield* loadScene(host, context, parsed.sceneId, parsed.draft);
  const pipeline = yield* speakerPipeline(host, context, loaded);
  const attributions = pipeline.result.attributions;
  const speakerDefinitions: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const entity of loaded.entities) if (entity.type === "character") speakerDefinitions[entity.id] = entity.raw;
  const declared = checkDeclaredVoiceConsistency(attributions, speakerDefinitions, loaded.scene.raw);
  const styleRows: Array<{ speakerEntityId: string | null; confidence: "high" | "low" | "none"; text: string; sentenceIndex: number; tokens: Token[] }> = [];
  const dialoguesByCharacter = new Map<string, DialogueTokens[]>();
  const dialogueTokens = new Map<string, Token[][]>();
  const styleAttributions: Array<{ speakerEntityId: string | null; confidence: "high" | "low" | "none"; text: string; sentenceIndex: number; tokens: Token[] }> = [];
  for (const row of attributions) {
    const content = removeDialogueBrackets(row.text);
    const tokens = pipeline.tokenCache[content] ?? [];
    const styleRow = { speakerEntityId: row.speakerEntityId, confidence: row.confidence, text: row.text, sentenceIndex: row.sentenceIndex, tokens };
    styleRows.push(styleRow);
    styleAttributions.push(styleRow);
    if (row.speakerEntityId !== null && row.confidence === "high" && tokens.length > 0) {
      const dialogueRows = dialoguesByCharacter.get(row.speakerEntityId) ?? [];
      dialogueRows.push({ text: row.text, tokens });
      dialoguesByCharacter.set(row.speakerEntityId, dialogueRows);
      const bucket = dialogueTokens.get(row.speakerEntityId) ?? [];
      bucket.push(tokens);
      dialogueTokens.set(row.speakerEntityId, bucket);
    }
  }
  const reduced = pipeline.warnings.includes("reduced_tokenizer");
  const fingerprints = computeStyleFingerprints(Object.fromEntries(dialoguesByCharacter));
  const learned = reduced ? [] : detectStyleDeviations(styleRows, fingerprints);
  const stylometricProfiles = reduced ? [] : computeStylometricProfiles(dialogueTokens);
  const stylometric = reduced ? [] : detectStylometricDeviations(styleAttributions, stylometricProfiles);
  const declaredRows = declared.map((row) => warningOutput(loaded, { ...row, issue: row.issue, expected: row.expected, found: row.found, confidence: "low" }, "declared"));
  const learnedRows = learned.map((row) => warningOutput(loaded, { ...row, issue: row.issue, expected: row.expected, found: row.found, confidence: "low", distance: row.zScore }, "learned"));
  const stylometricRows = stylometric.map((row) => warningOutput(loaded, { ...row, issue: "stylometric-deviation", expected: `distance <= ${row.threshold}`, found: row.distance, confidence: "low", distance: row.distance, threshold: row.threshold }, "stylometric"));
  return { scene_id: parsed.sceneId, attributions: attributionRows(loaded, pipeline.result), declared_warnings: declaredRows,
    learned_style_warnings: learnedRows, stylometric_warnings: reduced ? { available: false, reason: "reduced_tokenizer" } : { available: true, issues: stylometricRows },
    issues: [...declaredRows, ...learnedRows, ...stylometricRows],
    availability: { declared: "available", learned_style: reduced ? "unavailable" : "available", stylometric: reduced ? "unavailable" : "available" },
    provenance: { ...pipelineProvenance(loaded, pipeline), source_files: loaded.sourceFiles, draft_generation: loaded.draftGeneration ?? null,
      stylometric_profiles: stylometricProfiles.map((row) => ({ entity_id: row.entityId, sample_count: row.dialogueCount })) } };
}

function evaluationPayload(context: ActionRequest, scenes: AnalyzedScene[]): {
  report: Record<string, unknown>; rawReport: ReturnType<typeof buildSpeakerEvalReport>; gates: SpeakerRuleGates; goldCount: number; matchedCount: number;
} {
  const sceneReports: Array<ReturnType<typeof buildSceneEvalResult>["result"]> = [];
  const matchedByScene: MatchedEvalLine[][] = [];
  const nEvals: Array<{ goldN: number; estimatedN: number }> = [];
  let goldCount = 0;
  let matchedCount = 0;
  for (const scene of scenes) {
    const overrides = readOverrides(scene.loaded);
    goldCount += overrides.length;
    const evaluated = buildSceneEvalResult(scene.item.id, overrides, scene.computed.attributions);
    sceneReports.push(evaluated.result);
    matchedByScene.push(evaluated.matched);
    matchedCount += evaluated.result.textHashMatchedCount;
    const rawCount = scene.loaded.scene.raw.speakerCount;
    if (typeof rawCount === "number" && Number.isSafeInteger(rawCount) && rawCount > 0) nEvals.push({ goldN: rawCount, estimatedN: scene.computed.estimatedN });
  }
  if (matchedCount === 0) throw Object.assign(new Error("No current text-hash-matched gold speaker corrections are available"), { code: "no_gold_data" });
  const rawReport = buildSpeakerEvalReport(sceneReports, matchedByScene, nEvals, "");
  const gates = computeSpeakerRuleGates(rawReport.byReason);
  const report = {
    scenes: rawReport.scenes.map((row) => ({ scene_id: row.sceneId, text_hash_matched_count: row.textHashMatchedCount,
      text_hash_mismatch_count: row.textHashMismatchCount, lines: row.lines.map((line) => ({ gold_speaker_entity_id: line.gold,
        predicted_speaker_entity_id: line.predicted, reason: line.reason, confidence: line.confidence })) })),
    by_reason: Object.fromEntries(Object.entries(rawReport.byReason).map(([reason, stats]) => [reason, { fired: stats.fired, correct: stats.correct,
      measured_precision: stats.fired ? stats.correct / stats.fired : 0, gate: gates.gates[reason]?.action ?? null }])),
    metrics: { high_precision: rawReport.metrics.highPrecision, attribution_accuracy: rawReport.metrics.attributionAccuracy,
      coverage: rawReport.metrics.coverage, clustering_pairwise_f1: rawReport.metrics.clusteringPairwiseF1,
      speaker_count_mae: rawReport.metrics.nMae, within_one_rate: rawReport.metrics.nWithin1Rate },
    counts: { scenes: scenes.length, gold_corrections: goldCount, hash_matched: matchedCount,
      hash_mismatched: rawReport.scenes.reduce((sum, row) => sum + row.textHashMismatchCount, 0), speaker_count_scenes: nEvals.length },
  };
  return { report, rawReport, gates, goldCount, matchedCount };
}

function cacheIdentity(context: ActionRequest, modelRevision: string | null, key: string): import("../../shared/operations.js").CacheKey {
  return {
    plugin_id: SPEAKER_PLUGIN_ID,
    snapshot: context.snapshot,
    schema_version: 1,
    config_digest: keyDigest(JSON.stringify({ engine: [SPEAKER_ENGINE_ID, SPEAKER_ENGINE_VERSION], tokenizer_action: "research.nlp.analyze:v1", fallback: "proprium-speaker-regex-fallback:v1" })),
    model_digest: keyDigest(JSON.stringify(modelRevision)),
    key,
  };
}

function* readCache(host: Parameters<Handler>[2], key: import("../../shared/operations.js").CacheKey): Generator<HostCall, { found: boolean; value?: unknown }, unknown> {
  return yield* host.request(HOST_OPERATIONS.cacheGet, { key });
}

function* writeCache(host: Parameters<Handler>[2], key: import("../../shared/operations.js").CacheKey, value: unknown): Generator<HostCall, boolean, unknown> {
  try {
    const result = yield* host.request<{ stored: boolean }>(HOST_OPERATIONS.cachePut, { key, value });
    return result.stored === true;
  } catch (error) {
    if (optionalProviderFailure(error)) return false;
    throw error;
  }
}

function cachedGateValue(value: unknown, tokenizer: Record<string, string>): SpeakerRuleGates {
  const record = rawObject(value);
  const provenance = rawObject(record.provenance);
  const providers = Array.isArray(provenance.tokenizers) ? provenance.tokenizers.map(rawObject) : [];
  const matches = providers.some((provider) => provider.id === tokenizer.id && provider.version === tokenizer.version && provider.digest === tokenizer.digest);
  return matches ? parseSpeakerRuleGates(record.gates) : emptySpeakerRuleGates();
}

function* cachedRuleGates(host: Parameters<Handler>[2], context: ActionRequest, tokenizer: Record<string, string>, modelRevision: string | null): Generator<HostCall, SpeakerRuleGates, unknown> {
  const response = yield* readCache(host, cacheIdentity(context, modelRevision, "speaker.ruleGates"));
  if (!response.found) return emptySpeakerRuleGates();
  return cachedGateValue(response.value, tokenizer);
}

function evaluationProvenance(context: ActionRequest, scenes: AnalyzedScene[]): Record<string, unknown> {
  return { snapshot: context.snapshot, engine: { id: SPEAKER_ENGINE_ID, version: SPEAKER_ENGINE_VERSION },
    scenes_scanned: scenes.length, source_revisions: scenes.flatMap((scene) => scene.loaded.sourceFiles),
    tokenizers: [...new Map(scenes.map((scene) => [JSON.stringify(scene.pipeline.tokenizerIdentity), scene.pipeline.tokenizerIdentity])).values()],
    model_revisions: [...new Set(scenes.map((scene) => scene.pipeline.modelRevision).filter(Boolean))] };
}

function* evaluationRun(input: Record<string, unknown>, context: ActionRequest, host: Parameters<Handler>[2]): Generator<HostCall, unknown, unknown> {
  exactKeys(input, ["update_rule_gates"], "speaker.evaluation.run input");
  if (input.update_rule_gates !== undefined && typeof input.update_rule_gates !== "boolean") throw Object.assign(new Error("update_rule_gates must be a boolean"), { code: "invalid_input" });
  const scenes = yield* analyzeScenes(host, context, undefined, { ignoreOverrides: true, gates: emptySpeakerRuleGates() });
  const result = evaluationPayload(context, scenes);
  const modelRevision = scenes.map((scene) => scene.pipeline.modelRevision).find((revision): revision is string => revision !== null) ?? null;
  const provenance = evaluationProvenance(context, scenes);
  const reportStored = yield* writeCache(host, cacheIdentity(context, modelRevision, "speaker.evaluation"),
    { schema_version: 1, report: result.report, provenance });
  let gatesStored = false;
  if (input.update_rule_gates === true) {
    gatesStored = yield* writeCache(host, cacheIdentity(context, modelRevision, "speaker.ruleGates"),
      { version: result.gates.version, gates: result.gates.gates, provenance });
  }
  return { report: result.report, gates: Object.fromEntries(Object.entries(result.gates.gates).map(([reason, gate]) => [reason,
    { action: gate.action, measured_precision: gate.measuredPrecision, sample_size: gate.sampleSize }])),
    gates_updated: gatesStored, cache_stored: reportStored, provenance,
    cache_identity: cacheIdentity(context, modelRevision, "speaker.evaluation") };
}

function validEvaluationCache(value: unknown): Record<string, unknown> | null {
  const row = rawObject(value);
  const report = rawObject(row.report);
  const metrics = rawObject(report.metrics);
  if (row.schema_version !== 1 || !Array.isArray(report.scenes) || typeof metrics.attribution_accuracy !== "number" ||
      typeof metrics.high_precision !== "number" || typeof metrics.coverage !== "number" ||
      typeof metrics.clustering_pairwise_f1 !== "number" || typeof metrics.speaker_count_mae !== "number" || typeof metrics.within_one_rate !== "number") return null;
  return { report, provenance: rawObject(row.provenance) };
}

function* evaluationLatest(input: Record<string, unknown>, context: ActionRequest, host: Parameters<Handler>[2]): Generator<HostCall, unknown, unknown> {
  exactKeys(input, [], "speaker.evaluation.latest input");
  const modelPath = `${SPEAKER_PREFIX}/adopted-model.json`;
  const modelRevision = yield* fileRevision(host, context.snapshot, modelPath);
  const cached = yield* readCache(host, cacheIdentity(context, modelRevision, "speaker.evaluation"));
  const value = cached.found ? validEvaluationCache(cached.value) : null;
  return value ? { exists: true, report: value.report, provenance: value.provenance }
    : { exists: false, provenance: { snapshot: context.snapshot, reason: "no_matching_evaluation_cache" } };
}

function* ruleGates(input: Record<string, unknown>, context: ActionRequest, host: Parameters<Handler>[2]): Generator<HostCall, unknown, unknown> {
  exactKeys(input, [], "speaker.ruleGates input");
  const modelRevision = yield* fileRevision(host, context.snapshot, `${SPEAKER_PREFIX}/adopted-model.json`);
  const cached = yield* readCache(host, cacheIdentity(context, modelRevision, "speaker.ruleGates"));
  if (!cached.found) return { exists: false, gates: {}, provenance: { snapshot: context.snapshot, reason: "no_matching_evaluation_cache" } };
  const record = rawObject(cached.value);
  const parsed = parseSpeakerRuleGates(record);
  if (record.version !== 1 || !record.provenance) return { exists: false, gates: {}, provenance: { snapshot: context.snapshot, reason: "invalid_or_stale_cache" } };
  return { exists: true, gates: Object.fromEntries(Object.entries(parsed.gates).map(([reason, gate]) => [reason,
    { action: gate.action, measured_precision: gate.measuredPrecision, sample_size: gate.sampleSize }])), provenance: record.provenance };
}

function* retrainingRun(input: Record<string, unknown>, context: ActionRequest, host: Parameters<Handler>[2]): Generator<HostCall, unknown, unknown> {
  exactKeys(input, ["holdout_scene_ids", "dry_run", "idempotency_key"], "speaker.retraining.run input");
  const key = proposalKey(input.idempotency_key);
  validateRequestKey(context, key);
  if (input.dry_run !== undefined && typeof input.dry_run !== "boolean") throw Object.assign(new Error("dry_run must be a boolean"), { code: "invalid_input" });
  let requestedHoldout: string[] | undefined;
  if (input.holdout_scene_ids !== undefined) {
    if (!Array.isArray(input.holdout_scene_ids) || input.holdout_scene_ids.length > MAX_SCENES ||
        input.holdout_scene_ids.some((id) => typeof id !== "string" || !id.trim())) throw Object.assign(new Error("holdout_scene_ids must be a bounded scene ID array"), { code: "invalid_input" });
    requestedHoldout = [...new Set(input.holdout_scene_ids as string[])];
    if (requestedHoldout.length !== input.holdout_scene_ids.length) throw Object.assign(new Error("holdout_scene_ids contains duplicates"), { code: "invalid_input" });
  }
  const scenes = yield* analyzeScenes(host, context, undefined, { ignoreOverrides: true, gates: emptySpeakerRuleGates() });
  const goldScenes = scenes.filter((scene) => readOverrides(scene.loaded).length > 0);
  if (goldScenes.length < 2) throw Object.assign(new Error("At least two gold-labeled scenes are required for a non-empty train and holdout split"), { code: "empty_holdout" });
  let holdoutIds = requestedHoldout;
  if (!holdoutIds) {
    const ordered = [...goldScenes].sort((a, b) => keyDigest(a.item.id).localeCompare(keyDigest(b.item.id)) || a.item.id.localeCompare(b.item.id));
    const count = Math.max(1, Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.2)));
    holdoutIds = ordered.slice(0, count).map((scene) => scene.item.id);
  }
  if (!holdoutIds.length) throw Object.assign(new Error("Holdout set is empty"), { code: "empty_holdout" });
  const goldIds = new Set(goldScenes.map((scene) => scene.item.id));
  if (holdoutIds.some((id) => !goldIds.has(id))) throw Object.assign(new Error("Every holdout scene must contain gold speaker labels"), { code: "invalid_input" });
  const heldOut = new Set(holdoutIds);
  const trainScenes = goldScenes.filter((scene) => !heldOut.has(scene.item.id));
  const testScenes = goldScenes.filter((scene) => heldOut.has(scene.item.id));
  if (!trainScenes.length) throw Object.assign(new Error("Holdout selection leaves no training scenes"), { code: "empty_holdout" });

  const logPath = `${SPEAKER_PREFIX}/corrections.jsonl`;
  const logRevision = yield* fileRevision(host, context.snapshot, logPath);
  const logText = logRevision ? decodeUtf8(yield* readFile(host, context.snapshot, logPath), logPath) : "";
  const corrections = parseSpeakerCorrections(logText).records;
  const trainingRows: ReturnType<typeof buildSpeakerRerankExamples> = [];
  for (const scene of trainScenes) {
    const candidateIds = scene.loaded.candidates.map((entity) => entity.id);
    trainingRows.push(...buildSpeakerRerankExamples({ attributions: scene.computed.attributions,
      overrides: readOverrides(scene.loaded), corrections,
      context: { candidateIds, ...(typeof scene.loaded.scene.raw.pov === "string" ? { povEntityId: scene.loaded.scene.raw.pov } : {}) }, sceneId: scene.item.id }));
  }
  if (trainingRows.length < 10) throw Object.assign(new Error("At least ten matched training examples are required"), { code: "insufficient_training_examples" });
  const learned = trainSpeakerRerankModel(trainingRows, { seed: Number.parseInt(keyDigest(`${context.snapshot.id}\0speaker.train`).slice(0, 8), 16) });
  if (learned.featureNames.length !== SPEAKER_RERANK_FEATURE_NAMES.length ||
      learned.featureNames.some((name, index) => name !== SPEAKER_RERANK_FEATURE_NAMES[index]) ||
      learned.weights.length !== SPEAKER_RERANK_FEATURE_NAMES.length || learned.weights.some((weight) => !Number.isFinite(weight)) || !Number.isFinite(learned.bias)) {
    throw Object.assign(new Error("Trained model does not match the pinned reranker feature schema"), { code: "unsupported_schema" });
  }
  const trainAccuracy = trainingRows.filter((row) => (scoreSpeakerRerank(row.features, learned) >= 0.5 ? 1 : 0) === row.label).length / trainingRows.length;
  const trainedAt = yield* hostTimestamp(host, context);
  const provisional: SpeakerModel = { version: 1, ...learned, highProbabilityThreshold: 0.9, trainedAt, holdoutSceneIds: holdoutIds };
  const basePairs: Array<{ gold: string | null; predicted: string | null }> = [];
  const modelPairs: Array<{ gold: string | null; predicted: string | null }> = [];
  const scored: Array<{ gold: string | null; probability: number; predicted: string | null }> = [];
  const evidence: SourceSpan[] = [];
  for (const scene of testScenes) {
    const predictions = scene.computed.attributions;
    const overrides = readOverrides(scene.loaded);
    const baseline = buildSceneEvalResult(scene.item.id, overrides, predictions).matched;
    const contextForRows = { candidateIds: scene.loaded.candidates.map((entity) => entity.id),
      ...(typeof scene.loaded.scene.raw.pov === "string" ? { povEntityId: scene.loaded.scene.raw.pov } : {}) };
    const reranked = applySpeakerReranker(predictions, provisional, contextForRows);
    const rerankedMatches = buildSceneEvalResult(scene.item.id, overrides, reranked).matched;
    basePairs.push(...baseline.map((row) => ({ gold: row.gold, predicted: row.predicted })));
    modelPairs.push(...rerankedMatches.map((row) => ({ gold: row.gold, predicted: row.predicted })));
    const byIndex = new Map(reranked.map((row) => [row.sentenceIndex, row]));
    const spans = splitIntoSentenceOffsets(scene.loaded.text);
    for (const override of overrides) {
      const predicted = byIndex.get(override.sentenceIndex ?? -1);
      const basePrediction = predictions.find((row) => row.sentenceIndex === (override.sentenceIndex ?? -1));
      if (!predicted || !basePrediction || (override.textHash && override.textHash !== hashDialogueText(predicted.text))) continue;
      const candidates = [...contextForRows.candidateIds, null];
      let bestProbability = -1;
      for (const candidateId of candidates) bestProbability = Math.max(bestProbability,
        scoreSpeakerRerank(extractSpeakerRerankFeatures(basePrediction, candidateId, predictions, contextForRows), provisional));
      scored.push({ gold: override.speakerEntityId, probability: bestProbability, predicted: predicted.speakerEntityId });
      const span = spans[predicted.sentenceIndex - 1];
      if (span) evidence.push({ path: scene.loaded.narrative.manuscript_path, revision: scene.loaded.narrative.manuscript_revision,
        start: span.start, end: span.end, quote: predicted.text });
    }
  }
  if (!modelPairs.length) throw Object.assign(new Error("Holdout has no text-hash-matched gold labels"), { code: "no_matched_holdout" });
  const threshold = calibrateHighProbabilityThreshold(scored);
  const accuracyWithoutModel = attributionAccuracyFromPairs(basePairs);
  const accuracyWithModel = attributionAccuracyFromPairs(modelPairs);
  const delta = accuracyWithModel - accuracyWithoutModel;
  const adopted = delta >= 0.05;
  const model: SpeakerModel = { ...provisional, highProbabilityThreshold: threshold,
    metrics: { trainAccuracy, holdoutAccuracyWithoutModel: accuracyWithoutModel, holdoutAccuracyWithModel: accuracyWithModel, adopted } };
  const output: Record<string, unknown> = { train_example_count: trainingRows.length, holdout_scene_ids: holdoutIds,
    accuracy_without_model: accuracyWithoutModel, accuracy_with_model: accuracyWithModel, train_accuracy: trainAccuracy,
    delta_percentage_points: delta * 100, high_probability_threshold: threshold, adopted,
    model_candidate: model, provenance: evaluationProvenance(context, scenes) };
  if (!adopted || input.dry_run === true) return { ...output, adoption_proposal: null };

  const modelPath = `${SPEAKER_PREFIX}/adopted-model.json`;
  const modelRevision = yield* fileRevision(host, context.snapshot, modelPath);
  const modelBytes = new TextEncoder().encode(`${JSON.stringify(model, null, 2)}\n`);
  const digest = keyDigest(`${SPEAKER_PLUGIN_ID}\0speaker.retraining.run\0${key}`);
  const changeset = makeChangeSet(context, key, "Adopt speaker attribution model", "Adopt the reranker only after the deterministic held-out improvement gate passed.",
    [...scenes.flatMap((scene) => scene.loaded.sourceFiles), { path: logPath, revision: logRevision }, { path: modelPath, revision: modelRevision }],
    [{ id: `speaker-model-${digest.slice(0, 20)}`, kind: modelRevision ? "replace" : "create", path: modelPath, expected_revision: modelRevision, content: byteArray(modelBytes) }],
    evidence.slice(0, 256));
  const adoption = yield* propose(host, changeset);
  return { ...output, adoption_proposal: { ...proposalReference(adoption), expected_revisions: changeset.read_set } };
}

const handlers: Record<string, Handler> = {
  "speaker.scenes.list": listScenes,
  "speaker.attribute": attribute,
  "speaker.review.queue": reviewQueue,
  "speaker.override": speakerOverride,
  "speaker.count.update": countUpdate,
  "speaker.dialogue.list": dialogueList,
  "speaker.voice.profiles": voiceProfiles,
  "speaker.voice.check": voiceCheck,
  "speaker.evaluation.latest": evaluationLatest,
  "speaker.ruleGates": ruleGates,
  "speaker.evaluation.run": evaluationRun,
  "speaker.retraining.run": retrainingRun,
};

const guest = createGuest(SPEAKER_PLUGIN_ID, handlers);
export { guest };
