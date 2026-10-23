import type { PluginInstallation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePluginStartPage } from "./startPage.ts";
import { pluginInstallationFixture } from "./testFixtures.ts";

const board = (overrides: Partial<PluginInstallation> = {}): PluginInstallation => {
  const base = pluginInstallationFixture();
  return {
    ...base,
    installationId: "inst-board",
    manifest: {
      ...base.manifest,
      id: "examples.board",
      views: [
        { id: "board", title: "Board", entry: "view.html", placement: "page" },
        { id: "notes", title: "Notes", entry: "view.html", placement: "side-panel" },
      ],
    },
    grants: { capabilities: ["ui"], projectIds: [] },
    ...overrides,
  };
};
const preference = { environmentId: "env-1", pluginId: "examples.board", viewId: "board" };

describe("resolvePluginStartPage", () => {
  it("opens the chosen page once its environment's plugins are known", () => {
    expect(
      resolvePluginStartPage({ preference, environment: "pending", installations: [] }),
    ).toEqual({ kind: "pending" });
    expect(
      resolvePluginStartPage({ preference, environment: "ready", installations: [board()] }),
    ).toEqual({ kind: "open", installationId: "inst-board", viewId: "board" });
  });

  it("starts the usual way at once when the page cannot open", () => {
    for (const [environment, installations, viewId] of [
      ["unavailable", [board()], "board"],
      ["ready", [], "board"],
      ["ready", [board({ enabled: false, status: "disabled" })], "board"],
      ["ready", [board({ grants: { capabilities: [], projectIds: [] } })], "board"],
      ["ready", [board()], "notes"],
      ["ready", [board()], "gone"],
    ] as const) {
      expect(
        resolvePluginStartPage({
          preference: { ...preference, viewId },
          environment,
          installations,
        }),
      ).toEqual({ kind: "core" });
    }
    expect(
      resolvePluginStartPage({ preference: null, environment: "pending", installations: [] }),
    ).toEqual({ kind: "core" });
  });
});
