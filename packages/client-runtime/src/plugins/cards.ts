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
  /** The environment serves card views at all. */
  readonly supported: boolean;
  /** Null until the environment's plugins are known. */
  readonly installations: ReadonlyArray<PluginInstallation> | null;
  readonly executionDisabled: boolean;
}): PluginCardPresentation {
  const installation =
    input.installations?.find((entry) => entry.installationId === input.card.installationId) ??
    null;
  const summary = (reason: string | null): PluginCardPresentation => ({
    kind: "summary",
    pluginName: installation?.manifest.name ?? null,
    reason,
  });
  if (!input.supported) return summary("This environment's T3 Code cannot show plugin cards.");
  if (input.installations === null) return summary(null);
  if (installation === null)
    return summary("The plugin that made this card is not installed here.");
  if (input.executionDisabled) return summary("Plugin code is turned off on this environment.");
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
