import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { AuthoringJson } from "./types.js";
import { AuthoringSurface } from "./AuthoringSurface.js";
import { validateAuthoringSurfaceDeclaration } from "./validate.js";
import type { AuthoringActionInvoker, AuthoringNavigationHandler, AuthoringReadInvoker, AuthoringSurfaceRegistration } from "./WorkspaceAuthoringPanels.js";

/** Host command palette entry point for signed command-kind surfaces. */
export function AuthoringCommandMenu({ registrations, invoke, read, navigate }: {
  readonly registrations: readonly AuthoringSurfaceRegistration[];
  readonly invoke: AuthoringActionInvoker;
  readonly read: AuthoringReadInvoker;
  readonly navigate?: AuthoringNavigationHandler;
}): ReactElement | null {
  const commands = useMemo(() => registrations.flatMap(registration => {
    if (registration.surface.kind !== "command") return [];
    try { return [{ registration, surface: validateAuthoringSurfaceDeclaration(registration.surface) }]; }
    catch { return []; }
  }), [registrations]);
  const [activeId, setActiveId] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const active = commands.find(command => `${command.registration.pluginId}:${command.surface.id}` === activeId);

  useEffect(() => {
    if (active && dialog.current && !dialog.current.open) dialog.current.showModal();
    else if (!active && dialog.current?.open) dialog.current.close();
  }, [active]);
  useEffect(() => {
    if (activeId && !active) setActiveId("");
  }, [active, activeId]);

  if (!commands.length) return null;
  const close = () => setActiveId("");
  return <section className="authoring-command-menu" aria-labelledby="authoring-command-menu-title">
    <h2 id="authoring-command-menu-title">プラグインコマンド</h2>
    <ul>{commands.map(({ registration, surface }) => {
      const id = `${registration.pluginId}:${surface.id}`;
      return <li key={id}>
        <button type="button" aria-haspopup="dialog" onClick={() => setActiveId(id)}>
          <span>{surface.title}</span><small>{registration.pluginId}</small>
        </button>
      </li>;
    })}</ul>
    <dialog ref={dialog} className="authoring-command-dialog" aria-labelledby={active ? `authoring-surface-${active.surface.id}` : undefined}
      onCancel={event => { event.preventDefault(); close(); }}>
      {active && <AuthoringSurface
        key={`${active.registration.pluginId}:${active.registration.pluginVersion}:${active.surface.id}`}
        className="authoring-command-surface"
        surface={active.surface}
        data={active.registration.data ?? EMPTY_DATA}
        status={active.registration.status}
        message={active.registration.message}
        onClose={close}
        onInvoke={async ({ actionId, input, event }) => {
          const output = await invoke(event, active.registration.pluginId, actionId, input, { surfaceId: active.surface.id });
          const result = output.action_result;
          if (result.ok && result.value && typeof result.value === "object" && "navigation" in result.value) close();
          return output;
        }}
        onRead={({ actionId, input, signal }) => read(active.registration.pluginId, actionId, input, signal)}
        onNavigate={navigate}
      />}
    </dialog>
  </section>;
}

const EMPTY_DATA: AuthoringJson = Object.freeze({});
