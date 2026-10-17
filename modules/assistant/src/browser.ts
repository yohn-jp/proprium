import type { BrowserEditorDocument, BrowserModuleContext, BrowserModuleDefinition } from "@scriptorium/contracts";

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
  "assistant.rewrite.propose",
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
  "assistant.summary.scene.preview",
  "assistant.summary.chapter.preview",
  "assistant.qa.preview",
  "assistant.continuation.preview",
  "assistant.aspect.review.preview",
  "assistant.dialogue.topics.preview",
  "assistant.dialogue.turn.preview",
  "assistant.dialogue.turns.preview",
  "assistant.reader.reaction.preview",
  "assistant.synonyms.preview",
  "assistant.zukan.sandbox.preview",
] as const;
type AssistantAction = (typeof ACTIONS)[number];
const STORY_ACTIONS = ["story.entities.list"] as const;
type BrowserAction = AssistantAction | (typeof STORY_ACTIONS)[number];

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
  if (typeof row.speakerEntityId === "string" && typeof row.text === "string") return `${row.speakerEntityId}: ${row.text}`;
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
    if (Array.isArray(record.suggestions)) nested = appendSynonymSuggestions(block, record.suggestions) || nested;
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

function appendSynonymSuggestions(target: HTMLElement, value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const list = el("ul");
  for (const item of value) {
    const suggestion = asRecord(item);
    const row = el("li");
    if (typeof suggestion.term === "string") row.append(el("strong", suggestion.term));
    const candidates = suggestion.candidates;
    if (Array.isArray(candidates)) {
      const candidateList = el("ul");
      for (const candidate of candidates) candidateList.append(el("li", resultItemText(candidate)));
      row.append(candidateList);
    } else if (candidates !== undefined) {
      row.append(el("p", resultItemText(candidates)));
    }
    if (!row.hasChildNodes()) row.textContent = resultItemText(item);
    list.append(row);
  }
  if (value.length === 0) target.append(el("p", "候補はありませんでした。"));
  else target.append(list);
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
  if (Object.hasOwn(data, "suggestions")) {
    const block = section("同義語候補");
    rendered = appendSynonymSuggestions(block, data.suggestions) || rendered;
    if (block.childNodes.length > 1) content.append(block);
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

async function invoke(context: BrowserModuleContext, actionId: BrowserAction, inputValue: unknown): Promise<ActionCall> {
  const result = await context.invoke(actionId, inputValue);
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  if (![...ACTIONS, ...STORY_ACTIONS].includes(actionId)) throw new Error("Unknown assistant action");
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

function bindPreviewAction(
  buttonNode: HTMLButtonElement,
  buildInput: () => unknown,
  context: BrowserModuleContext,
  actionId: AssistantAction,
  status: HTMLOutputElement,
  resultNode: HTMLElement,
  cleanup: Cleanup,
): void {
  bindAction(buttonNode, buildInput, context, actionId, status, resultNode, cleanup, {
    loading: "送信前のプロンプトを組み立てています…",
    done: "実際の送信内容をプレビューしています。",
  });
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
  const intro = el("p", "対象文を指定して言い換え候補を生成します。使う候補を選ぶと変更案がレビューキューに送られ、承認前に原稿へ反映されません。");
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
    status.textContent = "生成をキャンセルしました。変更案は作成されていません。";
  };
  on(cancel, "click", cancelRun, cleanup);
  const abortFromHost = () => controller?.abort(context.signal.reason);
  context.signal.addEventListener("abort", abortFromHost, { once: true });
  cleanup.push(() => context.signal.removeEventListener("abort", abortFromHost));

  const onRun = async () => {
    const source = selectedText.value;
    const sourceSceneId = sceneId.value.trim();
    if (!sourceSceneId || !source.trim()) {
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
        body: JSON.stringify({ sceneId: sourceSceneId, selectedText: source, ...(instruction.value.trim() ? { instruction: instruction.value.trim() } : {}) }),
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
          displayRewriteFinal(result, data, source, sourceSceneId, sceneId, selectedText, context, status);
          status.textContent = "候補を受け取りました。使う候補を選んで変更案を作成してください。";
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
        if (!context.signal.aborted && userCancelled) status.textContent = "生成をキャンセルしました。変更案は作成されていません。";
      } else if (!context.signal.aborted) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
      if (streamEvent === "cancelled" && !context.signal.aborted) status.textContent = "生成をキャンセルしました。変更案は作成されていません。";
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

function displayRewriteFinal(
  target: HTMLElement,
  response: Data,
  sourceText: string,
  sourceSceneId: string,
  sceneIdInput: HTMLInputElement,
  selectedTextInput: HTMLTextAreaElement,
  context: BrowserModuleContext,
  status: HTMLOutputElement,
): void {
  const next = el("div");
  const choices = el("div");
  choices.style.display = "grid";
  choices.style.gap = "0.65rem";
  let busy = false;
  let proposalCreated = false;
  const proposalButtons: HTMLButtonElement[] = [];

  const createCandidate = (label: string, candidateText: unknown, rationale?: unknown): void => {
    if (typeof candidateText !== "string" || !candidateText.trim()) return;
    const card = el("article");
    card.style.border = "1px solid currentColor";
    card.style.borderRadius = "0.35rem";
    card.style.padding = "0.6rem";
    card.style.display = "grid";
    card.style.gap = "0.4rem";
    card.append(el("h5", label));
    const text = el("p", candidateText);
    text.style.whiteSpace = "pre-wrap";
    card.append(text);
    if (typeof rationale === "string" && rationale.trim()) {
      const reason = el("p", rationale);
      reason.style.whiteSpace = "pre-wrap";
      card.append(reason);
    }
    const propose = button(`${label}を変更案にする`);
    proposalButtons.push(propose);
    propose.addEventListener("click", async () => {
      if (busy || proposalCreated) return;
      if (context.signal.aborted) return;
      if (sceneIdInput.value.trim() !== sourceSceneId || selectedTextInput.value !== sourceText) {
        status.textContent = "シーンまたは対象文が変更されています。候補を再生成してください。";
        return;
      }
      busy = true;
      for (const candidateButton of proposalButtons) candidateButton.disabled = true;
      status.textContent = "選んだ言い換えを変更案にしています…";
      try {
        const proposalInput: Data = {
          sceneId: sourceSceneId,
          selectedText: sourceText,
          replacementText: candidateText,
        };
        if (typeof response.sentenceIndex === "number" && Number.isFinite(response.sentenceIndex)) {
          proposalInput.sentenceIndex = response.sentenceIndex;
        }
        const created = await invoke(context, "assistant.rewrite.propose", proposalInput);
        if (context.signal.aborted) return;
        proposalCreated = true;
        status.textContent = proposalStatus(created, "選んだ候補を変更案として送りました。レビューキューで確認できます。");
        for (const candidateButton of proposalButtons) candidateButton.disabled = true;
      } catch (error) {
        if (!context.signal.aborted) status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        busy = false;
        if (!context.signal.aborted) {
          for (const candidateButton of proposalButtons) candidateButton.disabled = proposalCreated;
        }
      }
    });
    card.append(propose);
    choices.append(card);
  };

  const suggestions = Array.isArray(response.suggestions) ? response.suggestions : [];
  const strategyLabels: Record<string, string> = {
    concise: "簡潔案",
    contextual: "文脈案",
    voice: "口調案",
  };
  for (const item of suggestions) {
    const suggestion = asRecord(item);
    const strategy = typeof suggestion.strategy === "string" ? suggestion.strategy : "言い換え案";
    const sourceLabel = suggestion.source === "source-heuristic" ? "（ローカル定型候補）" : "";
    createCandidate(`${strategyLabels[strategy] ?? strategy}${sourceLabel}`, suggestion.text, suggestion.rationale);
  }
  const sentenceSplit = asRecord(response.sentenceSplit);
  if (typeof sentenceSplit.text === "string") createCandidate("文分割案", sentenceSplit.text, sentenceSplit.rationale);
  const tellToShow = asRecord(response.tellToShow);
  if (typeof tellToShow.text === "string") {
    const source = tellToShow.source === "corpus" ? "コーパス" : "ヒューリスティック";
    createCandidate(`tell→show（${source}）`, tellToShow.text, tellToShow.rationale);
  }

  const knownMetadata: Data = {};
  for (const key of ["model", "provider", "promptVersion", "citations", "provenance"]) {
    if (Object.hasOwn(response, key)) knownMetadata[key] = response[key];
  }
  const details = el("details");
  details.append(el("summary", "モデル・根拠情報"));
  const meta = el("pre");
  meta.style.whiteSpace = "pre-wrap";
  meta.style.overflowWrap = "anywhere";
  meta.textContent = JSON.stringify(knownMetadata, null, 2) ?? String(knownMetadata);
  details.append(meta);
  if (choices.childNodes.length === 0) next.append(el("p", "利用できる候補がありませんでした。"));
  else next.append(el("h4", "言い換え候補を選択"), choices);
  next.append(details);
  target.replaceChildren(next);
}

function mountSummaries(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  const intro = el("p", "保存済みのシーンまたは章を指定して、要約案を生成します。候補はレビュー対象として扱います。");
  const sceneId = input("scene ID");
  const chapterId = input("chapter ID");
  const sceneStatus = statusNode();
  const sceneResult = el("div");
  const sceneRun = button("シーン要約を作る");
  const scenePreviewStatus = statusNode();
  const scenePreviewResult = el("div");
  const scenePreview = button("シーン要約プロンプトを確認");
  bindAction(sceneRun, () => ({ sceneId: sceneId.value.trim() }), context, "assistant.summary.scene", sceneStatus, sceneResult, cleanup, { loading: "シーン要約を生成しています…", done: "シーン要約を受け取りました。" });
  bindPreviewAction(scenePreview, () => ({ sceneId: sceneId.value.trim() }), context, "assistant.summary.scene.preview", scenePreviewStatus, scenePreviewResult, cleanup);
  const chapterStatus = statusNode();
  const chapterResult = el("div");
  const chapterRun = button("章要約を作る");
  const chapterPreviewStatus = statusNode();
  const chapterPreviewResult = el("div");
  const chapterPreview = button("章要約プロンプトを確認");
  bindAction(chapterRun, () => ({ chapterId: chapterId.value.trim() }), context, "assistant.summary.chapter", chapterStatus, chapterResult, cleanup, { loading: "章要約を生成しています…", done: "章要約を受け取りました。" });
  bindPreviewAction(chapterPreview, () => ({ chapterId: chapterId.value.trim() }), context, "assistant.summary.chapter.preview", chapterPreviewStatus, chapterPreviewResult, cleanup);
  const sceneSection = section("シーン要約");
  sceneSection.append(field("シーン ID", sceneId), scenePreview, scenePreviewStatus, scenePreviewResult, sceneRun, sceneStatus, sceneResult);
  const chapterSection = section("章要約");
  chapterSection.append(field("章 ID", chapterId), chapterPreview, chapterPreviewStatus, chapterPreviewResult, chapterRun, chapterStatus, chapterResult);
  root.append(intro, sceneSection, chapterSection);
}

function mountQa(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  const intro = el("p", "作品内の設定について質問し、回答と根拠を確認します。回答は執筆者の判断を置き換えません。");
  const question = textarea(4, "作品内の設定について質問");
  question.setAttribute("aria-label", "質問");
  const sceneId = input("scene ID（任意）");
  const run = button("設定に質問する");
  const retry = button("回答を再試行");
  retry.hidden = true;
  const cancel = button("回答生成をキャンセル");
  cancel.hidden = true;
  const clear = button("会話をクリア");
  const promptPreview = button("QAシステムプロンプトを確認");
  const promptPreviewStatus = statusNode();
  const promptPreviewResult = el("div");
  const status = statusNode();
  const conversation = el("div");
  const preview = el("div");
  type QaTurn = { role: "user" | "assistant"; content: string; citations?: unknown; confidence?: unknown };
  const turns: QaTurn[] = [];
  let retryPrompt: string | undefined;
  let controller: AbortController | undefined;
  let userCancelled = false;

  const renderConversation = () => {
    const items = turns.map((turn) => {
      const article = el("article");
      article.style.border = "1px solid currentColor";
      article.style.borderRadius = "0.35rem";
      article.style.padding = "0.6rem";
      article.style.marginBlock = "0.5rem";
      article.append(el("h4", turn.role === "user" ? "質問" : "回答"));
      const content = el("p", turn.content);
      content.style.whiteSpace = "pre-wrap";
      article.append(content);
      if (turn.role === "assistant") {
        if (typeof turn.confidence === "string" || typeof turn.confidence === "number") {
          article.append(el("p", `確度: ${String(turn.confidence)}`));
        }
        if (Array.isArray(turn.citations) && turn.citations.length > 0) {
          const evidence = section("根拠");
          const list = el("ul");
          for (const value of turn.citations) {
            const citation = asRecord(value);
            const identity = [citation.kind, citation.id].filter((part) => typeof part === "string").join(":");
            const quote = typeof citation.quote === "string" ? citation.quote : resultItemText(value);
            const location = [citation.path, citation.revision].filter((part) => typeof part === "string").join(" · ");
            const item = el("li");
            item.textContent = `${identity ? `[${identity}] ` : ""}${quote}${location ? ` (${location})` : ""}`;
            list.append(item);
          }
          evidence.append(list);
          article.append(evidence);
        }
      }
      return article;
    });
    conversation.replaceChildren(...items);
  };

  const cancelRun = () => {
    if (!controller) return;
    userCancelled = true;
    controller.abort();
    retryPrompt = question.value.trim() || retryPrompt;
    status.textContent = "回答生成をキャンセルしました。会話には追加されていません。";
    cancel.hidden = true;
  };
  on(cancel, "click", cancelRun, cleanup);
  on(clear, "click", () => {
    if (controller) return;
    turns.splice(0, turns.length);
    retryPrompt = undefined;
    question.value = "";
    retry.hidden = true;
    renderConversation();
    status.textContent = "会話をクリアしました。";
  }, cleanup);
  const abortFromHost = () => controller?.abort(context.signal.reason);
  context.signal.addEventListener("abort", abortFromHost, { once: true });
  cleanup.push(() => context.signal.removeEventListener("abort", abortFromHost));

  const ask = async () => {
    const prompt = question.value.trim() || retryPrompt || "";
    const sourceSceneId = sceneId.value.trim();
    if (!prompt) {
      status.textContent = "質問を入力してください。";
      return;
    }
    const messages = [...turns.map(({ role, content }) => ({ role, content })), { role: "user" as const, content: prompt }];
    if (messages.length > 20) {
      status.textContent = "会話は最大20件です。会話をクリアしてから質問してください。";
      return;
    }
    controller?.abort();
    controller = new AbortController();
    userCancelled = false;
    retry.hidden = true;
    run.disabled = true;
    question.disabled = true;
    sceneId.disabled = true;
    clear.disabled = true;
    cancel.hidden = false;
    status.textContent = "質問への回答を作成しています…";
    preview.replaceChildren();
    let pendingText = "";
    let finalResponse: Data | undefined;
    let finalReceived = false;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(context.projectId)}/modules/assistant/qa/stream`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ ...(sourceSceneId ? { sceneId: sourceSceneId } : {}), messages }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const error = asRecord(body).error;
        throw new Error(typeof error === "string" ? error : `質問に失敗しました (${response.status})`);
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
          if (typeof data.delta === "string") pendingText += data.delta;
          else if (typeof payload === "string") pendingText += payload;
          const block = section("生成中の回答");
          const text = el("p", pendingText);
          text.style.whiteSpace = "pre-wrap";
          block.append(text);
          preview.replaceChildren(block);
        } else if (eventName === "final") {
          finalReceived = true;
          finalResponse = data;
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
      if (!finalReceived || typeof finalResponse?.answer !== "string") {
        throw new Error("生成が完了する前にストリームが終了しました。");
      }
      turns.push(
        { role: "user", content: prompt },
        { role: "assistant", content: finalResponse.answer, citations: finalResponse.citations, confidence: finalResponse.confidence },
      );
      retryPrompt = undefined;
      question.value = "";
      renderConversation();
      preview.replaceChildren();
      status.textContent = "回答と根拠を読み込みました。";
    } catch (error) {
      if (!context.signal.aborted) {
        retryPrompt = prompt;
        retry.hidden = false;
        if (userCancelled || controller.signal.aborted) {
          status.textContent = "回答生成をキャンセルしました。会話には追加されていません。";
        } else {
          status.textContent = error instanceof Error ? error.message : String(error);
        }
      }
      preview.replaceChildren();
    } finally {
      if (!context.signal.aborted) {
        cancel.hidden = true;
        run.disabled = false;
        question.disabled = false;
        sceneId.disabled = false;
        clear.disabled = false;
      }
    }
  };
  on(run, "click", () => { void ask(); }, cleanup);
  on(retry, "click", () => { void ask(); }, cleanup);
  bindPreviewAction(promptPreview, () => sceneId.value.trim() ? { sceneId: sceneId.value.trim() } : {}, context, "assistant.qa.preview", promptPreviewStatus, promptPreviewResult, cleanup);
  root.append(intro, field("質問", question), field("関連シーン（任意）", sceneId), promptPreview, promptPreviewStatus, promptPreviewResult, run, retry, cancel, clear, status, preview, conversation);
}

function mountContinuation(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  const intro = el("p", "シーンの続きを複数案で提案します。保存済みシーンに対応する現在の編集本文があれば、明示的に選んで続きを考えられます。結果は候補として表示され、原稿には書き込みません。");
  const sceneId = input("scene ID");
  const chapterId = input("chapter ID（任意）");
  const useEditorDraft = el("input");
  useEditorDraft.type = "checkbox";
  const initialDraft = context.readCurrentEditor?.() ?? null;
  useEditorDraft.checked = Boolean(initialDraft);
  if (initialDraft) sceneId.value = initialDraft.sceneId;
  const useEditorDraftLabel = el("label", "選択シーンと一致する現在の編集本文を使う");
  useEditorDraftLabel.prepend(useEditorDraft);
  const loadEditorScene = button("現在の編集シーンを選ぶ");
  const editorStatus = statusNode();
  on(loadEditorScene, "click", () => {
    const draft = context.readCurrentEditor?.();
    if (!draft) {
      editorStatus.textContent = "現在の編集シーンを読み取れません。保存済み本文または直近の文を指定してください。";
      return;
    }
    sceneId.value = draft.sceneId;
    useEditorDraft.checked = true;
    editorStatus.textContent = `編集中の本文から末尾12文を使います (${draft.documentPath})。保存済み本文の代わりに現在の編集本文を参照します。`;
  }, cleanup);
  const recentSentences = textarea(5, "直近の文を1文ずつ入力（空欄ならシーン本文を使います）");
  const k = el("input");
  k.type = "number";
  k.min = "0";
  k.max = "40";
  k.step = "1";
  k.value = "8";
  const run = button("続きの候補を作る");
  const status = statusNode();
  const result = el("div");
  const promptPreview = button("続きを考えるプロンプトを確認");
  const promptPreviewStatus = statusNode();
  const promptPreviewResult = el("div");
  const selectedEditorDraft = () => {
    if (!useEditorDraft.checked) return undefined;
    const current = context.readCurrentEditor?.() ?? null;
    return current?.sceneId === sceneId.value.trim() ? current : undefined;
  };
  const requestInput = (editorDraft: BrowserEditorDocument | undefined) => {
    return {
      ...(sceneId.value.trim() ? { sceneId: sceneId.value.trim() } : {}),
      ...(chapterId.value.trim() ? { chapterId: chapterId.value.trim() } : {}),
      ...(editorDraft ? { editorDraft } : recentSentences.value.trim() ? { recentSentences: recentSentences.value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean) } : {}),
      k: Number(k.value),
    };
  };
  const editorDraftRequiredMessage = "現在の編集本文を使う設定ですが、選択シーンの編集本文を確認できません。編集シーンを選び直すか、この設定を解除してください。";
  on(run, "click", () => {
    const editorDraft = selectedEditorDraft();
    if (useEditorDraft.checked && !editorDraft) {
      status.textContent = editorDraftRequiredMessage;
      return;
    }
    void runAction(context, "assistant.continuation", requestInput(editorDraft), run, status, result, "続きを考えています…", "続きの候補を受け取りました。");
  }, cleanup);
  on(promptPreview, "click", () => {
    const editorDraft = selectedEditorDraft();
    if (useEditorDraft.checked && !editorDraft) {
      promptPreviewStatus.textContent = editorDraftRequiredMessage;
      return;
    }
    const inputValue = requestInput(editorDraft);
    void runAction(context, "assistant.continuation.preview", inputValue, promptPreview, promptPreviewStatus, promptPreviewResult, "送信前のプロンプトを組み立てています…", "実際の送信内容をプレビューしています。");
  }, cleanup);
  root.append(intro, field("シーン ID（任意）", sceneId), loadEditorScene, useEditorDraftLabel, editorStatus, field("章 ID（任意）", chapterId), field("直近の文（各行を1文として扱います。編集本文を使う場合は直近12文を自動選択）", recentSentences), field("使用する直近文数 k（0〜40）", k), promptPreview, promptPreviewStatus, promptPreviewResult, run, status, result);
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
  const promptPreview = button("レビュー用プロンプト骨組みを確認");
  const promptPreviewStatus = statusNode();
  const promptPreviewResult = el("div");
  const status = statusNode();
  const result = el("div");
  const buildInput = () => ({ chapterId: chapterId.value.trim(), aspects: checks.flatMap((item, index) => {
    const checkbox = item.querySelector("input");
    return checkbox?.checked ? [aspectChoices[index]![0]] : [];
  }) });
  bindAction(run, buildInput, context, "assistant.aspect.review", status, result, cleanup, { loading: "章をレビューしています…", done: "レビュー結果を受け取りました。" });
  bindPreviewAction(promptPreview, buildInput, context, "assistant.aspect.review.preview", promptPreviewStatus, promptPreviewResult, cleanup);
  const aspectSection = section("確認する観点");
  for (const choice of checks) aspectSection.append(choice);
  root.append(intro, field("章 ID", chapterId), aspectSection, promptPreview, promptPreviewStatus, promptPreviewResult, run, status, result);
}

function parseList(value: string): string[] {
  return value.split(/[\n,、]/u).map((item) => item.trim()).filter(Boolean);
}

function savedDialogueLineText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => {
    const line = asRecord(item);
    return typeof line.speakerEntityId === "string" && typeof line.text === "string"
      ? [`${line.speakerEntityId}\t${line.text}`]
      : [];
  }).join("\n");
}

function parseDialogueLines(value: string): Array<{ speakerEntityId: string; text: string }> {
  return value.split(/\r?\n/u).filter((line) => line.trim().length > 0).map((line) => {
    const separator = line.indexOf("\t");
    const text = line.slice(separator + 1);
    if (separator <= 0 || !text.trim()) {
      throw new Error("発話は「話者エンティティ ID、タブ、本文」の形式で入力してください。");
    }
    return { speakerEntityId: line.slice(0, separator).trim(), text };
  });
}

async function loadDialogueSketches(context: BrowserModuleContext): Promise<Data[]> {
  const response = await invoke(context, "story.entities.list", { type: "dialogue_sketch" });
  if (!Array.isArray(response.data)) throw new Error("対話スケッチ一覧を読み取れませんでした。");
  return response.data.map(asRecord).filter((item) => typeof item.id === "string" && item.type === "dialogue_sketch");
}

function dialogueSketchLabel(sketch: Data): string {
  const raw = asRecord(sketch.raw);
  return typeof raw.title === "string" && raw.title.trim()
    ? raw.title
    : typeof sketch.name === "string" && sketch.name.trim()
      ? sketch.name
      : String(sketch.id ?? "対話スケッチ");
}

function mountDialogue(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  const intro = el("p", "保存済み対話スケッチを読み込むか、参加者と発話を入力して、お題やターン候補を作ります。生成結果は確認用の候補です。");
  const sketchPicker = el("select");
  sketchPicker.setAttribute("aria-label", "保存済みスケッチ");
  sketchPicker.append(new Option("手動入力", ""));
  const loadSketches = button("保存済みスケッチを読み込む");
  const sketchStatus = statusNode();
  let savedSketches: Data[] = [];
  const participants = textarea(2, "参加するキャラクター ID（改行または読点区切り）");
  participants.setAttribute("aria-label", "対話の参加者");
  const topic = input("対話のお題");
  const situation = textarea(2, "状況（任意）");
  const preceding = textarea(5, "話者 ID、タブ、本文を1行ずつ入力");
  preceding.setAttribute("aria-label", "これまでの発話");
  const speaker = el("select");
  speaker.setAttribute("aria-label", "次のターンの話者");
  const syncSpeakers = () => {
    const current = speaker.value;
    speaker.replaceChildren(new Option("話者を選択", ""));
    for (const id of parseList(participants.value)) speaker.append(new Option(id, id));
    speaker.value = parseList(participants.value).includes(current) ? current : parseList(participants.value)[0] ?? "";
  };
  on(participants, "input", syncSpeakers, cleanup);
  const turnMode = el("select");
  turnMode.setAttribute("aria-label", "生成モード");
  turnMode.append(new Option("1人の次のターン", "single"), new Option("複数ターン", "bulk"));
  const lineCount = el("input");
  lineCount.type = "number";
  lineCount.min = "1";
  lineCount.max = "30";
  lineCount.step = "1";
  lineCount.value = "6";
  lineCount.setAttribute("aria-label", "生成ターン数");
  const speakerField = field("次の話者", speaker);
  const lineCountField = field("生成ターン数", lineCount);
  const updateTurnMode = () => {
    const single = turnMode.value === "single";
    speakerField.hidden = !single;
    lineCountField.hidden = single;
  };
  on(turnMode, "change", updateTurnMode, cleanup);
  syncSpeakers();
  updateTurnMode();

  on(loadSketches, "click", async () => {
    loadSketches.disabled = true;
    sketchStatus.textContent = "保存済みスケッチを読み込んでいます…";
    try {
      savedSketches = await loadDialogueSketches(context);
      if (context.signal.aborted) return;
      const selected = sketchPicker.value;
      sketchPicker.replaceChildren(new Option("手動入力", ""));
      for (const sketch of savedSketches) sketchPicker.append(new Option(dialogueSketchLabel(sketch), String(sketch.id)));
      sketchPicker.value = savedSketches.some((sketch) => sketch.id === selected) ? selected : "";
      sketchStatus.textContent = `${savedSketches.length} 件の対話スケッチを読み込みました。`;
    } catch (error) {
      if (!context.signal.aborted) sketchStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (!context.signal.aborted) loadSketches.disabled = false;
    }
  }, cleanup);
  on(sketchPicker, "change", () => {
    const sketch = savedSketches.find((item) => item.id === sketchPicker.value);
    if (!sketch) return;
    const raw = asRecord(sketch.raw);
    participants.value = Array.isArray(raw.participantEntityIds)
      ? raw.participantEntityIds.filter((id): id is string => typeof id === "string").join("、")
      : "";
    topic.value = typeof raw.title === "string" ? raw.title : "";
    situation.value = typeof raw.situation === "string" ? raw.situation : "";
    preceding.value = savedDialogueLineText(raw.lines);
    syncSpeakers();
  }, cleanup);

  const topics = button("お題を提案");
  const topicStatus = statusNode();
  const topicResult = el("div");
  const topicPreview = button("お題プロンプトを確認");
  const topicPreviewStatus = statusNode();
  const topicPreviewResult = el("div");
  const topicInput = () => ({ participantEntityIds: parseList(participants.value) });
  bindAction(topics, topicInput, context, "assistant.dialogue.topics", topicStatus, topicResult, cleanup, { loading: "対話のお題を考えています…", done: "お題候補を受け取りました。" });
  bindPreviewAction(topicPreview, topicInput, context, "assistant.dialogue.topics.preview", topicPreviewStatus, topicPreviewResult, cleanup);
  const turns = button("次のターンを提案");
  const turnPreview = button("ターン生成プロンプトを確認");
  const turnStatus = statusNode();
  const turnResult = el("div");
  const turnPreviewStatus = statusNode();
  const turnPreviewResult = el("div");
  const buildTurnInput = (): Data | undefined => {
    const participantEntityIds = parseList(participants.value);
    let precedingLines: Array<{ speakerEntityId: string; text: string }>;
    try {
      precedingLines = parseDialogueLines(preceding.value);
    } catch (error) {
      turnStatus.textContent = error instanceof Error ? error.message : String(error);
      turnPreviewStatus.textContent = turnStatus.textContent;
      return undefined;
    }
    const inputValue: Data = {
      participantEntityIds,
      precedingLines,
      ...(sketchPicker.value ? { sketchId: sketchPicker.value } : {}),
      ...(topic.value.trim() ? { topic: topic.value.trim() } : {}),
      ...(situation.value.trim() ? { situation: situation.value.trim() } : {}),
    };
    if (turnMode.value === "single") {
      if (!speaker.value) {
        turnStatus.textContent = "次のターンの話者を選んでください。";
        turnPreviewStatus.textContent = turnStatus.textContent;
        return undefined;
      }
      inputValue.speakerEntityId = speaker.value;
    } else {
      const count = Number(lineCount.value);
      if (!Number.isInteger(count) || count < 1 || count > 30) {
        turnStatus.textContent = "ターン数は 1〜30 の整数で指定してください。";
        turnPreviewStatus.textContent = turnStatus.textContent;
        return undefined;
      }
      inputValue.lineCount = count;
    }
    return inputValue;
  };
  on(turns, "click", () => {
    const inputValue = buildTurnInput();
    if (!inputValue) return;
    void runAction(context, "assistant.dialogue.turns", inputValue, turns, turnStatus, turnResult, "対話の続き方を考えています…", "ターン候補を受け取りました。");
  }, cleanup);
  on(turnPreview, "click", () => {
    const inputValue = buildTurnInput();
    if (!inputValue) return;
    const actionId = turnMode.value === "single" ? "assistant.dialogue.turn.preview" : "assistant.dialogue.turns.preview";
    void runAction(context, actionId, inputValue, turnPreview, turnPreviewStatus, turnPreviewResult, "プロンプトを組み立てています…", "モデルへ送るプロンプトを表示しました。");
  }, cleanup);
  root.append(intro, field("保存済みスケッチ", sketchPicker), loadSketches, sketchStatus, field("参加者", participants), field("お題", topic), field("状況", situation), field("これまでの発話（話者 ID + タブ + 本文）", preceding), topicPreview, topicPreviewStatus, topicPreviewResult, topics, topicStatus, topicResult, field("生成モード", turnMode), speakerField, lineCountField, turnPreview, turnPreviewStatus, turnPreviewResult, turns, turnStatus, turnResult);
}

function mountReaderReaction(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  const intro = el("p", "指定した章までの読者として、疑問、期待、混乱の候補を作ります。");
  const chapterId = input("chapter ID");
  const preview = button("初読プロンプトを確認");
  const previewStatus = statusNode();
  const previewResult = el("div");
  const run = button("初読の反応を作る");
  const status = statusNode();
  const result = el("div");
  bindPreviewAction(preview, () => ({ chapterId: chapterId.value.trim() }), context, "assistant.reader.reaction.preview", previewStatus, previewResult, cleanup);
  bindAction(run, () => ({ chapterId: chapterId.value.trim() }), context, "assistant.reader.reaction", status, result, cleanup, { loading: "初読レポートを作っています…", done: "初読レポートを受け取りました。" });
  root.append(intro, field("章 ID", chapterId), preview, previewStatus, previewResult, run, status, result);
}

function mountProposals(root: HTMLElement, context: BrowserModuleContext, cleanup: Cleanup): void {
  const intro = el("p", "各支援機能はレビュー用の変更案を作成します。案の確認と承認は執筆者がレビューキューで行います。");

  const zukanSection = section("図鑑の記述案");
  const zukanSource = el("select");
  zukanSource.setAttribute("aria-label", "提案対象");
  zukanSource.append(new Option("原稿・図鑑", "manuscript"), new Option("対話スケッチ（sandbox）", "sandbox"));
  const entityId = input("キャラクター / エンティティ ID");
  const blockPath = input("対象ブロック（任意）");
  const zukanPrompt = textarea(3, "提案の方向（任意）");
  const manuscriptControls = el("div");
  manuscriptControls.append(field("エンティティ ID", entityId), field("対象ブロック", blockPath), field("指示", zukanPrompt));

  const sandboxControls = el("div");
  sandboxControls.hidden = true;
  const sandboxSketch = el("select");
  sandboxSketch.setAttribute("aria-label", "sandbox 対話スケッチ");
  sandboxSketch.append(new Option("対話スケッチを選択", ""));
  const loadSandboxSketches = button("sandbox のスケッチ一覧を読み込む");
  const sandboxSketchStatus = statusNode();
  let savedSketches: Data[] = [];
  const rangeStart = el("input");
  rangeStart.type = "number";
  rangeStart.min = "1";
  rangeStart.step = "1";
  rangeStart.value = "1";
  rangeStart.setAttribute("aria-label", "開始ターン");
  const rangeEnd = el("input");
  rangeEnd.type = "number";
  rangeEnd.min = "1";
  rangeEnd.step = "1";
  rangeEnd.value = "1";
  rangeEnd.setAttribute("aria-label", "終了ターン");
  const sandboxPreview = button("sandbox 図鑑分析プロンプトを確認");
  const sandboxPreviewStatus = statusNode();
  const sandboxPreviewResult = el("div");
  on(loadSandboxSketches, "click", async () => {
    loadSandboxSketches.disabled = true;
    sandboxSketchStatus.textContent = "sandbox のスケッチを読み込んでいます…";
    try {
      savedSketches = await loadDialogueSketches(context);
      if (context.signal.aborted) return;
      const previous = sandboxSketch.value;
      sandboxSketch.replaceChildren(new Option("対話スケッチを選択", ""));
      for (const sketch of savedSketches) sandboxSketch.append(new Option(dialogueSketchLabel(sketch), String(sketch.id)));
      sandboxSketch.value = savedSketches.some((sketch) => sketch.id === previous) ? previous : "";
      sandboxSketchStatus.textContent = `${savedSketches.length} 件のsandboxスケッチを読み込みました。`;
    } catch (error) {
      if (!context.signal.aborted) sandboxSketchStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (!context.signal.aborted) loadSandboxSketches.disabled = false;
    }
  }, cleanup);
  on(sandboxSketch, "change", () => {
    const sketch = savedSketches.find((item) => item.id === sandboxSketch.value);
    const lines = Array.isArray(asRecord(sketch?.raw).lines) ? asRecord(sketch?.raw).lines as unknown[] : [];
    const max = Math.max(lines.length, 1);
    rangeStart.max = String(max);
    rangeEnd.max = String(max);
    rangeStart.value = "1";
    rangeEnd.value = String(max);
  }, cleanup);
  sandboxControls.append(
    field("保存済み対話スケッチ", sandboxSketch),
    loadSandboxSketches,
    sandboxSketchStatus,
    field("開始ターン", rangeStart),
    field("終了ターン", rangeEnd),
  );
  const syncZukanSource = () => {
    const sandbox = zukanSource.value === "sandbox";
    manuscriptControls.hidden = sandbox;
    sandboxControls.hidden = !sandbox;
    sandboxPreview.hidden = !sandbox;
    sandboxPreviewStatus.hidden = !sandbox;
    sandboxPreviewResult.hidden = !sandbox;
  };
  on(zukanSource, "change", syncZukanSource, cleanup);
  syncZukanSource();
  const zukanRun = button("図鑑の変更案を作る");
  const zukanStatus = statusNode();
  const zukanResult = el("div");
  on(zukanRun, "click", () => {
    if (zukanSource.value === "sandbox") {
      const sketch = savedSketches.find((item) => item.id === sandboxSketch.value);
      const lines = Array.isArray(asRecord(sketch?.raw).lines) ? asRecord(sketch?.raw).lines as unknown[] : [];
      const start = Number(rangeStart.value);
      const end = Number(rangeEnd.value);
      if (!sketch) {
        zukanStatus.textContent = "sandbox の対話スケッチを選択してください。";
        return;
      }
      if (lines.length === 0 || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
        zukanStatus.textContent = "ターン範囲はスケッチ内の発話から指定してください。";
        return;
      }
      void runAction(context, "assistant.zukan.suggestions", {
        source: "sandbox",
        sourceSessionId: String(sketch.id),
        turnRange: { start: start - 1, end: end - 1 },
      }, zukanRun, zukanStatus, zukanResult, "sandbox の変更案を作っています…", "sandbox の図鑑変更案を作成しました。");
      return;
    }
    if (!entityId.value.trim()) {
      zukanStatus.textContent = "エンティティ ID を入力してください。";
      return;
    }
    void runAction(context, "assistant.zukan.suggestions", {
      entityId: entityId.value.trim(),
      ...(blockPath.value.trim() ? { blockPath: blockPath.value.trim() } : {}),
      ...(zukanPrompt.value.trim() ? { prompt: zukanPrompt.value.trim() } : {}),
    }, zukanRun, zukanStatus, zukanResult, "図鑑の変更案を作っています…", "図鑑の変更案を作成しました。");
  }, cleanup);
  on(sandboxPreview, "click", () => {
    const sketch = savedSketches.find((item) => item.id === sandboxSketch.value);
    const lines = Array.isArray(asRecord(sketch?.raw).lines) ? asRecord(sketch?.raw).lines as unknown[] : [];
    const start = Number(rangeStart.value);
    const end = Number(rangeEnd.value);
    if (!sketch || lines.length === 0 || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
      sandboxPreviewStatus.textContent = "ターン範囲は保存済みスケッチ内の発話から指定してください。";
      return;
    }
    void runAction(context, "assistant.zukan.sandbox.preview", {
      sketchId: String(sketch.id), turnRange: { start: start - 1, end: end - 1 },
    }, sandboxPreview, sandboxPreviewStatus, sandboxPreviewResult, "sandbox の実際のプロンプトを組み立てています…", "モデルへ送るプロンプトを表示しました。");
  }, cleanup);
  zukanSection.append(field("提案対象", zukanSource), manuscriptControls, sandboxControls, sandboxPreview, sandboxPreviewStatus, sandboxPreviewResult, zukanRun, zukanStatus, zukanResult);

  const synonymsSection = section("同義語・言い換え候補");
  const original = input("診断対象の語句");
  const sentence = textarea(3, "診断対象を含む原文の一文");
  const reason = input("診断理由（任意）");
  const synonymsRun = button("候補をレビュー案にする");
  const synonymsPreview = button("同義語プロンプトを確認");
  const synonymsStatus = statusNode();
  const synonymsResult = el("div");
  const synonymInput = () => ({
    original: original.value.trim(),
    sentence: sentence.value,
    ...(reason.value.trim() ? { reason: reason.value.trim() } : {}),
  });
  const synonymsPreviewStatus = statusNode();
  const synonymsPreviewResult = el("div");
  bindAction(synonymsRun, () => ({ suggestions: [synonymInput()] }), context, "assistant.synonyms.suggestions", synonymsStatus, synonymsResult, cleanup, { loading: "同義語候補を作っています…", done: "同義語候補を作成しました。" });
  bindPreviewAction(synonymsPreview, synonymInput, context, "assistant.synonyms.preview", synonymsPreviewStatus, synonymsPreviewResult, cleanup);
  synonymsSection.append(field("語句", original), field("原文の一文", sentence), field("診断理由（任意）", reason), synonymsPreview, synonymsPreviewStatus, synonymsPreviewResult, synonymsRun, synonymsStatus, synonymsResult);

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
  const useEditorDraft = el("input");
  useEditorDraft.type = "checkbox";
  useEditorDraft.checked = Boolean(context.readCurrentEditor?.());
  const useEditorDraftLabel = el("label", "編集中の本文を使う");
  useEditorDraftLabel.prepend(useEditorDraft);
  const loadEditorScene = button("現在の編集シーンを選ぶ");
  const speakerRun = button("話者候補を確認する");
  const speakerStatus = statusNode();
  const speakerResult = el("div");
  on(loadEditorScene, "click", () => {
    const draft = context.readCurrentEditor?.();
    if (!draft) {
      speakerStatus.textContent = "現在の編集シーンを読み取れません。保存済み本文を使うか、シーン ID を入力してください。";
      return;
    }
    speakerSceneId.value = draft.sceneId;
    useEditorDraft.checked = true;
    speakerStatus.textContent = `編集中の本文を使用します (${draft.documentPath})。結果には編集画面とリモート基準点を別々に記録します。`;
  }, cleanup);
  on(speakerRun, "click", () => {
    const sceneId = speakerSceneId.value.trim();
    if (!sceneId) {
      speakerStatus.textContent = "シーン ID を入力するか、現在の編集シーンを選んでください。";
      return;
    }
    const draft = useEditorDraft.checked ? context.readCurrentEditor?.() ?? null : null;
    if (useEditorDraft.checked && (!draft || draft.sceneId !== sceneId)) {
      speakerStatus.textContent = "選択したシーンの現在の編集本文を確認できません。編集シーンを再選択するか、保存済み本文を使ってください。";
      return;
    }
    void runAction(context, "assistant.speaker.attribute", { sceneId, ...(draft ? { editorDraft: draft } : {}) }, speakerRun, speakerStatus, speakerResult, "話者候補を推定しています…", "話者候補を受け取りました。");
  }, cleanup);
  speakerSection.append(field("シーン ID", speakerSceneId), loadEditorScene, useEditorDraftLabel, speakerRun, speakerStatus, speakerResult);

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
