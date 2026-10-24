import { useEffect, useRef, useState } from "react";
import { RubyText } from "./ruby";
import { selectPendingTermLines, validateEditorTermSpans, type EditorTermSpan, type ResolveEditorTerms } from "./terms";

const MAX_VISIBLE_LINE_CHARS = 4_096;
const MAX_ACTIVE_LINES = 8;

/** Resolves cancellable visible reading lines and renders accessible, source-preserving links. */
export function TermAwareRubyText({
  text,
  resolveTerms,
  onTermNavigate,
}: {
  text: string;
  resolveTerms?: ResolveEditorTerms;
  onTermNavigate?: (targetPath: string, termId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const generationRef = useRef(0);
  const previousTextRef = useRef(text);
  if (previousTextRef.current !== text) {
    previousTextRef.current = text;
    generationRef.current += 1;
  }
  const generation = generationRef.current;
  const [termState, setTermState] = useState<{ generation: number; lines: ReadonlyMap<number, readonly EditorTermSpan[]> }>(() => ({ generation, lines: new Map() }));
  const spans = termState.generation === generation ? [...termState.lines.values()].flat() : [];

  useEffect(() => {
    setTermState({ generation, lines: new Map() });
    const container = containerRef.current;
    const root = container?.closest<HTMLElement>(".reading-pager");
    if (!container || !root || !resolveTerms || !onTermNavigate || typeof IntersectionObserver === "undefined") return;

    let disposed = false;
    let suspended = false;
    const visibleLines = new Map<number, HTMLParagraphElement>();
    const active = new Map<number, { controller: AbortController; timer: ReturnType<typeof setTimeout> }>();
    const completed = new Set<number>();

    const removeTerms = (lineStart: number) => {
      setTermState((current) => {
        if (current.generation !== generation || !current.lines.has(lineStart)) return current;
        const next = new Map(current.lines);
        next.delete(lineStart);
        return { generation, lines: next };
      });
    };

    const pump = () => {
      if (disposed || suspended) return;
      const pending = selectPendingTermLines([...visibleLines.keys()], new Set(active.keys()), completed, MAX_ACTIVE_LINES);
      for (const lineStart of pending) {
        const element = visibleLines.get(lineStart);
        if (!element) continue;
        const sourceStart = Number(element.dataset.sourceStart);
        const sourceEnd = Number(element.dataset.sourceEnd);
        if (!Number.isInteger(sourceStart) || !Number.isInteger(sourceEnd) || sourceEnd <= sourceStart) continue;
        const excerptEnd = Math.min(sourceEnd, sourceStart + MAX_VISIBLE_LINE_CHARS);
        const excerpt = text.slice(sourceStart, excerptEnd);
        const controller = new AbortController();
        const timer = setTimeout(() => {
          void Promise.resolve().then(() => resolveTerms(excerpt, controller.signal)).then((results) => {
            if (disposed || generationRef.current !== generation || controller.signal.aborted || visibleLines.get(lineStart) !== element) return;
            const valid = validateEditorTermSpans(excerpt, results).map((span) => ({
              ...span,
              start: span.start + sourceStart,
              end: span.end + sourceStart,
            }));
            setTermState((current) => current.generation === generation
              ? { generation, lines: new Map(current.lines).set(lineStart, valid) }
              : current);
          }).catch(() => {
            // Optional terminology failures do not affect reading or editing.
          }).finally(() => {
            if (active.get(lineStart)?.controller !== controller) return;
            active.delete(lineStart);
            if (!disposed && !controller.signal.aborted && visibleLines.get(lineStart) === element) completed.add(lineStart);
            pump();
          });
        }, 40);
        active.set(lineStart, { controller, timer });
        if (active.size >= MAX_ACTIVE_LINES) break;
      }
    };

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const element = entry.target as HTMLParagraphElement;
        const lineStart = Number(element.dataset.sourceStart);
        if (!Number.isInteger(lineStart)) continue;
        if (entry.isIntersecting) {
          visibleLines.set(lineStart, element);
        } else {
          visibleLines.delete(lineStart);
          completed.delete(lineStart);
          const request = active.get(lineStart);
          if (request) {
            clearTimeout(request.timer);
            request.controller.abort();
            active.delete(lineStart);
          }
          removeTerms(lineStart);
        }
      }
      pump();
    }, { root, rootMargin: "48px 0px" });

    const cancelActive = () => {
      for (const request of active.values()) {
        clearTimeout(request.timer);
        request.controller.abort();
      }
      active.clear();
    };
    const onPageHide = () => {
      suspended = true;
      cancelActive();
    };
    const onPageShow = () => {
      if (!suspended) return;
      suspended = false;
      pump();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    for (const line of container.querySelectorAll<HTMLParagraphElement>("[data-source-start][data-source-end]")) observer.observe(line);
    return () => {
      disposed = true;
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      observer.disconnect();
      cancelActive();
      visibleLines.clear();
    };
  }, [generation, text, resolveTerms, onTermNavigate]);

  return (
    <div ref={containerRef}>
      <RubyText text={text} termSpans={spans} onTermNavigate={onTermNavigate} />
    </div>
  );
}
