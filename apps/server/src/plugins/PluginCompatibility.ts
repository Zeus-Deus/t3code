import { PLUGIN_API_VERSION, pluginCompatibility } from "@t3tools/contracts";

const supportedApiVersions = new Set<number>([PLUGIN_API_VERSION]);

export function pluginCompatibilityForHost(manifest: {
  readonly apiVersion: number;
  readonly capabilities: ReadonlyArray<string>;
}) {
  const compatibility = pluginCompatibility(manifest);
  return {
    ...compatibility,
    available: supportedApiVersions.has(manifest.apiVersion) && compatibility.available,
  };
}
