import type { PluginInstallation, ProjectId } from "@t3tools/contracts";

export function pluginInstallationFixture(
  overrides: Partial<PluginInstallation> = {},
): PluginInstallation {
  const digest = "a".repeat(64);
  return {
    installationId: "inst-1",
    generation: "gen-1",
    manifest: {
      id: "acme.quote-helper",
      name: "Quote helper",
      version: "1.0.0",
      apiVersion: 1,
      entry: "plugin.mjs",
      capabilities: ["settings", "ui"],
      actions: [
        { id: "quote", title: "Quote selection", placements: ["message-selection", "palette"] },
        { id: "menu-only", title: "Menu only", placements: ["thread-menu"] },
      ],
      views: [{ id: "board", title: "Board", entry: "view.html", placement: "page" }],
      settings: [
        { key: "prefix", label: "Prefix", type: "string", default: ">" },
        { key: "limit", label: "Limit", type: "number", default: 3 },
        { key: "loud", label: "Loud", type: "boolean" },
        { key: "token", label: "Token", type: "secret" },
      ],
    },
    source: { kind: "local", directory: "/plugins/quote-helper" },
    digest,
    enabled: true,
    consentedDigest: digest,
    status: "idle",
    error: null,
    settings: {},
    grants: { capabilities: ["settings", "ui"], projectIds: [] as ProjectId[] },
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...overrides,
  };
}
