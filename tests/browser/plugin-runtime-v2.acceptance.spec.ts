import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface FixtureBundle {
  registryBytes: string;
  registrySignature: string;
  manifestBytes: string;
  componentPath: string;
  pinnedRegistryKey: string;
}
interface BrowserFixture extends Omit<FixtureBundle, "pinnedRegistryKey"> {}

declare global {
  interface Window {
    __pluginRuntimeV2PinnedRegistryKey?: string;
    pluginRuntimeV2Test: {
      execute(scenario: "success" | "snapshot-stale" | "tampered-component" | "invalid-registry-signature"): Promise<unknown>;
    };
  }
}

let fixture: BrowserFixture;
let component: Uint8Array;
let pinnedRegistryKey: string;

test.beforeAll(() => {
  const directory = process.env.PROPRIUM_RUNTIME_V2_FIXTURE_DIR;
  if (!directory) throw new Error("The focused v2 Playwright config must install its fixture global setup");
  const bundle = JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8")) as FixtureBundle;
  ({ pinnedRegistryKey, ...fixture } = bundle);
  component = new Uint8Array(readFileSync(join(directory, "component.wasm")));
});

async function openFixture(page: Page, wasm?: Uint8Array): Promise<void> {
  await page.addInitScript(key => {
    (window as Window).__pluginRuntimeV2PinnedRegistryKey = key;
  }, pinnedRegistryKey);
  await page.route("**/plugin-runtime-v2-fixture.json", route => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify(fixture),
  }));
  await page.route("**/plugin-runtime-v2-fixture.wasm", route => route.fulfill({
    status: 200, contentType: "application/wasm", body: Buffer.from(wasm ?? component),
  }));
  await page.goto("/plugin-runtime-v2-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");
}

test("synthetic signed v2 WASM resumes paged Host calls in the same scoped Worker", async ({ page }) => {
  await openFixture(page);
  const result = await page.evaluate(() => window.pluginRuntimeV2Test.execute("success")) as {
    result: { ok: boolean; value: { paths: string[]; content: string; revision: string } };
    hostCalls: string[];
    state: string;
  };
  expect(result).toMatchObject({
    result: { ok: true, value: { paths: ["fixture/chapter-1.md", "fixture/chapter-2.md"], content: "雨が降った。\r\n", revision: "a".repeat(64) } },
    hostCalls: ["workspace.file.list", "workspace.file.list", "workspace.file.read"],
    state: "active",
  });
});

test("stale snapshot stops a continuation before the next Host read", async ({ page }) => {
  await openFixture(page);
  const result = await page.evaluate(() => window.pluginRuntimeV2Test.execute("snapshot-stale")) as {
    result: { ok: boolean; error: { code: string } };
    hostCalls: string[];
    state: string;
  };
  expect(result.result).toMatchObject({ ok: false, error: { code: "snapshot_stale" } });
  expect(result.hostCalls).toEqual(["workspace.file.list"]);
  expect(result.state).toBe("active");
});

test("tampered WASM is rejected before a Worker is activated", async ({ page }) => {
  const changed = Uint8Array.from(component); changed[changed.length - 1] ^= 1;
  await openFixture(page, changed);
  const outcome = await page.evaluate(async () => {
    try { return await window.pluginRuntimeV2Test.execute("success"); }
    catch (error) { return { code: (error as { code?: string }).code ?? "unknown" }; }
  });
  expect(outcome).toMatchObject({ code: "digest_mismatch" });
});

test("invalid registry signature is rejected against the separately pinned test key", async ({ page }) => {
  await openFixture(page);
  const outcome = await page.evaluate(() => window.pluginRuntimeV2Test.execute("invalid-registry-signature"));
  expect(outcome).toEqual({ code: "untrusted_registry" });
});
