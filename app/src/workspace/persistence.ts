import { createWorkspacePreset, validateWorkspaceLayout, type WorkspaceLayout, type WorkspacePreset } from "./layout";

const MAX_LAYOUT_CHARACTERS = 64 * 1024;

export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface WorkspaceLoad {
  layout: WorkspaceLayout;
  state: "missing" | "valid" | "invalid" | "unavailable";
}

export function workspaceStorageKey(scope: string, mode: "desktop" | "mobile"): string {
  return `scriptorium:workspace:v1:${encodeURIComponent(scope)}:${mode}`;
}

export function loadWorkspaceLayout(
  storage: WorkspaceStorage,
  scope: string,
  mode: "desktop" | "mobile",
  panelIds: string[],
): WorkspaceLoad {
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
