import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { setNonce } from "@ionic/core/components";
import {
  IonApp,
  IonButton,
  IonContent,
  IonFooter,
  IonHeader,
  IonModal,
  IonPage,
  setupIonicReact,
} from "@ionic/react";
import { useLocation, useNavigate } from "react-router-dom";
import type { ApplicationShellProps, WorkspacePanelRequest } from "../../application/contracts";
import { Workspace } from "../../workspace/Workspace";
import { useWritingKeyboardVisibility } from "./useWritingKeyboardVisibility";
import "@ionic/react/css/core.css";
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";
import "./mobile.css";
import "../editorial.css";
import "../authoring.css";

export type MobileView = "library" | "writing" | "inspection" | "tools" | "settings";
type ReferenceSheet = "outline" | "inspector";

interface PendingMobilePanelRequest {
  sequence: number;
  origin: { identity: string; key: string; scope?: string };
  expectedIdentity?: string;
  commit?: () => void;
  committing?: boolean;
}

interface MobileLocationSnapshot {
  identity: string;
  key: string;
  pathname: string;
  search: string;
  hash: string;
  state: unknown;
  scope?: string;
}

const WORKSPACE_PANEL_FOR_VIEW: Readonly<Record<Exclude<MobileView, "settings">, string>> = {
  library: "outline",
  writing: "editor",
  inspection: "inspector",
  tools: "review",
};

function workspacePanelForView(view: MobileView): string | undefined {
  return view === "settings" ? undefined : WORKSPACE_PANEL_FOR_VIEW[view];
}

const VIEWS: ReadonlyArray<{ id: MobileView; label: string; title: string; mark: string }> = [
  { id: "library", label: "作品", title: "作品ライブラリ", mark: "▤" },
  { id: "writing", label: "書く", title: "執筆・読書", mark: "✎" },
  { id: "inspection", label: "確認", title: "状態と回復", mark: "◎" },
  { id: "tools", label: "道具", title: "ツールとレビュー", mark: "◇" },
  { id: "settings", label: "設定", title: "設定", mark: "⚙" },
];

const MOBILE_VIEW_PARAM = "view";
const MOBILE_PREVIOUS_VIEW_STATE = "scriptoriumMobilePreviousView";

function isMobileView(value: unknown): value is MobileView {
  return value === "library" || value === "writing" || value === "inspection" || value === "tools" || value === "settings";
}

function readViewFromSearch(search: string): MobileView {
  const value = new URLSearchParams(search).get(MOBILE_VIEW_PARAM);
  return isMobileView(value) ? value : "writing";
}

function withViewInCurrentUrl(view: MobileView): string {
  const url = new URL(window.location.href);
  url.searchParams.set(MOBILE_VIEW_PARAM, view);
  return `${url.pathname}${url.search}${url.hash}`;
}

function historyState(value: unknown): Record<string, unknown> {
  const state = value;
  return state && typeof state === "object" ? state as Record<string, unknown> : {};
}

function initializeIonicRuntime(): void {
  if (typeof document === "undefined") return;
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="scriptorium-style-nonce"]')?.content;
  if (nonce && nonce !== "__SCRIPTORIUM_STYLE_NONCE__") setNonce(nonce);
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  setupIonicReact({ mode: "md", animated: !reducedMotion });
}

initializeIonicRuntime();

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return `切り替えできませんでした。入力はこの画面に残っています。${error.message}`;
  }
  return "入力を保持したまま画面を切り替えられませんでした。表示中の状態を確認してください。";
}

/**
 * Ionic page navigation for the shared application controller.
 * The mobile entry supplies the Ionic React Router context around the controller.
 */
export function MobileShell({ header, documentTitle, documentContext, desktopDurability, library, editor, tools, settings, status, renderStatus, onSwitchMode, workspaceScope, panels, beforeLayoutChange, requestedPanel }: ApplicationShellProps) {
  const location = useLocation();
  const navigateRoute = useNavigate();
  const activeView = readViewFromSearch(location.search);
  const hasWorkspace = Boolean(workspaceScope && panels?.length);
  const writingKeyboardVisible = useWritingKeyboardVisibility();
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const [referenceSheet, setReferenceSheet] = useState<ReferenceSheet | null>(null);
  const [openingReference, setOpeningReference] = useState(false);
  const openingReferenceRef = useRef(false);
  const referenceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workspaceNavigationRef = useRef<HTMLDetailsElement | null>(null);
  const referenceOriginRef = useRef("");
  const routeIdentityRef = useRef(location.pathname + location.search);
  routeIdentityRef.current = location.pathname + location.search;
  const routeContext = {
    identity: location.pathname + location.search,
    key: location.key,
    pathname: location.pathname,
    search: location.search,
    hash: location.hash,
    state: location.state,
    scope: workspaceScope,
  } satisfies MobileLocationSnapshot;
  const routeContextRef = useRef(routeContext);
  routeContextRef.current = routeContext;
  const lastLocationRef = useRef(routeContext);
  const lastStableLocationRef = useRef(routeContext);
  const authorizedRouteChangeRef = useRef<{ originKey: string; expectedIdentity?: string } | null>(null);
  if (lastLocationRef.current.key !== routeContext.key) {
    const authorized = authorizedRouteChangeRef.current;
    if (authorized && authorized.originKey === lastLocationRef.current.key &&
        (!authorized.expectedIdentity || authorized.expectedIdentity === routeContext.identity)) {
      lastStableLocationRef.current = routeContext;
    }
    authorizedRouteChangeRef.current = null;
    lastLocationRef.current = routeContext;
  }
  const routeSelectionKey = `${workspaceScope ?? ""}\u001f${location.key}\u001f${location.pathname}${location.search}\u001f${activeView}`;
  const routeSelectionKeyRef = useRef(routeSelectionKey);
  routeSelectionKeyRef.current = routeSelectionKey;
  const panelRequestSequenceRef = useRef(0);
  const forwardedPanelRequestRef = useRef("");
  const [workspacePanelRequest, setWorkspacePanelRequest] = useState<WorkspacePanelRequest>();
  const workspacePanelRequestRef = useRef(workspacePanelRequest);
  workspacePanelRequestRef.current = workspacePanelRequest;
  const [routeTransitionSequence, setRouteTransitionSequence] = useState<number>();
  const pendingPanelRequestRef = useRef<PendingMobilePanelRequest | null>(null);
  const contentRef = useRef<HTMLIonContentElement | null>(null);
  const activeViewRef = useRef(activeView);
  const scrollPositionsRef = useRef(new Map<MobileView, number>());

  useEffect(() => {
    const pending = pendingPanelRequestRef.current;
    if (!pending) return;
    const current = routeContextRef.current;
    if (current.key === pending.origin.key && current.identity === pending.origin.identity && current.scope === pending.origin.scope) return;
    if (pending.committing && pending.origin.scope === current.scope && pending.expectedIdentity === current.identity) {
      pending.origin = { identity: current.identity, key: current.key, scope: current.scope };
      pending.committing = false;
      return;
    }
    pendingPanelRequestRef.current = null;
    panelRequestSequenceRef.current += 1;
    setRouteTransitionSequence((sequence) => sequence === pending.sequence ? undefined : sequence);
  }, [location.key, location.pathname, location.search, workspaceScope]);

  // A sheet only presents already-authorized panels. The Workspace and CodeMirror
  // remain mounted behind it; scene/navigation changes close the sheet.
  useEffect(() => {
    setReferenceSheet(null);
  }, [location.pathname, activeView]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const view = url.searchParams.get(MOBILE_VIEW_PARAM);
    if (!isMobileView(view)) {
      url.searchParams.set(MOBILE_VIEW_PARAM, "writing");
      navigateRoute(`${url.pathname}${url.search}${url.hash}`, { replace: true, state: location.state });
    }
  }, [location.search, location.state, navigateRoute]);

  useLayoutEffect(() => {
    const previousView = activeViewRef.current;
    if (previousView === activeView) return;

    let cancelled = false;
    const content = contentRef.current;
    if (!content) {
      activeViewRef.current = activeView;
      return;
    }

    void content.getScrollElement().then((scrollElement) => {
      if (cancelled) return;
      scrollPositionsRef.current.set(previousView, scrollElement.scrollTop);
      scrollElement.scrollTop = scrollPositionsRef.current.get(activeView) ?? 0;
      activeViewRef.current = activeView;
    });
    return () => { cancelled = true; };
  }, [activeView]);

  const preparePanelChange = useCallback(async (): Promise<boolean> => {
    setSwitchError("");
    try {
      const allowed = beforeLayoutChange ? await beforeLayoutChange() : true;
      if (!allowed) setSwitchError("下書きの回復状態を確認できないため、この画面を維持しています。入力は保持されています。");
      return allowed;
    } catch (error) {
      setSwitchError(errorMessage(error));
      return false;
    }
  }, [beforeLayoutChange]);

  const queueWorkspacePanel = useCallback((id: string, commitRoute?: () => void, expectedIdentity?: string) => {
    const sequence = ++panelRequestSequenceRef.current;
    pendingPanelRequestRef.current = {
      sequence,
      origin: {
        identity: routeContextRef.current.identity,
        key: routeContextRef.current.key,
        scope: routeContextRef.current.scope,
      },
      expectedIdentity,
      commit: commitRoute,
    };
    if (commitRoute) {
      setRouteTransitionSequence(sequence);
    } else {
      setRouteTransitionSequence(undefined);
    }
    setWorkspacePanelRequest({ id, sequence });
  }, []);

  const isPanelRequestCurrent = useCallback((sequence: number): boolean => {
    if (panelRequestSequenceRef.current !== sequence || workspacePanelRequestRef.current?.sequence !== sequence) return false;
    const pending = pendingPanelRequestRef.current;
    if (!pending || pending.sequence !== sequence) return true;
    const current = routeContextRef.current;
    return current.key === pending.origin.key && current.identity === pending.origin.identity && current.scope === pending.origin.scope;
  }, []);

  const onPanelRequestResult = useCallback((sequence: number, allowed: boolean): void => {
    const pending = pendingPanelRequestRef.current;
    if (!pending || pending.sequence !== sequence) return;
    if (!pending.commit) return;
    if (!allowed) {
      pendingPanelRequestRef.current = null;
      setRouteTransitionSequence((current) => current === sequence ? undefined : current);
      return;
    }
    const current = routeContextRef.current;
    if (current.key !== pending.origin.key || current.identity !== pending.origin.identity || current.scope !== pending.origin.scope) return;
    pending.committing = true;
    setRouteTransitionSequence((currentSequence) => currentSequence === sequence ? undefined : currentSequence);
    authorizedRouteChangeRef.current = { originKey: pending.origin.key, expectedIdentity: pending.expectedIdentity };
    pending.commit();
    setSwitchError("");
  }, []);

  const isRouteSelectionCurrent = useCallback((key: string): boolean => routeSelectionKeyRef.current === key, []);

  const onRouteSelectionResult = useCallback((key: string, allowed: boolean): void => {
    if (routeSelectionKeyRef.current !== key) return;
    if (allowed) {
      lastStableLocationRef.current = routeContextRef.current;
      return;
    }
    const stable = lastStableLocationRef.current;
    if (routeContextRef.current.key === stable.key && routeContextRef.current.identity === stable.identity) return;
    navigateRoute({ pathname: stable.pathname, search: stable.search, hash: stable.hash }, {
      replace: true,
      state: stable.state,
    });
  }, [navigateRoute]);

  useEffect(() => {
    if (!requestedPanel?.id || !requestedPanel.sequence) return;
    const requestKey = `${requestedPanel.id}:${requestedPanel.sequence}`;
    if (forwardedPanelRequestRef.current === requestKey) return;
    forwardedPanelRequestRef.current = requestKey;
    setReferenceSheet(null);
    queueWorkspacePanel(requestedPanel.id);
  }, [requestedPanel?.id, requestedPanel?.sequence, queueWorkspacePanel]);

  const navigate = useCallback(async (view: MobileView) => {
    const sameRoute = view === activeView;
    if (sameRoute && !hasWorkspace) return;
    if (sameRoute && view === "settings") return;
    setReferenceSheet(null);
    if (hasWorkspace) {
      const targetRoute = sameRoute ? "" : withViewInCurrentUrl(view);
      const commitRoute = sameRoute ? undefined : () => navigateRoute(targetRoute, {
        state: {
          ...historyState(location.state),
          [MOBILE_PREVIOUS_VIEW_STATE]: activeView,
        },
      });
      const panelId = workspacePanelForView(view);
      if (panelId) {
        queueWorkspacePanel(panelId, commitRoute, targetRoute || undefined);
      } else if (await preparePanelChange()) {
        commitRoute?.();
      }
      return;
    }
    if (!(await preparePanelChange())) return;
    navigateRoute(withViewInCurrentUrl(view), {
      state: {
        ...historyState(location.state),
        [MOBILE_PREVIOUS_VIEW_STATE]: activeView,
      },
    });
    setSwitchError("");
  }, [activeView, hasWorkspace, location.state, navigateRoute, preparePanelChange, queueWorkspacePanel]);

  const goBack = useCallback(async () => {
    if (referenceSheet) {
      setReferenceSheet(null);
      return;
    }
    const previous = historyState(location.state)[MOBILE_PREVIOUS_VIEW_STATE];
    if (isMobileView(previous)) {
      if (hasWorkspace) {
        const panelId = workspacePanelForView(previous);
        if (panelId) {
          queueWorkspacePanel(panelId, () => navigateRoute(-1), withViewInCurrentUrl(previous));
        } else if (await preparePanelChange()) {
          navigateRoute(-1);
        }
        return;
      }
      if (!(await preparePanelChange())) return;
      navigateRoute(-1);
      return;
    }
    await navigate(activeView === "writing" ? "library" : "writing");
  }, [activeView, hasWorkspace, location.state, navigate, navigateRoute, preparePanelChange, queueWorkspacePanel, referenceSheet]);

  const switchToDesktop = useCallback(async () => {
    if (switching) return;
    setSwitching(true);
    setSwitchError("");
    try {
      const switched = await onSwitchMode();
      if (!switched) {
        setSwitchError("回復記録を確認できないため切り替えませんでした。入力はこの画面に残っています。表示中の状態を確認してから、もう一度お試しください。");
      }
    } catch (error) {
      setSwitchError(errorMessage(error));
    } finally {
      setSwitching(false);
    }
  }, [onSwitchMode, switching]);

  const openReferenceSheet = useCallback(async (kind: ReferenceSheet, trigger: HTMLButtonElement) => {
    if (referenceSheet !== null) {
      setReferenceSheet(kind);
      return;
    }
    if (openingReferenceRef.current || !workspaceScope || !panels?.some((panel) => panel.id === kind)) return;
    openingReferenceRef.current = true;
    referenceTriggerRef.current = trigger;
    const routeAtStart = routeIdentityRef.current;
    const routeKeyAtStart = routeContextRef.current.key;
    const scopeAtStart = workspaceScope;
    referenceOriginRef.current = routeAtStart;
    setOpeningReference(true);
    try {
      // Do not hide an editing/composition failure behind a sheet.
      const allowed = await preparePanelChange();
      const current = routeContextRef.current;
      if (allowed && current.identity === routeAtStart && current.key === routeKeyAtStart && current.scope === scopeAtStart) {
        setReferenceSheet(kind);
      }
    } finally {
      openingReferenceRef.current = false;
      setOpeningReference(false);
    }
  }, [location.key, panels, preparePanelChange, referenceSheet, workspaceScope]);

  const closeReferenceSheet = useCallback(() => setReferenceSheet(null), []);
  const onReferenceDismissed = useCallback(() => {
    setReferenceSheet(null);
    // Return to the invoking control, not to a contenteditable element:
    // restoring input focus would unexpectedly reopen the soft keyboard.
    const trigger = referenceTriggerRef.current;
    if (trigger?.isConnected && routeIdentityRef.current === referenceOriginRef.current &&
        readViewFromSearch(window.location.search) === "writing") {
      trigger.focus({ preventScroll: true });
    }
  }, []);

  const referencePanel = referenceSheet ? panels?.find((panel) => panel.id === referenceSheet) : undefined;
  const hasWritingContext = activeView === "writing" && Boolean(documentTitle) && Boolean(workspaceScope)
    && Boolean(panels?.some((panel) => panel.id === "outline"))
    && Boolean(panels?.some((panel) => panel.id === "inspector"));

  const title = VIEWS.find((view) => view.id === activeView)?.title ?? "Proprium";
  const mobileTitle = activeView === "writing" && documentTitle ? documentTitle : title;
  const statusContent = switchError
    ? renderStatus?.(switchError) ?? status
    : status;
  const hasStatusContent = statusContent !== null && statusContent !== undefined && statusContent !== false;
  const settingsContent = (
    <section className="mobile-shell-settings-card" aria-labelledby="mobile-display-settings-title">
      <h2 id="mobile-display-settings-title">表示とアカウント</h2>
      {settings ?? <p>この画面に表示できる設定項目はまだありません。外観とアカウントの操作は画面上部から行えます。</p>}
      <IonButton className="mobile-shell-primary-action" expand="block" onClick={() => void navigate(hasWorkspace ? "writing" : "library")}>
        {hasWorkspace ? "執筆画面へ戻る" : "作品を開く"}
      </IonButton>
      <IonButton className="mobile-shell-primary-action" expand="block" disabled={switching} onClick={() => void switchToDesktop()}>
        {switching ? "切り替えています…" : "Desktop版へ切り替え"}
      </IonButton>
      {switchError ? <p className="mobile-shell-switch-error" role="alert">{switchError}</p> : null}
    </section>
  );
  return (
    <IonApp className={"mobile-shell" + (writingKeyboardVisible ? " mobile-shell-keyboard-open" : "")}>
      <IonPage className="mobile-shell-page">
        <IonHeader className="mobile-shell-ion-header">
          <div className="mobile-shell-identity-bar">
            <IonButton type="button" className="mobile-shell-back" fill="clear" aria-label="前の画面に戻る" onClick={goBack}>‹</IonButton>
            <div className="mobile-shell-identity-copy">
              <span className="mobile-shell-wordmark">proprium<span>.</span></span>
              <strong className="mobile-shell-current-title">{mobileTitle}</strong>
              {documentContext && activeView === "writing" ? <small className="mobile-shell-context">{documentContext}</small> : null}
            </div>
            <span className="mobile-shell-page-mark" aria-hidden="true">{VIEWS.find((view) => view.id === activeView)?.mark}</span>
          </div>
          <div className="mobile-shell-shared-header" aria-label="アカウントと画面設定">{header}</div>
        </IonHeader>

        <IonContent ref={contentRef} className="mobile-shell-content" fullscreen={false}>
          {hasWorkspace ? (
            <div className="mobile-shell-workspace-view" data-active-view={activeView}
              aria-label={activeView === "settings" ? "設定" : "モバイル用執筆画面"}>
              <div className="mobile-shell-workspace-panel" hidden={activeView === "settings"}>
                <Workspace
                  scope={workspaceScope!}
                  mode="mobile"
                  panels={panels!}
                  beforeLayoutChange={beforeLayoutChange}
                  requestedPanel={workspacePanelRequest}
                  selectedPanelId={workspacePanelForView(activeView)}
                  routeTransitionSequence={routeTransitionSequence}
                  isPanelRequestCurrent={isPanelRequestCurrent}
                  onPanelRequestResult={onPanelRequestResult}
                  routeSelectionKey={routeSelectionKey}
                  isRouteSelectionCurrent={isRouteSelectionCurrent}
                  onRouteSelectionResult={onRouteSelectionResult}
                />
              </div>
              {activeView === "settings" ? settingsContent : null}
            </div>
          ) : <div className="mobile-shell-view-stack" data-active-view={activeView}>
            <section className="mobile-shell-view" aria-labelledby="mobile-library-title" hidden={activeView !== "library"}>
              <h1 id="mobile-library-title" className="mobile-shell-page-title sr-only">作品ライブラリ</h1>
              <div className="mobile-shell-slot mobile-shell-library">{library}</div>
            </section>

            <section className="mobile-shell-view" aria-labelledby="mobile-writing-title" hidden={activeView !== "writing"}>
              <h1 id="mobile-writing-title" className="mobile-shell-page-title">執筆・読書</h1>
              <div className="mobile-shell-slot mobile-shell-editor">
                <section className="mobile-shell-empty-state" aria-labelledby="mobile-writing-empty-title">
                  <h2 id="mobile-writing-empty-title">原稿を開いていません</h2>
                  <p>作品を開くと、ここで執筆や読書を続けられます。まず作品ライブラリで作品を選んでください。</p>
                  <IonButton className="mobile-shell-primary-action" expand="block" onClick={() => void navigate("library")}>
                    作品ライブラリを開く
                  </IonButton>
                </section>
              </div>
            </section>

            <section className="mobile-shell-view" aria-labelledby="mobile-inspection-title" hidden={activeView !== "inspection"}>
              <h1 id="mobile-inspection-title" className="mobile-shell-page-title">状態と回復</h1>
              <div className="mobile-shell-empty-state" aria-labelledby="mobile-inspection-empty-title">
                <h2 id="mobile-inspection-empty-title">確認する作品がありません</h2>
                <p>作品を開くと、保存状態や回復情報、変更の確認先が表示されます。</p>
                <IonButton className="mobile-shell-primary-action" expand="block" onClick={() => void navigate("library")}>
                  作品ライブラリを開く
                </IonButton>
              </div>
            </section>

            <section className="mobile-shell-view" aria-labelledby="mobile-tools-title" hidden={activeView !== "tools"}>
              <h1 id="mobile-tools-title" className="mobile-shell-page-title">ツールとレビュー</h1>
              {activeView === "tools" ? <div className="mobile-shell-slot mobile-shell-tools">{tools}</div> : null}
              {!hasWorkspace ? (
                <section className="mobile-shell-empty-state" aria-labelledby="mobile-tools-empty-title">
                  <h2 id="mobile-tools-empty-title">道具を使う作品を開いてください</h2>
                  <p>作品を開くと、その作品で利用できる機能やレビューがここに表示されます。</p>
                  <IonButton className="mobile-shell-primary-action" expand="block" onClick={() => void navigate("library")}>
                    作品ライブラリを開く
                  </IonButton>
                </section>
              ) : null}
            </section>

            <section className="mobile-shell-view" aria-labelledby="mobile-settings-title" hidden={activeView !== "settings"}>
              <h1 id="mobile-settings-title" className="mobile-shell-page-title">設定</h1>
              {settingsContent}
            </section>
          </div>}
        </IonContent>

        {hasStatusContent ? <div className="mobile-shell-status" role="region" aria-label="保存と回復の状態">
          {statusContent}
        </div> : null}
        <IonFooter className="mobile-shell-footer">
          {hasWritingContext ? (
            <div className="mobile-shell-writing-accessories" aria-label="執筆中の参照">
              <span className="mobile-shell-accessories-label" aria-hidden="true">REFERENCES</span>
              <button type="button" className="mobile-shell-accessory-button" disabled={openingReference}
                aria-label="構成または保存状態を参照" onClick={(event) => { void openReferenceSheet("outline", event.currentTarget); }}>
                <span aria-hidden="true">☷</span> 構成・保存状態を参照
              </button>
            </div>
          ) : null}
          {hasWorkspace ? (
            <details className="mobile-shell-navigation-menu" ref={workspaceNavigationRef}>
              <summary aria-label="別の画面へ移動">
                <span>画面を移動</span>
                <span className="mobile-shell-navigation-current">{VIEWS.find((view) => view.id === activeView)?.label}</span>
              </summary>
              <nav className="mobile-shell-navigation" aria-label="モバイル画面">
                {VIEWS.map((view) => (
                  <IonButton
                    key={view.id}
                    type="button"
                    className="mobile-shell-nav-button"
                    fill={activeView === view.id ? "solid" : "clear"}
                    aria-current={activeView === view.id ? "page" : undefined}
                    onClick={() => {
                      void navigate(view.id).finally(() => {
                        if (workspaceNavigationRef.current) workspaceNavigationRef.current.open = false;
                      });
                    }}
                  >
                    <span className="mobile-shell-nav-content">
                      <span className="mobile-shell-nav-mark" aria-hidden="true">{view.mark}</span>
                      <span>{view.label}</span>
                    </span>
                  </IonButton>
                ))}
              </nav>
            </details>
          ) : (
            <nav className="mobile-shell-navigation" aria-label="モバイル画面">
              {VIEWS.map((view) => (
                <IonButton
                  key={view.id}
                  type="button"
                  className="mobile-shell-nav-button"
                  fill={activeView === view.id ? "solid" : "clear"}
                  aria-current={activeView === view.id ? "page" : undefined}
                  onClick={() => navigate(view.id)}
                >
                  <span className="mobile-shell-nav-content">
                    <span className="mobile-shell-nav-mark" aria-hidden="true">{view.mark}</span>
                    <span>{view.label}</span>
                  </span>
                </IonButton>
              ))}
            </nav>
          )}
        </IonFooter>
      </IonPage>
      <IonModal
        className="mobile-shell-reference-modal"
        isOpen={referenceSheet !== null}
        onDidDismiss={onReferenceDismissed}
        breakpoints={[0, 0.56, 0.88, 1]}
        initialBreakpoint={0.56}
        handle={true}
        handleBehavior="cycle"
        expandToScroll={false}
        htmlAttributes={{ "aria-labelledby": "mobile-shell-reference-title" }}
      >
        <IonContent className="mobile-shell-reference-content" scrollY={true}>
          <div className="mobile-shell-reference-top">
            <div>
              <p className="mobile-shell-reference-eyebrow">WRITING CONTEXT</p>
              <h2 id="mobile-shell-reference-title">原稿の参照</h2>
            </div>
            <button type="button" className="mobile-shell-reference-close" onClick={closeReferenceSheet}>
              閉じる
            </button>
          </div>
          <div className="mobile-shell-reference-switch" role="tablist" aria-label="参照する情報">
            {([
              { id: "outline", label: "構成" },
              { id: "inspector", label: "保存状態" },
            ] as const).map((choice) => (
              <button type="button" role="tab" key={choice.id}
                id={"mobile-reference-tab-" + choice.id}
                aria-selected={referenceSheet === choice.id}
                aria-controls="mobile-shell-reference-pane"
                tabIndex={referenceSheet === choice.id ? 0 : -1}
                onKeyDown={(event) => {
                  const next = event.key === "ArrowRight" || event.key === "End" ? "inspector"
                    : event.key === "ArrowLeft" || event.key === "Home" ? "outline" : null;
                  if (!next) return;
                  event.preventDefault();
                  setReferenceSheet(next);
                  event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
                    "#mobile-reference-tab-" + next,
                  )?.focus();
                }}
                onClick={() => setReferenceSheet(choice.id)}>
                {choice.label}
              </button>
            ))}
          </div>
          <div id="mobile-shell-reference-pane" className="mobile-shell-reference-pane"
            role="tabpanel"
            aria-labelledby={referenceSheet ? "mobile-reference-tab-" + referenceSheet : undefined}
            data-mobile-reference-panel={referenceSheet ?? undefined}>
            {referenceSheet === "inspector" && desktopDurability ? (
              <div className="mobile-shell-reference-durability" role="status" aria-label="原稿の保存状態">
                <strong>{{
                  draft: "Draft", checkpointing: "Checkpoint確認中",
                  checkpointed: "Checkpoint", publication_unknown: "Publish結果未確認",
                  saved: "GitHub保存済み",
                }[desktopDurability]}</strong>
                <span>{{
                  draft: "ブラウザーの下書きです。GitHubへの保存はまだ確認されていません。",
                  checkpointing: "ローカルCheckpointの結果を確認しています。",
                  checkpointed: "ローカルCheckpointです。GitHubへの公開は完了していません。",
                  publication_unknown: "GitHubへの保存結果は未確認です。原稿の回復記録を保持しています。",
                  saved: "GitHubへの保存が確認されています。",
                }[desktopDurability]}</span>
              </div>
            ) : null}
            {referencePanel?.render() ?? <p>この情報は現在利用できません。</p>}
          </div>
          <p className="mobile-shell-reference-hint">上のハンドルを上下に動かすと、参照領域を広げたり閉じたりできます。</p>
        </IonContent>
      </IonModal>
    </IonApp>
  );
}
