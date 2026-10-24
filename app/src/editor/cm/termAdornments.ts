import { StateEffect, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { isViewComposing } from "./compositionGuard";
import { findTermSpanAtSelection, selectVisibleTermSlices, validateEditorTermSpans, type EditorTermSpan, type ResolveEditorTerms } from "../terms";

type ResolverRef = { current: ResolveEditorTerms | undefined };
type NavigatorRef = { current: ((targetPath: string, termId: string) => void) | undefined };

const replaceTerms = StateEffect.define<readonly EditorTermSpan[]>();
export const refreshTermAdornments = StateEffect.define<null>();

/** Resolves only deferred, bounded visible source slices and renders disposable CodeMirror marks. */
export function termAdornmentsExtension(resolverRef: ResolverRef, navigatorRef: NavigatorRef): Extension {
  const currentSpans: { current: readonly EditorTermSpan[] } = { current: [] };
  const plugin = ViewPlugin.fromClass(class {
    decorations = Decoration.none;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private controller: AbortController | null = null;
    private generation = 0;
    private composing: boolean;
    private suspended = false;
    private readonly onPageHide = () => {
      this.suspended = true;
      this.cancel();
    };
    private readonly onPageShow = () => {
      if (!this.suspended) return;
      this.suspended = false;
      this.schedule();
    };

    constructor(private readonly view: EditorView) {
      this.composing = isViewComposing(view);
      window.addEventListener("pagehide", this.onPageHide);
      window.addEventListener("pageshow", this.onPageShow);
      this.schedule();
    }

    update(update: ViewUpdate): void {
      for (const transaction of update.transactions) {
        for (const effect of transaction.effects) {
          if (effect.is(replaceTerms)) {
            currentSpans.current = effect.value;
            this.decorations = this.toDecorations(effect.value, update.state.doc);
          }
        }
      }

      const wasComposing = this.composing;
      this.composing = isViewComposing(update.view);
      const needsRefresh = update.docChanged || update.viewportChanged || update.geometryChanged
        || update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(refreshTermAdornments)));
      if (this.composing) {
        if (!wasComposing || needsRefresh) this.cancel();
        return;
      }
      if (wasComposing || needsRefresh) {
        currentSpans.current = [];
        this.decorations = Decoration.none;
        this.cancel();
        this.schedule();
      }
    }

    destroy(): void {
      window.removeEventListener("pagehide", this.onPageHide);
      window.removeEventListener("pageshow", this.onPageShow);
      this.cancel();
    }

    private cancel(): void {
      this.generation += 1;
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.controller?.abort();
      this.controller = null;
    }

    private schedule(): void {
      const resolver = resolverRef.current;
      if (this.suspended || this.composing || !resolver) return;
      const generation = this.generation;
      const controller = new AbortController();
      this.controller = controller;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (!this.view.dom.isConnected || this.view.dom.getClientRects().length === 0) {
          controller.abort();
          if (this.controller === controller) this.controller = null;
          return;
        }
        void this.resolveVisible(this.view, resolver, controller, generation);
      }, 80);
    }

    private async resolveVisible(
      view: EditorView,
      resolver: ResolveEditorTerms,
      controller: AbortController,
      generation: number,
    ): Promise<void> {
      const document = view.state.doc;
      const slices = selectVisibleTermSlices(view.visibleRanges, document.length);
      const results: EditorTermSpan[] = [];
      try {
        for (const slice of slices) {
          if (controller.signal.aborted) return;
          const source = document.sliceString(slice.from, slice.to);
          const spans = validateEditorTermSpans(source, await resolver(source, controller.signal));
          if (!this.isCurrent(view, document, resolver, controller, generation)) return;
          results.push(...spans.map((span) => ({ ...span, start: span.start + slice.from, end: span.end + slice.from })));
        }
        if (this.isCurrent(view, document, resolver, controller, generation)) {
          view.dispatch({ effects: replaceTerms.of(results) });
        }
      } catch {
        // Optional terminology failures do not interrupt editing or alter the Markdown source.
      }
    }

    private isCurrent(
      view: EditorView,
      document: EditorView["state"]["doc"],
      resolver: ResolveEditorTerms,
      controller: AbortController,
      generation: number,
    ): boolean {
      return !this.composing && resolverRef.current === resolver && !controller.signal.aborted
        && this.generation === generation && view.state.doc === document;
    }

    private toDecorations(spans: readonly EditorTermSpan[], document: EditorView["state"]["doc"]) {
      const ranges = spans
        .filter((span) => span.start >= 0 && span.end > span.start && span.end <= document.length)
        .map((span) => {
          const attributes: Record<string, string> = {
            "data-term-id": span.termId,
            "data-term-target": span.targetPath,
          };
          if (navigatorRef.current) {
            attributes.role = "link";
            attributes["aria-label"] = `${document.sliceString(span.start, span.end)} 用語リンク。Control または Command + Enter で開く`;
            attributes["aria-keyshortcuts"] = "Control+Enter Meta+Enter";
          }
          return Decoration.mark({
            class: "cm-term-adornment",
            attributes,
          }).range(span.start, span.end);
        });
      return Decoration.set(ranges, true);
    }
  }, {
    decorations: (plugin) => plugin.decorations,
  });

  return [
    plugin,
    keymap.of([{
      key: "Mod-Enter",
      run(view) {
        if (isViewComposing(view)) return false;
        const selection = view.state.selection.main;
        const span = findTermSpanAtSelection(currentSpans.current, { from: selection.from, to: selection.to });
        if (!span || !navigatorRef.current) return false;
        navigatorRef.current(span.targetPath, span.termId);
        return true;
      },
    }]),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || (!event.ctrlKey && !event.metaKey) || isViewComposing(view)) return false;
        const mark = termMarkFromTarget(event.target);
        const termId = mark?.dataset.termId;
        const targetPath = mark?.dataset.termTarget;
        const navigate = navigatorRef.current;
        if (!termId || !targetPath || !navigate) return false;
        event.preventDefault();
        navigate(targetPath, termId);
        return true;
      },
    }),
  ];
}

function termMarkFromTarget(target: EventTarget | null): HTMLElement | null {
  if (target instanceof Element) return target.closest<HTMLElement>(".cm-term-adornment");
  if (target instanceof Node) return target.parentElement?.closest<HTMLElement>(".cm-term-adornment") ?? null;
  return null;
}
