import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { Menu } from "../../components/ui/Menu";
import { appAtomRegistry } from "../../state/atom-registry";
import { pluginPlacementEntriesAtom } from "../../state/plugins";
import { environmentThreadShells } from "../../state/threads";
import { usePluginActionRunner } from "./usePluginActions";

/** The contract bounds action context text; a longer message is offered as unavailable. */
const MAX_SELECTION_LENGTH = 64_000;

/**
 * Mobile has no custom text-selection menu, so a long press on an assistant message's copy button
 * offers the plugins' text actions on that whole message, plus the thread's plugin actions.
 */
export function AssistantMessagePluginMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly text: string;
  readonly children: ReactNode;
}) {
  const textEntries = useAtomValue(
    pluginPlacementEntriesAtom(props.environmentId, "message-selection"),
  );
  const threadEntries = useAtomValue(
    pluginPlacementEntriesAtom(props.environmentId, "thread-menu"),
  );
  const runAction = usePluginActionRunner();
  if (textEntries.length === 0 && threadEntries.length === 0) return props.children;
  const tooLong = props.text.length > MAX_SELECTION_LENGTH;
  const entryId = (kind: string, installationId: string, actionId: string) =>
    `${kind}:${installationId}:${actionId}`;
  const actions: MenuAction[] = [
    ...textEntries.map((entry): MenuAction => ({
      id: entryId("text", entry.installation.installationId, entry.action.id),
      title: entry.action.title,
      subtitle: tooLong ? "Message is too long" : entry.installation.manifest.name,
      image: "puzzlepiece.extension",
      attributes: { disabled: tooLong },
    })),
    ...threadEntries.map((entry): MenuAction => ({
      id: entryId("thread", entry.installation.installationId, entry.action.id),
      title: entry.action.title,
      subtitle: entry.installation.manifest.name,
      image: "puzzlepiece.extension",
    })),
  ];
  return (
    <Menu
      title="Plugins"
      actions={actions}
      shouldOpenOnLongPress
      onPressAction={({ nativeEvent }) => {
        const [kind, installationId, actionId] = nativeEvent.event.split(":");
        const entry = (kind === "text" ? textEntries : threadEntries).find(
          (candidate) =>
            candidate.installation.installationId === installationId &&
            candidate.action.id === actionId,
        );
        if (!entry) return;
        // Read on press rather than subscribed: the shell changes on every streamed update.
        const projectId = appAtomRegistry.get(
          environmentThreadShells.threadShellAtom(
            scopeThreadRef(props.environmentId, props.threadId),
          ),
        )?.projectId;
        void runAction(
          {
            environmentId: props.environmentId,
            installation: entry.installation,
            threadId: props.threadId,
          },
          entry.action,
          {
            ...(projectId === undefined ? {} : { projectId }),
            threadId: props.threadId,
            ...(kind === "text" ? { messageId: props.messageId, selection: props.text } : {}),
          },
        );
      }}
    >
      {props.children}
    </Menu>
  );
}
