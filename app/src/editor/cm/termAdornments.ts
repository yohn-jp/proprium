import { StateEffect, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { isViewComposing } from "./compositionGuard";
import { selectVisibleTermSlices, validateEditorTermSpans, type EditorTermSpan, type ResolveEditorTerms } from "../terms";

type ResolverRef = { current: ResolveEditorTerms | undefined };

const replaceTerms = StateEffect.define<readonly EditorTermSpan[]>();
export const refreshTermAdornments = StateEffect.define<null>();

/** Resolves only deferred, bounded visible source slices and renders disposable CodeMirror marks. */
export function termAdornmentsExtension(resolverRef: ResolverRef): Extension {
  return ViewPlugin.fromClass(class {
    decorations = Decoration.none;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private controller: AbortController | null = null;
    private generation = 0;
    private composing: boolean;

    constructor(private readonly view: EditorView) {
      this.composing = isViewComposing(view);
      this.schedule();
    }

    update(update: ViewUpdate): void {
      for (const transaction of update.transactions) {
        for (const effect of transaction.effects) {
          if (effect.is(replaceTerms)) this.decorations = this.toDecorations(effect.value, update.state.doc.length);
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
        this.decorations = Decoration.none;
        this.cancel();
        this.schedule();
      }
    }

    destroy(): void {
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
      if (this.composing || !resolver || !this.view.dom.isConnected || this.view.dom.getClientRects().length === 0) return;
      const generation = this.generation;
      const controller = new AbortController();
      this.controller = controller;
      this.timer = setTimeout(() => {
        this.timer = null;
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

    private toDecorations(spans: readonly EditorTermSpan[], documentLength: number) {
      const ranges = spans
        .filter((span) => span.start >= 0 && span.end > span.start && span.end <= documentLength)
        .map((span) => Decoration.mark({
          class: "cm-term-adornment",
          attributes: { "data-term-id": span.termId, "data-term-target": span.targetPath },
        }).range(span.start, span.end));
      return Decoration.set(ranges, true);
    }
  }, {
    decorations: (plugin) => plugin.decorations,
  });
}
