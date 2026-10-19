import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { setNonce } from "@ionic/core/components";
import {
  IonApp,
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
  setupIonicReact,
} from "@ionic/react";
import { useLocation, useNavigate } from "react-router-dom";
import type { ApplicationShellProps } from "../../application/contracts";
import { Workspace } from "../../workspace/Workspace";
import "@ionic/react/css/core.css";
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";
import "./mobile.css";
import "../editorial.css";

export type MobileView = "library" | "writing" | "inspection" | "tools" | "settings";

const WORKSPACE_PANEL_FOR_VIEW: Readonly<Record<MobileView, string>> = {
  library: "outline",
  writing: "editor",
  inspection: "inspector",
  tools: "review",
  settings: "inspector",
};

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
export function MobileShell({ header, library, editor, tools, status, statusHasError = false, onSwitchMode, workspaceScope, panels, beforeLayoutChange, requestedPanel }: ApplicationShellProps) {
  const location = useLocation();
  const navigateRoute = useNavigate();
  const activeView = readViewFromSearch(location.search);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const contentRef = useRef<HTMLIonContentElement | null>(null);
  const activeViewRef = useRef(activeView);
  const scrollPositionsRef = useRef(new Map<MobileView, number>());

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
      if (!allowed) setSwitchError("The editor could not confirm its recovery state. The current screen is unchanged.");
      return allowed;
    } catch (error) {
      setSwitchError(errorMessage(error));
      return false;
    }
  }, [beforeLayoutChange]);

  const navigate = useCallback(async (view: MobileView) => {
    if (view === activeView || !(await preparePanelChange())) return;
    navigateRoute(withViewInCurrentUrl(view), {
      state: {
        ...historyState(location.state),
        [MOBILE_PREVIOUS_VIEW_STATE]: activeView,
      },
    });
    setSwitchError("");
  }, [activeView, location.state, navigateRoute, preparePanelChange]);

  const goBack = useCallback(async () => {
    const previous = historyState(location.state)[MOBILE_PREVIOUS_VIEW_STATE];
    if (isMobileView(previous)) {
      if (!(await preparePanelChange())) return;
      navigateRoute(-1);
      return;
    }
    await navigate(activeView === "writing" ? "library" : "writing");
  }, [activeView, location.state, navigate, navigateRoute, preparePanelChange]);

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

  const title = VIEWS.find((view) => view.id === activeView)?.title ?? "Scriptorium";
  const showSharedStatus = activeView === "inspection" || (activeView === "settings" && Boolean(switchError)) || statusHasError;
  const sharedStatusNode = showSharedStatus ? (
    <div className="mobile-shell-slot mobile-shell-status" aria-label="保存と回復の状態">{status}</div>
  ) : null;

  return (
    <IonApp className="mobile-shell">
      <IonPage className="mobile-shell-page">
        <IonHeader className="mobile-shell-ion-header">
          <IonToolbar className="mobile-shell-toolbar">
            <IonButtons slot="start">
              <IonButton type="button" fill="clear" aria-label="前の画面に戻る" onClick={goBack}>
                ← 戻る
              </IonButton>
            </IonButtons>
            <IonTitle>{title}</IonTitle>
          </IonToolbar>
          <div className="mobile-shell-shared-header">{header}</div>
        </IonHeader>

        <IonContent ref={contentRef} className="mobile-shell-content" fullscreen={false}>
          {workspaceScope && panels?.length ? (
            <div className="mobile-shell-workspace-view" data-active-view={activeView}>
              {showSharedStatus ? sharedStatusNode : null}
              {activeView === "settings" ? (
                <section className="mobile-shell-settings-card" aria-labelledby="mobile-display-settings-title">
                  <h2 id="mobile-display-settings-title">表示と入力</h2>
                  <p>外観やアカウントの操作は画面上部にあります。執筆画面では原稿を開いたまま各機能へ移動できます。</p>
                  <IonButton className="mobile-shell-primary-action" expand="block" disabled={switching} onClick={() => void switchToDesktop()}>
                    {switching ? "切り替えています…" : "Desktop版へ切り替え"}
                  </IonButton>
                  {switchError ? <p className="mobile-shell-switch-error" role="alert">{switchError}</p> : null}
                </section>
              ) : null}
              <Workspace
                scope={workspaceScope}
                mode="mobile"
                panels={panels}
                beforeLayoutChange={beforeLayoutChange}
                requestedPanel={requestedPanel}
                selectedPanelId={WORKSPACE_PANEL_FOR_VIEW[activeView]}
              />
            </div>
          ) : <div className="mobile-shell-view-stack" data-active-view={activeView}>
            <section className="mobile-shell-view" aria-labelledby="mobile-library-title" hidden={activeView !== "library"}>
              <h1 id="mobile-library-title" className="mobile-shell-page-title">作品ライブラリ</h1>
              <div className="mobile-shell-slot mobile-shell-library">{library}</div>
            </section>

            <section className="mobile-shell-view" aria-labelledby="mobile-writing-title" hidden={activeView !== "writing"}>
              <h1 id="mobile-writing-title" className="mobile-shell-page-title">執筆・読書</h1>
              <div className="mobile-shell-slot mobile-shell-editor">
                {workspaceScope && panels?.length
                  ? <Workspace scope={workspaceScope} mode="mobile" panels={panels} beforeLayoutChange={beforeLayoutChange} requestedPanel={requestedPanel} />
                  : editor}
              </div>
            </section>

            <section className="mobile-shell-view" aria-labelledby="mobile-inspection-title" hidden={activeView !== "inspection"}>
              <h1 id="mobile-inspection-title" className="mobile-shell-page-title">状態と回復</h1>
              {activeView === "inspection" ? sharedStatusNode : null}
              <p className="mobile-shell-review-hint">
                提案の確認と承認、選択した機能の実行はツール画面から行えます。
              </p>
              <IonButton className="mobile-shell-primary-action" expand="block" onClick={() => navigate("tools")}>
                提案と機能を確認
              </IonButton>
            </section>

            <section className="mobile-shell-view" aria-labelledby="mobile-tools-title" hidden={activeView !== "tools"}>
              <h1 id="mobile-tools-title" className="mobile-shell-page-title">ツールとレビュー</h1>
              {activeView === "tools" ? <div className="mobile-shell-slot mobile-shell-tools">{tools}</div> : null}
            </section>

            <section className="mobile-shell-view" aria-labelledby="mobile-settings-title" hidden={activeView !== "settings"}>
              <h1 id="mobile-settings-title" className="mobile-shell-page-title">設定</h1>
              <section className="mobile-shell-settings-card" aria-labelledby="mobile-display-settings-title">
                <h2 id="mobile-display-settings-title">表示と入力</h2>
                <p>外観やアカウントの操作は画面上部にあります。執筆画面では原稿を開いたまま各機能へ移動できます。</p>
                {activeView === "settings" && switchError ? sharedStatusNode : null}
                <IonButton className="mobile-shell-primary-action" expand="block" disabled={switching} onClick={() => void switchToDesktop()}>
                  {switching ? "切り替えています…" : "Desktop版へ切り替え"}
                </IonButton>
                {switchError ? <p className="mobile-shell-switch-error" role="alert">{switchError}</p> : null}
              </section>
            </section>
          </div>}
        </IonContent>

        <IonFooter className="mobile-shell-footer">
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
        </IonFooter>
      </IonPage>
    </IonApp>
  );
}
