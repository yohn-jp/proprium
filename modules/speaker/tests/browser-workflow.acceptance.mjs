import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { createModule } from "../dist/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = resolve(packageRoot, "../..");
const { createServer } = await import(pathToFileURL(resolve(workspaceRoot, "app/node_modules/vite/dist/node/index.js")).href);
const repository = {
  provider: "local",
  repositoryId: "speaker-browser-fixture",
  defaultBranch: "main",
  ownerScope: "owner-1",
  url: "file:///synthetic/speaker-browser-fixture",
};
const snapshot = { repository, remoteCommit: "a".repeat(40) };
const calls = [];
const report = {
  generatedAt: "2026-10-17T00:00:00.000Z",
  byReason: { "preceding-narration": { fired: 2, correct: 1 } },
  scenes: [{
    sceneId: "sc-1",
    textHashMatchedCount: 2,
    textHashMismatchCount: 1,
    lines: [
      { gold: "char-hero", predicted: "char-hero", reason: "preceding-narration", confidence: "high" },
      { gold: "char-hero", predicted: null, reason: "none", confidence: "none" },
    ],
  }],
  metrics: { highPrecision: 0.5, attributionAccuracy: 0.5, coverage: 1, clusteringPairwiseF1: 0, nMae: 0, nWithin1Rate: 1 },
};
const actionData = {
  "speaker.scenes.list": { scenes: [{ id: "sc-1", name: "夜の駅" }] },
  "speaker.attribute": {
    estimatedN: 1,
    fromManual: false,
    model: "scriptorium-speaker-cpu",
    modelVersion: "1.0.0",
    tokenizerModel: "lindera-wasm-nodejs-ipadic",
    tokenizerModelVersion: "2.0.0",
    candidates: [{ id: "char-hero", name: "星野" }],
    attributions: [{ sentenceIndex: 1, text: "『俺が行く。』", speakerEntityId: "char-hero", speakerGroupId: "group-1", reason: "preceding-narration", confidence: "high" }],
  },
  "speaker.voice.check": {
    issues: [{ sentenceIndex: 1, issueLabel: "想定外の一人称", source: "registered", text: "『俺が行く。』", found: "俺" }],
  },
  "speaker.review.queue": { rows: [{
    sceneId: "sc-1", sceneName: "夜の駅", speakerName: "未解決話者 1", otherResolvableCount: 2,
    candidates: [{ id: "char-hero", name: "星野" }],
    attribution: { sentenceIndex: 2, text: "『待って。』", speakerEntityId: null, speakerGroupId: "group-1", reason: "none", confidence: "none" },
  }] },
  "speaker.count.update": { proposed: true },
  "speaker.override": { proposal: { id: "speaker-confirm-1" } },
  "speaker.evaluation.latest": { exists: true, report },
  "speaker.ruleGates": { exists: true, gates: { gates: { "preceding-narration": { action: "keep", sampleSize: 2, measuredPrecision: 0.5 } } } },
  "speaker.evaluation.run": { report, gatesUpdated: false },
  "speaker.retraining.run": { trainExampleCount: 12, accuracyWithoutModel: 0.5, accuracyWithModel: 0.6, deltaPt: 10, adopted: true, adoptionProposal: { id: "model-1" } },
};
const moduleContext = {
  cacheDirectory: "/tmp/speaker-browser-test-cache",
  signal: new AbortController().signal,
  async acquireCapability() { throw new Error("browser acceptance does not run engine actions"); },
  async createWorkerService() { throw new Error("browser acceptance does not run engine actions"); },
};
const definition = await createModule(moduleContext);
for (const id of ["speaker.attribute", "speaker.voice.check", "speaker.review.queue", "speaker.override", "speaker.evaluation.run", "speaker.retraining.run"]) {
  assert.ok(definition.actions.some((action) => action.id === id), `registered action ${id}`);
}
const server = await createServer({
  configFile: false,
  root: packageRoot,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
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
  await page.exposeFunction("speakerInvoke", async (actionId, input) => {
    calls.push({ actionId, input });
    const data = actionData[actionId];
    assert.ok(data, `unknown speaker action ${actionId}`);
    return { ok: true, snapshot, data, ...(data.proposal ? { proposals: [data.proposal] } : []) };
  });
  await page.evaluate(async ({ origin, snapshot }) => {
    const { browserModule } = await import(`${origin}/src/browser.ts`);
    const context = {
      projectId: "speaker-browser-fixture",
      snapshot,
      signal: new AbortController().signal,
      invoke: (actionId, input) => window.speakerInvoke(actionId, input),
      propose: async () => { throw new Error("speaker confirmation must use its registered proposal action"); },
      refresh: async () => {},
    };
    window.speakerContext = context;
    window.speakerMount = (contributionId) => browserModule.mount(contributionId, document.getElementById("speaker-root"), context);
    window.speakerUnmount = null;
    window.speakerUnmount = await window.speakerMount("speaker.attribution");
  }, { origin, snapshot });

  const scene = page.locator('select[aria-label="シーン"]');
  await scene.locator('option[value="sc-1"]').waitFor({ state: "attached" });
  await scene.selectOption("sc-1");
  await page.getByRole("button", { name: "話者を推定" }).click();
  await page.getByText("話者モデル scriptorium-speaker-cpu@1.0.0", { exact: false }).waitFor();
  assert.ok((await page.locator("main").innerText()).includes("共有 tokenizer lindera-wasm-nodejs-ipadic@2.0.0"));
  await page.getByRole("button", { name: "口調・文体を診断" }).click();
  await page.getByText("想定外の一人称", { exact: false }).waitFor();
  const speaker = page.locator("main select").nth(1);
  await speaker.selectOption("char-hero");
  await page.getByRole("button", { name: "この話者をレビュー案として確定" }).click();
  await page.getByText("確定案をレビューキューに作成しました。", { exact: false }).waitFor();
  await page.getByRole("button", { name: "話者数のレビュー案を作成" }).click();
  await page.getByText("話者数の変更案をレビューキューに作成しました。", { exact: false }).waitFor();
  assert.ok(calls.some((call) => call.actionId === "speaker.override" && call.input.speakerEntityId === "char-hero"));
  assert.ok(calls.some((call) => call.actionId === "speaker.count.update" && call.input.speakerCount === 1));

  await page.evaluate(async () => { await window.speakerUnmount(); window.speakerUnmount = await window.speakerMount("speaker.review"); });
  await page.getByText("この確定で他 2 行が解決", { exact: true }).waitFor();
  await page.getByText("未解決話者 1", { exact: false }).waitFor();
  assert.ok((await page.locator("main").innerText()).includes("未確定を優先"));

  await page.evaluate(async () => { await window.speakerUnmount(); window.speakerUnmount = await window.speakerMount("speaker.evaluation"); });
  await page.getByRole("button", { name: /sc-1 · 突合 2 · textHash 不一致 1/ }).waitFor();
  await page.getByRole("button", { name: /sc-1 · 突合 2 · textHash 不一致 1/ }).click();
  await page.getByText("評価行 2 · 話者一致 1 · 不一致 1 · textHash 除外 1", { exact: true }).waitFor();
  await page.getByLabel("不一致行のみ表示").check();
  assert.equal(await page.locator("article table tr").count(), 2, "the rendered mismatch-only toggle leaves one mismatched evaluation row plus its header");
  await page.getByLabel("評価後に規則ゲートを更新").check();
  await page.getByRole("button", { name: "全シーンを評価" }).click();
  await page.getByText("評価と規則ゲートをこのスナップショット", { exact: false }).waitFor();
  await page.getByRole("button", { name: "訂正データからモデルを再学習" }).click();
  await page.getByText("採用条件を通過", { exact: false }).waitFor();
  assert.ok(calls.some((call) => call.actionId === "speaker.evaluation.run"));
  assert.ok(calls.some((call) => call.actionId === "speaker.retraining.run"));
  assert.deepEqual(pageErrors, []);
  await page.evaluate(() => window.speakerUnmount());
  await page.close();
  console.log("PASS: rendered speaker attribution, review, diagnostics, evaluation, and retraining controls invoke their registered action boundary");
} finally {
  await browser?.close();
  await server.close();
}
