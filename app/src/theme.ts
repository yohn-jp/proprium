export type ThemeMode = "light" | "dark" | "paper";

export const THEME_STORAGE_KEY = "arcadia-theme-mode";

export function parseThemeMode(value: unknown): ThemeMode | null {
  return value === "light" || value === "dark" || value === "paper" ? value : null;
}

export function chooseThemeMode(storedValue: unknown, prefersLight: boolean): ThemeMode {
  return parseThemeMode(storedValue) ?? (prefersLight ? "light" : "dark");
}

export function loadThemeMode(): ThemeMode {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // The system preference remains usable when browser storage is unavailable.
  }
  let prefersLight = false;
  try {
    prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  } catch {
    // Match the source fallback when matchMedia is unavailable.
  }
  return chooseThemeMode(stored, prefersLight);
}

export function applyThemeMode(mode: ThemeMode): void {
  document.documentElement.setAttribute("data-zp-theme", mode);
}

export function persistThemeMode(mode: ThemeMode): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  applyThemeMode(mode);
}
