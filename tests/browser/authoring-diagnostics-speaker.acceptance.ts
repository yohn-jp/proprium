import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chooseFile, expectEditorText, showPanel } from "./restored-ui.helpers.js";

declare global {
  interface Window {
    propriumHostTest?: {
      openWorkspace(identity: { provider: "local"; name: string; branch: string; localWorkspaceId: string }, files?: Record<string, string>): Promise<void>;
    };
  }
}

const scenePath = "plot/volumes/v/chapters/c/scenes/a.yaml";
const manuscriptPath = "manuscript/custom/a.md";
const sceneYaml = "id: s1\ntype: scene\ntitle: 雨の夜\nvolume: v1\nchapter: c1\norder: 1\nmanuscript: manuscript/custom/a.md\nappears: [char-taro]\nunknownField: preserve-me\n";
const manuscript = "太郎は言った。「行こう。」\n彼は…笑った。\n";
const fixture: Record<string, string> = {
  "bible/characters/taro.yaml": "id: char-taro\ntype: character\nname: 太郎\naliases: [太郎]\nvoice_profiles: []\n",
  "plot/volumes/v/volume.yaml": "id: v1\ntype: volume\ntitle: 第一巻\norder: 1\n",
  "plot/volumes/v/chapters/c/chapter.yaml": "id: c1\ntype: chapter\ntitle: 始まり\nvolume: v1\norder: 1\n",
  [scenePath]: sceneYaml,
  [manuscriptPath]: manuscript,
};

async function install(page: Page, id: string, capabilities: string[]) {
  const manager = page.locator("details.plugin-manager-panel");
  await page.getByRole("button", { name: `${id} v0.1.0 の導入内容と署名を確認` }).click();
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  await expect(manager.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました");
  const plugin = page.locator(".installed-plugins > li").filter({ hasText: id }).filter({ hasText: "v0.1.0" });
  for (const capability of capabilities) await plugin.getByRole("checkbox", { name: capability, exact: true }).check();
  await plugin.getByRole("button", { name: "有効化" }).click();
  await expect(manager.getByRole("status")).toContainText(`${id}@0.1.0 is enabled`);
}

async function openAuthorPanel(page: Page, name: string) {
  const configuration = page.locator(".st-workspace-configuration");
  if (await configuration.getAttribute("open") === null) await configuration.locator(":scope > summary").click();
  const menu = page.locator(".st-workspace-panel-menu");
  if (await menu.getAttribute("open") === null) await menu.locator(":scope > summary").click();
  await page.getByRole("button", { name: `${name}を表示する`, exact: true }).click();
  if (await configuration.getAttribute("open") !== null) await configuration.locator(":scope > summary").click();
  const tab = page.getByRole("tab", { name, exact: true }).first();
  if (await tab.isVisible() && await tab.getAttribute("aria-selected") !== "true") await tab.click();
}

test("signed Diagnostics lint and Speaker correction stay inside Host review", async ({ page }) => {
  test.setTimeout(180_000);
  const directory = process.env.PROPRIUM_OFFICIAL_E2E_DIR;
  if (!directory) throw new Error("The signed registry setup did not provide its output directory");
  const registryDir = resolve(directory);
  const registryUrl = new URL(process.env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL!);
  const registryPrefix = registryUrl.pathname.slice(0, registryUrl.pathname.lastIndexOf("/") + 1);
  const artifactOrigin = process.env.PROPRIUM_AUTHORING_TEST_ARTIFACT_BASE
    ? new URL(process.env.PROPRIUM_AUTHORING_TEST_ARTIFACT_BASE).origin
    : registryUrl.origin;
  await page.route(url => (url.origin === registryUrl.origin || url.origin === artifactOrigin) && url.pathname.startsWith(registryPrefix), async route => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice(registryPrefix.length));
    const path = resolve(registryDir, relative);
    if (!path.startsWith(registryDir + sep)) return route.fulfill({ status: 404 });
    try {
      await route.fulfill({ body: await readFile(path), contentType: path.endsWith(".json") ? "application/json" : "application/octet-stream", headers: { "access-control-allow-origin": "*" } });
    } catch { await route.fulfill({ status: 404 }); }
  });

  await page.goto("/");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async files => window.propriumHostTest!.openWorkspace({ provider: "local", name: "diagnostics-speaker-e2e", branch: "main", localWorkspaceId: `diag-speaker-${crypto.randomUUID()}` }, files), fixture);
  await showPanel(page, "review");
  const manager = page.locator("details.plugin-manager-panel");
  await manager.locator("summary").click();
  await page.getByRole("button", { name: "カタログを表示" }).click();
  await install(page, "proprium.narrative", ["workspace.change.propose", "workspace.change.timestamp", "workspace.file.read", "workspace.identity.read"]);
  await install(page, "proprium.knowledge", ["plugin.preferences.read", "workspace.change.propose", "workspace.change.timestamp", "workspace.file.read", "workspace.plugin.invoke", "workspace.repository.snapshot.read"]);
  await install(page, "proprium.speaker", ["workspace.file.read", "workspace.plugin.invoke", "workspace.change.propose", "workspace.change.timestamp", "workspace.derived.cache"]);
  await install(page, "proprium.diagnostics", ["workspace.file.read", "workspace.plugin.invoke", "workspace.change.propose", "artifact.create", "artifact.append", "artifact.seal", "artifact.discard", "workspace.change.timestamp"]);

  await openAuthorPanel(page, "文章・場面診断");
  const diagnostics = page.getByRole("tabpanel", { name: "文章・場面診断", exact: true }).first();
  await diagnostics.getByRole("tab", { name: "文章lint" }).click();
  await diagnostics.getByRole("textbox", { name: "文章", exact: true }).fill("彼は…笑った。");
  await diagnostics.getByRole("button", { name: "送信", exact: true }).click();
  await diagnostics.getByRole("tab", { name: "所見" }).click();
  await expect(diagnostics).toContainText("三点リーダー（…）が1つだけ使われています");

  await diagnostics.getByRole("tab", { name: "場面レポート" }).click();
  await diagnostics.getByRole("textbox", { name: "Scene ID" }).fill("s1");
  await diagnostics.getByRole("button", { name: "送信", exact: true }).click();
  await diagnostics.getByRole("tab", { name: "整形を提案" }).click();
  await diagnostics.getByRole("textbox", { name: "レビューキー" }).fill("diagnostics-lint-acceptance-1");
  await diagnostics.getByRole("button", { name: "送信", exact: true }).click();
  await showPanel(page, "review");
  const proposals = page.getByRole("region", { name: "Authoring proposals" });
  const diagnosticsProposal = proposals.getByRole("button").filter({ hasText: "proprium.diagnostics" }).first();
  await expect(diagnosticsProposal).toBeVisible();
  await diagnosticsProposal.click();
  await expect(proposals).toContainText("Diagnostics: lint formatting");
  await proposals.getByRole("checkbox").first().check();
  await proposals.getByRole("button", { name: "選択した単位をローカルへ適用" }).click();
  await chooseFile(page, manuscriptPath);
  await expectEditorText(page, manuscript.replace("…", "……"));

  await openAuthorPanel(page, "Confirm speaker");
  const speaker = page.getByRole("tabpanel", { name: "Confirm speaker", exact: true }).first();
  await speaker.getByRole("textbox", { name: "Scene ID" }).fill("s1");
  await speaker.getByRole("spinbutton", { name: "Sentence index" }).fill("2");
  await speaker.getByRole("textbox", { name: "Exact dialogue text" }).fill("「行こう。」");
  await speaker.getByRole("textbox", { name: "Knowledge character ID (blank for unknown)" }).fill("char-taro");
  await speaker.getByRole("button", { name: "送信", exact: true }).click();

  await chooseFile(page, scenePath);
  const editor = page.getByRole("textbox", { name: "原稿 Markdown" });
  await expectEditorText(page, sceneYaml);
  await showPanel(page, "review");
  const proposals = page.getByRole("region", { name: "Authoring proposals" });
  const proposal = proposals.getByRole("button").filter({ hasText: "proprium.speaker" }).first();
  await expect(proposal).toBeVisible();
  await proposal.click();
  await expect(proposals).toContainText(scenePath);
  await expect(proposals).toContainText("speaker-corrections");
  await proposals.getByRole("checkbox").first().check();
  await proposals.getByRole("button", { name: "選択した単位をローカルへ適用" }).click();

  await chooseFile(page, scenePath);
  await expect(editor).toContainText("unknownField: preserve-me");
  await expect(editor).toContainText("speakerOverrides");
});
