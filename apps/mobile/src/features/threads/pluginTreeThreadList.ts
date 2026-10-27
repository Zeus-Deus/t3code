import {
  buildPluginTreeLayout,
  type PluginTreeRow,
  type PluginTreeSource,
} from "@t3tools/client-runtime/plugins";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { threadActivityTimestampMs } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId } from "@t3tools/contracts";

import type { HomeProjectScope } from "../home/homeThreadList";
import {
  buildThreadListV2ListItems,
  resolveThreadListV2WokeAt,
  type ThreadListV2Item,
  type ThreadListV2ListItem,
} from "./threadListV2";

const threadKey = (thread: EnvironmentThreadShell) => `${thread.environmentId}:${thread.id}`;

/**
 * A plugin tree as list items: its headings, then the threads it placed, indented under them.
 * Threads it leaves out are not here; the caller lists them as usual below, with their shelves,
 * so every thread stays reachable. Rows keep the host's own variants and actions.
 */
export function buildPluginTreeThreadListItems(input: {
  readonly sources: ReadonlyArray<PluginTreeSource>;
  /** The threads the list shows for its filters, as `filterThreadListV2Threads` returns them. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectScopes: ReadonlyArray<HomeProjectScope>;
  /** The project the list is filtered to, whose heading shows even when empty. */
  readonly selectedProjectKey: string | null;
  readonly folds: ReadonlySet<string>;
  readonly selectedThreadKey: string | null;
  readonly now: string;
  /** The list's minute clock, for the same snooze labels its other rows show. */
  readonly snoozeLabelNow: string;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
  /** Names an environment whose project heading is split from the others' conversations. */
  readonly environmentLabel?: (environmentId: EnvironmentId) => string | null;
}): {
  readonly items: ReadonlyArray<ThreadListV2ListItem>;
  readonly placedKeys: ReadonlySet<string>;
  /** The earliest snooze end among placed threads; the caller's list wakes only its own. */
  readonly nextSnoozeWakeAt: string | null;
} {
  const scopeByProject = new Map<string, HomeProjectScope>();
  for (const scope of input.projectScopes) {
    for (const ref of scope.projectRefs) {
      scopeByProject.set(`${ref.environmentId}:${ref.projectId}`, scope);
    }
  }
  const layout = buildPluginTreeLayout({
    sources: input.sources,
    threads: input.threads,
    // Nothing is collected under "other": the caller's own list keeps those threads.
    liveThreadKeys: new Set(),
    project: (environmentId, projectId) => {
      const scope = scopeByProject.get(`${environmentId}:${projectId}`);
      return scope === undefined ? null : { key: scope.key, project: scope };
    },
    showsEmptyProject: (scope) =>
      input.selectedProjectKey === null || scope.key === input.selectedProjectKey,
    folds: input.folds,
    routeThreadKey: input.selectedThreadKey,
    activityAt: threadActivityTimestampMs,
  });

  // Trees that opted into project conversations mark every finished worker Done.
  const conversationEnvironmentIds = new Set(
    input.sources.flatMap((source) => (source.conversations ? [source.environmentId] : [])),
  );
  const parked = (thread: EnvironmentThreadShell) =>
    ((input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true) &&
      effectiveSnoozed(thread, { now: input.now })) ||
    ((input.settlementEnvironmentIds?.has(thread.environmentId) ?? true) &&
      thread.settledOverride === "settled" &&
      input.queuedThreadKeys?.has(threadKey(thread)) !== true);
  const rows: Array<{
    readonly item: ThreadListV2Item;
    readonly depth: number;
    readonly markSettledDone: boolean;
  }> = [];
  // Headings by the row they precede; a folded or empty heading shares its index with the next.
  const headings = new Map<number, ThreadListV2ListItem[]>();
  const addRows = (
    entries: ReadonlyArray<PluginTreeRow<EnvironmentThreadShell>>,
    depth: number,
  ) => {
    for (const row of entries) {
      const snoozed =
        (input.snoozeEnvironmentIds?.has(row.thread.environmentId) ?? true) &&
        effectiveSnoozed(row.thread, { now: input.now });
      const slim = parked(row.thread);
      rows.push({
        depth,
        item: {
          thread: row.thread,
          variant: slim ? "slim" : "card",
          snoozed,
          pinned: !slim && row.thread.pinnedAt != null,
          wokeAt: slim ? null : resolveThreadListV2WokeAt(row.thread, { now: input.now }),
          isLast: false,
        },
        markSettledDone: conversationEnvironmentIds.has(row.thread.environmentId),
      });
      addRows(row.children, depth + 1);
    }
  };
  for (const section of layout.sections) {
    const heading = section.heading;
    if (heading !== null) {
      const before = headings.get(rows.length) ?? [];
      headings.set(rows.length, before);
      const conversation = heading.kind === "project" ? heading.conversation : undefined;
      const environment =
        heading.kind === "project" && heading.environmentId !== undefined
          ? (input.environmentLabel?.(heading.environmentId) ?? heading.environmentId)
          : null;
      before.push({
        type: "v2-tree-heading",
        key: `v2-tree:${section.key}`,
        sectionKey: section.key,
        title:
          heading.kind === "group"
            ? heading.title
            : heading.kind === "project"
              ? environment === null
                ? heading.project.title
                : `${heading.project.title} · ${environment}`
              : "Other threads",
        depth: section.depth,
        count: section.count,
        folded: section.folded,
        collapsedByDefault: section.collapsedByDefault,
        foldable: true,
        ...(conversation === undefined
          ? {}
          : {
              conversation,
              selected:
                conversation.kind === "thread" && conversation.key === input.selectedThreadKey,
            }),
      });
    }
    addRows(section.rows, section.rowDepth);
  }
  const threadItems = buildThreadListV2ListItems({
    items: rows.map((row) => row.item),
    pendingTasks: [],
    snoozeLabelNow: input.snoozeLabelNow,
    ...(input.snoozeEnvironmentIds === undefined
      ? {}
      : { snoozeEnvironmentIds: input.snoozeEnvironmentIds }),
    ...(input.queuedThreadKeys === undefined ? {} : { queuedThreadKeys: input.queuedThreadKeys }),
  });
  const items: ThreadListV2ListItem[] = [];
  threadItems.forEach((item, index) => {
    items.push(...(headings.get(index) ?? []));
    const depth = rows[index]?.depth ?? 0;
    const markSettledDone = rows[index]?.markSettledDone === true;
    items.push(
      item.type === "v2-thread" && (depth > 0 || markSettledDone)
        ? {
            ...item,
            ...(depth > 0 ? { depth } : {}),
            ...(markSettledDone ? { markSettledDone } : {}),
          }
        : item,
    );
  });
  items.push(...(headings.get(threadItems.length) ?? []));
  // A row divides from the next row only; a heading brings its own rule.
  const divided = items.map((item, index) =>
    item.type === "v2-thread" &&
    item.showTrailingDivider !== (items[index + 1]?.type === "v2-thread")
      ? { ...item, showTrailingDivider: !item.showTrailingDivider }
      : item,
  );
  let nextSnoozeWakeAt: string | null = null;
  for (const thread of input.threads) {
    const until = thread.snoozedUntil;
    if (
      until == null ||
      !layout.placedKeys.has(threadKey(thread)) ||
      !(input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true) ||
      !effectiveSnoozed(thread, { now: input.now })
    ) {
      continue;
    }
    if (nextSnoozeWakeAt === null || Date.parse(until) < Date.parse(nextSnoozeWakeAt)) {
      nextSnoozeWakeAt = until;
    }
  }
  return { items: divided, placedKeys: layout.placedKeys, nextSnoozeWakeAt };
}

/** Threads the tree placed are not in the list's own layout, so either may wake first. */
export function earliestSnoozeWakeAt(list: string | null, tree: string | null): string | null {
  if (list === null) return tree;
  if (tree === null) return list;
  return Date.parse(tree) < Date.parse(list) ? tree : list;
}

/**
 * The tree's items above the list's own. A heading names the live threads the tree left out, so
 * they do not read as part of the tree's last group; shelves keep their own headers.
 */
export function withPluginTreeItems<T extends { readonly type: string }>(
  tree: ReadonlyArray<ThreadListV2ListItem> | null,
  activity: ReadonlyArray<T>,
  /** An exclusive tree lists only its own: Activity keeps every other row and shelf. */
  exclusive = false,
): ReadonlyArray<T | ThreadListV2ListItem> {
  if (exclusive && tree !== null) return tree;
  if (tree === null || tree.length === 0) return activity;
  const liveCount = activity.findIndex(
    (item) => item.type !== "v2-thread" && item.type !== "v2-pending",
  );
  const count = liveCount === -1 ? activity.length : liveCount;
  if (count === 0) return [...tree, ...activity];
  const other: ThreadListV2ListItem = {
    type: "v2-tree-heading",
    key: "v2-tree-other",
    sectionKey: "",
    title: "Other threads",
    depth: 0,
    count,
    folded: false,
    collapsedByDefault: false,
    foldable: false,
  };
  return [...tree, other, ...activity];
}
