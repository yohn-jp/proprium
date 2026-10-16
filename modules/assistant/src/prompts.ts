import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PromptTemplate { version: string; body: string }

const promptCache = new Map<string, Promise<PromptTemplate>>();
const PROMPT_NAMES = new Set([
  "aspectReview", "chapterSummary", "common", "continuationOptions", "dialogueSketchLine",
  "dialogueSketchLines", "firstReadReaction", "sceneSummary", "settingQa",
]);

export function loadPromptTemplate(name: string): Promise<PromptTemplate> {
  if (!PROMPT_NAMES.has(name)) throw new TypeError(`Unknown assistant prompt template: ${name}`);
  const existing = promptCache.get(name);
  if (existing) return existing;
  const loading = (async () => {
    const directory = path.dirname(fileURLToPath(import.meta.url));
    const filename = `${name}.prompt.md`;
    let raw: string | undefined;
    let lastError: unknown;
    for (const candidate of [path.join(directory, "prompts", filename), path.join(directory, "..", "prompts", filename)]) {
      try { raw = await readFile(candidate, "utf8"); break; }
      catch (error) { lastError = error; }
    }
    if (raw === undefined) throw lastError ?? new Error(`Prompt asset ${filename} is unavailable`);
    const frontMatter = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/.exec(raw);
    if (!frontMatter) throw new TypeError(`Prompt asset ${filename} has no versioned front matter`);
    const version = /^version:\s*([^\r\n]+)\s*$/m.exec(frontMatter[1]!)?.[1]?.trim();
    const body = raw.slice(frontMatter[0].length).trim();
    if (!version || !body) throw new TypeError(`Prompt asset ${filename} is missing a version or prompt body`);
    return { version, body };
  })();
  promptCache.set(name, loading);
  return loading;
}

export async function renderPromptTemplate(name: string, values: Record<string, string>): Promise<PromptTemplate> {
  const template = await loadPromptTemplate(name);
  const body = template.body.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in values)) throw new TypeError(`Prompt ${name} is missing template value ${key}`);
    return values[key]!;
  });
  return { version: template.version, body };
}

export async function composePrompt(body: string): Promise<string> {
  const common = await loadPromptTemplate("common");
  return `${common.body}\n\n${body}`;
}

export const CUSTOM_PROMPT_VERSIONS = {
  rewrite: "rewrite@1",
  dialogueTopics: "v4",
  dialogueTurn: "dialogue-sketch-line@3",
  synonym: "synonym-suggest@2",
  contradiction: "n7-contradiction-check:v3",
  stateEvent: "state-event-extraction:v1",
  zukan: "zukan-manuscript@3",
  speaker: "speaker-attribution-llm@4",
} as const;
