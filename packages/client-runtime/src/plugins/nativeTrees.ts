import type {
  EnvironmentId,
  PluginCapability,
  PluginInstallation,
  PluginTreeNode,
  ProjectId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

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

const TREE_CONVERSATIONS_CAPABILITY: PluginCapability = "ui.native-tree-conversations";

/** Whether a tree served by this installation may make project headings conversations. */
export const pluginTreeConversationsGranted = (installation: PluginInstallation) =>
  installation.grants.capabilities.includes(TREE_CONVERSATIONS_CAPABILITY);

/**
 * What a project heading opens: the thread it stands for, or a declared action that starts one,
 * run with only this project's id. Its environment and project are the node's own, even when the
 * heading shows a project merged across environments.
 */
export type PluginTreeConversation<TThread> = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
} & (
  | { readonly kind: "thread"; readonly thread: TThread; readonly key: string }
  | { readonly kind: "action"; readonly actionId: string }
);

export type PluginTreeHeading<TProject, TThread> =
  | { readonly kind: "group"; readonly title: string }
  | {
      readonly kind: "project";
      readonly project: TProject;
      /** The heading's thread is never also a row; its unplaced children follow under it. */
      readonly conversation?: PluginTreeConversation<TThread>;
      /**
       * Set when several environments give the same project a conversation: each gets its own
       * heading, named by environment, rather than one heading picking among them.
       */
      readonly environmentId?: EnvironmentId;
    }
  /** Live threads the tree does not place. */
  | { readonly kind: "other" };

export interface PluginTreeSection<TProject, TThread> {
  readonly key: string;
  /** Null for threads the tree places at its root. */
  readonly heading: PluginTreeHeading<TProject, TThread> | null;
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
  /** Threads under this heading, nested headings included; never its conversation's own thread. */
  readonly count: number;
  /** Rows to render: all of them, or only the open thread while folded. */
  readonly rows: ReadonlyArray<PluginTreeRow<TThread>>;
  /** In tree order: the heading's conversation thread first, then its rows. */
  readonly threads: ReadonlyArray<TThread>;
}

export interface PluginTreeSource {
  readonly environmentId: EnvironmentId;
  readonly nodes: ReadonlyArray<PluginTreeNode>;
  /**
   * The serving installation holds ui.native-tree-conversations. Without it a project node's
   * thread or action is ignored and it lays out as a plain heading.
   */
  readonly conversations?: boolean;
}

const conversationThreadId = (source: PluginTreeSource, node: PluginTreeNode) =>
  node.kind === "project" && source.conversations === true ? node.threadId : undefined;

/** Threads that project headings stand for, so a thread can tell it is a project's conversation. */
export function pluginTreeConversationThreadKeys(
  sources: ReadonlyArray<PluginTreeSource>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const source of sources) {
    for (const node of source.nodes) {
      const threadId = conversationThreadId(source, node);
      if (threadId !== undefined) {
        keys.add(scopedThreadKey(scopeThreadRef(source.environmentId, threadId)));
      }
    }
  }
  return keys;
}

/** Families needed for placed references the shell omitted, anchored by listed ancestors. */
export function pluginTreeFamilyRoots(input: {
  readonly sources: ReadonlyArray<PluginTreeSource>;
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly lineage: { readonly rootThreadId: ThreadId };
  }>;
  /** Unmerged shell keys keep a loaded family's mount alive. */
  readonly shellThreadKeys?: ReadonlySet<string>;
}): ReadonlyArray<ScopedThreadRef> {
  const threadsByKey = new Map(
    input.threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const roots = new Map<string, ScopedThreadRef>();
  for (const source of input.sources) {
    const nodesById = new Map(source.nodes.map((node) => [node.id, node]));
    for (const node of source.nodes) {
      if (node.kind !== "thread") continue;
      const key = scopedThreadKey(scopeThreadRef(source.environmentId, node.threadId));
      if (input.shellThreadKeys?.has(key) ?? threadsByKey.has(key)) continue;
      const seen = new Set([node.id]);
      let parentId = node.parentId;
      while (parentId !== undefined && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = nodesById.get(parentId);
        if (parent === undefined) break;
        const ancestorId =
          parent.kind === "thread" ? parent.threadId : conversationThreadId(source, parent);
        if (ancestorId !== undefined) {
          const ancestor = threadsByKey.get(
            scopedThreadKey(scopeThreadRef(source.environmentId, ancestorId)),
          );
          if (ancestor !== undefined) {
            const ref = scopeThreadRef(source.environmentId, ancestor.lineage.rootThreadId);
            roots.set(scopedThreadKey(ref), ref);
            break;
          }
        }
        parentId = parent.parentId;
      }
    }
  }
  return [...roots.values()];
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
  readonly heading:
    | { readonly kind: "group"; readonly title: string }
    | {
        readonly kind: "project";
        readonly project: TProject;
        readonly environmentId?: EnvironmentId;
      };
  readonly collapsedByDefault: boolean;
  readonly children: Array<TreeEntry<TProject, TThread>>;
  /** The first conversation among the nodes it took in. */
  conversation: PluginTreeConversation<TThread> | null;
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

// Merge root project headings only through host grouping; node ids remain environment-local.
// Missing references promote children, and unplaced threads remain reachable on host shelves.
// Thread nesting is display only; only group/project headings fold. A project heading's
// conversation thread is placed by the heading itself, so it is never a row.
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
  // Logical projects whose conversations come from more than one environment.
  const conversationEnvironments = new Map<string, Set<EnvironmentId>>();
  for (const source of input.sources) {
    if (source.conversations !== true) continue;
    for (const node of source.nodes) {
      if (node.kind !== "project" || (node.threadId ?? node.actionId) === undefined) continue;
      const project = input.project(source.environmentId, node.projectId);
      if (project === null) continue;
      const environments = conversationEnvironments.get(project.key) ?? new Set();
      environments.add(source.environmentId);
      conversationEnvironments.set(project.key, environments);
    }
  }
  const isSplit = (projectKey: string) => (conversationEnvironments.get(projectKey)?.size ?? 0) > 1;

  for (const source of input.sources) {
    const { environmentId } = source;
    const nodesById = new Map(source.nodes.map((node) => [node.id, node]));
    /** Claims the node's conversation; a thread the host does not list, or already placed, has none. */
    const conversationOf = (
      node: PluginTreeNode & { readonly kind: "project" },
    ): PluginTreeConversation<TThread> | null => {
      if (source.conversations !== true) return null;
      if (node.actionId !== undefined) {
        return {
          kind: "action",
          environmentId,
          projectId: node.projectId,
          actionId: node.actionId,
        };
      }
      if (node.threadId === undefined) return null;
      const key = scopedThreadKey(scopeThreadRef(environmentId, node.threadId));
      const thread = threadsByKey.get(key);
      if (thread === undefined || placedKeys.has(key)) return null;
      placedKeys.add(key);
      return { kind: "thread", environmentId, projectId: node.projectId, thread, key };
    };
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
            conversation: null,
            merged: false,
          };
          return { entry, attachTo: headingParent, container: entry };
        }
        const project = input.project(environmentId, node.projectId);
        if (project === null) return { entry: null, attachTo: null, container: headingParent };
        const split = isSplit(project.key);
        const rootKey = split ? `${project.key}\0${environmentId}` : project.key;
        const merged = headingParent === null ? rootProjects.get(rootKey) : undefined;
        if (merged !== undefined) {
          merged.merged = true;
          merged.conversation ??= conversationOf(node);
          return { entry: null, attachTo: null, container: merged };
        }
        const entry: Heading = {
          kind: "heading",
          key: headingParent === null ? `project:${rootKey}` : `tree:${environmentId}:${node.id}`,
          heading: {
            kind: "project",
            project: project.project,
            ...(split ? { environmentId } : {}),
          },
          collapsedByDefault: collapsedByDefault(node),
          children: [],
          conversation: conversationOf(node),
          merged: false,
        };
        if (headingParent === null) rootProjects.set(rootKey, entry);
        return { entry, attachTo: headingParent, container: entry };
      })();
      resolving.delete(node.id);
      resolved.set(node.id, result);
      return result;
    };
    // A heading's conversation claims its thread before any row naming the same thread can.
    for (const node of source.nodes) if (node.kind === "project") resolve(node);
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
    heading: PluginTreeHeading<TProject, TThread> | null,
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
    threads:
      heading?.kind === "project" && heading.conversation?.kind === "thread"
        ? [heading.conversation.thread, ...flatten(rows)]
        : flatten(rows),
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
      const anchor = entry.conversation?.kind === "thread" ? entry.conversation : null;
      if (anchor !== null) {
        // Its children the tree left out lead the heading's own rows, ahead of nested headings.
        const seen = new Set([anchor.key]);
        const followed = (followers.get(anchor.key) ?? []).map((thread) =>
          followerRow(thread, seen),
        );
        inner.rows.push(...followed);
        inner.allRows.push(...followed);
        inner.count += flatten(followed).length;
      }
      laid.count += inner.count;
      laid.allRows.push(...inner.allRows);
      if (
        inner.count === 0 &&
        anchor === null &&
        !(entry.heading.kind === "project" && input.showsEmptyProject(entry.heading.project))
      )
        continue;
      const folded =
        inner.count > 0 &&
        isPluginTreeSectionFolded(entry.key, entry.collapsedByDefault, input.folds);
      laid.sections.push(
        section(
          entry.key,
          entry.heading.kind === "project" && entry.conversation !== null
            ? { ...entry.heading, conversation: entry.conversation }
            : entry.heading,
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

/** What the sidebar knows about one environment's latest read of the chosen tree. */
export interface PluginTreeReadState {
  readonly failed: boolean;
  /** A snapshot from this installation and generation is still being shown. */
  readonly hasNodes: boolean;
}

/**
 * One line telling the person a failed read changed what they see, or null. Rows the tree did not
 * place stay reachable either way; this only keeps the chosen layout from looking current.
 */
export function pluginTreeNotice(
  title: string,
  reads: ReadonlyArray<PluginTreeReadState>,
): string | null {
  if (!reads.some((read) => read.failed)) return null;
  if (!reads.some((read) => read.hasNodes)) return `Couldn't load ${title}. Showing Activity.`;
  return reads.every((read) => !read.failed || read.hasNodes)
    ? `${title} may be out of date.`
    : `Part of ${title} couldn't load. It may be incomplete.`;
}
