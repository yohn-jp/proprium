import { expect, test } from "@playwright/test";
import type { WorkspaceIdentity } from "../../app/src/browser/proprium/git/protocol.js";

declare global {
  interface Window {
    propriumHostTest?: {
      openWorkspace(identity: WorkspaceIdentity, files?: Record<string, string>): Promise<void>;
    };
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
