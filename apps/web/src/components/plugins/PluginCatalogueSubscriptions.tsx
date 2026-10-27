import {
  pluginRunnableInstallations,
  pluginSidebarTreeOptions,
  pluginSidebarViewOptions,
  pluginTreeOwnerGrants,
  type PluginSidebarViewSource,
} from "@t3tools/client-runtime/plugins";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useConnectedEnvironmentIds } from "../../state/environments";
import { usePluginCatalogue } from "../../state/plugins";
import { useSidebarViewSourceStore } from "../sidebar/sidebarView";

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

function PluginSidebarViewSource(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const catalogue = usePluginCatalogue(environmentId);
  const report = useSidebarViewSourceStore((state) => state.report);
  const source: PluginSidebarViewSource =
    catalogue.availability === "unknown" ||
    catalogue.availability === "disconnected" ||
    (catalogue.availability === "available" && !catalogue.loaded && catalogue.error === null)
      ? { status: "pending" }
      : {
          status: "ready",
          options: [
            ...pluginSidebarViewOptions(environmentId, pluginRunnableInstallations(catalogue)),
            ...pluginSidebarTreeOptions(environmentId, pluginRunnableInstallations(catalogue)),
          ],
          owners: pluginTreeOwnerGrants(pluginRunnableInstallations(catalogue)),
        };
  useEffect(() => {
    report(environmentId, source);
  }, [environmentId, report, source]);
  useEffect(() => () => report(environmentId, null), [environmentId, report]);
  return null;
}

/**
 * Reports which sidebar views each connected environment's plugins offer. Mounted by the app
 * layout on every route, including Settings, so disabling a plugin there falls back at once.
 */
export function PluginSidebarViewSources() {
  const environmentIds = useConnectedEnvironmentIds();
  return environmentIds.map((environmentId) => (
    <PluginSidebarViewSource key={environmentId} environmentId={environmentId} />
  ));
}
