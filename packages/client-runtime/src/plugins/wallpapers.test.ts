import type { PluginInstallation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pluginInstallationFixture } from "./testFixtures.ts";
import { pluginWallpaperEntries, resolvePluginWallpaper } from "./wallpapers.ts";

const wallpapers = (overrides: Partial<PluginInstallation> = {}): PluginInstallation => {
  const base = pluginInstallationFixture();
  return {
    ...base,
    installationId: "inst-walls",
    manifest: {
      ...base.manifest,
      id: "examples.walls",
      capabilities: ["ui", "ui.wallpapers"],
      views: [
        { id: "koi", title: "Koi Pond", entry: "koi.html", placement: "wallpaper" },
        { id: "board", title: "Board", entry: "view.html", placement: "page" },
      ],
    },
    grants: { capabilities: ["ui", "ui.wallpapers"], projectIds: [] },
    ...overrides,
  };
};
const choice = { environmentId: "env-1", pluginId: "examples.walls", viewId: "koi" };

describe("resolvePluginWallpaper", () => {
  it("offers only wallpaper views and draws the chosen one", () => {
    expect(pluginWallpaperEntries([wallpapers()]).map((entry) => entry.view.id)).toEqual(["koi"]);
    expect(resolvePluginWallpaper({ choice, installations: [wallpapers()] })?.view.id).toBe("koi");
  });

  it("draws nothing when the wallpaper cannot be shown", () => {
    for (const [installations, viewId] of [
      [[], "koi"],
      [[wallpapers({ enabled: false, status: "disabled" })], "koi"],
      [[wallpapers({ grants: { capabilities: ["ui"], projectIds: [] } })], "koi"],
      [[wallpapers({ grants: { capabilities: ["ui.wallpapers"], projectIds: [] } })], "koi"],
      [[wallpapers()], "board"],
      [[wallpapers()], "gone"],
    ] as const) {
      expect(resolvePluginWallpaper({ choice: { ...choice, viewId }, installations })).toBeNull();
    }
    expect(resolvePluginWallpaper({ choice: null, installations: [wallpapers()] })).toBeNull();
  });
});
