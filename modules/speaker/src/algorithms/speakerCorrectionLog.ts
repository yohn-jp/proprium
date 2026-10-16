import { z } from "zod";
import type { SpeakerCorrectionInput } from "./speakerAttribution.js";

export interface SpeakerCorrectionRecord extends Omit<SpeakerCorrectionInput, "predictedReason"> {
  /** Unknown historical reasons remain readable and do not invalidate the JSONL row. */
  predictedReason: string;
  sceneId: string;
  speakerEntityId: string | null;
  timestamp: string;
}

export const SpeakerCorrectionRecordSchema = z.object({
  sentenceIndex: z.number().int().positive(),
  textHash: z.string().regex(/^[a-f0-9]{8}$/),
  dialogueText: z.string(),
  predictedSpeakerEntityId: z.string().nullable(),
  predictedReason: z.string(),
  speakerGroupId: z.string().nullable(),
  label: z.enum(["direct", "propagated"]),
  sceneId: z.string(),
  speakerEntityId: z.string().nullable(),
  timestamp: z.string(),
});

export interface ReadSpeakerCorrectionsResult { records: SpeakerCorrectionRecord[]; skipped: number }

/** Parse the module-owned JSONL sidecar without rewriting or discarding malformed source lines. */
export function parseSpeakerCorrections(content: string | null): ReadSpeakerCorrectionsResult {
  if (!content) return { records: [], skipped: 0 };
  const records: SpeakerCorrectionRecord[] = [];
  let skipped = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { skipped++; continue; }
    const parsed = SpeakerCorrectionRecordSchema.safeParse(value);
    if (!parsed.success) { skipped++; continue; }
    records.push(parsed.data);
  }
  return { records, skipped };
}
