import {
  addProjectToPluginTree,
  pluginTreeCreateTarget,
  type PluginSidebarTreeOption,
} from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { ensureLocalApi } from "../../localApi";
import { readProject } from "../../state/entities";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { pluginEnvironment, readRunnablePluginInstallations } from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { pluginFailureMessage, usePluginActionRunner } from "../plugins/usePluginActions";
import { SidebarMenuButton } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { useSidebarViewSourceStore } from "./sidebarView";

/**
 * A plugin tree's "new" row: the person picks an existing project or adds a folder, grants the
 * plugin that project if it lacks it, and the tree's declared action runs with only its id.
 * Shown while some connected environment's installation offers it.
 */
export function PluginTreeCreate(props: { readonly choice: PluginSidebarTreeOption }) {
  const { choice } = props;
  const create = choice.tree.create;
  const router = useRouter();
  const environmentIds = useConnectedEnvironmentIds();
  const offered = useSidebarViewSourceStore((state) => state.sources);
  const offeredBy = environmentIds.filter((environmentId) => {
    const source = offered.get(environmentId);
    return source?.status === "ready" && source.createKeys?.includes(choice.key);
  });
  const grantProject = useAtomCommand(pluginEnvironment.grantProject, { reportFailure: false });
  const runAction = usePluginActionRunner();
  const [running, setRunning] = useState(false);
  if (create === undefined || offeredBy.length === 0) return null;

  const addProject = async (projectRef: ScopedProjectRef) => {
    const { environmentId, projectId } = projectRef;
    // The palette may have stayed open while the plugin changed; read it again for the target.
    const target = pluginTreeCreateTarget(readRunnablePluginInstallations(environmentId), choice);
    if (target === null) {
      toastManager.add({
        type: "error",
        title: `${choice.pluginName} is not available there`,
        description: "It no longer offers this on that project's environment.",
      });
      return;
    }
    const name = target.installation.manifest.name;
    const projectTitle = readProject(projectRef)?.title ?? "this project";
    const locationKey = router.state.location.pathname;
    setRunning(true);
    await addProjectToPluginTree({
      target,
      choice,
      projectId,
      confirmGrant: () =>
        ensureLocalApi().dialogs.confirm(
          [
            `Give ${name} access to "${projectTitle}"?`,
            "It can use this project with the permissions you already gave it.",
          ].join("\n"),
        ),
      grantProject: async (input) => {
        const result = await grantProject({ environmentId, input });
        if (result._tag === "Success") return result.value;
        if (isAtomCommandInterrupted(result)) return null;
        toastManager.add({
          type: "error",
          title: `Unable to give ${name} access`,
          description: pluginFailureMessage(squashAtomCommandFailure(result)),
        });
        return null;
      },
      run: (installation, action, context) =>
        runAction(
          // A project action never acts on whichever thread happens to be open.
          { environmentId, installation, threadRef: null, composerTarget: null, locationKey },
          action,
          context,
        ),
    }).finally(() => setRunning(false));
  };

  return (
    <>
      <SidebarMenuButton
        size="sm"
        disabled={running}
        onClick={() =>
          openCommandPalette({
            chooseProject: {
              environmentIds: [...offeredBy],
              choose: (projectRef) => void addProject(projectRef),
            },
          })
        }
      >
        <PlusIcon className="size-3.5" />
        <span>{create.title}</span>
      </SidebarMenuButton>
    </>
  );
}
