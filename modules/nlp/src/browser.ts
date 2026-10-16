import type { BrowserModuleContext, BrowserModuleDefinition } from "@scriptorium/contracts";

type ActionData = Record<string, unknown>;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function field(labelText: string, input: HTMLElement): HTMLLabelElement {
  const label = element("label");
  label.append(element("span", labelText), input);
  label.style.display = "grid";
  label.style.gap = "0.35rem";
  return label;
}
function button(label: string): HTMLButtonElement {
  const node = element("button", label);
  node.type = "button";
  return node;
}
function statusNode(): HTMLOutputElement {
  const node = element("output");
  node.setAttribute("aria-live", "polite");
  return node;
}
async function invoke(context: BrowserModuleContext, action: string, input: unknown): Promise<ActionData> {
  const result = await context.invoke(action, input);
  if (!result.ok) throw new Error(result.error.message);
  return result.data as ActionData;
}

function mountAnalyzer(elementRoot: HTMLElement, context: BrowserModuleContext, cleanup: Array<() => void>): void {
  const text = element("textarea");
  text.rows = 6;
  text.maxLength = 1_000_000;
  text.placeholder = "解析する日本語の本文を入力";
  text.setAttribute("aria-label", "解析する日本語の本文");
  const run = button("形態素解析");
  const status = statusNode();
  const result = element("div");
  const onClick = async () => {
    run.disabled = true;
    status.textContent = "解析しています…";
    result.replaceChildren();
    try {
      const data = await invoke(context, "nlp.analyze", { text: text.value });
      const analysis = data.analysis as { tokens?: Array<{ surface: string; baseForm?: string; reading?: string; pos: string; start: number; end: number }>; sentences?: Array<{ text: string; start: number; end: number }> };
      const summary = element("p", `${analysis.tokens?.length ?? 0} 語、${analysis.sentences?.length ?? 0} 文。文字位置は UTF-16 の開始・終了オフセットです。`);
      const table = element("table");
      const head = element("tr");
      for (const title of ["語", "読み", "品詞", "位置"]) head.append(element("th", title));
      table.append(head);
      for (const token of analysis.tokens ?? []) {
        const row = element("tr");
        row.append(element("td", token.surface), element("td", token.reading ?? ""), element("td", token.pos), element("td", `${token.start}–${token.end}`));
        table.append(row);
      }
      result.append(summary, table);
      status.textContent = `解析エンジン: ${String(data.engine)} ${String(data.engineVersion)}`;
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { run.disabled = false; }
  };
  run.addEventListener("click", onClick);
  cleanup.push(() => run.removeEventListener("click", onClick));
  elementRoot.append(field("本文", text), run, status, result);
}

function mountCandidates(elementRoot: HTMLElement, context: BrowserModuleContext, cleanup: Array<() => void>): void {
  const run = button("候補を調べる");
  const status = statusNode();
  const list = element("ul");
  const onClick = async () => {
    run.disabled = true;
    status.textContent = "スナップショットの本文を解析しています…";
    list.replaceChildren();
    try {
      const data = await invoke(context, "nlp.discoverCandidates", {});
      const candidates = data.candidates as Array<{ term: string; reading: string | null; occurrenceCount: number }>;
      for (const candidate of candidates) {
        const item = element("li");
        const label = element("span", `${candidate.term}${candidate.reading ? `（${candidate.reading}）` : ""} · ${candidate.occurrenceCount}回 `);
        const ignore = button("候補を無視");
        const onIgnore = async () => {
          ignore.disabled = true;
          try {
            await invoke(context, "nlp.ignoreCandidates", { terms: [candidate.term] });
            item.remove();
            status.textContent = `「${candidate.term}」の除外を変更案として保存しました。`;
          } catch (error) {
            ignore.disabled = false;
            status.textContent = error instanceof Error ? error.message : String(error);
          }
        };
        ignore.addEventListener("click", onIgnore);
        cleanup.push(() => ignore.removeEventListener("click", onIgnore));
        item.append(label, ignore);
        list.append(item);
      }
      status.textContent = `${String(data.sourceCount)} 件の本文を確認しました。変更案は承認後に保存されます。`;
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { run.disabled = false; }
  };
  run.addEventListener("click", onClick);
  cleanup.push(() => run.removeEventListener("click", onClick));
  elementRoot.append(run, status, list);
}

function mountDictionary(elementRoot: HTMLElement, context: BrowserModuleContext, cleanup: Array<() => void>): void {
  const words = element("input");
  words.type = "text";
  words.placeholder = "語句を「、」区切りで入力";
  const tone = element("select");
  for (const [value, label] of [["", "文脈を指定しない"], ["negative", "緊迫した文脈"], ["positive", "高揚した文脈"]]) {
    const option = element("option", label);
    option.value = value;
    tone.append(option);
  }
  const save = button("同義語グループを提案");
  const status = statusNode();
  const onClick = async () => {
    const group = words.value.split(/[、,]/u).map((word) => word.trim()).filter(Boolean);
    save.disabled = true;
    try {
      await invoke(context, "nlp.saveSynonymGroup", { words: group, ...(tone.value ? { context: tone.value } : {}) });
      status.textContent = "辞書の変更案を保存しました。承認後にチェックポイントへ進めます。";
      words.value = "";
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { save.disabled = false; }
  };
  save.addEventListener("click", onClick);
  cleanup.push(() => save.removeEventListener("click", onClick));
  elementRoot.append(field("関連する語句（2語以上）", words), field("文脈", tone), save, status);
}

function mountPrivacy(elementRoot: HTMLElement, context: BrowserModuleContext, cleanup: Array<() => void>): void {
  const status = statusNode();
  const list = element("ul");
  let disposed = false;
  void invoke(context, "nlp.features", {}).then((data) => {
    if (disposed) return;
    const features = data.features as Array<{ id: string; label: string; locality: "local" | "external"; enabled: boolean }>;
    for (const feature of features) {
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = feature.enabled;
      checkbox.disabled = feature.locality === "local";
      const label = field(`${feature.label} (${feature.id})`, checkbox);
      const onChange = async () => {
        if (checkbox.disabled) return;
        checkbox.disabled = true;
        try {
          await invoke(context, "nlp.updateExternalConsent", { externalEnabled: { [feature.id]: checkbox.checked } });
          status.textContent = "外部送信の設定案を保存しました。承認後に適用されます。";
        } catch (error) {
          checkbox.checked = !checkbox.checked;
          status.textContent = error instanceof Error ? error.message : String(error);
        } finally { checkbox.disabled = false; }
      };
      checkbox.addEventListener("change", onChange);
      cleanup.push(() => checkbox.removeEventListener("change", onChange));
      const item = element("li");
      item.append(label);
      if (feature.locality === "local") {
        const locality = element("small", "この機能は端末内で処理され、外部送信の設定対象ではありません。");
        item.append(locality);
      }
      list.append(item);
    }
    status.textContent = "外部機能ごとの送信同意です。設定変更は承認後に保存されます。";
  }).catch((error) => { if (!disposed) status.textContent = error instanceof Error ? error.message : String(error); });
  cleanup.push(() => { disposed = true; });
  elementRoot.append(status, list);
}

export const browserModule: BrowserModuleDefinition = {
  async mount(contributionId, elementRoot, context) {
    const cleanup: Array<() => void> = [];
    const heading = element("h3", ({
      "nlp.analyzer": "日本語の形態素解析",
      "nlp.candidates": "スナップショット語句候補",
      "nlp.dictionary": "作品固有の同義語辞書",
      "nlp.privacy": "外部送信の同意設定",
    } as Record<string, string>)[contributionId] ?? "NLP");
    elementRoot.replaceChildren(heading);
    if (contributionId === "nlp.analyzer") mountAnalyzer(elementRoot, context, cleanup);
    else if (contributionId === "nlp.candidates") mountCandidates(elementRoot, context, cleanup);
    else if (contributionId === "nlp.dictionary") mountDictionary(elementRoot, context, cleanup);
    else if (contributionId === "nlp.privacy") mountPrivacy(elementRoot, context, cleanup);
    else throw new Error(`Unknown NLP contribution: ${contributionId}`);
    const abort = () => { for (const dispose of cleanup.splice(0)) dispose(); elementRoot.replaceChildren(); };
    context.signal.addEventListener("abort", abort, { once: true });
    return () => {
      context.signal.removeEventListener("abort", abort);
      abort();
    };
  },
};
