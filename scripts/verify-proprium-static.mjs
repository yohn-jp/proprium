import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const output = resolve(root, "dist/proprium");
const page = resolve(output, "index.html");
const serviceWorkerPath = resolve(output, "proprium-sw.js");
const configPath = resolve(root, "wrangler.jsonc");
const headersPath = resolve(output, "_headers");

assert.ok(existsSync(page), "Browser build must emit dist/proprium/index.html");
assert.ok(existsSync(serviceWorkerPath), "Browser build must emit the offline static shell worker");
assert.ok(existsSync(configPath), "Wrangler configuration must exist");
assert.ok(existsSync(headersPath), "Browser build must emit Cloudflare static security headers");
const config = readFileSync(configPath, "utf8");
assert.match(config, /"directory"\s*:\s*"\.\/dist\/proprium"/u, "Wrangler must publish the verified Proprium output directory");
assert.match(config, /"not_found_handling"\s*:\s*"single-page-application"/u, "Wrangler must route unknown navigation paths to the SPA entry");
assert.doesNotMatch(config, /"main"\s*:|"r2_buckets"\s*:/u, "The static Host must not depend on an edge Worker or R2 binding");

const pageContents = readFileSync(page, "utf8");
assert.match(pageContents, /<div id="root"/u, "The static entry must mount the Browser Host");
assert.match(pageContents, /<script[^>]+src=.*\/assets\/[^>]+\.js/u, "The static entry must load a hashed browser bundle");
assert.doesNotMatch(pageContents, /SCRIPTORIUM|launcher\.tsx|api\/health/u, "The static entry must not point at the legacy Scriptorium application");

const serviceWorker = readFileSync(serviceWorkerPath, "utf8");
assert.match(serviceWorker, /cache\.addAll\(SHELL\)/u, "The offline shell must precache all emitted static entry assets");
assert.match(serviceWorker, /request\.mode === "navigate"/u, "The offline shell must fall back to cached index.html for navigations");
assert.match(serviceWorker, /new Response\(cached\.body, \{ status: cached\.status, statusText: cached\.statusText, headers: cached\.headers \}\)/u,
  "The navigation fallback must materialize a fresh response from cached HTML and preserve its security headers");
assert.match(serviceWorker, /proprium-static-/u, "Each Host build must use a versioned shell cache");
assert.doesNotMatch(serviceWorker, /github\.com|plugins\//u, "The shell cache must not include remote workspaces or plugin artifacts");
function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}
for (const wasmPath of filesUnder(output).filter(path => path.endsWith(".wasm"))) {
  const publicPath = `/${wasmPath.slice(output.length + 1).split("\\").join("/")}`;
  assert.ok(serviceWorker.includes(publicPath), `Essential browser WASM runtime ${publicPath} must be cached for offline activation`);
}

const headers = readFileSync(headersPath, "utf8");
assert.match(headers, /X-Content-Type-Options: nosniff/u);
assert.match(headers, /Content-Security-Policy:/u);
assert.match(headers, /script-src 'self' 'wasm-unsafe-eval' blob:/u);
const connectionSources = /connect-src ([^;\n]+)/u.exec(headers)?.[1].split(/\s+/u) ?? [];
for (const required of ["'self'", "https:", "http://localhost:*", "http://127.0.0.1:*", "https://api.github.com", "https://github.com"]) {
  assert.ok(connectionSources.includes(required), `Host must allow its configured HTTPS Gateway and local development transport: ${required}`);
}
assert.ok(!connectionSources.some(source => ["*", "http:", "ws:", "wss:"].includes(source)), "Runtime Gateway selection must not enable unrestricted plaintext or WebSocket transport");
assert.match(headers, /worker-src 'self' blob:/u);
assert.match(headers, /\/index\.html\n\s+Cache-Control: no-cache/u);
assert.match(headers, /\/proprium-sw\.js\n\s+Cache-Control: no-cache/u);
assert.match(headers, /\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/u);
assert.doesNotMatch(headers, /script-src[^;\n]*'unsafe-eval'/u, "The static Host must not enable arbitrary JavaScript evaluation");
assert.doesNotMatch(headers, /SCRIPTORIUM|__VITE|\.env/u, "Static headers must not expose build secrets or legacy settings");
console.info("Verified the dedicated Proprium SPA entry, security headers, and Wrangler asset directory.");
