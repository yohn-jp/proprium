import { useCallback, useEffect, useRef, useState } from "react";
import { ProviderRequestConsentDialog } from "./ProviderRequestConsentDialog.js";
import { ProviderRequestError, type ProviderConsentRequest, type ProviderRequestBroker,
  type ProviderRequestPreview, type ProviderRequestResult } from "../authoring/providers.js";

interface PendingConsent {
  broker: ProviderRequestBroker;
  preview: ProviderRequestPreview;
  send(consent: object, signal?: AbortSignal): Promise<void>;
  cancel(): void;
}

/** One Host modal, shared by UI and MCP requests. Tokens never enter an Action input. */
export function useProviderConsent() {
  const [pending, setPending] = useState<PendingConsent | null>(null);
  const current = useRef<PendingConsent | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (pending && dialog.current && !dialog.current.open) dialog.current.showModal(); }, [pending]);
  useEffect(() => () => current.current?.cancel(), []);
  const request = useCallback<ProviderConsentRequest>((broker, preview, send, signal) => {
    if (current.current) return Promise.reject(new ProviderRequestError("capability_denied", "Another provider consent is already open."));
    if (signal?.aborted) return Promise.reject(new ProviderRequestError("cancelled", "Provider request cancelled."));
    return new Promise<ProviderRequestResult>((resolve, reject) => {
      let sending = false;
      const cancellation = new AbortController();
      const close = () => {
        signal?.removeEventListener("abort", cancel);
        if (current.current === item) { current.current = null; setPending(null); }
      };
      const cancel = () => {
        cancellation.abort();
        if (!sending) { close(); reject(new ProviderRequestError("cancelled", "Provider request cancelled.")); }
      };
      const item: PendingConsent = { broker, preview, cancel, send: async (consent, approvalSignal) => {
        sending = true;
        try { resolve(await send(consent, approvalSignal ? AbortSignal.any([approvalSignal, cancellation.signal]) : cancellation.signal)); }
        catch (error) { reject(error); }
        finally { close(); }
      } };
      current.current = item; setPending(item);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }, []);
  const view = pending ? <dialog ref={dialog} className="storage-recovery-dialog" aria-label="Provider request consent"
    onCancel={event => { event.preventDefault(); pending.cancel(); }}>
    <ProviderRequestConsentDialog broker={pending.broker} preview={pending.preview} onGranted={pending.send} onCancel={pending.cancel} />
  </dialog> : null;
  return { request, view };
}
