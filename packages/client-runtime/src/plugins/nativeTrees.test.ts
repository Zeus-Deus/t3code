import { EnvironmentId, ProjectId, ThreadId, type PluginTreeNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopeThreadRef } from "../environment/scoped.ts";

import {
  buildPluginTreeLayout,
  PLUGIN_TREE_OTHER_SECTION_KEY,
  pluginTreeNotice,
  pluginTreeFamilyRoots,
  pluginTreeConversationThreadKeys,
  pluginTreeThreadKeys,
  togglePluginTreeFold,
  type PluginTreeSource,
} from "./nativeTrees.ts";

const local = EnvironmentId.make("env-local");
const remote = EnvironmentId.make("env-remote");

interface Thread {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly lineage: { readonly parentThreadId: ThreadId | null };
}

const thread = (id: string, environmentId = local, parent: string | null = null): Thread => ({
  id: ThreadId.make(id),
  environmentId,
  lineage: { parentThreadId: parent === null ? null : ThreadId.make(id === parent ? id : parent) },
});
const key = (entry: Pick<Thread, "id" | "environmentId">) => `${entry.environmentId}:${entry.id}`;

const group = (id: string, title: string, parentId?: string, collapsed?: boolean): PluginTreeNode =>
  ({
    id,
    kind: "group",
    title,
    ...(parentId === undefined ? {} : { parentId }),
    ...(collapsed === undefined ? {} : { collapsedByDefault: collapsed }),
  }) as PluginTreeNode;
const project = (id: string, projectId: string, parentId?: string): PluginTreeNode => ({
  id,
  kind: "project",
  projectId: ProjectId.make(projectId),
  ...(parentId === undefined ? {} : { parentId }),
});
const conversation = (
  id: string,
  projectId: string,
  target: { readonly threadId: string } | { readonly actionId: string },
): PluginTreeNode => ({
  id,
  kind: "project",
  projectId: ProjectId.make(projectId),
  ...("threadId" in target ? { threadId: ThreadId.make(target.threadId) } : target),
});
const placed = (id: string, threadId: string, parentId?: string): PluginTreeNode => ({
  id,
  kind: "thread",
  threadId: ThreadId.make(threadId),
  ...(parentId === undefined ? {} : { parentId }),
});

function layout(input: {
  readonly sources: ReadonlyArray<PluginTreeSource>;
  readonly threads: ReadonlyArray<Thread>;
  readonly parked?: ReadonlyArray<Thread>;
  readonly folds?: ReadonlyArray<string>;
  readonly route?: Thread;
  readonly emptyProjects?: boolean;
}) {
  const parked = new Set((input.parked ?? []).map(key));
  return buildPluginTreeLayout({
    sources: input.sources,
    threads: input.threads,
    liveThreadKeys: new Set(input.threads.map(key).filter((entry) => !parked.has(entry))),
    // Both environments' "app" projects are one logical project to the host.
    project: (environmentId, projectId) =>
      projectId === "missing"
        ? null
        : {
            key: projectId.startsWith("app") ? "logical:app" : `${environmentId}:${projectId}`,
            project: { name: projectId },
          },
    showsEmptyProject: () => input.emptyProjects === true,
    folds: new Set(input.folds ?? []),
    routeThreadKey: input.route === undefined ? null : key(input.route),
  });
}

const outline = (result: ReturnType<typeof layout>) =>
  result.sections.map((section) => {
    const title =
      section.heading === null
        ? "-"
        : section.heading.kind === "group"
          ? section.heading.title
          : section.heading.kind === "project"
            ? section.heading.project.name
            : "Other";
    const rows = (entries: typeof section.rows): unknown[] =>
      entries.map((row) =>
        row.children.length === 0 ? row.thread.id : { [row.thread.id]: rows(row.children) },
      );
    return `${"  ".repeat(section.depth)}${title}${section.folded ? " (folded)" : ""} ${section.count}: ${JSON.stringify(rows(section.rows))}`;
  });

describe("pluginTreeFamilyRoots", () => {
  const listed = (id: string, root: string, environmentId = local) => ({
    id: ThreadId.make(id),
    environmentId,
    lineage: { rootThreadId: ThreadId.make(root) },
  });

  it("loads a missing worker through its nearest listed ancestor, across headings and missing rows", () => {
    expect(
      pluginTreeFamilyRoots({
        sources: [
          {
            environmentId: local,
            nodes: [
              placed("worker", "idle-worker", "missing-parent"),
              placed("missing-parent", "idle-parent", "shelf"),
              group("shelf", "Review", "coordinator"),
              placed("coordinator", "coordinator", "unrelated"),
              placed("unrelated", "unrelated"),
            ],
          },
        ],
        threads: [listed("coordinator", "family-root"), listed("unrelated", "other-root")],
      }),
    ).toEqual([scopeThreadRef(local, ThreadId.make("family-root"))]);
  });

  it("mounts each root once per environment and never borrows another environment's ancestor", () => {
    const nodes = [
      placed("root", "root"),
      placed("one", "one", "root"),
      placed("two", "two", "root"),
    ];
    expect(
      pluginTreeFamilyRoots({
        sources: [
          { environmentId: local, nodes },
          { environmentId: local, nodes },
          { environmentId: remote, nodes },
        ],
        threads: [listed("root", "root"), listed("root", "root", remote)],
      }),
    ).toEqual([
      scopeThreadRef(local, ThreadId.make("root")),
      scopeThreadRef(remote, ThreadId.make("root")),
    ]);
    expect(
      pluginTreeFamilyRoots({
        sources: [{ environmentId: remote, nodes }],
        threads: [listed("root", "root")],
      }),
    ).toEqual([]);
  });

  it("does not load fully listed trees, unanchored references or malformed parent chains", () => {
    expect(
      pluginTreeFamilyRoots({
        sources: [
          {
            environmentId: local,
            nodes: [
              placed("root", "root"),
              placed("listed", "listed", "root"),
              placed("unanchored", "unanchored"),
              placed("broken", "broken", "absent"),
              placed("cycle-a", "cycle-a", "cycle-b"),
              group("cycle-b", "Cycle", "cycle-a"),
            ],
          },
        ],
        threads: [listed("root", "root"), listed("listed", "root")],
      }),
    ).toEqual([]);
    expect(pluginTreeFamilyRoots({ sources: [], threads: [listed("root", "root")] })).toEqual([]);
  });

  it("anchors missing workers on a granted project heading's conversation thread", () => {
    const nodes = [
      conversation("p", "web", { threadId: "coordinator" }),
      placed("w", "worker", "p"),
    ];
    const threads = [listed("coordinator", "family-root")];
    expect(
      pluginTreeFamilyRoots({
        sources: [{ environmentId: local, conversations: true, nodes }],
        threads,
      }),
    ).toEqual([scopeThreadRef(local, ThreadId.make("family-root"))]);
    expect(pluginTreeFamilyRoots({ sources: [{ environmentId: local, nodes }], threads })).toEqual(
      [],
    );
    expect(
      pluginTreeConversationThreadKeys([
        { environmentId: local, conversations: true, nodes },
        { environmentId: remote, nodes },
      ]),
    ).toEqual(new Set([`${local}:coordinator`]));
  });

  it("keeps a loaded family mounted while its placed workers are still missing from the shell", () => {
    const root = listed("root", "root");
    const parent = listed("parent", "root");
    const worker = listed("worker", "root");
    const sources = [
      {
        environmentId: local,
        nodes: [
          placed("root", "root"),
          placed("parent", "parent", "root"),
          placed("worker", "worker", "parent"),
        ],
      },
    ];
    const shellThreadKeys = new Set([key(root)]);
    const before = pluginTreeFamilyRoots({ sources, threads: [root], shellThreadKeys });
    expect(before).toEqual([scopeThreadRef(local, root.id)]);
    expect(
      pluginTreeFamilyRoots({ sources, threads: [root, parent, worker], shellThreadKeys }),
    ).toEqual(before);
    expect(
      pluginTreeFamilyRoots({
        sources,
        threads: [root, parent, worker],
        shellThreadKeys: new Set([root, parent, worker].map(key)),
      }),
    ).toEqual([]);
    // An ancestor loaded from a shelf or the route can anchor a tree that does not place the root.
    expect(
      pluginTreeFamilyRoots({
        sources: [{ environmentId: local, nodes: sources[0]!.nodes.slice(1) }],
        threads: [root, parent],
        shellThreadKeys,
      }),
    ).toEqual(before);
  });
});

describe("buildPluginTreeLayout", () => {
  it("nests groups, projects and display children in the plugin's order", () => {
    const threads = [thread("a"), thread("b"), thread("c"), thread("d")];
    const result = layout({
      sources: [
        {
          environmentId: local,
          nodes: [
            group("pinned", "Pinned"),
            placed("n-a", "a", "pinned"),
            project("p", "web"),
            placed("n-b", "b", "p"),
            // A launched thread shown under the thread it came from.
            placed("n-c", "c", "n-b"),
            group("later", "Later", "p"),
            placed("n-d", "d", "later"),
          ],
        },
      ],
      threads,
    });
    expect(outline(result)).toEqual([
      'Pinned 1: ["a"]',
      'web 3: [{"b":["c"]}]',
      '  Later 1: ["d"]',
    ]);
    expect(pluginTreeThreadKeys(result.sections)).toEqual(threads.map(key));
  });

  it("merges root projects only through the host's logical grouping, never by node id", () => {
    const result = layout({
      sources: [
        {
          environmentId: local,
          nodes: [project("p", "app-local"), placed("t", "one", "p"), group("g", "Mine")],
        },
        {
          environmentId: remote,
          nodes: [
            project("p", "app-remote"),
            placed("t", "two", "p"),
            group("g", "Mine"),
            placed("u", "three", "g"),
          ],
        },
      ],
      threads: [thread("one"), thread("two", remote), thread("three", remote)],
    });
    expect(outline(result)).toEqual(['app-local 2: ["one","two"]', 'Mine 1: ["three"]']);
    expect(result.sections.map((section) => section.key)).toEqual([
      "project:logical:app",
      `tree:${remote}:g`,
    ]);
  });

  it("makes a project heading its conversation: never a row, first in order, workers under it", () => {
    const coordinator = thread("coordinator");
    const placedWorker = thread("placed", local, "coordinator");
    const newWorker = thread("new", local, "coordinator");
    const doneWorker = thread("done", local, "coordinator");
    const sources = [
      {
        environmentId: local,
        conversations: true,
        nodes: [
          // A row naming the heading's thread first still leaves it to the heading.
          placed("dup", "coordinator"),
          conversation("p", "web", { threadId: "coordinator" }),
          placed("w", "placed", "p"),
          group("done", "Done", "p", true),
          placed("d", "done", "done"),
        ],
      },
    ];
    const threads = [newWorker, coordinator, placedWorker, doneWorker];
    const result = layout({ sources, threads });
    expect(outline(result)).toEqual(['web 3: ["placed","new"]', "  Done (folded) 1: []"]);
    const heading = result.sections[0]?.heading;
    expect(heading?.kind === "project" ? heading.conversation : null).toEqual({
      kind: "thread",
      environmentId: local,
      thread: coordinator,
      key: key(coordinator),
    });
    expect(pluginTreeThreadKeys(result.sections)).toEqual(
      [coordinator, placedWorker, newWorker].map(key),
    );
    expect(result.placedKeys).toEqual(new Set(threads.map(key)));

    // Folded, the heading keeps its thread in order and shows only an open worker.
    const folded = layout({ sources, threads, folds: [`project:${local}:web`], route: doneWorker });
    expect(outline(folded)).toEqual(['web (folded) 3: ["done"]']);
    expect(pluginTreeThreadKeys(folded.sections)).toEqual([coordinator, doneWorker].map(key));
    const onHeading = layout({
      sources,
      threads,
      folds: [`project:${local}:web`],
      route: coordinator,
    });
    expect(outline(onHeading)).toEqual(["web (folded) 3: []"]);
    expect(pluginTreeThreadKeys(onHeading.sections)).toEqual([key(coordinator)]);

    // A conversation with no workers yet still shows; without the grant it is a plain heading.
    expect(outline(layout({ sources, threads: [coordinator] }))).toEqual(["web 0: []"]);
    const ungranted = layout({ sources: [{ ...sources[0]!, conversations: false }], threads });
    expect(outline(ungranted)).toEqual([
      '- 2: [{"coordinator":["new"]}]',
      'web 2: ["placed"]',
      "  Done (folded) 1: []",
    ]);
  });

  it("opens an action from a heading only while its project belongs in scope", () => {
    const sources = [
      {
        environmentId: local,
        conversations: true,
        nodes: [conversation("p", "web", { actionId: "open-project" })],
      },
    ];
    expect(outline(layout({ sources, threads: [] }))).toEqual([]);
    const result = layout({ sources, threads: [], emptyProjects: true });
    const heading = result.sections[0]?.heading;
    expect(heading?.kind === "project" ? heading.conversation : null).toEqual({
      kind: "action",
      environmentId: local,
      projectId: "web",
      actionId: "open-project",
    });
    expect(pluginTreeThreadKeys(result.sections)).toEqual([]);
  });

  it("splits a merged project into named headings when several environments give it a conversation", () => {
    const localCoordinator = thread("lc");
    const remoteCoordinator = thread("rc", remote);
    const both = layout({
      sources: [
        {
          environmentId: local,
          conversations: true,
          nodes: [conversation("p", "app-local", { threadId: "lc" })],
        },
        {
          environmentId: remote,
          conversations: true,
          nodes: [conversation("p", "app-remote", { actionId: "open-project" })],
        },
      ],
      threads: [localCoordinator],
      emptyProjects: true,
    });
    expect(
      both.sections.map((section) =>
        section.heading?.kind === "project"
          ? [section.key, section.heading.environmentId, section.heading.conversation?.kind]
          : null,
      ),
    ).toEqual([
      [`project:logical:app\0${local}`, local, "thread"],
      [`project:logical:app\0${remote}`, remote, "action"],
    ]);
    // One conversation is unambiguous: the logical project stays one heading.
    const one = layout({
      sources: [
        {
          environmentId: local,
          conversations: true,
          nodes: [project("p", "app-local"), placed("t", "one", "p")],
        },
        {
          environmentId: remote,
          conversations: true,
          nodes: [conversation("p", "app-remote", { threadId: "rc" })],
        },
      ],
      threads: [thread("one"), remoteCoordinator],
    });
    expect(outline(one)).toEqual(['app-local 1: ["one"]']);
    const heading = one.sections[0]?.heading;
    expect(heading?.kind === "project" ? heading.environmentId : null).toBeUndefined();
    expect(pluginTreeThreadKeys(one.sections)).toEqual([key(remoteCoordinator), `${local}:one`]);
  });

  it("skips references the host does not list and lifts their children", () => {
    const result = layout({
      sources: [
        {
          environmentId: local,
          nodes: [
            project("gone", "missing"),
            placed("n-hidden", "archived", "gone"),
            placed("n-a", "a", "n-hidden"),
            // Already placed: a second reference does not duplicate the row.
            placed("n-a-again", "a"),
            placed("n-other-env", "b"),
          ],
        },
      ],
      threads: [thread("a"), thread("b", remote)],
    });
    expect(outline(result)).toEqual(['- 1: ["a"]', 'Other 1: ["b"]']);
  });

  it("keeps every listed thread reachable when the tree leaves it out", () => {
    const parent = thread("parent");
    const fork = thread("fork", local, "parent");
    const loose = thread("loose");
    const snoozed = thread("snoozed");
    const result = layout({
      sources: [
        { environmentId: local, nodes: [group("g", "Work"), placed("n-parent", "parent", "g")] },
      ],
      threads: [parent, fork, loose, snoozed],
      parked: [snoozed],
    });
    expect(outline(result)).toEqual(['Work 2: [{"parent":["fork"]}]', 'Other 1: ["loose"]']);
    // The snoozed thread stays on the host's shelf.
    expect([...result.placedKeys]).toEqual([key(parent), key(fork)]);
  });

  it("folds to the open thread, honouring the plugin default until the person chooses", () => {
    const threads = [thread("a"), thread("b"), thread("c")];
    const nodes = [
      group("quiet", "Quiet projects", undefined, true),
      project("p", "web", "quiet"),
      placed("n-a", "a", "p"),
      placed("n-b", "b", "p"),
      group("now", "Now"),
      placed("n-c", "c", "now"),
    ];
    const sources = [{ environmentId: local, nodes }];
    expect(outline(layout({ sources, threads, route: threads[1]! }))).toEqual([
      'Quiet projects (folded) 2: ["b"]',
      'Now 1: ["c"]',
    ]);
    const quietKey = `tree:${local}:quiet`;
    const opened = togglePluginTreeFold([], quietKey, true);
    expect(outline(layout({ sources, threads, folds: opened }))).toEqual([
      "Quiet projects 2: []",
      '  web 2: ["a","b"]',
      'Now 1: ["c"]',
    ]);
    // Toggling back returns to the plugin's default without leaving an entry behind.
    expect(togglePluginTreeFold(opened, quietKey, true)).toEqual([]);
    expect(
      outline(
        layout({ sources, threads, folds: togglePluginTreeFold([], `tree:${local}:now`, false) }),
      ),
    ).toEqual(["Quiet projects (folded) 2: []", "Now (folded) 1: []"]);
  });

  it("hides empty groups, and shows empty projects only where the host scope wants them", () => {
    const sources = [
      { environmentId: local, nodes: [group("empty", "Nothing"), project("p", "web")] },
    ];
    expect(outline(layout({ sources, threads: [] }))).toEqual([]);
    expect(outline(layout({ sources, threads: [], emptyProjects: true }))).toEqual(["web 0: []"]);
  });

  it("keeps rows listed after a nested heading in their place", () => {
    const result = layout({
      sources: [
        {
          environmentId: local,
          nodes: [
            group("g", "Work"),
            placed("n-a", "a", "g"),
            group("h", "Nested", "g"),
            placed("n-b", "b", "h"),
            placed("n-c", "c", "g"),
          ],
        },
      ],
      threads: [thread("a"), thread("b"), thread("c")],
    });
    expect(outline(result)).toEqual(['Work 3: ["a"]', '  Nested 1: ["b"]', '  - 1: ["c"]']);
    // "c" is Work's row, so it lines up with "a" rather than with Nested's rows.
    const rowDepthOf = (id: string) =>
      result.sections.find((section) => section.rows.some((row) => row.thread.id === id))?.rowDepth;
    expect([rowDepthOf("a"), rowDepthOf("b"), rowDepthOf("c")]).toEqual([1, 2, 1]);
  });

  it("puts a merged project's own rows before its nested headings", () => {
    // Each environment's shape from a Projects-style tree: live rows, then a folded shelf.
    const projectTree = (projectId: string, live: string, parked: string) => [
      project("p", projectId),
      placed("n-live", live, "p"),
      group("shelf", "Snoozed", "p", true),
      placed("n-parked", parked, "shelf"),
    ];
    const result = layout({
      sources: [
        { environmentId: local, nodes: projectTree("app-local", "a", "s") },
        { environmentId: remote, nodes: projectTree("app-remote", "b", "r") },
      ],
      threads: [thread("a"), thread("s"), thread("b", remote), thread("r", remote)],
      parked: [thread("s"), thread("r", remote)],
    });
    // Groups never merge across environments, so each keeps its own shelf.
    expect(outline(result)).toEqual([
      'app-local 4: ["a","b"]',
      "  Snoozed (folded) 1: []",
      "  Snoozed (folded) 1: []",
    ]);
  });

  it("lists unplaced live threads with their own lineage, even through a cycle", () => {
    const result = layout({
      sources: [{ environmentId: local, nodes: [] }],
      threads: [
        thread("x", local, "y"),
        thread("y", local, "x"),
        thread("root"),
        thread("child", local, "root"),
      ],
    });
    expect(outline(result)).toEqual(['Other 4: [{"root":["child"]},{"x":["y"]}]']);
    expect(result.sections[0]?.key).toBe(PLUGIN_TREE_OTHER_SECTION_KEY);
  });

  it("places children listed before their parents, keeping each parent's own position", () => {
    const result = layout({
      sources: [
        {
          environmentId: local,
          nodes: [
            placed("n-c", "c", "n-b"),
            placed("n-a", "a", "g"),
            group("first", "First"),
            placed("n-d", "d", "first"),
            group("g", "Work"),
            placed("n-b", "b", "g"),
          ],
        },
      ],
      threads: [thread("a"), thread("b"), thread("c"), thread("d")],
    });
    expect(outline(result)).toEqual(['First 1: ["d"]', 'Work 3: ["a",{"b":["c"]}]']);
  });

  it("treats a parent cycle as unparented instead of losing its nodes", () => {
    const result = layout({
      sources: [
        {
          environmentId: local,
          nodes: [group("x", "X", "y"), group("y", "Y", "x"), placed("n-a", "a", "x")],
        },
      ],
      threads: [thread("a")],
    });
    expect(result.placedKeys.has(key(thread("a")))).toBe(true);
    expect(pluginTreeThreadKeys(result.sections)).toEqual([key(thread("a"))]);
  });
});

describe("pluginTreeNotice", () => {
  it("says nothing while every environment's last read succeeded or is still loading", () => {
    expect(pluginTreeNotice("Projects", [])).toBeNull();
    expect(
      pluginTreeNotice("Projects", [
        { failed: false, hasNodes: true },
        { failed: false, hasNodes: false },
      ]),
    ).toBeNull();
  });

  it("says the sidebar shows Activity only when no environment's tree is shown", () => {
    expect(pluginTreeNotice("Projects", [{ failed: true, hasNodes: false }])).toBe(
      "Couldn't load Projects. Showing Activity.",
    );
  });

  it("calls retained rows out of date rather than claiming Activity", () => {
    expect(pluginTreeNotice("Projects", [{ failed: true, hasNodes: true }])).toBe(
      "Projects may be out of date.",
    );
    expect(
      pluginTreeNotice("Projects", [
        { failed: true, hasNodes: true },
        { failed: false, hasNodes: true },
      ]),
    ).toBe("Projects may be out of date.");
  });

  it("calls the tree incomplete when one environment never served it but another did", () => {
    expect(
      pluginTreeNotice("Projects", [
        { failed: true, hasNodes: false },
        { failed: false, hasNodes: true },
      ]),
    ).toBe("Part of Projects couldn't load. It may be incomplete.");
  });
});
