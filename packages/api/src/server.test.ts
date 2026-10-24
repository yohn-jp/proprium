import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, generateKeyPairSync, sign as signJwt } from "node:crypto";
import { request as httpRequest } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { MODEL_USAGE_CAPABILITY, type ActionResult, type ChangeOperation, type ChangeProposal, type JobRequest, type ModelUsageEvent, type ModelUsageStore, type ModuleAction, type ModuleContext, type ModuleDefinition, type ModuleManifest, type ProposalStatus, type RepositoryIdentity, type SnapshotId, type ValueSchema } from "@scriptorium/contracts";
import { CoreStore, type CoreStore as CoreStoreShape } from "@scriptorium/core";
import { ModuleRuntime, type ModuleLoader, type ModuleRuntimeOptions, type WorkerJobLifecycleListener, type WorkerJobLifecycleSnapshot } from "@scriptorium/module-runtime";
import { HistoricalModelUsageError, HistoricalModelUsageStore } from "./historical-store.js";
import { JobHistoryError, JobHistoryStore, type WorkerJobLifecycle } from "./job-history-store.js";
import "./recent-activity-store.test.js";
import "./platform-runtime.test.js";
import { createServer, importLegacyJobHistory, type ApiServerOptions, type HostedAuthorizationPolicy, type HostedPrincipal } from "./server.js";
import { RUNTIME_QUIESCE_PATH, RUNTIME_RESUME_PATH, RUNTIME_STATUS_PATH, sha256Digest, type RuntimeAssignment } from "./platform-runtime.js";

const ACCESS_TOKEN = "test-access-token-which-is-longer-than-32-characters";
const execFile = promisify(execFileCallback);
const SNAPSHOT: SnapshotId = {
  repository: { provider: "github", repositoryId: "123", defaultBranch: "main", ownerScope: "owner-1", url: "https://github.com/owner/work.git" },
  remoteCommit: "a".repeat(40),
};
const HOSTED_ASSIGNMENT: RuntimeAssignment = {
  contractVersion: "scriptorium-platform/v1",
  instanceId: "instance-1",
  repositoryId: 123,
  repositoryLocator: "https://github.com/owner/work",
  defaultBranchPolicy: "repository-default",
  runtimeEpoch: 3,
  imageDigest: `sha256:${"a".repeat(64)}`,
  compositionManifestDigest: `sha256:${"b".repeat(64)}`,
  enabledModuleIds: ["story", "mcp"],
  credentialBrokerLocator: "https://praetorium.example/internal/github/credential",
  controlServicePolicy: {
    issuer: "https://praetorium.example",
    jwksUrl: "https://praetorium.example/.well-known/control-jwks.json",
    audience: "praetorium-runtime-control",
  },
  grantPolicy: {
    issuer: "https://praetorium.example",
    jwksUrl: "https://praetorium.example/.well-known/grant-jwks.json",
    audience: "https://instance-1.instances.example",
  },
};
const RUNTIME_CONTROL_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const RUNTIME_CONTROL_PUBLIC_JWK = {
  ...RUNTIME_CONTROL_KEY.publicKey.export({ format: "jwk" }),
  use: "sig",
  alg: "ES256",
  kid: "runtime-control-test-key",
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
    localObservation: async () => ({ snapshot: SNAPSHOT, checkpointHead: SNAPSHOT.remoteCommit, observedAt: "1970-01-01T00:00:00.000Z", state: "unknown", pending: [] }),
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
  const snapshotReads: Array<{ kind: "tree" | "scene" | "views"; view?: string; pinned?: string }> = [];
  const document = { path: "manuscript/ms-one/scene-one.md", content: "---\nid: scene-one\n---\n\nA harbor at night.\n", revision: "body-revision" };
  const store = Object.assign(makeStore(), {
    async reader(_projectId: string, _view = "remote", pinned?: SnapshotId | string) {
      pinnedReads.push(typeof pinned === "string" ? pinned : pinned?.remoteCommit);
      const snapshot = typeof pinned === "object" ? pinned : { ...SNAPSHOT, ...(pinned ? { remoteCommit: pinned } : {}) };
      return {
        snapshot,
        async read(path: string, encoding: "utf8" | "base64" = "utf8") {
          if (path !== document.path) return null;
          return { content: encoding === "base64" ? Buffer.from(document.content).toString("base64") : document.content, revision: document.revision };
        },
        async list(prefix: string) { return prefix === "manuscript/" ? [document.path] : []; },
      };
    },
    async resolveDocumentScene(_projectId: string, path: string, pinned?: SnapshotId | string) {
      return { snapshot: typeof pinned === "object" ? pinned : SNAPSHOT, sceneId: path === document.path ? "scene-one" : null };
    },
    async observe() { return { snapshot: SNAPSHOT, checkpointHead: SNAPSHOT.remoteCommit, observedAt: "2026-10-17T00:00:00.000Z", state: "fresh" as const, pending: [] }; },
    async localObservation() { return { snapshot: SNAPSHOT, checkpointHead: SNAPSHOT.remoteCommit, observedAt: "1970-01-01T00:00:00.000Z", state: "unknown" as const, pending: [] }; },
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
    async readSceneViews(_projectId: string, sceneId: string, pinned: string) {
      snapshotReads.push({ kind: "views", pinned });
      const read = {
        snapshot: { ...SNAPSHOT, remoteCommit: pinned },
        scene: { id: sceneId, title: "Opening", text: "A harbor at night.", revision: "scene-revision" },
        document,
        metadata: { path: "plot/volumes/v1/chapters/c1/scenes/scene-one.yaml", content: "id: scene-one\n", revision: "metadata-revision" },
      };
      return { remote: read, effective: read };
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
    }, {
      id: "compute", path: "compute", methods: ["POST"], access: "owner", effect: "compute",
      async handle(request, context) {
        const input = await request.json() as { operation?: ChangeOperation };
        const document = await context.reader.read("manuscript/ms-one/scene-one.md");
        const nested = await context.invoke("nlp.analyze", {});
        let proposalCode: string | null = null;
        try {
          await context.propose([input.operation as ChangeOperation]);
        } catch (error) {
          proposalCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
        }
        return Response.json({ document: document?.content ?? null, nested, proposalCode });
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

const testWorkerEntry = fileURLToPath(new URL("../../module-runtime/src/fixtures/worker.mjs", import.meta.url));

function jobHistoryRuntime(cacheDirectory: string): ModuleRuntime {
  const manifest: ModuleManifest = {
    id: "speaker", version: "0.1.0", contractVersion: 1,
    dependencies: [], provides: [], requires: [], statePaths: [], locality: "local",
  };
  const schema: ValueSchema = { parse(value) { return value; } };
  const definition: ModuleDefinition = {
    manifest,
    actions: [{
      id: "test-worker", effect: "compute", inputSchema: schema, outputSchema: schema,
      async invoke(input, context): Promise<ActionResult> {
        const value = input as { jobId: string; task?: string };
        const request: JobRequest = {
          id: value.jobId, module: "speaker", task: value.task ?? "echo", snapshot: context.reader.snapshot,
          model: "test-model", modelVersion: "1", moduleVersion: manifest.version, deadline: Date.now() + 10_000,
          input: { privatePayload: "worker-input-must-not-enter-owner-history" },
        };
        return { ok: true, snapshot: context.reader.snapshot, data: await context.runJob(request) };
      },
    }],
    ui: [],
    async dispose() {},
  };
  return new ModuleRuntime({
    manifests: [manifest], enabled: ["speaker"], loaders: { speaker: async () => definition },
    workerEntries: { speaker: testWorkerEntry }, cacheDirectory,
  });
}

function sourceDomainJobRuntime(cacheDirectory: string): {
  runtime: ModuleRuntime;
  asyncStarted: Promise<void>;
  releaseAsync(): void;
} {
  const schema: ValueSchema = { parse(value) { return value; } };
  const speakerManifest: ModuleManifest = {
    id: "speaker", version: "0.1.0", contractVersion: 1,
    dependencies: [], provides: [], requires: [], statePaths: [], locality: "local",
  };
  const mcpManifest: ModuleManifest = {
    id: "mcp", version: "0.1.0", contractVersion: 1,
    dependencies: [], provides: [], requires: [], statePaths: [], locality: "local",
  };
  let resolveAsyncStarted!: () => void;
  const asyncStarted = new Promise<void>((resolveStarted) => { resolveAsyncStarted = resolveStarted; });
  let releaseAsync!: () => void;
  const asyncGate = new Promise<void>((resolveGate) => { releaseAsync = resolveGate; });
  const speakerAction: ModuleAction = {
    id: "speaker.evaluation.run", effect: "compute", job: { type: "speaker-eval" },
    inputSchema: schema, outputSchema: schema,
    async invoke(rawInput, context): Promise<ActionResult> {
      const input = rawInput as { fail?: boolean; wait?: boolean; progress?: number[] };
      if (Array.isArray(input.progress)) {
        if (!context.reportProgress) throw new Error("The host did not scope domain progress to this invocation");
        for (const progress of input.progress) await context.reportProgress(progress);
      }
      if (input.wait) {
        resolveAsyncStarted();
        await asyncGate;
      }
      if (input.fail) {
        return { ok: false, snapshot: context.reader.snapshot, error: { code: "synthetic_evaluation_failed", message: "Synthetic evaluation failure", retryable: true } };
      }
      return {
        ok: true, snapshot: context.reader.snapshot,
        data: { report: { examples: 3, accuracy: 0.75 }, version: "synthetic-v1" },
      };
    },
  };
  const definition: ModuleDefinition = {
    manifest: speakerManifest, actions: [speakerAction], ui: [], async dispose() {},
  };
  const mcpDefinition: ModuleDefinition = {
    manifest: mcpManifest, actions: [], ui: [],
    http: [{
      id: "invoke", path: "invoke", methods: ["POST"], access: "owner", effect: "propose",
      async handle(request, context) {
        return Response.json(await context.invoke("speaker.evaluation.run", await request.json()));
      },
    }],
    async dispose() {},
  };
  return {
    runtime: new ModuleRuntime({
      manifests: [speakerManifest, mcpManifest], enabled: ["speaker", "mcp"], cacheDirectory,
      loaders: { speaker: async () => definition, mcp: async () => mcpDefinition },
    }),
    asyncStarted,
    releaseAsync: () => releaseAsync(),
  };
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

function hostedTestPolicy(): HostedAuthorizationPolicy {
  const principals = new Map<string, HostedPrincipal>([
    ["read-grant", {
      userId: "reader-1", permissions: ["read"], repositoryId: HOSTED_ASSIGNMENT.repositoryId,
      instanceId: HOSTED_ASSIGNMENT.instanceId, runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
      sessionRevision: 1, authorizationRevision: 1, expiresAt: Date.now() + 60_000,
    }],
    ["write-grant", {
      userId: "writer-1", permissions: ["read", "write"], repositoryId: HOSTED_ASSIGNMENT.repositoryId,
      instanceId: HOSTED_ASSIGNMENT.instanceId, runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
      sessionRevision: 1, authorizationRevision: 1, expiresAt: Date.now() + 60_000,
    }],
  ]);
  return {
    async authenticate(token, requiredPermission = "read") {
      const principal = principals.get(token);
      if (!principal) throw Object.assign(new Error("grant invalid"), { status: 401 });
      if (!principal.permissions.includes(requiredPermission)) throw Object.assign(new Error("permission denied"), { status: 403 });
      return principal;
    },
    async authorizePublication() {
      throw Object.assign(new Error("publication is not part of this server-boundary test"), { status: 503 });
    },
  };
}

class InterleavingLifecycleRuntime extends ModuleRuntime {
  private lifecycleListener: WorkerJobLifecycleListener | undefined;

  override subscribeJobLifecycle(listener: WorkerJobLifecycleListener): () => void {
    this.lifecycleListener = listener;
    return () => { if (this.lifecycleListener === listener) this.lifecycleListener = undefined; };
  }

  async emitLifecycle(snapshot: WorkerJobLifecycleSnapshot): Promise<void> {
    await this.lifecycleListener?.(snapshot);
  }
}

async function startHostedApi(
  store: CoreStore,
  staticDir: string,
  authorization: HostedAuthorizationPolicy,
  controlFetch?: typeof fetch,
  runtime?: ModuleRuntime,
  usageDirectory?: string,
) {
  const server = createServer({
    store, staticDir,
    trustProxy: true,
    ...(runtime ? { runtime } : {}),
    ...(usageDirectory ? { usageDirectory } : {}),
    hosted: { assignment: HOSTED_ASSIGNMENT, projectId: "project-1", authorization, ...(controlFetch ? { controlFetch } : {}) },
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const close = () => new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return { server, base, close };
}

function rawHostedRequestStatus(urlValue: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(urlValue);
  return new Promise((resolveStatus, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers,
    }, (response) => {
      response.resume();
      response.once("end", () => resolveStatus(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

function runtimeControlToken(action: "status" | "quiesce" | "resume", operationId: string, payloadDigest: string): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const unsigned = `${encode({ alg: "ES256", kid: "runtime-control-test-key", typ: "JWT" })}.${encode({
    contractVersion: "praetorium-runtime-control/v1",
    iss: HOSTED_ASSIGNMENT.controlServicePolicy.issuer,
    sub: "test-control-plane",
    aud: HOSTED_ASSIGNMENT.controlServicePolicy.audience,
    instanceId: HOSTED_ASSIGNMENT.instanceId,
    repositoryId: HOSTED_ASSIGNMENT.repositoryId,
    runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
    operationId,
    action,
    payloadDigest,
    iat: now,
    nbf: now,
    exp: now + 30,
    jti: `${action}-${operationId}`,
  })}`;
  const signature = signJwt("sha256", Buffer.from(unsigned, "ascii"), {
    key: RUNTIME_CONTROL_KEY.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${signature.toString("base64url")}`;
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

async function waitForJob(base: string, cookie: string, id: string): Promise<{ status: string; result: unknown }> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}/api/jobs/${encodeURIComponent(id)}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const job = await response.json() as { status: string; result: unknown };
    if (job.status === "done" || job.status === "error") return job;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.fail(`Job ${id} did not reach a terminal state`);
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Scriptorium HTTP boundary", () => {
  it("binds hosted API access and signed lifecycle controls to one repository and runtime epoch", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-hosted-api-"));
    tempDirs.push(staticDir);
    let pending: Awaited<ReturnType<CoreStore["observe"]>>["pending"] = [];
    let pendingProposalCount = 0;
    let localWorkspaceDirty = false;
    let remoteObservationCalls = 0;
    let latestObservation: Awaited<ReturnType<CoreStore["observe"]>> | undefined;
    const fixture = makeSnapshotStore();
    const store = Object.assign(fixture.store, {
      async registeredRepositoryIdentity() { return SNAPSHOT.repository; },
      async observe() {
        remoteObservationCalls++;
        latestObservation = {
          snapshot: SNAPSHOT, checkpointHead: SNAPSHOT.remoteCommit,
          observedAt: new Date().toISOString(), state: "fresh" as const, pending,
        };
        return latestObservation;
      },
      async listProposals() {
        return Array.from({ length: pendingProposalCount }, () => ({ state: "pending" }) as unknown as ProposalStatus);
      },
      async localDurabilityCensus() {
        assert.ok(latestObservation, "a signed status preflight seeded the bounded local census");
        const observation = { ...latestObservation, pending };
        const reader = await fixture.store.reader("project-1", "remote", observation.snapshot.remoteCommit || undefined);
        return {
          observation,
          reader,
          pendingCheckpoints: observation.pending,
          pendingProposals: pendingProposalCount,
          localWorkspaceDirty,
        };
      },
    }) as CoreStore;
    const controlFetch: typeof fetch = async (input) => {
      assert.equal(String(input), HOSTED_ASSIGNMENT.controlServicePolicy.jwksUrl);
      return Response.json({ keys: [RUNTIME_CONTROL_PUBLIC_JWK] });
    };
    const apiServer = await startHostedApi(store, staticDir, hostedTestPolicy(), controlFetch);
    t.after(apiServer.close);

    const noGrant = await fetch(`${apiServer.base}/api/projects`);
    assert.equal(noGrant.status, 401);
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const discovery = await fetch(`${apiServer.base}${path}`);
      assert.equal(discovery.status, 200, `${path} must be public without a grant`);
      assert.deepEqual(await discovery.json(), {
        resource: HOSTED_ASSIGNMENT.grantPolicy.audience,
        authorization_servers: [HOSTED_ASSIGNMENT.grantPolicy.issuer],
        scopes_supported: ["read", "write"],
      });
    }
    const mcpChallenge = await fetch(`${apiServer.base}/mcp`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    });
    assert.equal(mcpChallenge.status, 401);
    assert.match(mcpChallenge.headers.get("www-authenticate") ?? "", /oauth-protected-resource/u);
    const readerHeaders = { Authorization: "Bearer read-grant" };
    const mcpReader = await fetch(`${apiServer.base}/mcp`, { headers: readerHeaders });
    assert.equal(mcpReader.status, 404, "a read grant must pass auth even if MCP was not packaged");
    const projects = await fetch(`${apiServer.base}/api/projects`, { headers: readerHeaders });
    assert.equal(projects.status, 200);
    assert.deepEqual(await projects.json(), [{ id: "project-1", url: "https://github.com/owner/work.git", branch: "main" }]);
    const otherRepository = await fetch(`${apiServer.base}/api/projects/another-project/tree`, { headers: readerHeaders });
    assert.equal(otherRepository.status, 404);
    const ambiguous = await fetch(`${apiServer.base}/api/projects`, {
      headers: { Authorization: "Bearer read-grant", Cookie: "__Host-praetorium_access=write-grant" },
    });
    assert.equal(ambiguous.status, 400);

    const readAction = await fetch(`${apiServer.base}/api/projects/project-1/actions/core.repositories.list`, {
      method: "POST", headers: { ...readerHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ input: {} }),
    });
    assert.equal(readAction.status, 200, "read-only MCP grants may invoke POST actions whose declared effect is read");
    const proposalBody = JSON.stringify({ snapshot: SNAPSHOT, operations: [{ id: "operation-1" }] });
    const deniedProposal = await fetch(`${apiServer.base}/api/projects/project-1/proposals`, {
      method: "POST", headers: { ...readerHeaders, "Content-Type": "application/json" }, body: proposalBody,
    });
    assert.equal(deniedProposal.status, 403);
    assert.equal((await deniedProposal.json() as { code: string }).code, "WRITE_PERMISSION_REQUIRED");
    const cookieHeaders = {
      Host: "instance-1.instances.example", "X-Forwarded-Proto": "https", Origin: HOSTED_ASSIGNMENT.grantPolicy.audience,
      Cookie: "__Host-praetorium_access=write-grant; __Host-praetorium_csrf=csrf-value",
    };
    const missingCsrf = await rawHostedRequestStatus(`${apiServer.base}/api/inbox/read-all`, cookieHeaders);
    assert.equal(missingCsrf, 403);
    const cookieWrite = await rawHostedRequestStatus(`${apiServer.base}/api/inbox/read-all`, {
      ...cookieHeaders, "X-CSRF-Token": "csrf-value",
    });
    assert.equal(cookieWrite, 200);

    const statusWithoutControl = await fetch(`${apiServer.base}${RUNTIME_STATUS_PATH}`);
    assert.equal(statusWithoutControl.status, 401);
    const statusToken = runtimeControlToken("status", "status-operation", sha256Digest(""));
    const statusResponse = await fetch(`${apiServer.base}${RUNTIME_STATUS_PATH}`, { headers: { Authorization: `Bearer ${statusToken}` } });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json() as {
      instanceId: string; repositoryId: number; runtimeEpoch: number;
      persistence: { state: string; observedRemoteCommit: string | null; remoteObservedAt?: string | null };
    };
    assert.deepEqual([status.instanceId, status.repositoryId, status.runtimeEpoch], ["instance-1", 123, 3]);
    assert.equal(status.persistence.state, "verified");
    assert.equal(status.persistence.observedRemoteCommit, SNAPSHOT.remoteCommit);
    assert.equal(status.persistence.remoteObservedAt, latestObservation?.observedAt,
      "verified persistence is bound to Core's successful observation time, not the API scan time");
    assert.ok(Number.isFinite(Date.parse(status.persistence.remoteObservedAt ?? "")));
    const observationsAfterPreflight = remoteObservationCalls;

    const quiesceRequest = {
      operationId: "quiesce-safe",
      instanceId: HOSTED_ASSIGNMENT.instanceId,
      runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
      reason: "redeploy",
      contractVersion: "scriptorium-platform/v1",
      deadline: new Date(Date.now() + 60_000).toISOString(),
    };
    const exactQuiesceBody = JSON.stringify(quiesceRequest);
    const quiesceToken = runtimeControlToken("quiesce", quiesceRequest.operationId, sha256Digest(exactQuiesceBody));
    const quiesceResponse = await fetch(`${apiServer.base}${RUNTIME_QUIESCE_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${quiesceToken}`, "Content-Type": "application/json" }, body: exactQuiesceBody,
    });
    assert.equal(quiesceResponse.status, 200);
    const safeReceipt = await quiesceResponse.json() as { disposition: string; activeMutations: number; pendingCheckpoints: number };
    assert.equal(safeReceipt.disposition, "safe");
    assert.equal(safeReceipt.activeMutations, 0);
    assert.equal(safeReceipt.pendingCheckpoints, 0);
    assert.equal(remoteObservationCalls, observationsAfterPreflight, "quiesce must use the local census after closing admission");
    const blockedByGate = await fetch(`${apiServer.base}/api/projects/project-1/proposals`, {
      method: "POST", headers: { Authorization: "Bearer write-grant", "Content-Type": "application/json" }, body: proposalBody,
    });
    assert.equal(blockedByGate.status, 503);
    assert.equal((await blockedByGate.json() as { code: string }).code, "RUNTIME_QUIESCED");

    const resumeToken = runtimeControlToken("resume", quiesceRequest.operationId, sha256Digest(exactQuiesceBody));
    const resumed = await fetch(`${apiServer.base}${RUNTIME_RESUME_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${resumeToken}`, "Content-Type": "application/json" }, body: exactQuiesceBody,
    });
    assert.equal(resumed.status, 204);
    const resumedAgain = await fetch(`${apiServer.base}${RUNTIME_RESUME_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${resumeToken}`, "Content-Type": "application/json" }, body: exactQuiesceBody,
    });
    assert.equal(resumedAgain.status, 204, "the same epoch and completed operation may resume idempotently");
    const unrelatedResumeBody = JSON.stringify({ ...quiesceRequest, operationId: "unrelated-resume" });
    const unrelatedResumeToken = runtimeControlToken("resume", "unrelated-resume", sha256Digest(unrelatedResumeBody));
    const unrelatedResume = await fetch(`${apiServer.base}${RUNTIME_RESUME_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${unrelatedResumeToken}`, "Content-Type": "application/json" }, body: unrelatedResumeBody,
    });
    assert.equal(unrelatedResume.status, 409);
    const allowedProposal = await fetch(`${apiServer.base}/api/projects/project-1/proposals`, {
      method: "POST", headers: { Authorization: "Bearer write-grant", "Content-Type": "application/json" }, body: proposalBody,
    });
    assert.equal(allowedProposal.status, 201);

    pending = [{ operationId: "local-checkpoint", generation: 0, localCommit: "c".repeat(40), remoteBase: SNAPSHOT.remoteCommit, revisions: [] }];
    pendingProposalCount = 1;
    localWorkspaceDirty = true;
    const blockedRequest = {
      ...quiesceRequest,
      operationId: "quiesce-blocked",
      deadline: new Date(Date.now() + 60_000).toISOString(),
    };
    const exactBlockedBody = JSON.stringify(blockedRequest);
    const blockedToken = runtimeControlToken("quiesce", blockedRequest.operationId, sha256Digest(exactBlockedBody));
    const blockedResponse = await fetch(`${apiServer.base}${RUNTIME_QUIESCE_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${blockedToken}`, "Content-Type": "application/json" }, body: exactBlockedBody,
    });
    assert.equal(blockedResponse.status, 200);
    const blockedReceipt = await blockedResponse.json() as { disposition: string; reasonCodes: string[] };
    assert.equal(blockedReceipt.disposition, "blocked");
    assert.ok(blockedReceipt.reasonCodes.includes("PENDING_CHECKPOINTS"));
    assert.ok(blockedReceipt.reasonCodes.includes("PENDING_PROPOSALS"));
    assert.ok(blockedReceipt.reasonCodes.includes("LOCAL_WORKSPACE_DIRTY"));
    const blockedResumeToken = runtimeControlToken("resume", blockedRequest.operationId, sha256Digest(exactBlockedBody));
    const blockedResume = await fetch(`${apiServer.base}${RUNTIME_RESUME_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${blockedResumeToken}`, "Content-Type": "application/json" }, body: exactBlockedBody,
    });
    assert.equal(blockedResume.status, 204, "resuming the exact blocked operation is an idempotent no-op");
    const gateReleasedAfterBlock = await fetch(`${apiServer.base}/api/projects/project-1/proposals`, {
      method: "POST", headers: { Authorization: "Bearer write-grant", "Content-Type": "application/json" }, body: proposalBody,
    });
    assert.equal(gateReleasedAfterBlock.status, 201);
  });

  it("keeps a quiesce census unverified when a worker job starts and finishes during its local scan, then permits a stable retry", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-hosted-activity-race-"));
    tempDirs.push(staticDir);
    const fixture = makeSnapshotStore();
    const runtime = new InterleavingLifecycleRuntime({ manifests: [], enabled: [], cacheDirectory: resolve(staticDir, "module-cache") });
    let latestObservation: Awaited<ReturnType<CoreStore["observe"]>> | undefined;
    let remoteObservationCalls = 0;
    let interleaveNextCensus = true;
    const lifecycleCreatedAt = new Date().toISOString();
    let lifecycleUpdatedAt = lifecycleCreatedAt;
    let lifecycleStartedAt: string | null = null;
    const lifecycle = async (state: WorkerJobLifecycleSnapshot["state"]): Promise<void> => {
      lifecycleUpdatedAt = new Date(Date.parse(lifecycleUpdatedAt) + 1).toISOString();
      if (state === "running") lifecycleStartedAt = lifecycleUpdatedAt;
      await runtime.emitLifecycle({
        jobId: "job-interleaving", module: "story", task: "runtime-activity-interleaving", snapshot: SNAPSHOT,
        state, createdAt: lifecycleCreatedAt, updatedAt: lifecycleUpdatedAt,
        startedAt: lifecycleStartedAt,
        finishedAt: state === "succeeded" || state === "failed" || state === "cancelled" ? lifecycleUpdatedAt : null,
      });
    };
    const store = Object.assign(fixture.store, {
      async registeredRepositoryIdentity() { return SNAPSHOT.repository; },
      async observe() {
        remoteObservationCalls++;
        latestObservation = {
          snapshot: SNAPSHOT, checkpointHead: SNAPSHOT.remoteCommit,
          observedAt: new Date().toISOString(), state: "fresh" as const, pending: [],
        };
        return latestObservation;
      },
      async listProposals() { return []; },
      async localDurabilityCensus() {
        assert.ok(latestObservation, "the signed preflight must seed the local census");
        if (interleaveNextCensus) {
          interleaveNextCensus = false;
          await lifecycle("queued");
          await lifecycle("running");
          await lifecycle("succeeded");
        }
        const observation = latestObservation;
        const reader = await fixture.store.reader("project-1", "remote", observation.snapshot.remoteCommit);
        return {
          observation, reader, pendingCheckpoints: observation.pending,
          pendingProposals: 0, localWorkspaceDirty: false,
        };
      },
    }) as CoreStore;
    const controlFetch: typeof fetch = async (input) => {
      assert.equal(String(input), HOSTED_ASSIGNMENT.controlServicePolicy.jwksUrl);
      return Response.json({ keys: [RUNTIME_CONTROL_PUBLIC_JWK] });
    };
    const apiServer = await startHostedApi(store, staticDir, hostedTestPolicy(), controlFetch, runtime, resolve(staticDir, "usage"));
    t.after(apiServer.close);

    const preflight = await fetch(`${apiServer.base}${RUNTIME_STATUS_PATH}`, {
      headers: { Authorization: `Bearer ${runtimeControlToken("status", "race-preflight", sha256Digest(""))}` },
    });
    assert.equal(preflight.status, 200);
    assert.equal((await preflight.json() as { persistence: { state: string } }).persistence.state, "verified");
    const remoteCallsAfterPreflight = remoteObservationCalls;

    const request = {
      operationId: "quiesce-activity-race",
      instanceId: HOSTED_ASSIGNMENT.instanceId,
      runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
      reason: "redeploy",
      contractVersion: "scriptorium-platform/v1",
      deadline: new Date(Date.now() + 60_000).toISOString(),
    };
    const body = JSON.stringify(request);
    const quiesceHeaders = {
      Authorization: `Bearer ${runtimeControlToken("quiesce", request.operationId, sha256Digest(body))}`,
      "Content-Type": "application/json",
    };
    const first = await fetch(`${apiServer.base}${RUNTIME_QUIESCE_PATH}`, { method: "POST", headers: quiesceHeaders, body });
    assert.equal(first.status, 200);
    const firstReceipt = await first.json() as { disposition: string; activeJobs: number; reasonCodes: string[] };
    assert.equal(firstReceipt.activeJobs, 0, "the worker has already finished by the time the census returns");
    assert.equal(firstReceipt.disposition, "unknown", "the monotonic activity version detects the completed job");
    assert.ok(firstReceipt.reasonCodes.includes("PERSISTENCE_UNVERIFIED"));
    assert.equal(remoteObservationCalls, remoteCallsAfterPreflight, "the local census must not refetch after the gate closes");

    const stableStatus = await fetch(`${apiServer.base}${RUNTIME_STATUS_PATH}`, {
      headers: { Authorization: `Bearer ${runtimeControlToken("status", "race-stable-status", sha256Digest(""))}` },
    });
    assert.equal(stableStatus.status, 200);
    assert.equal((await stableStatus.json() as { persistence: { state: string } }).persistence.state, "verified");

    const retry = await fetch(`${apiServer.base}${RUNTIME_QUIESCE_PATH}`, { method: "POST", headers: quiesceHeaders, body });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as { disposition: string }).disposition, "safe");
    assert.equal(remoteObservationCalls, remoteCallsAfterPreflight);

    const resumed = await fetch(`${apiServer.base}${RUNTIME_RESUME_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${runtimeControlToken("resume", request.operationId, sha256Digest(body))}`, "Content-Type": "application/json" },
      body,
    });
    assert.equal(resumed.status, 204);
  });

  it("safely quiesces an untouched empty remote using the lifecycle request property order", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-hosted-empty-remote-"));
    tempDirs.push(staticDir);
    const fixture = makeSnapshotStore();
    const emptySnapshot: SnapshotId = { ...SNAPSHOT, remoteCommit: "" };
    let remoteObservationCalls = 0;
    let latestEmptyObservation: Awaited<ReturnType<CoreStore["observe"]>> | undefined;
    const store = Object.assign(fixture.store, {
      async observe() {
        remoteObservationCalls++;
        latestEmptyObservation = { snapshot: emptySnapshot, checkpointHead: "", observedAt: new Date().toISOString(), state: "fresh" as const, pending: [] };
        return latestEmptyObservation;
      },
      async reader(_projectId: string, _view = "remote", pinned?: string) {
        assert.equal(pinned, undefined, "the empty remote is represented by the unpinned reader");
        return {
          snapshot: emptySnapshot,
          async read() { return null; },
          async list(prefix: string) { assert.equal(prefix, "meta/scriptorium"); return []; },
        };
      },
      async registeredRepositoryIdentity() { return SNAPSHOT.repository; },
      async listProposals() { return []; },
      async localDurabilityCensus() {
        assert.ok(latestEmptyObservation, "the signed status preflight seeds an empty-remote observation");
        return {
          observation: latestEmptyObservation,
          reader: {
            snapshot: emptySnapshot,
            async read() { return null; },
            async list(prefix: string) { assert.equal(prefix, "meta/scriptorium"); return []; },
          },
          pendingCheckpoints: [], pendingProposals: 0, localWorkspaceDirty: false,
        };
      },
    }) as CoreStore;
    const controlFetch: typeof fetch = async (input) => {
      assert.equal(String(input), HOSTED_ASSIGNMENT.controlServicePolicy.jwksUrl);
      return Response.json({ keys: [RUNTIME_CONTROL_PUBLIC_JWK] });
    };
    const apiServer = await startHostedApi(store, staticDir, hostedTestPolicy(), controlFetch);
    t.after(apiServer.close);

    const statusToken = runtimeControlToken("status", "empty-status", sha256Digest(""));
    const statusResponse = await fetch(`${apiServer.base}${RUNTIME_STATUS_PATH}`, { headers: { Authorization: `Bearer ${statusToken}` } });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json() as { lastConfirmedRemoteRevision: string | null; persistence: { state: string; observedRemoteCommit: string | null; remoteObservedAt: string | null; formats: unknown[] } };
    assert.equal(status.lastConfirmedRemoteRevision, null);
    assert.equal(status.persistence.state, "verified");
    assert.equal(status.persistence.observedRemoteCommit, null);
    assert.equal(status.persistence.remoteObservedAt, latestEmptyObservation?.observedAt,
      "an empty remote retains the successful observation time from Core");
    assert.ok(Number.isFinite(Date.parse(status.persistence.remoteObservedAt ?? "")));
    const observationsAfterPreflight = remoteObservationCalls;

    // This matches Praetorium ControlHttpClient's insertion order exactly.
    const request = {
      operationId: "empty-quiesce",
      instanceId: HOSTED_ASSIGNMENT.instanceId,
      runtimeEpoch: HOSTED_ASSIGNMENT.runtimeEpoch,
      reason: "redeploy",
      contractVersion: "scriptorium-platform/v1",
      deadline: new Date(Date.now() + 60_000).toISOString(),
    };
    const body = JSON.stringify(request);
    const quiesceToken = runtimeControlToken("quiesce", request.operationId, sha256Digest(body));
    const quiesced = await fetch(`${apiServer.base}${RUNTIME_QUIESCE_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${quiesceToken}`, "Content-Type": "application/json" }, body,
    });
    assert.equal(quiesced.status, 200);
    assert.equal((await quiesced.json() as { disposition: string; lastConfirmedRemoteRevision: string | null }).disposition, "safe");
    assert.equal(remoteObservationCalls, observationsAfterPreflight, "untouched empty remote quiesce must not perform a fresh remote observation");

    const resumeToken = runtimeControlToken("resume", request.operationId, sha256Digest(body));
    const resumed = await fetch(`${apiServer.base}${RUNTIME_RESUME_PATH}`, {
      method: "POST", headers: { Authorization: `Bearer ${resumeToken}`, "Content-Type": "application/json" }, body,
    });
    assert.equal(resumed.status, 204);
  });

  it("keeps health public, protects project data, and serves the app shell", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-"));
    tempDirs.push(staticDir);
    await writeFile(resolve(staticDir, "index.html"), '<meta name="scriptorium-style-nonce" content="__SCRIPTORIUM_STYLE_NONCE__"><h1>Scriptorium</h1>');
    await Promise.all(["main.js", "api.js", "drafts.js", "styles.css"].map((name) => writeFile(resolve(staticDir, name), name)));
    await writeFile(resolve(staticDir, "server.test.js"), "private test file");
    await mkdir(resolve(staticDir, "assets"));
    await writeFile(resolve(staticDir, "assets", "main-a1b2.js"), "compiled lazy chunk");
    await symlink(resolve(staticDir, "server.test.js"), resolve(staticDir, "assets", "leak-a1b2.js"));
    for (const ui of ["desktop", "mobile"]) {
      await mkdir(resolve(staticDir, ui, "assets"), { recursive: true });
      await writeFile(resolve(staticDir, ui, "index.html"), `<meta name="scriptorium-style-nonce" content="__SCRIPTORIUM_STYLE_NONCE__"><h1>${ui}</h1>`);
      await writeFile(resolve(staticDir, ui, "main.js"), `${ui} bundle`);
      await writeFile(resolve(staticDir, ui, "assets", "chunk.js"), `${ui} chunk`);
    }
    const apiServer = await startApi(staticDir);
    t.after(apiServer.close);

    for (const ui of ["desktop", "mobile"]) {
      for (const route of [`/${ui}`, `/${ui}/`, `/${ui}/writing?project=fixture&scene=s1`, `/${ui}/projects/project.1/scenes/scene.1?volume=volume.1&chapter=chapter.1`]) {
        const page = await fetch(`${apiServer.base}${route}`);
        assert.equal(page.status, 200);
        assert.match(await page.text(), new RegExp(`<h1>${ui}</h1>`));
        assert.ok(!page.headers.get("content-security-policy")?.includes("unsafe-inline"));
      }
      assert.equal(await (await fetch(`${apiServer.base}/${ui}/main.js`)).text(), `${ui} bundle`);
      assert.equal(await (await fetch(`${apiServer.base}/${ui}/assets/chunk.js`)).text(), `${ui} chunk`);
      assert.equal((await fetch(`${apiServer.base}/${ui}/assets/missing.js`)).status, 404);
      assert.equal((await fetch(`${apiServer.base}/${ui}/unknown-route`)).status, 404);
      assert.equal((await fetch(`${apiServer.base}/${ui}/server.test.js`)).status, 404);
    }

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
    const publicReader = await fetch(`${apiServer.base}/r/publishing/123/e2e-invalid-token`);
    assert.equal(publicReader.status, 200, "a structurally valid public reader URL must load the SPA before token validation");
    assert.match(publicReader.headers.get("content-type") ?? "", /text\/html/u);
    assert.equal(publicReader.headers.get("referrer-policy"), "no-referrer");
    assert.equal(publicReader.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.match(await publicReader.text(), /Scriptorium/u);
    assert.equal((await fetch(`${apiServer.base}/r/unknown/123/e2e-invalid-token`)).status, 404);
    assert.equal((await fetch(`${apiServer.base}/r/publishing/not-numeric/e2e-invalid-token`)).status, 404);
    assert.equal((await fetch(`${apiServer.base}/r/publishing/123/e2e-invalid-token/extra`)).status, 404);
    const owner = await login(apiServer.base);
    assert.equal((await fetch(`${apiServer.base}/api/no-such-route`, { headers: { Cookie: owner.cookie } })).status, 404,
      "the SPA fallback must not turn missing API routes into index.html");
    for (const name of ["main.js", "api.js", "drafts.js", "styles.css"]) {
      assert.equal((await fetch(`${apiServer.base}/${name}`)).status, 200);
    }
    const chunk = await fetch(`${apiServer.base}/assets/main-a1b2.js`);
    assert.equal(chunk.status, 200);
    assert.match(chunk.headers.get("content-type") ?? "", /javascript/u);
    assert.equal(await (await fetch(`${apiServer.base}/assets/leak-a1b2.js`)).json().then((body: unknown) => (body as { code: string }).code), "NOT_FOUND");
    assert.equal((await fetch(`${apiServer.base}/server.test.js`)).status, 404);
  });

  it("keeps fixed UI aliases fresh while caching only content-hashed JS and CSS", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-static-manifest-"));
    tempDirs.push(staticDir);
    await writeFile(resolve(staticDir, "server.test.js"), "private test file");
    const fixtures = new Map<string, { entry: string; stylesheet: string; scriptBody: string; styleBody: string }>();
    for (const ui of ["launcher", "desktop", "mobile"] as const) {
      const uiRoot = ui === "launcher" ? staticDir : resolve(staticDir, ui);
      const prefix = ui === "launcher" ? "" : `/${ui}`;
      const suffix = ui === "launcher" ? "a1B2c3D4" : ui === "desktop" ? "e5F6g7H8" : "i9J0k1L2";
      const entry = `main-${suffix}.js`;
      const stylesheet = `styles-${suffix}.css`;
      const scriptBody = `${ui} hashed bundle`;
      const styleBody = `${ui} hashed styles`;
      await Promise.all([
        mkdir(resolve(uiRoot, ".vite"), { recursive: true }),
        mkdir(resolve(uiRoot, "assets"), { recursive: true }),
      ]);
      await writeFile(resolve(uiRoot, "index.html"),
        `<meta name="scriptorium-style-nonce" content="__SCRIPTORIUM_STYLE_NONCE__"><link rel="stylesheet" href="${prefix}/assets/${stylesheet}"><script type="module" src="${prefix}/assets/${entry}"></script>`);
      await writeFile(resolve(uiRoot, "main.js"), `${ui} legacy bundle`);
      await writeFile(resolve(uiRoot, "styles.css"), `${ui} legacy styles`);
      await writeFile(resolve(uiRoot, "assets", entry), scriptBody);
      await writeFile(resolve(uiRoot, "assets", stylesheet), styleBody);
      await writeFile(resolve(uiRoot, "assets", "chunk.js"), `${ui} unhashed chunk`);
      await writeFile(resolve(uiRoot, ".vite", "manifest.json"), JSON.stringify({
        "index.html": { file: `assets/${entry}`, src: "index.html", isEntry: true },
        "style.css": { file: `assets/${stylesheet}`, src: "style.css" },
      }));
      fixtures.set(ui, { entry, stylesheet, scriptBody, styleBody });
    }
    await symlink(resolve(staticDir, "server.test.js"), resolve(staticDir, "assets", "leak-LeakHa12.js"));

    const apiServer = await startApi(staticDir);
    t.after(apiServer.close);
    for (const [ui, fixture] of fixtures) {
      const prefix = ui === "launcher" ? "" : `/${ui}`;
      const route = `${prefix}/`;
      const shell = await fetch(`${apiServer.base}${route}`);
      const shellHtml = await shell.text();
      const nonce = /name="scriptorium-style-nonce" content="([^"]+)"/u.exec(shellHtml)?.[1];
      assert.equal(shell.status, 200);
      assert.equal(shell.headers.get("cache-control"), "no-store");
      assert.ok(nonce && nonce !== "__SCRIPTORIUM_STYLE_NONCE__");
      assert.ok(shell.headers.get("content-security-policy")?.includes(`style-src 'self' 'nonce-${nonce}'`));
      assert.ok(shellHtml.includes(`src="${prefix}/assets/${fixture.entry}"`));
      assert.ok(shellHtml.includes(`href="${prefix}/assets/${fixture.stylesheet}"`));
      const nextShell = await fetch(`${apiServer.base}${route}`);
      assert.notEqual(nextShell.headers.get("content-security-policy"), shell.headers.get("content-security-policy"));
      assert.equal(nextShell.headers.get("cache-control"), "no-store");

      const jsAsset = await fetch(`${apiServer.base}${prefix}/assets/${fixture.entry}`);
      assert.equal(jsAsset.status, 200);
      assert.equal(await jsAsset.text(), fixture.scriptBody);
      assert.equal(jsAsset.headers.get("cache-control"), "public, max-age=31536000, immutable");
      const cssAsset = await fetch(`${apiServer.base}${prefix}/assets/${fixture.stylesheet}`);
      assert.equal(cssAsset.status, 200);
      assert.equal(await cssAsset.text(), fixture.styleBody);
      assert.equal(cssAsset.headers.get("cache-control"), "public, max-age=31536000, immutable");

      const jsAlias = await fetch(`${apiServer.base}${prefix}/main.js`);
      assert.equal(await jsAlias.text(), fixture.scriptBody, `${ui} fixed script URL resolves the active manifest`);
      assert.equal(jsAlias.headers.get("cache-control"), "no-store");
      const cssAlias = await fetch(`${apiServer.base}${prefix}/styles.css`);
      assert.equal(await cssAlias.text(), fixture.styleBody, `${ui} fixed stylesheet URL resolves the active manifest`);
      assert.equal(cssAlias.headers.get("cache-control"), "no-store");
      const unhashed = await fetch(`${apiServer.base}${prefix}/assets/chunk.js`);
      assert.equal(unhashed.headers.get("cache-control"), "no-store");
      assert.equal((await fetch(`${apiServer.base}${prefix}/assets/stale-Ab1Cd2Ef.js`)).status, 404);
    }

    const symlinkResponse = await fetch(`${apiServer.base}/assets/leak-LeakHa12.js`);
    assert.equal(symlinkResponse.status, 404);
    assert.equal((await symlinkResponse.json() as { code: string }).code, "NOT_FOUND");
    assert.equal(symlinkResponse.headers.get("cache-control"), "no-store");

    const launcherAssets = resolve(staticDir, "assets");
    const internalAssets = resolve(staticDir, "internal-assets");
    await rename(launcherAssets, internalAssets);
    await symlink(internalAssets, launcherAssets, "dir");
    for (const alias of ["/main.js", "/styles.css"]) {
      const aliasResponse = await fetch(`${apiServer.base}${alias}`);
      assert.equal(aliasResponse.status, 404, `${alias} rejects a manifest target beneath a symlinked assets directory`);
      assert.equal((await aliasResponse.json() as { code: string }).code, "NOT_FOUND");
    }
    await rm(launcherAssets);
    await rename(internalAssets, launcherAssets);

    await writeFile(resolve(staticDir, ".vite", "manifest.json"), JSON.stringify({
      "index.html": { file: "../server.test.js", src: "index.html", isEntry: true },
      "style.css": { file: "../server.test.js", src: "style.css" },
    }));
    const unsafeAlias = await fetch(`${apiServer.base}/main.js`);
    assert.equal(await unsafeAlias.text(), "launcher legacy bundle", "an unsafe manifest path cannot expose a private file");
    assert.equal(unsafeAlias.headers.get("cache-control"), "no-store");

    await writeFile(resolve(staticDir, ".vite", "manifest.json"), JSON.stringify({
      "index.html": { file: "main.js", src: "index.html", isEntry: true },
      "style.css": { file: "styles.css", src: "style.css" },
    }));
    const rollbackAlias = await fetch(`${apiServer.base}/main.js`);
    assert.equal(await rollbackAlias.text(), "launcher legacy bundle", "a legacy manifest remains usable after rollback");
    assert.equal(rollbackAlias.headers.get("cache-control"), "no-store");
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
    const first = usageEvent(SNAPSHOT.repository, "usage-1", "2026-10-17T00:00:00.000Z", {
      cacheHit: true, promptVersion: "rewrite@1", durationMs: 217, queueWaitMs: 18,
    });
    const second = usageEvent(SNAPSHOT.repository, "usage-2", "2026-10-17T00:00:02.000Z", { state: "aborted", errorCode: "request_cancelled" });
    const third = usageEvent(SNAPSHOT.repository, "usage-3", "2026-10-17T00:00:04.000Z");
    await Promise.all([store.append(first), store.append(first), store.append(second), store.append(third)]);

    const pageOne = await store.list(SNAPSHOT.repository, { limit: 2 });
    assert.deepEqual(pageOne.events.map(({ id }) => id), [first.id, second.id]);
    assert.deepEqual(pageOne.events[0], first, "source cache and prompt/timing metadata survive append and list");
    assert.ok(pageOne.nextCursor);
    const pageTwo = await store.list(SNAPSHOT.repository, { limit: 2, cursor: pageOne.nextCursor });
    assert.deepEqual(pageTwo.events.map(({ id }) => id), [third.id]);
    assert.equal(pageTwo.nextCursor, undefined);
    const ranged = await store.list(SNAPSHOT.repository, { from: second.startedAt, to: third.startedAt, limit: 10 });
    assert.deepEqual(ranged.events.map(({ id }) => id), [second.id, third.id]);
    await assert.rejects(store.list(SNAPSHOT.repository, { limit: 1_001 }), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_query_invalid");
    await assert.rejects(store.append({ ...first, outputTokens: 9 }), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_event_id_conflict");
    await assert.rejects(store.append({ ...first, cacheHit: false }), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_event_id_conflict");
    for (const invalid of [
      { cacheHit: "true" },
      { promptVersion: "v1\nprivate prompt" },
      { promptVersion: "v".repeat(129) },
      { durationMs: Number.POSITIVE_INFINITY },
      { durationMs: -1 },
      { durationMs: 86_400_001 },
      { queueWaitMs: Number.NaN },
      { queueWaitMs: -1 },
      { queueWaitMs: 86_400_001 },
    ]) {
      await assert.rejects(store.append({ ...first, id: `invalid-${Object.keys(invalid)[0]}`, ...invalid } as ModelUsageEvent),
        (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_event_invalid");
    }
    await assert.rejects(store.append({
      ...first, prompt: "private prompt", headers: { Authorization: "secret" }, key: "private key", body: "private body",
    } as ModelUsageEvent), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_event_invalid");

    await rm(coreDataDirectory, { recursive: true, force: true });
    await mkdir(coreDataDirectory);
    const reopened = new HistoricalModelUsageStore(usageDirectory);
    assert.deepEqual((await reopened.list(SNAPSHOT.repository, { limit: 10 })).events, [first, second, third],
      "source cache and prompt/timing metadata survive reopening the host-owned store after disposable Core data deletion");

    const alias = resolve(root, "history-alias");
    await symlink(usageDirectory, alias, "dir");
    await assert.rejects(new HistoricalModelUsageStore(alias).list(SNAPSHOT.repository), (error: unknown) => error instanceof HistoricalModelUsageError && error.code === "model_usage_path_invalid");
  });

  it("stores only bounded worker lifecycle metadata and durable completion inbox state", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "scriptorium-api-job-history-"));
    tempDirs.push(root);
    const usageDirectory = resolve(root, "host-history");
    const store = new JobHistoryStore(usageDirectory);
    await assert.rejects(lstat(usageDirectory), (error: NodeJS.ErrnoException) => error.code === "ENOENT", "construction must not touch host history");
    const base = {
      module: "assistant",
      task: "draft.story",
      snapshot: SNAPSHOT,
      createdAt: "2026-10-17T02:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    } satisfies Pick<WorkerJobLifecycle, "module" | "task" | "snapshot" | "createdAt" | "startedAt" | "finishedAt">;
    const queued: WorkerJobLifecycle = { ...base, jobId: "worker-job-1", state: "queued", updatedAt: base.createdAt };
    assert.deepEqual(await store.record(queued), {
      type: "job-status", jobId: "worker-job-1", jobType: "assistant.draft.story", status: "queued", progress: null, at: base.createdAt,
    });
    const running: WorkerJobLifecycle = { ...queued, state: "running", startedAt: "2026-10-17T02:00:01.000Z", updatedAt: "2026-10-17T02:00:01.000Z" };
    await store.record(running);
    const finished: WorkerJobLifecycle = {
      ...running, state: "failed", updatedAt: "2026-10-17T02:00:02.000Z", finishedAt: "2026-10-17T02:00:02.000Z", errorCode: "worker_failed",
    };
    const event = await store.record(finished);
    assert.deepEqual(event, {
      type: "job-status", jobId: "worker-job-1", jobType: "assistant.draft.story", status: "error", progress: null,
      error: "worker_failed", at: "2026-10-17T02:00:02.000Z",
    });
    assert.deepEqual(await store.listJobs(), [{
      id: "worker-job-1", type: "assistant.draft.story", status: "error", progress: null, result: null, error: "worker_failed",
      createdAt: "2026-10-17T02:00:00.000Z", updatedAt: "2026-10-17T02:00:02.000Z", finishedAt: "2026-10-17T02:00:02.000Z",
    }]);
    const inbox = await store.listInbox({ unreadOnly: true });
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.unreadCount, 1);
    assert.equal(inbox.items[0]?.body, "The job failed (worker_failed).");
    assert.equal(inbox.items[0]?.projectKey.includes(SNAPSHOT.repository.repositoryId), false);
    const stateText = await readFile(resolve(usageDirectory, "jobs", "jobs-state.json"), "utf8");
    for (const secret of [SNAPSHOT.repository.url, SNAPSHOT.repository.ownerScope, ACCESS_TOKEN, "prompt-secret", "result-secret", "worker error text"]) {
      assert.equal(stateText.includes(secret), false, `host history must not contain ${secret}`);
    }
    assert.equal(stateText.includes('"progress":null'), true);
    assert.equal(stateText.includes('"result":null'), true);
    assert.equal(stateText.includes('"type":"assistant.draft.story"'), true);
    await assert.rejects(store.record({ ...finished, errorCode: undefined, errorMessage: "worker error text" } as unknown as WorkerJobLifecycle),
      (error: unknown) => error instanceof JobHistoryError && error.code === "job_event_invalid");
    const reloaded = new JobHistoryStore(usageDirectory);
    assert.deepEqual(await reloaded.getJob("worker-job-1"), (await store.getJob("worker-job-1")));
    assert.equal(await reloaded.markAllInboxRead(), 1);
    assert.deepEqual(await new JobHistoryStore(usageDirectory).listInbox({ unreadOnly: true }), { items: [], unreadCount: 0 });
    await assert.rejects(reloaded.record({ ...queued, snapshot: { ...SNAPSHOT, repository: { ...SNAPSHOT.repository, repositoryId: "999" } } }),
      (error: unknown) => error instanceof JobHistoryError && error.code === "job_identity_conflict");
  });

  it("retains exact declared domain action data and machine errors across host-history reopen", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "scriptorium-api-domain-job-history-"));
    tempDirs.push(root);
    const usageDirectory = resolve(root, "history");
    const store = new JobHistoryStore(usageDirectory);
    const success: ActionResult = {
      ok: true, snapshot: SNAPSHOT,
      data: { report: { examples: 3, accuracy: 0.75 }, proposalId: "speaker-proposal-1" },
    };
    const queued = await store.beginDomainJob({ id: "domain-job-success", type: "speaker-eval", repository: SNAPSHOT.repository });
    assert.equal(queued.status, "queued");
    assert.equal(queued.progress, 0);
    const running = await store.markDomainJobRunning("domain-job-success");
    assert.equal(running.status, "running");
    assert.deepEqual(await store.reportDomainJobProgress("domain-job-success", 0.4), {
      type: "job-progress", jobId: "domain-job-success", jobType: "speaker-eval", status: "running", progress: 0.4,
      at: (await store.getJob("domain-job-success"))!.updatedAt,
    });
    const regressed = await store.reportDomainJobProgress("domain-job-success", 0.1);
    assert.equal(regressed?.type, "job-progress", "source progress may report a lower value in a later phase");
    assert.equal(regressed?.progress, 0.1);
    assert.equal(await store.reportDomainJobProgress("domain-job-success", 1.5).then((event) => event?.progress), 1,
      "finite source progress is bounded to the source 0–1 range");
    assert.equal(await store.reportDomainJobProgress("domain-job-success", 1), null, "identical progress may be coalesced");
    await assert.rejects(store.reportDomainJobProgress("domain-job-success", Number.NaN),
      (error: unknown) => error instanceof JobHistoryError && error.code === "job_progress_invalid");
    assert.equal((await store.finishDomainJob("domain-job-success", success)).status, "done");

    const failed: ActionResult = {
      ok: false, snapshot: SNAPSHOT,
      error: { code: "aspect_scope_invalid", message: "The selected chapter has no scenes", retryable: false },
    };
    await store.beginDomainJob({ id: "domain-job-error", type: "aspect-review", repository: SNAPSHOT.repository });
    await store.markDomainJobRunning("domain-job-error");
    assert.equal((await store.finishDomainJob("domain-job-error", failed)).status, "error");

    const reopened = new JobHistoryStore(usageDirectory);
    assert.deepEqual(await reopened.getJob("domain-job-success"), {
      id: "domain-job-success", type: "speaker-eval", status: "done", progress: 1,
      result: success.data, error: null,
      createdAt: (await store.getJob("domain-job-success"))!.createdAt,
      updatedAt: (await store.getJob("domain-job-success"))!.updatedAt,
      finishedAt: (await store.getJob("domain-job-success"))!.finishedAt,
    });
    assert.deepEqual(await reopened.getJob("domain-job-error"), await store.getJob("domain-job-error"));
    const failedJob = await reopened.getJob("domain-job-error");
    assert.equal(failedJob?.error, failed.error.message);
    assert.equal(failedJob?.errorCode, failed.error.code);
    assert.equal(failedJob?.retryable, false);
    await store.beginDomainJob({ id: "domain-job-interrupted", type: "speaker-retrain", repository: SNAPSHOT.repository });
    await store.markDomainJobRunning("domain-job-interrupted");
    await store.reportDomainJobProgress("domain-job-interrupted", 0.42);
    assert.equal((await reopened.listInbox()).unreadCount, 2);
    const afterRestart = new JobHistoryStore(usageDirectory);
    const interrupted = await afterRestart.getJob("domain-job-interrupted");
    assert.equal(interrupted?.status, "error", "an active target task becomes a non-replayed interruption after a store restart");
    assert.equal(interrupted?.errorCode, "worker_interrupted");
    assert.equal(interrupted?.progress, 0.42, "the latest fractional progress survives a host-history restart");
  });

  it("tracks exact source job results through direct actions and nested HTTP MCP invokes", async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "scriptorium-api-domain-job-runtime-"));
    tempDirs.push(root);
    const staticDir = resolve(root, "static");
    await mkdir(staticDir);
    const usageDirectory = resolve(root, "history");
    const domain = sourceDomainJobRuntime(resolve(root, "module-cache"));
    const api = await startCustomApi(makeSnapshotStore().store, staticDir, {
      runtime: domain.runtime,
      usageDirectory,
    });
    const owner = await login(api.base);
    const ownerHeaders = { Cookie: owner.cookie, Origin: api.base, "Content-Type": "application/json" };
    const expectedData = { report: { examples: 3, accuracy: 0.75 }, version: "synthetic-v1" };
    let progressAbort: AbortController | undefined;
    let progressReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let progressEventsTask: Promise<Array<{ type: string; jobId: string; jobType: string; status: string; progress: number; at: string }>> | undefined;
    t.after(async () => {
      domain.releaseAsync();
      progressAbort?.abort();
      await progressReader?.cancel().catch(() => undefined);
      await progressEventsTask?.catch(() => undefined);
      await api.close();
    });
    progressAbort = new AbortController();
    const progressResponse = await fetch(`${api.base}/api/jobs/events`, {
      headers: { Cookie: owner.cookie }, signal: progressAbort.signal,
    });
    assert.equal(progressResponse.status, 200);
    assert.ok(progressResponse.body);
    progressReader = progressResponse.body.getReader();
    progressEventsTask = (async () => {
      const decoder = new TextDecoder();
      const events: Array<{ type: string; jobId: string; jobType: string; status: string; progress: number; at: string }> = [];
      let buffer = "";
      while (events.length < 5) {
        const { value, done } = await progressReader!.read();
        if (done) throw new Error("The owner job event stream closed before all progress events arrived");
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
          if (!data) continue;
          const event = JSON.parse(data) as { type: string; jobId: string; jobType: string; status: string; progress: number; at: string };
          if (event.type === "job-progress") events.push(event);
        }
      }
      return events;
    })();

    const directResponse = await fetch(`${api.base}/api/projects/project-1/actions/speaker.evaluation.run`, {
      method: "POST", headers: ownerHeaders, body: JSON.stringify({ input: { requestSecret: "must-not-be-captured", progress: [0.7] } }),
    });
    assert.equal(directResponse.status, 200);
    const directJobId = directResponse.headers.get("x-scriptorium-job-id");
    assert.ok(directJobId);
    const directResult = await directResponse.json() as ActionResult;
    assert.deepEqual(directResult, { ok: true, snapshot: SNAPSHOT, data: expectedData });
    const directJobResponse = await fetch(`${api.base}/api/jobs/${directJobId}`, { headers: { Cookie: owner.cookie } });
    assert.equal(directJobResponse.status, 200);
    const directJob = await directJobResponse.json() as { status: string; result: unknown };
    assert.equal(directJob.status, "done");
    assert.deepEqual(directJob.result, expectedData);

    const nestedResponse = await fetch(`${api.base}/api/projects/project-1/modules/mcp/invoke`, {
      method: "POST", headers: ownerHeaders, body: JSON.stringify({ nested: true, progress: [0.4, 0.1] }),
    });
    assert.equal(nestedResponse.status, 200);
    const nestedJobId = nestedResponse.headers.get("x-scriptorium-job-id");
    assert.ok(nestedJobId);
    assert.notEqual(nestedJobId, directJobId);
    assert.deepEqual(await nestedResponse.json(), { ok: true, snapshot: SNAPSHOT, data: expectedData });
    const nestedJobResponse = await fetch(`${api.base}/api/jobs/${nestedJobId}`, { headers: { Cookie: owner.cookie } });
    assert.deepEqual((await nestedJobResponse.json() as { result: unknown }).result, expectedData);

    const failedResponse = await fetch(`${api.base}/api/projects/project-1/actions/speaker.evaluation.run`, {
      method: "POST", headers: ownerHeaders, body: JSON.stringify({ input: { fail: true } }),
    });
    assert.equal(failedResponse.status, 200);
    const failedJobId = failedResponse.headers.get("x-scriptorium-job-id");
    assert.ok(failedJobId);
    const failedResult = await failedResponse.json() as Extract<ActionResult, { ok: false }>;
    const failedJobResponse = await fetch(`${api.base}/api/jobs/${failedJobId}`, { headers: { Cookie: owner.cookie } });
    const failedJob = await failedJobResponse.json() as { status: string; result: unknown; error: string; errorCode?: string; retryable?: boolean };
    assert.equal(failedJob.status, "error");
    assert.equal(failedJob.result, null);
    assert.equal(failedJob.error, failedResult.error.message);
    assert.equal(failedJob.errorCode, failedResult.error.code);
    assert.equal(failedJob.retryable, true);

    const asyncResponsePromise = fetch(`${api.base}/api/projects/project-1/actions/speaker.evaluation.run`, {
      method: "POST", headers: { ...ownerHeaders, Prefer: "respond-async" },
      body: JSON.stringify({ input: { wait: true, progress: [0.05, 1.5] } }),
    });
    const asyncResponse = await asyncResponsePromise;
    assert.equal(asyncResponse.status, 202);
    assert.equal(asyncResponse.headers.get("preference-applied"), "respond-async");
    const asyncJobId = asyncResponse.headers.get("x-scriptorium-job-id");
    assert.ok(asyncJobId);
    assert.equal((await asyncResponse.json() as { id: string }).id, asyncJobId);
    await domain.asyncStarted;
    const progressEvents = await progressEventsTask;
    assert.deepEqual(progressEvents.map(({ jobId, progress }) => [jobId, progress]), [
      [directJobId, 0.7], [nestedJobId, 0.4], [nestedJobId, 0.1], [asyncJobId, 0.05], [asyncJobId, 1],
    ], "SSE progress keeps source fractions, phase regressions, clamped values, and exact direct/nested job IDs");
    assert.ok(progressEvents.every(({ type, jobType, status, at }) => type === "job-progress" && jobType === "speaker-eval" && status === "running" && Date.parse(at) > 0));
    progressAbort.abort();
    await progressReader.cancel().catch(() => undefined);
    const runningJobResponse = await fetch(`${api.base}/api/jobs/${asyncJobId}`, { headers: { Cookie: owner.cookie } });
    assert.equal(runningJobResponse.status, 200);
    assert.equal((await runningJobResponse.json() as { status: string }).status, "running");
    domain.releaseAsync();
    const completedAsync = await waitForJob(api.base, owner.cookie, asyncJobId);
    assert.equal(completedAsync.status, "done");
    assert.deepEqual(completedAsync.result, expectedData);

    const reopenedHistory = new JobHistoryStore(usageDirectory);
    const retained = await reopenedHistory.listJobs();
    assert.equal(retained.length, 4, "direct, nested, failed, and async actions each register exactly one host job");
    assert.deepEqual((await reopenedHistory.getJob(directJobId))?.result, expectedData, "the exact action result remains owner-readable after host-history reopen");
    assert.deepEqual((await reopenedHistory.getJob(nestedJobId))?.result, expectedData, "nested MCP results remain owner-readable after host-history reopen");
    const inbox = await new JobHistoryStore(usageDirectory).listInbox();
    assert.equal(inbox.items.length, 1, "unread completion inbox items coalesce by job type and repository");
    assert.equal(inbox.items[0]?.jobId, asyncJobId);
    const historyBytes = await readFile(resolve(usageDirectory, "jobs", "jobs-state.json"), "utf8");
    assert.equal(historyBytes.includes("must-not-be-captured"), false, "action input is not retained as job history");
  });

  it("archives exact legacy jobs outside Core data and exposes only explicitly mapped owner history", async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "scriptorium-api-legacy-jobs-"));
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-legacy-jobs-app-"));
    tempDirs.push(root, staticDir);
    const workspaceDataRoot = resolve(root, "core-data");
    const appState = resolve(workspaceDataRoot, "app-state");
    const usageDirectory = resolve(root, "history");
    await mkdir(appState, { recursive: true, mode: 0o700 });
    const legacyState = {
      jobs: [
        {
          id: "mapped-job", type: "speaker-eval", status: "done", progress: 1,
          result: { report: "explicitly mapped result" }, error: null,
          projectKey: "legacy-project-id", userId: "legacy-owner-id",
          createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:01:00.000Z", finishedAt: "2026-10-16T00:01:00.000Z",
        },
        {
          id: "unmapped-job", type: "zukan-proposal", status: "error", progress: null,
          result: { secretBody: "unmapped result stays private" }, error: "unmapped error stays private",
          projectKey: "unknown-project-id", userId: "unknown-user-id",
          createdAt: "2026-10-16T01:00:00.000Z", updatedAt: "2026-10-16T01:01:00.000Z", finishedAt: "2026-10-16T01:01:00.000Z",
        },
      ],
      inbox: [
        {
          id: "mapped-inbox", kind: "job-complete", jobId: "mapped-job", jobType: "speaker-eval",
          title: "Mapped report", body: "Mapped inbox result body", status: "done", read: false,
          userId: "legacy-owner-id", projectKey: "legacy-project-id", createdAt: "2026-10-16T00:01:00.000Z",
        },
        {
          id: "unmapped-inbox", kind: "job-complete", jobId: "unmapped-job", jobType: "zukan-proposal",
          title: "Unmapped title", body: "unmapped inbox body stays private", status: "error", read: false,
          userId: "unknown-user-id", projectKey: "unknown-project-id", createdAt: "2026-10-16T01:01:00.000Z",
        },
      ],
    };
    const sourcePath = resolve(appState, "jobs-state.json");
    const sourceBytes = Buffer.from(JSON.stringify(legacyState), "utf8");
    await writeFile(sourcePath, sourceBytes, { mode: 0o600 });
    const report = await importLegacyJobHistory({
      workspaceDataRoot,
      usageDirectory,
      legacyRepositoryMappings: { "legacy-project-id": SNAPSHOT.repository },
      legacyUserMappings: { "legacy-owner-id": "owner" },
    });
    assert.equal(report.archived, true);
    assert.equal(report.adoptedJobs, 1);
    assert.equal(report.adoptedInbox, 1);
    assert.deepEqual(report.mappingRequired, [{
      projectKey: "unknown-project-id", userId: "unknown-user-id", jobCount: 1, inboxCount: 1,
    }]);
    assert.equal(JSON.stringify(report).includes("unmapped result stays private"), false);
    const archivePath = resolve(usageDirectory, "jobs", "legacy", `${report.sourceHash}.json`);
    assert.deepEqual(await readFile(archivePath), sourceBytes, "the hash-addressed host archive retains the exact source bytes");
    assert.deepEqual(await readFile(sourcePath), sourceBytes, "migration leaves the source jobs file untouched");
    const retry = await importLegacyJobHistory({
      workspaceDataRoot,
      usageDirectory,
      legacyRepositoryMappings: { "legacy-project-id": SNAPSHOT.repository },
      legacyUserMappings: { "legacy-owner-id": "owner" },
    });
    assert.equal(retry.sourceHash, report.sourceHash);
    assert.equal(retry.adoptedJobs, 0, "a repeated import must not duplicate mapped jobs");
    assert.equal(retry.adoptedInbox, 0, "a repeated import must not duplicate inbox entries");

    await rm(workspaceDataRoot, { recursive: true, force: true });
    const apiServer = await startCustomApi(makeStore(), staticDir, { usageDirectory });
    t.after(apiServer.close);
    const owner = await login(apiServer.base);
    const bearer = { Authorization: `Bearer ${ACCESS_TOKEN}` };
    assert.equal((await fetch(`${apiServer.base}/api/jobs`, { headers: bearer })).status, 403,
      "legacy private history is cookie-owner-only");
    const jobListResponse = await fetch(`${apiServer.base}/api/jobs`, { headers: { Cookie: owner.cookie } });
    assert.equal(jobListResponse.status, 200);
    assert.deepEqual(await jobListResponse.json(), [{
      id: "mapped-job", type: "speaker-eval", status: "done", progress: 1,
      result: { report: "explicitly mapped result" }, error: null,
      createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:01:00.000Z", finishedAt: "2026-10-16T00:01:00.000Z",
    }]);
    const mappedJob = await fetch(`${apiServer.base}/api/jobs/mapped-job`, { headers: { Cookie: owner.cookie } });
    assert.equal(mappedJob.status, 200);
    assert.deepEqual(await mappedJob.json(), {
      id: "mapped-job", type: "speaker-eval", status: "done", progress: 1,
      result: { report: "explicitly mapped result" }, error: null,
      createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:01:00.000Z", finishedAt: "2026-10-16T00:01:00.000Z",
    });
    assert.equal((await fetch(`${apiServer.base}/api/jobs/unmapped-job`, { headers: { Cookie: owner.cookie } })).status, 404);
    const inbox = await fetch(`${apiServer.base}/api/inbox`, { headers: { Cookie: owner.cookie } });
    const inboxBody = await inbox.json() as { items: Array<Record<string, unknown>>; unreadCount: number };
    assert.equal(inboxBody.unreadCount, 1);
    assert.equal(inboxBody.items.length, 1);
    assert.deepEqual(inboxBody.items[0], {
      id: "mapped-inbox", kind: "job-complete", jobId: "mapped-job", jobType: "speaker-eval",
      title: "Mapped report", body: "Mapped inbox result body", status: "done", read: false,
      userId: "owner",
      projectKey: createHash("sha256").update(`github\0${SNAPSHOT.repository.ownerScope}\0${SNAPSHOT.repository.repositoryId}`).digest("hex"),
      createdAt: "2026-10-16T00:01:00.000Z",
    });
    assert.equal(JSON.stringify(inboxBody).includes("unmapped inbox body stays private"), false);
    const markRead = await fetch(`${apiServer.base}/api/inbox/mapped-inbox/read`, {
      method: "POST", headers: { Cookie: owner.cookie, Origin: apiServer.base },
    });
    assert.equal(markRead.status, 200);
    assert.equal(((await markRead.json() as { item: { read: boolean } }).item).read, true);
    const readAll = await fetch(`${apiServer.base}/api/inbox/read-all`, {
      method: "POST", headers: { Cookie: owner.cookie, Origin: apiServer.base },
    });
    assert.deepEqual(await readAll.json(), { marked: 0 });
    assert.equal((await fetch(`${apiServer.base}/api/inbox/unmapped-inbox/read`, {
      method: "POST", headers: { Cookie: owner.cookie, Origin: apiServer.base },
    })).status, 404);
    assert.deepEqual(await readFile(archivePath), sourceBytes, "removing the Core data root cannot remove or mutate the legacy archive");
  });

  it("publishes real supervised worker jobs through owner-only history routes and SSE", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-worker-history-app-"));
    const cacheDirectory = await mkdtemp(resolve(tmpdir(), "scriptorium-api-worker-history-cache-"));
    const usageDirectory = await mkdtemp(resolve(tmpdir(), "scriptorium-api-worker-history-store-"));
    tempDirs.push(staticDir, cacheDirectory, usageDirectory);
    const runtime = jobHistoryRuntime(cacheDirectory);
    const apiServer = await startCustomApi(makeSnapshotStore().store, staticDir, { runtime, usageDirectory });
    t.after(apiServer.close);
    const owner = await login(apiServer.base);
    const streamAbort = new AbortController();
    const stream = await fetch(`${apiServer.base}/api/jobs/events`, { headers: { Cookie: owner.cookie }, signal: streamAbort.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/u);
    assert.ok(stream.body);
    const reader = stream.body.getReader();
    const eventRead = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      const events: Array<{ type: string; jobId: string; status: string }> = [];
      const timeout = setTimeout(() => { void reader.cancel(); }, 15_000);
      try {
        while (!events.some((event) => event.jobId === "real-worker-job" && (event.status === "done" || event.status === "error"))) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
            if (data) events.push(JSON.parse(data) as { type: string; jobId: string; status: string });
          }
        }
      } finally { clearTimeout(timeout); }
      return events;
    })();
    const invocation = await fetch(`${apiServer.base}/api/projects/project-1/actions/speaker.test-worker`, {
      method: "POST",
      headers: { Cookie: owner.cookie, Origin: apiServer.base, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { jobId: "real-worker-job" } }),
    });
    assert.equal(invocation.status, 200);
    const response = await invocation.json() as ActionResult;
    assert.equal(response.ok, true);
    assert.equal(response.ok && (response.data as { ok?: boolean }).ok, true,
      `the actual supervised worker request must succeed: ${JSON.stringify(response)}`);
    const events = await eventRead;
    streamAbort.abort();
    await reader.cancel().catch(() => undefined);
    assert.deepEqual(events.map(({ status }) => status), ["queued", "running", "done"]);
    const jobResponse = await fetch(`${apiServer.base}/api/jobs/real-worker-job`, { headers: { Cookie: owner.cookie } });
    assert.equal(jobResponse.status, 200);
    const job = await jobResponse.json() as { id: string; type: string; status: string; progress: unknown; result: unknown; error: unknown; createdAt: string; updatedAt: string; finishedAt: string };
    assert.deepEqual({ ...job, createdAt: "", updatedAt: "", finishedAt: "" }, {
      id: "real-worker-job", type: "speaker.echo", status: "done", progress: null, result: null, error: null,
      createdAt: "", updatedAt: "", finishedAt: "",
    });
    for (const timestamp of [job.createdAt, job.updatedAt, job.finishedAt]) assert.ok(Date.parse(timestamp) > 0);
    const privateState = await readFile(resolve(usageDirectory, "jobs", "jobs-state.json"), "utf8");
    assert.equal(privateState.includes("worker-input-must-not-enter-owner-history"), false);
    assert.equal(privateState.includes("worker-input"), false);
    assert.equal((await fetch(`${apiServer.base}/api/jobs/real-worker-job`, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } })).status, 403);
    const inboxResponse = await fetch(`${apiServer.base}/api/inbox`, { headers: { Cookie: owner.cookie } });
    assert.equal((await inboxResponse.json() as { unreadCount: number }).unreadCount, 1);
  });

  it("propagates a disconnected owner action to a real running worker and records cancellation", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-worker-cancel-app-"));
    const cacheDirectory = await mkdtemp(resolve(tmpdir(), "scriptorium-api-worker-cancel-cache-"));
    const usageDirectory = await mkdtemp(resolve(tmpdir(), "scriptorium-api-worker-cancel-store-"));
    tempDirs.push(staticDir, cacheDirectory, usageDirectory);
    const apiServer = await startCustomApi(makeSnapshotStore().store, staticDir, {
      runtime: jobHistoryRuntime(cacheDirectory), usageDirectory,
    });
    t.after(apiServer.close);
    const owner = await login(apiServer.base);
    const streamAbort = new AbortController();
    const stream = await fetch(`${apiServer.base}/api/jobs/events`, { headers: { Cookie: owner.cookie }, signal: streamAbort.signal });
    assert.equal(stream.status, 200);
    assert.ok(stream.body);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const events: Array<{ jobId: string; status: string; error?: string }> = [];
    let buffer = "";
    const nextEvent = async (): Promise<{ jobId: string; status: string; error?: string }> => {
      while (events.length === 0) {
        const { done, value } = await reader.read();
        if (done) throw new Error("The job event stream closed before publishing a worker event");
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
          if (data) events.push(JSON.parse(data) as { jobId: string; status: string; error?: string });
        }
      }
      return events.shift()!;
    };
    const readNextEvent = async (): Promise<{ jobId: string; status: string; error?: string }> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          nextEvent(),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Timed out waiting for a worker event")), 5_000); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    };
    const actionAbort = new AbortController();
    const request = fetch(`${apiServer.base}/api/projects/project-1/actions/speaker.test-worker`, {
      method: "POST",
      headers: { Cookie: owner.cookie, Origin: apiServer.base, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { jobId: "cancelled-worker-job", task: "hold" } }),
      signal: actionAbort.signal,
    }).catch((error: unknown) => error);
    let event = await readNextEvent();
    while (!(event.jobId === "cancelled-worker-job" && event.status === "running")) event = await readNextEvent();
    actionAbort.abort();
    let terminal = await readNextEvent();
    while (!(terminal.jobId === "cancelled-worker-job" && terminal.status === "error")) terminal = await readNextEvent();
    assert.equal(terminal.error, "job_cancelled");
    assert.ok(await request instanceof Error, "the client request should be cancelled while its worker is running");
    streamAbort.abort();
    await reader.cancel().catch(() => undefined);
    const statusResponse = await fetch(`${apiServer.base}/api/jobs/cancelled-worker-job`, { headers: { Cookie: owner.cookie } });
    assert.equal(statusResponse.status, 200);
    const job = await statusResponse.json() as { status: string; error: string };
    assert.equal(job.status, "error");
    assert.equal(job.error, "job_cancelled");
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
    const event = usageEvent(identity, "host-usage-1", "2026-10-17T01:00:00.000Z", {
      cacheHit: true, promptVersion: "assistant-story-v2", durationMs: 1_842, queueWaitMs: 73,
    });
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

  it("serves immutable runtime metadata publicly in standalone mode", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-metadata-"));
    tempDirs.push(staticDir);
    const previousRevision = process.env.SCRIPTORIUM_PRODUCER_REVISION;
    process.env.SCRIPTORIUM_PRODUCER_REVISION = "a".repeat(40);
    const apiServer = await startCustomApi(makeStore(), staticDir);
    t.after(async () => {
      await apiServer.close();
      if (previousRevision === undefined) delete process.env.SCRIPTORIUM_PRODUCER_REVISION;
      else process.env.SCRIPTORIUM_PRODUCER_REVISION = previousRevision;
    });
    const response = await fetch(`${apiServer.base}/api/platform/v1/metadata`);
    assert.equal(response.status, 200);
    const metadata = await response.json() as {
      contractVersion: string; producerRevision: string; listener: { port: number };
      paths: { metadata: string; shutdown: string; status: string; quiesce: string; resume: string };
    };
    assert.equal(metadata.producerRevision, "a".repeat(40));
    assert.ok(metadata.listener.port > 0 && metadata.listener.port <= 65_535);
    assert.deepEqual(metadata.paths, {
      liveness: "/health/live", readiness: "/health/ready", metadata: "/api/platform/v1/metadata",
      shutdown: "/api/platform/v1/quiesce", status: "/api/platform/v1/status",
      quiesce: "/api/platform/v1/quiesce", resume: "/api/platform/v1/resume",
    });
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
    const detailBody = await detail.json() as { project: { id: string; url: string; branch: string }; observation: { snapshot: SnapshotId; state: string } };
    assert.equal(detail.status, 200);
    assert.deepEqual(detailBody.project, { id: "project-1", url: "https://github.com/owner/work.git", branch: "main" });
    assert.equal(detailBody.observation.snapshot.remoteCommit, SNAPSHOT.remoteCommit);
    assert.equal(detailBody.observation.state, "unknown", "project opening uses local observation");
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
    const paired = await fetch(`${apiServer.base}/api/projects/project-1/scenes/scene-one/views?snapshot=${SNAPSHOT.remoteCommit}`, { headers: auth });
    assert.equal(paired.status, 200);
    const pairedBody = await paired.json() as { remote: { snapshot: SnapshotId }; effective: { snapshot: SnapshotId } };
    assert.equal(pairedBody.remote.snapshot.remoteCommit, SNAPSHOT.remoteCommit);
    assert.equal(pairedBody.effective.snapshot.remoteCommit, SNAPSHOT.remoteCommit);
    assert.deepEqual(fixture.snapshotReads.at(-1), { kind: "views", pinned: SNAPSHOT.remoteCommit });
    const missingPairPin = await fetch(`${apiServer.base}/api/projects/project-1/scenes/scene-one/views`, { headers: auth });
    assert.equal(missingPairPin.status, 400);
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

    const overlay = { ...SNAPSHOT, overlayCommit: "c".repeat(40) };
    const resolveResponse = await fetch(`${apiServer.base}/api/projects/project-1/actions/core.document.resolve`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { path: "manuscript/ms-one/scene-one.md" }, snapshot: overlay }),
    });
    assert.deepEqual(await resolveResponse.json(), { ok: true, snapshot: overlay, data: { sceneId: "scene-one" } });
    const unsafeResolve = await fetch(`${apiServer.base}/api/projects/project-1/actions/core.document.resolve`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ input: { path: "../secret" }, snapshot: overlay }),
    });
    assert.equal((await unsafeResolve.json() as { error: { code: string } }).error.code, "invalid_action_input");
    const invalidSnapshot = await fetch(`${apiServer.base}/api/projects/project-1/actions/core.document.resolve`, {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ input: { path: "manuscript/x.md" }, snapshot: { remoteCommit: "invalid" } }),
    });
    assert.equal(invalidSnapshot.status, 400);
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


  it("keeps a strict Core proposal after an owner request is aborted following its durable write", async (t) => {
    const { root, remote } = await makeBareRemote();
    tempDirs.push(root);
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-aborted-proposal-"));
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
    const project = await registration.json() as { id: string };
    const snapshot = (await store.observe(project.id)).snapshot;
    const operation: ChangeOperation = {
      id: "aborted_response_operation", generation: 1, repository: snapshot.repository,
      baseRemoteCommit: snapshot.remoteCommit, effect: "metadata", reads: [],
      writes: [{ path: "meta/scriptorium/modules/publishing/aborted-response.md", revision: null, content: "Pending author decision.\n" }],
      message: "proposal retained across lost response",
    };
    const proposal: ChangeProposal = {
      id: "aborted_response_proposal", snapshot, operations: [operation], source: "author",
    };

    let acknowledgeStored!: () => void;
    const stored = new Promise<void>((resolve) => { acknowledgeStored = resolve; });
    let releaseResponse!: () => void;
    const resume = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const originalPropose = store.propose.bind(store);
    store.propose = async (projectId, input) => {
      const durableProposal = await originalPropose(projectId, input);
      acknowledgeStored();
      await resume; // Simulate a lost response after the disk write, not an unprocessed request.
      return durableProposal;
    };
    const abort = new AbortController();
    const pending = fetch(`${apiServer.base}/api/projects/${project.id}/proposals`, {
      method: "POST", headers, body: JSON.stringify(proposal), signal: abort.signal,
    });
    try {
      await stored;
      abort.abort();
      await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
    } finally {
      releaseResponse();
    }

    const recovered = await store.getProposal(project.id, proposal.id);
    assert.deepEqual(recovered?.proposal, proposal);
    const localJournal = JSON.parse(await readFile(resolve(dataDir, "proposal-journal", `${project.id}.json`), "utf8")) as {
      proposals: ChangeProposal[];
    };
    assert.deepEqual(localJournal.proposals, [proposal], "the server persists unaccepted proposals without HTTP acknowledgment");
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

    const httpCompute = await fetch(`${apiServer.base}/api/projects/project-1/modules/mcp/compute`, {
      method: "POST", headers: bearer, body: JSON.stringify({ operation: { id: "must-not-propose" } }),
    });
    assert.equal(httpCompute.status, 200);
    const httpComputeResult = await httpCompute.json() as {
      document: string | null;
      nested: ActionResult<{ nested: ActionResult }>;
      proposalCode: string | null;
    };
    assert.equal(httpComputeResult.document, "---\nid: scene-one\n---\n\nA harbor at night.\n", "bearer compute contributions receive the selected snapshot reader");
    assert.equal(httpComputeResult.nested.ok, true);
    assert.equal(httpComputeResult.nested.ok && httpComputeResult.nested.data.nested.ok, false);
    assert.equal(httpComputeResult.nested.ok && !httpComputeResult.nested.data.nested.ok && httpComputeResult.nested.data.nested.error.code, "action_effect_denied");
    assert.equal(httpComputeResult.proposalCode, "action_effect_denied", "HTTP compute may not use the host proposal capability");
    assert.equal(fixture.proposed.length, 0, "bearer HTTP compute must not reach the proposal coordinator");

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

  it("passes a large canonical base64 attachment through the bounded validator unchanged", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-large-scratch-"));
    tempDirs.push(staticDir);
    const fixture = makeSnapshotStore();
    const apiServer = await startCustomApi(fixture.store, staticDir);
    t.after(apiServer.close);
    const owner = await login(apiServer.base);
    const raw = Buffer.alloc(6 * 1024 * 1024 + 2, 0x5a);
    const dataBase64 = raw.toString("base64");
    assert.ok(dataBase64.endsWith("=") && !dataBase64.endsWith("=="), "large one-byte-padding input exercises canonical final-group validation");
    const response = await fetch(`${apiServer.base}/api/projects/project-1/scratch`, {
      method: "POST", headers: { Cookie: owner.cookie, "Content-Type": "application/json", Origin: apiServer.base },
      body: JSON.stringify({ text: "Large canonical attachment", attachments: [{ filename: "large.bin", mimeType: "application/octet-stream", dataBase64 }] }),
    });
    assert.equal(response.status, 201);
    await response.arrayBuffer();
    const attachment = fixture.proposed[0]?.operations[0]?.writes.find((write) => write.encoding === "base64");
    assert.ok(attachment);
    assert.equal(attachment.content, dataBase64);
    assert.equal(createHash("sha256").update(Buffer.from(attachment.content ?? "", "base64")).digest("hex"),
      createHash("sha256").update(raw).digest("hex"));
    assert.equal(fixture.approvals.length, 1);
  });

  it("rejects malformed large base64 attachments before calling Core", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-invalid-large-scratch-"));
    tempDirs.push(staticDir);
    const fixture = makeSnapshotStore();
    const apiServer = await startCustomApi(fixture.store, staticDir);
    t.after(apiServer.close);
    const owner = await login(apiServer.base);
    const dataBase64 = Buffer.alloc(6 * 1024 * 1024, 0x5a).toString("base64");
    const malformedEncodings = [
      `${dataBase64.slice(0, -1)}!`,
      "AB==", // nonzero unused pad bits
      "AA=A", // padding before the end
      "AAA", // missing canonical padding
    ];
    for (const malformedBase64 of malformedEncodings) {
      const response = await fetch(`${apiServer.base}/api/projects/project-1/scratch`, {
        method: "POST", headers: { Cookie: owner.cookie, "Content-Type": "application/json", Origin: apiServer.base },
        body: JSON.stringify({ text: "Malformed attachment", attachments: [{ filename: "large.bin", mimeType: "application/octet-stream", dataBase64: malformedBase64 }] }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { code?: string }).code, "INVALID_SCRATCH_ATTACHMENT");
    }
    assert.equal(fixture.proposed.length, 0);
    assert.equal(fixture.approvals.length, 0);
  });

  it("rejects an attachment one byte over the raw cap before calling Core", async (t) => {
    const staticDir = await mkdtemp(resolve(tmpdir(), "scriptorium-api-oversize-scratch-"));
    tempDirs.push(staticDir);
    const fixture = makeSnapshotStore();
    const apiServer = await startCustomApi(fixture.store, staticDir);
    t.after(apiServer.close);
    const owner = await login(apiServer.base);
    const dataBase64 = Buffer.alloc(8 * 1024 * 1024 + 1, 0x5a).toString("base64");
    const requestBody = JSON.stringify({ text: "Over the raw attachment cap", attachments: [{ filename: "large.bin", mimeType: "application/octet-stream", dataBase64 }] });
    assert.ok(Buffer.byteLength(requestBody) < 12 * 1024 * 1024, "the request remains within the existing JSON parser cap");
    const response = await fetch(`${apiServer.base}/api/projects/project-1/scratch`, {
      method: "POST", headers: { Cookie: owner.cookie, "Content-Type": "application/json", Origin: apiServer.base }, body: requestBody,
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json() as { code?: string }).code, "SCRATCH_ATTACHMENT_TOO_LARGE");
    assert.equal(fixture.proposed.length, 0);
    assert.equal(fixture.approvals.length, 0);
  });

  it("stores project recent activity for cookie owners across API restarts and rejects bearer or cross-origin writes", async (t) => {
    const root = await mkdtemp(resolve(tmpdir(), "scriptorium-api-recent-activity-"));
    const staticDir = resolve(root, "static");
    const usageDirectory = resolve(root, "host-history");
    await mkdir(staticDir);
    tempDirs.push(root);
    const fixture = makeSnapshotStore();
    let observeCalls = 0;
    const identityLookups: string[] = [];
    const apiStore = Object.assign(fixture.store, {
      async registeredRepositoryIdentity(projectId: string) {
        identityLookups.push(projectId);
        if (projectId === "legacy-project") throw { status: 409, code: "repository_identity_unavailable", message: "Registered repository identity is unavailable" };
        if (projectId === "unknown-project") throw { status: 404, code: "project_not_found", message: "Project not found" };
        return SNAPSHOT.repository;
      },
      async observe() {
        observeCalls += 1;
        throw new Error("simulated unavailable remote observation");
      },
    });
    let apiServer = await startCustomApi(apiStore, staticDir, { usageDirectory });
    t.after(() => apiServer.close().catch(() => undefined));
    let owner = await login(apiServer.base);
    const ownerJson = { Cookie: owner.cookie, Origin: apiServer.base, "Content-Type": "application/json" };

    const empty = await fetch(`${apiServer.base}/api/projects/project-1/recent-activity`, { headers: { Cookie: owner.cookie } });
    assert.deepEqual(await empty.json(), { items: [] });
    assert.equal(observeCalls, 0, "cursor reads use the registered identity without triggering remote observation");
    const desktopFirst = await fetch(`${apiServer.base}/api/projects/project-1/recent-activity`, {
      method: "PUT", headers: ownerJson,
      body: JSON.stringify({ sceneId: "scene-one", sentenceOffset: 3, pageIndex: 7, deviceType: "desktop" }),
    });
    assert.equal(desktopFirst.status, 200);
    const desktopFirstBody = await desktopFirst.json() as { items: Array<{ pageIndex: number | null; deviceType: string }> };
    assert.equal(desktopFirstBody.items[0]?.pageIndex, 7);

    const desktopUpdate = await fetch(`${apiServer.base}/api/projects/project-1/recent-activity`, {
      method: "PUT", headers: ownerJson,
      body: JSON.stringify({ sceneId: "scene-two", sentenceOffset: null, deviceType: "desktop" }),
    });
    const desktopUpdateBody = await desktopUpdate.json() as { items: Array<{ pageIndex: number | null; deviceType: string }> };
    assert.equal(desktopUpdateBody.items.find((item) => item.deviceType === "desktop")?.pageIndex, 7);
    const mobileUpdate = await fetch(`${apiServer.base}/api/projects/project-1/recent-activity`, {
      method: "PUT", headers: ownerJson,
      body: JSON.stringify({ sceneId: "scene-mobile", sentenceOffset: 1, pageIndex: null, deviceType: "mobile" }),
    });
    assert.equal((await mobileUpdate.json() as { items: unknown[] }).items.length, 2);

    const bearerRead = await fetch(`${apiServer.base}/api/projects/project-1/recent-activity`, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    assert.equal(bearerRead.status, 403, "recent activity is owner-cookie state, not bearer project data");
    const crossOriginWrite = await fetch(`${apiServer.base}/api/projects/project-1/recent-activity`, {
      method: "PUT", headers: { ...ownerJson, Origin: "https://foreign.example" },
      body: JSON.stringify({ sceneId: "foreign", sentenceOffset: 0, deviceType: "mobile" }),
    });
    assert.equal(crossOriginWrite.status, 403);
    const malformed = await fetch(`${apiServer.base}/api/projects/project-1/recent-activity`, {
      method: "PUT", headers: ownerJson,
      body: JSON.stringify({ sceneId: "scene-one", sentenceOffset: 0.5, deviceType: "desktop" }),
    });
    assert.equal(malformed.status, 400);
    assert.equal(observeCalls, 0, "cursor writes do not depend on remote availability");
    assert.deepEqual(identityLookups, ["project-1", "project-1", "project-1", "project-1", "project-1"]);
    const legacyIdentity = await fetch(`${apiServer.base}/api/projects/legacy-project/recent-activity`, { headers: { Cookie: owner.cookie } });
    assert.equal(legacyIdentity.status, 409);
    assert.equal((await legacyIdentity.json() as { code: string }).code, "repository_identity_unavailable");
    const unknownProject = await fetch(`${apiServer.base}/api/projects/unknown-project/recent-activity`, { headers: { Cookie: owner.cookie } });
    assert.equal(unknownProject.status, 404);
    assert.equal((await unknownProject.json() as { code: string }).code, "project_not_found");
    assert.deepEqual(identityLookups.slice(-2), ["legacy-project", "unknown-project"]);

    await apiServer.close();
    apiServer = await startCustomApi(apiStore, staticDir, { usageDirectory });
    owner = await login(apiServer.base);
    observeCalls = 0;
    const afterRestart = await fetch(`${apiServer.base}/api/projects/project-1/recent-activity`, { headers: { Cookie: owner.cookie } });
    const restored = await afterRestart.json() as { items: Array<{ sceneId: string; pageIndex: number | null; deviceType: string }> };
    assert.equal(restored.items.length, 2);
    assert.equal(restored.items.find((item) => item.deviceType === "desktop")?.sceneId, "scene-two");
    assert.equal(restored.items.find((item) => item.deviceType === "desktop")?.pageIndex, 7);
    assert.equal(restored.items.find((item) => item.deviceType === "mobile")?.sceneId, "scene-mobile");
    assert.equal(observeCalls, 0, "persisted cursors remain available while remote observation is unavailable after restart");
  });
});


for (const status of [502, 503] as const) {
  for (const phase of ["read", "write"] as const) {
    it(`audit Hosted ${phase} dependency HTTP ${status} is not authentication denial`, async () => {
      const directory = await mkdtemp(resolve(tmpdir(), "scriptorium-auth-outage-"));
      const normal = hostedTestPolicy();
      const policy: HostedAuthorizationPolicy = {
        ...normal,
        async authenticate(token, permission = "read") {
          if (permission === phase) throw Object.assign(new Error("private upstream detail"), { status });
          return normal.authenticate(token, permission);
        },
      };
      const apiServer = await startHostedApi(makeStore(), directory, policy, undefined, undefined, resolve(directory, "history"));
      try {
        const response = await fetch(`${apiServer.base}${phase === "read" ? "/api/session" : "/api/inbox/read-all"}`, {
          method: phase === "read" ? "GET" : "POST", headers: { Authorization: "Bearer write-grant" },
        });
        assert.equal(response.status, status);
        assert.equal(response.headers.has("www-authenticate"), false);
        const body = await response.json() as { code: string; error: string };
        assert.equal(body.code, "AUTHORIZATION_UNAVAILABLE");
        assert.ok(!body.error.includes("private"));
      } finally {
        await apiServer.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
