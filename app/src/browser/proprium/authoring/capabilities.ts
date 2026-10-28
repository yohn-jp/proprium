/** One mapping for admission, runtime continuations and Host dispatch. */
export function capabilityForHostOperation(operation: string): string {
  if (operation === "actions.list") return "workspace.plugin.invoke";
  if (operation === "workspace.file.list" || operation === "workspace.file.read") return "workspace.file.read";
  if (["workspace.derived.cache.get", "workspace.derived.cache.get_previous", "workspace.derived.cache.put", "workspace.derived.cache.evict",
    "workspace.derived.cache.evict_previous", "workspace.derived.cache.evict_prefix", "workspace.derived.cache.evict_previous_prefix"].includes(operation)) {
    return "workspace.derived.cache";
  }
  if (operation === "actions.list") return "workspace.plugin.invoke";
  if (operation === "plugin.preferences.read") return "plugin.preferences";
  return operation;
}
