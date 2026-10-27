import { normalizeUnicode } from "../../shared/unicode.js";
/** Pure source-preserving diagnostics primitives ported from the pinned Scriptorium source.
 * This module has no access to workspace storage, browser state or the network. */

export type RuleKind = "regex_sequence" | "line_spacing" | "sentence_length" | "punctuation_count" | "ending_repetition" | "narration_forbidden_marks";
export type LintRule =
  | { id: string; kind: "regex_sequence"; pattern: string; flags?: string; replacement: string; message?: string }
  | { id: string; kind: "line_spacing"; startPattern: string; flags?: string; message?: string }
  | { id: string; kind: "sentence_length"; maxLength: number; message?: string }
  | { id: string; kind: "punctuation_count"; maxCount: number; message?: string }
  | { id: string; kind: "ending_repetition"; maxRepeat: number; message?: string }
  | { id: string; kind: "narration_forbidden_marks"; forbiddenMarks: string[]; message?: string };

export interface LintWarning {
  ruleId: string;
  kind: RuleKind;
  message: string;
  offset: number;
  length: number;
  excerpt: string;
}

export interface RhythmWarning {
  ending: string;
  count: number;
  startSentenceIndex: number;
}

export interface TextAnalysisResult {
  textHash: string;
  charCount: number;
  sentenceCount: number;
  rhythmWarnings: RhythmWarning[];
  lintWarnings: LintWarning[];
  /** Lexical and sentiment results require Research's shared snapshot-scoped provider. */
  providers: { lexical: "unavailable" };
  frequentNouns: [];
  unknownTermCandidates: [];
  termVariantSuggestions: [];
  frequentPhrases: [];
  sentimentArc: null;
  toneWarnings: [];
  habitualPhraseWarnings: [];
  proseBalance: null;
}

export interface FindingContext {
  workspaceId: string;
  repositoryId: number | null;
  branch: string;
  generation: string;
  snapshotId: string;
  documentPath?: string;
  documentRevision?: string;
  draftGeneration?: string;
  configRevision?: string;
}

export interface DiagnosticFinding {
  fingerprint: string;
  class: "format" | "statistical";
  kind: RuleKind | "rhythm";
  severity: "warning";
  basis: "deterministic";
  message: string;
  analyzer_id: "proprium.diagnostics.cpu";
  analyzer_version: "1.0.0";
  source_path?: string;
  source_revision?: string;
  text_hash: string;
  range: { start: number; end: number };
  quote: string;
  evidence: Array<{ path?: string; revision?: string; text_hash: string; start: number; end: number; quote: string }>;
  sourceIdentity: Record<string, unknown>;
}

export const DEFAULT_LINT_RULES: LintRule[] = [
  { id: "ellipsis-single-piece", kind: "regex_sequence", pattern: "(?<!…)…(?!…)", flags: "u", replacement: "……", message: "三点リーダー（…）が1つだけ使われています。2つ連続させてください。" },
  { id: "dialogue-blank-line", kind: "line_spacing", startPattern: "^[「『]", message: "会話文の前後に空行がありません。" },
];

interface Span { start: number; end: number; text: string }

/** Match source NLP sentence boundaries, retaining UTF-16 offsets into the unchanged body. */
function sentenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      offset += 1;
      continue;
    }
    const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter("ja", { granularity: "sentence" })
      : undefined;
    if (segmenter) {
      for (const entry of segmenter.segment(line)) {
        const start = offset + entry.index;
        const end = start + entry.segment.length;
        spans.push({ start, end, text: entry.segment });
      }
    } else {
      // Small-runtime fallback uses the source punctuation boundary set while respecting quotes.
      let start = 0;
      let quoteDepth = 0;
      for (let index = 0; index < line.length; index++) {
        const char = line[index];
        if (char === "「" || char === "『") quoteDepth++;
        else if (char === "」" || char === "』") quoteDepth = Math.max(0, quoteDepth - 1);
        if (quoteDepth === 0 && (char === "。" || char === "！" || char === "？" || char === "!" || char === "?")) {
          spans.push({ start: offset + start, end: offset + index + 1, text: line.slice(start, index + 1) });
          start = index + 1;
        }
      }
      if (start < line.length) spans.push({ start: offset + start, end: offset + line.length, text: line.slice(start) });
    }
    offset += line.length + 1;
  }
  return spans.filter((span) => span.text.trim() !== "");
}

function isDialogue(text: string): boolean { return /^[「『]/u.test(text.trim()); }
function ending(text: string): string | undefined {
  const body = text.replace(/[。！？」』]+$/u, "").trim();
  return body ? body.slice(-1) : undefined;
}
function normalizedEnding(value: string): string {
  return normalizeUnicode(normalizeUnicode(value, "NFD").replace(/[゙゚]/gu, ""), "NFC");
}
function globalRegex(pattern: string, flags = ""): RegExp {
  if (/[gy]/u.test(flags.replace(/g/gu, ""))) throw new TypeError("Lint regex flags may not contain sticky mode");
  return new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
}
function validateRule(rule: LintRule): void {
  if (!rule || typeof rule.id !== "string" || rule.id.length === 0) throw new TypeError("Lint rule requires an id");
  switch (rule.kind) {
    case "regex_sequence": globalRegex(rule.pattern, rule.flags); return;
    case "line_spacing": new RegExp(rule.startPattern, rule.flags ?? ""); return;
    case "sentence_length": if (!Number.isSafeInteger(rule.maxLength) || rule.maxLength < 1) throw new TypeError(`${rule.id}.maxLength must be a positive integer`); return;
    case "punctuation_count": if (!Number.isSafeInteger(rule.maxCount) || rule.maxCount < 0) throw new TypeError(`${rule.id}.maxCount must be a nonnegative integer`); return;
    case "ending_repetition": if (!Number.isSafeInteger(rule.maxRepeat) || rule.maxRepeat < 2) throw new TypeError(`${rule.id}.maxRepeat must be at least two`); return;
    case "narration_forbidden_marks": if (rule.forbiddenMarks.length === 0 || rule.forbiddenMarks.some((mark) => !mark)) throw new TypeError(`${rule.id}.forbiddenMarks must be nonempty`); return;
    default: throw new TypeError("Unsupported lint rule");
  }
}

/** Evaluate all six canonical deterministic lint rule kinds. Offsets are UTF-16 half-open. */
export function lintText(text: string, rules: readonly LintRule[] = DEFAULT_LINT_RULES): LintWarning[] {
  const warnings: LintWarning[] = [];
  const sentences = sentenceSpans(text);
  for (const rule of rules) {
    validateRule(rule);
    switch (rule.kind) {
      case "regex_sequence": {
        for (const match of text.matchAll(globalRegex(rule.pattern, rule.flags))) {
          if (match.index === undefined) continue;
          warnings.push({ ruleId: rule.id, kind: rule.kind, message: rule.message ?? `Matched ${rule.id}`, offset: match.index, length: match[0].length, excerpt: match[0] });
        }
        break;
      }
      case "line_spacing": {
        const matcher = new RegExp(rule.startPattern, rule.flags ?? "");
        let offset = 0;
        const lines = text.split("\n");
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          if (line.trim() && matcher.test(line.trim())) {
            if (index > 0 && lines[index - 1].trim()) warnings.push({ ruleId: rule.id, kind: rule.kind, message: rule.message ?? "対象行の前に空行がありません。", offset, length: 0, excerpt: line });
            if (index < lines.length - 1 && lines[index + 1].trim()) warnings.push({ ruleId: rule.id, kind: rule.kind, message: rule.message ?? "対象行の後に空行がありません。", offset: offset + line.length, length: 0, excerpt: line });
          }
          offset += line.length + 1;
        }
        break;
      }
      case "sentence_length":
        for (const span of sentences) if (span.text.trim().length > rule.maxLength) warnings.push({ ruleId: rule.id, kind: rule.kind, message: rule.message ?? `一文が${rule.maxLength}字を超えています（${span.text.trim().length}字）。`, offset: span.start, length: span.end - span.start, excerpt: span.text });
        break;
      case "punctuation_count":
        for (const span of sentences) {
          if (isDialogue(span.text)) continue;
          const count = span.text.match(/、/gu)?.length ?? 0;
          if (count > rule.maxCount) warnings.push({ ruleId: rule.id, kind: rule.kind, message: rule.message ?? `一文中の読点が${rule.maxCount}個を超えています（${count}個）。`, offset: span.start, length: span.end - span.start, excerpt: span.text });
        }
        break;
      case "ending_repetition": {
        let streak: Span[] = [];
        let current: string | undefined;
        const flush = () => {
          if (streak.length >= rule.maxRepeat && current !== undefined) {
            const first = streak[0];
            const last = streak[streak.length - 1];
            warnings.push({ ruleId: rule.id, kind: rule.kind, message: rule.message ?? `同一の文末パターンが${streak.length}文連続しています。`, offset: first.start, length: last.end - first.start, excerpt: streak.map((span) => span.text).join("") });
          }
          streak = [];
          current = undefined;
        };
        for (const span of sentences) {
          const value = ending(span.text);
          if (isDialogue(span.text) || value === undefined) { flush(); continue; }
          const normalized = normalizedEnding(value);
          if (normalized === current) streak.push(span);
          else { flush(); streak = [span]; current = normalized; }
        }
        flush();
        break;
      }
      case "narration_forbidden_marks":
        for (const span of sentences) {
          if (isDialogue(span.text)) continue;
          for (const mark of rule.forbiddenMarks) {
            let index = span.text.indexOf(mark);
            while (index >= 0) {
              warnings.push({ ruleId: rule.id, kind: rule.kind, message: rule.message ?? "地の文で禁止されたマークが使われています。", offset: span.start + index, length: mark.length, excerpt: mark });
              index = span.text.indexOf(mark, index + mark.length);
            }
          }
        }
    }
  }
  return warnings.sort((a, b) => a.offset - b.offset || a.ruleId.localeCompare(b.ruleId));
}

/** Source `textTransformer` behavior. The returned text is only a local preview. */
export function transformText(text: string, rules: readonly LintRule[] = DEFAULT_LINT_RULES): string {
  for (const rule of rules) validateRule(rule);
  let result = text;
  for (const rule of rules) if (rule.kind === "regex_sequence") {
    const flags = rule.flags ?? "";
    result = result.replace(new RegExp(rule.pattern, flags.includes("g") ? flags : `${flags}g`), rule.replacement);
  }
  const lineRules = rules.filter((rule): rule is Extract<LintRule, { kind: "line_spacing" }> => rule.kind === "line_spacing");
  const lineEnding = result.includes("\r\n") ? "\r\n" : "\n";
  const lines = result.split(/\r?\n/u);
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const isBlockStart = line.trim() !== "" && lineRules.some((rule) => new RegExp(rule.startPattern, (rule.flags ?? "").replace(/g/gu, "")).test(line.trim()));
    if (isBlockStart && out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(line);
    const next = lines[index + 1];
    if (isBlockStart && next !== undefined && next.trim() !== "") out.push("");
  }
  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of out) {
    if (line.trim() === "") {
      if (++blankRun <= 1) collapsed.push(line);
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }
  while (collapsed.length > 0 && collapsed[0].trim() === "") collapsed.shift();
  while (collapsed.length > 0 && collapsed[collapsed.length - 1].trim() === "") collapsed.pop();
  return collapsed.join(lineEnding);
}

/** Source `detectRhythmWarnings` contract, returning one-based sentence indexes. */
export function detectRhythmWarnings(text: string): RhythmWarning[] {
  const warnings: RhythmWarning[] = [];
  let current: string | undefined;
  let displayedEnding: string | undefined;
  let count = 0;
  let startSentenceIndex = 0;
  const flush = () => {
    if (count >= 3 && displayedEnding !== undefined) warnings.push({ ending: displayedEnding, count, startSentenceIndex });
    current = undefined;
    displayedEnding = undefined;
    count = 0;
  };
  const sentences = sentenceSpans(text);
  for (let index = 0; index < sentences.length; index++) {
    const sentence = sentences[index].text;
    const value = ending(sentence);
    if (isDialogue(sentence) || value === undefined) { flush(); continue; }
    const normalized = normalizedEnding(value);
    if (normalized === current) count++;
    else {
      flush();
      current = normalized;
      displayedEnding = value;
      count = 1;
      startSentenceIndex = index + 1;
    }
  }
  flush();
  return warnings;
}

/** Provider-free portion of the canonical text.analyze action. Missing Research is explicit. */
export function analyzeText(text: string, rules: readonly LintRule[] = DEFAULT_LINT_RULES): TextAnalysisResult {
  if (Array.from(text).length > 500_000) throw new RangeError("Text exceeds the 500,000 code-point diagnostics limit");
  const body = text.slice(bodyOffset(text));
  const sentences = sentenceSpans(body);
  return {
    textHash: sha256(body),
    charCount: body.length,
    sentenceCount: sentences.length,
    rhythmWarnings: detectRhythmWarnings(body),
    lintWarnings: lintText(body, rules),
    providers: { lexical: "unavailable" },
    frequentNouns: [],
    unknownTermCandidates: [],
    termVariantSuggestions: [],
    frequentPhrases: [],
    sentimentArc: null,
    toneWarnings: [],
    habitualPhraseWarnings: [],
    proseBalance: null,
  };
}

interface FrontmatterParts { prefix: string; body: string; lineEnding: "\n" | "\r\n" }
function splitFrontmatter(text: string): FrontmatterParts {
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const firstLineEnd = text.indexOf("\n");
  if (firstLineEnd < 0 || text.slice(0, firstLineEnd).replace(/\r$/u, "").replace(/^\uFEFF/u, "") !== "---") return { prefix: "", body: text, lineEnding };
  let cursor = firstLineEnd + 1;
  while (cursor <= text.length) {
    const nextLineEnd = text.indexOf("\n", cursor);
    const contentEnd = nextLineEnd < 0 ? text.length : nextLineEnd;
    const line = text.slice(cursor, contentEnd).replace(/\r$/u, "");
    if (line === "---" || line === "...") {
      const prefixEnd = nextLineEnd < 0 ? contentEnd : nextLineEnd + 1;
      const prefix = text.slice(0, prefixEnd);
      return { prefix, body: text.slice(prefixEnd), lineEnding };
    }
    if (nextLineEnd < 0) break;
    cursor = nextLineEnd + 1;
  }
  return { prefix: "", body: text, lineEnding };
}

function transformBody(body: string, lineEnding: string): string {
  let result = body.replace(/(?<!…)…(?!…)/gu, "……");
  const lines = result.split(/\r?\n/u);
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const isDialogueStart = /^[「『]/u.test(line.trim());
    if (isDialogueStart && out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(line.replace(/^[ \t　]+/u, ""));
    const next = lines[index + 1];
    if (isDialogueStart && next !== undefined && next.trim() !== "") out.push("");
  }
  const collapsed: string[] = [];
  let blanks = 0;
  for (const line of out) {
    if (line.trim() === "") { if (++blanks <= 1) collapsed.push(line); }
    else { blanks = 0; collapsed.push(line); }
  }
  while (collapsed.length && collapsed[0].trim() === "") collapsed.shift();
  while (collapsed.length && collapsed[collapsed.length - 1].trim() === "") collapsed.pop();
  return collapsed.join(lineEnding);
}

/** Port of the pinned manuscript formatter. Frontmatter is copied byte-for-byte. */
export function formatManuscript(text: string): { text: string; frontmatterPreserved: boolean; changed: boolean } {
  const parts = splitFrontmatter(text);
  const formattedBody = transformBody(parts.body, parts.lineEnding);
  const formatted = parts.prefix + formattedBody;
  return { text: formatted, frontmatterPreserved: text.slice(0, parts.prefix.length) === formatted.slice(0, parts.prefix.length), changed: formatted !== text };
}

export function bodyOffset(text: string): number {
  return splitFrontmatter(text).prefix.length;
}

/** SHA-256 over UTF-8 bytes for source text identity and stable finding fingerprints. */
export function sha256(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const words = new Uint32Array(64);
  const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index++) {
      const x = words[index - 15], y = words[index - 2];
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let index = 0; index < 64; index++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + choice + k[index] + words[index]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;
    h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+hh)>>>0;
  }
  return h.map((value) => value.toString(16).padStart(8, "0")).join("");
}

export interface FindingIdentityInput {
  workspaceId?: string;
  repositoryId?: number | null;
  branch?: string;
  generation?: string;
  snapshotId?: string;
  actionId: string;
  analyzerVersion: string;
  sourcePath: string;
  sourceRevision: string;
  textHash?: string;
  kind: string;
  ruleId: string;
  start?: number;
  end?: number;
  quote?: string;
}
export function findingFingerprint(value: FindingIdentityInput): string {
  const canonical = JSON.stringify([value.workspaceId ?? null, value.repositoryId ?? null, value.branch ?? null, value.generation ?? null, value.snapshotId ?? null, value.actionId, value.analyzerVersion, value.sourcePath, value.sourceRevision, value.textHash ?? null, value.kind, value.ruleId, value.start ?? null, value.end ?? null, value.quote ?? null]);
  return sha256(canonical);
}

export function findingsForTextAnalysis(text: string, result: TextAnalysisResult, context: FindingContext): DiagnosticFinding[] {
  const sourcePath = context.documentPath;
  const sourceRevision = context.documentRevision;
  const findings: DiagnosticFinding[] = [];
  const add = (kind: RuleKind | "rhythm", className: DiagnosticFinding["class"], ruleId: string, start: number, end: number, quote: string, message: string) => {
    const fingerprint = findingFingerprint({
      workspaceId: context.workspaceId,
      repositoryId: context.repositoryId,
      branch: context.branch,
      generation: context.generation,
      snapshotId: context.snapshotId,
      actionId: "proprium.diagnostics.text.analyze.v1",
      analyzerVersion: "1.0.0",
      sourcePath: sourcePath ?? `input:${result.textHash}`,
      sourceRevision: sourceRevision ?? result.textHash,
      textHash: result.textHash,
      kind,
      ruleId,
      start,
      end,
      quote,
    });
    const evidence = [{ ...(sourcePath ? { path: sourcePath } : {}), ...(sourceRevision ? { revision: sourceRevision } : {}), text_hash: result.textHash, start, end, quote }];
    findings.push({
      fingerprint,
      class: className,
      kind,
      severity: "warning",
      basis: "deterministic",
      message,
      analyzer_id: "proprium.diagnostics.cpu",
      analyzer_version: "1.0.0",
      ...(sourcePath ? { source_path: sourcePath } : {}),
      ...(sourceRevision ? { source_revision: sourceRevision } : {}),
      text_hash: result.textHash,
      range: { start, end },
      quote,
      evidence,
      sourceIdentity: {
        actionId: "proprium.diagnostics.text.analyze.v1",
        repositoryId: context.repositoryId,
        branch: context.branch,
        generation: context.generation,
        snapshot: context.snapshotId,
        findingFingerprint: fingerprint,
        analyzer: { id: "proprium.diagnostics.cpu", version: "1.0.0" },
        sources: sourcePath && sourceRevision ? [{ path: sourcePath, fileRevision: sourceRevision, textHash: result.textHash, span: { start, end }, quote }] : [],
        ...(context.configRevision ? { configRevisions: { lint: context.configRevision } } : {}),
        ...(context.draftGeneration ? { draftGeneration: context.draftGeneration } : {}),
      },
    });
  };
  const bodyOrigin = bodyOffset(text);
  for (const warning of result.lintWarnings) add(warning.kind, "format", warning.ruleId, warning.offset, warning.offset + warning.length, warning.excerpt, warning.message);
  const sentences = sentenceSpans(text.slice(bodyOrigin));
  for (const warning of result.rhythmWarnings) {
    const startSentenceIndex = warning.startSentenceIndex - 1;
    const start = sentences[startSentenceIndex]?.start ?? 0;
    const end = sentences[startSentenceIndex + warning.count - 1]?.end ?? start;
    const quote = text.slice(bodyOrigin + start, bodyOrigin + end);
    add("rhythm", "statistical", `ending:${warning.ending}`, start, end, quote, `文末「${warning.ending}」が${warning.count}文連続しています。`);
  }
  return findings.sort((left, right) => left.class.localeCompare(right.class) || left.range.start - right.range.start || left.fingerprint.localeCompare(right.fingerprint));
}
