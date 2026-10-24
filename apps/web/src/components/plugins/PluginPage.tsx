import type { EnvironmentId } from "@t3tools/contracts";
import { findPluginView } from "@t3tools/client-runtime/plugins";
import { Link } from "@tanstack/react-router";

import { isElectron } from "../../env";
import { useEnvironment } from "../../state/environments";
import { usePluginCatalogue } from "../../state/plugins";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { PluginPageView } from "./PluginViewHost";

export function PluginPage(props: {
  readonly environmentId: EnvironmentId;
  readonly installationId: string;
  readonly viewId: string;
}) {
  const environment = useEnvironment(props.environmentId);
  const catalogue = usePluginCatalogue(props.environmentId);
  const entry = findPluginView(catalogue.installations, props.installationId, props.viewId);
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Plugin breadcrumb">
            <WorkspaceBreadcrumbItem>
              <Link
                to="/settings/plugins"
                search={{
                  environmentId: props.environmentId,
                  installationId: props.installationId,
                }}
              >
                <WorkspaceBreadcrumbText>Plugins</WorkspaceBreadcrumbText>
              </Link>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbText>
                {entry?.installation.manifest.name ?? "Plugin"}
              </WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
            <WorkspaceBreadcrumbItem current className="min-w-10 shrink">
              <h1 className="min-w-0">
                <WorkspaceBreadcrumbText>
                  {entry?.view.title ?? props.viewId}
                </WorkspaceBreadcrumbText>
              </h1>
            </WorkspaceBreadcrumbItem>
            {environment ? (
              <WorkspaceBreadcrumbItem className="min-w-10 shrink">
                <WorkspaceBreadcrumbText className="text-xs text-muted-foreground">
                  {environment.label}
                </WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbItem>
            ) : null}
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1">
          <PluginPageView
            environmentId={props.environmentId}
            installationId={props.installationId}
            viewId={props.viewId}
          />
        </div>
      </div>
    </SidebarInset>
  );
}
