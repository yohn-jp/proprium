import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  MODEL_USAGE_CAPABILITY,
  type ActionResult,
  type BrowserEditorDocument,
  type ChangeOperation,
  type ChangeProposal,
  type ModelUsageEvent,
  type ModelUsageStore,
  type ModuleActionContext,
  type ModuleContext,
  type SnapshotId,
} from "@scriptorium/contracts";
import { createAssistantActions } from "./actions.js";
import { createModule } from "./index.js";

const repository = {
  provider: "local" as const,
  repositoryId: "assistant-actions-test",
  defaultBranch: "main",
  ownerScope: "assistant-test-owner",
  url: "file:///assistant-actions-test",
};
const snapshot: SnapshotId = { repository, remoteCommit: "c".repeat(40) };
const assistantSettingsPath = "meta/scriptorium/modules/assistant/model-settings.json";
const usagePath = "meta/scriptorium/modules/assistant/usage.jsonl";
const revision = "a".repeat(64);

function reader(files: Record<string, string> = {}) {
  return {
    snapshot,
    async read(filePath: string) {
      const content = files[filePath];
      return content === undefined ? null : { content, revision };
    },
    async list(prefix: string) { return Object.keys(files).filter((filePath) => filePath.startsWith(prefix)).sort(); },
  };
}

function context(options: {
  files?: Record<string, string>;
  invoke?: (actionId: string, input: unknown) => Promise<ActionResult>;
  onPropose?: (operations: ChangeOperation[]) => void;
  onProgress?: (progress: number) => void;
} = {}): ModuleActionContext {
  const selectedReader = reader(options.files);
  const controller = new AbortController();
  return {
    projectId: "assistant-actions-test",
    reader: selectedReader,
    async invoke(actionId, input) {
      if (options.invoke) return options.invoke(actionId, input);
      return { ok: false, snapshot, error: { code: "not_available", message: `Unexpected action ${actionId}`, retryable: false } };
    },
    async listActions() { return []; },
    async linkedReader() { return selectedReader; },
    signal: controller.signal,
    async reportProgress(progress) { options.onProgress?.(progress); },
    async propose(operations, proposalEvidence, proposalId) {
      options.onPropose?.(operations);
      return {
        id: proposalId ?? "proposal-test",
        snapshot,
        operations,
        source: "module",
        ...(proposalEvidence ? { evidence: proposalEvidence } : {}),
      } satisfies ChangeProposal;
    },
    async runJob(request) {
      return { ok: false, id: request.id, snapshot, error: { code: "unused", message: "No jobs are expected", retryable: false } };
    },
  };
}

function moduleContext(store?: ModelUsageStore, onAcquire?: (id: string) => void): ModuleContext {
  const controller = new AbortController();
  return {
    cacheDirectory: "/tmp/assistant-actions-test-cache",
    signal: controller.signal,
    async acquireCapability<T>(id: string) {
      onAcquire?.(id);
      if (!store || id !== MODEL_USAGE_CAPABILITY) throw new Error("capability unavailable");
      return { value: store as T, async release() {} };
    },
    async createWorkerService() { throw new Error("Assistant must not create workers"); },
  };
}

function getAction(module: ReturnType<typeof createAssistantActions>, id: string) {
  const found = module.find((item) => item.id === id);
  assert.ok(found, `missing action ${id}`);
  return found;
}

test("module activation and provider health stay idle without provider or capabilities", async () => {
  const previous = process.env.ARCADIA_LLM_PROVIDER;
  process.env.ARCADIA_LLM_PROVIDER = "none";
  let capabilityAcquisitions = 0;
  try {
    const definition = await createModule(moduleContext(undefined, () => { capabilityAcquisitions += 1; }));
    const result = await getAction(definition.actions, "assistant.health").invoke({}, context());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.data, { available: false, providerKind: "none", configuredModel: null, locality: "optional-external" });
    assert.equal(capabilityAcquisitions, 0);
    assert.deepEqual(
      definition.http?.map(({ path, effect }) => ({ path, effect })).sort((a, b) => a.path.localeCompare(b.path)),
      [
        { path: "qa/stream", effect: "compute" },
        { path: "rewrite/stream", effect: "compute" },
      ],
      "model streams are compute-only; the separate rewrite proposal action retains author review",
    );
    assert.equal(getAction(definition.actions, "assistant.rewrite.propose").effect, "propose");
    await definition.dispose();
  } finally {
    if (previous === undefined) delete process.env.ARCADIA_LLM_PROVIDER;
    else process.env.ARCADIA_LLM_PROVIDER = previous;
  }
});

test("default-denied external consent stops generation before usage lease or provider setup", async () => {
  let capabilityAcquisitions = 0;
  const module = createAssistantActions(moduleContext(undefined, () => { capabilityAcquisitions += 1; }));
  const action = getAction(module, "assistant.synonyms.suggestions");
  const actionContext = context({
    async invoke(actionId) {
      assert.equal(actionId, "nlp.features");
      return { ok: true, snapshot, data: { features: [{ id: "rewrite", locality: "external", enabled: false }] } };
    },
  });

  const result = await action.invoke({ suggestions: [{ original: "夜明け", sentence: "夜明けが見える。" }] }, actionContext);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "assistant_privacy_denied");
  assert.equal(capabilityAcquisitions, 0);
});

test("provider NONE keeps source-grounded local rewrite context available and reports typed unavailability", async () => {
  const previous = process.env.ARCADIA_LLM_PROVIDER;
  process.env.ARCADIA_LLM_PROVIDER = "none";
  let capabilityAcquisitions = 0;
  const scenePath = "plot/volumes/vol-main/chapters/ch-none/scenes/sc-none.yaml";
  const manuscriptPath = "manuscript/vol-main/ch-none/sc-none.md";
  const action = getAction(createAssistantActions(moduleContext(undefined, () => { capabilityAcquisitions += 1; })), "assistant.rewrite");
  try {
    const result = await action.invoke({ sceneId: "sc-none", sentenceIndex: 0 }, context({
      files: {
        "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntype: volume\nname: Main\norder: 1\n",
        "plot/volumes/vol-main/chapters/ch-none/chapter.yaml": "id: ch-none\ntype: chapter\nname: None\nvolume: vol-main\norder: 1\n",
        [scenePath]: `id: sc-none\ntype: scene\nchapter: ch-none\norder: 1\nmanuscript: ${manuscriptPath}\n`,
        [manuscriptPath]: "彼は夜の駅を歩いた。",
      },
      async invoke(actionId) {
        if (actionId === "nlp.features") return { ok: true, snapshot, data: { features: [{ id: "rewrite", locality: "external", enabled: true }] } };
        if (actionId === "semantic.search") return { ok: true, snapshot, data: { results: [] } };
        assert.fail(`unexpected action ${actionId}`);
      },
    }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "assistant_provider_unavailable");
    assert.equal(capabilityAcquisitions, 0, "provider NONE does not lease usage storage or initialize a provider client");
  } finally {
    if (previous === undefined) delete process.env.ARCADIA_LLM_PROVIDER;
    else process.env.ARCADIA_LLM_PROVIDER = previous;
  }
});

test("speaker attribution uses the explicitly selected live editor text and preserves its separate remote base", async () => {
  let requestPrompt = "";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requestPrompt = JSON.stringify(body.messages ?? body);
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      const content = JSON.stringify({ attributions: [{ sentenceIndex: 1, speakerEntityId: "char-live", rationale: "口調が一致" }] });
      const chunk = {
        id: "chatcmpl-live-speaker", object: "chat.completion.chunk", created: 1, model: "synthetic-local",
        choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
      };
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const envNames = ["ARCADIA_LLM_PROVIDER", "ARCADIA_LLM_MODEL", "ARCADIA_LLM_BASE_URL", "ARCADIA_LLM_API_KEY", "CF_AIG_TOKEN", "CF_AIG_BYOK_ALIAS"] as const;
  const previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  process.env.ARCADIA_LLM_PROVIDER = "openai-compatible";
  process.env.ARCADIA_LLM_MODEL = "synthetic-local";
  process.env.ARCADIA_LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.ARCADIA_LLM_API_KEY = "local-test-placeholder";
  delete process.env.CF_AIG_TOKEN;
  delete process.env.CF_AIG_BYOK_ALIAS;
  const scenePath = "plot/volumes/vol-main/chapters/ch-live/scenes/sc-live.yaml";
  const manuscriptPath = "manuscript/vol-main/ch-live/sc-live.md";
  const files = {
    "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntype: volume\nname: Main\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-live/chapter.yaml": "id: ch-live\ntype: chapter\nname: Live editor\nvolume: vol-main\norder: 1\n",
    [scenePath]: `id: sc-live\ntype: scene\nchapter: ch-live\norder: 1\nappears: [char-live]\nmanuscript: ${manuscriptPath}\n`,
    "bible/characters/char-live/profile.yaml": "id: char-live\ntype: character\nname: Live speaker\nvoice:\n  tone: calm\n",
    [manuscriptPath]: "「保存済みの台詞。」と彼女が言った。",
  };
  const editorSnapshot: SnapshotId = { repository, remoteCommit: "c".repeat(40), overlayCommit: "d".repeat(40) };
  const editorDraft: BrowserEditorDocument = {
    sceneId: "sc-live", documentPath: manuscriptPath, documentRevision: "editor-document-rev-7",
    sceneRevision: "editor-scene-rev-11", text: "「編集中の新しい台詞。」と彼女が言った。",
    snapshot: editorSnapshot, baseSnapshot: snapshot, baseSceneRevision: revision,
  };
  const usageStore: ModelUsageStore = { async append() {}, async list() { return { events: [] }; } };
  try {
    const module = createAssistantActions(moduleContext(usageStore));
    const attribution = getAction(module, "assistant.speaker.attribute");
    const malformedDrafts: unknown[] = [
      { ...editorDraft, snapshot: { repository: {}, remoteCommit: snapshot.remoteCommit } },
      { ...editorDraft, snapshot: { ...editorSnapshot, overlayCommit: "not-a-git-object-id" } },
    ];
    for (const invalidDraft of malformedDrafts) {
      const invalidResult = await attribution.invoke({ sceneId: "sc-live", editorDraft: invalidDraft }, context({
        files,
        async invoke() { assert.fail("malformed editor identities must be rejected before consent/provider access"); },
      }));
      assert.equal(invalidResult.ok, false);
      if (!invalidResult.ok) assert.equal(invalidResult.error.code, "invalid_input");
    }
    const foreignView = await attribution.invoke({
      sceneId: "sc-live",
      editorDraft: {
        ...editorDraft,
        snapshot: { ...editorSnapshot, repository: { ...repository, repositoryId: "another-repository" } },
      },
    }, context({
      files,
      async invoke() { assert.fail("editor snapshot from another repository must be rejected before consent/provider access"); },
    }));
    assert.equal(foreignView.ok, false);
    if (!foreignView.ok) assert.equal(foreignView.error.code, "assistant_editor_draft_stale");
    const staleResult = await attribution.invoke({ sceneId: "sc-live", editorDraft: { ...editorDraft, baseSceneRevision: "b".repeat(64) } }, context({
      files,
      async invoke() { assert.fail("a stale editor base must be rejected before consent/provider access"); },
    }));
    assert.equal(staleResult.ok, false);
    if (staleResult.ok) return;
    assert.equal(staleResult.error.code, "assistant_editor_draft_stale");
    assert.equal(requestPrompt, "", "stale draft must not be transmitted");

    const result = await attribution.invoke({ sceneId: "sc-live", editorDraft }, context({
      files,
      async invoke(actionId) {
        assert.equal(actionId, "nlp.features");
        return { ok: true, snapshot, data: { features: [{ id: "speaker-attribution-llm", locality: "external", enabled: true }] } };
      },
    }));
    assert.equal(result.ok, true);
    assert.match(requestPrompt, /編集中の新しい台詞/u);
    assert.doesNotMatch(requestPrompt, /保存済みの台詞/u);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    assert.deepEqual(data.attributions, [{ sentenceIndex: 1, text: "「編集中の新しい台詞。」", speakerEntityId: "char-live", rationale: "口調が一致" }]);
    const citations = data.citations as Array<Record<string, unknown>>;
    assert.equal(citations[0]?.label, "current editor draft");
    assert.equal(citations[0]?.revision, "editor-document-rev-7");
    assert.deepEqual(citations[0]?.snapshot, editorSnapshot);
    const provenance = data.provenance as Record<string, unknown>;
    assert.deepEqual((provenance.editorDraft as Record<string, unknown>).baseSnapshot, snapshot);
    assert.equal((provenance.editorDraft as Record<string, unknown>).baseSceneRevision, revision);
    assert.equal((provenance.editorDraft as Record<string, unknown>).textSource, "browser-editor-draft");
    assert.match(String((provenance.editorDraft as Record<string, unknown>).textHash), /^[a-f0-9]{64}$/u);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const name of envNames) {
      const value = previousEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("continuation uses only a matching live editor draft after checking its remote scene base", async () => {
  let requestPrompt = "";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requestPrompt = JSON.stringify(body.messages ?? body);
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      const content = JSON.stringify({ options: [
        { direction: "手紙を開く", rationale: "編集稿の最後から続ける。" },
        { direction: "駅員へ尋ねる", rationale: "周囲の描写を広げる。" },
        { direction: "電話をかける", rationale: "人物の動機を見せる。" },
      ] });
      const chunk = {
        id: "chatcmpl-live-continuation", object: "chat.completion.chunk", created: 1, model: "synthetic-local",
        choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
      };
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const envNames = ["ARCADIA_LLM_PROVIDER", "ARCADIA_LLM_MODEL", "ARCADIA_LLM_BASE_URL", "ARCADIA_LLM_API_KEY", "CF_AIG_TOKEN", "CF_AIG_BYOK_ALIAS"] as const;
  const previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  process.env.ARCADIA_LLM_PROVIDER = "openai-compatible";
  process.env.ARCADIA_LLM_MODEL = "synthetic-local";
  process.env.ARCADIA_LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.ARCADIA_LLM_API_KEY = "local-test-placeholder";
  delete process.env.CF_AIG_TOKEN;
  delete process.env.CF_AIG_BYOK_ALIAS;
  const scenePath = "plot/volumes/vol-main/chapters/ch-live-cont/scenes/sc-live-cont.yaml";
  const manuscriptPath = "manuscript/vol-main/ch-live-cont/sc-live-cont.md";
  const files = {
    "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntype: volume\nname: Main\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-live-cont/chapter.yaml": "id: ch-live-cont\ntype: chapter\nname: Live continuation\nvolume: vol-main\norder: 1\n",
    [scenePath]: `id: sc-live-cont\ntype: scene\nchapter: ch-live-cont\norder: 1\ntitle: Station\nmanuscript: ${manuscriptPath}\n`,
    [manuscriptPath]: "保存済み本文の文。",
    "plot/volumes/vol-main/chapters/ch-live-cont/chapter-summary.yaml": "scope: chapter\nid: ch-live-cont\nsummaryLines:\n  - 承認済み要約。\n",
    "plot/volumes/vol-main/chapters/ch-selected/chapter.yaml": "id: ch-selected\ntype: chapter\nname: Selected continuation context\nvolume: vol-main\norder: 2\n",
    "plot/volumes/vol-main/chapters/ch-selected/chapter-summary.yaml": "scope: chapter\nid: ch-selected\nsummaryLines:\n  - 選択した章の承認済み要約。\n",
  };
  const draftSnapshot: SnapshotId = { repository, remoteCommit: "c".repeat(40), overlayCommit: "e".repeat(40) };
  const draftText = Array.from({ length: 13 }, (_, index) => `編集中${index + 1}。`).join("");
  const editorDraft: BrowserEditorDocument = {
    sceneId: "sc-live-cont", documentPath: manuscriptPath, documentRevision: "editor-document-rev-9",
    sceneRevision: "editor-scene-rev-14", text: draftText,
    snapshot: draftSnapshot, baseSnapshot: snapshot, baseSceneRevision: revision,
  };
  const usageStore: ModelUsageStore = { async append() {}, async list() { return { events: [] }; } };
  try {
    const continuation = getAction(createAssistantActions(moduleContext(usageStore)), "assistant.continuation");
    const staleResult = await continuation.invoke({ sceneId: "sc-live-cont", editorDraft: { ...editorDraft, baseSceneRevision: "b".repeat(64) }, k: 8 }, context({
      files,
      async invoke() { assert.fail("a stale editor base must be rejected before provider, retrieval, or tokenizer access"); },
    }));
    assert.equal(staleResult.ok, false);
    if (staleResult.ok) return;
    assert.equal(staleResult.error.code, "assistant_editor_draft_stale");
    assert.equal(requestPrompt, "");

    const expectedRetrievalQuery = ["編集中11。", "編集中12。", "編集中13。"].join(" ");
    const retrievalSearchInputs: unknown[] = [];
    const continuationInput = { sceneId: "sc-live-cont", chapterId: "ch-selected", editorDraft, recentSentences: ["must be ignored"], k: 8 };
    const makeContinuationContext = () => context({
      files,
      async invoke(actionId, input) {
        if (actionId === "nlp.features") return { ok: true, snapshot, data: { features: [{ id: "continuation-options", locality: "external", enabled: true }] } };
        if (actionId === "semantic.search") {
          retrievalSearchInputs.push(input);
          return { ok: true, snapshot, data: { results: [{ sceneId: "sc-neighbor", entityId: "sc-neighbor", snippet: "別の場面の根拠。" }] } };
        }
        if (actionId === "nlp.countTokens") {
          const request = input as { texts: string[]; modelId?: string };
          assert.ok(request.texts.some((text) => text.includes("編集中13。")));
          assert.ok(request.texts.some((text) => text.includes("選択した章の承認済み要約。")));
          return { ok: true, snapshot, data: {
            snapshot, counts: request.texts.map(() => 1),
            counter: { modelId: "source-fallback", exact: false, engine: "source-approximation", engineVersion: "1", fallbackReason: "test tokenizer absent" },
          } };
        }
        assert.fail(`unexpected action ${actionId}`);
      },
    });
    const preview = await getAction(createAssistantActions(moduleContext(usageStore)), "assistant.continuation.preview").invoke(continuationInput, makeContinuationContext());
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    assert.deepEqual(retrievalSearchInputs.at(-1), { query: expectedRetrievalQuery, mode: "scene", limit: 5, rerank: false });
    const previewPrompt = (preview.data as Record<string, unknown>).prompt as string;
    assert.match(previewPrompt, /別の場面の根拠。/u, "preview must include the same best-effort semantic context as generation");
    assert.match(previewPrompt, /選択した章の承認済み要約。/u, "preview must include the explicitly selected fresh chapter summary");
    assert.doesNotMatch(previewPrompt, /(?<!選択した章の)承認済み要約。/u, "an explicit chapter choice must not be replaced by the scene's chapter");

    const result = await continuation.invoke(continuationInput, makeContinuationContext());
    assert.deepEqual(retrievalSearchInputs.at(-1), { query: expectedRetrievalQuery, mode: "scene", limit: 5, rerank: false });
    assert.equal(result.ok, true);
    assert.match(requestPrompt, /編集中13。/u);
    assert.doesNotMatch(requestPrompt, /保存済み本文の文/u);
    assert.doesNotMatch(requestPrompt, /must be ignored/u);
    const sentMessages = JSON.parse(requestPrompt) as Array<{ content?: unknown }>;
    assert.ok(sentMessages.some((message) => message.content === previewPrompt), "the live continuation must send the exact prompt shown by its preview");
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    const citations = data.citations as Array<Record<string, unknown>>;
    assert.equal(citations[0]?.label, "current editor draft");
    assert.equal(citations[0]?.revision, "editor-document-rev-9");
    assert.deepEqual(citations[0]?.snapshot, draftSnapshot);
    const provenance = data.provenance as Record<string, unknown>;
    assert.deepEqual((provenance.editorDraft as Record<string, unknown>).baseSnapshot, snapshot);
    assert.equal((provenance.editorDraft as Record<string, unknown>).baseSceneRevision, revision);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const name of envNames) {
      const value = previousEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("rewrite parser follows source candidate normalization, keeps same-scene context, and falls back after a recorded provider failure", async () => {
  let providerFails = false;
  const prompts: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      prompts.push(JSON.stringify(body.messages ?? body));
      if (providerFails) {
        response.writeHead(503, { "Content-Type": "text/plain" }).end("local test provider unavailable");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      const content = JSON.stringify({ suggestions: [
        { text: "簡潔に置き換えた。", strategy: "strategic", rationale: "短くする。" },
        { rewrite: "文脈を保って言い換えた。", strategy: "contextual", rationale: "場面を維持する。" },
        { text: "口調を調整して書き換えた。", strategy: "unsupported", rationale: "声を保つ。" },
      ] });
      const chunk = {
        id: "chatcmpl-rewrite-source-shape", object: "chat.completion.chunk", created: 1, model: "synthetic-local",
        choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
      };
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const envNames = ["ARCADIA_LLM_PROVIDER", "ARCADIA_LLM_MODEL", "ARCADIA_LLM_BASE_URL", "ARCADIA_LLM_API_KEY", "CF_AIG_TOKEN", "CF_AIG_BYOK_ALIAS"] as const;
  const previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  process.env.ARCADIA_LLM_PROVIDER = "openai-compatible";
  process.env.ARCADIA_LLM_MODEL = "synthetic-local";
  process.env.ARCADIA_LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.ARCADIA_LLM_API_KEY = "local-test-placeholder";
  delete process.env.CF_AIG_TOKEN;
  delete process.env.CF_AIG_BYOK_ALIAS;
  const scenePath = "plot/volumes/vol-main/chapters/ch-rewrite-live/scenes/sc-rewrite-live.yaml";
  const manuscriptPath = "manuscript/vol-main/ch-rewrite-live/sc-rewrite-live.md";
  const otherScenePath = "plot/volumes/vol-main/chapters/ch-rewrite-live/scenes/sc-other.yaml";
  const files = {
    "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntype: volume\nname: Main\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-rewrite-live/chapter.yaml": "id: ch-rewrite-live\ntype: chapter\nname: Rewrite\nvolume: vol-main\norder: 1\n",
    [scenePath]: `id: sc-rewrite-live\ntype: scene\nchapter: ch-rewrite-live\norder: 1\ntitle: Rewrite\npov: char-rewrite\nappears: [char-rewrite]\nmanuscript: ${manuscriptPath}\n`,
    [otherScenePath]: "id: sc-other\ntype: scene\nchapter: ch-rewrite-live\norder: 2\ntitle: Other\nmanuscript: manuscript/vol-main/ch-rewrite-live/sc-other.md\n",
    [manuscriptPath]: "彼は駅で彼女を見つめた。別の文では、彼女は悲しかった。",
    "manuscript/vol-main/ch-rewrite-live/sc-other.md": "別の場面で彼は歩いた。",
    "bible/characters/char-rewrite/profile.yaml": "id: char-rewrite\ntype: character\nname: Rewrite POV\nvoice:\n  firstPerson: 私\n",
  };
  const usageEvents: ModelUsageEvent[] = [];
  const usageStore: ModelUsageStore = { async append(event) { usageEvents.push(event); }, async list() { return { events: [] }; } };
  const action = getAction(createAssistantActions(moduleContext(usageStore)), "assistant.rewrite");
  const actionContext = () => context({
    files,
    async invoke(actionId, input) {
      if (actionId === "nlp.features") return { ok: true, snapshot, data: { features: [{ id: "rewrite", locality: "external", enabled: true }] } };
      if (actionId === "speaker.voice.profiles") return { ok: true, snapshot, data: { fingerprints: [] } };
      if (actionId === "speaker.dialogue.list") return { ok: true, snapshot, data: { lines: [] } };
      if (actionId === "semantic.search") {
        assert.deepEqual(input, { query: "彼は駅で彼女を見つめた。", mode: "sentence", limit: 12, rerank: false });
        return { ok: true, snapshot, data: { results: [
          { sceneId: "sc-rewrite-live", sentenceIndex: 0, snippet: "彼は駅で彼女を見つめた。" },
          { sceneId: "sc-rewrite-live", sentenceIndex: 1, snippet: "別の文では、彼女は悲しかった。" },
          { sceneId: "sc-other", sentenceIndex: 0, snippet: "別の場面で彼は歩いた。" },
          { sceneId: "sc-other", sentenceIndex: 1, snippet: "別の場面で彼は歩いた。" },
          { sceneId: "sc-other", sentenceIndex: 2, snippet: "さらに別の場面で彼女は待った。" },
        ] } };
      }
      assert.fail(`unexpected action ${actionId}`);
    },
  });
  try {
    const result = await action.invoke({ sceneId: "sc-rewrite-live", sentenceIndex: 0 }, actionContext());
    assert.equal(result.ok, true);
    assert.match(prompts[0] ?? "", /別の文では、彼女は悲しかった/u, "same-scene nonselected sentences remain source examples");
    assert.match(prompts[0] ?? "", /さらに別の場面で彼女は待った/u);
    if (!result.ok) return;
    const resultData = result.data as Record<string, unknown>;
    assert.deepEqual((resultData.context as Record<string, unknown>).corpus_action_descriptions, [
      "別の文では、彼女は悲しかった。", "別の場面で彼は歩いた。", "さらに別の場面で彼女は待った。",
    ]);
    assert.deepEqual((resultData.suggestions as Array<Record<string, unknown>>).map((item) => item.strategy), ["concise", "contextual", "voice"]);
    assert.equal(resultData.sentenceIndex, 0);

    providerFails = true;
    const fallbackResult = await action.invoke({ sceneId: "sc-rewrite-live", sentenceIndex: 0 }, actionContext());
    assert.equal(fallbackResult.ok, true, "a recorded provider failure should leave the source heuristic alternatives available");
    if (fallbackResult.ok) {
      const fallbackData = fallbackResult.data as Record<string, unknown>;
      assert.equal(fallbackData.provider, "local");
      assert.deepEqual(fallbackData.providerAttempt, { outcome: "failed", fallback: "source-heuristics" });
      assert.equal((fallbackData.suggestions as unknown[]).length, 3);
    }
    assert.equal(usageEvents.length, 2);
    assert.equal(usageEvents[1]?.state, "failed", "the fallback does not erase durable failed-provider usage history");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const name of envNames) {
      const value = previousEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("setting QA streams source-compatible global scene and hybrid Bible searches with bound citations", async () => {
  let requestCount = 0;
  let sawToolCall = false;
  let firstRequestMessages = "";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requestCount += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      if (requestCount <= 6) {
        if (requestCount === 1) firstRequestMessages = JSON.stringify(body.messages ?? []);
        const tools = Array.isArray(body.tools) ? body.tools : [];
        sawToolCall ||= tools.some((item) => JSON.stringify(item).includes("searchScenes"));
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        const chunk = {
          id: `chatcmpl-qa-scenes-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "synthetic-local",
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-search-scenes-${requestCount}`, type: "function", function: { name: "searchScenes", arguments: JSON.stringify({ query: "夜明け", mode: "scene" }) } }] }, finish_reason: "tool_calls" }],
        };
        response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      } else if (requestCount === 7) {
        assert.ok(Array.isArray(body.messages), "the scene tool results should be sent back as model history");
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        const chunk = {
          id: "chatcmpl-qa-bible-tool", object: "chat.completion.chunk", created: 1, model: "synthetic-local",
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-search-bible", type: "function", function: { name: "searchBible", arguments: JSON.stringify({ query: "アリス", entityKind: "character" }) } }] }, finish_reason: "tool_calls" }],
        };
        response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      } else {
        assert.ok(Array.isArray(body.messages), "the read-only tool results should be sent back as model history");
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        const content = JSON.stringify({ answer: "アリスが夜明けに駅へ着きます。", citations: [
          { kind: "scene", id: "sc-other", quote: "別の場面にも夜明けの駅が出てくる。" },
          { kind: "bible", id: "char-qa", quote: "アリス" },
        ], confidence: "high" });
        const chunk = {
          id: "chatcmpl-qa-answer", object: "chat.completion.chunk", created: 1, model: "synthetic-local",
          choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
        };
        response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const envNames = ["ARCADIA_LLM_PROVIDER", "ARCADIA_LLM_MODEL", "ARCADIA_LLM_BASE_URL", "ARCADIA_LLM_API_KEY", "CF_AIG_TOKEN", "CF_AIG_BYOK_ALIAS"] as const;
  const previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  process.env.ARCADIA_LLM_PROVIDER = "openai-compatible";
  process.env.ARCADIA_LLM_MODEL = "synthetic-local";
  process.env.ARCADIA_LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.ARCADIA_LLM_API_KEY = "local-test-placeholder";
  delete process.env.CF_AIG_TOKEN;
  delete process.env.CF_AIG_BYOK_ALIAS;
  const scenePath = "plot/volumes/vol-main/chapters/ch-qa/scenes/sc-qa.yaml";
  const manuscriptPath = "manuscript/vol-main/ch-qa/sc-qa.md";
  const otherScenePath = "plot/volumes/vol-main/chapters/ch-qa/scenes/sc-other.yaml";
  const otherManuscriptPath = "manuscript/vol-main/ch-qa/sc-other.md";
  const files = {
    "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntype: volume\nname: Main\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-qa/chapter.yaml": "id: ch-qa\ntype: chapter\nname: QA\nvolume: vol-main\norder: 1\n",
    [scenePath]: `id: sc-qa\ntype: scene\nchapter: ch-qa\norder: 1\ntitle: Dawn\nmanuscript: ${manuscriptPath}\n`,
    [otherScenePath]: `id: sc-other\ntype: scene\nchapter: ch-qa\norder: 2\ntitle: Other dawn\nmanuscript: ${otherManuscriptPath}\n`,
    "bible/characters/char-qa/profile.yaml": "id: char-qa\ntype: character\nname: アリス\nnotes:\n  lead: []\n  sections: []\n",
    [manuscriptPath]: "主人公は夜明けに駅へ着いた。",
    [otherManuscriptPath]: "別の場面にも夜明けの駅が出てくる。",
  };
  const usageEvents: ModelUsageEvent[] = [];
  const usageStore: ModelUsageStore = { async append(event) { usageEvents.push(event); }, async list() { return { events: [] }; } };
  try {
    const qa = getAction(createAssistantActions(moduleContext(usageStore)), "assistant.qa");
    const result = await qa.invoke({ messages: [{ role: "user", content: "主人公は誰で、いつ駅へ着く?" }], sceneId: "sc-qa" }, context({
      files,
      async invoke(actionId, input) {
        if (actionId === "nlp.features") return { ok: true, snapshot, data: { features: [{ id: "setting-qa", locality: "external", enabled: true }] } };
        if (actionId === "semantic.search") {
          const search = input as Record<string, unknown>;
          if (search.limit === 8) {
            assert.deepEqual(search, { query: "夜明け", mode: "scene", limit: 8, rerank: false });
            return { ok: true, snapshot, data: { results: [{ sceneId: "sc-other", type: "scene", snippet: "別の場面にも夜明けの駅が出てくる。", filePath: otherManuscriptPath, revision }] } };
          }
          assert.deepEqual(search, { query: "アリス", mode: "scene", limit: 12, rerank: false });
          return { ok: true, snapshot, data: { results: [
            { sceneId: "char-qa", entityId: "char-qa", type: "character", name: "アリス", snippet: "アリス", filePath: "bible/characters/char-qa/profile.yaml", score: 0.81 },
            { sceneId: "sc-other", type: "scene", snippet: "別の場面にも夜明けの駅が出てくる。", filePath: otherManuscriptPath, score: 0.78 },
          ] } };
        }
        assert.fail(`unexpected action ${actionId}`);
      },
    }));
    assert.equal(result.ok, true);
    assert.equal(requestCount, 8, "QA must allow the source limit of eight model steps while using read-only search tools");
    assert.equal(sawToolCall, true);
    assert.match(firstRequestMessages, /主人公は夜明けに駅へ着いた/u, "the selected scene remains system-prompt context");
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    assert.equal(data.answer, "アリスが夜明けに駅へ着きます。");
    assert.deepEqual(data.citations, [
      { kind: "scene", id: "sc-other", quote: "別の場面にも夜明けの駅が出てくる。", path: otherManuscriptPath, revision, sceneId: "sc-other", label: "searchScenes result" },
      { kind: "bible", id: "char-qa", quote: "アリス", path: "bible/characters/char-qa/profile.yaml", revision, label: "searchBible result" },
    ]);
    assert.equal((data.provenance as Record<string, unknown>).snapshot && (data.provenance as Record<string, unknown>).snapshot, snapshot);
    assert.equal(usageEvents.length, 1);
    assert.equal(usageEvents[0]?.feature, "setting-qa");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const name of envNames) {
      const value = previousEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("aspect review runs the deterministic local source implementation without consent or model access", async () => {
  const previous = process.env.ARCADIA_LLM_PROVIDER;
  process.env.ARCADIA_LLM_PROVIDER = "none";
  let capabilityAcquisitions = 0;
  let actionInvocations = 0;
  let proposals = 0;
  const chapterPath = "plot/volumes/vol-main/chapters/ch-1/chapter.yaml";
  const sceneBase = "plot/volumes/vol-main/chapters/ch-1/scenes";
  const files: Record<string, string> = {
    [chapterPath]: "id: ch-1\ntype: chapter\nname: First chapter\nvolume: vol-main\norder: 1\n",
    [`${sceneBase}/sc-1.yaml`]: "id: sc-1\ntype: scene\nchapter: ch-1\norder: 1\ntitle: Long scene\npov: char-one\nmanuscript: manuscript/vol-main/ch-1/sc-1.md\n",
    [`${sceneBase}/sc-2.yaml`]: "id: sc-2\ntype: scene\nchapter: ch-1\norder: 2\ntitle: Short scene\npov: char-two\nmanuscript: manuscript/vol-main/ch-1/sc-2.md\n",
    "bible/characters/char-one/profile.yaml": "id: char-one\ntype: character\nname: One\n",
    "bible/characters/char-two/profile.yaml": "id: char-two\ntype: character\nname: Two\n",
    "manuscript/vol-main/ch-1/sc-1.md": `${"a".repeat(600)} 私は振り返った。彼女は先へ進んだ。`,
    "manuscript/vol-main/ch-1/sc-2.md": "短い場面。",
  };
  try {
    const module = createAssistantActions(moduleContext(undefined, () => { capabilityAcquisitions += 1; }));
    const action = getAction(module, "assistant.aspect.review");
    const result = await action.invoke({ chapterId: "ch-1", aspects: ["tempo", "pov-shift"] }, context({
      files,
      async invoke() {
        actionInvocations += 1;
        return { ok: false, snapshot, error: { code: "unexpected", message: "No action should be needed", retryable: false } };
      },
      onPropose() { proposals += 1; },
    }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    assert.equal(data.proposal, true);
    assert.equal(data.sceneCount, 2);
    const findings = data.findings as Array<Record<string, unknown>>;
    assert.ok(findings.some((finding) => finding.aspect === "tempo" && typeof finding.sceneId === "string"));
    assert.ok(findings.some((finding) => finding.aspect === "pov-shift" && String(finding.finding).includes("POV")));
    assert.equal(actionInvocations, 0);
    assert.equal(capabilityAcquisitions, 0);
    assert.equal(proposals, 0);
  } finally {
    if (previous === undefined) delete process.env.ARCADIA_LLM_PROVIDER;
    else process.env.ARCADIA_LLM_PROVIDER = previous;
  }
});

test("implemented prompt previews return their actual prompts locally without consent, usage, or proposal effects", async () => {
  const previous = process.env.ARCADIA_LLM_PROVIDER;
  process.env.ARCADIA_LLM_PROVIDER = "none";
  let capabilityAcquisitions = 0;
  let consentReads = 0;
  let proposals = 0;
  const chapterPath = "plot/volumes/vol-main/chapters/ch-preview/chapter.yaml";
  const scenePath = "plot/volumes/vol-main/chapters/ch-preview/scenes/sc-preview.yaml";
  const sketchPath = "bible/dialogue_sketches/ds-preview.yaml";
  const files: Record<string, string> = {
    "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntype: volume\nname: Main\norder: 1\n",
    [chapterPath]: "id: ch-preview\ntype: chapter\nname: Preview chapter\nvolume: vol-main\norder: 1\n",
    [scenePath]: "id: sc-preview\ntype: scene\nchapter: ch-preview\norder: 1\ntitle: Preview scene\nappears: [char-one, char-two]\nmanuscript: manuscript/vol-main/ch-preview/sc-preview.md\n",
    "bible/characters/char-one/profile.yaml": "id: char-one\ntype: character\nname: One\nvoice:\n  tone: calm\n",
    "bible/characters/char-two/profile.yaml": "id: char-two\ntype: character\nname: Two\n",
    [sketchPath]: "id: ds-preview\ntype: dialogue_sketch\nparticipantEntityIds: [char-one, char-two]\ntopic: Tea\nsituation: At a station\nlines:\n  - speakerEntityId: char-one\n    text: Tea is ready.\n",
    "manuscript/vol-main/ch-preview/sc-preview.md": "彼女は駅へ来た。「お茶ができたわ。」",
  };
  try {
    const actions = createAssistantActions(moduleContext(undefined, () => { capabilityAcquisitions += 1; }));
    const actionContext = context({
      files,
      async invoke(actionId, payload) {
        if (actionId === "nlp.features") consentReads += 1;
        if (actionId === "semantic.search") return { ok: true, snapshot, data: { results: [] } };
        if (actionId === "nlp.countTokens") {
          const request = payload as { texts: string[] };
          return { ok: true, snapshot, data: {
            snapshot, counts: request.texts.map(() => 1),
            counter: { modelId: "test", exact: false, engine: "test", engineVersion: "1" },
          } };
        }
        return { ok: false, snapshot, error: { code: "not_available", message: "Preview must not need domain actions", retryable: false } };
      },
      onPropose() { proposals += 1; },
    });
    const previews: Array<[string, unknown]> = [
      ["assistant.summary.scene.preview", { sceneId: "sc-preview" }],
      ["assistant.summary.chapter.preview", { chapterId: "ch-preview" }],
      ["assistant.qa.preview", { sceneId: "sc-preview" }],
      ["assistant.qa.preview", { sceneId: "missing-scene" }],
      ["assistant.continuation.preview", { recentSentences: ["彼女は駅へ来た。"] }],
      ["assistant.aspect.review.preview", { chapterId: "ch-preview", aspects: ["tempo", "pov-shift"] }],
      ["assistant.dialogue.topics.preview", { participantEntityIds: ["char-one", "char-two"] }],
      ["assistant.dialogue.turn.preview", { participantEntityIds: ["char-one", "char-two"], speakerEntityId: "char-one", topic: "Tea", situation: "At a station", precedingLines: [] }],
      ["assistant.dialogue.turns.preview", { participantEntityIds: ["char-one", "char-two"], lineCount: 2, topic: "Tea", situation: "At a station", precedingLines: [] }],
      ["assistant.reader.reaction.preview", { chapterId: "ch-preview" }],
      ["assistant.synonyms.preview", { original: "駅", sentence: "駅へ向かう。", reason: "繰り返し" }],
      ["assistant.zukan.sandbox.preview", { sketchId: "ds-preview", turnRange: { start: 0, end: 0 } }],
    ];
    for (const [id, input] of previews) {
      const result = await getAction(actions, id).invoke(input, actionContext);
      assert.equal(result.ok, true, `${id} should be available with provider NONE: ${JSON.stringify(result)}`);
      if (result.ok) assert.equal(typeof (result.data as Record<string, unknown>).prompt, "string", `${id} should return a populated prompt`);
    }
    const savedSceneContinuation = await getAction(actions, "assistant.continuation.preview").invoke({ sceneId: "sc-preview", chapterId: "ch-preview", k: 8 }, actionContext);
    assert.equal(savedSceneContinuation.ok, true);
    if (savedSceneContinuation.ok) {
      const prompt = (savedSceneContinuation.data as Record<string, unknown>).prompt as string;
      assert.match(prompt, /彼女は駅へ来た。/u, "saved-scene preview must use the same manuscript fallback as generation");
    }
    assert.equal(capabilityAcquisitions, 0);
    assert.equal(consentReads, 0);
    assert.equal(proposals, 0);
  } finally {
    if (previous === undefined) delete process.env.ARCADIA_LLM_PROVIDER;
    else process.env.ARCADIA_LLM_PROVIDER = previous;
  }
});

test("dialogue topic seeds retain manual relations and related links while excluding automatic and non-related links", async () => {
  const action = getAction(createAssistantActions(moduleContext()), "assistant.dialogue.topics.preview");
  const result = await action.invoke({ participantEntityIds: ["char-one", "char-two"] }, context({
    files: {
      "bible/characters/char-one/profile.yaml": [
        "id: char-one",
        "type: character",
        "name: One",
        "relations:",
        "  - target: char-two",
        "    kind: ally",
        "    note: trusted",
        "  - target: char-two",
        "    kind: related",
        "    note: automatic tie",
        "    auto: true",
        "affiliated: [char-two]",
        "related:",
        "  - target: char-two",
        "    note: linked note",
        "",
      ].join("\n"),
      "bible/characters/char-two/profile.yaml": "id: char-two\ntype: character\nname: Two\n",
    },
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const prompt = (result.data as Record<string, unknown>).prompt as string;
  assert.match(prompt, /One ↔ Two: ally: trusted/u);
  assert.match(prompt, /One ↔ Two: related: linked note/u);
  assert.doesNotMatch(prompt, /automatic tie/u);
  assert.doesNotMatch(prompt, /affiliated/u);
});

test("rewrite proposal preserves all candidates until the author chooses one and pins the manuscript selection", async () => {
  const scenePath = "plot/volumes/vol-main/chapters/ch-rewrite/scenes/sc-rewrite.yaml";
  const manuscriptPath = "manuscript/vol-main/ch-rewrite/sc-rewrite.md";
  const files = {
    "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntype: volume\nname: Main\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-rewrite/chapter.yaml": "id: ch-rewrite\ntype: chapter\nname: Rewrite\nvolume: vol-main\norder: 1\n",
    [scenePath]: `id: sc-rewrite\ntype: scene\nchapter: ch-rewrite\norder: 1\ntitle: Rewrite\nmanuscript: ${manuscriptPath}\n`,
    [manuscriptPath]: "---\ntitle: Rewrite\n---\n彼は夜の駅で彼女を見つけた。",
  };
  let proposed: ChangeOperation[] = [];
  const action = getAction(createAssistantActions(moduleContext()), "assistant.rewrite.propose");
  const result = await action.invoke({
    sceneId: "sc-rewrite",
    selectedText: "彼は夜の駅で彼女を見つけた。",
    replacementText: "夜の駅で、彼は彼女へ目を向けた。",
  }, context({ files, onPropose(operations) { proposed = operations; } }));
  assert.equal(result.ok, true);
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0]?.effect, "manuscript");
  assert.deepEqual(proposed[0]?.reads.map((item) => item.path).sort(), [scenePath, manuscriptPath].sort());
  assert.equal(proposed[0]?.writes[0]?.content, "---\ntitle: Rewrite\n---\n夜の駅で、彼は彼女へ目を向けた。");
  if (result.ok) assert.equal((result.data as Record<string, unknown>).replacementText, "夜の駅で、彼は彼女へ目を向けた。");
});

test("chapter summary proposes fresh child and parent summaries in one Core operation", async () => {
  let requestCount = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requestCount += 1;
      const content = requestCount === 1
        ? JSON.stringify({ summaryLines: ["彼女が駅へ来た。", "彼が手紙を渡した。", "二人は別れた。"], characters: [], stateChanges: [] })
        : JSON.stringify({ summaryLines: ["彼女が駅へ来て手紙を受け取る。", "二人は再会を約束して別れる。", "手紙が次章への手がかりになる。"] });
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      const chunk = {
        id: `chatcmpl-local-summary-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "synthetic-local",
        choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
      };
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const envNames = ["ARCADIA_LLM_PROVIDER", "ARCADIA_LLM_MODEL", "ARCADIA_LLM_BASE_URL", "ARCADIA_LLM_API_KEY", "CF_AIG_TOKEN", "CF_AIG_BYOK_ALIAS"] as const;
  const previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  process.env.ARCADIA_LLM_PROVIDER = "openai-compatible";
  process.env.ARCADIA_LLM_MODEL = "synthetic-local";
  process.env.ARCADIA_LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.ARCADIA_LLM_API_KEY = "local-test-placeholder";
  delete process.env.CF_AIG_TOKEN;
  delete process.env.CF_AIG_BYOK_ALIAS;
  const files: Record<string, string> = {
    "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntype: volume\nname: Main\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-summary/chapter.yaml": "id: ch-summary\ntype: chapter\nname: Summary chapter\nvolume: vol-main\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-summary/scenes/sc-summary.yaml": "id: sc-summary\ntype: scene\nchapter: ch-summary\norder: 1\ntitle: Station\npov: char-one\nappears: [char-two, char-one]\nmanuscript: manuscript/vol-main/ch-summary/sc-summary.md\n",
    "bible/characters/char-one/profile.yaml": "id: char-one\ntype: character\nname: One\n",
    "bible/characters/char-two/profile.yaml": "id: char-two\ntype: character\nname: Two\n",
    "manuscript/vol-main/ch-summary/sc-summary.md": "彼女は駅へ来た。彼は手紙を渡した。二人は別れを告げた。",
  };
  const store: ModelUsageStore = { async append() {}, async list() { return { events: [] }; } };
  const operations: ChangeOperation[][] = [];
  const progress: number[] = [];
  try {
    const action = getAction(createAssistantActions(moduleContext(store)), "assistant.summary.chapter");
    const result = await action.invoke({ chapterId: "ch-summary" }, context({
      files,
      async invoke(actionId) {
        assert.equal(actionId, "nlp.features");
        return { ok: true, snapshot, data: { features: [
          { id: "scene-summary", locality: "external", enabled: true },
          { id: "chapter-summary", locality: "external", enabled: true },
        ] } };
      },
      onPropose(value) { operations.push(value); },
      onProgress(value) { progress.push(value); },
    }));
    assert.equal(result.ok, true);
    assert.equal(requestCount, 2, "one scene summary and one chapter summary are generated");
    assert.equal(operations.length, 1, "all related writes must be one atomic review operation");
    assert.equal(operations[0]?.length, 1);
    const operation = operations[0]![0]!;
    assert.equal(operation.effect, "metadata");
    assert.deepEqual(operation.writes.map((write) => write.path).sort(), [
      "plot/volumes/vol-main/chapters/ch-summary/chapter-summary.yaml",
      "plot/volumes/vol-main/chapters/ch-summary/scene-summaries/sc-summary.yaml",
    ].sort());
    assert.equal(operation.reads.find((item) => item.path.endsWith("scene-summaries/sc-summary.yaml"))?.revision, null);
    assert.equal(operation.reads.find((item) => item.path.endsWith("chapter-summary.yaml"))?.revision, null);
    const sceneSummary = operation.writes.find((write) => write.path.endsWith("scene-summaries/sc-summary.yaml"))?.content;
    assert.ok(sceneSummary);
    assert.match(sceneSummary, /characters:\n  - One\n  - Two/u, "the source POV and appearance names fill an empty model character list");
    assert.equal(progress.at(-1), 1);
    assert.ok(progress.some((value) => Math.abs(value - 0.8) < 1e-9), "the chapter progress reports completion of its one child summary");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const name of envNames) {
      const value = previousEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("manuscript and sandbox Zukan suggestions are grounded before Story receives proposals", async () => {
  const sandboxOutputs = [
    JSON.stringify({ suggestions: [{ kind: "fact", targetEntityId: "char-zukan", blockPath: "lead.0", proposedText: "透明な魔法の杖を持つ。", evidenceQuote: "好きな紅茶を飲む。", confidence: "high" }] }),
    JSON.stringify({ suggestions: [{ kind: "habit", targetEntityId: "char-zukan", blockPath: "lead.0", proposedText: "好きな紅茶を飲む。", evidenceQuote: "好きな紅茶を飲む。", confidence: "high" }] }),
  ];
  const server = createServer((request, response) => {
    const requestChunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => requestChunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(requestChunks).toString("utf8")) as Record<string, unknown>;
      const prompt = typeof body.prompt === "string" ? body.prompt : JSON.stringify(body.messages ?? body);
      const content = prompt.includes("sketchId (sourceSessionId):")
        ? sandboxOutputs.shift()
        : JSON.stringify({ blockPath: "lead.0", proposedText: "未知の魔法の杖を持つ。", evidence: [{ sceneId: "sc-zukan", quote: "アリスは赤い剣を拾った。" }] });
      assert.ok(content, "one local model response is expected per action");
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      const chunk = {
        id: "chatcmpl-local-test", object: "chat.completion.chunk", created: 1, model: "synthetic-local",
        choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
      };
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const envNames = ["ARCADIA_LLM_PROVIDER", "ARCADIA_LLM_MODEL", "ARCADIA_LLM_BASE_URL", "ARCADIA_LLM_API_KEY", "CF_AIG_TOKEN", "CF_AIG_BYOK_ALIAS"] as const;
  const previousEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  process.env.ARCADIA_LLM_PROVIDER = "openai-compatible";
  process.env.ARCADIA_LLM_MODEL = "synthetic-local";
  process.env.ARCADIA_LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.ARCADIA_LLM_API_KEY = "local-test-placeholder";
  delete process.env.CF_AIG_TOKEN;
  delete process.env.CF_AIG_BYOK_ALIAS;

  const files: Record<string, string> = {
    "bible/characters/char-zukan/profile.yaml": "id: char-zukan\ntype: character\nname: アリス\nnotes:\n  lead: []\n  sections: []\n",
    "bible/dialogue_sketches/ds-zukan.yaml": "id: ds-zukan\ntype: dialogue_sketch\nname: Tea chat\nparticipantEntityIds:\n  - char-zukan\nlines:\n  - speakerEntityId: char-zukan\n    text: 好きな紅茶を飲む。\n",
    "plot/volumes/vol-main/chapters/ch-zukan/chapter.yaml": "id: ch-zukan\ntype: chapter\nname: Zukan chapter\nvolume: vol-main\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-zukan/scenes/sc-zukan.yaml": "id: sc-zukan\ntype: scene\nchapter: ch-zukan\norder: 1\ntitle: Red sword\nmanuscript: manuscript/vol-main/ch-zukan/sc-zukan.md\n",
    "manuscript/vol-main/ch-zukan/sc-zukan.md": "アリスは赤い剣を拾った。",
  };
  const usageEvents: ModelUsageEvent[] = [];
  const usageStore: ModelUsageStore = {
    async append(event) { usageEvents.push(event); },
    async list() { return { events: [] }; },
  };
  const nestedCreates: Record<string, unknown>[] = [];
  const childProposal: ChangeProposal = { id: "story-zukan-proposal", snapshot, operations: [], source: "module" };
  const action = getAction(createAssistantActions(moduleContext(usageStore)), "assistant.zukan.suggestions");
  const makeContext = () => context({
    files,
    async invoke(actionId, input) {
      if (actionId === "nlp.features") return { ok: true, snapshot, data: { features: [{ id: "zukan-proposal", locality: "external", enabled: true }] } };
      if (actionId === "semantic.search") return { ok: true, snapshot, data: { results: [{ sceneId: "sc-zukan", snippet: "アリスは赤い剣を拾った。" }] } };
      if (actionId === "story.zukan-suggestions.create") {
        nestedCreates.push(input as Record<string, unknown>);
        return { ok: true, snapshot, data: { suggestion: { id: `suggestion-${nestedCreates.length}` }, created: true, staledPendingCount: 0 }, proposals: [childProposal] };
      }
      assert.fail(`unexpected nested action ${actionId}`);
    },
  });

  try {
    const manuscript = await action.invoke({ entityId: "char-zukan", source: "manuscript" }, makeContext());
    assert.equal(manuscript.ok, false);
    if (!manuscript.ok) assert.equal(manuscript.error.code, "assistant_output_ungrounded");
    assert.equal(nestedCreates.length, 0, "ungrounded manuscript text must never reach Story");

    const sandbox = await action.invoke({ source: "sandbox", sourceSessionId: "ds-zukan", turnRange: { start: 0, end: 0 } }, makeContext());
    assert.equal(sandbox.ok, true);
    if (sandbox.ok) assert.equal((sandbox.data as Record<string, unknown>).createdCount, 0);
    assert.equal(nestedCreates.length, 0, "ungrounded sandbox text must never reach Story");

    const accepted = await action.invoke({ source: "sandbox", sourceSessionId: "ds-zukan", turnRange: { start: 0, end: 0 } }, makeContext());
    assert.equal(accepted.ok, true);
    assert.equal(nestedCreates.length, 1);
    assert.deepEqual(nestedCreates[0], {
      entityId: "char-zukan", proposedText: "好きな紅茶を飲む。", evidence: [{ quote: "好きな紅茶を飲む。" }],
      source: "sandbox", sourceSessionId: "ds-zukan", sourceTurnRange: { start: 0, end: 0 },
      blockPath: "lead.0", kind: "habit", confidence: "high",
    });
    assert.equal(usageEvents.length, 3, "each completed model call is recorded in durable host usage history");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const name of envNames) {
      const value = previousEnv.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("settings changes become a review proposal with snapshot preconditions", async () => {
  let submitted: ChangeOperation[] | undefined;
  const action = getAction(createAssistantActions(moduleContext()), "assistant.settings.propose");
  const result = await action.invoke({ patch: { maxConcurrentModels: 2 } }, context({ onPropose(operations) { submitted = operations; } }));
  assert.equal(result.ok, true);
  assert.equal(submitted?.length, 1);
  const operation = submitted?.[0];
  assert.ok(operation);
  assert.equal(operation.effect, "settings");
  assert.equal(operation.reads.find((item) => item.path === assistantSettingsPath)?.revision, null);
  assert.equal(operation.writes[0]?.path, assistantSettingsPath);
  assert.equal(operation.writes[0]?.revision, null);
  assert.match(operation.writes[0]?.content ?? "", /"maxConcurrentModels": 2/u);
});

test("usage history combines preserved JSONL and host-owned events without rewriting legacy bytes", async () => {
  const legacyLine = JSON.stringify({
    ts: "2026-10-01T12:00:00.000Z", feature: "rewrite", model: "local-model", promptVersion: "rewrite@1",
    inputTokens: 12, outputTokens: 5, cacheHit: false, durationMs: 300, aborted: false,
    queueWaitMs: 10, futureField: { retained: true },
  });
  const legacyContent = `${legacyLine}\n`;
  const hostEvent: ModelUsageEvent = {
    id: "host-event-1", repository, feature: "scene-summary", provider: "openai-compatible", model: "Qwen3-local",
    startedAt: "2026-10-02T12:00:00.000Z", completedAt: "2026-10-02T12:00:02.000Z", state: "completed",
    inputTokens: 50, outputTokens: 20, cacheHit: false, promptVersion: "scene-summary@2", durationMs: 1800, queueWaitMs: 200,
  };
  const store: ModelUsageStore = {
    async append() { throw new Error("history read must not append"); },
    async list(foundRepository, query) {
      assert.deepEqual(foundRepository, repository);
      assert.equal(query?.limit, 200);
      return { events: [hostEvent] };
    },
  };
  const action = getAction(createAssistantActions(moduleContext(store)), "assistant.usage.read");
  const actionContext = context({ files: { [usagePath]: legacyContent } });
  const result = await action.invoke({ limit: 10 }, actionContext);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const data = result.data as { events: Array<Record<string, unknown>>; aggregates: Record<string, Record<string, unknown>>; total: number; legacyRevision: string };
  assert.equal(data.total, 2);
  assert.deepEqual(data.events.map((event) => event.source), ["host-owned-store", "preserved-project-jsonl"]);
  assert.equal(data.events[1]?.promptVersion, "rewrite@1");
  assert.equal(data.events[1]?.queueWaitMs, 10);
  assert.equal(data.events[0]?.promptVersion, "scene-summary@2");
  assert.equal(data.events[0]?.durationMs, 1800);
  assert.equal(data.events[0]?.queueWaitMs, 200);
  assert.equal(data.events[0]?.cacheHit, false);
  assert.equal(data.events[1]?.futureField, undefined, "unknown raw fields remain in the authoritative JSONL without leaking through the table adapter");
  assert.equal(data.aggregates["2026-10"]?.calls, 2);
  assert.equal(data.aggregates["2026-10"]?.byFeature && (data.aggregates["2026-10"]?.byFeature as Record<string, number>).rewrite, 1);
  assert.equal(data.legacyRevision, revision);
  assert.equal((await actionContext.reader.read(usagePath))?.content, legacyContent);
  assert.equal(legacyContent.includes('"futureField":{"retained":true}'), true);
});
