import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clampPageIndex, measureColumnPageCount, pageTranslateX, READING_TAP_ZONE_PX, tapZoneAtX } from "./readingMetrics";

/** Mobile horizontal/vertical paged reader with source swipe and edge-tap behavior. */
export function MobileReadingPager({
  children,
  mode,
  pageIndex,
  onPageIndexChange,
}: {
  children: ReactNode;
  mode: "horizontal" | "vertical";
  pageIndex: number;
  onPageIndexChange: (page: number) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pageIndexRef = useRef(pageIndex);
  const pageCountRef = useRef(1);
  const gestureRef = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const [pageWidth, setPageWidth] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  pageIndexRef.current = pageIndex;
  pageCountRef.current = pageCount;

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const width = viewport.clientWidth;
    if (width <= 0) return;
    setPageWidth(width);
    if (!isMobile) {
      pageCountRef.current = 1;
      setPageCount(1);
      return;
    }
    content.style.setProperty("--reading-page-width", `${width}px`);
    const count = measureColumnPageCount(content.scrollWidth, width);
    pageCountRef.current = count;
    setPageCount(count);
    const clamped = clampPageIndex(pageIndexRef.current, count);
    if (clamped !== pageIndexRef.current) onPageIndexChange(clamped);
  }, [isMobile, onPageIndexChange]);

  useLayoutEffect(() => measure(), [measure, children, mode]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setIsMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const turn = useCallback((direction: "next" | "previous") => {
    const current = pageIndexRef.current;
    const next = direction === "next" ? Math.min(pageCountRef.current - 1, current + 1) : Math.max(0, current - 1);
    if (next !== current) onPageIndexChange(next);
  }, [onPageIndexChange]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    const edge = 20;
    if (event.clientX <= edge || event.clientX >= window.innerWidth - edge) return;
    gestureRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (Math.hypot(dx, dy) < 12) return;
    gesture.moved = true;
    if (Math.abs(dx) < Math.abs(dy) * 1.25) {
      gestureRef.current = null;
      setDragging(false);
      return;
    }
    event.preventDefault();
    setDragging(true);
    setDragOffset(dx);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    gestureRef.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    setDragging(false);
    setDragOffset(0);
    if (gesture.moved) {
      const dx = event.clientX - gesture.x;
      if (Math.abs(dx) >= 56) turn(dx < 0 ? "next" : "previous");
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const zone = tapZoneAtX(event.clientX, rect.left, rect.width);
    if (zone === "center") setChromeVisible((visible) => !visible);
    else turn(zone === (mode === "vertical" ? "left" : "right") ? "next" : "previous");
  };

  const pageOffset = isMobile ? pageTranslateX(pageIndex, pageWidth, mode === "vertical" ? "rtl" : "ltr") : 0;
  return (
    <div
      ref={viewportRef}
      className={`reading-pager ${chromeVisible ? "" : "is-chrome-hidden"}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      data-page-index={pageIndex}
      data-page-count={pageCount}
      aria-label={`読書ページ ${pageIndex + 1} / ${pageCount}`}
    >
      <div
        ref={contentRef}
        className={`reading-pager-content ${mode === "vertical" ? "is-vertical" : "is-horizontal"}`}
        style={{
          transform: `translateX(${pageOffset + (dragging ? dragOffset : 0)}px)`,
          transition: dragging ? "none" : "transform 180ms ease-out",
          "--reading-page-width": pageWidth > 0 ? `${pageWidth}px` : "100%",
        } as CSSProperties}
      >
        {children}
      </div>
      <p className="reading-page-count" aria-live="polite">{pageIndex + 1} / {pageCount}</p>
      <span className="reading-tap-zone is-left" aria-hidden="true" />
      <span className="reading-tap-zone is-right" aria-hidden="true" />
      <button type="button" className="reading-page-control is-previous" onClick={() => turn("previous")} aria-label="前のページ" disabled={pageIndex <= 0}>‹</button>
      <button type="button" className="reading-page-control is-next" onClick={() => turn("next")} aria-label="次のページ" disabled={pageIndex >= pageCount - 1}>›</button>
      <span className="sr-only">画面の中央をタップするとページ表示を切り替えます。</span>
    </div>
  );
}
