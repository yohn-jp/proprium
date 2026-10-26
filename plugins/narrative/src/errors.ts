export class NarrativeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>, retryable = false) {
    super(message);
    this.name = "NarrativeError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new NarrativeError(code, message, details);
}
