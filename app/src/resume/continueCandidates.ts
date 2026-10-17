import type { RecentActivityDeviceType, RecentActivityItem } from "@scriptorium/contracts";
import type { Tree } from "../api";

export interface WritingResumePosition {
  sceneId: string;
  cursorSentenceIndex: number | null;
  scrollTop: number;
}

export interface ContinueCandidate {
  sceneId: string;
  sentenceOffset: number | null;
  pageIndex: number | null;
  source: "local" | "server";
  deviceType?: RecentActivityDeviceType;
  updatedAt?: string;
  scrollTop?: number;
}

export function sceneExistsInTree(tree: Tree, sceneId: string): boolean {
  return tree.volumes.some((volume) => volume.chapters.some((chapter) => chapter.scenes.some((scene) => scene.id === sceneId)));
}

export function sceneTitleInTree(tree: Tree, sceneId: string): string {
  for (const volume of tree.volumes) {
    for (const chapter of volume.chapters) {
      const scene = chapter.scenes.find((item) => item.id === sceneId);
      if (scene) return scene.title || sceneId;
    }
  }
  return sceneId;
}

/** Merge the current browser cursor with one server cursor per device. */
export function mergeContinueCandidates(
  local: WritingResumePosition | null,
  serverItems: RecentActivityItem[],
  tree: Tree,
): ContinueCandidate[] {
  const byScene = new Map<string, ContinueCandidate>();
  for (const item of serverItems) {
    if (!sceneExistsInTree(tree, item.sceneId)) continue;
    const previous = byScene.get(item.sceneId);
    if (previous && (previous.updatedAt ?? "") >= item.updatedAt) continue;
    byScene.set(item.sceneId, {
      sceneId: item.sceneId,
      sentenceOffset: item.sentenceOffset,
      pageIndex: item.pageIndex ?? null,
      source: "server",
      deviceType: item.deviceType,
      updatedAt: item.updatedAt,
    });
  }
  if (local && sceneExistsInTree(tree, local.sceneId)) {
    const previous = byScene.get(local.sceneId);
    byScene.set(local.sceneId, {
      sceneId: local.sceneId,
      sentenceOffset: local.cursorSentenceIndex,
      pageIndex: previous?.pageIndex ?? null,
      source: "local",
      deviceType: previous?.deviceType,
      updatedAt: previous?.updatedAt,
      scrollTop: local.scrollTop,
    });
  }
  return [...byScene.values()].sort((left, right) => {
    if (left.source !== right.source) return left.source === "local" ? -1 : 1;
    return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
  });
}

export function formatHandoffHint(
  deviceType: RecentActivityDeviceType | undefined,
  updatedAt: string | undefined,
  nowMs = Date.now(),
  currentDeviceType?: RecentActivityDeviceType,
): string | null {
  if (!deviceType || !updatedAt || deviceType === currentDeviceType) return null;
  const then = Date.parse(updatedAt);
  if (!Number.isFinite(then)) return null;
  const minutes = Math.max(0, Math.round((nowMs - then) / 60_000));
  const label = deviceType === "desktop" ? "PC" : "スマホ";
  const when = minutes < 1 ? "たった今" : minutes < 60 ? `${minutes}分前` :
    minutes < 60 * 48 ? `${Math.round(minutes / 60)}時間前` : `${Math.round(minutes / 1_440)}日前`;
  return `${label}で${when}まで編集していました`;
}

export function writingResumeStorageKey(authorScope: string, repositoryKey: string): string {
  return `scriptorium:writing-resume:${encodeURIComponent(JSON.stringify([authorScope, repositoryKey]))}`;
}

export function loadWritingResume(authorScope: string, repositoryKey: string): WritingResumePosition | null {
  try {
    const raw = window.localStorage.getItem(writingResumeStorageKey(authorScope, repositoryKey));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.sceneId !== "string" || !record.sceneId ||
        (record.cursorSentenceIndex !== null && (!Number.isSafeInteger(record.cursorSentenceIndex) || (record.cursorSentenceIndex as number) < 1)) ||
        typeof record.scrollTop !== "number" || !Number.isFinite(record.scrollTop) || record.scrollTop < 0) return null;
    return {
      sceneId: record.sceneId,
      cursorSentenceIndex: record.cursorSentenceIndex as number | null,
      scrollTop: record.scrollTop,
    };
  } catch {
    return null;
  }
}

export function saveWritingResume(authorScope: string, repositoryKey: string, position: WritingResumePosition): void {
  try {
    window.localStorage.setItem(writingResumeStorageKey(authorScope, repositoryKey), JSON.stringify(position));
  } catch {
    // Resume is best-effort; manuscript durability remains in the separate IndexedDB journal.
  }
}

export function readingResumeStorageKey(authorScope: string, repositoryKey: string, sceneId: string): string {
  return `scriptorium:reading-resume:${encodeURIComponent(JSON.stringify([authorScope, repositoryKey, sceneId]))}`;
}

export function loadReadingPage(authorScope: string, repositoryKey: string, sceneId: string): number {
  try {
    const page = Number(window.localStorage.getItem(readingResumeStorageKey(authorScope, repositoryKey, sceneId)));
    return Number.isSafeInteger(page) && page >= 0 ? page : 0;
  } catch {
    return 0;
  }
}

export function saveReadingPage(authorScope: string, repositoryKey: string, sceneId: string, pageIndex: number): void {
  try {
    window.localStorage.setItem(readingResumeStorageKey(authorScope, repositoryKey, sceneId), String(pageIndex));
  } catch {
    // Resume is best-effort.
  }
}

interface SentenceOffset { start: number; end: number; }

// Port of core-shared's browser-safe splitter, kept in the shell so core UI
// stays independent from whichever optional module profile is selected.
function sentenceOffsets(text: string): SentenceOffset[] {
  const result: SentenceOffset[] = [];
  let lineStart = 0;
  let justSplit = false;
  for (let index = 0; index <= text.length; index++) {
    const atNewline = index < text.length && text[index] === "\n";
    const atEnd = index === text.length;
    if (!atNewline && !atEnd) continue;
    const lineEnd = index;
    if (lineEnd > lineStart) {
      const line = text.slice(lineStart, lineEnd);
      const segmenter = new Intl.Segmenter("ja", { granularity: "sentence" });
      const raw = [...segmenter.segment(line)].map(({ segment, index: start }) => ({ start, end: start + segment.length }));
      const merged: SentenceOffset[] = [];
      const depthAt = (end: number) => {
        let depth = 0;
        for (let cursor = 0; cursor < end; cursor++) {
          if (line[cursor] === "「" || line[cursor] === "『") depth++;
          else if (line[cursor] === "」" || line[cursor] === "』") depth = Math.max(0, depth - 1);
        }
        return depth;
      };
      if (raw.length === 0) raw.push({ start: 0, end: line.length });
      let start = raw[0]?.start ?? 0;
      let end = raw[0]?.end ?? line.length;
      for (const segment of raw.slice(1)) {
        if (depthAt(end) > 0) end = segment.end;
        else { merged.push({ start, end }); start = segment.start; end = segment.end; }
      }
      merged.push({ start, end });
      for (const segment of merged) {
        let depth = depthAt(segment.start);
        let chunkStart = segment.start;
        for (let cursor = segment.start; cursor < segment.end; cursor++) {
          const char = line[cursor];
          if (char === "「" || char === "『") {
            if (depth === 0 && cursor > chunkStart) {
              result.push({ start: lineStart + chunkStart, end: lineStart + cursor });
              chunkStart = cursor;
            }
            depth++;
          } else if (char === "」" || char === "』") {
            depth = Math.max(0, depth - 1);
            if (depth === 0) {
              result.push({ start: lineStart + chunkStart, end: lineStart + cursor + 1 });
              chunkStart = cursor + 1;
            }
          }
        }
        if (chunkStart < segment.end) result.push({ start: lineStart + chunkStart, end: lineStart + segment.end });
      }
      justSplit = true;
    } else if (atNewline && !justSplit) result.push({ start: lineEnd, end: lineEnd });
    if (atEnd) lineStart = text.length;
    else { lineStart = index + 1; justSplit = false; }
  }
  result.push({ start: lineStart, end: text.length });
  return result;
}

export function uiSentenceIndexAtOffset(text: string, offset: number): number | null {
  const cursor = Math.max(0, Math.min(offset, text.length));
  const offsets = sentenceOffsets(text);
  for (let index = 0; index < offsets.length; index++) {
    const range = offsets[index];
    if (range && cursor >= range.start && (cursor < range.end || (index === offsets.length - 1 && cursor === range.end))) return index + 1;
  }
  return null;
}

export function offsetAtUiSentenceIndex(text: string, sentenceIndex: number | null): number | null {
  if (sentenceIndex === null || !Number.isSafeInteger(sentenceIndex) || sentenceIndex < 1) return null;
  return sentenceOffsets(text)[sentenceIndex - 1]?.start ?? null;
}
