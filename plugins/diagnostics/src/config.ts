import YAML from "yaml";
import { DEFAULT_LINT_RULES, type LintRule } from "./core.js";

export const LINT_CONFIG_PATHS = [
  "meta/scriptorium/modules/diagnostics/lint-rules.yaml",
  "meta/lint-rules.yaml",
] as const;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}
function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value || value.length > max) throw new TypeError(`${label} must be a nonempty string of at most ${max} characters`);
  return value;
}
function int(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new TypeError(`${label} must be an integer from ${min} through ${max}`);
  return value as number;
}
function compileRegex(pattern: string, flags: string, label: string): void {
  if (/[gy]/u.test(flags.replace(/g/gu, ""))) throw new TypeError(`${label} flags may not contain sticky mode`);
  try { new RegExp(pattern, flags); } catch (error) { throw new TypeError(`${label} is invalid: ${error instanceof Error ? error.message : "regex syntax error"}`); }
}
function rule(value: unknown, index: number): LintRule {
  const item = record(value, `rules[${index}]`);
  const id = boundedString(item.id, `rules[${index}].id`, 128);
  const kind = boundedString(item.kind, `rules[${index}].kind`, 64);
  const message = item.message === undefined ? undefined : boundedString(item.message, `rules[${index}].message`, 1000);
  if (kind === "regex_sequence") {
    const pattern = boundedString(item.pattern, `rules[${index}].pattern`, 2048);
    const replacement = typeof item.replacement === "string" && item.replacement.length <= 2048 ? item.replacement : (() => { throw new TypeError(`rules[${index}].replacement must be a string of at most 2048 characters`); })();
    const flags = item.flags === undefined ? undefined : boundedString(item.flags, `rules[${index}].flags`, 8);
    compileRegex(pattern, flags ?? "", `rules[${index}].pattern`);
    return { id, kind, pattern, replacement, ...(flags === undefined ? {} : { flags }), ...(message === undefined ? {} : { message }) };
  }
  if (kind === "line_spacing") {
    const startPattern = boundedString(item.startPattern, `rules[${index}].startPattern`, 2048);
    const flags = item.flags === undefined ? undefined : boundedString(item.flags, `rules[${index}].flags`, 8);
    compileRegex(startPattern, flags ?? "", `rules[${index}].startPattern`);
    return { id, kind, startPattern, ...(flags === undefined ? {} : { flags }), ...(message === undefined ? {} : { message }) };
  }
  if (kind === "sentence_length") return { id, kind, maxLength: int(item.maxLength, `rules[${index}].maxLength`, 1, 500_000), ...(message === undefined ? {} : { message }) };
  if (kind === "punctuation_count") return { id, kind, maxCount: int(item.maxCount, `rules[${index}].maxCount`, 0, 10_000), ...(message === undefined ? {} : { message }) };
  if (kind === "ending_repetition") return { id, kind, maxRepeat: int(item.maxRepeat, `rules[${index}].maxRepeat`, 2, 10_000), ...(message === undefined ? {} : { message }) };
  if (kind === "narration_forbidden_marks") {
    if (!Array.isArray(item.forbiddenMarks) || item.forbiddenMarks.length < 1 || item.forbiddenMarks.length > 64) throw new TypeError(`rules[${index}].forbiddenMarks must contain 1 through 64 strings`);
    const forbiddenMarks = item.forbiddenMarks.map((mark, markIndex) => boundedString(mark, `rules[${index}].forbiddenMarks[${markIndex}]`, 32));
    return { id, kind, forbiddenMarks, ...(message === undefined ? {} : { message }) };
  }
  throw new TypeError(`rules[${index}].kind is unsupported: ${kind}`);
}

export function parseLintRulesConfig(text: string): LintRule[] {
  let document: ReturnType<typeof YAML.parseDocument>;
  try { document = YAML.parseDocument(text, { strict: true, uniqueKeys: true }); }
  catch (error) { throw new TypeError(error instanceof Error ? error.message : "Invalid YAML"); }
  if (document.errors.length) throw new TypeError(document.errors[0].message);
  const raw = document.toJS({ maxAliasCount: 100 });
  const root = record(raw, "lint configuration");
  if (root.rules === undefined) return [...DEFAULT_LINT_RULES];
  if (!Array.isArray(root.rules) || root.rules.length > 128) throw new TypeError("rules must be an array of at most 128 entries");
  const rules = root.rules.map(rule);
  if (new Set(rules.map((item) => item.id)).size !== rules.length) throw new TypeError("rule IDs must be unique");
  return rules.length ? rules : [...DEFAULT_LINT_RULES];
}
