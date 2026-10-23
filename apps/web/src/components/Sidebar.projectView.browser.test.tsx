import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { pluginSidebarViewKey } from "@t3tools/client-runtime/plugins";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type PluginInstallation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import Sidebar from "./Sidebar";
import { useSidebarViewSourceStore } from "./sidebar/sidebarView";
import { SidebarProvider } from "./ui/sidebar";

const laptop = EnvironmentId.make("env-laptop");
const server = EnvironmentId.make("env-server");
// Fixed instants; snoozes wake far in the future so the real clock never reaches them.
const NOW = "2026-10-23T12:00:00.000Z";
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

// Everything the sidebar reads is a subscription in the app; the mocks notify the same way.
const data = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let snapshot = {
    threads: [] as unknown[],
    groups: [] as unknown[],
    projects: [] as unknown[],
    installations: [] as unknown[],
    route: null as { environmentId: string; threadId: string } | null,
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

vi.mock("../state/environments", async (original) => ({
  ...(await original<object>()),
  useEnvironmentIdentities: () => [
    { environmentId: "env-laptop", label: "Laptop" },
    { environmentId: "env-server", label: "Server" },
  ],
  useConnectedEnvironmentIds: () => ["env-laptop", "env-server"],
  useEnvironmentMachines: () => new Map(),
  usePrimaryEnvironmentId: () => "env-laptop",
}));
vi.mock("../state/entities", async (original) => {
  const { useSyncExternalStore } = await import("react");
  const capabilities = {
    threadSettlement: true,
    threadSnooze: true,
    threadPinning: true,
    threadPinReorder: true,
  };
  const configs = new Map(
    ["env-laptop", "env-server"].map((id) => [
      id,
      { environment: { capabilities }, scratchWorkspaceRoot: null },
    ]),
  );
  return {
    ...(await original<object>()),
    readThreadShell: () => null,
    useAllEnvironmentProjectSnapshotsReady: () => true,
    useProjects: () => useSyncExternalStore(data.subscribe, () => data.read().projects),
    useServerConfigs: () => configs,
    useQuietThreadShells: () => useSyncExternalStore(data.subscribe, () => data.read().threads),
  };
});
vi.mock("../hooks/useSidebarProjectGroups", async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original<object>()),
    useSidebarProjectGroups: () => useSyncExternalStore(data.subscribe, () => data.read().groups),
  };
});
vi.mock("../hooks/useThreadRouteTarget", async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original<object>()),
    useThreadRouteTarget: () => {
      const route = useSyncExternalStore(data.subscribe, () => data.read().route);
      return route === null ? null : { kind: "server", threadRef: route };
    },
  };
});
vi.mock("../state/plugins", async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original<object>()),
    usePluginCatalogue: () => ({
      availability: "available",
      loaded: true,
      error: null,
      installations: useSyncExternalStore(data.subscribe, () => data.read().installations),
      executionDisabled: false,
    }),
  };
});
vi.mock("../state/presentation", async (original) => ({
  ...(await original<object>()),
  environmentPresentations: {
    providersByEnvironmentAtom: Atom.make(new Map()),
    serverConfigsAtom: Atom.make(new Map()),
  },
}));
vi.mock("../state/server", async (original) => ({
  ...(await original<object>()),
  primaryServerKeybindingsAtom: Atom.make([]),
}));
vi.mock("../state/projects", async (original) => ({
  ...(await original<object>()),
  environmentProjects: { projectConfigsReadyAtom: Atom.make(true) },
}));
vi.mock("../state/threads", async (original) => ({
  ...(await original<object>()),
  threadEnvironment: { updateMetadata: {} },
}));
vi.mock("../state/queries", async (original) => ({
  ...(await original<object>()),
  useThreadSearch: () => ({ matches: [], isPending: false }),
}));
vi.mock("../state/use-orchestration-command", async (original) => ({
  ...(await original<object>()),
  useOrchestrationCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("../state/session", async (original) => ({
  ...(await original<object>()),
  readEnvironmentScope: () => true,
}));
vi.mock("../hooks/useThreadActions", async (original) => ({
  ...(await original<object>()),
  useThreadActions: () => ({}),
  useAcknowledgeThreadWoke: () => () => {},
}));
vi.mock("../hooks/useHandleNewThread", async (original) => ({
  ...(await original<object>()),
  useHandleNewThread: () => ({
    handleNewThread: async () => {},
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
  }),
}));
vi.mock("./plugins/usePluginThreadMenu", () => ({ usePluginThreadMenu: () => () => [] }));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));
vi.mock("./sidebar/SidebarDraftBlock", () => ({ SidebarDraftBlock: () => null }));
vi.mock("./chat/ThreadContextDragGhost", () => ({ ThreadContextDragGhost: () => null }));
vi.mock("./ProjectFavicon", () => ({ ProjectFavicon: () => null }));
// Rows are the native row component in the app; here they expose only what this test reads.
vi.mock("./sidebar/SidebarThreadRow", () => ({
  SIDEBAR_SORTABLE_DRAG_DISABLED: { draggable: true },
  draftSurfaceClassName: "",
  draftPenClassName: "",
  SortableThreadRow: (props: {
    thread: Thread;
    isActive: boolean;
    variant: string;
    variantAction: string;
  }) => (
    <li
      data-testid="thread-row"
      data-variant={props.variant}
      data-action={props.variantAction}
      aria-current={props.isActive ? "page" : undefined}
    >
      {props.thread.title}
    </li>
  ),
  SidebarSearchResultRow: () => null,
}));

const project = (environmentId: EnvironmentId, id: string, title: string) => ({
  id: ProjectId.make(id),
  environmentId,
  title,
  workspaceRoot: `/work/${id}`,
  createdAt: NOW,
  updatedAt: NOW,
});
const group = (
  projectKey: string,
  displayName: string,
  members: ReturnType<typeof project>[],
): SidebarProjectSnapshot =>
  ({
    ...members[0]!,
    projectKey,
    displayName,
    groupedProjectCount: members.length,
    environmentPresence: "local-only",
    allRemoteMembersAreDesktopLocal: false,
    allRemoteMembersAreWsl: false,
    memberProjects: members,
    memberProjectRefs: members.map((member) => ({
      environmentId: member.environmentId,
      projectId: member.id,
    })),
    remoteEnvironmentLabels: [],
  }) as unknown as SidebarProjectSnapshot;
const thread = (
  id: string,
  environmentId: EnvironmentId,
  projectId: string,
  overrides: Partial<Thread> = {},
) =>
  makeThreadFixture({
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make(projectId),
    title: id,
    updatedAt: NOW,
    ...overrides,
  });
const settled = { settledOverride: "settled" as const, settledAt: NOW };
const routeTo = (value: Thread): ScopedThreadRef => scopeThreadRef(value.environmentId, value.id);

function projectsPlugin(enabled = true): PluginInstallation {
  const digest = "a".repeat(64);
  return {
    installationId: "inst-projects",
    generation: "gen-1",
    manifest: {
      id: "zeus-deus.projects",
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
    enabled,
    consentedDigest: digest,
    status: enabled ? "idle" : "disabled",
    error: null,
    settings: {},
    grants: { capabilities: ["ui.sidebar-views"], projectIds: [] },
    updatedAt: NOW,
  };
}

/** Laptop and server both have a project with id `p1`; only the grouped one shares a heading. */
function setup(input: { threads: Thread[]; route: Thread | null; chooseProjects?: boolean }) {
  window.localStorage.clear();
  useSidebarViewSourceStore.setState({ sources: new Map() });
  const app = [project(laptop, "p1", "App"), project(server, "p9", "App")];
  const docs = [project(server, "p1", "Docs")];
  data.update({
    threads: input.threads,
    projects: [...app, ...docs],
    groups: [group("repo:app", "App", app), group("server:p1", "Docs", docs)],
    installations: [projectsPlugin()],
    route: input.route === null ? null : routeTo(input.route),
  });
  if (input.chooseProjects !== false) {
    window.localStorage.setItem(
      "t3code:sidebar:view",
      JSON.stringify({
        key: pluginSidebarViewKey("zeus-deus.projects", "projects"),
        environmentId: laptop,
        pluginName: "Projects",
        view: { id: "projects", title: "Projects", groupBy: "project" },
      }),
    );
  }
}

const renderSidebar = () =>
  render(
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>,
  );
const sectionNames = () =>
  page
    .getByTestId("sidebar-project-section")
    .elements()
    .map((element) => element.getAttribute("data-project-key"));
const rowTitles = () =>
  page
    .getByTestId("thread-row")
    .elements()
    .map((element) => element.textContent);

describe("Sidebar project view", () => {
  it("groups live threads under environment-scoped projects and keeps parked ones on the shelves", async () => {
    const a1 = thread("a1", laptop, "p1");
    const a2 = thread("a2", server, "p9", { pinnedAt: NOW });
    const d1 = thread("d1", server, "p1");
    const s1 = thread("s1", laptop, "p1", settled);
    setup({ threads: [a1, a2, d1, s1], route: a1 });
    await using _screen = await renderSidebar();

    await expect.element(page.getByRole("button", { name: "App, 2 active" })).toBeVisible();
    expect(sectionNames()).toEqual(["repo:app", "server:p1"]);
    // Pinned first within its project; the laptop and server `p1` stay apart.
    expect(rowTitles()).toEqual(["a2", "a1", "d1"]);
    await expect
      .element(page.getByTestId("sidebar-settled-shelf-toggle"))
      .toHaveTextContent("Settled (1)");
    await expect.element(page.getByText("a1")).toHaveAttribute("aria-current", "page");
  });

  it("keeps the open settled thread visible while its shelf is closed or paged", async () => {
    const live = thread("live", laptop, "p1");
    const parked = Array.from({ length: 14 }, (_, index) =>
      thread(`old-${index}`, laptop, "p1", {
        ...settled,
        settledAt: new Date(Date.parse(NOW) - (index + 1) * 60_000).toISOString(),
      }),
    );
    const open = parked.at(-1)!;
    setup({ threads: [live, ...parked], route: open });
    await using _screen = await renderSidebar();

    await expect.element(page.getByText(open.title)).toHaveAttribute("aria-current", "page");
    expect(rowTitles()).toEqual(["live", open.title]);

    await userEvent.click(page.getByTestId("sidebar-settled-shelf-toggle"));
    // Ten per page, and the open thread is pulled in from beyond the page.
    await expect.element(page.getByText("old-9")).toBeVisible();
    expect(rowTitles()).toHaveLength(1 + 10 + 1);
    await expect.element(page.getByText(open.title)).toHaveAttribute("aria-current", "page");
  });

  it("keeps the open snoozed thread visible under its closed shelf", async () => {
    const live = thread("live", laptop, "p1");
    const snoozed = thread("napping", server, "p1", {
      snoozedAt: NOW,
      snoozedUntil: FAR_FUTURE,
    });
    setup({ threads: [live, snoozed], route: snoozed });
    await using _screen = await renderSidebar();

    await expect
      .element(page.getByTestId("sidebar-snoozed-shelf-toggle"))
      .toHaveTextContent("Snoozed (1)");
    await expect.element(page.getByText("napping")).toHaveAttribute("aria-current", "page");
    // Its project keeps a heading even though nothing there is live.
    expect(sectionNames()).toEqual(["repo:app", "server:p1"]);
  });

  it("folds a project to its open thread and remembers the fold", async () => {
    const a1 = thread("a1", laptop, "p1");
    const a2 = thread("a2", laptop, "p1");
    setup({ threads: [a1, a2], route: a2 });
    await using _screen = await renderSidebar();

    await userEvent.click(page.getByRole("button", { name: "App, 2 active" }));
    await expect
      .element(page.getByRole("button", { name: "App, 2 active" }))
      .toHaveAttribute("aria-expanded", "false");
    expect(rowTitles()).toEqual(["a2"]);
    expect(window.localStorage.getItem("t3code:sidebar:project-folds")).toBe('["repo:app"]');
  });

  it("falls back to activity when the plugin is disabled, keeping the open thread", async () => {
    const a1 = thread("a1", laptop, "p1");
    const s1 = thread("s1", laptop, "p1", settled);
    setup({ threads: [a1, s1], route: s1 });
    await using _screen = await renderSidebar();
    await expect
      .element(page.getByRole("button", { name: "Projects", exact: true }))
      .toHaveAttribute("aria-pressed", "true");

    await act(() => data.update({ installations: [projectsPlugin(false)] }));
    await expect.poll(sectionNames).toEqual([]);
    expect(page.getByRole("group", { name: "Sidebar view" }).elements()).toHaveLength(0);
    await expect.element(page.getByText("s1")).toHaveAttribute("aria-current", "page");
    expect(rowTitles()).toEqual(["a1", "s1"]);

    await act(() => data.update({ installations: [projectsPlugin()] }));
    await expect.poll(sectionNames).toEqual(["repo:app"]);
  });

  it("offers the view without switching to it", async () => {
    const a1 = thread("a1", laptop, "p1");
    setup({ threads: [a1], route: a1, chooseProjects: false });
    await using _screen = await renderSidebar();
    await expect.element(page.getByRole("button", { name: "Projects", exact: true })).toBeVisible();
    expect(sectionNames()).toEqual([]);

    await userEvent.click(page.getByRole("button", { name: "Projects", exact: true }));
    await expect.poll(sectionNames).toEqual(["repo:app"]);
    await expect.element(page.getByText("a1")).toHaveAttribute("aria-current", "page");
  });
});
