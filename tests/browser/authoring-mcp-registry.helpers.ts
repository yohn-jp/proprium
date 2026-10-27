import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** Serve the unchanged signed registry and its artifactBase from the retained release. */
export async function routeMcpRegistry(page: Page, origin: string): Promise<void> {
  const root = resolve(process.env.PROPRIUM_OFFICIAL_E2E_DIR!);
  const registry = JSON.parse(await readFile(resolve(root, "registry.json"), "utf8")) as { artifactBase:string };
  const base = new URL(registry.artifactBase);
  async function serve(route: import("@playwright/test").Route, prefix: string) {
    const pathname = new URL(route.request().url()).pathname;
    const relative = decodeURIComponent(pathname.slice(prefix.length));
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) return route.fulfill({ status:404 });
    try { return await route.fulfill({body:await readFile(path),contentType:path.endsWith(".json")?"application/json":"application/octet-stream",headers:{"access-control-allow-origin":origin}}); }
    catch { return route.fulfill({status:404,headers:{"access-control-allow-origin":origin}}); }
  }
  await page.route(`${origin}/plugin-fixture/**`, route => serve(route,"/plugin-fixture/"));
  if (base.origin !== origin || base.pathname !== "/plugin-fixture/") {
    await page.route(`${base.origin}${base.pathname}**`, route => serve(route,base.pathname));
  }
}
