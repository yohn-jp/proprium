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
  return reader.list(prefix).then((paths) => paths.filter((path) => {
    if (!path.endsWith(".yaml")) return false;
    if (type !== "character") return true;
    const relative = path.startsWith(prefix + "/") ? path.slice(prefix.length + 1) : "";
    // New source characters use nested profile.yaml. Older source projects also
    // have direct-child character records; voice.yaml and other nested helpers
    // are not separate character entities.
    return relative === "profile.yaml" || relative.endsWith("/profile.yaml") || !relative.includes("/");
  }));
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
      // Core's source loader ignores YAML without an explicit entity ID. That
      // excludes id-less voice.yaml helpers instead of inventing a filename ID.
      if (typeof data.id !== "string" || !data.id.trim()) continue;
      const id = data.id;
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
