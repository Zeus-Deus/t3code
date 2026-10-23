import { pluginBacklogDecision } from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PluginEventBacklogPolicy,
  PluginInstallation,
} from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { pluginEnvironment } from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { pluginFailureMessage } from "./usePluginActions";

type BacklogOutcome =
  | { readonly proceed: false }
  | { readonly proceed: true; readonly eventBacklog?: PluginEventBacklogPolicy };

/**
 * Before a plugin observes again, asks the server what it missed and lets the user deliver or
 * skip those runs. Servers without recovery support are not asked.
 */
export function usePluginEventBacklog() {
  const backlog = useAtomCommand(pluginEnvironment.backlog, { reportFailure: false });
  return async (
    environmentId: EnvironmentId,
    installation: PluginInstallation,
    recoverySupported: boolean,
  ): Promise<BacklogOutcome> => {
    if (!recoverySupported) return { proceed: true };
    const { name } = installation.manifest;
    const result = await backlog({
      environmentId,
      input: { installationId: installation.installationId },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        Dialog.alert(
          `Could not check what ${name} missed`,
          pluginFailureMessage(squashAtomCommandFailure(result)),
        );
      }
      return { proceed: false };
    }
    const decision = pluginBacklogDecision(result.value);
    if (decision.kind === "none") return { proceed: true };
    if (decision.kind === "resolved") return { proceed: true, eventBacklog: decision.eventBacklog };
    const runs = decision.count === 1 ? "1 run" : `${decision.count} runs`;
    const choice = await new Promise<PluginEventBacklogPolicy["policy"] | null>((settle) =>
      Dialog.alert(
        `${name} missed ${runs}`,
        `${runs} finished in your selected projects while ${name} wasn't receiving events. Delivering them lets it act on each one now, which may send messages or start work. Skipping starts it from new runs only.`,
        [
          { text: "Cancel", style: "cancel", onPress: () => settle(null) },
          { text: "Skip missed runs", onPress: () => settle("skip") },
          { text: `Deliver ${runs}`, onPress: () => settle("deliver") },
        ],
        { cancelable: true, onDismiss: () => settle(null) },
      ),
    );
    return choice === null
      ? { proceed: false }
      : {
          proceed: true,
          eventBacklog: { policy: choice, throughSequence: decision.throughSequence },
        };
  };
}
