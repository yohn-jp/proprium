import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
const schemaPath = process.env.PROPRIUM_AUTHORING_SCHEMA ?? fileURLToPath(new URL("../../app/src/browser/proprium/authoring/schema.ts", import.meta.url));
const { assertDescriptor, assertSurface, assertValue } = await import(pathToFileURL(schemaPath).href);
import { createResearchHandlers } from "./guest.js";

test("Research official manifest declares every implemented action and only actionable Host surfaces", async () => {
  const metadata = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8")) as {
    schema: string; id: string; abi: string; capabilities: string[];
    actions: unknown[]; ui: unknown[]; asset_groups: unknown[]; dependencies: unknown[];
  };
  assert.equal(metadata.schema, "proprium.plugin/v2");
  assert.equal(metadata.id, "proprium.research");
  assert.equal(metadata.abi, "proprium.component/v2");
  assert.equal(metadata.asset_groups.length, 1);
  assert.deepEqual(metadata.asset_groups[0], {
    id: "proprium.research.ipadic",
    manifest_path: "proprium/research/assets/manifests/66601c7e3f8ed946df567a97644135bfec786d79f5b28f2b5adbb54258fe5d07/assets.json",
    sha256: "66601c7e3f8ed946df567a97644135bfec786d79f5b28f2b5adbb54258fe5d07",
    bytes: 3761, role: "dictionary",
  });
  assert.deepEqual(metadata.dependencies, []);

  const handlers = createResearchHandlers();
  const actionIds = metadata.actions.map((value) => {
    assertDescriptor(value);
    return value.action_id;
  });
  assert.equal(new Set(actionIds).size, actionIds.length);
  assert.deepEqual([...actionIds].sort(), Object.keys(handlers).sort());
  assert.ok(metadata.ui.length > 0);
  const surfaceIds = new Set<string>();
  const bindings: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (typeof row.action_id === "string") {
      assert.ok(row.input_template && typeof row.input_template === "object" && !Array.isArray(row.input_template));
      bindings.push(row.action_id);
    }
    for (const child of Object.values(row)) visit(child);
  };
  for (const raw of metadata.ui) {
    assert.ok(raw && typeof raw === "object" && !Array.isArray(raw));
    assertSurface(raw);
    const surface = raw as Record<string, unknown>;
    assert.equal(typeof surface.id, "string");
    assert.ok(!surfaceIds.has(surface.id as string), `duplicate UI surface ${String(surface.id)}`);
    surfaceIds.add(surface.id as string);
    assert.equal(surface.kind, "panel");
    assert.equal(typeof surface.title, "string");
    assert.ok(surface.context && typeof surface.context === "object" && !Array.isArray(surface.context));
    assert.ok(surface.body && typeof surface.body === "object" && !Array.isArray(surface.body));
    visit(surface.body);
  }
  assert.ok(bindings.length > 0);
  for (const actionId of bindings) assert.ok(actionIds.includes(actionId), `surface binding references undeclared action ${actionId}`);
});

test("search fusion accepts typed Host action results only from the user interface", async () => {
  const metadata = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));
  const action = metadata.actions.find((item: any) => item.action_id === "research.search.fuse");
  assert.equal(action.effect, "read");
  assert.deepEqual(action.callers, ["ui"]);
  assert.ok(action.required_capabilities.includes("workspace.file.read"));
  assert.ok(action.required_capabilities.includes("workspace.derived.cache"));
  assert.ok(!action.required_capabilities.includes("workspace.change.propose"));
});

test("synonym contracts support absent groups and revision-bound add or merge proposals", async () => {
  const metadata = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));
  const lookup = metadata.actions.find((item: any) => item.action_id === "research.synonyms.get");
  const propose = metadata.actions.find((item: any) => item.action_id === "research.synonyms.propose");

  assertValue(lookup.output_schema, { group: null, alternatives: [], fileRevision: null }, "empty synonym lookup");
  assertValue(propose.input_schema, { words: ["灯", "明かり"], expectedFileRevision: null }, "new synonym group");
  assertValue(propose.input_schema, {
    words: ["山", "峰"], context: "positive",
    mergeGroupRef: { fileRevision: "a".repeat(64), ordinal: 0, words: ["山", "丘"], context: "positive" },
    expectedFileRevision: "a".repeat(64),
  }, "revision-bound synonym merge");
});

test("analyzer exposes local literal analysis and its results", async () => {
  const metadata = JSON.parse(await readFile(new URL("./plugin.json", import.meta.url), "utf8"));
  const surface = metadata.ui.find((item: any) => item.id === "nlp.analyzer");
  assert.equal(surface.body.type, "tabs");
  const form = surface.body.tabs.find((item: any) => item.id === "analysis-input").body;
  assert.equal(form.submit.action_id, "research.nlp.analyze");
  assert.deepEqual(form.submit.input_template.source, { kind: "literal" });
  assert.deepEqual(form.submit.input_template.text, { data_key: "form.text" });
  assert.deepEqual(surface.body.tabs.find((item: any) => item.id === "analysis-tokens").body.rows, { data_key: "last_action_result.tokens" });
});
