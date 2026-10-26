import { createGuest } from "../../../plugins/shared/guest.js";

interface FileEntry { path: string; revision: string; byte_length: number; media_type: string }
interface FilePage { entries: FileEntry[]; next_cursor: string | null }
interface FileChunk { revision: string; total_bytes: number; offset: number; bytes: number[]; next_offset: number | null }

export const guest = createGuest("proprium.runtime-proof", {
  "proprium.runtime-proof.pages.read": function* (input, context, host) {
    const first = yield* host.request<FilePage>("workspace.file.list", {
      snapshot: context.snapshot, prefix: input.prefix, cursor: null, limit: 1,
    });
    if (first.entries.length !== 1 || first.next_cursor === null) {
      throw Object.assign(new Error("Fixture expected a second page"), { code: "invalid_input" });
    }
    const second = yield* host.request<FilePage>("workspace.file.list", {
      snapshot: context.snapshot, prefix: input.prefix, cursor: first.next_cursor, limit: 1,
    });
    const firstPath = first.entries[0]!.path;
    const bytes = yield* host.request<FileChunk>("workspace.file.read", {
      snapshot: context.snapshot, path: firstPath, offset: 0, length: 65536,
    });
    const content = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes.bytes));
    return { paths: [...first.entries, ...second.entries].map(entry => entry.path), content, revision: bytes.revision };
  },
});
