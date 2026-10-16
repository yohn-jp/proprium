import { ApiError, api, type Commit, type Project, type Scene, type SyncStatus, type Tree } from "./api.js";
import { clearDraft, loadDraft, restoreDraft, saveDraft, type DraftStorage } from "./drafts.js";

const ACTIVE_PROJECT_KEY = "scriptorium:active-project";
const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing #app root");

let projects: Project[] = [];
let activeProject: Project | null = null;
let activeTree: Tree | null = null;
let activeScene: Scene | null = null;
let currentText = "";
let currentRevision = "";
let conflictScene: Scene | null = null;
let busy = false;
let navigationGeneration = 0;
let currentDraftPersisted = false;

const browserStorage: DraftStorage | null = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

function element<T extends HTMLElement>(selector: string): T | null {
  return app!.querySelector<T>(selector);
}

function setStatus(message: string, kind: "normal" | "error" | "success" = "normal"): void {
  const status = element<HTMLElement>("#status");
  if (!status) return;
  status.textContent = message;
  status.dataset.kind = kind;
}

function showLogin(message = ""): void {
  activeProject = null;
  activeTree = null;
  activeScene = null;
  app!.innerHTML = `
    <section class="login-panel" aria-labelledby="login-title">
      <h1 id="login-title">Scriptorium</h1>
      <p>この執筆ワークスペースにログインしてください。</p>
      <form id="login-form">
        <label for="auth-token">アクセストークン</label>
        <input id="auth-token" name="token" type="password" autocomplete="current-password" required minlength="32">
        <button type="submit">ログイン</button>
        <p id="login-message" class="message" role="status"></p>
      </form>
    </section>`;
  const loginMessage = element<HTMLElement>("#login-message");
  if (loginMessage) loginMessage.textContent = message;
  element<HTMLFormElement>("#login-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const token = String(form.get("token") ?? "");
    const message = element<HTMLElement>("#login-message");
    if (message) message.textContent = "ログインしています…";
    try {
      await api.login(token);
      await loadWorkspace();
    } catch (error) {
      if (message) message.textContent = errorMessage(error);
    }
  });
}

function renderShell(): void {
  app!.innerHTML = `
    <div class="workspace">
      <header class="topbar">
        <a class="brand" href="/" aria-label="Scriptorium ホーム">Scriptorium</a>
        <div class="topbar-status" id="sync-status" aria-live="polite">同期状態を読み込んでいます…</div>
        <button id="logout" class="quiet-button" type="button">ログアウト</button>
      </header>
      <div class="workspace-grid">
        <aside class="sidebar" aria-label="作品">
          <form id="project-form" class="project-form">
            <h2>作品を追加</h2>
            <label for="repo-url">GitHub リポジトリ URL</label>
            <input id="repo-url" name="url" type="url" placeholder="https://github.com/owner/work" required>
            <label for="repo-branch">ブランチ（任意）</label>
            <input id="repo-branch" name="branch" type="text" autocomplete="off">
            <button type="submit">リポジトリを登録</button>
          </form>
          <section aria-labelledby="projects-title" class="project-list-section">
            <h2 id="projects-title">作品</h2>
            <ul id="projects-list" class="plain-list"></ul>
          </section>
          <nav id="tree" class="tree" aria-label="作品構成"></nav>
        </aside>
        <section class="writing-area" aria-label="執筆">
          <p id="status" class="status" role="status" aria-live="polite"></p>
          <div id="empty-state" class="empty-state">
            <h1>Scriptorium</h1>
            <p>GitHub の作品リポジトリを登録して、原稿を書き始めましょう。</p>
          </div>
          <section id="editor" class="editor" hidden>
            <div class="editor-header">
              <div>
                <p id="scene-path" class="eyebrow"></p>
                <h1 id="scene-title"></h1>
              </div>
              <div class="editor-actions">
                <button id="save" type="button">保存</button>
                <button id="history-toggle" class="quiet-button" type="button" aria-expanded="false">履歴を表示</button>
                <button id="sync" class="quiet-button" type="button">GitHub と同期</button>
              </div>
            </div>
            <section id="conflict" class="conflict" hidden aria-labelledby="conflict-title">
              <h2 id="conflict-title">保存内容が更新されています</h2>
              <p>この下書きはブラウザーに保護されています。下の保存済み原稿と比較してから、統合するか保存済み原稿に戻してください。</p>
              <details>
                <summary>現在リポジトリに保存されている原稿</summary>
                <pre id="conflict-text"></pre>
              </details>
              <div class="conflict-actions">
                <button id="rebase-draft" type="button">比較した上で、この下書きを次回保存に使う</button>
                <button id="restore-saved" class="quiet-button" type="button">保存済み原稿に戻す</button>
              </div>
            </section>
            <div class="editor-columns">
              <div class="manuscript-column">
                <label for="manuscript">原稿 Markdown</label>
                <textarea id="manuscript" spellcheck="false" autocapitalize="sentences"></textarea>
                <p class="editor-hint">入力内容はブラウザーに自動保存されます。保存を押すまで Git の原稿は変更されません。</p>
              </div>
              <section class="preview-column" aria-labelledby="preview-title">
                <h2 id="preview-title">縦書きプレビュー</h2>
                <div id="vertical-preview" class="vertical-preview" role="document" aria-label="縦書きプレビュー（読み取り専用）"></div>
              </section>
            </div>
            <section id="history-panel" class="history-panel" hidden aria-labelledby="history-title">
              <h2 id="history-title">Git 履歴</h2>
              <ol id="history-list"></ol>
            </section>
          </section>
        </section>
      </div>
    </div>`;

  element<HTMLFormElement>("#project-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void registerProject(event.currentTarget as HTMLFormElement);
  });
  element<HTMLButtonElement>("#logout")?.addEventListener("click", () => void logout());
  element<HTMLButtonElement>("#save")?.addEventListener("click", () => void saveCurrentScene());
  element<HTMLButtonElement>("#sync")?.addEventListener("click", () => void syncProject());
  element<HTMLButtonElement>("#history-toggle")?.addEventListener("click", () => void toggleHistory());
  element<HTMLTextAreaElement>("#manuscript")?.addEventListener("input", onManuscriptInput);
  element<HTMLButtonElement>("#rebase-draft")?.addEventListener("click", adoptLatestRevision);
  element<HTMLButtonElement>("#restore-saved")?.addEventListener("click", restoreSavedScene);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "ログイン情報を確認してください。";
    if (error.status === 409 || error.status === 412) return "保存先が更新されています。下書きを保護しました。";
    return error.message;
  }
  return error instanceof Error ? error.message : "処理に失敗しました。";
}

function projectLabel(project: Project): string {
  try {
    const url = new URL(project.url);
    const path = url.pathname.replace(/\.git$/u, "").replace(/\/$/u, "");
    return `${url.hostname}${path}`;
  } catch {
    return project.url;
  }
}

async function loadWorkspace(): Promise<void> {
  renderShell();
  try {
    projects = await api.projects();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      showLogin("セッションが切れました。もう一度ログインしてください。");
      return;
    }
    setStatus(errorMessage(error), "error");
    return;
  }
  renderProjects();
  let storedId: string | null = null;
  try {
    storedId = browserStorage?.getItem(ACTIVE_PROJECT_KEY) ?? null;
  } catch {
    storedId = null;
  }
  const project = projects.find((item) => item.id === storedId) ?? projects[0];
  if (project) await activateProject(project.id, true);
}

function renderProjects(): void {
  const list = element<HTMLUListElement>("#projects-list");
  if (!list) return;
  list.replaceChildren();
  if (projects.length === 0) {
    const empty = document.createElement("li");
    empty.className = "muted-list-item";
    empty.textContent = "登録された作品はありません";
    list.append(empty);
    return;
  }
  for (const project of projects) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-button";
    button.textContent = projectLabel(project);
    button.setAttribute("aria-current", project.id === activeProject?.id ? "true" : "false");
    button.addEventListener("click", () => void activateProject(project.id, true));
    item.append(button);
    list.append(item);
  }
}

async function registerProject(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const url = String(data.get("url") ?? "").trim();
  const branch = String(data.get("branch") ?? "").trim();
  setStatus("リポジトリを登録しています…");
  setBusy(true);
  try {
    const project = await api.registerProject(url, branch || undefined);
    projects = await api.projects();
    renderProjects();
    form.reset();
    setStatus("リポジトリを登録しました。", "success");
    await activateProject(project.id, true);
  } catch (error) {
    setStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
  }
}

async function activateProject(projectId: string, openFirstScene: boolean): Promise<void> {
  const project = projects.find((item) => item.id === projectId);
  if (!project) return;
  if (!confirmLeavingScene()) return;
  const generation = ++navigationGeneration;
  activeProject = project;
  activeTree = null;
  activeScene = null;
  currentText = "";
  currentRevision = "";
  currentDraftPersisted = false;
  conflictScene = null;
  try {
    browserStorage?.setItem(ACTIVE_PROJECT_KEY, project.id);
  } catch {
    // Active-project restoration is a convenience; writing remains available.
  }
  renderTree(null);
  renderProjects();
  setStatus("作品構成を読み込んでいます…");
  try {
    const [tree, status] = await Promise.all([api.tree(project.id), api.status(project.id)]);
    if (generation !== navigationGeneration || activeProject?.id !== project.id) return;
    activeTree = tree;
    renderTree(tree);
    renderSyncStatus(status);
    element<HTMLElement>("#empty-state")!.hidden = false;
    element<HTMLElement>("#editor")!.hidden = true;
    setStatus("");
    if (openFirstScene) {
      const firstScene = tree.volumes.flatMap((volume) => volume.chapters.flatMap((chapter) => chapter.scenes.map((scene) => ({ scene, chapter, volume })) ))[0];
      if (firstScene) await openScene(firstScene.scene.id, firstScene.chapter.title, firstScene.volume.title);
    }
  } catch (error) {
    if (generation === navigationGeneration) {
      renderTree(null);
      setStatus(errorMessage(error), "error");
    }
  }
}

function renderTree(tree: Tree | null): void {
  const nav = element<HTMLElement>("#tree");
  if (!nav) return;
  nav.replaceChildren();
  if (!tree) return;
  const title = document.createElement("h2");
  title.textContent = tree.title;
  nav.append(title);
  for (const volume of tree.volumes) {
    const volumeSection = document.createElement("section");
    volumeSection.className = "tree-volume";
    const volumeTitle = document.createElement("h3");
    volumeTitle.textContent = volume.title;
    volumeSection.append(volumeTitle);
    for (const chapter of volume.chapters) {
      const chapterDetails = document.createElement("details");
      chapterDetails.open = true;
      const summary = document.createElement("summary");
      summary.textContent = chapter.title;
      chapterDetails.append(summary);
      const sceneList = document.createElement("ul");
      sceneList.className = "plain-list scene-list";
      for (const scene of chapter.scenes) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "scene-button";
        button.textContent = scene.title;
        button.setAttribute("aria-label", `${chapter.title}: ${scene.title}`);
        button.setAttribute("aria-current", scene.id === activeScene?.id ? "true" : "false");
        button.addEventListener("click", () => void openScene(scene.id, chapter.title, volume.title));
        item.append(button);
        sceneList.append(item);
      }
      chapterDetails.append(sceneList);
      volumeSection.append(chapterDetails);
    }
    nav.append(volumeSection);
  }
}

async function openScene(sceneId: string, chapterTitle = "", volumeTitle = ""): Promise<void> {
  if (!activeProject) return;
  if (activeScene?.id === sceneId) return;
  if (activeScene?.id !== sceneId && !confirmLeavingScene()) return;
  const projectId = activeProject.id;
  const generation = ++navigationGeneration;
  setStatus("原稿を読み込んでいます…");
  try {
    const scene = await api.scene(projectId, sceneId);
    if (generation !== navigationGeneration || activeProject?.id !== projectId) return;
    const stored = loadDraft(browserStorage, projectId, sceneId);
    const restored = restoreDraft(scene, stored);
    activeScene = scene;
    currentText = restored.text;
    currentRevision = restored.revision;
    currentDraftPersisted = restored.restored && stored !== null;
    conflictScene = restored.stale ? scene : null;
    element<HTMLElement>("#empty-state")!.hidden = true;
    element<HTMLElement>("#editor")!.hidden = false;
    element<HTMLElement>("#scene-title")!.textContent = scene.title;
    element<HTMLElement>("#scene-path")!.textContent = [activeTree?.title, volumeTitle, chapterTitle].filter(Boolean).join(" / ");
    const editor = element<HTMLTextAreaElement>("#manuscript")!;
    editor.value = currentText;
    renderTree(activeTree);
    renderConflict();
    renderPreview(currentText);
    if (restored.restored) {
      setStatus(restored.stale ? "未保存の下書きを復元しました。保存先も更新されているため、比較してください。" : "未保存の下書きを復元しました。", restored.stale ? "error" : "normal");
    } else {
      clearDraft(browserStorage, projectId, sceneId);
      currentDraftPersisted = false;
      setStatus("");
    }
    updateSaveButton();
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }
}

function isDirty(): boolean {
  return !!activeScene && currentText !== activeScene.text;
}

function confirmLeavingScene(): boolean {
  if (!isDirty() || currentDraftPersisted) return true;
  return window.confirm("このブラウザーでは未保存の下書きを保護できていません。移動すると入力内容が失われる可能性があります。移動しますか？");
}

function onManuscriptInput(): void {
  const editor = element<HTMLTextAreaElement>("#manuscript");
  if (!editor || !activeProject || !activeScene) return;
  currentText = editor.value;
  if (isDirty()) {
    currentDraftPersisted = saveDraft(browserStorage, activeProject.id, activeScene.id, currentText, currentRevision);
    if (!currentDraftPersisted) {
      setStatus("このブラウザーでは下書きを自動保存できません。保存またはコピーしてください。", "error");
    } else if (!conflictScene) {
      setStatus("未保存の変更があります。下書きはこのブラウザーに保存されています。");
    }
  } else {
    clearDraft(browserStorage, activeProject.id, activeScene.id);
    currentDraftPersisted = false;
    if (!conflictScene) setStatus("");
  }
  renderPreview(currentText);
  updateSaveButton();
}

function updateSaveButton(): void {
  const button = element<HTMLButtonElement>("#save");
  if (!button) return;
  button.disabled = busy || !activeScene || !isDirty();
}

function setBusy(value: boolean): void {
  busy = value;
  updateSaveButton();
  const sync = element<HTMLButtonElement>("#sync");
  if (sync) sync.disabled = value;
  const register = element<HTMLButtonElement>("#project-form button[type=submit]");
  if (register) register.disabled = value;
}

async function saveCurrentScene(): Promise<void> {
  if (!activeProject || !activeScene || !isDirty() || busy) return;
  const projectId = activeProject.id;
  const sceneId = activeScene.id;
  const submittedText = currentText;
  const submittedRevision = currentRevision;
  setBusy(true);
  setStatus("保存しています…");
  try {
    const saved = await api.saveScene(projectId, sceneId, submittedText, submittedRevision);
    const pending = loadDraft(browserStorage, projectId, sceneId);
    if (pending && pending.text !== submittedText) {
      const persisted = saveDraft(browserStorage, projectId, sceneId, pending.text, saved.revision);
      if (activeProject?.id === projectId && activeScene?.id === sceneId) currentDraftPersisted = persisted;
    } else {
      clearDraft(browserStorage, projectId, sceneId);
      if (activeProject?.id === projectId && activeScene?.id === sceneId) currentDraftPersisted = false;
    }
    if (activeProject?.id === projectId && activeScene?.id === sceneId) {
      activeScene = saved;
      currentRevision = saved.revision;
      const editor = element<HTMLTextAreaElement>("#manuscript")!;
      currentText = editor.value;
      if (currentText === submittedText) {
        clearDraft(browserStorage, projectId, sceneId);
        currentDraftPersisted = false;
        currentText = saved.text;
        editor.value = saved.text;
        setStatus("保存しました。", "success");
      } else {
        currentDraftPersisted = saveDraft(browserStorage, projectId, sceneId, currentText, saved.revision);
        setStatus("入力中の原稿を保存しました。続けて入力した分は未保存です。", "normal");
      }
      conflictScene = null;
      renderConflict();
      updateSaveButton();
      await refreshStatus();
    }
  } catch (error) {
    if (activeProject?.id === projectId && activeScene?.id === sceneId) {
      if (error instanceof ApiError && (error.status === 409 || error.status === 412)) {
        try {
          conflictScene = await api.scene(projectId, sceneId);
        } catch {
          conflictScene = null;
        }
        currentDraftPersisted = saveDraft(browserStorage, projectId, sceneId, currentText, submittedRevision);
        renderConflict();
        setStatus("競合を検出しました。下書きは保護され、保存内容は上書きされていません。", "error");
      } else {
        setStatus(errorMessage(error), "error");
      }
    }
  } finally {
    setBusy(false);
  }
}

function renderConflict(): void {
  const panel = element<HTMLElement>("#conflict");
  const text = element<HTMLPreElement>("#conflict-text");
  if (!panel || !text) return;
  panel.hidden = !conflictScene;
  text.textContent = conflictScene?.text ?? "";
}

function adoptLatestRevision(): void {
  if (!conflictScene || !activeScene || !activeProject) return;
  const approved = window.confirm("保存済み原稿と比較し、必要な内容を下書きへ統合しましたか？ 次の保存では、この下書き全体が現在の保存内容を置き換えます。");
  if (!approved) return;
  currentRevision = conflictScene.revision;
  activeScene = conflictScene;
  conflictScene = null;
  currentDraftPersisted = saveDraft(browserStorage, activeProject.id, activeScene.id, currentText, currentRevision);
  renderConflict();
  setStatus("下書きを現在の revision に結び付けました。確認してから保存してください。");
  updateSaveButton();
}

function restoreSavedScene(): void {
  if (!conflictScene || !activeProject || !activeScene) return;
  const approved = window.confirm("ブラウザーに保存された未保存の下書きを削除して、リポジトリの原稿に戻しますか？");
  if (!approved) return;
  const latest = conflictScene;
  clearDraft(browserStorage, activeProject.id, activeScene.id);
  activeScene = latest;
  currentText = latest.text;
  currentRevision = latest.revision;
  currentDraftPersisted = false;
  conflictScene = null;
  element<HTMLTextAreaElement>("#manuscript")!.value = currentText;
  renderConflict();
  renderPreview(currentText);
  setStatus("保存済み原稿を読み込みました。", "success");
  updateSaveButton();
}

function renderPreview(text: string): void {
  const preview = element<HTMLElement>("#vertical-preview");
  if (!preview) return;
  preview.replaceChildren();
  const lines = text.split("\n");
  if (text.length === 0) {
    const empty = document.createElement("p");
    empty.className = "preview-empty";
    empty.textContent = "本文がありません";
    preview.append(empty);
    return;
  }
  for (const line of lines) {
    const paragraph = document.createElement("p");
    paragraph.className = "preview-line";
    paragraph.textContent = line;
    preview.append(paragraph);
  }
}

function renderSyncStatus(status: SyncStatus): void {
  const target = element<HTMLElement>("#sync-status");
  if (!target) return;
  const changes = status.dirty ? "未コミットの変更あり" : "作業ツリー clean";
  target.textContent = `${status.branch} · ${status.head.slice(0, 8)} · ${changes} · ahead ${status.ahead} / behind ${status.behind}`;
}

async function refreshStatus(): Promise<void> {
  if (!activeProject) return;
  try {
    renderSyncStatus(await api.status(activeProject.id));
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }
}

async function syncProject(): Promise<void> {
  if (!activeProject || busy) return;
  setBusy(true);
  setStatus("GitHub と同期しています…");
  try {
    const status = await api.sync(activeProject.id);
    renderSyncStatus(status);
    setStatus("GitHub と同期しました。", "success");
  } catch (error) {
    setStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
  }
}

async function toggleHistory(): Promise<void> {
  if (!activeProject) return;
  const panel = element<HTMLElement>("#history-panel");
  const button = element<HTMLButtonElement>("#history-toggle");
  if (!panel || !button) return;
  if (!panel.hidden) {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    return;
  }
  button.disabled = true;
  try {
    renderHistory(await api.history(activeProject.id));
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
  } catch (error) {
    setStatus(errorMessage(error), "error");
  } finally {
    button.disabled = false;
  }
}

function renderHistory(commits: Commit[]): void {
  const list = element<HTMLOListElement>("#history-list");
  if (!list) return;
  list.replaceChildren();
  if (commits.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "コミット履歴はありません";
    list.append(empty);
    return;
  }
  for (const commit of commits) {
    const item = document.createElement("li");
    const message = document.createElement("strong");
    message.textContent = commit.message;
    const metadata = document.createElement("span");
    const date = new Date(commit.date);
    metadata.textContent = `${date.toLocaleString("ja-JP")} · ${commit.hash.slice(0, 8)}`;
    item.append(message, metadata);
    list.append(item);
  }
}

async function logout(): Promise<void> {
  try {
    await api.logout();
  } finally {
    showLogin("ログアウトしました。");
  }
}

window.addEventListener("beforeunload", (event) => {
  if (isDirty()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

try {
  await api.session();
  await loadWorkspace();
} catch (error) {
  showLogin(error instanceof ApiError && error.status !== 401 ? errorMessage(error) : "");
}
