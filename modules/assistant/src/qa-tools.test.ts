import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantQaTools, type AssistantQaReadCapabilities } from "./qa-tools.js";

type ExecutableTool = { execute?: (input: Record<string, unknown>) => Promise<unknown> };

async function runTool(tools: ReturnType<typeof createAssistantQaTools>, name: string, input: Record<string, unknown>): Promise<unknown> {
  const execute = (tools[name] as unknown as ExecutableTool | undefined)?.execute;
  assert.equal(typeof execute, "function", `${name} should expose an executable tool`);
  return execute!(input);
}

function rows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value as Record<string, unknown>[];
}

test("search tools call only their read capabilities and keep bounded source citations", async () => {
  const calls: string[] = [];
  const reads: AssistantQaReadCapabilities = {
    async semanticSearch(input) {
      calls.push(`semantic:${input.mode}:${input.limit}:${input.rerank}`);
      return { results: [
        { sceneId: "scene-1", type: "scene", snippet: "x".repeat(500), score: 0.9, sentenceIndex: 4, filePath: "manuscript/a.md", revision: "rev-a" },
        { sceneId: "bible-in-scene-search", type: "character", snippet: "unrelated" },
        ...Array.from({ length: 9 }, (_, index) => ({ sceneId: `scene-${index + 2}`, type: "scene", text: `quote ${index}` })),
      ] };
    },
    async searchBible(query, entityKind) {
      calls.push(`bible:${query}:${entityKind}`);
      return { results: [
        ...Array.from({ length: 9 }, (_, index) => ({ id: `character-${index}`, type: "character", name: `Name ${index}`, snippet: "bio", path: "bible/characters.yaml", revision: "rev-b" })),
        { id: "not-bible", type: "scene", name: "Scene", snippet: "ignored" },
      ] };
    },
    async worldStateAtScene() { throw new Error("not used"); },
    async readSummary() { throw new Error("not used"); },
  };
  const tools = createAssistantQaTools(reads);

  assert.deepEqual(Object.keys(tools).sort(), ["getSummary", "getWorldState", "searchBible", "searchScenes"]);
  const sceneResult = rows(await runTool(tools, "searchScenes", { query: "question" }));
  assert.equal(calls[0], "semantic:scene:8:false");
  assert.equal(sceneResult.length, 8);
  assert.equal(sceneResult[0]?.id, "scene-1");
  assert.equal((sceneResult[0]?.quote as string).length, 400);
  assert.deepEqual(sceneResult[0]?.citation, {
    sourceId: "scene-1", quote: "x".repeat(400), path: "manuscript/a.md", revision: "rev-a",
  });

  const bibleResult = rows(await runTool(tools, "searchBible", { query: "Nina", entityKind: "character" }));
  assert.equal(calls[1], "bible:Nina:character");
  assert.equal(bibleResult.length, 8);
  assert.deepEqual(bibleResult[0]?.citation, {
    sourceId: "character-0", quote: "bio", path: "bible/characters.yaml", revision: "rev-b",
  });
});

test("world-state output filters per entity and caps all returned records", async () => {
  const locations = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [
    `character-${index}`, { locationId: `place-${index}`, sinceSceneId: "scene-1" },
  ]));
  const itemOwners = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [
    `item-${index}`, { ownerCharacterId: `character-${index}`, sinceSceneId: "scene-1" },
  ]));
  const acquaintances = Array.from({ length: 40 }, (_, index) => ({ a: "character-0", b: `character-${index + 1}`, sinceSceneId: "scene-1" }));
  const tools = createAssistantQaTools({
    async semanticSearch() { return []; },
    async searchBible() { return []; },
    async worldStateAtScene() { return { locations, itemOwners, acquaintances }; },
    async readSummary() { return null; },
  });

  const all = await runTool(tools, "getWorldState", { sceneId: "scene-1" }) as Record<string, unknown>;
  assert.equal(all.sourceId, "scene-1");
  assert.equal(Object.keys(all.locations as object).length, 32);
  assert.equal(Object.keys(all.itemOwners as object).length, 32);
  assert.equal((all.acquaintances as unknown[]).length, 24);
  assert.equal(all.truncated, true);
  assert.ok((all.quote as string).length <= 400);

  const one = await runTool(tools, "getWorldState", { sceneId: "scene-1", entityId: "character-0" }) as Record<string, unknown>;
  assert.equal((one.acquaintances as unknown[]).length, 24);
  assert.deepEqual(one.location, { locationId: "place-0", sinceSceneId: "scene-1" });
  assert.equal(one.itemOwner, null);
});

test("summary output is bounded and an absent summary is an empty read", async () => {
  let requestedScope = "";
  const tools = createAssistantQaTools({
    async semanticSearch() { return []; },
    async searchBible() { return []; },
    async worldStateAtScene() { return null; },
    async readSummary(input) {
      requestedScope = input.scope;
      return { summaryLines: Array.from({ length: 20 }, () => "s".repeat(500)), path: "summary/chapter.yaml", revision: "rev-summary" };
    },
  });

  const summary = await runTool(tools, "getSummary", { scope: "chapter", id: "chapter-1" }) as Record<string, unknown>;
  assert.equal(requestedScope, "chapter");
  assert.equal((summary.summaryLines as string[]).length, 12);
  assert.equal((summary.summaryLines as string[])[0]?.length, 400);
  assert.deepEqual(summary.citation, {
    sourceId: "chapter-1", quote: "s".repeat(400), path: "summary/chapter.yaml", revision: "rev-summary",
  });

  const missingTools = createAssistantQaTools({
    async semanticSearch() { return []; }, async searchBible() { return []; },
    async worldStateAtScene() { return null; }, async readSummary() { return null; },
  });
  const missing = await runTool(missingTools, "getSummary", { scope: "volume", id: "volume-1" }) as Record<string, unknown>;
  assert.deepEqual(missing.summaryLines, []);
});

test("failures return bounded generic stubs and tool logs contain no thrown secret", async () => {
  const toolLog: Array<{ toolName: string; resultSummary: string; chars: number; input: unknown }> = [];
  const tools = createAssistantQaTools({
    async semanticSearch() { throw new Error("token=private-secret"); },
    async searchBible() { throw new Error("token=private-secret"); },
    async worldStateAtScene() { throw new Error("token=private-secret"); },
    async readSummary() { throw new Error("token=private-secret"); },
  }, toolLog);

  const output = await runTool(tools, "searchBible", { query: "question" }) as Record<string, unknown>;
  assert.deepEqual(output, { error: "searchBible unavailable" });
  assert.equal(toolLog.length, 1);
  assert.equal(toolLog[0]?.toolName, "searchBible");
  assert.equal(toolLog[0]?.chars, toolLog[0]?.resultSummary.length);
  assert.equal(toolLog[0]?.resultSummary.includes("private-secret"), false);
});
