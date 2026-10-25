interface ImportMeta {
  readonly env: {
    readonly [key: string]: string | undefined;
    readonly VITE_PROPRIUM_GATEWAY_URL?: string;
    readonly VITE_PROPRIUM_PLUGIN_REGISTRY_URL?: string;
    readonly VITE_PROPRIUM_PLUGIN_REGISTRY_KEY?: string;
    readonly VITE_PROPRIUM_PLUGIN_ARTIFACT_ORIGINS?: string;
    readonly VITE_PROPRIUM_E2E?: string;
  };
}
