/**
 * Horizontal navigation is an optional shortcut. Buttons and browser history
 * remain authoritative, and the editor/reading/scrolling surfaces own touch.
 */
export interface SwipeSample {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  viewportWidth: number;
}
export type SwipeDirection = "previous" | "next";

export function classifyPageSwipe(sample: SwipeSample): SwipeDirection | null {
  const { startX, startY, endX, endY, viewportWidth } = sample;
  if (![startX, startY, endX, endY, viewportWidth].every(Number.isFinite) || viewportWidth <= 0) return null;
  // Reserve iOS Safari's system back/forward edge gestures.
  if (startX < 32 || startX > viewportWidth - 32) return null;
  const dx = endX - startX, dy = endY - startY;
  if (Math.abs(dx) < 72 || Math.abs(dx) < Math.abs(dy) * 1.6) return null;
  return dx > 0 ? "previous" : "next";
}

/** A swipe may not steal input, selection, horizontal scrolling or a button. */
export function isPageSwipeSurface(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(
    'input, textarea, select, button, a, summary, [role="button"], [role="tab"], ' +
    '[contenteditable], .cm-editor, .manuscript-column, .reading-view, .reading-pager-content, ' +
    '.file-tree, .file-list, .st-workspace-mobile-tabs, .mobile-shell-reference-modal, ' +
    '.st-workspace-panel-menu, [data-no-page-swipe]'
  )) return false;
  let ancestor: Element | null = target;
  while (ancestor) {
    const el = ancestor as HTMLElement;
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      const overflow = getComputedStyle(el).overflowX;
      if (overflow === "auto" || overflow === "scroll") return false;
    }
    ancestor = ancestor.parentElement;
  }
  return true;
}
