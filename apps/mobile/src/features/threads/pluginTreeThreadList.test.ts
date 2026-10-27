import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId, type PluginTreeNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import type { HomeProjectScope } from "../home/homeThreadList";
import { buildPluginTreeThreadListItems } from "./pluginTreeThreadList";

const laptop = EnvironmentId.make("env-laptop");
const NOW = "2026-10-23T12:00:00.000Z";

const thread = (id: string, overrides: Partial<EnvironmentThreadShell> = {}) =>
  makeThreadShellFixture({
    environmentId: laptop,
    id: ThreadId.make(id),
    title: id,
    projectId: ProjectId.make("p1"),
    ...overrides,
  });

const scope = {
  key: "repo:app",
  title: "App",
  projectRefs: [{ environmentId: laptop, projectId: ProjectId.make("p1") }],
} as unknown as HomeProjectScope;

const build = (nodes: PluginTreeNode[], threads: EnvironmentThreadShell[], folds: string[] = []) =>
  buildPluginTreeThreadListItems({
    sources: [{ environmentId: laptop, nodes }],
    threads,
    projectScopes: [scope],
    selectedProjectKey: null,
    folds: new Set(folds),
    selectedThreadKey: `${laptop}:b`,
    now: NOW,
    snoozeLabelNow: NOW,
  });

const outline = (result: ReturnType<typeof build>) =>
  result.items.map((item) =>
    item.type === "v2-tree-heading"
      ? `${item.depth}#${item.title}${item.folded ? " (folded)" : ""}`
      : item.type === "v2-thread"
        ? `${item.depth ?? 0}:${item.item.thread.title}:${item.item.variant}${item.showTrailingDivider ? "|" : ""}`
        : item.type,
  );

describe("buildPluginTreeThreadListItems", () => {
  it("lists headings and indented native rows, leaving unplaced threads to the caller", () => {
    const result = build(
      [
        { id: "app", kind: "project", projectId: ProjectId.make("p1") },
        { id: "a", kind: "thread", threadId: ThreadId.make("a"), parentId: "app" },
        { id: "b", kind: "thread", threadId: ThreadId.make("b"), parentId: "a" },
        { id: "done", kind: "group", title: "Done" },
        { id: "c", kind: "thread", threadId: ThreadId.make("c"), parentId: "done" },
      ],
      [
        thread("a"),
        thread("b"),
        thread("c", { settledOverride: "settled", settledAt: NOW }),
        thread("loose"),
      ],
    );
    expect(outline(result)).toEqual(["0#App", "1:a:card|", "2:b:card", "0#Done", "1:c:slim"]);
    expect([...result.placedKeys].toSorted()).toEqual([
      `${laptop}:a`,
      `${laptop}:b`,
      `${laptop}:c`,
    ]);
  });

  it("keeps folded headings in order with the open thread under them", () => {
    const result = build(
      [
        { id: "quiet", kind: "group", title: "Quiet", collapsedByDefault: true },
        { id: "a", kind: "thread", threadId: ThreadId.make("a"), parentId: "quiet" },
        { id: "later", kind: "group", title: "Later", collapsedByDefault: true },
        { id: "c", kind: "thread", threadId: ThreadId.make("c"), parentId: "later" },
        { id: "now", kind: "group", title: "Now" },
        { id: "b", kind: "thread", threadId: ThreadId.make("b"), parentId: "now" },
      ],
      [thread("a"), thread("b"), thread("c")],
    );
    expect(outline(result)).toEqual(["0#Quiet (folded)", "0#Later (folded)", "0#Now", "1:b:card"]);
  });

  it("names the earliest snooze end among the threads it placed", () => {
    const nodes: PluginTreeNode[] = [
      { id: "later", kind: "group", title: "Later", collapsedByDefault: true },
      { id: "a", kind: "thread", threadId: ThreadId.make("a"), parentId: "later" },
      { id: "b", kind: "thread", threadId: ThreadId.make("b"), parentId: "later" },
    ];
    const result = build(nodes, [
      thread("a", { snoozedAt: NOW, snoozedUntil: "2026-10-23T15:00:00.000Z" }),
      thread("b", { snoozedAt: NOW, snoozedUntil: "2026-10-23T13:00:00.000Z" }),
      // The caller's own list wakes threads the tree leaves out.
      thread("c", { snoozedAt: NOW, snoozedUntil: "2026-10-23T12:30:00.000Z" }),
    ]);
    expect(result.nextSnoozeWakeAt).toBe("2026-10-23T13:00:00.000Z");
    expect(build(nodes, [thread("a"), thread("b")]).nextSnoozeWakeAt).toBeNull();
  });

  it("lines up rows listed after a nested heading with the heading they continue", () => {
    const result = build(
      [
        { id: "work", kind: "group", title: "Work" },
        { id: "a", kind: "thread", threadId: ThreadId.make("a"), parentId: "work" },
        { id: "nested", kind: "group", title: "Nested", parentId: "work" },
        { id: "b", kind: "thread", threadId: ThreadId.make("b"), parentId: "nested" },
        { id: "c", kind: "thread", threadId: ThreadId.make("c"), parentId: "work" },
        { id: "d", kind: "thread", threadId: ThreadId.make("d") },
      ],
      [thread("a"), thread("b"), thread("c"), thread("d")],
    );
    expect(outline(result)).toEqual([
      "0#Work",
      "1:a:card",
      "1#Nested",
      "2:b:card|",
      "1:c:card|",
      "0:d:card",
    ]);
  });
  it("makes a granted project heading its conversation, workers under it and marked alike", () => {
    const remote = EnvironmentId.make("env-remote");
    const coordinator = thread("coordinator");
    const worker = thread("worker", {
      lineage: { ...coordinator.lineage, parentThreadId: coordinator.id },
    });
    const heading = (environmentId: EnvironmentId, conversation: object) =>
      ({
        id: "app",
        kind: "project",
        projectId: ProjectId.make(environmentId === laptop ? "p1" : "p9"),
        ...conversation,
      }) as PluginTreeNode;
    const result = buildPluginTreeThreadListItems({
      sources: [
        {
          environmentId: laptop,
          conversations: true,
          nodes: [heading(laptop, { threadId: coordinator.id })],
        },
        {
          environmentId: remote,
          conversations: true,
          nodes: [heading(remote, { actionId: "open-project" })],
        },
      ],
      threads: [coordinator, worker],
      projectScopes: [
        {
          ...scope,
          projectRefs: [...scope.projectRefs, { environmentId: remote, projectId: "p9" }],
        } as unknown as HomeProjectScope,
      ],
      selectedProjectKey: null,
      folds: new Set(),
      selectedThreadKey: `${laptop}:coordinator`,
      now: NOW,
      snoozeLabelNow: NOW,
      environmentLabel: (environmentId) => (environmentId === remote ? "Server" : "Laptop"),
    });
    // Two environments each give App a conversation, so each gets its own named heading.
    expect(outline(result)).toEqual(["0#App · Laptop", "1:worker:card", "0#App · Server"]);
    const [onLaptop, workerRow, onServer] = result.items;
    expect(onLaptop).toEqual(
      expect.objectContaining({
        selected: true,
        conversation: expect.objectContaining({ kind: "thread", thread: coordinator }),
      }),
    );
    expect(onServer).toEqual(
      expect.objectContaining({
        selected: false,
        conversation: {
          kind: "action",
          environmentId: remote,
          projectId: "p9",
          actionId: "open-project",
        },
      }),
    );
    expect(workerRow).toEqual(expect.objectContaining({ markSettledDone: true }));
    expect(result.placedKeys).toEqual(new Set([`${laptop}:coordinator`, `${laptop}:worker`]));

    // Without the grant: a plain heading, and the coordinator is the caller's again.
    const plain = build([heading(laptop, { threadId: coordinator.id })], [coordinator, worker]);
    expect(outline(plain)).toEqual(["0#App"]);
    expect(plain.placedKeys).toEqual(new Set());
  });
});
