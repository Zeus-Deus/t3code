import {
  PLUGIN_SIDEBAR_VIEW_CAPABILITY,
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

/** What one environment currently contributes. `pending` until its catalogue has been read. */
export type PluginSidebarViewSource =
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly options: ReadonlyArray<PluginSidebarViewOption> };

export const pluginSidebarViewKey = (pluginId: string, viewId: string) => `${pluginId}/${viewId}`;

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
  readonly remembered: PluginSidebarViewOption | null;
  readonly sources: ReadonlyMap<EnvironmentId, PluginSidebarViewSource>;
}): {
  readonly options: ReadonlyArray<PluginSidebarViewOption>;
  readonly selected: PluginSidebarViewOption | null;
} {
  const byKey = new Map<string, PluginSidebarViewOption>();
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
