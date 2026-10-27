import { Inflate, zipSync } from "fflate";
import { MAX_WORKSPACE_CHANGE_BYTES, MAX_WORKSPACE_CHANGE_COUNT, validateGitPath } from "../git/protocol.js";

// ZIP central/local headers and UTF-8 names add bytes beyond the expanded contents.
export const MAX_WORKSPACE_ARCHIVE_BYTES = MAX_WORKSPACE_CHANGE_BYTES + 4 * 1024 * 1024;

export interface TransferFile { path: string; data: Uint8Array; }

export function validateTransferFiles(files: readonly TransferFile[]): void {
  if (!files.length || files.length > MAX_WORKSPACE_CHANGE_COUNT) throw new Error(`一度に取り込めるファイルは1〜${MAX_WORKSPACE_CHANGE_COUNT}件です。`);
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    validateGitPath(file.path);
    if (seen.has(file.path)) throw new Error(`同じパスが複数あります: ${file.path}`);
    seen.add(file.path);
    total += file.data.byteLength;
    if (total > MAX_WORKSPACE_CHANGE_BYTES) throw new Error("ファイルの合計サイズは64 MiB以内にしてください。");
  }
}

/** File-only archive: Git history, authentication and browser preferences are not included. */
export function createWorkspaceArchive(files: readonly TransferFile[]): Uint8Array<ArrayBuffer> {
  validateTransferFiles(files);
  const entries: Record<string, Uint8Array> = Object.create(null);
  for (const file of files) entries[file.path] = file.data;
  const archive = zipSync(entries, { level: 0 });
  if (archive.byteLength > MAX_WORKSPACE_ARCHIVE_BYTES) throw new Error("ZIPの管理情報が大きすぎます。ファイルを分けて書き出してください。");
  return archive;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let result = value;
  for (let step = 0; step < 8; step++) result = result & 1 ? (result >>> 1) ^ 0xedb88320 : result >>> 1;
  return result >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff]!;
  return (value ^ 0xffffffff) >>> 0;
}

function corruptArchive(): never { throw new Error("ZIPの管理情報またはファイルの内容が破損しています。"); }

/** Parse and cross-check ZIP headers before changing any workspace bytes. ZIP64/encrypted entries are not admitted. */
export function readWorkspaceArchive(archive: Uint8Array): TransferFile[] {
  if (archive.byteLength > MAX_WORKSPACE_ARCHIVE_BYTES) throw new Error("ZIPファイルは68 MiB以内（展開後64 MiB以内）にしてください。");
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const u16 = (offset: number): number => {
    if (offset < 0 || offset + 2 > archive.byteLength) return corruptArchive();
    return view.getUint16(offset, true);
  };
  const u32 = (offset: number): number => {
    if (offset < 0 || offset + 4 > archive.byteLength) return corruptArchive();
    return view.getUint32(offset, true);
  };
  let end = -1;
  for (let offset = archive.byteLength - 22; offset >= Math.max(0, archive.byteLength - 65557); offset--) {
    if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === archive.byteLength) { end = offset; break; }
  }
  if (end < 0 || u16(end + 4) !== 0 || u16(end + 6) !== 0 ||
      u16(end + 8) !== u16(end + 10)) return corruptArchive();
  const count = u16(end + 10), directorySize = u32(end + 12), directoryOffset = u32(end + 16);
  if (count > MAX_WORKSPACE_CHANGE_COUNT + 1024 || directoryOffset + directorySize !== end) return corruptArchive();

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files: TransferFile[] = [];
  const seen = new Set<string>();
  let total = 0, cursor = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (u32(cursor) !== 0x02014b50) return corruptArchive();
    const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16);
    const compressedSize = u32(cursor + 20), originalSize = u32(cursor + 24);
    const nameSize = u16(cursor + 28), extraSize = u16(cursor + 30), commentSize = u16(cursor + 32);
    const localOffset = u32(cursor + 42);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > end || !nameSize || compressedSize === 0xffffffff || originalSize === 0xffffffff ||
        localOffset === 0xffffffff || u16(cursor + 34) !== 0 ||
        (flags & 0x41) !== 0 || (method !== 0 && method !== 8)) return corruptArchive();
    const filenameBytes = archive.subarray(cursor + 46, cursor + 46 + nameSize);
    let name: string;
    try { name = decoder.decode(filenameBytes); } catch { return corruptArchive(); }
    const directory = name.endsWith("/");
    validateGitPath(directory ? name.slice(0, -1) : name);
    if (!directory) {
      if (seen.has(name)) throw new Error(`ZIP内でパスが重複しています: ${name}`);
      seen.add(name);
      total += originalSize;
      if (seen.size > MAX_WORKSPACE_CHANGE_COUNT || total > MAX_WORKSPACE_CHANGE_BYTES) {
        throw new Error("ZIPの展開後は256ファイル・合計64 MiB以内にしてください。");
      }
    }
    if (u32(localOffset) !== 0x04034b50 || u16(localOffset + 6) !== flags || u16(localOffset + 8) !== method) return corruptArchive();
    const localNameSize = u16(localOffset + 26), localExtraSize = u16(localOffset + 28);
    const dataStart = localOffset + 30 + localNameSize + localExtraSize;
    const dataEnd = dataStart + compressedSize;
    if (localNameSize !== nameSize || dataEnd > directoryOffset || dataStart < localOffset ||
        filenameBytes.some((byte, i) => archive[localOffset + 30 + i] !== byte)) return corruptArchive();
    if (flags & 8) {
      // Streaming ZIP writers place a descriptor after data instead of filling the local sizes.
      const desc = u32(dataEnd) === 0x08074b50 ? dataEnd + 4 : dataEnd;
      if (desc + 12 > directoryOffset || u32(desc) !== crc || u32(desc + 4) !== compressedSize ||
          u32(desc + 8) !== originalSize) return corruptArchive();
    } else if (u32(localOffset + 14) !== crc || u32(localOffset + 18) !== compressedSize ||
               u32(localOffset + 22) !== originalSize) return corruptArchive();
    const compressed = archive.subarray(dataStart, dataEnd);
    let bytes: Uint8Array;
    if (method === 0) {
      if (compressedSize !== originalSize) return corruptArchive();
      bytes = Uint8Array.from(compressed);
    } else {
      bytes = new Uint8Array(originalSize);
      let written = 0;
      const inflater = new Inflate((chunk) => {
        if (written + chunk.byteLength > bytes.byteLength) return corruptArchive();
        bytes.set(chunk, written);
        written += chunk.byteLength;
      });
      try {
        for (let offset = 0; offset < compressed.byteLength; offset += 4096) {
          const endOffset = Math.min(compressed.byteLength, offset + 4096);
          inflater.push(compressed.subarray(offset, endOffset), endOffset === compressed.byteLength);
        }
        if (compressed.byteLength === 0) inflater.push(new Uint8Array(), true);
      } catch { return corruptArchive(); }
      if (written !== originalSize) return corruptArchive();
    }
    if (crc32(bytes) !== crc) return corruptArchive();
    if (!directory) files.push({ path: name, data: bytes });
    cursor = next;
  }
  if (cursor !== end) return corruptArchive();
  validateTransferFiles(files);
  return files;
}

export function documentPath(name: string, explicitPath = false): string {
  const trimmed = name.trim();
  const path = explicitPath || /\.[^/]+$/u.test(trimmed) ? trimmed : `${trimmed}.md`;
  if (!trimmed) throw new Error("文書名を入力してください。");
  validateGitPath(path);
  return path;
}
