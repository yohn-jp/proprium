import { sha256Hex } from "./sha256.js";

function canonicalValue(value: unknown, ancestors: Set<object>, budget: { nodes: number }, depth: number): string {
  if (depth > 32 || ++budget.nodes > 10_000) throw new TypeError("Series binding fingerprint exceeds its JSON bound");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)!;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Series binding fingerprint contains a non-finite number");
    return JSON.stringify(value)!;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Series binding fingerprint contains a cycle");
    ancestors.add(value);
    try { return `[${value.map((item) => canonicalValue(item, ancestors, budget, depth + 1)).join(",")}]`; }
    finally { ancestors.delete(value); }
  }
  if (typeof value === "object" && value !== null &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    if (ancestors.has(value)) throw new TypeError("Series binding fingerprint contains a cycle");
    const record = value as Record<string, unknown>;
    ancestors.add(value);
    try {
      return `{${Object.keys(record).sort().map((key) => {
        if (record[key] === undefined) throw new TypeError("Series binding fingerprint contains an undefined field");
        return `${JSON.stringify(key)}:${canonicalValue(record[key], ancestors, budget, depth + 1)}`;
      }).join(",")}}`;
    } finally { ancestors.delete(value); }
  }
  throw new TypeError("Series binding fingerprint must contain only JSON values");
}

/** RFC-style deterministic JSON for the parsed binding record, retaining all unknown fields. */
export function canonicalSeriesBindingJson(binding: Record<string, unknown>): string {
  return canonicalValue(binding, new Set(), { nodes: 0 }, 0);
}

/** Host-local preferences are namespaced by this exact source-record fingerprint. */
export function seriesBindingPreferenceKey(binding: Record<string, unknown>): string {
  return `series.binding.${sha256Hex(canonicalSeriesBindingJson(binding))}`;
}
