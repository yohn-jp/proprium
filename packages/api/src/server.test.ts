import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { MODEL_USAGE_CAPABILITY, type ActionResult, type ChangeOperation, type ChangeProposal, type ModelUsageEvent, type ModelUsageStore, type ModuleAction, type ModuleContext, type ModuleDefinition, type ModuleManifest, type ProposalStatus, type RepositoryIdentity, type SnapshotId, type ValueSchema } from "@scriptorium/contracts";
import { CoreStore, type CoreStore as CoreStoreShape } from "@scriptorium/core";
import { ModuleRuntime, type ModuleLoader, type ModuleRuntimeOptions } from "@scriptorium/module-runtime";
import { HistoricalModelUsageError, HistoricalModelUsageStore } from "./historical-store.js";
import { createServer, type ApiServerOptions } from "./server.js";

const ACCESS_TOKEN = "test-access-token-which-is-longer-than-32-characters";
const execFile = promisify(execFileCallback);
const SNAPSHOT: SnapshotId = {
  repository: { provider: "github", repositoryId: "123", defaultBranch: "main", ownerScope: "owner-1", url: "https://github.com/owner/work.git" },
  remoteCommit: "a".repeat(40),
};

function makeStore(onSaveScene: () => void = () => undefined): CoreStoreShape {
  const project = { id: "project-1", url: "https://github.com/owner/work.git", branch: "main" };
  const scene = { id: "scene-1", title: "Opening", text: "canonical draft", revision: "revision-1" };
  return {
    listProjects: async () => [project],
    registerProject: async ({ url, branch }: { url: string; branch?: string }) => ({
      id: "project-2",
      url,
      branch: branch ?? "main",
    }),
    tree: async () => ({
      title: "A Work",
      volumes: [{ id: "vol-1", title: "Volume 1", chapters: [{ id: "ch-1", title: "Chapter 1", scenes: [{ id: scene.id, title: scene.title }] }] }],
    }),
    readScene: async () => scene,
    saveScene: async (_projectId: string, _sceneId: string, input: { text: string; revision: string }) => {
      onSaveScene();
      if (input.revision !== scene.revision) {
        throw { status: 412, code: "STALE_REVISION", message: "Scene changed since it was read" };
      }
      return { ...scene, text: input.text, revision: "revision-2" };
    },
    history: async () => [{ hash: "abc12345", date: "2026-10-16T00:00:00.000Z", message: "write opening" }],
    sync: async () => ({ branch: "main", head: "abc12345", ahead: 0, behind: 0, dirty: false }),
    status: async () => ({ branch: "main", head: "abc12345", ahead: 1, behind: 0, dirty: true }),
  } as unknown as CoreStore;
}

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function makeBareRemote(): Promise<{ root: string; remote: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "scriptorium-api-project-remote-"));
  const remote = resolve(root, "remote.git");
  const seed = resolve(root, "seed");
  await mkdir(seed);
  await runGit(root, "init", "--bare", "--initial-branch=main", remote);
  await runGit(seed, "init", "--initial-branch=main");
  await runGit(seed, "config", "user.name", "Scriptorium API Test");
  await runGit(seed, "config", "user.email", "api-test@example.invalid");
  await writeFile(resolve(seed, "README.md"), "Project workspace remains intact.\n", "utf8");
  await runGit(seed, "add", ".");
  await runGit(seed, "commit", "-m", "Initial project");
  await runGit(seed, "remote", "add", "origin", remote);
  await runGit(seed, "push", "-u", "origin", "main");
  await runGit(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  return { root, remote };
}

function makeSnapshotStore() {
  const proposed: ChangeProposal[] = [];
  const approvals: Array<{ proposalId: string; operationIds: string[]; authorScope: string }> = [];
  const pinnedReads: Array<string | undefined> = [];
  const snapshotReads: Array<{ kind: "tree" | "scene"; view?: string; pinned?: string }> = [];
  const document = { path: "manuscript/ms-one/scene-one.md", content: "---\nid: scene-one\n---\n\nA harbor at night.\n", revision: "body-revision" };
  const store = Object.assign(makeStore(), {
    async reader(_projectId: string, _view = "remote", pinned?: string) {
      pinnedReads.push(pinned);
      const snapshot = { ...SNAPSHOT, ...(pinned ? { remoteCommit: pinned } : {}) };
      return {
        snapshot,
        async read(path: string, encoding: "utf8" | "base64" = "utf8") {
          if (path !== document.path) return null;
          return { content: encoding === "base64" ? Buffer.from(document.content).toString("base64") : document.content, revision: document.revision };
        },
        async list(prefix: string) { return prefix === "manuscript/" ? [document.path] : []; },
      };
    },
    async observe() { return { snapshot: SNAPSHOT, checkpointHead: SNAPSHOT.remoteCommit, observedAt: "2026-10-17T00:00:00.000Z", state: "fresh" as const, pending: [] }; },
    async readTreeSnapshot(_projectId: string, view?: "remote" | "checkpoint", pinned?: string) {
      snapshotReads.push({ kind: "tree", view, pinned });
      const snapshot = { ...SNAPSHOT, ...(pinned ? { remoteCommit: pinned } : {}) };
      return { snapshot, tree: { title: "A Work", volumes: [] } };
    },
    async readSceneSnapshot(_projectId: string, sceneId: string, view?: "remote" | "checkpoint", pinned?: string) {
      snapshotReads.push({ kind: "scene", view, pinned });
      return {
        snapshot: { ...SNAPSHOT, ...(pinned ? { remoteCommit: pinned } : {}) },
        scene: { id: sceneId, title: "Opening", text: "A harbor at night.", revision: "scene-revision" },
        document,
        metadata: { path: "plot/volumes/v1/chapters/c1/scenes/scene-one.yaml", content: "id: scene-one\n", revision: "metadata-revision" },
      };
    },
    async listManuscriptSnapshots(_projectId: string, manuscriptId: string, sceneId?: string, _view?: "remote" | "checkpoint", pinned?: string) {
      return { snapshot: { ...SNAPSHOT, ...(pinned ? { remoteCommit: pinned } : {}) }, snapshots: [{ id: "b".repeat(40), manuscriptId, sceneId, message: "loom(scene): update", date: "2026-10-16T00:00:00.000Z" }] };
    },
    async readManuscriptSnapshot(_projectId: string, manuscriptId: string, snapshotId: string, _view?: "remote" | "checkpoint", pinned?: string) {
      return { snapshot: { ...SNAPSHOT, ...(pinned ? { remoteCommit: pinned } : {}) }, manuscript: { id: manuscriptId, snapshotId, body: "A harbor at night.", document } };
    },
    async searchSnapshot(_projectId: string, query: string, limit = 20, _view?: "remote" | "checkpoint", pinned?: string) {
      pinnedReads.push(pinned);
      return { snapshot: { ...SNAPSHOT, ...(pinned ? { remoteCommit: pinned } : {}) }, results: [{ id: "scene-one", type: "scene", name: "Opening", snippet: "A harbor at night.", filePath: document.path, score: 1, field: "body", offset: 2, length: query.length }].slice(0, limit) };
    },
    async writingStatsSnapshot(_projectId: string, _view?: "remote" | "checkpoint", pinned?: string) {
      pinnedReads.push(pinned);
      return { snapshot: { ...SNAPSHOT, ...(pinned ? { remoteCommit: pinned } : {}) }, stats: { totalCharCount: 20, totalPages400: 1, volumes: [], sceneById: {} } };
    },
    async listProposals() { return []; },
    async getProposal() { return null; },
    async propose(_projectId: string, proposal: ChangeProposal) { proposed.push(proposal); return proposal; },
    async approve(_projectId: string, approval: { proposalId: string; operationIds: string[]; authorScope: string }) { approvals.push(approval); },
    async checkpoint(_projectId: string, operation: ChangeOperation) { return { operationId: operation.id, generation: operation.generation, localCommit: "c".repeat(40), remoteBase: SNAPSHOT.remoteCommit, revisions: operation.writes.map(({ path, revision }) => ({ path, revision })) }; },
  }) as unknown as CoreStore;
  return { store, proposed, approvals, pinnedReads, snapshotReads };
}

interface PublishingObservations {
  paths: string[];
  forwardedHeaders?: { authorization: string | null; cookie: string | null; proxyAuthorization: string | null; mcpSessionId: string | null };
  publicCoreActions?: ActionResult;
  publicActionIds?: string[];
  linkedReaderError?: string;
}

function publishingRuntime(cacheDirectory: string, observed: PublishingObservations): ModuleRuntime {
  const manifest: ModuleManifest = {
    id: "publishing", version: "0.1.0", contractVersion: 1,
    dependencies: [], provides: [], requires: [], statePaths: [], locality: "local",
  };
  const schema: ValueSchema = { parse(value) { return value; } };
  const readCore: ModuleAction = {
    id: "read-core", effect: "read", inputSchema: schema, outputSchema: schema,
    async invoke(_input, context): Promise<ActionResult> { return context.invoke("core.status", {}); },
  };
  const definition: ModuleDefinition = {
    manifest,
    actions: [readCore],
    ui: [],
    http: [{
      id: "share", path: "share/:token", methods: ["GET"], access: "public", effect: "read",
      async handle(request, context) {
        observed.paths.push(new URL(request.url).pathname);
        observed.forwardedHeaders = {
          authorization: request.headers.get("authorization"),
          cookie: request.headers.get("cookie"),
          proxyAuthorization: request.headers.get("proxy-authorization"),
          mcpSessionId: request.headers.get("mcp-session-id"),
        };
        observed.publicCoreActions = await context.invoke("core.proposals.list", {});
        observed.publicActionIds = (await context.listActions()).map(({ id }) => id);
        try { await context.linkedReader("123"); }
        catch (error) { observed.linkedReaderError = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unavailable"; }
        return Response.json({ path: new URL(request.url).pathname, access: context.projectId, snapshot: context.reader.snapshot.remoteCommit }, {
          headers: {
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Robots-Tag": "noindex, nofollow",
          },
        });
      },
    }],
    async dispose() {},
  };
  return new ModuleRuntime({ manifests: [manifest], enabled: ["publishing"], loaders: { publishing: async () => definition }, cacheDirectory });
}

function actionBoundaryRuntime(cacheDirectory: string): ModuleRuntime {
  const schema: ValueSchema = { parse(value) { return value; } };
  const mcpManifest: ModuleManifest = {
    id: "mcp", version: "0.1.0", contractVersion: 1,
    dependencies: [], provides: [], requires: [], statePaths: [], locality: "local",
  };
  const nlpManifest: ModuleManifest = {
    id: "nlp", version: "0.1.0", contractVersion: 1,
    dependencies: [], provides: [], requires: [], statePaths: [], locality: "local",
  };
  const mcpDefinition: ModuleDefinition = {
    manifest: mcpManifest,
    actions: [{
      id: "propose", effect: "propose", inputSchema: schema, outputSchema: schema,
      async invoke(input, context): Promise<ActionResult> {
        const proposal = await context.propose([input as ChangeOperation]);
        return { ok: true, snapshot: context.reader.snapshot, data: { proposal } };
      },
    }],
    ui: [],
    http: [{
      id: "propose", path: "propose", methods: ["POST"], access: "owner", effect: "propose",
      async handle(request, context) {
        const proposal = await context.propose([await request.json() as ChangeOperation]);
        return Response.json({ source: proposal.source });
      },
    }],
    async dispose() {},
  };
  const nlpDefinition: ModuleDefinition = {
    manifest: nlpManifest,
    actions: [{
      id: "analyze", effect: "compute", inputSchema: schema, outputSchema: schema,
      async invoke(_input, context): Promise<ActionResult> {
        const nested = await context.invoke("core.hierarchy.create", { kind: "volume", id: "blocked", title: "Blocked" });
        return { ok: true, snapshot: context.reader.snapshot, data: { nested } };
      },
    }],
    ui: [],
    async dispose() {},
  };
  return new ModuleRuntime({
    manifests: [mcpManifest, nlpManifest], enabled: ["mcp", "nlp"], cacheDirectory,
    loaders: { mcp: async () => mcpDefinition, nlp: async () => nlpDefinition },
  });
}

async function startCustomApi(
  store: CoreStore,
  staticDir: string,
  options: Pick<ApiServerOptions, "trustProxy" | "runtime" | "runtimeOptions" | "usageDirectory"> = {},
) {
  const server = createServer({ store, authToken: ACCESS_TOKEN, staticDir, ...options });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const close = () => new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return { server, base, close };
}

async function startApi(staticDir: string, trustProxy = false) {
  return startCustomApi(makeStore(), staticDir, { trustProxy });
}

function usageEvent(repository: RepositoryIdentity, id: string, startedAt: string, options: Partial<ModelUsageEvent> = {}): ModelUsageEvent {
  return {
    id, repository, feature: "assistant.story-draft", provider: "openai", model: "gpt-4o-mini",
    startedAt, completedAt: new Date(Date.parse(startedAt) + 1_000).toISOString(), state: "completed",
    inputTokens: 12, outputTokens: 8, cost: 0.00002, ...options,
  };
}

function modelUsageRuntimeOptions(cacheDirectory: string): Omit<ModuleRuntimeOptions, "cacheDirectory"> & { cacheDirectory: string } {
  const manifest: ModuleManifest = {
    id: "assistant", version: "0.1.0", contractVersion: 1,
    dependencies: [], provides: [], requires: [], optionalRequires: [MODEL_USAGE_CAPABILITY], statePaths: [], locality: "optional-external",
  };
  const schema: ValueSchema = { parse(value) { return value; } };
  const loader: ModuleLoader = async (moduleContext: ModuleContext) => ({
    manifest,
    actions: [{
      id: "assistant.model-usage-history", effect: "compute", inputSchema: schema, outputSchema: schema,
      async invoke(rawInput, context): Promise<ActionResult> {
        const input = rawInput as { event?: ModelUsageEvent; query?: { from?: string; to?: string; limit?: number; cursor?: string } };
        const lease = await moduleContext.acquireCapability<ModelUsageStore>(MODEL_USAGE_CAPABILITY);
        try {
          if (input.event) await lease.value.append(input.event);
          const history = await lease.value.list(context.reader.snapshot.repository, input.query);
          return { ok: true, snapshot: context.reader.snapshot, data: history };
        } catch (error) {
          const candidate = error as { code?: unknown; message?: unknown };
          return { ok: false, snapshot: context.reader.snapshot, error: {
            code: typeof candidate?.code === "string" ? candidate.code : "model_usage_test_failed",
            message: typeof candidate?.message === "string" ? candidate.message : "Model usage test action failed",
            retryable: false,
          } };
        } finally {
          await lease.release();
        }
      },
    }],
    ui: [],
    async dispose() {},
  });
  return {
    manifests: [manifest], enabled: ["assistant"], loaders: { assistant: loader }, cacheDirectory,
  };
}

async function login(base: string): Promise<{ cookie: string; setCookie: string; body: unknown }> {
  const response = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ token: ACCESS_TOKEN }),
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return { cookie: setCookie.split(";", 1)[0]!, setCookie, body: await response.json() };
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Scriptorium HTTP boundary", () => {
  it("keeps health public, protects project data, and serves the app shell", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-"));
    tempDirs.push(staticDir);
    await writeFile(resolve(staticDir, "index.html"), '<meta name="scriptorium-style-nonce" content="__SCRIPTORIUM_STYLE_NONCE__"><h1>Scriptorium</h1>');
    await Promise.all(["main.js", "api.js", "drafts.js", "styles.css"].map((name) => writeFile(resolve(staticDir, name), name)));
    await writeFile(resolve(staticDir, "server.test.js"), "private test file");
    await mkdir(resolve(staticDir, "assets"));
    await writeFile(resolve(staticDir, "assets", "main-a1b2.js"), "compiled lazy chunk");
    await symlink(resolve(staticDir, "server.test.js"), resolve(staticDir, "assets", "leak-a1b2.js"));
    const apiServer = await startApi(staticDir);
    t.after(apiServer.close);

    const health = await fetch(`${apiServer.base}/api/health`);
    assert.equal(health.status, 200);
    const healthBody: unknown = await health.json();
    assert.deepEqual(healthBody, { status: "ok" });
    assert.equal(JSON.stringify(healthBody).includes(ACCESS_TOKEN), false);

    const projects = await fetch(`${apiServer.base}/api/projects`);
    assert.equal(projects.status, 401);
    assert.equal((await projects.json() as { code: string }).code, "UNAUTHORIZED");

    const shell = await fetch(`${apiServer.base}/`);
    assert.equal(shell.status, 200);
    const html = await shell.text();
    assert.match(html, /Scriptorium/u);
    const nonce = /name="scriptorium-style-nonce" content="([^"]+)"/u.exec(html)?.[1];
    assert.ok(nonce && nonce !== "__SCRIPTORIUM_STYLE_NONCE__");
    assert.ok(shell.headers.get("content-security-policy")?.includes(`style-src 'self' 'nonce-${nonce}'`));
    assert.ok(!shell.headers.get("content-security-policy")?.includes("unsafe-inline"));
    const nextShell = await fetch(`${apiServer.base}/`);
    assert.notEqual(nextShell.headers.get("content-security-policy"), shell.headers.get("content-security-policy"));
    for (const name of ["main.js", "api.js", "drafts.js", "styles.css"]) {
      assert.equal((await fetch(`${apiServer.base}/${name}`)).status, 200);
    }
    const chunk = await fetch(`${apiServer.base}/assets/main-a1b2.js`);
    assert.equal(chunk.status, 200);
    assert.match(chunk.headers.get("content-type") ?? "", /javascript/u);
    assert.equal(await (await fetch(`${apiServer.base}/assets/leak-a1b2.js`)).json().then((body: unknown) => (body as { code: string }).code), "NOT_FOUND");
    assert.equal((await fetch(`${apiServer.base}/server.test.js`)).status, 404);
  });

  it("stores bounded immutable model usage with complete paginated history and no symlink traversal", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "scriptorium-api-model-history-"));
    tempDirs.push(root);
    const usageDirectory = resolve(root, "host-history");
    const coreDataDirectory = resolve(root, "core-data");
    await mkdir(coreDataDirectory);
    await writeFile(resolve(coreDataDirectory, "disposable-cache.json"), "temporary Core cache");
    const unusedDirectory = resolve(root, "unused-history");
    assert.deepEqual(await new HistoricalModelUsageStore(unusedDirectory).list(SNAPSHOT.repository), { events: [] });
    await assert.rejects(lstat(unusedDirectory), (error: NodeJS.ErrnoException) => error.code === "ENOENT", "an empty history read must not create host storage");
    const store = new HistoricalModelUsageStore(usageDirectory);
    const first = usageEvent(SNAPSHOT.repository, "usage-1", "2026-10-17T00:00:00.000Z");
    const second = usageEvent(SNAPSHOT.repository, "usage-2", "2026-10-17T00:00:02.000Z", { state: "aborted", errorCode: "request_cancelled" });
    const third = usageEvent(SNAPSHOT.repository, "usage-3", "2026-10-17T00:00:04.000Z");
    await Promise.all([store.append(first), store.append(first), store.append(second), store.append(third)]);

    const pageOne = await store.list(SNAPSHOT.repository, { limit: 2 });
    assert.deepEqual(pageOne.events.map(({ id }) => id), [first.id, second.id]);
    assert.ok(pageOne.nextCursor);
    const pageTwo = await store.list(SNAPSHOT.repository, { limit: 2, cursor: pageOne.nextCursor });
    assert.deepEqual(pageTwo.events.map(({ id }) => id), [third.id]);
    assert.equal(pageTwo.nextCursor, undefined);
    const ranged = await store.list(SNAPSHOT.repository, { from: second.startedAt, to: third.startedAt, limit: 10 });
    assert.deepEqual(ranged.events.map(({ id }) => id), [second.id, third.id]);
    await assert.rejects(store.list(SNAPSHOT.repository, { limit: 1_001 }), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_query_invalid");
    await assert.rejects(store.append({ ...first, outputTokens: 9 }), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_event_id_conflict");
    await assert.rejects(store.append({
      ...first, prompt: "private prompt", headers: { Authorization: "secret" }, key: "private key", body: "private body",
    } as ModelUsageEvent), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_event_invalid");

    await rm(coreDataDirectory, { recursive: true, force: true });
    await mkdir(coreDataDirectory);
    const reopened = new HistoricalModelUsageStore(usageDirectory);
    assert.deepEqual((await reopened.list(SNAPSHOT.repository, { limit: 10 })).events.map(({ id }) => id), [first.id, second.id, third.id]);

    const alias = resolve(root, "history-alias");
    await symlink(usageDirectory, alias, "dir");
    await assert.rejects(new HistoricalModelUsageStore(alias).list(SNAPSHOT.repository), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_path_invalid");
  });

  it("wires model usage lazily into the host and retains it after Core data-root deletion and reconstruction", async (t) => {
    const { root, remote } = await makeBareRemote();
    tempDirs.push(root);
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-model-history-app-"));
    tempDirs.push(staticDir);
    const coreDataDirectory = resolve(root, "core-data");
    const usageDirectory = resolve(root, "history");
    const cacheDirectory = resolve(root, "module-cache");
    let coreStore = new CoreStore({ dataDir: coreDataDirectory, allowLocalRemotes: true });
    let apiServer: Awaited<ReturnType<typeof startCustomApi>> | undefined;
    t.after(async () => { if (apiServer) await apiServer.close(); });
    const openApi = (store: CoreStore) => startCustomApi(store, staticDir, {
      usageDirectory,
      runtimeOptions: modelUsageRuntimeOptions(cacheDirectory),
    });
    apiServer = await openApi(coreStore);
    let owner = await login(apiServer.base);
    const ownerHeaders = () => ({ Cookie: owner.cookie, Origin: apiServer!.base, "Content-Type": "application/json" });
    const register = async () => {
      const response = await fetch(`${apiServer!.base}/api/projects`, { method: "POST", headers: ownerHeaders(), body: JSON.stringify({ url: remote }) });
      assert.equal(response.status, 201);
      return response.json() as Promise<{ id: string }>;
    };
    const invokeHistory = async (projectId: string, input: unknown) => fetch(
      `${apiServer!.base}/api/projects/${projectId}/actions/assistant.model-usage-history`,
      { method: "POST", headers: ownerHeaders(), body: JSON.stringify({ input }) },
    );

    assert.equal((await fetch(`${apiServer.base}/api/health`)).status, 200);
    await assert.rejects(lstat(usageDirectory), (error: NodeJS.ErrnoException) => error.code === "ENOENT", "server startup must not touch unused usage history");
    const project = await register();
    const identity = (await coreStore.observe(project.id)).snapshot.repository;
    const event = usageEvent(identity, "host-usage-1", "2026-10-17T01:00:00.000Z");
    const descriptors = await fetch(`${apiServer.base}/api/projects/${project.id}/actions`, { headers: { Cookie: owner.cookie } });
    assert.equal(descriptors.status, 200);
    assert.ok((await descriptors.json() as { actions: Array<{ id: string }> }).actions.some(({ id }) => id === "assistant.model-usage-history"));
    await assert.rejects(lstat(usageDirectory), (error: NodeJS.ErrnoException) => error.code === "ENOENT", "module activation alone must not create the history directory");
    const saved = await invokeHistory(project.id, { event });
    assert.equal(saved.status, 200);
    const savedResult = await saved.json() as ActionResult<{ events: ModelUsageEvent[] }>;
    assert.equal(savedResult.ok, true, JSON.stringify(savedResult));
    if (!savedResult.ok) return;
    assert.deepEqual(savedResult.data.events, [event]);
    assert.ok((await lstat(usageDirectory)).isDirectory());

    await apiServer.close();
    apiServer = undefined;
    await rm(coreDataDirectory, { recursive: true, force: true });
    await assert.rejects(lstat(coreDataDirectory), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    coreStore = new CoreStore({ dataDir: coreDataDirectory, allowLocalRemotes: true });
    apiServer = await openApi(coreStore);
    owner = await login(apiServer.base);
    const reconstructed = await register();
    const newIdentity = (await coreStore.observe(reconstructed.id)).snapshot.repository;
    assert.equal(newIdentity.repositoryId, identity.repositoryId, "Core reconstructs stable repository identity independently of its ephemeral project ID");
    assert.equal(newIdentity.ownerScope, identity.ownerScope);
    const restored = await invokeHistory(reconstructed.id, { query: { limit: 10 } });
    assert.equal(restored.status, 200);
    const restoredResult = await restored.json() as ActionResult<{ events: ModelUsageEvent[] }>;
    assert.equal(restoredResult.ok, true, JSON.stringify(restoredResult));
    if (!restoredResult.ok) return;
    assert.deepEqual(restoredResult.data.events, [event]);
    assert.ok((await lstat(coreDataDirectory)).isDirectory(), "project registration recreates the disposable Core data root");
    assert.ok((await lstat(usageDirectory)).isDirectory(), "host history remains available in its separately configured directory");
  });

  it("uses an HttpOnly same-site session and enforces same-origin writes", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-"));
    tempDirs.push(staticDir);
    let directSaveCalls = 0;
    const apiServer = await startCustomApi(makeStore(() => { directSaveCalls += 1; }), staticDir);
    t.after(apiServer.close);

    const crossOrigin = await fetch(`${apiServer.base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ token: ACCESS_TOKEN }),
    });
    assert.equal(crossOrigin.status, 403);

    const invalid = await fetch(`${apiServer.base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify({ token: "wrong" }),
    });
    assert.equal(invalid.status, 401);

    const session = await login(apiServer.base);
    assert.deepEqual(session.body, { authenticated: true });
    assert.match(session.setCookie, /HttpOnly/u);
    assert.match(session.setCookie, /SameSite=Strict/u);
    assert.doesNotMatch(session.setCookie, /Secure/u);
    const cookie = session.cookie;
    const loginResponse = await fetch(`${apiServer.base}/api/session`, { headers: { Cookie: cookie } });
    assert.equal(loginResponse.status, 200);
    const projects = await fetch(`${apiServer.base}/api/projects`, { headers: { Cookie: cookie } });
    assert.deepEqual(await projects.json(), [
      { id: "project-1", url: "https://github.com/owner/work.git", branch: "main" },
    ]);

    const mutation = await fetch(`${apiServer.base}/api/projects/project-1/scenes/scene-1`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify({ text: "new draft", revision: "revision-1" }),
    });
    assert.equal(mutation.status, 410);
    assert.equal((await mutation.json() as { code: string }).code, "SCENE_PROPOSAL_REQUIRED");
    assert.equal(directSaveCalls, 0);

    const stale = await fetch(`${apiServer.base}/api/projects/project-1/scenes/scene-1`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify({ text: "must not overwrite", revision: "revision-old" }),
    });
    assert.equal(stale.status, 410);
    assert.equal(directSaveCalls, 0);

    const logout = await fetch(`${apiServer.base}/api/logout`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", Origin: apiServer.base },
      body: "{}",
    });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(`${apiServer.base}/api/projects`, { headers: { Cookie: cookie } })).status, 401);
  });

  it("marks a session cookie Secure when HTTPS is asserted by a trusted proxy", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-"));
    tempDirs.push(staticDir);
    const apiServer = await startApi(staticDir, true);
    t.after(apiServer.close);
    const origin = apiServer.base.replace(/^http:/u, "https:");
    const response = await fetch(`${apiServer.base}/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ token: ACCESS_TOKEN }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie") ?? "", /; Secure(?:;|$)/u);
  });

  it("rejects short access tokens before opening a listener", () => {
    assert.throws(() => createServer({ store: makeStore(), authToken: "too-short" }), /at least 32/u);
  });

  it("exposes the source Core read surface through pinned routes and composed host actions", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-core-"));
    tempDirs.push(staticDir);
    const fixture = makeSnapshotStore();
    const apiServer = await startCustomApi(fixture.store, staticDir);
    t.after(apiServer.close);
    const auth = { Authorization: `Bearer ${ACCESS_TOKEN}` };

    const projects = await fetch(`${apiServer.base}/api/projects`, { headers: auth });
    assert.deepEqual(await projects.json(), [{ id: "project-1", url: "https://github.com/owner/work.git", branch: "main" }]);
    const detail = await fetch(`${apiServer.base}/api/projects/project-1`, { headers: auth });
    const detailBody = await detail.json() as { project: { id: string; url: string; branch: string }; observation: { snapshot: SnapshotId } };
    assert.equal(detail.status, 200);
    assert.deepEqual(detailBody.project, { id: "project-1", url: "https://github.com/owner/work.git", branch: "main" });
    assert.equal(detailBody.observation.snapshot.remoteCommit, SNAPSHOT.remoteCommit);
    const missingProject = await fetch(`${apiServer.base}/api/projects/missing`, { headers: auth });
    assert.equal(missingProject.status, 404);
    assert.equal((await missingProject.json() as { code: string }).code, "PROJECT_NOT_FOUND");
    assert.equal((await fetch(`${apiServer.base}/api/projects/project-1/manuscripts`, { headers: auth })).status, 404);
    const defaultTree = await fetch(`${apiServer.base}/api/projects/project-1/tree`, { headers: auth });
    assert.equal((await defaultTree.json() as { snapshot: SnapshotId }).snapshot.remoteCommit, SNAPSHOT.remoteCommit);
    assert.deepEqual(fixture.snapshotReads.at(-1), { kind: "tree", view: "remote", pinned: undefined });
    const defaultScene = await fetch(`${apiServer.base}/api/projects/project-1/scenes/scene-one`, { headers: auth });
    assert.equal((await defaultScene.json() as { snapshot: SnapshotId }).snapshot.remoteCommit, SNAPSHOT.remoteCommit);
    assert.deepEqual(fixture.snapshotReads.at(-1), { kind: "scene", view: "remote", pinned: undefined });
    const checkpointId = "c".repeat(40);
    const checkpointTree = await fetch(`${apiServer.base}/api/projects/project-1/tree?view=checkpoint&snapshot=${checkpointId}`, { headers: auth });
    assert.equal(checkpointTree.status, 200);
    assert.deepEqual(fixture.snapshotReads.at(-1), { kind: "tree", view: "checkpoint", pinned: checkpointId });
    assert.equal((await fetch(`${apiServer.base}/api/nlp/features`)).status, 401);
    const providerNone = await fetch(`${apiServer.base}/api/nlp/features`, { headers: auth });
    assert.equal((await providerNone.json() as { providerKind: string }).providerKind, "none");
    const modules = await fetch(`${apiServer.base}/api/projects/project-1/modules`, { headers: auth });
    assert.equal(modules.status, 200);
    assert.ok((await modules.json() as Array<{ id: string; availability: string }>).some(({ id, availability }) => id === "mcp" && availability === "not-included"));
    const contributions = await fetch(`${apiServer.base}/api/projects/project-1/contributions`, { headers: auth });
    assert.deepEqual(await contributions.json(), []);

    const descriptorsResponse = await fetch(`${apiServer.base}/api/projects/project-1/actions`, { headers: auth });
    const descriptors = await descriptorsResponse.json() as Array<{ id: string; module: string; effect: string }> | { actions: Array<{ id: string; module: string; effect: string }> };
    const actions = Array.isArray(descriptors) ? descriptors : descriptors.actions;
    assert.ok(actions.some((action) => action.id === "core.status" && action.module === "core" && action.effect === "read"));
    assert.ok(actions.some((action) => action.id === "core.search"));
    assert.ok(actions.some((action) => action.id === "core.writing-stats"));
    assert.ok(actions.some((action) => action.id === "core.manuscript-snapshots"));
    assert.equal(actions.some((action) => action.module === "mcp"), false);

    const actionResponse = await fetch(`${apiServer.base}/api/projects/project-1/actions/core.search`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { query: "harbor", limit: 5 } }),
    });
    assert.deepEqual(await actionResponse.json(), {
      ok: true, snapshot: SNAPSHOT,
      data: { query: "harbor", results: [{ id: "scene-one", type: "scene", name: "Opening", snippet: "A harbor at night.", filePath: "manuscript/ms-one/scene-one.md", score: 1, field: "body", offset: 2, length: 6 }] },
    });
    assert.ok(fixture.pinnedReads.includes(SNAPSHOT.remoteCommit));
    const invalidAction = await fetch(`${apiServer.base}/api/projects/project-1/actions/core.search`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { query: "" } }),
    });
    assert.equal((await invalidAction.json() as { error: { code: string } }).error.code, "invalid_action_input");

    const pinned = "b".repeat(40);
    const snapshots = await fetch(`${apiServer.base}/api/projects/project-1/manuscripts/ms-one/snapshots?sceneId=scene-one&snapshot=${pinned}`, { headers: auth });
    const listed = await snapshots.json() as { snapshot: SnapshotId; snapshots: Array<{ id: string }> };
    assert.equal(listed.snapshot.remoteCommit, pinned);
    assert.equal(listed.snapshots[0]?.id, "b".repeat(40));
    const historical = await fetch(`${apiServer.base}/api/projects/project-1/manuscripts/ms-one/snapshots/${"b".repeat(40)}?snapshot=${pinned}`, { headers: auth });
    assert.equal((await historical.json() as { manuscript: { document: { path: string } } }).manuscript.document.path, "manuscript/ms-one/scene-one.md");

    const stats = await fetch(`${apiServer.base}/api/projects/project-1/writing-stats?snapshot=${pinned}`, { headers: auth });
    const statsBody = await stats.json() as { snapshot: SnapshotId; stats: { totalPages400: number } };
    assert.equal(statsBody.snapshot.remoteCommit, pinned);
    assert.equal(statsBody.stats.totalPages400, 1);
  });

  it("assigns proposal source at the host and keeps approval exclusive to same-origin owner sessions", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-proposals-"));
    tempDirs.push(staticDir);
    const fixture = makeSnapshotStore();
    const apiServer = await startCustomApi(fixture.store, staticDir);
    t.after(apiServer.close);
    const operation: ChangeOperation = {
      id: "operation-1", generation: 0, repository: SNAPSHOT.repository, baseRemoteCommit: SNAPSHOT.remoteCommit,
      effect: "metadata", reads: [], writes: [], message: "propose a bounded metadata update",
    };
    const proposal = await fetch(`${apiServer.base}/api/projects/project-1/proposals`, {
      method: "POST", headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "mcp-batch-1", source: "author", snapshot: SNAPSHOT, operations: [operation] }),
    });
    assert.equal(proposal.status, 201);
    assert.equal((await proposal.json() as ChangeProposal).source, "mcp");
    assert.equal(fixture.proposed[0]?.id, "mcp-batch-1");
    assert.equal(fixture.proposed[0]?.source, "mcp");

    const mcpApproval = await fetch(`${apiServer.base}/api/projects/project-1/approvals`, {
      method: "POST", headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId: "mcp-batch-1", operationIds: [operation.id], authorScope: "forged" }),
    });
    assert.equal(mcpApproval.status, 403);
    assert.deepEqual(fixture.approvals, []);

    const owner = await login(apiServer.base);
    const authorApproval = await fetch(`${apiServer.base}/api/projects/project-1/approvals`, {
      method: "POST", headers: { Cookie: owner.cookie, "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify({ proposalId: "mcp-batch-1", operationIds: [operation.id], authorScope: "forged" }),
    });
    assert.equal(authorApproval.status, 204);
    assert.deepEqual(fixture.approvals, [{ proposalId: "mcp-batch-1", operationIds: [operation.id], authorScope: "owner" }]);
  });

  it("restores a partial MCP proposal through an exact owner retry after Core data loss", async (t) => {
    const { root, remote } = await makeBareRemote();
    tempDirs.push(root);
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-proposal-recovery-"));
    tempDirs.push(staticDir);
    const dataDir = resolve(root, "state");
    let store = new CoreStore({ dataDir, allowLocalRemotes: true });
    let apiServer: Awaited<ReturnType<typeof startCustomApi>> | undefined;
    t.after(async () => { if (apiServer) await apiServer.close(); });

    apiServer = await startCustomApi(store, staticDir);
    let owner = await login(apiServer.base);
    const ownerHeaders = () => ({ Cookie: owner.cookie, Origin: apiServer!.base, "Content-Type": "application/json" });
    const registration = await fetch(`${apiServer.base}/api/projects`, {
      method: "POST", headers: ownerHeaders(), body: JSON.stringify({ url: remote }),
    });
    assert.equal(registration.status, 201);
    const project = await registration.json() as { id: string; url: string; branch: string };
    const snapshot = (await store.observe(project.id)).snapshot;
    const operation = (id: string, path: string, content: string): ChangeOperation => ({
      id, generation: 1, repository: snapshot.repository, baseRemoteCommit: snapshot.remoteCommit,
      effect: "manuscript", reads: [{ path, revision: null }], writes: [{ path, revision: null, content }],
      message: `Write ${path}`,
    });
    const selected = operation("recovery_selected_op", "manuscript/recovery-selected.md", "Selected and published.\n");
    const unselected = operation("recovery_unselected_op", "manuscript/recovery-unselected.md", "Still pending after recovery.\n");
    const proposal: ChangeProposal = {
      id: "recovery_mcp_batch",
      snapshot,
      operations: [selected, unselected],
      source: "mcp",
      evidence: [{
        id: "recovery_mcp_evidence", snapshot, module: "mcp", kind: "source_change_set_mapping", paths: [],
        details: { sourceChangeSetId: "source-change-set-recovery" },
      }],
    };

    const initial = await fetch(`${apiServer.base}/api/projects/${project.id}/proposals`, {
      method: "POST", headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...proposal, source: "author" }),
    });
    assert.equal(initial.status, 201);
    assert.deepEqual(await initial.json(), proposal, "new bearer submissions are attributed to MCP regardless of request source");

    const cookieOperation = operation("cookie_author_source_op", "manuscript/cookie-author.md", "Created by the owner session.\n");
    const cookieCreated = await fetch(`${apiServer.base}/api/projects/${project.id}/proposals`, {
      method: "POST", headers: ownerHeaders(),
      body: JSON.stringify({ id: "cookie_author_source", snapshot, operations: [cookieOperation], source: "mcp" }),
    });
    assert.equal(cookieCreated.status, 201);
    assert.equal((await cookieCreated.json() as ChangeProposal).source, "author", "new cookie submissions cannot claim MCP provenance");

    const approval = await fetch(`${apiServer.base}/api/projects/${project.id}/approvals`, {
      method: "POST", headers: ownerHeaders(),
      body: JSON.stringify({ proposalId: proposal.id, operationIds: [selected.id] }),
    });
    assert.equal(approval.status, 204);
    const checkpoint = await fetch(`${apiServer.base}/api/projects/${project.id}/checkpoints`, {
      method: "POST", headers: ownerHeaders(), body: JSON.stringify(selected),
    });
    assert.equal(checkpoint.status, 201);
    const publication = await fetch(`${apiServer.base}/api/projects/${project.id}/publish`, {
      method: "POST", headers: ownerHeaders(), body: JSON.stringify({ batchId: "recovery_publish_batch" }),
    });
    assert.equal(publication.status, 200);
    assert.equal((await publication.json() as { state: string }).state, "confirmed");

    await apiServer.close();
    apiServer = undefined;
    await rm(dataDir, { recursive: true, force: true });
    store = new CoreStore({ dataDir, allowLocalRemotes: true });
    apiServer = await startCustomApi(store, staticDir);
    owner = await login(apiServer.base);
    const recoveredRegistration = await fetch(`${apiServer.base}/api/projects`, {
      method: "POST", headers: ownerHeaders(), body: JSON.stringify({ url: remote }),
    });
    assert.equal(recoveredRegistration.status, 201);
    const recoveredProject = await recoveredRegistration.json() as { id: string };
    assert.notEqual(recoveredProject.id, project.id, "the project cache is reconstructed from the remote after data-root deletion");

    const statusPath = `${apiServer.base}/api/projects/${recoveredProject.id}/proposals/${proposal.id}`;
    const partialResponse = await fetch(statusPath, { headers: { Cookie: owner.cookie } });
    assert.equal(partialResponse.status, 200);
    const partial = await partialResponse.json() as ProposalStatus;
    assert.equal(partial.payloadComplete, false);
    assert.equal(partial.proposal.source, "mcp");
    assert.deepEqual(partial.operationIds, [selected.id, unselected.id]);
    assert.deepEqual(partial.proposal.operations.map(({ id }) => id), [selected.id]);
    assert.deepEqual(partial.approvedOperationIds, [selected.id]);
    assert.deepEqual(partial.publishedOperationIds, [selected.id]);

    const retry = await fetch(`${apiServer.base}/api/projects/${recoveredProject.id}/proposals`, {
      method: "POST", headers: ownerHeaders(), body: JSON.stringify(proposal),
    });
    assert.equal(retry.status, 201);
    assert.deepEqual(await retry.json(), proposal, "the owner retry restores the exact original MCP payload and source");
    const restoredResponse = await fetch(statusPath, { headers: { Cookie: owner.cookie } });
    const restored = await restoredResponse.json() as ProposalStatus;
    assert.equal(restored.payloadComplete, true);
    assert.deepEqual(restored.proposal, proposal);
    assert.deepEqual(restored.approvedOperationIds, [selected.id], "restoring payload must not approve the remaining operation");
    assert.deepEqual(restored.publishedOperationIds, [selected.id]);

    const changed = {
      ...proposal,
      operations: proposal.operations.map((item) => item.id === unselected.id
        ? { ...item, writes: [{ ...item.writes[0]!, content: "Changed recovered payload.\n" }] }
        : item),
    };
    const changedRetry = await fetch(`${apiServer.base}/api/projects/${recoveredProject.id}/proposals`, {
      method: "POST", headers: ownerHeaders(), body: JSON.stringify(changed),
    });
    assert.equal(changedRetry.status, 409);
    assert.equal((await changedRetry.json() as { code: string }).code, "proposal_id_reused", "Core must keep enforcing the original full-payload digest");

    const unapprovedCheckpoint = await fetch(`${apiServer.base}/api/projects/${recoveredProject.id}/checkpoints`, {
      method: "POST", headers: ownerHeaders(), body: JSON.stringify(unselected),
    });
    assert.equal(unapprovedCheckpoint.status, 403);
    assert.equal((await unapprovedCheckpoint.json() as { code: string }).code, "author_approval_required");

    const currentSnapshot = (await store.observe(recoveredProject.id)).snapshot;
    const newCookieOperation = {
      ...cookieOperation,
      repository: currentSnapshot.repository,
      baseRemoteCommit: currentSnapshot.remoteCommit,
    };
    const newCookieProposal = await fetch(`${apiServer.base}/api/projects/${recoveredProject.id}/proposals`, {
      method: "POST", headers: ownerHeaders(),
      body: JSON.stringify({ id: "new_cookie_after_recovery", snapshot: currentSnapshot, operations: [newCookieOperation], source: "mcp" }),
    });
    assert.equal(newCookieProposal.status, 201);
    assert.equal((await newCookieProposal.json() as ChangeProposal).source, "author", "transport attribution still applies to new cookie proposals after recovery");
  });

  it("streams owner-scoped events only for actual manual sync outcomes and closes streams on shutdown", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-project-events-"));
    tempDirs.push(staticDir);
    let syncCount = 0;
    let observationCount = 0;
    const store = Object.assign(makeStore(), {
      async observe() {
        observationCount += 1;
        return {
          snapshot: { ...SNAPSHOT, remoteCommit: observationCount === 1 ? SNAPSHOT.remoteCommit : "b".repeat(40) },
          checkpointHead: "c".repeat(40), observedAt: new Date().toISOString(), state: "fresh" as const, pending: [],
        };
      },
      async sync() {
        syncCount += 1;
        if (syncCount === 2) throw { status: 409, code: "sync_conflict", message: "Remote synchronization failed" };
        return { branch: "main", head: "b".repeat(40), ahead: 0, behind: 0, dirty: false };
      },
    }) as unknown as CoreStore;
    const apiServer = await startCustomApi(store, staticDir);
    let closeCalled = false;
    t.after(async () => { if (!closeCalled) await apiServer.close(); });
    const owner = await login(apiServer.base);
    const stream = await fetch(`${apiServer.base}/api/projects/events`, { headers: { Cookie: owner.cookie } });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/u);
    assert.equal((await fetch(`${apiServer.base}/api/projects/events`)).status, 401);

    const syncRequest = () => fetch(`${apiServer.base}/api/projects/project-1/sync`, {
      method: "POST",
      headers: { Cookie: owner.cookie, Origin: apiServer.base },
    });
    const completed = await syncRequest();
    assert.equal(completed.status, 200);
    const failed = await syncRequest();
    assert.equal(failed.status, 409);

    const streamReader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let frames = "";
    while (!frames.includes('"phase":"failed"')) {
      const item = await streamReader.read();
      if (item.done) break;
      frames += decoder.decode(item.value, { stream: true });
    }
    const parsed = [...frames.matchAll(/data: (\{[^\n]+\})\n\n/gu)].map((match) => JSON.parse(match[1]!) as {
      id: string; type: string; projectId: string; reason: string; phase: string; status?: { head: string };
      observation?: { snapshot: SnapshotId; pendingCount: number }; updated?: boolean; error?: { code: string };
    });
    assert.deepEqual(parsed.map(({ phase }) => phase), ["started", "completed", "started", "failed"]);
    assert.ok(parsed.every((event) => event.type === "project-sync" && event.projectId === "project-1" && event.reason === "manual"));
    assert.equal(parsed[0]?.id, parsed[1]?.id);
    assert.equal(parsed[2]?.id, parsed[3]?.id);
    assert.equal(parsed[1]?.status?.head, "b".repeat(40));
    assert.equal(parsed[1]?.observation?.snapshot.remoteCommit, "b".repeat(40));
    assert.equal(parsed[1]?.updated, true);
    assert.deepEqual(parsed[3]?.error, { code: "sync_conflict", retryable: false });
    const shutdownAt = Date.now();
    await apiServer.close();
    closeCalled = true;
    assert.equal((await streamReader.read()).done, true, "shutdown must close the live event stream");
    assert.ok(Date.now() - shutdownAt < 5_000, "shutdown must not wait indefinitely for event-stream clients");
  });

  it("routes project reconstruction and detachment only through the guarded Core ports", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-project-management-"));
    tempDirs.push(staticDir);
    const project = { id: "project-1", url: "https://github.com/owner/work.git", branch: "main" };
    const reconstructed: string[] = [];
    const detached: string[] = [];
    let refuseDetach = true;
    const store = Object.assign(makeStore(), {
      async reconstructProject(projectId: string) { reconstructed.push(projectId); return project; },
      async detachProject(projectId: string) {
        detached.push(projectId);
        if (refuseDetach) throw { status: 409, code: "pending_checkpoints", message: "Pending local checkpoint operations block detach" };
      },
    }) as unknown as CoreStore;
    const apiServer = await startCustomApi(store, staticDir);
    t.after(apiServer.close);
    const owner = await login(apiServer.base);
    const ownerJson = { Cookie: owner.cookie, Origin: apiServer.base, "Content-Type": "application/json" };
    const ownerMutation = { Cookie: owner.cookie, Origin: apiServer.base };

    const bearerPut = await fetch(`${apiServer.base}/api/projects/project-1`, {
      method: "PUT", headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    assert.equal(bearerPut.status, 403);
    assert.deepEqual(reconstructed, []);

    const otherUrl = await fetch(`${apiServer.base}/api/projects/project-1`, {
      method: "PUT", headers: ownerJson, body: JSON.stringify({ repoUrl: "https://github.com/other/repo.git" }),
    });
    assert.equal(otherUrl.status, 409);
    assert.equal((await otherUrl.json() as { code: string }).code, "REGISTER_REPOSITORY_FIRST");
    assert.deepEqual(reconstructed, [], "mismatched remote URLs must not reach Core reconstruction");

    const credentialInput = await fetch(`${apiServer.base}/api/projects/project-1`, {
      method: "PUT", headers: ownerJson, body: JSON.stringify({ url: project.url, token: "must-not-echo" }),
    });
    const credentialError = await credentialInput.json() as { code: string; error: string };
    assert.equal(credentialInput.status, 400);
    assert.equal(credentialError.code, "REGISTER_REPOSITORY_FIRST");
    assert.equal(credentialError.error.includes("must-not-echo"), false);
    assert.deepEqual(reconstructed, []);

    const reconstruction = await fetch(`${apiServer.base}/api/projects/project-1`, {
      method: "PUT", headers: ownerJson, body: JSON.stringify({ url: project.url, branch: "main" }),
    });
    assert.equal(reconstruction.status, 200);
    assert.deepEqual(await reconstruction.json(), { project });
    assert.deepEqual(reconstructed, ["project-1"]);

    const branchOverride = await fetch(`${apiServer.base}/api/projects/project-1`, {
      method: "PUT", headers: ownerJson, body: JSON.stringify({ branch: "feature" }),
    });
    assert.equal(branchOverride.status, 409);
    assert.equal((await branchOverride.json() as { code: string }).code, "DEFAULT_BRANCH_MISMATCH");

    const patch = await fetch(`${apiServer.base}/api/projects/project-1`, {
      method: "PATCH", headers: ownerJson, body: JSON.stringify({ autoMerge: true }),
    });
    assert.equal(patch.status, 410);
    assert.equal((await patch.json() as { code: string }).code, "AUTO_MERGE_RETIRED");

    const bearerDelete = await fetch(`${apiServer.base}/api/projects/project-1`, {
      method: "DELETE", headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    assert.equal(bearerDelete.status, 403);
    assert.deepEqual(detached, []);

    const blockedDetach = await fetch(`${apiServer.base}/api/projects/project-1`, { method: "DELETE", headers: ownerMutation });
    assert.equal(blockedDetach.status, 409);
    assert.equal((await blockedDetach.json() as { code: string }).code, "pending_checkpoints");
    refuseDetach = false;
    const detach = await fetch(`${apiServer.base}/api/projects/project-1`, { method: "DELETE", headers: ownerMutation });
    assert.equal(detach.status, 204);
    assert.deepEqual(detached, ["project-1", "project-1"]);
  });

  it("keeps the real Core clone unchanged on URL mismatch and honors its detach guard", async (t) => {
    const { root, remote } = await makeBareRemote();
    tempDirs.push(root);
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-real-project-"));
    tempDirs.push(staticDir);
    const dataDir = resolve(root, "state");
    const store = new CoreStore({ dataDir, allowLocalRemotes: true });
    const apiServer = await startCustomApi(store, staticDir);
    t.after(apiServer.close);
    const owner = await login(apiServer.base);
    const headers = { Cookie: owner.cookie, Origin: apiServer.base, "Content-Type": "application/json" };

    const registration = await fetch(`${apiServer.base}/api/projects`, {
      method: "POST", headers, body: JSON.stringify({ url: remote }),
    });
    assert.equal(registration.status, 201);
    const project = await registration.json() as { id: string; url: string; branch: string };
    assert.equal(project.branch, "main");
    const workspace = resolve(dataDir, "projects", project.id);
    const originalFile = await readFile(resolve(workspace, "README.md"), "utf8");

    const mismatch = await fetch(`${apiServer.base}/api/projects/${project.id}`, {
      method: "PUT", headers, body: JSON.stringify({ url: resolve(root, "other.git") }),
    });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json() as { code: string }).code, "REGISTER_REPOSITORY_FIRST");
    assert.equal(await readFile(resolve(workspace, "README.md"), "utf8"), originalFile);
    assert.deepEqual(await store.listProjects(), [project]);

    const reconstructedResponse = await fetch(`${apiServer.base}/api/projects/${project.id}`, {
      method: "PUT", headers, body: JSON.stringify({ repoUrl: project.url, branch: "main" }),
    });
    assert.equal(reconstructedResponse.status, 200);
    assert.deepEqual(await reconstructedResponse.json(), { project });
    assert.equal(await readFile(resolve(workspace, "README.md"), "utf8"), originalFile);

    const untrackedPath = resolve(workspace, "api-test-untracked.md");
    await writeFile(untrackedPath, "uncommitted local content\n", "utf8");
    const blocked = await fetch(`${apiServer.base}/api/projects/${project.id}`, { method: "DELETE", headers: { Cookie: owner.cookie, Origin: apiServer.base } });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json() as { code: string }).code, "working_tree_dirty");
    assert.deepEqual(await store.listProjects(), [project]);
    await rm(untrackedPath, { force: true });

    const detached = await fetch(`${apiServer.base}/api/projects/${project.id}`, { method: "DELETE", headers: { Cookie: owner.cookie, Origin: apiServer.base } });
    assert.equal(detached.status, 204);
    assert.deepEqual(await store.listProjects(), []);
  });

  it("allows bearer compute under runtime effect limits and host-assigns MCP proposal source", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-effects-"));
    const cacheDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-effects-cache-"));
    tempDirs.push(staticDir, cacheDir);
    const fixture = makeSnapshotStore();
    const apiServer = await startCustomApi(fixture.store, staticDir, { runtime: actionBoundaryRuntime(cacheDir) });
    t.after(apiServer.close);
    const bearer = { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" };

    const version = await fetch(`${apiServer.base}/api/version`);
    assert.deepEqual((await version.json() as { auth: string[] }).auth, ["cookie-owner", "bearer-read-compute-propose"]);
    const computed = await fetch(`${apiServer.base}/api/projects/project-1/actions/nlp.analyze`, {
      method: "POST", headers: bearer, body: JSON.stringify({ input: {} }),
    });
    const computeResult = await computed.json() as ActionResult<{ nested: ActionResult }>;
    assert.equal(computeResult.ok, true);
    assert.equal(computeResult.ok && computeResult.data.nested.ok, false);
    assert.equal(computeResult.ok && !computeResult.data.nested.ok && computeResult.data.nested.error.code, "action_effect_denied");
    assert.equal(fixture.proposed.length, 0, "compute must not reach a host proposal port");

    const operation: ChangeOperation = {
      id: "mcp-cookie-operation", generation: 0, repository: SNAPSHOT.repository, baseRemoteCommit: SNAPSHOT.remoteCommit,
      effect: "metadata", reads: [], writes: [], message: "MCP contribution proposal",
    };
    const owner = await login(apiServer.base);
    const actionProposal = await fetch(`${apiServer.base}/api/projects/project-1/actions/mcp.propose`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify({ input: operation }),
    });
    assert.equal(actionProposal.status, 200);
    assert.equal((await actionProposal.json() as ActionResult<{ proposal: ChangeProposal }>).ok, true);
    assert.equal(fixture.proposed[0]?.source, "mcp");

    const httpProposal = await fetch(`${apiServer.base}/api/projects/project-1/modules/mcp/propose`, {
      method: "POST",
      headers: { Cookie: owner.cookie, "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify(operation),
    });
    assert.equal(httpProposal.status, 200);
    assert.deepEqual(await httpProposal.json(), { source: "mcp" });
    assert.equal(fixture.proposed[1]?.source, "mcp");
  });

  it("passes public module requests through the registered relative route with a fresh remote reader", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-module-"));
    const cacheDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-module-cache-"));
    tempDirs.push(staticDir, cacheDir);
    const observed: PublishingObservations = { paths: [] };
    const runtime = publishingRuntime(cacheDir, observed);
    const apiServer = await startCustomApi(makeSnapshotStore().store, staticDir, { runtime });
    t.after(apiServer.close);

    const descriptors = await fetch(`${apiServer.base}/api/projects/project-1/actions`, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    const actions = (await descriptors.json() as { actions: Array<{ id: string }> }).actions;
    assert.ok(actions.some(({ id }) => id === "publishing.read-core"));
    const invoked = await fetch(`${apiServer.base}/api/projects/project-1/actions/publishing.read-core`, {
      method: "POST", headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ input: {} }),
    });
    assert.equal((await invoked.json() as { ok: boolean; data: unknown }).ok, true);

    const ownerRoute = await fetch(`${apiServer.base}/api/projects/project-1/modules/publishing/share/secret`);
    assert.equal(ownerRoute.status, 401);
    const owner = await login(apiServer.base);
    const publicResponse = await fetch(`${apiServer.base}/api/public/repos/123/modules/publishing/share/secret?lang=en`, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        Cookie: owner.cookie,
        "Proxy-Authorization": "Basic ambient-proxy-secret",
        "Mcp-Session-Id": "mcp-session-123",
      },
    });
    assert.equal(publicResponse.status, 200);
    const publicBody = await publicResponse.json() as { path: string; access: string; snapshot: string };
    assert.equal(publicBody.path, "/share/secret");
    assert.equal(publicBody.access, "project-1");
    assert.equal(publicBody.snapshot, SNAPSHOT.remoteCommit);
    assert.deepEqual(observed.paths, ["/share/secret"]);
    assert.equal(publicResponse.headers.get("cache-control"), "no-store");
    assert.equal(publicResponse.headers.get("referrer-policy"), "no-referrer");
    assert.equal(publicResponse.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.deepEqual(observed.forwardedHeaders, {
      authorization: null,
      cookie: null,
      proxyAuthorization: null,
      mcpSessionId: "mcp-session-123",
    });
    assert.equal(observed.publicCoreActions?.ok, false);
    assert.equal(observed.publicCoreActions?.ok === false && observed.publicCoreActions.error.code, "public_action_unavailable");
    assert.equal(observed.publicActionIds?.some((id) => id.startsWith("core.")), false);
    assert.equal(observed.linkedReaderError, "public_access_restricted");
  });

  it("bounds shutdown when an in-flight module handler ignores cancellation", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-drain-"));
    const cacheDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-drain-cache-"));
    tempDirs.push(staticDir, cacheDir);
    const manifest: ModuleManifest = {
      id: "mcp", version: "0.1.0", contractVersion: 1,
      dependencies: [], provides: [], requires: [], statePaths: [], locality: "local",
    };
    let markEntered!: () => void;
    const entered = new Promise<void>((resolveEntered) => { markEntered = resolveEntered; });
    const definition: ModuleDefinition = {
      manifest, actions: [], ui: [],
      http: [{
        id: "hang", path: "hang", methods: ["GET"], access: "owner", effect: "read",
        async handle() { markEntered(); return await new Promise<Response>(() => undefined); },
      }],
      async dispose() {},
    };
    const runtime = new ModuleRuntime({
      manifests: [manifest], enabled: ["mcp"], cacheDirectory: cacheDir, moduleDrainTimeoutMs: 50,
      loaders: { mcp: async () => definition },
    });
    const apiServer = await startCustomApi(makeSnapshotStore().store, staticDir, { runtime });
    let closeCalled = false;
    t.after(async () => { if (!closeCalled) await apiServer.close().catch(() => undefined); });
    const request = fetch(`${apiServer.base}/api/projects/project-1/modules/mcp/hang`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    }).catch((error: unknown) => error);
    await entered;
    const startedAt = Date.now();
    closeCalled = true;
    const closeError = await apiServer.close().then(() => undefined, (error: unknown) => error);
    assert.ok(Date.now() - startedAt < 7_000, "server.close must finish after the bounded drain deadline");
    assert.equal((closeError as { code?: string } | undefined)?.code, "module_drain_timeout");
    assert.ok(await request instanceof Error, "the forcibly closed in-flight request must terminate");
  });

  it("stores scratch text and bounded attachments only through Core proposal/checkpoint operations", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-scratch-"));
    tempDirs.push(staticDir);
    const fixture = makeSnapshotStore();
    const apiServer = await startCustomApi(fixture.store, staticDir);
    t.after(apiServer.close);
    const owner = await login(apiServer.base);
    const raw = Buffer.from([0, 1, 2, 250]);
    const response = await fetch(`${apiServer.base}/api/projects/project-1/scratch`, {
      method: "POST", headers: { Cookie: owner.cookie, "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify({ text: "", source: "camera", sceneId: "scene-one", attachments: [{ filename: "../../note.png", mimeType: "image/png", dataBase64: raw.toString("base64") }] }),
    });
    assert.equal(response.status, 201);
    const result = await response.json() as { attachments: Array<{ path: string; filename: string }>; proposal: ChangeProposal };
    assert.equal(result.attachments[0]?.filename.includes("/"), false);
    assert.equal(result.proposal.source, "author");
    const writes = fixture.proposed[0]?.operations[0]?.writes ?? [];
    const attachment = writes.find((write) => write.encoding === "base64");
    assert.ok(attachment);
    assert.equal(Buffer.from(attachment.content ?? "", "base64").toString("hex"), raw.toString("hex"));
    assert.ok(writes.some((write) => write.path.endsWith(".md") && write.content?.includes("![")));
    assert.equal(fixture.approvals[0]?.authorScope, "owner");
  });
});
