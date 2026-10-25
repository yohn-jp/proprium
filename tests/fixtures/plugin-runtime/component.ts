import { snapshotRead } from "proprium:plugin/host@1.0.0";

interface Request { hang?: boolean; read?: boolean; trap?: boolean }

let workspaceId = "";

export const guest = {
  initialize(context: { workspaceId: string }): void {
    workspaceId = context.workspaceId;
  },
  invoke(raw: string): string {
    const request = JSON.parse(raw) as Request;
    if (request.hang) while (true) { /* Host deadline must terminate this component Worker. */ }
    if (request.trap) throw new Error("Fixture guest trap");
    if (request.read) snapshotRead("notes.md");
    return JSON.stringify({ workspaceId });
  },
  dispose(): void {
    workspaceId = "";
  },
};
