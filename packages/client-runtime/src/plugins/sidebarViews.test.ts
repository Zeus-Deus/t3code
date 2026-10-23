import { EnvironmentId, type PluginInstallation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pluginRunnableInstallations } from "./model.ts";
import {
  pluginSidebarViewOptions,
  resolvePluginSidebarView,
  type PluginSidebarViewSource,
} from "./sidebarViews.ts";
import { pluginInstallationFixture } from "./testFixtures.ts";

const local = EnvironmentId.make("env-local");
const remote = EnvironmentId.make("env-remote");

const projectsPlugin = (
  overrides: Partial<PluginInstallation> = {},
  quietAfterDays = 3,
): PluginInstallation => {
  const base = pluginInstallationFixture();
  return {
    ...base,
    manifest: {
      ...base.manifest,
      id: "t3code.projects",
      name: "Projects",
      capabilities: ["ui.sidebar-views"],
      sidebarViews: [{ id: "projects", title: "Projects", groupBy: "project", quietAfterDays }],
    },
    grants: { capabilities: ["ui.sidebar-views"], projectIds: [] },
    ...overrides,
  };
};

const ready = (
  environmentId: EnvironmentId,
  installations: ReadonlyArray<PluginInstallation>,
  executionDisabled = false,
): PluginSidebarViewSource => ({
  status: "ready",
  options: pluginSidebarViewOptions(
    environmentId,
    pluginRunnableInstallations({ installations, executionDisabled }),
  ),
});

describe("plugin sidebar views", () => {
  it("offers one choice per plugin view across environments, preferring the earlier environment", () => {
    const { options } = resolvePluginSidebarView({
      remembered: null,
      sources: new Map([
        [local, ready(local, [projectsPlugin({}, 3)])],
        [remote, ready(remote, [projectsPlugin({ installationId: "other" }, 9)])],
      ]),
    });
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      key: "t3code.projects/projects",
      environmentId: local,
      view: { quietAfterDays: 3 },
    });
  });

  it("offers nothing for plugins that cannot contribute right now", () => {
    for (const installation of [
      projectsPlugin({ enabled: false, status: "disabled" }),
      projectsPlugin({ consentedDigest: null, status: "needs-consent" }),
      projectsPlugin({ status: "quarantined" }),
      projectsPlugin({ compatibility: { available: false, missingCapabilities: ["x"] } }),
      projectsPlugin({ grants: { capabilities: [], projectIds: [] } }),
    ]) {
      expect(pluginSidebarViewOptions(local, [installation])).toEqual([]);
    }
    expect(ready(local, [projectsPlugin()], true)).toEqual({ status: "ready", options: [] });
  });

  it("falls back to activity without forgetting the choice, and restores it when offered again", () => {
    const [option] = pluginSidebarViewOptions(local, [projectsPlugin()]);
    const remembered = option!;
    const disabled = resolvePluginSidebarView({
      remembered,
      sources: new Map([[local, ready(local, [projectsPlugin({ enabled: false })])]]),
    });
    expect(disabled).toEqual({ options: [], selected: null });
    const reenabled = resolvePluginSidebarView({
      remembered,
      sources: new Map([[local, ready(local, [projectsPlugin()])]]),
    });
    expect(reenabled.selected?.key).toBe(remembered.key);
  });

  it("keeps the last known rules only while their environment has not reported", () => {
    const [option] = pluginSidebarViewOptions(remote, [projectsPlugin()]);
    const remembered = option!;
    const pending = new Map<EnvironmentId, PluginSidebarViewSource>([
      [local, ready(local, [])],
      [remote, { status: "pending" }],
    ]);
    expect(resolvePluginSidebarView({ remembered, sources: pending }).selected).toBe(remembered);
    // Another environment's pending catalogue does not hold a choice its origin has withdrawn.
    expect(
      resolvePluginSidebarView({
        remembered,
        sources: new Map([
          [local, { status: "pending" }],
          [remote, ready(remote, [])],
        ]),
      }).selected,
    ).toBeNull();
    // An environment that is no longer known cannot supply it either.
    expect(
      resolvePluginSidebarView({ remembered, sources: new Map([[local, ready(local, [])]]) })
        .selected,
    ).toBeNull();
  });

  it("follows the live declaration when the plugin's rules change", () => {
    const [stale] = pluginSidebarViewOptions(local, [projectsPlugin({}, 3)]);
    const { selected } = resolvePluginSidebarView({
      remembered: stale!,
      sources: new Map([[local, ready(local, [projectsPlugin({}, 14)])]]),
    });
    expect(selected?.view.quietAfterDays).toBe(14);
  });
});
