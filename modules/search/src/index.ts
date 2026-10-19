import type { ModuleContext } from "@scriptorium/contracts";
import { createSearchDefinition, searchManifest } from "./actions.js";

export function createModule(context: ModuleContext) {
  return createSearchDefinition(context);
}

export { createSearchActions, createSearchDefinition, searchManifest } from "./actions.js";
export { SnapshotIndexCache, isSearchableDocumentPath, type IndexedSnapshot } from "./index-cache.js";
export { createSearchDocument, lexicalTokens, normalizeSearchText, searchDocuments, searchTerms, type SearchDocument, type SearchHit, type SearchMode } from "./search-ranking.js";
export { normalizeTerm, parseTermRegistry, resolveTermSpans, TERM_REGISTRY_PATH, type AmbiguousTermSpan, type SearchTerm, type TermRegistry, type TermResolution, type TermSpan } from "./terminology.js";
export { browserModule } from "./browser.js";

export default searchManifest;
