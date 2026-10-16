import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangeOperation, ChangeProposal, ModuleActionContext, ModuleContext, SnapshotId } from "@scriptorium/contracts";
import { createModule } from "./index.js";

const snapshot: SnapshotId = {
  repository: { provider: "local", repositoryId: "nlp-feature-consent", defaultBranch: "main", ownerScope: "local-owner", url: "file:///nlp-feature-consent" },
  remoteCommit: "c".repeat(40),
};

test("source LLM reactions are external features with deny-by-default and explicit proposal consent", async () => {
  const moduleContext = {
    cacheDirectory: "/tmp/scriptorium-nlp-feature-consent-test",
    signal: new AbortController().signal,
    async acquireCapability() { throw new Error("tokenizer is not used by feature-consent actions"); },
    async createWorkerService() { throw new Error("tokenizer worker is not used by feature-consent actions"); },
  } as unknown as ModuleContext;
  const definition = await createModule(moduleContext);
  const featuresAction = definition.actions?.find((item) => item.id === "nlp.features");
  const consentAction = definition.actions?.find((item) => item.id === "nlp.updateExternalConsent");
  assert.ok(featuresAction);
  assert.ok(consentAction);

  let selectedSnapshot = snapshot;
  let settingsContent = `${JSON.stringify({ externalEnabled: { "setting-qa": false } })}\n`;
  const reader = {
    get snapshot() { return selectedSnapshot; },
    async read(path: string) { return path === "meta/scriptorium/modules/nlp/feature-settings.json" ? { content: settingsContent, revision: `revision-${selectedSnapshot.remoteCommit}` } : null; },
    async list() { return []; },
  };
  const proposals: ChangeProposal[] = [];
  const context = {
    projectId: "nlp-feature-consent",
    reader,
    signal: new AbortController().signal,
    async invoke() { throw new Error("feature-consent actions do not compose other actions"); },
    async listActions() { return []; },
    async linkedReader() { throw new Error("feature-consent actions do not read linked projects"); },
    async runJob() { throw new Error("feature-consent actions do not run model jobs"); },
    async propose(operations: ChangeOperation[], evidence?: ChangeProposal["evidence"], proposalId?: string) {
      const proposal: ChangeProposal = { id: proposalId ?? "feature-consent", snapshot: reader.snapshot, operations, source: "module", ...(evidence ? { evidence } : {}) };
      proposals.push(proposal);
      return proposal;
    },
  } as unknown as ModuleActionContext;

  const initial = await featuresAction.invoke(featuresAction.inputSchema.parse({}), context);
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  const listed = initial.data as { features: Array<{ id: string; label: string; locality: "local" | "external"; enabled: boolean }> };
  for (const [id, label] of [["first-read-reaction", "初読リアクション"], ["state-event-draft", "状態イベント草案"]] as const) {
    const feature = listed.features.find((item) => item.id === id);
    assert.deepEqual(feature, { id, label, locality: "external", enabled: false }, `${id} has no implicit external-send consent`);
  }

  assert.throws(
    () => consentAction.inputSchema.parse({ externalEnabled: { "unmapped-feature": true } }),
    /unsupported feature flag/u,
    "only declared external feature IDs are accepted",
  );
  const consent = await consentAction.invoke(consentAction.inputSchema.parse({
    externalEnabled: { "first-read-reaction": true, "state-event-draft": true },
  }), context);
  assert.equal(consent.ok, true);
  assert.equal(proposals.length, 1);
  const write = proposals[0]?.operations[0]?.writes[0];
  assert.equal(write?.path, "meta/scriptorium/modules/nlp/feature-settings.json");
  const proposedSettings = JSON.parse(write?.content ?? "{}") as { externalEnabled: Record<string, boolean> };
  assert.deepEqual(proposedSettings.externalEnabled, {
    "setting-qa": false,
    "first-read-reaction": true,
    "state-event-draft": true,
  });

  const beforeApproval = await featuresAction.invoke(featuresAction.inputSchema.parse({}), context);
  assert.equal(beforeApproval.ok, true);
  if (beforeApproval.ok) {
    const features = (beforeApproval.data as typeof listed).features;
    assert.equal(features.find((item) => item.id === "first-read-reaction")?.enabled, false, "a proposal does not activate consent before the selected snapshot changes");
    assert.equal(features.find((item) => item.id === "state-event-draft")?.enabled, false);
  }

  settingsContent = write?.content ?? settingsContent;
  selectedSnapshot = { ...snapshot, remoteCommit: "d".repeat(40) };
  const afterApproval = await featuresAction.invoke(featuresAction.inputSchema.parse({}), context);
  assert.equal(afterApproval.ok, true);
  if (afterApproval.ok) {
    const features = (afterApproval.data as typeof listed).features;
    assert.equal(features.find((item) => item.id === "first-read-reaction")?.enabled, true);
    assert.equal(features.find((item) => item.id === "state-event-draft")?.enabled, true);
  }
});
