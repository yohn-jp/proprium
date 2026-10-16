import type { BrowserModuleContext, BrowserModuleDefinition } from "@scriptorium/contracts";

type Data = Record<string, unknown>;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = text;
  return value;
}
function button(text: string): HTMLButtonElement { const value = element("button", text); value.type = "button"; return value; }
function output(): HTMLOutputElement { const value = element("output"); value.setAttribute("aria-live", "polite"); return value; }
function field(labelText: string, input: HTMLElement): HTMLLabelElement {
  const label = element("label"); label.append(element("span", labelText), input); label.style.display = "grid"; label.style.gap = "0.35rem"; return label;
}
async function invoke(context: BrowserModuleContext, id: string, input: unknown): Promise<Data> {
  const result = await context.invoke(id, input);
  if (!result.ok) throw new Error(result.error.message);
  return result.data as Data;
}

function mountAnalysis(root: HTMLElement, context: BrowserModuleContext, cleanup: Array<() => void>): void {
  const text = element("textarea"); text.rows = 9; text.maxLength = 500_000; text.placeholder = "解析する本文"; text.setAttribute("aria-label", "解析する本文");
  const tone = element("input"); tone.type = "text"; tone.placeholder = "例: suspense";
  const goal = element("textarea"); goal.rows = 3; goal.placeholder = "シーンの goal / conflict（任意）";
  const run = button("文章を診断"); const status = output(); const results = element("section");
  const onClick = async () => {
    run.disabled = true; status.textContent = "日本語形態素解析と診断を実行しています…"; results.replaceChildren();
    try {
      const data = await invoke(context, "diagnostics.analyze", { text: text.value, ...(tone.value ? { intendedTone: tone.value } : {}), ...(goal.value ? { goalConflictText: goal.value } : {}) });
      const analysis = data.analysis as { charCount: number; sentenceCount: number; frequentNouns: Array<{ term: string; count: number }>; sentimentArc: { mean: number }; rhythmWarnings: Array<{ ending: string; count: number }> };
      const prose = data.proseBalance as { dialogueRatio: number; narrationRatio: number; adjectiveRatio: number; adverbRatio: number };
      const issues = data.issues as Array<{ kind: string; severity: string; message: string; sentenceIndex?: number; range?: { start: number; end: number } }>;
      const stats = element("p", `${analysis.charCount}文字・${analysis.sentenceCount}文 · セリフ ${(prose.dialogueRatio * 100).toFixed(0)}% · 感情平均 ${analysis.sentimentArc.mean.toFixed(3)}`);
      const terms = element("p", `頻出名詞: ${analysis.frequentNouns.map((term) => `${term.term} (${term.count})`).join("、") || "なし"}`);
      const list = element("ol");
      for (const issue of issues) {
        const item = element("li", `[${issue.severity}/${issue.kind}] ${issue.message}${issue.sentenceIndex ? ` (文 ${issue.sentenceIndex})` : ""}${issue.range ? ` (位置 ${issue.range.start}–${issue.range.end})` : ""}`);
        list.append(item);
      }
      results.append(stats, terms, list);
      status.textContent = `解析器 ${String(data.model)} ${String(data.modelVersion)} · 診断 ${String(data.diagnosticsEngineVersion)} · ${issues.length} 件の指摘`;
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { run.disabled = false; }
  };
  run.addEventListener("click", onClick); cleanup.push(() => run.removeEventListener("click", onClick));
  root.append(field("本文", text), field("意図したトーン（任意）", tone), field("goal / conflict（任意）", goal), run, status, results);
}

function mountLint(root: HTMLElement, context: BrowserModuleContext, cleanup: Array<() => void>): void {
  const path = element("input"); path.type = "text"; path.placeholder = "manuscript/chapter/scene.md";
  const text = element("textarea"); text.rows = 7; text.maxLength = 500_000; text.placeholder = "確認する本文";
  const run = button("ルールを確認"); const propose = button("ファイルの整形案を作成"); const status = output(); const results = element("pre");
  const onRun = async () => {
    run.disabled = true; status.textContent = "ルールを確認しています…";
    try {
      const data = await invoke(context, "diagnostics.lint", { text: text.value });
      const warnings = data.warnings as Array<{ offset: number; length: number; message: string; excerpt?: string }>;
      results.textContent = `${warnings.length} 件\n${warnings.map((warning) => `${warning.offset}+${warning.length}: ${warning.message}${warning.excerpt ? ` (${warning.excerpt})` : ""}`).join("\n")}`;
      status.textContent = data.fixed ? "整形すると本文に変更があります。" : "宣言ルールに合う整形です。";
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { run.disabled = false; }
  };
  const onPropose = async () => {
    propose.disabled = true; status.textContent = "本文ファイルを読み、レビュー用変更案を作成しています…";
    try {
      const data = await invoke(context, "diagnostics.proposeLintFix", { path: path.value });
      if (data.proposal) status.textContent = "整形案をレビューキューに送りました。承認後に保存できます。";
      else status.textContent = "本文に変更はありません。";
      text.value = String(data.body ?? text.value);
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { propose.disabled = false; }
  };
  run.addEventListener("click", onRun); propose.addEventListener("click", onPropose);
  cleanup.push(() => run.removeEventListener("click", onRun), () => propose.removeEventListener("click", onPropose));
  root.append(field("Markdown ファイルのパス（整形案用）", path), field("確認する本文", text), run, propose, status, results);
}

function mountVoice(root: HTMLElement, context: BrowserModuleContext, cleanup: Array<() => void>): void {
  const dialogues = element("textarea"); dialogues.rows = 8; dialogues.placeholder = '{"character-id":["「台詞」", "「別の台詞」", "…"]}';
  const run = button("文体プロファイルを計算"); const status = output(); const result = element("pre");
  const onClick = async () => {
    run.disabled = true; status.textContent = "共有 tokenizer で台詞を解析しています…";
    try {
      const data = await invoke(context, "diagnostics.voiceProfiles", { dialoguesByCharacter: JSON.parse(dialogues.value) });
      result.textContent = JSON.stringify({ fingerprints: data.fingerprints, voiceSeparation: data.matrix, stylometricProfiles: data.stylometricProfiles }, null, 2);
      status.textContent = `解析器 ${String(data.model)} ${String(data.modelVersion)} · ${Array.isArray(data.fingerprints) ? data.fingerprints.length : 0} 件の文体プロファイル`;
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { run.disabled = false; }
  };
  run.addEventListener("click", onClick); cleanup.push(() => run.removeEventListener("click", onClick));
  root.append(field("話者 ID ごとの台詞 JSON（各話者3発話以上）", dialogues), run, status, result);
}

export const browserModule: BrowserModuleDefinition = {
  async mount(contributionId, elementRoot, context) {
    const cleanup: Array<() => void> = [];
    const config = {
      "diagnostics.analysis": { title: "日本語本文の統合診断", mount: mountAnalysis },
      "diagnostics.lint": { title: "宣言型の組版ルール", mount: mountLint },
      "diagnostics.voice": { title: "声・文体の統計プロファイル", mount: mountVoice },
    } as const;
    const contribution = config[contributionId as keyof typeof config];
    if (!contribution) throw new Error(`Unknown diagnostics contribution: ${contributionId}`);
    elementRoot.replaceChildren(element("h3", contribution.title));
    contribution.mount(elementRoot, context, cleanup);
    const abort = () => { for (const dispose of cleanup.splice(0)) dispose(); elementRoot.replaceChildren(); };
    context.signal.addEventListener("abort", abort, { once: true });
    return () => { context.signal.removeEventListener("abort", abort); abort(); };
  },
};
