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
const editorDraft = {
  sceneId: "sc-1",
  documentPath: "manuscript/vol-main/ch-1/sc-1.md",
  documentRevision: "editor-document-rev",
  sceneRevision: "editor-scene-rev",
  text: "一文目。二文目。三文目。四文目。五文目。六文目。七文目。八文目。九文目。十文目。十一文目。十二文目。",
  snapshot: { ...snapshot, overlayCommit: "d".repeat(40) },
  baseSnapshot: snapshot,
  baseSceneRevision: "b".repeat(64),
};
const calls = [];
let streamMode = "success";
let qaStreamMode = "error";
const qaRequests = [];
let resolveStreamClosed;
const streamClosed = new Promise((resolvePromise) => { resolveStreamClosed = resolvePromise; });
let resolveQaStreamClosed;
const qaStreamClosed = new Promise((resolvePromise) => { resolveQaStreamClosed = resolvePromise; });

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
  "assistant.summary.scene.preview": { prompt: "実際のシーン要約プロンプト" },
  "assistant.summary.chapter.preview": { prompt: "実際の章要約プロンプト" },
  "assistant.qa.preview": { prompt: "実際のQAシステムプロンプト" },
  "assistant.continuation": { options: ["列車が動き出した。", "彼女は切符を握りしめた。"] },
  "assistant.continuation.preview": { prompt: "実際の続きプロンプト" },
  "assistant.aspect.review": { findings: [{ aspect: "tempo", aspectLabel: "テンポ", finding: "間を少し短くできます。" }] },
  "assistant.aspect.review.preview": { prompt: "ローカルのレビュー骨組み" },
  "story.entities.list": [{
    id: "ds-1",
    name: "駅の対話スケッチ",
    type: "dialogue_sketch",
    raw: {
      title: "雨宿り",
      situation: "駅の軒下で雨を待つ",
      participantEntityIds: ["char-a", "char-b"],
      lines: [
        { speakerEntityId: "char-a", text: "傘、持ってる？" },
        { speakerEntityId: "char-b", text: "今日は持ってないの。" },
        { speakerEntityId: "char-a", text: "じゃあ、ここで待とう。" },
      ],
    },
  }],
  "assistant.dialogue.topics": { topics: [{ title: "雨宿り", situation: "駅の軒下で雨を待つ" }] },
  "assistant.dialogue.topics.preview": { prompt: "実際のお題プロンプト" },
  "assistant.dialogue.turns": { lines: [{ speakerEntityId: "char-a", text: "傘、持ってる？" }] },
  "assistant.dialogue.turn.preview": { prompt: "実際の1ターンプロンプト" },
  "assistant.dialogue.turns.preview": { prompt: "実際の複数ターンプロンプト" },
  "assistant.reader.reaction": { questions: ["二人はどこへ向かうのだろう？"], expectations: ["旅の始まり"], confusions: [] },
  "assistant.reader.reaction.preview": { prompt: "実際の初読プロンプト" },
  "assistant.zukan.suggestions": { proposal: { id: "proposal-zukan" }, suggestion: "人物の変更案" },
  "assistant.synonyms.suggestions": {
    suggestions: [{ term: "静か", candidates: ["静かに", "そっと"] }],
  },
  "assistant.synonyms.preview": { prompt: "実際の同義語プロンプト" },
  "assistant.zukan.sandbox.preview": { prompt: "実際のsandbox図鑑プロンプト" },
  "assistant.contradictions.assist": { findings: [] },
  "assistant.stateEvents.draft": { proposal: { id: "proposal-state" }, events: [] },
  "assistant.speaker.attribute": { attributions: [] },
};

const server = await createServer({
  configFile: false,
  root: packageRoot,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
});
server.middlewares.stack.unshift({ route: "", handle: (request, response, next) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const rewritePath = "/api/projects/assistant-browser-fixture/modules/assistant/rewrite/stream";
  const qaPath = "/api/projects/assistant-browser-fixture/modules/assistant/qa/stream";
  const isRewrite = pathname === rewritePath && streamMode === "hang";
  const isQa = pathname === qaPath && qaStreamMode === "hang";
  if (request.method !== "POST" || (!isRewrite && !isQa)) {
    next();
    return;
  }
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    response.on("close", () => {
      if (!response.writableEnded) {
        if (isRewrite) resolveStreamClosed();
        if (isQa) resolveQaStreamClosed();
      }
    });
    response.write(isRewrite
      ? 'event: delta\ndata: {"delta":"途中の候補"}\n\n'
      : 'event: delta\ndata: {"delta":"未確定の回答"}\n\n');
  });
} });

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
    if (actionId === "assistant.rewrite.propose") {
      const proposal = { id: "proposal-rewrite-choice" };
      return { ok: true, snapshot, data: { proposal }, proposals: [proposal] };
    }
    if (actionId === "assistant.zukan.suggestions" && input?.source === "sandbox") {
      const data = { proposal: { id: "proposal-zukan-sandbox" }, suggestion: "sandbox の変更案" };
      return { ok: true, snapshot, data, proposals: [data.proposal] };
    }
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
        body: 'event: delta\ndata: {"delta":"夜の駅で"}\n\nevent: delta\ndata: {"delta":"彼を見つけた。"}\n\nevent: final\ndata: {"text":"夜の駅で彼を見つけた。","sentenceIndex":1,"suggestions":[{"text":"暗い駅で彼を見つけた。","strategy":"concise","rationale":"短くする"},{"text":"夜の駅のホームで彼を見つけた。","strategy":"contextual","rationale":"場所を補う"},{"text":"夜の駅で彼を見つけたんだ。","strategy":"voice","rationale":"口調を調整する"}],"sentenceSplit":{"text":"夜の駅で彼を見つけた。胸が高鳴る。","rationale":"二文に分ける"},"tellToShow":{"text":"足音が止まった。彼がいた。","rationale":"動作で示す","source":"corpus"},"model":"test-model","provider":"test-provider","promptVersion":"1","citations":[],"provenance":{}}\n\n',
      });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/projects/assistant-browser-fixture/modules/assistant/qa/stream", async (route) => {
    qaRequests.push(route.request().postDataJSON());
    if (qaStreamMode === "hang") {
      await route.continue();
      return;
    }
    if (qaStreamMode === "error") {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "一時的なプロバイダーエラー" }) });
      return;
    }
    const answer = qaRequests.length === 2 ? "<img src=x onerror=alert(1)> 回答" : "再試行後の回答";
    const response = {
      answer,
      confidence: "medium",
      citations: [{ kind: "scene", id: "sc-1", quote: "駅で会った。", path: "scenes/sc-1.md", revision: "r1" }],
      model: "test-model",
      provider: "test-provider",
      promptVersion: "qa-1",
      provenance: {},
    };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `event: delta\ndata: ${JSON.stringify({ delta: answer })}\n\nevent: final\ndata: ${JSON.stringify(response)}\n\n`,
    });
  });

  await page.evaluate(async ({ origin, snapshot, editorDraft }) => {
    const { browserModule } = await import(`${origin}/src/browser.ts`);
    window.assistantEditorDraft = editorDraft;
    const context = {
      projectId: "assistant-browser-fixture",
      snapshot,
      signal: new AbortController().signal,
      invoke: (actionId, input) => window.assistantInvoke(actionId, input),
      readCurrentEditor: () => structuredClone(editorDraft),
      propose: async () => { throw new Error("assistant UI must not approve or bypass the proposal queue"); },
      refresh: async () => {},
    };
    window.assistantContext = context;
    window.assistantUnmount = null;
    window.assistantMount = async (contributionId) => {
      window.assistantUnmount?.();
      window.assistantUnmount = await browserModule.mount(contributionId, document.getElementById("assistant-root"), context);
    };
  }, { origin, snapshot, editorDraft });

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
  await page.getByText("候補を受け取りました。使う候補を選んで変更案を作成してください。", { exact: true }).waitFor();
  await page.getByText("簡潔案", { exact: true }).waitFor();
  await page.getByText("文脈案", { exact: true }).waitFor();
  await page.getByText("口調案", { exact: true }).waitFor();
  await page.getByText("文分割案", { exact: true }).waitFor();
  await page.getByText("tell→show（コーパス）", { exact: true }).waitFor();
  await page.getByLabel("言い換える文").fill("別の対象文");
  await page.getByRole("button", { name: "簡潔案を変更案にする" }).click();
  await page.getByText("シーンまたは対象文が変更されています。候補を再生成してください。", { exact: true }).waitFor();
  assert.equal(calls.some((call) => call.actionId === "assistant.rewrite.propose"), false, "stale rewrite choices cannot create a proposal");
  await page.getByLabel("言い換える文").fill("夜の駅で彼を見つけた。");
  await page.getByRole("button", { name: "口調案を変更案にする" }).click();
  await page.getByText("変更案をレビューキューに送りました", { exact: false }).waitFor();
  assert.deepEqual(calls.find((call) => call.actionId === "assistant.rewrite.propose").input, {
    sceneId: "sc-1",
    selectedText: "夜の駅で彼を見つけた。",
    replacementText: "夜の駅で彼を見つけたんだ。",
    sentenceIndex: 1,
  });
  assert.equal(await page.getByRole("button", { name: "簡潔案を変更案にする" }).isDisabled(), true, "one selected rewrite candidate is proposed at a time");
  assert.equal(calls.some((call) => call.actionId === "assistant.rewrite"), false, "streamed candidate is not regenerated through the action API");

  streamMode = "hang";
  await page.getByRole("button", { name: "ストリーミングで言い換え案を作る" }).click();
  await page.getByText("生成中の候補", { exact: true }).waitFor();
  await page.getByRole("button", { name: "生成をキャンセル" }).click();
  await page.getByText("生成をキャンセルしました。変更案は作成されていません。", { exact: true }).waitFor();
  await Promise.race([
    streamClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("stream request was not cancelled")), 3000)),
  ]);

  await page.evaluate(() => window.assistantMount("assistant.summaries"));
  await page.getByLabel("シーン ID").fill("sc-1");
  await page.getByRole("button", { name: "シーン要約プロンプトを確認" }).click();
  await page.getByText("実際のシーン要約プロンプト", { exact: false }).waitFor();
  assert.deepEqual(calls.find((call) => call.actionId === "assistant.summary.scene.preview").input, { sceneId: "sc-1" });
  await page.getByRole("button", { name: "シーン要約を作る" }).click();
  await page.getByText("駅で二人が再会する。", { exact: true }).waitFor();
  await page.getByLabel("章 ID").fill("ch-1");
  await page.getByRole("button", { name: "章要約プロンプトを確認" }).click();
  await page.getByText("実際の章要約プロンプト", { exact: false }).waitFor();
  assert.deepEqual(calls.find((call) => call.actionId === "assistant.summary.chapter.preview").input, { chapterId: "ch-1" });
  await page.getByRole("button", { name: "章要約を作る" }).click();
  await page.getByText("二人が再会し、旅に出る。", { exact: true }).waitFor();

  await page.evaluate(() => window.assistantMount("assistant.qa"));
  await page.getByLabel("関連シーン（任意）").fill("sc-1");
  await page.getByRole("button", { name: "QAシステムプロンプトを確認" }).click();
  await page.getByText("実際のQAシステムプロンプト", { exact: false }).waitFor();
  assert.deepEqual(calls.find((call) => call.actionId === "assistant.qa.preview").input, { sceneId: "sc-1" });
  await page.getByLabel("質問").fill("この章で二人はどこで会った？");
  await page.getByRole("button", { name: "設定に質問する" }).click();
  await page.getByText("一時的なプロバイダーエラー", { exact: true }).waitFor();
  qaStreamMode = "success";
  await page.getByRole("button", { name: "回答を再試行" }).click();
  await page.getByText("<img src=x onerror=alert(1)> 回答", { exact: true }).waitFor();
  await page.getByText("[scene:sc-1] 駅で会った。 (scenes/sc-1.md · r1)", { exact: true }).waitFor();
  assert.equal(await page.locator("img").count(), 0, "model text is rendered as text, never executable markup");
  assert.deepEqual(qaRequests[0], { sceneId: "sc-1", messages: [{ role: "user", content: "この章で二人はどこで会った？" }] });

  qaStreamMode = "hang";
  await page.getByLabel("質問").fill("会話に追加される前にキャンセルする質問");
  await page.getByRole("button", { name: "設定に質問する" }).click();
  await page.getByText("生成中の回答", { exact: true }).waitFor();
  await page.getByRole("button", { name: "回答生成をキャンセル" }).click();
  await page.getByText("回答生成をキャンセルしました。会話には追加されていません。", { exact: true }).waitFor();
  await Promise.race([
    qaStreamClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("QA stream request was not cancelled")), 3000)),
  ]);
  assert.equal(await page.locator("#assistant-root article").count(), 2, "cancelled QA requests do not become conversation turns");
  qaStreamMode = "success";
  await page.getByRole("button", { name: "回答を再試行" }).click();
  await page.getByText("再試行後の回答", { exact: true }).waitFor();
  assert.deepEqual(qaRequests[3], {
    sceneId: "sc-1",
    messages: [
      { role: "user", content: "この章で二人はどこで会った？" },
      { role: "assistant", content: "<img src=x onerror=alert(1)> 回答" },
      { role: "user", content: "会話に追加される前にキャンセルする質問" },
    ],
  }, "retry keeps completed history and excludes the cancelled attempt");

  await page.evaluate(() => window.assistantMount("assistant.continuation"));
  await page.getByLabel("シーン ID").fill("sc-1");
  await page.getByRole("button", { name: "続きを考えるプロンプトを確認" }).click();
  await page.getByText("実際の続きプロンプト", { exact: false }).waitFor();
  assert.deepEqual(calls.find((call) => call.actionId === "assistant.continuation.preview").input, { editorText: editorDraft.text });
  const continuationCallsBeforeLostEditor = calls.filter((call) => call.actionId === "assistant.continuation.preview").length;
  await page.evaluate(() => { window.assistantContext.readCurrentEditor = () => null; });
  await page.getByRole("button", { name: "続きを考えるプロンプトを確認" }).click();
  await page.getByText("選択シーンの編集本文を確認できません", { exact: false }).waitFor();
  assert.equal(calls.filter((call) => call.actionId === "assistant.continuation.preview").length, continuationCallsBeforeLostEditor, "a missing live draft does not silently preview saved-scene context");
  await page.evaluate(() => { window.assistantContext.readCurrentEditor = () => structuredClone(window.assistantEditorDraft); });
  await page.getByRole("button", { name: "続きの候補を作る" }).click();
  await page.getByText("列車が動き出した。", { exact: true }).waitFor();
  assert.deepEqual(calls.find((call) => call.actionId === "assistant.continuation").input, { sceneId: "sc-1", editorDraft, k: 8 });

  await page.evaluate(() => window.assistantMount("assistant.aspect-review"));
  await page.getByLabel("章 ID").fill("ch-1");
  await page.getByRole("button", { name: "レビュー用プロンプト骨組みを確認" }).click();
  await page.getByText("ローカルのレビュー骨組み", { exact: false }).waitFor();
  assert.deepEqual(calls.find((call) => call.actionId === "assistant.aspect.review.preview").input, { chapterId: "ch-1", aspects: ["tempo", "pov-shift", "over-explain"] });
  await page.getByRole("button", { name: "章をレビューする" }).click();
  await page.getByText("テンポ: 間を少し短くできます。", { exact: true }).waitFor();

  await page.evaluate(() => window.assistantMount("assistant.dialogue"));
  await page.getByRole("button", { name: "保存済みスケッチを読み込む" }).click();
  await page.getByLabel("保存済みスケッチ").selectOption("ds-1");
  await page.getByRole("button", { name: "お題プロンプトを確認" }).click();
  await page.getByText("実際のお題プロンプト", { exact: false }).waitFor();
  assert.deepEqual(calls.find((call) => call.actionId === "assistant.dialogue.topics.preview").input, { participantEntityIds: ["char-a", "char-b"] });
  await page.getByRole("button", { name: "お題を提案" }).click();
  await page.getByText("雨宿り — 駅の軒下で雨を待つ", { exact: true }).waitFor();
  await page.getByRole("button", { name: "ターン生成プロンプトを確認" }).click();
  await page.getByText("実際の1ターンプロンプト", { exact: false }).waitFor();
  const singleTurnPreview = calls.find((call) => call.actionId === "assistant.dialogue.turn.preview");
  assert.equal(singleTurnPreview.input.speakerEntityId, "char-a");
  assert.equal(singleTurnPreview.input.sketchId, "ds-1");
  await page.getByRole("button", { name: "次のターンを提案" }).click();
  await page.getByText("char-a: 傘、持ってる？", { exact: true }).waitFor();
  const dialogueTopicsCall = calls.find((call) => call.actionId === "assistant.dialogue.topics");
  assert.deepEqual(dialogueTopicsCall.input, { participantEntityIds: ["char-a", "char-b"] });
  const dialogueCall = calls.find((call) => call.actionId === "assistant.dialogue.turns");
  assert.deepEqual(dialogueCall.input, {
    sketchId: "ds-1",
    participantEntityIds: ["char-a", "char-b"],
    speakerEntityId: "char-a",
    topic: "雨宿り",
    situation: "駅の軒下で雨を待つ",
    precedingLines: [
      { speakerEntityId: "char-a", text: "傘、持ってる？" },
      { speakerEntityId: "char-b", text: "今日は持ってないの。" },
      { speakerEntityId: "char-a", text: "じゃあ、ここで待とう。" },
    ],
  });
  await page.getByLabel("生成モード").selectOption("bulk");
  await page.getByLabel("生成ターン数").fill("2");
  await page.getByRole("button", { name: "ターン生成プロンプトを確認" }).click();
  await page.getByText("実際の複数ターンプロンプト", { exact: false }).waitFor();
  const bulkTurnPreview = calls.find((call) => call.actionId === "assistant.dialogue.turns.preview");
  assert.equal(bulkTurnPreview.input.lineCount, 2);
  assert.equal(bulkTurnPreview.input.sketchId, "ds-1");
  await page.getByRole("button", { name: "次のターンを提案" }).click();
  const bulkDialogueCall = calls.filter((call) => call.actionId === "assistant.dialogue.turns")[1];
  assert.deepEqual(bulkDialogueCall.input, {
    sketchId: "ds-1",
    participantEntityIds: ["char-a", "char-b"],
    topic: "雨宿り",
    situation: "駅の軒下で雨を待つ",
    precedingLines: [
      { speakerEntityId: "char-a", text: "傘、持ってる？" },
      { speakerEntityId: "char-b", text: "今日は持ってないの。" },
      { speakerEntityId: "char-a", text: "じゃあ、ここで待とう。" },
    ],
    lineCount: 2,
  });

  await page.evaluate(() => window.assistantMount("assistant.reader-reaction"));
  await page.getByLabel("章 ID").fill("ch-1");
  await page.getByRole("button", { name: "初読プロンプトを確認" }).click();
  await page.getByText("実際の初読プロンプト", { exact: false }).waitFor();
  assert.deepEqual(calls.find((call) => call.actionId === "assistant.reader.reaction.preview").input, { chapterId: "ch-1" });
  await page.getByRole("button", { name: "初読の反応を作る" }).click();
  await page.getByText("二人はどこへ向かうのだろう？", { exact: true }).waitFor();

  await page.evaluate(() => window.assistantMount("assistant.proposals"));
  await page.getByLabel("エンティティ ID").fill("char-a");
  await page.getByLabel("対象ブロック").fill("personality");
  await page.getByRole("button", { name: "図鑑の変更案を作る" }).click();
  await page.getByText("変更案をレビューキューに送りました", { exact: false }).first().waitFor();
  await page.getByText("人物の変更案", { exact: true }).waitFor();
  await page.getByLabel("語句").fill("静か");
  await page.getByLabel("原文の一文").fill("彼女は静かに窓辺へ歩いた。");
  await page.getByLabel("診断理由（任意）").fill("副詞の重複を避ける");
  await page.getByRole("button", { name: "同義語プロンプトを確認" }).click();
  await page.getByText("実際の同義語プロンプト", { exact: false }).waitFor();
  assert.deepEqual(calls.find((call) => call.actionId === "assistant.synonyms.preview").input, {
    original: "静か", sentence: "彼女は静かに窓辺へ歩いた。", reason: "副詞の重複を避ける",
  });
  await page.getByRole("button", { name: "候補をレビュー案にする" }).click();
  await page.getByText("静かに", { exact: true }).waitFor();
  await page.getByText("そっと", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("文脈").count(), 0, "synonym suggestions do not use polarity as a context selector");
  assert.deepEqual(calls.find((call) => call.actionId === "assistant.synonyms.suggestions").input, {
    suggestions: [{ original: "静か", sentence: "彼女は静かに窓辺へ歩いた。", reason: "副詞の重複を避ける" }],
  });
  await page.getByLabel("提案対象").selectOption("sandbox");
  await page.getByRole("button", { name: "sandbox のスケッチ一覧を読み込む" }).click();
  await page.getByLabel("sandbox 対話スケッチ").selectOption("ds-1");
  await page.getByLabel("開始ターン").fill("2");
  await page.getByLabel("終了ターン").fill("3");
  await page.getByRole("button", { name: "sandbox 図鑑分析プロンプトを確認" }).click();
  await page.getByText("実際のsandbox図鑑プロンプト", { exact: false }).waitFor();
  assert.deepEqual(calls.find((call) => call.actionId === "assistant.zukan.sandbox.preview").input, { sketchId: "ds-1", turnRange: { start: 1, end: 2 } });
  await page.getByRole("button", { name: "図鑑の変更案を作る" }).click();
  await page.getByText("sandbox の変更案", { exact: true }).waitFor();
  assert.deepEqual(calls.filter((call) => call.actionId === "assistant.zukan.suggestions")[1].input, {
    source: "sandbox",
    sourceSessionId: "ds-1",
    turnRange: { start: 1, end: 2 },
  });
  await page.getByLabel("記述").fill("主人公は雪の村で寒がりだと言った。");
  await page.getByRole("button", { name: "矛盾を確認する" }).click();
  await page.getByText("矛盾候補を確認しました", { exact: false }).waitFor();
  await page.getByLabel("シーン ID").nth(0).fill("sc-1");
  await page.getByRole("button", { name: "状態イベント案を作る" }).click();
  await page.getByText("変更案をレビューキューに送りました", { exact: false }).last().waitFor();
  await page.getByLabel("シーン ID").nth(1).fill("sc-1");
  await page.getByRole("button", { name: "話者候補を確認する" }).click();
  await page.getByText("話者候補を受け取りました", { exact: false }).waitFor();

  const allowedActions = new Set([
    "assistant.health", "assistant.queue.status", "assistant.settings.read", "assistant.settings.propose", "assistant.usage.read",
    "assistant.rewrite", "assistant.summary.scene", "assistant.summary.chapter", "assistant.continuation", "assistant.aspect.review",
    "assistant.rewrite.propose", "story.entities.list", "assistant.dialogue.topics", "assistant.dialogue.turns", "assistant.reader.reaction", "assistant.zukan.suggestions",
    "assistant.synonyms.suggestions", "assistant.contradictions.assist", "assistant.stateEvents.draft", "assistant.speaker.attribute",
    "assistant.summary.scene.preview", "assistant.summary.chapter.preview", "assistant.qa.preview", "assistant.continuation.preview", "assistant.aspect.review.preview",
    "assistant.dialogue.topics.preview", "assistant.dialogue.turn.preview", "assistant.dialogue.turns.preview", "assistant.reader.reaction.preview", "assistant.synonyms.preview", "assistant.zukan.sandbox.preview",
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
