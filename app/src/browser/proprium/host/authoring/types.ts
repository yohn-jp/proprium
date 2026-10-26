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

export type AuthoringSurfaceKind = "panel" | "command";
export type AuthoringWidgetKind =
  | "outline" | "list" | "table" | "detail" | "form" | "tabs" | "status" | "progress"
  | "evidence" | "diff" | "graph" | "map" | "timeline";

export type AuthoringSurfaceDeclaration = Omit<SurfaceDeclaration, "kind" | "context" | "body"> & {
  readonly kind: AuthoringSurfaceKind;
  readonly context: Readonly<Record<string, unknown>>;
  readonly body: AuthoringWidget;
};

export interface AuthoringWidgetBase {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  /** A read action, started only when this Host panel/widget is opened. */
  readonly load_action?: AuthoringActionBinding;
}

export interface AuthoringField {
  readonly id: string;
  readonly label: string;
  readonly type: "string" | "integer" | "boolean" | "enum" | "multi-reference" | "ordered-list";
  readonly required?: boolean;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly placeholder?: string;
  readonly min_length?: number;
  readonly max_length?: number;
  readonly validation_message?: string;
}

export interface AuthoringOutlineRow {
  readonly id: string;
  readonly title: string;
  readonly kind?: string;
  readonly path?: string;
  readonly children?: readonly AuthoringOutlineRow[];
  readonly action?: AuthoringActionBinding;
}

export interface AuthoringColumn {
  readonly key: string;
  readonly label: string;
}

export type AuthoringWidget =
  | (AuthoringWidgetBase & { readonly type: "outline"; readonly items: AuthoringTemplate; readonly activate?: AuthoringActionBinding; readonly next_action?: AuthoringActionBinding; readonly previous_action?: AuthoringActionBinding })
  | (AuthoringWidgetBase & { readonly type: "list"; readonly items: AuthoringTemplate; readonly primary: string; readonly secondary?: string; readonly item_action?: AuthoringActionBinding; readonly next_action?: AuthoringActionBinding; readonly previous_action?: AuthoringActionBinding })
  | (AuthoringWidgetBase & { readonly type: "table"; readonly rows: AuthoringTemplate; readonly columns: readonly AuthoringColumn[]; readonly next_action?: AuthoringActionBinding; readonly previous_action?: AuthoringActionBinding })
  | (AuthoringWidgetBase & { readonly type: "detail"; readonly value: AuthoringTemplate; readonly fields?: readonly { readonly key: string; readonly label: string }[] })
  | (AuthoringWidgetBase & { readonly type: "form"; readonly fields: readonly AuthoringField[]; readonly submit: AuthoringActionBinding; readonly cancel_action?: AuthoringActionBinding })
  | (AuthoringWidgetBase & { readonly type: "tabs"; readonly tabs: readonly { readonly id: string; readonly title: string; readonly body: AuthoringWidget }[] })
  | (AuthoringWidgetBase & { readonly type: "status"; readonly state: AuthoringTemplate; readonly messages?: Readonly<Record<string, string>> })
  | (AuthoringWidgetBase & { readonly type: "progress"; readonly value: AuthoringTemplate; readonly maximum?: number; readonly label?: string })
  | (AuthoringWidgetBase & { readonly type: "evidence"; readonly items: AuthoringTemplate; readonly open_action?: AuthoringActionBinding })
  | (AuthoringWidgetBase & { readonly type: "diff"; readonly files: AuthoringTemplate })
  | (AuthoringWidgetBase & { readonly type: "graph" | "map" | "timeline"; readonly entities: AuthoringTemplate; readonly edges?: AuthoringTemplate; readonly columns?: readonly AuthoringColumn[] });

export interface AuthoringInvocation {
  readonly actionId: string;
  readonly input: Readonly<Record<string, AuthoringJson>>;
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
  onInvoke(invocation: AuthoringInvocation): Promise<AuthoringJson>;
  readonly onClose?: () => void;
  readonly className?: string;
}
