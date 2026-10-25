import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = resolve(appRoot, "..");
const profile = process.env.SCRIPTORIUM_PROFILE ?? "core";
if (!/^[a-z][a-z0-9-]{0,31}$/u.test(profile)) {
  throw new Error("SCRIPTORIUM_PROFILE must be a valid profile name");
}
const generatedBrowserModules = process.env.SCRIPTORIUM_BROWSER_MODULE_PROFILE_PATH
  ? resolve(process.env.SCRIPTORIUM_BROWSER_MODULE_PROFILE_PATH)
  : resolve(workspaceRoot, "profiles", profile, "generated", "browser.mjs");

const ui = process.env.SCRIPTORIUM_UI ?? "launcher";
if (!["launcher", "desktop", "mobile"].includes(ui)) throw new Error("Invalid SCRIPTORIUM_UI");
const uiDirectory = ui === "launcher" ? "" : ui;

export default defineConfig({
  root: appRoot,
  optimizeDeps: { exclude: ["@bytecodealliance/jco-transpile"] },
  plugins: [react(), {
    name: "scriptorium-ui-entry",
    transformIndexHtml: {
      order: "pre",
      handler: (html: string) => ui === "launcher" ? html : html.replace("/src/launcher.tsx", `/src/entries/${ui}.tsx`),
    },
  }],
  base: uiDirectory ? `/${uiDirectory}/` : "/",
  resolve: {
    alias: [{
      find: /^(?:\.\/|\.\.\/)+generated\/browser-modules$/u,
      replacement: generatedBrowserModules,
    }],
  },
  build: {
    outDir: resolve(appRoot, "dist", uiDirectory),
    emptyOutDir: true,
    manifest: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(appRoot, "index.html"),
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (asset) => asset.name?.endsWith(".css") ? "assets/styles-[hash][extname]" : "assets/[name]-[hash][extname]",
      },
    },
  },
});
