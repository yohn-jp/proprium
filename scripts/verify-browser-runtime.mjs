#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { chromium, webkit } from "@playwright/test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);

const expectedImageDigest = "sha256:d65108d1a8095d8b0c4a5e32bf1807a40a5ce90ff0c78473e1116b1c243235e8";
assert.equal(process.platform, "linux", "Browser verification requires the Linux Noble container");
assert.equal(process.arch, "x64", "The pinned Playwright image digest is the Linux amd64 image");
assert.equal(process.versions.node.split(".")[0], "24", "The browser runner must use Node 24");
assert.equal(
  process.env.SCRIPTORIUM_PLAYWRIGHT_IMAGE_DIGEST,
  expectedImageDigest,
  "The browser job must declare the pinned Playwright 1.64.1 Noble image digest",
);

const operatingSystem = await readFile("/etc/os-release", "utf8");
assert.match(operatingSystem, /^VERSION_CODENAME="?noble"?$/mu, "The browser runner must use Ubuntu Noble");

const { stdout: pnpmVersionOutput } = await execFileAsync("pnpm", ["--version"], { encoding: "utf8" });
const pnpmVersion = pnpmVersionOutput.trim();
assert.equal(pnpmVersion, "12.10.1", "The browser runner must use pnpm 12.10.1");

const playwrightPackage = JSON.parse(await readFile(resolve(root, "node_modules/@playwright/test/package.json"), "utf8"));
assert.equal(playwrightPackage.version, "1.64.1", "The installed Playwright package must match the pinned browser image");

async function verifyBrowser(name, browserType) {
  const browser = await browserType.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><title>Scriptorium browser runtime</title><main>browser-ready</main>");
    const content = await page.locator("main").textContent();
    assert.equal(content, "browser-ready", `${name} must render and read a real page`);
    return browser.version();
  } finally {
    await browser.close();
  }
}

const chromiumVersion = await verifyBrowser("Chromium", chromium);
const webkitVersion = await verifyBrowser("WebKit", webkit);
process.stdout.write(`PLAYWRIGHT_RUNTIME PASS ${JSON.stringify({
  os: "ubuntu-noble",
  imageDigest: expectedImageDigest,
  node: process.version,
  pnpm: pnpmVersion,
  playwright: playwrightPackage.version,
  browsers: { chromium: chromiumVersion, webkit: webkitVersion },
})}\n`);
