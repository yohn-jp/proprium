import type { SnapshotReader } from "@scriptorium/contracts";
import { readCanonicalSnapshotEntities } from "@scriptorium/module-nlp";

// Source-derived from Arcadia Loom's core-shared validate.ts, graph.ts,
// continuityCheck.ts, timeline/timeExpressions.ts, and tracker/ implementations
// at edc033c. Project documents still come exclusively from this pinned reader.

type Entity = {
  id: string;
  type: string;
  name?: string;
  status?: string;
  filePath: string;
  raw: Record<string, unknown>;
  body?: string;
};
type Link = { from: string; to: string; kind: string; note?: string };
export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  entityId?: string;
  filePath?: string;
}
export interface ContinuityWarning {
  sceneId: string;
  previousSceneId: string;
  characterEntityId: string;
  fromLocationId: string;
  toLocationId: string;
  reason: "non-adjacent-location" | "item-owner-mismatch" | "unrecorded-teleport" | "timeline-reversal" | "timeline-gap" | "travel-impossible" | "travel-severe" | "travel-tight";
  itemId?: string;
  expectedOwnerId?: string | null;
  detail?: string;
  fromDayOffset?: number | null;
  toDayOffset?: number | null;
  requiredTravelDays?: number;
  availableTravelDays?: number;
}

const LINK_FIELDS: Record<string, string> = {
  appears: "appears", mentions: "mentions", plants: "plants", advances: "advances", related: "related",
  pov: "pov", affiliated: "affiliated", target: "target", first_appears: "first_appears", planted: "planted", payoff: "payoff",
};

function extractLinks(entityId: string, data: Record<string, unknown>, links: Link[]): void {
  for (const [field, kind] of Object.entries(LINK_FIELDS)) {
    const value = data[field];
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") links.push({ from: entityId, to: item, kind });
        else if (item && typeof item === "object") {
          const object = item as Record<string, unknown>;
          const target = (object.target ?? object.scene ?? object.id) as string | undefined;
          if (target) links.push({ from: entityId, to: target, kind, ...(typeof object.note === "string" ? { note: object.note } : {}) });
        }
      }
    } else if (typeof value === "string") links.push({ from: entityId, to: value, kind });
  }
  if (Array.isArray(data.relations)) for (const relation of data.relations) {
    if (relation && typeof relation === "object" && typeof (relation as Record<string, unknown>).target === "string") {
      const value = relation as Record<string, unknown>;
      links.push({ from: entityId, to: value.target as string, kind: (value.kind as string) ?? "related", ...(typeof value.note === "string" ? { note: value.note } : {}) });
    }
  }
  if (data.entities && typeof data.entities === "object") {
    const nested = data.entities as Record<string, unknown>;
    for (const [field, kind] of Object.entries(LINK_FIELDS)) if (Array.isArray(nested[field])) {
      for (const target of nested[field] as unknown[]) if (typeof target === "string") links.push({ from: entityId, to: target, kind });
    }
  }
  if (data.threads && typeof data.threads === "object") {
    const nested = data.threads as Record<string, unknown>;
    for (const [field, kind] of [["plants", "plants"], ["advances", "advances"]] as const) if (Array.isArray(nested[field])) {
      for (const target of nested[field] as unknown[]) if (typeof target === "string") links.push({ from: entityId, to: target, kind });
    }
  }
}

async function readProject(reader: SnapshotReader, signal: AbortSignal): Promise<{ entities: Map<string, Entity>; links: Link[]; duplicateIds: Array<{ id: string; filePaths: string[] }> }> {
  // The source loader processes every YAML entity before manuscripts; retain
  // that insertion/overwrite order when path-derived IDs collide.
  const sourceEntities = (await readCanonicalSnapshotEntities(reader, signal))
    .filter((entity) => /\.yaml$/i.test(entity.filePath) || /\.md$/i.test(entity.filePath))
    .sort((a, b) => Number(/\.md$/i.test(a.filePath)) - Number(/\.md$/i.test(b.filePath)));
  const entities = new Map<string, Entity>();
  const links: Link[] = [];
  const filePathsById = new Map<string, string[]>();
  for (const source of sourceEntities) {
    if (signal.aborted) throw Object.assign(new Error("Project diagnostics were cancelled"), { code: "job_cancelled" });
    const entity: Entity = {
      id: source.id,
      type: source.type,
      ...(source.name ? { name: source.name } : {}),
      ...(typeof source.raw.status === "string" ? { status: source.raw.status } : {}),
      filePath: source.filePath,
      raw: source.raw,
      ...(source.body !== undefined ? { body: source.body } : {}),
    };
    entities.set(entity.id, entity);
    const paths = filePathsById.get(entity.id) ?? [];
    paths.push(entity.filePath);
    filePathsById.set(entity.id, paths);
    if (/\.yaml$/i.test(entity.filePath)) extractLinks(entity.id, entity.raw, links);
  }
  const duplicateIds = [...filePathsById.entries()].filter(([, paths]) => paths.length > 1).map(([id, filePaths]) => ({ id, filePaths }));
  for (const entity of entities.values()) {
    if (entity.type !== "scene" || typeof entity.raw.manuscript !== "string") continue;
    for (const manuscript of entities.values()) if (manuscript.filePath === entity.raw.manuscript) {
      links.push({ from: entity.id, to: manuscript.id, kind: "manuscript" });
      break;
    }
  }
  return { entities, links, duplicateIds };
}

function validateProject(entities: Map<string, Entity>, links: Link[], duplicateIds: Array<{ id: string; filePaths: string[] }>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set(entities.keys());
  for (const duplicate of duplicateIds) issues.push({ severity: "error", code: "DUPLICATE_ID", message: `Duplicate id "${duplicate.id}" used by multiple files: ${duplicate.filePaths.join(", ")}`, entityId: duplicate.id });
  for (const entity of entities.values()) {
    if (!entity.id) issues.push({ severity: "error", code: "MISSING_ID", message: "Entity is missing id", filePath: entity.filePath });
    if (entity.type === "scene" && typeof entity.raw.manuscript === "string") {
      const manuscriptPath = entity.raw.manuscript;
      if (![...entities.values()].some((candidate) => candidate.filePath === manuscriptPath || candidate.filePath.endsWith(manuscriptPath))) {
        issues.push({ severity: "warning", code: "MISSING_MANUSCRIPT", message: `Manuscript file not found: ${manuscriptPath}`, entityId: entity.id, filePath: entity.filePath });
      }
    }
  }
  for (const link of links) {
    if (!ids.has(link.from)) issues.push({ severity: "error", code: "MISSING_LINK_SOURCE", message: `Link source not found: ${link.from}`, entityId: link.from });
    if (!ids.has(link.to)) issues.push({ severity: "error", code: "MISSING_LINK_TARGET", message: `Link target not found: ${link.to} (${link.kind})`, entityId: link.from });
  }
  for (const thread of [...entities.values()].filter((entity) => entity.type === "thread")) {
    const hasPlant = links.some((link) => link.to === thread.id && (link.kind === "plants" || link.kind === "planted"));
    const hasPayoff = links.some((link) => link.to === thread.id && link.kind === "payoff");
    if (thread.status === "open" && !hasPlant) issues.push({ severity: "warning", code: "THREAD_NO_PLANT", message: `Open thread has no plant point: ${thread.id}`, entityId: thread.id, filePath: thread.filePath });
    if (hasPlant && !hasPayoff && thread.status !== "abandoned") issues.push({ severity: "warning", code: "THREAD_NO_PAYOFF", message: `Thread has plant but no payoff: ${thread.id}`, entityId: thread.id, filePath: thread.filePath });
  }
  return issues;
}

function linked(entities: Map<string, Entity>, links: Link[], sceneId: string, kind: string): Entity[] {
  return links.filter((link) => link.from === sceneId && link.kind === kind).flatMap((link) => {
    const entity = entities.get(link.to);
    return entity ? [entity] : [];
  });
}

interface SceneInfo { sceneId: string; order: number; locationId?: string; characterIds: string[]; chapterId?: string }
function compareJa(a: Entity, b: Entity): number { return (a.name ?? a.id).localeCompare(b.name ?? b.id, "ja"); }
function buildSceneLocationInfos(entities: Map<string, Entity>, links: Link[]): SceneInfo[] {
  const volumes = [...entities.values()].filter((entity) => entity.type === "volume").sort(compareJa).sort((a, b) => Number(a.raw.order ?? 0) - Number(b.raw.order ?? 0));
  const chapters = [...entities.values()].filter((entity) => entity.type === "chapter").sort(compareJa);
  const scenes = [...entities.values()].filter((entity) => entity.type === "scene").sort(compareJa);
  const infos: SceneInfo[] = [];
  let order = 0;
  for (const volume of volumes) {
    const volumeChapters = chapters.filter((chapter) => chapter.raw.volume === volume.id || String(chapter.raw.volume) === volume.id).sort((a, b) => Number(a.raw.order ?? 0) - Number(b.raw.order ?? 0));
    for (const chapter of volumeChapters) {
      const chapterScenes = scenes.filter((scene) => scene.raw.chapter === chapter.id || scene.raw.chapter === chapter.raw.id).sort((a, b) => Number(a.raw.order ?? 0) - Number(b.raw.order ?? 0));
      for (const scene of chapterScenes) {
        order += 1;
        const locationLink = links.find((link) => link.from === scene.id && (link.kind === "appears" || link.to.startsWith("loc-")));
        const appears = linked(entities, links, scene.id, "appears");
        const characters = appears.filter((entity) => entity.type === "character");
        const location = (typeof scene.raw.location === "string" ? entities.get(scene.raw.location) : undefined)
          ?? (locationLink ? entities.get(locationLink.to) : undefined);
        infos.push({
          sceneId: scene.id, order,
          ...(location ? { locationId: location.id } : {}),
          characterIds: (characters.length ? characters : appears).filter((entity) => entity.type === "character").map((entity) => entity.id),
          chapterId: typeof chapter.id === "string" ? chapter.id : typeof chapter.raw.id === "string" ? chapter.raw.id : undefined,
        });
      }
    }
  }
  return infos;
}

type TimeExpression = { surface: string; start: number; end: number; deltaDays: number | null; kind: "relative-forward" | "relative-backward" | "time-of-day" | "unknown" };
type TimelineEstimate = { sceneId: string; order: number; expressions: TimeExpression[]; cumulativeDayOffset: number | null; deltaFromPrevious: number | null; relation: "forward" | "backward" | "same-day" | "unknown" };
const FIXED_TIME_WORDS: ReadonlyArray<readonly [string, number | null, TimeExpression["kind"]]> = [
  ["一週間後", 7, "relative-forward"], ["翌週", 7, "relative-forward"], ["数日後", 3, "relative-forward"],
  ["翌朝", 1, "relative-forward"], ["翌日", 1, "relative-forward"], ["前日", -1, "relative-backward"], ["昨日", -1, "relative-backward"], ["今朝", 0, "relative-forward"],
  ["夕暮れ", null, "time-of-day"], ["夜明け", null, "time-of-day"], ["真夜中", null, "time-of-day"], ["正午", null, "time-of-day"], ["夕方", null, "time-of-day"], ["夜", null, "time-of-day"], ["朝", null, "time-of-day"],
];
function parseJapaneseNumber(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
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
function extractTimeExpressions(text: string): TimeExpression[] {
  const out: TimeExpression[] = [];
  const add = (expr: TimeExpression) => {
    if (out.some((item) => item.start === expr.start && item.end === expr.end)) return;
    if (out.some((item) => expr.start >= item.start && expr.end <= item.end && expr.end - expr.start < item.end - item.start)) return;
    for (let i = out.length - 1; i >= 0; i--) if (out[i].start >= expr.start && out[i].end <= expr.end && out[i].end - out[i].start < expr.end - expr.start) out.splice(i, 1);
    out.push(expr);
  };
  for (const [surface, deltaDays, kind] of FIXED_TIME_WORDS) {
    let from = 0;
    while (from < text.length) {
      const start = text.indexOf(surface, from);
      if (start < 0) break;
      add({ surface, start, end: start + surface.length, deltaDays, kind });
      from = start + surface.length;
    }
  }
  for (const [suffix, sign, kind] of [["日後", 1, "relative-forward"], ["日前", -1, "relative-backward"]] as const) {
    const pattern = new RegExp(`([一二三四五六七八九十百零〇\\d]+)${suffix}`, "g");
    for (const match of text.matchAll(pattern)) {
      const value = parseJapaneseNumber(match[1]);
      if (value == null) continue;
      const start = match.index ?? 0;
      add({ surface: match[0], start, end: start + match[0].length, deltaDays: value * sign, kind });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
function estimateSceneTimeline(scenes: Array<{ sceneId: string; order: number; text: string }>): TimelineEstimate[] {
  const sorted = [...scenes].sort((a, b) => a.order - b.order);
  const estimates: TimelineEstimate[] = [];
  let cumulative: number | null = 0;
  let hasAnyRelative = false;
  for (let i = 0; i < sorted.length; i++) {
    const scene = sorted[i];
    const expressions = extractTimeExpressions(scene.text);
    const relative = expressions.filter((expression) => expression.deltaDays != null);
    let delta: number | null = null;
    if (relative.length) {
      const backward = relative.find((expression) => (expression.deltaDays ?? 0) < 0);
      const forward = relative.find((expression) => (expression.deltaDays ?? 0) > 0);
      const zero = relative.find((expression) => expression.deltaDays === 0);
      delta = backward?.deltaDays ?? forward?.deltaDays ?? zero?.deltaDays ?? null;
      hasAnyRelative = true;
    }
    const relation = delta == null ? "unknown" : delta < 0 ? "backward" : delta === 0 ? "same-day" : "forward";
    if (i === 0) {
      if (delta != null) cumulative = delta;
      else { cumulative = hasAnyRelative ? cumulative : null; if (expressions.length === 0) cumulative = null; else cumulative = 0; }
    } else if (delta != null && cumulative != null) cumulative += delta;
    else if (delta != null && cumulative == null) cumulative = delta;
    estimates.push({ sceneId: scene.sceneId, order: scene.order, expressions, cumulativeDayOffset: cumulative, deltaFromPrevious: i === 0 ? null : delta, relation: i === 0 && delta == null ? "unknown" : relation });
  }
  return estimates;
}

function readTravel(entity: Entity): { adjacent: string[]; sameAs: string[]; daysTo: Record<string, number> } {
  const raw = entity.raw.travel;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { adjacent: [], sameAs: [], daysTo: {} };
  const value = raw as Record<string, unknown>;
  const daysTo: Record<string, number> = {};
  if (value.daysTo && typeof value.daysTo === "object" && !Array.isArray(value.daysTo)) for (const [id, days] of Object.entries(value.daysTo as Record<string, unknown>)) if (typeof days === "number" && Number.isFinite(days) && days >= 0) daysTo[id] = days;
  return { adjacent: Array.isArray(value.adjacent) ? value.adjacent.filter((item): item is string => typeof item === "string") : [], sameAs: Array.isArray(value.sameAs) ? value.sameAs.filter((item): item is string => typeof item === "string") : [], daysTo };
}
function travelDays(locations: Map<string, Entity>, from: string, to: string): number | null {
  if (from === to) return 0;
  const direct = locations.get(from); const reverse = locations.get(to);
  const forwardDays = direct ? readTravel(direct).daysTo[to] : undefined;
  if (typeof forwardDays === "number") return forwardDays;
  const reverseDays = reverse ? readTravel(reverse).daysTo[from] : undefined;
  return typeof reverseDays === "number" ? reverseDays : null;
}
function reachable(locations: Map<string, Entity>, from: string, to: string): boolean {
  if (from === to) return true;
  const a = locations.get(from); const b = locations.get(to);
  if (!a || !b) return true;
  const at = readTravel(a); const bt = readTravel(b);
  return at.adjacent.includes(to) || at.sameAs.includes(to) || bt.adjacent.includes(from) || bt.sameAs.includes(from);
}
function sceneEffects(raw: unknown): Array<Record<string, string>> {
  if (!Array.isArray(raw)) return [];
  const effects: Array<Record<string, string>> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || typeof (entry as Record<string, unknown>).action !== "string") continue;
    const effect = entry as Record<string, unknown>;
    switch (effect.action) {
      case "move_to": if (typeof effect.characterId === "string" && typeof effect.toLocationId === "string") effects.push({ action: "move_to", characterId: effect.characterId, toLocationId: effect.toLocationId }); break;
      case "transfer_item": if (typeof effect.itemId === "string" && typeof effect.toCharacterId === "string") effects.push({ action: "transfer_item", itemId: effect.itemId, toCharacterId: effect.toCharacterId }); break;
      case "acquire_item": if (typeof effect.characterId === "string" && typeof effect.itemId === "string") effects.push({ action: "acquire_item", characterId: effect.characterId, itemId: effect.itemId }); break;
      case "drop_item": case "use_item": if (typeof effect.characterId === "string" && typeof effect.itemId === "string") effects.push({ action: effect.action, characterId: effect.characterId, itemId: effect.itemId }); break;
      default: break;
    }
  }
  return effects;
}

function detectContinuityWarnings(entities: Map<string, Entity>, sceneInfos: SceneInfo[], timelineScenes: Array<{ sceneId: string; order: number; text: string }>): ContinuityWarning[] {
  const warnings: ContinuityWarning[] = [];
  const sorted = [...sceneInfos].sort((a, b) => a.order - b.order);
  const timeline = new Map(estimateSceneTimeline(timelineScenes).map((estimate) => [estimate.sceneId, estimate]));
  const locationEntities = new Map([...entities].filter(([, entity]) => entity.type === "location"));
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]; const b = sorted[i + 1];
    if (a.chapterId && b.chapterId && a.chapterId !== b.chapterId) continue;
    if (!a.locationId || !b.locationId) continue;
    const aChars = new Set(a.characterIds);
    const shared = b.characterIds.filter((id) => aChars.has(id));
    if (!shared.length) continue;
    const estimateA = timeline.get(a.sceneId); const estimateB = timeline.get(b.sceneId);
    const fromDayOffset = estimateA?.cumulativeDayOffset ?? null; const toDayOffset = estimateB?.cumulativeDayOffset ?? null;
    const availableDays = estimateB?.deltaFromPrevious ?? null;
    for (const characterId of shared) {
      if (!reachable(locationEntities, a.locationId, b.locationId)) {
        warnings.push({ sceneId: b.sceneId, previousSceneId: a.sceneId, characterEntityId: characterId, fromLocationId: a.locationId, toLocationId: b.locationId, reason: "non-adjacent-location", fromDayOffset, toDayOffset });
        continue;
      }
      const requiredDays = travelDays(locationEntities, a.locationId, b.locationId);
      if (requiredDays == null || availableDays == null || !(requiredDays > 0) || availableDays < 0) continue;
      const ratio = availableDays / requiredDays;
      const reason = ratio < 1 ? "travel-impossible" : ratio < 1.25 ? "travel-severe" : ratio < 1.5 ? "travel-tight" : null;
      if (reason) warnings.push({ sceneId: b.sceneId, previousSceneId: a.sceneId, characterEntityId: characterId, fromLocationId: a.locationId, toLocationId: b.locationId, reason, detail: `${reason === "travel-impossible" ? "移動が間に合わない（物理的に不可能）" : reason === "travel-severe" ? "移動がかなり厳しい" : "移動にやや余裕がない"}: 移動所要 ${requiredDays} 日に対しシーン間は ${availableDays} 日`, fromDayOffset, toDayOffset, requiredTravelDays: requiredDays, availableTravelDays: availableDays });
    }
  }

  // Source state tracking: effects are applied in plot order; use_item checks the preceding state.
  const effectsEntries = sceneInfos.map((scene) => ({ ...scene, effects: sceneEffects(entities.get(scene.sceneId)?.raw.effects) })).sort((a, b) => a.order - b.order);
  const itemOwners = new Map<string, { owner: string | null; since: string }>();
  const locations = new Map<string, { location: string; since: string }>();
  const snapshots = new Map<string, { owners: Map<string, { owner: string | null; since: string }>; locations: Map<string, { location: string; since: string }> }>();
  for (const entry of effectsEntries) {
    for (const effect of entry.effects) {
      if (effect.action === "move_to") locations.set(effect.characterId, { location: effect.toLocationId, since: entry.sceneId });
      else if (effect.action === "transfer_item") itemOwners.set(effect.itemId, { owner: effect.toCharacterId, since: entry.sceneId });
      else if (effect.action === "acquire_item") itemOwners.set(effect.itemId, { owner: effect.characterId, since: entry.sceneId });
      else if (effect.action === "drop_item") itemOwners.set(effect.itemId, { owner: null, since: entry.sceneId });
    }
    snapshots.set(entry.sceneId, { owners: new Map(itemOwners), locations: new Map(locations) });
  }
  for (const entry of effectsEntries) for (const effect of entry.effects) if (effect.action === "use_item") {
    const index = effectsEntries.findIndex((candidate) => candidate.sceneId === entry.sceneId);
    const owner = index > 0 ? snapshots.get(effectsEntries[index - 1].sceneId)?.owners.get(effect.itemId) : undefined;
    if (!owner || owner.owner === null || owner.owner === effect.characterId) continue;
    warnings.push({ sceneId: entry.sceneId, previousSceneId: owner.since, characterEntityId: effect.characterId, fromLocationId: "", toLocationId: "", reason: "item-owner-mismatch", itemId: effect.itemId, expectedOwnerId: owner.owner, detail: `アイテム「${effect.itemId}」はシーン「${owner.since}」以降キャラ「${owner.owner}」が所持しているはずだが、シーン「${entry.sceneId}」でキャラ「${effect.characterId}」が使用した。` });
  }
  const observed = new Map<string, { locationId: string; sceneId: string }>();
  for (const scene of sorted) {
    if (!scene.locationId) continue;
    const snapshot = snapshots.get(scene.sceneId);
    for (const characterId of scene.characterIds) {
      const previous = observed.get(characterId);
      if (previous && previous.locationId !== scene.locationId && snapshot?.locations.get(characterId)?.location !== scene.locationId) warnings.push({
        sceneId: scene.sceneId, previousSceneId: previous.sceneId, characterEntityId: characterId, fromLocationId: previous.locationId, toLocationId: scene.locationId, reason: "unrecorded-teleport",
        detail: `キャラ「${characterId}」はシーン「${previous.sceneId}」で場所「${previous.locationId}」にいたが、移動effect（move_to）の記録なしにシーン「${scene.sceneId}」で場所「${scene.locationId}」に出現した。`,
      });
      observed.set(characterId, { locationId: scene.locationId, sceneId: scene.sceneId });
    }
  }
  const timelineSorted = [...estimateSceneTimeline(timelineScenes)].sort((a, b) => a.order - b.order);
  for (let i = 1; i < timelineSorted.length; i++) {
    const previous = timelineSorted[i - 1]; const current = timelineSorted[i];
    if (current.relation === "backward" || (current.deltaFromPrevious != null && current.deltaFromPrevious < 0)) warnings.push({ sceneId: current.sceneId, previousSceneId: previous.sceneId, characterEntityId: "", fromLocationId: "", toLocationId: "", reason: "timeline-reversal", detail: `時系列の逆転: 「${previous.sceneId}」の後に「${current.sceneId}」で過去方向の時間表現（Δ=${current.deltaFromPrevious}日）`, fromDayOffset: previous.cumulativeDayOffset, toDayOffset: current.cumulativeDayOffset });
    if (current.deltaFromPrevious != null && current.deltaFromPrevious > 30) warnings.push({ sceneId: current.sceneId, previousSceneId: previous.sceneId, characterEntityId: "", fromLocationId: "", toLocationId: "", reason: "timeline-gap", detail: `不自然な時間空白: 「${previous.sceneId}」→「${current.sceneId}」で ${current.deltaFromPrevious} 日経過（閾値 30）`, fromDayOffset: previous.cumulativeDayOffset, toDayOffset: current.cumulativeDayOffset });
    if (previous.cumulativeDayOffset != null && current.cumulativeDayOffset != null && current.cumulativeDayOffset < previous.cumulativeDayOffset && current.relation !== "backward" && !(current.deltaFromPrevious != null && current.deltaFromPrevious < 0)) warnings.push({ sceneId: current.sceneId, previousSceneId: previous.sceneId, characterEntityId: "", fromLocationId: "", toLocationId: "", reason: "timeline-reversal", detail: `時系列の逆転: 累積日オフセットが ${previous.cumulativeDayOffset} → ${current.cumulativeDayOffset}`, fromDayOffset: previous.cumulativeDayOffset, toDayOffset: current.cumulativeDayOffset });
  }
  return warnings;
}

export async function checkProjectConsistency(reader: SnapshotReader, signal: AbortSignal): Promise<ValidationIssue[]> {
  const project = await readProject(reader, signal);
  return validateProject(project.entities, project.links, project.duplicateIds);
}

export async function checkProjectContinuity(reader: SnapshotReader, signal: AbortSignal): Promise<ContinuityWarning[]> {
  const project = await readProject(reader, signal);
  const sceneInfos = buildSceneLocationInfos(project.entities, project.links);
  const timelineScenes = sceneInfos.map((info) => {
    const scene = project.entities.get(info.sceneId);
    const manuscriptPath = scene?.raw.manuscript;
    const manuscript = typeof manuscriptPath === "string" ? [...project.entities.values()].find((entity) => entity.filePath === manuscriptPath) : undefined;
    const linkedManuscript = linked(project.entities, project.links, info.sceneId, "manuscript")[0];
    return { sceneId: info.sceneId, order: info.order, text: linkedManuscript?.body ?? manuscript?.body ?? "" };
  });
  return detectContinuityWarnings(project.entities, sceneInfos, timelineScenes);
}
