import { openPluginRepairDraft } from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PluginInstallation } from "@t3tools/contracts";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import { newProjectId } from "../../lib/utils";
import { readProjects, waitForProject } from "../../state/entities";
import { pluginEnvironment } from "../../state/plugins";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { pluginFailureMessage } from "./usePluginActions";

/**
 * Repair with agent: the server copies the exact running files into a folder under T3 home, and
 * this opens an ordinary draft there holding its redacted diagnostics. Nothing is sent, enabled,
 * or installed; the user chooses the agent and stages the fix later.
 */
export function usePluginRepair() {
  const prepareRepair = useAtomCommand(pluginEnvironment.prepareRepair, { reportFailure: false });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const openThread = useNewThreadHandler();
  return async (environmentId: EnvironmentId, installation: PluginInstallation) => {
    const { name } = installation.manifest;
    const prepared = await prepareRepair({
      environmentId,
      input: { installationId: installation.installationId },
    });
    if (prepared._tag === "Failure") {
      if (!isAtomCommandInterrupted(prepared)) {
        toastManager.add({
          type: "error",
          title: `Could not prepare ${name} for repair`,
          description: pluginFailureMessage(squashAtomCommandFailure(prepared)),
        });
      }
      return;
    }
    const opened = await openPluginRepairDraft(environmentId, prepared.value, {
      findProject: (target, directory) =>
        findProjectByPath(
          readProjects().filter((project) => project.environmentId === target),
          directory,
        )?.id ?? null,
      createProject: async (target, directory) => {
        const projectId = newProjectId();
        const result = await createProject({
          environmentId: target,
          input: {
            projectId,
            // The folder is named by an opaque workspace id.
            title: `${name} repair`,
            workspaceRoot: directory,
            createWorkspaceRootIfMissing: false,
            defaultModelSelection: null,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return projectId;
      },
      waitForProject: async (projectRef) => {
        await waitForProject(projectRef);
      },
      // The agent must edit the folder itself; a worktree would hide its changes from staging.
      openDraft: async (projectRef) =>
        (await openThread(projectRef, { envMode: "local", branch: null, worktreePath: null }))
          ?.draftId ?? null,
      setDraftText: (draftId, text) => useComposerDraftStore.getState().setPrompt(draftId, text),
    });
    if (!opened.ok) {
      toastManager.add({
        type: "error",
        title:
          opened.step === "project"
            ? `Could not add the ${name} repair folder as a project`
            : `Could not open a draft for ${name}`,
        description: `${opened.cause === null ? "" : `${pluginFailureMessage(opened.cause)} `}The files are in ${opened.directory}.`,
      });
    }
  };
}
