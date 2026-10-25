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
  const toggle = page.getByRole("button", { name: /^Files(?:\s|$)/u });
  if (await toggle.isVisible()) await toggle.click();
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
  await fileTree.getByRole("button", { name: "README.md" }).click();
  await expect(page.getByLabel("File contents")).toHaveValue("A generic Git repository.\n");

  await context.setOffline(true);
  await page.getByLabel("File contents").fill("Edited on this browser with no network.\n");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft on this device", { exact: true })).toBeVisible();

  await page.getByLabel("Commit message").fill("Save offline workspace edit");
  await page.getByLabel("Git author name").fill("Proprium Browser Test");
  await page.getByLabel("Git author email").fill("browser-test@example.invalid");
  await page.getByRole("button", { name: "Commit locally" }).click();

  await expect(page.getByText(/^Committed locally · [a-f0-9]{8}$/u)).toBeVisible();
  const historyEntry = page.getByRole("listitem").filter({ hasText: "Save offline workspace edit" });
  await expect(historyEntry).toBeVisible();
  await expect(historyEntry.locator("code")).toHaveText(/^[a-f0-9]{10}$/u);
  await showRepositoryFiles(page);
  await expect(page.getByText("Sign in to enable remote sync. Local editing remains available offline.")).toBeVisible();

  // The dev server cannot supply a newly-created worker while offline. Keep the
  // editing and local Git operations offline, then restore transport before
  // replacing the in-memory workspace state and verifying LightningFS data.
  await context.setOffline(false);
  await page.evaluate(async ({ workspace }) => {
    await window.propriumHostTest!.openWorkspace(workspace);
  }, { workspace });
  await showRepositoryFiles(page);
  await fileTree.getByRole("button", { name: "README.md" }).click();
  await expect(page.getByLabel("File contents")).toHaveValue("Edited on this browser with no network.\n");
  await expect(historyEntry).toBeVisible();
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
  await files.getByRole("button", { name: "README.md" }).click();
  const editor = page.getByRole("textbox", { name: "File contents" });
  await expect(editor).toHaveValue("Original file contents.\n");

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
  await expect(editor).toHaveValue(newerText);
  await expect(page.locator(".save-state")).toHaveText("Unsaved editor text");
  await expect(page.locator(".host-message[role='status']")).toContainText(
    "README.md is deleted in the local worktree. Newer editor text is preserved as an unsaved draft; save it to recreate the file.",
  );

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.locator(".host-message[role='status']")).toContainText("README.md saved to this browser's local Git worktree");
  await showRepositoryFiles(page);
  await expect(files.getByRole("button", { name: "README.md" })).toBeVisible();
  await expect(editor).toHaveValue(newerText);
});
