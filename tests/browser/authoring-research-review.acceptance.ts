import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chooseFile, expectEditorText, showPanel } from "./restored-ui.helpers.js";

function registryDirectory(): string {
  const directory = process.env.PROPRIUM_KNOWLEDGE_REGISTRY ?? process.env.PROPRIUM_OFFICIAL_E2E_DIR;
  if (!directory) throw new Error("A verified signed authoring registry is required for this test");
  return resolve(directory);
}

async function install(page: Page, id: string, grants: string[]) {
  const manager = page.locator("details.plugin-manager-panel");
  await page.getByRole("button", { name: new RegExp(`${id.replaceAll(".", "\\.")} .* の導入内容と署名を確認`) }).click();
  await page.getByRole("button", { name: "ダウンロードして無効状態でインストール" }).click();
  await expect(manager.getByRole("status")).toContainText("署名とダイジェストを検証し、無効状態でインストールしました", { timeout: 60_000 });
  const plugin = manager.locator(".installed-plugins > li").filter({ hasText: id }).filter({ hasText: "無効" });
  for (const grant of grants) await plugin.getByRole("checkbox", { name: grant, exact: true }).check();
  await plugin.getByRole("button", { name: "有効化" }).click();
  await expect(manager.getByRole("status")).toContainText(`${id}@`, { timeout: 60_000 });
}

async function reviewProposal(page: Page, pluginId: string, decision: "apply" | "reject"): Promise<void> {
  const review = page.getByRole("region", { name: "Authoring proposals" });
  const proposal = review.getByRole("button", { name: new RegExp(`${pluginId.replaceAll(".", "\\.")} · pending`) }).last();
  await expect(proposal).toBeVisible({ timeout: 30_000 });
  await proposal.click();
  if (decision === "apply") {
    await review.getByRole("button", { name: "選択した単位をローカルへ適用" }).click();
  } else {
    await review.getByRole("button", { name: "提案を却下" }).click();
  }
}

test("signed Research review discovers Knowledge evidence, hands it to Knowledge, and reviews ignore lifecycle without migrating legacy grants", async ({ page }, info) => {
  const origin = new URL(info.project.use.baseURL!).origin;
  const registry = registryDirectory();
  const serve = async (route: import("@playwright/test").Route) => {
    const pathname = new URL(route.request().url()).pathname;
    const relative = decodeURIComponent(pathname.split(pathname.startsWith("/plugins/") ? "/plugins/" : "/plugin-fixture/")[1] ?? "");
    const path = resolve(registry, relative);
    if (!path.startsWith(registry + sep)) return route.fulfill({ status: 404 });
    try { await route.fulfill({ body: await readFile(path), contentType: path.endsWith(".json") ? "application/json" : "application/octet-stream", headers: { "Access-Control-Allow-Origin": origin } }); }
    catch { await route.fulfill({ status: 404 }); }
  };
  await page.route("**/plugin-fixture/**", serve);
  await page.route("https://authoring-build.invalid/plugins/**", serve);
  await page.goto("/");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  const workspace = { origin: "https://github.com", repositoryId: 923456792, owner: "proprium-test", repository: "research-review", branch: "main", localWorkspaceId: `research-${crypto.randomUUID()}` };
  const ignoreYaml = "# Preserve this author comment\nextensions:\n  local: keep-me\nignored: []\n";
  await page.evaluate(async ({ workspace, ignoreYaml }) => window.propriumHostTest!.openWorkspace(workspace, {
    "bible/characters/char-a.yaml": "id: char-a\ntype: character\nname: 灯\naliases: [あかり]\ndescription: 黒猫と白猫が青い灯台のそばで静かに眠る。\n",
    "bible/locations/loc-a.yaml": "id: loc-a\ntype: location\nname: 灯台\ndescription: 海辺に建つ。\n",
    "meta/scriptorium/modules/nlp/feature-settings.json": JSON.stringify({ externalEnabled: { rewrite: true, "retired-feature": true } }) + "\n",
    "meta/scriptorium/modules/nlp/candidate-ignore-list.yaml": ignoreYaml,
  }), { workspace, ignoreYaml });
  await showPanel(page, "review");
  const manager = page.locator("details.plugin-manager-panel");
  await manager.locator("summary").click();
  await page.getByRole("button", { name: "カタログを表示" }).click();
  await install(page, "proprium.knowledge", ["workspace.file.read", "workspace.change.propose"]);
  await install(page, "proprium.research", ["workspace.file.read", "workspace.asset.read", "workspace.derived.cache", "workspace.change.propose", "artifact.create", "artifact.append", "artifact.seal", "artifact.discard"]);

  const review = page.getByRole("region", { name: "Research 候補のレビュー" });
  await expect(review).toBeVisible({ timeout: 30_000 });
  const legacy = review.getByText("旧 NLP 外部送信設定と Host 権限");
  await legacy.click();
  await expect(review.locator('[data-legacy-feature="rewrite"]')).toContainText("旧設定: 有効");
  await expect(review.locator('[data-legacy-feature="rewrite"]')).toContainText("Host 権限へ引き継がれません");
  await expect(review.locator('[data-legacy-feature="retired-feature"]')).toContainText("Host 権限はありません");
  await review.getByRole("button", { name: "Host Plugin Manager で現在の署名済み権限を確認" }).click();
  await expect(manager.locator(".installed-plugins")).toContainText("proprium.research@", { timeout: 30_000 });
  await expect(manager.locator(".installed-plugins")).not.toContainText("proprium.paired-writing@");

  const assets = page.locator("details.authoring-assets");
  await assets.locator("summary").click();
  const dictionary = assets.getByRole("listitem").filter({ hasText: "proprium.research.ipadic" });
  await dictionary.getByRole("button", { name: "配布データと容量を確認" }).click();
  const capacity = assets.getByRole("region", { name: "追加データの容量確認" });
  await expect(capacity).toBeVisible();
  await capacity.getByRole("checkbox").check();
  await capacity.getByRole("button", { name: "確認したデータの取得を開始" }).click();
  await expect(assets.getByRole("status").filter({ hasText: "署名・全チャンク" })).toBeVisible({ timeout: 60_000 });

  await review.getByRole("button", { name: "Knowledge エンティティを選ぶ" }).click();
  await expect(review.getByText("char-a", { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  await review.getByRole("button", { name: "選択した文章から候補を抽出" }).click();
  const candidate = review.locator('[data-candidate-term="黒猫"]');
  await expect(candidate).toBeVisible({ timeout: 90_000 });
  await expect(candidate).toContainText("bible/characters/char-a.yaml");
  await expect(candidate).toContainText("黒猫");
  await candidate.getByRole("combobox", { name: "黒猫 の Knowledge 種別" }).selectOption("lore");
  await candidate.getByRole("button", { name: "Knowledge にエンティティ作成を提案" }).click();
  const hostReview = page.getByRole("region", { name: "Authoring proposals" });
  const knowledgeProposal = hostReview.getByRole("button", { name: /proprium\.knowledge · pending/u }).last();
  await expect(knowledgeProposal).toBeVisible({ timeout: 30_000 });
  await knowledgeProposal.click();
  await expect(hostReview.locator("pre")).toContainText("bible/characters/char-a.yaml");
  await expect(hostReview.locator("pre")).toContainText("黒猫");
  await hostReview.getByRole("button", { name: "選択した単位をローカルへ適用" }).click();

  // The new entity becomes a known term; rerun from Knowledge before reviewing a separate candidate.
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: /Knowledge エンティティを(?:選ぶ|再読込)/u }).click();
  await review.getByRole("button", { name: "選択した文章から候補を抽出" }).click();
  const whiteCat = review.locator('[data-candidate-term="白猫"]');
  await expect(whiteCat).toBeVisible({ timeout: 90_000 });

  // First reject a revision-guarded ignore proposal: the comment and extension data remain unchanged.
  await whiteCat.getByRole("button", { name: "Host Review に無視を提案" }).click();
  await reviewProposal(page, "proprium.research", "reject");
  await chooseFile(page, "meta/scriptorium/modules/nlp/candidate-ignore-list.yaml");
  await expectEditorText(page, ignoreYaml);

  // Approve the same action, rerun against current Git revisions, then restore it through Host review.
  await showPanel(page, "review");
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: /Knowledge エンティティを(?:選ぶ|再読込)/u }).click();
  await review.getByRole("button", { name: "選択した文章から候補を抽出" }).click();
  await expect(review.locator('[data-candidate-term="白猫"]')).toBeVisible({ timeout: 90_000 });
  await review.locator('[data-candidate-term="白猫"]').getByRole("button", { name: "Host Review に無視を提案" }).click();
  await reviewProposal(page, "proprium.research", "apply");
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: /Knowledge エンティティを(?:選ぶ|再読込)/u }).click();
  await review.getByRole("button", { name: "選択した文章から候補を抽出" }).click();
  await expect(review.locator('[data-candidate-term="白猫"]')).toHaveCount(0, { timeout: 90_000 });
  const ignored = review.locator("details").filter({ hasText: "無視した候補" });
  await ignored.locator("summary").click();
  await expect(ignored).toContainText("白猫");
  await ignored.getByRole("button", { name: "Host Review に復元を提案" }).click();
  await reviewProposal(page, "proprium.research", "apply");
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: /Knowledge エンティティを(?:選ぶ|再読込)/u }).click();
  await review.getByRole("button", { name: "選択した文章から候補を抽出" }).click();
  await expect(review.locator('[data-candidate-term="白猫"]')).toBeVisible({ timeout: 90_000 });

  await chooseFile(page, "meta/scriptorium/modules/nlp/candidate-ignore-list.yaml");
  await expect.poll(() => page.evaluate(() => window.propriumHostEditorText?.() ?? null)).toContain("local: keep-me");
  await expect.poll(() => page.evaluate(() => window.propriumHostEditorText?.() ?? null)).not.toContain("白猫");
});
