/**
 * Memoize only the filesystem used by Git's ignore matcher during ONE shared
 * workspace read lock. Rule files and missing ancestors cannot change within
 * that transaction; manuscript stats and all subsequent generations stay fresh.
 */
export function createIgnoreReadCache<T extends object>(filesystem: T): T {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(filesystem, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (methods.has(property)) return methods.get(property);
      const bound = value.bind(target);
      if (!["readFile", "stat", "lstat"].includes(String(property))) return bound;
      const cache = new Map<string, Promise<unknown>>();
      const memoized = (...args: unknown[]) => {
        const key = JSON.stringify(args);
        let pending = cache.get(key);
        if (!pending) { pending = Promise.resolve().then(() => bound(...args)); cache.set(key, pending); }
        return pending;
      };
      methods.set(property, memoized);
      return memoized;
    },
  });
}
