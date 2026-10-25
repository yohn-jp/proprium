/** Source manuscriptPageMetrics behavior retained for the mobile reader. */
export const READING_TAP_ZONE_PX = 44;

export function measureColumnPageCount(scrollWidth: number, pageWidth: number): number {
  if (pageWidth <= 0) return 1;
  return Math.max(1, Math.ceil((scrollWidth - 0.5) / pageWidth));
}

export function clampPageIndex(pageIndex: number, pageCount: number): number {
  if (pageCount <= 1 || !Number.isFinite(pageIndex)) return 0;
  return Math.max(0, Math.min(Math.trunc(pageIndex), pageCount - 1));
}

export function pageTranslateX(pageIndex: number, pageWidth: number, direction: "ltr" | "rtl"): number {
  const index = Number.isFinite(pageIndex) ? Math.max(0, Math.trunc(pageIndex)) : 0;
  if (index === 0 || pageWidth <= 0) return 0;
  return direction === "rtl" ? index * pageWidth : -index * pageWidth;
}

export function tapZoneAtX(clientX: number, left: number, width: number, zone = READING_TAP_ZONE_PX): "left" | "center" | "right" {
  const x = clientX - left;
  if (x < zone) return "left";
  if (x > width - zone) return "right";
  return "center";
}
