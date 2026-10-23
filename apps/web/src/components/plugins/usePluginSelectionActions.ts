import { useAtomValue } from "@effect/atom-react";
import {
  pluginActionEntries,
  pluginRunnableInstallations,
  type PluginActionEntry,
} from "@t3tools/client-runtime/plugins";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import { useThreadShell } from "../../state/entities";
import { pluginEnvironment, usePluginCatalogue } from "../../state/plugins";
import { usePluginActionRunner } from "./usePluginActions";

/** Longest selection a plugin receives; the contract bounds action context text. */
const PLUGIN_SELECTION_MAX_LENGTH = 64_000;

/** Actions placed on selected assistant text in this thread's environment. */
export function usePluginSelectionActions(threadRef: ScopedThreadRef) {
  const catalogue = usePluginCatalogue(threadRef.environmentId);
  const canInvoke = useAtomValue(pluginEnvironment.invoke.permissionAtom(threadRef.environmentId));
  const thread = useThreadShell(threadRef);
  const runAction = usePluginActionRunner();
  const router = useRouter();
  const entries = canInvoke
    ? pluginActionEntries(pluginRunnableInstallations(catalogue), "message-selection")
    : [];
  /** Captures thread, message and text now; the result lands in this thread's composer only. */
  const run = (entry: PluginActionEntry, selection: { messageId: string; text: string }) =>
    runAction(
      {
        environmentId: threadRef.environmentId,
        installation: entry.installation,
        threadRef,
        composerTarget: threadRef,
        locationKey: router.state.location.pathname,
      },
      entry.action,
      {
        ...(thread?.projectId === undefined ? {} : { projectId: thread.projectId }),
        threadId: threadRef.threadId,
        messageId: selection.messageId,
        selection: selection.text.slice(0, PLUGIN_SELECTION_MAX_LENGTH),
      },
    );
  return { entries, run };
}
