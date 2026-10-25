import { proposeChange, snapshotList, snapshotRead, uiContribute } from "proprium:plugin/host@1.0.0";

interface Request {
  hang?: boolean;
  trap?: boolean;
  delay?: boolean;
  path: string;
  content: string;
  expectedRevision: string;
  snapshotId: string;
  snapshotRevision: string;
}

let workspaceId = "";

export const guest = {
  initialize(context: { workspaceId: string }): void {
    workspaceId = context.workspaceId;
  },
  invoke(raw: string): string {
    const request = JSON.parse(raw) as Request;
    if (request.hang) while (true) { /* Host deadline must terminate this component Worker. */ }
    if (request.trap) throw new Error("Fixture guest trap");
    const files = snapshotList();
    const before = snapshotRead(request.path) ?? null;
    let delayChecksum = 0;
    if (request.delay) {
      for (let index = 0; index < 50_000_000; index++) delayChecksum = (delayChecksum + index) & 0xffff;
    }
    proposeChange({
      snapshotId: request.snapshotId,
      snapshotRevision: request.snapshotRevision,
      readSet: [{ path: request.path, revision: request.expectedRevision }],
      changes: [{ path: request.path, expectedRevision: request.expectedRevision, content: request.content }],
    });
    uiContribute({ kind: "panel", id: "fixture-panel", title: "Fixture panel" });
    return JSON.stringify({ before, files, workspaceId, delayChecksum });
  },
  dispose(): void {
    workspaceId = "";
  },
};
