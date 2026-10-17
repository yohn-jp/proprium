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

export default defineConfig({
  root: appRoot,
  plugins: [react()],
  base: "/",
  resolve: {
    alias: [{
      find: /^(?:\.\/|\.\.\/)+generated\/browser-modules$/u,
      replacement: generatedBrowserModules,
    }],
  },
  build: {
    outDir: resolve(appRoot, "dist"),
    emptyOutDir: true,
    manifest: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: "main.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (asset) => asset.name?.endsWith(".css") ? "styles.css" : "assets/[name]-[hash][extname]",
      },
    },
  },
});
