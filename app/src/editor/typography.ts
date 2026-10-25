export interface TypographySettings {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  maxWidth: number;
  fontFamily: "mincho" | "gothic";
}

export type TypographyPresetId = "bunko" | "web-novel" | "genko";

export const TYPOGRAPHY_PRESETS: Record<TypographyPresetId, { label: string; values: Pick<TypographySettings, "lineHeight" | "letterSpacing" | "maxWidth" | "fontFamily"> }> = {
  bunko: { label: "文庫風", values: { fontFamily: "mincho", lineHeight: 1.7, maxWidth: 560, letterSpacing: 0.02 } },
  "web-novel": { label: "Web小説風", values: { fontFamily: "gothic", lineHeight: 2, maxWidth: 720, letterSpacing: 0 } },
  genko: { label: "原稿用紙風", values: { fontFamily: "mincho", lineHeight: 2.2, maxWidth: 480, letterSpacing: 0.04 } },
};

const STORAGE_KEY = "scriptorium:editor-typography";

const DEFAULTS: TypographySettings = {
  fontSize: 16,
  lineHeight: 1.8,
  letterSpacing: 0,
  maxWidth: 960,
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
    maxWidth: bounded(record.maxWidth, 480, 960, DEFAULTS.maxWidth),
    fontFamily: record.fontFamily === "mincho" || record.fontFamily === "gothic" ? record.fontFamily : DEFAULTS.fontFamily,
  };
}

export function typographyPresetValues(id: TypographyPresetId): Pick<TypographySettings, "lineHeight" | "letterSpacing" | "maxWidth" | "fontFamily"> {
  return { ...TYPOGRAPHY_PRESETS[id].values };
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
