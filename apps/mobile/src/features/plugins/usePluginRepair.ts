import { StackActions, useNavigation } from "@react-navigation/native";
import { openPluginRepairDraft } from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import { ProjectId, type EnvironmentId, type PluginInstallation } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { uuidv4 } from "../../lib/uuid";
import { useProjects, waitForProject } from "../../state/entities";
import { pluginEnvironment } from "../../state/plugins";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  createNewTaskDraft,
  setComposerDraftText,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { pluginFailureMessage } from "./usePluginActions";

/**
 * Repair with agent, as on web: the server copies the running files into a folder under T3 home,
 * and this opens an unsent new-task draft there with the redacted diagnostics.
 */
export function usePluginRepair() {
  const navigation = useNavigation();
  const projects = useProjects();
  const prepareRepair = useAtomCommand(pluginEnvironment.prepareRepair, { reportFailure: false });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  return async (environmentId: EnvironmentId, installation: PluginInstallation) => {
    const { name } = installation.manifest;
    const prepared = await prepareRepair({
      environmentId,
      input: { installationId: installation.installationId },
    });
    if (prepared._tag === "Failure") {
      if (!isAtomCommandInterrupted(prepared)) {
        Dialog.alert(
          `Could not prepare ${name} for repair`,
          pluginFailureMessage(squashAtomCommandFailure(prepared)),
        );
      }
      return;
    }
    const opened = await openPluginRepairDraft(environmentId, prepared.value, {
      findProject: (target, directory) =>
        findProjectByPath(
          projects.filter((project) => project.environmentId === target),
          directory,
        )?.id ?? null,
      createProject: async (target, directory) => {
        const projectId = ProjectId.make(uuidv4());
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
        if ((await waitForProject(projectRef)) === null) {
          throw new Error("The project did not appear in time.");
        }
      },
      openDraft: async (projectRef) => {
        await waitForComposerDraftsLoaded();
        const draftKey = createNewTaskDraft(projectRef);
        // The agent must edit the folder itself; a worktree would hide its changes from staging.
        updateComposerDraftSettings(draftKey, {
          workspaceSelection: { mode: "local", branch: null, worktreePath: null },
        });
        return draftKey;
      },
      setDraftText: setComposerDraftText,
    });
    if (!opened.ok) {
      Dialog.alert(
        opened.step === "project"
          ? `Could not add the ${name} repair folder as a project`
          : `Could not open a draft for ${name}`,
        `${opened.cause === null ? "" : `${pluginFailureMessage(opened.cause)} `}The files are in ${opened.directory}.`,
      );
      return;
    }
    navigation.dispatch(
      StackActions.push("Thread", { draft: { draftId: opened.draft, title: `${name} repair` } }),
    );
  };
}
