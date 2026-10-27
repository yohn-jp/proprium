import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { showPanel } from "./restored-ui.helpers.js";

test("real pending typed action cancels and disconnects without applying changes", async ({ page, context }) => {
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
  for (let index = 1; index <= 301; index++) {
    files[`plot/volumes/v/chapters/c/scenes/scene-${index}.yaml`] = `id: scene-${index}\ntype: scene\ntitle: Scene ${index}\nvolume: volume-1\nchapter: chapter-1\norder: ${index}\nmanuscript: manuscript/scene-${index}.md\n`;
    files[`manuscript/scene-${index}.md`] = `Scene ${index}\n` + "x".repeat(7000);
  }
  const identity = { origin:"https://github.com", repositoryId:923456789, owner:"proprium-test", repository:"mcp-official", branch:"main", localWorkspaceId:`mcp-${crypto.randomUUID()}` };
  await page.evaluate(async ({identity, files}) => window.propriumHostTest!.openWorkspace(identity, files), {identity, files});
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
      body:JSON.stringify({jsonrpc:"2.0",id:crypto.randomUUID(),method:"tools/call",params:{name:"git_status",arguments:{repository_id:923456789,branch:"main"}}}),
    });
    expect(response.status).toBe(200);
    const wire = await response.json();
    return JSON.parse(wire.result.content.find((item:{type:string}) => item.type === "text").text);
  }
  async function fileRead() {
    const response = await fetch(`${process.env.VITE_PROPRIUM_GATEWAY_URL}/mcp`, {
      method:"POST", headers:{ Accept:"application/json, text/event-stream", "Content-Type":"application/json", "MCP-Protocol-Version":"2025-11-25" },
      body:JSON.stringify({jsonrpc:"2.0",id:crypto.randomUUID(),method:"tools/call",params:{name:"file_read",arguments:{repository_id:923456789,branch:"main",path:"manuscript/scene-1.md"}}}),
    });
    expect(response.status).toBe(200);
    const wire=await response.json();
    return JSON.parse(wire.result.content.find((item:{type:string}) => item.type === "text").text);
  }
  const beforeCancellation = await repositoryStatus();
  const fileBeforeCancellation = await fileRead();
  const controller = new AbortController();
  const cancelled = pending(controller.signal).then(() => "completed", () => "cancelled");
  await expect(page.locator(".live-mcp-panel").getByText("MCP requests: 1")).toBeVisible({timeout:20_000});
  controller.abort();
  expect(await cancelled).toBe("cancelled");
  await expect(page.locator(".live-mcp-panel").getByText("MCP requests: 1")).toHaveCount(0, {timeout:20_000});
  expect(await repositoryStatus()).toEqual(beforeCancellation);
  const disconnected = pending();
  await expect(page.locator(".live-mcp-panel").getByText("MCP requests: 1")).toBeVisible({timeout:20_000});
  await page.close();
  expect((await disconnected).status).toBe(503);
  const reopened = await context.newPage();
  await reopened.goto("/");
  await reopened.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await reopened.evaluate(async identity => window.propriumHostTest!.openWorkspace(identity), identity);
  await showPanel(reopened, "review");
  await expect(reopened.locator(".live-mcp-panel").getByRole("status").first()).toContainText("ブラウザーに接続中", { timeout:20_000 });
  expect(await repositoryStatus()).toEqual(beforeCancellation);
  expect(await fileRead()).toEqual(fileBeforeCancellation);
});
