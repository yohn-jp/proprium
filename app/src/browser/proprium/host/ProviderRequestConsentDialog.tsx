import { useRef, useState, type MouseEvent } from "react";
import {
  ProviderRequestBroker,
  ProviderRequestError,
  type ProviderRequestPreview,
} from "../authoring/providers.js";

export interface ProviderRequestConsentDialogProps {
  readonly broker: ProviderRequestBroker;
  readonly preview: ProviderRequestPreview;
  readonly onGranted: (consent: object, signal: AbortSignal) => void | Promise<void>;
  readonly onCancel: () => void;
}

/** Host-rendered per-request consent. It performs no network or credential lookup. */
export function ProviderRequestConsentDialog({ broker, preview, onGranted, onCancel }: ProviderRequestConsentDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const { request, context, destination } = preview;
  const send = async (event: MouseEvent<HTMLButtonElement>) => {
    setError(undefined);
    setBusy(true);
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const consent = broker.authorize(event.nativeEvent, preview);
      await onGranted(consent, controller.signal);
    } catch (cause) {
      setError(cause instanceof ProviderRequestError ? cause.message : "The provider request could not be authorized.");
    } finally {
      if (activeRequest.current === controller) activeRequest.current = undefined;
      setBusy(false);
    }
  };
  const cancel = () => {
    activeRequest.current?.abort();
    onCancel();
  };

  return <section role="dialog" aria-modal="true" aria-labelledby="provider-consent-title" className="provider-consent">
    <h2 id="provider-consent-title">Send this exact request?</h2>
    <dl>
      <dt>Provider</dt><dd>{destination.provider_label} ({destination.provider_id})</dd>
      <dt>Destination</dt><dd><code>{destination.endpoint}</code></dd>
      <dt>Model</dt><dd>{destination.model_label} ({destination.model_id})</dd>
      <dt>Estimated cost</dt><dd>{destination.estimated_cost ?? "Not provided by Host configuration"}</dd>
      <dt>Purpose</dt><dd>{request.purpose}</dd>
      <dt>Output limit</dt><dd>{preview.output_limit_bytes.toLocaleString()} bytes</dd>
      <dt>Plugin action</dt><dd>{context.plugin_id} / {context.action_id}</dd>
      <dt>Workspace scope</dt><dd><pre>{pretty(context.scope)}</pre></dd>
      <dt>Snapshot</dt><dd><pre>{pretty(context.snapshot)}</pre></dd>
      <dt>Source manifest SHA-256</dt><dd><code>{preview.source_manifest_sha256}</code></dd>
    </dl>
    <h3>Exact payload</h3>
    <pre className="provider-consent__payload">{pretty(request.payload)}</pre>
    <h3>Exact source manifest</h3>
    <pre className="provider-consent__payload">{pretty(request.source_manifest)}</pre>
    {error && <p role="alert">{error}</p>}
    <div className="provider-consent__actions">
      <button type="button" onClick={cancel}>Cancel</button>
      <button type="button" onClick={send} disabled={busy}>
        {busy ? "Sending…" : "Send to this provider"}
      </button>
    </div>
  </section>;
}

function pretty(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? "null"; }
  catch { return "[unavailable]"; }
}
