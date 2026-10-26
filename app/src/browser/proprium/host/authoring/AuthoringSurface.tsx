import { useCallback, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactElement } from "react";
import type {
  AuthoringActionBinding,
  AuthoringColumn,
  AuthoringDataKey,
  AuthoringField,
  AuthoringJson,
  AuthoringOutlineRow,
  AuthoringSurfaceProps,
  AuthoringTemplate,
  AuthoringWidget,
} from "./types.js";

const DATA_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;
const MAX_TEMPLATE_DEPTH = 12;
const UNSAFE_DATA_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isValidDataPath(path: string): boolean {
  return DATA_KEY_PATTERN.test(path) && path.split(".").every(part => !UNSAFE_DATA_KEYS.has(part));
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
    if (!isRecord(value) || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
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
    if (!isRecord(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function validBinding(binding: AuthoringActionBinding): boolean {
  return /^[a-z][a-z0-9._-]{0,127}$/u.test(binding.action_id) && isRecord(binding.input_template);
}

function rowsForOutline(value: unknown): readonly AuthoringOutlineRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is AuthoringOutlineRow => isRecord(row) && typeof row.id === "string" && typeof row.title === "string");
}

function Pagination({ previous, next, invoke, disabled }: {
  readonly previous?: AuthoringActionBinding;
  readonly next?: AuthoringActionBinding;
  invoke(binding: AuthoringActionBinding): void;
  readonly disabled: boolean;
}): ReactElement | null {
  if (!previous && !next) return null;
  return <nav className="authoring-pagination" aria-label="ページ送り">
    {previous && <button type="button" disabled={disabled} onClick={() => invoke(previous)}>前へ</button>}
    {next && <button type="button" disabled={disabled} onClick={() => invoke(next)}>次へ</button>}
  </nav>;
}

function Table({ rows, columns, label }: { readonly rows: readonly Record<string, unknown>[]; readonly columns: readonly AuthoringColumn[]; readonly label: string }): ReactElement {
  if (!rows.length) return <p className="authoring-empty">表示できる項目はありません。</p>;
  return <div className="authoring-table-scroll" role="region" aria-label={label} tabIndex={0}><table className="authoring-table"><thead><tr>{columns.map(column => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead><tbody>
    {rows.map((row, rowIndex) => <tr key={plainText(row.id) || `${label}-${rowIndex}`}>{columns.map(column => <td key={column.key}>{plainText(readPath(row, column.key))}</td>)}</tr>)}
  </tbody></table></div>;
}

function FormWidget({ node, data, invoke, busy }: {
  readonly node: Extract<AuthoringWidget, { type: "form" }>;
  readonly data: AuthoringJson;
  invoke(binding: AuthoringActionBinding, context?: AuthoringJson): void;
  readonly busy: boolean;
}): ReactElement {
  const [values, setValues] = useState<Record<string, string | boolean | string[]>>({});
  const [error, setError] = useState("");
  const update = (field: AuthoringField, value: string | boolean | string[]) => setValues(current => ({ ...current, [field.id]: value }));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = node.fields.find(field => {
      const value = values[field.id];
      const empty = value === undefined || value === "" || (Array.isArray(value) && !value.length);
      if (field.required && empty) { setError(field.validation_message || `${field.label}を入力してください。`); return true; }
      if (typeof value === "string" && ((field.min_length !== undefined && value.length < field.min_length) || (field.max_length !== undefined && value.length > field.max_length))) {
        setError(field.validation_message || `${field.label}の入力を確認してください。`); return true;
      }
      return false;
    });
    if (validation) return;
    setError("");
    try {
      invoke(node.submit, { ...asRecord(data), form: formValuesToJson(node.fields, values) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "入力内容を確認してください。");
    }
  };
  const labelId = `authoring-form-${node.id}`;
  return <form className="authoring-form" aria-labelledby={labelId} onSubmit={submit}>
    {node.title && <h3 id={labelId}>{node.title}</h3>}{node.description && <p>{node.description}</p>}
    {node.fields.map(field => <label className="authoring-field" key={field.id}>
      <span>{field.label}{field.required && <span aria-hidden="true"> *</span>}</span>
      {field.type === "boolean" ? <input type="checkbox" checked={Boolean(values[field.id])} onChange={event => update(field, event.currentTarget.checked)} />
        : field.type === "enum" ? <select required={field.required} value={plainText(values[field.id])} onChange={event => update(field, event.currentTarget.value)}><option value="">選択してください</option>{(field.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          : field.type === "multi-reference" ? <select multiple required={field.required} value={Array.isArray(values[field.id]) ? values[field.id] as string[] : []} onChange={event => update(field, Array.from(event.currentTarget.selectedOptions, option => option.value))}>{(field.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            : field.type === "ordered-list" ? <textarea rows={4} required={field.required} placeholder={field.placeholder} value={Array.isArray(values[field.id]) ? (values[field.id] as string[]).join("\n") : ""} onChange={event => update(field, event.currentTarget.value.split("\n"))} />
              : <input type={field.type === "integer" ? "number" : "text"} required={field.required} minLength={field.min_length} maxLength={field.max_length} placeholder={field.placeholder} value={plainText(values[field.id])} onChange={event => update(field, field.type === "integer" ? event.currentTarget.value : event.currentTarget.value)} />}
    </label>)}
    {error && <p className="authoring-error" role="alert">{error}</p>}
    <div className="authoring-form-actions"><button type="submit" disabled={busy || !validBinding(node.submit)}>送信</button>{node.cancel_action && <button type="button" disabled={busy} onClick={() => invoke(node.cancel_action!)}>キャンセル</button>}</div>
  </form>;
}

export function formValuesToJson(fields: readonly AuthoringField[], values: Readonly<Record<string, string | boolean | string[]>>): AuthoringJson {
  const output: Record<string, AuthoringJson> = {};
  for (const field of fields) {
    const value = values[field.id];
    if (value === undefined) continue;
    if (field.type === "integer") {
      if (value === "") continue;
      if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${field.label}は整数で入力してください。`);
      const integer = Number(value);
      if (!Number.isSafeInteger(integer)) throw new Error(`${field.label}の値が範囲外です。`);
      output[field.id] = integer;
    } else {
      output[field.id] = Array.isArray(value) ? [...value] : value;
    }
  }
  return output;
}

function asRecord(value: unknown): Record<string, AuthoringJson> {
  return isRecord(value) ? value as Record<string, AuthoringJson> : {};
}

function contextLabel(context: Readonly<Record<string, unknown>>): string {
  for (const key of ["label", "description", "scope", "kind"]) {
    const value = context[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function OutlineWidget({ node, data, invoke, busy }: {
  readonly node: Extract<AuthoringWidget, { type: "outline" }>;
  readonly data: AuthoringJson;
  invoke(binding: AuthoringActionBinding, context?: AuthoringJson): void;
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
    else if (event.key === "Enter") { event.preventDefault(); const action = item.action ?? node.activate; if (action) invoke(action, { ...asRecord(data), item: item as unknown as AuthoringJson }); }
    else if (event.key === " ") { event.preventDefault(); setSelectedId(item.id); }
  };
  const render = (rows: readonly AuthoringOutlineRow[]): ReactElement => <ul role="group">{rows.map(item => <li role="treeitem" aria-expanded={item.children?.length ? expanded.has(item.id) : undefined} aria-selected={selectedId === item.id} key={item.id}>
    <button type="button" className="authoring-tree-row" data-authoring-tree-id={item.id} tabIndex={activeId === item.id ? 0 : -1} onFocus={() => setActiveId(item.id)} onKeyDown={event => handleKey(event, item)} onClick={() => { setSelectedId(item.id); const action = item.action ?? node.activate; if (action) invoke(action, { ...asRecord(data), item: item as unknown as AuthoringJson }); }} disabled={busy}>
      {item.children?.length ? <span aria-hidden="true">{expanded.has(item.id) ? "▾" : "▸"}</span> : <span aria-hidden="true">·</span>}<span>{item.title}</span>{item.path && <small>{item.path}</small>}
    </button>{item.children?.length && expanded.has(item.id) ? render(item.children) : null}
  </li>)}</ul>;
  return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title || "作品構成"}</h3>{node.description && <p>{node.description}</p>}{items.length ? <div className="authoring-outline" role="tree" aria-label={node.title || "構成"}>{render(items)}</div> : <p className="authoring-empty">表示できる項目はありません。</p>}<Pagination previous={node.previous_action} next={node.next_action} invoke={binding => invoke(binding)} disabled={busy} /></section>;
}

function WidgetRenderer({ node, data, invoke, busy }: {
  readonly node: AuthoringWidget;
  readonly data: AuthoringJson;
  invoke(binding: AuthoringActionBinding, context?: AuthoringJson): void;
  readonly busy: boolean;
}): ReactElement {
  if (node.type === "outline") return <OutlineWidget node={node} data={data} invoke={invoke} busy={busy} />;
  if (node.type === "form") return <FormWidget node={node} data={data} invoke={invoke} busy={busy} />;
  if (node.type === "tabs") return <TabsWidget node={node} data={data} invoke={invoke} busy={busy} />;
  if (node.type === "list") {
    const items = recordRows(isDataKey(node.items) ? dataAtPath(data, node.items.data_key) : node.items);
    return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title}</h3>{node.description && <p>{node.description}</p>}{items.length ? <ul className="authoring-list">{items.map((item, index) => <li key={plainText(item.id) || `${node.id}-${index}`}>
      {node.item_action && <button type="button" onClick={() => invoke(node.item_action!, { ...asRecord(data), item: item as unknown as AuthoringJson })} disabled={busy}><strong>{plainText(readPath(item, node.primary))}</strong>{node.secondary && <small>{plainText(readPath(item, node.secondary))}</small>}</button>}
      {!node.item_action && <><strong>{plainText(readPath(item, node.primary))}</strong>{node.secondary && <small>{plainText(readPath(item, node.secondary))}</small>}</>}
    </li>)}</ul> : <p className="authoring-empty">表示できる項目はありません。</p>}<Pagination previous={node.previous_action} next={node.next_action} invoke={binding => invoke(binding)} disabled={busy} /></section>;
  }
  if (node.type === "table") {
    const rows = recordRows(isDataKey(node.rows) ? dataAtPath(data, node.rows.data_key) : node.rows);
    return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title}</h3>{node.description && <p>{node.description}</p>}<Table rows={rows} columns={node.columns} label={node.title || "一覧"} /><Pagination previous={node.previous_action} next={node.next_action} invoke={binding => invoke(binding)} disabled={busy} /></section>;
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
    return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title || "根拠"}</h3>{items.length ? <ol className="authoring-evidence">{items.map((item, index) => <li key={plainText(item.id) || `${node.id}-${index}`}><blockquote>{plainText(item.quote)}</blockquote><p>{plainText(item.path)}{typeof item.start === "number" ? ` · ${item.start}–${plainText(item.end)}` : ""}</p>{node.open_action && <button type="button" disabled={busy} onClick={() => invoke(node.open_action!, { ...asRecord(data), item: item as unknown as AuthoringJson })}>根拠を開く</button>}</li>)}</ol> : <p className="authoring-empty">根拠はありません。</p>}</section>;
  }
  if (node.type === "diff") {
    const files = recordRows(isDataKey(node.files) ? dataAtPath(data, node.files.data_key) : node.files);
    return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title || "変更内容"}</h3>{files.length ? <ol className="authoring-diff">{files.map((file, index) => <li key={plainText(file.path) || `${node.id}-${index}`}><h4>{plainText(file.path)}</h4>{plainText(file.before) && <pre className="authoring-diff-before">{plainText(file.before)}</pre>}{plainText(file.after) && <pre className="authoring-diff-after">{plainText(file.after)}</pre>}</li>)}</ol> : <p className="authoring-empty">変更内容はありません。</p>}</section>;
  }
  if (node.type === "graph" || node.type === "map" || node.type === "timeline") {
    const entities = recordRows(isDataKey(node.entities) ? dataAtPath(data, node.entities.data_key) : node.entities);
    const columns = node.columns ?? [{ key: "title", label: node.type === "timeline" ? "時点" : "項目" }, { key: "description", label: node.type === "map" ? "場所" : "説明" }];
    return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title || node.type}</h3><p>{node.description || "図の内容をアクセシブルな一覧で表示しています。"}</p><Table rows={entities} columns={columns} label={node.title || node.type} /></section>;
  }
  return <section className="authoring-widget" aria-labelledby={`authoring-widget-${node.id}`}><h3 id={`authoring-widget-${node.id}`}>{node.title}</h3><p className="authoring-unavailable">この表示形式には対応していません。</p></section>;
}

function TabsWidget({ node, data, invoke, busy }: {
  readonly node: Extract<AuthoringWidget, { type: "tabs" }>;
  readonly data: AuthoringJson;
  invoke(binding: AuthoringActionBinding, context?: AuthoringJson): void;
  readonly busy: boolean;
}): ReactElement {
  const [activeId, setActiveId] = useState(node.tabs[0]?.id ?? "");
  const active = node.tabs.find(tab => tab.id === activeId) ?? node.tabs[0];
  return <section className="authoring-widget" aria-label={node.title || "詳細"}><div className="authoring-tabs" role="tablist" aria-label={node.title || "詳細"}>{node.tabs.map(tab => <button type="button" role="tab" id={`authoring-tab-${tab.id}`} aria-selected={active?.id === tab.id} aria-controls={`authoring-tabpanel-${tab.id}`} tabIndex={active?.id === tab.id ? 0 : -1} key={tab.id} onClick={() => setActiveId(tab.id)}>{tab.title}</button>)}</div>{active && <div role="tabpanel" id={`authoring-tabpanel-${active.id}`} aria-labelledby={`authoring-tab-${active.id}`}><WidgetRenderer node={active.body} data={data} invoke={invoke} busy={busy} /></div>}</section>;
}

export function AuthoringSurface({ surface, data: initialData = {}, status = "ready", message, onInvoke, onClose, className = "" }: AuthoringSurfaceProps): ReactElement {
  const [lastActionResult, setLastActionResult] = useState<AuthoringJson | undefined>();
  const data = useMemo(() => lastActionResult === undefined ? initialData : { ...asRecord(initialData), last_action_result: lastActionResult }, [initialData, lastActionResult]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const invoke = useCallback(async (binding: AuthoringActionBinding, context: AuthoringJson = data): Promise<void> => {
    if (!validBinding(binding) || busy) return;
    setBusy(true); setError("");
    try {
      const resolved = Object.fromEntries(Object.entries(binding.input_template).map(([key, template]) => [key, resolveAuthoringTemplate(template, context)]));
      if (!isRecord(resolved)) throw new Error("An action input must resolve to a JSON object.");
      setLastActionResult(await onInvoke({ actionId: binding.action_id, input: resolved as Record<string, AuthoringJson> }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作を完了できませんでした。"); }
    finally { setBusy(false); }
  }, [busy, data, onInvoke]);
  const initialStatus = status === "loading" || status === "partial" || status === "stale" || status === "unavailable" || status === "failure";
  const loadAction = surface.body.load_action;
  return <section className={`authoring-surface authoring-surface-${surface.kind} ${className}`.trim()} aria-labelledby={`authoring-surface-${surface.id}`}>
    <header className="authoring-surface-header"><div>{contextLabel(surface.context) && <p className="authoring-surface-context">{contextLabel(surface.context)}</p>}<h2 id={`authoring-surface-${surface.id}`}>{surface.title}</h2></div>{onClose && <button type="button" className="authoring-surface-close" onClick={onClose} aria-label={`${surface.title}を閉じる`}>閉じる</button>}</header>
    {initialStatus && <p className={`authoring-state authoring-state-${status}`} role="status" aria-live="polite">{message || statusMessage(status)}</p>}
    {error && <p className="authoring-error" role="alert">{error}</p>}
    {loadAction && <button type="button" className="authoring-load-action" disabled={busy || status === "unavailable" || status === "failure"} onClick={() => void invoke(loadAction)}>{lastActionResult === undefined ? "読み込む" : "更新"}</button>}
    {status !== "unavailable" && status !== "failure" && <div className="authoring-surface-body" aria-busy={busy}>{busy && <p className="authoring-submitting" role="status">処理中…</p>}<WidgetRenderer node={surface.body} data={data} invoke={(binding, context) => void invoke(binding, context)} busy={busy} /></div>}
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
