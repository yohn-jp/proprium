import assert from "node:assert/strict";
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
    assert.equal(definition.http?.length, 1);
    assert.equal(definition.http?.[0]?.path, "rewrite/stream");
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

  const result = await action.invoke({ terms: ["夜明け"] }, actionContext);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "assistant_privacy_denied");
  assert.equal(capabilityAcquisitions, 0);
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
