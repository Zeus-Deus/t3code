import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";

import { PluginsSettings } from "../components/settings/PluginsSettings";

function SettingsPluginsRoute() {
  return <PluginsSettings target={Route.useSearch()} />;
}

export const Route = createFileRoute("/_chat/settings/plugins")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.installationId === "string" && raw.installationId.trim()
      ? { installationId: raw.installationId }
      : {}),
  }),
  component: SettingsPluginsRoute,
});
