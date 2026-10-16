import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";
import { chromium } from "@playwright/test";
import { createModule } from "../dist/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = resolve(packageRoot, "../..");
const { createServer } = await import(pathToFileURL(resolve(workspaceRoot, "app/node_modules/vite/dist/node/index.js")).href);
const repository = {
  provider: "local",
  repositoryId: "publishing-browser-fixture",
  defaultBranch: "main",
  ownerScope: "owner-1",
  url: "file:///synthetic/publishing-browser-fixture",
};
const snapshot = { repository, remoteCommit: "a".repeat(40) };
const files = new Map([
  ["meta/project.yaml", "title: 星の図書館\n"],
  ["plot/volumes/vol-1/volume.yaml", "id: vol-1\ntitle: 第一巻\norder: 1\n"],
  ["plot/volumes/vol-1/chapters/ch-1/chapter.yaml", "id: ch-1\ntitle: はじまり\norder: 1\n"],
  ["plot/volumes/vol-1/chapters/ch-1/scenes/sc-1.yaml", "id: sc-1\ntitle: 夜の駅\norder: 1\nmanuscript: manuscript/vol-1/ch-1/sc-1.md\n"],
  ["plot/volumes/vol-1/chapters/ch-1/scenes/sc-2.yaml", "id: sc-2\ntitle: 朝の港\norder: 2\nmanuscript: manuscript/vol-1/ch-1/sc-2.md\n"],
  ["manuscript/vol-1/ch-1/sc-1.md", "夜の駅。\n"],
  ["manuscript/vol-1/ch-1/sc-2.md", "朝の港。\n"],
  ["meta/scriptorium/modules/publishing/episodes.yaml", YAML.stringify({
    episodes: [{
      id: "episode-1",
      number: 1,
      title: "第一話",
      scope: "chapter",
      scopeId: "ch-1",
      publishedAt: "2025-04-03",
      sceneIds: ["sc-1"],
      futureEpisodeField: { retained: true },
    }],
  })],
]);

class Reader {
  snapshot = snapshot;
  async read(path) {
    const content = files.get(path);
    return content === undefined ? null : {
      content,
      revision: createHash("sha256").update(content).digest("hex"),
    };
  }
  async list(prefix) {
    return [...files.keys()].filter((path) => path.startsWith(prefix)).sort();
  }
}

const reader = new Reader();
const proposals = [];
const actionContext = {
  projectId: "publishing-browser-fixture",
  reader,
  invoke: async () => ({ ok: false, snapshot, error: { code: "unused", message: "unused", retryable: false } }),
  listActions: async () => [],
  linkedReader: async () => reader,
  signal: new AbortController().signal,
  propose: async (operations, evidence) => {
    const proposal = { id: `proposal-${proposals.length + 1}`, snapshot, operations, source: "module", ...(evidence ? { evidence } : {}) };
    proposals.push(proposal);
    return proposal;
  },
  runJob: async () => ({ ok: false, id: "unused", snapshot, error: { code: "unused", message: "unused", retryable: false } }),
};
const moduleContext = {
  cacheDirectory: "/tmp/publishing-browser-test-cache",
  signal: new AbortController().signal,
  acquireCapability: async () => { throw new Error("no capabilities required"); },
  createWorkerService: async () => { throw new Error("no worker required"); },
};
const definition = await createModule(moduleContext);
const server = await createServer({
  configFile: false,
  root: packageRoot,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  optimizeDeps: { include: ["react", "react-dom/client"] },
});
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.SCRIPTORIUM_E2E_CHROMIUM ? { executablePath: process.env.SCRIPTORIUM_E2E_CHROMIUM } : {}),
  });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/tests/browser-clear.html`);
  await page.exposeFunction("publishingInvoke", async (actionId, input) => {
    const action = definition.actions.find((candidate) => candidate.id === actionId);
    assert.ok(action, `unknown publishing action ${actionId}`);
    return action.invoke(action.inputSchema.parse(input), actionContext);
  });
  await page.evaluate(async ({ origin, snapshot }) => {
    const { browserModule } = await import(`${origin}/src/browser.tsx`);
    const context = {
      projectId: "publishing-browser-fixture",
      snapshot,
      signal: new AbortController().signal,
      invoke: (actionId, input) => window.publishingInvoke(actionId, input),
      propose: async () => { throw new Error("episode editing should use its registered action"); },
      refresh: async () => {},
    };
    window.publishingUnmount = await browserModule.mount(
      "publishing.episode-map",
      document.getElementById("publishing-root"),
      context,
    );
  }, { origin, snapshot });

  const date = page.locator('input[type="date"]');
  await date.waitFor();
  assert.equal(await date.inputValue(), "2025-04-03");
  await date.fill("");
  await page.getByLabel("夜の駅", { exact: true }).uncheck();
  await page.getByRole("button", { name: "レビューに保存" }).click();
  await page.getByRole("status").waitFor();
  assert.equal(proposals.length, 1, "the browser submitted one real publishing proposal");
  const write = proposals[0].operations[0].writes[0];
  const saved = YAML.parse(write.content).episodes[0];
  assert.equal(Object.hasOwn(saved, "publishedAt"), false, "clearing the date in the rendered UI removes it from metadata");
  assert.equal(Object.hasOwn(saved, "sceneIds"), false, "unchecking the last scene in the rendered UI removes its annotation");
  assert.deepEqual(saved.futureEpisodeField, { retained: true });
  assert.deepEqual(pageErrors, []);
  await page.evaluate(() => window.publishingUnmount());
  await page.close();
  console.log("PASS: rendered episode-map UI clears publishedAt and the final sceneId through the real proposal action");
} finally {
  await browser?.close();
  await server.close();
}
