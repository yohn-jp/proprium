import { DEFAULT_LINT_RULES } from "./types.js";
import { transformText } from "./textTransformer.js";

const LEADING_WHITESPACE_RE = /^[ \t　]+/;

/** Source `core-shared/formatManuscript`: remove line indentation, then apply defaults. */
export function formatManuscript(text: string): string {
  const withoutIndent = text
    .split("\n")
    .map((line) => line.replace(LEADING_WHITESPACE_RE, ""))
    .join("\n");
  return transformText(withoutIndent, DEFAULT_LINT_RULES);
}
