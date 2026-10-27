import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement } from "react";
import type {
  AuthoringActionBinding,
  AuthoringColumn,
  AuthoringDataKey,
  AuthoringField,
  AuthoringHostArtifact,
  AuthoringJson,
  AuthoringNavigationTarget,
  AuthoringNavigationTemplate,
  AuthoringOutlineRow,
  AuthoringPrintPreset,
  AuthoringScalarField,
  AuthoringSurfaceProps,
  AuthoringTemplate,
  AuthoringWidget,
} from "./types.js";

const DATA_KEY_PART = /^(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9][0-9]{0,2})$/u;
const MAX_TEMPLATE_DEPTH = 12;
const UNSAFE_DATA_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const EMPTY_DATA: AuthoringJson = Object.freeze({});

function isValidDataPath(path: string): boolean {
  return path.length <= 512 && path.split(".").every(part => DATA_KEY_PART.test(part) && !UNSAFE_DATA_KEYS.has(part));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDataKey(value: unknown): value is AuthoringDataKey {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value.data_key === "string" && isValidDataPath(value.data_key);
}

function dataAtPath(data: unknown, path: string): unknown {
  if (!isValidDataPath(path)) throw new Error("The UI declaration contains an invalid data key.");
  let value: unknown = data;
  for (const part of path.split(".")) {
    if (Array.isArray(value) && /^(?:0|[1-9][0-9]{0,2})$/u.test(part)) {
      const index = Number(part);
      if (!Object.hasOwn(value, index)) return undefined;
      value = value[index];
    } else {
      if (!isRecord(value) || !Object.hasOwn(value, part)) return undefined;
      value = value[part];
    }
  }
  return value;
}

/** Resolves only literal JSON and declared `{ data_key }` references; it evaluates no expressions. */
export function resolveAuthoringTemplate(template: AuthoringTemplate, data: unknown, depth = 0): AuthoringJson {
  if (depth > MAX_TEMPLATE_DEPTH) throw new Error("The UI input template is too deeply nested.");
  if (isRecord(template) && Object.hasOwn(template, "data_key") && !isDataKey(template)) throw new Error("The UI declaration contains an invalid data key.");
  if (isDataKey(template)) {
    const result = dataAtPath(data, template.data_key);
    if (result === undefined) throw new Error(`The UI input is missing declared data key “${template.data_key}”.`);
    return cloneJson(result, depth + 1);
  }
  if (Array.isArray(template)) return template.map(item => resolveAuthoringTemplate(item, data, depth + 1));
  if (isRecord(template)) {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, resolveAuthoringTemplate(value as AuthoringTemplate, data, depth + 1)]));
  }
  if (template === null || typeof template === "string" || typeof template === "boolean" || typeof template === "number") return template;
  throw new Error("The UI input template contains a value that is not JSON.");
}

export function resolveAuthoringNavigation(binding: AuthoringNavigationTemplate, data: unknown): { target: AuthoringNavigationTarget; intent: "open" | "reveal" } {
  if (binding.intent !== "open" && binding.intent !== "reveal") throw new Error("The UI navigation intent is invalid.");
  const resolved = Object.fromEntries(Object.entries(binding.target).map(([key, template]) => [key, resolveAuthoringTemplate(template, data)]));
  if (Object.keys(resolved).some(key => !["path", "panel_id", "span"].includes(key))) throw new Error("The UI navigation target contains an unsupported field.");
  const path = resolved.path;
  const panelId = resolved.panel_id;
  if ((path !== undefined && (typeof path !== "string" || !path.trim() || path.length > 1024)) ||
      (panelId !== undefined && (typeof panelId !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,159}$/u.test(panelId))) ||
      (path === undefined && panelId === undefined)) throw new Error("The UI navigation target is invalid.");
  let span: AuthoringNavigationTarget["span"];
  const rawSpan = resolved.span;
  if (rawSpan !== undefined && rawSpan !== null) {
    if (!isRecord(rawSpan) || Object.keys(rawSpan).some(key => !["path", "revision", "start", "end", "quote"].includes(key)) ||
        !Number.isSafeInteger(rawSpan.start) || !Number.isSafeInteger(rawSpan.end) ||
        (rawSpan.start as number) < 0 || (rawSpan.end as number) < (rawSpan.start as number) ||
        (rawSpan.path !== undefined && typeof rawSpan.path !== "string") ||
        (rawSpan.revision !== undefined && typeof rawSpan.revision !== "string") ||
        (rawSpan.quote !== undefined && typeof rawSpan.quote !== "string")) throw new Error("The UI navigation span is invalid.");
    span = { path: rawSpan.path as string | undefined, revision: rawSpan.revision as string | undefined, start: rawSpan.start as number, end: rawSpan.end as number, quote: rawSpan.quote as string | undefined };
  }
  return { target: { path: path as string | undefined, panel_id: panelId as string | undefined, span }, intent: binding.intent };
}

function cloneJson(value: unknown, depth: number): AuthoringJson {
  if (depth > MAX_TEMPLATE_DEPTH) throw new Error("A referenced UI value is too deeply nested.");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(item => cloneJson(item, depth + 1));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item, depth + 1)]));
  throw new Error("A referenced UI value is not JSON.");
}

function plainText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function recordRows(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function readPath(value: unknown, path: string): unknown {
  if (!isValidDataPath(path)) return undefined;
  let current = value;
  for (const part of path.split(".")) {
    if (Array.isArray(current) && /^(?:0|[1-9][0-9]{0,2})$/u.test(part)) {
      const index = Number(part);
      if (!Object.hasOwn(current, index)) return undefined;
      current = current[index];
    } else {
      if (!isRecord(current) || !Object.hasOwn(current, part)) return undefined;
      current = current[part];
    }
  }
  return current;
}

function validBinding(binding: AuthoringActionBinding): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(binding.action_id) && isRecord(binding.input_template);
}

function rowsForOutline(value: unknown): readonly AuthoringOutlineRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is AuthoringOutlineRow => isRecord(row) && typeof row.id === "string" && typeof row.title === "string");
}

function conditionMatches(condition: AuthoringDataKey | undefined, data: AuthoringJson): boolean {
  if (!condition) return true;
  try {
    const value = dataAtPath(data, condition.data_key);
    return value !== undefined && value !== null && value !== "" && value !== false;
  } catch { return false; }
}

function Pagination({ previous, next, previousWhen, nextWhen, data, invoke, disabled }: {
  readonly previous?: AuthoringActionBinding;
  readonly next?: AuthoringActionBinding;
  readonly previousWhen?: AuthoringDataKey;
  readonly nextWhen?: AuthoringDataKey;
  readonly data: AuthoringJson;
  invoke(binding: AuthoringActionBinding, event: Event): void;
  readonly disabled: boolean;
}): ReactElement | null {
  const showPrevious = previous && conditionMatches(previousWhen, data);
  const showNext = next && conditionMatches(nextWhen, data);
  if (!showPrevious && !showNext) return null;
  return <nav className="authoring-pagination" aria-label="ページ送り">
    {showPrevious && <button type="button" disabled={disabled} onClick={event => invoke(previous, event.nativeEvent)}>前へ</button>}
    {showNext && <button type="button" disabled={disabled} onClick={event => invoke(next, event.nativeEvent)}>次へ</button>}
  </nav>;
}

const EXPORT_PREFLIGHT_ITEMS = [
  "原稿を校正した",
  "人名とルビを確認した",
  "出力範囲を確認した",
  "公開先の規則を確認した",
  "エピソード番号とタイトルを確認した",
] as const;

type ArtifactIntent = "download" | "print";

function formatArtifactBytes(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return "サイズ未確認";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function ArtifactResultToolbar({ artifact }: { readonly artifact: AuthoringHostArtifact }): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState<ArtifactIntent | null>(null);
  const [checked, setChecked] = useState<boolean[]>(() => EXPORT_PREFLIGHT_ITEMS.map(() => false));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ text: string; truncated: boolean } | null>(null);
  const [preset, setPreset] = useState<AuthoringPrintPreset>("bunko");

  useEffect(() => {
    const element = dialog.current;
    if (pending && element && !element.open) element.showModal();
    else if (!pending && element?.open) element.close();
  }, [pending]);

  const begin = (intent: ArtifactIntent) => {
    setError("");
    setChecked(EXPORT_PREFLIGHT_ITEMS.map(() => false));
    setPending(intent);
  };
  const cancel = () => {
    setPending(null);
    setChecked(EXPORT_PREFLIGHT_ITEMS.map(() => false));
  };
  const continueEffect = (event: React.MouseEvent<HTMLButtonElement>) => {
    const intent = pending;
    if (!intent || busy) return;
    setPending(null);
    setBusy(true);
    setError("");
    const task = intent === "download" ? artifact.download(event.nativeEvent) : artifact.print(event.nativeEvent, preset);
    void task.catch(cause => setError(cause instanceof Error ? cause.message : "出力を完了できませんでした。"))
      .finally(() => setBusy(false));
  };
  const loadPreview = async () => {
    if (busy || !artifact.text_preview_available) return;
    setBusy(true); setError("");
    try { setPreview(await artifact.previewText(40_000)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "安全なテキストプレビューを読み込めませんでした。"); }
    finally { setBusy(false); }
  };
  const unconfirmed = checked.filter(value => !value).length;

  return <section className="authoring-artifact-result" aria-label="Host が確認した出力">
    <div className="authoring-artifact-summary"><div><h3>出力の準備ができました</h3><p>{artifact.metadata.filename} · {artifact.metadata.media_type} · {formatArtifactBytes(artifact.metadata.bytes)}</p><small>SHA-256 {artifact.metadata.sha256}</small></div></div>
    <div className="authoring-artifact-actions">
      <button type="button" disabled={busy} onClick={() => begin("download")}>ダウンロード</button>
      {artifact.text_preview_available && <>
        <button type="button" disabled={busy} onClick={() => void loadPreview()}>{preview ? "プレビューを更新" : "テキストプレビュー"}</button>
        <label>印刷設定<select value={preset} disabled={busy} onChange={event => setPreset(event.currentTarget.value as AuthoringPrintPreset)}><option value="bunko">文庫</option><option value="web-novel">Web小説</option><option value="genko">原稿用紙</option></select></label>
        <button type="button" disabled={busy || !preview} onClick={() => begin("print")}>印刷 / PDF</button>
      </>}
    </div>
    {preview && <section className="authoring-artifact-preview" aria-label="出力テキストプレビュー"><h4>テキストプレビュー</h4>{preview.truncated && <p role="status">先頭 40,000 文字を表示しています。印刷は封印済み出力の全体を使います。</p>}<pre>{preview.text}</pre></section>}
    {busy && <p role="status" aria-live="polite">出力を準備しています…</p>}
    {error && <p className="authoring-error" role="alert">{error}</p>}
    <dialog ref={dialog} className="authoring-preflight" aria-labelledby="authoring-preflight-title" onCancel={event => { event.preventDefault(); cancel(); }}>
      <h2 id="authoring-preflight-title">出力前の確認</h2>
      <p>未確認の項目が {unconfirmed} 件あります。確認を続けても出力は妨げられません。</p>
      <ul>{EXPORT_PREFLIGHT_ITEMS.map((label, index) => <li key={label}><label><input type="checkbox" checked={checked[index] ?? false} onChange={event => setChecked(current => current.map((value, currentIndex) => currentIndex === index ? event.currentTarget.checked : value))} />{label}</label></li>)}</ul>
      <div className="authoring-form-actions"><button type="button" onClick={cancel}>キャンセル</button><button type="button" disabled={busy} onClick={continueEffect}>{unconfirmed ? "未確認の項目を残して続ける" : "確認して続ける"}</button></div>
    </dialog>
  </section>;
}

function Table({ rows, columns, label }: { readonly rows: readonly Record<string, unknown>[]; readonly columns: readonly AuthoringColumn[]; readonly label: string }): ReactElement {
  if (!rows.length) return <p className="authoring-empty">表示できる項目はありません。</p>;
  return <div className="authoring-table-scroll" role="region" aria-label={label} tabIndex={0}><table className="authoring-table"><thead><tr>{columns.map(column => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead><tbody>
    {rows.map((row, rowIndex) => <tr key={plainText(row.id) || `${label}-${rowIndex}`}>{columns.map(column => <td key={column.key}>{plainText(readPath(row, column.key))}</td>)}</tr>)}
  </tbody></table></div>;
}

type FormValues = Record<string, unknown>;

function blankValue(field: AuthoringScalarField): string | boolean | string[] {
  if (field.type === "boolean") return false;
  if (field.type === "multi-reference" || field.type === "ordered-list") return [];
  return "";
}

function optionsForField(field: AuthoringScalarField, data: AuthoringJson): readonly { readonly value: string; readonly label: string }[] {
  if (Array.isArray(field.options)) return field.options;
  if (!isDataKey(field.options) || !field.option_value_key || !field.option_label_key) return [];
  const seen = new Set<string>();
  return recordRows(dataAtPath(data, field.options.data_key)).slice(0, 1000).flatMap(row => {
    const rawValue = readPath(row, field.option_value_key!);
    const rawLabel = readPath(row, field.option_label_key!);
    const value = typeof rawValue === "string" ? rawValue : typeof rawValue === "number" && Number.isFinite(rawValue) ? String(rawValue) : "";
    const label = plainText(rawLabel);
    if (!value || !label || seen.has(value)) return [];
    seen.add(value);
    return [{ value, label }];
  });
}

/**
 * Record rows may refer to options loaded from different pages. Keep each row's current value
 * available when the active page changes so a later page cannot invalidate an earlier choice.
 */
export function optionsForRecordField(
  field: AuthoringScalarField,
  data: AuthoringJson,
  value: unknown,
): readonly { readonly value: string; readonly label: string }[] {
  const options = [...optionsForField(field, data)];
  const present = new Set(options.map(option => option.value));
  const selected = field.type === "multi-reference"
    ? Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
    : field.type === "enum" && typeof value === "string" ? [value] : [];
  for (const item of selected.slice(0, 1000)) {
    if (!item || present.has(item)) continue;
    present.add(item);
    options.push({ value: item, label: `${item}（現在の値を保持）` });
  }
  return options;
}

function initialScalarValue(field: AuthoringScalarField, value: unknown): unknown {
  if (field.type === "boolean") return typeof value === "boolean" ? value : undefined;
  if (field.type === "integer") return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
  if (field.type === "multi-reference" || field.type === "ordered-list") {
    return Array.isArray(value) && value.every(item => typeof item === "string") ? [...value] : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function initialFormValues(fields: readonly AuthoringField[], data: AuthoringJson): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    if (field.initial_value === undefined) continue;
    try {
      const value = resolveAuthoringTemplate(field.initial_value, data);
      if (field.type === "record-list") {
        if (Array.isArray(value)) values[field.id] = value;
      } else {
        const initial = initialScalarValue(field, value);
        if (initial !== undefined) values[field.id] = initial;
      }
    } catch { /* Data may not exist until the declared read action runs. */ }
  }
  return values;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function mergeInitialFormValues(
  fields: readonly AuthoringField[],
  current: Readonly<FormValues>,
  previous: Readonly<FormValues>,
  nextInitial: Readonly<FormValues>,
): FormValues {
  const next = { ...current };
  for (const field of fields) {
    if (!sameJsonValue(current[field.id], previous[field.id])) continue;
    if (Object.hasOwn(nextInitial, field.id)) next[field.id] = nextInitial[field.id];
    else delete next[field.id];
  }
  return next;
}

function FormScalarInput({ field, value, disabled, options = [], onChange }: {
  readonly field: AuthoringScalarField;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  onChange(value: unknown): void;
}): ReactElement {
  if (field.type === "boolean") return <input type="checkbox" disabled={disabled} checked={Boolean(value)} onChange={event => onChange(event.currentTarget.checked)} />;
  if (field.type === "enum") return <select disabled={disabled} required={field.required} value={plainText(value)} onChange={event => onChange(event.currentTarget.value)}><option value="">選択してください</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  if (field.type === "multi-reference") return <select multiple disabled={disabled} required={field.required} value={Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []} onChange={event => onChange(Array.from(event.currentTarget.selectedOptions, option => option.value))}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  if (field.type === "ordered-list") return <textarea rows={4} disabled={disabled} required={field.required} placeholder={field.placeholder} value={Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("\n") : ""} onChange={event => onChange(event.currentTarget.value === "" ? [] : event.currentTarget.value.split("\n"))} />;
  return <input type={field.type === "integer" ? "number" : "text"} disabled={disabled} required={field.required} minLength={field.min_length} maxLength={field.max_length} placeholder={field.placeholder} value={plainText(value)} onChange={event => onChange(event.currentTarget.value)} />;
}

function RecordListField({ field, value, data, disabled, onChange }: {
  readonly field: Extract<AuthoringField, { type: "record-list" }>;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly data: AuthoringJson;
  onChange(value: AuthoringJson[]): void;
}): ReactElement {
  const rows = recordRows(value);
  const minItems = Math.max(field.required ? 1 : 0, field.min_items ?? 0);
  const maxItems = Math.min(256, field.max_items ?? 128);
  const changeRow = (index: number, key: string, nextValue: unknown) => {
    const next = rows.map(row => ({ ...row }));
    next[index] = { ...next[index], [key]: nextValue };
    onChange(next as AuthoringJson[]);
  };
  const addRow = () => {
    if (rows.length >= maxItems) return;
    const row = Object.fromEntries(field.fields.map(item => [item.id, blankValue(item)]));
    onChange([...rows.map(item => cloneJson(item, 0) as Record<string, AuthoringJson>), row] as AuthoringJson[]);
  };
  const removeRow = (index: number) => onChange(rows.filter((_, current) => current !== index).map(row => cloneJson(row, 0) as Record<string, AuthoringJson>) as AuthoringJson[]);
  const moveRow = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= rows.length) return;
    const next = rows.map(row => cloneJson(row, 0) as Record<string, AuthoringJson>);
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next as AuthoringJson[]);
  };
  return <fieldset className="authoring-record-list" disabled={disabled}>
    <legend>{field.label}{field.required && <span aria-hidden="true"> *</span>}</legend>
    {rows.map((row, index) => <fieldset className="authoring-record-row" key={plainText(field.key_field ? readPath(row, field.key_field) : row.id) || `${field.id}-${index}`}>
      <legend>{field.label} {index + 1}</legend>
      {field.fields.map(child => <label className="authoring-field" key={child.id}><span>{child.label}{child.required && <span aria-hidden="true"> *</span>}</span><FormScalarInput field={child} value={row[child.id]} options={optionsForRecordField(child, data, row[child.id])} disabled={disabled} onChange={next => changeRow(index, child.id, next)} /></label>)}
      <div className="authoring-record-actions"><button type="button" disabled={index === 0} aria-label={`${field.label} ${index + 1}を上へ`} onClick={() => moveRow(index, -1)}>上へ</button><button type="button" disabled={index === rows.length - 1} aria-label={`${field.label} ${index + 1}を下へ`} onClick={() => moveRow(index, 1)}>下へ</button><button type="button" disabled={rows.length <= minItems} aria-label={`${field.label} ${index + 1}を削除`} onClick={() => removeRow(index)}>削除</button></div>
    </fieldset>)}
    {rows.length < maxItems && <button type="button" onClick={addRow}>項目を追加</button>}
    <p className="field-help">順序を保ったまま編集できます。画面にない項目はそのまま保持されます。</p>
  </fieldset>;
}

function FormWidget({ node, data, invoke, busy }: {
  readonly node: Extract<AuthoringWidget, { type: "form" }>;
  readonly data: AuthoringJson;
  invoke(binding: AuthoringActionBinding, event: Event, context?: AuthoringJson): void;
  readonly busy: boolean;
}): ReactElement {
  const initialValues = useMemo(() => initialFormValues(node.fields, data), [node.fields, data]);
  const [values, setValues] = useState<FormValues>(initialValues);
  const baselineValues = useRef(initialValues);
  useEffect(() => {
    const previous = baselineValues.current;
    setValues(current => mergeInitialFormValues(node.fields, current, previous, initialValues));
    baselineValues.current = initialValues;
  }, [initialValues, node.fields]);
  const [pendingContext, setPendingContext] = useState<AuthoringJson | null>(null);
  const confirmationDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = confirmationDialog.current;
    if (pendingContext !== null && dialog && !dialog.open) dialog.showModal();
    else if (pendingContext === null && dialog?.open) dialog.close();
  }, [pendingContext]);
  const [error, setError] = useState("");
  const update = (field: AuthoringField, value: unknown) => setValues(current => ({ ...current, [field.id]: value }));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = node.fields.find(field => {
      const value = values[field.id];
      const empty = value === undefined || value === "" || (Array.isArray(value) && !value.length);
      if (field.required && empty) { setError(field.validation_message || `${field.label}を入力してください。`); return true; }
      if (field.type === "record-list") {
        const rows = recordRows(value);
        if (rows.length < Math.max(field.required ? 1 : 0, field.min_items ?? 0) || rows.length > Math.min(256, field.max_items ?? 128)) { setError(field.validation_message || `${field.label}の項目数を確認してください。`); return true; }
        const invalid = rows.some((row, index) => field.fields.some(child => {
          const childValue = row[child.id];
          const childEmpty = childValue === undefined || childValue === "" || (Array.isArray(childValue) && !childValue.length);
          if (child.required && childEmpty) { setError(`${field.label} ${index + 1}: ${child.validation_message || `${child.label}を入力してください。`}`); return true; }
          if (typeof childValue === "string" && ((child.min_length !== undefined && childValue.length < child.min_length) || (child.max_length !== undefined && childValue.length > child.max_length))) { setError(`${field.label} ${index + 1}: ${child.validation_message || `${child.label}の入力を確認してください。`}`); return true; }
          if (child.type === "enum" && typeof childValue === "string" && childValue && !optionsForRecordField(child, data, childValue).some(option => option.value === childValue)) { setError(`${field.label} ${index + 1}: ${child.label}の選択肢を更新してください。`); return true; }
          if (child.type === "multi-reference" && Array.isArray(childValue) && childValue.some(item => typeof item !== "string" || !optionsForRecordField(child, data, childValue).some(option => option.value === item))) { setError(`${field.label} ${index + 1}: ${child.label}の選択肢を更新してください。`); return true; }
          return false;
        }));
        if (invalid) return true;
      }
      if (field.type === "enum" && typeof value === "string" && value && !optionsForField(field, data).some(option => option.value === value)) { setError(`${field.label}の選択肢を更新してください。`); return true; }
      if (field.type === "multi-reference" && Array.isArray(value) && value.some(item => typeof item !== "string" || !optionsForField(field, data).some(option => option.value === item))) { setError(`${field.label}の選択肢を更新してください。`); return true; }
      if (typeof value === "string" && ((field.min_length !== undefined && value.length < field.min_length) || (field.max_length !== undefined && value.length > field.max_length))) {
        setError(field.validation_message || `${field.label}の入力を確認してください。`); return true;
      }
      return false;
    });
    if (validation) return;
    setError("");
    try {
      const context: AuthoringJson = { ...asRecord(data), form: formValuesToJson(node.fields, values) };
      if (node.confirmation) setPendingContext(context);
      else invoke(node.submit, event.nativeEvent, context);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "入力内容を確認してください。");
    }
  };
  const submitAllowed = !node.submit_when || conditionMatches(node.submit_when, data);
  const cancelConfirmation = () => setPendingContext(null);
  const confirmSubmit = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (pendingContext === null || busy) return;
    const context = pendingContext;
    setPendingContext(null);
    invoke(node.submit, event.nativeEvent, context);
  };
  const labelId = `authoring-form-${node.id}`;
  return <form className="authoring-form" aria-labelledby={labelId} onSubmit={submit}>
    {node.title && <h3 id={labelId}>{node.title}</h3>}{node.description && <p>{node.description}</p>}
    {node.fields.map(field => field.type === "record-list"
      ? <RecordListField key={field.id} field={field} value={values[field.id]} data={data} disabled={busy} onChange={value => update(field, value)} />
      : <label className="authoring-field" key={field.id}><span>{field.label}{field.required && <span aria-hidden="true"> *</span>}</span><FormScalarInput field={field} value={values[field.id]} options={optionsForField(field, data)} disabled={busy} onChange={value => update(field, value)} /></label>)}
    {error && <p className="authoring-error" role="alert">{error}</p>}
    {!submitAllowed && node.unavailable_message && <p className="authoring-unavailable" role="status">{node.unavailable_message}</p>}
    <div className="authoring-form-actions"><button type="submit" disabled={busy || !submitAllowed || !validBinding(node.submit)}>送信</button>{node.cancel_action && <button type="button" disabled={busy} onClick={event => invoke(node.cancel_action!, event.nativeEvent)}>キャンセル</button>}</div>
    {node.confirmation && <dialog ref={confirmationDialog} className="authoring-form-confirmation" aria-labelledby={`authoring-confirmation-${node.id}`} onCancel={event => { event.preventDefault(); cancelConfirmation(); }}>
      <h2 id={`authoring-confirmation-${node.id}`}>{node.confirmation.title}</h2>
      <p>{node.confirmation.message}</p>
      <div className="authoring-form-actions"><button type="button" disabled={busy} onClick={cancelConfirmation}>{node.confirmation.cancel_label || "キャンセル"}</button><button type="button" disabled={busy} onClick={confirmSubmit}>{node.confirmation.continue_label || "続ける"}</button></div>
    </dialog>}
  </form>;
}

function scalarValueToJson(field: AuthoringScalarField, value: unknown): AuthoringJson | undefined {
  if (field.type === "integer") {
    if (value === "" || value === undefined) return undefined;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new Error(`${field.label}の値が範囲外です。`);
      return value;
    }
    if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${field.label}は整数で入力してください。`);
    const integer = Number(value);
    if (!Number.isSafeInteger(integer)) throw new Error(`${field.label}の値が範囲外です。`);
    return integer;
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${field.label}の入力を確認してください。`);
    return value;
  }
  if (field.type === "multi-reference" || field.type === "ordered-list") {
    if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw new Error(`${field.label}の入力を確認してください。`);
    return [...value];
  }
  if (typeof value !== "string") throw new Error(`${field.label}の入力を確認してください。`);
  return value;
}

export function formValuesToJson(fields: readonly AuthoringField[], values: Readonly<Record<string, unknown>>): AuthoringJson {
  const output: Record<string, AuthoringJson> = {};
  for (const field of fields) {
    const value = values[field.id];
    if (value === undefined) continue;
    if (field.type === "record-list") {
      if (!Array.isArray(value)) throw new Error(`${field.label}の入力を確認してください。`);
      output[field.id] = value.map((entry, index) => {
        if (!isRecord(entry)) throw new Error(`${field.label} ${index + 1}の入力を確認してください。`);
        const row = cloneJson(entry, 0);
        if (!isRecord(row)) throw new Error(`${field.label} ${index + 1}の入力を確認してください。`);
        for (const child of field.fields) {
          if (!Object.hasOwn(entry, child.id)) continue;
          const converted = scalarValueToJson(child, entry[child.id]);
          if (converted === undefined) delete row[child.id];
          else row[child.id] = converted;
        }
        return row as AuthoringJson;
      });
    } else {
      const converted = scalarValueToJson(field, value);
      if (converted !== undefined) output[field.id] = converted;
    }
  }
  return output;
}

function asRecord(value: unknown): Record<string, AuthoringJson> {
  return isRecord(value) ? value as Record<string, AuthoringJson> : {};
}

function composeSurfaceData(surface: AuthoringSurfaceProps["surface"], data: AuthoringJson): Record<string, AuthoringJson> {
  const base = asRecord(data);
  return { ...base, context: { ...asRecord(surface.context), ...asRecord(base.context) } };
}

function contextLabel(context: Readonly<Record<string, unknown>>): string {
  for (const key of ["label", "description", "scope", "kind"]) {
    const value = context[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function OutlineWidget({ node, data, invoke, navigate, busy }: {
  readonly node: Extract<AuthoringWidget, { type: "outline" }>;
  readonly data: AuthoringJson;
  invoke(binding: AuthoringActionBinding, event: Event, context?: AuthoringJson): void;
  navigate(binding: AuthoringNavigationTemplate, event: Event, context?: AuthoringJson): void;
  readonly busy: boolean;
}): ReactElement {
  const items = useMemo(() => rowsForOutline(isDataKey(node.items) ? dataAtPath(data, node.items.data_key) : node.items), [data, node.items]);
  const [activeId, setActiveId] = useState(items[0]?.id ?? "");
  const [selectedId, setSelectedId] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(items.map(item => item.id)));
  const visible: AuthoringOutlineRow[] = [];
  const flatten = (rows: readonly AuthoringOutlineRow[]) => rows.forEach(row => { visible.push(row); if (expanded.has(row.id)) flatten(row.children ?? []); });
  flatten(items);
  const focusByOffset = (id: string, offset: number) => {
    const index = visible.findIndex(item => item.id === id);
    const target = visible[Math.max(0, Math.min(visible.length - 1, index + offset))];
    if (target) { setActiveId(target.id); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-authoring-tree-id="${CSS.escape(target.id)}"]`)?.focus()); }
  };
  const handleKey = (event: KeyboardEvent<HTMLButtonElement>, item: AuthoringOutlineRow) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); focusByOffset(item.id, event.key === "ArrowDown" ? 1 : -1); }
    else if (event.key === "Home" || event.key === "End") { event.preventDefault(); const target = event.key === "Home" ? visible[0] : visible.at(-1); if (target) { setActiveId(target.id); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-authoring-tree-id="${CSS.escape(target.id)}"]`)?.focus()); } }
    else if (event.key === "ArrowRight" && item.children?.length) { event.preventDefault(); setExpanded(current => new Set(current).add(item.id)); }
    else if (event.key === "ArrowLeft" && expanded.has(item.id)) { event.preventDefault(); setExpanded(current => { const next = new Set(current); next.delete(item.id); return next; }); }
    else if (event.key === "Enter") { event.preventDefault(); activate(item, event.nativeEvent); }
    else if (event.key === " ") { event.preventDefault(); setSelectedId(item.id); }
  };
  const activate = (item: AuthoringOutlineRow, event: Event) => {
    const context = { ...asRecord(data), item: item as unknown as AuthoringJson };
    if (item.navigation) navigate(item.navigation, event, context);
    else { const action = item.action ?? node.activate; if (action) invoke(action, event, context); }
  };
  const render = (rows: readonly AuthoringOutlineRow[]): ReactElement => <ul role="group">{rows.map(item => <li role="treeitem" aria-expanded={item.children?.length ? expanded.has(item.id) : undefined} aria-selected={selectedId === item.id} key={item.id}>
    <button type="button" className="authoring-tree-row" data-authoring-tree-id={item.id} tabIndex={(visible.some(row => row.id === activeId) ? activeId : visible[0]?.id) === item.id ? 0 : -1} onFocus={() => setActiveId(item.id)} onKeyDown={event => handleKey(event, item)} onClick={event => { setSelectedId(item.id); activate(item, event.nativeEvent); }} disabled={busy}>
      {item.children?.length ? <span aria-hidden="true">{expanded.has(item.id) ? "▾" : "▸"}</span> : <span aria-hidden="true">·</span>}<span>{item.title}</span>{item.path && <small>{item.path}</small>}
    </button>{item.children?.length && expanded.has(item.id) ? render(item.children) : null}
  </li>)}</ul>;
  return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title || "作品構成"}</h3>{node.description && <p>{node.description}</p>}{items.length ? <div className="authoring-outline" role="tree" aria-label={node.title || "構成"}>{render(items)}</div> : <p className="authoring-empty">表示できる項目はありません。</p>}<Pagination previous={node.previous_action} next={node.next_action} previousWhen={node.previous_action_when} nextWhen={node.next_action_when} data={data} invoke={(binding, event) => invoke(binding, event)} disabled={busy} /></section>;
}

function WidgetRenderer({ node, data, invoke, navigate, busy, load, cancelRead, nested = false }: {
  readonly node: AuthoringWidget;
  readonly data: AuthoringJson;
  invoke(binding: AuthoringActionBinding, event: Event, context?: AuthoringJson): void;
  navigate(binding: AuthoringNavigationTemplate, event: Event, context?: AuthoringJson): void;
  readonly busy: boolean;
  load(node: AuthoringWidget): void;
  cancelRead(): void;
  readonly nested?: boolean;
}): ReactElement {
  return <>{nested && (node.load_action || node.load_actions?.length) && <button type="button" className="authoring-load-action" disabled={busy} onClick={() => load(node)}>{node.title || "情報"}を読み込む</button>}<WidgetBody node={node} data={data} invoke={invoke} navigate={navigate} busy={busy} load={load} cancelRead={cancelRead} /></>;
}

function WidgetBody({ node, data, invoke, navigate, busy, load, cancelRead }: {
  readonly node: AuthoringWidget;
  readonly data: AuthoringJson;
  invoke(binding: AuthoringActionBinding, event: Event, context?: AuthoringJson): void;
  navigate(binding: AuthoringNavigationTemplate, event: Event, context?: AuthoringJson): void;
  readonly busy: boolean;
  load(node: AuthoringWidget): void;
  cancelRead(): void;
}): ReactElement {
  if (node.type === "outline") return <OutlineWidget node={node} data={data} invoke={invoke} navigate={navigate} busy={busy} />;
  if (node.type === "form") return <FormWidget node={node} data={data} invoke={invoke} busy={busy} />;
  if (node.type === "tabs") return <TabsWidget node={node} data={data} invoke={invoke} navigate={navigate} busy={busy} load={load} cancelRead={cancelRead} />;
  if (node.type === "list") {
    const items = recordRows(isDataKey(node.items) ? dataAtPath(data, node.items.data_key) : node.items);
    return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title}</h3>{node.description && <p>{node.description}</p>}{items.length ? <ul className="authoring-list">{items.map((item, index) => <li key={plainText(item.id) || `${node.id}-${index}`}>
      {(node.item_action || node.item_navigation) && <button type="button" onClick={event => { const context = { ...asRecord(data), item: item as unknown as AuthoringJson }; if (node.item_action) invoke(node.item_action, event.nativeEvent, context); else if (node.item_navigation) navigate(node.item_navigation, event.nativeEvent, context); }} disabled={busy}><strong>{plainText(readPath(item, node.primary))}</strong>{node.secondary && <small>{plainText(readPath(item, node.secondary))}</small>}</button>}
      {node.item_action && node.item_navigation && <button type="button" disabled={busy} onClick={event => navigate(node.item_navigation!, event.nativeEvent, { ...asRecord(data), item: item as unknown as AuthoringJson })}>{plainText(readPath(item, node.primary))}の原文を開く</button>}
      {!node.item_action && !node.item_navigation && <><strong>{plainText(readPath(item, node.primary))}</strong>{node.secondary && <small>{plainText(readPath(item, node.secondary))}</small>}</>}
    </li>)}</ul> : <p className="authoring-empty">表示できる項目はありません。</p>}<Pagination previous={node.previous_action} next={node.next_action} previousWhen={node.previous_action_when} nextWhen={node.next_action_when} data={data} invoke={(binding, event) => invoke(binding, event)} disabled={busy} /></section>;
  }
  if (node.type === "table") {
    const rows = recordRows(isDataKey(node.rows) ? dataAtPath(data, node.rows.data_key) : node.rows);
    return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title}</h3>{node.description && <p>{node.description}</p>}<Table rows={rows} columns={node.columns} label={node.title || "一覧"} /><Pagination previous={node.previous_action} next={node.next_action} previousWhen={node.previous_action_when} nextWhen={node.next_action_when} data={data} invoke={(binding, event) => invoke(binding, event)} disabled={busy} /></section>;
  }
  if (node.type === "detail") {
    const value = isDataKey(node.value) ? dataAtPath(data, node.value.data_key) : node.value;
    const fields = node.fields ?? (isRecord(value) ? Object.keys(value).map(key => ({ key, label: key })) : []);
    return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title}</h3>{node.description && <p>{node.description}</p>}{fields.length ? <dl className="authoring-detail">{fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{plainText(readPath(value, field.key))}</dd></div>)}</dl> : <p className="authoring-empty">詳細はありません。</p>}</section>;
  }
  if (node.type === "status") {
    const state = plainText(isDataKey(node.state) ? dataAtPath(data, node.state.data_key) : node.state);
    const message = node.messages?.[state] ?? state;
    return <section className="authoring-status" aria-labelledby={`authoring-widget-${node.id}`} data-status={state}><h3 id={`authoring-widget-${node.id}`}>{node.title || "状態"}</h3><p role="status">{message || "状態を取得できません。"}</p></section>;
  }
  if (node.type === "progress") {
    const raw = isDataKey(node.value) ? dataAtPath(data, node.value.data_key) : node.value;
    const value = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, raw) : 0;
    const max = Number.isFinite(node.maximum) && (node.maximum ?? 0) > 0 ? node.maximum! : 100;
    return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title || "進行状況"}</h3><label>{node.label || "進行状況"}<progress max={max} value={Math.min(value, max)}>{Math.round(Math.min(value / max, 1) * 100)}%</progress></label></section>;
  }
  if (node.type === "evidence") {
    const items = recordRows(isDataKey(node.items) ? dataAtPath(data, node.items.data_key) : node.items);
    return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title || "根拠"}</h3>{items.length ? <ol className="authoring-evidence">{items.map((item, index) => <li key={plainText(item.id) || `${node.id}-${index}`}><blockquote>{plainText(item.quote)}</blockquote><p>{plainText(item.path)}{typeof item.start === "number" ? ` · ${item.start}–${plainText(item.end)}` : ""}</p>{(node.open_action || node.open_navigation) && <button type="button" disabled={busy} onClick={event => { const context = { ...asRecord(data), item: item as unknown as AuthoringJson }; if (node.open_navigation) navigate(node.open_navigation, event.nativeEvent, context); else if (node.open_action) invoke(node.open_action, event.nativeEvent, context); }}>根拠を開く</button>}</li>)}</ol> : <p className="authoring-empty">根拠はありません。</p>}</section>;
  }
  if (node.type === "diff") {
    const files = recordRows(isDataKey(node.files) ? dataAtPath(data, node.files.data_key) : node.files);
    return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title || "変更内容"}</h3>{files.length ? <ol className="authoring-diff">{files.map((file, index) => <li key={plainText(file.path) || `${node.id}-${index}`}><h4>{plainText(file.path)}</h4>{plainText(file.before) && <pre className="authoring-diff-before">{plainText(file.before)}</pre>}{plainText(file.after) && <pre className="authoring-diff-after">{plainText(file.after)}</pre>}</li>)}</ol> : <p className="authoring-empty">変更内容はありません。</p>}</section>;
  }
  if (node.type === "graph" || node.type === "map" || node.type === "timeline") {
    const entities = recordRows(isDataKey(node.entities) ? dataAtPath(data, node.entities.data_key) : node.entities);
    const edges = recordRows(node.edges && isDataKey(node.edges) ? dataAtPath(data, node.edges.data_key) : node.edges);
    const columns = node.columns ?? [{ key: "title", label: node.type === "timeline" ? "時点" : "項目" }, { key: "description", label: node.type === "map" ? "場所" : "説明" }];
    return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title || node.type}</h3>{node.description && <p>{node.description}</p>}
      {node.type === "timeline" ? <ol className="authoring-timeline" aria-label={node.title || "時系列"}>{entities.map((entity, index) => <li key={plainText(entity.id) || index}><strong>{plainText(entity.order)} · {plainText(entity.title || entity.name || entity.id)}</strong><p>{plainText(entity.relation)} {plainText(entity.confidence)}</p></li>)}</ol>
        : <EntityDiagram entities={entities} edges={edges} kind={node.type} label={node.title || node.type} />}
      <Table rows={entities} columns={columns} label={node.title || node.type} />
      {edges.length > 0 && <Table rows={edges} columns={[{ key: "from", label: "起点" }, { key: "to", label: "終点" }, { key: "kind", label: "関係" }]} label={`${node.title || node.type}の関係`} />}
    </section>;
  }
  return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title}</h3><p className="authoring-unavailable">この表示形式には対応していません。</p></section>;
}

/** Deterministic Host layout; guest data can supply text and finite coordinates only. */
function EntityDiagram({ entities, edges, kind, label }: {
  readonly entities: readonly Record<string, unknown>[];
  readonly edges: readonly Record<string, unknown>[];
  readonly kind: "graph" | "map";
  readonly label: string;
}): ReactElement {
  const shown = entities.slice(0, 128);
  const positions = new Map<string, { x: number; y: number }>();
  const positioned = shown.length > 0 && shown.every(entity => typeof entity.x === "number" && Number.isFinite(entity.x) && typeof entity.y === "number" && Number.isFinite(entity.y));
  const coordinate = (key: "x" | "y", entity: Record<string, unknown>): number => {
    const values = shown.map(row => row[key] as number);
    const low = Math.min(...values), high = Math.max(...values);
    return 45 + (high === low ? .5 : ((entity[key] as number) - low) / (high - low)) * (key === "x" ? 510 : 310);
  };
  shown.forEach((entity, index) => {
    const angle = 2 * Math.PI * index / Math.max(1, shown.length) - Math.PI / 2;
    const id = plainText(entity.id);
    if (id) positions.set(id, positioned ? { x: coordinate("x", entity), y: coordinate("y", entity) }
      : { x: 300 + Math.cos(angle) * 230, y: 200 + Math.sin(angle) * 145 });
  });
  return <figure className="authoring-entity-diagram">
    {shown.length ? <svg viewBox="0 0 600 400" role="img" aria-label={label} style={{ width: "100%", maxHeight: "28rem" }}>
      <title>{label}</title>
      {edges.slice(0, 512).map((edge, index) => {
        const from = positions.get(plainText(edge.from)), to = positions.get(plainText(edge.to));
        return from && to ? <g key={`edge-${index}`}><line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="currentColor" opacity=".4" /><title>{plainText(edge.from)} → {plainText(edge.to)}: {plainText(edge.kind)}</title></g> : null;
      })}
      {shown.map((entity, index) => {
        const point = positions.get(plainText(entity.id));
        return point ? <g key={`node-${index}`}><circle cx={point.x} cy={point.y} r="7" fill="currentColor" /><text x={point.x} y={point.y + 19} textAnchor="middle" fill="currentColor" fontSize="12">{plainText(entity.name || entity.title || entity.id).slice(0, 32)}</text><title>{plainText(entity.name || entity.title || entity.id)}</title></g> : null;
      })}
    </svg> : <p className="authoring-empty">表示できる項目はありません。</p>}
    <figcaption>{kind === "map" && !positioned ? "位置座標は未設定です。場所どうしの関係を表示します。" : "項目と関係を表示しています。"}{entities.length > shown.length && ` 図は先頭${shown.length}件です。全項目は一覧で確認できます。`}</figcaption>
  </figure>;
}

function TabsWidget({ node, data, invoke, navigate, busy, load, cancelRead }: {
  readonly node: Extract<AuthoringWidget, { type: "tabs" }>;
  readonly data: AuthoringJson;
  invoke(binding: AuthoringActionBinding, event: Event, context?: AuthoringJson): void;
  navigate(binding: AuthoringNavigationTemplate, event: Event, context?: AuthoringJson): void;
  readonly busy: boolean;
  load(node: AuthoringWidget): void;
  cancelRead(): void;
  readonly nested?: boolean;
}): ReactElement {
  const [activeId, setActiveId] = useState(node.tabs[0]?.id ?? "");
  const active = node.tabs.find(tab => tab.id === activeId) ?? node.tabs[0];
  return <section className="authoring-widget" aria-label={node.title || "詳細"}><div className="authoring-tabs" role="tablist" aria-label={node.title || "詳細"}>{node.tabs.map(tab => <button type="button" role="tab" id={`authoring-tab-${tab.id}`} aria-selected={active?.id === tab.id} aria-controls={`authoring-tabpanel-${tab.id}`} tabIndex={active?.id === tab.id ? 0 : -1} key={tab.id} onClick={() => { cancelRead(); setActiveId(tab.id); }}>{tab.title}</button>)}</div>{active && <div role="tabpanel" id={`authoring-tabpanel-${active.id}`} aria-labelledby={`authoring-tab-${active.id}`}><WidgetRenderer key={active.id} node={active.body} data={data} invoke={invoke} navigate={navigate} busy={busy} load={load} cancelRead={cancelRead} nested /></div>}</section>;
}

export function AuthoringSurface({ surface, data: initialData = EMPTY_DATA, status = "ready", message, onInvoke, onRead, onNavigate, onClose, className = "" }: AuthoringSurfaceProps): ReactElement {
  const [lastActionResult, setLastActionResult] = useState<AuthoringJson | undefined>();
  const [loadResults, setLoadResults] = useState<Record<string, AuthoringJson>>({});
  const [artifact, setArtifact] = useState<AuthoringHostArtifact | undefined>();
  const data = useMemo(() => {
    const base = composeSurfaceData(surface, initialData);
    const load = { ...asRecord(base.load), ...loadResults };
    return {
      ...base,
      ...(Object.keys(loadResults).length ? { load } : {}),
      ...(lastActionResult === undefined ? {} : { last_action_result: lastActionResult }),
    };
  }, [surface, initialData, lastActionResult, loadResults]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const readController = useRef<AbortController | null>(null);
  useEffect(() => () => readController.current?.abort(), []);
  const runAction = useCallback(async (binding: AuthoringActionBinding, context: AuthoringJson, event: Event) => {
    const resolved = Object.fromEntries(Object.entries(binding.input_template).map(([key, template]) => [key, resolveAuthoringTemplate(template, context)]));
    if (!isRecord(resolved)) throw new Error("An action input must resolve to a JSON object.");
    return onInvoke({ actionId: binding.action_id, input: resolved as Record<string, AuthoringJson>, event });
  }, [onInvoke]);
  const invoke = useCallback(async (binding: AuthoringActionBinding, event: Event, context: AuthoringJson = data): Promise<void> => {
    if (!validBinding(binding) || busy) return;
    setBusy(true); setError(""); setArtifact(undefined);
    try {
      const output = await runAction(binding, context, event);
      if (!output.action_result.ok) throw new Error(`${output.action_result.error.code}: ${output.action_result.error.message}`);
      // Navigation-only results leave the current outline page and its scroll position mounted.
      const resultValue = output.action_result.value;
      if (!(isRecord(resultValue) && isRecord(resultValue.navigation))) setLastActionResult(cloneJson(resultValue, 0));
      setArtifact(output.artifact);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作を完了できませんでした。"); }
    finally { setBusy(false); }
  }, [busy, data, runAction]);
  const navigate = useCallback(async (binding: AuthoringNavigationTemplate, event: Event, context: AuthoringJson = data): Promise<void> => {
    if (!onNavigate) { setError("Host navigation is unavailable."); return; }
    if (busy) return;
    setBusy(true); setError(""); setArtifact(undefined);
    try {
      const resolved = resolveAuthoringNavigation(binding, context);
      await onNavigate(event, resolved.target, resolved.intent);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "移動できませんでした。"); }
    finally { setBusy(false); }
  }, [busy, data, onNavigate]);
  const initialStatus = status === "loading" || status === "partial" || status === "stale" || status === "unavailable" || status === "failure";
  const loadActions = surface.body.load_actions?.length
    ? surface.body.load_actions
    : surface.body.load_action ? [{ key: "", ...surface.body.load_action }] : [];
  const cancelRead = useCallback(() => {
    if (readController.current) { readController.current.abort(); readController.current = null; setBusy(false); }
  }, []);
  const load = useCallback(async (node: AuthoringWidget = surface.body) => {
    const requestedActions = node.load_actions?.length ? node.load_actions
      : node.load_action ? [{ key: "", ...node.load_action }] : [];
    if (busy || !requestedActions.length) return;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    setBusy(true); setError("");
    const nextResults = { ...loadResults };
    let latest: AuthoringJson | undefined = lastActionResult;
    try {
      for (const declaration of requestedActions) {
        const base = composeSurfaceData(surface, initialData);
        const context: AuthoringJson = {
          ...base,
          ...(Object.keys(nextResults).length ? { load: { ...asRecord(base.load), ...nextResults } } : {}),
          ...(latest === undefined ? {} : { last_action_result: latest }),
        };
        const { key, ...binding } = declaration;
        const resolved = Object.fromEntries(Object.entries(binding.input_template).map(([inputKey, template]) => [inputKey, resolveAuthoringTemplate(template, context)]));
        if (!isRecord(resolved)) throw new Error("A read input must resolve to a JSON object.");
        const result = await onRead({ actionId: binding.action_id, input: resolved as Record<string, AuthoringJson>, signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
        latest = cloneJson(result.value, 0);
        if (key) nextResults[key] = latest;
      }
      if (controller.signal.aborted) return;
      setLoadResults(nextResults);
      if (latest !== undefined) setLastActionResult(latest);
      setArtifact(undefined);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "読み込みを完了できませんでした。");
    } finally {
      if (readController.current === controller) readController.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }, [busy, initialData, lastActionResult, loadResults, onRead, surface]);
  const hasLoadAction = loadActions.length > 0;
  return <section className={`authoring-surface authoring-surface-${surface.kind} ${className}`.trim()} aria-labelledby={`authoring-surface-${surface.id}`}>
    <header className="authoring-surface-header"><div>{contextLabel(surface.context) && <p className="authoring-surface-context">{contextLabel(surface.context)}</p>}<h2 id={`authoring-surface-${surface.id}`}>{surface.title}</h2></div>{onClose && <button type="button" className="authoring-surface-close" onClick={onClose} aria-label={`${surface.title}を閉じる`}>閉じる</button>}</header>
    {initialStatus && <p className={`authoring-state authoring-state-${status}`} role="status" aria-live="polite">{message || statusMessage(status)}</p>}
    {error && <p className="authoring-error" role="alert">{error}</p>}
    {hasLoadAction && <button type="button" className="authoring-load-action" disabled={busy || status === "unavailable" || status === "failure"} onClick={() => void load()}>{lastActionResult === undefined ? "読み込む" : "更新"}</button>}
    {status !== "unavailable" && status !== "failure" && <div className="authoring-surface-body" aria-busy={busy}>{busy && <p className="authoring-submitting" role="status">処理中…</p>}<WidgetRenderer node={surface.body} data={data} invoke={(binding, event, context) => void invoke(binding, event, context)} navigate={(binding, event, context) => void navigate(binding, event, context)} busy={busy} load={node => void load(node)} cancelRead={cancelRead} /></div>}
    {artifact && <ArtifactResultToolbar artifact={artifact} />}
  </section>;
}

function statusMessage(status: AuthoringSurfaceProps["status"]): string {
  switch (status) {
    case "loading": return "読み込み中です。";
    case "partial": return "一部の情報を表示しています。";
    case "stale": return "ワークスペースが変更されています。情報を更新してください。";
    case "unavailable": return "この機能は現在利用できません。";
    case "failure": return "情報を読み込めませんでした。";
    default: return "";
  }
}
