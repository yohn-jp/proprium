import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = resolve(packageRoot, "../..");
const { createServer } = await import(pathToFileURL(resolve(workspaceRoot, "app/node_modules/vite/dist/node/index.js")).href);
const repository = {
  provider: "local",
  repositoryId: "assistant-browser-fixture",
  defaultBranch: "main",
  ownerScope: "owner-1",
  url: "file:///synthetic/assistant-browser-fixture",
};
const snapshot = { repository, remoteCommit: "a".repeat(40) };
const calls = [];
let failQaOnce = true;
let delayQa = false;
let streamMode = "success";
let resolveStreamClosed;
const streamClosed = new Promise((resolvePromise) => { resolveStreamClosed = resolvePromise; });

const actionData = {
  "assistant.health": { provider: "openai-compatible", ok: true, checked: "deep" },
  "assistant.queue.status": { active: 0, pending: 0 },
  "assistant.settings.read": {
    providerKind: "openai-compatible",
    settings: {
      defaultPresetId: "balanced",
      presets: [{ id: "balanced", label: "Balanced", model: "small-model", sampling: { temperature: 0.4 } }],
      featurePresetIds: { rewrite: "balanced", qa: "balanced" },
      maxConcurrentModels: 2,
    },
  },
  "assistant.settings.propose": { proposal: { id: "proposal-settings" } },
  "assistant.usage.read": { month: "2026-10", total: 12 },
  "assistant.summary.scene": { summary: "駅で二人が再会する。", proposal: { id: "proposal-scene-summary" } },
  "assistant.summary.chapter": { summary: "二人が再会し、旅に出る。", proposal: { id: "proposal-chapter-summary" } },
  "assistant.qa": { answer: "<img src=x onerror=alert(1)> 回答", citations: [{ kind: "scene", id: "sc-1", quote: "駅で会った。" }] },
  "assistant.continuation": { options: ["列車が動き出した。", "彼女は切符を握りしめた。"] },
  "assistant.aspect.review": { findings: [{ aspect: "tempo", finding: "間を少し短くできます。" }], proposal: { id: "proposal-aspect" } },
  "assistant.dialogue.topics": { topics: [{ title: "雨宿り", situation: "駅の軒下で雨を待つ" }] },
  "assistant.dialogue.turns": { lines: [{ speaker: "char-a", text: "傘、持ってる？" }] },
  "assistant.reader.reaction": { questions: ["二人はどこへ向かうのだろう？"], expectations: ["旅の始まり"], confusions: [] },
  "assistant.zukan.suggestions": { proposal: { id: "proposal-zukan" }, suggestion: "人物の変更案" },
  "assistant.synonyms.suggestions": { proposal: { id: "proposal-synonyms" }, candidates: ["静かに", "そっと"] },
  "assistant.contradictions.assist": { proposal: { id: "proposal-contradiction" }, findings: [] },
  "assistant.stateEvents.draft": { proposal: { id: "proposal-state" }, events: [] },
  "assistant.speaker.attribute": { proposal: { id: "proposal-speaker" }, attributions: [] },
};

const server = await createServer({
  configFile: false,
  root: packageRoot,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
});
server.middlewares.use((request, response, next) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname !== "/api/projects/assistant-browser-fixture/modules/assistant/rewrite/stream" || streamMode !== "hang") {
    next();
    return;
  }
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    response.on("close", () => {
      if (!response.writableEnded) resolveStreamClosed();
    });
    response.write('event: delta\ndata: {"delta":"途中の候補"}\n\n');
  });
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
  await page.goto(`${origin}/tests/browser-workflow.html`);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.exposeFunction("assistantInvoke", async (actionId, input) => {
    calls.push({ actionId, input });
    if (actionId === "assistant.qa" && failQaOnce) {
      failQaOnce = false;
      return { ok: false, snapshot, error: { code: "provider_unavailable", message: "一時的なプロバイダーエラー", retryable: true } };
    }
    if (actionId === "assistant.qa" && delayQa) await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
    const data = actionData[actionId];
    assert.ok(data, `unexpected assistant action: ${actionId}`);
    return { ok: true, snapshot, data, ...(data.proposal ? { proposals: [data.proposal] } : {}) };
  });

  await page.route("**/api/projects/assistant-browser-fixture/modules/assistant/rewrite/stream", async (route) => {
    if (streamMode === "success") {
      const input = route.request().postDataJSON();
      assert.deepEqual(input, { sceneId: "sc-1", selectedText: "夜の駅で彼を見つけた。", instruction: "簡潔に" });
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: 'event: delta\ndata: {"delta":"夜の駅で"}\n\nevent: delta\ndata: {"delta":"彼を見つけた。"}\n\nevent: final\ndata: {"text":"夜の駅で彼を見つけた。","model":"test-model","promptVersion":"1","citations":[],"proposal":{"id":"proposal-rewrite"}}\n\n',
      });
      return;
    }
    await route.continue();
  });

  await page.evaluate(async ({ origin, snapshot }) => {
    const { browserModule } = await import(`${origin}/src/browser.ts`);
    const context = {
      projectId: "assistant-browser-fixture",
      snapshot,
      signal: new AbortController().signal,
      invoke: (actionId, input) => window.assistantInvoke(actionId, input),
      propose: async () => { throw new Error("assistant UI must not approve or bypass the proposal queue"); },
      refresh: async () => {},
    };
    window.assistantContext = context;
    window.assistantUnmount = null;
    window.assistantMount = async (contributionId) => {
      window.assistantUnmount?.();
      window.assistantUnmount = await browserModule.mount(contributionId, document.getElementById("assistant-root"), context);
    };
  }, { origin, snapshot });

  await page.evaluate(() => window.assistantMount("assistant.settings"));
  await page.getByRole("button", { name: "接続状態を確認" }).click();
  await page.getByText('"ok": true', { exact: false }).waitFor();
  await page.getByRole("button", { name: "実行キューを確認" }).click();
  await page.getByText('"pending": 0', { exact: false }).waitFor();
  await page.getByRole("button", { name: "モデル設定を読み込む" }).click();
  await page.getByLabel("モデル ID").waitFor();
  await page.getByLabel("モデル ID").fill("provider/model-v2");
  await page.getByRole("button", { name: "設定変更案をレビューに送る" }).click();
  await page.getByText("変更案をレビューキューに送りました", { exact: false }).waitFor();
  const settingsCall = calls.find((call) => call.actionId === "assistant.settings.propose");
  assert.equal(settingsCall.input.patch.presets[0].model, "provider/model-v2");
  await page.getByLabel("利用履歴の月").fill("2026-10");
  await page.getByRole("button", { name: "利用履歴を読む" }).click();
  await page.getByText('"total": 12', { exact: false }).waitFor();

  await page.evaluate(() => window.assistantMount("assistant.rewrite"));
  await page.getByLabel("シーン ID").fill("sc-1");
  await page.getByLabel("言い換える文").fill("夜の駅で彼を見つけた。");
  await page.getByLabel("指示（任意）").fill("簡潔に");
  await page.getByRole("button", { name: "ストリーミングで言い換え案を作る" }).click();
  await page.getByText("言い換え候補を受け取りました", { exact: false }).waitFor();
  await page.getByText("夜の駅で彼を見つけた。", { exact: true }).waitFor();
  assert.equal(calls.some((call) => call.actionId === "assistant.rewrite"), false, "streamed candidate is not regenerated through the action API");

  streamMode = "hang";
  await page.getByRole("button", { name: "ストリーミングで言い換え案を作る" }).click();
  await page.getByText("途中の候補", { exact: true }).waitFor();
  await page.getByRole("button", { name: "生成をキャンセル" }).click();
  await page.getByText("生成をキャンセルしました。レビューキューに変更案がないか確認してください。", { exact: true }).waitFor();
  await Promise.race([
    streamClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("stream request was not cancelled")), 3000)),
  ]);

  await page.evaluate(() => window.assistantMount("assistant.summaries"));
  await page.getByLabel("シーン ID").fill("sc-1");
  await page.getByRole("button", { name: "シーン要約を作る" }).click();
  await page.getByText("駅で二人が再会する。", { exact: true }).waitFor();
  await page.getByLabel("章 ID").fill("ch-1");
  await page.getByRole("button", { name: "章要約を作る" }).click();
  await page.getByText("二人が再会し、旅に出る。", { exact: true }).waitFor();

  await page.evaluate(() => window.assistantMount("assistant.qa"));
  await page.getByLabel("質問").fill("この章で二人はどこで会った？");
  await page.getByRole("button", { name: "設定に質問する" }).click();
  await page.getByText("一時的なプロバイダーエラー", { exact: true }).waitFor();
  delayQa = true;
  await page.getByRole("button", { name: "設定に質問する" }).click();
  await page.getByText("質問への回答を作成しています…", { exact: true }).waitFor();
  await page.getByText("<img src=x onerror=alert(1)> 回答", { exact: false }).waitFor();
  assert.equal(await page.locator("img").count(), 0, "model text is rendered as text, never executable markup");

  await page.evaluate(() => window.assistantMount("assistant.continuation"));
  await page.getByLabel("シーン ID").fill("sc-1");
  await page.getByRole("button", { name: "続きの候補を作る" }).click();
  await page.getByText("列車が動き出した。", { exact: true }).waitFor();

  await page.evaluate(() => window.assistantMount("assistant.aspect-review"));
  await page.getByLabel("章 ID").fill("ch-1");
  await page.getByRole("button", { name: "章をレビューする" }).click();
  await page.getByText("テンポ: 間を少し短くできます。", { exact: true }).waitFor();

  await page.evaluate(() => window.assistantMount("assistant.dialogue"));
  await page.getByLabel("シーン ID").fill("sc-1");
  await page.getByLabel("対話の参加者").fill("char-a、char-b");
  await page.getByLabel("お題").fill("雨宿り");
  await page.getByLabel("これまでの発話").fill("char-a: 傘、持ってる？");
  await page.getByRole("button", { name: "お題を提案" }).click();
  await page.getByText("雨宿り — 駅の軒下で雨を待つ", { exact: true }).waitFor();
  await page.getByRole("button", { name: "次のターンを提案" }).click();
  await page.getByText("char-a: 傘、持ってる？", { exact: true }).waitFor();
  const dialogueCall = calls.find((call) => call.actionId === "assistant.dialogue.turns");
  assert.deepEqual(dialogueCall.input.participants, ["char-a", "char-b"]);
  assert.deepEqual(dialogueCall.input.precedingLines, ["char-a: 傘、持ってる？"]);

  await page.evaluate(() => window.assistantMount("assistant.reader-reaction"));
  await page.getByLabel("章 ID").fill("ch-1");
  await page.getByRole("button", { name: "初読の反応を作る" }).click();
  await page.getByText("二人はどこへ向かうのだろう？", { exact: true }).waitFor();

  await page.evaluate(() => window.assistantMount("assistant.proposals"));
  await page.getByLabel("エンティティ ID").fill("char-a");
  await page.getByLabel("対象ブロック").fill("personality");
  await page.getByRole("button", { name: "図鑑の変更案を作る" }).click();
  await page.getByText("変更案をレビューキューに送りました", { exact: false }).first().waitFor();
  await page.getByText("人物の変更案", { exact: true }).waitFor();
  await page.getByLabel("語句").fill("静か,穏やか");
  await page.getByLabel("文脈").selectOption("positive");
  await page.getByRole("button", { name: "候補をレビュー案にする" }).click();
  await page.getByText("静かに", { exact: true }).waitFor();
  await page.getByLabel("記述").fill("主人公は雪の村で寒がりだと言った。");
  await page.getByRole("button", { name: "矛盾を確認する" }).click();
  await page.getByText("矛盾候補を確認しました", { exact: false }).waitFor();
  await page.getByLabel("scene ID").nth(0).fill("sc-1");
  await page.getByRole("button", { name: "状態イベント案を作る" }).click();
  await page.getByText("状態イベント案を作成しました", { exact: false }).waitFor();
  await page.getByLabel("scene ID").nth(1).fill("sc-1");
  await page.getByRole("button", { name: "話者候補を確認する" }).click();
  await page.getByText("話者候補を受け取りました", { exact: false }).waitFor();

  const allowedActions = new Set([
    "assistant.health", "assistant.queue.status", "assistant.settings.read", "assistant.settings.propose", "assistant.usage.read",
    "assistant.rewrite", "assistant.summary.scene", "assistant.summary.chapter", "assistant.qa", "assistant.continuation", "assistant.aspect.review",
    "assistant.dialogue.topics", "assistant.dialogue.turns", "assistant.reader.reaction", "assistant.zukan.suggestions",
    "assistant.synonyms.suggestions", "assistant.contradictions.assist", "assistant.stateEvents.draft", "assistant.speaker.attribute",
  ]);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => allowedActions.has(call.actionId)), "browser invokes only the approved assistant action IDs");
  assert.equal(calls.some((call) => ["assistant.approve", "assistant.commit", "assistant.publish"].includes(call.actionId)), false);
  assert.deepEqual(pageErrors, []);
  await page.evaluate(() => window.assistantUnmount());
  await page.close();
  console.log("PASS: assistant panels render safely, invoke approved actions, stream and cancel rewrite, and keep generated changes in review proposals");
} finally {
  await browser?.close();
  await server.close();
}
