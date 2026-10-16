import type { BrowserModuleContext, BrowserModuleDefinition } from "@scriptorium/contracts";

type Data = Record<string, unknown>;
type Attribution = {
  sentenceIndex: number;
  text: string;
  speakerEntityId: string | null;
  speakerGroupId: string | null;
  reason: string;
  confidence: "high" | "low" | "none";
};
type ReviewContext = { speakerName?: string | null; otherResolvableCount?: number };
type SceneChoice = { id: string; name: string };

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
  const label = el("label");
  label.append(el("span", labelText), control);
  label.style.display = "grid";
  label.style.gap = "0.35rem";
  return label;
}

function statusNode(): HTMLOutputElement {
  const status = el("output");
  status.setAttribute("aria-live", "polite");
  status.style.display = "block";
  status.style.marginBlock = "0.5rem";
  return status;
}

function section(title: string): HTMLElement {
  const node = el("section");
  node.style.display = "grid";
  node.style.gap = "0.5rem";
  node.style.marginBlock = "0.75rem";
  node.append(el("h4", title));
  return node;
}

function ensureData(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Speaker module returned an invalid result");
  return value as Data;
}

async function invoke<T = Data>(context: BrowserModuleContext, actionId: string, input: unknown): Promise<T> {
  const result = await context.invoke(actionId, input);
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  if (!result.data || typeof result.data !== "object") throw new Error("Speaker module returned an invalid result");
  return result.data as T;
}

function appendWarning(status: HTMLOutputElement, error: unknown): void {
  status.textContent = error instanceof Error ? error.message : String(error);
}

function scenePicker(scenes: SceneChoice[]): HTMLSelectElement {
  const select = el("select");
  select.setAttribute("aria-label", "シーン");
  select.append(new Option("シーンを選択", ""));
  for (const scene of scenes) select.append(new Option(scene.name, scene.id));
  return select;
}

function speakerPicker(candidates: Array<{ id: string; name: string }>): HTMLSelectElement {
  const select = el("select");
  select.append(new Option("不明 / モブ", ""));
  for (const candidate of candidates) select.append(new Option(candidate.name, candidate.id));
  return select;
}

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    "attribution-verb": "話者動詞",
    "attribution-verb-subject": "主語付き話者動詞",
    "strong-hint": "強い候補ヒント",
    "pov-reply": "視点人物への返答",
    mob: "モブ確定",
    "preceding-narration": "直前の地の文",
    "vocative-other": "呼びかけ相手以外",
    "addressed-by-next": "次の台詞の呼びかけ",
    "alternating-turn": "交互会話",
    rerank: "採用モデル",
    "manual-override": "手動確定",
    none: "未確定",
  };
  return labels[reason] ?? reason;
}

function confidenceLabel(confidence: Attribution["confidence"]): string {
  return confidence === "high" ? "高" : confidence === "low" ? "低" : "未確定";
}

async function loadScenes(context: BrowserModuleContext): Promise<SceneChoice[]> {
  const data = await invoke(context, "speaker.scenes.list", {});
  if (!Array.isArray(data.scenes)) throw new Error("シーン一覧が不正です");
  return data.scenes.map((row) => {
    const item = ensureData(row);
    return { id: String(item.id), name: String(item.name ?? item.id) };
  });
}

async function loadCharacters(context: BrowserModuleContext): Promise<SceneChoice[]> {
  const data = await invoke<unknown>(context, "story.entities.list", { type: "character" });
  if (!Array.isArray(data)) throw new Error("キャラクター一覧が不正です");
  return data.map((row) => {
    const item = ensureData(row);
    return { id: String(item.id), name: String(item.name ?? item.id) };
  });
}

function characterPicker(): HTMLSelectElement {
  const select = el("select");
  select.setAttribute("aria-label", "キャラクター");
  select.append(new Option("キャラクターを選択", ""));
  return select;
}

function attributionRow(
  attribution: Attribution,
  candidates: Array<{ id: string; name: string }>,
  sceneId: string,
  context: BrowserModuleContext,
  status: HTMLOutputElement,
  review: ReviewContext = {},
): HTMLElement {
  const row = el("article");
  row.style.borderBottom = "1px solid currentColor";
  row.style.paddingBlock = "0.45rem";
  row.style.display = "grid";
  row.style.gap = "0.35rem";
  const speakerName = review.speakerName ?? (attribution.speakerEntityId
    ? candidates.find((candidate) => candidate.id === attribution.speakerEntityId)?.name ?? attribution.speakerEntityId
    : attribution.speakerGroupId ? "未解決クラスタ" : "不明");
  const line = el("div", `${speakerName} · 文 ${attribution.sentenceIndex} · ${confidenceLabel(attribution.confidence)} · ${reasonLabel(attribution.reason)} · ${attribution.text}`);
  line.style.overflowWrap = "anywhere";
  const groupSummary = review.otherResolvableCount !== undefined
    ? el("small", review.otherResolvableCount > 0
      ? `この確定で他 ${review.otherResolvableCount} 行が解決`
      : "単独行（クラスタ波及なし）")
    : null;
  const select = speakerPicker(candidates);
  if (attribution.speakerEntityId) select.value = attribution.speakerEntityId;
  const confirm = button("この話者をレビュー案として確定");
  const onConfirm = async () => {
    confirm.disabled = true;
    try {
      const result = await invoke(context, "speaker.override", {
        sceneId,
        sentenceIndex: attribution.sentenceIndex,
        dialogueText: attribution.text,
        speakerEntityId: select.value || null,
      });
      status.textContent = result.proposal ? "確定案をレビューキューに作成しました。承認後に正本へ反映されます。" : "確定案を作成できませんでした。";
    } catch (error) { appendWarning(status, error); }
    finally { confirm.disabled = false; }
  };
  confirm.addEventListener("click", onConfirm);
  row.append(line, ...(groupSummary ? [groupSummary] : []), field("話者", select), confirm);
  (row as HTMLElement & { dispose?: () => void }).dispose = () => confirm.removeEventListener("click", onConfirm);
  return row;
}

function mountAttribution(root: HTMLElement, context: BrowserModuleContext, cleanups: Array<() => void>): void {
  const status = statusNode();
  const results = section("帰属結果");
  const scenes = scenePicker([]);
  const run = button("話者を推定");
  const voice = button("口調・文体を診断");
  const count = el("input"); count.type = "number"; count.min = "1"; count.max = "1000";
  const updateCount = button("話者数のレビュー案を作成");
  const onRun = async () => {
    if (!scenes.value) { status.textContent = "先にシーンを選択してください。"; return; }
    run.disabled = true; status.textContent = "共有日本語 tokenizer で話者帰属を計算しています…"; results.replaceChildren(el("h4", "帰属結果"));
    try {
      const data = await invoke(context, "speaker.attribute", { sceneId: scenes.value });
      const attrs = Array.isArray(data.attributions) ? data.attributions as Attribution[] : [];
      const candidates = Array.isArray(data.candidates) ? data.candidates.map((value) => {
        const row = ensureData(value); return { id: String(row.id), name: String(row.name ?? row.id) };
      }) : [];
      const summary = el("p", `${attrs.filter((row) => row.speakerGroupId !== null).length}/${attrs.length} 件をクラスタ化 · 推定話者数 ${String(data.estimatedN)}${data.fromManual ? "（手動指定あり）" : ""}`);
      const list = el("div");
      const rowCleanups: Array<() => void> = [];
      for (const attribution of attrs) {
        const row = attributionRow(attribution, candidates, scenes.value, context, status);
        const dispose = (row as HTMLElement & { dispose?: () => void }).dispose;
        if (dispose) rowCleanups.push(dispose);
        list.append(row);
      }
      cleanups.push(() => rowCleanups.forEach((dispose) => dispose()));
      results.append(summary, list);
      const estimated = Number(data.estimatedN);
      if (Number.isSafeInteger(estimated) && estimated > 0) count.value = String(estimated);
      status.textContent = `話者モデル ${String(data.model)}@${String(data.modelVersion)} · 共有 tokenizer ${String(data.tokenizerModel)}@${String(data.tokenizerModelVersion)} · ${attrs.length} 件の台詞`;
    } catch (error) { appendWarning(status, error); }
    finally { run.disabled = false; }
  };
  const onVoice = async () => {
    if (!scenes.value) { status.textContent = "先にシーンを選択してください。"; return; }
    voice.disabled = true; status.textContent = "全作品の高信頼発話から文体プロファイルを計算しています…";
    try {
      const data = await invoke(context, "speaker.voice.check", { sceneId: scenes.value });
      const issues = Array.isArray(data.issues) ? data.issues.map(ensureData) : [];
      const list = el("ol");
      for (const issue of issues) list.append(el("li", `文 ${String(issue.sentenceIndex)} · ${String(issue.issueLabel)} · ${String(issue.source)} · ${String(issue.text)}${typeof issue.found === "string" && issue.found ? `（検出: ${issue.found}）` : ""}`));
      results.append(el("h4", "登録口調・学習指紋・統計逸脱"), list);
      status.textContent = `${issues.length} 件の口調・文体警告`;
    } catch (error) { appendWarning(status, error); }
    finally { voice.disabled = false; }
  };
  const onCount = async () => {
    if (!scenes.value) { status.textContent = "先にシーンを選択してください。"; return; }
    const value = Number(count.value);
    if (!Number.isSafeInteger(value) || value < 1) { status.textContent = "正の整数を入力してください。"; return; }
    updateCount.disabled = true;
    try {
      const result = await invoke(context, "speaker.count.update", { sceneId: scenes.value, speakerCount: value });
      status.textContent = result.proposed ? "話者数の変更案をレビューキューに作成しました。" : "話者数の変更案を作成できませんでした。";
    } catch (error) { appendWarning(status, error); }
    finally { updateCount.disabled = false; }
  };
  run.addEventListener("click", onRun); voice.addEventListener("click", onVoice); updateCount.addEventListener("click", onCount);
  cleanups.push(() => run.removeEventListener("click", onRun), () => voice.removeEventListener("click", onVoice), () => updateCount.removeEventListener("click", onCount));
  root.append(field("シーン", scenes), run, voice, field("話者数", count), updateCount, status, results);
  void loadScenes(context).then((items) => { for (const scene of items) scenes.append(new Option(scene.name, scene.id)); }).catch((error) => appendWarning(status, error));
}

function mountReviewQueue(root: HTMLElement, context: BrowserModuleContext, cleanups: Array<() => void>): void {
  const status = statusNode();
  const results = section("未確定・低信頼の話者帰属");
  const reload = button("確認キューを更新");
  const onReload = async () => {
    reload.disabled = true; status.textContent = "全シーンを走査しています…"; results.replaceChildren(el("h4", "未確定・低信頼の話者帰属"));
    try {
      const data = await invoke(context, "speaker.review.queue", {});
      const rows = Array.isArray(data.rows) ? data.rows.map(ensureData) : [];
      const list = el("div");
      const rowCleanups: Array<() => void> = [];
      for (const row of rows) {
        const item = ensureData(row.attribution);
        const candidates = Array.isArray(row.candidates) ? row.candidates.map((value) => {
          const candidate = ensureData(value); return { id: String(candidate.id), name: String(candidate.name ?? candidate.id) };
        }) : [];
        const rendered = attributionRow(item as unknown as Attribution, candidates, String(row.sceneId), context, status, {
          speakerName: typeof row.speakerName === "string" ? row.speakerName : null,
          otherResolvableCount: Number(row.otherResolvableCount ?? 0),
        });
        rendered.prepend(el("strong", String(row.sceneName)));
        const dispose = (rendered as HTMLElement & { dispose?: () => void }).dispose;
        if (dispose) rowCleanups.push(dispose);
        list.append(rendered);
      }
      cleanups.push(() => rowCleanups.forEach((dispose) => dispose()));
      results.append(list);
      status.textContent = `${rows.length} 件。未確定を優先し、続いて低信頼を表示しています。確認は Core のレビュー提案として作成されます。`;
    } catch (error) { appendWarning(status, error); }
    finally { reload.disabled = false; }
  };
  reload.addEventListener("click", onReload); cleanups.push(() => reload.removeEventListener("click", onReload));
  root.append(reload, status, results);
  void onReload();
}

function mountCharacterDialogue(root: HTMLElement, context: BrowserModuleContext, cleanups: Array<() => void>): void {
  const status = statusNode();
  const character = characterPicker();
  const scene = scenePicker([]);
  scene.options[0]!.textContent = "すべてのシーン";
  const confidence = el("select"); confidence.setAttribute("aria-label", "最低信頼度");
  confidence.append(new Option("高・低信頼", "low"), new Option("高信頼のみ", "high"));
  const reload = button("再読込");
  const results = section("セリフ一覧");
  const onReload = async () => {
    if (!character.value) { status.textContent = "先にキャラクターを選択してください。"; return; }
    reload.disabled = true; status.textContent = "キャラクターの帰属セリフを走査しています…";
    results.replaceChildren(el("h4", "セリフ一覧"));
    try {
      const data = await invoke(context, "speaker.dialogue.list", {
        characterId: character.value,
        ...(scene.value ? { sceneId: scene.value } : {}),
        limit: 80,
        minConfidence: confidence.value,
      });
      const lines = Array.isArray(data.lines) ? data.lines.map(ensureData) : [];
      const byScene = new Map<string, { name: string; lines: Data[] }>();
      for (const line of lines) {
        const sceneId = String(line.sceneId ?? "(unknown)");
        const group = byScene.get(sceneId) ?? { name: String(line.sceneName ?? sceneId), lines: [] };
        group.lines.push(line); byScene.set(sceneId, group);
      }
      if (lines.length === 0) results.append(el("p", "帰属セリフはまだありません。"));
      for (const [sceneId, group] of byScene) {
        const groupSection = section(group.name || sceneId);
        for (const line of group.lines) {
          groupSection.append(el("p", String(line.text ?? "—")));
          groupSection.append(el("small", `文 ${String(line.sentenceIndex)} · ${confidenceLabel(line.confidence as Attribution["confidence"])} · ${reasonLabel(String(line.reason ?? "none"))}`));
        }
        results.append(groupSection);
      }
      status.textContent = `${String(data.count ?? lines.length)} 件のセリフ · ${confidence.value === "high" ? "高信頼のみ" : "高・低信頼"} · 直近最大 80 件`;
    } catch (error) { appendWarning(status, error); }
    finally { reload.disabled = false; }
  };
  const onFilterChange = () => { if (character.value) void onReload(); };
  reload.addEventListener("click", onReload); character.addEventListener("change", onFilterChange);
  scene.addEventListener("change", onFilterChange); confidence.addEventListener("change", onFilterChange);
  cleanups.push(
    () => reload.removeEventListener("click", onReload),
    () => character.removeEventListener("change", onFilterChange),
    () => scene.removeEventListener("change", onFilterChange),
    () => confidence.removeEventListener("change", onFilterChange),
  );
  root.append(field("キャラクター", character), field("シーン", scene), field("最低信頼度", confidence), reload, status, results);
  void Promise.all([loadCharacters(context), loadScenes(context)]).then(([characters, scenes]) => {
    for (const item of characters) character.append(new Option(item.name, item.id));
    for (const item of scenes) scene.append(new Option(item.name, item.id));
  }).catch((error) => appendWarning(status, error));
}

function distributionList(title: string, raw: unknown): HTMLElement {
  const distribution = raw && typeof raw === "object" && !Array.isArray(raw) ? ensureData(raw) : {};
  const entries = Object.entries(distribution).filter(([, value]) => typeof value === "number" && value > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8);
  const sectionNode = section(title);
  if (!entries.length) { sectionNode.append(el("p", "データなし")); return sectionNode; }
  const max = Number(entries[0]![1]);
  const list = el("ul");
  for (const [label, rawValue] of entries) {
    const value = Number(rawValue);
    const row = el("li");
    const bar = el("span"); bar.style.display = "inline-block"; bar.style.height = "0.55rem"; bar.style.marginInline = "0.5rem"; bar.style.background = "currentColor"; bar.style.width = `${Math.max(4, value / max * 100)}%`;
    row.append(el("span", label.replaceAll("|", "")), bar, el("small", `${(value * 100).toFixed(0)}%`));
    list.append(row);
  }
  sectionNode.append(list);
  return sectionNode;
}

function metricRow(label: string, value: unknown, percentage = false): HTMLElement {
  const row = el("div"); row.style.display = "flex"; row.style.justifyContent = "space-between";
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : null;
  row.append(el("span", label), el("span", numeric === null ? "—" : percentage ? `${(numeric * 100).toFixed(1)}%` : numeric.toFixed(numeric >= 10 ? 1 : 2)));
  return row;
}

function renderVoiceProfile(
  root: HTMLElement,
  profileData: Data,
  characterId: string,
  characters: SceneChoice[],
  onSelect: (id: string) => void,
): void {
  root.replaceChildren();
  const fingerprints = Array.isArray(profileData.fingerprints) ? profileData.fingerprints.map(ensureData) : [];
  const stylometrics = Array.isArray(profileData.stylometricProfiles) ? profileData.stylometricProfiles.map(ensureData) : [];
  const matrix = Array.isArray(profileData.matrix) ? profileData.matrix.map(ensureData) : [];
  const fingerprint = fingerprints.find((item) => item.entityId === characterId);
  const stylometric = stylometrics.find((item) => item.entityId === characterId);
  if (!fingerprint) {
    root.append(el("h4", "声紋サマリー"), el("p", "学習に必要なセリフがまだ不足しています。"));
    if (stylometric) root.append(renderStylometric(stylometric));
    return;
  }
  const dialogueCount = Number(fingerprint.dialogueCount ?? 0);
  const coverage = dialogueCount >= 10 ? "診断可能" : dialogueCount >= 3 ? "学習中" : "不足";
  root.append(el("p", `${coverage} · 高信頼セリフ ${dialogueCount} 件（プロファイル 3+ / 逸脱判定 10+）`));
  const first = distributionEntries(fingerprint.firstPersonDist)[0];
  const ending = distributionEntries(fingerprint.endingBigramDist)[0];
  if (first || ending) root.append(el("p", `代表口調:${first ? ` 一人称「${first[0]}」${(Number(first[1]) * 100).toFixed(0)}%` : ""}${first && ending ? " ·" : ""}${ending ? ` 語尾「${ending[0].replaceAll("|", "")}」${(Number(ending[1]) * 100).toFixed(0)}%` : ""}`));
  const metrics = el("div");
  metrics.append(
    metricRow("感嘆符率", fingerprint.exclamationRate, true), metricRow("疑問符率", fingerprint.questionRate, true),
    metricRow("丁寧語比率", fingerprint.politeRatio, true), metricRow("カタカナ率", fingerprint.katakanaRate, true),
    metricRow("平均セリフ長", fingerprint.avgDialogueLength), metricRow("セリフ長の分散", fingerprint.dialogueLengthVariance),
  );
  root.append(metrics, distributionList("一人称分布", fingerprint.firstPersonDist), distributionList("語尾 bigram", fingerprint.endingBigramDist), distributionList("助詞分布", fingerprint.particleDist));
  const similar = matrix.filter((pair) => pair.entityIdA === characterId || pair.entityIdB === characterId)
    .sort((a, b) => Number(b.similarity) - Number(a.similarity));
  const tooSimilar = similar.filter((pair) => pair.tooSimilar === true);
  if (tooSimilar.length) {
    const list = el("ul");
    for (const pair of tooSimilar) {
      const otherId = String(pair.entityIdA === characterId ? pair.entityIdB : pair.entityIdA);
      const otherName = characters.find((item) => item.id === otherId)?.name ?? otherId;
      const choose = button(otherName); choose.addEventListener("click", () => onSelect(otherId));
      const row = el("li"); row.append(choose, el("span", ` 類似度 ${Number(pair.similarity).toFixed(2)}`)); list.append(row);
    }
    const warning = section("声が似すぎているキャラ"); warning.append(list); root.append(warning);
  }
  const peers = similar.slice(0, 2);
  if (peers.length) {
    const table = el("table");
    const head = el("tr"); head.append(el("th", "指標"));
    const peerProfiles: Data[] = [fingerprint];
    for (const peer of peers) {
      const otherId = String(peer.entityIdA === characterId ? peer.entityIdB : peer.entityIdA);
      const otherName = characters.find((item) => item.id === otherId)?.name ?? otherId;
      const choose = button(otherName); choose.addEventListener("click", () => onSelect(otherId));
      const th = el("th"); th.append(choose, el("small", ` ${Number(peer.similarity).toFixed(2)}`)); head.append(th);
      const found = fingerprints.find((item) => item.entityId === otherId);
      if (found) peerProfiles.push(found);
    }
    table.append(head);
    for (const [label, key, percent] of [["丁寧語", "politeRatio", true], ["感嘆符", "exclamationRate", true], ["平均長", "avgDialogueLength", false]] as const) {
      const row = el("tr"); row.append(el("td", label));
      for (const peerProfile of peerProfiles) row.append(el("td", typeof peerProfile[key] === "number" ? percent ? `${(Number(peerProfile[key]) * 100).toFixed(0)}%` : Number(peerProfile[key]).toFixed(1) : "—"));
      table.append(row);
    }
    const compare = section("類似キャラとの比較"); compare.append(table); root.append(compare);
  }
  if (stylometric) root.append(renderStylometric(stylometric));
  else root.append(el("p", "量的スタイル: 学習に必要なセリフがまだ不足しています。"));
}

function distributionEntries(raw: unknown): Array<[string, number]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0).sort((a, b) => b[1] - a[1]);
}

function renderStylometric(profile: Data): HTMLElement {
  const mean = profile.mean && typeof profile.mean === "object" ? ensureData(profile.mean) : {};
  const stdDev = profile.stdDev && typeof profile.stdDev === "object" ? ensureData(profile.stdDev) : {};
  const sectionNode = section("量的スタイル");
  sectionNode.append(el("p", `n=${String(profile.dialogueCount ?? 0)}`));
  sectionNode.append(
    metricRow("語彙豊富さ (TTR)", mean.typeTokenRatio, true), metricRow("平均形態素数", mean.morphemeCount),
    metricRow("読点頻度", mean.commaFrequency, true), metricRow("形容詞比", mean.adjectiveRatio, true), metricRow("動詞比", mean.verbRatio, true),
  );
  const details = el("details"); details.append(el("summary", "分布の広がり (stdDev)"));
  details.append(metricRow("TTR", stdDev.typeTokenRatio), metricRow("形態素数", stdDev.morphemeCount), metricRow("読点頻度", stdDev.commaFrequency), metricRow("形容詞比", stdDev.adjectiveRatio), metricRow("動詞比", stdDev.verbRatio));
  sectionNode.append(details);
  return sectionNode;
}

function mountVoiceProfiles(root: HTMLElement, context: BrowserModuleContext, cleanups: Array<() => void>): void {
  const status = statusNode();
  const character = characterPicker();
  const content = section("声紋サマリー");
  const reload = button("声紋を再計算");
  let characters: SceneChoice[] = [];
  let profiles: Data | null = null;
  const draw = () => {
    if (!profiles || !character.value) { content.replaceChildren(el("h4", "声紋サマリー"), el("p", "キャラクターを選択してください。")); return; }
    renderVoiceProfile(content, profiles, character.value, characters, (id) => { character.value = id; draw(); });
  };
  const onCharacter = () => draw();
  const onReload = async () => {
    reload.disabled = true; status.textContent = "高信頼セリフから声紋と量的スタイルを再計算しています…";
    try {
      const result = await invoke(context, "speaker.voice.profiles", {});
      profiles = result;
      draw();
      status.textContent = `文体解析 ${String(result.diagnosticsEngine)}@${String(result.diagnosticsEngineVersion)} · 共有 tokenizer ${String(result.tokenizerModel)}@${String(result.tokenizerModelVersion)}`;
    } catch (error) { appendWarning(status, error); }
    finally { reload.disabled = false; }
  };
  character.addEventListener("change", onCharacter); reload.addEventListener("click", onReload);
  cleanups.push(() => character.removeEventListener("change", onCharacter), () => reload.removeEventListener("click", onReload));
  root.append(field("キャラクター", character), reload, status, content);
  void loadCharacters(context).then((items) => {
    characters = items;
    for (const item of items) character.append(new Option(item.name, item.id));
    if (items[0]) character.value = items[0].id;
    draw();
    return onReload();
  }).catch((error) => appendWarning(status, error));
}

function renderEvaluation(root: HTMLElement, data: Data): void {
  const report = data.report && typeof data.report === "object" ? ensureData(data.report) : null;
  if (!report) { root.append(el("p", "このスナップショットには評価レポートがありません。")); return; }
  const metrics = ensureData(report.metrics);
  const list = el("dl");
  const names: Array<[string, string]> = [
    ["高信頼精度", "highPrecision"], ["帰属精度", "attributionAccuracy"], ["カバレッジ", "coverage"],
    ["クラスタ pairwise F1", "clusteringPairwiseF1"], ["話者数 MAE", "nMae"], ["±1 内率", "nWithin1Rate"],
  ];
  for (const [label, key] of names) {
    list.append(el("dt", label), el("dd", typeof metrics[key] === "number" ? `${(Number(metrics[key]) * 100).toFixed(1)}%` : "—"));
  }
  root.append(el("p", `生成 ${String(report.generatedAt)} · ${Array.isArray(report.scenes) ? report.scenes.length : 0} シーン`), list);
  const reasons = ensureData(report.byReason);
  const table = el("table");
  const head = el("tr");
  for (const label of ["規則", "発火", "正解", "精度"]) head.append(el("th", label));
  table.append(head);
  for (const reason of Object.keys(reasons).sort()) {
    const row = ensureData(reasons[reason]);
    const tr = el("tr");
    tr.append(el("td", reasonLabel(reason)), el("td", String(row.fired)), el("td", String(row.correct)), el("td", typeof row.fired === "number" && row.fired > 0 ? `${((Number(row.correct) / Number(row.fired)) * 100).toFixed(1)}%` : "—"));
    table.append(tr);
  }
  root.append(table);

  const scenes = Array.isArray(report.scenes) ? report.scenes.map(ensureData) : [];
  const mismatchOnly = el("input"); mismatchOnly.type = "checkbox";
  const mismatchLabel = field("不一致行のみ表示", mismatchOnly);
  mismatchLabel.style.display = "flex";
  mismatchLabel.style.alignItems = "center";
  const detail = section("シーン別");
  const sceneList = el("div");
  let expandedSceneId: string | null = null;
  const renderScenes = () => {
    sceneList.replaceChildren();
    for (const scene of scenes) {
      const sceneId = String(scene.sceneId ?? "");
      const lines = Array.isArray(scene.lines) ? scene.lines.map(ensureData) : [];
      const matched = Number(scene.textHashMatchedCount ?? lines.length);
      const hashMismatch = Number(scene.textHashMismatchCount ?? 0);
      const correct = lines.filter((line) => line.gold === line.predicted).length;
      const mismatches = lines.filter((line) => line.gold !== line.predicted);
      const toggle = button(`${sceneId} · 突合 ${matched} · textHash 不一致 ${hashMismatch} · 行 ${lines.length}`);
      toggle.setAttribute("aria-expanded", String(expandedSceneId === sceneId));
      toggle.addEventListener("click", () => {
        expandedSceneId = expandedSceneId === sceneId ? null : sceneId;
        renderScenes();
      });
      const row = el("article");
      row.style.borderBottom = "1px solid currentColor";
      row.style.paddingBlock = "0.4rem";
      row.append(toggle);
      if (expandedSceneId === sceneId) {
        row.append(el("p", `評価行 ${lines.length} · 話者一致 ${correct} · 不一致 ${mismatches.length}${hashMismatch > 0 ? ` · textHash 除外 ${hashMismatch}` : ""}`));
        const visible = mismatchOnly.checked ? mismatches : lines;
        if (visible.length === 0) {
          row.append(el("p", mismatchOnly.checked ? "不一致行はありません。" : "評価行がありません。"));
        } else {
          const detailTable = el("table");
          const detailHead = el("tr");
          for (const label of ["#", "gold", "predicted", "reason", "confidence"]) detailHead.append(el("th", label));
          detailTable.append(detailHead);
          for (const line of visible) {
            const tr = el("tr");
            tr.append(
              el("td", String(lines.indexOf(line) + 1)),
              el("td", String(line.gold ?? "—")),
              el("td", String(line.predicted ?? "—")),
              el("td", reasonLabel(String(line.reason ?? "none"))),
              el("td", String(line.confidence ?? "none")),
            );
            detailTable.append(tr);
          }
          row.append(detailTable);
        }
      }
      sceneList.append(row);
    }
  };
  mismatchOnly.addEventListener("change", renderScenes);
  renderScenes();
  detail.append(mismatchLabel, sceneList);
  root.append(detail);
}

function mountEvaluation(root: HTMLElement, context: BrowserModuleContext, cleanups: Array<() => void>): void {
  const status = statusNode();
  const content = section("評価レポート・ルールゲート・再学習");
  const updateGates = el("input"); updateGates.type = "checkbox";
  const run = button("全シーンを評価");
  const refresh = button("保存済みレポートを再読込");
  const train = button("訂正データからモデルを再学習");
  const report = section("評価レポート");
  const gatesView = section("規則ゲート");
  const onRefresh = async () => {
    refresh.disabled = true;
    try {
      const [latest, gates] = await Promise.all([
        invoke(context, "speaker.evaluation.latest", {}), invoke(context, "speaker.ruleGates", {}),
      ]);
      report.replaceChildren(el("h4", "評価レポート"));
      renderEvaluation(report, latest);
      gatesView.replaceChildren(el("h4", "規則ゲート"));
      const table = el("ul");
      const gateData = gates.gates && typeof gates.gates === "object" ? ensureData(gates.gates) : { gates: {} };
      const entries = gateData.gates && typeof gateData.gates === "object" ? ensureData(gateData.gates) : {};
      for (const [reason, value] of Object.entries(entries)) {
        const gate = ensureData(value);
        table.append(el("li", `${reasonLabel(reason)}: ${String(gate.action)}（標本 ${String(gate.sampleSize)}、実測精度 ${typeof gate.measuredPrecision === "number" ? `${(gate.measuredPrecision * 100).toFixed(1)}%` : "—"}）`));
      }
      if (Object.keys(entries).length === 0) table.append(el("li", "ゲートなし（冷スタート）"));
      gatesView.append(table);
      status.textContent = `評価レポート ${latest.exists ? "あり" : "なし"} · 規則ゲート ${gates.exists ? "あり" : "なし"}`;
    } catch (error) { appendWarning(status, error); }
    finally { refresh.disabled = false; }
  };
  const onRun = async () => {
    run.disabled = true; status.textContent = "ゴールド確定済みシーンを再評価しています…";
    try {
      const result = await invoke(context, "speaker.evaluation.run", { writeGates: updateGates.checked });
      report.replaceChildren(el("h4", "今回の評価結果"));
      renderEvaluation(report, result.report && typeof result.report === "object" ? { report: result.report } : { report: result });
      await onRefresh();
      status.textContent = updateGates.checked ? "評価と規則ゲートをこのスナップショットの再構築キャッシュに保存しました。" : "評価レポートをこのスナップショットの再構築キャッシュに保存しました。";
    } catch (error) { appendWarning(status, error); }
    finally { run.disabled = false; }
  };
  const onTrain = async () => {
    train.disabled = true; status.textContent = "訂正ログとゴールド確定行から線形再ランカーを学習し、決定的 holdout で比較しています…";
    try {
      const result = await invoke(context, "speaker.retraining.run", {});
      status.textContent = `学習例 ${String(result.trainExampleCount)} · holdout ${(Number(result.accuracyWithoutModel) * 100).toFixed(1)}% → ${(Number(result.accuracyWithModel) * 100).toFixed(1)}%（${Number(result.deltaPt).toFixed(1)} pt） · ${result.adopted ? "採用条件を通過" : "採用条件未達。既存モデルを保持"}${result.adoptionProposal ? "。モデル採用案をレビューキューへ送りました。" : ""}`;
    } catch (error) { appendWarning(status, error); }
    finally { train.disabled = false; }
  };
  run.addEventListener("click", onRun); refresh.addEventListener("click", onRefresh); train.addEventListener("click", onTrain);
  cleanups.push(() => run.removeEventListener("click", onRun), () => refresh.removeEventListener("click", onRefresh), () => train.removeEventListener("click", onTrain));
  content.append(field("評価後に規則ゲートを更新", updateGates), run, refresh, train, status, report, gatesView);
  root.append(content);
  void onRefresh();
}

export const browserModule: BrowserModuleDefinition = {
  async mount(contributionId, root, context) {
    const cleanups: Array<() => void> = [];
    const titles: Record<string, string> = {
      "speaker.attribution": "話者帰属と声の確認",
      "speaker.review": "話者確認キュー",
      "speaker.dialogue": "キャラクター別セリフ",
      "speaker.voice.profiles": "キャラクター声紋",
      "speaker.evaluation": "話者評価とモデル",
    };
    if (!titles[contributionId]) throw new Error(`Unknown speaker contribution: ${contributionId}`);
    root.replaceChildren(el("h3", titles[contributionId]));
    if (contributionId === "speaker.attribution") mountAttribution(root, context, cleanups);
    else if (contributionId === "speaker.review") mountReviewQueue(root, context, cleanups);
    else if (contributionId === "speaker.dialogue") mountCharacterDialogue(root, context, cleanups);
    else if (contributionId === "speaker.voice.profiles") mountVoiceProfiles(root, context, cleanups);
    else mountEvaluation(root, context, cleanups);
    const dispose = () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
      root.replaceChildren();
    };
    context.signal.addEventListener("abort", dispose, { once: true });
    return () => { context.signal.removeEventListener("abort", dispose); dispose(); };
  },
};

