import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

declare global {
  interface Window {
    pluginRuntimeTest: {
      execute(scenario: "success" | "denied" | "hang" | "trap" | "tampered" | "unknown-capability"): Promise<unknown>;
    };
  }
}

let fixtureDirectory: string;
let component: Uint8Array;

test.beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "proprium-plugin-component-"));
  const componentPath = join(fixtureDirectory, "plugin.component.wasm");
  execFileSync("pnpm", [
    "dlx", "@bytecodealliance/jco@1.39.0", "componentize",
    "tests/fixtures/plugin-runtime/component.ts",
    "--wit", "app/src/browser/proprium/plugin-runtime/wit",
    "--world-name", "proprium:plugin/plugin@1.0.0",
    "--disable", "all", "--bundle", "-o", componentPath,
  ], { cwd: resolve("."), stdio: "pipe" });
  component = new Uint8Array(readFileSync(componentPath));
});

test.afterAll(() => rmSync(fixtureDirectory, { recursive: true, force: true }));

test("admitted WIT Components execute in a bounded Worker with default-denied Host imports", async ({ page }) => {
  await page.route("**/plugin-runtime-fixture.wasm", route => route.fulfill({
    status: 200,
    contentType: "application/wasm",
    body: Buffer.from(component),
  }));
  await page.goto("/plugin-runtime-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");

  const success = await page.evaluate(() => window.pluginRuntimeTest.execute("success")) as {
    result: { value: string };
    state: string;
  };
  expect(success.state).toBe("stopped");
  expect(JSON.parse(success.result.value)).toEqual({ workspaceId: "browser-plugin-workspace" });

  const denied = await page.evaluate(() => window.pluginRuntimeTest.execute("denied")) as { code: string; state: string };
  expect(denied).toMatchObject({ code: "capability_denied", state: "failed" });

  const tampered = await page.evaluate(() => window.pluginRuntimeTest.execute("tampered")) as { code: string; workerCreated: boolean };
  expect(tampered).toEqual({ code: "digest_mismatch", workerCreated: false });

  const incompatible = await page.evaluate(() => window.pluginRuntimeTest.execute("unknown-capability")) as { code: string; workerCreated: boolean };
  expect(incompatible).toEqual({ code: "incompatible_abi", workerCreated: false });

  const timedOut = await page.evaluate(() => window.pluginRuntimeTest.execute("hang")) as { code: string; state: string };
  expect(timedOut).toMatchObject({ code: "timeout", state: "failed" });

  const trapped = await page.evaluate(() => window.pluginRuntimeTest.execute("trap")) as { code: string; state: string };
  expect(trapped).toMatchObject({ code: "guest_trap", state: "failed" });
});
