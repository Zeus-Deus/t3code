import type {
  PluginSidebarTreeOption,
  PluginTreeProjectAction,
} from "@t3tools/client-runtime/plugins";
import type { EnvironmentId, PluginCapability } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { usePluginActionRunner } from "../plugins/usePluginActions";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usePluginTreeInstallation } from "./pluginTreeSources";

const TREE_ACTIONS_CAPABILITY: PluginCapability = "ui.native-tree-actions";

/**
 * One button per action a tree's project nodes offer. A heading merged across environments keeps
 * each environment's action and names the environment, so a click never picks one arbitrarily.
 */
export function PluginTreeProjectActions(props: {
  readonly choice: PluginSidebarTreeOption;
  readonly actions: ReadonlyArray<PluginTreeProjectAction>;
  readonly projectName: string;
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
}) {
  const named = new Set(props.actions.map((action) => action.environmentId)).size > 1;
  return props.actions.map((action) => (
    <PluginTreeProjectActionButton
      key={`${action.environmentId}\0${action.projectId}\0${action.actionId}`}
      choice={props.choice}
      action={action}
      projectName={props.projectName}
      environmentLabel={
        named ? (props.environmentLabels.get(action.environmentId) ?? action.environmentId) : null
      }
    />
  ));
}

function PluginTreeProjectActionButton(props: {
  readonly choice: PluginSidebarTreeOption;
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
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={label}
            disabled={running}
            onClick={run}
          />
        }
      >
        <PlusIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {`${declared.title} · ${installation.manifest.name}${where}`}
      </TooltipPopup>
    </Tooltip>
  );
}
