export const WRITING_SYMBOLS = [
  { id: "quotes", label: "「」", ariaLabel: "鉤括弧を挿入" },
  { id: "ellipsis", label: "……", ariaLabel: "三点リーダーを挿入" },
  { id: "emdash", label: "――", ariaLabel: "ダッシュを挿入" },
  { id: "paragraph", label: "改段落", ariaLabel: "改段落を挿入" },
] as const;

export type WritingSymbolId = (typeof WRITING_SYMBOLS)[number]["id"];

export interface InsertResult {
  from: number;
  to: number;
  insert: string;
  cursor: number;
}

export function planWritingSymbol(value: string, from: number, to: number, symbol: WritingSymbolId): InsertResult {
  const start = Math.max(0, Math.min(from, to, value.length));
  const end = Math.max(0, Math.min(Math.max(from, to), value.length));
  const selected = value.slice(start, end);
  const insert = symbol === "quotes" ? `「${selected}」`
    : symbol === "ellipsis" ? "……"
      : symbol === "emdash" ? "――"
        : "\n\n";
  return {
    from: start,
    to: end,
    insert,
    cursor: symbol === "quotes" ? start + selected.length + 1 : start + insert.length,
  };
}
