import { EnvironmentId, ProjectId, ThreadId, type PluginInstallation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pluginRunnableInstallations } from "./model.ts";
import { isPluginTreeOwnedThread } from "./nativeTrees.ts";
import * as Schema from "effect/Schema";

import {
  findPluginTreeInstallation,
  PluginSidebarChoice,
  pluginSidebarTreeOptions,
  pluginSidebarViewOptions,
  pluginTreeOwnerGrants,
  resolvePluginSidebarView,
  type PluginSidebarViewSource,
} from "./sidebarViews.ts";
import { pluginInstallationFixture } from "./testFixtures.ts";

const decodeChoice = Schema.decodeUnknownSync(PluginSidebarChoice);
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
    expect(selected).toMatchObject({ view: { quietAfterDays: 14 } });
  });

  it("offers a native tree only with both its own grant and thread reads", () => {
    const base = pluginInstallationFixture();
    const treePlugin = (capabilities: ReadonlyArray<string>): PluginInstallation => ({
      ...base,
      manifest: {
        ...base.manifest,
        id: "t3code.projects",
        name: "Projects",
        capabilities: ["ui.native-trees", "threads.read"],
        nativeTrees: [{ id: "projects", title: "Projects" }],
      },
      grants: {
        capabilities: capabilities as PluginInstallation["grants"]["capabilities"],
        projectIds: [],
      },
    });
    const granted = treePlugin(["ui.native-trees", "threads.read"]);
    const [option] = pluginSidebarTreeOptions(local, [granted]);
    expect(option).toMatchObject({ kind: "tree", key: "t3code.projects/tree:projects" });
    expect(pluginSidebarTreeOptions(local, [treePlugin(["ui.native-trees"])])).toEqual([]);
    expect(findPluginTreeInstallation([granted], option!)).toBe(granted);
    expect(findPluginTreeInstallation([treePlugin(["threads.read"])], option!)).toBeNull();
    // A remembered tree resolves like a declared view, and a choice saved before trees existed
    // still decodes.
    expect(
      resolvePluginSidebarView({
        remembered: option!,
        sources: new Map([[local, { status: "ready", options: [option!] }]]),
      }).selected,
    ).toBe(option);
    const [saved] = pluginSidebarViewOptions(local, [projectsPlugin()]);
    expect(decodeChoice(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });

  it("leaves a main thread to its owning tree only while that tree is offered with its project", () => {
    const base = pluginInstallationFixture();
    const owning = (
      capabilities: ReadonlyArray<string>,
      overrides: Partial<PluginInstallation> = {},
    ): PluginInstallation => ({
      ...base,
      manifest: {
        ...base.manifest,
        nativeTrees: [{ id: "projects", title: "Projects", unplaced: "omit" }],
      },
      grants: {
        capabilities: capabilities as PluginInstallation["grants"]["capabilities"],
        projectIds: [ProjectId.make("shelf")],
      },
      ...overrides,
    });
    const full = ["ui.native-trees", "threads.read", "ui.native-tree-projects"];
    const main = {
      lineage: { parentThreadId: null as ThreadId | null },
      projectId: ProjectId.make("shelf"),
      pluginOwner: { installationId: "inst-1", treeId: "projects" },
    };
    const hidden = (installations: ReadonlyArray<PluginInstallation>, thread = main) =>
      isPluginTreeOwnedThread(thread, pluginTreeOwnerGrants(installations));

    expect(hidden([owning(full)])).toBe(true);
    // Any missing grant, a disabled or failed plugin, or safe mode returns it to Activity.
    for (const capability of full) {
      expect(hidden([owning(full.filter((entry) => entry !== capability))])).toBe(false);
    }
    expect(hidden([owning(full, { enabled: false })])).toBe(false);
    expect(hidden([owning(full, { status: "error" })])).toBe(false);
    expect(
      hidden(
        pluginRunnableInstallations({ installations: [owning(full)], executionDisabled: true }),
      ),
    ).toBe(false);
    expect(hidden([])).toBe(false);
    // Another installation's or tree's claim, an ungranted project, or a child stays in Activity.
    expect(hidden([owning(full, { installationId: "inst-2" })])).toBe(false);
    expect(
      hidden([owning(full)], {
        ...main,
        pluginOwner: { installationId: "inst-1", treeId: "other" },
      }),
    ).toBe(false);
    expect(hidden([owning(full)], { ...main, projectId: ProjectId.make("elsewhere") })).toBe(false);
    expect(
      hidden([owning(full)], { ...main, lineage: { parentThreadId: ThreadId.make("parent") } }),
    ).toBe(false);
    // An environment that has not reported its plugins hides nothing.
    expect(isPluginTreeOwnedThread(main, undefined)).toBe(false);
  });
});
