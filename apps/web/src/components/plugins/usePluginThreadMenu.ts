import { pluginActionEntries, type PluginActionEntry } from "@t3tools/client-runtime/plugins";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";

import { readRunnablePluginInstallations } from "../../state/plugins";
import {
  parsePluginThreadActionMenuId,
  pluginThreadActionMenuId,
  type PluginThreadActionMenuId,
} from "../threadActionMenu.logic";
import { usePluginActionRunner } from "./usePluginActions";

interface PluginThreadMenu {
  readonly entries: ReadonlyArray<PluginActionEntry>;
  readonly items: ReadonlyArray<{ readonly id: PluginThreadActionMenuId; readonly label: string }>;
  readonly locationKey: string;
}

/**
 * Thread-menu plugin actions for the sidebar and the chat header menus. `capture` runs before the
 * menu opens, so the action targets that thread and location wherever the user is when it ends.
 */
export function usePluginThreadMenu() {
  const router = useRouter();
  const runAction = usePluginActionRunner();
  const capture = (threadRef: ScopedThreadRef): PluginThreadMenu => {
    const entries = pluginActionEntries(
      readRunnablePluginInstallations(threadRef.environmentId),
      "thread-menu",
    );
    return {
      entries,
      items: entries.map((entry) => ({
        id: pluginThreadActionMenuId(entry.installation.installationId, entry.action.id),
        label: `${entry.action.title} · ${entry.installation.manifest.name}`,
      })),
      locationKey: router.state.location.pathname,
    };
  };
  /** Runs the picked plugin action; false when the choice was not a plugin action. */
  const run = (
    choice: string,
    menu: PluginThreadMenu,
    thread: { readonly threadRef: ScopedThreadRef; readonly projectId: ProjectId },
  ): boolean => {
    const picked = parsePluginThreadActionMenuId(choice);
    if (picked === null) return false;
    const entry = menu.entries.find(
      (candidate) =>
        candidate.installation.installationId === picked.installationId &&
        candidate.action.id === picked.actionId,
    );
    if (entry) {
      void runAction(
        {
          environmentId: thread.threadRef.environmentId,
          installation: entry.installation,
          threadRef: thread.threadRef,
          composerTarget: thread.threadRef,
          locationKey: menu.locationKey,
        },
        entry.action,
        { projectId: thread.projectId, threadId: thread.threadRef.threadId },
      );
    }
    return true;
  };
  return { capture, run };
}
