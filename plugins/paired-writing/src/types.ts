import type { ActionRequest, ActionResult, ChangeSet, Scope, Snapshot } from "../../../app/src/browser/proprium/authoring/types.js";
import type { GuestHost } from "../../shared/guest.js";
import { AuthoringError } from "../../../app/src/browser/proprium/authoring/types.js";

export type { ActionRequest, ActionResult, ChangeSet, Scope, Snapshot };
export type PairedHost = GuestHost;
export type ChangeSetUnit = ChangeSet["units"][number];
export type GenericOperation = ChangeSetUnit["operations"][number];

export class PairedError extends AuthoringError {
  constructor(code: string, message: string, details?: Record<string, unknown>, retryable = false) {
    super(code, message, retryable, details);
    this.name = "PairedError";
  }
}
