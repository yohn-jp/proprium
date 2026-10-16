import type { LineSpacingRule, LintRule, RegexSequenceRule } from "./types.js";

function isRegexSequenceRule(rule: LintRule): rule is RegexSequenceRule {
  return rule.kind === "regex_sequence";
}

function isLineSpacingRule(rule: LintRule): rule is LineSpacingRule {
  return rule.kind === "line_spacing";
}

function applyRegexSequenceRules(text: string, rules: RegexSequenceRule[]): string {
  let result = text;
  for (const rule of rules) {
    const flags = rule.flags ?? "";
    const regex = new RegExp(rule.pattern, flags.includes("g") ? flags : `${flags}g`);
    result = result.replace(regex, rule.replacement);
  }
  return result;
}

/** 複数のline_spacingルールを、いずれか1つでもマッチすれば「ブロック開始行」とみなす判定関数にまとめる。 */
function buildBlockStartMatcher(rules: LineSpacingRule[]): (line: string) => boolean {
  const regexes = rules.map((rule) => new RegExp(rule.startPattern, rule.flags ?? ""));
  return (line: string) => regexes.some((regex) => regex.test(line.trim()));
}

/** ブロック開始行（会話文など）の前後に空行を1行だけ確保する。 */
function insertLineSpacing(lines: string[], isBlockStart: (line: string) => boolean): string[] {
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isStart = line.trim() !== "" && isBlockStart(line);

    if (isStart && out.length > 0 && out[out.length - 1].trim() !== "") {
      out.push("");
    }

    out.push(line);

    const next = lines[i + 1];
    if (isStart && next !== undefined && next.trim() !== "") {
      out.push("");
    }
  }

  return out;
}

/** 2行以上連続する空行を1行の空行に畳む。 */
function collapseBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  let blankRun = 0;

  for (const line of lines) {
    if (line.trim() === "") {
      blankRun++;
      if (blankRun <= 1) out.push(line);
    } else {
      blankRun = 0;
      out.push(line);
    }
  }

  return out;
}

/** 先頭・末尾の空行を除去する。 */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * ルールに基づいて本文を自動整形する純粋関数。
 *
 * - regex_sequence ルール: マッチ箇所を置換で修正する（例: 三点リーダー1片を2つに揃える）。
 * - line_spacing ルール: 対象行の前後に空行を1行確保する（例: 会話文の前後）。
 *   line_spacingルールの有無によらず、連続空行の正規化・先頭末尾の空行trimは常に行う。
 */
export function transformText(text: string, rules: LintRule[]): string {
  const regexSequenceRules = rules.filter(isRegexSequenceRule);
  const lineSpacingRules = rules.filter(isLineSpacingRule);

  const afterRegexFixes = applyRegexSequenceRules(text, regexSequenceRules);

  const isBlockStart =
    lineSpacingRules.length > 0 ? buildBlockStartMatcher(lineSpacingRules) : () => false;
  const lines = afterRegexFixes.split("\n");
  const withSpacing = insertLineSpacing(lines, isBlockStart);
  const collapsed = collapseBlankRuns(withSpacing);

  return trimBlankEdges(collapsed).join("\n");
}
