import { EditorState, Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { diagnosticsMarginExtension, type DiagnosticsMarginMarker, type DiagnosticDecision } from "./diagnosticMargin.js";

declare global {
  interface Window {
    diagnosticsMarginBrowserTest: {
      select: string[];
      decisions: Array<{ fingerprint: string; decision: DiagnosticDecision; trusted: boolean }>;
      view: EditorView;
      clear(): void;
    };
  }
}

const fingerprint = "a".repeat(64);
const revision = "b".repeat(40);
const marker: DiagnosticsMarginMarker = {
  findingFingerprint: fingerprint, message: "🌸の表現を確認してください", severity: "warning",
  path: "manuscript/chapter.md", revision, start: 1, end: 5, quote: "🌸です",
  sourceIdentity: {
    actionId: "proprium.diagnostics.scene.run.v1", repositoryId: 17, branch: "main", generation: "generation-1", snapshot: "snapshot-1",
    findingFingerprint: fingerprint, analyzer: { id: "proprium.diagnostics.cpu", version: "1.0.0" },
    sources: [{ path: markerPath(), fileRevision: revision, span: { start: 1, end: 5 }, quote: "🌸です" }],
  },
};
function markerPath(): string { return "manuscript/chapter.md"; }

const select: string[] = [];
const decisions: Array<{ fingerprint: string; decision: DiagnosticDecision; trusted: boolean }> = [];
const markers = new Compartment();
const view = new EditorView({
  state: EditorState.create({ doc: "前🌸です後", extensions: [markers.of(diagnosticsMarginExtension([marker], {
    onSelect: value => select.push(value),
    onDecision: (event, finding, decision) => decisions.push({ fingerprint: finding.findingFingerprint, decision, trusted: event.isTrusted }),
  }))] }),
  parent: document.querySelector("#editor")!,
});
window.diagnosticsMarginBrowserTest = {
  select,
  decisions,
  view,
  clear() { view.dispatch({ effects: markers.reconfigure(diagnosticsMarginExtension([], { onSelect: () => undefined, onDecision: () => undefined })) }); },
};
document.querySelector("#result")!.textContent = "ready";
