import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CoreError, CoreStore } from "../../../packages/core/dist/index.js";
import { ModuleRuntime } from "../../../packages/module-runtime/dist/index.js";

const execFile = promisify(execFileCallback);
const root = await mkdtemp(join(tmpdir(), "scriptorium-semantic-scope-"));
const remote = join(root, "remote.git");
const seed = join(root, "seed");
let runtime;

async function git(cwd, ...args) {
  return (await execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}

async function writeProjectFile(relativePath, content) {
  const filePath = join(seed, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function modulePackage(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

try {
  await mkdir(seed, { recursive: true });
  await git(root, "init", "--bare", "--initial-branch=main", remote);
  await git(seed, "init", "--initial-branch=main");
  await git(seed, "config", "user.name", "P09 Core scope acceptance");
  await git(seed, "config", "user.email", "p09-scope@example.test");
  await writeProjectFile("meta/project.yaml", "id: semantic-scope-fixture\ntitle: Semantic scope fixture\n");
  await writeProjectFile("bible/characters/owner/profile.yaml", "id: char-owner\ntype: character\nname: Owner\naliases: [Owner]\n");
  await writeProjectFile("bible/characters/thief/profile.yaml", "id: char-thief\ntype: character\nname: Thief\naliases: [Thief]\n");
  await writeProjectFile("plot/volumes/v/volume.yaml", "id: vol-v\ntype: volume\norder: 0\n");
  await writeProjectFile("plot/volumes/v/chapters/c/chapter.yaml", "id: ch-c\ntype: chapter\nvolume: vol-v\norder: 0\n");
  await writeProjectFile("plot/volumes/v/chapters/c/scenes/one.yaml", "id: sc-one\ntype: scene\nchapter: ch-c\norder: 0\neffects:\n  - action: acquire_item\n    itemId: sword\n    characterId: char-owner\n");
  await writeProjectFile("plot/volumes/v/chapters/c/scenes/two.yaml", "id: sc-two\ntype: scene\nchapter: ch-c\norder: 1\neffects:\n  - action: use_item\n    itemId: sword\n    characterId: char-thief\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "Seed semantic scope fixture");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "-u", "origin", "main");
  await git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");

  const [storyPackage, nlpPackage, semanticPackage] = await Promise.all([
    modulePackage("../../story/package.json"),
    modulePackage("../../nlp/package.json"),
    modulePackage("../package.json"),
  ]);
  const storyEntry = new URL("../../story/dist/index.js", import.meta.url).href;
  const nlpEntry = new URL("../../nlp/dist/index.js", import.meta.url).href;
  const semanticEntry = new URL("../dist/index.js", import.meta.url).href;
  const runtimeCache = join(root, "runtime-cache");
  runtime = new ModuleRuntime({
    manifests: [storyPackage.scriptoriumModule, nlpPackage.scriptoriumModule, semanticPackage.scriptoriumModule],
    enabled: ["semantic"],
    cacheDirectory: runtimeCache,
    workerEntries: {
      nlp: fileURLToPath(new URL("../../nlp/dist/worker.js", import.meta.url)),
      semantic: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
    },
    loaders: {
      story: async (context) => (await import(storyEntry)).createModule(context),
      nlp: async (context) => (await import(nlpEntry)).createModule(context),
      semantic: async (context) => (await import(semanticEntry)).createModule(context),
    },
  });
  const store = new CoreStore({ dataDir: join(root, "core-state"), allowLocalRemotes: true });
  const project = await store.registerProject({ url: remote });
  const observed = await store.observe(project.id);
  assert.equal(observed.state, "fresh");
  const reader = await store.reader(project.id, "remote", observed.snapshot);
  const host = {
    projectId: project.id,
    reader,
    signal: new AbortController().signal,
    access: "owner",
    async propose(operations, evidence, proposalId) {
      return store.propose(project.id, {
        id: proposalId ?? "p09-semantic-dismissal",
        snapshot: reader.snapshot,
        operations,
        source: "module",
        ...(evidence ? { evidence } : {}),
      });
    },
  };

  const rebuilt = await runtime.invokeAction("semantic", "semantic.contradictions.rebuild", {}, host);
  assert.equal(rebuilt.ok, true, `semantic contradiction rebuild failed: ${JSON.stringify(rebuilt.error)}`);
  const candidate = rebuilt.data.candidates.find((item) => item.id.startsWith("rule:item-owner-mismatch:"));
  assert.ok(candidate, "the synthetic source effects should yield an ownership contradiction");
  const dismissed = await runtime.invokeAction("semantic", "semantic.contradictions.dismiss", { candidateId: candidate.id }, host);
  assert.equal(dismissed.ok, true, `semantic dismissal proposal failed: ${JSON.stringify(dismissed.error)}`);
  const proposal = dismissed.data.proposal;
  const operation = proposal.operations[0];
  assert.deepEqual(operation.readScopes.map(({ prefix }) => prefix).sort(), ["bible", "plot"]);
  await store.approve(project.id, {
    proposalId: proposal.id,
    operationIds: [operation.id],
    authorScope: "p09-semantic-scope-owner",
  });

  await writeProjectFile("bible/characters/owner/profile.yaml", "id: char-owner\ntype: character\nname: Owner\naliases: [Former Owner]\n");
  await git(seed, "add", "bible/characters/owner/profile.yaml");
  await git(seed, "commit", "-m", "Change a canonical Bible alias after review");
  await git(seed, "push", "origin", "main");
  await assert.rejects(
    store.checkpoint(project.id, operation),
    (error) => error instanceof CoreError && error.code === "scope_precondition_conflict",
  );
  console.log("PASS: actual semantic dismissal proposal carries Bible/plot revisions and Core rejects checkpoint after the Bible alias changes.");
} finally {
  await runtime?.shutdown();
  await rm(root, { recursive: true, force: true });
}
