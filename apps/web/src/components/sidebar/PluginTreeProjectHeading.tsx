import type {
  PluginSidebarTreeOption,
  PluginTreeConversation,
} from "@t3tools/client-runtime/plugins";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useState, type ComponentProps, type MouseEvent as ReactMouseEvent } from "react";

import { useThreadSelectionStore } from "../../threadSelectionStore";
import { usePluginActionRunner } from "../plugins/usePluginActions";
import { usePluginTreeInstallation } from "./pluginTreeSources";
import { SidebarProjectSectionHeader } from "./SidebarProjectView";
import { JumpHintBadge, SidebarThreadStatusIcon } from "./SidebarThreadRow";

type HeaderProps = Omit<ComponentProps<typeof SidebarProjectSectionHeader>, "conversation">;

/**
 * A plugin tree's project heading that stands for a conversation: its name opens the thread, or
 * runs the declared action that starts one with only this project's id. Folding moves to the
 * chevron; new thread and project settings stay as on any project heading.
 */
export function PluginTreeProjectHeading(
  props: HeaderProps & {
    readonly choice: PluginSidebarTreeOption;
    readonly conversation: PluginTreeConversation<EnvironmentThreadShell>;
    readonly environmentLabel: string | null;
    readonly routeThreadKey: string | null;
    readonly jumpLabel: string | null;
    readonly revealRef: (row: HTMLElement, threadKey: string) => void;
    readonly onThreadClick: (event: ReactMouseEvent, threadRef: ScopedThreadRef) => void;
    readonly onThreadContextMenu: (
      threadRef: ScopedThreadRef,
      position: { readonly x: number; readonly y: number },
    ) => void;
  },
) {
  const {
    choice,
    conversation,
    environmentLabel,
    routeThreadKey,
    jumpLabel,
    revealRef,
    onThreadClick,
    onThreadContextMenu,
    ...header
  } = props;
  const name = header.project?.displayName ?? "";
  const where = environmentLabel === null ? "" : ` on ${environmentLabel}`;
  const inSelection = useThreadSelectionStore(
    (state) => conversation.kind === "thread" && state.selectedThreadKeys.has(conversation.key),
  );
  if (conversation.kind === "thread") {
    const { thread } = conversation;
    return (
      <SidebarProjectSectionHeader
        {...header}
        conversation={{
          label: `Open ${name}${where}`,
          threadKey: conversation.key,
          revealRef: routeThreadKey === conversation.key ? revealRef : undefined,
          selected: routeThreadKey === conversation.key,
          inSelection,
          busy: false,
          environmentLabel,
          jumpHint: jumpLabel === null ? null : <JumpHintBadge label={jumpLabel} />,
          status: <SidebarThreadStatusIcon thread={thread} markSettledDone />,
          onOpen: (event) => onThreadClick(event, scopeThreadRef(thread.environmentId, thread.id)),
          // The native thread menu: archive keeps its guard and Undo, and project settings stay.
          onContextMenu: (event) => {
            event.preventDefault();
            onThreadContextMenu(scopeThreadRef(thread.environmentId, thread.id), {
              x: event.clientX,
              y: event.clientY,
            });
          },
        }}
      />
    );
  }
  return (
    <PluginTreeActionHeading
      {...header}
      choice={choice}
      action={conversation}
      label={`${name}${where}`}
      environmentLabel={environmentLabel}
    />
  );
}

function PluginTreeActionHeading(
  props: HeaderProps & {
    readonly choice: PluginSidebarTreeOption;
    readonly action: PluginTreeConversation<EnvironmentThreadShell> & { readonly kind: "action" };
    readonly label: string;
    readonly environmentLabel: string | null;
  },
) {
  const { choice, action, label, environmentLabel, ...header } = props;
  const router = useRouter();
  const runAction = usePluginActionRunner();
  const [running, setRunning] = useState(false);
  // Only the installation that served this snapshot, still runnable and still serving the tree.
  const installation = usePluginTreeInstallation(choice, action.environmentId);
  const declared = installation?.manifest.actions.find((entry) => entry.id === action.actionId);
  if (installation === null || declared === undefined) {
    return <SidebarProjectSectionHeader {...header} />;
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
  return (
    <SidebarProjectSectionHeader
      {...header}
      conversation={{
        label: `${label}, ${declared.title}`,
        selected: false,
        inSelection: false,
        busy: running,
        environmentLabel,
        jumpHint: null,
        status: null,
        onOpen: run,
      }}
    />
  );
}
