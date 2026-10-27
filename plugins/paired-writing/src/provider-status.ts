import type { GuestHost, HostCall } from "../../shared/guest.js";
import { PairedError } from "./types.js";
import { exactKeys, record } from "./validation.js";

export function* readProviderStatus(input: unknown, host: GuestHost): Generator<HostCall, unknown, unknown> {
  exactKeys(record(input, "input"), [], "input");
  const status = record(yield* host.request("workspace.capabilities.query", { capability_id: "provider.request" }), "Host provider status");
  const local_features = { context: true, rewrite: true, qa_preview: true, synonym_preview: true };
  if (status.available !== true) throw new PairedError("provider_unavailable",
    "外部プロバイダーは設定されていません。本文の参照、ローカルの書換え候補、QA・類義語のプレビューは利用できます。", { local_features });
  if (!Array.isArray(status.provider_ids) || status.provider_ids.length > 64 ||
      status.provider_ids.some(id => typeof id !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/u.test(id))) {
    throw new PairedError("unsupported_format", "Host provider status is malformed");
  }
  return { available: true, provider_ids: status.provider_ids, queue: { state: "not_measured" }, local_features };
}
