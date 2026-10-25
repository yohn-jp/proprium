import { EditorState, type Extension } from "@codemirror/state";

const ELLIPSIS_LONE = /(?<!…)…(?!…)/gu;

export function normalizeEllipsisInsert(before: string, insert: string, after: string): string {
  if (!insert.includes("…")) return insert;
  const combined = before + insert + after;
  const normalized = combined.replace(ELLIPSIS_LONE, "……");
  if (normalized === combined) return insert;
  return normalized.slice(before.length, normalized.length - after.length);
}

function isMidCompositionTransaction(transaction: { isUserEvent: (event: string) => boolean }): boolean {
  return transaction.isUserEvent("input.type.compose") && !transaction.isUserEvent("input.type.compose.end");
}

export function ellipsisNormalizeExtension(): Extension {
  return EditorState.transactionFilter.of((transaction) => {
    if (!transaction.docChanged || isMidCompositionTransaction(transaction)) return transaction;
    let changed = false;
    const replacements: { from: number; to: number; insert: string }[] = [];
    const doc = transaction.startState.doc;
    transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const text = inserted.toString();
      const previousIsEllipsis = fromA > 0 && doc.sliceString(fromA - 1, fromA) === "…";
      if (!text.includes("…") && !previousIsEllipsis) {
        replacements.push({ from: fromA, to: toA, insert: text });
        return;
      }
      const from = Math.max(0, fromA - 1);
      const to = Math.min(doc.length, toA + 1);
      const combined = doc.sliceString(from, fromA) + text + doc.sliceString(toA, to);
      const normalized = combined.replace(ELLIPSIS_LONE, "……");
      if (normalized !== combined) changed = true;
      replacements.push({ from, to, insert: normalized });
    });
    if (!changed) return transaction;
    return { changes: replacements, filter: false };
  });
}
