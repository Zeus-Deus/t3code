import { useAtomValue } from "@effect/atom-react";
import {
  pluginActionEntries,
  pluginRunnableInstallations,
  pluginViewEntries,
} from "@t3tools/client-runtime/plugins";
import type {
  EnvironmentId,
  PluginInstallation,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { FolderTreeIcon, ListIcon, PanelsTopLeftIcon, PuzzleIcon } from "lucide-react";

import type { ComposerThreadTarget } from "../../composerDraftStore";
import { pluginEnvironment, usePluginCatalogue } from "../../state/plugins";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { useClientSettings } from "../../hooks/useSettings";
import { useSidebarView } from "../sidebar/sidebarView";
import { usePluginActionRunner, usePluginIntentApplier } from "./usePluginActions";

/**
 * Palette entries for the plugins of the environment the user is working in: actions placed in
 * the palette, and each view. Results apply to the thread and composer open when picked.
 */
export function usePluginPaletteItems(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly projectId: ProjectId | null;
  readonly composerTarget: ComposerThreadTarget | null;
}): ReadonlyArray<CommandPaletteActionItem> {
  const catalogue = usePluginCatalogue(input.environmentId);
  const canInvoke = useAtomValue(pluginEnvironment.invoke.permissionAtom(input.environmentId));
  const runAction = usePluginActionRunner();
  const applyIntents = usePluginIntentApplier();
  const router = useRouter();
  const environmentId = input.environmentId;
  const installations = pluginRunnableInstallations(catalogue);
  if (environmentId === null || installations.length === 0) return [];
  const target = (installation: PluginInstallation) => ({
    environmentId,
    installation,
    threadRef: input.threadRef,
    composerTarget: input.composerTarget,
    locationKey: router.state.location.pathname,
  });
  const context = {
    ...(input.projectId === null ? {} : { projectId: input.projectId }),
    ...(input.threadRef === null ? {} : { threadId: input.threadRef.threadId }),
  };
  const actions = pluginActionEntries(installations, "palette").map(
    ({ installation, action }): CommandPaletteActionItem => ({
      kind: "action",
      value: `plugin-action:${installation.installationId}:${action.id}`,
      searchTerms: ["plugin", installation.manifest.name, action.title, action.description ?? ""],
      title: action.title,
      description: action.description
        ? `${installation.manifest.name} · ${action.description}`
        : installation.manifest.name,
      icon: <PuzzleIcon className={ITEM_ICON_CLASS} />,
      disabled: !canInvoke,
      run: () => runAction(target(installation), action, context),
    }),
  );
  const views = pluginViewEntries(installations)
    // A side panel needs a thread to sit beside.
    .filter(({ view }) => view.placement === "page" || input.threadRef !== null)
    .map(({ installation, view }): CommandPaletteActionItem => ({
      kind: "action",
      value: `plugin-view:${installation.installationId}:${view.id}`,
      searchTerms: ["plugin", "open", "view", installation.manifest.name, view.title],
      title: `Open ${view.title}`,
      description: installation.manifest.name,
      icon: <PanelsTopLeftIcon className={ITEM_ICON_CLASS} />,
      run: async () => applyIntents(target(installation), [{ type: "view.open", viewId: view.id }]),
    }));
  return [...actions, ...views];
}

/** Switches the sidebar between activity and the plugin views offered by any environment. */
export function useSidebarViewPaletteItems(): ReadonlyArray<CommandPaletteActionItem> {
  const sidebarView = useSidebarView();
  // The legacy project-tree sidebar does not render plugin views.
  const legacySidebarEnabled = useClientSettings((settings) => settings.legacySidebarEnabled);
  if (legacySidebarEnabled || sidebarView.options.length === 0) return [];
  const selectedKey = sidebarView.selected?.key ?? null;
  const items: CommandPaletteActionItem[] = sidebarView.options
    .filter((option) => option.key !== selectedKey)
    .map((option) => ({
      kind: "action",
      value: `sidebar-view:${option.key}`,
      searchTerms: ["sidebar", "view", "switch", "group", option.view.title, option.pluginName],
      title: `Show ${option.view.title} in sidebar`,
      description: option.pluginName,
      icon: <FolderTreeIcon className={ITEM_ICON_CLASS} />,
      run: async () => sidebarView.select(option),
    }));
  if (selectedKey !== null) {
    items.push({
      kind: "action",
      value: "sidebar-view:activity",
      searchTerms: ["sidebar", "view", "switch", "activity", "settled", "inbox"],
      title: "Show Activity in sidebar",
      icon: <ListIcon className={ITEM_ICON_CLASS} />,
      run: async () => sidebarView.select(null),
    });
  }
  return items;
}
