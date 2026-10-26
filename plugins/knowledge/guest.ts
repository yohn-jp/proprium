import { createGuest } from "../shared/guest.js";
import { clearKnowledgeCache, knowledgeHandlers } from "./src/actions.js";

const lifecycle = createGuest("proprium.knowledge", knowledgeHandlers);

export const guest = {
  initialize: lifecycle.initialize,
  invoke: lifecycle.invoke,
  dispose(): void {
    lifecycle.dispose();
    clearKnowledgeCache();
  },
};
