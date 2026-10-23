import type { EnvironmentId } from "@t3tools/contracts";

import { useConnectedEnvironmentIds } from "../../state/environments";
import { usePluginCatalogue } from "../../state/plugins";

function PluginCatalogueSubscription(props: { readonly environmentId: EnvironmentId }) {
  usePluginCatalogue(props.environmentId);
  return null;
}

/**
 * Keeps each connected environment's plugin catalogue live while the chat layout is open, so
 * menus built inside event handlers (the sidebar's thread menu) read current actions.
 * Environments without plugin support are never asked.
 */
export function PluginCatalogueSubscriptions() {
  const environmentIds = useConnectedEnvironmentIds();
  return environmentIds.map((environmentId) => (
    <PluginCatalogueSubscription key={environmentId} environmentId={environmentId} />
  ));
}
