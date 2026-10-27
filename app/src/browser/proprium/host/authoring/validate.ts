import type { AuthoringActionBinding, AuthoringDataKey, AuthoringField, AuthoringNavigationTemplate, AuthoringScalarField, AuthoringSurfaceDeclaration, AuthoringTemplate, AuthoringWidget } from "./types.js";

const ID = /^[a-z][a-z0-9._-]{0,63}$/u;
const ACTION_ID = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const DATA_KEY_PART = /^(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9][0-9]{0,2})$/u;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_NODES = 512;
const MAX_SURFACE_DEPTH = 16;
const MAX_TEMPLATE_DEPTH = 12;
const MAX_SURFACE_BYTES = 96 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: Record<string, unknown>, required: readonly string[], allowed: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error(`${label} has missing or unsupported fields.`);
}

function text(value: unknown, label: string, max: number): asserts value is string;
function text(value: unknown, label: string, max: number, optional: true): asserts value is string | undefined;
function text(value: unknown, label: string, max: number, optional = false): asserts value is string | undefined {
  if (optional && value === undefined) return;
  if (typeof value !== "string" || value.length > max || (!optional && !value.trim())) throw new Error(`${label} must be non-empty text of at most ${max} characters.`);
}

function safeJson(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (depth > MAX_SURFACE_DEPTH || ++budget.nodes > MAX_NODES) throw new Error("UI JSON exceeds its nesting or item limit.");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (Array.isArray(value)) { for (const item of value) safeJson(item, depth + 1, budget); return; }
  if (!record(value)) throw new Error("UI JSON contains a non-JSON value.");
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) throw new Error("UI JSON contains an unsafe property name.");
    safeJson(item, depth + 1, budget);
  }
}

function template(value: unknown, depth = 0): asserts value is AuthoringTemplate {
  if (depth > MAX_TEMPLATE_DEPTH) throw new Error("UI data template is too deeply nested.");
  if (record(value) && Object.hasOwn(value, "data_key")) {
    exact(value, ["data_key"], ["data_key"], "UI data reference");
    const path = value.data_key;
    if (typeof path !== "string" || path.length > 512 || !path.split(".").every(part => DATA_KEY_PART.test(part) && !UNSAFE_KEYS.has(part))) {
      throw new Error("UI data reference has an invalid key.");
    }
    return;
  }
  if (Array.isArray(value)) { for (const item of value) template(item, depth + 1); return; }
  if (record(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) throw new Error("UI template has an unsafe property name.");
      template(item, depth + 1);
    }
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  throw new Error("UI template contains a non-JSON value.");
}

function dataKey(value: unknown): asserts value is AuthoringDataKey {
  if (!record(value)) throw new Error("UI condition must be a data-key reference.");
  exact(value, ["data_key"], ["data_key"], "UI data key");
  const path = value.data_key;
  if (typeof path !== "string" || path.length > 512 || !path.split(".").every(part => DATA_KEY_PART.test(part) && !UNSAFE_KEYS.has(part))) throw new Error("UI condition has an invalid data key.");
}

function action(value: unknown): asserts value is AuthoringActionBinding {
  if (!record(value)) throw new Error("UI action binding must be an object.");
  exact(value, ["action_id", "input_template"], ["action_id", "input_template"], "UI action binding");
  if (typeof value.action_id !== "string" || !ACTION_ID.test(value.action_id) || !record(value.input_template)) throw new Error("UI action binding is malformed.");
  for (const item of Object.values(value.input_template)) template(item);
}

function navigation(value: unknown): asserts value is AuthoringNavigationTemplate {
  if (!record(value)) throw new Error("UI navigation binding must be an object.");
  exact(value, ["intent", "target"], ["intent", "target"], "UI navigation binding");
  if (value.intent !== "open" && value.intent !== "reveal") throw new Error("UI navigation intent is unsupported.");
  if (!record(value.target)) throw new Error("UI navigation target must be an object.");
  exact(value.target, [], ["path", "panel_id", "span"], "UI navigation target");
  if (Object.keys(value.target).length === 0) throw new Error("UI navigation target is empty.");
  for (const target of Object.values(value.target)) template(target);
}

function columns(value: unknown): void {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error("UI columns must be bounded and non-empty.");
  for (const item of value) {
    if (!record(item)) throw new Error("UI column must be an object.");
    exact(item, ["key", "label"], ["key", "label"], "UI column");
    if (typeof item.key !== "string" || !item.key.split(".").every(part => DATA_KEY_PART.test(part) && !UNSAFE_KEYS.has(part))) throw new Error("UI column key is invalid.");
    text(item.label, "UI column label", 100);
  }
}

function field(value: unknown, nested = false): asserts value is AuthoringField {
  if (!record(value)) throw new Error("UI form field must be an object.");
  if (typeof value.id !== "string" || !ID.test(value.id)) throw new Error("UI form field ID is invalid.");
  text(value.label, "UI form field label", 100);
  if (typeof value.required !== "undefined" && typeof value.required !== "boolean") throw new Error("UI form required flag must be boolean.");
  for (const key of ["min_length", "max_length"]) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0 || (value[key] as number) > 100_000)) throw new Error(`UI form ${key} is invalid.`);
  }
  text(value.placeholder, "UI form placeholder", 512, true);
  text(value.validation_message, "UI form validation message", 512, true);
  if (value.type === "record-list") {
    if (nested) throw new Error("Nested UI record lists are unsupported.");
    exact(value, ["id", "label", "type", "fields"], ["id", "label", "type", "fields", "required", "initial_value", "key_field", "min_items", "max_items", "validation_message"], "UI record-list field");
    if (!Array.isArray(value.fields) || value.fields.length > 32) throw new Error("UI record-list child fields must be bounded.");
    const childIds = new Set<string>();
    for (const child of value.fields) {
      field(child, true);
      if (child.type === "record-list") throw new Error("Nested UI record lists are unsupported.");
      if (childIds.has(child.id)) throw new Error("UI record-list child field IDs must be unique.");
      childIds.add(child.id);
    }
    if (value.initial_value !== undefined) template(value.initial_value);
    if (value.key_field !== undefined && (typeof value.key_field !== "string" || !value.key_field.split(".").every(part => DATA_KEY_PART.test(part) && !UNSAFE_KEYS.has(part)))) throw new Error("UI record-list key field is invalid.");
    if (value.min_items !== undefined && (!Number.isSafeInteger(value.min_items) || (value.min_items as number) < 0 || (value.min_items as number) > 256)) throw new Error("UI record-list minimum is invalid.");
    if (value.max_items !== undefined && (!Number.isSafeInteger(value.max_items) || (value.max_items as number) < 1 || (value.max_items as number) > 256)) throw new Error("UI record-list maximum is invalid.");
    if ((value.min_items ?? (value.required ? 1 : 0)) > (value.max_items ?? 128)) throw new Error("UI record-list minimum exceeds its maximum.");
    return;
  }
  if (nested && value.type === "record-list") throw new Error("Nested UI record lists are unsupported.");
  if (!["string", "integer", "boolean", "enum", "multi-reference", "ordered-list"].includes(String(value.type))) throw new Error("UI form field type is unsupported.");
  const scalar = value as AuthoringScalarField & Record<string, unknown>;
  exact(scalar, ["id", "label", "type"], ["id", "label", "type", "required", "options", "option_value_key", "option_label_key", "placeholder", "min_length", "max_length", "validation_message", "initial_value"], "UI form field");
  if (scalar.initial_value !== undefined) template(scalar.initial_value);
  if (scalar.type === "enum" || scalar.type === "multi-reference") {
    if (Array.isArray(scalar.options)) {
      if (!scalar.options.length || scalar.options.length > 1000 || scalar.option_value_key !== undefined || scalar.option_label_key !== undefined) throw new Error("UI form options must be bounded and cannot mix literal and data-bound options.");
      const seen = new Set<string>();
      for (const option of scalar.options) {
        if (!record(option)) throw new Error("UI form option must be an object.");
        exact(option, ["value", "label"], ["value", "label"], "UI form option");
        text(option.value, "UI form option value", 256);
        text(option.label, "UI form option label", 100);
        if (seen.has(option.value)) throw new Error("UI form option values must be unique.");
        seen.add(option.value);
      }
    } else {
      if (scalar.options === undefined || !record(scalar.options) || scalar.option_value_key === undefined || scalar.option_label_key === undefined) throw new Error("UI data-bound options require a data key and value/label keys.");
      dataKey(scalar.options);
      for (const key of [scalar.option_value_key, scalar.option_label_key]) {
        if (typeof key !== "string" || !key.split(".").every(part => DATA_KEY_PART.test(part) && !UNSAFE_KEYS.has(part))) throw new Error("UI data-bound option key is invalid.");
      }
    }
  } else if (scalar.options !== undefined || scalar.option_value_key !== undefined || scalar.option_label_key !== undefined) throw new Error("Only enum and multi-reference fields may declare options.");
}

interface WidgetVisit { count: number; ids: Set<string> }
function widget(value: unknown, visit: WidgetVisit, depth = 0): asserts value is AuthoringWidget {
  if (depth > 8 || ++visit.count > MAX_NODES || !record(value)) throw new Error("UI widget tree exceeds its limit or is malformed.");
  if (typeof value.id !== "string" || !ID.test(value.id) || visit.ids.has(value.id)) throw new Error("UI widget IDs must be valid and unique in the surface.");
  visit.ids.add(value.id);
  text(value.title, "UI widget title", 120, true);
  text(value.description, "UI widget description", 1024, true);
  const common = ["id", "type", "title", "description", "load_action", "load_actions"];
  if (value.load_action !== undefined && value.load_actions !== undefined) throw new Error("UI widget may declare either load_action or load_actions, not both.");
  if (value.load_action !== undefined) action(value.load_action);
  if (value.load_actions !== undefined) {
    if (!Array.isArray(value.load_actions) || !value.load_actions.length || value.load_actions.length > 8) throw new Error("UI named load actions must be bounded and non-empty.");
    const keys = new Set<string>();
    for (const item of value.load_actions) {
      if (!record(item)) throw new Error("UI named load action must be an object.");
      exact(item, ["key", "action_id", "input_template"], ["key", "action_id", "input_template"], "UI named load action");
      if (typeof item.key !== "string" || !ID.test(item.key) || keys.has(item.key)) throw new Error("UI named load action keys must be unique and valid.");
      keys.add(item.key);
      const { key: _key, ...binding } = item;
      action(binding);
    }
  }
  switch (value.type) {
    case "outline":
      exact(value, ["id", "type", "items"], [...common, "items", "activate", "next_action", "previous_action", "next_action_when", "previous_action_when"], "UI outline");
      template(value.items);
      for (const key of ["activate", "next_action", "previous_action"]) if (value[key] !== undefined) action(value[key]);
      for (const key of ["next_action_when", "previous_action_when"]) if (value[key] !== undefined) dataKey(value[key]);
      break;
    case "list":
      exact(value, ["id", "type", "items", "primary"], [...common, "items", "primary", "secondary", "item_action", "item_navigation", "next_action", "previous_action", "next_action_when", "previous_action_when"], "UI list");
      template(value.items);
      if (typeof value.primary !== "string" || !value.primary.split(".").every(part => DATA_KEY_PART.test(part) && !UNSAFE_KEYS.has(part))) throw new Error("UI list primary path is invalid.");
      if (value.secondary !== undefined && (typeof value.secondary !== "string" || !value.secondary.split(".").every(part => DATA_KEY_PART.test(part) && !UNSAFE_KEYS.has(part)))) throw new Error("UI list secondary path is invalid.");
      if (value.item_action !== undefined) action(value.item_action);
      if (value.item_navigation !== undefined) navigation(value.item_navigation);
      for (const key of ["next_action", "previous_action"]) if (value[key] !== undefined) action(value[key]);
      for (const key of ["next_action_when", "previous_action_when"]) if (value[key] !== undefined) dataKey(value[key]);
      break;
    case "table":
      exact(value, ["id", "type", "rows", "columns"], [...common, "rows", "columns", "next_action", "previous_action", "next_action_when", "previous_action_when"], "UI table");
      template(value.rows); columns(value.columns);
      for (const key of ["next_action", "previous_action"]) if (value[key] !== undefined) action(value[key]);
      for (const key of ["next_action_when", "previous_action_when"]) if (value[key] !== undefined) dataKey(value[key]);
      break;
    case "detail":
      exact(value, ["id", "type", "value"], [...common, "value", "fields"], "UI detail");
      template(value.value);
      if (value.fields !== undefined) {
        if (!Array.isArray(value.fields) || value.fields.length > 64) throw new Error("UI detail fields must be bounded.");
        for (const item of value.fields) {
          if (!record(item)) throw new Error("UI detail field must be an object.");
          exact(item, ["key", "label"], ["key", "label"], "UI detail field");
          if (typeof item.key !== "string" || !item.key.split(".").every(part => DATA_KEY_PART.test(part) && !UNSAFE_KEYS.has(part))) throw new Error("UI detail path is invalid.");
          text(item.label, "UI detail label", 100);
        }
      }
      break;
    case "form":
      exact(value, ["id", "type", "fields", "submit"], [...common, "fields", "submit", "cancel_action", "confirmation", "submit_when", "unavailable_message"], "UI form");
      if (!Array.isArray(value.fields) || value.fields.length > 32) throw new Error("UI form fields must be bounded.");
      {
        const fieldIds = new Set<string>();
        for (const item of value.fields) {
          field(item);
          if (fieldIds.has(item.id)) throw new Error("UI form field IDs must be unique.");
          fieldIds.add(item.id);
        }
      }
      action(value.submit);
      if (value.cancel_action !== undefined) action(value.cancel_action);
      if (value.submit_when !== undefined) dataKey(value.submit_when);
      text(value.unavailable_message, "UI form unavailable message", 512, true);
      if (value.confirmation !== undefined) {
        if (!record(value.confirmation)) throw new Error("UI form confirmation must be an object.");
        exact(value.confirmation, ["title", "message"], ["title", "message", "continue_label", "cancel_label"], "UI form confirmation");
        text(value.confirmation.title, "UI form confirmation title", 120);
        text(value.confirmation.message, "UI form confirmation message", 1024);
        text(value.confirmation.continue_label, "UI form confirmation continue label", 100, true);
        text(value.confirmation.cancel_label, "UI form confirmation cancel label", 100, true);
      }
      break;
    case "tabs":
      exact(value, ["id", "type", "tabs"], [...common, "tabs"], "UI tabs");
      if (!Array.isArray(value.tabs) || !value.tabs.length || value.tabs.length > 16) throw new Error("UI tabs must be bounded and non-empty.");
      for (const tab of value.tabs) {
        if (!record(tab)) throw new Error("UI tab must be an object.");
        exact(tab, ["id", "title", "body"], ["id", "title", "body"], "UI tab");
        if (typeof tab.id !== "string" || !ID.test(tab.id) || visit.ids.has(tab.id)) throw new Error("UI tab IDs must be valid and unique in the surface.");
        visit.ids.add(tab.id); text(tab.title, "UI tab title", 120); widget(tab.body, visit, depth + 1);
      }
      break;
    case "status":
      exact(value, ["id", "type", "state"], [...common, "state", "messages"], "UI status");
      template(value.state);
      if (value.messages !== undefined) {
        if (!record(value.messages) || Object.keys(value.messages).length > 32) throw new Error("UI status messages must be bounded.");
        for (const message of Object.values(value.messages)) text(message, "UI status message", 512);
      }
      break;
    case "progress":
      exact(value, ["id", "type", "value"], [...common, "value", "maximum", "label"], "UI progress");
      template(value.value);
      if (value.maximum !== undefined && (typeof value.maximum !== "number" || !Number.isFinite(value.maximum) || value.maximum <= 0 || value.maximum > 1_000_000_000)) throw new Error("UI progress maximum is invalid.");
      text(value.label, "UI progress label", 100, true);
      break;
    case "evidence":
      exact(value, ["id", "type", "items"], [...common, "items", "open_action", "open_navigation"], "UI evidence");
      template(value.items);
      if (value.open_action !== undefined) action(value.open_action);
      if (value.open_navigation !== undefined) navigation(value.open_navigation);
      break;
    case "diff":
      exact(value, ["id", "type", "files"], [...common, "files"], "UI diff");
      template(value.files);
      break;
    case "graph": case "map": case "timeline":
      exact(value, ["id", "type", "entities"], [...common, "entities", "edges", "columns"], `UI ${value.type}`);
      template(value.entities);
      if (value.edges !== undefined) template(value.edges);
      if (value.columns !== undefined) columns(value.columns);
      break;
    default: throw new Error("UI widget type is unsupported.");
  }
}

/** Validate the signed manifest's declarative panel before handing it to React. */
export function validateAuthoringSurfaceDeclaration(value: unknown): AuthoringSurfaceDeclaration {
  safeJson(value);
  if (!record(value)) throw new Error("UI surface must be an object.");
  exact(value, ["id", "kind", "title", "context", "body"], ["id", "kind", "title", "context", "body"], "UI surface");
  if (typeof value.id !== "string" || !ID.test(value.id) || (value.kind !== "panel" && value.kind !== "command")) throw new Error("UI surface ID or kind is unsupported.");
  text(value.title, "UI surface title", 120);
  if (!record(value.context)) throw new Error("UI surface context must be an object.");
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_SURFACE_BYTES) throw new Error("UI surface exceeds its size limit.");
  const visit: WidgetVisit = { count: 0, ids: new Set([value.id]) };
  widget(value.body, visit);
  return value as unknown as AuthoringSurfaceDeclaration;
}
