import type { PluginCardReference, PluginInstallation, PluginView } from "@t3tools/contracts";

import { isPluginActive } from "./model.ts";
import { pluginInactiveReason } from "./recovery.ts";

/**
 * How a conversation card shows here. The summary the agent's tool result recorded is always
 * readable; the plugin's view mounts only when this environment and plugin can serve it now. The
 * server still checks that the card's data belongs to the installation before serving the view:
 * matching ids here only decide whether to ask.
 */
export type PluginCardPresentation =
  | {
      readonly kind: "live";
      readonly installation: PluginInstallation;
      readonly view: PluginView;
    }
  | {
      readonly kind: "summary";
      /** The plugin's current name, when this environment still has it. */
      readonly pluginName: string | null;
      /** Why the card is only a summary; null while the plugin list is still loading. */
      readonly reason: string | null;
    };

export function resolvePluginCardPresentation(input: {
  readonly card: PluginCardReference;
  /** The environment serves card views at all; null until its capabilities are known. */
  readonly supported: boolean | null;
  /**
   * The environment's whole catalogue, null until known. Not the runnable subset: safe mode empties
   * that, and the card would then claim its plugin is gone.
   */
  readonly installations: ReadonlyArray<PluginInstallation> | null;
  readonly executionDisabled: boolean;
}): PluginCardPresentation {
  // A same-source reinstall gets a new installation id but keeps the card's data. Only the
  // server's explicit owner says so; a shared plugin id, source or path never does.
  const installation =
    input.installations?.find((entry) => entry.installationId === input.card.installationId) ??
    input.installations?.find(
      (entry) => entry.dataOwner !== undefined && entry.dataOwner === input.card.dataOwner,
    ) ??
    null;
  const summary = (reason: string | null): PluginCardPresentation => ({
    kind: "summary",
    pluginName: installation?.manifest.name ?? null,
    reason,
  });
  if (input.supported === null) return summary(null);
  // Before the catalogue: an environment without plugin cards may never list one.
  if (!input.supported) return summary("This environment's T3 Code cannot show plugin cards.");
  if (input.installations === null) return summary(null);
  // Before the lookup: safe mode is the reason even where a list of runnable plugins is empty.
  if (input.executionDisabled) return summary("Plugin code is turned off on this environment.");
  if (installation === null) {
    // Not "removed": the catalogue may be filtered, or come from a server without owner metadata.
    return summary("This card’s original installation is unavailable here.");
  }
  if (!isPluginActive(installation)) {
    return summary(pluginInactiveReason(installation) ?? "The plugin is not running.");
  }
  if (
    !installation.grants.capabilities.includes("ui") ||
    !installation.grants.capabilities.includes("ui.conversation-cards")
  ) {
    return summary("The plugin is not allowed to show cards.");
  }
  const view = installation.manifest.views.find((entry) => entry.id === input.card.viewId);
  if (view === undefined || view.placement !== "conversation") {
    return summary("This version of the plugin no longer shows this card.");
  }
  return { kind: "live", installation, view };
}
