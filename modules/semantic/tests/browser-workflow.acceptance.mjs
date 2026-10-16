import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = resolve(packageRoot, "../..");
const { createServer } = await import(pathToFileURL(resolve(workspaceRoot, "app/node_modules/vite/dist/node/index.js")).href);
const repository = {
  provider: "local",
  repositoryId: "semantic-browser-fixture",
  defaultBranch: "main",
  ownerScope: "owner-1",
  url: "file:///synthetic/semantic-browser-fixture",
};
const snapshot = { repository, remoteCommit: "a".repeat(40) };
const calls = [];
let activeTask;
let rejectRebuild;

const server = await createServer({
  configFile: false,
  root: packageRoot,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  optimizeDeps: { include: ["react", "react-dom/client"] },
});
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.SCRIPTORIUM_E2E_CHROMIUM ? { executablePath: process.env.SCRIPTORIUM_E2E_CHROMIUM } : {}),
  });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/tests/browser-workflow.html`);
  await page.exposeFunction("semanticInvoke", async (actionId, input) => {
    calls.push({ actionId, input });
    if (actionId === "semantic.search") return {
      ok: true, snapshot,
      data: { query: input.query, mode: input.mode, model: "Xenova/multilingual-e5-small", modelVersion: "761b726dd34fb83930e26aab4e9ac3899aa1fa78", ...(input.rerank ? { rerankWarning: "semantic_reranker_unavailable" } : {}), results: [
        { sceneId: "sc-station", sentenceIndex: 0, name: "Station", type: "scene", snippet: "夜遅く駅に着いた。", score: 0.04 },
      ] },
    };
    if (actionId === "semantic.expressions.search") return {
      ok: true, snapshot,
      data: { query: input.query, mode: "expression", modelVersion: "761b726dd34fb83930e26aab4e9ac3899aa1fa78", results: [
        { sceneId: "sc-station", sentenceIndex: 0, name: "Station", type: "scene", snippet: "夜遅く駅に着いた。", score: 0.91 },
      ] },
    };
    if (actionId === "semantic.contradictions.rebuild") return {
      ok: true, snapshot,
      data: { indexAvailable: false, count: 1, candidates: [
        { id: "rule:item-owner-mismatch:sc-1:sc-2:char-1:item-1", kind: "rule_ownership", score: 1, suspicion: "Synthetic item ownership conflict", evidenceA: { sceneId: "sc-1", quote: "Scene one owns item." }, evidenceB: { sceneId: "sc-2", quote: "Scene two uses item." } },
      ] },
    };
    if (actionId === "semantic.contradictions.dismiss") return {
      ok: true, snapshot,
      data: { candidateId: input.candidateId, dismissed: true, proposal: { id: "proposal-dismissal-1" } },
    };
    if (actionId === "semantic.index.status") return {
      ok: true, snapshot,
      data: { indexAvailable: false, passageCount: 0, indexUpdatedAt: null, modelVersion: "761b726dd34fb83930e26aab4e9ac3899aa1fa78", modelLoaded: false },
    };
    if (actionId === "semantic.settings.read") return {
      ok: true, snapshot,
      data: { settings: { schemaVersion: 1, rerankerEnabled: false }, models: { reranker: { id: "mogolloni/bge-reranker-v2-m3-onnx" } } },
    };
    if (actionId === "semantic.settings.update") return {
      ok: true, snapshot,
      data: { settings: { schemaVersion: 1, rerankerEnabled: input.rerankerEnabled }, proposal: { id: "proposal-settings-1" } },
    };
    if (actionId === "semantic.index.rebuild") {
      activeTask = { taskId: input.taskId, phase: "embedding", completed: 2, total: 4 };
      return await new Promise((_resolve, reject) => { rejectRebuild = reject; });
    }
    if (actionId === "semantic.task.status") return { ok: true, snapshot, data: { activeTasks: activeTask ? [activeTask] : [] } };
    if (actionId === "semantic.task.cancel") {
      const cancelled = activeTask?.taskId === input.taskId;
      activeTask = undefined;
      rejectRebuild?.(new Error("Synthetic semantic task cancelled"));
      return { ok: true, snapshot, data: { taskId: input.taskId, cancelled } };
    }
    throw new Error(`Unexpected semantic action ${actionId}`);
  });

  await page.evaluate(async ({ origin, snapshot }) => {
    const { browserModule } = await import(`${origin}/src/browser.ts`);
    const context = {
      projectId: "semantic-browser-fixture",
      snapshot,
      signal: new AbortController().signal,
      invoke: (actionId, input) => window.semanticInvoke(actionId, input),
      propose: async () => { throw new Error("The semantic browser must use registered proposal actions"); },
      refresh: async () => {},
    };
    window.semanticContext = context;
    window.semanticMount = async (id) => {
      window.semanticUnmount = await browserModule.mount(id, document.getElementById("semantic-root"), context);
    };
  }, { origin, snapshot });

  await page.evaluate(() => window.semanticMount("semantic.search"));
  assert.equal(await page.evaluate(() => window.semanticContext.projectId), "semantic-browser-fixture");
  assert.deepEqual(await page.evaluate(() => window.semanticContext.snapshot), snapshot);
  await page.waitForTimeout(100);
  await page.getByLabel("検索語").fill("夜遅く 駅");
  await page.getByLabel("上位30件を CPU 再ランキング").check();
  await page.getByRole("button", { name: "検索" }).click();
  await page.getByText("夜遅く駅に着いた。", { exact: true }).waitFor();
  const searchCall = calls.findLast((call) => call.actionId === "semantic.search");
  assert.equal(searchCall?.input.query, "夜遅く 駅");
  assert.equal(searchCall?.input.mode, "scene");
  assert.equal(searchCall?.input.limit, 20);
  assert.equal(searchCall?.input.rerank, true);
  assert.match(searchCall?.input.taskId ?? "", /^[0-9a-f-]{36}$/);
  assert.match(await page.locator("output").textContent(), /1 件/);
  assert.match(await page.locator("output").textContent(), /semantic_reranker_unavailable/);
  await page.evaluate(() => window.semanticUnmount());

  await page.evaluate(() => window.semanticMount("semantic.expressions"));
  await page.getByLabel("検索語").fill("雨の描写");
  await page.getByRole("button", { name: "検索" }).click();
  await page.getByText("夜遅く駅に着いた。", { exact: true }).waitFor();
  const expressionCall = calls.findLast((call) => call.actionId === "semantic.expressions.search");
  assert.equal(expressionCall?.input.query, "雨の描写");
  assert.equal(expressionCall?.input.mode, "expression");
  await page.evaluate(() => window.semanticUnmount());

  await page.evaluate(() => window.semanticMount("semantic.contradictions"));
  await page.getByText("Synthetic item ownership conflict", { exact: true }).waitFor();
  await page.getByRole("button", { name: "棄却案を作成" }).click();
  await page.getByText(/proposal-dismissal-1/).waitFor();
  const dismissalCall = calls.findLast((call) => call.actionId === "semantic.contradictions.dismiss");
  assert.equal(dismissalCall?.input.candidateId, "rule:item-owner-mismatch:sc-1:sc-2:char-1:item-1");
  await page.evaluate(() => window.semanticUnmount());

  await page.evaluate(() => window.semanticMount("semantic.index"));
  await page.getByText(/プロジェクト内容は外部へ送信しません/).waitFor();
  await page.waitForTimeout(100);
  const rerankSetting = page.getByLabel("CPU 再ランキングを既定で有効にする");
  await rerankSetting.check();
  await page.getByRole("button", { name: "インデックスを再構築" }).click();
  await page.waitForFunction(() => document.querySelector("output")?.textContent?.includes("embedding · 2/4"));
  await page.getByRole("button", { name: "キャンセル" }).click();
  await page.getByText(/Synthetic semantic task cancelled/).waitFor();
  assert.ok(calls.some((call) => call.actionId === "semantic.task.cancel"));
  assert.equal(await page.getByRole("button", { name: "インデックスを再構築" }).isDisabled(), false);
  await page.getByRole("button", { name: "再ランキング設定案を作成" }).click();
  await page.getByText(/proposal-settings-1/).waitFor();
  const settingsCall = calls.findLast((call) => call.actionId === "semantic.settings.update");
  assert.deepEqual(settingsCall?.input, { rerankerEnabled: true });
  assert.deepEqual(pageErrors, []);
  await page.evaluate(() => window.semanticUnmount());
  await page.close();
  console.log("PASS: Chromium mounted semantic search, expression, contradiction review and settings contributions; action IDs, snapshot context, progress, cancellation and proposal feedback remained wired.");
} finally {
  await browser?.close();
  await server.close();
}
