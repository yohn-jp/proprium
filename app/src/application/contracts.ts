import type { ComponentType, ReactNode } from "react";

export type UiMode = "desktop" | "mobile";

/** A host-approved panel definition. The workspace stores its ID, never its renderer. */
export interface WorkspacePanel {
  id: string;
  title: string;
  render(): ReactNode;
}

export interface WorkspacePanelRequest {
  id: string;
  sequence: number;
}

/** Shared production UI assembled by the application controller for either shell. */
export interface ApplicationShellProps {
  mode: UiMode;
  header: ReactNode;
  /** Production-authorized buttons/status for the Desktop Studio masthead. */
  desktopActions?: ReactNode;
  desktopDurability?: "draft" | "checkpointing" | "checkpointed" | "publication_unknown" | "saved";
  documentTitle?: string;
  documentContext?: string;
  library: ReactNode;
  editor: ReactNode;
  tools: ReactNode;
  status: ReactNode;
  /** Present shell navigation errors in the same persistent status surface. */
  renderStatus?: (interactionError: string) => ReactNode;
  onSwitchMode(): Promise<boolean>;
  /** Stable author and device scope; desktop and mobile use separate layout keys. */
  workspaceScope?: string;
  /** Host-approved core and activated module panels available in this workspace. */
  panels?: readonly WorkspacePanel[];
  /** Flush and validate the active editor before a panel switch can unmount it. */
  beforeLayoutChange?: () => Promise<boolean>;
  /** Ask the workspace to reveal and focus a panel, for example History. */
  requestedPanel?: WorkspacePanelRequest;
}

export type ApplicationShell = ComponentType<ApplicationShellProps>;
