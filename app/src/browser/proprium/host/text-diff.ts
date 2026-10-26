export type TextDiffLineKind = "context" | "removed" | "added";

export interface TextDiffLine {
  kind: TextDiffLineKind;
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
}

export interface TextDiffResult {
  lines: TextDiffLine[];
  beforeLineEnding: string;
  afterLineEnding: string;
  beforeHasFinalNewline: boolean;
  afterHasFinalNewline: boolean;
}

const MAX_INLINE_LINE_COUNT = 2_000;
const MAX_INLINE_DIFF_CELLS = 100_000;

function splitLines(value: string): string[] {
  if (!value) return [];
  const lines = value.split(/\r\n|\r|\n/u);
  if (/(?:\r\n|\r|\n)$/u.test(value)) lines.pop();
  return lines;
}

function lineEnding(value: string): string {
  const endings = [...value.matchAll(/\r\n|\r|\n/gu)].map(match => match[0]);
  if (!endings.length) return "なし";
  const unique = new Set(endings);
  if (unique.size > 1) return "混在";
  return endings[0] === "\r\n" ? "CRLF" : endings[0] === "\r" ? "CR" : "LF";
}

/**
 * Return a bounded line diff. `null` means the inputs are too large for the
 * inline LCS view; callers can still show the two complete text panes.
 */
export function computeTextDiff(before: string, after: string): TextDiffResult | null {
  const original = splitLines(before);
  const proposed = splitLines(after);
  if (original.length + proposed.length > MAX_INLINE_LINE_COUNT ||
      original.length * proposed.length > MAX_INLINE_DIFF_CELLS) return null;

  const rows = Array.from({ length: original.length + 1 }, () => new Uint32Array(proposed.length + 1));
  for (let oldIndex = original.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = proposed.length - 1; newIndex >= 0; newIndex--) {
      rows[oldIndex][newIndex] = original[oldIndex] === proposed[newIndex]
        ? rows[oldIndex + 1][newIndex + 1] + 1
        : Math.max(rows[oldIndex + 1][newIndex], rows[oldIndex][newIndex + 1]);
    }
  }

  const lines: TextDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < original.length || newIndex < proposed.length) {
    if (oldIndex < original.length && newIndex < proposed.length && original[oldIndex] === proposed[newIndex]) {
      lines.push({ kind: "context", text: original[oldIndex], beforeLine: oldIndex + 1, afterLine: newIndex + 1 });
      oldIndex++;
      newIndex++;
    } else if (oldIndex < original.length &&
        (newIndex >= proposed.length || rows[oldIndex + 1][newIndex] >= rows[oldIndex][newIndex + 1])) {
      lines.push({ kind: "removed", text: original[oldIndex], beforeLine: oldIndex + 1, afterLine: null });
      oldIndex++;
    } else {
      lines.push({ kind: "added", text: proposed[newIndex], beforeLine: null, afterLine: newIndex + 1 });
      newIndex++;
    }
  }

  return {
    lines,
    beforeLineEnding: lineEnding(before),
    afterLineEnding: lineEnding(after),
    beforeHasFinalNewline: /(?:\r\n|\r|\n)$/u.test(before),
    afterHasFinalNewline: /(?:\r\n|\r|\n)$/u.test(after),
  };
}
