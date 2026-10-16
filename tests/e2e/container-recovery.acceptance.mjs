import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const repositoryUrl = process.env.SCRIPTORIUM_E2E_REPOSITORY_URL ?? "";
const chromiumPath = process.env.SCRIPTORIUM_E2E_CHROMIUM;
const keepFailureArtifacts = process.env.SCRIPTORIUM_KEEP_FAILURE_ARTIFACTS === "1";
const appToken = randomBytes(32).toString("hex");
const runtimeSourcePaths = [
  "Dockerfile", "LICENSE", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json",
  "packages", "modules", "app", "profiles", "scripts",
];
const sceneOnePath = "manuscript/vol-1/ch-1/scene-1.md";
const sceneTwoPath = "manuscript/vol-1/ch-1/scene-2.md";
const fixturePaths = [
  "plot/volumes/vol-1/volume.yaml",
  "plot/volumes/vol-1/chapters/ch-1/chapter.yaml",
  "plot/volumes/vol-1/chapters/ch-1/scenes/scene-1.yaml",
  sceneOnePath,
  "plot/volumes/vol-1/chapters/ch-1/scenes/scene-2.yaml",
  sceneTwoPath,
];
const fixtureContents = new Map([
  ["plot/volumes/vol-1/volume.yaml", "id: vol-1\ntitle: Volume One\n"],
  ["plot/volumes/vol-1/chapters/ch-1/chapter.yaml", "id: ch-1\nvolume: vol-1\ntitle: Chapter One\n"],
  ["plot/volumes/vol-1/chapters/ch-1/scenes/scene-1.yaml", "id: scene-1\ntitle: Scene One\nvolume: vol-1\nchapter: ch-1\nmanuscript: manuscript/vol-1/ch-1/scene-1.md\n"],
  [sceneOnePath, "# Scene One\n\nThe first line of the story.\n"],
  ["plot/volumes/vol-1/chapters/ch-1/scenes/scene-2.yaml", "id: scene-2\ntitle: Scene Two\nvolume: vol-1\nchapter: ch-1\nmanuscript: manuscript/vol-1/ch-1/scene-2.md\n"],
  [sceneTwoPath, "# Scene Two\n\nThe second line of the story.\n"],
]);

function requiredRepository() {
  if (!repositoryUrl) throw new Error("Set SCRIPTORIUM_E2E_REPOSITORY_URL to the dedicated private synthetic GitHub fixture.");
  let parsed;
  try { parsed = new URL(repositoryUrl); }
  catch { throw new Error("SCRIPTORIUM_E2E_REPOSITORY_URL must be an HTTPS GitHub repository URL."); }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    throw new Error("SCRIPTORIUM_E2E_REPOSITORY_URL must be an HTTPS GitHub repository URL.");
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts[1].replace(/\.git$/u, "") === "scriptorium-epic7-acceptance-20261017-db517d") {
    throw new Error("Use a dedicated repository for this P13 run; the P07 acceptance fixture is not permitted.");
  }
  return parsed;
}

function commandAvailable(name) {
  return spawnSync(name, ["--version"], { stdio: "ignore" }).status === 0;
}

function requiredEngine() {
  const configured = process.env.OCI_ENGINE;
  if (configured) {
    if (!commandAvailable(configured)) throw new Error(`OCI_ENGINE is unavailable: ${configured}`);
    return configured;
  }
  if (commandAvailable("podman")) return "podman";
  if (commandAvailable("docker")) return "docker";
  throw new Error("Install Docker or run this command inside nix shell nixpkgs#podman.");
}

function run(engine, args, options = {}) {
  const result = spawnSync(engine, args, {
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${engine} ${args[0] ?? "command"} failed with exit status ${result.status ?? "unknown"}.`);
  }
  return options.capture ? String(result.stdout).trim() : "";
}

function gitOutput(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function assertImageInputsMatchHead() {
  const sourceHead = gitOutput("rev-parse", "HEAD");
  const result = spawnSync("git", ["diff", "--quiet", "HEAD", "--", ...runtimeSourcePaths], { stdio: "ignore" });
  if (result.status !== 0) throw new Error("Build-input changes are present; freeze and inspect the runtime tree before this acceptance run.");
  const untracked = gitOutput("ls-files", "--others", "--exclude-standard").split(/\r?\n/u).filter(Boolean);
  if (untracked.some((path) => runtimeSourcePaths.some((root) => path === root || path.startsWith(`${root}/`)))) {
    throw new Error("An untracked file is present in the OCI build inputs; freeze and inspect the runtime tree first.");
  }
  return sourceHead;
}

function githubToken() {
  const configured = process.env.SCRIPTORIUM_GITHUB_TOKEN?.trim();
  const token = configured || execFileSync("gh", ["auth", "token", "--hostname", "github.com"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!token) throw new Error("Set SCRIPTORIUM_GITHUB_TOKEN or authenticate gh; the token is held in memory and never printed.");
  return token;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

async function waitFor(description, read, accept, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    try {
      latest = await read();
      if (accept(latest)) return latest;
    } catch { /* The server or browser may still be starting. */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function collectBrowserDiagnostics(page, secrets) {
  const requests = [];
  const pending = new Map();
  const consoleErrors = [];
  const safeText = (value) => secrets.reduce((text, secret) => secret ? text.replaceAll(secret, "[redacted]") : text, String(value)).slice(0, 500);
  const record = (request) => {
    let url;
    try { url = new URL(request.url()); }
    catch { return null; }
    if (!url.pathname.startsWith("/api/")) return null;
    const item = {
      method: request.method(),
      path: url.pathname.replace(/^\/api\/projects\/[^/]+/u, "/api/projects/[id]"),
      startedAt: new Date().toISOString(),
      startedMs: Date.now(),
    };
    requests.push(item);
    if (requests.length > 200) requests.shift();
    pending.set(request, item);
    return item;
  };
  page.on("request", record);
  page.on("response", (response) => {
    const item = pending.get(response.request());
    if (!item) return;
    item.status = response.status();
    item.durationMs = Date.now() - item.startedMs;
    pending.delete(response.request());
    delete item.startedMs;
  });
  page.on("requestfailed", (request) => {
    const item = pending.get(request);
    if (!item) return;
    item.failure = safeText(request.failure()?.errorText ?? "request failed");
    item.durationMs = Date.now() - item.startedMs;
    pending.delete(request);
    delete item.startedMs;
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    consoleErrors.push(safeText(message.text()));
    if (consoleErrors.length > 30) consoleErrors.shift();
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(safeText(error.message));
    if (consoleErrors.length > 30) consoleErrors.shift();
  });
  return () => ({
    requests: requests.slice(-80).map(({ startedMs, ...request }) => request),
    pending: [...pending.values()].map(({ startedMs, ...request }) => ({ ...request, elapsedMs: Date.now() - startedMs })),
    consoleErrors: [...consoleErrors],
  });
}

async function browserUiState(page, expectedAuthorText = "") {
  return page.evaluate((expectedText) => {
    const editor = document.querySelector(".cm-content");
    const main = document.querySelector('main[aria-label="執筆"]');
    const selected = main?.closest(".workspace-grid")?.querySelector("button.scene-button[aria-current='true']");
    const selectedSceneLabel = selected?.textContent?.trim() ?? null;
    return {
      path: window.location.pathname,
      visibleHeadings: [...(main?.querySelectorAll("h1, h2, h3") ?? [])].map((heading) => heading.textContent?.trim()).filter(Boolean),
      selectedSceneLabel,
      selectedFixtureSceneId: selectedSceneLabel?.endsWith("Scene One") ? "scene-1" : selectedSceneLabel?.endsWith("Scene Two") ? "scene-2" : null,
      loadingScene: Boolean(main?.querySelector(".loading")),
      editorVisible: Boolean(editor && editor.getClientRects().length > 0),
      editorCharacterCount: editor?.textContent?.length ?? null,
      editorMatchesAuthorInput: Boolean(expectedText && editor?.textContent === expectedText),
      conflictVisible: Boolean(main?.querySelector(".conflict")),
    };
  }, expectedAuthorText);
}

async function startContainer(engine, options) {
  const env = {
    ...process.env,
    SCRIPTORIUM_AUTH_TOKEN: options.authToken,
    SCRIPTORIUM_GITHUB_TOKEN: options.githubToken,
  };
  run(engine, [
    "run", "--detach", "--name", options.name, "--stop-timeout", "30",
    "--publish", `127.0.0.1:${options.port}:3000`,
    "--volume", `${options.volume}:/data`,
    "--env", "SCRIPTORIUM_AUTH_TOKEN", "--env", "SCRIPTORIUM_GITHUB_TOKEN",
    "--env", "SCRIPTORIUM_DATA_DIR=/data", options.image,
  ], { env, capture: true });
  const baseUrl = `http://127.0.0.1:${options.port}`;
  await waitFor("the real Core image health endpoint", async () => {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      return response.ok;
    } catch { return false; }
  }, (healthy) => healthy, 120_000);
  return baseUrl;
}

function parseRepository(url) {
  const [owner, rawName] = url.pathname.split("/").filter(Boolean);
  assert.ok(owner && rawName);
  return { owner, name: rawName.replace(/\.git$/u, "") };
}

function createGithubApi(token, owner, name) {
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  async function request(method, path, body = undefined, allowMissing = false) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allowMissing && response.status === 404) return { status: response.status, value: undefined };
    const text = await response.text();
    let value;
    try { value = text ? JSON.parse(text) : undefined; }
    catch { throw new Error(`GitHub API ${method} returned a non-JSON response (${response.status}).`); }
    if (!response.ok) throw new Error(`GitHub API ${method} ${path.split("?")[0]} returned ${response.status}.`);
    return { status: response.status, value };
  }
  return {
    async metadata() { return (await request("GET", "")).value; },
    async branchHead(branch) {
      return (await request("GET", `/branches/${encodeURIComponent(branch)}`)).value.commit.sha;
    },
    async tree(head) {
      return (await request("GET", `/git/trees/${encodeURIComponent(head)}?recursive=1`)).value;
    },
    async content(path, branch) {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const result = await request("GET", `/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`, undefined, true);
      if (result.status === 404) return null;
      assert.equal(result.value.type, "file", `Expected a file at ${path}.`);
      return { sha: result.value.sha, content: Buffer.from(String(result.value.content).replace(/\s/gu, ""), "base64").toString("utf8") };
    },
    async updateContent(path, branch, content, message) {
      const previous = await this.content(path, branch);
      assert.ok(previous, `Synthetic fixture file is missing: ${path}.`);
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const result = await request("PUT", `/contents/${encodedPath}`, {
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        sha: previous.sha,
        branch,
      });
      return result.value.commit.sha;
    },
    async commitsForPath(path, branch) {
      const query = new URLSearchParams({ path, sha: branch, per_page: "100" });
      return (await request("GET", `/commits?${query.toString()}`)).value;
    },
  };
}

async function assertSyntheticFixture(github, branch) {
  const metadata = await github.metadata();
  assert.equal(metadata.private, true, "P13 requires a private synthetic GitHub repository.");
  assert.equal(metadata.default_branch, branch, "The acceptance target must be the repository default branch.");
  const head = await github.branchHead(branch);
  const tree = await github.tree(head);
  assert.equal(tree.truncated, false, "The synthetic fixture tree must be complete.");
  assert.deepEqual([...tree.tree].filter((entry) => entry.type === "blob").map((entry) => entry.path).sort(), [...fixturePaths].sort(), "The disposable fixture must contain only the six generic e2e files.");
  for (const [path, expected] of fixtureContents) {
    const actual = await github.content(path, branch);
    assert.ok(actual, `Synthetic fixture file is missing: ${path}.`);
    assert.equal(actual.content, expected, `Unexpected non-fixture content at ${path}.`);
  }
  return head;
}

async function readJournal(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolvePromise, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolvePromise(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("operations", "readonly");
      return await new Promise((resolvePromise, reject) => {
        let entries;
        transaction.oncomplete = () => resolvePromise(entries.map((entry) => ({
          key: entry.key,
          repositoryKey: entry.repositoryKey,
          documentKey: entry.documentKey,
          sceneId: entry.sceneId,
          snapshot: entry.snapshot,
          updatedAt: entry.updatedAt,
          documentPath: entry.documentPath,
          state: entry.state,
          operationId: entry.operation.id,
          generation: entry.operation.generation,
          authorScope: entry.authorScope ?? null,
          entryKeys: Object.keys(entry).sort(),
          repositoryIdentity: {
            provider: entry.repository.provider,
            ownerScope: entry.repository.ownerScope,
            repositoryId: entry.repository.repositoryId,
            defaultBranch: entry.repository.defaultBranch,
          },
          proposalId: entry.proposalId ?? null,
          checkpointReceipt: entry.checkpoint ? {
            operationId: entry.checkpoint.operationId,
            generation: entry.checkpoint.generation,
            localCommit: entry.checkpoint.localCommit,
            remoteBase: entry.checkpoint.remoteBase,
          } : null,
          text: entry.text,
          operationContent: entry.operation.writes.find((write) => write.path === entry.documentPath)?.content ?? null,
          operationWrites: entry.operation.writes.map((write) => ({ path: write.path, contentLength: typeof write.content === "string" ? write.content.length : null })),
          localCommit: entry.checkpoint?.localCommit ?? null,
        })));
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB journal transaction failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB journal transaction was aborted"));
        const request = transaction.objectStore("operations").getAll();
        request.onsuccess = () => { entries = request.result; };
        request.onerror = () => reject(request.error ?? new Error("IndexedDB journal read failed"));
      });
    } finally {
      database.close();
    }
  });
}

async function readJournalEntry(page, key) {
  return page.evaluate(async (entryKey) => {
    const database = await new Promise((resolvePromise, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolvePromise(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("operations", "readonly");
      return await new Promise((resolvePromise, reject) => {
        let entry;
        transaction.oncomplete = () => resolvePromise(entry ? {
          key: entry.key,
          repositoryKey: entry.repositoryKey,
          documentKey: entry.documentKey,
          sceneId: entry.sceneId,
          snapshot: entry.snapshot,
          updatedAt: entry.updatedAt,
          documentPath: entry.documentPath,
          state: entry.state,
          operationId: entry.operation.id,
          generation: entry.operation.generation,
          authorScope: entry.authorScope ?? null,
          entryKeys: Object.keys(entry).sort(),
          repositoryIdentity: {
            provider: entry.repository.provider,
            ownerScope: entry.repository.ownerScope,
            repositoryId: entry.repository.repositoryId,
            defaultBranch: entry.repository.defaultBranch,
          },
          proposalId: entry.proposalId ?? null,
          checkpointReceipt: entry.checkpoint ? {
            operationId: entry.checkpoint.operationId,
            generation: entry.checkpoint.generation,
            localCommit: entry.checkpoint.localCommit,
            remoteBase: entry.checkpoint.remoteBase,
          } : null,
          text: entry.text,
          operationContent: entry.operation.writes.find((write) => write.path === entry.documentPath)?.content ?? null,
          operationWrites: entry.operation.writes.map((write) => ({ path: write.path, contentLength: typeof write.content === "string" ? write.content.length : null })),
          localCommit: entry.checkpoint?.localCommit ?? null,
        } : null);
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB journal transaction failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB journal transaction was aborted"));
        const request = transaction.objectStore("operations").get(entryKey);
        request.onsuccess = () => { entry = request.result; };
        request.onerror = () => reject(request.error ?? new Error("IndexedDB journal read failed"));
      });
    } finally {
      database.close();
    }
  }, key);
}

async function readDocumentJournal(page, documentKey, authorScope, expectedText) {
  return page.evaluate(async ({ key, scope, text }) => {
    const database = await new Promise((resolvePromise, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolvePromise(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("operations", "readonly");
      return await new Promise((resolvePromise, reject) => {
        let entries;
        transaction.oncomplete = () => {
          const rows = entries
            .filter((entry) => entry.version === 1 && entry.documentKey === key && entry.authorScope === scope)
            .sort((left, right) => left.operation.generation - right.operation.generation || left.updatedAt - right.updatedAt)
            .map((entry) => ({
              key: entry.key,
              operationId: entry.operation.id,
              generation: entry.operation.generation,
              state: entry.state,
              updatedAt: entry.updatedAt,
              authorScope: entry.authorScope,
              documentPath: entry.documentPath,
              repositoryKey: entry.repositoryKey,
              textLength: typeof entry.text === "string" ? entry.text.length : null,
              textMatchesExpectedAuthorInput: entry.text === text,
              operationContentLength: typeof entry.operation.writes.find((write) => write.path === entry.documentPath)?.content === "string"
                ? entry.operation.writes.find((write) => write.path === entry.documentPath).content.length
                : null,
              operationContentMatchesExpectedAuthorInput: entry.operation.writes.find((write) => write.path === entry.documentPath)?.content === text,
              entryKeys: Object.keys(entry).sort(),
            }));
          const selected = rows.at(-1);
          resolvePromise({ rows, selectedKey: selected?.key ?? null, selectedOperationId: selected?.operationId ?? null, selectedGeneration: selected?.generation ?? null, selectedState: selected?.state ?? null });
        };
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB journal transaction failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB journal transaction was aborted"));
        const request = transaction.objectStore("operations").index("documentKey").getAll(key);
        request.onsuccess = () => { entries = request.result; };
        request.onerror = () => reject(request.error ?? new Error("IndexedDB document journal read failed"));
      });
    } finally {
      database.close();
    }
  }, { key: documentKey, scope: authorScope, text: expectedText });
}

async function readPublicationReceipts(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolvePromise, reject) => {
      const request = indexedDB.open("scriptorium-recovery", 3);
      request.onsuccess = () => resolvePromise(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
    try {
      const transaction = database.transaction("publicationReceipts", "readonly");
      return await new Promise((resolvePromise, reject) => {
        const request = transaction.objectStore("publicationReceipts").getAll();
        request.onsuccess = () => resolvePromise(request.result.map((record) => ({
          batchId: record.receipt.batchId,
          state: record.receipt.state,
          acknowledged: record.receipt.acknowledged.map((item) => ({ operationId: item.operationId, generation: item.generation })),
        })));
        request.onerror = () => reject(request.error ?? new Error("IndexedDB publication receipt read failed"));
      });
    } finally {
      database.close();
    }
  });
}

async function signIn(page) {
  if (await page.getByLabel("アクセストークン").isVisible().catch(() => false)) {
    await page.getByLabel("アクセストークン").fill(appToken);
    await page.getByRole("button", { name: "ログイン" }).click();
  }
  await page.getByRole("heading", { name: "作品を追加" }).waitFor({ state: "visible", timeout: 30_000 });
}

async function openProject(page, baseUrl) {
  await signIn(page);
  const label = (() => {
    const parsed = new URL(repositoryUrl);
    return `${parsed.hostname}${parsed.pathname.replace(/\.git$/u, "").replace(/\/$/u, "")}`;
  })();
  const existing = page.getByRole("button", { name: label, exact: true });
  if (await existing.isVisible().catch(() => false)) {
    await existing.click();
  } else {
    await page.getByLabel("GitHub リポジトリ URL").fill(repositoryUrl.replace(/\.git$/u, ""));
    const branchInput = page.getByLabel("ブランチ（任意）");
    if (await branchInput.count()) await branchInput.fill("");
    await page.getByRole("button", { name: "リポジトリを登録" }).click();
  }
  await page.getByRole("heading", { name: "Volume One" }).waitFor({ state: "visible", timeout: 90_000 });
  await page.getByRole("button", { name: "Chapter One: Scene One" }).click();
  await page.getByRole("heading", { name: "Scene One" }).waitFor({ state: "visible" });
  await page.locator(".cm-content").waitFor({ state: "visible" });
  assert.equal(new URL(page.url()).origin, new URL(baseUrl).origin);
}

async function projectId(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/projects");
    if (!response.ok) throw new Error("The production project list was unavailable.");
    const projects = await response.json();
    if (!projects[0]) throw new Error("The production project list did not contain the registered fixture.");
    return projects[0].id;
  });
}

async function remoteCommit(page, id) {
  return page.evaluate(async (projectIdValue) => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectIdValue)}/observation`);
    if (!response.ok) throw new Error("The production observation endpoint was unavailable.");
    const result = await response.json();
    return result.snapshot.remoteCommit;
  }, id);
}

async function reportConflictDiagnostics(page, diagnostics, project, expectedHead, authorDraftEntry, expectedAuthorText) {
  const [coreObservedHead, ui, entries, documentJournal] = await Promise.all([
    remoteCommit(page, project).catch((error) => `unavailable: ${String(error.message).slice(0, 300)}`),
    browserUiState(page, expectedAuthorText).catch((error) => ({ unavailable: String(error.message).slice(0, 300) })),
    readJournal(page).catch((error) => [{ error: String(error.message).slice(0, 300) }]),
    readDocumentJournal(page, authorDraftEntry.documentKey, authorDraftEntry.authorScope, expectedAuthorText).catch((error) => ({ unavailable: String(error.message).slice(0, 300) })),
  ]);
  console.error(JSON.stringify({
    phase: "same-file conflict browser diagnostic",
    expectedRemoteHead: expectedHead,
    coreObservedHead,
    ui,
    journalStore: "scriptorium-recovery.operations",
    expectedOperationId: authorDraftEntry.operationId,
    expectedGeneration: authorDraftEntry.generation,
    expectedAuthorTextLength: expectedAuthorText.length,
    expectedAuthorEntryKey: authorDraftEntry.key,
    documentJournal,
    matchingJournalEntries: entries.filter((entry) => entry.operationId === authorDraftEntry.operationId && entry.generation === authorDraftEntry.generation).map((entry) => ({
      operationId: entry.operationId,
      generation: entry.generation,
      state: entry.state,
      documentPath: entry.documentPath,
      authorScope: entry.authorScope,
      repositoryIdentity: entry.repositoryIdentity,
      entryKeys: entry.entryKeys,
      proposalId: entry.proposalId,
      checkpointReceipt: entry.checkpointReceipt,
      matchesExpectedAuthorText: entry.text === expectedAuthorText,
      authorTextLength: typeof entry.text === "string" ? entry.text.length : null,
      operationContentMatchesAuthor: entry.operationContent === expectedAuthorText,
      operationContentLength: typeof entry.operationContent === "string" ? entry.operationContent.length : null,
      operationWrites: entry.operationWrites,
    })),
    browserNetworkAndConsole: diagnostics(),
  }));
}

async function dispatchRemoteRefresh(page) {
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

function operationPath(operationId) {
  return `meta/scriptorium/operations/v1/${operationId}.json`;
}

async function main() {
  const parsedUrl = requiredRepository();
  const { owner, name } = parseRepository(parsedUrl);
  const branchOverride = process.env.SCRIPTORIUM_E2E_REPOSITORY_BRANCH;
  const githubCredential = githubToken();
  const github = createGithubApi(githubCredential, owner, name);
  const repository = await github.metadata();
  const branch = branchOverride || repository.default_branch;
  if (branch !== repository.default_branch) throw new Error("The P13 recovery check writes only to the synthetic repository's default branch.");
  const initialHead = await assertSyntheticFixture(github, branch);
  const diagnosticSecrets = [
    appToken,
    githubCredential,
    repositoryUrl,
    `${owner}/${name}`,
    `https://github.com/${owner}/${name}`,
    `https://api.github.com/repos/${owner}/${name}`,
  ];
  const sourceHead = assertImageInputsMatchHead();
  const engine = requiredEngine();
  const tempRoot = await mkdtemp(join(tmpdir(), "scriptorium-p13-recovery-"));
  const profileDir = join(tempRoot, "browser-profile");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const suffix = randomBytes(5).toString("hex");
  const image = `localhost/scriptorium:p13-recovery-${sourceHead.slice(0, 8)}-${suffix}`;
  const container = `scriptorium-p13-recovery-${suffix}`;
  const volume = `scriptorium-p13-recovery-${suffix}`;
  let volumeCreated = false;
  let context;
  let diagnostics;
  let failureArtifactPath;
  let profileCookiesCleared = false;
  const chromiumOptions = { headless: true, ...(chromiumPath ? { executablePath: chromiumPath } : {}) };
  let result;

  try {
    run(engine, [
      "build", ...(engine.split("/").at(-1) === "podman" ? ["--format", "oci"] : []), "--pull",
      "--build-arg", "PROFILE=core", "--tag", image, ".",
    ]);
    const inspect = run(engine, ["image", "inspect", "--format", "{{.Id}}\t{{.Digest}}\t{{.Os}}/{{.Architecture}}", image], { capture: true });
    const [imageId, manifestDigest, platform] = inspect.split("\t");
    assert.ok(imageId && manifestDigest && platform, "The locally built OCI image must report an immutable ID and manifest digest.");

    run(engine, ["volume", "create", volume], { capture: true });
    volumeCreated = true;
    await startContainer(engine, { name: container, image, volume, port, authToken: appToken, githubToken: githubCredential });

    context = await chromium.launchPersistentContext(profileDir, chromiumOptions);
    const page = context.pages()[0] ?? await context.newPage();
    diagnostics = collectBrowserDiagnostics(page, diagnosticSecrets);
    page.on("dialog", (dialog) => {
      if (dialog.type() === "beforeunload") void dialog.accept();
      else void dialog.dismiss();
    });
    await page.goto(baseUrl);
    await openProject(page, baseUrl);

    const authorText = `P13 browser recovery ${randomUUID()}`;
    diagnosticSecrets.push(authorText);
    const editor = page.locator(".cm-content");
    await editor.fill(authorText);
    const draft = await waitFor("the IndexedDB Draft entry", () => readJournal(page), (entries) => entries.some((entry) => entry.documentPath === sceneOnePath && entry.text === authorText && entry.state === "draft"));
    const draftEntry = draft.find((entry) => entry.documentPath === sceneOnePath && entry.text === authorText);
    assert.ok(draftEntry);
    const operationId = draftEntry.operationId;
    assert.ok(draft.find((entry) => entry.operationId === operationId)?.operationContent?.includes(authorText));
    await page.getByRole("button", { name: "Checkpoint", exact: true }).click();
    await waitFor("the local checkpoint journal state", () => readJournal(page), (entries) => entries.some((entry) => entry.operationId === operationId && entry.state === "checkpointed" && entry.localCommit));
    const checkpointBeforeRestart = (await readJournal(page)).find((entry) => entry.operationId === operationId);
    assert.ok(checkpointBeforeRestart);
    assert.equal(await github.branchHead(branch), initialHead, "A local checkpoint must not publish to GitHub.");
    assert.equal(await github.content(operationPath(operationId), branch), null, "The operation record must remain local before explicit publication.");
    await context.close();
    context = undefined;

    run(engine, ["stop", "--time", "30", container], { capture: true });
    run(engine, ["rm", "--force", container], { capture: true });
    run(engine, ["volume", "rm", volume], { capture: true });
    volumeCreated = false;
    run(engine, ["volume", "create", volume], { capture: true });
    volumeCreated = true;
    await startContainer(engine, { name: container, image, volume, port, authToken: appToken, githubToken: githubCredential });

    context = await chromium.launchPersistentContext(profileDir, chromiumOptions);
    const recoveredPage = context.pages()[0] ?? await context.newPage();
    diagnostics = collectBrowserDiagnostics(recoveredPage, diagnosticSecrets);
    recoveredPage.on("dialog", (dialog) => {
      if (dialog.type() === "beforeunload") void dialog.accept();
      else void dialog.dismiss();
    });
    await recoveredPage.goto(baseUrl);
    await signIn(recoveredPage);
    const persistedDraft = await waitFor("the checkpointed entry in the reopened browser profile", () => readJournal(recoveredPage), (entries) => entries.some((entry) => entry.operationId === operationId && entry.state === "checkpointed" && entry.text === authorText));
    assert.equal(persistedDraft.filter((entry) => entry.operationId === operationId).length, 1, "The browser journal must contain one copy of the operation.");
    assert.equal((await recoveredPage.getByText("登録された作品はありません").isVisible().catch(() => false)), true, "The erased container data root must not retain the project registry.");
    await openProject(recoveredPage, baseUrl);
    await waitFor("Core replay of the complete checkpointed operation", () => readJournal(recoveredPage), (entries) => entries.some((entry) => entry.operationId === operationId && entry.state === "checkpointed" && entry.text === authorText && entry.operationContent?.includes(authorText)));
    const replayed = (await readJournal(recoveredPage)).find((entry) => entry.operationId === operationId);
    assert.ok(replayed);
    assert.equal(replayed.operationId, checkpointBeforeRestart.operationId);
    assert.equal(await github.branchHead(branch), initialHead, "Recovery must stay a local checkpoint until the author publishes.");

    const recoveredEditor = recoveredPage.locator(".cm-content");
    await expect(recoveredEditor).toHaveText(authorText);
    await recoveredPage.getByRole("button", { name: "Save to GitHub" }).click();
    await waitFor("a durable confirmed receipt acknowledging the recovered operation", () => readPublicationReceipts(recoveredPage), (receipts) => receipts.some((receipt) => receipt.state === "confirmed" && receipt.acknowledged.some((item) => item.operationId === operationId && item.generation === draftEntry.generation)), 120_000);
    const publishedHead = await waitFor("the explicit GitHub publication", () => github.branchHead(branch), (head) => head !== initialHead, 120_000);
    const operationRecord = await github.content(operationPath(operationId), branch);
    assert.ok(operationRecord, "The confirmed remote tree must contain the recovered operation record.");
    const decodedOperation = JSON.parse(operationRecord.content);
    assert.equal(decodedOperation.operation.id, operationId);
    assert.equal(decodedOperation.operation.writes.find((write) => write.path === sceneOnePath)?.content?.includes(authorText), true);
    assert.equal((await github.commitsForPath(operationPath(operationId), branch)).length, 1, "The same operation ID must have exactly one remote commit.");
    await waitFor("acknowledgement cleanup in IndexedDB", () => readJournal(recoveredPage), (entries) => !entries.some((entry) => entry.operationId === operationId));

    const project = await projectId(recoveredPage);
    await waitFor("Core observation of the confirmed publication", () => remoteCommit(recoveredPage, project), (head) => head === publishedHead, 120_000);
    const initialSceneTwo = await github.content(sceneTwoPath, branch);
    assert.ok(initialSceneTwo);
    const sceneTwoInitial = initialSceneTwo.content;
    const remoteOne = `${sceneTwoInitial.trimEnd()}\n\nExternal synthetic update one.\n`;
    const externalHeadOne = await github.updateContent(sceneTwoPath, branch, remoteOne, "acceptance: external update to unedited synthetic scene");
    await dispatchRemoteRefresh(recoveredPage);
    await waitFor("the production remote observation to follow GitHub", () => remoteCommit(recoveredPage, project), (head) => head === externalHeadOne, 120_000);
    await recoveredPage.getByRole("button", { name: "Chapter One: Scene Two" }).click();
    await recoveredPage.getByRole("heading", { name: "Scene Two" }).waitFor({ state: "visible", timeout: 90_000 });
    await expect(recoveredPage.locator(".cm-content")).toContainText("External synthetic update one.", { timeout: 90_000 });

    const conflictAuthorText = `P13 author input protected ${randomUUID()}`;
    diagnosticSecrets.push(conflictAuthorText);
    await recoveredPage.locator(".cm-content").fill(conflictAuthorText);
    const authorDraft = await waitFor("the same-file author Draft", () => readJournal(recoveredPage), (entries) => entries.some((entry) => entry.documentPath === sceneTwoPath && entry.text === conflictAuthorText && entry.state === "draft"));
    const authorDraftEntry = authorDraft.find((entry) => entry.documentPath === sceneTwoPath && entry.text === conflictAuthorText);
    assert.ok(authorDraftEntry);
    assert.ok(authorDraftEntry.key, "The author operation must have a stable IndexedDB primary key.");
    assert.ok(authorDraftEntry.operationContent?.includes(conflictAuthorText), "The Draft operation must store the author's exact recoverable write before checkpointing.");
    const conflictOperationId = authorDraftEntry.operationId;
    await recoveredPage.getByRole("button", { name: "Checkpoint", exact: true }).click();
    await waitFor("the same-file local checkpoint", () => readJournal(recoveredPage), (entries) => entries.some((entry) => entry.operationId === conflictOperationId && entry.state === "checkpointed"));
    const remoteTwo = `${remoteOne.trimEnd()}\n\nExternal synthetic conflicting update.\n`;
    const externalHeadTwo = await github.updateContent(sceneTwoPath, branch, remoteTwo, "acceptance: external same-file conflict");
    await dispatchRemoteRefresh(recoveredPage);
    await waitFor("the production conflict observation", () => remoteCommit(recoveredPage, project), (head) => head === externalHeadTwo, 120_000);
    let conflictEntry;
    let conflictDocumentJournal;
    try {
      conflictEntry = await waitFor("the exact author-scoped conflicted manuscript journal operation", () => readJournalEntry(recoveredPage, authorDraftEntry.key), (entry) => entry?.key === authorDraftEntry.key && entry.operationId === conflictOperationId && entry.generation === authorDraftEntry.generation && entry.authorScope === authorDraftEntry.authorScope && entry.documentPath === sceneTwoPath && entry.state === "conflict", 120_000);
      assert.equal(conflictEntry.text, conflictAuthorText, "The conflicted author journal entry must retain the exact editor text.");
      assert.ok(conflictEntry.operationContent?.includes(conflictAuthorText), "The conflicted journal operation must retain the author's exact recoverable write.");
      await recoveredPage.getByRole("heading", { name: "Scene Two" }).waitFor({ state: "visible", timeout: 120_000 });
      await expect(recoveredPage.locator(".cm-content")).toHaveText(conflictAuthorText, { timeout: 120_000 });
      await expect(recoveredPage.locator(".conflict")).toBeVisible({ timeout: 120_000 });
      conflictDocumentJournal = await readDocumentJournal(recoveredPage, authorDraftEntry.documentKey, authorDraftEntry.authorScope, conflictAuthorText);
      const selectedDocumentEntry = conflictDocumentJournal.rows.at(-1);
      assert.ok(selectedDocumentEntry, "Journal.getDocument must return the author-scoped manuscript entry.");
      assert.equal(selectedDocumentEntry.textMatchesExpectedAuthorInput, true, "The entry selected last by Journal.getDocument must retain the exact author input.");
      assert.ok(selectedDocumentEntry.operationContentMatchesExpectedAuthorInput, "The selected entry's recoverable operation must retain the exact author input.");
    } catch (error) {
      await reportConflictDiagnostics(recoveredPage, diagnostics, project, externalHeadTwo, authorDraftEntry, conflictAuthorText);
      throw error;
    }

    const refused = await recoveredPage.evaluate(async ({ projectIdValue, batchId }) => {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectIdValue)}/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchId }),
      });
      return { status: response.status, receipt: await response.json() };
    }, { projectIdValue: project, batchId: `p13-conflict-${randomUUID()}` });
    assert.equal(refused.status, 200);
    assert.equal(refused.receipt.state, "conflict", "Core must reject publication after a same-file remote update.");
    const stillRemote = await github.content(sceneTwoPath, branch);
    assert.ok(stillRemote?.content.includes("External synthetic conflicting update."));
    assert.equal(stillRemote?.content.includes(conflictAuthorText), false, "A rejected publication must not save the author's conflicting input.");
    assert.equal(await github.content(operationPath(conflictOperationId), branch), null, "A rejected publication must not add the conflicting operation record to GitHub.");
    await expect(recoveredPage.locator(".cm-content")).toHaveText(conflictAuthorText);

    result = {
      status: "PASS",
      runtimeSourceHead: sourceHead,
      profile: "core",
      ociEngine: `${engine} (${run(engine, ["--version"], { capture: true }).split(/\r?\n/u)[0]})`,
      imageId,
      manifestDigest,
      platform,
      initialRemoteCommit: initialHead,
      publishedRemoteCommit: publishedHead,
      recoveredOperationId: operationId,
      recoveredOperationCommitCount: 1,
      indexedDbRetainedAcrossBrowserRestart: true,
      dataVolumeDeletedAndRecreated: true,
      externalUneditedSceneUpdateObserved: externalHeadOne,
      sameFileConflictPreservedAuthorInput: true,
      sameFileJournalRows: conflictDocumentJournal.rows,
      sameFileJournalSelectedKey: conflictDocumentJournal.selectedKey,
      rejectedPublishState: refused.receipt.state,
      conflictingOperationPublished: false,
      finalRemoteCommit: await github.branchHead(branch),
    };
  } finally {
    if (context && keepFailureArtifacts && !result) {
      try {
        await context.clearCookies();
        profileCookiesCleared = true;
      } catch { /* Do not retain a profile unless its session cookie can be cleared. */ }
    }
    await context?.close().catch(() => undefined);
    context = undefined;
    try { run(engine, ["stop", "--time", "30", container], { capture: true }); } catch { /* The container may not have started. */ }
    try { run(engine, ["rm", "--force", container], { capture: true }); } catch { /* The container may already be removed. */ }
    if (volumeCreated) {
      try { run(engine, ["volume", "rm", volume], { capture: true }); } catch { /* The temporary volume may already be absent. */ }
    }
    if (keepFailureArtifacts && !result) {
      const profileExists = await stat(profileDir).then(() => true, () => false);
      if (profileExists) {
        const artifactDirectory = join(tmpdir(), `scriptorium-p13-failure-${suffix}`);
        try {
          if (!profileCookiesCleared) {
            const scrubContext = await chromium.launchPersistentContext(profileDir, chromiumOptions);
            try {
              await scrubContext.clearCookies();
              profileCookiesCleared = true;
            } finally {
              await scrubContext.close().catch(() => undefined);
            }
          }
          if (!profileCookiesCleared) throw new Error("Could not clear the synthetic session cookie.");
          await mkdir(artifactDirectory, { mode: 0o700 });
          failureArtifactPath = artifactDirectory;
          await rename(profileDir, join(artifactDirectory, "browser-profile"));
          const networkDiagnostics = diagnostics?.() ?? { requests: [], pending: [], consoleErrors: [] };
          await writeFile(join(artifactDirectory, "network-diagnostics.json"), JSON.stringify(networkDiagnostics, null, 2), { encoding: "utf8", mode: 0o600 });
          await rm(tempRoot, { recursive: true, force: true });
        } catch {
          await rm(artifactDirectory, { recursive: true, force: true }).catch(() => undefined);
          failureArtifactPath = undefined;
          await rm(tempRoot, { recursive: true, force: true });
        }
      } else {
        await rm(tempRoot, { recursive: true, force: true });
      }
    } else {
      await rm(tempRoot, { recursive: true, force: true });
    }
    if (failureArtifactPath) console.error(`Sanitized browser failure artifacts retained at ${failureArtifactPath}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

await main();
