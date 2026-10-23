import { describe, expect, it } from "vite-plus/test";
import {
  validatePluginTree,
  validatePluginCard,
  isPluginTreeMembershipEvent,
} from "./pluginContributions.ts";

describe("plugin contribution validation", () => {
  it("accepts native thread nesting and folded groups, rejects ambiguous or cyclic snapshots", () => {
    const nodes = [
      { id: "p", kind: "project", projectId: "p", collapsedByDefault: true },
      { id: "t", kind: "thread", parentId: "p", threadId: "t" },
      { id: "child", kind: "thread", parentId: "t", threadId: "child" },
    ];
    expect(validatePluginTree({ nodes }).nodes).toEqual(nodes);
    for (const invalid of [
      [...nodes, nodes[0]],
      [...nodes, { id: "duplicate-ref", kind: "thread", threadId: "t" }],
      [{ id: "a", kind: "group", title: "A", parentId: "missing" }],
      [
        { id: "a", kind: "group", title: "A", parentId: "b" },
        { id: "b", kind: "group", title: "B", parentId: "a" },
      ],
      Array.from({ length: 17 }, (_, i) => ({
        id: `g${i}`,
        kind: "group",
        title: "group",
        ...(i ? { parentId: `g${i - 1}` } : {}),
      })),
      Array.from({ length: 2001 }, (_, i) => ({ id: `g${i}`, kind: "group", title: "group" })),
    ])
      expect(() => validatePluginTree({ nodes: invalid })).toThrow();
    expect(() => validatePluginTree({ nodes, extra: "😀".repeat(32_000) })).toThrow();
  });
  it("bounds card JSON by UTF8 bytes and discards worker-supplied ownership", () => {
    expect(
      validatePluginCard({
        viewId: "card",
        summary: "Proposal",
        data: { planId: "one" },
        dataOwner: "forged",
      }),
    ).toEqual({ viewId: "card", summary: "Proposal", data: { planId: "one" } });
    expect(() =>
      validatePluginCard({ viewId: "card", summary: "Proposal", data: "😀".repeat(600) }),
    ).toThrow();
    expect(() => validatePluginCard({ viewId: "card", summary: "", data: {} })).toThrow();
  });
  it("invalidates semantic membership changes without subscribing to display chunks", () => {
    for (const type of [
      "thread.created",
      "thread.metadata-updated",
      "thread.pinned",
      "thread.unpinned",
      "thread.snoozed",
      "thread.unsnoozed",
      "thread.settled",
      "thread.unsettled",
      "thread.deleted",
      "project.updated",
    ])
      expect(isPluginTreeMembershipEvent(type)).toBe(true);
    for (const type of [
      "message.delta",
      "run.updated",
      "thread.visited",
      "thread.marked-unread",
      "tool.updated",
    ])
      expect(isPluginTreeMembershipEvent(type)).toBe(false);
  });
});
