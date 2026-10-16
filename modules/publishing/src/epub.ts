import { createHash } from "node:crypto";
import path from "node:path";
import JSZip from "jszip";
import type { SnapshotReader } from "@scriptorium/contracts";
import type { PublishingProject, PublishingScope } from "./project.js";

/** Aozora / カクヨム系: `|漢字《かんじ》` または全角 `｜`（plaintextExport と同型）。 */
const RUBY_RE = /[|｜]([^《|\n｜]+?)《([^》]+)》/g;
/** カクヨム傍点: `《《本文》》`。 */
const BOUTEN_RE = /《《([^》]+)》》/g;

/** 既定の表紙パス（プロジェクトルート相対）。 */
export const DEFAULT_EPUB_COVER_PATH = "meta/scriptorium/modules/publishing/assets/cover.jpg";

/** 図鑑付録に載せる entity type（character 必須、lore/location は余裕分）。 */
const BIBLE_APPENDIX_TYPES = ["character", "lore", "location"] as const;

const COVER_MEDIA_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export type EpubExportScope = PublishingScope;

export interface EpubCoverImage {
  data: Buffer;
  mediaType: string;
  /** OEBPS 内ファイル名（例: `images/cover.jpg`）。未指定時は拡張子から決定。 */
  href?: string;
}

export interface EpubExportOptions {
  scope: EpubExportScope;
  id?: string;
  title?: string;
  subtitle?: string;
  coverPath?: string;
  coverImage?: EpubCoverImage;
  includeBibleAppendix?: boolean;
}

export interface EpubBibleEntry {
  id: string;
  type: "character" | "lore" | "location";
  name: string;
  aliases?: string[];
  notes?: unknown;
}

export interface EpubExportResult {
  /** EPUB3 ZIP (`application/epub+zip`)。 */
  buffer: Buffer;
  filename: string;
}

export class EpubExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpubExportError";
  }
}

interface EpubSceneDoc {
  id: string;
  href: string;
  title: string;
  bodyHtml: string;
}

interface EpubChapterNav {
  id: string;
  title: string;
  scenes: EpubSceneDoc[];
}

function safeFilenamePart(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return cleaned.slice(0, 80) || "export";
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 任意の文字列を XML `id`/`idref` 属性値として安全な NCName 形状にサニタイズする。
 *
 * シーン/エンティティ ID を OPF・XHTML の `id` 属性に埋め込む際、ID 生成元が
 * 将来変わっても不正な XML（数字始まり・コロン含み等の無効な `id` 属性）を
 * 生成しないための防御。EPUB パッケージング全体のライブラリ移行までの
 * 暫定措置（issue #305）。
 *
 * NCName は概ね「先頭は英字/アンダースコアのみ、以降は英数字/`.`/`-`/`_`」。
 * ここでは Unicode 文字クラス全体は追わず、ASCII の安全な部分集合のみを
 * 許可し、それ以外は `_` に置換する保守的な実装とする。
 */
export function sanitizeNCName(value: string): string {
  let sanitized = (value ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  if (!sanitized) sanitized = "id";
  if (!/^[A-Za-z_]/.test(sanitized)) sanitized = `id-${sanitized}`;
  return sanitized;
}

/**
 * プロジェクトルート相対パスを正規化。`..`・絶対パス・null バイトは拒否。
 * 拒否時は null（呼び出し側で 400 等）。
 */
export function sanitizeProjectRelativePath(relativePath: string): string | null {
  if (typeof relativePath !== "string") return null;
  const trimmed = relativePath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  const unified = trimmed.replace(/\\/g, "/");
  if (path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) return null;
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) return null;
  const segments = unified.split("/");
  if (segments.some((seg) => seg === "..")) return null;
  // 先頭の "./" を除去し、空セグメントを落とす
  const cleaned = segments.filter((seg) => seg !== "" && seg !== ".");
  if (cleaned.length === 0) return null;
  return cleaned.join("/");
}

/** 拡張子から cover 用 media-type を返す。未知は null。 */
export function coverMediaTypeForPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return COVER_MEDIA_TYPES[ext] ?? null;
}

/**
 * `coverPath` を root 配下に解決して読む。ファイル無し・未知拡張子は null（表紙スキップ）。
 * パスが root 外なら EpubExportError。
 */
export async function loadCoverImage(reader: SnapshotReader, coverPath: string): Promise<EpubCoverImage | null> {
  const safe = sanitizeProjectRelativePath(coverPath);
  if (!safe) {
    throw new EpubExportError("Invalid coverPath " + coverPath + ": expected a project-relative path without ..");
  }
  const mediaType = coverMediaTypeForPath(safe);
  if (!mediaType) return null;

  const file = await reader.read(safe, "base64");
  if (!file) return null;
  const ext = path.extname(safe).toLowerCase() || ".jpg";
  return {
    data: Buffer.from(file.content, "base64"),
    mediaType,
    href: "images/cover" + ext,
  };
}

/**
 * 正本原稿記法を EPUB 向けインライン HTML に変換。
 * ルビ → `<ruby>`、傍点 → `text-emphasis` 用 span。
 */
export function manuscriptMarkupToHtml(text: string): string {
  const withRuby = text.replace(
    RUBY_RE,
    (_m, base: string, reading: string) =>
      `<ruby>${escapeXml(base)}<rt>${escapeXml(reading)}</rt></ruby>`,
  );
  return withRuby.replace(
    BOUTEN_RE,
    (_m, inner: string) => `<span class="bouten">${escapeXml(inner)}</span>`,
  );
}

/** 段落分割: 空行で区切る。行内は `<br/>`。 */
export function manuscriptBodyToXhtml(body: string): string {
  const trimmed = body.replace(/\s+$/u, "");
  if (!trimmed) return "";
  const paragraphs = trimmed.split(/\n{2,}/);
  return paragraphs
    .map((para) => {
      const lines = para.split(/\n/).map((line) => escapeXmlKeepMarkup(line));
      return `<p>${lines.join("<br/>")}</p>`;
    })
    .join("\n");
}

/**
 * ルビ・傍点以外の生テキストをエスケープしつつ記法を HTML 化する。
 * 記法区間をプレースホルダにしてから全体 escape → 記法を HTML 化。
 */
function escapeXmlKeepMarkup(line: string): string {
  const tokens: string[] = [];
  const protectedLine = line
    .replace(RUBY_RE, (m) => {
      const i = tokens.length;
      tokens.push(m);
      return `@@ARCADIA_MARKUP_${i}@@`;
    })
    .replace(BOUTEN_RE, (m) => {
      const i = tokens.length;
      tokens.push(m);
      return `@@ARCADIA_MARKUP_${i}@@`;
    });
  const escaped = escapeXml(protectedLine);
  return escaped.replace(/@@ARCADIA_MARKUP_(\d+)@@/g, (_m, idx) => {
    const original = tokens[Number(idx)] ?? "";
    return manuscriptMarkupToHtml(original);
  });
}

function xhtmlDocument(title: string, bodyInner: string, cssHref = "styles.css"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ja" xml:lang="ja">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" type="text/css" href="${cssHref}"/>
</head>
<body>
${bodyInner}
</body>
</html>
`;
}

function collectChapterTree(
  project: PublishingProject,
  scope: EpubExportScope,
  id?: string,
): { chapters: EpubChapterNav[]; label: string } {
  const toDocs = (chapter: PublishingProject["volumes"][number]["chapters"][number]): EpubChapterNav => {
    const scenes = chapter.scenes.flatMap((scene) => {
      const body = scene.body.replace(/\s+$/u, "");
      if (!body) return [];
      return [{
        id: scene.id,
        href: "scene-" + safeFilenamePart(scene.id) + ".xhtml",
        title: scene.title,
        bodyHtml: manuscriptBodyToXhtml(body),
      }];
    });
    return { id: chapter.id, title: chapter.title, scenes };
  };

  if (scope === "all") {
    return {
      chapters: project.volumes.flatMap((volume) => volume.chapters.map(toDocs)).filter((chapter) => chapter.scenes.length > 0),
      label: "all",
    };
  }
  if (!id || !id.trim()) throw new EpubExportError("A volume or chapter ID is required for this scope");
  const selectedId = id.trim();

  if (scope === "volume") {
    const volume = project.volumes.find((item) => item.id === selectedId);
    if (!volume) throw new EpubExportError("Volume not found: " + selectedId);
    return {
      chapters: volume.chapters.map(toDocs).filter((chapter) => chapter.scenes.length > 0),
      label: volume.title,
    };
  }

  for (const volume of project.volumes) {
    const chapter = volume.chapters.find((item) => item.id === selectedId);
    if (chapter) {
      const nav = toDocs(chapter);
      return {
        chapters: nav.scenes.length > 0 ? [nav] : [],
        label: volume.title + "_" + chapter.title,
      };
    }
  }
  throw new EpubExportError("Chapter not found: " + selectedId);
}

function buildStylesCss(): string {
  return `body {
  font-family: serif;
  line-height: 1.8;
  margin: 1em;
}
h1 { font-size: 1.4em; margin: 1em 0 0.6em; }
h2 { font-size: 1.2em; margin: 0.8em 0 0.5em; }
h3 { font-size: 1.05em; margin: 0.6em 0 0.3em; }
p { margin: 0 0 0.8em; text-indent: 1em; }
.bouten {
  -webkit-text-emphasis: filled sesame;
  text-emphasis: filled sesame;
}
.title-page, .colophon {
  text-align: center;
  margin-top: 30vh;
}
.colophon { margin-top: 20vh; font-size: 0.95em; }
.cover {
  text-align: center;
  margin: 0;
  padding: 0;
}
.cover img {
  max-width: 100%;
  max-height: 95vh;
  height: auto;
}
.bible-entry { margin-bottom: 1.5em; }
.bible-entry .aliases { text-indent: 0; color: #444; font-size: 0.95em; }
.bible-entry .notes { text-indent: 0; }
`;
}

function buildNavDocument(
  bookTitle: string,
  chapters: EpubChapterNav[],
  includeColophon: boolean,
  includeCover: boolean,
  includeBibleAppendix: boolean,
): string {
  const chapterItems = chapters
    .map((ch) => {
      const sceneItems = ch.scenes
        .map((s) => `        <li><a href="${s.href}">${escapeXml(s.title)}</a></li>`)
        .join("\n");
      return `      <li>
        <span>${escapeXml(ch.title)}</span>
        <ol>
${sceneItems}
        </ol>
      </li>`;
    })
    .join("\n");

  const coverLi = includeCover ? `      <li><a href="cover.xhtml">表紙</a></li>\n` : "";
  const colophonLi = includeColophon ? `      <li><a href="colophon.xhtml">奥付</a></li>\n` : "";
  const bibleLi = includeBibleAppendix
    ? `      <li><a href="bible-appendix.xhtml">図鑑付録</a></li>\n`
    : "";

  const landmarkCover = includeCover
    ? `      <li><a epub:type="cover" href="cover.xhtml">表紙</a></li>\n`
    : "";

  const body = `  <nav epub:type="toc" id="toc">
    <h1>目次</h1>
    <ol>
${coverLi}      <li><a href="title.xhtml">${escapeXml(bookTitle)}</a></li>
${chapterItems}
${bibleLi}${colophonLi}    </ol>
  </nav>
  <nav epub:type="landmarks" id="landmarks" hidden="hidden">
    <ol>
${landmarkCover}      <li><a epub:type="bodymatter" href="${chapters[0]?.scenes[0]?.href ?? "title.xhtml"}">本文</a></li>
      <li><a epub:type="toc" href="nav.xhtml">目次</a></li>
    </ol>
  </nav>`;

  return xhtmlDocument("目次", body);
}

function buildPackageOpf(
  bookTitle: string,
  uuid: string,
  chapters: EpubChapterNav[],
  includeColophon: boolean,
  cover: EpubCoverImage | null,
  includeBibleAppendix: boolean,
): string {
  const sceneItemId = (s: EpubSceneDoc) => `item-${sanitizeNCName(s.id)}`;

  const manifestScenes = chapters
    .flatMap((ch) => ch.scenes)
    .map(
      (s) =>
        `    <item id="${escapeXml(sceneItemId(s))}" href="${s.href}" media-type="application/xhtml+xml"/>`,
    )
    .join("\n");

  const spineScenes = chapters
    .flatMap((ch) => ch.scenes)
    .map((s) => `    <itemref idref="${escapeXml(sceneItemId(s))}"/>`)
    .join("\n");

  const colophonManifest = includeColophon
    ? `    <item id="colophon" href="colophon.xhtml" media-type="application/xhtml+xml"/>\n`
    : "";
  const colophonSpine = includeColophon ? `    <itemref idref="colophon"/>\n` : "";

  const coverHref = cover?.href ?? "images/cover.jpg";
  const coverManifest = cover
    ? `    <item id="cover-image" href="${escapeXml(coverHref)}" media-type="${escapeXml(cover.mediaType)}" properties="cover-image"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>\n`
    : "";
  const coverSpine = cover ? `    <itemref idref="cover"/>\n` : "";

  const bibleManifest = includeBibleAppendix
    ? `    <item id="bible-appendix" href="bible-appendix.xhtml" media-type="application/xhtml+xml"/>\n`
    : "";
  const bibleSpine = includeBibleAppendix ? `    <itemref idref="bible-appendix"/>\n` : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ja">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${escapeXml(bookTitle)}</dc:title>
    <dc:language>ja</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles.css" media-type="text/css"/>
${coverManifest}    <item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
${bibleManifest}${colophonManifest}${manifestScenes}
  </manifest>
  <spine>
${coverSpine}    <itemref idref="title"/>
${spineScenes}
${bibleSpine}${colophonSpine}  </spine>
</package>
`;
}

function notesSummaryText(notes: unknown): string {
  const structured = structuredNotesPlainTexts(notes);
  if (structured) return structured.map((text) => text.trim()).filter(Boolean).join(" ").slice(0, 800);
  if (typeof notes === "string") return notes.trim().slice(0, 800);
  if (!notes || typeof notes !== "object") return "";
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.trim()) values.push(value.trim());
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (["text", "body", "content", "value"].includes(key)) visit(item);
        else if (Array.isArray(item)) visit(item);
      }
    }
  };
  visit(notes);
  return values.join(" ").slice(0, 800);
}

interface NotesTextBlock { type: "paragraph"; text: string }
interface NotesLabeledBlock { type: "definitions" | "steps"; items: Array<{ term: string; description: string }> }
type NotesBlock = NotesTextBlock | NotesLabeledBlock;
interface NotesSection { heading: string; body: NotesBlock[]; children: NotesSection[] }

function notesRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function notesBlock(value: unknown): value is NotesBlock {
  const block = notesRecord(value);
  if (!block) return false;
  if (block.type === "paragraph") return typeof block.text === "string";
  if (block.type !== "definitions" && block.type !== "steps") return false;
  return Array.isArray(block.items) && block.items.every((item) => {
    const labeled = notesRecord(item);
    return Boolean(labeled && typeof labeled.term === "string" && typeof labeled.description === "string");
  });
}

function notesSection(value: unknown): value is NotesSection {
  const section = notesRecord(value);
  return Boolean(section && typeof section.heading === "string" &&
    Array.isArray(section.body) && section.body.every(notesBlock) &&
    Array.isArray(section.children) && section.children.every(notesSection));
}

/** Source-compatible flattening for typed StructuredNotes and nested sections. */
function structuredNotesPlainTexts(value: unknown): string[] | null {
  const notes = notesRecord(value);
  if (!notes || !Array.isArray(notes.lead) || !notes.lead.every(notesBlock) ||
      !Array.isArray(notes.sections) || !notes.sections.every(notesSection)) return null;
  const texts: string[] = [];
  const collectBlocks = (blocks: NotesBlock[]) => {
    for (const block of blocks) {
      if (block.type === "paragraph") texts.push(block.text);
      else for (const item of block.items) texts.push(item.term, item.description);
    }
  };
  const collectSection = (section: NotesSection) => {
    collectBlocks(section.body);
    for (const child of section.children) collectSection(child);
  };
  collectBlocks(notes.lead);
  for (const section of notes.sections) collectSection(section);
  return texts;
}

function buildBibleAppendixXhtml(entries: EpubBibleEntry[]): string {
  const typeLabels: Record<EpubBibleEntry["type"], string> = {
    character: "登場人物",
    lore: "設定",
    location: "場所",
  };
  const sections: string[] = [];
  for (const type of BIBLE_APPENDIX_TYPES) {
    const list = entries.filter((entry) => entry.type === type)
      .sort((left, right) => left.name.localeCompare(right.name, "ja") || left.id.localeCompare(right.id));
    if (!list.length) continue;
    const rendered = list.map((entry) => {
      const name = entry.name.trim() || entry.id;
      const aliases = (entry.aliases ?? []).map((alias) => alias.trim()).filter(Boolean);
      const notes = notesSummaryText(entry.notes);
      const aliasHtml = aliases.length
        ? "    <p class=\"aliases\">別名: " + escapeXml(aliases.join("、")) + "</p>\n"
        : "";
      const notesHtml = notes
        ? "    <div class=\"notes\">" + manuscriptBodyToXhtml(notes) + "</div>\n"
        : "";
      return "  <section class=\"bible-entry\" id=\"" + escapeXml(sanitizeNCName(entry.id)) + "\">\n" +
        "    <h3>" + escapeXml(name) + "</h3>\n" + aliasHtml + notesHtml + "  </section>";
    }).join("\n");
    sections.push("  <h2>" + escapeXml(typeLabels[type]) + "</h2>\n" + rendered);
  }
  const inner = sections.length ? sections.join("\n") : "  <p>図鑑に掲載する項目がありません。</p>";
  return xhtmlDocument("図鑑付録", "  <h1>図鑑付録</h1>\n" + inner);
}

/**
 * ツリー順のシーン本文を EPUB3 最小パッケージとして ZIP 化する。
 * 表紙（任意）・図鑑付録（任意）を同梱可能。
 */
export async function buildEpubExport(
  project: PublishingProject,
  options: EpubExportOptions,
  reader: SnapshotReader,
  bibleEntries: EpubBibleEntry[] = [],
): Promise<EpubExportResult> {
  const {
    scope,
    id,
    title: titleOpt,
    subtitle: subtitleOpt,
    coverPath,
    coverImage: coverImageOpt,
    includeBibleAppendix = false,
  } = options;
  if (scope !== "all" && scope !== "volume" && scope !== "chapter") {
    throw new EpubExportError('Invalid scope "' + String(scope) + '": expected all, volume, or chapter');
  }

  let cover: EpubCoverImage | null = coverImageOpt ?? null;
  if (!cover && coverPath) cover = await loadCoverImage(reader, coverPath);
  if (cover && !cover.href) {
    const mediaType = cover.mediaType;
    const ext = Object.entries(COVER_MEDIA_TYPES).find(([, candidate]) => candidate === mediaType)?.[0] ?? ".jpg";
    cover = { ...cover, href: "images/cover" + ext };
  }

  const { chapters, label } = collectChapterTree(project, scope, id);
  const titleValue = titleOpt?.trim() || project.title;
  const subtitle = subtitleOpt?.trim() || project.subtitle;
  const bookTitle = (titleValue || label || "Scriptorium").trim();
  const includeColophon = Boolean(titleValue?.trim() || subtitle?.trim());
  const uuid = createHash("sha1").update("arcadia-epub:" + bookTitle + ":" + label).digest("hex");
  const uuidFmt = [
    uuid.slice(0, 8),
    uuid.slice(8, 12),
    uuid.slice(12, 16),
    uuid.slice(16, 20),
    uuid.slice(20, 32),
  ].join("-");

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`,
  );

  const oebps = zip.folder("OEBPS");
  if (!oebps) throw new EpubExportError("Failed to create OEBPS folder");

  oebps.file("styles.css", buildStylesCss());

  if (cover?.href) {
    oebps.file(cover.href, cover.data);
    oebps.file(
      "cover.xhtml",
      xhtmlDocument(
        "表紙",
        `  <div class="cover" epub:type="cover">
    <img src="${escapeXml(cover.href)}" alt="表紙"/>
  </div>`,
        "styles.css",
      ),
    );
  }

  oebps.file(
    "title.xhtml",
    xhtmlDocument(
      bookTitle,
      `  <div class="title-page" epub:type="titlepage">
    <h1>${escapeXml(bookTitle)}</h1>
${subtitle?.trim() ? `    <p>${escapeXml(subtitle.trim())}</p>\n` : ""}  </div>`,
    ),
  );

  if (includeColophon) {
    oebps.file(
      "colophon.xhtml",
      xhtmlDocument(
        "奥付",
        `  <div class="colophon" epub:type="colophon">
    <h1>奥付</h1>
    <p>${escapeXml(bookTitle)}</p>
${subtitle?.trim() ? `    <p>${escapeXml(subtitle.trim())}</p>\n` : ""}    <p>Exported from Scriptorium</p>
  </div>`,
      ),
    );
  }

  if (includeBibleAppendix) {
    oebps.file("bible-appendix.xhtml", buildBibleAppendixXhtml(bibleEntries));
  }

  oebps.file(
    "nav.xhtml",
    buildNavDocument(bookTitle, chapters, includeColophon, Boolean(cover), includeBibleAppendix),
  );
  oebps.file(
    "content.opf",
    buildPackageOpf(bookTitle, uuidFmt, chapters, includeColophon, cover, includeBibleAppendix),
  );

  for (const ch of chapters) {
    for (const scene of ch.scenes) {
      oebps.file(
        scene.href,
        xhtmlDocument(
          scene.title,
          `  <h1>${escapeXml(scene.title)}</h1>
${scene.bodyHtml}`,
        ),
      );
    }
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    mimeType: "application/epub+zip",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });

  return {
    buffer: Buffer.from(buffer),
    filename: `arcadia-${safeFilenamePart(label)}.epub`,
  };
}
