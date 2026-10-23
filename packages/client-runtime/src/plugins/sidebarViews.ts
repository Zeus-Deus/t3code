import {
  PLUGIN_SIDEBAR_VIEW_CAPABILITY,
  PluginNativeTree,
  PluginSidebarView,
  type EnvironmentId,
  type PluginInstallation,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isPluginActive } from "./model.ts";

/**
 * A sidebar view the person can switch to. Its key is the plugin and view id, not the installation,
 * so the same plugin installed on several environments, or reinstalled, offers one choice.
 */
export const PluginSidebarViewOption = Schema.Struct({
  key: Schema.String,
  environmentId: Schema.String,
  pluginName: Schema.String,
  view: PluginSidebarView,
});
export type PluginSidebarViewOption = typeof PluginSidebarViewOption.Type;

/**
 * A plugin's native tree as a sidebar choice. Every environment whose installation offers the same
 * key contributes its own snapshot; `environmentId` only says which one the choice came from.
 */
export const PluginSidebarTreeOption = Schema.Struct({
  kind: Schema.Literal("tree"),
  key: Schema.String,
  environmentId: Schema.String,
  pluginId: Schema.String,
  pluginName: Schema.String,
  tree: PluginNativeTree,
});
export type PluginSidebarTreeOption = typeof PluginSidebarTreeOption.Type;

/** What the sidebar can show besides activity. Choices saved before trees existed still decode. */
export const PluginSidebarChoice = Schema.Union([PluginSidebarViewOption, PluginSidebarTreeOption]);
export type PluginSidebarChoice = typeof PluginSidebarChoice.Type;

export const isPluginSidebarTreeOption = (
  choice: PluginSidebarChoice,
): choice is PluginSidebarTreeOption => "kind" in choice && choice.kind === "tree";

export const pluginSidebarChoiceTitle = (choice: PluginSidebarChoice) =>
  isPluginSidebarTreeOption(choice) ? choice.tree.title : choice.view.title;

/** What one environment currently contributes. `pending` until its catalogue has been read. */
export type PluginSidebarViewSource =
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly options: ReadonlyArray<PluginSidebarChoice> };

export const pluginSidebarViewKey = (pluginId: string, viewId: string) => `${pluginId}/${viewId}`;
// Tree and view ids share no namespace in the manifest, so their keys must not collide.
export const pluginSidebarTreeKey = (pluginId: string, treeId: string) =>
  `${pluginId}/tree:${treeId}`;

const PLUGIN_NATIVE_TREE_CAPABILITY = "ui.native-trees";

/** Trees read threads, so they need that grant as well as their own. */
const offersNativeTrees = (installation: PluginInstallation) =>
  isPluginActive(installation) &&
  installation.grants.capabilities.includes(PLUGIN_NATIVE_TREE_CAPABILITY) &&
  installation.grants.capabilities.includes("threads.read");

/** Pass the environment's runnable installations, so safe mode contributes nothing. */
export function pluginSidebarTreeOptions(
  environmentId: EnvironmentId,
  installations: ReadonlyArray<PluginInstallation>,
): ReadonlyArray<PluginSidebarTreeOption> {
  return installations.filter(offersNativeTrees).flatMap((installation) =>
    (installation.manifest.nativeTrees ?? []).map((tree) => ({
      kind: "tree" as const,
      key: pluginSidebarTreeKey(installation.manifest.id, tree.id),
      environmentId,
      pluginId: installation.manifest.id,
      pluginName: installation.manifest.name,
      tree,
    })),
  );
}

/** The installation that serves a tree choice on one environment, if it offers it right now. */
export function findPluginTreeInstallation(
  installations: ReadonlyArray<PluginInstallation>,
  choice: Pick<PluginSidebarTreeOption, "pluginId" | "tree">,
): PluginInstallation | null {
  return (
    installations.find(
      (installation) =>
        offersNativeTrees(installation) &&
        installation.manifest.id === choice.pluginId &&
        (installation.manifest.nativeTrees ?? []).some((tree) => tree.id === choice.tree.id),
    ) ?? null
  );
}

/**
 * Pass the environment's runnable installations, so safe mode contributes nothing. Like views and
 * statuses, a sidebar view needs its capability granted, not just requested.
 */
export function pluginSidebarViewOptions(
  environmentId: EnvironmentId,
  installations: ReadonlyArray<PluginInstallation>,
): ReadonlyArray<PluginSidebarViewOption> {
  return installations
    .filter(
      (installation) =>
        isPluginActive(installation) &&
        installation.grants.capabilities.includes(PLUGIN_SIDEBAR_VIEW_CAPABILITY),
    )
    .flatMap((installation) =>
      (installation.manifest.sidebarViews ?? []).map((view) => ({
        key: pluginSidebarViewKey(installation.manifest.id, view.id),
        environmentId,
        pluginName: installation.manifest.name,
        view,
      })),
    );
}

/**
 * The views offered beside the built-in activity list, and the one to render. `selected` is null
 * whenever the remembered choice is no longer contributed (disabled, removed, incompatible, safe
 * mode, grant withdrawn), so the sidebar falls back to activity without the choice being erased:
 * enabling the plugin again restores it. While the environment that supplied the remembered view
 * has not reported yet (starting up, reconnecting) its last known rules keep applying, so a launch
 * does not flash the activity list.
 *
 * `sources` lists every known environment in priority order; the first to offer a key wins.
 */
export function resolvePluginSidebarView(input: {
  readonly remembered: PluginSidebarChoice | null;
  readonly sources: ReadonlyMap<EnvironmentId, PluginSidebarViewSource>;
}): {
  readonly options: ReadonlyArray<PluginSidebarChoice>;
  readonly selected: PluginSidebarChoice | null;
} {
  const byKey = new Map<string, PluginSidebarChoice>();
  for (const source of input.sources.values()) {
    if (source.status !== "ready") continue;
    for (const option of source.options) if (!byKey.has(option.key)) byKey.set(option.key, option);
  }
  const options = [...byKey.values()];
  const { remembered } = input;
  if (remembered === null) return { options, selected: null };
  const live = byKey.get(remembered.key);
  if (live !== undefined) return { options, selected: live };
  const origin = [...input.sources].find(
    ([environmentId]) => environmentId === remembered.environmentId,
  )?.[1];
  return { options, selected: origin?.status === "pending" ? remembered : null };
}
