import type { ComponentType, ReactNode } from "react";

export type UiMode = "desktop" | "mobile";

/** Shared production UI assembled by the application controller for either shell. */
export interface ApplicationShellProps {
  mode: UiMode;
  header: ReactNode;
  library: ReactNode;
  editor: ReactNode;
  tools: ReactNode;
  status: ReactNode;
  onSwitchMode(): Promise<boolean>;
}

export type ApplicationShell = ComponentType<ApplicationShellProps>;
