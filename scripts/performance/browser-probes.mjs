// Injected only into disposable benchmark pages. Never bundled into Core.
export function installBrowserProbes() {
  const metrics = window.__wave0 = { transactions: [], reads: [], reactCommits: [], longTasks: [], inputs: [] };
  try { new PerformanceObserver(list => metrics.longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration })))).observe({ type: 'longtask', buffered: true }); } catch { /* explicit capability in output */ }
  let renderer = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, checkDCE() {}, inject() { return ++renderer; },
    onCommitFiberRoot(id, root) {
      let fibers = 0, updated = 0;
      const visit = node => { for (let current = node; current; current = current.sibling) { fibers++; if (current.flags) updated++; if (current.child) visit(current.child); } };
      visit(root.current);
      metrics.reactCommits.push({ at: performance.now(), fibers, flaggedFibers: updated });
    },
    onCommitFiberUnmount() {},
  };
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function(...args) {
    const start = performance.now(), tx = Reflect.apply(transaction, this, args);
    const row = { start, mode: tx.mode, durability: tx.durability, stores: Array.from(tx.objectStoreNames), status: 'pending' };
    metrics.transactions.push(row);
    tx.addEventListener('complete', () => Object.assign(row, { ms: performance.now() - start, status: 'complete' }));
    tx.addEventListener('abort', () => Object.assign(row, { ms: performance.now() - start, status: 'aborted' }));
    return tx;
  };
  for (const method of ['get', 'getAll', 'getAllKeys', 'count', 'openCursor']) {
    const original = IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method] = function(...args) {
      const start = performance.now(), request = Reflect.apply(original, this, args);
      const row = { start, method, store: this.name }; metrics.reads.push(row);
      request.addEventListener('success', () => Object.assign(row, { ms: performance.now() - start,
        records: Array.isArray(request.result) ? request.result.length : request.result == null ? 0 : 1 }));
      return request;
    };
  }
  for (const type of ['keydown', 'beforeinput', 'compositionstart', 'compositionend']) {
    document.addEventListener(type, event => {
      if (!event.target.closest?.('.cm-content')) return;
      const start = performance.now(), row = { type, start, key: event.key, inputType: event.inputType };
      metrics.inputs.push(row);
      requestAnimationFrame(() => { row.frameMs = performance.now() - start; });
    }, true);
  }
}
