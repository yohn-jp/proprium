import type { SnapshotId } from "@scriptorium/contracts";

/** Value shapes retained by the original editor; no application-server transport. */
export interface Tree {
  title: string;
  volumes: Array<{
    id: string;
    title: string;
    chapters: Array<{
      id: string;
      title: string;
      scenes: Array<{ id: string; title: string }>;
    }>;
  }>;
}

export interface Scene {
  id: string;
  title: string;
  text: string;
  /** Legacy combined YAML + manuscript revision. File preconditions use SceneRead.document.revision. */
  revision: string;
}

export interface FileDocument {
  path: string;
  content: string;
  /** null distinguishes an absent file from an existing empty file. */
  revision: string | null;
}

export interface SceneRead {
  snapshot: SnapshotId;
  scene: Scene;
  /** Full manuscript bytes decoded as UTF-8, including Markdown frontmatter. */
  document: FileDocument;
  /** Exact scene YAML, used only when the manuscript link needs to be added. */
  metadata: FileDocument;
}

