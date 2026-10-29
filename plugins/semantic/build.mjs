import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import { generatePinnedAssets } from "./asset-build.mjs";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageDirectory, "../..");
const sourceDirectory = resolve(process.env.PROPRIUM_PLUGIN_SOURCE_DIR ?? packageDirectory);
const output = resolve(process.env.PROPRIUM_PLUGIN_BUILD_OUTPUT ?? join(packageDirectory, "dist/plugin.component.wasm"));
const assetOutput = resolve(process.env.PROPRIUM_PLUGIN_ASSET_OUTPUT_DIR ?? join(packageDirectory, "dist/plugin-assets"));
const declaredWorld = process.env.PROPRIUM_PLUGIN_V2_WORLD ?? "proprium:plugin/plugin@2.0.0";
if (declaredWorld !== "proprium:plugin/plugin@2.0.0") throw new Error(`Unsupported Semantic world: ${declaredWorld}`);

const jco = process.env.PROPRIUM_PLUGIN_JCO_BIN ?? resolve(repositoryRoot, "node_modules/.bin/jco");
const sharedWitFile = resolve(process.env.PROPRIUM_PLUGIN_V2_WIT ?? join(repositoryRoot, "app/src/browser/proprium/plugin-runtime/wit-v2/main.wit"));
const sharedWitDirectory = dirname(sharedWitFile);
const cargoTargetDirectory = resolve(process.env.CARGO_TARGET_DIR ?? await mkdtemp(join(tmpdir(), "semantic-cargo-target-")));
const ownsCargoTargetDirectory = !process.env.CARGO_TARGET_DIR;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "semantic-component-"));
const temporaryWitDirectory = join(temporaryDirectory, "wit-v2");
const modelComponent = join(temporaryDirectory, "semantic-inference.wasm");
const rerankerComponent = join(temporaryDirectory, "semantic-reranker.wasm");
const guestComponent = join(temporaryDirectory, "semantic-guest.wasm");

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDirectory },
  });
}

async function findComponent(directory, expected) {
  const targetDirectory = join(directory, "wasm32-unknown-unknown", "release");
  const entries = await readdir(targetDirectory, { withFileTypes: true });
  const path = join(targetDirectory, expected);
  if (entries.some((entry) => entry.isFile() && entry.name === expected)) return path;
  throw new Error(`cargo-component did not emit ${expected} under ${targetDirectory}`);
}

try {
  const metadata = JSON.parse(await readFile(join(sourceDirectory, "plugin.json"), "utf8"));
  const group = metadata.asset_groups?.find(item => item.id === "proprium.semantic.embedding.e5-small");
  const rerankerGroup = metadata.asset_groups?.find(item => item.id === "proprium.semantic.reranker.bge-v2-m3");
  for (const ref of [group, rerankerGroup]) if (!ref || typeof ref.manifest_path !== "string" ||
      !/^proprium\/semantic\/assets\/manifests\/[a-f0-9]{64}\/manifest\.json$/u.test(ref.manifest_path)) throw new Error("Pinned Semantic asset group is missing");
  const manifestBytes = await readFile(join(sourceDirectory, group.manifest_path.slice("proprium/semantic/".length)));
  const sourcePrefix = "proprium/semantic/embedding/e5-small/";
  const upstream = "https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/";
  await generatePinnedAssets({ manifestBytes, group, outputDirectory: assetOutput, openFile: async path => {
    const relativePath = path.slice(sourcePrefix.length);
    if (relativePath === "provenance.json") return createReadStream(join(sourceDirectory, "embedding/e5-small/provenance.json"));
    const allowed = new Set(["onnx/model.onnx", "tokenizer.json", "sentencepiece.bpe.model", "config.json", "tokenizer_config.json", "special_tokens_map.json"]);
    if (!path.startsWith(sourcePrefix) || !allowed.has(relativePath)) throw new Error(`Unsupported Semantic asset source: ${path}`);
    const response = await fetch(new URL(relativePath, upstream));
    if (!response.ok || !response.body) throw new Error(`Semantic asset download failed (${response.status}): ${relativePath}`);
    return response.body;
  } });
  const rerankerManifestBytes = await readFile(join(sourceDirectory, rerankerGroup.manifest_path.slice("proprium/semantic/".length)));
  const rerankerPrefix = "proprium/semantic/reranker/bge-reranker-v2-m3/";
  const rerankerSource = JSON.parse(await readFile(join(sourceDirectory, "reranker/model-source.json"), "utf8"));
  const rerankerUpstream = `https://huggingface.co/${rerankerSource.model_id}/resolve/${rerankerSource.revision}/`;
  const rerankerPaths = new Set(rerankerSource.files.map(file => file.path));
  await generatePinnedAssets({ manifestBytes: rerankerManifestBytes, group: rerankerGroup, outputDirectory: assetOutput, openFile: async path => {
    const relativePath = path.slice(rerankerPrefix.length);
    if (!path.startsWith(rerankerPrefix)) throw new Error(`Unsupported BGE asset source: ${path}`);
    if (relativePath === "provenance.json") return createReadStream(join(sourceDirectory, "reranker/provenance.json"));
    if (!rerankerPaths.has(relativePath)) throw new Error(`Unsupported pinned BGE asset source: ${relativePath}`);
    const response = await fetch(new URL(relativePath, rerankerUpstream));
    if (!response.ok || !response.body) throw new Error(`BGE asset download failed (${response.status}): ${relativePath}`);
    return response.body;
  } });
  await mkdir(dirname(output), { recursive: true });
  await mkdir(dirname(cargoTargetDirectory), { recursive: true });

  const cargo = process.env.CARGO ?? "cargo";
  run(cargo, [
    "component", "build",
    "--manifest-path", join(sourceDirectory, "model/Cargo.toml"),
    "--target", "wasm32-unknown-unknown",
    "--release",
    "--locked",
  ], sourceDirectory);
  run(cargo, [
    "component", "build",
    "--manifest-path", join(sourceDirectory, "reranker/Cargo.toml"),
    "--target", "wasm32-unknown-unknown",
    "--release",
    "--locked",
  ], sourceDirectory);
  const compiledModel = await findComponent(cargoTargetDirectory, "proprium_semantic_inference.wasm");
  await cp(compiledModel, modelComponent);
  const compiledReranker = await findComponent(cargoTargetDirectory, "proprium_semantic_reranker.wasm");
  await cp(compiledReranker, rerankerComponent);

  await cp(sharedWitDirectory, temporaryWitDirectory, { recursive: true });
  const mainWit = join(temporaryWitDirectory, basename(sharedWitFile));
  const [mainSource, modelSource] = await Promise.all([
    readFile(mainWit, "utf8"),
    readFile(join(sourceDirectory, "model/wit/world.wit"), "utf8"),
  ]);
  const inferenceInterface = modelSource.match(/interface inference\s*\{[\s\S]*?\n\}/u)?.[0];
  if (!inferenceInterface) throw new Error("Semantic model WIT does not declare the inference interface");
  const worldPattern = /(world plugin\s*\{)/u;
  if (!worldPattern.test(mainSource)) throw new Error("Shared plugin WIT does not contain the plugin world");
  const extendedWit = mainSource.replace(worldPattern, `${inferenceInterface}\n\n$1\n  import inference;\n  import proprium:semantic-reranker/inference@1.0.0;`);
  await writeFile(mainWit, extendedWit);
  const rerankerWitPackage = join(temporaryWitDirectory, "deps/proprium-semantic-reranker");
  await mkdir(rerankerWitPackage, { recursive: true });
  await cp(join(sourceDirectory, "reranker/wit/world.wit"), join(rerankerWitPackage, "world.wit"));

  run(jco, [
    "componentize",
    join(sourceDirectory, "component-guest.ts"),
    "--wit", temporaryWitDirectory,
    "--world-name", declaredWorld,
    "--disable", "all",
    "--bundle",
    "-o", guestComponent,
  ], sourceDirectory);

  run("wasm-tools", ["compose", guestComponent, "--definitions", modelComponent,
    "--definitions", rerankerComponent, "-o", output], sourceDirectory);
  run(jco, ["wit", output], sourceDirectory);
  console.log(`Built Semantic component at ${output}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
  if (ownsCargoTargetDirectory) await rm(cargoTargetDirectory, { recursive: true, force: true });
}
