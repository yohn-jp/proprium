import { useRef, useState } from "react";
import { FreshGestureAuthority } from "../authoring/brokers.js";
import { PublishingSecretBroker } from "../authoring/secrets.js";

export interface ShareLinkRevealProps {
  readonly broker: PublishingSecretBroker;
  readonly gestures: FreshGestureAuthority;
  readonly handle: string;
  readonly applied: boolean;
  readonly publicOrigin: string;
}

/** Owner UI affordance; the URL is revealed once and never enters plugin/MCP state. */
export function ShareLinkReveal({ broker, gestures, handle, applied, publicOrigin }: ShareLinkRevealProps) {
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("");
  const revealed = useRef(false);
  async function reveal(event: React.MouseEvent<HTMLButtonElement>) {
    if (revealed.current) return;
    revealed.current = true;
    setMessage("");
    try {
      const gesture = gestures.issue(event.nativeEvent);
      const oneTimeUrl = broker.revealApprovedUrl(handle, "ui", gesture, publicOrigin);
      try {
        await navigator.clipboard.writeText(oneTimeUrl);
        setUrl("");
        setMessage("共有リンクをコピーしました。GitHub に公開するまでは有効になりません。安全な場所に保存してください。");
      } catch {
        setUrl(oneTimeUrl);
        setMessage("リンクを表示しました。表示は一度だけです。GitHub に公開するまでは有効になりません。安全な場所にコピーしてください。");
      }
    } catch {
      setUrl("");
      setMessage("この共有リンクは表示できません。期限切れ、取消済み、または未承認の可能性があります。");
    }
  }
  return <section aria-label="共有リンク">
    {message && <p role="status">{message}</p>}
    {url && <label>
      共有リンク
      <input type="url" readOnly value={url} autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} />
    </label>}
    <button type="button" disabled={!applied || revealed.current} onClick={event => void reveal(event)}>
      {url ? "リンクは表示済み" : "承認済みリンクを一度だけ表示・コピー"}
    </button>
  </section>;
}
