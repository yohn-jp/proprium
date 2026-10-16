import type { SnapshotReader } from "@scriptorium/contracts";
import YAML from "yaml";
import type { LintRule, LintRulesConfig, DiagnosticSeverityThresholds, CountSeverityThresholds } from "./linter/types.js";
import { DEFAULT_DIAGNOSTIC_SEVERITY_THRESHOLDS, DEFAULT_LINT_RULES } from "./linter/types.js";
import type { ToneLexiconConfig } from "./tone/types.js";
import { DEFAULT_TONE_LEXICON } from "./tone/types.js";
import type { PlotArchetype, PlotLexiconConfig } from "./plot/types.js";
import { DEFAULT_PLOT_LEXICON } from "./plot/types.js";

export const LINT_CONFIG_PATH = "meta/scriptorium/modules/diagnostics/lint-rules.yaml";
export const TONE_CONFIG_PATH = "meta/scriptorium/modules/diagnostics/tone-lexicon.yaml";
export const PLOT_CONFIG_PATH = "meta/scriptorium/modules/diagnostics/plot-lexicon.yaml";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}
async function readYaml(reader: SnapshotReader, path: string): Promise<unknown> {
  const file = await reader.read(path);
  if (!file) return undefined;
  try { return YAML.parse(file.content); }
  catch (error) { throw new TypeError(`${path} contains invalid YAML: ${error instanceof Error ? error.message : "parse error"}`); }
}

function validRule(value: unknown, index: number): LintRule {
  const rule = object(value, `lint rule ${index + 1}`);
  if (typeof rule.id !== "string" || !rule.id || typeof rule.kind !== "string") throw new TypeError(`lint rule ${index + 1} needs id and kind`);
  const common = { id: rule.id, kind: rule.kind as LintRule["kind"], ...(typeof rule.description === "string" ? { description: rule.description } : {}), ...(typeof rule.message === "string" ? { message: rule.message } : {}) };
  switch (rule.kind) {
    case "regex_sequence": {
      if (typeof rule.pattern !== "string" || typeof rule.replacement !== "string" || (rule.flags !== undefined && typeof rule.flags !== "string")) throw new TypeError(`lint rule ${rule.id} has invalid regex fields`);
      new RegExp(rule.pattern, `${typeof rule.flags === "string" ? rule.flags.replace(/g/g, "") : ""}g`);
      return { ...common, kind: "regex_sequence", pattern: rule.pattern, replacement: rule.replacement, ...(typeof rule.flags === "string" ? { flags: rule.flags } : {}) };
    }
    case "line_spacing": {
      if (typeof rule.startPattern !== "string" || (rule.flags !== undefined && typeof rule.flags !== "string")) throw new TypeError(`lint rule ${rule.id} has invalid line spacing fields`);
      new RegExp(rule.startPattern, typeof rule.flags === "string" ? rule.flags : "");
      return { ...common, kind: "line_spacing", startPattern: rule.startPattern, ...(typeof rule.flags === "string" ? { flags: rule.flags } : {}) };
    }
    case "sentence_length":
      if (typeof rule.maxLength !== "number" || !Number.isFinite(rule.maxLength) || rule.maxLength <= 0) throw new TypeError(`lint rule ${rule.id} has invalid maxLength`);
      return { ...common, kind: "sentence_length", maxLength: rule.maxLength };
    case "punctuation_count":
      if (typeof rule.maxCount !== "number" || !Number.isFinite(rule.maxCount) || rule.maxCount <= 0) throw new TypeError(`lint rule ${rule.id} has invalid maxCount`);
      return { ...common, kind: "punctuation_count", maxCount: rule.maxCount };
    case "ending_repetition":
      if (typeof rule.maxRepeat !== "number" || !Number.isFinite(rule.maxRepeat) || rule.maxRepeat <= 0) throw new TypeError(`lint rule ${rule.id} has invalid maxRepeat`);
      return { ...common, kind: "ending_repetition", maxRepeat: rule.maxRepeat };
    case "narration_forbidden_marks":
      if (!Array.isArray(rule.forbiddenMarks) || rule.forbiddenMarks.length === 0 || rule.forbiddenMarks.some((mark) => typeof mark !== "string" || !mark)) throw new TypeError(`lint rule ${rule.id} has invalid forbiddenMarks`);
      return { ...common, kind: "narration_forbidden_marks", forbiddenMarks: rule.forbiddenMarks as string[] };
    default: throw new TypeError(`lint rule ${rule.id} has unsupported kind`);
  }
}

function severityConfig(value: unknown): DiagnosticSeverityThresholds | undefined {
  if (value === undefined) return undefined;
  const root = object(value, "lint severity");
  const parse = (item: unknown, label: string): Partial<CountSeverityThresholds> | undefined => {
    if (item === undefined) return undefined;
    const current = object(item, label);
    const output: Partial<CountSeverityThresholds> = {};
    for (const key of ["infoMin", "mediumMin"] as const) {
      if (current[key] !== undefined) {
        if (typeof current[key] !== "number" || !Number.isFinite(current[key]) || current[key] <= 0) throw new TypeError(`${label}.${key} must be a positive number`);
        output[key] = current[key] as number;
      }
    }
    return output;
  };
  return { rhythm: parse(root.rhythm, "severity.rhythm"), habitualPhrase: parse(root.habitualPhrase, "severity.habitualPhrase") };
}

export async function loadLintRulesConfig(reader: SnapshotReader): Promise<LintRulesConfig> {
  const data = await readYaml(reader, LINT_CONFIG_PATH);
  if (data === undefined) return { rules: DEFAULT_LINT_RULES };
  const value = object(data, LINT_CONFIG_PATH);
  if (value.rules !== undefined && !Array.isArray(value.rules)) throw new TypeError(`${LINT_CONFIG_PATH}.rules must be an array`);
  const rules = (value.rules as unknown[] | undefined)?.map(validRule) ?? [];
  return { rules: rules.length ? rules : DEFAULT_LINT_RULES, severity: severityConfig(value.severity) };
}

function weightedLexicon(value: unknown, label: string): Record<string, Record<string, number>> {
  const root = object(value, label);
  const output: Record<string, Record<string, number>> = {};
  for (const [category, rawTerms] of Object.entries(root)) {
    if (!category.trim()) throw new TypeError(`${label} contains an empty category`);
    const terms = object(rawTerms, `${label}.${category}`);
    output[category] = {};
    for (const [term, weight] of Object.entries(terms)) {
      if (!term || typeof weight !== "number" || !Number.isFinite(weight)) throw new TypeError(`${label}.${category}.${term} must have a finite weight`);
      output[category][term] = weight;
    }
  }
  return output;
}

function weightedTerms(value: unknown, label: string): Record<string, number> {
  const root = object(value, label);
  const output: Record<string, number> = {};
  for (const [term, weight] of Object.entries(root)) {
    if (!term || typeof weight !== "number" || !Number.isFinite(weight)) throw new TypeError(`${label}.${term} must have a finite weight`);
    output[term] = weight;
  }
  return output;
}

export async function loadToneLexiconConfig(reader: SnapshotReader): Promise<ToneLexiconConfig> {
  const data = await readYaml(reader, TONE_CONFIG_PATH);
  if (data === undefined) return DEFAULT_TONE_LEXICON;
  const root = object(data, TONE_CONFIG_PATH);
  const tones = weightedLexicon(root.tones, `${TONE_CONFIG_PATH}.tones`);
  return Object.keys(tones).length ? { tones } : DEFAULT_TONE_LEXICON;
}

export async function loadPlotLexiconConfig(reader: SnapshotReader): Promise<PlotLexiconConfig> {
  const data = await readYaml(reader, PLOT_CONFIG_PATH);
  if (data === undefined) return DEFAULT_PLOT_LEXICON;
  const root = object(data, PLOT_CONFIG_PATH);
  const raw = object(root.archetypes, `${PLOT_CONFIG_PATH}.archetypes`);
  const archetypes: Record<string, PlotArchetype> = {};
  for (const [name, value] of Object.entries(raw)) {
    const item = object(value, `${PLOT_CONFIG_PATH}.archetypes.${name}`);
    const goalKeywords = weightedTerms(item.goalKeywords, `${name}.goalKeywords`);
    const violation = item.violationKeywords === undefined ? undefined : weightedTerms(item.violationKeywords, `${name}.violationKeywords`);
    if (item.violationThreshold !== undefined && (typeof item.violationThreshold !== "number" || !Number.isFinite(item.violationThreshold))) throw new TypeError(`${name}.violationThreshold must be finite`);
    archetypes[name] = { goalKeywords, ...(violation ? { violationKeywords: violation } : {}), ...(typeof item.violationThreshold === "number" ? { violationThreshold: item.violationThreshold } : {}) };
  }
  return Object.keys(archetypes).length ? { archetypes } : DEFAULT_PLOT_LEXICON;
}

export function resolveDiagnosticSeverityThresholds(config?: DiagnosticSeverityThresholds): { rhythm: CountSeverityThresholds; habitualPhrase: CountSeverityThresholds } {
  return {
    rhythm: {
      infoMin: config?.rhythm?.infoMin ?? DEFAULT_DIAGNOSTIC_SEVERITY_THRESHOLDS.rhythm.infoMin,
      mediumMin: config?.rhythm?.mediumMin ?? DEFAULT_DIAGNOSTIC_SEVERITY_THRESHOLDS.rhythm.mediumMin,
    },
    habitualPhrase: {
      infoMin: config?.habitualPhrase?.infoMin ?? DEFAULT_DIAGNOSTIC_SEVERITY_THRESHOLDS.habitualPhrase.infoMin,
      mediumMin: config?.habitualPhrase?.mediumMin ?? DEFAULT_DIAGNOSTIC_SEVERITY_THRESHOLDS.habitualPhrase.mediumMin,
    },
  };
}
