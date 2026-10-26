import type { WorkspacePanel } from "../../../../application/contracts.js";
import { AuthoringSurface } from "./AuthoringSurface.js";
import type { AuthoringJson, AuthoringSurfaceDeclaration, AuthoringSurfaceStatus } from "./types.js";

export interface AuthoringSurfaceRegistration {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly surface: AuthoringSurfaceDeclaration;
  readonly status: AuthoringSurfaceStatus;
  readonly data?: AuthoringJson;
  readonly message?: string;
}

export type AuthoringActionInvoker = (pluginId: string, pluginVersion: string, actionId: string,
  input: Readonly<Record<string, AuthoringJson>>) => Promise<AuthoringJson>;

/** Stable IDs preserve Host layout preferences across plugin updates. */
export function authoringPanelId(pluginId: string, surfaceId: string): string {
  const fullId = `plugin:${pluginId}:${surfaceId}`;
  if (fullId.length <= 159) return fullId;
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(`${pluginId}\u0000${surfaceId}`)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return `plugin:${pluginId.slice(0, 96)}:${hash.toString(16).padStart(16, "0")}`;
}

/**
 * Turns already signature-verified declarations into normal Workspace panels. The Workspace
 * owns layout/mobile selection; each renderer can only call the injected typed Host action port.
 */
export function createAuthoringWorkspacePanels(
  registrations: readonly AuthoringSurfaceRegistration[],
  invoke: AuthoringActionInvoker,
  onClose?: (panelId: string) => void,
): WorkspacePanel[] {
  const ids = new Set<string>();
  const panels: WorkspacePanel[] = [];
  for (const registration of registrations) {
    const id = authoringPanelId(registration.pluginId, registration.surface.id);
    if (ids.has(id)) continue;
    ids.add(id);
    panels.push({
      id,
      title: registration.surface.title,
      render: () => <AuthoringSurface
        key={`${registration.pluginId}:${registration.pluginVersion}:${registration.surface.id}`}
        className="authoring-workspace-panel"
        surface={registration.surface}
        data={registration.data}
        status={registration.status}
        message={registration.message}
        onClose={onClose ? () => onClose(id) : undefined}
        onInvoke={({ actionId, input }) => invoke(registration.pluginId, registration.pluginVersion, actionId, input)}
      />,
    });
  }
  return panels;
}
