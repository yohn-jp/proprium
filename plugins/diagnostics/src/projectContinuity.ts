import type { ProjectEntity, ProjectLink, ProjectScope } from "./projectConsistency.js";

export type ContinuityReason = "non-adjacent-location" | "item-owner-mismatch" | "unrecorded-teleport" | "timeline-reversal" | "timeline-gap" | "travel-impossible" | "travel-severe" | "travel-tight";
export interface ContinuityFinding {
  reason: ContinuityReason;
  sceneId: string;
  previousSceneId: string;
  characterEntityId: string;
  fromLocationId: string;
  toLocationId: string;
  itemId?: string;
  expectedOwnerId?: string | null;
  detail?: string;
  fromDayOffset?: number | null;
  toDayOffset?: number | null;
  requiredTravelDays?: number;
  availableTravelDays?: number;
  evidence: Array<{ path: string; revision: string }>;
}

interface SceneInfo { sceneId: string; order: number; locationId?: string; characterIds: string[]; chapterId?: string; entity: ProjectEntity }
interface TimeExpression { surface: string; start: number; end: number; deltaDays: number | null; kind: "relative-forward" | "relative-backward" | "time-of-day" }
interface TimelineEstimate { sceneId: string; order: number; expressions: TimeExpression[]; cumulativeDayOffset: number | null; deltaFromPrevious: number | null; relation: "forward" | "backward" | "same-day" | "unknown" }

const FIXED_TIME_WORDS: ReadonlyArray<readonly [string, number | null, TimeExpression["kind"]]> = [
  ["一週間後", 7, "relative-forward"], ["翌週", 7, "relative-forward"], ["数日後", 3, "relative-forward"],
  ["翌朝", 1, "relative-forward"], ["翌日", 1, "relative-forward"], ["前日", -1, "relative-backward"], ["昨日", -1, "relative-backward"], ["今朝", 0, "relative-forward"],
  ["夕暮れ", null, "time-of-day"], ["夜明け", null, "time-of-day"], ["真夜中", null, "time-of-day"], ["正午", null, "time-of-day"], ["夕方", null, "time-of-day"], ["夜", null, "time-of-day"], ["朝", null, "time-of-day"],
];
function numberJa(raw: string): number | null {
  if (/^\d+$/u.test(raw)) return Number(raw);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (raw === "十") return 10;
  if (raw === "百") return 100;
  let total = 0; let current = 0;
  for (const char of raw) {
    if (char === "十") { total += (current || 1) * 10; current = 0; }
    else if (char === "百") { total += (current || 1) * 100; current = 0; }
    else if (char in digits) current = digits[char];
    else return null;
  }
  return total + current;
}
function timeExpressions(text: string): TimeExpression[] {
  const found: TimeExpression[] = [];
  const add = (item: TimeExpression) => {
    if (found.some((old) => old.start === item.start && old.end === item.end)) return;
    if (found.some((old) => item.start >= old.start && item.end <= old.end && item.end - item.start < old.end - old.start)) return;
    for (let i = found.length - 1; i >= 0; i--) if (found[i].start >= item.start && found[i].end <= item.end && found[i].end - found[i].start < item.end - item.start) found.splice(i, 1);
    found.push(item);
  };
  for (const [surface, deltaDays, kind] of FIXED_TIME_WORDS) {
    let from = 0;
    while (from < text.length) { const start = text.indexOf(surface, from); if (start < 0) break; add({ surface, start, end: start + surface.length, deltaDays, kind }); from = start + surface.length; }
  }
  for (const [suffix, sign, kind] of [["日後", 1, "relative-forward"], ["日前", -1, "relative-backward"]] as const) {
    const pattern = new RegExp(`([一二三四五六七八九十百零〇\\d]+)${suffix}`, "gu");
    for (const match of text.matchAll(pattern)) {
      const value = numberJa(match[1]);
      if (value === null) continue;
      const start = match.index ?? 0;
      add({ surface: match[0], start, end: start + match[0].length, deltaDays: value * sign, kind });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}
function estimateTimeline(scenes: Array<{ sceneId: string; order: number; text: string }>): TimelineEstimate[] {
  const sorted = [...scenes].sort((a, b) => a.order - b.order);
  const result: TimelineEstimate[] = [];
  let cumulative: number | null = 0;
  let hasAnyRelative = false;
  for (let i = 0; i < sorted.length; i++) {
    const scene = sorted[i];
    const expressions = timeExpressions(scene.text);
    const relative = expressions.filter((expression) => expression.deltaDays !== null);
    let delta: number | null = null;
    if (relative.length) {
      const backward = relative.find((expression) => (expression.deltaDays ?? 0) < 0);
      const forward = relative.find((expression) => (expression.deltaDays ?? 0) > 0);
      const zero = relative.find((expression) => expression.deltaDays === 0);
      delta = backward?.deltaDays ?? forward?.deltaDays ?? zero?.deltaDays ?? null;
      hasAnyRelative = true;
    }
    const relation = delta === null ? "unknown" : delta < 0 ? "backward" : delta === 0 ? "same-day" : "forward";
    if (i === 0) {
      if (delta !== null) cumulative = delta;
      else { cumulative = hasAnyRelative ? cumulative : null; if (!expressions.length) cumulative = null; else cumulative = 0; }
    } else if (delta !== null && cumulative !== null) cumulative += delta;
    else if (delta !== null && cumulative === null) cumulative = delta;
    result.push({ sceneId: scene.sceneId, order: scene.order, expressions, cumulativeDayOffset: cumulative, deltaFromPrevious: i === 0 ? null : delta, relation: i === 0 && delta === null ? "unknown" : relation });
  }
  return result;
}

function orderScenes(entities: readonly ProjectEntity[]): ProjectEntity[] {
  const compare = (left: ProjectEntity, right: ProjectEntity) => Number(left.raw.order ?? 0) - Number(right.raw.order ?? 0) || left.filePath.localeCompare(right.filePath);
  const volumes = entities.filter((entity) => entity.type === "volume").sort(compare);
  const chapters = entities.filter((entity) => entity.type === "chapter");
  const scenes = entities.filter((entity) => entity.type === "scene");
  return volumes.flatMap((volume) => chapters.filter((chapter) => String(chapter.raw.volume ?? "") === volume.id).sort(compare)
    .flatMap((chapter) => scenes.filter((scene) => String(scene.raw.chapter ?? "") === chapter.id).sort(compare)));
}
function readTravel(entity: ProjectEntity): { adjacent: string[]; sameAs: string[]; daysTo: Record<string, number> } {
  const value = entity.raw.travel;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { adjacent: [], sameAs: [], daysTo: {} };
  const raw = value as Record<string, unknown>;
  const daysTo: Record<string, number> = {};
  if (raw.daysTo && typeof raw.daysTo === "object" && !Array.isArray(raw.daysTo)) for (const [id, days] of Object.entries(raw.daysTo as Record<string, unknown>)) if (typeof days === "number" && Number.isFinite(days) && days >= 0) daysTo[id] = days;
  return { adjacent: Array.isArray(raw.adjacent) ? raw.adjacent.filter((item): item is string => typeof item === "string") : [], sameAs: Array.isArray(raw.sameAs) ? raw.sameAs.filter((item): item is string => typeof item === "string") : [], daysTo };
}
function effects(raw: unknown): Array<Record<string, string>> {
  if (!Array.isArray(raw)) return [];
  const result: Array<Record<string, string>> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const action = row.action;
    if (action === "move_to" && typeof row.characterId === "string" && typeof row.toLocationId === "string") result.push({ action, characterId: row.characterId, toLocationId: row.toLocationId });
    else if (action === "transfer_item" && typeof row.itemId === "string" && typeof row.toCharacterId === "string") result.push({ action, itemId: row.itemId, toCharacterId: row.toCharacterId });
    else if (action === "acquire_item" && typeof row.characterId === "string" && typeof row.itemId === "string") result.push({ action, characterId: row.characterId, itemId: row.itemId });
    else if ((action === "drop_item" || action === "use_item") && typeof row.characterId === "string" && typeof row.itemId === "string") result.push({ action, characterId: row.characterId, itemId: row.itemId });
  }
  return result;
}

function scopeSceneIds(entities: readonly ProjectEntity[], ordered: readonly ProjectEntity[], scope?: ProjectScope): Set<string> | undefined {
  if (!scope || !Object.values(scope).some(Boolean)) return undefined;
  if (scope.sceneId) return new Set([scope.sceneId]);
  let chapterIds = new Set<string>();
  if (scope.chapterId) chapterIds.add(scope.chapterId);
  if (scope.volumeId) for (const entity of entities) if (entity.type === "chapter" && String(entity.raw.volume ?? "") === scope.volumeId) chapterIds.add(entity.id);
  if (chapterIds.size) return new Set(ordered.filter((scene) => chapterIds.has(String(scene.raw.chapter ?? ""))).map((scene) => scene.id));
  if (scope.workId) return new Set(ordered.map((scene) => scene.id));
  return new Set();
}

/** Source-derived deterministic continuity checks; unknown facts yield no warning. */
export function checkProjectContinuity(entities: readonly ProjectEntity[], links: readonly ProjectLink[], manuscriptText: ReadonlyMap<string, string>, scope?: ProjectScope): { recognized: boolean; findings: ContinuityFinding[] } {
  const ordered = orderScenes(entities);
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const sceneInfo: SceneInfo[] = ordered.map((scene, index) => {
    const appears = links.filter((link) => link.from === scene.id && link.kind === "appears").map((link) => entityById.get(link.to)).filter((item): item is ProjectEntity => !!item);
    const locationLink = links.find((link) => link.from === scene.id && (link.kind === "appears" || link.to.startsWith("loc-")) && entityById.get(link.to)?.type === "location");
    const location = (typeof scene.raw.location === "string" ? entityById.get(scene.raw.location) : undefined) ?? (locationLink ? entityById.get(locationLink.to) : undefined);
    const characters = appears.filter((entity) => entity.type === "character");
    return { sceneId: scene.id, order: index + 1, ...(location ? { locationId: location.id } : {}), characterIds: characters.map((entity) => entity.id), chapterId: typeof scene.raw.chapter === "string" ? scene.raw.chapter : undefined, entity: scene };
  });
  const sceneEntityById = new Map(sceneInfo.map((row) => [row.sceneId, row.entity]));
  const bodyByScene = new Map(ordered.map((scene) => [scene.id, manuscriptText.get(String(scene.raw.manuscript ?? "")) ?? ""]));
  const timeline = new Map(estimateTimeline(sceneInfo.map((row) => ({ sceneId: row.sceneId, order: row.order, text: bodyByScene.get(row.sceneId) ?? "" }))).map((row) => [row.sceneId, row]));
  const warnings: ContinuityFinding[] = [];
  const evidenceFor = (current: string, previous: string, extra: ProjectEntity[] = []) => {
    const sceneEntities = [sceneEntityById.get(previous), sceneEntityById.get(current)].filter((item): item is ProjectEntity => !!item);
    const rows = [...sceneEntities, ...extra];
    const seen = new Set<string>();
    return rows.filter((entity) => { const key = `${entity.filePath}\0${entity.revision}`; if (seen.has(key)) return false; seen.add(key); return true; }).map((entity) => ({ path: entity.filePath, revision: entity.revision }));
  };
  const locationEntities = new Map(entities.filter((entity) => entity.type === "location").map((entity) => [entity.id, entity]));
  const sortedInfo = [...sceneInfo].sort((a, b) => a.order - b.order);
  for (let i = 0; i < sortedInfo.length - 1; i++) {
    const left = sortedInfo[i]; const right = sortedInfo[i + 1];
    if (left.chapterId && right.chapterId && left.chapterId !== right.chapterId) continue;
    if (!left.locationId || !right.locationId) continue;
    const shared = right.characterIds.filter((id) => left.characterIds.includes(id));
    for (const characterId of shared) {
      const a = locationEntities.get(left.locationId); const b = locationEntities.get(right.locationId);
      const aTravel = a ? readTravel(a) : { adjacent: [], sameAs: [], daysTo: {} };
      const bTravel = b ? readTravel(b) : { adjacent: [], sameAs: [], daysTo: {} };
      const isReachable = left.locationId === right.locationId || !a || !b || aTravel.adjacent.includes(right.locationId) || aTravel.sameAs.includes(right.locationId) || bTravel.adjacent.includes(left.locationId) || bTravel.sameAs.includes(left.locationId);
      const previousTime = timeline.get(left.sceneId); const currentTime = timeline.get(right.sceneId);
      const fromDayOffset = previousTime?.cumulativeDayOffset ?? null; const toDayOffset = currentTime?.cumulativeDayOffset ?? null;
      if (!isReachable) warnings.push({ reason: "non-adjacent-location", sceneId: right.sceneId, previousSceneId: left.sceneId, characterEntityId: characterId, fromLocationId: left.locationId, toLocationId: right.locationId, fromDayOffset, toDayOffset, evidence: evidenceFor(right.sceneId, left.sceneId, [a, b].filter((item): item is ProjectEntity => !!item)) });
      const required = left.locationId === right.locationId ? 0 : aTravel.daysTo[right.locationId] ?? bTravel.daysTo[left.locationId];
      const available = currentTime?.deltaFromPrevious;
      if (isReachable && typeof required === "number" && required > 0 && typeof available === "number" && available >= 0) {
        const ratio = available / required;
        const reason: ContinuityReason | undefined = ratio < 1 ? "travel-impossible" : ratio < 1.25 ? "travel-severe" : ratio < 1.5 ? "travel-tight" : undefined;
        if (reason) warnings.push({ reason, sceneId: right.sceneId, previousSceneId: left.sceneId, characterEntityId: characterId, fromLocationId: left.locationId, toLocationId: right.locationId, detail: `移動所要 ${required} 日に対しシーン間は ${available} 日`, fromDayOffset, toDayOffset, requiredTravelDays: required, availableTravelDays: available, evidence: evidenceFor(right.sceneId, left.sceneId, [a, b].filter((item): item is ProjectEntity => !!item)) });
      }
    }
  }
  const orderedEffects = sceneInfo.map((row) => ({ ...row, effects: effects(row.entity.raw.effects) }));
  const itemOwners = new Map<string, { owner: string | null; since: string }>();
  const locations = new Map<string, { location: string; since: string }>();
  const snapshots = new Map<string, Map<string, { owner: string | null; since: string }>>();
  for (const row of orderedEffects) {
    for (const effect of row.effects) {
      if (effect.action === "move_to") locations.set(effect.characterId, { location: effect.toLocationId, since: row.sceneId });
      else if (effect.action === "transfer_item") itemOwners.set(effect.itemId, { owner: effect.toCharacterId, since: row.sceneId });
      else if (effect.action === "acquire_item") itemOwners.set(effect.itemId, { owner: effect.characterId, since: row.sceneId });
      else if (effect.action === "drop_item") itemOwners.set(effect.itemId, { owner: null, since: row.sceneId });
    }
    snapshots.set(row.sceneId, new Map(itemOwners));
  }
  for (let i = 0; i < orderedEffects.length; i++) for (const effect of orderedEffects[i].effects) if (effect.action === "use_item") {
    const owner = i > 0 ? snapshots.get(orderedEffects[i - 1].sceneId)?.get(effect.itemId) : undefined;
    if (!owner || owner.owner === null || owner.owner === effect.characterId) continue;
    warnings.push({ reason: "item-owner-mismatch", sceneId: orderedEffects[i].sceneId, previousSceneId: owner.since, characterEntityId: effect.characterId, fromLocationId: "", toLocationId: "", itemId: effect.itemId, expectedOwnerId: owner.owner, detail: `アイテム「${effect.itemId}」は「${owner.owner}」の所持中ですが「${effect.characterId}」が使用しています。`, evidence: evidenceFor(orderedEffects[i].sceneId, owner.since) });
  }
  const observed = new Map<string, { locationId: string; sceneId: string }>();
  for (const scene of sortedInfo) {
    if (!scene.locationId) continue;
    for (const characterId of scene.characterIds) {
      const previous = observed.get(characterId);
      const recorded = locations.get(characterId)?.location;
      if (previous && previous.locationId !== scene.locationId && recorded !== scene.locationId) warnings.push({ reason: "unrecorded-teleport", sceneId: scene.sceneId, previousSceneId: previous.sceneId, characterEntityId: characterId, fromLocationId: previous.locationId, toLocationId: scene.locationId, detail: `「${characterId}」の移動 effect が記録されていません。`, evidence: evidenceFor(scene.sceneId, previous.sceneId) });
      observed.set(characterId, { locationId: scene.locationId, sceneId: scene.sceneId });
    }
  }
  const timelineRows = [...timeline.values()].sort((a, b) => a.order - b.order);
  for (let i = 1; i < timelineRows.length; i++) {
    const previous = timelineRows[i - 1]; const current = timelineRows[i];
    if (current.relation === "backward" || (current.deltaFromPrevious !== null && current.deltaFromPrevious < 0)) warnings.push({ reason: "timeline-reversal", sceneId: current.sceneId, previousSceneId: previous.sceneId, characterEntityId: "", fromLocationId: "", toLocationId: "", detail: `過去方向の時間表現（Δ=${current.deltaFromPrevious}日）`, fromDayOffset: previous.cumulativeDayOffset, toDayOffset: current.cumulativeDayOffset, evidence: evidenceFor(current.sceneId, previous.sceneId) });
    if (current.deltaFromPrevious !== null && current.deltaFromPrevious > 30) warnings.push({ reason: "timeline-gap", sceneId: current.sceneId, previousSceneId: previous.sceneId, characterEntityId: "", fromLocationId: "", toLocationId: "", detail: `シーン間で ${current.deltaFromPrevious} 日経過（閾値 30）`, fromDayOffset: previous.cumulativeDayOffset, toDayOffset: current.cumulativeDayOffset, evidence: evidenceFor(current.sceneId, previous.sceneId) });
    if (previous.cumulativeDayOffset !== null && current.cumulativeDayOffset !== null && current.cumulativeDayOffset < previous.cumulativeDayOffset && current.relation !== "backward" && !(current.deltaFromPrevious !== null && current.deltaFromPrevious < 0)) warnings.push({ reason: "timeline-reversal", sceneId: current.sceneId, previousSceneId: previous.sceneId, characterEntityId: "", fromLocationId: "", toLocationId: "", detail: `累積日オフセットが ${previous.cumulativeDayOffset} から ${current.cumulativeDayOffset} に戻っています。`, fromDayOffset: previous.cumulativeDayOffset, toDayOffset: current.cumulativeDayOffset, evidence: evidenceFor(current.sceneId, previous.sceneId) });
  }
  const selected = scopeSceneIds(entities, ordered, scope);
  const filtered = selected ? warnings.filter((warning) => selected.has(warning.sceneId) || selected.has(warning.previousSceneId)) : warnings;
  filtered.sort((a, b) => a.sceneId.localeCompare(b.sceneId) || a.reason.localeCompare(b.reason) || a.previousSceneId.localeCompare(b.previousSceneId));
  return { recognized: entities.some((entity) => entity.type === "scene" || entity.type === "chapter" || entity.type === "volume"), findings: filtered };
}
