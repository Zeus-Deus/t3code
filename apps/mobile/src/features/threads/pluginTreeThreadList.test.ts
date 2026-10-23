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
});
