export type LintRuleKind = "regex_sequence" | "line_spacing" | "sentence_length" | "punctuation_count" | "ending_repetition" | "narration_forbidden_marks";
export interface RegexSequenceRule { id: string; kind: "regex_sequence"; description?: string; pattern: string; flags?: string; replacement: string; message?: string }
export interface LineSpacingRule { id: string; kind: "line_spacing"; description?: string; startPattern: string; flags?: string; message?: string }
export interface SentenceLengthRule { id: string; kind: "sentence_length"; description?: string; maxLength: number; message?: string }
export interface PunctuationCountRule { id: string; kind: "punctuation_count"; description?: string; maxCount: number; message?: string }
export interface EndingRepetitionRule { id: string; kind: "ending_repetition"; description?: string; maxRepeat: number; message?: string }
export interface NarrationForbiddenMarksRule { id: string; kind: "narration_forbidden_marks"; description?: string; forbiddenMarks: string[]; message?: string }
export type LintRule = RegexSequenceRule | LineSpacingRule | SentenceLengthRule | PunctuationCountRule | EndingRepetitionRule | NarrationForbiddenMarksRule;
export interface LintWarning { ruleId: string; kind: LintRuleKind; message: string; offset: number; length: number; excerpt?: string }
export interface CountSeverityThresholds { infoMin: number; mediumMin: number }
export interface DiagnosticSeverityThresholds { rhythm?: Partial<CountSeverityThresholds>; habitualPhrase?: Partial<CountSeverityThresholds> }
export interface LintRulesConfig { rules: LintRule[]; severity?: DiagnosticSeverityThresholds }

export const DEFAULT_DIAGNOSTIC_SEVERITY_THRESHOLDS = {
  rhythm: { infoMin: 3, mediumMin: 5 },
  habitualPhrase: { infoMin: 2, mediumMin: 4 },
};

/** Exact source defaults retained for projects without `meta/lint-rules.yaml`. */
export const DEFAULT_LINT_RULES: LintRule[] = [
  {
    id: "ellipsis-single-piece",
    kind: "regex_sequence",
    description: "三点リーダー（…）は2つ連続させて使う慣習。1つだけの使用を検知する。",
    pattern: "(?<!…)…(?!…)",
    flags: "u",
    replacement: "……",
    message: "三点リーダー（…）が1つだけ使われています。2つ連続させてください。",
  },
  {
    id: "dialogue-blank-line",
    kind: "line_spacing",
    description: "会話文（「」『』で始まる行）の前後に空行を1行入れる。",
    startPattern: "^[「『]",
    message: "会話文の前後に空行がありません。",
  },
];
