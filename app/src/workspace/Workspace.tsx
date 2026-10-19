import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { UiMode, WorkspacePanel, WorkspacePanelRequest } from "../application/contracts";
import {
  activateWorkspacePanel,
  createWorkspacePreset,
  hideWorkspacePanel,
  moveWorkspacePanel,
  resizeWorkspaceSplit,
  showWorkspacePanel,
  visiblePanelIds,
  type DockSide,
  type WorkspaceLayout,
  type WorkspaceNode,
  type WorkspacePreset,
} from "./layout";
import { loadWorkspaceLayout, presetTitle, saveWorkspaceLayout, type WorkspaceLoad, type WorkspaceStorage } from "./persistence";
import "./workspace.css";

interface WorkspaceProps {
  scope: string;
  mode: UiMode;
  panels: readonly WorkspacePanel[];
  beforeLayoutChange?: () => Promise<boolean>;
  requestedPanel?: WorkspacePanelRequest;
  selectedPanelId?: string;
}

type Placement = "tab" | DockSide;

function browserStorage(): WorkspaceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function loadFor(scope: string, mode: UiMode, panelIds: string[]): WorkspaceLoad {
  const storage = browserStorage();
  if (!storage) return { layout: createWorkspacePreset("writing", panelIds), state: "unavailable" };
  return loadWorkspaceLayout(storage, scope, mode, panelIds);
}

function firstActivePanel(node: WorkspaceNode): string {
  if (node.type === "leaf") return node.panelId;
  if (node.type === "stack") return node.activePanelId;
  return firstActivePanel(node.children[0]!);
}

function initialMobilePanel(layout: WorkspaceLayout): string {
  return visiblePanelIds(layout.root).includes("outline") ? "outline" : firstActivePanel(layout.root);
}

function domId(prefix: string, panelId: string): string {
  return `${prefix}-${Array.from(panelId).map((char) => /[A-Za-z0-9_-]/.test(char) ? char : `-${char.codePointAt(0)?.toString(16)}-`).join("")}`;
}

function PanelContent({ panel }: { panel?: WorkspacePanel }): ReactNode {
  if (!panel) return <p className="st-workspace-unavailable">このパネルは現在利用できません。パネル一覧から閉じるか、機能を再度有効にしてください。</p>;
  return <>{panel.render()}</>;
}

interface PanelFrameProps {
  panelId: string;
  panel?: WorkspacePanel;
  mode: UiMode;
  canHide: boolean;
  onHide(panelId: string): void;
  onDrop(sourceId: string, targetId: string, placement: Placement): void;
}

function PanelFrame({ panelId, panel, mode, canHide, onHide, onDrop }: PanelFrameProps): ReactNode {
  const title = panel?.title ?? panelId;
  const dragStart = (event: DragEvent<HTMLDivElement>): void => {
    event.dataTransfer.setData("text/plain", panelId);
    event.dataTransfer.effectAllowed = "move";
  };
  const drop = (placement: Placement) => (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/plain");
    if (sourceId) onDrop(sourceId, panelId, placement);
  };
  const acceptDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };
  const placementTitles: ReadonlyArray<{ placement: Placement; mark: string }> = [
    { placement: "tab", mark: "Tab" },
    { placement: "left", mark: "←" },
    { placement: "right", mark: "→" },
    { placement: "top", mark: "↑" },
    { placement: "bottom", mark: "↓" },
  ];
  const dock = (event: DragEvent<HTMLDivElement>): void => {
    const zone = (event.target as HTMLElement).closest<HTMLElement>("[data-placement]");
    if (!zone) return;
    const value = zone.dataset.placement;
    if (value === "tab" || value === "left" || value === "right" || value === "top" || value === "bottom") drop(value)(event);
  };

  return (
    <section className="st-workspace-panel" tabIndex={-1} data-workspace-panel={panelId} aria-labelledby={domId("st-workspace-heading", panelId)}>
      <header className="st-workspace-panel-heading">
        {mode === "desktop" ? (
          <div
            className="st-workspace-drag-grip"
            draggable
            aria-hidden="true"
            onDragStart={dragStart}
            title={`Drag ${title} to move`}
          >⠿</div>
        ) : null}
        <h2 id={domId("st-workspace-heading", panelId)}>{title}</h2>
        {mode === "desktop" ? (
          <div className="st-workspace-drop-zones" aria-hidden="true" onDragOver={acceptDrop} onDrop={dock}>
            {placementTitles.map(({ placement, mark }) => (
              <div
                key={placement}
                className="st-workspace-drop-zone"
                data-placement={placement}
              >{mark}</div>
            ))}
          </div>
        ) : null}
        {mode === "desktop" ? (
          <button
            className="st-workspace-hide"
            type="button"
            aria-label={`Hide ${title}`}
            title={`Hide ${title}`}
            disabled={!canHide}
            onClick={() => onHide(panelId)}
          >×</button>
        ) : null}
      </header>
      <div className="st-workspace-panel-body"><PanelContent panel={panel} /></div>
    </section>
  );
}

interface TreeViewProps {
  node: WorkspaceNode;
  mode: UiMode;
  catalog: ReadonlyMap<string, WorkspacePanel>;
  visibleCount: number;
  onActivate(panelId: string): Promise<boolean>;
  onHide(panelId: string): void;
  onDrop(sourceId: string, targetId: string, placement: Placement): void;
  onResize(splitId: string, sizes: number[]): void;
}

function WorkspaceTree({ node, mode, catalog, visibleCount, onActivate, onHide, onDrop, onResize }: TreeViewProps): ReactNode {
  if (node.type === "leaf") {
    return <PanelFrame panelId={node.panelId} panel={catalog.get(node.panelId)} mode={mode} canHide={visibleCount > 1} onHide={onHide} onDrop={onDrop} />;
  }
  if (node.type === "stack") {
    return (
      <div className="st-workspace-stack">
        <div className="st-workspace-tabs" role="tablist" aria-label="Panel tabs">
          {node.children.map((child) => {
            const panel = catalog.get(child.panelId);
            const title = panel?.title ?? child.panelId;
            const selected = node.activePanelId === child.panelId;
            const tabId = domId("st-workspace-tab", child.panelId);
            return (
              <button
                className="st-workspace-tab"
                id={tabId}
                key={child.panelId}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={domId("st-workspace-pane", child.panelId)}
                draggable={mode === "desktop"}
                onDragStart={(event) => {
                  event.dataTransfer.setData("text/plain", child.panelId);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => { if (!selected) onActivate(child.panelId); }}
                onKeyDown={(event) => {
                  const currentIndex = node.children.findIndex((item) => item.panelId === child.panelId);
                  let nextIndex = currentIndex;
                  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % node.children.length;
                  else if (event.key === "ArrowLeft") nextIndex = (currentIndex + node.children.length - 1) % node.children.length;
                  else if (event.key === "Home") nextIndex = 0;
                  else if (event.key === "End") nextIndex = node.children.length - 1;
                  else return;
                  event.preventDefault();
                  const next = node.children[nextIndex]!;
                  const trigger = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[nextIndex];
                  void onActivate(next.panelId).then((allowed) => { if (allowed) trigger?.focus(); });
                }}
              >{title}</button>
            );
          })}
        </div>
        <div
          className="st-workspace-tab-panel"
          id={domId("st-workspace-pane", node.activePanelId)}
          role="tabpanel"
          aria-labelledby={domId("st-workspace-tab", node.activePanelId)}
          tabIndex={0}
        >
          <PanelFrame
            panelId={node.activePanelId}
            panel={catalog.get(node.activePanelId)}
            mode={mode}
            canHide={visibleCount > 1}
            onHide={onHide}
            onDrop={onDrop}
          />
        </div>
      </div>
    );
  }

  return (
    <PanelGroup
      className={`st-workspace-split st-workspace-split-${node.direction}`}
      id={`st-workspace-${node.id}`}
      direction={node.direction}
      onLayout={(sizes) => onResize(node.id, sizes)}
    >
      {node.children.flatMap((child, index) => [
          <Panel
            key={child.type === "leaf" ? child.panelId : child.id}
            id={`st-workspace-panel-${node.id}-${index}`}
            order={index + 1}
            defaultSize={node.sizes[index]}
            minSize={12}
            className="st-workspace-resizable-panel"
          >
            <WorkspaceTree
              node={child}
              mode={mode}
              catalog={catalog}
              visibleCount={visibleCount}
              onActivate={onActivate}
              onHide={onHide}
              onDrop={onDrop}
              onResize={onResize}
            />
          </Panel>,
          ...(index < node.children.length - 1 ? [
            <PanelResizeHandle
              key={`resize-${node.id}-${index}`}
              className={`st-workspace-resize-handle st-workspace-resize-${node.direction}`}
              aria-label={`Resize ${node.direction} workspace panels`}
              aria-orientation={node.direction === "horizontal" ? "vertical" : "horizontal"}
            />,
          ] : []),
        ])}
    </PanelGroup>
  );
}

export function Workspace({ scope, mode, panels, beforeLayoutChange, requestedPanel, selectedPanelId }: WorkspaceProps): ReactNode {
  const panelIds = useMemo(() => [...new Set(panels.map((panel) => panel.id))], [panels]);
  const catalog = useMemo(() => new Map(panels.map((panel) => [panel.id, panel])), [panels]);
  const [initial] = useState(() => loadFor(scope, mode, panelIds));
  const [layout, setLayout] = useState<WorkspaceLayout>(initial.layout);
  const [persistenceState, setPersistenceState] = useState<WorkspaceLoad["state"]>(initial.state);
  const [mobilePanelId, setMobilePanelId] = useState<string>(() => initialMobilePanel(initial.layout));
  const [moveSource, setMoveSource] = useState<string>(() => firstActivePanel(initial.layout.root));
  const [moveTarget, setMoveTarget] = useState<string>(() => panelIds.find((id) => id !== "editor") ?? "");
  const [placement, setPlacement] = useState<Placement>("tab");
  const [message, setMessage] = useState("");
  const [changing, setChanging] = useState(false);
  const changingRef = useRef(false);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const handledRequestRef = useRef("");
  const routeSuppressedByPanelRequestRef = useRef("");
  const visibleIds = useMemo(() => visiblePanelIds(layout.root), [layout.root]);

  useEffect(() => {
    const loaded = loadFor(scope, mode, panelIds);
    setLayout(loaded.layout);
    setPersistenceState(loaded.state);
    setMobilePanelId(initialMobilePanel(loaded.layout));
    setMoveSource(firstActivePanel(loaded.layout.root));
    setMoveTarget(panelIds.find((id) => id !== "editor") ?? "");
    setMessage("");
  }, [scope, mode]);

  useEffect(() => {
    if (!visibleIds.includes(mobilePanelId)) setMobilePanelId(visibleIds[0] ?? "editor");
    if (!visibleIds.includes(moveSource)) setMoveSource(visibleIds[0] ?? "editor");
    if (!visibleIds.includes(moveTarget) || moveTarget === moveSource) {
      setMoveTarget(visibleIds.find((id) => id !== moveSource) ?? "");
    }
  }, [visibleIds, mobilePanelId, moveSource, moveTarget]);

  const changeLayout = useCallback(async (change: (current: WorkspaceLayout) => WorkspaceLayout, success = "Layout updated. Save layout to keep it."): Promise<boolean> => {
    if (changingRef.current) return false;
    changingRef.current = true;
    setChanging(true);
    setMessage("");
    try {
      const allowed = beforeLayoutChange ? await beforeLayoutChange() : true;
      if (!allowed) {
        setMessage("The editor could not confirm its recovery state. The current panel layout is unchanged.");
        return false;
      }
      setLayout((current) => change(current));
      setMessage(success);
      return true;
    } catch (error) {
      setMessage(error instanceof Error && error.message ? error.message : "The editor could not be prepared for a panel change.");
      return false;
    } finally {
      changingRef.current = false;
      setChanging(false);
    }
  }, [beforeLayoutChange]);

  useEffect(() => {
    const panelId = requestedPanel?.id;
    const sequence = requestedPanel?.sequence;
    if (!panelId || !sequence || changingRef.current) return;
    const requestKey = `${scope}:${mode}:${panelId}:${sequence}`;
    if (handledRequestRef.current === requestKey) return;
    handledRequestRef.current = requestKey;
    if (!catalog.has(panelId)) {
      setMessage(`The ${panelId} panel is not available.`);
      return;
    }
    if (mode === "mobile" && selectedPanelId && selectedPanelId !== panelId) {
      routeSuppressedByPanelRequestRef.current = `${scope}:${mode}:${selectedPanelId}`;
    }
    const reveal = async (): Promise<void> => {
      const change = visibleIds.includes(panelId)
        ? (current: WorkspaceLayout) => activateWorkspacePanel(current, panelId)
        : (current: WorkspaceLayout) => showWorkspacePanel(current, panelId);
      const allowed = await changeLayout(change, "Panel opened. Save layout to keep it.");
      if (!allowed) return;
      if (mode === "mobile") setMobilePanelId(panelId);
      window.requestAnimationFrame(() => {
        const element = Array.from(workspaceRef.current?.querySelectorAll<HTMLElement>("[data-workspace-panel]") ?? [])
          .find((candidate) => candidate.dataset.workspacePanel === panelId);
        element?.focus();
      });
    };
    void reveal();
  }, [requestedPanel?.id, requestedPanel?.sequence, scope, mode, catalog, visibleIds, changeLayout, changing]);

  const changePreset = (preset: Exclude<WorkspacePreset, "custom">): void => {
    void changeLayout(() => createWorkspacePreset(preset, panelIds), `${presetTitle(preset)} preset applied. Save layout to keep it.`);
  };

  const save = (): void => {
    const storage = browserStorage();
    const saved = storage ? saveWorkspaceLayout(storage, scope, mode, layout) : false;
    if (saved) {
      setPersistenceState("valid");
      setMessage("Layout saved on this device.");
    } else {
      setMessage("Layout could not be saved in this browser.");
    }
  };

  const hidePanel = (panelId: string): void => {
    void changeLayout((current) => hideWorkspacePanel(current, panelId)).then((allowed) => {
      if (allowed) window.setTimeout(() => workspaceRef.current?.querySelector<HTMLElement>(".st-workspace-panel")?.focus(), 0);
    });
  };

  const showPanel = (panelId: string): void => {
    void changeLayout((current) => showWorkspacePanel(current, panelId));
  };

  const movePanel = (sourceId: string, targetId: string, nextPlacement: Placement): void => {
    void changeLayout((current) => moveWorkspacePanel(current, sourceId, targetId, nextPlacement));
  };

  const activateTab = (panelId: string): Promise<boolean> => {
    return changeLayout((current) => activateWorkspacePanel(current, panelId), "Panel selected. Save layout to keep it.");
  };

  const activateMobilePanel = (panelId: string): Promise<boolean> => {
    if (panelId === mobilePanelId || changingRef.current) return Promise.resolve(false);
    changingRef.current = true;
    setChanging(true);
    setMessage("");
    return (async () => {
      try {
        const allowed = beforeLayoutChange ? await beforeLayoutChange() : true;
        if (!allowed) {
          setMessage("The editor could not confirm its recovery state. The current panel is unchanged.");
          return false;
        }
        setMobilePanelId(panelId);
        return true;
      } catch (error) {
        setMessage(error instanceof Error && error.message ? error.message : "The editor could not be prepared for a panel change.");
        return false;
      } finally {
        changingRef.current = false;
        setChanging(false);
      }
    })();
  };

  const routeSelectionRef = useRef("");
  useEffect(() => {
    if (mode !== "mobile" || !selectedPanelId || !catalog.has(selectedPanelId) || changingRef.current) return;
    const selectionKey = `${scope}:${mode}:${selectedPanelId}`;
    if (routeSuppressedByPanelRequestRef.current === selectionKey) return;
    routeSuppressedByPanelRequestRef.current = "";
    if (routeSelectionRef.current === selectionKey) return;
    routeSelectionRef.current = selectionKey;
    const change = visibleIds.includes(selectedPanelId)
      ? (current: WorkspaceLayout) => current
      : (current: WorkspaceLayout) => showWorkspacePanel(current, selectedPanelId);
    void changeLayout(change, "Panel opened for this view. Save layout to keep it.")
      .then((allowed) => { if (allowed) setMobilePanelId(selectedPanelId); });
  }, [mode, scope, selectedPanelId, visibleIds, catalog, changeLayout, changing]);

  const resize = (splitId: string, sizes: number[]): void => {
    setLayout((current) => resizeWorkspaceSplit(current, splitId, sizes));
  };

  const handleDrop = (sourceId: string, targetId: string, nextPlacement: Placement): void => {
    if (sourceId !== targetId && visibleIds.includes(sourceId) && visibleIds.includes(targetId)) {
      movePanel(sourceId, targetId, nextPlacement);
    }
  };

  const titleOf = (panelId: string): string => catalog.get(panelId)?.title ?? panelId;
  const storageLabel = persistenceState === "valid"
    ? "Saved layout loaded."
    : persistenceState === "invalid"
      ? "A saved layout is invalid. The Writing preset is open; saving will replace it."
      : persistenceState === "unavailable"
        ? "Browser storage is unavailable."
        : "Layout changes are saved only when you choose Save layout.";

  return (
    <section ref={workspaceRef} className={`st-workspace st-workspace-${mode}`} aria-label="Composable workspace">
      <div className="st-workspace-toolbar" role="toolbar" aria-label="Workspace layout controls">
        <div className="st-workspace-presets" aria-label="Workspace presets">
          <button type="button" aria-pressed={layout.preset === "writing"} onClick={() => changePreset("writing")} disabled={changing}>Writing</button>
          <button type="button" aria-pressed={layout.preset === "research"} onClick={() => changePreset("research")} disabled={changing}>Research</button>
          <button type="button" aria-pressed={layout.preset === "review"} onClick={() => changePreset("review")} disabled={changing}>Review</button>
        </div>
        <details className="st-workspace-panel-menu">
          <summary>Panels</summary>
          <div className="st-workspace-panel-menu-list">
            {panels.map((panel) => {
              const visible = visibleIds.includes(panel.id);
              return (
                <div className="st-workspace-panel-menu-item" key={panel.id}>
                  <span>{panel.title}</span>
                  <button type="button" disabled={changing || (visible && visibleIds.length <= 1)} onClick={() => visible ? hidePanel(panel.id) : showPanel(panel.id)}>
                    {visible ? `Hide ${panel.title}` : `Show ${panel.title}`}
                  </button>
                </div>
              );
            })}
          </div>
        </details>
        <button className="st-workspace-save" type="button" onClick={save} disabled={changing}>Save layout</button>
      </div>

      <div className="st-workspace-move-controls" aria-label="Move panel controls">
        <label>
          Panel to move
          <select value={moveSource} onChange={(event) => setMoveSource(event.target.value)} disabled={changing || visibleIds.length < 2}>
            {visibleIds.map((id) => <option value={id} key={id}>{titleOf(id)}</option>)}
          </select>
        </label>
        <label>
          Move next to
          <select value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)} disabled={changing || visibleIds.length < 2}>
            {visibleIds.filter((id) => id !== moveSource).map((id) => <option value={id} key={id}>{titleOf(id)}</option>)}
          </select>
        </label>
        <label>
          Placement
          <select value={placement} onChange={(event) => setPlacement(event.target.value as Placement)} disabled={changing}>
            <option value="tab">Tab</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
          </select>
        </label>
        <button type="button" disabled={changing || !moveSource || !moveTarget} onClick={() => movePanel(moveSource, moveTarget, placement)}>Move panel</button>
      </div>

      {persistenceState === "invalid" ? <p className="st-workspace-warning" role="alert">{storageLabel}</p> : null}
      {message ? <p className="st-workspace-message" role="status" aria-live="polite">{message}</p> : null}
      {!message && persistenceState !== "invalid" ? <p className="st-workspace-storage-state">{storageLabel}</p> : null}

      {mode === "mobile" ? (
        <div className="st-workspace-mobile-layout">
          <nav className="st-workspace-mobile-tabs" role="tablist" aria-label="Workspace panels">
            {visibleIds.map((panelId) => {
              const selected = panelId === mobilePanelId;
              const tabId = domId("st-workspace-mobile-tab", panelId);
              return (
                <button
                  type="button"
                  role="tab"
                  id={tabId}
                  key={panelId}
                  aria-selected={selected}
                  aria-controls={domId("st-workspace-mobile-pane", panelId)}
                  disabled={changing}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => { void activateMobilePanel(panelId); }}
                  onKeyDown={(event) => {
                    const currentIndex = visibleIds.indexOf(panelId);
                    let nextIndex = currentIndex;
                    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % visibleIds.length;
                    else if (event.key === "ArrowLeft") nextIndex = (currentIndex + visibleIds.length - 1) % visibleIds.length;
                    else if (event.key === "Home") nextIndex = 0;
                    else if (event.key === "End") nextIndex = visibleIds.length - 1;
                    else return;
                    event.preventDefault();
                    const nextPanelId = visibleIds[nextIndex]!;
                    const trigger = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[nextIndex];
                    void activateMobilePanel(nextPanelId).then((allowed) => { if (allowed) trigger?.focus(); });
                  }}
                >{titleOf(panelId)}</button>
              );
            })}
          </nav>
          <div
            className="st-workspace-mobile-pane"
            id={domId("st-workspace-mobile-pane", mobilePanelId)}
            role="tabpanel"
            aria-labelledby={domId("st-workspace-mobile-tab", mobilePanelId)}
            tabIndex={0}
          >
            <PanelFrame panelId={mobilePanelId} panel={catalog.get(mobilePanelId)} mode="mobile" canHide={false} onHide={hidePanel} onDrop={handleDrop} />
          </div>
        </div>
      ) : (
        <div className="st-workspace-layout" aria-label="Workspace panels">
          <WorkspaceTree
            node={layout.root}
            mode={mode}
            catalog={catalog}
            visibleCount={visibleIds.length}
            onActivate={activateTab}
            onHide={hidePanel}
            onDrop={handleDrop}
            onResize={resize}
          />
        </div>
      )}
    </section>
  );
}
