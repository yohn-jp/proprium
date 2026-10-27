import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { showPanel } from "./restored-ui.helpers.js";

// Runtime varies by browser and hardware; opt in when exercising actual deadline behavior.
test("real Narrative work detects Host timeout without changing files", async ({ page }) => {
  test.skip(process.env.PROPRIUM_E2E_LARGE_TIMEOUT !== "1", "Opt in to the load-dependent Host timeout experiment");
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const root = resolve(process.env.PROPRIUM_OFFICIAL_E2E_DIR!);
  await page.route(`${origin}/plugin-fixture/**`, async route => {
    const path = resolve(root, decodeURIComponent(new URL(route.request().url()).pathname.slice("/plugin-fixture/".length)));
    if (!path.startsWith(root + sep)) return route.fulfill({ status: 404 });
    try { return await route.fulfill({ body: await readFile(path), contentType: path.endsWith(".json") ? "application/json" : "application/octet-stream" }); }
    catch { return route.fulfill({ status: 404 }); }
  });
  await page.goto("/");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  const files: Record<string, string> = {
    "plot/volumes/v/volume.yaml":"id: volume-1\ntype: volume\ntitle: Volume One\norder: 1\n",
    "plot/volumes/v/chapters/c/chapter.yaml":"id: chapter-1\ntype: chapter\ntitle: Chapter One\nvolume: volume-1\norder: 1\n",
  };
  for (let index = 1; index <= 3000; index++) {
    files[`plot/volumes/v/chapters/c/scenes/scene-${index}.yaml`] = `id: scene-${index}\ntype: scene\ntitle: Scene ${index}\nvolume: volume-1\nchapter: chapter-1\norder: ${index}\nmanuscript: manuscript/scene-${index}.md\n`;
    files[`manuscript/scene-${index}.md`] = `Scene ${index}\n` + "x".repeat(7000);
  }
  await page.evaluate(async files => window.propriumHostTest!.openWorkspace({ origin:"https://github.com", repositoryId:923456789, owner:"proprium-test", repository:"mcp-official", branch:"main", localWorkspaceId:`mcp-${crypto.randomUUID()}` }, files), files);
  await showPanel(page, "review");
  const manager = page.locator("details.plugin-manager-panel");
  await manager.locator("summary").click();
  await page.getByRole("button", { name:"信頼済みカタログを表示" }).click();
  await page.getByRole("button", { name:"proprium.narrative 0.1.0 の署名済みプレビューを確認" }).click();
  await page.getByRole("button", { name:"ダウンロードして無効状態でインストール" }).click();
  const card = manager.getByRole("listitem").filter({ hasText:"proprium.narrative" }).filter({ hasText:"v0.1.0" });
  for (const capability of ["workspace.change.propose", "workspace.change.timestamp", "workspace.file.read", "workspace.identity.read"]) await card.getByRole("checkbox", { name:capability, exact:true }).check();
  await card.getByRole("button", { name:"Enable" }).click();
  await expect(manager.getByRole("status")).toContainText("proprium.narrative@0.1.0 is enabled");
  await expect(page.locator(".live-mcp-panel").getByRole("status").first()).toContainText("ブラウザーに接続中", { timeout:20_000 });
  const pending = (signal?: AbortSignal) => fetch(`${process.env.VITE_PROPRIUM_GATEWAY_URL}/mcp`, {
    method:"POST", signal, headers:{ Accept:"application/json, text/event-stream", "Content-Type":"application/json", "MCP-Protocol-Version":"2025-11-25" },
    body:JSON.stringify({jsonrpc:"2.0",id:crypto.randomUUID(),method:"tools/call",params:{name:"plugin_call",arguments:{repository_id:923456789,branch:"main",pluginId:"proprium.narrative",operation:"proprium.narrative.work.detect",input:{}}}}),
  });
  async function repositoryStatus() {
    const response = await fetch(`${process.env.VITE_PROPRIUM_GATEWAY_URL}/mcp`, {
      method:"POST", headers:{ Accept:"application/json, text/event-stream", "Content-Type":"application/json", "MCP-Protocol-Version":"2025-11-25" },
      body:JSON.stringify({jsonrpc:"2.0",id:crypto.randomUUID(),method:"tools/call",params:{name:"file_read",arguments:{repository_id:923456789,branch:"main",path:"manuscript/scene-1.md"}}}),
    });
    expect(response.status).toBe(200);
    const wire = await response.json();
    return JSON.parse(wire.result.content.find((item:{type:string}) => item.type === "text").text);
  }
  const beforeCancellation = await repositoryStatus();
  const response = await pending();
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const body = JSON.parse(text.startsWith("data:") ? text.split(/\r?\n/u).find(line => line.startsWith("data:"))!.slice(5).trim() : text);
  const result = JSON.parse(body.result.content.find((item:{type:string}) => item.type === "text").text);
  expect(result).toMatchObject({ok:false, error:{code:"timeout"}});
  expect(await repositoryStatus()).toEqual(beforeCancellation);
  await showPanel(page, "outline");
  await page.getByRole("list", {name:"Repository files"}).getByRole("button", {name:"manuscript/scene-1.md"}).click();
  await showPanel(page, "editor");
  await expect(page.getByRole("textbox", {name:"原稿 Markdown"})).toContainText("Scene 1");
});
