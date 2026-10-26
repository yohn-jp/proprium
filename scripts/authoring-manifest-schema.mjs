let schemaModule;

/** Load the same validators used by browser admission. */
async function canonicalSchema() {
  if (!schemaModule) {
    const { register } = await import("tsx/esm/api");
    register();
    schemaModule = await import("../app/src/browser/proprium/authoring/schema.ts");
  }
  return schemaModule;
}

export async function assertAuthoringDeclarations(pluginId, capabilities, actions, surfaces) {
  const { assertDescriptor, assertSurface } = await canonicalSchema();
  const actionIds = new Set();
  for (const action of actions) {
    assertDescriptor(action);
    if (action.plugin_id !== pluginId || actionIds.has(action.action_id) ||
        action.required_capabilities.some(capability => !capabilities.includes(capability))) {
      throw new Error(`${pluginId} action identity, uniqueness or capability declaration is invalid`);
    }
    if (action.caller_plugins !== undefined && action.caller_plugins.some(value =>
      typeof value !== "string" || !/^[a-z][a-z0-9-]{0,62}\.[a-z][a-z0-9-]{0,62}$/u.test(value))) {
      throw new Error(`${pluginId} action ${action.action_id} has an invalid caller plugin allowlist`);
    }
    for (const schema of [action.input_schema, action.output_schema]) {
      if (!schema || typeof schema !== "object" || Array.isArray(schema) || schema.type !== "object" || schema.additionalProperties !== false) {
        throw new Error(`${pluginId} action ${action.action_id} schema must be a closed object`);
      }
    }
    actionIds.add(action.action_id);
  }

  const surfaceIds = new Set();
  for (const surface of surfaces) {
    assertSurface(surface);
    if (surfaceIds.has(surface.id)) throw new Error(`${pluginId} repeats UI surface ${surface.id}`);
    surfaceIds.add(surface.id);
    const validateBindings = value => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(validateBindings); return; }
      if (typeof value.action_id === "string" && !actionIds.has(value.action_id)) {
        throw new Error(`${pluginId} UI surface ${surface.id} binds undeclared action ${value.action_id}`);
      }
      Object.values(value).forEach(validateBindings);
    };
    validateBindings(surface);
  }
}
