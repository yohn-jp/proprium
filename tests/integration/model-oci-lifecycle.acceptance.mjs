import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { CoreStore } from "../../packages/core/dist/index.js";

const execFile = promisify(execFileCallback);
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const helperDirectory = dirname(fileURLToPath(import.meta.url));
const helperFilename = join(helperDirectory, "model-oci-lifecycle.container.mjs");
const defaultModelCache = "/tmp/scriptorium-model-runtime-edc033c/home/.arcadia/models";
const modelCache = resolve(process.env.SCRIPTORIUM_P13_MODEL_CACHE ?? defaultModelCache);
const modelRefs = {
  embedding: { id: "Xenova/multilingual-e5-small", revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78" },
  reranker: { id: "mogolloni/bge-reranker-v2-m3-onnx", revision: "e5023553f6c47f09057da7a19cdd79ef850a4985" },
};

async function run(command, args, options = {}) {
  const result = await execFile(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  });
  return result.stdout.trim();
}

async function git(cwd, ...args) {
  return run("git", args, { cwd, timeout: 60_000 });
}

async function writeText(directory, relative, contents) {
  const filename = join(directory, relative);
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, contents, "utf8");
}

async function writeYaml(directory, relative, value) {
  await writeText(directory, relative, JSON.stringify(value) + "\n");
}

async function choosePort() {
  const server = await import("node:net").then(({ createServer }) => createServer());
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

async function createFixture(directory, sceneCount = 240) {
  const remote = join(directory, "remote.git");
  const seed = join(directory, "seed");
  await mkdir(seed, { recursive: true });
  await git(directory, "init", "--bare", "--initial-branch=main", remote);
  await git(seed, "init", "--initial-branch=main");
  await git(seed, "config", "user.name", "P13 OCI Synthetic Author");
  await git(seed, "config", "user.email", "p13-oci@example.test");

  await writeYaml(seed, "meta/project.yaml", { id: "p13-oci-synthetic", title: "Synthetic OCI model lifecycle work" });
  await writeYaml(seed, "plot/volumes/v1/volume.yaml", { id: "vol-one", type: "volume", name: "第一巻", order: 1 });
  await writeYaml(seed, "plot/volumes/v1/chapters/c1/chapter.yaml", { id: "ch-one", type: "chapter", title: "第一章", volume: "vol-one", order: 1 });
  await writeText(seed, "bible/characters/hero/profile.yaml", [
    "id: char-hero",
    "type: character",
    "name: 星野",
    "aliases: [星野]",
    "voicePatterns:",
    "  firstPerson: [僕]",
    "",
  ].join("\n"));

  for (let index = 0; index < sceneCount; index += 1) {
    const suffix = String(index + 1).padStart(2, "0");
    const sceneId = "sc-synthetic-" + suffix;
    const manuscriptPath = "manuscript/v1/" + sceneId + ".md";
    await writeYaml(seed, "plot/volumes/v1/chapters/c1/scenes/" + sceneId + ".yaml", {
      id: sceneId,
      type: "scene",
      name: "合成場面 " + suffix,
      chapter: "ch-one",
      volume: "vol-one",
      order: index + 1,
      appears: ["char-hero"],
      speakerCount: 1,
      manuscript: manuscriptPath,
    });
    const contrast = index % 2 === 0 ? "雨上がりの路地に白い花が咲いた。" : "朝の市場で赤い林檎を買った。";
    const dialogue = index === 0 ? "星野は灯りを見た。『俺が行く。』" : "星野は灯りを見た。『僕が行く。』";
    await writeText(seed, manuscriptPath, [
      "---",
      "title: " + sceneId,
      "---",
      "夜遅く駅に着き、青い切符を握りしめた。静かなホームで遠い汽笛を聞いた。",
      contrast,
      dialogue,
      "",
    ].join("\n"));
  }

  const nlpSettings = JSON.stringify({
    externalEnabled: { "setting-qa": false, rewrite: false },
    ownerNote: "preserve-local-consent",
  }, null, 2) + "\n";
  const semanticSettings = JSON.stringify({ schemaVersion: 1, rerankerEnabled: false }, null, 2) + "\n";
  const dismissals = JSON.stringify({ candidateId: "author-dismissed-p13-oci-fixture", timestamp: "2026-10-17T00:00:00.000Z" }) + "\n";
  await writeText(seed, "meta/scriptorium/modules/nlp/feature-settings.json", nlpSettings);
  await writeText(seed, "meta/scriptorium/modules/semantic/settings.json", semanticSettings);
  await writeText(seed, "meta/scriptorium/modules/semantic/contradiction-dismissals.jsonl", dismissals);

  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "Seed synthetic P13 OCI acceptance work");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-u", "origin", "main");
  await git(directory, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  return { remote, seed, nlpSettings, semanticSettings, dismissals };
}

function safeBuildEnvironment() {
  const names = [
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "XDG_RUNTIME_DIR",
    "TMPDIR", "SSL_CERT_FILE", "NIX_SSL_CERT_FILE", "NIX_PATH", "NIX_PROFILES",
    "DBUS_SESSION_BUS_ADDRESS",
  ];
  return Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
}

async function waitForReplacementReady(podman, name) {
  const script = 'fetch("http://127.0.0.1:3000/health/live").then(async (response) => { await response.arrayBuffer(); if (!response.ok) process.exit(1); }).catch(() => process.exit(1));';
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await run(podman, ["exec", name, "node", "-e", script], { timeout: 5_000, maxBuffer: 256_000 });
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error("replacement full-profile OCI server did not become live");
}

test("full OCI runs actual tokenizer, speaker, E5 and BGE lifecycle and survives replacement", { timeout: 900_000 }, async () => {
  const podman = process.env.OCI_ENGINE ?? "podman";
  const commit = await git(root, "rev-parse", "HEAD");
  const tree = await git(root, "rev-parse", "HEAD^{tree}");
  const image = process.env.SCRIPTORIUM_P13_IMAGE ?? "localhost/scriptorium:p13-full-" + commit.slice(0, 7);
  const port = await choosePort();
  const verifyEnvironment = {
    ...safeBuildEnvironment(),
    OCI_ENGINE: podman,
    SCRIPTORIUM_PROFILE: "full",
    SCRIPTORIUM_OCI_IMAGE: image,
    SCRIPTORIUM_OCI_PORT: String(port),
  };
  const verifyOutput = await run("bash", ["scripts/verify-oci.sh"], { env: verifyEnvironment, timeout: 600_000 });
  const verificationLines = verifyOutput.split("\n").filter((line) =>
    line.startsWith("OCI startup checks passed:") ||
    line.startsWith("Image ID:") ||
    line.startsWith("Startup cgroup measurement:") ||
    line.startsWith("Startup process measurement:") ||
    line.startsWith("OCI shutdown check passed:")
  );
  assert.ok(verificationLines.some((line) => line.startsWith("OCI startup checks passed:")), "the existing full-profile OCI verifier must pass");
  assert.ok(verificationLines.some((line) => line.startsWith("OCI shutdown check passed:")), "the production launcher must drain on SIGTERM");
  const imageInspection = await run(podman, [
    "image", "inspect", "--format", "{{.Id}} {{.Digest}} {{.Os}}/{{.Architecture}} {{.Size}}", image,
  ]);
  const [imageId, imageDigest, platform, imageBytes] = imageInspection.split(" ");
  assert.match(imageId, /^(?:sha256:)?[a-f0-9]{64}$/u);
  assert.match(imageDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(platform, "linux/amd64");

  const modelCacheStat = await run("stat", ["-c", "%F", modelCache]);
  assert.equal(modelCacheStat, "directory");
  for (const model of Object.values(modelRefs)) {
    const modelDir = join(modelCache, model.id, model.revision, "onnx");
    assert.equal(await run("stat", ["-c", "%F", modelDir]), "directory");
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "scriptorium-p13-full-oci-"));
  const dataDirectory = join(temporaryRoot, "data");
  const outputDirectory = join(temporaryRoot, "output");
  const envFilename = join(temporaryRoot, "container.env");
  const customName = "scriptorium-p13-lifecycle-" + process.pid + "-" + randomBytes(4).toString("hex");
  const replacementName = "scriptorium-p13-replacement-" + process.pid + "-" + randomBytes(4).toString("hex");
  const token = randomBytes(32).toString("hex");
  let customStarted = false;
  let replacementStarted = false;
  let candidatePassed = false;

  try {
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const fixture = await createFixture(temporaryRoot);
    const store = new CoreStore({ dataDir: dataDirectory, allowLocalRemotes: true });
    const project = await store.registerProject({ url: fixture.remote });
    const observed = await store.observe(project.id);
    assert.equal(observed.state, "fresh");
    const modelLink = join(dataDirectory, "module-cache", "semantic", "semantic", "models");
    await mkdir(dirname(modelLink), { recursive: true });
    await symlink("/models", modelLink);

    await writeFile(envFilename, [
      "SCRIPTORIUM_AUTH_TOKEN=" + token,
      "P13_PROJECT_ID=" + project.id,
      "",
    ].join("\n"), { mode: 0o600 });

    const outputVolume = outputDirectory + ":/p13-output:rw";
    const commonMounts = [
      "--volume", dataDirectory + ":/data:rw",
      "--volume", fixture.remote + ":" + fixture.remote + ":ro",
      "--volume", modelCache + ":/models:ro",
      "--volume", helperDirectory + ":/app/p13-harness:ro",
      "--volume", outputVolume,
    ];
    const commonEnv = [
      "--env-file", envFilename,
      "--env", "HOST=0.0.0.0",
      "--env", "PORT=3000",
      "--env", "SCRIPTORIUM_PROFILE=full",
      "--env", "SCRIPTORIUM_DATA_DIR=/data",
      "--env", "SCRIPTORIUM_USAGE_DIR=/history",
      "--env", "SCRIPTORIUM_MODULE_CACHE_DIR=/data/module-cache",
      "--env", "HF_HUB_OFFLINE=1",
    ];

    await run(podman, [
      "run", "--detach", "--name", customName, "--userns=keep-id", "--network=none",
      ...commonEnv, ...commonMounts, image,
      "node", "/app/p13-harness/model-oci-lifecycle.container.mjs", "lifecycle",
    ], { timeout: 30_000 });
    customStarted = true;
    const customExit = await run(podman, ["wait", customName], { timeout: 720_000, maxBuffer: 256_000 });
    if (customExit !== "0") {
      const logs = await run(podman, ["logs", customName], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }).catch(() => "");
      const failure = await readFile(join(outputDirectory, "failure.json"), "utf8").catch(() => "");
      throw new Error("in-container lifecycle acceptance exited with " + customExit +
        (failure ? "\n" + failure.slice(-12_000) : "") +
        (logs ? "\n" + logs.slice(-12_000) : ""));
    }

    const lifecycle = JSON.parse(await readFile(join(outputDirectory, "lifecycle.json"), "utf8"));
    assert.equal(lifecycle.profile, "full");
    assert.deepEqual(lifecycle.installedModules, ["story", "nlp", "diagnostics", "semantic", "speaker", "assistant", "publishing", "mcp"]);
    assert.equal(lifecycle.assertions.noWorkerAtEnabledIdle, true);
    assert.equal(lifecycle.assertions.disableOneConsumerPreservesOther, true);
    assert.equal(lifecycle.assertions.lastLeaseStopsWorker, true);
    assert.equal(lifecycle.assertions.derivedCacheDeletionAndRebuild.recovered, true);
    assert.equal(lifecycle.assertions.replacementSearch.reranker.revision, modelRefs.reranker.revision);
    assert.ok(lifecycle.resourceMeasurements.healthProbe.successfulRequests > 0);
    assert.equal(lifecycle.resourceMeasurements.healthProbe.failures, 0);
    const lifecyclePhases = new Map(lifecycle.phases.map((phase) => [phase.name, phase]));
    for (const phase of ["actual-nlp-tokenizer-child", "actual-speaker-and-lindera-children", "overlapping-diagnostics-and-semantic-real-capability", "replacement-e5-bge-search"]) {
      assert.ok(lifecyclePhases.has(phase), "missing lifecycle resource phase " + phase);
      assert.ok(lifecyclePhases.get(phase).peakCompiled.compiledWorkerCount > 0, "no compiled child was measured during " + phase);
    }
    assert.equal(lifecyclePhases.get("after-disable-before-replacement").last.compiledWorkerCount, 0);
    assert.ok(lifecyclePhases.get("replacement-e5-bge-search").peakSemantic.semanticWorkerCount > 0);

    const projectDirectory = join(dataDirectory, "projects", project.id);
    const preserved = {
      "meta/scriptorium/modules/nlp/feature-settings.json": fixture.nlpSettings,
      "meta/scriptorium/modules/semantic/settings.json": fixture.semanticSettings,
      "meta/scriptorium/modules/semantic/contradiction-dismissals.jsonl": fixture.dismissals,
    };
    for (const [relative, expected] of Object.entries(preserved)) {
      const actual = await readFile(join(projectDirectory, relative), "utf8");
      assert.equal(actual, expected, "module lifecycle must preserve author settings and dismissals: " + relative);
    }

    await run(podman, [
      "run", "--detach", "--name", replacementName, "--userns=keep-id", "--network=none",
      ...commonEnv, ...commonMounts, image,
    ], { timeout: 30_000 });
    replacementStarted = true;
    await waitForReplacementReady(podman, replacementName);
    await run(podman, [
      "exec", replacementName, "node", "/app/p13-harness/model-oci-lifecycle.container.mjs", "replacement-probe",
    ], { timeout: 360_000, maxBuffer: 2 * 1024 * 1024 });

    const replacement = JSON.parse(await readFile(join(outputDirectory, "replacement.json"), "utf8"));
    assert.equal(replacement.mode, "production-launcher-replacement");
    assert.equal(replacement.assertions.allEightModulesInstalledAndEnabled, true);
    assert.equal(replacement.assertions.noWorkerAtReplacementIdle, true);
    assert.equal(replacement.assertions.persistedDerivedIndex, true);
    assert.equal(replacement.assertions.realReplacementInference.reranker.revision, modelRefs.reranker.revision);
    assert.ok(replacement.resourceMeasurements.healthProbe.successfulRequests > 0);
    assert.equal(replacement.resourceMeasurements.healthProbe.failures, 0);

    await run(podman, ["kill", "--signal", "TERM", replacementName], { timeout: 20_000 });
    const replacementExit = await run(podman, ["wait", replacementName], { timeout: 45_000 });
    assert.equal(replacementExit, "0");
    const replacementLogs = await run(podman, ["logs", replacementName], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
    assert.ok(replacementLogs.includes("Scriptorium shutdown complete"), "production replacement must finish its SIGTERM drain");

    const candidateEvidence = {
      sourceCommit: commit,
      sourceTree: tree,
      image: { tag: image, id: imageId, digest: imageDigest, platform, bytes: Number(imageBytes) },
      verificationLines,
      modelCache,
      modelRefs,
      lifecycle,
      replacement,
    };
    console.log("P13 full OCI candidate evidence: " + JSON.stringify(candidateEvidence));
    candidatePassed = true;
  } finally {
    if (customStarted) await run(podman, ["rm", "--volumes", "--force", customName], { timeout: 30_000 }).catch(() => {});
    if (replacementStarted) await run(podman, ["rm", "--volumes", "--force", replacementName], { timeout: 30_000 }).catch(() => {});
    if (candidatePassed || process.env.SCRIPTORIUM_P13_KEEP_FAILED !== "1") {
      await rm(temporaryRoot, { recursive: true, force: true });
    } else {
      console.error("P13 synthetic acceptance data retained for diagnosis at " + temporaryRoot);
    }
  }
});
