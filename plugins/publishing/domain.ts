/** Pure Publishing computations. Host I/O, snapshot reads, artifact storage and
 * user gestures intentionally live outside this module. */

export type PublishingScope = "all" | "volume" | "chapter";

export interface PublishingScene {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly path: string;
  readonly volumeId: string;
  readonly chapterId: string;
  readonly order?: number;
}

export interface PublishingChapter {
  readonly id: string;
  readonly title: string;
  readonly order?: number;
  readonly scenes: readonly PublishingScene[];
}

export interface PublishingVolume {
  readonly id: string;
  readonly title: string;
  readonly order?: number;
  readonly chapters: readonly PublishingChapter[];
}

export interface PublishingProject {
  readonly title: string;
  readonly subtitle?: string;
  readonly volumes: readonly PublishingVolume[];
}

export interface PlaintextOptions {
  readonly scope: PublishingScope;
  readonly id?: string;
  readonly markup: "raw" | "strip" | "kakuyomu" | "narou";
}

export interface PlaintextExport {
  readonly filename: string;
  readonly mediaType: "text/plain; charset=utf-8";
  readonly bytes: Uint8Array;
  readonly sceneCount: number;
}

export interface EpubBibleEntry {
  readonly id: string;
  readonly type: "character" | "lore" | "location";
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly notes?: unknown;
}

export interface EpubOptions {
  readonly scope: PublishingScope;
  readonly id?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly cover?: { readonly path: string; readonly bytes: Uint8Array };
  readonly bible?: readonly EpubBibleEntry[];
}

export interface EpubExport {
  readonly filename: string;
  readonly mediaType: "application/epub+zip";
  readonly bytes: Uint8Array;
  readonly sceneCount: number;
  readonly warnings: readonly string[];
}

export interface VerticalPrintSection {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

function invalid(reason: string): Error {
  return Object.assign(new Error(reason), { code: "invalid_input" as const });
}

function ambiguous(reason: string): Error {
  return Object.assign(new Error(reason), { code: "ambiguous_identity" as const });
}

function safeFilenamePart(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/gu, "_")
    .replace(/[\u0000-\u001f\u007f]/gu, "_")
    .replace(/\s+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_|_$/gu, "");
  return [...cleaned].slice(0, 80).join("") || "export";
}

function assertProject(project: PublishingProject): void {
  if (!project || typeof project.title !== "string" || !Array.isArray(project.volumes)) {
    throw invalid("invalid_source");
  }
  const volumeIds = new Set<string>();
  const chapterIds = new Set<string>();
  const sceneIds = new Set<string>();
  for (const volume of project.volumes) {
    if (!volume.id || !volume.title || !Array.isArray(volume.chapters)) throw invalid("invalid_source");
    if (volumeIds.has(volume.id)) throw ambiguous("ambiguous_identity");
    volumeIds.add(volume.id);
    for (const chapter of volume.chapters) {
      if (!chapter.id || !chapter.title || !Array.isArray(chapter.scenes)) throw invalid("invalid_source");
      if (chapterIds.has(chapter.id)) throw ambiguous("ambiguous_identity");
      chapterIds.add(chapter.id);
      for (const scene of chapter.scenes) {
        if (!scene.id || !scene.title || typeof scene.body !== "string" ||
            scene.volumeId !== volume.id || scene.chapterId !== chapter.id || !safeRelativePath(scene.path)) {
          throw invalid("invalid_source");
        }
        if (sceneIds.has(scene.id)) throw ambiguous("ambiguous_identity");
        if (scene.body.includes("\u0000")) throw invalid("invalid_source");
        sceneIds.add(scene.id);
      }
    }
  }
}

export function collectPublishingScenes(project: PublishingProject, scope: PublishingScope, id?: string): PublishingScene[] {
  assertProject(project);
  if (scope !== "all" && scope !== "volume" && scope !== "chapter") throw invalid("invalid_scope");
  // Narrative's hierarchy action is the sole ordering authority. Publishing
  // preserves the received page order and never sorts a second time.
  const volumes = project.volumes;
  if (scope === "all") return volumes.flatMap(volume => volume.chapters.flatMap(chapter => [...chapter.scenes]));
  if (!id?.trim()) throw invalid("invalid_scope");
  const selectedId = id.trim();
  if (scope === "volume") {
    const volume = volumes.find(candidate => candidate.id === selectedId);
    if (!volume) throw invalid("invalid_scope");
    return volume.chapters.flatMap(chapter => [...chapter.scenes]);
  }
  for (const volume of volumes) {
    const chapter = volume.chapters.find(candidate => candidate.id === selectedId);
    if (chapter) return [...chapter.scenes];
  }
  throw invalid("invalid_scope");
}

function scopeLabel(project: PublishingProject, scope: PublishingScope, id?: string): string {
  if (scope === "all") return "all";
  if (!id) throw invalid("invalid_scope");
  if (scope === "volume") return project.volumes.find(volume => volume.id === id)?.title ?? "export";
  for (const volume of project.volumes) {
    const chapter = volume.chapters.find(item => item.id === id);
    if (chapter) return `${volume.title}_${chapter.title}`;
  }
  return "export";
}

export function publishingFilename(project: PublishingProject, scope: PublishingScope, id: string | undefined,
  format: "plain-raw" | "plain-strip" | "plain-kakuyomu" | "plain-narou" | "epub" | "vertical"): string {
  const work = safeFilenamePart(project.title);
  const label = safeFilenamePart(scopeLabel(project, scope, id));
  if (format === "epub") return `${work}-${label}.epub`;
  if (format === "vertical") return `${work}-${label}-vertical.txt`;
  const suffix = format === "plain-strip" ? "plain" : format.slice("plain-".length);
  return `${work}-${label}-${suffix}.txt`;
}

export function stripManuscriptMarkup(text: string): string {
  return text.replace(/[|｜]([^《|\n｜]+?)《([^》]+)》/gu, "$1").replace(/《《([^》]+)》》/gu, "$1");
}

export function toKakuyomuDialect(text: string): string {
  return text.replace(/[|｜]([^《|\n｜]+?)《([^》]+)》/gu, (_match, base: string, reading: string) => `｜${base}《${reading}》`);
}

export function toNarouDialect(text: string): string {
  const withRuby = text.replace(/[|｜]([^《|\n｜]+?)《([^》]+)》/gu, (_match, base: string, reading: string) => `|${base}《${reading}》`);
  return withRuby.replace(/《《([^》]+)》》/gu, (_match, inner: string) => [...inner].map(character => `|${character}《・》`).join(""));
}

export function buildPlaintextExport(project: PublishingProject, options: PlaintextOptions): PlaintextExport {
  const scenes = collectPublishingScenes(project, options.scope, options.id);
  if (scenes.length === 0) throw invalid("empty_scope");
  const transforms = {
    raw: (value: string) => value,
    strip: stripManuscriptMarkup,
    kakuyomu: toKakuyomuDialect,
    narou: toNarouDialect,
  } satisfies Record<PlaintextOptions["markup"], (text: string) => string>;
  const transform = transforms[options.markup];
  if (!transform) throw invalid("invalid_source");
  const parts = scenes.flatMap(scene => {
    const body = transform(scene.body).replace(/\s+$/u, "");
    return [`# ${scene.title}${body ? `\n\n${body}` : ""}`];
  });
  const filename = publishingFilename(project, options.scope, options.id, `plain-${options.markup}`);
  return { filename, mediaType: "text/plain; charset=utf-8", bytes: new TextEncoder().encode(parts.length ? `${parts.join("\n\n")}\n` : ""), sceneCount: scenes.length };
}

/** Format one selected scene without retaining another scene's manuscript body. */
export function plaintextSceneText(scene: PublishingScene, body: string, markup: PlaintextOptions["markup"]): string {
  const transforms = {
    raw: (value: string) => value,
    strip: stripManuscriptMarkup,
    kakuyomu: toKakuyomuDialect,
    narou: toNarouDialect,
  } satisfies Record<PlaintextOptions["markup"], (text: string) => string>;
  const transform = transforms[markup];
  if (!transform) throw invalid("invalid_source");
  const content = transform(body).replace(/\s+$/u, "");
  return `# ${scene.title}${content ? `\n\n${content}` : ""}`;
}

export function composeVerticalPrintText(sections: readonly VerticalPrintSection[]): string {
  const parts: string[] = [];
  for (const section of sections) {
    if (typeof section.id !== "string" || typeof section.title !== "string" || typeof section.body !== "string" || section.body.includes("\u0000")) {
      throw invalid("invalid_source");
    }
    const body = section.body.replace(/\s+$/u, "");
    parts.push(`${section.title}${body ? `\n\n${body}` : ""}`);
  }
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

export function safeRelativePath(path: string): boolean {
  return typeof path === "string" && path.length > 0 && !path.includes("\u0000") && !path.includes("\\") &&
    !path.startsWith("/") && !/^[a-zA-Z]:/u.test(path) && path.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

function escapeXml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function assertXmlText(text: string): void {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw invalid("invalid_source");
}

function validNcName(value: string): string {
  let safe = value.replace(/[^A-Za-z0-9._-]/gu, "_");
  if (!safe) safe = "id";
  if (!/^[A-Za-z_]/u.test(safe)) safe = `id-${safe}`;
  return safe;
}

function inlineMarkup(text: string): string {
  const tokens: string[] = [];
  const protectedText = text
    .replace(/[|｜]([^《|\n｜]+?)《([^》]+)》/gu, (match) => {
      const index = tokens.push(match) - 1;
      return `\u0001${index}\u0002`;
    })
    .replace(/《《([^》]+)》》/gu, (match) => {
      const index = tokens.push(match) - 1;
      return `\u0001${index}\u0002`;
    });
  let escaped = escapeXml(protectedText);
  escaped = escaped.replace(/\u0001(\d+)\u0002/gu, (_token, index: string) => {
    const source = tokens[Number(index)] ?? "";
    const ruby = /[|｜]([^《|\n｜]+?)《([^》]+)》/u.exec(source);
    if (ruby) return `<ruby>${escapeXml(ruby[1]!)}<rt>${escapeXml(ruby[2]!)}</rt></ruby>`;
    const bouten = /《《([^》]+)》》/u.exec(source);
    return bouten ? `<span class="bouten">${escapeXml(bouten[1]!)}</span>` : escapeXml(source);
  });
  return escaped;
}

function bodyToXhtml(body: string): string {
  const trimmed = body.replace(/\s+$/u, "");
  if (!trimmed) return "";
  return trimmed.split(/\n{2,}/u).map(paragraph => `<p>${paragraph.split("\n").map(inlineMarkup).join("<br/>")}</p>`).join("\n");
}

function xhtmlDocument(title: string, content: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ja" xml:lang="ja"><head><meta charset="UTF-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head><body>${content}</body></html>\n`;
}

function notesText(value: unknown, depth = 0): string[] {
  if (depth > 8 || value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(item => notesText(item, depth + 1));
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["text", "term", "description", "heading"]) out.push(...notesText(record[key], depth + 1));
  for (const key of ["lead", "sections", "body", "items", "children"]) out.push(...notesText(record[key], depth + 1));
  return out;
}

function appendix(entries: readonly EpubBibleEntry[]): string {
  const supported = entries.filter(entry => entry && typeof entry.id === "string" && entry.id.trim() &&
    ["character", "lore", "location"].includes(entry.type) && typeof entry.name === "string");
  const body = supported.map(entry => {
    const aliases = (entry.aliases ?? []).filter(alias => typeof alias === "string" && alias.trim());
    const notes = [...new Set(notesText(entry.notes))];
    return `<section id="${escapeXml(validNcName(`bible-${entry.type}-${entry.id}`))}"><h2>${escapeXml(entry.name)}</h2>${aliases.length ? `<p class="aliases">${escapeXml(aliases.join("、"))}</p>` : ""}${notes.map(note => `<p>${escapeXml(note)}</p>`).join("")}</section>`;
  }).join("\n");
  return `<h1>人物・用語</h1>${body}`;
}

const EPUB_CSS = `body{font-family:serif;line-height:1.8;margin:1em}.title-page{text-align:center;margin-top:30vh}p{margin:0 0 .8em;text-indent:1em}.bouten{-webkit-text-emphasis:filled sesame;text-emphasis:filled sesame}.aliases{text-indent:0;color:#444}`;
const COVER_TYPES: Readonly<Record<string, string>> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" };

export interface EpubSceneDocument {
  readonly scene: PublishingScene;
  readonly href: string;
  readonly id: string;
}

export interface EpubScaffold {
  readonly files: Map<string, Uint8Array>;
  readonly scenes: readonly EpubSceneDocument[];
}

export function buildEpubScaffold(project: PublishingProject, options: EpubOptions): EpubScaffold {
  const scenes = collectPublishingScenes(project, options.scope, options.id);
  if (scenes.length === 0) throw invalid("empty_scope");
  const chapterFor = new Map<string, PublishingChapter>();
  for (const volume of project.volumes) for (const chapter of volume.chapters) chapterFor.set(chapter.id, chapter);
  const sceneDocs = scenes.map((scene, index) => ({
    scene,
    href: `scene-${String(index + 1).padStart(5, "0")}.xhtml`,
    id: `scene-${String(index + 1).padStart(5, "0")}`,
  }));
  const bookTitle = options.title?.trim() || project.title;
  const subtitle = options.subtitle?.trim() || project.subtitle;
  assertXmlText(bookTitle);
  if (subtitle) assertXmlText(subtitle);
  for (const scene of scenes) {
    assertXmlText(scene.title);
    assertXmlText(scene.body);
  }
  const files = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const addText = (path: string, text: string) => files.set(path, encoder.encode(text));

  // EPUB requires the stored mimetype entry to be the first local ZIP entry.
  addText("mimetype", "application/epub+zip");
  addText("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n`);
  addText("OEBPS/styles.css", EPUB_CSS);
  addText("OEBPS/title.xhtml", xhtmlDocument(bookTitle, `<section class="title-page"><h1>${escapeXml(bookTitle)}</h1>${subtitle ? `<p>${escapeXml(subtitle)}</p>` : ""}</section>`));
  const chapterGroups = new Map<string, typeof sceneDocs>();
  for (const item of sceneDocs) {
    const group = chapterGroups.get(item.scene.chapterId) ?? [];
    group.push(item);
    chapterGroups.set(item.scene.chapterId, group);
  }
  const toc = [...chapterGroups.entries()].map(([chapterId, items]) => {
    const chapter = chapterFor.get(chapterId);
    return `<li><span>${escapeXml(chapter?.title ?? chapterId)}</span><ol>${items.map(item => `<li><a href="${item.href}">${escapeXml(item.scene.title)}</a></li>`).join("")}</ol></li>`;
  }).join("");
  const includeAppendix = Boolean(options.bible?.some(entry => entry && typeof entry.id === "string" && entry.id.trim()));
  if (includeAppendix) addText("OEBPS/bible-appendix.xhtml", xhtmlDocument("人物・用語", appendix(options.bible ?? [])));
  let coverItem: { href: string; type: string } | undefined;
  if (options.cover) {
    if (!safeRelativePath(options.cover.path)) throw Object.assign(invalid("invalid_path"), { code: "invalid_path" });
    const extension = options.cover.path.slice(options.cover.path.lastIndexOf(".")).toLowerCase();
    const type = COVER_TYPES[extension];
    if (type) {
      const href = `images/cover${extension}`;
      files.set(`OEBPS/${href}`, Uint8Array.from(options.cover.bytes));
      coverItem = { href, type };
      addText("OEBPS/cover.xhtml", xhtmlDocument("表紙", `<figure><img src="${href}" alt="表紙"/></figure>`));
    }
  }
  const nav = `<nav epub:type="toc" id="toc"><h1>目次</h1><ol><li><a href="title.xhtml">${escapeXml(bookTitle)}</a></li>${toc}${includeAppendix ? `<li><a href="bible-appendix.xhtml">人物・用語</a></li>` : ""}</ol></nav><nav epub:type="landmarks" id="landmarks" hidden="hidden"><ol><li><a epub:type="bodymatter" href="${sceneDocs[0]!.href}">本文</a></li><li><a epub:type="toc" href="nav.xhtml">目次</a></li></ol></nav>`;
  addText("OEBPS/nav.xhtml", xhtmlDocument("目次", nav));

  const manifestItems = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>`,
    `<item id="css" href="styles.css" media-type="text/css"/>`,
    ...sceneDocs.map(({ id, href }) => `<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`),
    ...(includeAppendix ? [`<item id="bible-appendix" href="bible-appendix.xhtml" media-type="application/xhtml+xml"/>`] : []),
    ...(coverItem ? [`<item id="cover-image" href="${coverItem.href}" media-type="${coverItem.type}" properties="cover-image"/>`, `<item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>`] : []),
  ].join("");
  const spine = ["title", ...sceneDocs.map(item => item.id), ...(includeAppendix ? ["bible-appendix"] : [])]
    .map(id => `<itemref idref="${id}"/>`).join("");
  // A content-derived identifier makes repeat exports of the same fixed source
  // stable without pretending an export has a remote publication timestamp.
  const identity = encodeURIComponent(`${project.title}\n${options.scope}\n${options.id ?? ""}\n${scenes.map(scene => scene.id).join("\n")}`);
  addText("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="ja"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:proprium:publishing:${identity}</dc:identifier><dc:title>${escapeXml(bookTitle)}</dc:title><dc:language>ja</dc:language><meta property="dcterms:modified">1980-01-01T00:00:00Z</meta></metadata><manifest>${manifestItems}</manifest><spine>${spine}</spine></package>\n`);
  return { files, scenes: sceneDocs };
}

export function buildEpubSceneXhtml(scene: PublishingScene, body: string): Uint8Array {
  assertXmlText(scene.title);
  assertXmlText(body);
  return new TextEncoder().encode(xhtmlDocument(scene.title, `<h1>${escapeXml(scene.title)}</h1>${bodyToXhtml(body)}`));
}

function buildEpubFiles(project: PublishingProject, options: EpubOptions): Map<string, Uint8Array> {
  const scaffold = buildEpubScaffold(project, options);
  const files = scaffold.files;
  for (const item of scaffold.scenes) files.set(`OEBPS/${item.href}`, buildEpubSceneXhtml(item.scene, item.scene.body));
  return files;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value, true); }
function u32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value >>> 0, true); }

/** Deterministic ZIP32 writer using the store method. The EPUB mimetype is first and uncompressed. */
export function createStoredZip(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const entries = [...files.entries()];
  if (entries.length === 0 || entries[0]?.[0] !== "mimetype") throw invalid("epub_mimetype_must_be_first");
  if (entries.length > 0xffff) throw Object.assign(invalid("artifact_too_large"), { code: "capacity" });
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localSize = 0;
  for (const [path, bytes] of entries) {
    if (!safeRelativePath(path) || path.startsWith("/") || bytes.byteLength > 0xffffffff) throw invalid("invalid_epub_entry");
    const name = encoder.encode(path);
    if (name.byteLength > 0xffff) throw invalid("invalid_epub_entry");
    const crc = crc32(bytes);
    const header = new Uint8Array(30 + name.byteLength);
    const view = new DataView(header.buffer);
    u32(view, 0, 0x04034b50); u16(view, 4, 20); u16(view, 6, 0x0800); u16(view, 8, 0);
    u16(view, 10, 0); u16(view, 12, 0x0021); u32(view, 14, crc);
    u32(view, 18, bytes.byteLength); u32(view, 22, bytes.byteLength); u16(view, 26, name.byteLength); u16(view, 28, 0);
    header.set(name, 30);
    localChunks.push(header, bytes);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    u32(centralView, 0, 0x02014b50); u16(centralView, 4, 20); u16(centralView, 6, 20);
    u16(centralView, 8, 0x0800); u16(centralView, 10, 0); u16(centralView, 12, 0); u16(centralView, 14, 0x0021);
    u32(centralView, 16, crc); u32(centralView, 20, bytes.byteLength); u32(centralView, 24, bytes.byteLength);
    u16(centralView, 28, name.byteLength); u16(centralView, 30, 0); u16(centralView, 32, 0);
    u16(centralView, 34, 0); u16(centralView, 36, 0); u32(centralView, 38, 0); u32(centralView, 42, localSize);
    central.set(name, 46);
    centralChunks.push(central);
    localSize += header.byteLength + bytes.byteLength;
  }
  const centralSize = centralChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  if (localSize > 0xffffffff || centralSize > 0xffffffff || localSize + centralSize + 22 > 0xffffffff) {
    throw Object.assign(invalid("artifact_too_large"), { code: "capacity" });
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  u32(endView, 0, 0x06054b50); u16(endView, 4, 0); u16(endView, 6, 0);
  u16(endView, 8, entries.length); u16(endView, 10, entries.length); u32(endView, 12, centralSize);
  u32(endView, 16, localSize); u16(endView, 20, 0);
  const output = new Uint8Array(localSize + centralSize + end.byteLength);
  let offset = 0;
  for (const chunk of localChunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  for (const chunk of centralChunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  output.set(end, offset);
  return output;
}

export function buildEpubExport(project: PublishingProject, options: EpubOptions): EpubExport {
  const scenes = collectPublishingScenes(project, options.scope, options.id);
  const files = buildEpubFiles(project, options);
  const filename = publishingFilename(project, options.scope, options.id, "epub");
  const warnings = options.cover && !COVER_TYPES[options.cover.path.slice(options.cover.path.lastIndexOf(".")).toLowerCase()]
    ? ["unsupported_cover_type"]
    : [];
  return { filename, mediaType: "application/epub+zip", bytes: createStoredZip(files), sceneCount: scenes.length, warnings };
}

export function buildVerticalPrintExport(project: PublishingProject, scope: PublishingScope, id?: string): Uint8Array {
  const scenes = collectPublishingScenes(project, scope, id);
  if (scenes.length === 0) throw invalid("empty_scope");
  return new TextEncoder().encode(composeVerticalPrintText(scenes));
}

export type PreflightItemId = "proofread" | "names-ruby" | "export-scope" | "platform-rules" | "episode-meta";
export interface PreflightItem { readonly id: PreflightItemId; readonly label: string; }

/** Recovered Loom fixed-order preflight checklist. State belongs to the Host dialog and resets on open. */
export const EXPORT_PREFLIGHT_ITEMS: readonly PreflightItem[] = [
  { id: "proofread", label: "誤字・脱字をざっと見直した" },
  { id: "names-ruby", label: "固有名・ルビの表記を確認した" },
  { id: "export-scope", label: "書き出し範囲（巻/章）が意図どおり" },
  { id: "platform-rules", label: "投稿先の禁則・記法を確認した" },
  { id: "episode-meta", label: "公開回番号・タイトルを確認した" },
];

export type PreflightChecked = Partial<Record<PreflightItemId, boolean>>;

export function uncheckedPreflightItems(checked: PreflightChecked): readonly PreflightItem[] {
  return EXPORT_PREFLIGHT_ITEMS.filter(item => !checked[item.id]);
}

export function preflightWarningMessage(checked: PreflightChecked): string | null {
  const count = uncheckedPreflightItems(checked).length;
  return count ? `未確認が ${count} 件あります。強制ブロックはしませんが、公開前に見直すことを推奨します。` : null;
}
