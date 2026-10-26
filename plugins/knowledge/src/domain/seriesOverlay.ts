import { snapshotResult, type StoryEntity, type StoryLink, type StorySnapshotResult } from "./types.js";
import type { SnapshotId } from "./types.js";

/**
 * Read-only work ∪ series-bible overlay. A work entity with the same id wins;
 * relation identity is from/to/kind and duplicate relations are returned once.
 */
export function mergeSeriesOverlay(input: {
  snapshot: SnapshotId;
  workEntities: ReadonlyMap<string, StoryEntity>;
  workLinks: readonly StoryLink[];
  bibleEntities: ReadonlyMap<string, StoryEntity>;
  bibleLinks: readonly StoryLink[];
}): StorySnapshotResult<{ entities: Map<string, StoryEntity>; links: StoryLink[] }> {
  const entities = new Map(input.bibleEntities);
  for (const [id, entity] of input.workEntities) entities.set(id, entity);

  const seen = new Set<string>();
  const links: StoryLink[] = [];
  for (const link of [...input.bibleLinks, ...input.workLinks]) {
    const key = `${link.from}\0${link.to}\0${link.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }
  return snapshotResult(input.snapshot, { entities, links });
}
