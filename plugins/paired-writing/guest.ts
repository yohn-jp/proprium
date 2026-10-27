import type { ActionRequest } from "../../app/src/browser/proprium/authoring/types.js";
import { createGuest } from "../shared/guest.js";
import { captureContext, readContextManifest } from "./src/context.js";
import { proposeRewrite, suggestRewrite } from "./src/rewrite.js";
import { changeSetObservations, changeSetStatus, inspectChangeSet, listChangeSets, readProposalContent } from "./src/receipts.js";
import { previewSynonyms } from "./src/synonym-preview.js";
import { proposeWorkspaceSettings, readWorkspaceSettings } from "./src/settings.js";
import { proposeChangeSet, validateChangeSet } from "./src/changeset-workflow.js";

export const guest = createGuest("proprium.paired-writing", {
  "paired.synonyms.preview": (input, context, host) => previewSynonyms(input, host, context as ActionRequest),
  "paired.workspace-settings.propose": (input, context, host) => proposeWorkspaceSettings(input, host, context as ActionRequest),
  "paired.workspace-settings.read": (input, context, host) => readWorkspaceSettings(input, host, context as ActionRequest),
  "paired.context.capture": (input, context, host) => captureContext(input, host, context as ActionRequest),
  "paired.context.manifest": (input, context, host) => readContextManifest(input, host, context as ActionRequest),
  "paired.rewrite.suggest": (input, context, host) => suggestRewrite(input, host, context as ActionRequest),
  "paired.rewrite.propose": (input, context, host) => proposeRewrite(input, host, context as ActionRequest),
  "paired.changeset.list": (input, _context, host) => listChangeSets(input, host),
  "paired.changeset.status": (input, _context, host) => changeSetStatus(input, host),
  "paired.changeset.observations": (input, _context, host) => changeSetObservations(input, host),
  "paired.changeset.inspect": (input, _context, host) => inspectChangeSet(input, host),
  "paired.changeset.content.read": (input, _context, host) => readProposalContent(input, host),
  "paired.changeset.validate": (input, context, host) => validateChangeSet(input, host, context as ActionRequest),
  "paired.changeset.propose": (input, context, host) => proposeChangeSet(input, host, context as ActionRequest),
});
