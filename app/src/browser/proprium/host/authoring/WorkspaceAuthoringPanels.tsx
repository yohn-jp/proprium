import type { WorkspacePanel } from "../../../../application/contracts.js";
import { AuthoringSurface } from "./AuthoringSurface.js";
import type { ActionResult } from "../../authoring/types.js";
import type { AuthoringInvocationOutput, AuthoringJson, AuthoringNavigationTarget, AuthoringSurfaceDeclaration, AuthoringSurfaceStatus, AuthoringNavigationTemplate, AuthoringReadInvocation } from "./types.js";
import { validateAuthoringSurfaceDeclaration } from "./validate.js";

export interface AuthoringSurfaceRegistration {
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly manifestDigest?: string;
  readonly surface: AuthoringSurfaceDeclaration;
  readonly status: AuthoringSurfaceStatus;
  readonly data?: AuthoringJson;
  readonly message?: string;
}

/** Converts service metadata into a validated Host-renderable registration. */
export function validateAuthoringSurfaceRegistrations(values: readonly unknown[]): AuthoringSurfaceRegistration[] {
  const registrations: AuthoringSurfaceRegistration[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const raw = value as Record<string, unknown>;
    if (typeof raw.pluginId !== "string" || typeof raw.pluginVersion !== "string" || !raw.surface || typeof raw.surface !== "object") continue;
    const availability = raw.availability;
    if (!(["ready", "disabled", "dependency_unavailable", "capability_denied", "incompatible"] as unknown[]).includes(availability)) continue;
    try {
      const surface = validateAuthoringSurfaceDeclaration(raw.surface);
      const status: AuthoringSurfaceStatus = availability === "ready" ? "ready" : availability === "incompatible" ? "failure" : "unavailable";
      const reason = typeof raw.reason === "string" ? raw.reason : undefined;
      registrations.push({ pluginId: raw.pluginId, pluginVersion: raw.pluginVersion, surface, status,
        ...(reason ? { message: reason } : {}),
        ...(typeof raw.manifestDigest === "string" ? { manifestDigest: raw.manifestDigest } : {}) });
    } catch { /* Invalid signed UI is never handed to a renderer. */ }
  }
  return registrations;
}

export type AuthoringActionInvoker = (event: Event, pluginId: string, actionId: string,
  input: Readonly<Record<string, AuthoringJson>>, source?: { readonly surfaceId: string }) => Promise<AuthoringInvocationOutput>;
export type AuthoringReadInvoker = (pluginId: string, actionId: string,
  input: Readonly<Record<string, AuthoringJson>>, signal: AbortSignal) => Promise<ActionResult>;
export type AuthoringNavigationHandler = (event: Event,
  target: AuthoringNavigationTarget, intent: AuthoringNavigationTemplate["intent"]) => Promise<void>;

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
  read: AuthoringReadInvoker,
  onClose?: (panelId: string) => void,
  onNavigate?: AuthoringNavigationHandler,
): WorkspacePanel[] {
  const ids = new Set<string>();
  const panels: WorkspacePanel[] = [];
  for (const registration of registrations) {
    if (registration.surface.kind !== "panel") continue;
    let surface: AuthoringSurfaceDeclaration;
    try { surface = validateAuthoringSurfaceDeclaration(registration.surface); }
    catch { continue; }
    const id = authoringPanelId(registration.pluginId, surface.id);
    if (ids.has(id)) continue;
    ids.add(id);
    panels.push({
      id,
      title: surface.title,
      render: () => <AuthoringSurface
        key={`${registration.pluginId}:${registration.pluginVersion}:${surface.id}`}
        className="authoring-workspace-panel"
        surface={surface}
        data={registration.data}
        status={registration.status}
        message={registration.message}
        onClose={onClose ? () => onClose(id) : undefined}
        onInvoke={({ actionId, input, event }) => invoke(event, registration.pluginId, actionId, input)}
        onRead={({ actionId, input, signal }: AuthoringReadInvocation) => read(registration.pluginId, actionId, input, signal)}
        onNavigate={onNavigate}
      />,
    });
  }
  return panels;
}
