import type { ActionDescriptor, SurfaceDeclaration } from '../app/src/browser/proprium/authoring/types.js';

/** The producer validates these declarations against the Host's runtime schemas. */
export function assertAuthoringDeclarations(
  pluginId: string,
  capabilities: readonly string[],
  actions: readonly ActionDescriptor[],
  surfaces: readonly SurfaceDeclaration[],
): Promise<void>;
