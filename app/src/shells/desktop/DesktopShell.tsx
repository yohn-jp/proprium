import { useRef, useState } from "react";
import * as Separator from "@radix-ui/react-separator";
import * as Tabs from "@radix-ui/react-tabs";
import { Panel, PanelGroup, PanelResizeHandle, setNonce } from "react-resizable-panels";
import type { ApplicationShellProps } from "../../application/contracts";
import "./desktop.css";
import "../editorial.css";

const styleNonce = document.querySelector<HTMLMetaElement>('meta[name="scriptorium-style-nonce"]')?.content;
if (styleNonce) setNonce(styleNonce);

function describeFailure(reason: unknown): string {
  return reason instanceof Error && reason.message.trim()
    ? reason.message
    : "下書きの保存状態を確認してから、もう一度お試しください。";
}

export function DesktopShell({ header, library, editor, tools, status, onSwitchMode }: ApplicationShellProps) {
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const switchInFlight = useRef(false);

  async function switchToMobile(): Promise<void> {
    if (switchInFlight.current) return;
    switchInFlight.current = true;
    setSwitching(true);
    setSwitchError("");

    try {
      const switched = await onSwitchMode();
      if (!switched) {
        setSwitchError("モバイル画面へ切り替えられませんでした。保存状態を確認してから再試行してください。");
      }
    } catch (reason) {
      setSwitchError(`モバイル画面へ切り替えられませんでした。${describeFailure(reason)}`);
    } finally {
      switchInFlight.current = false;
      setSwitching(false);
    }
  }

  return (
    <div className="st-desktop-shell">
      <div className="st-desktop-chrome">
        <div className="st-desktop-header-slot">{header}</div>
        <div className="st-desktop-controls">
          <span className="st-desktop-workbench-label">執筆ワークベンチ</span>
          <button
            className="st-desktop-switch"
            type="button"
            onClick={() => void switchToMobile()}
            disabled={switching}
            aria-busy={switching}
          >
            {switching ? "切替中…" : "モバイルUIへ"}
          </button>
        </div>
      </div>

      <div className="st-desktop-status" role="region" aria-label="保存と接続の状態">{status}</div>
      {switchError && <p className="st-desktop-switch-error" role="alert">{switchError}</p>}

      <PanelGroup className="st-desktop-workbench" direction="horizontal" id="scriptorium-desktop-workbench">
        <Panel
          className="st-desktop-navigation-panel"
          defaultSize={28}
          minSize={18}
          maxSize={46}
          id="scriptorium-desktop-navigation"
          order={1}
        >
          <Tabs.Root className="st-desktop-navigation" defaultValue="library" orientation="horizontal">
            <Tabs.List className="st-desktop-panel-tabs" aria-label="ナビゲーションとツール">
              <Tabs.Trigger className="st-desktop-panel-tab" value="library">作品ライブラリ</Tabs.Trigger>
              <Tabs.Trigger className="st-desktop-panel-tab" value="tools">ツールと履歴</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content className="st-desktop-tab-content" value="library" forceMount>
              <section className="st-desktop-slot st-desktop-library-slot" aria-label="作品ライブラリ">
                {library}
              </section>
            </Tabs.Content>
            <Tabs.Content className="st-desktop-tab-content" value="tools">
              <section className="st-desktop-slot st-desktop-tools-slot" aria-label="ツールと履歴">
                {tools}
              </section>
            </Tabs.Content>
          </Tabs.Root>
        </Panel>

        <PanelResizeHandle
          className="st-desktop-resize-handle"
          aria-label="作品パネルと原稿パネルの幅を変更"
          aria-describedby="st-desktop-resize-help"
        >
          <Separator.Root className="st-desktop-resize-line" decorative orientation="vertical" />
        </PanelResizeHandle>

        <Panel
          className="st-desktop-editor-panel"
          defaultSize={72}
          minSize={42}
          id="scriptorium-desktop-editor"
          order={2}
        >
          <main className="st-desktop-editor-slot" aria-label="原稿の編集と読書" tabIndex={-1}>
            {editor}
          </main>
        </Panel>
      </PanelGroup>
      <span className="st-desktop-visually-hidden" id="st-desktop-resize-help">
        左右矢印キーでパネル幅を変更できます。
      </span>
    </div>
  );
}
