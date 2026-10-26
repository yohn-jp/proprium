import { buildMentionDictionary, findMentions, type MentionDictionary } from "./mentionIndex.js";
import { snapshotResult, type StoryEntity, type StoryGraphInput, type StoryLink, type StorySnapshotResult } from "./types.js";

export type ThreadLifecycleState = "unset" | "planted" | "recalled" | "resolved";

export interface ThreadSceneTextInput {
  sceneId: string;
  order: number;
  text: string;
  volumeId?: string;
}

export interface ThreadMention {
  sceneId: string;
  order: number;
  matchedKeywords: string[];
  via: "keyword" | "embedding";
}

export interface ThreadLifecycleSnapshot {
  threadId: string;
  state: ThreadLifecycleState;
  mentions: ThreadMention[];
  plantedSceneId?: string;
  recalledSceneIds: string[];
  resolvedSceneId?: string;
  scenesSinceLastMention: number;
}

export type ThreadLifecycleWarningCode =
  | "THREAD_STALE_UNMENTIONED"
  | "THREAD_RESOLUTION_UNSET_AT_FINAL_VOLUME";

export interface ThreadLifecycleWarning {
  threadId: string;
  code: ThreadLifecycleWarningCode;
  message: string;
  severity: "warning";
  filePath?: string;
}

export interface ThreadLifecycleOptions {
  staleSceneThreshold?: number;
  embedSimilarity?: {
    embed: (text: string) => Promise<Float32Array>;
    threshold?: number;
  };
}

const DEFAULT_STALE_THRESHOLD = 5;
const DEFAULT_EMBED_THRESHOLD = 0.72;
const MIN_KEYWORD_LENGTH = 2;

function cosineSimilarityDense(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    const x = a[index]!;
    const y = b[index]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function threadKeywordEntities(threads: readonly StoryEntity[]): StoryEntity[] {
  return threads
    .filter((thread) => thread.type === "thread" && (thread.keywords?.length ?? 0) > 0)
    .map((thread) => ({
      ...thread,
      name: undefined,
      aliases: (thread.keywords ?? []).filter((keyword) => keyword.length >= MIN_KEYWORD_LENGTH),
    }));
}

export function buildThreadKeywordDictionary(input: {
  snapshot: StoryGraphInput["snapshot"];
  threads: readonly StoryEntity[];
}): StorySnapshotResult<MentionDictionary> {
  return snapshotResult(
    input.snapshot,
    buildMentionDictionary(threadKeywordEntities(input.threads)),
  );
}

function sceneOrder(scenes: readonly ThreadSceneTextInput[]): ThreadSceneTextInput[] {
  return [...scenes].sort((a, b) => a.order - b.order);
}

function plantSceneIds(threadId: string, links: readonly StoryLink[]): Set<string> {
  const ids = new Set<string>();
  for (const link of links) {
    if (link.to === threadId && (link.kind === "plants" || link.kind === "planted")) {
      ids.add(link.from);
    }
    if (link.from === threadId && link.kind === "planted") ids.add(link.to);
  }
  return ids;
}

function payoffSceneIds(
  threadId: string,
  links: readonly StoryLink[],
  resolution?: string,
): Set<string> {
  const ids = new Set<string>();
  if (resolution) ids.add(resolution);
  for (const link of links) {
    if (link.from === threadId && link.kind === "payoff") ids.add(link.to);
    if (link.to === threadId && link.kind === "payoff") ids.add(link.from);
  }
  return ids;
}

export function findThreadMentionsByKeyword(
  input: StoryGraphInput & { scenes: readonly ThreadSceneTextInput[] },
): StorySnapshotResult<Map<string, ThreadMention[]>> {
  const threads = [...input.entities.values()].filter((entity) => entity.type === "thread");
  const dict = buildMentionDictionary(threadKeywordEntities(threads));
  const keywordByThread = new Map<string, string[]>();
  for (const thread of threads) {
    if (thread.keywords?.length) {
      keywordByThread.set(
        thread.id,
        thread.keywords.filter((keyword) => keyword.length >= MIN_KEYWORD_LENGTH),
      );
    }
  }
  const result = new Map<string, ThreadMention[]>();
  for (const threadId of keywordByThread.keys()) result.set(threadId, []);

  for (const scene of sceneOrder(input.scenes)) {
    if (!scene.text) continue;
    for (const threadId of findMentions(dict, scene.text)) {
      const keywords = keywordByThread.get(threadId) ?? [];
      const matched = keywords.filter((keyword) => scene.text.includes(keyword));
      const mentions = result.get(threadId) ?? [];
      mentions.push({
        sceneId: scene.sceneId,
        order: scene.order,
        matchedKeywords: matched.length > 0 ? matched : keywords.slice(0, 1),
        via: "keyword",
      });
      result.set(threadId, mentions);
    }
  }
  return snapshotResult(input.snapshot, result);
}

export function findThreadMentionsByEmbedding(input: {
  snapshot: StoryGraphInput["snapshot"];
  threads: readonly StoryEntity[];
  scenes: readonly ThreadSceneTextInput[];
  embed: (text: string) => Promise<Float32Array>;
  threshold?: number;
  existing?: ReadonlyMap<string, readonly ThreadMention[]>;
}): Promise<StorySnapshotResult<Map<string, ThreadMention[]>>> {
  return (async () => {
    const result = new Map<string, ThreadMention[]>();
    for (const [threadId, mentions] of input.existing ?? []) result.set(threadId, [...mentions]);
    const threshold = input.threshold ?? DEFAULT_EMBED_THRESHOLD;

    for (const thread of input.threads) {
      if (thread.type !== "thread") continue;
      const keywords = (thread.keywords ?? []).filter((keyword) => keyword.length >= MIN_KEYWORD_LENGTH);
      if (keywords.length === 0) continue;

      const queryVector = await input.embed(keywords.join(" "));
      const mentions = result.get(thread.id) ?? [];
      const known = new Set(mentions.map((mention) => mention.sceneId));
      const list = [...mentions];
      for (const scene of sceneOrder(input.scenes)) {
        if (!scene.text || known.has(scene.sceneId)) continue;
        const sceneVector = await input.embed(scene.text.slice(0, 2000));
        if (cosineSimilarityDense(queryVector, sceneVector) >= threshold) {
          list.push({
            sceneId: scene.sceneId,
            order: scene.order,
            matchedKeywords: keywords,
            via: "embedding",
          });
          known.add(scene.sceneId);
        }
      }
      list.sort((a, b) => a.order - b.order);
      result.set(thread.id, list);
    }
    return snapshotResult(input.snapshot, result);
  })();
}

export function buildThreadLifecycle(input: StoryGraphInput & {
  threads?: readonly StoryEntity[];
  scenes: readonly ThreadSceneTextInput[];
  mentionsByThread: ReadonlyMap<string, readonly ThreadMention[]>;
}): StorySnapshotResult<ThreadLifecycleSnapshot[]> {
  const sorted = sceneOrder(input.scenes);
  const orderIndex = new Map(sorted.map((scene, index) => [scene.sceneId, index]));
  const threads = input.threads ?? [...input.entities.values()];
  const snapshots: ThreadLifecycleSnapshot[] = [];

  for (const thread of threads) {
    if (thread.type !== "thread") continue;
    const mentions = [...(input.mentionsByThread.get(thread.id) ?? [])].sort((a, b) => a.order - b.order);
    const plants = plantSceneIds(thread.id, input.links);
    const payoffs = payoffSceneIds(thread.id, input.links, thread.resolution);
    const plantCandidates = sorted.filter((scene) => plants.has(scene.sceneId));
    const plantedSceneId = plantCandidates[0]?.sceneId ?? mentions[0]?.sceneId;
    const payoffCandidates = sorted.filter((scene) => payoffs.has(scene.sceneId));
    const resolvedSceneId = payoffCandidates[0]?.sceneId;
    const plantedIndex = plantedSceneId == null ? -1 : (orderIndex.get(plantedSceneId) ?? -1);
    const resolvedIndex = resolvedSceneId == null ? Infinity : (orderIndex.get(resolvedSceneId) ?? Infinity);
    const recalledSceneIds: string[] = [];

    for (const mention of mentions) {
      const index = orderIndex.get(mention.sceneId) ?? -1;
      if (mention.sceneId === plantedSceneId || mention.sceneId === resolvedSceneId) continue;
      if (index > plantedIndex && index < resolvedIndex && !recalledSceneIds.includes(mention.sceneId)) {
        recalledSceneIds.push(mention.sceneId);
      }
    }
    for (const link of input.links) {
      if (link.to !== thread.id || link.kind !== "advances") continue;
      const index = orderIndex.get(link.from) ?? -1;
      if (index > plantedIndex && index < resolvedIndex && !recalledSceneIds.includes(link.from)) {
        recalledSceneIds.push(link.from);
      }
    }

    let state: ThreadLifecycleState = "unset";
    if (resolvedSceneId) state = "resolved";
    else if (recalledSceneIds.length > 0) state = "recalled";
    else if (plantedSceneId) state = "planted";

    let scenesSinceLastMention = 0;
    if (state !== "resolved" && state !== "unset" && sorted.length > 0) {
      const lastMentionOrder = Math.max(
        plantedSceneId == null
          ? -Infinity
          : (sorted.find((scene) => scene.sceneId === plantedSceneId)?.order ?? -Infinity),
        ...mentions.map((mention) => mention.order),
        ...recalledSceneIds.map(
          (sceneId) => sorted.find((scene) => scene.sceneId === sceneId)?.order ?? -Infinity,
        ),
      );
      if (Number.isFinite(lastMentionOrder)) {
        scenesSinceLastMention = sorted.filter((scene) => scene.order > lastMentionOrder).length;
      }
    }

    snapshots.push({
      threadId: thread.id,
      state,
      mentions,
      plantedSceneId,
      recalledSceneIds,
      resolvedSceneId,
      scenesSinceLastMention,
    });
  }
  return snapshotResult(input.snapshot, snapshots);
}

export function findFinalVolumeId(
  input: StoryGraphInput,
): StorySnapshotResult<string | undefined> {
  const volumes = [...input.entities.values()].filter((entity) => entity.type === "volume");
  volumes.sort((a, b) => Number(a.raw.order ?? 0) - Number(b.raw.order ?? 0));
  return snapshotResult(input.snapshot, volumes.at(-1)?.id);
}

export function detectThreadLifecycleWarnings(input: StoryGraphInput & {
  snapshots: readonly ThreadLifecycleSnapshot[];
  threads?: readonly StoryEntity[];
  scenes: readonly ThreadSceneTextInput[];
  options?: ThreadLifecycleOptions;
}): StorySnapshotResult<ThreadLifecycleWarning[]> {
  const threshold = input.options?.staleSceneThreshold ?? DEFAULT_STALE_THRESHOLD;
  const threads = input.threads ?? [...input.entities.values()].filter((entity) => entity.type === "thread");
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const warnings: ThreadLifecycleWarning[] = [];
  const finalVolumeId = [...input.entities.values()]
    .filter((entity) => entity.type === "volume")
    .sort((a, b) => Number(a.raw.order ?? 0) - Number(b.raw.order ?? 0))
    .at(-1)?.id;
  const reachedFinalVolume =
    finalVolumeId != null && input.scenes.some((scene) => scene.volumeId === finalVolumeId);

  for (const snapshot of input.snapshots) {
    const thread = threadById.get(snapshot.threadId);
    if (!thread || thread.status === "abandoned") continue;
    if (snapshot.state !== "resolved" && snapshot.state !== "unset" && snapshot.scenesSinceLastMention >= threshold) {
      warnings.push({
        threadId: snapshot.threadId,
        code: "THREAD_STALE_UNMENTIONED",
        severity: "warning",
        message: `未回収伏線 ${snapshot.threadId} が ${snapshot.scenesSinceLastMention} シーン言及なし（閾値 ${threshold}）`,
        filePath: thread.filePath,
      });
    }
    if (reachedFinalVolume && !thread.resolution && snapshot.state !== "resolved") {
      warnings.push({
        threadId: snapshot.threadId,
        code: "THREAD_RESOLUTION_UNSET_AT_FINAL_VOLUME",
        severity: "warning",
        message: `最終巻に到達したが伏線 ${snapshot.threadId} の resolution が未設定`,
        filePath: thread.filePath,
      });
    }
  }
  return snapshotResult(input.snapshot, warnings);
}

export async function analyzeThreadLifecycles(input: StoryGraphInput & {
  scenes: readonly ThreadSceneTextInput[];
  options?: ThreadLifecycleOptions;
}): Promise<StorySnapshotResult<{ snapshots: ThreadLifecycleSnapshot[]; warnings: ThreadLifecycleWarning[] }>> {
  const threads = [...input.entities.values()].filter((entity) => entity.type === "thread");
  const keywordResult = findThreadMentionsByKeyword({ ...input, scenes: input.scenes });
  let mentions = keywordResult.data;
  if (input.options?.embedSimilarity) {
    mentions = (
      await findThreadMentionsByEmbedding({
        snapshot: input.snapshot,
        threads,
        scenes: input.scenes,
        embed: input.options.embedSimilarity.embed,
        threshold: input.options.embedSimilarity.threshold ?? DEFAULT_EMBED_THRESHOLD,
        existing: mentions,
      })
    ).data;
  }
  const snapshots = buildThreadLifecycle({ ...input, threads, mentionsByThread: mentions }).data;
  const warnings = detectThreadLifecycleWarnings({
    ...input,
    snapshots,
    threads,
    scenes: input.scenes,
    options: input.options,
  }).data;
  return snapshotResult(input.snapshot, { snapshots, warnings });
}
