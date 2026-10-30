/**
 * Tracks short-lived, in-memory Browser Git snapshot handles. An active handle
 * can be kept alive only after its owner and source have been revalidated.
 */
export class AuthoringSnapshotLeases {
  private readonly expiresAt = new Map<string, number>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new RangeError("Snapshot lease TTL must be a positive safe integer.");
  }

  start(id: string): void {
    if (!id || this.expiresAt.has(id)) throw new Error("Snapshot lease identity is invalid or already active.");
    this.expiresAt.set(id, this.now() + this.ttlMs);
  }

  isActive(id: string): boolean {
    const expiresAt = this.expiresAt.get(id);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.expiresAt.delete(id);
      return false;
    }
    return true;
  }

  renewIfActive(id: string): boolean {
    if (!this.isActive(id)) return false;
    this.expiresAt.set(id, this.now() + this.ttlMs);
    return true;
  }

  release(id: string): void {
    this.expiresAt.delete(id);
  }

  pruneExpired(): string[] {
    const expired: string[] = [];
    for (const [id, expiresAt] of this.expiresAt) {
      if (expiresAt <= this.now()) {
        expired.push(id);
        this.expiresAt.delete(id);
      }
    }
    return expired;
  }
}

export type AuthoringSnapshotRenewal = "renewed" | "expired" | "source_changed";

/**
 * Refreshes a live lease only after an asynchronous same-source check passes.
 * The second ownership/expiry check prevents an in-flight check from reviving
 * a lease that was released or expired while the source was being inspected.
 */
export async function verifyAndRenewAuthoringSnapshot(
  leases: AuthoringSnapshotLeases,
  id: string,
  isOwned: () => boolean,
  sourceIsCurrent: () => Promise<boolean>,
): Promise<AuthoringSnapshotRenewal> {
  if (!isOwned() || !leases.isActive(id)) return "expired";
  const sameSource = await sourceIsCurrent();
  if (!isOwned() || !leases.isActive(id)) return "expired";
  if (!sameSource) return "source_changed";
  return leases.renewIfActive(id) ? "renewed" : "expired";
}
