export interface LocalDraft {
  version: 1;
  projectId: string;
  sceneId: string;
  text: string;
  revision: string;
  savedAt: number;
}

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SceneSnapshot {
  text: string;
  revision: string;
}

export interface RestoredDraft {
  text: string;
  revision: string;
  restored: boolean;
  stale: boolean;
}

export function draftKey(projectId: string, sceneId: string): string {
  return `scriptorium:draft:${encodeURIComponent(projectId)}:${encodeURIComponent(sceneId)}`;
}

function isDraft(value: unknown, projectId: string, sceneId: string): value is LocalDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return (
    draft.version === 1 &&
    draft.projectId === projectId &&
    draft.sceneId === sceneId &&
    typeof draft.text === "string" &&
    typeof draft.revision === "string" &&
    typeof draft.savedAt === "number"
  );
}

export function loadDraft(storage: DraftStorage | null, projectId: string, sceneId: string): LocalDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(draftKey(projectId, sceneId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isDraft(parsed, projectId, sceneId) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveDraft(
  storage: DraftStorage | null,
  projectId: string,
  sceneId: string,
  text: string,
  revision: string,
): boolean {
  if (!storage) return false;
  try {
    const draft: LocalDraft = { version: 1, projectId, sceneId, text, revision, savedAt: Date.now() };
    storage.setItem(draftKey(projectId, sceneId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(storage: DraftStorage | null, projectId: string, sceneId: string): void {
  if (!storage) return;
  try {
    storage.removeItem(draftKey(projectId, sceneId));
  } catch {
    // Storage may be unavailable in private browsing; the live editor still works.
  }
}

/** Preserve a recovery draft and its original base revision across reloads. */
export function restoreDraft(scene: SceneSnapshot, draft: LocalDraft | null): RestoredDraft {
  if (!draft || draft.text === scene.text) {
    return { text: scene.text, revision: scene.revision, restored: false, stale: false };
  }
  return {
    text: draft.text,
    revision: draft.revision,
    restored: true,
    stale: draft.revision !== scene.revision,
  };
}
