import { EnvironmentId, type PluginInstallation } from "@t3tools/contracts";
import {
  isPluginSidebarTreeOption,
  pluginSidebarChoiceTitle,
} from "@t3tools/client-runtime/plugins";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { PluginSidebarViewSources } from "../plugins/PluginCatalogueSubscriptions";
import { SidebarViewSwitch } from "./SidebarProjectView";
import { useSidebarView, useSidebarViewSourceStore } from "./sidebarView";
import { SidebarProvider } from "../ui/sidebar";

const laptop = EnvironmentId.make("env-laptop");
// The catalogue is a subscription in the app; the mock notifies the same way.
const catalogue = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let snapshot = {
    availability: "available",
    loaded: true,
    error: null,
    installations: [] as PluginInstallation[],
    executionDisabled: false,
  };
  return {
    read: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update: (patch: Partial<typeof snapshot>) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("../../state/environments", () => ({
  useConnectedEnvironmentIds: () => [laptop],
  useEnvironmentIdentities: () => [{ environmentId: laptop, label: "Laptop" }],
  usePrimaryEnvironmentId: () => laptop,
}));
vi.mock("../../state/plugins", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePluginCatalogue: () => useSyncExternalStore(catalogue.subscribe, catalogue.read),
  };
});

function setup(installations: PluginInstallation[] = []) {
  catalogue.update({ installations, loaded: true, executionDisabled: false });
  window.localStorage.clear();
  useSidebarViewSourceStore.setState({ sources: new Map() });
}

function projectsPlugin(overrides: Partial<PluginInstallation> = {}): PluginInstallation {
  const digest = "a".repeat(64);
  return {
    installationId: "inst-projects",
    generation: "gen-1",
    manifest: {
      id: "t3code.projects",
      name: "Projects",
      version: "0.1.0",
      apiVersion: 1,
      entry: "plugin.mjs",
      capabilities: ["ui.sidebar-views"],
      actions: [],
      views: [],
      settings: [],
      sidebarViews: [{ id: "projects", title: "Projects", groupBy: "project" }],
    },
    source: { kind: "local", directory: "/plugins/projects" },
    digest,
    enabled: true,
    consentedDigest: digest,
    status: "idle",
    error: null,
    settings: {},
    grants: { capabilities: ["ui.sidebar-views"], projectIds: [] },
    updatedAt: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

function projectsTreePlugin(): PluginInstallation {
  const installation = projectsPlugin();
  return {
    ...installation,
    installationId: "inst-projects-tree",
    manifest: {
      ...installation.manifest,
      id: "examples.projects-tree",
      name: "Projects Tree",
      capabilities: ["ui.native-trees", "threads.read"],
      sidebarViews: [],
      nativeTrees: [{ id: "projects", title: "Projects" }],
    },
    grants: { capabilities: ["ui.native-trees", "threads.read"], projectIds: [] },
  };
}

function withSidebarViews(
  installation: PluginInstallation,
  sidebarViews: NonNullable<PluginInstallation["manifest"]["sidebarViews"]>,
): PluginInstallation {
  return { ...installation, manifest: { ...installation.manifest, sidebarViews } };
}

function SidebarList(props: { onRender?: (view: string) => void }) {
  const view = useSidebarView();
  props.onRender?.(view.selected === null ? "Activity" : pluginSidebarChoiceTitle(view.selected));
  return (
    <output data-testid="list-view">
      {view.selected === null ? "Activity" : pluginSidebarChoiceTitle(view.selected)}
    </output>
  );
}

function Harness() {
  const view = useSidebarView();
  return (
    <SidebarProvider>
      <PluginSidebarViewSources />
      <output data-testid="rendered-view">
        {view.selected === null ? "Activity" : pluginSidebarChoiceTitle(view.selected)}
      </output>
      <output data-testid="selected-choice">
        {view.selected === null
          ? "activity"
          : `${isPluginSidebarTreeOption(view.selected) ? "tree" : "view"} ${view.selected.key}`}
      </output>
      {view.options.length > 0 || view.selected !== null ? (
        <SidebarViewSwitch
          options={view.options}
          selectedKey={view.selected?.key ?? null}
          onSelect={view.select}
        />
      ) : null}
    </SidebarProvider>
  );
}

const renderedView = () => page.getByTestId("rendered-view");
const selectedChoice = () => page.getByTestId("selected-choice");
const viewMenu = () => page.getByRole("button", { name: "Sidebar view", exact: true });
const menuChoice = (name: string) => page.getByRole("menuitemradio", { name, exact: true });
const toggle = () => page.getByRole("button", { name: "Toggle Projects view", exact: true });

describe("sidebar view choice", () => {
  it("offers a compact toggle without selecting a view, and toggles back to Activity", async () => {
    setup([projectsPlugin()]);
    await using _screen = await render(<Harness />);
    await expect.element(toggle()).toBeVisible();
    await expect.element(renderedView()).toHaveTextContent("Activity");
    await expect.element(toggle()).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(toggle());
    await expect.element(renderedView()).toHaveTextContent("Projects");
    await expect.element(toggle()).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle());
    await expect.element(renderedView()).toHaveTextContent("Activity");
  });

  it("shows no switch when no plugin offers a view", async () => {
    setup([projectsPlugin({ grants: { capabilities: [], projectIds: [] } })]);
    await using _screen = await render(<Harness />);
    await expect.element(renderedView()).toHaveTextContent("Activity");
    expect(toggle().elements()).toHaveLength(0);
  });

  it("uses one header menu when several views are offered", async () => {
    const installation = projectsPlugin();
    setup([
      {
        ...installation,
        manifest: {
          ...installation.manifest,
          sidebarViews: [
            { id: "projects", title: "Projects", groupBy: "project" },
            { id: "quiet", title: "Quiet projects", groupBy: "project", quietAfterDays: 3 },
          ],
        },
      },
    ]);
    await using _screen = await render(<Harness />);
    await userEvent.click(viewMenu());
    await userEvent.click(menuChoice("Quiet projects"));
    await expect.element(renderedView()).toHaveTextContent("Quiet projects");
    await userEvent.click(viewMenu());
    await userEvent.click(menuChoice("Activity"));
    await expect.element(renderedView()).toHaveTextContent("Activity");
  });

  it("names the owning plugin when two plugins offer views with the same title", async () => {
    setup([
      projectsPlugin({ manifest: { ...projectsPlugin().manifest, id: "example.projects" } }),
      projectsTreePlugin(),
    ]);
    await using _screen = await render(<Harness />);
    await userEvent.click(viewMenu());
    await expect.element(menuChoice("Activity")).toBeVisible();
    await expect.element(menuChoice("Projects (Projects)")).toBeVisible();
    await userEvent.click(menuChoice("Projects (Projects Tree)"));
    await expect
      .element(selectedChoice())
      .toHaveTextContent("tree examples.projects-tree/tree:projects");

    await userEvent.click(viewMenu());
    await expect
      .element(menuChoice("Projects (Projects Tree)"))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(menuChoice("Projects (Projects)"))
      .toHaveAttribute("aria-checked", "false");
    await userEvent.click(menuChoice("Projects (Projects)"));
    await expect.element(selectedChoice()).toHaveTextContent("view example.projects/projects");

    await userEvent.click(viewMenu());
    await userEvent.click(menuChoice("Activity"));
    await expect.element(selectedChoice()).toHaveTextContent("activity");
  });

  it("keeps the built-in Activity distinct from a plugin view titled Activity", async () => {
    setup([
      withSidebarViews(projectsPlugin(), [
        { id: "projects", title: "Projects", groupBy: "project" },
        { id: "activity", title: "Activity", groupBy: "project" },
      ]),
    ]);
    await using _screen = await render(<Harness />);
    await userEvent.click(viewMenu());
    // A unique title stays as the plugin wrote it.
    await expect.element(menuChoice("Projects")).toBeVisible();
    await userEvent.click(menuChoice("Activity (Projects)"));
    await expect.element(selectedChoice()).toHaveTextContent("view t3code.projects/activity");

    await userEvent.click(viewMenu());
    await expect.element(menuChoice("Activity")).toHaveAttribute("aria-checked", "false");
    await userEvent.click(menuChoice("Activity"));
    await expect.element(selectedChoice()).toHaveTextContent("activity");
  });

  it("tells apart one plugin's view and tree that share a title", async () => {
    const tree = projectsTreePlugin();
    setup([
      {
        ...tree,
        manifest: {
          ...tree.manifest,
          id: "t3code.projects",
          name: "Projects",
          sidebarViews: [{ id: "projects", title: "Projects", groupBy: "project" }],
        },
        grants: {
          capabilities: ["ui.sidebar-views", "ui.native-trees", "threads.read"],
          projectIds: [],
        },
      },
    ]);
    await using _screen = await render(<Harness />);
    await userEvent.click(viewMenu());
    await userEvent.click(menuChoice("Projects (t3code.projects/tree:projects)"));
    await expect.element(selectedChoice()).toHaveTextContent("tree t3code.projects/tree:projects");
    await userEvent.click(viewMenu());
    await userEvent.click(menuChoice("Projects (t3code.projects/projects)"));
    await expect.element(selectedChoice()).toHaveTextContent("view t3code.projects/projects");
  });

  it("falls back while the plugin is unavailable and restores the remembered choice", async () => {
    setup([projectsPlugin()]);
    await using _screen = await render(<Harness />);
    await userEvent.click(toggle());
    await expect.element(renderedView()).toHaveTextContent("Projects");

    for (const unavailable of [
      { installations: [projectsPlugin({ enabled: false, status: "disabled" as const })] },
      { installations: [] },
      { executionDisabled: true },
      {
        installations: [
          projectsPlugin({ compatibility: { available: false, missingCapabilities: ["x"] } }),
        ],
      },
    ]) {
      await act(() => catalogue.update(unavailable));
      await expect.element(renderedView()).toHaveTextContent("Activity");
      expect(toggle().elements()).toHaveLength(0);

      await act(() =>
        catalogue.update({ installations: [projectsPlugin()], executionDisabled: false }),
      );
      await expect.element(renderedView()).toHaveTextContent("Projects");
    }
  });

  it("returns from Settings without rendering a view disabled there", async () => {
    setup([projectsPlugin()]);
    // The app layout keeps the sources mounted while Settings replaces the thread list.
    const seen: string[] = [];
    const layout = (showList: boolean) => (
      <>
        <PluginSidebarViewSources />
        {showList ? <SidebarList onRender={(view) => seen.push(view)} /> : null}
      </>
    );
    window.localStorage.setItem(
      "t3code:sidebar:view",
      JSON.stringify({
        key: "t3code.projects/projects",
        environmentId: laptop,
        pluginName: "Projects",
        view: { id: "projects", title: "Projects", groupBy: "project" },
      }),
    );
    await using screen = await render(layout(true));
    await expect.element(page.getByTestId("list-view")).toHaveTextContent("Projects");

    await screen.rerender(layout(false));
    await act(() => catalogue.update({ installations: [] }));
    seen.length = 0;
    await screen.rerender(layout(true));
    await expect.element(page.getByTestId("list-view")).toHaveTextContent("Activity");
    expect(seen).not.toContain("Projects");
  });

  it("keeps the remembered view while its environment's plugins are still loading", async () => {
    setup([projectsPlugin()]);
    await using screen = await render(<Harness />);
    await userEvent.click(toggle());
    await screen.unmount();

    // A relaunch: nothing reported yet, then a catalogue that is still loading.
    useSidebarViewSourceStore.setState({ sources: new Map() });
    catalogue.update({ loaded: false, installations: [] });
    await using _relaunched = await render(<Harness />);
    await expect.element(renderedView()).toHaveTextContent("Projects");

    await act(() => catalogue.update({ loaded: true }));
    await expect.element(renderedView()).toHaveTextContent("Activity");
  });
});
