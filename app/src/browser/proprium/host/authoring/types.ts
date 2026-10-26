import type { ActionBinding, SurfaceDeclaration } from "../../authoring/types.js";

/** JSON accepted at the boundary between a signed authoring manifest and the Host UI. */
export type AuthoringJson = null | boolean | number | string | AuthoringJson[] | { [key: string]: AuthoringJson };

export interface AuthoringDataKey {
  readonly data_key: string;
}

export type AuthoringTemplate = AuthoringJson | AuthoringDataKey;

export type AuthoringActionBinding = Omit<ActionBinding, "input_template"> & {
  readonly input_template: { readonly [key: string]: AuthoringTemplate };
};

export interface AuthoringNavigationTemplate {
  readonly target: { readonly [key: string]: AuthoringTemplate };
  readonly intent: "open" | "reveal";
}

export interface AuthoringNavigationTarget {
  readonly path?: string;
  readonly panel_id?: string;
  readonly span?: {
    readonly path?: string;
    readonly revision?: string;
    readonly start: number;
    readonly end: number;
    readonly quote?: string;
  };
}

export type AuthoringSurfaceKind = "panel" | "command";
export type AuthoringWidgetKind =
  | "outline" | "list" | "table" | "detail" | "form" | "tabs" | "status" | "progress"
  | "evidence" | "diff" | "graph" | "map" | "timeline";

export type AuthoringSurfaceDeclaration = Omit<SurfaceDeclaration, "kind" | "context" | "body"> & {
  readonly kind: AuthoringSurfaceKind;
  readonly context: Readonly<Record<string, unknown>>;
  readonly body: AuthoringWidget;
};

export interface AuthoringLoadAction extends AuthoringActionBinding {
  readonly key: string;
}

export interface AuthoringWidgetBase {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  /** Reads run only after the author explicitly presses the Host refresh button. */
  readonly load_action?: AuthoringActionBinding;
  /** Explicit named reads for surfaces that need more than one pinned source result. */
  readonly load_actions?: readonly AuthoringLoadAction[];
}

interface AuthoringFieldBase {
  readonly id: string;
  readonly label: string;
  readonly required?: boolean;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly placeholder?: string;
  readonly min_length?: number;
  readonly max_length?: number;
  readonly validation_message?: string;
  readonly initial_value?: AuthoringTemplate;
}

export type AuthoringScalarField = AuthoringFieldBase & {
  readonly type: "string" | "integer" | "boolean" | "enum" | "multi-reference" | "ordered-list";
};

/** Ordered rows retain every unknown source key while exposing only declared editable fields. */
export type AuthoringField = AuthoringScalarField | (AuthoringFieldBase & {
  readonly type: "record-list";
  readonly fields: readonly AuthoringScalarField[];
  readonly initial_value?: AuthoringTemplate;
  readonly key_field?: string;
  readonly min_items?: number;
  readonly max_items?: number;
});

export interface AuthoringOutlineRow {
  readonly id: string;
  readonly title: string;
  readonly kind?: string;
  readonly path?: string;
  readonly children?: readonly AuthoringOutlineRow[];
  readonly action?: AuthoringActionBinding;
  readonly navigation?: AuthoringNavigationTemplate;
}

export interface AuthoringColumn {
  readonly key: string;
  readonly label: string;
}

export type AuthoringPrintPreset = "bunko" | "web-novel" | "genko";
export interface AuthoringArtifactMetadata {
  readonly filename: string;
  readonly media_type: string;
  readonly bytes: number;
  readonly sha256: string;
}
/** Host-only callbacks bound to a verified sealed artifact receipt. */
export interface AuthoringHostArtifact {
  readonly metadata: AuthoringArtifactMetadata;
  readonly text_preview_available: boolean;
  previewText(maxChars: number): Promise<{ readonly text: string; readonly truncated: boolean }>;
  download(event: Event): Promise<void>;
  print(event: Event, preset: AuthoringPrintPreset): Promise<void>;
}

export interface AuthoringInvocationOutput {
  readonly action_result: import("../../authoring/types.js").ActionResult;
  readonly artifact?: AuthoringHostArtifact;
}

export type AuthoringWidget =
  | (AuthoringWidgetBase & { readonly type: "outline"; readonly items: AuthoringTemplate; readonly activate?: AuthoringActionBinding; readonly next_action?: AuthoringActionBinding; readonly previous_action?: AuthoringActionBinding; readonly next_action_when?: AuthoringDataKey; readonly previous_action_when?: AuthoringDataKey })
  | (AuthoringWidgetBase & { readonly type: "list"; readonly items: AuthoringTemplate; readonly primary: string; readonly secondary?: string; readonly item_action?: AuthoringActionBinding; readonly item_navigation?: AuthoringNavigationTemplate; readonly next_action?: AuthoringActionBinding; readonly previous_action?: AuthoringActionBinding; readonly next_action_when?: AuthoringDataKey; readonly previous_action_when?: AuthoringDataKey })
  | (AuthoringWidgetBase & { readonly type: "table"; readonly rows: AuthoringTemplate; readonly columns: readonly AuthoringColumn[]; readonly next_action?: AuthoringActionBinding; readonly previous_action?: AuthoringActionBinding; readonly next_action_when?: AuthoringDataKey; readonly previous_action_when?: AuthoringDataKey })
  | (AuthoringWidgetBase & { readonly type: "detail"; readonly value: AuthoringTemplate; readonly fields?: readonly { readonly key: string; readonly label: string }[] })
  | (AuthoringWidgetBase & { readonly type: "form"; readonly fields: readonly AuthoringField[]; readonly submit: AuthoringActionBinding; readonly cancel_action?: AuthoringActionBinding })
  | (AuthoringWidgetBase & { readonly type: "tabs"; readonly tabs: readonly { readonly id: string; readonly title: string; readonly body: AuthoringWidget }[] })
  | (AuthoringWidgetBase & { readonly type: "status"; readonly state: AuthoringTemplate; readonly messages?: Readonly<Record<string, string>> })
  | (AuthoringWidgetBase & { readonly type: "progress"; readonly value: AuthoringTemplate; readonly maximum?: number; readonly label?: string })
  | (AuthoringWidgetBase & { readonly type: "evidence"; readonly items: AuthoringTemplate; readonly open_action?: AuthoringActionBinding; readonly open_navigation?: AuthoringNavigationTemplate })
  | (AuthoringWidgetBase & { readonly type: "diff"; readonly files: AuthoringTemplate })
  | (AuthoringWidgetBase & { readonly type: "graph" | "map" | "timeline"; readonly entities: AuthoringTemplate; readonly edges?: AuthoringTemplate; readonly columns?: readonly AuthoringColumn[] });

export interface AuthoringInvocation {
  readonly actionId: string;
  readonly input: Readonly<Record<string, AuthoringJson>>;
  /** Original trusted browser event, forwarded synchronously to the Host gesture authority. */
  readonly event: Event;
}

export interface AuthoringReadInvocation {
  readonly actionId: string;
  readonly input: Readonly<Record<string, AuthoringJson>>;
  readonly signal: AbortSignal;
}

export type AuthoringSurfaceStatus = "loading" | "ready" | "partial" | "stale" | "unavailable" | "failure";

/**
 * Only the parent Host adapter can invoke actions or change documents. These callbacks are
 * intentionally narrow so a guest declaration cannot acquire DOM, Git, or navigation authority.
 */
export interface AuthoringSurfaceProps {
  readonly surface: AuthoringSurfaceDeclaration;
  readonly data?: AuthoringJson;
  readonly status?: AuthoringSurfaceStatus;
  readonly message?: string;
  onInvoke(invocation: AuthoringInvocation): Promise<AuthoringInvocationOutput>;
  onRead(invocation: AuthoringReadInvocation): Promise<import("../../authoring/types.js").ActionResult>;
  onNavigate?(event: Event, target: AuthoringNavigationTarget, intent: AuthoringNavigationTemplate["intent"]): Promise<void>;
  readonly onClose?: () => void;
  readonly className?: string;
}
