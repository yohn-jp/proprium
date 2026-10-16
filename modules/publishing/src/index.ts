import { CONTRACT_VERSION, type ModuleContext, type ModuleDefinition, type ModuleManifest } from "@scriptorium/contracts";
import { createPublishingActions } from "./actions.js";
import { createPublishingHttpContributions } from "./http.js";

export const publishingManifest: ModuleManifest = {
  id: "publishing",
  version: "0.1.0",
  contractVersion: CONTRACT_VERSION,
  dependencies: [],
  provides: [],
  requires: [],
  serverEntry: "./dist/index.js",
  browserEntry: "./dist/browser.js",
  statePaths: ["meta/scriptorium/modules/publishing"],
  locality: "local",
};

/** The optional module is imported only when Publishing is enabled and activated. */
export async function createModule(_context: ModuleContext): Promise<ModuleDefinition> {
  const actions = createPublishingActions();
  return {
    manifest: publishingManifest,
    actions,
    ui: [
      { id: "publishing.export.plaintext", module: "publishing", slot: "settings", title: "プレーンテキスト書き出し", action: "publishing.export.plaintext" },
      { id: "publishing.export.epub", module: "publishing", slot: "settings", title: "EPUB 書き出し", action: "publishing.export.epub" },
      { id: "publishing.export.vertical-print", module: "publishing", slot: "settings", title: "縦書き PDF", action: "publishing.export.vertical-print" },
      { id: "publishing.episode-map", module: "publishing", slot: "settings", title: "公開回マッピング", action: "publishing.episodes.read" },
      { id: "publishing.share-links", module: "publishing", slot: "settings", title: "読み取り専用共有リンク", action: "publishing.shares.list" },
    ],
    http: createPublishingHttpContributions(),
    async dispose() {},
  };
}

export { createPublishingMigrationProducer } from "./migration.js";
export * from "./project.js";
export * from "./plaintext.js";
export * from "./epub.js";
export * from "./verticalPrint.js";
export * from "./episodes.js";
export * from "./grants.js";
