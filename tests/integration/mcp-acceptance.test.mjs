import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { CoreStore } from "../../packages/core/dist/index.js";
import { ModuleRuntime } from "../../packages/module-runtime/dist/index.js";
import { createServer } from "../../packages/api/dist/server.js";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const moduleRequire = createRequire(resolve(root, "modules/mcp/package.json"));
const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }] = await Promise.all([
  import(moduleRequire.resolve("@modelcontextprotocol/sdk/client/index.js")),
  import(moduleRequire.resolve("@modelcontextprotocol/sdk/client/stdio.js")),
  import(moduleRequire.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")),
]);

const SOURCE_TOOL_NAMES = [
  "get_entity", "get_scene_context", "suggest_rewrite", "list_entities", "search", "get_volume_tree",
  "reload", "analyze_manuscript", "check_stylometric_deviations", "check_plot_semantics", "get_diagnostics",
  "get_thread_status", "get_dialogue", "format_manuscript", "create_scene", "update_entity",
  "check_consistency", "check_continuity", "compute_cooccurrence", "check_voice_consistency",
  "check_style_deviations", "get_writing_context", "get_context_manifest", "lint_manuscript",
  "submit_change_set", "get_change_set", "list_change_sets",
];
const READY_MODULES = (process.env.SCRIPTORIUM_MCP_ACCEPTANCE_MODULES ?? "story,nlp,diagnostics,semantic,speaker,publishing,mcp")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const ACCESS_TOKEN = randomBytes(32).toString("base64url");
const INITIAL_NAME = "Uma";
const UPDATED_NAME = "Uma Reviewed";
const SECOND_NAME = "Haru";
const MANUSCRIPT = "# Scene One\n\nUma enters the cafe at dusk.\n\n星野は灯りを見た。『俺が行く。』\n";

function fixtureFiles() {
  return {
    "bible/characters/char-uma/profile.yaml": [
      "id: char-uma", "name: Uma", "type: character", "aliases: [星野]", "tags: []", "relations: []", "voicePatterns:", "  firstPerson: [僕]", "",
    ].join("\n"),
    "bible/characters/char-haru/profile.yaml": [
      "id: char-haru", "name: Haru", "type: character", "aliases: []", "tags: []", "relations: []", "",
    ].join("\n"),
    "bible/locations/loc-cafe.yaml": "id: loc-cafe\nname: Cafe\ntype: location\n",
    "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntitle: Main\ntype: volume\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-main-1/chapter.yaml": "id: ch-main-1\nvolume: vol-main\ntitle: Opening\ntype: chapter\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-main-1/scenes/sc-1.yaml": [
      "id: sc-1", "title: Scene One", "type: scene", "volume: vol-main", "chapter: ch-main-1", "order: 1",
      "location: loc-cafe", "appears:", "  - char-uma", "speakerCount: 1", "manuscript: manuscript/vol-main/ch-main-1/sc-1.md", "",
    ].join("\n"),
    "manuscript/vol-main/ch-main-1/sc-1.md": MANUSCRIPT,
  };
}

async function git(cwd, ...args) {
  const { stdout } = await execFile("git", args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Scriptorium MCP acceptance",
      GIT_AUTHOR_EMAIL: "mcp-acceptance@example.invalid",
      GIT_COMMITTER_NAME: "Scriptorium MCP acceptance",
      GIT_COMMITTER_EMAIL: "mcp-acceptance@example.invalid",
    },
  });
  return stdout.trim();
}

async function createSyntheticRemote(rootDir) {
  const remote = resolve(rootDir, "fixture.git");
  const seed = resolve(rootDir, "seed");
  await mkdir(seed, { recursive: true });
  await git(rootDir, "init", "--bare", "--initial-branch=main", remote);
  await git(seed, "init", "--initial-branch=main");
  await git(seed, "config", "user.name", "Scriptorium MCP acceptance");
  await git(seed, "config", "user.email", "mcp-acceptance@example.invalid");
  for (const [path, content] of Object.entries(fixtureFiles())) {
    const filename = resolve(seed, path);
    await mkdir(dirname(filename), { recursive: true });
    await writeFile(filename, content, "utf8");
  }
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "Create synthetic MCP project");
  await git(seed, "remote", "add", "origin", remote);
  await git(seed, "push", "--set-upstream", "origin", "main");
  await git(rootDir, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  return { remote, url: `file://${remote}` };
}

async function runtimeOptions(cacheDirectory) {
  const manifests = [];
  const loaders = {};
  const moduleDirectories = {};
  const workerEntries = {};
  for (const id of READY_MODULES) {
    const directory = resolve(root, "modules", id);
    const metadata = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")).scriptoriumModule;
    assert.equal(metadata.id, id, `Missing real ${id} module manifest`);
    manifests.push(metadata);
    moduleDirectories[id] = directory;
    if (metadata.workerEntry) workerEntries[id] = resolve(directory, metadata.workerEntry);
    const entry = pathToFileURL(resolve(directory, metadata.serverEntry));
    loaders[id] = async (context) => {
      const module = await import(entry.href);
      assert.equal(typeof module.createModule, "function", `${id} must export createModule`);
      return module.createModule(context);
    };
  }
  return new ModuleRuntime({
    manifests,
    enabled: READY_MODULES,
    loaders,
    moduleDirectories,
    workerEntries,
    cacheDirectory,
  });
}

async function startHost({ dataDirectory, cacheDirectory, store: suppliedStore }) {
  const runtime = await runtimeOptions(cacheDirectory);
  const store = suppliedStore ?? new CoreStore({ dataDir: dataDirectory, allowLocalRemotes: true });
  const server = createServer({
    store,
    authToken: ACCESS_TOKEN,
    staticDir: resolve(root, "app/dist"),
    runtime,
    profile: "mcp-acceptance",
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "Production API failed to bind a test port");
  let closePromise;
  return {
    base: `http://127.0.0.1:${address.port}`,
    runtime,
    store,
    close() {
      closePromise ??= new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
      return closePromise;
    },
  };
}

async function apiRequest(host, path, { method = "GET", body, cookie, bearer = false } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (bearer) headers.Authorization = `Bearer ${ACCESS_TOKEN}`;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers.Origin = host.base;
  }
  return fetch(`${host.base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function responseJson(response, label) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} returned invalid JSON (HTTP ${response.status})`); }
}

async function ownerJson(host, cookie, path, { method = "GET", body, status = 200 } = {}) {
  const response = await apiRequest(host, path, { method, body, cookie });
  assert.equal(response.status, status, `${method} ${path} should return HTTP ${status}, got ${response.status}`);
  return response.status === 204 ? undefined : responseJson(response, `${method} ${path}`);
}

async function login(host) {
  const response = await apiRequest(host, "/api/login", { method: "POST", body: { token: ACCESS_TOKEN } });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie, "Owner login did not establish a cookie session");
  return cookie.split(";", 1)[0];
}

function success(result, name) {
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.structuredContent ?? result.content)}`);
  assert.ok(result.structuredContent, `${name} did not return MCP structured content`);
  return result.structuredContent;
}

function errorCode(result, name) {
  assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
  const content = result.structuredContent;
  assert.equal(typeof content?.error?.code, "string", `${name} did not return a typed error`);
  return content.error.code;
}

async function startStdioClient(host, projectId) {
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    SCRIPTORIUM_API_URL: host.base,
    SCRIPTORIUM_AUTH_TOKEN: ACCESS_TOKEN,
    SCRIPTORIUM_PROJECT_ID: projectId,
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, "modules/mcp/dist/stdio.js")],
    env: environment,
    cwd: root,
    stderr: "inherit",
  });
  const client = new Client({ name: "scriptorium-mcp-acceptance-stdio", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function startHttpClient(host, projectId) {
  const path = `/api/projects/${encodeURIComponent(projectId)}/modules/mcp/streamable`;
  const transport = new StreamableHTTPClientTransport(new URL(path, host.base), {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${ACCESS_TOKEN}`);
      return fetch(input, { ...init, headers });
    },
    reconnectionOptions: { maxReconnectionDelay: 100, initialReconnectionDelay: 10, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
  });
  const client = new Client({ name: "scriptorium-mcp-acceptance-http", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function closeMcpClient(connection, http = false) {
  if (!connection) return;
  if (http) await connection.transport.terminateSession().catch(() => undefined);
  await connection.client.close().catch(() => undefined);
  await connection.transport.close().catch(() => undefined);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(message);
}

async function verifyCancellation(connection, host, projectId, label) {
  const controller = new AbortController();
  const inputText = "あ".repeat(300_000);
  const request = connection.client.callTool({
    name: "invoke_action",
    arguments: { project_id: projectId, action_id: "nlp.analyze", input: { text: inputText } },
  }, undefined, { signal: controller.signal });
  await waitUntil(() => host.runtime.status("nlp").activeJobs > 0, 20_000, `${label} never reached the real NLP worker`);
  controller.abort(new Error("P08 integration cancellation"));
  const completed = await Promise.race([
    request.then((result) => ({ result }), (error) => ({ error })),
    delay(15_000).then(() => ({ timeout: true })),
  ]);
  assert.equal("timeout" in completed, false, `${label} cancellation did not settle the MCP request`);
  assert.ok("error" in completed || completed.result.isError === true, `${label} cancellation returned a successful result`);
  await waitUntil(() => host.runtime.status("nlp").activeJobs === 0, 15_000, `${label} cancellation did not stop the real worker job`);
}

function narrativeChangeSet(projectId, id, umaRevision, haruRevision) {
  const assessment = { confidence: 0.95, risk: "low" };
  return {
    schemaVersion: 1,
    id,
    projectId,
    goal: "Update two synthetic character profiles so only one can be approved",
    status: "proposed",
    assessment,
    operations: [
      {
        id: "update-uma",
        kind: "entity.update",
        precondition: { kind: "revision", value: umaRevision },
        target: { entityId: "char-uma" },
        changes: { name: UPDATED_NAME },
        evidenceIds: [],
        assessment,
      },
      {
        id: "update-haru",
        kind: "entity.update",
        precondition: { kind: "revision", value: haruRevision },
        target: { entityId: "char-haru" },
        changes: { name: "Haru Unapproved" },
        evidenceIds: [],
        assessment,
      },
    ],
    evidence: [],
    diagnostics: { before: null, after: null },
  };
}

async function readRemoteFile(remote, path) {
  return git(root, "--git-dir", remote, "show", `main:${path}`);
}

async function remoteContainsString(remote, value) {
  return (await git(root, "--git-dir", remote, "log", "--all", "--format=%H", "--fixed-strings", `-S${value}`)).length > 0;
}

test("spawned stdio and production HTTP MCP preserve Core review boundaries through publish and restart", {
  timeout: 240_000,
}, async (t) => {
  assert.equal(SOURCE_TOOL_NAMES.length, 27);
  const rootDir = await mkdtemp(resolve(tmpdir(), "scriptorium-p08-mcp-acceptance-"));
  const dataDirectory = resolve(rootDir, "core-data");
  const staticDirectory = resolve(rootDir, "static");
  await mkdir(staticDirectory, { recursive: true });
  const fixture = await createSyntheticRemote(rootDir);
  let host;
  let stdio;
  let http;
  t.after(async () => {
    await closeMcpClient(http, true);
    await closeMcpClient(stdio);
    await host?.close().catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true });
  });

  host = await startHost({ dataDirectory, cacheDirectory: resolve(rootDir, "module-cache-first") });
  let cookie = await login(host);
  const project = await ownerJson(host, cookie, "/api/projects", {
    method: "POST",
    status: 201,
    body: { url: fixture.url },
  });
  assert.ok(project?.id && project.branch === "main", "Core did not register the synthetic local Git project");
  const projectId = project.id;

  stdio = await startStdioClient(host, projectId);
  http = await startHttpClient(host, projectId);
  for (const [name, connection] of [["stdio", stdio], ["HTTP", http]]) {
    const listed = await connection.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.equal(names.length, new Set(names).size, `${name} MCP discovery duplicated a tool`);
    for (const tool of SOURCE_TOOL_NAMES) assert.ok(names.includes(tool), `${name} MCP is missing source tool ${tool}`);
  }

  const projects = success(await stdio.client.callTool({ name: "list_projects", arguments: {} }), "list_projects");
  assert.ok(projects.data.projects.some((item) => item.id === projectId), "Bearer stdio project discovery omitted its owner project");
  const actions = success(await stdio.client.callTool({ name: "discover_actions", arguments: { project_id: projectId } }), "discover_actions");
  const actionIds = new Set(actions.data.actions.map((item) => item.id));
  for (const action of ["core.status", "core.history", "story.entities.get", "story.scene.context", "diagnostics.analyze", "publishing.export.plaintext"]) {
    assert.ok(actionIds.has(action), `Composed runtime omitted ${action}`);
  }
  if (READY_MODULES.includes("semantic")) assert.ok(actionIds.has("semantic.search"));
  if (READY_MODULES.includes("speaker")) {
    assert.ok(actionIds.has("speaker.dialogue.list"));
    assert.ok(actionIds.has("speaker.voice.check"));
  }

  const status = success(await http.client.callTool({
    name: "get_status", arguments: { project_id: projectId },
  }), "HTTP get_status");
  assert.ok(status.snapshot.remoteCommit && status.data);
  const history = success(await stdio.client.callTool({
    name: "get_history", arguments: { project_id: projectId },
  }), "stdio get_history");
  assert.ok(Array.isArray(history.data));

  const entity = success(await stdio.client.callTool({
    name: "get_entity", arguments: { project_id: projectId, id: "char-uma" },
  }), "get_entity");
  assert.equal(entity.data.name, INITIAL_NAME);
  assert.equal(typeof entity.data.revision, "string");
  const scene = success(await http.client.callTool({
    name: "get_scene_context", arguments: { project_id: projectId, scene_id: "sc-1" },
  }), "HTTP get_scene_context");
  assert.equal(scene.data.scene.id, "sc-1");
  assert.match(scene.data.manuscriptBody, /Uma enters the cafe/u);
  const context = success(await http.client.callTool({
    name: "get_writing_context", arguments: { project_id: projectId, scene_id: "sc-1" },
  }), "HTTP get_writing_context");
  assert.match(context.data.saved_manuscript.text, /Uma enters the cafe/u);
  assert.equal(context.data.scene.id, "sc-1");
  const manifest = success(await stdio.client.callTool({
    name: "get_context_manifest", arguments: { project_id: projectId, scene_id: "sc-1" },
  }), "get_context_manifest");
  assert.equal(manifest.data.scope, "arcadia_provided_context");
  assert.ok(manifest.data.parts.some((part) => part.kind === "scene" && part.source_identity.scene_id === "sc-1"));
  const savedPart = manifest.data.parts.find((part) => part.kind === "saved_manuscript");
  assert.ok(savedPart);
  assert.equal(savedPart.size.included_character_count, 0);
  assert.equal("text" in savedPart, false);

  const analysis = success(await stdio.client.callTool({
    name: "analyze_manuscript", arguments: { project_id: projectId, scene_id: "sc-1" },
  }), "analyze_manuscript");
  assert.ok(analysis.data.analysis && analysis.snapshot.remoteCommit, "Diagnostics/NLP did not analyze the saved scene through the host snapshot");
  const consistency = success(await http.client.callTool({
    name: "check_consistency", arguments: { project_id: projectId },
  }), "HTTP check_consistency");
  assert.ok(Array.isArray(consistency.data.issues));
  const continuity = success(await stdio.client.callTool({
    name: "check_continuity", arguments: { project_id: projectId },
  }), "check_continuity");
  assert.ok(Array.isArray(continuity.data));
  const plaintext = success(await http.client.callTool({
    name: "invoke_action",
    arguments: { project_id: projectId, action_id: "publishing.export.plaintext", input: { scope: "all", stripMarkup: false } },
  }), "publishing.export.plaintext");
  assert.match(Buffer.from(plaintext.data.contentBase64, "base64").toString("utf8"), /Uma enters the cafe/u);

  if (READY_MODULES.includes("semantic")) {
    const search = success(await stdio.client.callTool({
      name: "search", arguments: { project_id: projectId, query: "cafe", limit: 10 },
    }), "source hybrid search");
    assert.equal(search.data.query, "cafe");
    assert.ok(Array.isArray(search.data.results));
    assert.ok(search.data.results.some((item) => item.sceneId === "sc-1" || item.sceneId === "loc-cafe"),
      `Semantic source search did not return a lexical fixture hit: ${JSON.stringify(search.data.results)}`);
  } else {
    assert.equal(errorCode(await stdio.client.callTool({
      name: "search", arguments: { project_id: projectId, query: "cafe" },
    }), "search"), "MODULE_UNAVAILABLE");
  }

  if (READY_MODULES.includes("speaker")) {
    const dialogue = success(await stdio.client.callTool({
      name: "get_dialogue", arguments: { project_id: projectId, character_id: "char-uma", scene_id: "sc-1", min_confidence: "low" },
    }), "source speaker dialogue list");
    assert.equal(dialogue.data.character_id, "char-uma");
    assert.ok(Array.isArray(dialogue.data.lines));
    assert.equal(dialogue.data.count, dialogue.data.lines.length);
    assert.ok(dialogue.data.lines.some((line) => line.sceneId === "sc-1"),
      "The source fixture dialogue was not attributed to Uma");

    for (const tool of ["check_voice_consistency", "check_style_deviations", "check_stylometric_deviations"]) {
      const result = success(await http.client.callTool({
        name: tool, arguments: { project_id: projectId, scene_id: "sc-1" },
      }), `source speaker ${tool}`);
      assert.ok(Array.isArray(result.data), `${tool} must preserve the source warning-array result`);
      assert.ok(result.snapshot?.remoteCommit, `${tool} omitted the pinned Core snapshot`);
    }
  } else {
    for (const tool of ["get_dialogue", "check_voice_consistency", "check_style_deviations", "check_stylometric_deviations"]) {
      const unavailable = await stdio.client.callTool({
        name: tool,
        arguments: { project_id: projectId, character_id: "char-uma", scene_id: "sc-1" },
      });
      assert.equal(errorCode(unavailable, tool), "MODULE_UNAVAILABLE");
    }
  }
  const fullDiagnostics = await http.client.callTool({
    name: "get_diagnostics", arguments: { project_id: projectId, scene_id: "sc-1" },
  });
  assert.equal(errorCode(fullDiagnostics, "get_diagnostics"), "ACTION_UNAVAILABLE");

  await verifyCancellation(stdio, host, projectId, "spawned stdio");
  await verifyCancellation(http, host, projectId, "Streamable HTTP");

  const uma = success(await stdio.client.callTool({
    name: "get_entity", arguments: { project_id: projectId, id: "char-uma" },
  }), "read Uma revision");
  const haru = success(await stdio.client.callTool({
    name: "get_entity", arguments: { project_id: projectId, id: "char-haru" },
  }), "read Haru revision");
  const beforeUma = await readRemoteFile(fixture.remote, "bible/characters/char-uma/profile.yaml");
  const beforeHaru = await readRemoteFile(fixture.remote, "bible/characters/char-haru/profile.yaml");

  const directMutation = success(await stdio.client.callTool({
    name: "update_entity",
    arguments: {
      project_id: projectId,
      id: "char-haru",
      base_revision: haru.data.revision,
      operation_id: `mcp-direct-persistent-check-${randomUUID()}`,
      patch: { name: "Haru MCP Proposed" },
    },
  }), "source update_entity proposal");
  assert.equal(directMutation.proposals?.[0]?.source, "mcp",
    "A bearer mutation tool must become a host-sourced MCP proposal");
  assert.equal(await readRemoteFile(fixture.remote, "bible/characters/char-haru/profile.yaml"), beforeHaru,
    "A source mutation tool bypassed author review and wrote directly to the remote");

  const changeSetId = `mcp-acceptance-${randomUUID().replaceAll("-", "")}`;
  const changeSet = narrativeChangeSet(projectId, changeSetId, uma.data.revision, haru.data.revision);
  const submitted = await stdio.client.callTool({
    name: "submit_change_set", arguments: { project_id: projectId, change_set: changeSet },
  });
  const sourceRecord = success(submitted, "submit_change_set");
  assert.equal(sourceRecord.changeSet.id, changeSetId);
  assert.equal(sourceRecord.status, "proposed");
  assert.equal((await readRemoteFile(fixture.remote, "bible/characters/char-uma/profile.yaml")), beforeUma,
    "MCP proposal wrote to the synthetic Git remote before owner review");

  const proposalEnvelope = await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/proposals`);
  const proposalStatus = proposalEnvelope.proposals.find((item) => item.proposal?.id === changeSetId);
  assert.ok(proposalStatus, "Core did not persist the MCP proposal");
  const proposal = proposalStatus.proposal;
  const originalCoreProposal = structuredClone(proposal);
  assert.equal(proposal.source, "mcp", "Production API must assign the MCP proposal source");
  const sourceIdentity = proposal.evidence.find((item) => item.kind === "source.narrative-change-set.v1");
  assert.ok(sourceIdentity?.details?.operationMap, "Story did not persist source operation identities in Core evidence");
  const selectedCoreOperationId = sourceIdentity.details.operationMap["update-uma"];
  const unselectedCoreOperationId = sourceIdentity.details.operationMap["update-haru"];
  const selectedOperation = proposal.operations.find((item) => item.id === selectedCoreOperationId);
  assert.ok(selectedOperation, "Core proposal omitted the selected source operation");

  const directCheckpoint = await http.client.callTool({
    name: "invoke_action",
    arguments: { project_id: projectId, action_id: "core.checkpoint", input: selectedOperation },
  });
  assert.equal(errorCode(directCheckpoint, "direct bearer checkpoint action"), "FORBIDDEN");

  for (const route of ["approvals", "checkpoints", "publish"]) {
    const body = route === "approvals"
      ? { proposalId: proposal.id, operationIds: [selectedCoreOperationId] }
      : route === "checkpoints" ? selectedOperation : { batchId: `mcp-bearer-${randomUUID().replaceAll("-", "")}` };
    const denied = await apiRequest(host, `/api/projects/${encodeURIComponent(projectId)}/${route}`, {
      method: "POST", body, bearer: true,
    });
    assert.equal(denied.status, 403, `Bearer MCP credentials must not perform ${route}`);
  }
  assert.equal(await readRemoteFile(fixture.remote, "bible/characters/char-haru/profile.yaml"), beforeHaru,
    "Bearer review attempts changed an unapproved profile");

  await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/approvals`, {
    method: "POST", status: 204, body: { proposalId: proposal.id, operationIds: [selectedCoreOperationId] },
  });
  await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/checkpoints`, {
    method: "POST", status: 201, body: selectedOperation,
  });

  const httpPartial = success(await http.client.callTool({
    name: "get_change_set", arguments: { project_id: projectId, change_set_id: changeSetId },
  }), "HTTP partial ChangeSet status");
  assert.equal(httpPartial.status, "partially-applied");
  assert.deepEqual(httpPartial.approvedOperationIds, ["update-uma"]);
  assert.equal(httpPartial.result.operations.length, 1);
  assert.equal(httpPartial.result.operations[0].resultId, "char-uma");
  assert.equal(await readRemoteFile(fixture.remote, "bible/characters/char-uma/profile.yaml"), beforeUma,
    "A Core checkpoint unexpectedly changed the remote before publish");
  assert.equal(await remoteContainsString(fixture.remote, "Haru Unapproved"), false,
    "The unapproved source operation leaked into reachable Git history");
  assert.equal(await remoteContainsString(fixture.remote, "Haru MCP Proposed"), false,
    "The unapproved direct source mutation proposal leaked into reachable Git history");

  const batchId = `mcp-acceptance-${randomUUID().replaceAll("-", "")}`;
  const publication = await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/publish`, {
    method: "POST", body: { batchId },
  });
  assert.equal(publication.state, "confirmed", "Owner publish did not confirm the selected checkpoint");
  assert.ok(publication.acknowledged.some((item) => item.operationId === selectedCoreOperationId),
    "Published Core receipt did not acknowledge the selected operation");
  const publishedUma = await readRemoteFile(fixture.remote, "bible/characters/char-uma/profile.yaml");
  const publishedHaru = await readRemoteFile(fixture.remote, "bible/characters/char-haru/profile.yaml");
  assert.match(publishedUma, /name: Uma Reviewed/u);
  assert.equal(publishedHaru, beforeHaru, "An unapproved source operation was included in publication");
  assert.equal(await remoteContainsString(fixture.remote, "Haru Unapproved"), false,
    "The unapproved source operation leaked into published Git history");
  assert.equal(await remoteContainsString(fixture.remote, "Haru MCP Proposed"), false,
    "The unapproved direct source mutation proposal leaked into published Git history");

  await closeMcpClient(http, true);
  http = undefined;
  await closeMcpClient(stdio);
  stdio = undefined;
  await host.close();

  // Reconstruct the same Core project identity from the published remote, without its private proposal journal.
  const recreatedDataDirectory = resolve(rootDir, "core-data-recreated");
  await mkdir(recreatedDataDirectory, { recursive: true });
  await writeFile(
    resolve(recreatedDataDirectory, "projects.json"),
    await readFile(resolve(dataDirectory, "projects.json"), "utf8"),
    "utf8",
  );
  const recreatedStore = new CoreStore({ dataDir: recreatedDataDirectory, allowLocalRemotes: true });
  await recreatedStore.reconstructProject(projectId);
  host = await startHost({
    dataDirectory: recreatedDataDirectory,
    cacheDirectory: resolve(rootDir, "module-cache-recreated"),
    store: recreatedStore,
  });
  cookie = await login(host);
  stdio = await startStdioClient(host, projectId);
  http = await startHttpClient(host, projectId);
  const recoveredEnvelope = await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/proposals`);
  const safePartialStatus = recoveredEnvelope.proposals.find((item) => item.proposal?.id === changeSetId);
  assert.ok(safePartialStatus, "Core did not reconstruct the immutable partial proposal status");
  assert.equal(safePartialStatus.payloadComplete, false);
  assert.equal(typeof safePartialStatus.originalDigest, "string");
  assert.deepEqual(safePartialStatus.operationIds, [selectedCoreOperationId, unselectedCoreOperationId]);
  assert.deepEqual(safePartialStatus.proposal.operations.map((operation) => operation.id), [selectedCoreOperationId]);
  assert.equal(JSON.stringify(safePartialStatus).includes("Haru Unapproved"), false,
    "The recovered remote status contains an unapproved operation payload");
  const listedIncomplete = success(await stdio.client.callTool({
    name: "list_change_sets", arguments: { project_id: projectId },
  }), "reconstructed list_change_sets").incomplete_payloads?.find((item) => item.sourceChangeSetId === changeSetId);
  assert.ok(listedIncomplete, "Source list_change_sets must report incomplete Core recovery metadata");
  assert.equal(listedIncomplete.payloadComplete, false);
  assert.deepEqual(listedIncomplete.operationIds, [selectedCoreOperationId, unselectedCoreOperationId]);
  assert.equal(JSON.stringify(listedIncomplete).includes("Haru Unapproved"), false);
  for (const [name, connection] of [["recreated stdio", stdio], ["recreated HTTP", http]]) {
    const unavailable = await connection.client.callTool({
      name: "get_change_set", arguments: { project_id: projectId, change_set_id: changeSetId },
    });
    assert.equal(errorCode(unavailable, `${name} incomplete proposal recovery`), "PROPOSAL_PAYLOAD_UNAVAILABLE");
    const details = unavailable.structuredContent.error.details;
    assert.equal(details.payloadComplete, false);
    assert.equal(details.sourceChangeSetId, changeSetId);
    assert.deepEqual(details.operationIds, [selectedCoreOperationId, unselectedCoreOperationId]);
    assert.deepEqual(details.approvedOperationIds, [selectedCoreOperationId]);
    assert.deepEqual(details.checkpointedOperationIds, [selectedCoreOperationId]);
    assert.deepEqual(details.publishedOperationIds, [selectedCoreOperationId]);
    assert.match(details.recovery, /browser\/private proposal/u);
    assert.equal(JSON.stringify(unavailable.structuredContent).includes("Haru Unapproved"), false);
  }

  // The browser-private proposal record is the original full Core proposal, not a regenerated Story payload.
  const restore = await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/proposals`, {
    method: "POST", status: 201, body: originalCoreProposal,
  });
  assert.equal(restore.id, changeSetId, "Owner recovery did not restore the original Core proposal identity");
  assert.equal(restore.source, "mcp", "Owner recovery must preserve the original proposal source binding");
  const restored = success(await stdio.client.callTool({
    name: "get_change_set", arguments: { project_id: projectId, change_set_id: changeSetId },
  }), "restored source ChangeSet status");
  assert.equal(restored.status, "partially-applied");
  assert.deepEqual(restored.approvedOperationIds, ["update-uma"]);
  assert.equal(restored.result.operations.length, 1);
  assert.equal(restored.result.operations[0].resultId, "char-uma");

  const restoredProposal = (await ownerJson(host, cookie, `/api/projects/${encodeURIComponent(projectId)}/proposals`))
    .proposals.find((item) => item.proposal?.id === changeSetId);
  assert.ok(restoredProposal);
  assert.equal(restoredProposal.payloadComplete, true, "Exact owner restoration did not recover the full private proposal");
  assert.equal(restoredProposal.proposal.operations.filter((operation) => operation.id === selectedCoreOperationId).length, 1,
    "Restoration duplicated an accepted Core operation");
  assert.equal(restoredProposal.checkpoints.filter((receipt) => receipt.operationId === selectedCoreOperationId).length, 1,
    "Restoration duplicated the accepted checkpoint receipt");

  const finalRecord = success(await stdio.client.callTool({
    name: "get_change_set", arguments: { project_id: projectId, change_set_id: changeSetId },
  }), "final source ChangeSet status");
  assert.equal(finalRecord.status, "partially-applied");
});
