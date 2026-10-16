import { snapshotResult, type StorySnapshotResult } from "./types.js";
import type { SnapshotId } from "@scriptorium/contracts";

export type TimeOfDay = "dawn" | "morning" | "noon" | "evening" | "dusk" | "night";
export type TimeExpressionKind = "relative-forward" | "relative-backward" | "time-of-day" | "unknown";

export interface TimeExpression {
  surface: string;
  start: number;
  end: number;
  deltaDays: number | null;
  timeOfDay?: TimeOfDay;
  kind: TimeExpressionKind;
}

export type SceneTimeRelation = "forward" | "backward" | "same-day" | "unknown";
export type TimelineConfidence = "confirmed" | "estimated" | "unknown";

export interface SceneTimelineEstimate {
  sceneId: string;
  order: number;
  expressions: TimeExpression[];
  cumulativeDayOffset: number | null;
  deltaFromPrevious: number | null;
  relation: SceneTimeRelation;
}

export interface TimelineSceneInput {
  sceneId: string;
  order: number;
  text: string;
}

export interface StoryToken {
  surface: string;
  pos: string;
  posDetail?: string[];
  baseForm?: string;
  start: number;
  end: number;
}

/** Structural tokenizer port; Story can use an available tokenizer without importing NLP. */
export interface StoryTokenizer {
  tokenize(text: string): StoryToken[];
}

export interface SceneTimelineCharacter {
  id: string;
  name: string;
}

export interface SceneTimelineEntryInput extends TimelineSceneInput {
  title?: string;
  explicitDateMeta?: boolean;
  locationId?: string;
  locationName?: string;
  characters?: SceneTimelineCharacter[];
  chapterId?: string;
  chapterName?: string;
}

export interface SceneTimelineEntry {
  sceneId: string;
  order: number;
  title: string;
  cumulativeDayOffset: number | null;
  deltaFromPrevious: number | null;
  relation: SceneTimeRelation;
  confidence: TimelineConfidence;
  expressionSurfaces: string[];
  locationId?: string;
  locationName?: string;
  characters?: SceneTimelineCharacter[];
  chapterId?: string;
  chapterName?: string;
}

export function parseJapaneseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (trimmed === "十") return 10;
  if (trimmed === "百") return 100;
  let total = 0;
  let current = 0;
  for (const character of trimmed) {
    if (character === "十") {
      total += (current === 0 ? 1 : current) * 10;
      current = 0;
    } else if (character === "百") {
      total += (current === 0 ? 1 : current) * 100;
      current = 0;
    } else if (character in digits) {
      current = digits[character]!;
    } else {
      return null;
    }
  }
  return total + current;
}

interface LexiconEntry {
  surface: string;
  deltaDays: number | null;
  timeOfDay?: TimeOfDay;
  kind: TimeExpressionKind;
}

const FIXED_LEXICON: LexiconEntry[] = (
  [
    { surface: "一週間後", deltaDays: 7, kind: "relative-forward" },
    { surface: "翌週", deltaDays: 7, kind: "relative-forward" },
    { surface: "数日後", deltaDays: 3, kind: "relative-forward" },
    { surface: "翌朝", deltaDays: 1, timeOfDay: "morning", kind: "relative-forward" },
    { surface: "翌日", deltaDays: 1, kind: "relative-forward" },
    { surface: "前日", deltaDays: -1, kind: "relative-backward" },
    { surface: "昨日", deltaDays: -1, kind: "relative-backward" },
    { surface: "今朝", deltaDays: 0, timeOfDay: "morning", kind: "relative-forward" },
    { surface: "夕暮れ", deltaDays: null, timeOfDay: "dusk", kind: "time-of-day" },
    { surface: "夜明け", deltaDays: null, timeOfDay: "dawn", kind: "time-of-day" },
    { surface: "真夜中", deltaDays: null, timeOfDay: "night", kind: "time-of-day" },
    { surface: "正午", deltaDays: null, timeOfDay: "noon", kind: "time-of-day" },
    { surface: "夕方", deltaDays: null, timeOfDay: "evening", kind: "time-of-day" },
    { surface: "夜", deltaDays: null, timeOfDay: "night", kind: "time-of-day" },
    { surface: "朝", deltaDays: null, timeOfDay: "morning", kind: "time-of-day" },
  ] satisfies LexiconEntry[]
).sort((a, b) => b.surface.length - a.surface.length);

const N_DAYS_LATER_RE = /([一二三四五六七八九十百零〇\d]+)日後/g;
const N_DAYS_BEFORE_RE = /([一二三四五六七八九十百零〇\d]+)日前/g;

function tokenPosDetail1(token: StoryToken): string {
  return token.posDetail?.[0] ?? "";
}

function isNoun(token: StoryToken): boolean {
  return token.pos === "名詞";
}

function isProperNoun(token: StoryToken): boolean {
  return tokenPosDetail1(token) === "固有名詞";
}

function isNumeral(token: StoryToken): boolean {
  return tokenPosDetail1(token) === "数";
}

function isTimeLikeNoun(token: StoryToken): boolean {
  if (!isNoun(token)) return false;
  const detail = tokenPosDetail1(token);
  return (
    detail === "副詞可能" ||
    detail === "接尾" ||
    isProperNoun(token) ||
    detail === "一般" ||
    isNumeral(token) ||
    detail === "" ||
    detail === "サ変接続"
  );
}

function pushUnique(out: TimeExpression[], expression: TimeExpression): void {
  if (out.some((item) => item.start === expression.start && item.end === expression.end)) return;
  if (
    out.some(
      (item) =>
        expression.start >= item.start &&
        expression.end <= item.end &&
        expression.end - expression.start < item.end - item.start,
    )
  ) {
    return;
  }
  for (let index = out.length - 1; index >= 0; index--) {
    const item = out[index]!;
    if (
      item.start >= expression.start &&
      item.end <= expression.end &&
      item.end - item.start < expression.end - expression.start
    ) {
      out.splice(index, 1);
    }
  }
  out.push(expression);
}

function extractTimeExpressionsData(text: string, tokenizer?: StoryTokenizer): TimeExpression[] {
  const out: TimeExpression[] = [];
  if (!text) return out;

  for (const entry of FIXED_LEXICON) {
    let from = 0;
    while (from < text.length) {
      const index = text.indexOf(entry.surface, from);
      if (index < 0) break;
      pushUnique(out, {
        surface: entry.surface,
        start: index,
        end: index + entry.surface.length,
        deltaDays: entry.deltaDays,
        timeOfDay: entry.timeOfDay,
        kind: entry.kind,
      });
      from = index + entry.surface.length;
    }
  }

  for (const match of text.matchAll(N_DAYS_LATER_RE)) {
    const days = parseJapaneseNumber(match[1]!);
    if (days == null) continue;
    const start = match.index ?? 0;
    pushUnique(out, {
      surface: match[0],
      start,
      end: start + match[0].length,
      deltaDays: days,
      kind: "relative-forward",
    });
  }
  for (const match of text.matchAll(N_DAYS_BEFORE_RE)) {
    const days = parseJapaneseNumber(match[1]!);
    if (days == null) continue;
    const start = match.index ?? 0;
    pushUnique(out, {
      surface: match[0],
      start,
      end: start + match[0].length,
      deltaDays: -days,
      kind: "relative-backward",
    });
  }

  if (tokenizer) {
    const tokens = tokenizer.tokenize(text);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (!isTimeLikeNoun(token)) continue;
      const surface = token.surface;
      const base = token.baseForm ?? token.surface;
      const entry = FIXED_LEXICON.find((item) => item.surface === surface || item.surface === base);
      if (entry) {
        pushUnique(out, {
          surface,
          start: token.start,
          end: token.end,
          deltaDays: entry.deltaDays,
          timeOfDay: entry.timeOfDay,
          kind: entry.kind,
        });
      }
      if (isNumeral(token) || /^\d+$/.test(surface) || /^[一二三四五六七八九十百]+$/.test(surface)) {
        const dayToken = tokens[index + 1];
        const relativeToken = tokens[index + 2];
        if (dayToken?.surface === "日" && (relativeToken?.surface === "後" || relativeToken?.surface === "前")) {
          const days = parseJapaneseNumber(surface);
          if (days != null) {
            const forward = relativeToken.surface === "後";
            pushUnique(out, {
              surface: `${surface}日${relativeToken.surface}`,
              start: token.start,
              end: relativeToken.end,
              deltaDays: forward ? days : -days,
              kind: forward ? "relative-forward" : "relative-backward",
            });
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export function extractTimeExpressions(input: {
  snapshot: SnapshotId;
  text: string;
  tokenizer?: StoryTokenizer;
}): StorySnapshotResult<TimeExpression[]> {
  return snapshotResult(input.snapshot, extractTimeExpressionsData(input.text, input.tokenizer));
}

function estimateSceneTimelineData(
  scenes: readonly TimelineSceneInput[],
  tokenizer?: StoryTokenizer,
): SceneTimelineEstimate[] {
  const sorted = [...scenes].sort((a, b) => a.order - b.order);
  const estimates: SceneTimelineEstimate[] = [];
  let cumulative: number | null = 0;
  let hasAnyRelative = false;
  for (let index = 0; index < sorted.length; index++) {
    const scene = sorted[index]!;
    const expressions = extractTimeExpressionsData(scene.text, tokenizer);
    const relative = expressions.filter((expression) => expression.deltaDays != null);
    let deltaFromPrevious: number | null = null;
    if (relative.length > 0) {
      const backward = relative.find((expression) => (expression.deltaDays ?? 0) < 0);
      const forward = relative.find((expression) => (expression.deltaDays ?? 0) > 0);
      const zero = relative.find((expression) => expression.deltaDays === 0);
      if (backward) deltaFromPrevious = backward.deltaDays;
      else if (forward) deltaFromPrevious = forward.deltaDays;
      else if (zero) deltaFromPrevious = 0;
      hasAnyRelative = true;
    }

    let relation: SceneTimeRelation = "unknown";
    if (deltaFromPrevious != null) {
      if (deltaFromPrevious < 0) relation = "backward";
      else if (deltaFromPrevious === 0) relation = "same-day";
      else relation = "forward";
    }

    if (index === 0) {
      if (deltaFromPrevious != null) {
        cumulative = deltaFromPrevious;
      } else {
        cumulative = hasAnyRelative ? cumulative : null;
        if (expressions.length === 0) cumulative = null;
        else cumulative = 0;
      }
    } else if (deltaFromPrevious != null && cumulative != null) {
      cumulative += deltaFromPrevious;
    } else if (deltaFromPrevious != null && cumulative == null) {
      cumulative = deltaFromPrevious;
    }

    estimates.push({
      sceneId: scene.sceneId,
      order: scene.order,
      expressions,
      cumulativeDayOffset: cumulative,
      deltaFromPrevious: index === 0 ? null : deltaFromPrevious,
      relation: index === 0 && deltaFromPrevious == null ? "unknown" : relation,
    });
  }
  return estimates;
}

export function estimateSceneTimeline(input: {
  snapshot: SnapshotId;
  scenes: readonly TimelineSceneInput[];
  tokenizer?: StoryTokenizer;
}): StorySnapshotResult<SceneTimelineEstimate[]> {
  return snapshotResult(input.snapshot, estimateSceneTimelineData(input.scenes, input.tokenizer));
}

const ABSOLUTE_DATE_RE = /(?:\d{1,4}|[一二三四五六七八九十百]+)年(?:\d{1,2}|[一二三四五六七八九十]+)月(?:\d{1,2}|[一二三四五六七八九十]+)日/;

export function hasAbsoluteDateMention(text: string): boolean {
  return text.length > 0 && ABSOLUTE_DATE_RE.test(text);
}

function deriveTimelineConfidenceData(
  estimate: Pick<SceneTimelineEstimate, "expressions">,
  options?: { text?: string; explicitDateMeta?: boolean },
): TimelineConfidence {
  if (options?.explicitDateMeta) return "confirmed";
  if (options?.text && hasAbsoluteDateMention(options.text)) return "confirmed";
  if (estimate.expressions.length === 0) return "unknown";
  return "estimated";
}

export function deriveTimelineConfidence(input: {
  snapshot: SnapshotId;
  estimate: Pick<SceneTimelineEstimate, "expressions">;
  options?: { text?: string; explicitDateMeta?: boolean };
}): StorySnapshotResult<TimelineConfidence> {
  return snapshotResult(input.snapshot, deriveTimelineConfidenceData(input.estimate, input.options));
}

export function buildSceneTimelineEntries(input: {
  snapshot: SnapshotId;
  scenes: readonly SceneTimelineEntryInput[];
  tokenizer?: StoryTokenizer;
}): StorySnapshotResult<SceneTimelineEntry[]> {
  const estimates = estimateSceneTimelineData(input.scenes, input.tokenizer);
  const byId = new Map(input.scenes.map((scene) => [scene.sceneId, scene]));
  const data = estimates.map((estimate): SceneTimelineEntry => {
    const scene = byId.get(estimate.sceneId);
    return {
      sceneId: estimate.sceneId,
      order: estimate.order,
      title: scene?.title?.trim() || estimate.sceneId,
      cumulativeDayOffset: estimate.cumulativeDayOffset,
      deltaFromPrevious: estimate.deltaFromPrevious,
      relation: estimate.relation,
      confidence: deriveTimelineConfidenceData(estimate, {
        text: scene?.text,
        explicitDateMeta: scene?.explicitDateMeta,
      }),
      expressionSurfaces: estimate.expressions.map((expression) => expression.surface),
      locationId: scene?.locationId,
      locationName: scene?.locationName,
      characters: scene?.characters,
      chapterId: scene?.chapterId,
      chapterName: scene?.chapterName,
    };
  });
  return snapshotResult(input.snapshot, data);
}
