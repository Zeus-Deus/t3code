import type { PluginInstallation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isPluginActive } from "./model.ts";

/**
 * A plugin page this device opens instead of the usual landing when the app starts. Kept on the
 * device, never synced: it names a plugin and view, not an installation, so a reinstall keeps it.
 */
export const PluginStartPage = Schema.Struct({
  environmentId: Schema.String,
  pluginId: Schema.String,
  viewId: Schema.String,
});
export type PluginStartPage = typeof PluginStartPage.Type;

export type PluginStartPageResolution =
  | { readonly kind: "pending" }
  | { readonly kind: "core" }
  | { readonly kind: "open"; readonly installationId: string; readonly viewId: string };

/**
 * Where the app starts. It waits only while the environment's first connection or plugin list is
 * still loading; anything missing, failed or not allowed starts the usual way at once, so a
 * broken plugin never stands between the person and their threads.
 */
export function resolvePluginStartPage(input: {
  readonly preference: PluginStartPage | null;
  /** `pending` while the first connection or the plugin list is still loading. */
  readonly environment: "pending" | "ready" | "unavailable";
  /** The environment's runnable installations, once known. */
  readonly installations: ReadonlyArray<PluginInstallation>;
}): PluginStartPageResolution {
  const { preference } = input;
  if (preference === null || input.environment === "unavailable") return { kind: "core" };
  if (input.environment === "pending") return { kind: "pending" };
  const installation = input.installations.find(
    (entry) =>
      entry.manifest.id === preference.pluginId &&
      isPluginActive(entry) &&
      entry.grants.capabilities.includes("ui"),
  );
  const view = installation?.manifest.views.find(
    (entry) => entry.id === preference.viewId && entry.placement === "page",
  );
  return installation === undefined || view === undefined
    ? { kind: "core" }
    : { kind: "open", installationId: installation.installationId, viewId: view.id };
}
