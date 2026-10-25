import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { defineConfig, loadEnv } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = resolve(appRoot, "..");

const publicVariables = new Set([
  "VITE_PROPRIUM_GITHUB_AUTH_RELAY",
  "VITE_PROPRIUM_PLUGIN_REGISTRY_URL",
  "VITE_PROPRIUM_PLUGIN_REGISTRY_KEY",
  "VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS",
  "VITE_PROPRIUM_E2E",
]);

function publicOrigins(env: Record<string, string>): string[] {
  const origins = new Set<string>();
  for (const name of ["VITE_PROPRIUM_GITHUB_AUTH_RELAY", "VITE_PROPRIUM_PLUGIN_REGISTRY_URL"]) {
    const value = env[name];
    if (!value) continue;
    const parsed = new URL(value);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password ||
        (parsed.protocol === "http:" && !["localhost", "127.0.0.1"].includes(parsed.hostname))) {
      throw new Error(`${name} must use HTTPS and contain no credentials`);
    }
    origins.add(parsed.origin);
  }
  for (const origin of (env.VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean)) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.username || parsed.password ||
        !["https:", "http:"].includes(parsed.protocol) ||
        (parsed.protocol === "http:" && !["localhost", "127.0.0.1"].includes(parsed.hostname))) {
      throw new Error("VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS must contain credential-free HTTPS origins");
    }
    origins.add(parsed.origin);
  }
  if (env.VITE_PROPRIUM_PLUGIN_REGISTRY_URL && !env.VITE_PROPRIUM_PLUGIN_REGISTRY_KEY) {
    throw new Error("A pinned plugin registry URL requires its public Ed25519 key");
  }
  if (env.VITE_PROPRIUM_PLUGIN_REGISTRY_KEY) {
    const key = Buffer.from(env.VITE_PROPRIUM_PLUGIN_REGISTRY_KEY, "base64");
    if (key.byteLength !== 32 || key.toString("base64") !== env.VITE_PROPRIUM_PLUGIN_REGISTRY_KEY) {
      throw new Error("VITE_PROPRIUM_PLUGIN_REGISTRY_KEY must be canonical base64 for a 32-byte public Ed25519 key");
    }
  }
  return [...origins];
}

export default defineConfig(({ command, mode }) => {
  const fileEnv = loadEnv(mode, workspaceRoot, "VITE_");
  const env = { ...fileEnv };
  for (const name of publicVariables) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const name of Object.keys(env)) {
    if (!publicVariables.has(name)) throw new Error(`${name} is not an approved public Browser Host build setting`);
  }
  if (command === "build" && env.VITE_PROPRIUM_E2E === "true") {
    throw new Error("The test-only Host seam cannot be included in a static build");
  }
  const origins = publicOrigins(env);
  const connectSources = ["'self'", "https://api.github.com", "https://github.com", ...origins].join(" ");
  const imageSources = ["'self'", "data:", "blob:", ...origins].join(" ");
  const headers = `/index.html\n  Cache-Control: no-cache\n/proprium-sw.js\n  Cache-Control: no-cache\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Content-Security-Policy: default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src ${imageSources}; font-src 'self' data:; connect-src ${connectSources}; worker-src 'self' blob:; manifest-src 'self'\n`;
  const staticHeaders = {
    name: "proprium-static-security-headers",
    apply: "build" as const,
    generateBundle(this: { emitFile(file: { type: "asset"; fileName: string; source: string }): void }, _options: unknown, bundle: Record<string, { type: string; fileName: string }>) {
      const precache = Object.values(bundle)
        .filter(file => file.type === "asset" || file.type === "chunk")
        .map(file => file.fileName)
        .filter(fileName => /\.(?:js|css|wasm|woff2?|svg|png|webp|ico)$/u.test(fileName))
        .sort();
      const cacheVersion = createHash("sha256").update(precache.join("\n")).digest("hex").slice(0, 16);
      const serviceWorker = `const CACHE = "proprium-static-${cacheVersion}";\nconst SHELL = ["/", "/index.html", ${precache.map(file => JSON.stringify(`/${file}`)).join(", ")}];\nconst SHELL_PATHS = new Set(SHELL.map(path => new URL(path, self.location.origin).pathname));\nself.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));\nself.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("proprium-static-") && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));\nself.addEventListener("fetch", event => { const request = event.request; const url = new URL(request.url); if (request.method !== "GET" || url.origin !== self.location.origin) return; if (request.mode === "navigate") { event.respondWith(fetch(request).catch(async () => { const cache = await caches.open(CACHE); const cached = (await cache.match("/index.html")) ?? (await cache.match("/")); return cached ? new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers: cached.headers }) : Response.error(); })); return; } if (SHELL_PATHS.has(url.pathname)) event.respondWith(caches.match(request).then(response => response ?? fetch(request))); });\n`;
      this.emitFile({ type: "asset", fileName: "proprium-sw.js", source: serviceWorker });
    },
    closeBundle() {
      writeFileSync(resolve(workspaceRoot, "dist/proprium/_headers"), headers);
    },
  };

  return {
    root: appRoot,
    envDir: workspaceRoot,
    plugins: [react(), staticHeaders],
    optimizeDeps: {
      include: ["@isomorphic-git/lightning-fs", "buffer", "isomorphic-git", "isomorphic-git/http/web", "react", "react-dom/client"],
      exclude: ["@bytecodealliance/jco-transpile"],
    },
    define: Object.fromEntries([...publicVariables].map(name => [
      `import.meta.env.${name}`,
      JSON.stringify(env[name] ?? (name === "VITE_PROPRIUM_E2E" ? "false" : "")),
    ])),
    resolve: {
      alias: [{ find: "@proprium", replacement: resolve(appRoot, "src/browser/proprium") }],
    },
    server: {
      fs: { allow: [workspaceRoot] },
    },
    worker: {
      format: "es",
    },
    build: {
      outDir: resolve(workspaceRoot, "dist/proprium"),
      emptyOutDir: true,
      rollupOptions: {
        output: {
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: (asset) => asset.name?.endsWith(".css")
            ? "assets/styles-[hash][extname]"
            : "assets/[name]-[hash][extname]",
        },
      },
    },
  };
});
