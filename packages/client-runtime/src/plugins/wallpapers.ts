import {
  PLUGIN_WALLPAPER_CAPABILITY,
  type PluginInstallation,
  type PluginView,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isPluginActive } from "./model.ts";

/**
 * The wallpaper this device shows behind the app. Kept on the device, never synced: it names a
 * plugin and view, not an installation, so a reinstall keeps it.
 */
export const PluginWallpaperChoice = Schema.Struct({
  environmentId: Schema.String,
  pluginId: Schema.String,
  viewId: Schema.String,
});
export type PluginWallpaperChoice = typeof PluginWallpaperChoice.Type;

export interface PluginWallpaperEntry {
  readonly installation: PluginInstallation;
  readonly view: PluginView;
}

/** Wallpapers need `ui` (to read the document) and `ui.wallpapers` granted, not just requested. */
export function pluginWallpaperEntries(
  installations: ReadonlyArray<PluginInstallation>,
): ReadonlyArray<PluginWallpaperEntry> {
  return installations
    .filter(
      (installation) =>
        isPluginActive(installation) &&
        installation.grants.capabilities.includes("ui") &&
        installation.grants.capabilities.includes(PLUGIN_WALLPAPER_CAPABILITY),
    )
    .flatMap((installation) =>
      installation.manifest.views
        .filter((view) => view.placement === "wallpaper")
        .map((view) => ({ installation, view })),
    );
}

export const isPluginWallpaperChoice = (
  choice: PluginWallpaperChoice | null,
  environmentId: string,
  entry: PluginWallpaperEntry,
): boolean =>
  choice !== null &&
  choice.environmentId === environmentId &&
  choice.pluginId === entry.installation.manifest.id &&
  choice.viewId === entry.view.id;

/**
 * The wallpaper to draw from the chosen environment's runnable installations. Anything missing,
 * disabled or not granted draws nothing, without forgetting the choice, so enabling the plugin
 * again brings it back.
 */
export function resolvePluginWallpaper(input: {
  readonly choice: PluginWallpaperChoice | null;
  readonly installations: ReadonlyArray<PluginInstallation>;
}): PluginWallpaperEntry | null {
  const { choice } = input;
  if (choice === null) return null;
  return (
    pluginWallpaperEntries(input.installations).find(
      (entry) =>
        entry.installation.manifest.id === choice.pluginId && entry.view.id === choice.viewId,
    ) ?? null
  );
}
