import type { Text } from "@codemirror/state";

export const BRACKET_PAIRS: Readonly<Record<string, string>> = {
  "「": "」",
  "『": "』",
  "（": "）",
  "(": ")",
  "【": "】",
  "〈": "〉",
  "《": "》",
  "［": "］",
  "[": "]",
  "{": "}",
  "〔": "〕",
};

export interface BracketInputResult {
  insert: string;
  cursor: number;
}

/** Source behavior: pair opening marks; skip an already-present closing mark. */
export function resolveBracketInput(doc: Text, from: number, to: number, text: string): BracketInputResult | null {
  if (from !== to || text.length !== 1) return null;
  const close = BRACKET_PAIRS[text];
  if (close) {
    const next = doc.sliceString(to, to + close.length);
    return { insert: next === close ? text : text + close, cursor: from + text.length };
  }
  for (const closing of Object.values(BRACKET_PAIRS)) {
    if (text === closing && doc.sliceString(to, to + closing.length) === closing) {
      return { insert: "", cursor: to + closing.length };
    }
  }
  return null;
}
