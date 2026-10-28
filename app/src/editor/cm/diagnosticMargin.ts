import { gutter, GutterMarker, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

export type DiagnosticDecision = "intentional" | "false_positive";

/** The Host-normalized, current-file projection of one Diagnostics finding. */
export interface DiagnosticsMarginMarker {
  findingFingerprint: string;
  message: string;
  severity: "error" | "warning" | "info";
  path: string;
  revision: string;
  start: number;
  end: number;
  quote: string;
  sourceIdentity: Readonly<Record<string, unknown>>;
}

export interface DiagnosticsMarginCallbacks {
  onSelect(findingFingerprint: string): void;
  onDecision(event: Event, finding: DiagnosticsMarginMarker, decision: DiagnosticDecision): void;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identityMatches(marker: DiagnosticsMarginMarker): boolean {
  const identity = marker.sourceIdentity;
  if (identity.findingFingerprint !== marker.findingFingerprint ||
      typeof identity.actionId !== "string" || !identity.actionId.startsWith("proprium.diagnostics.") ||
      !(typeof identity.repositoryId === "number" && Number.isSafeInteger(identity.repositoryId) && identity.repositoryId > 0 || identity.repositoryId === null) ||
      typeof identity.branch !== "string" || !identity.branch || typeof identity.generation !== "string" || !identity.generation ||
      typeof identity.snapshot !== "string" || !identity.snapshot || !record(identity.analyzer) ||
      typeof identity.analyzer.id !== "string" || typeof identity.analyzer.version !== "string" || !Array.isArray(identity.sources)) return false;
  return identity.sources.some(source => record(source) && source.path === marker.path && source.fileRevision === marker.revision &&
    source.quote === marker.quote && record(source.span) && source.span.start === marker.start && source.span.end === marker.end);
}

/** Reject stale or malformed guest data before a marker reaches the CodeMirror gutter. */
export function currentDiagnosticsMarginMarkers(
  markers: readonly DiagnosticsMarginMarker[],
  document: string,
  active: { readonly path: string; readonly revision: string },
): DiagnosticsMarginMarker[] {
  if (!active.path || !active.revision) return [];
  return markers.filter(marker => marker.path === active.path && marker.revision === active.revision &&
    /^[a-f0-9]{64}$/u.test(marker.findingFingerprint) && marker.message.length > 0 && marker.message.length <= 4000 &&
    ["error", "warning", "info"].includes(marker.severity) && Number.isSafeInteger(marker.start) && Number.isSafeInteger(marker.end) &&
    marker.start >= 0 && marker.end > marker.start && marker.end <= document.length && marker.quote.length > 0 &&
    marker.quote.length <= 4000 && document.slice(marker.start, marker.end) === marker.quote && identityMatches(marker))
    .sort((left, right) => left.start - right.start || left.findingFingerprint.localeCompare(right.findingFingerprint));
}

class FindingMarker extends GutterMarker {
  constructor(
    readonly marker: DiagnosticsMarginMarker,
    readonly onSelect: DiagnosticsMarginCallbacks["onSelect"],
    readonly onDecision: DiagnosticsMarginCallbacks["onDecision"],
  ) { super(); }

  eq(other: GutterMarker): boolean {
    return other instanceof FindingMarker && other.marker.findingFingerprint === this.marker.findingFingerprint &&
      other.marker.message === this.marker.message && other.marker.severity === this.marker.severity &&
      other.marker.start === this.marker.start && other.marker.end === this.marker.end && other.marker.quote === this.marker.quote &&
      JSON.stringify(other.marker.sourceIdentity) === JSON.stringify(this.marker.sourceIdentity);
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("span");
    root.className = `cm-diagnostic-margin-marker cm-diagnostic-margin-${this.marker.severity}`;
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "文章の診断シグナル");

    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "cm-diagnostic-margin-jump";
    jump.textContent = "!";
    jump.setAttribute("aria-label", `診断箇所を選択: ${this.marker.message.slice(0, 180)}`);
    jump.title = this.marker.message;
    jump.addEventListener("mousedown", event => event.preventDefault());
    jump.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (view.state.doc.sliceString(this.marker.start, this.marker.end) !== this.marker.quote) return;
      view.dispatch({
        selection: { anchor: this.marker.start, head: this.marker.end },
        effects: EditorView.scrollIntoView(this.marker.start, { y: "center" }),
      });
      view.focus();
      this.onSelect(this.marker.findingFingerprint);
    });

    const intentional = this.decisionButton(view, "intentional", "意図した警告としてレビューする");
    const falsePositive = this.decisionButton(view, "false_positive", "誤検出としてレビューする");
    root.append(jump, intentional, falsePositive);
    return root;
  }

  private decisionButton(view: EditorView, decision: DiagnosticDecision, label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `cm-diagnostic-margin-decision cm-diagnostic-margin-decision-${decision}`;
    button.textContent = decision === "intentional" ? "意図" : "誤検出";
    button.setAttribute("aria-label", `${label}: ${this.marker.message.slice(0, 180)}`);
    button.addEventListener("mousedown", event => event.preventDefault());
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (view.state.doc.sliceString(this.marker.start, this.marker.end) !== this.marker.quote) return;
      this.onDecision(event, this.marker, decision);
    });
    return button;
  }

  ignoreEvent(): boolean { return true; }
}

/** CodeMirror hides all gutter content from assistive technology by default. */
class AccessibleFindingGutter {
  private readonly originalAttributes = new Map<HTMLElement, string | null>();

  constructor(private readonly view: EditorView) { this.expose(); }

  update(_update: ViewUpdate): void { this.expose(); }

  destroy(): void {
    for (const [gutterElement, original] of this.originalAttributes) {
      if (!gutterElement.isConnected) continue;
      if (original === null) gutterElement.removeAttribute("aria-hidden");
      else gutterElement.setAttribute("aria-hidden", original);
    }
  }

  private expose(): void {
    const element = this.view.dom.querySelector<HTMLElement>(".cm-gutters");
    if (!element || element.getAttribute("aria-hidden") === "false") return;
    if (!this.originalAttributes.has(element)) this.originalAttributes.set(element, element.getAttribute("aria-hidden"));
    element.setAttribute("aria-hidden", "false");
  }
}

const accessibleFindingGutter = ViewPlugin.fromClass(AccessibleFindingGutter);

/** Adds source-bound finding controls in CodeMirror's line gutter, never in manuscript text. */
export function diagnosticsMarginExtension(
  markers: readonly DiagnosticsMarginMarker[],
  callbacks: DiagnosticsMarginCallbacks,
) {
  const byDocument = new WeakMap<object, Map<number, DiagnosticsMarginMarker[]>>();
  const active = { path: markers[0]?.path ?? "", revision: markers[0]?.revision ?? "" };
  const lineEntries = (view: EditorView): Map<number, DiagnosticsMarginMarker[]> => {
    const document = view.state.doc;
    const cached = byDocument.get(document);
    if (cached) return cached;
    const index = new Map<number, DiagnosticsMarginMarker[]>();
    for (const marker of currentDiagnosticsMarginMarkers(markers, document.toString(), active)) {
      const line = document.lineAt(marker.start).from;
      const group = index.get(line) ?? [];
      group.push(marker);
      index.set(line, group);
    }
    byDocument.set(document, index);
    return index;
  };
  const extensions = [gutter({
    class: "cm-diagnostic-gutter",
    lineMarker(view, line) {
      const match = lineEntries(view).get(line.from)?.[0];
      return match ? new FindingMarker(match, callbacks.onSelect, callbacks.onDecision) : null;
    },
  }), EditorView.baseTheme({
    ".cm-diagnostic-gutter": { width: "2.6rem" },
    ".cm-diagnostic-margin-marker": { display: "flex", gap: "0.1rem", alignItems: "center", justifyContent: "center", minWidth: "2.4rem" },
    ".cm-diagnostic-margin-marker button": { border: "0", borderRadius: "0.25rem", padding: "0.1rem 0.2rem", font: "inherit", fontSize: "0.68rem", background: "var(--surface-subtle, #eee)", color: "var(--text-primary, #222)", cursor: "pointer" },
    ".cm-diagnostic-margin-marker button:focus-visible": { outline: "2px solid currentColor", outlineOffset: "1px" },
    ".cm-diagnostic-margin-error .cm-diagnostic-margin-jump": { color: "var(--diagnostic-error, #a00)", fontWeight: "700" },
    ".cm-diagnostic-margin-warning .cm-diagnostic-margin-jump": { color: "var(--diagnostic-warning, #765300)", fontWeight: "700" },
    ".cm-diagnostic-margin-info .cm-diagnostic-margin-jump": { color: "var(--diagnostic-info, #145b80)", fontWeight: "700" },
  })];
  if (markers.length) extensions.push(accessibleFindingGutter);
  return extensions;
}
