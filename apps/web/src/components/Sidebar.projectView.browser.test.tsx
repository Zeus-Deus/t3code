import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { pluginSidebarTreeKey, pluginSidebarViewKey } from "@t3tools/client-runtime/plugins";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type PluginInstallation,
  type PluginTreeNode,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useUiStateStore } from "../uiStateStore";
import { PluginSidebarViewSources } from "./plugins/PluginCatalogueSubscriptions";
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
    // A plugin tree as each environment serves it, and how often it signalled a change.
    trees: new Map<string, unknown[]>(),
    treeRevision: 0,
    treeReads: [] as string[],
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
vi.mock("../state/use-atom-command", async (original) => {
  const actual = await original<typeof import("../state/use-atom-command")>();
  return {
    ...actual,
    useAtomCommand: (command: { label: string }, options?: never) => {
      const real = actual.useAtomCommand(command as never, options);
      if (command.label !== "environment-command:plugins:read-tree") return real;
      return async (request: { environmentId: string }) => {
        data.read().treeReads.push(request.environmentId);
        const nodes = data.read().trees.get(request.environmentId);
        return nodes === undefined
          ? { _tag: "Failure", cause: { _tag: "Fail", error: new Error("unavailable") } }
          : { _tag: "Success", value: { nodes } };
      };
    },
  };
});
vi.mock("../state/plugins", async (original) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await original<object>()),
    usePluginChangeRevision: (environmentId: string | null) => {
      const revision = useSyncExternalStore(data.subscribe, () => data.read().treeRevision);
      return environmentId === null ? null : revision;
    },
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
  primaryServerKeybindingsAtom: Atom.make([
    {
      command: "thread.next",
      shortcut: {
        key: "]",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
        modKey: false,
      },
    },
    {
      command: "thread.jump.2",
      shortcut: {
        key: "2",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        modKey: false,
      },
    },
  ]),
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
    jumpLabel: string | null;
    onThreadClick: (event: React.MouseEvent, ref: ScopedThreadRef) => void;
  }) => (
    <li
      data-testid="thread-row"
      data-thread-item={scopedThreadKey(
        scopeThreadRef(props.thread.environmentId, props.thread.id),
      )}
      data-variant={props.variant}
      data-action={props.variantAction}
      aria-current={props.isActive ? "page" : undefined}
      onClick={(event) =>
        props.onThreadClick(event, scopeThreadRef(props.thread.environmentId, props.thread.id))
      }
    >
      {props.thread.title}
      {props.jumpLabel ? <kbd>{props.jumpLabel}</kbd> : null}
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

type ProjectsRules = { emptyProjects?: "show" | "hide"; quietAfterDays?: number };
const projectsView = (rules: ProjectsRules) => ({
  id: "projects",
  title: "Projects",
  groupBy: "project" as const,
  ...rules,
});

function projectsPlugin(enabled = true, rules: ProjectsRules = {}): PluginInstallation {
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
      sidebarViews: [projectsView(rules)],
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
function setup(input: {
  threads: Thread[];
  route: Thread | null;
  chooseProjects?: boolean;
  rules?: ProjectsRules;
  scope?: string;
}) {
  window.localStorage.clear();
  useThreadSelectionStore.getState().clearSelection();
  useSidebarViewSourceStore.setState({ sources: new Map() });
  useUiStateStore.getState().setSidebarProjectScopeKey(input.scope ?? null);
  const app = [project(laptop, "p1", "App"), project(server, "p9", "App")];
  const docs = [project(server, "p1", "Docs")];
  data.update({
    threads: input.threads,
    projects: [...app, ...docs],
    groups: [group("repo:app", "App", app), group("server:p1", "Docs", docs)],
    installations: [projectsPlugin(true, input.rules)],
    route: input.route === null ? null : routeTo(input.route),
  });
  if (input.chooseProjects !== false) {
    window.localStorage.setItem(
      "t3code:sidebar:view",
      JSON.stringify({
        key: pluginSidebarViewKey("zeus-deus.projects", "projects"),
        environmentId: laptop,
        pluginName: "Projects",
        view: projectsView(input.rules ?? {}),
      }),
    );
  }
}

const renderSidebar = () =>
  render(
    <SidebarProvider>
      <PluginSidebarViewSources />
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

const rowLefts = () =>
  new Map(
    page
      .getByTestId("thread-row")
      .elements()
      .map((element) => [element.textContent, Math.round(element.getBoundingClientRect().left)]),
  );

describe("Sidebar project view", () => {
  it("nests forks and T3 delegations recursively, hiding provider subagents", async () => {
    const parent = thread("parent", laptop, "p1");
    const fork = thread("fork", laptop, "p1", {
      lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationshipToParent: "fork" },
    });
    const delegated = thread("delegated", laptop, "p1", {
      source: { ...parent.source, creationSource: "mcp" },
      lineage: {
        parentThreadId: fork.id,
        rootThreadId: parent.id,
        relationshipToParent: "subagent",
      },
    });
    const native = thread("native", laptop, "p1", {
      source: { ...parent.source, creationSource: "provider" },
      lineage: {
        parentThreadId: delegated.id,
        rootThreadId: parent.id,
        relationshipToParent: "subagent",
      },
    });
    const other = thread("other", laptop, "p1");
    setup({ threads: [delegated, fork, other, native, parent], route: delegated });
    await using _screen = await renderSidebar();
    expect(rowTitles()).toEqual(["other", "parent", "fork", "delegated"]);
    expect(page.getByText("native", { exact: true }).elements()).toHaveLength(0);
    await expect
      .element(page.getByText("delegated", { exact: true }))
      .toHaveAttribute("aria-current", "page");
    const forkRow = page.getByText("fork", { exact: true }).element();
    expect(
      forkRow.closest("[data-parent-thread-key]")?.getAttribute("data-parent-thread-key"),
    ).toBe(scopedThreadKey(routeTo(parent)));
    expect(
      page
        .getByText("delegated", { exact: true })
        .element()
        .closest("[data-parent-thread-key]")
        ?.getAttribute("data-parent-thread-key"),
    ).toBe(scopedThreadKey(routeTo(fork)));

    await act(() => data.update({ route: routeTo(native) }));
    await expect
      .element(page.getByText("delegated", { exact: true }))
      .toHaveAttribute("aria-current", "page");
    await act(() => data.update({ installations: [projectsPlugin(false)] }));
    expect(rowTitles()).toEqual(["fork", "other", "parent"]);
    await expect
      .element(page.getByText("fork", { exact: true }))
      .toHaveAttribute("aria-current", "page");
    await act(() => data.update({ installations: [projectsPlugin()] }));
    expect(rowTitles()).toEqual(["other", "parent", "fork", "delegated"]);

    await userEvent.click(page.getByRole("button", { name: "App, 4 active" }));
    expect(rowTitles()).toEqual(["delegated"]);
    await expect
      .element(page.getByText("delegated", { exact: true }))
      .toHaveAttribute("aria-current", "page");
  });

  it("uses nested visual order for keyboard traversal, jump hints, and range selection", async () => {
    const parent = thread("parent", laptop, "p1", { activeOrderKey: "b" });
    const child = thread("child", laptop, "p1", {
      activeOrderKey: "a",
      lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationshipToParent: "fork" },
    });
    const other = thread("other", laptop, "p1", { activeOrderKey: "c" });
    setup({ threads: [child, other, parent], route: parent });
    await using screen = await renderSidebar();
    using navigate = vi.spyOn(screen.router!, "navigate").mockResolvedValue(undefined);
    await act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "]", ctrlKey: true, shiftKey: true, bubbles: true }),
      ),
    );
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { environmentId: laptop, threadId: child.id } }),
    );
    await act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "2", ctrlKey: true, bubbles: true }),
      ),
    );
    expect(navigate).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: { environmentId: laptop, threadId: child.id } }),
    );
    await userEvent.keyboard("{Control>}");
    await expect
      .element(page.getByText("child", { exact: false }))
      .toHaveTextContent("childCtrl+2");
    await userEvent.keyboard("{/Control}");
    await act(() => useThreadSelectionStore.getState().setAnchor(scopedThreadKey(routeTo(parent))));
    await userEvent.keyboard("{Shift>}");
    await userEvent.click(page.getByText("child", { exact: true }));
    await userEvent.keyboard("{/Shift}");
    expect([...useThreadSelectionStore.getState().selectedThreadKeys]).toEqual(
      [parent, child].map((t) => scopedThreadKey(routeTo(t))),
    );
  });

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

  it("shows only the filtered project's heading, even with empty projects shown", async () => {
    const a1 = thread("a1", laptop, "p1");
    const d1 = thread("d1", server, "p1");
    setup({
      threads: [a1, d1],
      route: a1,
      rules: { emptyProjects: "show", quietAfterDays: 3 },
      scope: "repo:app",
    });
    await using _screen = await renderSidebar();

    await expect.element(page.getByRole("button", { name: "App, 1 active" })).toBeVisible();
    expect(sectionNames()).toEqual(["repo:app"]);
    expect(rowTitles()).toEqual(["a1"]);
    expect(page.getByTestId("sidebar-quiet-projects-toggle").elements()).toHaveLength(0);
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
      .element(page.getByRole("button", { name: "Toggle Projects view", exact: true }))
      .toHaveAttribute("aria-pressed", "true");

    using scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    await act(() => data.update({ installations: [projectsPlugin(false)] }));
    await expect.poll(sectionNames).toEqual([]);
    // The rows moved, so the open one is brought back into view.
    await expect
      .poll(() =>
        scrolled.mock.contexts.some((row) => row instanceof Element && row.textContent === "s1"),
      )
      .toBe(true);
    expect(page.getByRole("button", { name: "Toggle Projects view" }).elements()).toHaveLength(0);
    await expect.element(page.getByText("s1")).toHaveAttribute("aria-current", "page");
    expect(rowTitles()).toEqual(["a1", "s1"]);

    await act(() => data.update({ installations: [projectsPlugin()] }));
    await expect.poll(sectionNames).toEqual(["repo:app"]);
  });

  it("offers the view without switching to it", async () => {
    const a1 = thread("a1", laptop, "p1");
    setup({ threads: [a1], route: a1, chooseProjects: false });
    await using _screen = await renderSidebar();
    await expect
      .element(page.getByRole("button", { name: "Toggle Projects view", exact: true }))
      .toBeVisible();
    expect(sectionNames()).toEqual([]);

    await userEvent.click(page.getByRole("button", { name: "Toggle Projects view", exact: true }));
    await expect.poll(sectionNames).toEqual(["repo:app"]);
    await expect.element(page.getByText("a1")).toHaveAttribute("aria-current", "page");
  });
});

function treePlugin(enabled = true): PluginInstallation {
  const base = projectsPlugin(enabled);
  return {
    ...base,
    manifest: {
      ...base.manifest,
      capabilities: ["ui.native-trees", "threads.read"],
      sidebarViews: [],
      nativeTrees: [{ id: "focus", title: "Focus" }],
    },
    grants: { capabilities: ["ui.native-trees", "threads.read"], projectIds: [] },
  };
}

const treeGroup = (id: string, title: string, extra: Partial<PluginTreeNode> = {}) =>
  ({ id, kind: "group", title, ...extra }) as PluginTreeNode;
const treeProject = (id: string, projectId: string, parentId?: string): PluginTreeNode => ({
  id,
  kind: "project",
  projectId: ProjectId.make(projectId),
  ...(parentId === undefined ? {} : { parentId }),
});
const treeThread = (id: string, threadId: string, parentId?: string): PluginTreeNode => ({
  id,
  kind: "thread",
  threadId: ThreadId.make(threadId),
  ...(parentId === undefined ? {} : { parentId }),
});

function setupTree(input: {
  threads: Thread[];
  route: Thread | null;
  trees: ReadonlyMap<string, PluginTreeNode[]>;
}) {
  setup({ threads: input.threads, route: input.route, chooseProjects: false });
  data.update({
    installations: [treePlugin()],
    trees: new Map(input.trees),
    treeRevision: 0,
    treeReads: [],
  });
  window.localStorage.setItem(
    "t3code:sidebar:view",
    JSON.stringify({
      kind: "tree",
      key: pluginSidebarTreeKey("zeus-deus.projects", "focus"),
      environmentId: laptop,
      pluginId: "zeus-deus.projects",
      pluginName: "Projects",
      tree: { id: "focus", title: "Focus" },
    }),
  );
}

describe("Sidebar plugin tree", () => {
  it("renders the plugin's arrangement with native rows and keeps every thread reachable", async () => {
    const focus = thread("focus", laptop, "p1");
    const parent = thread("parent", server, "p9");
    const launched = thread("launched", server, "p9");
    const loose = thread("loose", laptop, "p1");
    const parkedPlaced = thread("parked-placed", laptop, "p1", settled);
    const parkedLoose = thread("parked-loose", laptop, "p1", settled);
    setupTree({
      threads: [focus, parent, launched, loose, parkedPlaced, parkedLoose],
      route: loose,
      trees: new Map([
        [
          laptop,
          [
            treeGroup("now", "Now"),
            treeThread("n1", "focus", "now"),
            treeThread("n2", "parked-placed", "now"),
          ],
        ],
        // The server's project groups with the laptop's App; the launched thread nests by display.
        [
          server,
          [
            treeProject("app", "p9"),
            treeThread("t1", "parent", "app"),
            treeThread("t2", "launched", "t1"),
          ],
        ],
      ]),
    });
    await using _screen = await renderSidebar();

    await expect
      .poll(sectionNames)
      .toEqual([`tree:${laptop}:now`, "project:repo:app", "\0plugin-tree-other"]);
    expect(rowTitles()).toEqual(["focus", "parked-placed", "parent", "launched", "loose"]);
    // The tree placed one settled thread; the other stays on the host's closed shelf.
    await expect
      .element(page.getByTestId("sidebar-settled-shelf-toggle"))
      .toHaveTextContent("Settled (1)");
    expect(
      document
        .querySelector(`[data-thread-item="${scopedThreadKey(routeTo(launched))}"]`)
        ?.closest("[data-parent-thread-key]")
        ?.getAttribute("data-parent-thread-key"),
    ).toBe(scopedThreadKey(routeTo(parent)));
    await expect.element(page.getByText("loose")).toHaveAttribute("aria-current", "page");
  });

  it("reads again only when the tree changes, and falls back to activity when withdrawn", async () => {
    const a = thread("a", laptop, "p1");
    const b = thread("b", laptop, "p1");
    setupTree({
      threads: [a, b],
      route: a,
      trees: new Map([[laptop, [treeGroup("g", "Mine"), treeThread("n", "a", "g")]]]),
    });
    await using _screen = await renderSidebar();
    await expect.poll(rowTitles).toEqual(["a", "b"]);
    const reads = data.read().treeReads.length;

    // Ordinary re-renders do not ask the plugin again.
    await act(() => data.update({ threads: [a, { ...b, title: "b" }] }));
    expect(data.read().treeReads).toHaveLength(reads);

    await act(() =>
      data.update({
        trees: new Map([[laptop, [treeGroup("g", "Mine"), treeThread("n", "b", "g")]]]),
        treeRevision: 1,
      }),
    );
    await expect.poll(rowTitles).toEqual(["b", "a"]);
    expect(data.read().treeReads.length).toBeGreaterThan(reads);

    await act(() => data.update({ installations: [treePlugin(false)] }));
    await expect.poll(sectionNames).toEqual([]);
    await expect.element(page.getByText("a")).toHaveAttribute("aria-current", "page");
  });

  it("lines up rows listed after a nested heading with the rows of the heading they continue", async () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => thread(id, laptop, "p1"));
    setupTree({
      threads: [a!, b!, c!],
      route: null,
      trees: new Map([
        [
          laptop,
          [
            treeGroup("work", "Work"),
            treeThread("n-a", "a", "work"),
            treeGroup("nested", "Nested", { parentId: "work" }),
            treeThread("n-b", "b", "nested"),
            treeThread("n-c", "c", "work"),
          ],
        ],
      ]),
    });
    await using _screen = await renderSidebar();
    await expect.poll(rowTitles).toEqual(["a", "b", "c"]);
    const left = rowLefts();
    expect(left.get("c")).toBe(left.get("a"));
    expect(left.get("b")).toBeGreaterThan(left.get("a")!);
  });

  it("keeps each environment's own rows of a merged project ahead of its shelves", async () => {
    const a = thread("a", laptop, "p1");
    const s = thread("s", laptop, "p1", settled);
    const b = thread("b", server, "p9");
    const r = thread("r", server, "p9", settled);
    // The shape a Projects-style tree serves per environment: live rows, then a folded shelf.
    const projectTree = (projectId: string, live: string, parked: string) => [
      treeProject("p", projectId),
      treeThread("t-live", live, "p"),
      treeGroup("shelf", "Settled", { parentId: "p", collapsedByDefault: true }),
      treeThread("t-parked", parked, "shelf"),
    ];
    setupTree({
      threads: [a, b, s, r],
      route: null,
      trees: new Map([
        [laptop, projectTree("p1", "a", "s")],
        [server, projectTree("p9", "b", "r")],
      ]),
    });
    await using _screen = await renderSidebar();
    await expect
      .poll(sectionNames)
      .toEqual(["project:repo:app", `tree:${laptop}:shelf`, `tree:${server}:shelf`]);
    // Both live rows come before either shelf heading and line up as the project's own rows.
    expect(
      [
        ...document.querySelectorAll(
          '[data-testid="sidebar-project-section"], [data-testid="thread-row"]',
        ),
      ].map((element) => element.getAttribute("data-project-key") ?? element.textContent),
    ).toEqual(["project:repo:app", "a", "b", `tree:${laptop}:shelf`, `tree:${server}:shelf`]);
    const left = rowLefts();
    expect(left.get("b")).toBe(left.get("a"));
  });

  it("folds as the plugin asks until the person chooses, keeping the open thread", async () => {
    const a = thread("a", laptop, "p1");
    const b = thread("b", laptop, "p1");
    setupTree({
      threads: [a, b],
      route: b,
      trees: new Map([
        [
          laptop,
          [
            treeGroup("quiet", "Quiet", { collapsedByDefault: true }),
            treeThread("n1", "a", "quiet"),
            treeThread("n2", "b", "quiet"),
          ],
        ],
      ]),
    });
    await using _screen = await renderSidebar();
    await expect.poll(rowTitles).toEqual(["b"]);

    await userEvent.click(page.getByRole("button", { name: "Quiet, 2 active" }));
    await expect.poll(rowTitles).toEqual(["a", "b"]);
    expect(window.localStorage.getItem("t3code:sidebar:project-folds")).toBe(
      JSON.stringify([`+tree:${laptop}:quiet`]),
    );
  });
});
