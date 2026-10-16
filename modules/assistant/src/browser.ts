import type { BrowserModuleContext, BrowserModuleDefinition } from "@scriptorium/contracts";

type Data = Record<string, unknown>;
type ActionCall = { data: unknown; proposals: unknown[] };
type Cleanup = Array<() => void>;

const ACTIONS = [
  "assistant.health",
  "assistant.queue.status",
  "assistant.settings.read",
  "assistant.settings.propose",
  "assistant.usage.read",
  "assistant.rewrite",
  "assistant.summary.scene",
  "assistant.summary.chapter",
  "assistant.qa",
  "assistant.continuation",
  "assistant.aspect.review",
  "assistant.dialogue.topics",
  "assistant.dialogue.turns",
  "assistant.reader.reaction",
  "assistant.zukan.suggestions",
  "assistant.synonyms.suggestions",
  "assistant.contradictions.assist",
  "assistant.stateEvents.draft",
  "assistant.speaker.attribute",
] as const;
type AssistantAction = (typeof ACTIONS)[number];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string): HTMLButtonElement {
  const node = el("button", label);
  node.type = "button";
  return node;
}

function field(labelText: string, control: HTMLElement): HTMLLabelElement {
  const node = el("label");
  node.append(el("span", labelText), control);
  node.style.display = "grid";
  node.style.gap = "0.35rem";
  return node;
}

function input(placeholder = ""): HTMLInputElement {
  const node = el("input");
  node.type = "text";
  node.placeholder = placeholder;
  return node;
}

function textarea(rows = 4, placeholder = ""): HTMLTextAreaElement {
  const node = el("textarea");
  node.rows = rows;
  node.maxLength = 200_000;
  node.placeholder = placeholder;
  return node;
}

function statusNode(): HTMLOutputElement {
  const node = el("output");
  node.setAttribute("aria-live", "polite");
  node.style.display = "block";
  node.style.marginBlock = "0.5rem";
  return node;
}

function section(title: string): HTMLElement {
  const node = el("section");
  node.style.display = "grid";
  node.style.gap = "0.5rem";
  node.style.marginBlock = "0.75rem";
  node.append(el("h4", title));
  return node;
}

function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  listener: (event: HTMLElementEventMap[K]) => void,
  cleanup: Cleanup,
): void {
  target.addEventListener(type, listener as EventListener);
  cleanup.push(() => target.removeEventListener(type, listener as EventListener));
}

function asRecord(value: unknown): Data {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
}

function displayJson(target: HTMLElement, value: unknown): void {
  const pre = el("pre");
  pre.style.whiteSpace = "pre-wrap";
  pre.style.overflowWrap = "anywhere";
  try {
    pre.textContent = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    pre.textContent = String(value);
  }
  target.replaceChildren(pre);
}

function resultItemText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);
  const row = asRecord(value);
  if (typeof row.title === "string" && typeof row.situation === "string") return `${row.title} — ${row.situation}`;
  if (typeof row.speaker === "string" && typeof row.text === "string") return `${row.speaker}: ${row.text}`;
  if (typeof row.aspectLabel === "string" && typeof row.finding === "string") return `${row.aspectLabel}: ${row.finding}`;
  if (typeof row.kind === "string" && typeof row.id === "string" && typeof row.quote === "string") return `[${row.kind}:${row.id}] ${row.quote}`;
  for (const key of ["title", "text", "direction", "finding", "summary", "question", "expectation", "confusion", "quote", "name", "id"]) {
    if (typeof row[key] === "string") return row[key] as string;
  }
  return JSON.stringify(value) ?? String(value);
}

function appendReadableResult(target: HTMLElement, label: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const block = section(label);
  if (Array.isArray(value)) {
    if (value.length === 0) block.append(el("p", "候補はありませんでした。"));
    else {
      const list = el("ul");
      for (const item of value) list.append(el("li", resultItemText(item)));
      block.append(list);
    }
  } else if (typeof value === "string") {
    const text = el("p", value);
    text.style.whiteSpace = "pre-wrap";
    block.append(text);
  } else if (typeof value === "number" || typeof value === "boolean") {
    block.append(el("p", String(value)));
  } else {
    const record = asRecord(value);
    let nested = false;
    const nestedFields: Array<[string, string]> = [
      ["answer", "回答"], ["summary", "要約"], ["summaryLines", "要約"], ["text", "候補"],
      ["questions", "疑問"], ["expectations", "期待"], ["confusions", "混乱"], ["citations", "根拠"],
    ];
    for (const [key, nestedLabel] of nestedFields) {
      if (Object.hasOwn(record, key)) nested = appendReadableResult(block, nestedLabel, record[key]) || nested;
    }
    if (!nested) block.append(el("p", resultItemText(value)));
  }
  target.append(block);
  return true;
}

function displayAssistantResult(target: HTMLElement, value: unknown): void {
  const data = asRecord(value);
  if (Object.keys(data).length === 0) {
    displayJson(target, value);
    return;
  }
  const labels: Array<[string, string]> = [
    ["summary", "要約"], ["summaryLines", "要約"], ["text", "候補"], ["answer", "回答"],
    ["options", "続きの候補"], ["topics", "対話のお題"], ["lines", "対話のターン"],
    ["firstReadReaction", "初読の反応"], ["questions", "疑問"], ["expectations", "期待"],
    ["confusions", "混乱"], ["findings", "レビュー結果"], ["candidates", "候補"],
    ["suggestion", "変更案"], ["events", "状態イベント"], ["attributions", "話者候補"],
    ["citations", "根拠"],
  ];
  const content = el("div");
  let rendered = false;
  for (const [key, label] of labels) {
    if (Object.hasOwn(data, key)) rendered = appendReadableResult(content, label, data[key]) || rendered;
  }
  if (!rendered) {
    displayJson(target, value);
    return;
  }
  const details = el("details");
  details.append(el("summary", "モデル・根拠・詳細データ"));
  const pre = el("pre");
  pre.style.whiteSpace = "pre-wrap";
  pre.style.overflowWrap = "anywhere";
  pre.textContent = JSON.stringify(value, null, 2) ?? String(value);
  details.append(pre);
  content.append(details);
  target.replaceChildren(content);
}

function proposalCount(result: ActionCall): number {
  const data = asRecord(result.data);
  const embedded = data.proposal ? 1 : Array.isArray(data.proposals) ? data.proposals.length : 0;
  return Math.max(embedded, result.proposals.length);
}

function proposalStatus(result: ActionCall, fallback: string): string {
  const count = proposalCount(result);
  return count > 0
    ? `${count} 件の変更案をレビューキューに送りました。承認されるまでプロジェクトには適用されません。`
    : fallback;
}

async function invoke(context: BrowserModuleContext, actionId: AssistantAction, inputValue: unknown): Promise<ActionCall> {
  const result = await context.invoke(actionId, inputValue);
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  if (!ACTIONS.includes(actionId)) throw new Error("Unknown assistant action");
  return { data: result.data, proposals: result.proposals ?? [] };
}

async function runAction(
  context: BrowserModuleContext,
  actionId: AssistantAction,
  inputValue: unknown,
  run: HTMLButtonElement,
  status: HTMLOutputElement,
  resultNode: HTMLElement,
  loading: string,
  done: string,
): Promise<void> {
  run.disabled = true;
  status.textContent = loading;
  resultNode.replaceChildren();
  try {
    const response = await invoke(context, actionId, inputValue);
    if (context.signal.aborted) return;
    displayAssistantResult(resultNode, response.data);
    status.textContent = proposalStatus(response, done);
  } catch (error) {
    if (!context.signal.aborted) status.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (!context.signal.aborted) run.disabled = false;
  }
}

function bindAction(
  buttonNode: HTMLButtonElement,
  buildInput: () => unknown,
  context: BrowserModuleContext,
  actionId: AssistantAction,
  status: HTMLOutputElement,
  resultNode: HTMLElement,
  cleanup: Cleanup,
  options: { loading?: string; done?: string } = {},
): void {
  on(buttonNode, "click", () => {
    void runAction(
      context,
      actionId,
      buildInput(),
      buttonNode,
      status,
      resultNode,
      options.loading ?? "処理しています…",
      options.done ?? "結果を読み込みました。",
    );
  }, cleanup);
}

function renderSettingsForm(
  target: HTMLElement,
  settingsValue: unknown,
  providerKind: unknown,
  environmentModel: unknown,
  context: BrowserModuleContext,
  cleanup: Cleanup,
  status: HTMLOutputElement,
  resultNode: HTMLElement,
): void {
  const settings = structuredClone(asRecord(settingsValue));
  const initialPresets = Array.isArray(settings.presets) ? settings.presets.map(asRecord) : [];
  const draft: Data = {
    ...settings,
    presets: initialPresets.map((preset) => ({ ...preset })),
    featurePresetIds: { ...asRecord(settings.featurePresetIds) },
  };

  const draw = () => {
    target.replaceChildren();
    target.append(el("p", `プロバイダー: ${String(providerKind ?? "不明")}${typeof environmentModel === "string" ? ` · 環境の既定モデル: ${environmentModel}` : ""}`));
    const presets = (Array.isArray(draft.presets) ? draft.presets : []).map(asRecord);
    if (presets.length === 0) {
      target.append(el("p", "このプロバイダーにモデルプリセットはありません。"));
      return;
    }

    const defaultPreset = el("select");
    for (const preset of presets) {
      const option = el("option", String(preset.label ?? preset.id ?? "モデル"));
      option.value = String(preset.id ?? "");
      defaultPreset.append(option);
    }
    defaultPreset.value = String(draft.defaultPresetId ?? presets[0]?.id ?? "");
    on(defaultPreset, "change", () => { draft.defaultPresetId = defaultPreset.value; }, cleanup);
    target.append(field("既定のモデル", defaultPreset));

    for (const [index, preset] of presets.entries()) {
      const group = el("fieldset");
      group.style.display = "grid";
      group.style.gap = "0.4rem";
      const legend = el("legend", `${String(preset.label ?? preset.id ?? `モデル ${index + 1}`)} · ${String(preset.id ?? "")}`);
      const labelInput = input("表示名");
      labelInput.value = String(preset.label ?? "");
      on(labelInput, "input", () => { preset.label = labelInput.value; legend.textContent = `${labelInput.value || String(preset.id ?? "モデル")} · ${String(preset.id ?? "")}`; }, cleanup);
      const modelInput = input("provider model ID");
      modelInput.value = String(preset.model ?? "");
      on(modelInput, "input", () => { preset.model = modelInput.value; }, cleanup);
      const concurrency = el("input");
      concurrency.type = "number";
      concurrency.min = "1";
      concurrency.step = "1";
      concurrency.value = String(preset.maxConcurrency ?? 1);
      on(concurrency, "input", () => { preset.maxConcurrency = Math.max(1, Number(concurrency.value) || 1); }, cleanup);
      group.append(legend, field("表示名", labelInput), field("モデル ID", modelInput), field("同時実行上限", concurrency));

      const sampling = asRecord(preset.sampling);
      const temperature = el("input");
      temperature.type = "number";
      temperature.min = "0";
      temperature.max = "2";
      temperature.step = "0.1";
      temperature.value = sampling.temperature === undefined ? "" : String(sampling.temperature);
      temperature.placeholder = "provider default";
      on(temperature, "change", () => {
        const next = asRecord(preset.sampling);
        if (temperature.value === "") delete next.temperature;
        else next.temperature = Number(temperature.value);
        preset.sampling = next;
      }, cleanup);
      group.append(field("temperature（任意）", temperature));

      if (presets.length > 1) {
        const remove = button("プリセットを削除");
        on(remove, "click", () => {
          draft.presets = presets.filter((_, itemIndex) => itemIndex !== index);
          const ids = new Set((draft.presets as Data[]).map((item) => String(item.id)));
          if (!ids.has(String(draft.defaultPresetId))) draft.defaultPresetId = String((draft.presets as Data[])[0]?.id ?? "");
          const featureIds = asRecord(draft.featurePresetIds);
          for (const [feature, id] of Object.entries(featureIds)) if (!ids.has(String(id))) delete featureIds[feature];
          draw();
        }, cleanup);
        group.append(remove);
      }
      target.append(group);
    }

    const features = asRecord(draft.featurePresetIds);
    const routing = section("機能ごとのモデル割当");
    for (const [featureId, presetId] of Object.entries(features)) {
      const select = el("select");
      for (const preset of presets) {
        const option = el("option", String(preset.label ?? preset.id ?? "モデル"));
        option.value = String(preset.id ?? "");
        select.append(option);
      }
      select.value = String(presetId);
      on(select, "change", () => { features[featureId] = select.value; }, cleanup);
      routing.append(field(featureId, select));
    }
    target.append(routing);

    const maxModels = el("input");
    maxModels.type = "number";
    maxModels.min = "1";
    maxModels.step = "1";
    maxModels.value = String(draft.maxConcurrentModels ?? 1);
    on(maxModels, "input", () => { draft.maxConcurrentModels = Math.max(1, Number(maxModels.value) || 1); }, cleanup);
    target.append(field("同時に使うモデルの上限", maxModels));

    const add = button("モデルプリセットを追加");
    on(add, "click", () => {
      const ids = new Set((draft.presets as Data[]).map((preset) => String(preset.id)));
      let suffix = (draft.presets as Data[]).length + 1;
      let id = `custom-${suffix}`;
      while (ids.has(id)) id = `custom-${++suffix}`;
      (draft.presets as Data[]).push({ id, label: "新しいプリセット", model: "" });
      draw();
    }, cleanup);
    target.append(add);

    const save = button("設定変更案をレビューに送る");
    const result = el("div");
    const localStatus = statusNode();
    on(save, "click", () => {
      void runAction(
        context,
        "assistant.settings.propose",
        { patch: {
          defaultPresetId: draft.defaultPresetId,
          presets: draft.presets,
          featurePresetIds: draft.featurePresetIds,
          maxConcurrentModels: draft.maxConcurrentModels,
        } },
        save,
        localStatus,
        result,
        "設定変更案を作成しています…",
        "設定変更案をレビューキューに送りました。",
      );
    }, cleanup);
    target.append(save, localStatus, result);
    status.textContent = "モデルと機能割当を編集できます。変更はレビュー案として保存され、承認まで反映されません。";
    resultNode.replaceChildren();
  };

  draw();
}

function mountSettings(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  const intro = el("p", "プロバイダーの状態、実行キュー、モデル設定、利用履歴を確認できます。設定変更はレビュー案として作成します。");
  const healthStatus = statusNode();
  const healthResult = el("div");
  const health = button("接続状態を確認");
  bindAction(health, () => ({}), context, "assistant.health", healthStatus, healthResult, cleanup, { loading: "プロバイダーを確認しています…", done: "接続状態を読み込みました。" });
  const queueStatus = statusNode();
  const queueResult = el("div");
  const queue = button("実行キューを確認");
  bindAction(queue, () => ({}), context, "assistant.queue.status", queueStatus, queueResult, cleanup, { loading: "キューを確認しています…", done: "キュー状態を読み込みました。" });
  const settingsStatus = statusNode();
  const settingsResult = el("div");
  const settingsForm = el("div");
  const settings = button("モデル設定を読み込む");
  on(settings, "click", async () => {
    settings.disabled = true;
    settingsStatus.textContent = "モデル設定を読み込んでいます…";
    settingsForm.replaceChildren();
    try {
      const response = await invoke(context, "assistant.settings.read", {});
      if (context.signal.aborted) return;
      const data = asRecord(response.data);
      const settingsValue = data.settings ?? response.data;
      settingsStatus.textContent = `プロバイダー: ${String(data.providerKind ?? "設定済み")}. 変更はレビュー案として送ります。`;
      renderSettingsForm(settingsForm, settingsValue, data.providerKind, data.envDefaultModel, context, cleanup, settingsStatus, settingsResult);
    } catch (error) {
      if (!context.signal.aborted) settingsStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (!context.signal.aborted) settings.disabled = false;
    }
  }, cleanup);

  const month = input("YYYY-MM（任意）");
  month.setAttribute("aria-label", "利用履歴の月");
  const usageStatus = statusNode();
  const usageResult = el("div");
  const usage = button("利用履歴を読む");
  bindAction(usage, () => month.value.trim() ? { month: month.value.trim() } : {}, context, "assistant.usage.read", usageStatus, usageResult, cleanup, { loading: "利用履歴を読み込んでいます…", done: "利用履歴を読み込みました。" });

  const controls = section("プロバイダーと設定");
  controls.append(health, healthStatus, healthResult, queue, queueStatus, queueResult, settings, settingsStatus, settingsForm, settingsResult);
  const usageSection = section("利用履歴");
  usageSection.append(field("対象月", month), usage, usageStatus, usageResult);
  root.append(intro, controls, usageSection);
}

function mountRewrite(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  const intro = el("p", "対象文と言い換えの希望を指定します。生成結果は変更案として送られ、承認前に原稿へ反映されません。");
  const sceneId = input("scene ID");
  sceneId.setAttribute("aria-label", "シーン ID");
  const selectedText = textarea(4, "言い換える文");
  selectedText.setAttribute("aria-label", "言い換える文");
  const instruction = input("例: 簡潔に、落ち着いた口調で");
  const run = button("ストリーミングで言い換え案を作る");
  const cancel = button("生成をキャンセル");
  cancel.hidden = true;
  const status = statusNode();
  const result = el("div");
  let controller: AbortController | undefined;
  let userCancelled = false;

  const cancelRun = () => {
    if (!controller) return;
    userCancelled = true;
    controller.abort();
    cancel.hidden = true;
    status.textContent = "生成をキャンセルしました。レビューキューに変更案がないか確認してください。";
  };
  on(cancel, "click", cancelRun, cleanup);
  const abortFromHost = () => controller?.abort(context.signal.reason);
  context.signal.addEventListener("abort", abortFromHost, { once: true });
  cleanup.push(() => context.signal.removeEventListener("abort", abortFromHost));

  const onRun = async () => {
    const source = selectedText.value.trim();
    if (!sceneId.value.trim() || !source) {
      status.textContent = "シーン ID と対象文を入力してください。";
      return;
    }
    controller?.abort();
    controller = new AbortController();
    userCancelled = false;
    run.disabled = true;
    cancel.hidden = false;
    status.textContent = "言い換え候補を生成しています…";
    result.replaceChildren();
    const chunks: string[] = [];
    let finalReceived = false;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(context.projectId)}/modules/assistant/rewrite/stream`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ sceneId: sceneId.value.trim(), selectedText: source, ...(instruction.value.trim() ? { instruction: instruction.value.trim() } : {}) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message = asRecord(body).error;
        throw new Error(typeof message === "string" ? message : `言い換えに失敗しました (${response.status})`);
      }
      if (!response.body) throw new Error("ストリーミング応答を読み取れませんでした。");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const processFrame = (frame: string) => {
        let eventName = "message";
        const dataLines: string[] = [];
        for (const line of frame.split(/\r?\n/u)) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) return;
        const raw = dataLines.join("\n");
        let payload: unknown = raw;
        try { payload = JSON.parse(raw) as unknown; } catch { /* Plain text data is supported for simple delta frames. */ }
        const data = asRecord(payload);
        if (eventName === "delta") {
          const delta = typeof payload === "string" ? payload : data.delta;
          if (typeof delta === "string") {
            chunks.push(delta);
            displayRewriteText(result, chunks.join(""));
          }
        } else if (eventName === "final") {
          finalReceived = true;
          const text = typeof data.text === "string" ? data.text : chunks.join("");
          displayRewriteFinal(result, text, payload);
          status.textContent = proposalStatus({ data: payload, proposals: Array.isArray(data.proposals) ? data.proposals : [] }, "言い換え候補を受け取りました。");
        } else if (eventName === "error" || eventName === "cancelled") {
          const message = typeof data.message === "string" ? data.message : typeof payload === "string" ? payload : eventName;
          throw Object.assign(new Error(message), { streamEvent: eventName });
        }
      };
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        buffer += decoder.decode(item.value, { stream: true });
        let boundary = /\r?\n\r?\n/u.exec(buffer);
        while (boundary) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          processFrame(frame);
          boundary = /\r?\n\r?\n/u.exec(buffer);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) processFrame(buffer);
      if (!finalReceived && !controller.signal.aborted) throw new Error("生成が完了する前にストリームが終了しました。");
    } catch (error) {
      const streamEvent = asRecord(error).streamEvent;
      if (userCancelled || controller.signal.aborted) {
        if (!context.signal.aborted && userCancelled) status.textContent = "生成をキャンセルしました。レビューキューに変更案がないか確認してください。";
      } else if (!context.signal.aborted) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
      if (streamEvent === "cancelled" && !context.signal.aborted) status.textContent = "生成をキャンセルしました。レビューキューに変更案がないか確認してください。";
    } finally {
      if (controller && !context.signal.aborted) {
        cancel.hidden = true;
        run.disabled = false;
      }
    }
  };
  on(run, "click", () => { void onRun(); }, cleanup);
  root.append(intro, field("シーン ID", sceneId), field("対象文", selectedText), field("指示（任意）", instruction), run, cancel, status, result);
}

function displayRewriteText(target: HTMLElement, text: string): void {
  const candidate = el("p", text);
  candidate.style.whiteSpace = "pre-wrap";
  const next = el("div");
  next.append(el("h4", "生成中の候補"), candidate);
  target.replaceChildren(next);
}

function displayRewriteFinal(target: HTMLElement, text: string, response: unknown): void {
  const candidate = el("p", text);
  candidate.style.whiteSpace = "pre-wrap";
  const details = el("details");
  const summary = el("summary", "モデル・根拠・レビュー案の情報");
  details.append(summary);
  const meta = el("pre");
  meta.style.whiteSpace = "pre-wrap";
  meta.textContent = JSON.stringify(response, null, 2) ?? String(response);
  details.append(meta);
  const next = el("div");
  next.append(el("h4", "言い換え候補"), candidate, details);
  target.replaceChildren(next);
}

function mountSummaries(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  const intro = el("p", "保存済みのシーンまたは章を指定して、要約案を生成します。候補はレビュー対象として扱います。");
  const sceneId = input("scene ID");
  const chapterId = input("chapter ID");
  const sceneStatus = statusNode();
  const sceneResult = el("div");
  const sceneRun = button("シーン要約を作る");
  bindAction(sceneRun, () => ({ sceneId: sceneId.value.trim() }), context, "assistant.summary.scene", sceneStatus, sceneResult, cleanup, { loading: "シーン要約を生成しています…", done: "シーン要約を受け取りました。" });
  const chapterStatus = statusNode();
  const chapterResult = el("div");
  const chapterRun = button("章要約を作る");
  bindAction(chapterRun, () => ({ chapterId: chapterId.value.trim() }), context, "assistant.summary.chapter", chapterStatus, chapterResult, cleanup, { loading: "章要約を生成しています…", done: "章要約を受け取りました。" });
  const sceneSection = section("シーン要約");
  sceneSection.append(field("シーン ID", sceneId), sceneRun, sceneStatus, sceneResult);
  const chapterSection = section("章要約");
  chapterSection.append(field("章 ID", chapterId), chapterRun, chapterStatus, chapterResult);
  root.append(intro, sceneSection, chapterSection);
}

function mountQa(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  const intro = el("p", "作品内の設定について質問し、回答と根拠を確認します。回答は執筆者の判断を置き換えません。");
  const question = textarea(4, "作品内の設定について質問");
  question.setAttribute("aria-label", "質問");
  const sceneId = input("scene ID（任意）");
  const run = button("設定に質問する");
  const status = statusNode();
  const result = el("div");
  bindAction(run, () => ({ question: question.value.trim(), ...(sceneId.value.trim() ? { sceneId: sceneId.value.trim() } : {}) }), context, "assistant.qa", status, result, cleanup, { loading: "質問への回答を作成しています…", done: "回答と根拠を読み込みました。" });
  root.append(intro, field("質問", question), field("関連シーン（任意）", sceneId), run, status, result);
}

function mountContinuation(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  const intro = el("p", "シーンの続きを複数案で提案します。結果は候補として表示され、原稿には書き込みません。");
  const sceneId = input("scene ID");
  const run = button("続きの候補を作る");
  const status = statusNode();
  const result = el("div");
  bindAction(run, () => ({ sceneId: sceneId.value.trim() }), context, "assistant.continuation", status, result, cleanup, { loading: "続きを考えています…", done: "続きの候補を受け取りました。" });
  root.append(intro, field("シーン ID", sceneId), run, status, result);
}

function mountAspectReview(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  const intro = el("p", "章内のテンポ、視点移動、説明の重なりを確認します。結果は根拠付きのレビュー案です。");
  const chapterId = input("chapter ID");
  const aspectChoices = [
    ["tempo", "テンポ"],
    ["pov-shift", "視点の移動"],
    ["over-explain", "説明の重なり"],
  ] as const;
  const checks = aspectChoices.map(([value, label]) => {
    const checkbox = el("input");
    checkbox.type = "checkbox";
    checkbox.value = value;
    checkbox.checked = true;
    return field(label, checkbox);
  });
  const run = button("章をレビューする");
  const status = statusNode();
  const result = el("div");
  bindAction(run, () => ({ chapterId: chapterId.value.trim(), aspects: checks.flatMap((item, index) => {
    const checkbox = item.querySelector("input");
    return checkbox?.checked ? [aspectChoices[index]![0]] : [];
  }) }), context, "assistant.aspect.review", status, result, cleanup, { loading: "章をレビューしています…", done: "レビュー結果を受け取りました。" });
  const aspectSection = section("確認する観点");
  for (const choice of checks) aspectSection.append(choice);
  root.append(intro, field("章 ID", chapterId), aspectSection, run, status, result);
}

function parseList(value: string): string[] {
  return value.split(/[\n,、]/u).map((item) => item.trim()).filter(Boolean);
}

function mountDialogue(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  const intro = el("p", "対話スケッチ向けのお題とターン候補を作ります。参加者、シーン、既存の発話を指定し、必要な行だけ候補を追加してください。");
  const sceneId = input("scene ID");
  const participants = textarea(2, "参加するキャラクター ID（改行または読点区切り）");
  participants.setAttribute("aria-label", "対話の参加者");
  const topic = input("対話のお題");
  const preceding = textarea(5, "既存の発話（1行ずつ）");
  const topics = button("お題を提案");
  const topicStatus = statusNode();
  const topicResult = el("div");
  bindAction(topics, () => ({ sceneId: sceneId.value.trim() }), context, "assistant.dialogue.topics", topicStatus, topicResult, cleanup, { loading: "対話のお題を考えています…", done: "お題候補を受け取りました。" });
  const turns = button("次のターンを提案");
  const turnStatus = statusNode();
  const turnResult = el("div");
  bindAction(turns, () => ({ sceneId: sceneId.value.trim(), topic: topic.value.trim(), participants: parseList(participants.value), ...(preceding.value.trim() ? { precedingLines: preceding.value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean) } : {}) }), context, "assistant.dialogue.turns", turnStatus, turnResult, cleanup, { loading: "対話の続き方を考えています…", done: "ターン候補を受け取りました。" });
  root.append(intro, field("シーン ID", sceneId), field("参加者", participants), field("お題", topic), field("これまでの発話", preceding), topics, topicStatus, topicResult, turns, turnStatus, turnResult);
}

function mountReaderReaction(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  const intro = el("p", "指定した章までの読者として、疑問、期待、混乱の候補を作ります。");
  const chapterId = input("chapter ID");
  const run = button("初読の反応を作る");
  const status = statusNode();
  const result = el("div");
  bindAction(run, () => ({ chapterId: chapterId.value.trim() }), context, "assistant.reader.reaction", status, result, cleanup, { loading: "初読レポートを作っています…", done: "初読レポートを受け取りました。" });
  root.append(intro, field("章 ID", chapterId), run, status, result);
}

function mountProposals(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  const intro = el("p", "各支援機能はレビュー用の変更案を作成します。案の確認と承認は執筆者がレビューキューで行います。");

  const zukanSection = section("図鑑の記述案");
  const entityId = input("キャラクター / エンティティ ID");
  const blockPath = input("対象ブロック（任意）");
  const zukanPrompt = textarea(3, "提案の方向（任意）");
  const zukanRun = button("図鑑の変更案を作る");
  const zukanStatus = statusNode();
  const zukanResult = el("div");
  bindAction(zukanRun, () => ({ entityId: entityId.value.trim(), ...(blockPath.value.trim() ? { blockPath: blockPath.value.trim() } : {}), ...(zukanPrompt.value.trim() ? { prompt: zukanPrompt.value.trim() } : {}) }), context, "assistant.zukan.suggestions", zukanStatus, zukanResult, cleanup, { loading: "図鑑の変更案を作っています…", done: "図鑑の変更案を作成しました。" });
  zukanSection.append(field("エンティティ ID", entityId), field("対象ブロック", blockPath), field("指示", zukanPrompt), zukanRun, zukanStatus, zukanResult);

  const synonymsSection = section("同義語・言い換え候補");
  const terms = input("比較する語句を読点またはカンマで入力");
  const contextSelect = el("select");
  contextSelect.append(new Option("文脈を指定しない", ""), new Option("緊迫した文脈", "negative"), new Option("高揚した文脈", "positive"));
  const synonymsRun = button("候補をレビュー案にする");
  const synonymsStatus = statusNode();
  const synonymsResult = el("div");
  bindAction(synonymsRun, () => ({ terms: parseList(terms.value), ...(contextSelect.value ? { context: contextSelect.value } : {}) }), context, "assistant.synonyms.suggestions", synonymsStatus, synonymsResult, cleanup, { loading: "同義語候補を作っています…", done: "同義語候補を作成しました。" });
  synonymsSection.append(field("語句", terms), field("文脈", contextSelect), synonymsRun, synonymsStatus, synonymsResult);

  const contradictionSection = section("設定の矛盾候補");
  const candidate = textarea(4, "確認する設定の記述");
  const contradictionRun = button("矛盾を確認する");
  const contradictionStatus = statusNode();
  const contradictionResult = el("div");
  bindAction(contradictionRun, () => ({ candidate: candidate.value.trim() }), context, "assistant.contradictions.assist", contradictionStatus, contradictionResult, cleanup, { loading: "関連する記述を確認しています…", done: "矛盾候補を確認しました。" });
  contradictionSection.append(field("記述", candidate), contradictionRun, contradictionStatus, contradictionResult);

  const stateSection = section("世界状態イベント案");
  const stateSceneId = input("scene ID");
  const stateRun = button("状態イベント案を作る");
  const stateStatus = statusNode();
  const stateResult = el("div");
  bindAction(stateRun, () => ({ sceneId: stateSceneId.value.trim() }), context, "assistant.stateEvents.draft", stateStatus, stateResult, cleanup, { loading: "状態イベント案を作っています…", done: "状態イベント案を作成しました。" });
  stateSection.append(field("シーン ID", stateSceneId), stateRun, stateStatus, stateResult);

  const speakerSection = section("話者の帰属候補");
  const speakerSceneId = input("scene ID");
  const speakerRun = button("話者候補を確認する");
  const speakerStatus = statusNode();
  const speakerResult = el("div");
  bindAction(speakerRun, () => ({ sceneId: speakerSceneId.value.trim() }), context, "assistant.speaker.attribute", speakerStatus, speakerResult, cleanup, { loading: "話者候補を推定しています…", done: "話者候補を受け取りました。" });
  speakerSection.append(field("シーン ID", speakerSceneId), speakerRun, speakerStatus, speakerResult);

  root.append(intro, zukanSection, synonymsSection, contradictionSection, stateSection, speakerSection);
}

const CONTRIBUTIONS: Record<string, { title: string; mount: (root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup) => void }> = {
  "assistant.settings": { title: "LLM モデル・利用状況", mount: mountSettings },
  "assistant.rewrite": { title: "ストリーミング言い換え", mount: mountRewrite },
  "assistant.summaries": { title: "シーン・章の要約", mount: mountSummaries },
  "assistant.qa": { title: "作品設定への質問", mount: mountQa },
  "assistant.continuation": { title: "続きを考える", mount: mountContinuation },
  "assistant.aspect-review": { title: "章の観点レビュー", mount: mountAspectReview },
  "assistant.dialogue": { title: "対話スケッチ", mount: mountDialogue },
  "assistant.reader-reaction": { title: "初読レポート", mount: mountReaderReaction },
  "assistant.proposals": { title: "執筆支援の変更案", mount: mountProposals },
};

export const browserModule: BrowserModuleDefinition = {
  async mount(contributionId, elementRoot, context) {
    const contribution = CONTRIBUTIONS[contributionId];
    if (!contribution) throw new Error(`Unknown assistant contribution: ${contributionId}`);
    const cleanup: Cleanup = [];
    elementRoot.replaceChildren(el("h3", contribution.title));
    contribution.mount(elementRoot, context, cleanup);
    const abort = () => {
      for (const dispose of cleanup.splice(0)) dispose();
      elementRoot.replaceChildren();
    };
    context.signal.addEventListener("abort", abort, { once: true });
    return () => {
      context.signal.removeEventListener("abort", abort);
      abort();
    };
  },
};
