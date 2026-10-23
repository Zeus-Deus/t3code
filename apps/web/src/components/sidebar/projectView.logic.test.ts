import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type PluginSidebarView,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectView,
  projectViewThreadKeys,
  UNKNOWN_PROJECT_SECTION_KEY,
} from "./projectView.logic";

const laptop = EnvironmentId.make("env-laptop");
const server = EnvironmentId.make("env-server");
const now = Date.parse("2026-10-23T12:00:00.000Z");
const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
const view: PluginSidebarView = { id: "projects", title: "Projects", groupBy: "project" };

const ref = (environmentId: EnvironmentId, projectId: string): ScopedProjectRef => ({
  environmentId,
  projectId: ProjectId.make(projectId),
});
const group = (projectKey: string, members: ScopedProjectRef[], updatedAt = daysAgo(30)) => ({
  projectKey,
  memberProjectRefs: members,
  updatedAt,
});
const thread = (
  id: string,
  environmentId: EnvironmentId,
  projectId: string,
  updatedAt = daysAgo(0),
) => ({
  id: ThreadId.make(id),
  environmentId,
  projectId: ProjectId.make(projectId),
  updatedAt,
});
const keyOf = (value: ReturnType<typeof thread>) =>
  scopedThreadKey(scopeThreadRef(value.environmentId, value.id));

const build = (overrides: Partial<Parameters<typeof buildProjectView>[0]> = {}) =>
  buildProjectView({
    view,
    groups: [],
    liveThreads: [],
    allThreads: [],
    foldedKeys: new Set(),
    routeThreadKey: null,
    scopedProjectKey: null,
    now,
    ...overrides,
  });

describe("buildProjectView", () => {
  it("groups threads by the environment-scoped project, merging only grouped members", () => {
    // The same project id on two environments is two projects unless grouping joins them.
    const app = group("repo:app", [ref(laptop, "p1"), ref(server, "p9")]);
    const other = group("server:p1", [ref(server, "p1")]);
    const a = thread("a", laptop, "p1");
    const b = thread("b", server, "p9");
    const c = thread("c", server, "p1");
    const { sections } = build({
      groups: [app, other],
      liveThreads: [a, c, b],
      allThreads: [a, b, c],
    });
    expect(sections.map((section) => [section.key, section.threads.map((t) => t.id)])).toEqual([
      ["repo:app", ["a", "b"]],
      ["server:p1", ["c"]],
    ]);
  });

  it("keeps threads of unknown projects visible in their own section", () => {
    const stray = thread("stray", laptop, "missing");
    const { sections } = build({ liveThreads: [stray], allThreads: [stray] });
    expect(sections).toMatchObject([{ key: UNKNOWN_PROJECT_SECTION_KEY, group: null }]);
    expect(sections[0]?.threads).toEqual([stray]);
  });

  it("folds idle projects away only when the view asks, keeping filtered and open ones", () => {
    const busy = group("busy", [ref(laptop, "busy")]);
    const recent = group("recent", [ref(laptop, "recent")]);
    const idle = group("idle", [ref(laptop, "idle")]);
    const settledRecent = thread("r", laptop, "recent", daysAgo(1));
    const settledIdle = thread("i", laptop, "idle", daysAgo(10));
    const live = thread("l", laptop, "busy", daysAgo(40));
    const input = {
      groups: [busy, recent, idle],
      liveThreads: [live],
      allThreads: [live, settledRecent, settledIdle],
    };
    expect(build(input).quietSections).toEqual([]);
    const quiet = build({ ...input, view: { ...view, quietAfterDays: 3 } });
    expect(quiet.sections.map((section) => section.key)).toEqual(["busy", "recent"]);
    expect(quiet.quietSections.map((section) => section.key)).toEqual(["idle"]);
    expect(quiet.quietSections[0]).toMatchObject({ liveCount: 0, lastActivityAt: daysAgo(10) });
    for (const keep of [{ scopedProjectKey: "idle" }, { routeThreadKey: keyOf(settledIdle) }]) {
      const kept = build({ ...input, ...keep, view: { ...view, quietAfterDays: 3 } });
      expect(kept.sections.map((section) => section.key)).toContain("idle");
    }
  });

  it("lists projects without threads only when the view shows empty projects", () => {
    const empty = group("empty", [ref(server, "empty")], daysAgo(1));
    const stale = group("stale", [ref(server, "stale")], daysAgo(30));
    expect(build({ groups: [empty, stale] }).sections).toEqual([]);
    const shown = build({
      groups: [empty, stale],
      view: { ...view, emptyProjects: "show", quietAfterDays: 7 },
    });
    expect(shown.sections.map((section) => section.key)).toEqual(["empty"]);
    expect(shown.quietSections.map((section) => section.key)).toEqual(["stale"]);
    expect(build({ groups: [empty], scopedProjectKey: "empty" }).sections).toHaveLength(1);
  });

  it("lists only the filtered project, even when the view shows empty projects", () => {
    const app = group("app", [ref(laptop, "app")]);
    const docs = group("docs", [ref(laptop, "docs")], daysAgo(1));
    const old = group("old", [ref(laptop, "old")], daysAgo(30));
    const a1 = thread("a1", laptop, "app");
    const { sections, quietSections } = build({
      view: { ...view, emptyProjects: "show", quietAfterDays: 3 },
      groups: [app, docs, old],
      liveThreads: [a1],
      allThreads: [a1],
      scopedProjectKey: "app",
    });
    expect(sections.map((section) => section.key)).toEqual(["app"]);
    expect(quietSections).toEqual([]);
  });

  it("shows threads without a project only while something there is live or open", () => {
    const scratch = { ...group("scratch", [ref(laptop, "scratch")]), isScratch: true as const };
    const parked = thread("parked", laptop, "scratch");
    const input = { groups: [scratch], allThreads: [parked] };
    expect(build({ ...input, view: { ...view, emptyProjects: "show" } }).sections).toEqual([]);
    expect(build({ ...input, routeThreadKey: keyOf(parked) }).sections).toHaveLength(1);
  });

  it("hides a folded project's rows except the open thread, and orders keys as rendered", () => {
    const app = group("app", [ref(laptop, "app")]);
    const docs = group("docs", [ref(laptop, "docs")]);
    const a1 = thread("a1", laptop, "app");
    const a2 = thread("a2", laptop, "app");
    const d1 = thread("d1", laptop, "docs");
    const input = {
      groups: [app, docs],
      liveThreads: [a1, a2, d1],
      allThreads: [a1, a2, d1],
      foldedKeys: new Set(["app"]),
    };
    const folded = build(input);
    expect(folded.sections[0]).toMatchObject({ folded: true, liveCount: 2, threads: [] });
    expect(projectViewThreadKeys(folded.sections)).toEqual([keyOf(d1)]);
    const open = build({ ...input, routeThreadKey: keyOf(a2) });
    expect(projectViewThreadKeys(open.sections)).toEqual([keyOf(a2), keyOf(d1)]);
  });
});
