import { createGuest, type Handler } from "../shared/guest.js";
import type { ActionRequest, NarrativeHost } from "./src/contracts.js";
import { invokeNarrative, NARRATIVE_ACTIONS } from "./src/actions.js";

const handlers = Object.fromEntries(NARRATIVE_ACTIONS.map((action) => [
  action,
  (_input: Record<string, unknown>, context: Parameters<Handler>[1], host: Parameters<Handler>[2]) =>
    invokeNarrative(context as ActionRequest, host as NarrativeHost),
])) satisfies Record<string, Handler>;

export const guest = createGuest("proprium.narrative", handlers);
