/** Snapshot-scoped, transient terminology result returned by an optional host resolver. */
export interface EditorTermSpan {
  /** UTF-16 code-unit offset in the supplied text, matching JavaScript string indices. */
  start: number;
  /** Exclusive UTF-16 code-unit offset in the supplied text. */
  end: number;
  termId: string;
  /** Canonical repository-relative document path. The host validates it before navigation. */
  targetPath: string;
}

/** The resolver receives a bounded source excerpt; returned offsets are relative to that excerpt. */
export type ResolveEditorTerms = (
  text: string,
  signal: AbortSignal,
) => Promise<readonly EditorTermSpan[]>;

export interface VisibleTextRange {
  from: number;
  to: number;
}

export interface TermTextSlice extends VisibleTextRange {}

/** Bounds resolver work to currently visible source ranges, with per-call and total limits. */
export function selectVisibleTermSlices(
  visibleRanges: readonly VisibleTextRange[],
  documentLength: number,
  options: { maxTotalChars?: number; maxSliceChars?: number } = {},
): TermTextSlice[] {
  const finiteLimit = (value: number | undefined, fallback: number) => Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : fallback;
  const maxTotalChars = finiteLimit(options.maxTotalChars, 24_576);
  const maxSliceChars = finiteLimit(options.maxSliceChars, 8_192);
  const safeDocumentLength = Number.isFinite(documentLength) ? Math.max(0, Math.floor(documentLength)) : 0;
  let budget = maxTotalChars;
  let lastEnd = 0;
  const selected: TermTextSlice[] = [];

  const validRanges = visibleRanges
    .filter((range) => Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from)
    .sort((left, right) => left.from - right.from || left.to - right.to);
  for (const range of validRanges) {
    const from = Math.max(lastEnd, 0, Math.floor(range.from));
    const to = Math.min(safeDocumentLength, Math.floor(range.to));
    const length = Math.min(to - from, maxSliceChars, budget);
    if (length <= 0) continue;
    selected.push({ from, to: from + length });
    lastEnd = from + length;
    budget -= length;
    if (budget <= 0) break;
  }
  return selected;
}

/** Drops malformed, out-of-slice and overlapping results before they become source decorations. */
export function validateEditorTermSpans(text: string, spans: readonly EditorTermSpan[]): EditorTermSpan[] {
  if (!Array.isArray(spans)) return [];
  const sorted = spans
    .filter((span) => span !== null && typeof span === "object")
    .filter((span) => Number.isInteger(span.start) && Number.isInteger(span.end))
    .filter((span) => span.start >= 0 && span.end > span.start && span.end <= text.length)
    .filter((span) => isUtf16Boundary(text, span.start) && isUtf16Boundary(text, span.end))
    .filter((span) => typeof span.termId === "string" && span.termId.length > 0)
    .filter((span) => typeof span.targetPath === "string" && span.targetPath.length > 0)
    .sort((left, right) => left.start - right.start || right.end - left.end || left.termId.localeCompare(right.termId));

  const result: EditorTermSpan[] = [];
  let previousEnd = 0;
  for (const span of sorted) {
    if (span.start < previousEnd) continue;
    result.push({ start: span.start, end: span.end, termId: span.termId, targetPath: span.targetPath });
    previousEnd = span.end;
  }
  return result;
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}
