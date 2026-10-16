import { expect, test, type Page } from "@playwright/test";
import { pathToFileURL } from "node:url";

const authToken = process.env.SCRIPTORIUM_E2E_AUTH_TOKEN ?? "";
const repositoryUrl = process.env.SCRIPTORIUM_E2E_REPOSITORY_URL ?? "";
const branch = process.env.SCRIPTORIUM_E2E_REPOSITORY_BRANCH ?? "main";

interface JournalSummary {
  documentPath: string;
  state: string;
  operationId: string;
  generation: number;
  text: string;
  authorScope: string | null;
  attachmentWrites: number;
  writes: Array<{ path: string; content: string | null }>;
}

interface PublicationReceiptSummary {
  batchId: string;
  state: string;
  acknowledged: Array<{ operationId: string; generation: number }>;
  authorScope: string;
}

interface ProposalJournalSummary {
  authorScope: string | null;
  proposal: {
    id: string;
    source: string;
    operations: Array<{ id: string; generation: number; writes: Array<{ path: string; content: string | null }> }>;
    evidence?: Array<{ id: string; module: string }>;
  };
  status?: { state: string; approvedOperationIds: string[]; checkpoints: unknown[] };
}

function repositoryInputValue(value: string): string {
  return value.startsWith("https://") || value.startsWith("file://")
    ? value
    : pathToFileURL(value).href;
}

function projectLabel(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname.replace(/\.git$/u, "").replace(/\/$/u, "")}`;
  } catch {
    return value;
  }
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("アクセストークン").fill(authToken);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByRole("heading", { name: "作品を追加" })).toBeVisible();
}

async function openFixtureProject(page: Page): Promise<void> {
  const existing = page.getByRole("button", { name: projectLabel(repositoryUrl), exact: true });
  if (await existing.isVisible()) {
    await existing.click();
  } else {
    await page.getByLabel("GitHub リポジトリ URL").fill(repositoryInputValue(repositoryUrl));
    await page.getByLabel("ブランチ（任意）").fill(branch);
    await page.getByRole("button", { name: "リポジトリを登録" }).click();
  }
  await expect(page.getByRole("heading", { name: "Volume One" })).toBeVisible();
  await page.getByRole("button", { name: "Chapter One: Scene One" }).click();
  await expect(page.getByRole("heading", { name: "Scene One" })).toBeVisible();
  await expect(page.locator(".cm-content")).toBeVisible();
}

async function readJournal(page: Page): Promise<JournalSummary[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("operations", "readonly");
      const records = await new Promise<Array<{
        documentPath: string;
        state: string;
        text: string;
        authorScope?: string | null;
        operation: { id: string; generation: number; writes: Array<{ path: string; content: string | null; encoding?: string }> };
      }>>((resolve, reject) => {
        const request = transaction.objectStore("operations").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB journal read failed"));
      });
      return records.map((entry) => ({
        documentPath: entry.documentPath,
        state: entry.state,
        operationId: entry.operation.id,
        generation: entry.operation.generation,
        text: entry.text,
        authorScope: entry.authorScope ?? null,
        attachmentWrites: entry.operation.writes.filter((write) => write.encoding === "base64").length,
        writes: entry.operation.writes.map((write) => ({ path: write.path, content: write.content })),
      }));
    } finally {
      database.close();
    }
  });
}

async function readPublicationReceipts(page: Page): Promise<PublicationReceiptSummary[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("publicationReceipts", "readonly");
      return await new Promise<PublicationReceiptSummary[]>((resolve, reject) => {
        const request = transaction.objectStore("publicationReceipts").getAll();
        request.onsuccess = () => resolve(request.result.map((record: {
          authorScope: string;
          receipt: PublicationReceiptSummary;
        }) => ({
          authorScope: record.authorScope,
          batchId: record.receipt.batchId,
          state: record.receipt.state,
          acknowledged: record.receipt.acknowledged.map((item) => ({ operationId: item.operationId, generation: item.generation })),
        })));
        request.onerror = () => reject(request.error ?? new Error("IndexedDB receipt read failed"));
      });
    } finally {
      database.close();
    }
  });
}

async function readProposalJournal(page: Page): Promise<ProposalJournalSummary[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("proposals", "readonly");
      return await new Promise<ProposalJournalSummary[]>((resolve, reject) => {
        const request = transaction.objectStore("proposals").getAll();
        request.onsuccess = () => resolve(request.result.map((record: ProposalJournalSummary) => ({
          authorScope: record.authorScope ?? null,
          proposal: record.proposal,
          status: record.status,
        })));
        request.onerror = () => reject(request.error ?? new Error("IndexedDB proposal journal read failed"));
      });
    } finally {
      database.close();
    }
  });
}

async function waitForJournalCount(page: Page, count: number): Promise<void> {
  await expect.poll(async () => (await readJournal(page)).length).toBe(count);
}

test("writing UI recovers multi-document drafts and separates Draft, Checkpoint, and GitHub publication", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");

  const cspErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy|refused to|violat(?:e|ion)/iu.test(message.text())) {
      cspErrors.push(message.text());
    }
  });

  await signIn(page);
  await openFixtureProject(page);
  const nonce = await page.locator('meta[name="scriptorium-style-nonce"]').getAttribute("content");
  expect(nonce).toBeTruthy();
  expect(nonce).not.toBe("__SCRIPTORIUM_STYLE_NONCE__");

  const editor = page.locator(".cm-content");
  await editor.fill("彼は|東京《とうきょう》へ行く。");
  await expect(page.locator(".manuscript-preview ruby")).toContainText("東京");
  await expect(page.locator(".manuscript-preview rt")).toHaveText("とうきょう");
  await page.getByRole("button", { name: "縦書き" }).click();
  await expect(page.locator(".manuscript-preview.is-vertical")).toBeVisible();
  await page.getByRole("button", { name: "読書モード" }).click();
  await expect(page.getByRole("document", { name: "縦書き読書モード" })).toBeVisible();
  await page.getByRole("button", { name: "編集に戻る" }).click();
  await page.getByRole("button", { name: "集中" }).click();
  await expect(page.locator(".editor.is-zen")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".editor.is-zen")).toHaveCount(0);

  await page.getByRole("button", { name: "文字を大きく" }).click();
  await expect(page.locator('output[aria-label="文字サイズ"]')).toHaveText("18px");
  await page.getByLabel("組版プリセット").selectOption("bunko");
  await expect(page.getByLabel("組版プリセット")).toHaveValue("bunko");
  await expect.poll(() => page.locator(".manuscript-preview").evaluate((element) => getComputedStyle(element).getPropertyValue("--reader-line-height"))).toBe("1.7");
  await expect.poll(() => page.locator(".manuscript-preview").evaluate((element) => getComputedStyle(element).getPropertyValue("--reader-max-width"))).toBe("560px");
  await page.setViewportSize({ width: 390, height: 844 });
  await editor.fill("物語");
  await editor.press("Control+a");
  await page.getByRole("button", { name: "鉤括弧を挿入" }).click();
  await expect(editor).toHaveText("「物語」");

  await page.locator(".scratch-panel summary").click();
  const scratchText = "本文に入れない台詞候補";
  await page.getByLabel("本文に含まれないメモ").fill(scratchText);
  await page.getByLabel("スクラッチ画像を添付").setInputFiles({
    name: "mood-board.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  await editor.click();
  await expect(page.locator(".scratch-panel summary")).toContainText("Draft を保護済み");
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.documentPath.startsWith("meta/scratch/") && entry.text === scratchText && entry.attachmentWrites === 1)).toBe(true);

  const longReadingDraft = Array.from({ length: 240 }, () => "物語の続きを書く。読書ページを移動します。").join("");
  await editor.fill(longReadingDraft);
  await page.getByRole("button", { name: "読書モード" }).click();
  const pager = page.locator(".reading-pager");
  await expect.poll(async () => Number(await pager.getAttribute("data-page-count"))).toBeGreaterThan(1);
  await page.getByRole("button", { name: "次のページ" }).click();
  await expect(pager).toHaveAttribute("data-page-index", "1");
  await page.getByRole("button", { name: "編集に戻る" }).click();

  const sceneTwoDraft = "A separate Scene Two browser draft.";
  await page.getByRole("button", { name: "Chapter One: Scene Two" }).click();
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
  await page.locator(".cm-content").fill(sceneTwoDraft);
  await expect.poll(async () => {
    const entries = await readJournal(page);
    return entries.some((entry) => entry.state === "draft" && entry.text === longReadingDraft) &&
      entries.some((entry) => entry.state === "draft" && entry.text === sceneTwoDraft);
  }).toBe(true);
  await waitForJournalCount(page, 3);
  await page.getByRole("button", { name: "Chapter One: Scene One" }).click();
  await expect(page.locator(".cm-content")).toHaveText(longReadingDraft);

  await page.reload();
  await openFixtureProject(page);
  await expect(page.locator('output[aria-label="文字サイズ"]')).toHaveText("18px");
  await expect(page.locator(".cm-content")).toHaveText(longReadingDraft);
  await page.getByRole("button", { name: "読書モード" }).click();
  await expect(page.locator(".reading-pager")).toHaveAttribute("data-page-index", "1");
  await page.getByRole("button", { name: "編集に戻る" }).click();
  await page.locator(".scratch-panel summary").click();
  await page.locator(".scratch-panel").getByRole("button", { name: "続ける" }).click();
  await expect(page.getByLabel("本文に含まれないメモ")).toHaveValue(scratchText);
  await page.locator(".scratch-panel").getByRole("button", { name: "Checkpoint", exact: true }).click();
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.documentPath.startsWith("meta/scratch/") && entry.state === "checkpointed")).toBe(true);
  const sceneOneDraft = "Scene One draft restored from IndexedDB.";
  await editor.fill(sceneOneDraft);
  // Move within the debounce window; navigation must flush Scene One before Scene Two can type.
  await page.getByRole("button", { name: "Chapter One: Scene Two" }).click();
  await expect(page.locator(".cm-content")).toHaveText(sceneTwoDraft);
  await page.locator(".cm-content").press("Control+z");
  await expect(page.locator(".cm-content")).toHaveText(sceneTwoDraft);
  await page.getByRole("button", { name: "Chapter One: Scene One" }).click();
  await expect(page.locator(".cm-content")).toHaveText(sceneOneDraft);

  await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
  await expect(page.locator(".durability-message")).toContainText("ローカルチェックポイント");
  await expect(page.getByRole("button", { name: "Save to GitHub" })).toBeEnabled();
  const checkpointed = await readJournal(page);
  expect(checkpointed).toHaveLength(3);
  expect(checkpointed.find((entry) => entry.text === sceneOneDraft)?.state).toBe("checkpointed");
  const checkpointBatchId = checkpointed.find((entry) => entry.text === sceneOneDraft)?.operationId;
  const scratchBatchId = checkpointed.find((entry) => entry.documentPath.startsWith("meta/scratch/"))?.operationId;
  await page.getByRole("button", { name: "Save to GitHub" }).click();
  await expect(page.locator(".topbar-status")).toContainText("GitHub への保存を確認しました。");
  await expect(page.getByText("Saved to GitHub", { exact: true })).toBeVisible();
  await expect.poll(async () => (await readJournal(page)).map((entry) => `${entry.documentPath}:${entry.state}`)).toEqual([
    "manuscript/vol-1/ch-1/scene-2.md:draft",
  ]);
  expect((await readPublicationReceipts(page)).some((receipt) => receipt.state === "confirmed" &&
    receipt.acknowledged.some((item) => item.operationId === checkpointBatchId) &&
    receipt.acknowledged.some((item) => item.operationId === scratchBatchId))).toBe(true);
  const laterDraft = "A later draft compared with the published version.";
  await editor.fill(laterDraft);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === laterDraft && entry.state === "draft")).toBe(true);
  await page.getByRole("button", { name: "履歴" }).click();
  await expect(page.getByRole("heading", { name: "改稿の履歴" })).toBeVisible();
  const versions = page.getByRole("list", { name: "原稿の各バージョン" });
  await expect(versions.locator("li")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "この版を下書きとして開く" })).toBeVisible();
  await page.getByRole("button", { name: "この版を下書きとして開く" }).click();
  await expect(page.locator(".cm-content")).toHaveText(sceneOneDraft);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.documentPath === "manuscript/vol-1/ch-1/scene-1.md" && entry.text === sceneOneDraft && entry.state === "draft")).toBe(true);
  const restoredHistoryDraft = (await readJournal(page)).find((entry) => entry.documentPath === "manuscript/vol-1/ch-1/scene-1.md" && entry.text === sceneOneDraft);
  expect(restoredHistoryDraft?.state).toBe("draft");
  expect(restoredHistoryDraft?.text).toBe(sceneOneDraft);
  expect(restoredHistoryDraft?.writes.find((write) => write.path.endsWith("scene-1.md"))?.content).toContain(sceneOneDraft);
  expect(cspErrors).toEqual([]);
});

test("new typing survives an older in-flight checkpoint and exact publication acknowledgement", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await signIn(page);
  await openFixtureProject(page);

  const firstGeneration = "Checkpoint generation one.";
  await page.locator(".cm-content").fill(firstGeneration);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.state === "draft" && entry.text === firstGeneration)).toBe(true);

  let releaseCheckpoint!: () => void;
  let signalCheckpoint!: () => void;
  const checkpointGate = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
  const checkpointStarted = new Promise<void>((resolve) => { signalCheckpoint = resolve; });
  await page.route(/\/api\/projects\/[^/]+\/checkpoints$/u, async (route) => {
    if (route.request().method() === "POST") {
      signalCheckpoint();
      await checkpointGate;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
  await checkpointStarted;
  const newerGeneration = "New typing while generation one checkpoints.";
  await page.locator(".cm-content").fill(newerGeneration);
  await expect.poll(async () => (await readJournal(page)).length).toBe(2);
  const duringCheckpoint = await readJournal(page);
  const pendingCheckpoint = duringCheckpoint.find((entry) => entry.state === "checkpointing");
  const newerDraft = duringCheckpoint.find((entry) => entry.state === "draft");
  expect(pendingCheckpoint?.text).toBe(firstGeneration);
  expect(newerDraft?.text).toBe(newerGeneration);
  expect(newerDraft?.operationId).not.toBe(pendingCheckpoint?.operationId);

  releaseCheckpoint();
  await expect.poll(async () => (await readJournal(page)).find((entry) => entry.text === firstGeneration)?.state).toBe("checkpointed");
  await expect(page.locator(".cm-content")).toHaveText(newerGeneration);
  await expect(page.locator(".conflict")).toHaveCount(0);
  const afterCheckpoint = await readJournal(page);
  expect(afterCheckpoint.find((entry) => entry.text === firstGeneration)?.state).toBe("checkpointed");
  expect(afterCheckpoint.find((entry) => entry.text === newerGeneration)?.state).toBe("draft");

  await page.getByRole("button", { name: "Save to GitHub" }).click();
  await expect(page.locator(".topbar-status")).toContainText("GitHub への保存を確認しました。");
  const afterPublication = await readJournal(page);
  expect(afterPublication).toHaveLength(1);
  expect(afterPublication[0]?.text).toBe(newerGeneration);
  expect(afterPublication[0]?.state).toBe("draft");
});

test("browser recovery is author-scoped and foreign records remain untouched", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await signIn(page);
  await openFixtureProject(page);
  const ownerDraft = "Owner-scoped draft.";
  await page.locator(".cm-content").fill(ownerDraft);
  await expect.poll(async () => (await readJournal(page)).some((entry) => entry.text === ownerDraft)).toBe(true);

  const foreignText = "FOREIGN AUTHOR RECOVERY MUST NOT OPEN";
  await page.evaluate(({ ownerText, foreignText }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("scriptorium-recovery", 3);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("operations", "readwrite");
      const store = transaction.objectStore("operations");
      const get = store.getAll();
      get.onerror = () => reject(get.error ?? new Error("IndexedDB journal read failed"));
      get.onsuccess = () => {
        const seed = get.result.find((entry: { authorScope: string | null; text: string }) => entry.authorScope === "owner" && entry.text === ownerText);
        if (!seed) {
          reject(new Error("Owner journal seed is missing"));
          return;
        }
        const repositoryKey = JSON.stringify([seed.repository.provider, seed.repository.ownerScope, seed.repository.repositoryId, seed.repository.defaultBranch]);
        const documentPath = "manuscript/vol-1/ch-1/scene-2.md";
        const documentKey = JSON.stringify([repositoryKey, documentPath]);
        const operation = structuredClone(seed.operation);
        operation.id = crypto.randomUUID();
        operation.generation = 999;
        operation.reads = operation.reads.map((item: { path: string; revision: string | null }) => ({ ...item, path: documentPath }));
        operation.writes = operation.writes.map((item: { path: string; revision: string | null; content: string | null }) => ({ ...item, path: documentPath, content: foreignText }));
        store.put({
          ...seed,
          key: JSON.stringify([documentKey, "different-author", operation.id, operation.generation]),
          repositoryKey,
          documentKey,
          documentPath,
          sceneId: "scene-2",
          authorScope: "different-author",
          operation,
          text: foreignText,
        });
      };
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
    };
  }), { ownerText: ownerDraft, foreignText });

  await page.getByRole("button", { name: "Chapter One: Scene Two" }).click();
  await expect(page.getByRole("heading", { name: "Scene Two" })).toBeVisible();
  await expect(page.locator(".cm-content")).not.toContainText(foreignText);
  expect((await readJournal(page)).some((entry) => entry.authorScope === "different-author" && entry.text === foreignText)).toBe(true);
});

test("one malformed legacy key does not hide later recoverable drafts", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await page.addInitScript(() => {
    localStorage.setItem("scriptorium:draft:malformed", "{");
    localStorage.setItem("scriptorium:draft:recoverable", JSON.stringify({
      version: 1,
      projectId: "removed-project-id",
      sceneId: "removed-scene-id",
      text: "Legacy recovery after malformed item.",
      revision: "old-revision",
      savedAt: 1,
    }));
  });
  await signIn(page);
  await openFixtureProject(page);
  await expect(page.getByRole("heading", { name: "旧ブラウザー下書き" })).toBeVisible();
  await expect(page.getByText("シーン removed-scene-id")).toBeVisible();
});

test("external MCP proposals enter owner review before approval, then checkpoint and publish", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await signIn(page);
  await openFixtureProject(page);

  const projectResponse = await page.request.get(new URL("/api/projects", page.url()).toString());
  expect(projectResponse.ok()).toBe(true);
  const projects = await projectResponse.json() as Array<{ id: string }>;
  const projectId = projects[0]?.id;
  expect(projectId).toBeTruthy();
  const projectPath = "/api/projects/" + encodeURIComponent(projectId!);
  const observationResponse = await page.request.get(new URL(projectPath + "/observation", page.url()).toString());
  expect(observationResponse.ok()).toBe(true);
  const observation = await observationResponse.json() as {
    snapshot: { repository: { provider: "github" | "local"; repositoryId: string; defaultBranch: string; ownerScope: string; url: string }; remoteCommit: string };
  };
  const sceneResponse = await page.request.get(new URL(
    projectPath + "/scenes/scene-1?view=remote&snapshot=" + encodeURIComponent(observation.snapshot.remoteCommit),
    page.url(),
  ).toString());
  expect(sceneResponse.ok()).toBe(true);
  const sceneRead = await sceneResponse.json() as {
    snapshot: typeof observation.snapshot;
    scene: { id: string };
    document: { path: string; content: string; revision: string | null };
  };
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const proposalId = "mcp-e2e-" + suffix;
  const operationId = "mcp-e2e-op-" + suffix;
  const generatedText = "MCP text requiring owner approval.";
  const content = sceneRead.document.content + "\n" + generatedText + "\n";
  const operation = {
    id: operationId,
    generation: 1,
    repository: observation.snapshot.repository,
    baseRemoteCommit: observation.snapshot.remoteCommit,
    effect: "manuscript",
    reads: [{ path: sceneRead.document.path, revision: sceneRead.document.revision }],
    writes: [{ path: sceneRead.document.path, revision: sceneRead.document.revision, content }],
    message: "loom(scene): scene-1 MCP acceptance\n\nLoom-Manuscript: scene-1\nLoom-File: " + sceneRead.document.path + "\nLoom-Char-Count: " + generatedText.length,
  };
  const evidence = {
    id: "mcp-evidence-" + suffix,
    snapshot: observation.snapshot,
    module: "mcp",
    kind: "external-proposal",
    paths: [{ path: sceneRead.document.path, revision: sceneRead.document.revision }],
    details: { intent: "e2e author review acceptance" },
  };
  const origin = new URL(page.url()).origin;
  const proposed = await fetch(origin + projectPath + "/proposals", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + authToken },
    body: JSON.stringify({
      id: proposalId,
      snapshot: observation.snapshot,
      operations: [operation],
      evidence: [evidence],
    }),
  });
  expect(proposed.status).toBe(201);
  const storedProposal = await proposed.json() as { id: string; source: string };
  expect(storedProposal).toMatchObject({ id: proposalId, source: "mcp" });
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    return page.getByText(proposalId, { exact: false }).isVisible().catch(() => false);
  }).toBe(true);
  const journaledBeforeApproval = (await readProposalJournal(page)).find((record) => record.proposal.id === proposalId);
  expect(journaledBeforeApproval).toMatchObject({
    authorScope: "owner",
    proposal: { id: proposalId, source: "mcp", evidence: [{ id: evidence.id, module: "mcp" }] },
    status: { state: "proposed", approvedOperationIds: [], checkpoints: [] },
  });
  expect(journaledBeforeApproval?.proposal.operations[0]?.writes[0]?.content).toContain(generatedText);
  const remoteBeforeApproval = await page.request.get(new URL(projectPath + "/proposals/" + encodeURIComponent(proposalId), page.url()).toString());
  expect(remoteBeforeApproval.ok()).toBe(true);
  expect(await remoteBeforeApproval.json()).toMatchObject({ state: "proposed", approvedOperationIds: [], checkpoints: [] });

  await page.getByRole("button", { name: "承認して Checkpoint" }).click();
  const proposalCard = page.locator(".proposal-card").filter({ hasText: proposalId });
  await expect(proposalCard.getByText(/ローカル Checkpoint 済み/u)).toBeVisible();
  await expect.poll(async () => (await readJournal(page)).some((record) =>
    record.operationId === operationId && record.generation === 1 && record.state === "checkpointed" && record.authorScope === "owner",
  )).toBe(true);
  await expect(page.getByRole("button", { name: "Save to GitHub" })).toBeEnabled();
  await page.getByRole("button", { name: "Save to GitHub" }).click();
  await expect(page.locator(".topbar-status")).toContainText("GitHub への保存を確認しました。");
  await expect.poll(async () => (await readJournal(page)).some((record) => record.operationId === operationId)).toBe(false);
  expect((await readPublicationReceipts(page)).some((receipt) => receipt.state === "confirmed" &&
    receipt.acknowledged.some((item) => item.operationId === operationId && item.generation === 1))).toBe(true);

  const afterPublishObservation = await page.request.get(new URL(projectPath + "/observation", page.url()).toString());
  const afterPublish = await afterPublishObservation.json() as { snapshot: { remoteCommit: string } };
  const publishedStatusResponse = await page.request.get(new URL(projectPath + "/proposals/" + encodeURIComponent(proposalId), page.url()).toString());
  expect(publishedStatusResponse.ok()).toBe(true);
  const publishedStatus = await publishedStatusResponse.json() as { publishedOperationIds: string[] };
  expect(publishedStatus.publishedOperationIds).toContain(operationId);
  const publishedSceneResponse = await page.request.get(new URL(
    projectPath + "/scenes/scene-1?view=remote&snapshot=" + encodeURIComponent(afterPublish.snapshot.remoteCommit),
    page.url(),
  ).toString());
  const publishedScene = await publishedSceneResponse.json() as { document: { content: string } };
  expect(publishedScene.document.content).toContain(generatedText);
  expect((await readProposalJournal(page)).some((record) => record.proposal.id === proposalId)).toBe(false);
});

test("IndexedDB quota failures remain visible and block checkpointing", async ({ page }) => {
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  expect(repositoryUrl).not.toBe("");
  await page.addInitScript(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
      if (this.name === "operations") throw new DOMException("Synthetic quota limit", "QuotaExceededError");
      return originalPut.call(this, value, key);
    };
  });
  await signIn(page);
  await openFixtureProject(page);

  const canonicalBefore = await page.locator(".cm-content").textContent();
  await page.locator(".cm-content").fill("This edit cannot be journaled because the browser is full.");
  await expect(page.getByRole("alert")).toContainText("Browser storage is full");
  await expect(page.getByRole("button", { name: "Checkpoint", exact: true })).toBeDisabled();

  const unloadDialog = page.waitForEvent("dialog");
  const reloading = page.reload();
  const dialog = await unloadDialog;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.accept();
  await reloading;
  await openFixtureProject(page);
  await expect(page.locator(".cm-content")).toHaveText(canonicalBefore ?? "");
});
