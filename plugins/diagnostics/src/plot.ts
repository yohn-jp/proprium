import YAML from "yaml";

export interface PlotToken {
  start: number;
  end: number;
  surface: string;
  base?: string;
  pos: string;
  sentenceIndex?: number;
}

export interface PlotArchetype {
  goalKeywords: Record<string, number>;
  violationKeywords?: Record<string, number>;
  violationThreshold?: number;
}

export interface PlotLexicon { archetypes: Record<string, PlotArchetype> }

export const DEFAULT_PLOT_LEXICON: PlotLexicon = {
  archetypes: {
    concealment: {
      goalKeywords: { "隠す": 1, "秘密": 1, "秘匿": 1.2, "隠匿": 1.2, "伏せる": 1, "黙る": 0.8, "隠蔽": 1.2 },
      violationKeywords: { "正体": 1, "真相": 1, "種明かし": 1.2, "白状": 1, "暴露": 1.2, "実は": 0.6, "本当は": 0.6 },
      violationThreshold: 0.03,
    },
  },
};

export const PLOT_CONFIG_PATHS = [
  "meta/scriptorium/modules/diagnostics/plot-lexicon.yaml",
  "meta/plot-lexicon.yaml",
] as const;

const MAX_ARCHETYPES = 128;
const MAX_TERMS = 2048;
const DEFAULT_VIOLATION_THRESHOLD = 0.03;
const DIVERGENCE_SIMILARITY_THRESHOLD = 0.05;
const MIN_GOAL_CONTENT_WORDS = 3;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}

function parseWeights(value: unknown, label: string): Record<string, number> {
  const raw = record(value, label);
  const entries = Object.entries(raw);
  if (entries.length > MAX_TERMS) throw new TypeError(`${label} exceeds ${MAX_TERMS} terms`);
  const weights: Record<string, number> = {};
  for (const [term, weight] of entries) {
    if (!term || term.length > 256 || typeof weight !== "number" || !Number.isFinite(weight) || Math.abs(weight) > 1_000_000) {
      throw new TypeError(`${label}.${term} must have a bounded finite weight`);
    }
    weights[term] = weight;
  }
  return weights;
}

export function parsePlotLexicon(text: string): PlotLexicon {
  const document = YAML.parseDocument(text, { strict: true, uniqueKeys: true });
  if (document.errors.length) throw new TypeError(document.errors[0].message);
  const root = record(document.toJS({ maxAliasCount: 100 }), "plot lexicon");
  const raw = record(root.archetypes, "plot lexicon.archetypes");
  const entries = Object.entries(raw);
  if (entries.length > MAX_ARCHETYPES) throw new TypeError(`archetypes exceeds ${MAX_ARCHETYPES} entries`);
  const archetypes: Record<string, PlotArchetype> = {};
  for (const [name, value] of entries) {
    if (!name || name.length > 128) throw new TypeError("archetype names must be nonempty and bounded");
    const item = record(value, `archetypes.${name}`);
    const goalKeywords = parseWeights(item.goalKeywords, `${name}.goalKeywords`);
    const violationKeywords = item.violationKeywords === undefined ? undefined : parseWeights(item.violationKeywords, `${name}.violationKeywords`);
    const threshold = item.violationThreshold;
    if (threshold !== undefined && (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1_000_000)) {
      throw new TypeError(`${name}.violationThreshold must be a finite nonnegative number`);
    }
    archetypes[name] = { goalKeywords, ...(violationKeywords ? { violationKeywords } : {}), ...(typeof threshold === "number" ? { violationThreshold: threshold } : {}) };
  }
  return Object.keys(archetypes).length ? { archetypes } : DEFAULT_PLOT_LEXICON;
}

export interface PlotEvidence {
  source: "goal" | "manuscript";
  path: string;
  revision: string;
  start: number;
  end: number;
  quote: string;
}

export interface PlotWarning {
  kind: "contradiction" | "divergence";
  basis: "statistical";
  signal: "weak_lexical";
  archetype?: string;
  violationDensity?: number;
  similarity?: number;
  message: string;
  evidence: PlotEvidence[];
}

function tokenKey(token: PlotToken): string { return token.base ?? token.surface; }
function isContentWord(token: PlotToken): boolean {
  return token.pos === "名詞" || token.pos === "動詞" || token.pos === "形容詞" || token.pos === "形容動詞" || token.pos === "副詞";
}

function weightedDensity(tokens: PlotToken[], weights: Record<string, number>): number {
  if (tokens.length === 0) return 0;
  let sum = 0;
  for (const token of tokens) sum += weights[tokenKey(token)] ?? weights[token.surface] ?? 0;
  return sum / tokens.length;
}

function dominantArchetype(tokens: PlotToken[], lexicon: PlotLexicon): string | undefined {
  let name: string | undefined;
  let maximum = 0;
  for (const [candidate, archetype] of Object.entries(lexicon.archetypes)) {
    const density = weightedDensity(tokens, archetype.goalKeywords);
    if (density > maximum) { maximum = density; name = candidate; }
  }
  return name;
}

function tokenEvidence(tokens: PlotToken[], text: string, path: string, revision: string, source: PlotEvidence["source"], weights?: Record<string, number>): PlotEvidence[] {
  const rows: PlotEvidence[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const weight = weights?.[tokenKey(token)] ?? weights?.[token.surface];
    if ((weights && weight === undefined) || token.start < 0 || token.end <= token.start || token.end > text.length || text.slice(token.start, token.end) !== token.surface) continue;
    const identity = `${token.start}:${token.end}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    rows.push({ source, path, revision, start: token.start, end: token.end, quote: token.surface });
    if (rows.length === 12) break;
  }
  return rows;
}

function contentVector(tokens: PlotToken[]): Map<string, number> {
  const vector = new Map<string, number>();
  for (const token of tokens) if (isContentWord(token)) {
    const key = tokenKey(token);
    vector.set(key, (vector.get(key) ?? 0) + 1);
  }
  return vector;
}

function cosineSimilarity(left: Map<string, number>, right: Map<string, number>): number {
  if (!left.size || !right.size) return 0;
  let dot = 0;
  for (const [term, a] of left) dot += a * (right.get(term) ?? 0);
  const normA = Math.sqrt([...left.values()].reduce((sum, value) => sum + value * value, 0));
  const normB = Math.sqrt([...right.values()].reduce((sum, value) => sum + value * value, 0));
  return normA === 0 || normB === 0 ? 0 : dot / (normA * normB);
}

/** Pinned Scriptorium plot-goal thresholds/algorithm with source-paired lexical evidence. */
export function analyzePlotGoal(input: {
  goalTokens: PlotToken[];
  bodyTokens: PlotToken[];
  bodyText: string;
  goalText: string;
  manuscriptPath: string;
  manuscriptRevision: string;
  goalPath: string;
  goalRevision: string;
  lexicon: PlotLexicon;
}): PlotWarning[] {
  const warnings: PlotWarning[] = [];
  const archetypeName = dominantArchetype(input.goalTokens, input.lexicon);
  if (archetypeName) {
    const archetype = input.lexicon.archetypes[archetypeName];
    if (archetype.violationKeywords) {
      const violationDensity = weightedDensity(input.bodyTokens, archetype.violationKeywords);
      const threshold = archetype.violationThreshold ?? DEFAULT_VIOLATION_THRESHOLD;
      if (violationDensity >= threshold) {
        const goalEvidence = tokenEvidence(input.goalTokens, input.goalText, input.goalPath, input.goalRevision, "goal", archetype.goalKeywords);
        const bodyEvidence = tokenEvidence(input.bodyTokens, input.bodyText, input.manuscriptPath, input.manuscriptRevision, "manuscript", archetype.violationKeywords);
        warnings.push({
          kind: "contradiction", basis: "statistical", signal: "weak_lexical", archetype: archetypeName,
          violationDensity, message: `Scene goal matched the ${archetypeName} lexical archetype; conflicting terms have density ${violationDensity.toFixed(3)}. This is a weak lexical signal, not an entity-state contradiction.`,
          evidence: [...goalEvidence, ...bodyEvidence],
        });
      }
    }
  }

  const goalVector = contentVector(input.goalTokens);
  if (goalVector.size >= MIN_GOAL_CONTENT_WORDS) {
    const similarity = cosineSimilarity(goalVector, contentVector(input.bodyTokens));
    if (similarity < DIVERGENCE_SIMILARITY_THRESHOLD) {
      warnings.push({
        kind: "divergence", basis: "statistical", signal: "weak_lexical", similarity,
        message: `Scene goal/conflict has little lexical overlap with the manuscript (cosine similarity ${similarity.toFixed(3)}); this weak signal does not establish a semantic mismatch.`,
        evidence: [
          ...tokenEvidence(input.goalTokens.filter(isContentWord), input.goalText, input.goalPath, input.goalRevision, "goal").slice(0, 12),
          ...tokenEvidence(input.bodyTokens.filter(isContentWord), input.bodyText, input.manuscriptPath, input.manuscriptRevision, "manuscript").slice(0, 12),
        ],
      });
    }
  }
  return warnings;
}
