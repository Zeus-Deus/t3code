import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationV2AppThreadLineage,
  PluginSidebarView,
  ProjectId,
  ScopedProjectRef,
  ThreadId,
} from "@t3tools/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

interface ProjectViewThread {
  readonly id: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly updatedAt: string;
  readonly lineage: OrchestrationV2AppThreadLineage;
}

interface ProjectViewGroupInput {
  readonly projectKey: string;
  readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
  readonly updatedAt: string;
  readonly isScratch?: true | undefined;
}

export interface ProjectViewSection<TGroup, TThread> {
  /** Null for threads whose project is not known yet; they still render. */
  readonly group: TGroup | null;
  readonly key: string;
  /** Rows to render: the live threads, or only the open one while folded. */
  readonly threads: ReadonlyArray<TThread>;
  readonly rows: ReadonlyArray<ProjectViewRow<TThread>>;
  readonly liveCount: number;
  readonly lastActivityAt: string | null;
  readonly folded: boolean;
}

export interface ProjectViewRow<TThread> {
  readonly thread: TThread;
  readonly key: string;
  readonly children: ReadonlyArray<ProjectViewRow<TThread>>;
}

export const UNKNOWN_PROJECT_SECTION_KEY = "\0unknown-project";

const threadKey = (thread: ProjectViewThread) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

const latest = (left: string | null, right: string) =>
  left === null || Date.parse(right) > Date.parse(left) ? right : left;

function nestProjectThreads<TThread extends ProjectViewThread>(threads: ReadonlyArray<TThread>) {
  const nodes = new Map(
    threads.map((thread) => [
      threadKey(thread),
      { thread, key: threadKey(thread), children: [] as ProjectViewRow<TThread>[] },
    ]),
  );
  const parents = new Map<string, string>();
  for (const thread of threads) {
    if (thread.lineage.parentThreadId === null || thread.lineage.relationshipToParent === null)
      continue;
    const parentKey = scopedThreadKey(
      scopeThreadRef(thread.environmentId, thread.lineage.parentThreadId),
    );
    if (nodes.has(parentKey)) parents.set(threadKey(thread), parentKey);
  }
  // Resolve each chain once. Broken cycles (and chains into them) stay at the root rather
  // than disappearing from the tree; environment-scoped keys never join two machines.
  const cyclic = new Map<string, boolean>();
  for (const key of nodes.keys()) {
    const path = new Set<string>();
    let cursor: string | undefined = key;
    while (cursor !== undefined && !cyclic.has(cursor) && !path.has(cursor)) {
      path.add(cursor);
      cursor = parents.get(cursor);
    }
    const isCycle = cursor !== undefined && (cyclic.get(cursor) === true || path.has(cursor));
    for (const visited of path) cyclic.set(visited, isCycle);
  }
  const roots: ProjectViewRow<TThread>[] = [];
  for (const [key, node] of nodes) {
    const parentKey = cyclic.get(key) ? undefined : parents.get(key);
    const parent = parentKey === undefined ? undefined : nodes.get(parentKey);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function flattenProjectRows<TThread>(rows: ReadonlyArray<ProjectViewRow<TThread>>): TThread[] {
  const threads: TThread[] = [];
  const stack = rows.toReversed();
  while (stack.length > 0) {
    const row = stack.pop()!;
    threads.push(row.thread);
    for (let index = row.children.length - 1; index >= 0; index--) stack.push(row.children[index]!);
  }
  return threads;
}

// The plugin chooses project headings; the host owns activity order and parked shelves.
// Unknown projects and the open thread remain reachable even when groups are folded.
export function buildProjectView<
  TGroup extends ProjectViewGroupInput,
  TThread extends ProjectViewThread,
>(input: {
  readonly view: PluginSidebarView;
  /** In the person's project order. */
  readonly groups: ReadonlyArray<TGroup>;
  readonly liveThreads: ReadonlyArray<TThread>;
  /** Every thread the sidebar lists, parked ones included, for activity and emptiness. */
  readonly allThreads: ReadonlyArray<ProjectViewThread>;
  readonly foldedKeys: ReadonlySet<string>;
  readonly routeThreadKey: string | null;
  /** The project the sidebar is filtered to: the only heading, however quiet or empty. */
  readonly scopedProjectKey: string | null;
  readonly now: number;
}): {
  readonly sections: ReadonlyArray<ProjectViewSection<TGroup, TThread>>;
  /** Projects folded away by `quietAfterDays`; they have nothing live to show. */
  readonly quietSections: ReadonlyArray<ProjectViewSection<TGroup, TThread>>;
} {
  const groupKeyByProject = new Map<string, string>();
  for (const group of input.groups) {
    for (const ref of group.memberProjectRefs) {
      groupKeyByProject.set(`${ref.environmentId}:${ref.projectId}`, group.projectKey);
    }
  }
  const sectionKeyOf = (thread: ProjectViewThread) =>
    groupKeyByProject.get(`${thread.environmentId}:${thread.projectId}`) ??
    UNKNOWN_PROJECT_SECTION_KEY;

  const live = new Map<string, TThread[]>();
  for (const thread of input.liveThreads) {
    const key = sectionKeyOf(thread);
    const list = live.get(key);
    if (list) list.push(thread);
    else live.set(key, [thread]);
  }
  const activity = new Map<string, string>();
  const holdsRoute = new Set<string>();
  for (const thread of input.allThreads) {
    const key = sectionKeyOf(thread);
    activity.set(key, latest(activity.get(key) ?? null, thread.updatedAt));
    if (threadKey(thread) === input.routeThreadKey) holdsRoute.add(key);
  }

  const section = (key: string, group: TGroup | null): ProjectViewSection<TGroup, TThread> => {
    const liveThreads = live.get(key) ?? [];
    const folded = input.foldedKeys.has(key);
    // Folding keeps only the open row, at the root: hidden ancestors must not consume space.
    const rows = nestProjectThreads(
      folded
        ? liveThreads.filter((thread) => threadKey(thread) === input.routeThreadKey)
        : liveThreads,
    );
    return {
      group,
      key,
      threads: flattenProjectRows(rows),
      rows,
      liveCount: liveThreads.length,
      lastActivityAt: activity.get(key) ?? null,
      folded,
    };
  };

  const quietBefore =
    input.view.quietAfterDays === undefined ? null : input.now - input.view.quietAfterDays * DAY_MS;
  const sections: ProjectViewSection<TGroup, TThread>[] = [];
  const quietSections: ProjectViewSection<TGroup, TThread>[] = [];
  for (const group of input.groups) {
    const key = group.projectKey;
    // The thread lists are already filtered; other projects would only look empty.
    if (input.scopedProjectKey !== null && key !== input.scopedProjectKey) continue;
    const result = section(key, group);
    const pinnedOpen = key === input.scopedProjectKey || holdsRoute.has(key);
    if (pinnedOpen || result.liveCount > 0) {
      sections.push(result);
      continue;
    }
    const hasThreads = activity.has(key);
    // Threads without a project only matter while something there is live.
    if (group.isScratch) continue;
    if (!hasThreads && input.view.emptyProjects !== "show") continue;
    const lastActivity = Date.parse(result.lastActivityAt ?? group.updatedAt);
    if (quietBefore !== null && !(lastActivity >= quietBefore)) quietSections.push(result);
    else sections.push(result);
  }
  if (live.has(UNKNOWN_PROJECT_SECTION_KEY)) {
    sections.push(section(UNKNOWN_PROJECT_SECTION_KEY, null));
  }
  return { sections, quietSections };
}

/** Thread keys in the order the view shows them, for keyboard traversal and jump hints. */
export function projectViewThreadKeys(
  sections: ReadonlyArray<ProjectViewSection<unknown, ProjectViewThread>>,
): string[] {
  return sections.flatMap((section) => section.threads.map(threadKey));
}
