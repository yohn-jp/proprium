import type { ModuleContext, ModuleDefinition, ModuleManifest } from "@scriptorium/contracts";
import { createSemanticActions } from "./actions.js";
import { SEMANTIC_MODULE_VERSION, SEMANTIC_EMBEDDING_CAPABILITY } from "./contracts.js";
import { semanticEmbeddingCapability } from "./embedding.js";

/** Must stay byte-for-byte aligned with the installed package profile metadata. */
export const semanticManifest: ModuleManifest = {
  id: "semantic",
  version: SEMANTIC_MODULE_VERSION,
  contractVersion: 1,
  dependencies: ["story", "nlp"],
  provides: [SEMANTIC_EMBEDDING_CAPABILITY],
  requires: ["nlp.tokenizer"],
  serverEntry: "./dist/index.js",
  browserEntry: "./dist/browser.js",
  workerEntry: "./dist/worker.js",
  statePaths: ["meta/scriptorium/modules/semantic"],
  locality: "local",
};

export function createModule(context: ModuleContext): ModuleDefinition {
  return {
    manifest: semanticManifest,
    capabilities: [semanticEmbeddingCapability],
    actions: createSemanticActions(context),
    ui: [
      { id: "semantic.search", module: "semantic", slot: "dock", title: "意味検索", action: "semantic.search" },
      { id: "semantic.expressions", module: "semantic", slot: "dock", title: "表現の在庫", action: "semantic.expressions.search" },
      { id: "semantic.contradictions", module: "semantic", slot: "review", title: "矛盾候補", action: "semantic.contradictions.rebuild" },
      { id: "semantic.index", module: "semantic", slot: "settings", title: "意味インデックスとプライバシー", action: "semantic.index.status" },
    ],
    async dispose() {},
  };
}

export { createSemanticActions } from "./actions.js";
export { buildSemanticPassages } from "./passages.js";
export { searchSnapshotLexically, combineHybridScores } from "./search.js";
export { clusterSimilarTerms, shouldClusterByString } from "./termClustering.js";
export { collectMentionGroups, detectSourceRuleContradictions, mergeContradictionCandidates } from "./contradictions.js";
export { createSemanticMigrationProducer } from "./migration.js";
export * from "./contracts.js";
