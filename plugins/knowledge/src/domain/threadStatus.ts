import { buildSceneContext, getVolumeTree } from "./graph.js";
import {
  analyzeThreadLifecycles,
  type ThreadLifecycleSnapshot,
  type ThreadLifecycleWarning,
  type ThreadSceneTextInput,
} from "./threadLifecycle.js";
import {
  snapshotResult,
  type StoryGraphInput,
  type StorySnapshotResult,
} from "./types.js";

export type ThreadStatusLabel = "planted" | "advanced" | "resolved" | "unset";

export interface ThreadStatusEntry {
  threadId: string;
  status: ThreadStatusLabel;
  plantedSceneId?: string;
  advancedSceneIds: string[];
  resolvedSceneId?: string;
  mentions: ThreadLifecycleSnapshot["mentions"];
}

export function collectSceneTextInputs(
  input: StoryGraphInput,
): StorySnapshotResult<ThreadSceneTextInput[]> {
  const scenes: ThreadSceneTextInput[] = [];
  let order = 0;
  for (const { volume, chapters } of getVolumeTree(input).data) {
    for (const { scenes: chapterScenes } of chapters) {
      for (const scene of chapterScenes) {
        order++;
        const context = buildSceneContext({ ...input, sceneId: scene.id }).data;
        scenes.push({
          sceneId: scene.id,
          order,
          text: context?.manuscriptBody ?? "",
          volumeId: volume.id,
        });
      }
    }
  }
  return snapshotResult(input.snapshot, scenes);
}

function mapState(state: ThreadLifecycleSnapshot["state"]): ThreadStatusLabel {
  if (state === "recalled") return "advanced";
  return state;
}

function statusAtScene(
  snapshot: ThreadLifecycleSnapshot,
  sceneId: string,
  orderIndex: ReadonlyMap<string, number>,
): ThreadStatusLabel {
  const at = orderIndex.get(sceneId);
  if (at == null) return "unset";
  const plantedAt =
    snapshot.plantedSceneId == null ? undefined : orderIndex.get(snapshot.plantedSceneId);
  const resolvedAt =
    snapshot.resolvedSceneId == null ? undefined : orderIndex.get(snapshot.resolvedSceneId);
  const advancedAts = snapshot.recalledSceneIds
    .map((id) => orderIndex.get(id))
    .filter((order): order is number => order != null);
  if (resolvedAt != null && resolvedAt <= at) return "resolved";
  if (advancedAts.some((order) => order <= at) && plantedAt != null && plantedAt <= at) {
    return "advanced";
  }
  if (plantedAt != null && plantedAt <= at) return "planted";
  return "unset";
}

/** Source-compatible thread status projection at an optional scene boundary. */
export async function getThreadStatus(input: StoryGraphInput & {
  at?: string;
  threadId?: string;
}): Promise<StorySnapshotResult<{ threads: ThreadStatusEntry[] }>> {
  const scenes = collectSceneTextInputs(input).data;
  const orderIndex = new Map(scenes.map((scene) => [scene.sceneId, scene.order]));
  if (input.at && !orderIndex.has(input.at)) throw new Error(`Scene not found: ${input.at}`);
  if (input.threadId && input.entities.get(input.threadId)?.type !== "thread") {
    throw new Error(`Thread not found: ${input.threadId}`);
  }

  const lifecycle = await analyzeThreadLifecycles({ ...input, scenes });
  const filtered = input.threadId
    ? lifecycle.data.snapshots.filter((thread) => thread.threadId === input.threadId)
    : lifecycle.data.snapshots;
  const threads = filtered.map((snapshot): ThreadStatusEntry => ({
    threadId: snapshot.threadId,
    status: input.at ? statusAtScene(snapshot, input.at, orderIndex) : mapState(snapshot.state),
    plantedSceneId: snapshot.plantedSceneId,
    advancedSceneIds: snapshot.recalledSceneIds,
    resolvedSceneId: snapshot.resolvedSceneId,
    mentions: snapshot.mentions,
  }));
  const visible = input.at ? threads.filter((thread) => thread.status !== "unset") : threads;
  return snapshotResult(input.snapshot, { threads: visible });
}

export type { ThreadLifecycleWarning };
