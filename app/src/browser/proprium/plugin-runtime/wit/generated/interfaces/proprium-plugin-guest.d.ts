/** @module Interface proprium:plugin/guest@1.0.0 **/
export function initialize(context: PluginContext): void;
export function invoke(request: string): string;
export function dispose(): void;
export interface PluginContext {
  pluginId: string,
  version: string,
  workspaceId: string,
}
