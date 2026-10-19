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
  let url: URL;
  try {
    url = new URL(pathname, "http://scriptorium.invalid");
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const mode = segments[0];
  if (!isUiMode(mode)) return null;

  const resource: ApplicationResource = {};
  if (segments[1] === "projects" && segments[2] !== undefined) {
    try {
      resource.projectId = decodeURIComponent(segments[2]);
      if (segments[3] === "scenes" && segments[4] !== undefined) {
        resource.sceneId = decodeURIComponent(segments[4]);
      }
    } catch {
      return { mode, resource: null };
    }
  }
  const volumeId = url.searchParams.get("volume");
  const chapterId = url.searchParams.get("chapter");
  const projectId = url.searchParams.get("project");
  const sceneId = url.searchParams.get("scene");
  if (volumeId) resource.volumeId = volumeId;
  if (chapterId) resource.chapterId = chapterId;
  if (!resource.projectId && projectId) resource.projectId = projectId;
  if (!resource.sceneId && sceneId) resource.sceneId = sceneId;
  return { mode, resource: Object.keys(resource).length > 0 ? resource : null };
}

export function applicationPath(mode: UiMode, resource: ApplicationResource | null = null, currentSearch = ""): string {
  const path = resource?.projectId
    ? `/${mode}/projects/${encodeURIComponent(resource.projectId)}${resource.sceneId ? `/scenes/${encodeURIComponent(resource.sceneId)}` : ""}`
    : `/${mode}/`;
  const query = new URLSearchParams(currentSearch);
  for (const key of ["project", "scene", "volume", "chapter"]) query.delete(key);
  if (resource?.volumeId) query.set("volume", resource.volumeId);
  if (resource?.chapterId) query.set("chapter", resource.chapterId);
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

export function switchApplicationPath(pathname: string, mode: UiMode): string {
  let search = "";
  const resource = parseApplicationLocation(pathname)?.resource ?? null;
  try {
    const params = new URL(pathname, "http://scriptorium.invalid").searchParams;
    if (mode === "mobile") params.set("view", resource?.sceneId ? "writing" : "library");
    else params.delete("view");
    search = params.toString();
  } catch {
    // The pathname parser below will return no resource for malformed input.
  }
  return applicationPath(mode, resource, search);
}
