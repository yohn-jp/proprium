import { isDialogue } from "../dialogueDetection.js";
import { extractEnding, normalizeEnding } from "../sentenceEnding.js";
import { splitIntoSentenceOffsets } from "@scriptorium/module-nlp";
import type {
  EndingRepetitionRule,
  LineSpacingRule,
  LintRule,
  LintWarning,
  NarrationForbiddenMarksRule,
  PunctuationCountRule,
  RegexSequenceRule,
  SentenceLengthRule,
} from "./types.js";

function isRegexSequenceRule(rule: LintRule): rule is RegexSequenceRule {
  return rule.kind === "regex_sequence";
}

function isLineSpacingRule(rule: LintRule): rule is LineSpacingRule {
  return rule.kind === "line_spacing";
}

function isSentenceLengthRule(rule: LintRule): rule is SentenceLengthRule {
  return rule.kind === "sentence_length";
}

function isPunctuationCountRule(rule: LintRule): rule is PunctuationCountRule {
  return rule.kind === "punctuation_count";
}

function isEndingRepetitionRule(rule: LintRule): rule is EndingRepetitionRule {
  return rule.kind === "ending_repetition";
}

function isNarrationForbiddenMarksRule(rule: LintRule): rule is NarrationForbiddenMarksRule {
  return rule.kind === "narration_forbidden_marks";
}

/** テキストを文単位に分割し、各文の元テキスト上のオフセットとともに返す。 */
function splitIntoSentencesWithOffsets(
  text: string,
): Array<{ sentence: string; start: number; end: number }> {
  return splitIntoSentenceOffsets(text)
    .map(({ start, end }) => ({ sentence: text.slice(start, end), start, end }))
    .filter(({ sentence }) => sentence.trim() !== "");
}

/** ルールのflagsに"g"を必ず含めたRegExpを生成する（matchAllに必要なため）。 */
function buildGlobalRegex(source: string, flags: string | undefined): RegExp {
  const base = flags ?? "";
  return new RegExp(source, base.includes("g") ? base : `${base}g`);
}

function evaluateRegexSequenceRule(text: string, rule: RegexSequenceRule): LintWarning[] {
  const regex = buildGlobalRegex(rule.pattern, rule.flags);
  const warnings: LintWarning[] = [];

  for (const match of text.matchAll(regex)) {
    if (match.index === undefined) continue;
    warnings.push({
      ruleId: rule.id,
      kind: "regex_sequence",
      message: rule.message ?? `${rule.description ?? "パターン"}に一致する箇所が見つかりました。`,
      offset: match.index,
      length: match[0].length,
      excerpt: match[0],
    });
  }

  return warnings;
}

function evaluateLineSpacingRule(text: string, rule: LineSpacingRule): LintWarning[] {
  const lines = text.split("\n");
  const warnings: LintWarning[] = [];
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const isBlockStart =
      trimmed !== "" && new RegExp(rule.startPattern, rule.flags ?? "").test(trimmed);

    if (isBlockStart) {
      const prev = i > 0 ? lines[i - 1] : undefined;
      if (prev !== undefined && prev.trim() !== "") {
        warnings.push({
          ruleId: rule.id,
          kind: "line_spacing",
          message: rule.message ?? `${rule.description ?? "対象行"}の前に空行がありません。`,
          offset,
          length: 0,
          excerpt: line,
        });
      }

      const next = i < lines.length - 1 ? lines[i + 1] : undefined;
      if (next !== undefined && next.trim() !== "") {
        warnings.push({
          ruleId: rule.id,
          kind: "line_spacing",
          message: rule.message ?? `${rule.description ?? "対象行"}の後に空行がありません。`,
          offset: offset + line.length,
          length: 0,
          excerpt: line,
        });
      }
    }

    offset += line.length + 1; // "\n"分（末尾行では使われない）
  }

  return warnings;
}

function evaluateSentenceLengthRule(text: string, rule: SentenceLengthRule): LintWarning[] {
  const warnings: LintWarning[] = [];

  for (const { sentence, start, end } of splitIntoSentencesWithOffsets(text)) {
    const trimmed = sentence.trim();
    if (trimmed.length <= rule.maxLength) continue;
    warnings.push({
      ruleId: rule.id,
      kind: "sentence_length",
      message:
        rule.message ??
        `${rule.description ?? "一文"}が${rule.maxLength}字を超えています（${trimmed.length}字）。`,
      offset: start,
      length: end - start,
      excerpt: sentence,
    });
  }

  return warnings;
}

const TOUTEN_RE = /、/g;

function evaluatePunctuationCountRule(text: string, rule: PunctuationCountRule): LintWarning[] {
  const warnings: LintWarning[] = [];

  for (const { sentence, start, end } of splitIntoSentencesWithOffsets(text)) {
    if (isDialogue(sentence)) continue;
    const count = sentence.match(TOUTEN_RE)?.length ?? 0;
    if (count <= rule.maxCount) continue;
    warnings.push({
      ruleId: rule.id,
      kind: "punctuation_count",
      message:
        rule.message ??
        `${rule.description ?? "一文中の読点"}が${rule.maxCount}個を超えています（${count}個）。`,
      offset: start,
      length: end - start,
      excerpt: sentence,
    });
  }

  return warnings;
}

function evaluateEndingRepetitionRule(text: string, rule: EndingRepetitionRule): LintWarning[] {
  const sentences = splitIntoSentencesWithOffsets(text);
  const warnings: LintWarning[] = [];

  let streak: Array<{ sentence: string; start: number; end: number }> = [];
  let currentNormalized: string | null = null;

  const flush = () => {
    if (streak.length >= rule.maxRepeat && currentNormalized !== null) {
      const first = streak[0];
      const last = streak[streak.length - 1];
      warnings.push({
        ruleId: rule.id,
        kind: "ending_repetition",
        message:
          rule.message ??
          `${rule.description ?? "同一の文末パターン"}が${streak.length}文連続しています。`,
        offset: first.start,
        length: last.end - first.start,
        excerpt: streak.map((s) => s.sentence).join(""),
      });
    }
    streak = [];
    currentNormalized = null;
  };

  for (const entry of sentences) {
    if (isDialogue(entry.sentence)) {
      flush();
      continue;
    }
    const ending = extractEnding(entry.sentence);
    if (ending === null) {
      flush();
      continue;
    }
    const normalized = normalizeEnding(ending);

    if (normalized === currentNormalized) {
      streak.push(entry);
    } else {
      flush();
      streak = [entry];
      currentNormalized = normalized;
    }
  }
  flush();

  return warnings;
}

function evaluateNarrationForbiddenMarksRule(
  text: string,
  rule: NarrationForbiddenMarksRule,
): LintWarning[] {
  const warnings: LintWarning[] = [];

  for (const { sentence, start } of splitIntoSentencesWithOffsets(text)) {
    if (isDialogue(sentence)) continue;

    for (const mark of rule.forbiddenMarks) {
      let index = sentence.indexOf(mark);
      while (index !== -1) {
        warnings.push({
          ruleId: rule.id,
          kind: "narration_forbidden_marks",
          message:
            rule.message ?? `${rule.description ?? "地の文で禁止されたマーク"}が使われています。`,
          offset: start + index,
          length: mark.length,
          excerpt: mark,
        });
        index = sentence.indexOf(mark, index + mark.length);
      }
    }
  }

  return warnings;
}

/**
 * 本文に対して与えられたリントルールを評価し、検知した警告を文字オフセット付きで返す純粋関数。
 * ファイルI/Oを行わない（ルールは呼び出し側がconfigLoaderなどから渡す）。
 */
export function evaluateLintRules(text: string, rules: LintRule[]): LintWarning[] {
  const warnings: LintWarning[] = [];

  for (const rule of rules) {
    if (isRegexSequenceRule(rule)) {
      warnings.push(...evaluateRegexSequenceRule(text, rule));
    } else if (isLineSpacingRule(rule)) {
      warnings.push(...evaluateLineSpacingRule(text, rule));
    } else if (isSentenceLengthRule(rule)) {
      warnings.push(...evaluateSentenceLengthRule(text, rule));
    } else if (isPunctuationCountRule(rule)) {
      warnings.push(...evaluatePunctuationCountRule(text, rule));
    } else if (isEndingRepetitionRule(rule)) {
      warnings.push(...evaluateEndingRepetitionRule(text, rule));
    } else if (isNarrationForbiddenMarksRule(rule)) {
      warnings.push(...evaluateNarrationForbiddenMarksRule(text, rule));
    }
  }

  return warnings.sort((a, b) => a.offset - b.offset);
}
