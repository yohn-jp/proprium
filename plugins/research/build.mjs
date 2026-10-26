import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageDirectory, "../..");
const sourceDirectory = resolve(process.env.PROPRIUM_PLUGIN_SOURCE_DIR ?? packageDirectory);
const output = resolve(process.env.PROPRIUM_PLUGIN_BUILD_OUTPUT ?? join(packageDirectory, "dist/plugin.component.wasm"));
const assetOutput = resolve(process.env.PROPRIUM_PLUGIN_ASSET_OUTPUT_DIR ?? join(packageDirectory, "dist/plugin-assets"));
const declaredWorld = process.env.PROPRIUM_PLUGIN_V2_WORLD ?? "proprium:plugin/plugin@2.0.0";
const jco = process.env.PROPRIUM_PLUGIN_JCO_BIN ?? resolve(repositoryRoot, "node_modules/.bin/jco");
const sharedWitFile = resolve(process.env.PROPRIUM_PLUGIN_V2_WIT ?? join(repositoryRoot, "app/src/browser/proprium/plugin-runtime/wit-v2/main.wit"));
const cargoTargetDirectory = resolve(process.env.CARGO_TARGET_DIR ?? await mkdtemp(join(tmpdir(), "research-cargo-target-")));
const ownsCargoTargetDirectory = !process.env.CARGO_TARGET_DIR;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "research-component-"));
const temporaryWitDirectory = join(temporaryDirectory, "wit-v2");
const modelComponent = join(temporaryDirectory, "research-morphology.wasm");
const guestComponent = join(temporaryDirectory, "research-guest.wasm");

const GROUP_ID = "proprium.research.ipadic";
const LINDERA_ARCHIVE_URL = "https://github.com/lindera/lindera/releases/download/v2.0.1/lindera-ipadic-2.0.1.zip";
const LINDERA_ARCHIVE_BYTES = 11_264_427;
const LINDERA_ARCHIVE_SHA256 = "a40606ad2cd94946ab0c44b26007f97dc221cd17e6fd74b35c1a53265a4acfaa";
const ASSET_LICENSE = "MIT (Lindera); IPADIC redistribution notice included in the asset group";
const IPADIC_FILES = [
  ["lindera-ipadic/metadata.json", 791, "3bf3d5ef582e6ef4c8ad409b013bdc511f32a852344d81a62afb97f2bab7155c"],
  ["lindera-ipadic/char_def.bin", 764, "cb7674fcd5a5c277a1aac27ace1b3977a5a13547574dab57c87157edcb351d41"],
  ["lindera-ipadic/dict.words", 4_175_536, "2563d4ec2e93085fef51b40242b895bdc42509b8fa65884fba35e8f366f79d44"],
  ["lindera-ipadic/dict.wordsidx", 765_408, "dd7df63ee77efa61249e116ffefb81dc53f052b1f3b21ef93fc115076656b912"],
  ["lindera-ipadic/matrix.mtx", 1_692_436, "35737753b8f53ec692604d997521a513d8228453a71905a6aae242afb1ab414c"],
  ["lindera-ipadic/dict.da", 3_307_616, "b1e1d9a51aedf1a5150cef4cdeca5d1319a57c638a0200b12209fc48ca1b8d91"],
  ["lindera-ipadic/dict.vals", 1_409_868, "5ff937a473b528fd1ce611c89247928aa71d40502aa07a0b3b7a2604e0081e91"],
  ["lindera-ipadic/unk.bin", 356, "1821e73ee882b721269dcd15f56abe34592a25476e761a0c22ff259ddc9286cc"],
];
const EXTRA_FILES = [
  ["IPADIC-NOTICE.txt", join(sourceDirectory, "IPADIC-NOTICE.txt"), 4_092, "2cf235bf0842d6d61eb0244fb22e645a321b12408a3cf75feb3a53577d885bde"],
  ["LINDERA-LICENSE.txt", join(sourceDirectory, "LINDERA-LICENSE.txt"), 1_080, "d37249886de3136db31717f15f6ade215a36fbed1c782381e38b2bf6047e8ec4"],
];

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const comparePath = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDirectory } });
}

async function readPinnedArchive() {
  let bytes;
  if (process.env.PROPRIUM_LINDERA_IPADIC_ARCHIVE) {
    bytes = new Uint8Array(await readFile(resolve(process.env.PROPRIUM_LINDERA_IPADIC_ARCHIVE)));
  } else {
    const response = await fetch(LINDERA_ARCHIVE_URL);
    if (!response.ok) throw new Error(`Pinned Lindera release download failed: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (bytes.byteLength !== LINDERA_ARCHIVE_BYTES || digest(bytes) !== LINDERA_ARCHIVE_SHA256) {
    throw new Error("Lindera IPADIC archive size or SHA-256 differs from the pinned v2.0.1 release");
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function extractPinnedZip(archive) {
  const minimumEnd = Math.max(0, archive.byteLength - 65_557);
  let endRecord = -1;
  for (let offset = archive.byteLength - 22; offset >= minimumEnd; offset--) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { endRecord = offset; break; }
  }
  if (endRecord < 0) throw new Error("Pinned Lindera archive has no ZIP end record");
  const count = archive.readUInt16LE(endRecord + 10);
  const centralBytes = archive.readUInt32LE(endRecord + 12);
  let centralOffset = archive.readUInt32LE(endRecord + 16);
  if (count === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff || centralOffset + centralBytes > archive.byteLength) {
    throw new Error("Pinned Lindera ZIP64 layout is unsupported");
  }

  const expected = new Map(IPADIC_FILES.map(([path, bytes, sha256]) => [path, { bytes, sha256 }]));
  const result = new Map();
  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error("Pinned Lindera ZIP central directory is invalid");
    const flags = archive.readUInt16LE(centralOffset + 8);
    const method = archive.readUInt16LE(centralOffset + 10);
    const compressedBytes = archive.readUInt32LE(centralOffset + 20);
    const uncompressedBytes = archive.readUInt32LE(centralOffset + 24);
    const nameBytes = archive.readUInt16LE(centralOffset + 28);
    const extraBytes = archive.readUInt16LE(centralOffset + 30);
    const commentBytes = archive.readUInt16LE(centralOffset + 32);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(archive.subarray(centralOffset + 46, centralOffset + 46 + nameBytes));
    centralOffset += 46 + nameBytes + extraBytes + commentBytes;
    if (name.endsWith("/")) continue;
    const pinned = expected.get(name);
    if (!pinned || result.has(name) || flags & 1 || uncompressedBytes !== pinned.bytes) {
      throw new Error(`Pinned Lindera ZIP contains an unexpected asset: ${name}`);
    }
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Pinned Lindera ZIP local header is invalid: ${name}`);
    const localNameBytes = archive.readUInt16LE(localOffset + 26);
    const localExtraBytes = archive.readUInt16LE(localOffset + 28);
    const payloadStart = localOffset + 30 + localNameBytes + localExtraBytes;
    const payloadEnd = payloadStart + compressedBytes;
    if (payloadEnd > archive.byteLength) throw new Error(`Pinned Lindera ZIP asset is truncated: ${name}`);
    const compressed = archive.subarray(payloadStart, payloadEnd);
    let bytes;
    if (method === 0) bytes = Buffer.from(compressed);
    else if (method === 8) bytes = inflateRawSync(compressed, { maxOutputLength: pinned.bytes });
    else throw new Error(`Pinned Lindera ZIP uses unsupported compression for ${name}`);
    if (bytes.byteLength !== pinned.bytes || digest(bytes) !== pinned.sha256) throw new Error(`Pinned Lindera IPADIC file differs: ${name}`);
    result.set(name, bytes);
  }
  if (centralOffset !== archive.readUInt32LE(endRecord + 16) + centralBytes || result.size !== expected.size) {
    throw new Error("Pinned Lindera ZIP is incomplete or has an unexpected file count");
  }
  return result;
}

async function writeAsset(path, bytes) {
  const target = resolve(assetOutput, ...path.split("/"));
  const rel = relative(assetOutput, target);
  if (rel.startsWith("../") || rel === "..") throw new Error(`Generated asset escaped temporary output: ${path}`);
  await mkdir(dirname(target), { recursive: true });
  try {
    const previous = await readFile(target);
    if (!previous.equals(bytes)) throw new Error(`Refusing to overwrite different generated asset bytes: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeFile(target, bytes, { flag: "wx" });
  }
}

async function generateAssetGroup() {
  const archiveAssets = extractPinnedZip(await readPinnedArchive());
  for (const [path, source, expectedBytes, expectedSha256] of EXTRA_FILES) {
    const bytes = new Uint8Array(await readFile(source));
    if (bytes.byteLength !== expectedBytes || digest(bytes) !== expectedSha256) throw new Error(`Lindera license/notice source differs: ${path}`);
    archiveAssets.set(path, Buffer.from(bytes));
  }

  const files = [];
  for (const [path, bytes] of [...archiveAssets].sort(([left], [right]) => comparePath(left, right))) {
    const sha256 = digest(bytes);
    const pathChunk = `proprium/research/assets/chunks/${sha256}/${basename(path)}`;
    files.push({ path, bytes: bytes.byteLength, sha256, chunks: [{ path: pathChunk, offset: 0, bytes: bytes.byteLength, sha256 }] });
    await writeAsset(pathChunk.slice("proprium/research/".length), bytes);
  }

  const manifest = { schema: "proprium.assets/v1", id: GROUP_ID, version: "2.0.1", license: ASSET_LICENSE, files };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const sha256 = digest(manifestBytes);
  const manifestPath = `proprium/research/assets/manifests/${sha256}/assets.json`;
  await writeAsset(manifestPath.slice("proprium/research/".length), manifestBytes);

  const metadata = JSON.parse(await readFile(join(sourceDirectory, "plugin.json"), "utf8"));
  const group = metadata.asset_groups?.find(item => item?.id === GROUP_ID);
  if (!group || group.manifest_path !== manifestPath || group.sha256 !== sha256 || group.bytes !== manifestBytes.byteLength || group.role !== "dictionary") {
    throw new Error(`plugin.json must pin the generated IPADIC group as ${manifestPath} (${sha256}, ${manifestBytes.byteLength} bytes)`);
  }
  console.log(`Generated pinned IPADIC asset group ${GROUP_ID}: ${manifestBytes.byteLength} manifest bytes, ${files.reduce((sum, file) => sum + file.bytes, 0)} payload bytes, ${sha256}`);
}

async function findModelComponent(directory) {
  const expected = "proprium_research_morphology.wasm";
  const targetDirectory = join(directory, "wasm32-unknown-unknown", "release");
  const entries = await readdir(targetDirectory, { withFileTypes: true });
  const path = join(targetDirectory, expected);
  if (entries.some(entry => entry.isFile() && entry.name === expected)) return path;
  throw new Error(`cargo-component did not emit ${expected} under ${targetDirectory}`);
}

try {
  if (declaredWorld !== "proprium:plugin/plugin@2.0.0") throw new Error(`Unsupported Research world: ${declaredWorld}`);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(assetOutput, { recursive: true });
  await mkdir(dirname(cargoTargetDirectory), { recursive: true });
  await generateAssetGroup();

  const cargo = process.env.CARGO ?? "cargo";
  run(cargo, ["component", "build", "--manifest-path", join(sourceDirectory, "model/Cargo.toml"), "--target", "wasm32-unknown-unknown", "--release", "--locked"], sourceDirectory);
  await cp(await findModelComponent(cargoTargetDirectory), modelComponent);

  await cp(dirname(sharedWitFile), temporaryWitDirectory, { recursive: true });
  const mainWit = join(temporaryWitDirectory, basename(sharedWitFile));
  const [mainSource, modelSource] = await Promise.all([
    readFile(mainWit, "utf8"), readFile(join(sourceDirectory, "model/wit/world.wit"), "utf8"),
  ]);
  const morphologyInterface = modelSource.match(/interface morphology\s*\{[\s\S]*?\n\}/u)?.[0];
  if (!morphologyInterface) throw new Error("Research model WIT does not declare the morphology interface");
  const worldPattern = /(world plugin\s*\{)/u;
  if (!worldPattern.test(mainSource)) throw new Error("Shared plugin WIT does not contain the plugin world");
  await writeFile(mainWit, mainSource.replace(worldPattern, `${morphologyInterface}\n\n$1\n  import morphology;`));

  run(jco, ["componentize", join(sourceDirectory, "component-guest.ts"), "--wit", temporaryWitDirectory,
    "--world-name", declaredWorld, "--disable", "all", "--bundle", "-o", guestComponent], sourceDirectory);
  run("wasm-tools", ["compose", guestComponent, "--definitions", modelComponent, "-o", output], sourceDirectory);
  const wit = execFileSync(jco, ["wit", output], { cwd: sourceDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: process.env });
  const imports = [...wit.matchAll(/\bimport\s+([^;]+);/gu)].map(match => match[1].trim());
  const exports = [...wit.matchAll(/\bexport\s+([^;]+);/gu)].map(match => match[1].trim());
  if (imports.length !== 1 || imports[0] !== "proprium:plugin/host@2.0.0" || exports.length !== 1 || exports[0] !== "proprium:plugin/guest@2.0.0" || /\bwasi[:_-]/iu.test(wit)) {
    throw new Error("Research component must expose only the v2 Host import and guest export");
  }
  console.log(`Built Research component at ${output}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
  if (ownsCargoTargetDirectory) await rm(cargoTargetDirectory, { recursive: true, force: true });
}
