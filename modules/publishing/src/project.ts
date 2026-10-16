import { assertProjectPath, type SnapshotReader } from "@scriptorium/contracts";
import YAML from "yaml";

export type PublishingScope = "all" | "volume" | "chapter";
export type ShareScopeKind = "project" | "volume" | "chapter" | "scene";

export interface PublishingScene {
  id: string;
  title: string;
  body: string;
  path: string;
  volumeId: string;
  chapterId: string;
  order?: number;
}

export interface PublishingChapter {
  id: string;
  title: string;
  order?: number;
  scenes: PublishingScene[];
}

export interface PublishingVolume {
  id: string;
  title: string;
  order?: number;
  chapters: PublishingChapter[];
}

export interface PublishingProject {
  title: string;
  subtitle?: string;
  volumes: PublishingVolume[];
}

export interface ShareScope {
  kind: ShareScopeKind;
  id: string;
}

export interface PublicScene {
  id: string;
  title: string;
  body: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nodeId(data: Record<string, unknown>, fallback: string): string {
  return typeof data.id === "string" && data.id.trim() ? data.id : fallback;
}

function nodeTitle(data: Record<string, unknown>, fallback: string): string {
  for (const candidate of [data.title, data.name]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return fallback;
}

function nodeOrder(data: Record<string, unknown>): number | undefined {
  return typeof data.order === "number" && Number.isFinite(data.order) ? data.order : undefined;
}

function compareOrdered(
  left: { id: string; title: string; order?: number },
  right: { id: string; title: string; order?: number },
): number {
  if (left.order !== undefined && right.order !== undefined && left.order !== right.order) {
    return left.order - right.order;
  }
  if (left.order !== undefined && right.order === undefined) return -1;
  if (left.order === undefined && right.order !== undefined) return 1;
  return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

async function readYaml(reader: SnapshotReader, path: string): Promise<Record<string, unknown> | null> {
  const file = await reader.read(path);
  if (!file) return null;
  let parsed: unknown;
  try {
    parsed = YAML.parse(file.content);
  } catch {
    throw new Error("Invalid YAML in " + path);
  }
  const result = record(parsed);
  if (!result) throw new Error("Expected a YAML mapping in " + path);
  return result;
}

function manuscriptBody(document: string, filePath: string): string {
  const opening = /^---[ \t]*\r?\n/.exec(document);
  if (!opening) return document;
  const delimiter = /^---[ \t]*\r?$/gm;
  delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(document);
  if (!closing) throw new Error("Unclosed Markdown frontmatter in " + filePath);
  const frontmatter = document.slice(opening[0].length, closing.index);
  try {
    const parsed = YAML.parse(frontmatter);
    if (parsed !== null && !record(parsed)) throw new Error("Frontmatter must be a mapping");
  } catch {
    throw new Error("Invalid Markdown frontmatter in " + filePath);
  }
  let start = closing.index + closing[0].length;
  if (document.startsWith("\r\n", start)) start += 2;
  else if (document.startsWith("\n", start)) start += 1;
  return document.slice(start);
}

function manuscriptPath(sceneFile: string, data: Record<string, unknown>, sceneId: string): string {
  const match = /^plot\/volumes\/([^/]+)\/chapters\/([^/]+)\/scenes\/[^/]+\.yaml$/.exec(sceneFile);
  const path = typeof data.manuscript === "string"
    ? data.manuscript
    : match ? "manuscript/" + match[1] + "/" + match[2] + "/" + sceneId + ".md" : "";
  assertProjectPath(path);
  if (!path.toLowerCase().endsWith(".md")) throw new Error("Scene manuscript must be a Markdown file");
  return path;
}

function folderIds(files: string[], prefix: string): string[] {
  return [...new Set(files.flatMap((path) => {
    if (!path.startsWith(prefix)) return [];
    const id = path.slice(prefix.length).split("/")[0];
    return id ? [id] : [];
  }))];
}

export async function readPublishingProject(reader: SnapshotReader): Promise<PublishingProject> {
  const projectMetadata = await readYaml(reader, "meta/project.yaml");
  const title = projectMetadata ? nodeTitle(projectMetadata, "Project") : "Project";
  const subtitle = typeof projectMetadata?.subtitle === "string" && projectMetadata.subtitle.trim()
    ? projectMetadata.subtitle.trim()
    : undefined;
  const files = await reader.list("plot/volumes");
  const volumeIds = folderIds(files, "plot/volumes/");
  const volumes: PublishingVolume[] = [];

  for (const volumeId of volumeIds) {
    const volumePath = "plot/volumes/" + volumeId + "/volume.yaml";
    const volumeData = await readYaml(reader, volumePath) ?? { id: volumeId };
    const volumeOrder = nodeOrder(volumeData);
    const volume: PublishingVolume = {
      id: nodeId(volumeData, volumeId),
      title: nodeTitle(volumeData, volumeId),
      ...(volumeOrder === undefined ? {} : { order: volumeOrder }),
      chapters: [],
    };
    const chapterPrefix = "plot/volumes/" + volumeId + "/chapters/";
    const chapterIds = folderIds(files, chapterPrefix);
    for (const chapterId of chapterIds) {
      const chapterBase = chapterPrefix + chapterId;
      const chapterData = await readYaml(reader, chapterBase + "/chapter.yaml") ?? { id: chapterId };
      const chapterOrder = nodeOrder(chapterData);
      const chapter: PublishingChapter = {
        id: nodeId(chapterData, chapterId),
        title: nodeTitle(chapterData, chapterId),
        ...(chapterOrder === undefined ? {} : { order: chapterOrder }),
        scenes: [],
      };
      const sceneFiles = files.filter((path) =>
        path.startsWith(chapterBase + "/scenes/") && path.endsWith(".yaml"));
      for (const sceneFile of sceneFiles) {
        const sceneData = await readYaml(reader, sceneFile);
        if (!sceneData) continue;
        const basename = sceneFile.split("/").at(-1)!.slice(0, -".yaml".length);
        const id = nodeId(sceneData, basename);
        const bodyPath = manuscriptPath(sceneFile, sceneData, id);
        const manuscript = await reader.read(bodyPath);
        const sceneOrder = nodeOrder(sceneData);
        chapter.scenes.push({
          id,
          title: nodeTitle(sceneData, id),
          body: manuscript ? manuscriptBody(manuscript.content, bodyPath) : "",
          path: bodyPath,
          volumeId: volume.id,
          chapterId: chapter.id,
          ...(sceneOrder === undefined ? {} : { order: sceneOrder }),
        });
      }
      chapter.scenes.sort(compareOrdered);
      volume.chapters.push(chapter);
    }
    volume.chapters.sort(compareOrdered);
    volumes.push(volume);
  }

  volumes.sort(compareOrdered);
  return { title, ...(subtitle ? { subtitle } : {}), volumes };
}

export function collectPublishingScenes(
  project: PublishingProject,
  scope: PublishingScope,
  id?: string,
): PublishingScene[] {
  if (scope === "all") return project.volumes.flatMap((volume) => volume.chapters.flatMap((chapter) => chapter.scenes));
  if (!id?.trim()) throw new Error("A volume or chapter ID is required for this export scope");
  const pickedId = id.trim();
  if (scope === "volume") {
    const volume = project.volumes.find((item) => item.id === pickedId);
    if (!volume) throw new Error("Volume not found: " + pickedId);
    return volume.chapters.flatMap((chapter) => chapter.scenes);
  }
  if (scope === "chapter") {
    for (const volume of project.volumes) {
      const chapter = volume.chapters.find((item) => item.id === pickedId);
      if (chapter) return chapter.scenes;
    }
    throw new Error("Chapter not found: " + pickedId);
  }
  throw new Error("Invalid export scope");
}

export function resolveShareScope(project: PublishingProject, scope: ShareScope): PublishingScene[] {
  if (!scope.id.trim()) throw new Error("A share scope ID is required");
  if (scope.kind === "volume") {
    const volume = project.volumes.find((item) => item.id === scope.id);
    if (!volume) throw new Error("Volume not found: " + scope.id);
    return volume.chapters.flatMap((chapter) => chapter.scenes);
  }
  if (scope.kind === "chapter") {
    for (const volume of project.volumes) {
      const chapter = volume.chapters.find((item) => item.id === scope.id);
      if (chapter) return chapter.scenes;
    }
    throw new Error("Chapter not found: " + scope.id);
  }
  if (scope.kind === "scene") {
    const scene = project.volumes.flatMap((volume) => volume.chapters.flatMap((chapter) => chapter.scenes))
      .find((item) => item.id === scope.id);
    if (!scene) throw new Error("Scene not found: " + scope.id);
    return [scene];
  }
  if (scope.kind === "project") {
    return project.volumes.flatMap((volume) => volume.chapters.flatMap((chapter) => chapter.scenes));
  }
  throw new Error("Invalid share scope");
}
