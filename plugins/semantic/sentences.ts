/** Pinned Scriptorium sentence boundary port, preserving JavaScript UTF-16 spans. */
export interface SentenceOffset { start: number; end: number }
interface SentenceSegment extends SentenceOffset { text: string }

const OPEN_BRACKETS = new Set(["「", "『"]);
const CLOSE_BRACKETS = new Set(["」", "』"]);

function bracketDepth(text: string, endExclusive: number): number {
  let depth = 0;
  for (let index = 0; index < endExclusive; index++) {
    const character = text[index];
    if (OPEN_BRACKETS.has(character!)) depth++;
    else if (CLOSE_BRACKETS.has(character!)) depth = Math.max(0, depth - 1);
  }
  return depth;
}

function splitAtClosingBrackets(line: string, lineStart: number, segment: SentenceSegment): SentenceSegment[] {
  const relativeStart = segment.start - lineStart;
  const relativeEnd = segment.end - lineStart;
  const output: SentenceSegment[] = [];
  let depth = bracketDepth(line, relativeStart);
  let chunkStart = relativeStart;
  for (let index = relativeStart; index < relativeEnd; index++) {
    const character = line[index]!;
    if (OPEN_BRACKETS.has(character)) {
      if (depth === 0 && index > chunkStart) {
        output.push({ text: line.slice(chunkStart, index), start: lineStart + chunkStart, end: lineStart + index });
        chunkStart = index;
      }
      depth++;
    } else if (CLOSE_BRACKETS.has(character)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        const end = index + 1;
        output.push({ text: line.slice(chunkStart, end), start: lineStart + chunkStart, end: lineStart + end });
        chunkStart = end;
      }
    }
  }
  if (chunkStart < relativeEnd) output.push({ text: line.slice(chunkStart, relativeEnd), start: lineStart + chunkStart, end: segment.end });
  return output.length > 0 ? output : [segment];
}

function splitLine(line: string, lineStart: number): SentenceSegment[] {
  if (line.length === 0) return [{ text: "", start: lineStart, end: lineStart }];
  if (typeof Intl.Segmenter !== "function") {
    throw Object.assign(new Error("This runtime does not provide the pinned Japanese sentence segmenter"), { code: "dependency_unavailable" });
  }
  const segmenter = new Intl.Segmenter("ja", { granularity: "sentence" });
  const raw: SentenceSegment[] = [];
  for (const { segment, index } of segmenter.segment(line)) {
    raw.push({ text: segment, start: lineStart + index, end: lineStart + index + segment.length });
  }
  if (raw.length === 0) return splitAtClosingBrackets(line, lineStart, { text: line, start: lineStart, end: lineStart + line.length });
  const merged: SentenceSegment[] = [];
  let accumulated = raw[0]!;
  for (let index = 1; index < raw.length; index++) {
    const next = raw[index]!;
    if (bracketDepth(line, accumulated.end - lineStart) > 0) {
      accumulated = { text: line.slice(accumulated.start - lineStart, next.end - lineStart), start: accumulated.start, end: next.end };
    } else {
      merged.push(accumulated);
      accumulated = next;
    }
  }
  merged.push(accumulated);
  return merged.flatMap((segment) => splitAtClosingBrackets(line, lineStart, segment));
}

function splitSegments(text: string): SentenceSegment[] {
  const segments: SentenceSegment[] = [];
  let lineStart = 0;
  let justSplit = false;
  for (let index = 0; index <= text.length; index++) {
    const atNewline = index < text.length && text[index] === "\n";
    const atEnd = index === text.length;
    if (!atNewline && !atEnd) continue;
    const lineEnd = index;
    if (lineEnd > lineStart) {
      segments.push(...splitLine(text.slice(lineStart, lineEnd), lineStart));
      justSplit = true;
    } else if (atNewline && !justSplit) {
      segments.push({ text: "", start: lineEnd, end: lineEnd });
    }
    if (atEnd) lineStart = text.length;
    else {
      lineStart = index + 1;
      justSplit = false;
    }
  }
  segments.push({ text: text.slice(lineStart), start: lineStart, end: text.length });
  return segments;
}

export function splitIntoSentenceOffsets(text: string): SentenceOffset[] {
  return splitSegments(text).map(({ start, end }) => ({ start, end }));
}
