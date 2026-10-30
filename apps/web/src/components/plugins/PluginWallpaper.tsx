import {
  PluginWallpaperChoice,
  pluginRunnableInstallations,
  resolvePluginWallpaper,
} from "@t3tools/client-runtime/plugins";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { usePluginCatalogue } from "../../state/plugins";
import { PluginViewFrame } from "./PluginViewHost";

const WALLPAPER_KEY = "t3code:plugins:wallpaper";
const WallpaperPreference = Schema.NullOr(PluginWallpaperChoice);

/** The plugin wallpaper this device shows, if any. */
export function usePluginWallpaper() {
  const [wallpaper, setWallpaper] = useLocalStorage(WALLPAPER_KEY, null, WallpaperPreference);
  return { wallpaper, setWallpaper };
}

/**
 * Draws the chosen wallpaper behind the app shell. While one is drawn, the root carries
 * `data-plugin-wallpaper` so the shell's surfaces turn translucent; without one (none chosen,
 * plugin disabled, environment offline) the app looks exactly as usual.
 */
export function PluginWallpaperLayer() {
  const { wallpaper } = usePluginWallpaper();
  const environmentId = wallpaper === null ? null : EnvironmentId.make(wallpaper.environmentId);
  const catalogue = usePluginCatalogue(environmentId);
  const entry = resolvePluginWallpaper({
    choice: wallpaper,
    installations: pluginRunnableInstallations(catalogue),
  });
  const shown = environmentId !== null && entry !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors whether a wallpaper is drawn onto the root element, which the shell's translucent-surface styles key off
  useEffect(() => {
    if (!shown) return;
    const root = document.documentElement;
    root.dataset.pluginWallpaper = "";
    return () => {
      delete root.dataset.pluginWallpaper;
    };
  }, [shown]);
  if (!shown) return null;
  return (
    <div
      aria-hidden
      data-plugin-wallpaper-layer=""
      className="pointer-events-none fixed inset-0 z-0 select-none overflow-hidden"
    >
      <PluginViewFrame
        key={`${entry.installation.installationId}:${entry.installation.generation}:${entry.view.id}`}
        environmentId={environmentId}
        installation={entry.installation}
        view={entry.view}
        placement="wallpaper"
        threadRef={null}
        composerTarget={null}
      />
    </div>
  );
}
