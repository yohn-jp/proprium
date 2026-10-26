import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import type { ActionRequest, ActionResult, ChangeSet, Snapshot } from "../../../app/src/browser/proprium/authoring/types.js";
import { guest } from "./guest.js";
import { hashDialogueText, splitIntoSentenceOffsets } from "./index.js";

const sceneId = "scene-1";
const scenePath = "plot/volumes/v1/chapters/c1/scenes/scene-1.yaml";
const manuscriptPath = "plot/volumes/v1/chapters/c1/scenes/scene-1.md";
const taroPath = "plot/characters/taro.yaml";
const hanakoPath = "plot/characters/hanako.yaml";
const manuscript = "太郎は壁を見た。「行くよ。」\n花子はうなずいた。「そうね。」";
const lines = splitIntoSentenceOffsets(manuscript).map((span) => manuscript.slice(span.start, span.end));
const files = new Map<string, { bytes: Uint8Array; revision: string }>();
interface FixtureScene {
  id: string;
  title: string;
  scenePath: string;
  manuscriptPath: string;
  text: string;
  sceneRevision: string;
  manuscriptRevision: string;
  metadata: string;
}
const hostSchemaModulePath: string = "../../../app/src/browser/proprium/authoring/schema.js";
const hostSchema = await import(hostSchemaModulePath) as {
  assertDescriptor(value: unknown): void;
  assertValue(schema: never, value: unknown, phase?: string): void;
};
const speakerManifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8")) as {
  actions: Array<{ action_id: string; input_schema: unknown; output_schema: unknown; [key: string]: unknown }>;
};
const descriptors = new Map(speakerManifest.actions.map((descriptor) => [descriptor.action_id, descriptor]));

function assertOutput(actionId: string, value: unknown): void {
  const descriptor = descriptors.get(actionId);
  assert.ok(descriptor, `missing Speaker descriptor for ${actionId}`);
  hostSchema.assertValue(descriptor.output_schema as never, value, `Speaker ${actionId} output`);
}

function assertInput(actionId: string, value: unknown): void {
  const descriptor = descriptors.get(actionId);
  assert.ok(descriptor, `missing Speaker descriptor for ${actionId}`);
  hostSchema.assertValue(descriptor.input_schema as never, value, `Speaker ${actionId} input`);
}

function bytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
function revision(name: string): string { return `revision:${name}`; }

function fixture(options: { training?: boolean } = {}) {
  files.clear();
  let sceneConfigs: FixtureScene[];
  if (options.training) {
    const trainingText = Array.from({ length: 12 }, (_, index) => `太郎は言った。「セリフ${index}。」`).join("\n");
    const trainingLines = splitIntoSentenceOffsets(trainingText).map((span, index) => ({
      sentenceIndex: index + 1, text: trainingText.slice(span.start, span.end),
    })).filter((row) => row.text.startsWith("「"));
    sceneConfigs = ["scene-training-a", "scene-training-b"].map((id) => {
      const path = `plot/volumes/v1/chapters/c1/scenes/${id}.yaml`;
      const textPath = `plot/volumes/v1/chapters/c1/scenes/${id}.md`;
      const metadata = `id: ${id}\nname: ${id}\nspeakerCount: 2\nappears: [char-taro, char-hanako]\nspeakerOverrides:\n${trainingLines.map(({ sentenceIndex, text }) => `  - sentenceIndex: ${sentenceIndex}\n    textHash: ${hashDialogueText(text)}\n    dialogueText: ${JSON.stringify(text)}\n    speakerEntityId: char-taro`).join("\n")}\n`;
      return { id, title: id, scenePath: path, manuscriptPath: textPath, text: trainingText,
        sceneRevision: revision(`${id}-scene`), manuscriptRevision: revision(`${id}-manuscript`), metadata };
    });
  } else {
    const metadata = `id: ${sceneId}\nname: First meeting\nspeakerCount: 2\ncustomUnknown: preserve-me\nappears: [char-taro, char-hanako]\nspeakerOverrides:\n  - dialogueText: ${JSON.stringify(lines[1])}\n    speakerEntityId: char-taro\n`;
    sceneConfigs = [{ id: sceneId, title: "First meeting", scenePath, manuscriptPath, text: manuscript,
      sceneRevision: revision("scene"), manuscriptRevision: revision("manuscript"), metadata }];
  }
  for (const scene of sceneConfigs) {
    files.set(scene.scenePath, { bytes: bytes(scene.metadata), revision: scene.sceneRevision });
    files.set(scene.manuscriptPath, { bytes: bytes(scene.text), revision: scene.manuscriptRevision });
  }
  files.set(taroPath, { bytes: bytes("id: char-taro\ntype: character\n"), revision: revision("taro") });
  files.set(hanakoPath, { bytes: bytes("id: char-hanako\ntype: character\n"), revision: revision("hanako") });
  files.set("meta/proprium/plugins/proprium.speaker/corrections.jsonl", {
    bytes: bytes("not valid json\r\n{\"unknownLegacyField\":true}"), revision: revision("corrections"),
  });
  const snapshot: Snapshot = { id: "snapshot-1", local_commit: "commit-1", worktree_generation: "worktree-1", draft_generation: null };
  const scope = { workspace_id: "workspace-1", repository_id: 42, branch: "main", generation: "generation-1" };
  const proposals: ChangeSet[] = [];
  const cache = new Map<string, unknown>();
  const calls: string[] = [];

  function tree(parentId: string | null) {
    const volume = { id: "v1", kind: "volume" as const, title: "Volume 1", parent_id: null, metadata_path: "plot/volumes/v1/volume.yaml", metadata_revision: revision("volume") };
    const chapter = { id: "c1", kind: "chapter" as const, title: "Chapter 1", parent_id: "v1", metadata_path: "plot/volumes/v1/chapters/c1/chapter.yaml", metadata_revision: revision("chapter") };
    const scenes = sceneConfigs.map((scene, order) => ({ id: scene.id, kind: "scene" as const, title: scene.title, parent_id: "c1",
      metadata_path: scene.scenePath, metadata_revision: scene.sceneRevision, manuscript_path: scene.manuscriptPath, order: order + 1 }));
    const items = parentId === null ? [volume] : parentId === "v1" ? [chapter] : parentId === "c1" ? scenes : [];
    return { parent_id: parentId, tree_revision: "tree-1", items, next_cursor: null, diagnostics: [] };
  }

  function action(pluginId: string, actionId: string, input: Record<string, unknown>): ActionResult {
    if (pluginId === "proprium.research" && actionId === "research.nlp.analyze") {
      return { request_id: "nested", scope, snapshot, ok: false,
        error: { code: "dependency_unavailable", message: "Local tokenizer is unavailable", retryable: true } };
    }
    const value = (() => {
      if (pluginId === "proprium.narrative" && actionId === "proprium.narrative.hierarchy.tree") return tree(input.parent_id as string | null);
      if (pluginId === "proprium.narrative" && actionId === "proprium.narrative.scene.context") {
        const selected = sceneConfigs.find((scene) => scene.id === input.scene_id);
        if (!selected) throw Object.assign(new Error("missing scene"), { code: "scene_not_found" });
        return { scene_id: selected.id, title: selected.title, volume: { id: "v1", title: "Volume 1" }, chapter: { id: "c1", title: "Chapter 1" },
          manuscript_path: selected.manuscriptPath, metadata_revision: selected.sceneRevision, manuscript_revision: selected.manuscriptRevision, diagnostics: [] };
      }
      if (pluginId === "proprium.knowledge" && actionId === "knowledge.scene.context") return {
        sceneId: input.sceneId, appears: ["char-taro", "char-hanako"], povId: "char-taro",
        entityCards: [
          { id: "char-taro", type: "character", name: "太郎", aliases: [], raw: {}, filePath: taroPath, fileRevision: revision("taro") },
          { id: "char-hanako", type: "character", name: "花子", aliases: [], raw: { voice_profiles: [{ id: "calm", firstPerson: ["私"], unknown: "preserve" }] }, filePath: hanakoPath, fileRevision: revision("hanako") },
        ], sourceFiles: [{ path: taroPath, revision: revision("taro") }, { path: hanakoPath, revision: revision("hanako") }],
      };
      if (pluginId === "proprium.knowledge" && actionId === "knowledge.entities.get") {
        const id = input.id;
        if (id === "char-taro") return { entity: { id, type: "character", name: "太郎", raw: {} } };
        if (id === "char-hanako") return { entity: { id, type: "character", name: "花子", raw: {} } };
        throw Object.assign(new Error("missing character"), { code: "file_not_found" });
      }
      if (pluginId === "proprium.knowledge" && actionId === "knowledge.entities.list") return { items: [], nextCursor: null };
      throw Object.assign(new Error(`Unexpected nested action ${pluginId}.${actionId}`), { code: "invalid_input" });
    })();
    return { request_id: "nested", scope, snapshot, ok: true, value, warnings: [] };
  }

  function host(operation: string, payload: Record<string, unknown>): unknown {
    calls.push(operation);
    if (operation === "workspace.plugin.invoke") {
      const input = payload.input as Record<string, unknown>;
      const result = action(payload.plugin_id as string, payload.action_id as string, input);
      if (!result.ok) throw result.error;
      return result;
    }
    if (operation === "workspace.file.list") {
      const prefix = payload.prefix as string | undefined;
      const entries = [...files].filter(([path]) => !prefix || path === prefix || path.startsWith(`${prefix}/`)).map(([path, file]) => ({
        path, revision: file.revision, byte_length: file.bytes.length, media_type: path.endsWith(".yaml") || path.endsWith(".md") || path.endsWith(".jsonl") ? "text/plain" : "application/octet-stream",
      }));
      return { entries, next_cursor: null };
    }
    if (operation === "workspace.file.read") {
      const file = files.get(payload.path as string);
      if (!file) throw Object.assign(new Error(`missing ${String(payload.path)}`), { code: "file_not_found" });
      const offset = payload.offset as number;
      const length = payload.length as number;
      const end = Math.min(file.bytes.length, offset + length);
      return { revision: file.revision, total_bytes: file.bytes.length, offset,
        bytes: Array.from(file.bytes.slice(offset, end)), next_offset: end < file.bytes.length ? end : null };
    }
    if (operation === "workspace.derived.cache.get") {
      const key = (payload.key as { key: string }).key;
      return cache.has(key) ? { found: true, value: cache.get(key) } : { found: false };
    }
    if (operation === "workspace.derived.cache.put") {
      const key = (payload.key as { key: string }).key;
      cache.set(key, payload.value);
      return { stored: true };
    }
    if (operation === "workspace.change.timestamp") return { timestamp: "2026-10-26T00:00:00.000Z" };
    if (operation === "workspace.change.propose") {
      proposals.push(payload.changeset as ChangeSet);
      return { proposal_id: `proposal-${proposals.length}`, status: "proposed" };
    }
    throw Object.assign(new Error(`Unexpected Host operation ${operation}`), { code: "invalid_input" });
  }

  return { snapshot, scope, proposals, cache, calls, host };
}

async function invoke(actionId: string, input: Record<string, unknown>, options: { idempotencyKey?: string; setup?: ReturnType<typeof fixture> } = {}) {
  assertInput(actionId, input);
  const state = options.setup ?? fixture();
  guest.initialize({ pluginId: "proprium.speaker", version: "0.1.0", workspaceId: state.scope.workspace_id });
  const request: ActionRequest = {
    schema_version: 1, request_id: `request-${actionId}`, plugin_id: "proprium.speaker", action_id: actionId,
    scope: state.scope, snapshot: state.snapshot, input, deadline_ms: 30_000,
    ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}),
  };
  try {
    let raw = guest.invoke(JSON.stringify(request));
    while (true) {
      const message = JSON.parse(raw) as { kind?: string; call_id?: string; operation?: string; payload?: Record<string, unknown>; ok?: boolean; value?: unknown; error?: { code: string; message: string; retryable: boolean } };
      if (message.kind === "host_call") {
        try {
          const value = state.host(message.operation!, message.payload ?? {});
          raw = guest.invoke(JSON.stringify({ kind: "host_response", call_id: message.call_id, ok: true, value }));
        } catch (error) {
          const failure = error as { code?: string; message?: string };
          raw = guest.invoke(JSON.stringify({ kind: "host_response", call_id: message.call_id, ok: false,
            error: { code: failure.code ?? "guest_trap", message: failure.message ?? "Host call failed", retryable: false } }));
        }
        continue;
      }
      const result = message as unknown as ActionResult;
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      assertOutput(actionId, result.value);
      return { value: result.value as Record<string, unknown>, state };
    }
  } finally {
    guest.dispose();
  }
}

test("all Speaker action descriptors pass the adopted bounded-schema validator", () => {
  assert.equal(speakerManifest.actions.length, 12);
  for (const descriptor of speakerManifest.actions) hostSchema.assertDescriptor(descriptor as never);
});

test("scene, queue, preview, count, dialogue, profile, and gate actions return schema-valid values", async () => {
  const { value: inventory } = await invoke("speaker.scenes.list", {});
  assert.equal((inventory.scenes as Array<Record<string, unknown>>)[0]?.scene_id, sceneId);

  const { value: attribution } = await invoke("speaker.attribute", { scene_id: sceneId });
  const first = (attribution.attributions as Array<Record<string, unknown>>)[0]!;
  const { value: queue } = await invoke("speaker.review.queue", { limit: 50 });
  assert.ok(Array.isArray(queue.rows));

  const { value: preview } = await invoke("speaker.override", {
    mode: "preview-group", scene_id: sceneId, sentence_index: first.sentence_index,
    dialogue_text: first.text, text_hash: first.text_hash, speaker_entity_id: null,
  });
  assert.ok(Array.isArray(preview.affected_lines));

  const countKey = "count-schema-key";
  const { value: countProposal } = await invoke("speaker.count.update", {
    scene_id: sceneId, speaker_count: 3, idempotency_key: countKey,
  }, { idempotencyKey: countKey });
  assert.equal((countProposal.preview as Record<string, unknown>).speaker_count, 3);

  const { value: dialogue } = await invoke("speaker.dialogue.list", { character_id: "char-taro", limit: 20 });
  assert.ok(Array.isArray(dialogue.lines));
  const { value: profiles } = await invoke("speaker.voice.profiles", {});
  assert.ok(Array.isArray(profiles.fingerprints));
  const { value: gates, state: gateState } = await invoke("speaker.ruleGates", {});
  assert.equal(gates.exists, false);
  gateState.cache.set("speaker.ruleGates", { version: 1,
    gates: { "attribution-verb": { action: "demote", measuredPrecision: 0.5, sampleSize: 20 } },
    provenance: { snapshot: gateState.snapshot, reason: "schema-fixture" } });
  const { value: populatedGates } = await invoke("speaker.ruleGates", {}, { setup: gateState });
  assert.equal((populatedGates.gates as Record<string, { action: string }>)?.["attribution-verb"]?.action, "demote");
});

test("retraining emits a bounded held-out model candidate without proposing during dry run", async () => {
  const setup = fixture({ training: true });
  const { value: corpus } = await invoke("speaker.attribute", { scene_id: "scene-training-a" }, { setup });
  assert.equal((corpus.attributions as unknown[]).length, 12);
  const key = "training-schema-key";
  const { value, state } = await invoke("speaker.retraining.run", {
    dry_run: true, idempotency_key: key,
  }, { idempotencyKey: key, setup });
  assert.ok((value.train_example_count as number) >= 10);
  assert.equal(value.adoption_proposal, null);
  assert.equal(state.proposals.length, 0);
  assert.deepEqual(value.holdout_scene_ids, ["scene-training-a"]);
});

test("guest attribution uses explicit Narrative and Knowledge contracts and returns exact UTF-16 evidence", async () => {
  const { value, state } = await invoke("speaker.attribute", { scene_id: sceneId });
  const rows = value.attributions as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.text), [lines[1], lines[3]]);
  for (const row of rows) {
    const source = row.evidence as Array<{ source_span: { start: number; end: number; quote: string } }>;
    const span = source[0]!.source_span;
    assert.equal(manuscript.slice(span.start, span.end), span.quote);
    assert.deepEqual(row.source_span, { path: manuscriptPath, revision: revision("manuscript"), ...span });
    assert.equal(row.text_hash, hashDialogueText(row.text as string));
  }
  assert.ok(state.calls.includes("workspace.file.read"));
  assert.ok(state.calls.includes("workspace.derived.cache.get"));
  assert.equal(state.proposals.length, 0);
});

test("voice check reports reduced-tokenizer availability and keeps source-bound attribution rows", async () => {
  const { value } = await invoke("speaker.voice.check", { scene_id: sceneId });
  assert.deepEqual(value.availability, { declared: "available", learned_style: "unavailable", stylometric: "unavailable" });
  const rows = value.attributions as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  assert.equal((rows[0]!.source_span as Record<string, unknown>).path, manuscriptPath);
  assert.equal((value.provenance as Record<string, unknown>).draft_generation, null);
});

test("correction proposal preserves unknown YAML and appends correction bytes without rewriting the old log", async () => {
  const { value: analysis, state } = await invoke("speaker.attribute", { scene_id: sceneId });
  const first = (analysis.attributions as Array<Record<string, unknown>>)[0]!;
  const key = "correction-key-1";
  const { value } = await invoke("speaker.override", {
    mode: "propose", scene_id: sceneId,
    items: [{ sentence_index: first.sentence_index, dialogue_text: first.text, text_hash: first.text_hash,
      predicted_speaker_entity_id: first.speaker_entity_id, predicted_reason: first.reason,
      speaker_group_id: first.speaker_group_id, speaker_entity_id: "char-hanako", label: "direct" }],
    idempotency_key: key,
  }, { idempotencyKey: key, setup: state });
  assert.equal(value.proposal_id, "proposal-1");
  assert.equal(state.proposals.length, 1);
  const change = state.proposals[0]!;
  assert.deepEqual(change.read_set.find((entry) => entry.path === scenePath), { path: scenePath, revision: revision("scene") });
  const sceneOperation = change.units[0]!.operations.find((operation) => operation.path === scenePath)!;
  const updatedScene = parse(new TextDecoder().decode(Uint8Array.from(sceneOperation.content!))) as Record<string, unknown>;
  assert.equal(updatedScene.customUnknown, "preserve-me");
  assert.equal(updatedScene.speakerCount, 2);
  assert.equal((updatedScene.speakerOverrides as Array<Record<string, unknown>>).at(-1)?.speakerEntityId, "char-hanako");
  const oldLog = bytes("not valid json\r\n{\"unknownLegacyField\":true}");
  const logOperation = change.units[0]!.operations.find((operation) => operation.path.endsWith("corrections.jsonl"))!;
  const updatedLog = Uint8Array.from(logOperation.content!);
  assert.deepEqual([...updatedLog.slice(0, oldLog.length)], [...oldLog]);
  assert.equal(updatedLog[oldLog.length], 10);
  assert.equal(new TextDecoder().decode(updatedLog.slice(oldLog.length + 1)).trim().split("\n").length, 1);
  assert.equal(state.calls.includes("workspace.change.propose"), true);
});

test("evaluation and gate caches are snapshot-keyed and latest reads only validated report shapes", async () => {
  const { value: run, state } = await invoke("speaker.evaluation.run", { update_rule_gates: true });
  assert.equal(run.cache_stored, true);
  assert.equal(run.gates_updated, true);
  assert.ok(state.cache.has("speaker.evaluation"));
  assert.ok(state.cache.has("speaker.ruleGates"));
  const { value: latest } = await invoke("speaker.evaluation.latest", {}, { setup: state });
  assert.equal(latest.exists, true);
  assert.equal((latest.report as Record<string, unknown>).counts && typeof (latest.report as Record<string, unknown>).counts, "object");
});
