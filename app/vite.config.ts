import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const workspaceRoot = resolve(appRoot, "..");
const profile = process.env.SCRIPTORIUM_PROFILE ?? "core";
if (profile !== "core" && profile !== "full") {
  throw new Error("SCRIPTORIUM_PROFILE must be core or full");
}
const generatedBrowserModules = resolve(workspaceRoot, "profiles", profile, "generated", "browser.mjs");

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
