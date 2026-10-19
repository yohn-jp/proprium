import type { BrowserModuleContext, BrowserModuleDefinition } from "@scriptorium/contracts";

type Data = Record<string, unknown>;
type SearchBrowserContext = BrowserModuleContext & { navigateDocument?(path: string): Promise<void> };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string): HTMLButtonElement {
  const node = element("button", label);
  node.type = "button";
  return node;
}

function output(): HTMLOutputElement {
  const node = element("output");
  node.setAttribute("aria-live", "polite");
  return node;
}

function field(labelText: string, input: HTMLElement): HTMLLabelElement {
  const label = element("label");
  label.append(element("span", labelText), input);
  label.style.display = "grid";
  label.style.gap = "0.35rem";
  return label;
}

async function invoke(context: BrowserModuleContext, id: string, input: unknown): Promise<Data> {
  const result = await context.invoke(id, input);
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.data as Data;
}

function searchPanel(root: HTMLElement, context: SearchBrowserContext, cleanup: Array<() => void>): void {
  const query = element("input");
  query.type = "search";
  query.maxLength = 512;
  query.setAttribute("aria-label", "検索語");
  const mode = element("select");
  for (const [value, title] of [["fulltext", "全文"], ["exact", "完全一致"], ["prefix", "前方一致"]]) {
    const option = element("option", title);
    option.value = value;
    mode.append(option);
  }
  const scope = element("input");
  scope.type = "text";
  scope.maxLength = 1024;
  scope.placeholder = "manuscript/vol-1/ch-1";
  const useNlp = element("input");
  useNlp.type = "checkbox";
  const includeSemantic = element("input");
  includeSemantic.type = "checkbox";
  const run = button("検索");
  const status = output();
  const results = element("ol");
  let generation = 0;
  let running = false;
  const onSearch = async () => {
    if (running || context.signal.aborted) return;
    running = true;
    const current = ++generation;
    run.disabled = true;
    results.replaceChildren();
    status.textContent = "検索しています…";
    try {
      const data = await invoke(context, "search.query", {
        query: query.value, mode: mode.value, scope: scope.value, limit: 50,
        useNlp: useNlp.checked, includeSemantic: includeSemantic.checked,
      });
      if (context.signal.aborted || current !== generation) return;
      const hits = Array.isArray(data.results) ? data.results as Array<Record<string, unknown>> : [];
      for (const hit of hits) {
        const item = element("li");
        const title = typeof hit.title === "string" ? hit.title : String(hit.path ?? "");
        const path = typeof hit.path === "string" ? hit.path : "";
        item.append(element("strong", title));
        if (typeof hit.snippet === "string" && hit.snippet) item.append(element("p", hit.snippet));
        item.append(element("small", `${hit.kind === "term" ? "用語" : "文書"} · ${path}`));
        const open = button(`この文書を開く: ${path}`);
        open.dataset.testid = "search-result-open";
        const onOpen = async () => {
          if (!context.navigateDocument) { status.textContent = "この表示からは文書へ移動できません。"; return; }
          try { await context.navigateDocument(path); }
          catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
        };
        open.addEventListener("click", onOpen);
        cleanup.push(() => open.removeEventListener("click", onOpen));
        item.append(open);
        results.append(item);
      }
      const warnings = Array.isArray(data.warnings) ? data.warnings.filter((value): value is string => typeof value === "string") : [];
      const semantic = Array.isArray(data.semanticResults) ? data.semanticResults : [];
      status.textContent = `${hits.length} 件 · ${String(data.indexedDocuments ?? 0)} 文書を索引${warnings.length ? ` · ${warnings.join(" · ")}` : ""}${includeSemantic.checked ? ` · 意味検索 ${semantic.length} 件` : ""}`;
    } catch (error) {
      if (!context.signal.aborted && current === generation) status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (current === generation) { running = false; run.disabled = false; }
    }
  };
  run.addEventListener("click", onSearch);
  const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Enter") void onSearch(); };
  query.addEventListener("keydown", onKeyDown);
  cleanup.push(() => run.removeEventListener("click", onSearch), () => query.removeEventListener("keydown", onKeyDown));
  const onAbort = () => { generation += 1; running = false; run.disabled = true; };
  context.signal.addEventListener("abort", onAbort, { once: true });
  cleanup.push(() => context.signal.removeEventListener("abort", onAbort));
  root.append(
    field("検索語", query), field("検索対象", mode), field("範囲パス", scope),
    field("NLPで日本語分かち書き", useNlp), field("意味検索を含める", includeSemantic), run, status, results,
  );
}

function termsPanel(root: HTMLElement, context: SearchBrowserContext, cleanup: Array<() => void>): void {
  const status = output();
  const list = element("ul");
  const canonical = element("input"); canonical.maxLength = 256;
  const aliases = element("input"); aliases.maxLength = 2048;
  const targetPath = element("input"); targetPath.maxLength = 1024;
  const save = button("用語の提案を作成");
  const editor = context.readCurrentEditor?.();
  if (editor) targetPath.value = editor.documentPath;
  const draw = async () => {
    if (context.signal.aborted) return;
    list.replaceChildren();
    try {
      const data = await invoke(context, "search.terms.list", {});
      if (context.signal.aborted) return;
      const terms = Array.isArray(data.terms) ? data.terms as Array<Record<string, unknown>> : [];
      for (const term of terms) {
        const item = element("li");
        const name = typeof term.canonical === "string" ? term.canonical : "用語";
        const path = typeof term.targetPath === "string" ? term.targetPath : "";
        const available = term.targetAvailable === true;
        item.append(element("strong", name), element("p", `別名: ${Array.isArray(term.aliases) ? term.aliases.join("、") : "なし"}`));
        item.append(element("small", `${path} · ${available ? "参照可能" : "参照先がありません"}`));
        if (available && context.navigateDocument) {
          const open = button(`用語「${name}」の参照先を開く`);
          const onOpen = () => {
            if (context.signal.aborted) return;
            void context.navigateDocument!(path).catch((error) => { if (!context.signal.aborted) status.textContent = error instanceof Error ? error.message : String(error); });
          };
          open.addEventListener("click", onOpen);
          cleanup.push(() => open.removeEventListener("click", onOpen));
          item.append(open);
        }
        if (typeof term.id === "string") {
          const remove = button(`用語「${name}」の削除案を作成`);
          const onRemove = async () => {
            if (context.signal.aborted) return;
            remove.disabled = true;
            try { const result = await invoke(context, "search.terms.remove", { id: term.id }); if (!context.signal.aborted) status.textContent = `削除案 ${(result.proposal as { id?: string } | undefined)?.id ?? ""} を作成しました。承認後に反映されます。`; }
            catch (error) { if (!context.signal.aborted) status.textContent = error instanceof Error ? error.message : String(error); }
            finally { if (!context.signal.aborted) remove.disabled = false; }
          };
          remove.addEventListener("click", onRemove);
          cleanup.push(() => remove.removeEventListener("click", onRemove));
          item.append(remove);
        }
        list.append(item);
      }
      if (typeof data.warning === "string") status.textContent = "用語辞典を読み込めませんでした。原本を保護しています。";
      else status.textContent = `${terms.length} 件 · 変更は承認用の提案として作成されます。`;
    } catch (error) { if (!context.signal.aborted) status.textContent = error instanceof Error ? error.message : String(error); }
  };
  const onSave = async () => {
    if (context.signal.aborted) return;
    const draft = context.readCurrentEditor?.();
    const target = targetPath.value.trim() || draft?.documentPath || "";
    save.disabled = true;
    try {
      const result = await invoke(context, "search.terms.propose", {
        canonical: canonical.value, aliases: aliases.value.split(/[、,]/u).map((value) => value.trim()).filter(Boolean), targetPath: target,
      });
      if (!context.signal.aborted) status.textContent = `提案 ${(result.proposal as { id?: string } | undefined)?.id ?? ""} を作成しました。承認後に用語辞典へ反映されます。`;
    } catch (error) { if (!context.signal.aborted) status.textContent = error instanceof Error ? error.message : String(error); }
    finally { if (!context.signal.aborted) save.disabled = false; }
  };
  save.addEventListener("click", onSave);
  cleanup.push(() => save.removeEventListener("click", onSave));
  const onAbort = () => { save.disabled = true; };
  context.signal.addEventListener("abort", onAbort, { once: true });
  cleanup.push(() => context.signal.removeEventListener("abort", onAbort));
  root.append(element("h3", "登録済みの用語"), list,
    element("h3", "用語を提案"), field("用語", canonical), field("別名（読点またはカンマ区切り）", aliases), field("参照先パス", targetPath), save, status);
  void draw();
}

export const browserModule: BrowserModuleDefinition = {
  async mount(contributionId, root, rawContext) {
    const context = rawContext as SearchBrowserContext;
    const cleanup: Array<() => void> = [];
    if (contributionId === "search.panel") {
      root.append(element("h2", "全文検索"));
      searchPanel(root, context, cleanup);
    } else if (contributionId === "search.terms") {
      root.append(element("h2", "用語辞典"));
      termsPanel(root, context, cleanup);
    }
    return () => { for (const dispose of cleanup.splice(0).reverse()) dispose(); root.replaceChildren(); };
  },
};

