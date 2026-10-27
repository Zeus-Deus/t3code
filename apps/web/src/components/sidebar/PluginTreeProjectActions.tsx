import type {
  PluginSidebarTreeOption,
  PluginTreeProjectAction,
} from "@t3tools/client-runtime/plugins";
import type { EnvironmentId, PluginCapability } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { usePluginActionRunner } from "../plugins/usePluginActions";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { usePluginTreeInstallation } from "./pluginTreeSources";
import { depthIndent } from "./SidebarProjectView";

const TREE_ACTIONS_CAPABILITY: PluginCapability = "ui.native-tree-actions";

/**
 * One row per action a tree's project nodes offer, under the heading and above its threads. A
 * heading merged across environments keeps each environment's action and names the environment,
 * so a click never picks one arbitrarily.
 */
export function PluginTreeProjectActions(props: {
  readonly choice: PluginSidebarTreeOption;
  readonly actions: ReadonlyArray<PluginTreeProjectAction>;
  readonly projectName: string;
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
  /** Headings above the rows, as for the heading's threads. */
  readonly depth: number;
}) {
  const named = new Set(props.actions.map((action) => action.environmentId)).size > 1;
  return props.actions.map((action) => (
    <PluginTreeProjectActionRow
      key={`${action.environmentId}\0${action.projectId}\0${action.actionId}`}
      choice={props.choice}
      depth={props.depth}
      action={action}
      projectName={props.projectName}
      environmentLabel={
        named ? (props.environmentLabels.get(action.environmentId) ?? action.environmentId) : null
      }
    />
  ));
}

function PluginTreeProjectActionRow(props: {
  readonly choice: PluginSidebarTreeOption;
  readonly depth: number;
  readonly action: PluginTreeProjectAction;
  readonly projectName: string;
  readonly environmentLabel: string | null;
}) {
  const { action, environmentLabel } = props;
  const router = useRouter();
  const runAction = usePluginActionRunner();
  const [running, setRunning] = useState(false);
  // Only the installation that served this snapshot, still runnable and still serving the tree.
  const installation = usePluginTreeInstallation(props.choice, action.environmentId);
  const declared = installation?.manifest.actions.find((entry) => entry.id === action.actionId);
  if (
    installation === null ||
    declared === undefined ||
    !installation.grants.capabilities.includes(TREE_ACTIONS_CAPABILITY)
  ) {
    return null;
  }
  const run = () => {
    setRunning(true);
    void runAction(
      {
        environmentId: action.environmentId,
        installation,
        // A project action never acts on whichever thread happens to be open.
        threadRef: null,
        composerTarget: null,
        locationKey: router.state.location.pathname,
      },
      declared,
      { projectId: action.projectId },
    ).finally(() => setRunning(false));
  };
  const where = environmentLabel === null ? "" : ` on ${environmentLabel}`;
  const label = `${declared.title} in ${props.projectName}${where}`;
  return (
    <li className={cn("list-none", depthIndent(props.depth))} data-thread-selection-safe>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              aria-busy={running || undefined}
              disabled={running}
              onClick={run}
              className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-secondary-label outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring enabled:hover:bg-sidebar-row-hover enabled:hover:text-foreground disabled:cursor-default disabled:opacity-60"
            />
          }
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            <PlusIcon aria-hidden className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate">{declared.title}</span>
          {environmentLabel === null ? null : (
            <span className="shrink-0 truncate text-xs">{environmentLabel}</span>
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">
          {`${declared.title} · ${installation.manifest.name}${where}`}
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}
