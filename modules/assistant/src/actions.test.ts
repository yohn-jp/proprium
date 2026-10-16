import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  MODEL_USAGE_CAPABILITY,
  type ActionResult,
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
    assert.deepEqual(definition.http?.map((item) => item.path).sort(), ["qa/stream", "rewrite/stream"]);
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

test("setting QA streams an actual read-only tool round and returns only source-revision-bound citations", async () => {
  let requestCount = 0;
  let sawToolCall = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requestCount += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      if (requestCount === 1) {
        const tools = Array.isArray(body.tools) ? body.tools : [];
        sawToolCall = tools.some((item) => JSON.stringify(item).includes("searchScenes"));
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        const chunk = {
          id: "chatcmpl-qa-tool", object: "chat.completion.chunk", created: 1, model: "synthetic-local",
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-search-scenes", type: "function", function: { name: "searchScenes", arguments: JSON.stringify({ query: "夜明け", mode: "scene" }) } }] }, finish_reason: "tool_calls" }],
        };
        response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      } else {
        assert.ok(Array.isArray(body.messages), "the tool result should be sent back as model history");
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        const content = JSON.stringify({ answer: "主人公は夜明けに駅へ着きます。", citations: [{ kind: "scene", id: "sc-qa", quote: "主人公は夜明けに駅へ着いた。" }], confidence: "high" });
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
  const files = {
    "plot/volumes/vol-main/volume.yaml": "id: vol-main\ntype: volume\nname: Main\norder: 1\n",
    "plot/volumes/vol-main/chapters/ch-qa/chapter.yaml": "id: ch-qa\ntype: chapter\nname: QA\nvolume: vol-main\norder: 1\n",
    [scenePath]: `id: sc-qa\ntype: scene\nchapter: ch-qa\norder: 1\ntitle: Dawn\nmanuscript: ${manuscriptPath}\n`,
    [manuscriptPath]: "主人公は夜明けに駅へ着いた。",
  };
  const usageEvents: ModelUsageEvent[] = [];
  const usageStore: ModelUsageStore = { async append(event) { usageEvents.push(event); }, async list() { return { events: [] }; } };
  try {
    const qa = getAction(createAssistantActions(moduleContext(usageStore)), "assistant.qa");
    const result = await qa.invoke({ messages: [{ role: "user", content: "主人公はいつ駅へ着く?" }] }, context({
      files,
      async invoke(actionId, input) {
        if (actionId === "nlp.features") return { ok: true, snapshot, data: { features: [{ id: "setting-qa", locality: "external", enabled: true }] } };
        if (actionId === "semantic.search") {
          assert.deepEqual(input, { query: "夜明け", mode: "scene", limit: 8, rerank: false });
          return { ok: true, snapshot, data: { results: [{ sceneId: "sc-qa", type: "scene", snippet: "主人公は夜明けに駅へ着いた。", filePath: manuscriptPath, revision }] } };
        }
        assert.fail(`unexpected action ${actionId}`);
      },
    }));
    assert.equal(result.ok, true);
    assert.equal(requestCount, 2, "QA must call the model again after the read-only search tool");
    assert.equal(sawToolCall, true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    assert.equal(data.answer, "主人公は夜明けに駅へ着きます。");
    assert.deepEqual(data.citations, [{ kind: "scene", id: "sc-qa", quote: "主人公は夜明けに駅へ着いた。", path: manuscriptPath, revision, sceneId: "sc-qa", label: "searchScenes result" }]);
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
        ? JSON.stringify({ summaryLines: ["彼女が駅へ来た。", "彼が手紙を渡した。", "二人は別れた。"], characters: ["彼女"], stateChanges: [] })
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
    "plot/volumes/vol-main/chapters/ch-summary/scenes/sc-summary.yaml": "id: sc-summary\ntype: scene\nchapter: ch-summary\norder: 1\ntitle: Station\nmanuscript: manuscript/vol-main/ch-summary/sc-summary.md\n",
    "manuscript/vol-main/ch-summary/sc-summary.md": "彼女は駅へ来た。彼は手紙を渡した。二人は別れを告げた。",
  };
  const store: ModelUsageStore = { async append() {}, async list() { return { events: [] }; } };
  const operations: ChangeOperation[][] = [];
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
