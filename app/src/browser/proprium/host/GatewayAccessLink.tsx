import type { ReactElement } from "react";

/** Build the Gateway landing URL without carrying user-supplied paths or credentials across origins. */
export function gatewayAccessLandingUrl(gatewayUrl: string): string | null {
  let gateway: URL;
  try { gateway = new URL(gatewayUrl.trim()); }
  catch { return null; }
  const loopback = gateway.protocol === "http:" && ["localhost", "127.0.0.1"].includes(gateway.hostname);
  if ((!loopback && gateway.protocol !== "https:") || gateway.username || gateway.password ||
      gateway.pathname !== "/" || gateway.search || gateway.hash) return null;
  return `${gateway.origin}/auth`;
}

export function GatewayAccessLink({ gatewayUrl }: { gatewayUrl: string }): ReactElement {
  const href = gatewayAccessLandingUrl(gatewayUrl);
  return <a className="gateway-access-link" href={href ?? undefined} target="_blank" rel="noopener noreferrer"
    aria-disabled={!href} tabIndex={href ? undefined : -1}>
    Cloudflare Accessにログイン
  </a>;
}
