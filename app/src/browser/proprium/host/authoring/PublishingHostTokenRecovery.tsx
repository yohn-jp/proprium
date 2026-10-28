import { useState, type ChangeEvent, type ReactElement } from 'react';

export type LegacyShareSourceName = 'app-state/share-tokens.json' | 'share-tokens.json';
export type LegacyGrantScope = string | ({ kind: 'project' | 'volume' | 'chapter' | 'scene'; id: string } & Record<string, unknown>);
export interface SanitizedLegacyShareGrant extends Record<string, unknown> {
  id: string;
  projectId: string;
  scope: LegacyGrantScope;
  label: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}
export type LegacySharePreviewGrant = SanitizedLegacyShareGrant | {
  id?: string;
  projectId: string;
  invalid: true;
};
export interface LegacyShareMapPreview {
  source_name: LegacyShareSourceName;
  source_sha256: string;
  project_ids: string[];
  grants: LegacySharePreviewGrant[];
  total_rows: number;
  blocked_rows: number;
}
export interface LegacyShareProposalInput {
  source_name: LegacyShareSourceName;
  source_sha256: string;
  legacy_project_id: string;
  repository_id_confirmation: number;
  branch_confirmation: string;
  grants: SanitizedLegacyShareGrant[];
}

export function legacyGrantProposalMessage(result: unknown): string {
  const status = isRecord(result) && typeof result.status === 'string' ? result.status : '';
  if (status === 'already_imported') return 'この share grant は既に同じ内容で復旧されています。';
  if (status === 'conflict') return '既存の share-grants.jsonl と内容が異なるため復旧は競合しました。追加・変更は行われていません。';
  if (status === 'proposed') return 'proposal を Host Review に送信しました。承認されるまで Git ファイルは変更されません。';
  return 'Host から proposal の結果を確認できませんでした。ファイルは変更されていません。';
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_ROWS = 10_000;
const MAX_GRANTS = 100;
const MAX_ROW_BYTES = 32 * 1024;
const SENSITIVE_FIELD = /(?:owner|user|bearer|token|secret|credential|auth|account)/iu;
const RAW_BEARER = /share_[A-Za-z0-9_-]{43}/u;
const DANGEROUS_FIELD = /^(?:__proto__|prototype|constructor)$/u;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalidFile = () => new Error('共有リンクの復旧ファイルを安全に読み込めませんでした。元ファイルは変更されていません。');

function containsRawBearer(value: unknown): boolean {
  if (typeof value === 'string') return RAW_BEARER.test(value);
  if (Array.isArray(value)) return value.some(containsRawBearer);
  return isRecord(value) && Object.values(value).some(containsRawBearer);
}

function hasUnexpectedSensitiveField(value: unknown, root = true): boolean {
  if (Array.isArray(value)) return value.some(item => hasUnexpectedSensitiveField(item, false));
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_FIELD.test(key)) {
      // These fields are present in the legacy token map and are explicitly
      // discarded. Any other secret-bearing field makes the row unimportable.
      if (lowerKey === 'ownerid' || lowerKey === 'tokenprefix') continue;
      if (root && lowerKey === 'tokenhash') continue;
      return true;
    }
    if (hasUnexpectedSensitiveField(child, false)) return true;
  }
  return false;
}

function safeJson(value: unknown): unknown {
  if (typeof value === 'string') {
    if (RAW_BEARER.test(value)) throw invalidFile();
    return value;
  }
  if (Array.isArray(value)) return value.map(safeJson);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(key) || DANGEROUS_FIELD.test(key)) continue;
    result[key] = safeJson(child);
  }
  return result;
}

function validProjectId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value) && !RAW_BEARER.test(value);
}

function safeScope(value: unknown): LegacyGrantScope | null {
  if (typeof value === 'string') {
    if (!value.trim()) return { kind: 'project', id: '*' };
    if (/^vol-.+/u.test(value)) return { kind: 'volume', id: value };
    if (/^ch-.+/u.test(value)) return { kind: 'chapter', id: value };
    if (/^sc-.+/u.test(value)) return { kind: 'scene', id: value };
    return null;
  }
  if (!isRecord(value) || !['project', 'volume', 'chapter', 'scene'].includes(String(value.kind)) ||
      typeof value.id !== 'string' || !value.id.trim()) return null;
  // Preserve safe nested extensions as well. Sensitive fields have already
  // made this record invalid; normalization below removes any known secret key.
  const safeExtras = safeJson(value) as Record<string, unknown>;
  return { ...safeExtras, kind: value.kind as 'project' | 'volume' | 'chapter' | 'scene', id: value.id };
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function safeGrant(value: unknown): SanitizedLegacyShareGrant | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.id) ||
      !validProjectId(value.projectId) || typeof value.label !== 'string' || value.label.length > 256 ||
      typeof value.tokenHash !== 'string' || !/^[a-fA-F0-9]{64}$/u.test(value.tokenHash) ||
      !validDate(value.createdAt) || !validDate(value.expiresAt) ||
      (value.lastUsedAt !== undefined && !validDate(value.lastUsedAt)) ||
      (value.revokedAt !== undefined && !validDate(value.revokedAt)) ||
      containsRawBearer(value) || hasUnexpectedSensitiveField(value)) return null;
  const scope = safeScope(value.scope);
  if (!scope) return null;
  const extra = safeJson(Object.fromEntries(Object.entries(value).filter(([key]) =>
    !['id', 'projectId', 'scope', 'label', 'tokenHash', 'createdAt', 'expiresAt', 'lastUsedAt', 'revokedAt'].includes(key)))) as Record<string, unknown>;
  const grant: SanitizedLegacyShareGrant = {
    ...extra, id: value.id, projectId: value.projectId, scope, label: value.label,
    tokenHash: value.tokenHash.toLowerCase(), createdAt: value.createdAt, expiresAt: value.expiresAt,
    ...(typeof value.lastUsedAt === 'string' ? { lastUsedAt: value.lastUsedAt } : {}),
    ...(typeof value.revokedAt === 'string' ? { revokedAt: value.revokedAt } : {}),
  };
  return grant;
}

/** Parse a user-selected local export; return only explicitly mapped, hash-only descriptors. */
export async function inspectLegacyShareMap(sourceName: LegacyShareSourceName, bytes: Uint8Array): Promise<LegacyShareMapPreview> {
  if (!['app-state/share-tokens.json', 'share-tokens.json'].includes(sourceName) ||
      !(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) throw invalidFile();
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalidFile(); }
  if (!Array.isArray(parsed) || parsed.length > MAX_FILE_ROWS || parsed.some(row => !isRecord(row))) throw invalidFile();
  const rows = parsed as Record<string, unknown>[];
  const projectIds = [...new Set(rows.map(row => row.projectId).filter(validProjectId))].sort();
  const digestInput = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(digestInput).set(bytes);
  const sourceSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput))]
    .map(value => value.toString(16).padStart(2, '0')).join('');

  // Repeated grant IDs make source attribution ambiguous. Mark every such row
  // blocked rather than choosing one based on order.
  const idCounts = new Map<string, number>();
  for (const row of rows) if (typeof row.id === 'string') idCounts.set(row.id, (idCounts.get(row.id) ?? 0) + 1);
  let safeGrantCount = 0;
  const grants: LegacySharePreviewGrant[] = [];
  for (const row of rows) {
    if (!validProjectId(row.projectId)) continue;
    const grant = safeGrant(row);
    if (!grant || (typeof row.id === 'string' && idCounts.get(row.id) !== 1) ||
        new TextEncoder().encode(JSON.stringify(grant)).byteLength > MAX_ROW_BYTES) {
      grants.push({ ...(typeof row.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(row.id) && !RAW_BEARER.test(row.id) ? { id: row.id } : {}),
        projectId: row.projectId, invalid: true });
      continue;
    }
    safeGrantCount += 1;
    grants.push(grant);
  }
  return { source_name: sourceName, source_sha256: sourceSha256, project_ids: projectIds, grants,
    total_rows: rows.length, blocked_rows: rows.length - safeGrantCount };
}

export interface PublishingHostTokenRecoveryProps {
  readonly repositoryId: number | null;
  readonly branch: string;
  readonly inspect: (sourceName: LegacyShareSourceName, bytes: Uint8Array) => Promise<LegacyShareMapPreview>;
  /** Host supplies the trusted gesture and repository/branch scope. */
  readonly propose: (event: Event, input: LegacyShareProposalInput) => Promise<unknown>;
}

/** Import one user-selected legacy map in memory, then ask the signed plugin for a guarded proposal. */
export function PublishingHostTokenRecovery({ repositoryId, branch, inspect, propose }: PublishingHostTokenRecoveryProps): ReactElement {
  const [sourceName, setSourceName] = useState<LegacyShareSourceName>('app-state/share-tokens.json');
  const [preview, setPreview] = useState<LegacyShareMapPreview | null>(null);
  const [legacyProjectId, setLegacyProjectId] = useState('');
  const [repositoryConfirmation, setRepositoryConfirmation] = useState('');
  const [branchConfirmation, setBranchConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const hasBoundRepository = Number.isSafeInteger(repositoryId) && Number(repositoryId) > 0 && branch.length > 0;

  async function readFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    setPreview(null); setLegacyProjectId(''); setMessage('');
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setMessage('ファイルは 2 MiB 以下にしてください。'); return; }
    setBusy(true);
    let bytes: Uint8Array | null = null;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
      const result = await inspect(sourceName, bytes);
      setPreview(result); setMessage(`${result.project_ids.length} 件の legacy project ID を確認しました。復旧対象を選択してください。`);
    } catch { setMessage('ファイルを安全に確認できませんでした。元ファイルは変更されていません。'); }
    finally { bytes?.fill(0); setBusy(false); }
  }

  function submit(event: Event): void {
    if (!preview || !legacyProjectId || !hasBoundRepository || busy || repositoryId === null) return;
    const selected = preview.grants.filter((row): row is LegacySharePreviewGrant => row.projectId === legacyProjectId);
    if (!selected.length || selected.length > MAX_GRANTS || selected.some(row => 'invalid' in row)) {
      setMessage(`選択した project ID に安全に読み込めない行があるか、上限 ${MAX_GRANTS} 件を超えています。元ファイルは変更されていません。`); return;
    }
    if (repositoryConfirmation !== String(repositoryId) || branchConfirmation !== branch) {
      setMessage('現在の GitHub repository ID と branch を確認欄へ正確に入力してください。'); return;
    }
    const input: LegacyShareProposalInput = {
      source_name: preview.source_name, source_sha256: preview.source_sha256,
      legacy_project_id: legacyProjectId, repository_id_confirmation: repositoryId,
      branch_confirmation: branch, grants: selected as SanitizedLegacyShareGrant[],
    };
    setBusy(true); setMessage('Host Review 用の proposal を作成しています。');
    void propose(event, input).then(result => setMessage(legacyGrantProposalMessage(result)),
      () => setMessage('proposal を作成できませんでした。ファイルは変更されていません。'))
      .finally(() => setBusy(false));
  }

  return <details className="publishing-host-token-recovery">
    <summary>旧共有リンクの復旧</summary>
    {!hasBoundRepository
      ? <p role="status">復旧には明示的な GitHub repository ID と branch が必要です。この workspace では利用できません。</p>
      : <>
        <p>旧 Scriptorium の server-local file はブラウザーから自動では読めません。コピーまたは export 済み JSON を選択してください。選択したファイルはこの画面で一時的に読み取り、hash 済み grant metadata だけをレビューへ送ります。所有者情報と token prefix は除外します。元ファイルや共有リンクは変更・有効化されません。</p>
        <label>元の Host file
          <select value={sourceName} disabled={busy} onChange={event => { setSourceName(event.target.value as LegacyShareSourceName); setPreview(null); setMessage(''); }}>
            <option value="app-state/share-tokens.json">app-state/share-tokens.json</option>
            <option value="share-tokens.json">share-tokens.json</option>
          </select>
        </label>
        <label>復旧した file を選択
          <input aria-label="復旧した share token map JSON" type="file" accept="application/json,.json" disabled={busy} onChange={event => void readFile(event)} />
        </label>
        {preview && <>
          <p>SHA-256: <code>{preview.source_sha256}</code></p>
          <p>全 {preview.total_rows} 件のうち {preview.blocked_rows} 件は形式または秘密欄のため復旧対象外です。</p>
          <label>対応付ける legacy project ID
            <select value={legacyProjectId} disabled={busy} onChange={event => setLegacyProjectId(event.target.value)}>
              <option value="">選択してください</option>
              {preview.project_ids.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </label>
          <p>復旧先: GitHub repository ID <code>{repositoryId}</code> · branch <code>{branch}</code></p>
          <label>GitHub repository ID を再入力
            <input inputMode="numeric" value={repositoryConfirmation} disabled={busy} onChange={event => setRepositoryConfirmation(event.target.value)} />
          </label>
          <label>branch を再入力
            <input value={branchConfirmation} disabled={busy} onChange={event => setBranchConfirmation(event.target.value)} />
          </label>
          <p>選択された project ID の grant: {preview.grants.filter(row => row.projectId === legacyProjectId).length} 件。該当 group に復旧対象外の行が含まれる場合は提案を拒否します。</p>
          <button type="button" disabled={busy || !legacyProjectId || !repositoryConfirmation || !branchConfirmation} onClick={event => submit(event.nativeEvent)}>選択した grant を Host Review へ提案</button>
        </>}
      </>}
    {busy && <p role="status">処理中…</p>}
    {message && <p role="status">{message}</p>}
  </details>;
}
