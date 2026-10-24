import { createWorkspacePreset, validateWorkspaceLayout, visiblePanelIds, type WorkspaceLayout, type WorkspacePreset } from "./layout";
import { floatingStorageKey, loadFloatingPanels, validateFloatingPanels, type FloatingPanelLayout } from "./floating";

const MAX_LAYOUT_CHARACTERS = 64 * 1024;
const MAX_WORKSPACE_RECORD_CHARACTERS = MAX_LAYOUT_CHARACTERS + 8 * 1024 + 128;

export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WorkspaceLoad {
  layout: WorkspaceLayout;
  floating: FloatingPanelLayout[];
  state: "missing" | "valid" | "invalid" | "unavailable";
}

export interface WorkspaceLayoutLoad {
  layout: WorkspaceLayout;
  state: WorkspaceLoad["state"];
}

export interface WorkspaceSnapshot {
  layout: WorkspaceLayout;
  floating: FloatingPanelLayout[];
}

export function workspaceStorageKey(scope: string, mode: "desktop" | "mobile"): string {
  return `scriptorium:workspace:v1:${encodeURIComponent(scope)}:${mode}`;
}

/** One localStorage value is the commit point for a complete workspace layout. */
export function workspaceSnapshotStorageKey(scope: string, mode: "desktop" | "mobile"): string {
  return `scriptorium:workspace:v2:${encodeURIComponent(scope)}:${mode}`;
}

function workspacePanelIds(layout: WorkspaceLayout): string[] {
  return [...visiblePanelIds(layout.root), ...layout.hiddenPanelIds];
}

function isWorkspaceSnapshot(value: unknown, mode: "desktop" | "mobile"): value is WorkspaceSnapshot & { version: 2 } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || !["version", "layout", "floating"].every((key) => Object.prototype.hasOwnProperty.call(record, key)) ||
      record.version !== 2 || !validateWorkspaceLayout(record.layout) || !Array.isArray(record.floating)) return false;
  if (mode === "mobile" && record.floating.length !== 0) return false;
  return validateFloatingPanels(record.floating, workspacePanelIds(record.layout), record.layout.hiddenPanelIds);
}

export function loadWorkspaceLayout(
  storage: WorkspaceStorage,
  scope: string,
  mode: "desktop" | "mobile",
  panelIds: string[],
): WorkspaceLayoutLoad {
  const fallback = createWorkspacePreset("writing", panelIds);
  let raw: string | null;
  try {
    raw = storage.getItem(workspaceStorageKey(scope, mode));
  } catch {
    return { layout: fallback, state: "unavailable" };
  }
  if (raw === null) return { layout: fallback, state: "missing" };
  if (raw.length > MAX_LAYOUT_CHARACTERS) return { layout: fallback, state: "invalid" };
  try {
    const value: unknown = JSON.parse(raw);
    return validateWorkspaceLayout(value)
      ? { layout: value, state: "valid" }
      : { layout: fallback, state: "invalid" };
  } catch {
    return { layout: fallback, state: "invalid" };
  }
}

/**
 * Restore one committed layout record. The previous split keys remain readable
 * so existing browser settings can be upgraded by the next explicit save.
 */
export function loadWorkspaceSnapshot(
  storage: WorkspaceStorage,
  scope: string,
  mode: "desktop" | "mobile",
  panelIds: string[],
): WorkspaceLoad {
  const fallback = createWorkspacePreset("writing", panelIds);
  let raw: string | null;
  try {
    raw = storage.getItem(workspaceSnapshotStorageKey(scope, mode));
  } catch {
    return { layout: fallback, floating: [], state: "unavailable" };
  }
  if (raw !== null) {
    if (raw.length > MAX_WORKSPACE_RECORD_CHARACTERS) return { layout: fallback, floating: [], state: "invalid" };
    try {
      const value: unknown = JSON.parse(raw);
      return isWorkspaceSnapshot(value, mode)
        ? { layout: value.layout, floating: value.floating, state: "valid" }
        : { layout: fallback, floating: [], state: "invalid" };
    } catch {
      return { layout: fallback, floating: [], state: "invalid" };
    }
  }

  const legacy = loadWorkspaceLayout(storage, scope, mode, panelIds);
  const floating = mode === "desktop"
    ? loadFloatingPanels(storage, scope, workspacePanelIds(legacy.layout), legacy.layout.hiddenPanelIds)
    : [];
  return { ...legacy, floating };
}

/** Persistence happens only after an explicit user save action. */
export function saveWorkspaceSnapshot(
  storage: WorkspaceStorage,
  scope: string,
  mode: "desktop" | "mobile",
  snapshot: WorkspaceSnapshot,
): boolean {
  const value = { version: 2 as const, layout: snapshot.layout, floating: snapshot.floating };
  if (!isWorkspaceSnapshot(value, mode)) return false;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > MAX_WORKSPACE_RECORD_CHARACTERS) return false;
    storage.setItem(workspaceSnapshotStorageKey(scope, mode), serialized);
    return true;
  } catch {
    return false;
  }
}

/** Persistence happens only after an explicit user save action. */
export function saveWorkspaceLayout(
  storage: WorkspaceStorage,
  scope: string,
  mode: "desktop" | "mobile",
  layout: WorkspaceLayout,
): boolean {
  if (!validateWorkspaceLayout(layout)) return false;
  try {
    const serialized = JSON.stringify(layout);
    if (serialized.length > MAX_LAYOUT_CHARACTERS) return false;
    storage.setItem(workspaceStorageKey(scope, mode), serialized);
    return true;
  } catch {
    return false;
  }
}

export function presetTitle(preset: WorkspacePreset): string {
  switch (preset) {
    case "writing": return "執筆";
    case "research": return "調査";
    case "review": return "レビュー";
    case "custom": return "カスタム";
  }
}
