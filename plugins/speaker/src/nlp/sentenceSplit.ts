/** Browser-safe sentence segmentation copied from the source core-shared contract. */
export interface SentenceOffset { start: number; end: number }
interface SentenceSegment { text: string; start: number; end: number }

const OPEN_BRACKETS = new Set(["「", "『"]);
const CLOSE_BRACKETS = new Set(["」", "』"]);

function bracketDepth(text: string, endExclusive: number): number {
  let depth = 0;
  for (let i = 0; i < endExclusive; i++) {
    const ch = text[i];
    if (OPEN_BRACKETS.has(ch)) depth++;
    else if (CLOSE_BRACKETS.has(ch)) depth = Math.max(0, depth - 1);
  }
  return depth;
}

function splitAtClosingBrackets(line: string, lineStart: number, seg: SentenceSegment): SentenceSegment[] {
  const relStart = seg.start - lineStart;
  const relEnd = seg.end - lineStart;
  const out: SentenceSegment[] = [];
  let depth = bracketDepth(line, relStart);
  let chunkStart = relStart;
  for (let i = relStart; i < relEnd; i++) {
    const ch = line[i];
    if (OPEN_BRACKETS.has(ch)) {
      if (depth === 0 && i > chunkStart) {
        out.push({ text: line.slice(chunkStart, i), start: lineStart + chunkStart, end: lineStart + i });
        chunkStart = i;
      }
      depth++;
    } else if (CLOSE_BRACKETS.has(ch)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        const end = i + 1;
        out.push({ text: line.slice(chunkStart, end), start: lineStart + chunkStart, end: lineStart + end });
        chunkStart = end;
      }
    }
  }
  if (chunkStart < relEnd) out.push({ text: line.slice(chunkStart, relEnd), start: lineStart + chunkStart, end: seg.end });
  return out.length > 0 ? out : [seg];
}

type SentenceEnds = (text: string) => ArrayLike<number>;
let sentenceEnds: SentenceEnds | undefined;
/** The composed component supplies the pinned Unicode segmentation implementation. */
export function setSentenceEnds(segmenter: SentenceEnds): void { sentenceEnds = segmenter; }

function splitLineWithSegmenter(line: string, lineStart: number): SentenceSegment[] {
  if (line.length === 0) return [{ text: "", start: lineStart, end: lineStart }];
  const raw: SentenceSegment[] = [];
  if (sentenceEnds) {
    let start = 0;
    for (const end of Array.from(sentenceEnds(line))) {
      if (!Number.isSafeInteger(end) || end <= start || end > line.length) throw new Error("Invalid Unicode sentence boundary");
      raw.push({ text: line.slice(start, end), start: lineStart + start, end: lineStart + end });
      start = end;
    }
    if (start !== line.length) throw new Error("Incomplete Unicode sentence boundaries");
  } else {
    const segmenter = new Intl.Segmenter("ja", { granularity: "sentence" });
    for (const { segment, index } of segmenter.segment(line)) {
      raw.push({ text: segment, start: lineStart + index, end: lineStart + index + segment.length });
    }
  }
  if (raw.length === 0) return splitAtClosingBrackets(line, lineStart, { text: line, start: lineStart, end: lineStart + line.length });
  const merged: SentenceSegment[] = [];
  let acc = raw[0];
  for (let i = 1; i < raw.length; i++) {
    if (bracketDepth(line, acc.end - lineStart) > 0) {
      acc = { text: line.slice(acc.start - lineStart, raw[i].end - lineStart), start: acc.start, end: raw[i].end };
    } else {
      merged.push(acc);
      acc = raw[i];
    }
  }
  merged.push(acc);
  return merged.flatMap((seg) => splitAtClosingBrackets(line, lineStart, seg));
}

function splitIntoSentenceSegments(text: string): SentenceSegment[] {
  const segments: SentenceSegment[] = [];
  let lineStart = 0;
  let justSplit = false;
  for (let i = 0; i <= text.length; i++) {
    const atNewline = i < text.length && text[i] === "\n";
    const atEnd = i === text.length;
    if (!atNewline && !atEnd) continue;
    const lineEnd = i;
    if (lineEnd > lineStart) {
      segments.push(...splitLineWithSegmenter(text.slice(lineStart, lineEnd), lineStart));
      justSplit = true;
    } else if (atNewline && !justSplit) {
      segments.push({ text: "", start: lineEnd, end: lineEnd });
    }
    if (atEnd) lineStart = text.length;
    else {
      lineStart = i + 1;
      justSplit = false;
    }
  }
  segments.push({ text: text.slice(lineStart), start: lineStart, end: text.length });
  return segments;
}

export function splitIntoSentences(text: string): string[] {
  return splitIntoSentenceSegments(text).map((segment) => segment.text);
}

export function splitIntoSentenceOffsets(text: string): SentenceOffset[] {
  return splitIntoSentenceSegments(text).map(({ start, end }) => ({ start, end }));
}
