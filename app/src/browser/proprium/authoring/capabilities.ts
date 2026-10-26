/** One mapping for admission, runtime continuations and Host dispatch. */
export function capabilityForHostOperation(operation: string): string {
  if (operation === "workspace.file.list" || operation === "workspace.file.read") return "workspace.file.read";
  if (["workspace.derived.cache.get", "workspace.derived.cache.put", "workspace.derived.cache.evict"].includes(operation)) {
    return "workspace.derived.cache";
  }
  if (operation === "plugin.preferences.read") return "plugin.preferences";
  return operation;
}
