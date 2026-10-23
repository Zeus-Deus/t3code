import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
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
  readonly liveCount: number;
  readonly lastActivityAt: string | null;
  readonly folded: boolean;
}

export const UNKNOWN_PROJECT_SECTION_KEY = "\0unknown-project";

const threadKey = (thread: ProjectViewThread) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

const latest = (left: string | null, right: string) =>
  left === null || Date.parse(right) > Date.parse(left) ? right : left;

/**
 * Arranges the sidebar's threads by project for a plugin-declared view. The host decides what is
 * live: `liveThreads` are the pinned, active and working threads in activity order, and settled or
 * snoozed threads stay on the shared shelves below. The view's rules only choose which project
 * headings appear. No thread is ever dropped: unknown projects get their own section, and the open
 * thread shows even when its project is folded.
 */
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
  /** The project the sidebar is filtered to: it always shows, however quiet or empty. */
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
    const rows = live.get(key) ?? [];
    const folded = input.foldedKeys.has(key);
    return {
      group,
      key,
      threads: folded ? rows.filter((thread) => threadKey(thread) === input.routeThreadKey) : rows,
      liveCount: rows.length,
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
