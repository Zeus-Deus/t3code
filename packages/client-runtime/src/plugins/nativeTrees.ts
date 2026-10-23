import type { EnvironmentId, PluginTreeNode, ProjectId, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey, scopeThreadRef } from "../environment/scoped.ts";

/**
 * A plugin's native sidebar tree, laid out by the host. The plugin only says where threads go; the
 * host resolves every reference against threads it already lists, renders its own rows, and keeps
 * every listed thread reachable: a thread the tree leaves out stays where the host would put it.
 */

interface PluginTreeThread {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly lineage: { readonly parentThreadId: ThreadId | null };
}

export interface PluginTreeRow<TThread> {
  readonly thread: TThread;
  readonly key: string;
  readonly children: ReadonlyArray<PluginTreeRow<TThread>>;
}

export type PluginTreeHeading<TProject> =
  | { readonly kind: "group"; readonly title: string }
  | { readonly kind: "project"; readonly project: TProject }
  /** Live threads the tree does not place. */
  | { readonly kind: "other" };

export interface PluginTreeSection<TProject, TThread> {
  readonly key: string;
  /** Null for threads the tree places at its root. */
  readonly heading: PluginTreeHeading<TProject> | null;
  /** Headings above this one. */
  readonly depth: number;
  /**
   * Headings above its rows: one more than `depth` under a heading. Rows without a heading are
   * the ones listed after a nested heading, so they sit at the level of the heading they continue.
   */
  readonly rowDepth: number;
  readonly folded: boolean;
  /** The plugin's initial fold, for toggling; the person's choice is kept against it. */
  readonly collapsedByDefault: boolean;
  /** Threads under this heading, nested headings included. */
  readonly count: number;
  /** Rows to render: all of them, or only the open thread while folded. */
  readonly rows: ReadonlyArray<PluginTreeRow<TThread>>;
  readonly threads: ReadonlyArray<TThread>;
}

export interface PluginTreeSource {
  readonly environmentId: EnvironmentId;
  readonly nodes: ReadonlyArray<PluginTreeNode>;
}

export const PLUGIN_TREE_OTHER_SECTION_KEY = "\0plugin-tree-other";

/** Persisted per device: an explicit fold or unfold, which wins over `collapsedByDefault`. */
const pluginTreeExpandedFoldKey = (sectionKey: string) => `+${sectionKey}`;

function isPluginTreeSectionFolded(
  sectionKey: string,
  collapsedByDefault: boolean,
  folds: ReadonlySet<string>,
): boolean {
  if (folds.has(sectionKey)) return true;
  if (folds.has(pluginTreeExpandedFoldKey(sectionKey))) return false;
  return collapsedByDefault;
}

/** The fold entries after the person toggles a section, leaving at most one entry for it. */
export function togglePluginTreeFold(
  folds: ReadonlyArray<string>,
  sectionKey: string,
  collapsedByDefault: boolean,
): ReadonlyArray<string> {
  const folded = isPluginTreeSectionFolded(sectionKey, collapsedByDefault, new Set(folds));
  const expandedKey = pluginTreeExpandedFoldKey(sectionKey);
  const rest = folds.filter((key) => key !== sectionKey && key !== expandedKey);
  // Back to the plugin's default needs no entry.
  if (folded === !collapsedByDefault) return rest;
  return [...rest, folded ? expandedKey : sectionKey];
}

const threadKey = (thread: PluginTreeThread) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

// Read by shape so snapshots from a contract without it still lay out. Only headings fold:
// native thread rows always show their children, so the hint on a thread node is ignored.
const collapsedByDefault = (node: PluginTreeNode) =>
  "collapsedByDefault" in node && node.collapsedByDefault === true;

interface HeadingNode<TProject, TThread> {
  readonly kind: "heading";
  readonly key: string;
  readonly heading: PluginTreeHeading<TProject>;
  readonly collapsedByDefault: boolean;
  readonly children: Array<TreeEntry<TProject, TThread>>;
  /** Root project headings that took in another node of the same logical project. */
  merged: boolean;
}

interface ThreadNode<TProject, TThread> {
  readonly kind: "thread";
  readonly thread: TThread;
  readonly key: string;
  /** Headings never nest under a row; one placed under a thread goes beside it. */
  readonly heading: HeadingNode<TProject, TThread> | null;
  readonly children: Array<ThreadNode<TProject, TThread>>;
}

type TreeEntry<TProject, TThread> = HeadingNode<TProject, TThread> | ThreadNode<TProject, TThread>;

/**
 * Lays out one tree from every environment that offers it, in environment priority order.
 *
 * - Node ids are local to an environment; nothing merges by id. Project headings at the root merge
 *   only when the host's own project grouping puts them in the same logical project.
 * - References the host does not list (archived, filtered, not loaded, outside the scope) are
 *   skipped and their children move up, so no listed thread disappears behind a missing parent.
 * - Nesting under a thread is display only; it says nothing about who owns or runs the thread.
 * - A thread the tree leaves out follows its parent thread when that is placed; otherwise a live one
 *   goes to the "other" section, and a parked one (snoozed, settled) stays on the host's shelves.
 * - Group and project headings fold, keeping only the open thread; thread rows do not fold.
 */
export function buildPluginTreeLayout<TProject, TThread extends PluginTreeThread>(input: {
  readonly sources: ReadonlyArray<PluginTreeSource>;
  /** Every thread the host lists, in its order. */
  readonly threads: ReadonlyArray<TThread>;
  /** Threads that belong in the list rather than on a shelf when the tree leaves them out. */
  readonly liveThreadKeys: ReadonlySet<string>;
  /** The host's logical project for an environment's project, or null when it has none. */
  readonly project: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) => { readonly key: string; readonly project: TProject } | null;
  /** Whether an empty project heading belongs in the current scope. */
  readonly showsEmptyProject: (project: TProject) => boolean;
  readonly folds: ReadonlySet<string>;
  readonly routeThreadKey: string | null;
}): {
  readonly sections: ReadonlyArray<PluginTreeSection<TProject, TThread>>;
  /** Threads the tree placed, directly or by following a placed parent. */
  readonly placedKeys: ReadonlySet<string>;
} {
  type Heading = HeadingNode<TProject, TThread>;
  type Thread = ThreadNode<TProject, TThread>;
  const threadsByKey = new Map(input.threads.map((thread) => [threadKey(thread), thread]));
  const placedKeys = new Set<string>();
  const roots: Array<TreeEntry<TProject, TThread>> = [];
  const rootProjects = new Map<string, Heading>();

  for (const source of input.sources) {
    const { environmentId } = source;
    const nodesById = new Map(source.nodes.map((node) => [node.id, node]));
    interface Resolved {
      /** The node's own heading or row; null when it is skipped or merged into another. */
      readonly entry: TreeEntry<TProject, TThread> | null;
      readonly attachTo: Heading | Thread | null;
      /** Where its children go: itself, or the ancestor that stands in for a skipped node. */
      readonly container: Heading | Thread | null;
    }
    // Snapshots may list a child before its parent, so parents resolve on demand. Entries attach
    // afterwards in snapshot order, so siblings keep the plugin's order.
    const resolved = new Map<string, Resolved>();
    const resolving = new Set<string>();
    const resolve = (node: PluginTreeNode): Resolved => {
      const known = resolved.get(node.id);
      if (known !== undefined) return known;
      resolving.add(node.id);
      // A parent chain that loops back leaves the node it reached unparented.
      const parentNode =
        node.parentId === undefined || resolving.has(node.parentId)
          ? undefined
          : nodesById.get(node.parentId);
      const parent = parentNode === undefined ? null : resolve(parentNode).container;
      const headingParent = parent?.kind === "thread" ? parent.heading : parent;
      const result = ((): Resolved => {
        if (node.kind === "thread") {
          const key = scopedThreadKey(scopeThreadRef(environmentId, node.threadId));
          const thread = threadsByKey.get(key);
          if (thread === undefined || placedKeys.has(key)) {
            return { entry: null, attachTo: null, container: parent };
          }
          placedKeys.add(key);
          const entry: Thread = {
            kind: "thread",
            thread,
            key,
            heading: headingParent,
            children: [],
          };
          return { entry, attachTo: parent, container: entry };
        }
        if (node.kind === "group") {
          const entry: Heading = {
            kind: "heading",
            key: `tree:${environmentId}:${node.id}`,
            heading: { kind: "group", title: node.title },
            collapsedByDefault: collapsedByDefault(node),
            children: [],
            merged: false,
          };
          return { entry, attachTo: headingParent, container: entry };
        }
        const project = input.project(environmentId, node.projectId);
        if (project === null) return { entry: null, attachTo: null, container: headingParent };
        const merged = headingParent === null ? rootProjects.get(project.key) : undefined;
        if (merged !== undefined) {
          merged.merged = true;
          return { entry: null, attachTo: null, container: merged };
        }
        const entry: Heading = {
          kind: "heading",
          key:
            headingParent === null ? `project:${project.key}` : `tree:${environmentId}:${node.id}`,
          heading: { kind: "project", project: project.project },
          collapsedByDefault: collapsedByDefault(node),
          children: [],
          merged: false,
        };
        if (headingParent === null) rootProjects.set(project.key, entry);
        return { entry, attachTo: headingParent, container: entry };
      })();
      resolving.delete(node.id);
      resolved.set(node.id, result);
      return result;
    };
    for (const node of source.nodes) {
      const { entry, attachTo } = resolve(node);
      if (entry === null) continue;
      if (attachTo === null) roots.push(entry);
      else if (attachTo.kind === "heading") attachTo.children.push(entry);
      else if (entry.kind === "thread") attachTo.children.push(entry);
    }
  }

  // A thread the tree leaves out follows its nearest placed ancestor thread, in host order.
  const parentKey = (thread: TThread) =>
    thread.lineage.parentThreadId === null
      ? null
      : scopedThreadKey(scopeThreadRef(thread.environmentId, thread.lineage.parentThreadId));
  const treePlaced = new Set(placedKeys);
  const anchorOf = (thread: TThread): string | null => {
    const seen = new Set<string>();
    let cursor = parentKey(thread);
    while (cursor !== null && !seen.has(cursor)) {
      if (treePlaced.has(cursor)) return cursor;
      const next = threadsByKey.get(cursor);
      if (next === undefined) return null;
      seen.add(cursor);
      cursor = parentKey(next);
    }
    return null;
  };
  const followers = new Map<string, TThread[]>();
  const others: TThread[] = [];
  for (const thread of input.threads) {
    const key = threadKey(thread);
    if (treePlaced.has(key)) continue;
    if (anchorOf(thread) === null) {
      if (input.liveThreadKeys.has(key)) others.push(thread);
      continue;
    }
    placedKeys.add(key);
  }
  const otherKeys = new Set(others.map(threadKey));
  for (const thread of input.threads) {
    const key = threadKey(thread);
    const parent = parentKey(thread);
    if (treePlaced.has(key) || parent === null) continue;
    // Followers hang under their direct parent; so do unplaced live threads among themselves.
    const follows = placedKeys.has(key) && (placedKeys.has(parent) || treePlaced.has(parent));
    if (!follows && !(otherKeys.has(key) && otherKeys.has(parent))) continue;
    const list = followers.get(parent);
    if (list) list.push(thread);
    else followers.set(parent, [thread]);
  }

  const followerRow = (thread: TThread, seen: Set<string>): PluginTreeRow<TThread> => {
    const key = threadKey(thread);
    seen.add(key);
    return {
      thread,
      key,
      children: (followers.get(key) ?? [])
        .filter((child) => !seen.has(threadKey(child)))
        .map((child) => followerRow(child, seen)),
    };
  };
  const placedRow = (entry: Thread): PluginTreeRow<TThread> => {
    const own = followerRow(entry.thread, new Set([entry.key]));
    return { ...own, children: [...entry.children.map(placedRow), ...own.children] };
  };
  const flatten = (rows: ReadonlyArray<PluginTreeRow<TThread>>): TThread[] =>
    rows.flatMap((row) => [row.thread, ...flatten(row.children)]);
  const findRoute = (rows: ReadonlyArray<PluginTreeRow<TThread>>): PluginTreeRow<TThread>[] => {
    for (const row of rows) {
      if (row.key === input.routeThreadKey) return [{ ...row, children: [] }];
      const nested = findRoute(row.children);
      if (nested.length > 0) return nested;
    }
    return [];
  };
  const section = (
    key: string,
    heading: PluginTreeHeading<TProject> | null,
    depth: number,
    rowDepth: number,
    rows: ReadonlyArray<PluginTreeRow<TThread>>,
    count = flatten(rows).length,
    folded = false,
    collapsedByDefault = false,
  ): PluginTreeSection<TProject, TThread> => ({
    key,
    heading,
    depth,
    rowDepth,
    folded,
    collapsedByDefault,
    count,
    rows,
    threads: flatten(rows),
  });

  interface Laid {
    readonly rows: PluginTreeRow<TThread>[];
    count: number;
    /** Every row below, nested headings included, for finding the open thread when folded. */
    readonly allRows: PluginTreeRow<TThread>[];
    readonly sections: PluginTreeSection<TProject, TThread>[];
  }
  // A heading's own rows come first; rows listed after a nested heading keep their place in a
  // section without a heading, so the plugin's order holds. A merged project lists every
  // environment's own rows first, so a later environment's rows do not follow an earlier one's
  // nested headings.
  const lay = (
    entries: ReadonlyArray<TreeEntry<TProject, TThread>>,
    depth: number,
    key: string,
  ) => {
    const laid: Laid = { rows: [], count: 0, allRows: [], sections: [] };
    let loose: PluginTreeRow<TThread>[] = [];
    let continuation = 0;
    const flush = () => {
      if (loose.length === 0) return;
      laid.sections.push(section(`${key}:${continuation++}`, null, depth, depth, loose));
      loose = [];
    };
    for (const entry of entries) {
      if (entry.kind === "thread") {
        const row = placedRow(entry);
        laid.count += flatten([row]).length;
        laid.allRows.push(row);
        if (laid.sections.length === 0) laid.rows.push(row);
        else loose.push(row);
        continue;
      }
      flush();
      const children = entry.merged
        ? [
            ...entry.children.filter((child) => child.kind === "thread"),
            ...entry.children.filter((child) => child.kind === "heading"),
          ]
        : entry.children;
      const inner = lay(children, depth + 1, entry.key);
      laid.count += inner.count;
      laid.allRows.push(...inner.allRows);
      if (
        inner.count === 0 &&
        !(entry.heading.kind === "project" && input.showsEmptyProject(entry.heading.project))
      )
        continue;
      const folded =
        inner.count > 0 &&
        isPluginTreeSectionFolded(entry.key, entry.collapsedByDefault, input.folds);
      laid.sections.push(
        section(
          entry.key,
          entry.heading,
          depth,
          depth + 1,
          folded ? findRoute(inner.allRows) : inner.rows,
          inner.count,
          folded,
          entry.collapsedByDefault,
        ),
      );
      if (!folded) laid.sections.push(...inner.sections);
    }
    flush();
    return laid;
  };

  const top = lay(roots, 0, "tree-root");
  const sections: PluginTreeSection<TProject, TThread>[] = [];
  if (top.rows.length > 0) sections.push(section("tree-root", null, 0, 0, top.rows));
  sections.push(...top.sections);

  if (others.length > 0) {
    const seen = new Set<string>();
    const rows = others
      .filter((thread) => {
        const parent = parentKey(thread);
        return parent === null || !otherKeys.has(parent);
      })
      .map((thread) => followerRow(thread, seen));
    // A lineage cycle would hide every thread in it; list those flat instead.
    for (const thread of others) {
      if (!seen.has(threadKey(thread))) rows.push(followerRow(thread, seen));
    }
    const folded = isPluginTreeSectionFolded(PLUGIN_TREE_OTHER_SECTION_KEY, false, input.folds);
    sections.push(
      section(
        PLUGIN_TREE_OTHER_SECTION_KEY,
        { kind: "other" },
        0,
        1,
        folded ? findRoute(rows) : rows,
        flatten(rows).length,
        folded,
      ),
    );
  }
  return { sections, placedKeys };
}

/** Thread keys in the order the tree shows them, for keyboard traversal and jump hints. */
export const pluginTreeThreadKeys = (
  sections: ReadonlyArray<{ readonly threads: ReadonlyArray<PluginTreeThread> }>,
) => sections.flatMap((section) => section.threads.map(threadKey));
