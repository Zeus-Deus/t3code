import { EnvironmentId, type PluginInstallation } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { PluginSidebarViewSources } from "../plugins/PluginCatalogueSubscriptions";
import { SidebarViewSwitch } from "./SidebarProjectView";
import { useSidebarView, useSidebarViewSourceStore } from "./sidebarView";

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

function SidebarList(props: { onRender?: (view: string) => void }) {
  const view = useSidebarView();
  props.onRender?.(view.selected?.view.title ?? "Activity");
  return <output data-testid="list-view">{view.selected?.view.title ?? "Activity"}</output>;
}

function Harness() {
  const view = useSidebarView();
  return (
    <>
      <PluginSidebarViewSources />
      <output data-testid="rendered-view">{view.selected?.view.title ?? "Activity"}</output>
      {view.options.length > 0 || view.selected !== null ? (
        <SidebarViewSwitch
          options={view.options}
          selectedKey={view.selected?.key ?? null}
          onSelect={view.select}
        />
      ) : null}
    </>
  );
}

const renderedView = () => page.getByTestId("rendered-view");
const segment = (name: string) => page.getByRole("button", { name, exact: true });

describe("sidebar view choice", () => {
  it("offers a plugin view without switching to it, and never clears the selected segment", async () => {
    setup([projectsPlugin()]);
    await using _screen = await render(<Harness />);
    await expect.element(segment("Projects")).toBeVisible();
    await expect.element(renderedView()).toHaveTextContent("Activity");
    await expect.element(segment("Activity")).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(segment("Projects"));
    await expect.element(renderedView()).toHaveTextContent("Projects");
    await userEvent.click(segment("Projects"));
    await expect.element(renderedView()).toHaveTextContent("Projects");
    await userEvent.click(segment("Activity"));
    await expect.element(renderedView()).toHaveTextContent("Activity");
  });

  it("shows no switch when no plugin offers a view", async () => {
    setup([projectsPlugin({ grants: { capabilities: [], projectIds: [] } })]);
    await using _screen = await render(<Harness />);
    await expect.element(renderedView()).toHaveTextContent("Activity");
    expect(page.getByRole("group", { name: "Sidebar view" }).elements()).toHaveLength(0);
  });

  it("falls back while the plugin is unavailable and restores the remembered choice", async () => {
    setup([projectsPlugin()]);
    await using _screen = await render(<Harness />);
    await userEvent.click(segment("Projects"));
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
      expect(page.getByRole("group", { name: "Sidebar view" }).elements()).toHaveLength(0);

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
    await userEvent.click(segment("Projects"));
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
