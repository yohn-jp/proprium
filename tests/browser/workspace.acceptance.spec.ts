import { showPanel, expectEditorText, chooseFile } from "./restored-ui.helpers.js";
import { expect, test } from "@playwright/test";
import type { WorkspaceIdentity } from "../../app/src/browser/proprium/git/protocol.js";

declare global {
  interface Window {
    propriumHostTest?: {
      openWorkspace(identity: WorkspaceIdentity, files?: Record<string, string>): Promise<void>;
    };
    propriumDeleteTestStarted?: boolean;
    propriumReleaseDeleteTest?: () => void;
  }
}

function identity(localWorkspaceId: string): WorkspaceIdentity {
  return {
    origin: "https://github.com",
    repositoryId: 923456789,
    owner: "proprium-test",
    repository: "browser-workspace",
    branch: "main",
    localWorkspaceId,
  };
}

async function showRepositoryFiles(page: import("@playwright/test").Page): Promise<void> {
  const fileTree = page.getByRole("list", { name: "Repository files" });
  if (await fileTree.isVisible()) return;
  await showPanel(page, "outline");
  await expect(fileTree).toBeVisible();
}

test("Host edits and commits a generic repository offline, then reopens the saved workspace", async ({ page, context }) => {
  const localWorkspaceId = `pw-${crypto.randomUUID()}`;
  const workspace = identity(localWorkspaceId);
  await page.goto("/?e2e=1");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async ({ workspace, files }) => {
    await window.propriumHostTest!.openWorkspace(workspace, files);
  }, { workspace, files: { "README.md": "A generic Git repository.\n" } });

  const fileTree = page.getByRole("list", { name: "Repository files" });
  await showRepositoryFiles(page);
  await chooseFile(page, "README.md");
  await expectEditorText(page, "A generic Git repository.\n");

  await context.setOffline(true);
  await page.getByLabel("原稿 Markdown").fill("Edited on this browser with no network.\n");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft on this device", { exact: true })).toBeVisible();

  await showPanel(page, "inspector");
  await page.getByLabel("Commit message").fill("Save offline workspace edit");
  await page.getByLabel("Git author name").fill("Proprium Browser Test");
  await page.getByLabel("Git author email").fill("browser-test@example.invalid");
  await page.getByRole("button", { name: "Commit locally" }).click();

  await expect(page.getByText(/^Committed locally · [a-f0-9]{8}$/u)).toBeVisible();
  await showPanel(page, "history");
  const historyEntry = page.getByRole("listitem").filter({ hasText: "Save offline workspace edit" });
  await showPanel(page, "history");
  await expect(historyEntry).toBeVisible();
  await expect(historyEntry.locator("code")).toHaveText(/^[a-f0-9]{10}$/u);
  await showRepositoryFiles(page);
  await expect(page.getByLabel("Local workspace only", { exact: true })).toBeVisible();
  await expect(page.locator(".topbar").getByRole("button", { name: "GitHubに接続", exact: true })).toBeVisible();

  // The dev server cannot supply a newly-created worker while offline. Keep the
  // editing and local Git operations offline, then restore transport before
  // replacing the in-memory workspace state and verifying LightningFS data.
  await context.setOffline(false);
  await page.evaluate(async ({ workspace }) => {
    await window.propriumHostTest!.openWorkspace(workspace);
  }, { workspace });
  await showRepositoryFiles(page);
  await chooseFile(page, "README.md");
  await expectEditorText(page, "Edited on this browser with no network.\n");
  await showPanel(page, "history");
  await expect(historyEntry).toBeVisible();
});

test("local start creates and reopens a generic browser-only workspace without calling a remote", async ({ page }) => {
  await page.goto("/?e2e=1");
  const hostOrigin = new URL(page.url()).origin;
  const remoteRequests: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin !== hostOrigin) remoteRequests.push(url.href);
  });

  await expect(page.getByRole("heading", { name: "Start or open a workspace" })).toBeVisible();
  await page.getByLabel("Workspace name", { exact: true }).fill("A local draft");
  await page.getByRole("button", { name: "Create local workspace", exact: true }).click();
  await showPanel(page, "outline");
  await expect(page.getByLabel("Local workspace only", { exact: true })).toBeVisible();
  await expect(page.locator(".topbar").getByRole("button", { name: "GitHubに接続", exact: true })).toHaveCount(0);

  await page.getByLabel("New file path", { exact: true }).fill("notes.md");
  await page.getByRole("button", { name: "Create new file", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "原稿 Markdown" });
  await editor.fill("A generic local workspace.\n");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.locator(".host-message[role='status']")).toContainText("saved to this browser's local Git worktree");

  await page.getByRole("button", { name: "Workspaces", exact: true }).click();
  await page.getByRole("button", { name: /A local draft/u }).click();
  await showRepositoryFiles(page);
  await chooseFile(page, "notes.md");
  await expectEditorText(page, "A generic local workspace.\n");
  expect(remoteRequests).toEqual([]);
});

test("Host preserves editor text typed while a deleted file is pending, then saves it as a new file", async ({ page }) => {
  const workspace = identity(`delete-race-${crypto.randomUUID()}`);
  await page.goto("/?e2e=1");
  await page.waitForFunction(() => typeof window.propriumHostTest?.openWorkspace === "function");
  await page.evaluate(async ({ workspace, files }) => {
    await window.propriumHostTest!.openWorkspace(workspace, files);
  }, { workspace, files: { "README.md": "Original file contents.\n" } });

  await showRepositoryFiles(page);
  const files = page.getByRole("list", { name: "Repository files" });
  await chooseFile(page, "README.md");
  const editor = page.getByRole("textbox", { name: "原稿 Markdown" });
  await expectEditorText(page, "Original file contents.\n");

  await page.evaluate(async () => {
    const moduleUrl = new URL("/src/browser/proprium/git/index.ts", location.origin).href;
    const runtime = await import(/* @vite-ignore */ moduleUrl) as unknown as {
      BrowserLocalGit: { prototype: Record<string, unknown> };
    };
    const prototype = runtime.BrowserLocalGit.prototype;
    const originalDelete = prototype.delete as (...args: unknown[]) => Promise<void>;
    prototype.delete = async function (this: unknown, ...args: unknown[]): Promise<void> {
      const deletion = Reflect.apply(originalDelete, this, args) as unknown as Promise<void>;
      await deletion;
      window.propriumDeleteTestStarted = true;
      await new Promise<void>(resolve => { window.propriumReleaseDeleteTest = resolve; });
    };
    window.propriumDeleteTestStarted = false;
  });

  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete file" }).click();
  await expect.poll(() => page.evaluate(() => window.propriumDeleteTestStarted === true)).toBe(true);

  const newerText = "Typed while the local delete was completing.\n";
  await editor.fill(newerText);
  await page.evaluate(() => window.propriumReleaseDeleteTest?.());
  await expectEditorText(page, newerText);
  await expect(page.locator(".save-state")).toHaveText("Unsaved editor text");
  await expect(page.locator(".host-message[role='status']")).toContainText(
    "README.md is deleted in the local worktree. Newer editor text is preserved as an unsaved draft; save it to recreate the file.",
  );

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator(".host-message[role='status']")).toContainText("README.md saved to this browser's local Git worktree");
  await showRepositoryFiles(page);
  await expect(files.getByRole("button", { name: "README.md" })).toBeVisible();
  await expectEditorText(page, newerText);
});
