import { PairedError } from "./types.js";

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new PairedError("invalid_input", `${label} must be an object`);
  return value;
}

export function exactKeys(value: JsonRecord, allowed: readonly string[], label: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw new PairedError("invalid_input", `${label} contains unsupported field: ${key}`);
  }
}

export function identity(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new PairedError("invalid_input", `${label} must be a string of 1 to ${maximum} characters`);
  }
  return value;
}

export function finiteInteger(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new PairedError("invalid_input", `${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

/** Canonical source JSON limits from the pinned NarrativeChangeSet validator. */
export function assertBoundedJson(value: unknown, label: string): void {
  let visited = 0;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (++visited > 10_000 || current.depth > 16) throw new PairedError("capacity", `${label} exceeds source JSON limits`);
    const item = current.value;
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "string") {
      if (item.length > 100_000) throw new PairedError("capacity", `${label} contains an oversized string`);
      continue;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new PairedError("invalid_input", `${label} contains a non-finite number`);
      continue;
    }
    if (typeof item !== "object") throw new PairedError("invalid_input", `${label} must contain JSON data`);
    if (Array.isArray(item)) {
      if (item.length > 1_000) throw new PairedError("capacity", `${label} contains an oversized array`);
      for (const child of item) pending.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!isRecord(item) || Object.keys(item).length > 1_000) {
      throw new PairedError("invalid_input", `${label} must contain bounded plain JSON records`);
    }
    for (const [key, child] of Object.entries(item)) {
      if (key.length > 256 || ["__proto__", "prototype", "constructor"].includes(key)) {
        throw new PairedError("invalid_input", `${label} contains an unsafe key`);
      }
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch { throw new PairedError("invalid_input", `${label} is not serializable JSON`); }
  if (serialized.length > 1_000_000) throw new PairedError("capacity", `${label} exceeds the 1,000,000 character source limit`);
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function countUnicodeScalars(text: string): number {
  let count = 0;
  for (const _scalar of text) count++;
  return count;
}

export function filePath(value: unknown, label = "path"): string {
  const path = identity(value, label, 4096);
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
      path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new PairedError("invalid_path", `${label} must be a normalized relative workspace path`);
  }
  return path;
}
