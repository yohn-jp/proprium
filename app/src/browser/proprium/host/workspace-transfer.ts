import { unzipSync, zipSync } from "fflate";
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

export function readWorkspaceArchive(archive: Uint8Array): TransferFile[] {
  if (archive.byteLength > MAX_WORKSPACE_ARCHIVE_BYTES) throw new Error("ZIPファイルは68 MiB以内（展開後64 MiB以内）にしてください。");
  let total = 0;
  const seen = new Set<string>();
  const entries = unzipSync(archive, { filter(file) {
    if (file.name.endsWith("/")) { validateGitPath(file.name.slice(0, -1)); return false; }
    validateGitPath(file.name);
    if (seen.has(file.name)) throw new Error(`ZIP内でパスが重複しています: ${file.name}`);
    seen.add(file.name);
    total += file.originalSize;
    if (seen.size > MAX_WORKSPACE_CHANGE_COUNT || total > MAX_WORKSPACE_CHANGE_BYTES) throw new Error("ZIPの展開後は256ファイル・合計64 MiB以内にしてください。");
    return true;
  } });
  const files = Object.entries(entries).map(([path, data]) => ({ path, data }));
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
