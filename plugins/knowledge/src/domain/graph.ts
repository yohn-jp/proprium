import {
  snapshotResult,
  type SceneLocationInfo,
  type StoryEntity,
  type StoryEntityType,
  type StoryGraphInput,
  type StoryLink,
  type StorySnapshotResult,
} from "./types.js";

export interface StorySceneContext {
  scene: StoryEntity;
  pov?: StoryEntity;
  location?: StoryEntity;
  appears: StoryEntity[];
  mentions: StoryEntity[];
  items: StoryEntity[];
  threadsPlanted: StoryEntity[];
  threadsAdvanced: StoryEntity[];
  manuscript?: StoryEntity;
  manuscriptBody?: string;
}

export interface EntityAppearance {
  scene: StoryEntity;
  volumeId?: string;
  chapterId?: string;
  kinds: string[];
}

export interface ThreadSceneRef {
  scene: StoryEntity;
  note?: string;
}

export interface ThreadOverview {
  thread: StoryEntity;
  planted: ThreadSceneRef[];
  advanced: ThreadSceneRef[];
  payoff: ThreadSceneRef[];
}

export interface GraphNode {
  id: string;
  type: StoryEntityType;
  name: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type StoryVolumeTree = Array<{
  volume: StoryEntity;
  chapters: Array<{ chapter: StoryEntity; scenes: StoryEntity[] }>;
}>;

const GRAPH_TYPES: readonly StoryEntityType[] = [
  "character",
  "location",
  "item",
  "faction",
  "lore",
  "thread",
  "arc",
];

function getLinkedEntitiesData(
  entities: ReadonlyMap<string, StoryEntity>,
  links: readonly StoryLink[],
  fromId: string,
  kind?: string,
): StoryEntity[] {
  const filtered = links.filter((link) => link.from === fromId && (!kind || link.kind === kind));
  const result: StoryEntity[] = [];
  for (const link of filtered) {
    const entity = entities.get(link.to);
    if (entity) result.push(entity);
  }
  return result;
}

function buildSceneContextData(
  entities: ReadonlyMap<string, StoryEntity>,
  links: readonly StoryLink[],
  sceneId: string,
): StorySceneContext | null {
  const scene = entities.get(sceneId);
  if (scene?.type !== "scene") return null;

  const povLink = links.find((link) => link.from === sceneId && link.kind === "pov");
  const locationLink = links.find(
    (link) => link.from === sceneId && (link.kind === "appears" || link.to.startsWith("loc-")),
  );
  const appears = getLinkedEntitiesData(entities, links, sceneId, "appears");
  const mentions = getLinkedEntitiesData(entities, links, sceneId, "mentions");
  const items = appears.filter((entity) => entity.type === "item");
  const characters = appears.filter((entity) => entity.type === "character");
  const threadsPlanted = getLinkedEntitiesData(entities, links, sceneId, "plants");
  const threadsAdvanced = getLinkedEntitiesData(entities, links, sceneId, "advances");

  let manuscript: StoryEntity | undefined;
  let manuscriptBody: string | undefined;
  const manuscriptLink = links.find((link) => link.from === sceneId && link.kind === "manuscript");
  if (manuscriptLink) {
    manuscript = entities.get(manuscriptLink.to);
    manuscriptBody = manuscript?.body;
  } else if (typeof scene.raw.manuscript === "string") {
    const manuscriptPath = scene.raw.manuscript;
    for (const entity of entities.values()) {
      if (entity.filePath === manuscriptPath) {
        manuscript = entity;
        manuscriptBody = entity.body;
        break;
      }
    }
  }

  const pov = povLink ? entities.get(povLink.to) : undefined;
  const location =
    (typeof scene.raw.location === "string" ? entities.get(scene.raw.location) : undefined) ??
    (locationLink ? entities.get(locationLink.to) : undefined);

  return {
    scene,
    pov,
    location,
    appears: characters.length > 0 ? characters : appears,
    mentions,
    items,
    threadsPlanted,
    threadsAdvanced,
    manuscript,
    manuscriptBody,
  };
}

function listByTypeData(entities: ReadonlyMap<string, StoryEntity>, type: string): StoryEntity[] {
  return [...entities.values()]
    .filter((entity) => entity.type === type)
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, "ja"));
}

function deduplicateSceneRefs(refs: ThreadSceneRef[]): ThreadSceneRef[] {
  const byId = new Map<string, ThreadSceneRef>();
  for (const ref of refs) {
    if (!byId.has(ref.scene.id)) byId.set(ref.scene.id, ref);
  }
  return [...byId.values()];
}

function getVolumeTreeData(entities: ReadonlyMap<string, StoryEntity>): StoryVolumeTree {
  const volumes = listByTypeData(entities, "volume").sort(
    (a, b) => Number(a.raw.order ?? 0) - Number(b.raw.order ?? 0),
  );
  const chapters = listByTypeData(entities, "chapter");
  const scenes = listByTypeData(entities, "scene");

  return volumes.map((volume) => {
    const volumeId = volume.id;
    const volumeChapters = chapters
      .filter((chapter) => chapter.raw.volume === volumeId || String(chapter.raw.volume) === volumeId)
      .sort((a, b) => Number(a.raw.order ?? 0) - Number(b.raw.order ?? 0));

    return {
      volume,
      chapters: volumeChapters.map((chapter) => ({
        chapter,
        scenes: scenes
          .filter(
            (scene) => scene.raw.chapter === chapter.id || scene.raw.chapter === chapter.raw.id,
          )
          .sort((a, b) => Number(a.raw.order ?? 0) - Number(b.raw.order ?? 0)),
      })),
    };
  });
}

export function getLinkedEntities(
  input: StoryGraphInput & { fromId: string; kind?: string },
): StorySnapshotResult<StoryEntity[]> {
  return snapshotResult(
    input.snapshot,
    getLinkedEntitiesData(input.entities, input.links, input.fromId, input.kind),
  );
}

export function getBacklinks(
  input: StoryGraphInput & { toId: string },
): StorySnapshotResult<Array<{ link: StoryLink; entity: StoryEntity }>> {
  const result: Array<{ link: StoryLink; entity: StoryEntity }> = [];
  for (const link of input.links) {
    if (link.to !== input.toId) continue;
    const entity = input.entities.get(link.from);
    if (entity) result.push({ link, entity });
  }
  return snapshotResult(input.snapshot, result);
}

export function buildSceneContext(
  input: StoryGraphInput & { sceneId: string },
): StorySnapshotResult<StorySceneContext | null> {
  return snapshotResult(
    input.snapshot,
    buildSceneContextData(input.entities, input.links, input.sceneId),
  );
}

export function listByType(
  input: StoryGraphInput & { type: string },
): StorySnapshotResult<StoryEntity[]> {
  return snapshotResult(input.snapshot, listByTypeData(input.entities, input.type));
}

/** Scenes linked by appears/mentions/pov; repeated relation kinds are grouped per scene. */
export function getEntityAppearances(
  input: StoryGraphInput & { entityId: string },
): StorySnapshotResult<EntityAppearance[]> {
  const relevantKinds = new Set(["appears", "mentions", "pov"]);
  const byScene = new Map<string, EntityAppearance>();
  for (const link of input.links) {
    if (link.to !== input.entityId || !relevantKinds.has(link.kind)) continue;
    const scene = input.entities.get(link.from);
    if (scene?.type !== "scene") continue;

    const existing = byScene.get(scene.id);
    if (existing) {
      if (!existing.kinds.includes(link.kind)) existing.kinds.push(link.kind);
      continue;
    }
    byScene.set(scene.id, {
      scene,
      volumeId: typeof scene.raw.volume === "string" ? scene.raw.volume : undefined,
      chapterId: typeof scene.raw.chapter === "string" ? scene.raw.chapter : undefined,
      kinds: [link.kind],
    });
  }

  const data = [...byScene.values()].sort(
    (a, b) => Number(a.scene.raw.order ?? 0) - Number(b.scene.raw.order ?? 0),
  );
  return snapshotResult(input.snapshot, data);
}

export function getThreadsOverview(
  input: StoryGraphInput,
): StorySnapshotResult<ThreadOverview[]> {
  const threads = listByTypeData(input.entities, "thread");
  const data = threads.map((thread): ThreadOverview => {
    const plantedFromThread = input.links.filter(
      (link) => link.from === thread.id && link.kind === "planted",
    );
    const payoffFromThread = input.links.filter(
      (link) => link.from === thread.id && link.kind === "payoff",
    );
    const plantedFromScene = input.links.filter(
      (link) => link.to === thread.id && link.kind === "plants",
    );
    const advancedFromScene = input.links.filter(
      (link) => link.to === thread.id && link.kind === "advances",
    );
    const toRefs = (links: readonly StoryLink[], sceneId: (link: StoryLink) => string) =>
      links
        .map((link): ThreadSceneRef | null => {
          const scene = input.entities.get(sceneId(link));
          return scene ? { scene, note: link.note } : null;
        })
        .filter((ref): ref is ThreadSceneRef => ref !== null);

    return {
      thread,
      planted: deduplicateSceneRefs([
        ...toRefs(plantedFromThread, (link) => link.to),
        ...toRefs(plantedFromScene, (link) => link.from),
      ]),
      advanced: deduplicateSceneRefs(toRefs(advancedFromScene, (link) => link.from)),
      payoff: deduplicateSceneRefs(toRefs(payoffFromThread, (link) => link.to)),
    };
  });
  return snapshotResult(input.snapshot, data);
}

export function getGraphData(
  input: StoryGraphInput & { types?: readonly StoryEntityType[] },
): StorySnapshotResult<GraphData> {
  const typeSet = new Set<string>(input.types ?? GRAPH_TYPES);
  const nodes = [...input.entities.values()]
    .filter((entity) => typeSet.has(entity.type))
    .map((entity) => ({ id: entity.id, type: entity.type, name: entity.name ?? entity.id }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = input.links
    .filter((link) => nodeIds.has(link.from) && nodeIds.has(link.to))
    .map((link) => ({ from: link.from, to: link.to, kind: link.kind }));
  return snapshotResult(input.snapshot, { nodes, edges });
}

export function getVolumeTree(input: StoryGraphInput): StorySnapshotResult<StoryVolumeTree> {
  return snapshotResult(input.snapshot, getVolumeTreeData(input.entities));
}

export function buildSceneLocationInfos(
  input: StoryGraphInput,
): StorySnapshotResult<SceneLocationInfo[]> {
  const infos: SceneLocationInfo[] = [];
  let globalOrder = 0;
  for (const { chapters } of getVolumeTreeData(input.entities)) {
    for (const { chapter, scenes } of chapters) {
      for (const scene of scenes) {
        globalOrder += 1;
        const context = buildSceneContextData(input.entities, input.links, scene.id);
        const characterIds =
          context?.appears.filter((entity) => entity.type === "character").map((entity) => entity.id) ??
          [];
        infos.push({
          sceneId: scene.id,
          order: globalOrder,
          locationId: context?.location?.id,
          characterIds,
          chapterId: typeof chapter.id === "string" ? chapter.id : undefined,
        });
      }
    }
  }
  return snapshotResult(input.snapshot, infos);
}
