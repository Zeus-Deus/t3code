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
import { useState } from "react";

import { pluginEnvironment } from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { PluginEventBacklogDialog } from "./PluginRecoveryDialogs";
import { pluginFailureMessage } from "./usePluginActions";

type BacklogOutcome =
  | { readonly proceed: false }
  | { readonly proceed: true; readonly eventBacklog?: PluginEventBacklogPolicy };

interface BacklogPrompt {
  readonly name: string;
  readonly count: number;
  readonly throughSequence: number;
  readonly settle: (choice: PluginEventBacklogPolicy | null) => void;
}

/**
 * Before a plugin starts observing again, asks the server what it missed. Missed runs are
 * delivered or skipped only by the user's explicit choice; servers without recovery are not asked.
 */
export function usePluginEventBacklog() {
  const backlog = useAtomCommand(pluginEnvironment.backlog, { reportFailure: false });
  const [prompt, setPrompt] = useState<BacklogPrompt | null>(null);
  const resolveBacklog = async (
    environmentId: EnvironmentId,
    installation: PluginInstallation,
    recoverySupported: boolean,
  ): Promise<BacklogOutcome> => {
    if (!recoverySupported) return { proceed: true };
    const result = await backlog({
      environmentId,
      input: { installationId: installation.installationId },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: `Could not check what ${installation.manifest.name} missed`,
          description: pluginFailureMessage(squashAtomCommandFailure(result)),
        });
      }
      return { proceed: false };
    }
    const decision = pluginBacklogDecision(result.value);
    if (decision.kind === "none") return { proceed: true };
    if (decision.kind === "resolved") return { proceed: true, eventBacklog: decision.eventBacklog };
    const choice = await new Promise<PluginEventBacklogPolicy | null>((settle) =>
      setPrompt({
        name: installation.manifest.name,
        count: decision.count,
        throughSequence: decision.throughSequence,
        settle,
      }),
    );
    return choice === null ? { proceed: false } : { proceed: true, eventBacklog: choice };
  };
  const finish = (choice: PluginEventBacklogPolicy | null) => {
    prompt?.settle(choice);
    setPrompt(null);
  };
  const backlogDialog = prompt ? (
    <PluginEventBacklogDialog
      name={prompt.name}
      count={prompt.count}
      throughSequence={prompt.throughSequence}
      onChoose={finish}
      onClose={() => finish(null)}
    />
  ) : null;
  return { resolveBacklog, backlogDialog };
}
