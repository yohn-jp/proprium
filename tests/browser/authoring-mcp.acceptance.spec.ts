import { expect, test } from "@playwright/test";
import { showPanel } from "./restored-ui.helpers.js";
import { routeMcpRegistry } from "./authoring-mcp-registry.helpers.js";

test("real MCP invokes signed Narrative actions and requires human proposal approval", async ({ page }) => {
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await routeMcpRegistry(page, origin);
  await page.goto("/");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async () => window.propriumHostTest!.openWorkspace({ origin:"https://github.com", repositoryId:923456789, owner:"proprium-test", repository:"mcp-official", branch:"main", localWorkspaceId:`mcp-${crypto.randomUUID()}` }, {
    "plot/volumes/v/volume.yaml":"id: volume-1\ntype: volume\ntitle: Volume One\norder: 1\n",
    "plot/volumes/v/chapters/c/chapter.yaml":"id: chapter-1\ntype: chapter\ntitle: Chapter One\nvolume: volume-1\norder: 1\n",
  }));
  await showPanel(page, "review");
  const manager = page.locator("details.plugin-manager-panel");
  await manager.locator("summary").click();
  await page.getByRole("button", { name:"カタログを表示" }).click();
  await page.getByRole("button", { name:"proprium.narrative v0.1.0 の導入内容と署名を確認" }).click();
  await page.getByRole("button", { name:"ダウンロードして無効状態でインストール" }).click();
  const card = manager.locator(".installed-plugins > li").filter({ hasText:"proprium.narrative" }).filter({ hasText:"v0.1.0" });
  for (const capability of ["workspace.change.propose", "workspace.change.timestamp", "workspace.file.read", "workspace.identity.read"]) await card.getByRole("checkbox", { name:capability, exact:true }).check();
  await card.getByRole("button", { name:"有効化" }).click();
  await expect(manager.getByRole("status")).toContainText("proprium.narrative@0.1.0 is enabled");
  await expect(page.locator(".live-mcp-panel").getByRole("status").first()).toContainText("ブラウザーに接続中", { timeout:20_000 });
  async function call(operation:string, input:Record<string,unknown>, idempotency_key?:string) {
    const version = "2026-07-28";
    const response = await fetch(`${process.env.VITE_PROPRIUM_GATEWAY_URL}/mcp`, { method:"POST", headers:{ Accept:"application/json, text/event-stream", "Content-Type":"application/json", "MCP-Protocol-Version":version, "Mcp-Method":"tools/call", "Mcp-Name":"plugin_call" }, body:JSON.stringify({jsonrpc:"2.0", id:crypto.randomUUID(), method:"tools/call", params:{name:"plugin_call", arguments:{repository_id:923456789,branch:"main",pluginId:"proprium.narrative",operation,input,...(idempotency_key ? {idempotency_key} : {})}, _meta:{"io.modelcontextprotocol/protocolVersion":version,"io.modelcontextprotocol/clientInfo":{name:"MCP acceptance",version:"1"},"io.modelcontextprotocol/clientCapabilities":{}}}}) });
    const text=await response.text(); expect(response.status, text).toBe(200);
    const wire=JSON.parse(text.startsWith("data:") ? text.split(/\r?\n/u).find(line=>line.startsWith("data:"))!.slice(5).trim() : text);
    expect(wire.error).toBeUndefined();
    return JSON.parse(wire.result.content.find((item:{type:string})=>item.type==="text").text);
  }
  const actions = await call("actions.list", {});
  expect(actions.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ descriptor:expect.objectContaining({ action_id:"proprium.narrative.work.detect" }) }),
  ]));
  expect(actions.items.some((item:{descriptor:{action_id:string}}) => item.descriptor.action_id === "proprium.narrative.hierarchy.outline")).toBe(false);
  const detected = await call("proprium.narrative.work.detect", {});
  expect(detected.ok).toBe(true);
  const revision = detected.value?.tree_revision;
  expect(revision).toMatch(/^sha256-/);
  const denied = await call("proprium.narrative.hierarchy.outline", {});
  expect(denied).toMatchObject({ ok:false, error:{ code:"capability_denied" } });
  const stale = await call("proprium.narrative.hierarchy.tree", { expected_tree_revision:`sha256-${"0".repeat(64)}` });
  expect(stale).toMatchObject({ ok:false, error:{ code:"snapshot_stale" } });
  const proposal = await call("proprium.narrative.structure.create", {kind:"volume",title:"MCP Volume",id:"mcp-volume",expected_tree_revision:revision}, "mcp-volume-1");

  expect(proposal.ok, JSON.stringify(proposal)).toBe(true);
  await showPanel(page, "outline");
  await expect(page.getByRole("list", {name:"Repository files"}).getByRole("button", {name:"plot/volumes/mcp-volume/volume.yaml"})).toHaveCount(0);
  await showPanel(page, "review");
  const review = page.getByRole("region", {name:"Authoring proposals"});
  await expect(review.getByRole("button").first()).toBeVisible({timeout:60_000});
  await review.getByRole("button").first().click();
  await review.getByRole("checkbox").first().check();
  await review.getByRole("button", {name:"選択した単位をローカルへ適用"}).click();
  await expect(review.getByRole("button", {name:/proprium.narrative · applied/})).toBeVisible({timeout:60_000});
  await showPanel(page,"outline");
  await expect(page.getByRole("list", {name:"Repository files"}).getByRole("button", {name:"plot/volumes/mcp-volume/volume.yaml"})).toBeVisible();
});
