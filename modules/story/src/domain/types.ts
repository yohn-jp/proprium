import type { SnapshotId } from "@scriptorium/contracts";

export type StoryEntityType =
  | "character"
  | "location"
  | "item"
  | "faction"
  | "event"
  | "thread"
  | "scene"
  | "chapter"
  | "volume"
  | "arc"
  | "lore"
  | "manuscript"
  | "dialogue_sketch";

/** Source-derived narrative entity data used by Story's pure domain queries. */
export interface StoryEntity {
  id: string;
  type: StoryEntityType;
  name?: string;
  aliases?: string[];
  status?: string;
  tags?: string[];
  keywords?: string[];
  resolution?: string;
  filePath: string;
  raw: Record<string, unknown>;
  body?: string;
}

/** Relation kinds remain strings because source YAML supports domain extensions. */
export interface StoryLink {
  from: string;
  to: string;
  kind: string;
  note?: string;
}

export interface StoryGraphInput {
  snapshot: SnapshotId;
  entities: ReadonlyMap<string, StoryEntity>;
  links: readonly StoryLink[];
}

/** Every read model returns the exact snapshot identity selected by its caller. */
export interface StorySnapshotResult<T> {
  snapshot: SnapshotId;
  data: T;
}

export interface SceneLocationInfo {
  sceneId: string;
  order: number;
  locationId?: string;
  characterIds: string[];
  chapterId?: string;
}

export function snapshotResult<T>(snapshot: SnapshotId, data: T): StorySnapshotResult<T> {
  return { snapshot, data };
}
