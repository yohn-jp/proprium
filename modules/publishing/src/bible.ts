import type { SnapshotReader } from "@scriptorium/contracts";
import YAML from "yaml";
import type { EpubBibleEntry } from "./epub.js";

type BibleType = EpubBibleEntry["type"];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pathsFor(reader: SnapshotReader, type: BibleType): Promise<string[]> {
  const prefix = "bible/" + (type === "character" ? "characters" : type === "lore" ? "lore" : "locations");
  return reader.list(prefix).then((paths) => paths.filter((path) =>
    type === "character"
      ? path.endsWith("/profile.yaml") || path.endsWith(".yaml")
      : path.endsWith(".yaml")));
}

/** Read the source's character/lore/location records for the optional EPUB appendix. */
export async function readEpubBibleEntries(reader: SnapshotReader): Promise<EpubBibleEntry[]> {
  const entries: EpubBibleEntry[] = [];
  const types: BibleType[] = ["character", "lore", "location"];
  for (const type of types) {
    for (const path of await pathsFor(reader, type)) {
      const file = await reader.read(path);
      if (!file) continue;
      let parsed: unknown;
      try {
        parsed = YAML.parse(file.content);
      } catch {
        throw new Error("Invalid YAML in " + path);
      }
      const data = record(parsed);
      if (!data) throw new Error("Expected a YAML mapping in " + path);
      const fallback = path.split("/").at(-1)!.replace(/\.yaml$/, "");
      const id = typeof data.id === "string" && data.id.trim() ? data.id : fallback;
      const name = [data.name, data.title].find((value) => typeof value === "string" && value.trim());
      const aliases = Array.isArray(data.aliases)
        ? data.aliases.filter((value): value is string => typeof value === "string")
        : undefined;
      entries.push({
        id,
        type,
        name: typeof name === "string" ? name.trim() : id,
        ...(aliases?.length ? { aliases } : {}),
        ...(data.notes === undefined ? {} : { notes: data.notes }),
      });
    }
  }
  return entries;
}
