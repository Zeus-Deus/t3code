import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { PluginPage } from "../components/plugins/PluginPage";

function PluginPageRoute() {
  const { environmentId, installationId, viewId } = Route.useParams();
  return (
    <PluginPage
      key={`${environmentId}:${installationId}:${viewId}`}
      environmentId={EnvironmentId.make(environmentId)}
      installationId={installationId}
      viewId={viewId}
    />
  );
}

export const Route = createFileRoute("/_chat/plugins/$environmentId/$installationId/$viewId")({
  component: PluginPageRoute,
});
