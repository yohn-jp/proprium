import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageDirectory, "../..");
const sourceDirectory = resolve(process.env.PROPRIUM_PLUGIN_SOURCE_DIR ?? packageDirectory);
const output = resolve(process.env.PROPRIUM_PLUGIN_BUILD_OUTPUT ?? join(packageDirectory, "dist/plugin.component.wasm"));
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
const guestComponent = join(temporaryDirectory, "semantic-guest.wasm");

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDirectory },
  });
}

async function findModelComponent(directory) {
  const expected = "proprium_semantic_inference.wasm";
  const targetDirectory = join(directory, "wasm32-unknown-unknown", "release");
  const entries = await readdir(targetDirectory, { withFileTypes: true });
  const path = join(targetDirectory, expected);
  if (entries.some((entry) => entry.isFile() && entry.name === expected)) return path;
  throw new Error(`cargo-component did not emit ${expected} under ${targetDirectory}`);
}

try {
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
  const compiledModel = await findModelComponent(cargoTargetDirectory);
  await cp(compiledModel, modelComponent);

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
  const extendedWit = mainSource.replace(worldPattern, `${inferenceInterface}\n\n$1\n  import inference;`);
  await writeFile(mainWit, extendedWit);

  run(jco, [
    "componentize",
    join(sourceDirectory, "component-guest.ts"),
    "--wit", temporaryWitDirectory,
    "--world-name", declaredWorld,
    "--disable", "all",
    "--bundle",
    "-o", guestComponent,
  ], sourceDirectory);

  run("wasm-tools", ["compose", guestComponent, "--definitions", modelComponent, "-o", output], sourceDirectory);
  run(jco, ["wit", output], sourceDirectory);
  console.log(`Built Semantic component at ${output}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
  if (ownsCargoTargetDirectory) await rm(cargoTargetDirectory, { recursive: true, force: true });
}
