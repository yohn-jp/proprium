import type { ModuleId } from "@scriptorium/contracts";

export const MODULE_IDS = ["story", "diagnostics", "nlp", "semantic", "speaker", "assistant", "publishing", "mcp", "search"] as const satisfies readonly ModuleId[];

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === "string" && (MODULE_IDS as readonly string[]).includes(value);
}

export class ModuleRuntimeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "ModuleRuntimeError";
    this.code = code;
    this.retryable = retryable;
  }
}
