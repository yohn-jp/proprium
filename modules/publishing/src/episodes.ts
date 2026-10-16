import type { SnapshotReader } from "@scriptorium/contracts";
import YAML from "yaml";

export const EPISODES_PATH = "meta/scriptorium/modules/publishing/episodes.yaml";

export interface PublishEpisodeRecord extends Record<string, unknown> {
  id: string;
  number: number;
  title: string;
  scope: "volume" | "chapter";
  scopeId: string;
  publishedAt?: string;
  sceneIds?: string[];
}

export interface EpisodeMapDocument {
  root: Record<string, unknown>;
  episodes: PublishEpisodeRecord[];
  content: string;
  revision: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateEpisode(value: unknown, index: number): PublishEpisodeRecord {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() ||
      typeof value.number !== "number" || !Number.isSafeInteger(value.number) || value.number < 1 ||
      typeof value.title !== "string" || (value.scope !== "volume" && value.scope !== "chapter") ||
      typeof value.scopeId !== "string" || !value.scopeId.trim() ||
      (value.publishedAt !== undefined && typeof value.publishedAt !== "string") ||
      (value.sceneIds !== undefined && (!Array.isArray(value.sceneIds) || value.sceneIds.some((id) => typeof id !== "string")))) {
    throw new Error(`Invalid publication episode at index ${index}`);
  }
  return value as PublishEpisodeRecord;
}

export async function readEpisodeMap(reader: SnapshotReader): Promise<EpisodeMapDocument> {
  const file = await reader.read(EPISODES_PATH);
  if (!file) return { root: {}, episodes: [], content: "", revision: null };
  let parsed: unknown;
  try { parsed = YAML.parse(file.content); } catch { throw new Error("Invalid publication episode YAML"); }
  if (!isRecord(parsed) || (parsed.episodes !== undefined && !Array.isArray(parsed.episodes))) {
    throw new Error("Publication episode map must contain an episodes array");
  }
  const episodes = (parsed.episodes as unknown[] | undefined ?? []).map(validateEpisode);
  return { root: parsed, episodes, content: file.content, revision: file.revision };
}

export function mergeEpisodeMap(existing: EpisodeMapDocument, input: unknown): { root: Record<string, unknown>; episodes: PublishEpisodeRecord[]; content: string } {
  if (!Array.isArray(input)) throw new Error("episodes must be an array");
  const priorById = new Map(existing.episodes.map((episode) => [episode.id, episode]));
  const seenIds = new Set<string>();
  const episodes = input.map((value, index) => {
    const episode = validateEpisode(value, index);
    if (seenIds.has(episode.id)) throw new Error(`Duplicate publication episode ID: ${episode.id}`);
    seenIds.add(episode.id);
    // Keep fields unknown to the current UI when it edits known fields.
    return { ...(priorById.get(episode.id) ?? {}), ...episode };
  }).sort((left, right) => left.number - right.number || left.id.localeCompare(right.id));
  const root = { ...existing.root, episodes };
  return { root, episodes, content: YAML.stringify(root) };
}
