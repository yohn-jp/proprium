import { collectPublishingScenes, type PublishingProject, type PublishingScope } from "./project.js";

export type PlaintextDialect = "kakuyomu" | "narou";

export interface PlaintextOptions {
  scope: PublishingScope;
  id?: string;
  stripMarkup?: boolean;
  dialect?: PlaintextDialect;
}

export interface PlaintextResult {
  text: string;
  filename: string;
}

const RUBY_RE = /[|｜]([^《|\n｜]+?)《([^》]+)》/g;
const BOUTEN_RE = /《《([^》]+)》》/g;

export class PlaintextExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaintextExportError";
  }
}

export function stripManuscriptMarkup(text: string): string {
  return text.replace(RUBY_RE, "$1").replace(BOUTEN_RE, "$1");
}

export function toKakuyomuDialect(text: string): string {
  return text.replace(RUBY_RE, (_match, base: string, reading: string) => "｜" + base + "《" + reading + "》");
}

export function toNarouDialect(text: string): string {
  const withRuby = text.replace(RUBY_RE, (_match, base: string, reading: string) => "|" + base + "《" + reading + "》");
  return withRuby.replace(BOUTEN_RE, (_match, inner: string) =>
    [...inner].map((character) => "|" + character + "《・》").join(""));
}

export const SITE_DIALECTS: Record<PlaintextDialect, (text: string) => string> = {
  kakuyomu: toKakuyomuDialect,
  narou: toNarouDialect,
};

export const PLAINTEXT_EXPORT_DIALECTS = Object.keys(SITE_DIALECTS) as PlaintextDialect[];

function safeFilenamePart(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return cleaned.slice(0, 80) || "export";
}

function applyMarkupMode(body: string, stripMarkup: boolean, dialect?: PlaintextDialect): string {
  if (stripMarkup && dialect) {
    throw new PlaintextExportError("stripMarkup and dialect are mutually exclusive; choose one markup mode");
  }
  if (stripMarkup) return stripManuscriptMarkup(body);
  if (dialect) {
    const convert = SITE_DIALECTS[dialect];
    if (!convert) throw new PlaintextExportError("Invalid dialect: expected " + PLAINTEXT_EXPORT_DIALECTS.join(", "));
    return convert(body);
  }
  return body;
}

function filenameSuffix(stripMarkup: boolean, dialect?: PlaintextDialect): string {
  if (stripMarkup) return "plain";
  if (dialect) return dialect;
  return "raw";
}

/** Source-compatible text export: preserve scene order and manuscript markup options. */
export function buildPlaintextExport(project: PublishingProject, options: PlaintextOptions): PlaintextResult {
  const { scope, id, stripMarkup = false, dialect } = options;
  if (scope !== "all" && scope !== "volume" && scope !== "chapter") {
    throw new PlaintextExportError('Invalid scope "' + String(scope) + '": expected all, volume, or chapter');
  }
  if (stripMarkup && dialect) {
    throw new PlaintextExportError("stripMarkup and dialect are mutually exclusive; choose one markup mode");
  }
  if (dialect !== undefined && !(dialect in SITE_DIALECTS)) {
    throw new PlaintextExportError('Invalid dialect "' + String(dialect) + '": expected ' + PLAINTEXT_EXPORT_DIALECTS.join(", "));
  }

  const scenes = collectPublishingScenes(project, scope, id);
  const parts: string[] = [];
  for (const scene of scenes) {
    const body = applyMarkupMode(scene.body, stripMarkup, dialect).replace(/\s+$/u, "");
    if (!body) continue;
    parts.push("# " + scene.title + "\n\n" + body);
  }

  let label = "all";
  if (scope === "volume") {
    label = project.volumes.find((volume) => volume.id === id)?.title ?? "export";
  } else if (scope === "chapter") {
    for (const volume of project.volumes) {
      const chapter = volume.chapters.find((item) => item.id === id);
      if (chapter) {
        label = volume.title + "_" + chapter.title;
        break;
      }
    }
  }
  const suffix = filenameSuffix(stripMarkup, dialect);
  return {
    text: parts.length > 0 ? parts.join("\n\n") + "\n" : "",
    filename: "arcadia-" + safeFilenamePart(label) + "-" + suffix + ".txt",
  };
}
