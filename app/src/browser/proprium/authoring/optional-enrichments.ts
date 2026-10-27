/**
 * Host-orchestrated optional edges from docs/canon/ARCHITECTURE.md, Execution
 * and dependencies. These are not installation/activation dependencies. Both
 * plugins still need their own grants, caller policy, current scope and schemas.
 * Unknown/third-party identities gain no edge from this official profile.
 */
const enrichments: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "proprium.narrative": Object.freeze(["proprium.research"]),
  "proprium.knowledge": Object.freeze(["proprium.semantic"]),
  "proprium.research": Object.freeze(["proprium.semantic"]),
  "proprium.diagnostics": Object.freeze(["proprium.knowledge", "proprium.research", "proprium.speaker", "proprium.semantic"]),
  "proprium.speaker": Object.freeze(["proprium.research", "proprium.diagnostics"]),
  "proprium.semantic": Object.freeze(["proprium.knowledge"]),
  "proprium.paired-writing": Object.freeze(["proprium.knowledge", "proprium.research", "proprium.diagnostics", "proprium.speaker", "proprium.semantic"]),
});

export function isCanonOptionalEnrichment(source: string, target: string): boolean {
  return Object.hasOwn(enrichments, source) && enrichments[source]!.includes(target);
}
