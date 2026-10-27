import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repository = resolve(root, "../..");
const source = resolve(process.env.PROPRIUM_PLUGIN_SOURCE_DIR ?? root);
const output = resolve(process.env.PROPRIUM_PLUGIN_BUILD_OUTPUT ?? join(root, "dist/plugin.component.wasm"));
const jco = process.env.PROPRIUM_PLUGIN_JCO_BIN ?? join(repository, "node_modules/.bin/jco");
const wit = resolve(process.env.PROPRIUM_PLUGIN_V2_WIT ?? join(repository, "app/src/browser/proprium/plugin-runtime/wit-v2/main.wit"));
const world = process.env.PROPRIUM_PLUGIN_V2_WORLD ?? "proprium:plugin/plugin@2.0.0";
if (world !== "proprium:plugin/plugin@2.0.0") throw new Error("Unsupported Speaker world");
const temp = await mkdtemp(join(tmpdir(), "speaker-component-"));
const target = resolve(process.env.CARGO_TARGET_DIR ?? join(temp, "target"));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: source, stdio: "inherit", env: { ...process.env, CARGO_TARGET_DIR: target } });
try {
  run(process.env.CARGO ?? "cargo", ["component", "build", "--manifest-path", join(source, "segmenter/Cargo.toml"), "--target", "wasm32-unknown-unknown", "--release", "--locked"]);
  const witDir = join(temp, "wit"); await cp(dirname(wit), witDir, { recursive: true });
  const main = join(witDir, basename(wit));
  const original = await readFile(main, "utf8");
  const extra = await readFile(join(source, "segmenter/wit/world.wit"), "utf8");
  const iface = extra.match(/interface sentence-segmentation\s*\{[\s\S]*?\n\}/u)?.[0];
  if (!iface || !/world plugin\s*\{/u.test(original)) throw new Error("Speaker segmentation WIT is invalid");
  await writeFile(main, original.replace(/(world plugin\s*\{)/u, `${iface}\n\n$1\n  import sentence-segmentation;`));
  const guest = join(temp, "guest.wasm");
  run(jco, ["componentize", join(source, "component-guest.ts"), "--wit", witDir, "--world-name", world, "--disable", "all", "--bundle", "-o", guest]);
  await mkdir(dirname(output), { recursive: true });
  const segmenter = join(temp, "speaker-segmenter.wasm");
  await cp(join(target, "wasm32-unknown-unknown/release/proprium_speaker_segmenter.wasm"), segmenter);
  run("wasm-tools", ["compose", guest, "--definitions", segmenter, "-o", output]);
  run(jco, ["wit", output]);
} finally { await rm(temp, { recursive: true, force: true }); }
