import type { BrowserModuleContext, BrowserModuleDefinition } from "@scriptorium/contracts";

type Data = Record<string, unknown>;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  return item;
}
function button(label: string): HTMLButtonElement { const item = node("button", label); item.type = "button"; return item; }
function output(): HTMLOutputElement { const item = node("output"); item.setAttribute("aria-live", "polite"); return item; }
function field(labelText: string, input: HTMLElement): HTMLLabelElement {
  const label = node("label"); label.append(node("span", labelText), input); label.style.display = "grid"; label.style.gap = "0.35rem"; return label;
}
async function invoke(context: BrowserModuleContext, id: string, input: unknown): Promise<Data> {
  const result = await context.invoke(id, input);
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.data as Data;
}

function startProgress(context: BrowserModuleContext, taskId: string, status: HTMLOutputElement, cleanup: Array<() => void>): void {
  const timer = window.setInterval(async () => {
    try {
      const data = await invoke(context, "semantic.task.status", {});
      const active = (data.activeTasks as Array<{ taskId: string; phase: string; completed: number; total: number }>).find((task) => task.taskId === taskId);
      if (active) status.textContent = `${active.phase}${active.total ? ` · ${active.completed}/${active.total}` : ""}`;
      else window.clearInterval(timer);
    } catch { window.clearInterval(timer); }
  }, 600);
  cleanup.push(() => window.clearInterval(timer));
}

function mountSearch(root: HTMLElement, context: BrowserModuleContext, cleanup: Array<() => void>, expressionOnly = false): void {
  const query = node("input"); query.type = "search"; query.maxLength = 8192; query.placeholder = "検索する文章や語句";
  const mode = node("select");
  for (const [value, label] of [["scene", "シーン"], ["sentence", "文"], ["expression", "表現"]]) { const option = node("option", label); option.value = value; mode.append(option); }
  mode.value = expressionOnly ? "expression" : "scene";
  const rerank = node("input"); rerank.type = "checkbox";
  const run = button("検索"); const cancel = button("キャンセル"); cancel.disabled = true;
  const status = output(); const results = node("ol"); let runningTask: string | null = null;
  const onCancel = async () => {
    if (!runningTask) return;
    try { await invoke(context, "semantic.task.cancel", { taskId: runningTask }); status.textContent = "キャンセルを要求しました。"; }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  };
  const onSearch = async () => {
    const taskId = crypto.randomUUID(); runningTask = taskId; run.disabled = true; cancel.disabled = false;
    results.replaceChildren(); status.textContent = "検索しています…"; startProgress(context, taskId, status, cleanup);
    try {
      const data = await invoke(context, expressionOnly ? "semantic.expressions.search" : "semantic.search", {
        query: query.value, mode: expressionOnly ? "expression" : mode.value, limit: 20,
        ...(!expressionOnly ? { rerank: rerank.checked } : {}), taskId,
      });
      const hits = data.results as Array<{ sceneId: string; sentenceIndex?: number; snippet?: string; score: number; name?: string; type?: string }>;
      for (const hit of hits) {
        const item = node("li");
        item.append(node("strong", `${hit.name ?? hit.sceneId}${hit.sentenceIndex === undefined ? "" : ` · 文 ${hit.sentenceIndex + 1}`}`));
        item.append(node("p", hit.snippet ?? ""));
        item.append(node("small", `${hit.type ?? "entity"} · RRF ${hit.score.toFixed(5)}`));
        results.append(item);
      }
      const warnings = [data.warning, data.rerankWarning].filter((warning): warning is string => typeof warning === "string" && warning.length > 0);
      status.textContent = `${hits.length} 件 · ${String(data.model ?? "index unavailable")} ${String(data.modelVersion ?? "")}${warnings.map((warning) => ` · ${warning}`).join("")}`;
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { runningTask = null; run.disabled = false; cancel.disabled = true; }
  };
  run.addEventListener("click", onSearch); cancel.addEventListener("click", onCancel);
  cleanup.push(() => run.removeEventListener("click", onSearch), () => cancel.removeEventListener("click", onCancel));
  if (context.signal.aborted) void onCancel();
  else { const onAbort = () => { void onCancel(); }; context.signal.addEventListener("abort", onAbort, { once: true }); cleanup.push(() => context.signal.removeEventListener("abort", onAbort)); }
  if (!expressionOnly) {
    void invoke(context, "semantic.settings.read", {}).then((data) => {
      if (!context.signal.aborted) rerank.checked = Boolean((data.settings as { rerankerEnabled?: boolean }).rerankerEnabled);
    }).catch(() => undefined);
  }
  root.append(field("検索語", query));
  if (!expressionOnly) root.append(field("検索モード", mode), field("上位30件を CPU 再ランキング", rerank));
  root.append(run, cancel, status, results);
}

function mountContradictions(root: HTMLElement, context: BrowserModuleContext, cleanup: Array<() => void>): void {
  const refresh = button("候補を更新"); const cancel = button("キャンセル"); cancel.disabled = true;
  const status = output(); const results = node("ol"); let runningTask: string | null = null;
  const onCancel = async () => {
    if (!runningTask) return;
    try { await invoke(context, "semantic.task.cancel", { taskId: runningTask }); status.textContent = "キャンセルを要求しました。"; }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  };
  const onRefresh = async () => {
    const taskId = crypto.randomUUID(); runningTask = taskId;
    refresh.disabled = true; cancel.disabled = false; status.textContent = "現在のスナップショットを確認しています…"; results.replaceChildren();
    startProgress(context, taskId, status, cleanup);
    try {
      const data = await invoke(context, "semantic.contradictions.rebuild", { taskId });
      const candidates = data.candidates as Array<{ id: string; kind: string; score: number; suspicion: string; evidenceA: { sceneId: string; quote: string }; evidenceB: { sceneId: string; quote: string } }>;
      for (const candidate of candidates) {
        const item = node("li"); item.append(node("strong", `${candidate.kind} · ${candidate.score.toFixed(3)}`), node("p", candidate.suspicion));
        item.append(node("blockquote", `${candidate.evidenceA.sceneId}: ${candidate.evidenceA.quote}`), node("blockquote", `${candidate.evidenceB.sceneId}: ${candidate.evidenceB.quote}`));
        const dismiss = button("棄却案を作成");
        const onDismiss = async () => {
          dismiss.disabled = true;
          try { const result = await invoke(context, "semantic.contradictions.dismiss", { candidateId: candidate.id }); status.textContent = `棄却案 ${String((result.proposal as { id?: string } | undefined)?.id ?? "")} をレビューに送りました。`; }
          catch (error) { status.textContent = error instanceof Error ? error.message : String(error); dismiss.disabled = false; }
        };
        dismiss.addEventListener("click", onDismiss); cleanup.push(() => dismiss.removeEventListener("click", onDismiss));
        item.append(dismiss); results.append(item);
      }
      status.textContent = `${candidates.length} 件 · ${data.indexAvailable ? "埋め込み候補を含む" : "ルール候補（インデックスなし）"}`;
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { runningTask = null; refresh.disabled = false; cancel.disabled = true; }
  };
  refresh.addEventListener("click", onRefresh); cancel.addEventListener("click", onCancel);
  cleanup.push(() => refresh.removeEventListener("click", onRefresh), () => cancel.removeEventListener("click", onCancel));
  if (context.signal.aborted) void onCancel();
  else { const onAbort = () => { void onCancel(); }; context.signal.addEventListener("abort", onAbort, { once: true }); cleanup.push(() => context.signal.removeEventListener("abort", onAbort)); }
  root.append(refresh, cancel, status, results); void onRefresh();
}

function mountIndex(root: HTMLElement, context: BrowserModuleContext, cleanup: Array<() => void>): void {
  const status = output(); const refresh = button("状態を更新"); const rebuild = button("インデックスを再構築");
  const cancel = button("キャンセル"); cancel.disabled = true;
  const rerank = node("input"); rerank.type = "checkbox";
  const save = button("再ランキング設定案を作成"); const privacy = node("p", "文埋め込みと再ランキングはローカルの監督対象 CPU worker で実行し、プロジェクト内容は外部へ送信しません。固定版モデルのファイルは未取得の場合にダウンロードされます。重みと派生インデックスはローカルキャッシュに保存されます。");
  let runningTask: string | null = null;
  const onRefresh = async () => {
    try {
      const [index, settings] = await Promise.all([invoke(context, "semantic.index.status", {}), invoke(context, "semantic.settings.read", {})]);
      status.textContent = `${index.indexAvailable ? `${String(index.passageCount)} 文 · ${String(index.indexUpdatedAt)}` : "このスナップショットのインデックスはありません"} · 埋め込みモデル ${String(index.modelVersion)} · worker ${index.modelLoaded ? "読込済み" : "未読込"}`;
      rerank.checked = Boolean((settings.settings as { rerankerEnabled?: boolean }).rerankerEnabled);
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  };
  const onRebuild = async () => {
    const taskId = crypto.randomUUID(); runningTask = taskId; rebuild.disabled = true; cancel.disabled = false; status.textContent = "インデックスを再構築しています…"; startProgress(context, taskId, status, cleanup);
    try {
      const data = await invoke(context, "semantic.index.rebuild", { taskId });
      status.textContent = `${String(data.scanned)} 文 · 新規 ${String(data.embedded)} · 再利用 ${String(data.reused)} · 削除 ${String(data.removed)}`;
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { runningTask = null; rebuild.disabled = false; cancel.disabled = true; }
  };
  const onCancel = () => runningTask ? invoke(context, "semantic.task.cancel", { taskId: runningTask }).catch(() => undefined) : undefined;
  const onSave = async () => {
    save.disabled = true;
    try { const data = await invoke(context, "semantic.settings.update", { rerankerEnabled: rerank.checked }); status.textContent = `設定案 ${String((data.proposal as { id?: string } | undefined)?.id ?? "")} をレビューに送りました。`; }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { save.disabled = false; }
  };
  refresh.addEventListener("click", onRefresh); rebuild.addEventListener("click", onRebuild); cancel.addEventListener("click", onCancel); save.addEventListener("click", onSave);
  cleanup.push(() => refresh.removeEventListener("click", onRefresh), () => rebuild.removeEventListener("click", onRebuild), () => cancel.removeEventListener("click", onCancel), () => save.removeEventListener("click", onSave));
  if (context.signal.aborted) void onCancel();
  else { const onAbort = () => { void onCancel(); }; context.signal.addEventListener("abort", onAbort, { once: true }); cleanup.push(() => context.signal.removeEventListener("abort", onAbort)); }
  root.append(refresh, status, rebuild, cancel, field("CPU 再ランキングを既定で有効にする", rerank), save, privacy);
  void onRefresh();
}

export const browserModule: BrowserModuleDefinition = {
  async mount(contributionId, root, context) {
    const cleanup: Array<() => void> = [];
    const title = node("h2", contributionId === "semantic.contradictions" ? "矛盾候補" : contributionId === "semantic.index" ? "意味インデックスとプライバシー" : contributionId === "semantic.expressions" ? "表現の在庫" : "意味検索");
    root.append(title);
    if (contributionId === "semantic.contradictions") mountContradictions(root, context, cleanup);
    else if (contributionId === "semantic.index") mountIndex(root, context, cleanup);
    else mountSearch(root, context, cleanup, contributionId === "semantic.expressions");
    return () => { for (const dispose of cleanup.reverse()) dispose(); root.replaceChildren(); };
  },
};
