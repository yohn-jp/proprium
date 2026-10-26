import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEpubExport,
  buildPlaintextExport,
  collectPublishingScenes,
  composeVerticalPrintText,
  EXPORT_PREFLIGHT_ITEMS,
  preflightWarningMessage,
  stripManuscriptMarkup,
  toKakuyomuDialect,
  toNarouDialect,
  uncheckedPreflightItems,
  type PublishingProject,
} from "./domain.js";

const project: PublishingProject = {
  title: "星の図書館",
  subtitle: "第二巻",
  volumes: [{
    id: "vol-1", title: "第一巻", order: 1, chapters: [{
      id: "ch-1", title: "はじまり", order: 1, scenes: [
        {
          id: "scene-α", title: "夜の駅", order: 2, volumeId: "vol-1", chapterId: "ch-1",
          path: "manuscript/vol-1/ch-1/custom-scene-file.md",
          body: "|星《ほし》の駅で、《《彼女》》は待った。 & <物語>。\r\n次の列車を待った。\r\n",
        },
        {
          id: "scene-2", title: "朝の港", order: 1, volumeId: "vol-1", chapterId: "ch-1",
          path: "manuscript/vol-1/ch-1/scene-2.md", body: "海から朝日が昇った。\n",
        },
      ],
    }],
  }],
};

function extractStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 4 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    assert.equal(method, 0, "deterministic EPUB entries use the store method");
    const compressedSize = view.getUint32(offset + 18, true);
    const size = view.getUint32(offset + 22, true);
    assert.equal(compressedSize, size);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    const dataStart = nameStart + nameLength + extraLength;
    files.set(name, bytes.slice(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50, "central directory follows the local entries");
  return files;
}

test("publication scope follows explicit scene links and preserves Narrative page order", () => {
  assert.deepEqual(collectPublishingScenes(project, "chapter", "ch-1").map(scene => scene.path), [
    "manuscript/vol-1/ch-1/custom-scene-file.md",
    "manuscript/vol-1/ch-1/scene-2.md",
  ]);
  assert.throws(() => collectPublishingScenes(project, "chapter", "missing"), /invalid_scope/u);
  assert.deepEqual(collectPublishingScenes({ ...project, volumes: [] }, "all"), []);
  assert.throws(() => buildPlaintextExport({ ...project, volumes: [] }, { scope: "all", markup: "raw" }), /empty_scope/u);
});

test("TXT raw, stripped, Kakuyomu and Narou modes preserve Unicode, order and source text safely", () => {
  const raw = buildPlaintextExport(project, { scope: "chapter", id: "ch-1", markup: "raw" });
  const rawText = new TextDecoder().decode(raw.bytes);
  assert.equal(raw.filename, "星の図書館-第一巻_はじまり-raw.txt");
  assert.match(rawText, /夜の駅[\s\S]*朝の港/u);
  assert.match(rawText, /\r\n/u, "raw export retains source line endings");
  assert.match(rawText, /& <物語>/u, "plain text does not interpret markup as HTML");
  assert.equal(new TextDecoder().decode(buildPlaintextExport(project, { scope: "chapter", id: "ch-1", markup: "strip" }).bytes).includes("星の駅で、彼女は待った"), true);
  assert.match(toKakuyomuDialect("|星《ほし》"), /｜星《ほし》/u);
  assert.match(toNarouDialect("｜星《ほし》 《《彼女》》"), /\|星《ほし》 \|彼《・》\|女《・》/u);
  assert.equal(stripManuscriptMarkup("|星《ほし》 《《彼女》》"), "星 彼女");
  assert.deepEqual(buildPlaintextExport(project, { scope: "chapter", id: "ch-1", markup: "raw" }).bytes, raw.bytes,
    "the same pinned work and options produce identical UTF-8 bytes");
});

test("EPUB output is a real deterministic EPUB3 ZIP with escaped XHTML, ruby, appendix and exact cover bytes", () => {
  const cover = Uint8Array.from([0xff, 0xd8, 0x00, 0x81, 0xfe, 0x00, 0xd9]);
  const exported = buildEpubExport(project, {
    scope: "all",
    cover: { path: "assets/cover.jpg", bytes: cover },
    bible: [{ id: "char-ari", type: "character", name: "アリ", aliases: ["あり"], notes: { lead: [{ text: "星を読む。" }] } }],
  });
  assert.equal(exported.filename, "星の図書館-all.epub");
  assert.equal(exported.mediaType, "application/epub+zip");
  const files = extractStoredZip(exported.bytes);
  assert.deepEqual([...files.keys()].slice(0, 2), ["mimetype", "META-INF/container.xml"]);
  assert.equal(new TextDecoder().decode(files.get("mimetype")), "application/epub+zip");
  assert.equal(new TextDecoder().decode(files.get("META-INF/container.xml")).includes("OEBPS/content.opf"), true);
  const opf = new TextDecoder().decode(files.get("OEBPS/content.opf"));
  assert.match(opf, /version="3\.0"/u);
  assert.match(opf, /properties="cover-image"/u);
  assert.match(opf, /scene-00001\.xhtml/u);
  const scene = new TextDecoder().decode(files.get("OEBPS/scene-00001.xhtml"));
  assert.match(scene, /<ruby>星<rt>ほし<\/rt><\/ruby>/u);
  assert.match(scene, /<span class="bouten">彼女<\/span>/u);
  assert.match(scene, /&amp; &lt;物語&gt;/u);
  const appendix = new TextDecoder().decode(files.get("OEBPS/bible-appendix.xhtml"));
  assert.match(appendix, /アリ/u);
  assert.match(appendix, /星を読む/u);
  assert.deepEqual(files.get("OEBPS/images/cover.jpg"), cover);
  assert.deepEqual(buildEpubExport(project, {
    scope: "all",
    cover: { path: "assets/cover.jpg", bytes: cover },
    bible: [{ id: "char-ari", type: "character", name: "アリ", aliases: ["あり"], notes: { lead: [{ text: "星を読む。" }] } }],
  }).bytes, exported.bytes);
});

test("EPUB rejects traversal covers and keeps unsupported image types out of the manifest", () => {
  assert.throws(() => buildEpubExport(project, { scope: "all", cover: { path: "../secret.jpg", bytes: new Uint8Array([1]) } }), /invalid_path/u);
  const exported = buildEpubExport(project, { scope: "all", cover: { path: "assets/cover.svg", bytes: new Uint8Array([1, 2]) } });
  assert.deepEqual(exported.warnings, ["unsupported_cover_type"]);
  const files = extractStoredZip(exported.bytes);
  assert.equal(files.has("OEBPS/images/cover.svg"), false);
  assert.match(new TextDecoder().decode(files.get("OEBPS/content.opf")), /<manifest>/u);
  assert.doesNotMatch(new TextDecoder().decode(files.get("OEBPS/content.opf")), /cover-image/u);
});

test("vertical print preserves canonical scene order and preflight stays non-blocking", () => {
  const bytes = new TextEncoder().encode(composeVerticalPrintText(collectPublishingScenes(project, "all")));
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /夜の駅[\s\S]*朝の港/u);
  assert.equal(EXPORT_PREFLIGHT_ITEMS.map(item => item.id).join(","), "proofread,names-ruby,export-scope,platform-rules,episode-meta");
  assert.equal(uncheckedPreflightItems({}).length, 5);
  const warning = preflightWarningMessage({});
  assert.ok(warning);
  assert.match(warning, /5 件/u);
  assert.equal(preflightWarningMessage({ proofread: true, "names-ruby": true, "export-scope": true, "platform-rules": true, "episode-meta": true }), null);
});
