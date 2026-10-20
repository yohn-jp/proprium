import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { chromium, expect } from "@playwright/test";
import { git } from "./dataset.mjs";
import { installBrowserProbes } from "./browser-probes.mjs";
import { installCore64RenderProbe, summarizeCore64RenderProbe } from "./core64-render-probe.mjs";

const [fixturePath, outputPath, repeatsArg = "20"] = process.argv.slice(2);
if (!fixturePath || !outputPath) {
  throw new Error("Usage: node scripts/performance/core64-render.mjs <fixture-directory> <output.json> [repeats]");
}
const repeats = Number(repeatsArg);
if (!Number.isInteger(repeats) || repeats < 1) throw new Error("repeats must be a positive integer");

const fixture = JSON.parse(await readFile(join(fixturePath, "dataset.json"), "utf8"));
const report = {
  schemaVersion: 1,
  harness: {
    source: git(process.cwd(), "rev-parse", "HEAD"),
    scriptSha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
    probeSha256: createHash("sha256").update(await readFile(new URL("./core64-render-probe.mjs", import.meta.url))).digest("hex"),
  },
  fixture,
  node: process.version,
  repeats,
  status: "running",
  phases: [],
  notChecked: [
    "Native OS English/Japanese IME and physical devices; CDP composition is synthetic.",
    "React actualDuration per component; this probe attributes commit flags and panel references only.",
    "The CPU profile spans startup through the focused input and panel switch, not one isolated input phase.",
  ],
};

const server = fork(new URL("./server.mjs", import.meta.url), [resolve(fixturePath)], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
let browser;
let page;
let cdp;
let profilerStarted = false;
const startedAt = performance.now();

async function saveReport() {
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

function metricsMap(result) {
  return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
}

function metricDelta(before, after, names) {
  const start = metricsMap(before), end = metricsMap(after);
  return Object.fromEntries(names.map((name) => [name, (end[name] ?? 0) - (start[name] ?? 0)]));
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (p) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] ?? sorted.at(-1) : null;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? null };
}

try {
  const [ready] = await once(server, "message");
  report.serverStartupMs = ready.startupMs;
  browser = await chromium.launch({ headless: true,
    ...(process.env.SCRIPTORIUM_E2E_CHROMIUM ? { executablePath: process.env.SCRIPTORIUM_E2E_CHROMIUM } : {}) });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const initSource = `(${installBrowserProbes.toString()})();\n(${installCore64RenderProbe.toString()})();`;
  await context.addInitScript({ content: initSource });
  page = await context.newPage();
  page.setDefaultTimeout(60000);
  cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.start");
  profilerStarted = true;

  const base = `http://127.0.0.1:${ready.port}`;
  await page.goto(`${base}/desktop/`);
  await page.getByLabel("アクセストークン").waitFor();
  await page.getByLabel("アクセストークン").fill("synthetic-benchmark-local-token-000000");
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await page.getByLabel("GitHub リポジトリ URL").fill(pathToFileURL(ready.remote).href);
  const sceneButton = (id) => page.locator("button.scene-button").filter({ hasText: new RegExp(`^Chapter One: Scene ${id}$`) });
  await page.getByRole("button", { name: "リポジトリを登録" }).click();
  await sceneButton(1).waitFor();
  const editor = page.locator(".cm-content");

  async function openScene(id) {
    await sceneButton(id).click();
    await expect(page.locator(".scene-heading h1")).toHaveText(`Scene ${id}`);
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.press("Control+Home");
    await expect(editor).toContainText(`Synthetic scene ${id}`);
  }

  async function setPhase(name, cohort = name) {
    await page.evaluate(([value, group]) => window.__scriptoriumCore64RenderProbe.setPhase(value, group), [name, cohort]);
  }

  async function stats() {
    const next = once(server, "message");
    server.send("stats");
    return (await next)[0];
  }

  const inputSizes = fixture.documentBytes ?? [1024, 102400, 1048576];
  if (inputSizes.length < 3) throw new Error("The render probe requires the three-document small fixture");
  for (let index = 0; index < 3; index++) {
    const id = index + 1;
    await openScene(id);
    await editor.focus();
    await editor.press("Control+End");
    const name = `input.${inputSizes[index]}`;
    const cdpBefore = await cdp.send("Performance.getMetrics");
    await setPhase("input.typing", name);
    const start = await page.evaluate(() => performance.now());
    for (let count = 0; count < repeats; count++) {
      await editor.press("a");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    await setPhase("input.cursor", name);
    for (let count = 0; count < repeats; count++) await editor.press("ArrowLeft");
    await setPhase("input.history", name);
    await editor.press("Control+z");
    await editor.press("Control+Shift+z");
    await setPhase("input.composition", name);
    await cdp.send("Input.imeSetComposition", { text: "にほんご", selectionStart: 4, selectionEnd: 4 });
    await cdp.send("Input.insertText", { text: "日本語" });
    await setPhase("input.paste", name);
    await cdp.send("Input.insertText", { text: "\nSynthetic paste. ".repeat(64) });
    await page.waitForFunction((at) => window.__wave0.transactions.some((tx) =>
      tx.start > at && tx.mode === "readwrite" && tx.status === "complete"), start);
    await page.waitForTimeout(1000);
    const end = await page.evaluate(() => performance.now());
    await setPhase("between", "between");
    const cdpAfter = await cdp.send("Performance.getMetrics");
    const snapshot = await page.evaluate(() => ({
      render: window.__scriptoriumCore64RenderProbe.snapshot(),
      browser: structuredClone(window.__wave0),
    }));
    const keyFrames = snapshot.browser.inputs.filter((row) => row.start >= start && row.start <= end && row.type === "keydown")
      .map((row) => row.frameMs).filter(Number.isFinite);
    const arrowFrames = snapshot.browser.inputs.filter((row) => row.start >= start && row.start <= end &&
      row.type === "keydown" && row.key === "ArrowLeft").map((row) => row.frameMs).filter(Number.isFinite);
    const longTasks = snapshot.browser.longTasks.filter((row) => row.start >= start && row.start <= end);
    report.phases.push({
      name,
      sceneId: `scene-${id}`,
      start,
      end,
      elapsedMs: end - start,
      render: summarizeCore64RenderProbe(snapshot.render, null, name),
      renderByPhase: Object.fromEntries(["input.typing", "input.cursor", "input.history", "input.composition", "input.paste"]
        .map((phase) => [phase, summarizeCore64RenderProbe(snapshot.render, phase, name)])),
      keyFrameMs: distribution(keyFrames),
      cursorKeyFrameMs: distribution(arrowFrames),
      longTasks: { count: longTasks.length, totalMs: longTasks.reduce((sum, row) => sum + row.ms, 0), maxMs: Math.max(0, ...longTasks.map((row) => row.ms)) },
      strictWrites: snapshot.browser.transactions.filter((tx) => tx.start >= start && tx.start <= end && tx.mode === "readwrite" && tx.status === "complete").length,
      cdpDelta: metricDelta(cdpBefore, cdpAfter, ["ScriptDuration", "TaskDuration", "TaskOtherDuration"]),
      server: await stats(),
    });
    await saveReport();
  }

  const inspectorTab = page.getByRole("tab", { name: "Inspector", exact: true });
  await inspectorTab.waitFor();
  await setPhase("workspace.activate.inspector");
  await inspectorTab.click();
  await expect(page.locator('[data-workspace-panel="inspector"]')).toHaveCount(1);
  await setPhase("workspace.activate.outline");
  await page.getByRole("tab", { name: "Outline", exact: true }).click();
  await expect(page.locator('[data-workspace-panel="outline"]')).toHaveCount(1);
  await setPhase("complete");
  const render = await page.evaluate(() => window.__scriptoriumCore64RenderProbe.snapshot());
  report.workspaceActivation = {
    inspector: summarizeCore64RenderProbe(render, "workspace.activate.inspector"),
    outline: summarizeCore64RenderProbe(render, "workspace.activate.outline"),
  };
  report.renderProbe = render;
  const profile = await cdp.send("Profiler.stop");
  profilerStarted = false;
  const profilePath = `${outputPath}.cpuprofile`;
  await mkdir(dirname(resolve(profilePath)), { recursive: true });
  const profileJson = JSON.stringify(profile.profile);
  await writeFile(profilePath, profileJson);
  report.cpuProfile = { file: profilePath, bytes: Buffer.byteLength(profileJson), sha256: createHash("sha256").update(profileJson).digest("hex") };
  report.server = await stats();
  report.status = "complete";
  await saveReport();
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.stack : String(error);
  if (page && !page.isClosed()) {
    report.renderProbe = await page.evaluate(() => window.__scriptoriumCore64RenderProbe?.snapshot()).catch(() => null);
    report.browserMetrics = await page.evaluate(() => structuredClone(window.__wave0)).catch(() => null);
  }
  if (profilerStarted && cdp) {
    const profile = await cdp.send("Profiler.stop").catch(() => null);
    if (profile?.profile) {
      const profileJson = JSON.stringify(profile.profile);
      await writeFile(`${outputPath}.cpuprofile`, profileJson).catch(() => {});
    }
  }
  await saveReport();
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  server.kill("SIGTERM");
  await once(server, "exit").catch(() => {});
  report.elapsedSeconds = (performance.now() - startedAt) / 1000;
}
