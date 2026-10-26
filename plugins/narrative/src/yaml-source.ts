import YAML from "yaml";
import { fail } from "./errors.js";

export type YamlRecord = Record<string, unknown>;

function isRecord(value: unknown): value is YamlRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ParsedYaml = {
  source: string;
  document: YAML.Document.Parsed;
  value: YamlRecord;
  getNode(key: string): YAML.Node | undefined;
};

export function parseYamlRecord(source: string, path: string): ParsedYaml {
  let document: YAML.Document.Parsed;
  try {
    document = YAML.parseDocument(source, { keepSourceTokens: true, version: "1.2" });
  } catch (error) {
    fail("unsupported_format", `Cannot parse YAML metadata at ${path}`, { path, cause: String(error) });
  }
  if (document.errors.length > 0 || !YAML.isMap(document.contents)) {
    fail("unsupported_format", `Expected a valid YAML mapping at ${path}`, {
      path,
      problems: document.errors.map((error) => error.message),
    });
  }
  const converted = document.toJS();
  if (!isRecord(converted)) fail("unsupported_format", `Expected a YAML mapping at ${path}`, { path });
  const map = document.contents;
  return {
    source,
    document,
    value: converted,
    getNode(key) {
      const node = map.get(key, true);
      return YAML.isNode(node) ? node : undefined;
    },
  };
}

export function updateYamlFields(source: string, path: string, updates: Record<string, string | number>): string {
  const parsed = parseYamlRecord(source, path);
  let output = source;
  for (const [key, value] of Object.entries(updates)) {
    const document = YAML.parseDocument(output, { keepSourceTokens: true, version: "1.2" });
    if (document.errors.length || !YAML.isMap(document.contents)) fail("unsupported_format", `Cannot safely edit YAML metadata at ${path}`, { path });
    const node = document.contents.get(key, true);
    if (node === undefined) {
      const eol = output.endsWith("\r\n") ? "\r\n" : output.endsWith("\n") ? "\n" : output.includes("\r\n") ? "\r\n" : "\n";
      const addition = `${key}: ${YAML.stringify(value).trimEnd()}`;
      output += `${output.endsWith("\n") ? "" : eol}${addition}${eol}`;
      continue;
    }
    if (!YAML.isScalar(node) || !node.range) fail("unsupported_format", `Cannot safely replace ${key} in ${path}`, { path, key });
    const start = node.range[0];
    const end = node.range[1];
    document.set(key, value);
    const serialized = document.toString();
    const updated = YAML.parseDocument(serialized, { keepSourceTokens: true, version: "1.2" });
    if (updated.errors.length || !YAML.isMap(updated.contents)) fail("unsupported_format", `YAML edit failed validation at ${path}`, { path, key });
    const next = updated.contents.get(key, true);
    if (!YAML.isScalar(next) || !next.range) fail("unsupported_format", `YAML edit lost ${key} at ${path}`, { path, key });
    output = `${output.slice(0, start)}${serialized.slice(next.range[0], next.range[1])}${output.slice(end)}`;
  }
  const verified = parseYamlRecord(output, path).value;
  for (const [key, value] of Object.entries(updates)) {
    if (verified[key] !== value) fail("unsupported_format", `YAML edit could not be verified at ${path}`, { path, key });
  }
  return output;
}

export function appendYamlSequenceValue(source: string, path: string, key: string, value: YamlRecord, identityKey = "id"): string {
  const parsed = parseYamlRecord(source, path);
  const map = parsed.document.contents;
  if (!YAML.isMap(map)) fail("unsupported_format", `Expected a YAML mapping at ${path}`, { path });
  const current = map.get(key, true);
  let output: string;
  if (current === undefined) {
    const eol = source.endsWith("\r\n") ? "\r\n" : source.endsWith("\n") ? "\n" : source.includes("\r\n") ? "\r\n" : "\n";
    const generated = YAML.stringify({ [key]: [value] }, { lineWidth: 0 });
    const content = generated.slice(generated.indexOf("\n") + 1).replace(/\n$/u, "").replace(/\n/gu, eol);
    output = `${source}${source.endsWith("\n") ? "" : eol}${key}:${eol}${content}${eol}`;
  } else if (YAML.isSeq(current) && !current.flow && current.range) {
    const start = current.range[0];
    const end = current.range[1];
    current.add(value);
    const generated = parsed.document.toString();
    const verifiedDoc = YAML.parseDocument(generated, { keepSourceTokens: true, version: "1.2" });
    const updated = YAML.isMap(verifiedDoc.contents) ? verifiedDoc.contents.get(key, true) : undefined;
    if (!YAML.isSeq(updated) || !updated.range || verifiedDoc.errors.length) fail("unsupported_format", `Cannot safely append ${key} in ${path}`, { path, key });
    const oldSection = source.slice(start, end);
    const newSection = generated.slice(updated.range[0], updated.range[1]);
    if (oldSection.includes("\r\n") && /(?<!\r)\n/u.test(oldSection)) fail("unsupported_format", `Cannot safely preserve mixed line endings in ${key} at ${path}`, { path, key });
    const eol = oldSection.includes("\r\n") ? "\r\n" : "\n";
    const normalized = newSection.replace(/\r?\n/gu, eol);
    output = `${source.slice(0, start)}${normalized}${source.slice(end)}`;
  } else fail("unsupported_format", `${key} must be a safely editable block sequence at ${path}`, { path });
  const verified = parseYamlRecord(output, path).value[key];
  if (!Array.isArray(verified) || !verified.some((row) => isRecord(row) && row[identityKey] === value[identityKey])) {
    fail("unsupported_format", `YAML sequence edit could not be verified at ${path}`, { path, key });
  }
  return output;
}

export function removeYamlSequenceIndex(source: string, path: string, key: string, index: number): string {
  const parsed = parseYamlRecord(source, path);
  const map = parsed.document.contents;
  if (!YAML.isMap(map)) fail("unsupported_format", `Expected a YAML mapping at ${path}`, { path });
  const current = map.get(key, true);
  if (!YAML.isSeq(current) || current.flow || !current.range || index < 0 || index >= current.items.length) {
    fail("unsupported_format", `${key} sequence changed at ${path}`, { path, key });
  }
  const start = current.range[0];
  const end = current.range[1];
  current.items.splice(index, 1);
  const generated = parsed.document.toString();
  const verifiedDoc = YAML.parseDocument(generated, { keepSourceTokens: true, version: "1.2" });
  const updated = YAML.isMap(verifiedDoc.contents) ? verifiedDoc.contents.get(key, true) : undefined;
  if (!YAML.isSeq(updated) || !updated.range || verifiedDoc.errors.length) fail("unsupported_format", `Cannot safely remove ${key} item in ${path}`, { path, key });
  const oldSection = source.slice(start, end);
  if (oldSection.includes("\r\n") && /(?<!\r)\n/u.test(oldSection)) fail("unsupported_format", `Cannot safely preserve mixed line endings in ${key} at ${path}`, { path, key });
  const eol = oldSection.includes("\r\n") ? "\r\n" : "\n";
  const output = `${source.slice(0, start)}${generated.slice(updated.range[0], updated.range[1]).replace(/\r?\n/gu, eol)}${source.slice(end)}`;
  parseYamlRecord(output, path);
  return output;
}

export function updateYamlSequenceMapFields(
  source: string,
  path: string,
  key: string,
  index: number,
  updates: Record<string, string | number | boolean | null>,
): string {
  let output = source;
  for (const [field, value] of Object.entries(updates)) {
    const parsed = parseYamlRecord(output, path);
    const root = parsed.document.contents;
    if (!YAML.isMap(root)) fail("unsupported_format", `Expected a YAML mapping at ${path}`, { path });
    const sequence = root.get(key, true);
    if (!YAML.isSeq(sequence) || sequence.flow || index < 0 || index >= sequence.items.length) {
      fail("unsupported_format", `Cannot safely edit ${key}[${index}] at ${path}`, { path, key, index });
    }
    const item = sequence.items[index];
    if (!YAML.isMap(item)) fail("unsupported_format", `${key}[${index}] must be a YAML mapping at ${path}`, { path, key, index });
    const oldValue = item.get(field, true);
    if (!YAML.isScalar(oldValue) || !oldValue.range) {
      fail("unsupported_format", `Cannot safely replace ${key}[${index}].${field} at ${path}`, { path, key, index, field });
    }
    const start = oldValue.range[0], end = oldValue.range[1];
    item.set(field, value);
    const serialized = parsed.document.toString();
    const updatedDoc = YAML.parseDocument(serialized, { keepSourceTokens: true, version: "1.2" });
    const updatedSequence = YAML.isMap(updatedDoc.contents) ? updatedDoc.contents.get(key, true) : undefined;
    const updatedItem = YAML.isSeq(updatedSequence) ? updatedSequence.items[index] : undefined;
    const updatedValue = YAML.isMap(updatedItem) ? updatedItem.get(field, true) : undefined;
    if (updatedDoc.errors.length || !YAML.isScalar(updatedValue) || !updatedValue.range) {
      fail("unsupported_format", `YAML edit lost ${key}[${index}].${field} at ${path}`, { path, key, index, field });
    }
    output = `${output.slice(0, start)}${serialized.slice(updatedValue.range[0], updatedValue.range[1])}${output.slice(end)}`;
  }
  const verified = parseYamlRecord(output, path).value[key];
  const row = Array.isArray(verified) ? verified[index] : undefined;
  if (!isRecord(row) || Object.entries(updates).some(([field, value]) => row[field] !== value)) {
    fail("unsupported_format", `YAML sequence edit could not be verified at ${path}`, { path, key, index });
  }
  return output;
}
