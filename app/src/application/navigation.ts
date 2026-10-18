import type { UiMode } from "./contracts";

export const UI_MODE_PREFERENCE_KEY = "scriptorium:ui-mode";

export interface ApplicationResource {
  projectId?: string;
  volumeId?: string;
  chapterId?: string;
  sceneId?: string;
}

export interface ApplicationLocation {
  mode: UiMode;
  resource: ApplicationResource | null;
}

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function isUiMode(value: unknown): value is UiMode {
  return value === "desktop" || value === "mobile";
}

export function readUiModePreference(storage: StorageReader | null = browserStorage()): UiMode | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(UI_MODE_PREFERENCE_KEY);
    return isUiMode(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberUiMode(mode: UiMode, storage: StorageWriter | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(UI_MODE_PREFERENCE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

export function parseApplicationLocation(pathname: string): ApplicationLocation | null {
  const segments = pathname.split("/").filter(Boolean);
  const mode = segments[0];
  if (!isUiMode(mode)) return null;

  const resource: ApplicationResource = {};
  const keys = new Map<string, keyof ApplicationResource>([
    ["projects", "projectId"],
    ["volumes", "volumeId"],
    ["chapters", "chapterId"],
    ["scenes", "sceneId"],
  ]);
  for (let index = 1; index < segments.length; index += 2) {
    const key = keys.get(segments[index]);
    const value = segments[index + 1];
    if (!key || value === undefined) return { mode, resource: null };
    try {
      resource[key] = decodeURIComponent(value);
    } catch {
      return { mode, resource: null };
    }
  }
  return { mode, resource: Object.keys(resource).length > 0 ? resource : null };
}

export function applicationPath(mode: UiMode, resource: ApplicationResource | null = null): string {
  const path = [`/${mode}`];
  if (resource?.projectId) path.push("projects", encodeURIComponent(resource.projectId));
  if (resource?.volumeId) path.push("volumes", encodeURIComponent(resource.volumeId));
  if (resource?.chapterId) path.push("chapters", encodeURIComponent(resource.chapterId));
  if (resource?.sceneId) path.push("scenes", encodeURIComponent(resource.sceneId));
  return path.join("/");
}

export function switchApplicationPath(pathname: string, mode: UiMode): string {
  return applicationPath(mode, parseApplicationLocation(pathname)?.resource ?? null);
}
