/** Serialize one Worker's own requests before trying the cross-tab Web Lock. */
export class WorkspaceOperationQueue {
  private readonly pending = new Map<string, Promise<void>>();

  run<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.pending.get(workspace) ?? Promise.resolve()).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.pending.set(workspace, settled);
    void settled.then(() => {
      if (this.pending.get(workspace) === settled) this.pending.delete(workspace);
    });
    return result;
  }
}
