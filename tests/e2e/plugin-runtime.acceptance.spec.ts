import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

declare global {
  interface Window {
    pluginRuntimeTest: {
      execute(scenario: "success" | "denied" | "stale" | "snapshot-advanced" | "snapshot-mutated-after-invoke" | "cancel" | "destroy" | "hang" | "trap" | "tampered" | "mutated-after-create" | "unadmitted-manifest" | "constructor-bypass" | "unknown-capability"): Promise<unknown>;
    };
  }
}

let fixtureDirectory: string;
let component: Uint8Array;

test.beforeAll(() => {
  fixtureDirectory = mkdtempSync(join(tmpdir(), "proprium-plugin-component-"));
  const componentPath = join(fixtureDirectory, "plugin.component.wasm");
  execFileSync("pnpm", [
    "exec", "jco", "componentize",
    "tests/fixtures/plugin-runtime/component.ts",
    "--wit", "app/src/browser/proprium/plugin-runtime/wit",
    "--world-name", "proprium:plugin/plugin@1.0.0",
    "--disable", "all", "--bundle", "-o", componentPath,
  ], { cwd: resolve("."), stdio: "pipe" });
  component = new Uint8Array(readFileSync(componentPath));
});

test.afterAll(() => rmSync(fixtureDirectory, { recursive: true, force: true }));

test("admitted WIT Components execute in a bounded Worker with scoped Host capabilities", async ({ page }) => {
  await page.route("**/plugin-runtime-fixture.wasm", route => route.fulfill({
    status: 200,
    contentType: "application/wasm",
    body: Buffer.from(component),
  }));
  await page.goto("/plugin-runtime-test.html");
  await expect(page.locator("#ready")).toHaveText("ready");

  const success = await page.evaluate(() => window.pluginRuntimeTest.execute("success")) as {
    result: { value: string; reads: unknown[]; proposals: unknown[]; contributions: unknown[] };
    state: string;
  };
  expect(success.state).toBe("stopped");
  expect(JSON.parse(success.result.value)).toEqual({
    before: "before", files: [{ path: "notes.md", revision: "revision-1" }], workspaceId: "browser-plugin-workspace", delayChecksum: 0,
  });
  expect(success.result.reads).toEqual([{ path: "notes.md", revision: "revision-1" }]);
  expect(success.result.proposals).toEqual([{
    snapshotId: "snapshot-1", snapshotRevision: "commit-1", readSet: [{ path: "notes.md", revision: "revision-1" }],
    changes: [{ path: "notes.md", expectedRevision: "revision-1", content: "after" }],
  }]);
  expect(success.result.contributions).toEqual([{ kind: "panel", id: "fixture-panel", title: "Fixture panel" }]);

  const denied = await page.evaluate(() => window.pluginRuntimeTest.execute("denied")) as { code: string; state: string };
  expect(denied).toMatchObject({ code: "capability_denied", state: "failed" });

  const stale = await page.evaluate(() => window.pluginRuntimeTest.execute("stale")) as { code: string; state: string };
  expect(stale).toMatchObject({ code: "snapshot_stale", state: "active" });

  const advanced = await page.evaluate(() => window.pluginRuntimeTest.execute("snapshot-advanced")) as { code: string; state: string };
  expect(advanced).toMatchObject({ code: "snapshot_stale", state: "active" });

  const snapshotMutation = await page.evaluate(() => window.pluginRuntimeTest.execute("snapshot-mutated-after-invoke")) as {
    result: { value: string; proposals: unknown[] };
    state: string;
  };
  expect(snapshotMutation.state).toBe("stopped");
  expect(JSON.parse(snapshotMutation.result.value)).toMatchObject({ before: "before" });
  expect(snapshotMutation.result.proposals).toEqual([{
    snapshotId: "snapshot-1", snapshotRevision: "commit-1",
    readSet: [{ path: "notes.md", revision: "revision-1" }],
    changes: [{ path: "notes.md", expectedRevision: "revision-1", content: "after" }],
  }]);

  const canceled = await page.evaluate(() => window.pluginRuntimeTest.execute("cancel")) as { code: string; state: string };
  expect(canceled).toMatchObject({ code: "canceled", state: "stopped" });

  const destroyed = await page.evaluate(() => window.pluginRuntimeTest.execute("destroy")) as { state: string };
  expect(destroyed.state).toBe("stopped");

  const tampered = await page.evaluate(() => window.pluginRuntimeTest.execute("tampered")) as { code: string; workerCreated: boolean };
  expect(tampered).toEqual({ code: "digest_mismatch", workerCreated: false });

  const unadmitted = await page.evaluate(() => window.pluginRuntimeTest.execute("unadmitted-manifest")) as { code: string; workerCreated: boolean };
  expect(unadmitted).toEqual({ code: "untrusted_publisher", workerCreated: false });

  const constructorBypass = await page.evaluate(() => window.pluginRuntimeTest.execute("constructor-bypass")) as {
    reflectCode: string;
    objectCreateCode: string;
    workerCreated: boolean;
  };
  expect(constructorBypass).toEqual({
    reflectCode: "untrusted_publisher", objectCreateCode: "untrusted_publisher", workerCreated: false,
  });

  const incompatible = await page.evaluate(() => window.pluginRuntimeTest.execute("unknown-capability")) as { code: string; workerCreated: boolean };
  expect(incompatible).toEqual({ code: "incompatible_abi", workerCreated: false });

  const timedOut = await page.evaluate(() => window.pluginRuntimeTest.execute("hang")) as { code: string; state: string };
  expect(timedOut).toMatchObject({ code: "timeout", state: "failed" });

  const trapped = await page.evaluate(() => window.pluginRuntimeTest.execute("trap")) as { code: string; state: string };
  expect(trapped).toMatchObject({ code: "guest_trap", state: "failed" });

  const mutation = await page.evaluate(() => window.pluginRuntimeTest.execute("mutated-after-create")) as {
    result: { value: string };
    state: string;
  };
  expect(mutation.state).toBe("stopped");
  expect(JSON.parse(mutation.result.value)).toEqual({
    before: "before", files: [{ path: "notes.md", revision: "revision-1" }], workspaceId: "browser-plugin-workspace", delayChecksum: 0,
  });
});
