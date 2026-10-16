import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./deny-lindera-loader.mjs", import.meta.url), import.meta.url);

const nlp = await import("../../../nlp/dist/index.js");
const diagnostics = await import("../../dist/index.js");
assert.equal(typeof nlp.createModule, "function");
assert.equal(typeof diagnostics.createModule, "function");
await nlp.createModule({});
await diagnostics.createModule({});
