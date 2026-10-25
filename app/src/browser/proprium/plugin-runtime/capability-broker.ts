import type { ChangeProposal, ReadRevision, SnapshotEntry, UiContribution } from "./wit/generated/interfaces/proprium-plugin-host.js";
import { LIMITS, PluginRuntimeError, type PluginCapability, type PluginTranscript, type RuntimeSnapshotFile, type WorkerRequest, isSafePluginPath, utf8Size } from "./protocol.js";

export class CapabilityBroker {
  private readonly files = new Map<string, RuntimeSnapshotFile>();
  private readonly reads = new Map<string, ReadRevision>();
  private readonly proposals: ChangeProposal[] = [];
  private readonly contributions: UiContribution[] = [];
  private proposalChanges = 0;
  private proposalReadEntries = 0;
  private proposalBytes = 0;

  constructor(
    readonly capabilities: ReadonlySet<PluginCapability>,
    readonly request: Extract<WorkerRequest, { type: "invoke" }>,
    private readonly requireCompleteReadSet = true,
  ) {
    if (request.grants.length !== capabilities.size || request.grants.some(grant => !capabilities.has(grant))) {
      throw new PluginRuntimeError("malformed_message", "Invocation capability set differs from the active grant set");
    }
    for (const file of request.snapshot.files) this.files.set(file.path, file);
  }

  snapshotList(): SnapshotEntry[] {
    this.require("workspace.snapshot.read");
    return [...this.files.values()].map(({ path, revision }) => {
      this.recordRead({ path, revision });
      return Object.freeze({ path, revision });
    });
  }

  snapshotRead(path: string): string | undefined {
    this.require("workspace.snapshot.read");
    if (!isSafePluginPath(path)) throw new PluginRuntimeError("invalid_input", "Snapshot path is invalid");
    const file = this.files.get(path);
    this.recordRead({ path, ...(file ? { revision: file.revision } : {}) });
    return file?.content;
  }

  validateRead(read: ReadRevision): void {
    this.require("workspace.snapshot.read");
    if (!read || !isSafePluginPath(read.path)) throw new PluginRuntimeError("invalid_input", "Snapshot read provenance is invalid");
    const current = this.files.get(read.path);
    if (current?.revision !== read.revision) throw new PluginRuntimeError("snapshot_stale", `Read revision for ${read.path} is stale`);
    this.recordRead(read);
  }

  proposeChange(proposal: ChangeProposal): void {
    this.require("workspace.change.propose");
    if (!proposal || proposal.snapshotId !== this.request.snapshot.id || proposal.snapshotRevision !== this.request.snapshot.revision ||
        !Array.isArray(proposal.readSet) || proposal.readSet.length > LIMITS.snapshotFiles || !Array.isArray(proposal.changes) ||
        proposal.changes.length === 0) {
      throw new PluginRuntimeError("snapshot_stale", "Change proposal does not match the active snapshot");
    }
    if (proposal.changes.length > LIMITS.proposalChanges - this.proposalChanges ||
        proposal.readSet.length > LIMITS.proposalReadEntries - this.proposalReadEntries) {
      throw new PluginRuntimeError("invalid_input", "Change proposals exceed the per-invocation budget");
    }

    const declaredReads = new Map<string, ReadRevision>();
    let size = 0;
    for (const read of proposal.readSet) {
      if (!read || !isSafePluginPath(read.path) || declaredReads.has(read.path)) {
        throw new PluginRuntimeError("invalid_input", "Change proposal read set contains an invalid or duplicate path");
      }
      const current = this.files.get(read.path);
      if (current?.revision !== read.revision) throw new PluginRuntimeError("snapshot_stale", `Read revision for ${read.path} is stale`);
      declaredReads.set(read.path, Object.freeze({ path: read.path, ...(read.revision === undefined ? {} : { revision: read.revision }) }));
      size += utf8Size(read.path) + utf8Size(read.revision ?? "");
    }
    if (this.requireCompleteReadSet && (declaredReads.size !== this.reads.size || [...this.reads].some(([path, read]) => {
      const declared = declaredReads.get(path);
      return !declared || declared.revision !== read.revision;
    }))) {
      throw new PluginRuntimeError("invalid_input", "Change proposal must declare every revision read for this request");
    }
    if (!this.requireCompleteReadSet && [...declaredReads].some(([path, read]) => this.reads.get(path)?.revision !== read.revision)) {
      throw new PluginRuntimeError("invalid_input", "Change proposal read set differs from the Worker read transcript");
    }

    const seen = new Set<string>();
    for (const change of proposal.changes) {
      if (!change || !isSafePluginPath(change.path) || seen.has(change.path) || typeof change.content !== "string") {
        throw new PluginRuntimeError("invalid_input", "Change proposal contains an invalid or duplicate path");
      }
      seen.add(change.path);
      const current = this.files.get(change.path);
      if ((current && change.expectedRevision !== current.revision) || (!current && change.expectedRevision !== undefined)) {
        throw new PluginRuntimeError("snapshot_stale", `Expected revision for ${change.path} is stale`);
      }
      const contentBytes = utf8Size(change.content);
      if (contentBytes > LIMITS.proposalFileBytes) throw new PluginRuntimeError("invalid_input", "A proposed file exceeds the byte limit");
      size += utf8Size(change.path) + utf8Size(change.expectedRevision ?? "") + contentBytes;
    }
    if (this.proposalChanges + proposal.changes.length > LIMITS.proposalChanges ||
        this.proposalReadEntries + proposal.readSet.length > LIMITS.proposalReadEntries ||
        this.proposalBytes + size > LIMITS.proposalBytes) {
      throw new PluginRuntimeError("invalid_input", "Change proposals exceed the per-invocation budget");
    }
    this.proposalChanges += proposal.changes.length;
    this.proposalReadEntries += proposal.readSet.length;
    this.proposalBytes += size;
    this.proposals.push(Object.freeze({
      snapshotId: proposal.snapshotId,
      snapshotRevision: proposal.snapshotRevision,
      readSet: Object.freeze([...declaredReads.values()]) as unknown as ChangeProposal["readSet"],
      changes: Object.freeze(proposal.changes.map(change => Object.freeze({ ...change }))) as unknown as ChangeProposal["changes"],
    }));
  }

  uiContribute(contribution: UiContribution): void {
    this.require("workspace.ui.contribute");
    if (!contribution || !["panel", "command"].includes(contribution.kind) ||
        !/^[a-z][a-z0-9-]{0,62}$/u.test(contribution.id) || typeof contribution.title !== "string" ||
        contribution.title.trim().length === 0 || contribution.title.length > 80 || this.contributions.length >= 32) {
      throw new PluginRuntimeError("invalid_input", "UI contribution is invalid or exceeds the limit");
    }
    this.contributions.push(Object.freeze({ kind: contribution.kind, id: contribution.id, title: contribution.title }));
  }

  transcript(value: string): PluginTranscript {
    if (typeof value !== "string" || utf8Size(value) > LIMITS.outputBytes) {
      throw new PluginRuntimeError("invalid_input", "Plugin output exceeds the byte limit");
    }
    const request = this.request;
    const transcript: PluginTranscript = Object.freeze({
      requestId: request.id, sessionId: request.sessionId, epoch: request.epoch,
      pluginId: request.pluginId, version: request.version, digest: request.digest,
      workspaceId: request.workspaceId, deadlineAt: request.deadlineAt, grants: Object.freeze([...request.grants]),
      snapshotId: request.snapshot.id, snapshotRevision: request.snapshot.revision, value,
      reads: Object.freeze([...this.reads.values()]),
      proposals: Object.freeze([...this.proposals]), contributions: Object.freeze([...this.contributions]),
    });
    if (utf8Size(JSON.stringify(transcript)) > LIMITS.outputBytes) {
      throw new PluginRuntimeError("invalid_input", "Plugin transcript exceeds the byte limit");
    }
    return transcript;
  }

  private recordRead(read: ReadRevision): void {
    const current = this.files.get(read.path);
    if (current?.revision !== read.revision) throw new PluginRuntimeError("snapshot_stale", `Read revision for ${read.path} is stale`);
    this.reads.set(read.path, Object.freeze({ path: read.path, ...(read.revision === undefined ? {} : { revision: read.revision }) }));
  }

  private require(capability: PluginCapability): void {
    if (Date.now() >= this.request.deadlineAt) throw new PluginRuntimeError("timeout", "Plugin capability request exceeded its deadline");
    if (!this.capabilities.has(capability)) throw new PluginRuntimeError("capability_denied", `Plugin lacks ${capability}`);
  }
}
