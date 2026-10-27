import { Validator, type Schema } from "@cfworker/json-schema";
import { structuralSchemaMeta } from "./schema-meta.js";
import type { ActionDescriptor, ActionRequest, ActionResult, JsonSchema } from "./types.js";
import { AuthoringError } from "./types.js";

const text = (maxLength = 256, minLength = 1) => ({ type: "string", minLength, maxLength });
const array = (items: unknown, maxItems = 256) => ({ type: "array", items, maxItems });
const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: "object", properties, required, additionalProperties: false });
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const jsonObject = { type: "object" };
export const scopeSchema = closed({
  workspace_id: text(), repository_id: nullable({ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  branch: text(1024), generation: text(),
});
export const snapshotSchema = closed({
  id: text(), local_commit: nullable(text()), worktree_generation: text(),
  draft_generation: nullable(text()), remote_commit: nullable(text()),
}, ["id", "local_commit", "worktree_generation", "draft_generation"]);
const schemaValue = { anyOf: [{ type: "boolean" }, { type: "object" }] };
export const actionDescriptorSchema = closed({
  plugin_id: text(128), action_id: text(256), schema_version: { const: 1 },
  effect: { enum: ["read", "propose"] }, input_schema: schemaValue, output_schema: schemaValue,
  required_capabilities: { ...array(text(128), 128), uniqueItems: true },
  callers: { ...array({ enum: ["ui", "mcp", "plugin"] }, 3), minItems: 1, uniqueItems: true },
  requires_user_gesture: { type: "boolean" }, caller_plugins: { ...array(text(128), 128), uniqueItems: true },
}, ["plugin_id", "action_id", "schema_version", "effect", "input_schema", "output_schema", "required_capabilities", "callers", "requires_user_gesture"]);
export const actionRequestSchema = closed({
  schema_version: { const: 1 }, request_id: text(), plugin_id: text(128), action_id: text(),
  scope: scopeSchema, snapshot: snapshotSchema, input: jsonObject,
  deadline_ms: { type: "integer", minimum: 1, maximum: 120000 }, idempotency_key: text(),
}, ["schema_version", "request_id", "plugin_id", "action_id", "scope", "snapshot", "input", "deadline_ms"]);
const errorSchema = closed({ code: text(128), message: text(4096), retryable: { type: "boolean" }, details: jsonObject },
  ["code", "message", "retryable"]);
export const actionResultSchema = { oneOf: [
  closed({ ok: { const: true }, request_id: text(), scope: scopeSchema, snapshot: snapshotSchema,
    value: true, warnings: array(text(4096, 0), 256) }),
  closed({ ok: { const: false }, request_id: text(), scope: scopeSchema, snapshot: snapshotSchema, error: errorSchema }),
] };

/** Host-rendered widget shapes; no expression language or executable content. */
const binding = closed({ action_id: text(), input_template: jsonObject });
const template = true;
const nav = closed({ target: jsonObject, intent: { enum: ["open", "reveal"] } });
const column = closed({ key: text(), label: text() });
const fieldProperties = {
  id: text(), label: text(), required: { type: "boolean" },
  initial_value: true,
  options: { oneOf: [array(closed({ value: text(), label: text() }), 1000), closed({ data_key: text() })] },
  option_value_key: text(), option_label_key: text(), placeholder: text(4096, 0),
  min_length: { type: "integer", minimum: 0, maximum: 1048576 },
  max_length: { type: "integer", minimum: 0, maximum: 1048576 }, validation_message: text(4096),
};
const scalarField = closed({ ...fieldProperties,
  type: { enum: ["string", "integer", "boolean", "enum", "multi-reference", "ordered-list"] },
}, ["id", "label", "type"]);
const field = { oneOf: [scalarField, closed({ ...fieldProperties, type: { const: "record-list" },
  fields: array(scalarField, 64), initial_value: template, key_field: text(128),
  min_items: { type: "integer", minimum: 0, maximum: 10000 },
  max_items: { type: "integer", minimum: 0, maximum: 10000 },
}, ["id", "label", "type", "fields"])] };
const baseWidget = { id: text(), title: text(), description: text(4096), load_action: binding,
  load_actions: array(closed({ key: text(128), action_id: text(), input_template: jsonObject }), 8) };
const widget = (type: string | string[], properties: Record<string, unknown>, required: string[]) =>
  closed({ ...baseWidget, type: typeof type === "string" ? { const: type } : { enum: type }, ...properties },
    ["id", "type", ...required]);
const dataKey = closed({ data_key: text(256) });
const paging = { next_action: binding, previous_action: binding, next_action_when: dataKey, previous_action_when: dataKey };
export const surfaceSchema = {
  $id: "urn:proprium:authoring:surface:v2",
  ...closed({ id: text(), kind: { enum: ["panel", "command"] }, title: text(), context: jsonObject,
    body: { $ref: "#/$defs/widget" } }),
  $defs: { widget: { oneOf: [
    widget("outline", { items: template, activate: binding, ...paging }, ["items"]),
    widget("list", { items: template, primary: text(), secondary: text(), item_action: binding, item_navigation: nav, ...paging }, ["items", "primary"]),
    widget("table", { rows: template, columns: array(column, 64), ...paging }, ["rows", "columns"]),
    widget("detail", { value: template, fields: array(column, 64) }, ["value"]),
    widget("form", { fields: array(field, 64), submit: binding, cancel_action: binding,
      confirmation: closed({ title: text(), message: text(4096), continue_label: text(), cancel_label: text() }, ["title", "message"]),
      submit_when: dataKey, unavailable_message: text(4096),
    }, ["fields", "submit"]),
    widget("tabs", { tabs: array(closed({ id: text(), title: text(), body: { $ref: "#/$defs/widget" } }), 32) }, ["tabs"]),
    widget("status", { state: template, messages: { type: "object", additionalProperties: text(4096) } }, ["state"]),
    widget("progress", { value: template, maximum: { type: "number", exclusiveMinimum: 0 }, label: text() }, ["value"]),
    widget("evidence", { items: template, open_action: binding, open_navigation: nav }, ["items"]),
    widget("diff", { files: template }, ["files"]),
    widget(["graph", "map", "timeline"], { entities: template, edges: template, columns: array(column, 64) }, ["entities"]),
  ] } },
};

// Interpret the adopted schema without eval/Function. Runtime code generation is
// forbidden by the static Host CSP, including for newly installed action schemas.
const compile = (schema: unknown) => {
  const validator = new Validator(structuredClone(schema) as Schema | boolean, "2020-12", true);
  return (value: unknown) => validator.validate(value).valid;
};
const schemaValidator = new Validator(structuredClone(structuralSchemaMeta) as Schema, "7", true);
const requestValidator = compile(actionRequestSchema);
const descriptorValidator = compile(actionDescriptorSchema);
const resultValidator = compile(actionResultSchema);
const surfaceValidator = compile(surfaceSchema);
const valueValidators = new WeakMap<object, ReturnType<typeof compile>>();
function invalid(phase: string): never {
  throw new AuthoringError("invalid_input", `${phase} does not match its declared schema`);
}
function assertSize(value: unknown, limit = 1024 * 1024): void {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { invalid("JSON value"); }
  if (typeof serialized !== "string" || new TextEncoder().encode(serialized).length > limit) invalid("JSON size");
}
/** Schema safety is checked at admission, before an untrusted declaration compiles. */
export function assertSafeSchema(schema: JsonSchema): void {
  assertSize(schema, 256 * 1024);
  if (!schemaValidator.validate(schema).valid) invalid("Action schema");
  let nodes = 0;
  const visit = (value: unknown, depth: number) => {
    if (++nodes > 10000 || depth > 64) invalid("Schema complexity");
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
    const object = value as Record<string, unknown>;
    if ("$async" in object || "$dynamicRef" in object || "$recursiveRef" in object) invalid("Unsupported schema extension");
    if (typeof object.$ref === "string" && !object.$ref.startsWith("#/")) invalid("Unadmitted schema reference");
    if ((object.type === "object" || object.properties) && object.additionalProperties !== false) invalid("Open object schema");
    if (object.type === "array" && (!Number.isSafeInteger(object.maxItems) || (object.maxItems as number) > 262144)) invalid("Unbounded array schema");
    if (object.type === "string" && (!Number.isSafeInteger(object.maxLength) || (object.maxLength as number) > 1048576)) invalid("Unbounded string schema");
    for (const child of Object.values(object)) visit(child, depth + 1);
  };
  visit(schema, 0);
}
export function assertValue(schema: JsonSchema, value: unknown, phase = "Action payload"): void {
  assertSize(value);
  if (schema === true) return;
  if (schema === false) invalid(phase);
  let validator = valueValidators.get(schema);
  if (!validator) {
    assertSafeSchema(schema);
    try { validator = compile(schema); } catch { invalid("Action schema"); }
    valueValidators.set(schema, validator);
  }
  if (!validator(value)) invalid(phase);
}
export function assertActionRequest(value: unknown): asserts value is ActionRequest {
  assertSize(value); if (!requestValidator(value)) invalid("Action request");
}
export function assertDescriptor(value: unknown): asserts value is ActionDescriptor {
  if (!descriptorValidator(value)) invalid("Action declaration");
  const descriptor = value as unknown as ActionDescriptor;
  assertSafeSchema(descriptor.input_schema); assertSafeSchema(descriptor.output_schema);
}
export function assertResult(value: unknown): asserts value is ActionResult {
  assertSize(value); if (!resultValidator(value)) invalid("Action result");
}
export function assertSurface(value: unknown): void {
  assertSize(value, 512 * 1024); if (!surfaceValidator(value)) invalid("UI declaration");
}
