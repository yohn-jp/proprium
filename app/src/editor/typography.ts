export interface TypographySettings {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  fontFamily: "mincho" | "gothic";
}

const STORAGE_KEY = "scriptorium:editor-typography";

const DEFAULTS: TypographySettings = {
  fontSize: 16,
  lineHeight: 1.8,
  letterSpacing: 0,
  fontFamily: "gothic",
};

function bounded(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function normalizeTypographySettings(value: unknown): TypographySettings {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    fontSize: bounded(record.fontSize, 14, 24, DEFAULTS.fontSize),
    lineHeight: bounded(record.lineHeight, 1.4, 2.4, DEFAULTS.lineHeight),
    letterSpacing: bounded(record.letterSpacing, 0, 0.2, DEFAULTS.letterSpacing),
    fontFamily: record.fontFamily === "mincho" || record.fontFamily === "gothic" ? record.fontFamily : DEFAULTS.fontFamily,
  };
}

export function loadTypographySettings(): TypographySettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeTypographySettings(JSON.parse(raw)) : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function storeTypographySettings(settings: TypographySettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Display preferences are best-effort and never block writing.
  }
}
