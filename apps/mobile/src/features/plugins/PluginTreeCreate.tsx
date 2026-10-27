import { useAtomValue } from "@effect/atom-react";
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
import { StackActions, useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Pressable } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { pluginEnvironment, pluginRunnableInstallationsAtom } from "../../state/plugins";
import { environmentProjects } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { registerProjectDestination } from "../projects/projectDestination";
import { pluginFailureMessage, usePluginActionRunner } from "./usePluginActions";

const confirm = (title: string, message: string) =>
  new Promise<boolean>((resolve) =>
    Dialog.confirm({
      title,
      message,
      confirmText: "Give access",
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
    }),
  );

/**
 * A plugin tree's "new" row: the person picks an existing project or adds a folder, grants the
 * plugin that project if it lacks it, and the tree's declared action runs with only its id.
 * Shown while some connected environment's installation offers it.
 */
export function PluginTreeCreate(props: { readonly choice: PluginSidebarTreeOption }) {
  const { choice } = props;
  const create = choice.tree.create;
  const navigation = useNavigation();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const installationsAtom = pluginRunnableInstallationsAtom(
    connectedEnvironments.map((environment) => environment.environmentId),
  );
  const installations = useAtomValue(installationsAtom);
  const grantProject = useAtomCommand(pluginEnvironment.grantProject, { reportFailure: false });
  const runAction = usePluginActionRunner();
  const [running, setRunning] = useState(false);
  const offeredBy = [...installations]
    .filter(([, entries]) => pluginTreeCreateTarget(entries, choice) !== null)
    .map(([environmentId]) => environmentId);
  if (create === undefined || offeredBy.length === 0) return null;

  const addProject = async (projectRef: ScopedProjectRef) => {
    const { environmentId, projectId } = projectRef;
    // The chooser may have stayed open while the plugin changed; read it again for the target.
    const target = pluginTreeCreateTarget(
      appAtomRegistry.get(installationsAtom).get(environmentId) ?? [],
      choice,
    );
    if (target === null) {
      Dialog.alert(
        `${choice.pluginName} is not available there`,
        "It no longer offers this on that project's environment.",
      );
      return;
    }
    const name = target.installation.manifest.name;
    const projectTitle =
      appAtomRegistry.get(environmentProjects.projectAtom(projectRef))?.title ?? "this project";
    setRunning(true);
    await addProjectToPluginTree({
      target,
      choice,
      projectId,
      confirmGrant: () =>
        confirm(
          `Give ${name} access to "${projectTitle}"?`,
          "It can use this project with the permissions you already gave it.",
        ),
      grantProject: async (input) => {
        const result = await grantProject({ environmentId, input });
        if (result._tag === "Success") return result.value;
        if (!isAtomCommandInterrupted(result)) {
          Dialog.alert(
            `Unable to give ${name} access`,
            pluginFailureMessage(squashAtomCommandFailure(result)),
          );
        }
        return null;
      },
      // A project action never acts on whichever thread happens to be open.
      run: (installation, action, context) =>
        runAction({ environmentId, installation, threadId: null }, action, context),
    }).finally(() => setRunning(false));
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={create.title}
      accessibilityState={{ disabled: running, busy: running }}
      disabled={running}
      onPress={() =>
        navigation.dispatch(
          StackActions.push("NewTaskProject", {
            projectDestination: registerProjectDestination({
              environmentIds: offeredBy,
              choose: (projectRef) => void addProject(projectRef),
            }),
          }),
        )
      }
      className="flex-row items-center gap-2 px-4 py-2"
    >
      <SymbolView name="plus" size={14} tintColorClassName="accent-icon" type="monochrome" />
      <Text className="text-sm font-t3-bold text-foreground">{create.title}</Text>
    </Pressable>
  );
}
