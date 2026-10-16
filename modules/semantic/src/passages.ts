import type { CanonicalSnapshotEntity } from "@scriptorium/module-nlp";
import { splitIntoSentences } from "@scriptorium/module-nlp";
import type { SemanticPassage } from "./contracts.js";

const EMBEDDABLE_TYPES = new Set([
  "scene", "manuscript", "character", "location", "item", "faction", "event", "thread", "lore",
]);

/** Preserve source `extractEmbeddableText` field order and source sentence indexes. */
export function extractEmbeddableText(entity: CanonicalSnapshotEntity): string {
  const parts: string[] = [];
  if (entity.body?.trim()) parts.push(entity.body.trim());
  const description = entity.raw.description;
  if (typeof description === "string" && description.trim()) parts.push(description.trim());
  const notes = entity.raw.notes;
  if (typeof notes === "string" && notes.trim()) parts.push(notes.trim());
  return parts.join("\n");
}

export function buildSemanticPassages(entities: readonly CanonicalSnapshotEntity[]): SemanticPassage[] {
  const passages: SemanticPassage[] = [];
  for (const entity of entities) {
    if (!EMBEDDABLE_TYPES.has(entity.type)) continue;
    const content = extractEmbeddableText(entity);
    if (!content) continue;
    const sentences = splitIntoSentences(content).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex++) {
      passages.push({
        entityId: entity.id,
        sceneId: entity.id,
        sentenceIndex,
        text: sentences[sentenceIndex]!,
        type: entity.type,
        ...(entity.name ? { name: entity.name } : {}),
        filePath: entity.filePath,
      });
    }
  }
  return passages;
}
