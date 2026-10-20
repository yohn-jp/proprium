import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const fixtureRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const hostSource = resolve(fixtureRoot, "app/src/contributions/ContributionHost.tsx");
const loaderFixture = resolve(fixtureRoot, "tests/e2e/core64-lifecycle/browser-loaders.fixture.ts");

export default {
  root: fixtureRoot,
  cacheDir: join(tmpdir(), "scriptorium-core64-lifecycle-vite-cache"),
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  server: { host: "127.0.0.1", port: 4189, strictPort: true },
  resolve: {
    alias: [
      { find: "../generated/browser-modules", replacement: loaderFixture },
      { find: /^react-dom(?=\/|$)/, replacement: resolve(fixtureRoot, "app/node_modules/react-dom") },
      { find: /^react(?=\/|$)/, replacement: resolve(fixtureRoot, "app/node_modules/react") },
    ],
  },
  plugins: [{
    name: "core64-lifecycle-held-request-fixture",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "../generated/browser-modules" && importer?.split("?")[0] === hostSource) return loaderFixture;
      return null;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.startsWith("/api/lifecycle-held")) return;
        next();
      });
    },
  }],
};
