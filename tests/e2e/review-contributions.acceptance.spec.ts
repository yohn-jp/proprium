import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const authToken = process.env.SCRIPTORIUM_E2E_AUTH_TOKEN ?? "";
const branch = "main";
const zukanPath = "meta/scriptorium/modules/story/zukan-suggestions.jsonl";
const scenePath = "plot/volumes/vol-review/chapters/ch-review/scenes/scene-review.yaml";

interface Project {
  id: string;
  url: string;
  branch: string;
}

interface ProposalActionResult {
  ok: boolean;
  snapshot: unknown;
  data?: Record<string, unknown>;
  proposals?: Array<{ id: string; operations: Array<{ id: string; writes: Array<{ path: string; content: string | null }> }> }>;
  error?: { code: string; message: string };
}

interface ProposalStatus {
  proposal: { id: string; operations: Array<{ id: string; writes: Array<{ path: string; content: string | null }> }> };
  state: string;
  approvedOperationIds: string[];
  checkpoints: unknown[];
  publishedOperationIds: string[];
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Scriptorium Review Acceptance",
      GIT_AUTHOR_EMAIL: "review-acceptance@example.invalid",
      GIT_COMMITTER_NAME: "Scriptorium Review Acceptance",
      GIT_COMMITTER_EMAIL: "review-acceptance@example.invalid",
    },
  }).trim();
}

async function writeFixture(seed: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const destination = join(seed, relativePath);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
}

async function createReviewProject(): Promise<{ root: string; remote: string; remoteUrl: string; initialHead: string }> {
  const root = await mkdtemp(join(tmpdir(), "scriptorium-review-contributions-"));
  const remote = join(root, "review.git");
  const seed = join(root, "seed");
  await mkdir(seed, { recursive: true });
  git(root, "init", "--bare", `--initial-branch=${branch}`, remote);
  git(seed, "init", `--initial-branch=${branch}`);

  const suggestion = {
    id: "zukan-review-queue-item",
    entityId: "char-akari",
    blockPath: "lead.0",
    proposedText: "Akari collects old maps.",
    evidence: [{ quote: "『この古地図を探している。』", sceneId: "scene-review" }],
    status: "pending",
    source: "manuscript",
    kind: "habit",
    sourceSessionId: null,
    sourceTurnRange: null,
    confidence: "high",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
  };
  await writeFixture(seed, {
    "meta/project.yaml": "id: review-contributions\ntitle: Review Contributions\n",
    "bible/characters/char-akari/profile.yaml": [
      "id: char-akari",
      "type: character",
      "name: Akari",
      "aliases: [Akari]",
      "notes:",
      "  lead: []",
      "  sections: []",
      "voicePatterns:",
      "  firstPerson: [私]",
      "",
    ].join("\n"),
    "bible/characters/char-sumi/profile.yaml": [
      "id: char-sumi",
      "type: character",
      "name: Sumi",
      "aliases: [Sumi]",
      "notes:",
      "  lead: []",
      "  sections: []",
      "voicePatterns:",
      "  firstPerson: [僕]",
      "",
    ].join("\n"),
    "plot/volumes/vol-review/volume.yaml": "id: vol-review\ntype: volume\nname: Review Volume\norder: 1\n",
    "plot/volumes/vol-review/chapters/ch-review/chapter.yaml": "id: ch-review\ntype: chapter\nname: Review Chapter\nvolume: vol-review\norder: 1\n",
    [scenePath]: [
      "id: scene-review",
      "type: scene",
      "name: Review Scene",
      "volume: vol-review",
      "chapter: ch-review",
      "order: 1",
      "appears: [char-akari, char-sumi]",
      "speakerCount: 2",
      "manuscript: manuscript/vol-review/ch-review/scene-review.md",
      "",
    ].join("\n"),
    "manuscript/vol-review/ch-review/scene-review.md": "# Review Scene\n\n『この古地図を探している。』\n",
    [zukanPath]: `${JSON.stringify(suggestion)}\n`,
  });
  git(seed, "add", "--all");
  git(seed, "commit", "-m", "Seed pending Story and Speaker review contributions");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "origin", `HEAD:refs/heads/${branch}`);
  return { root, remote, remoteUrl: remote, initialHead: git(remote, "rev-parse", `refs/heads/${branch}`) };
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/desktop/");
  await page.getByLabel("アクセストークン").fill(authToken);
  await page.getByRole("button", { name: "ログイン" }).click();
  await expect(page.getByRole("heading", { name: "作品を追加" })).toBeVisible();
}

function actionResponse(response: { url(): string; request(): { method(): string } }, actionId: string): boolean {
  const url = new URL(response.url());
  return response.request().method() === "POST" && url.pathname.endsWith(`/actions/${actionId}`);
}

async function readProposalStatus(page: Page, projectId: string, proposalId: string): Promise<ProposalStatus> {
  const origin = new URL(page.url()).origin;
  const response = await page.request.get(
    `${origin}/api/projects/${encodeURIComponent(projectId)}/proposals/${encodeURIComponent(proposalId)}`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as ProposalStatus;
}

test("full profile renders Story and Speaker review queues and turns both author decisions into unapproved Core proposals", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(process.env.SCRIPTORIUM_PROFILE !== "full", "Story and Speaker review contributions are selected by the full profile.");
  test.skip(Boolean(process.env.SCRIPTORIUM_E2E_EXTERNAL_REPOSITORY === "1" || process.env.SCRIPTORIUM_E2E_BASE_URL || process.env.SCRIPTORIUM_BASE_URL),
    "This acceptance registers and writes only to an owned temporary local bare Git fixture.");
  expect(authToken.length).toBeGreaterThanOrEqual(32);
  const fixture = await createReviewProject();
  let projectId: string | null = null;
  try {
    await signIn(page);
    await page.getByLabel("GitHub リポジトリ URL").fill(pathToFileURL(fixture.remote).href);
    await page.getByRole("button", { name: "リポジトリを登録" }).click();
    await expect(page.getByRole("heading", { name: "Review Volume" })).toBeVisible({ timeout: 30_000 });

    const origin = new URL(page.url()).origin;
    const projectsResponse = await page.request.get(`${origin}/api/projects`);
    expect(projectsResponse.ok()).toBe(true);
    const projects = await projectsResponse.json() as Project[];
    const project = projects.find((item) => item.url === fixture.remote);
    expect(project, "the app must register the owned local bare repository through its real API").toBeDefined();
    projectId = project!.id;

    const zukanListResponse = page.waitForResponse((response) => actionResponse(response, "story.zukan-suggestions.list"), { timeout: 60_000 });
    const speakerQueueResponse = page.waitForResponse((response) => actionResponse(response, "speaker.review.queue"), { timeout: 120_000 });
    await page.getByRole("button", { name: "Review Chapter: Review Scene", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review Scene" })).toBeVisible();

    const [zukanResponse, speakerResponse] = await Promise.all([zukanListResponse, speakerQueueResponse]);
    expect(zukanResponse.ok()).toBe(true);
    expect(speakerResponse.ok()).toBe(true);
    const zukanResult = await zukanResponse.json() as { ok: boolean; data?: { pendingCount?: number; suggestions?: Array<Record<string, unknown>> } };
    const speakerResult = await speakerResponse.json() as { ok: boolean; data?: { rows?: Array<{ sceneId?: string; attribution?: { text?: string; confidence?: string } }> } };
    expect(zukanResult.ok).toBe(true);
    expect(zukanResult.data?.pendingCount).toBe(1);
    expect(zukanResult.data?.suggestions?.some((item) => item.id === "zukan-review-queue-item" && item.status === "pending")).toBe(true);
    expect(speakerResult.ok).toBe(true);
    const unresolved = speakerResult.data?.rows?.filter((row) => row.sceneId === "scene-review" && row.attribution?.confidence !== "high") ?? [];
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.some((row) => row.attribution?.text === "『この古地図を探している。』")).toBe(true);

    const zukanPanel = page.locator('[data-contribution="story.zukan-review"]');
    const speakerPanel = page.locator('[data-contribution="speaker.review"]');
    await expect(zukanPanel.getByRole("heading", { name: "Zukan suggestions" })).toBeVisible();
    await expect(zukanPanel.getByText("1 pending suggestion(s)")).toBeVisible();
    await expect(zukanPanel.getByText("Akari collects old maps.")).toBeVisible();
    await expect(speakerPanel.getByRole("heading", { name: "未確定・低信頼の話者帰属" })).toBeVisible();
    await expect(speakerPanel.getByText("『この古地図を探している。』")).toBeVisible();
    await expect(speakerPanel.getByText(new RegExp(`${unresolved.length} 件。`))).toBeVisible();

    const zukanProposalResponse = page.waitForResponse((response) => actionResponse(response, "story.zukan-suggestions.reject"), { timeout: 30_000 });
    await zukanPanel.getByRole("button", { name: "Propose rejection" }).click();
    const zukanAction = await zukanProposalResponse;
    expect(zukanAction.ok()).toBe(true);
    const zukanProposalResult = await zukanAction.json() as ProposalActionResult;
    expect(zukanProposalResult.ok).toBe(true);
    expect(zukanProposalResult.data?.suggestion).toMatchObject({ id: "zukan-review-queue-item", status: "rejected" });
    const zukanProposalId = zukanProposalResult.proposals?.[0]?.id;
    expect(zukanProposalId).toBeTruthy();
    const zukanStatus = await readProposalStatus(page, project.id, zukanProposalId!);
    expect(zukanStatus.state).toBe("proposed");
    expect(zukanStatus.approvedOperationIds).toEqual([]);
    expect(zukanStatus.checkpoints).toEqual([]);
    expect(zukanStatus.proposal.operations[0]?.writes.map((write) => write.path)).toContain(zukanPath);
    await expect(zukanPanel.getByText("A review proposal is pending checkpoint; this suggestion remains pending in the selected snapshot.")).toBeVisible();

    const speakerRow = speakerPanel.locator("article").filter({ hasText: "『この古地図を探している。』" }).first();
    await speakerRow.getByLabel("話者").selectOption("char-akari");
    const speakerProposalResponse = page.waitForResponse((response) => actionResponse(response, "speaker.override"), { timeout: 30_000 });
    await speakerRow.getByRole("button", { name: "この話者をレビュー案として確定" }).click();
    const speakerAction = await speakerProposalResponse;
    expect(speakerAction.ok()).toBe(true);
    const speakerProposalResult = await speakerAction.json() as ProposalActionResult;
    expect(speakerProposalResult.ok).toBe(true);
    const speakerProposalId = speakerProposalResult.proposals?.[0]?.id;
    expect(speakerProposalId).toBeTruthy();
    const speakerStatus = await readProposalStatus(page, project.id, speakerProposalId!);
    expect(speakerStatus.state).toBe("proposed");
    expect(speakerStatus.approvedOperationIds).toEqual([]);
    expect(speakerStatus.checkpoints).toEqual([]);
    expect(speakerStatus.proposal.operations[0]?.writes.map((write) => write.path)).toEqual(expect.arrayContaining([
      scenePath,
      "meta/scriptorium/modules/speaker/corrections.jsonl",
    ]));
    await expect(speakerPanel.getByText("確定案をレビューキューに作成しました。承認後に正本へ反映されます。")).toBeVisible();

    expect(git(fixture.remote, "rev-parse", `refs/heads/${branch}`)).toBe(fixture.initialHead);
    const remoteSuggestion = JSON.parse(git(fixture.remote, "show", `refs/heads/${branch}:${zukanPath}`)) as { status: string };
    expect(remoteSuggestion.status).toBe("pending");
    const remoteScene = git(fixture.remote, "show", `refs/heads/${branch}:${scenePath}`);
    expect(remoteScene).not.toMatch(/^speakerOverrides:/mu);
    expect(() => git(fixture.remote, "cat-file", "-e", `refs/heads/${branch}:meta/scriptorium/modules/speaker/corrections.jsonl`)).toThrow();
  } finally {
    if (projectId) {
      const origin = new URL(page.url()).origin;
      await page.request.delete(`${origin}/api/projects/${encodeURIComponent(projectId)}`, {
        headers: { Origin: origin },
      }).catch(() => undefined);
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});
