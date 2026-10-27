import {
  PluginSidebarChoice,
  resolvePluginSidebarView,
  togglePluginTreeFold,
  type PluginSidebarViewSource,
  type PluginTreeOwnerGrant,
} from "@t3tools/client-runtime/plugins";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";
import { create } from "zustand";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useEnvironmentIdentities, usePrimaryEnvironmentId } from "../../state/environments";

/** The remembered sidebar view on this device; null is the built-in activity list. */
const SIDEBAR_VIEW_KEY = "t3code:sidebar:view";
const SidebarViewPreference = Schema.NullOr(PluginSidebarChoice);
const PENDING: PluginSidebarViewSource = { status: "pending" };

interface SidebarViewSourceState {
  readonly sources: ReadonlyMap<EnvironmentId, PluginSidebarViewSource>;
  readonly report: (environmentId: EnvironmentId, source: PluginSidebarViewSource | null) => void;
}

/** Filled by the per-environment plugin catalogue subscriptions. */
export const useSidebarViewSourceStore = create<SidebarViewSourceState>()((set) => ({
  sources: new Map(),
  report: (environmentId, source) =>
    set((state) => {
      // Catalogue pushes arrive with fresh identities; only a real change re-renders the sidebar.
      const current = state.sources.get(environmentId) ?? null;
      if (JSON.stringify(current) === JSON.stringify(source)) return state;
      const sources = new Map(state.sources);
      if (source === null) sources.delete(environmentId);
      else sources.set(environmentId, source);
      return { sources };
    }),
}));

/**
 * Which sidebar view to render, and the choices offered. Environments that have not reported
 * count as pending, so a remembered view keeps its last known rules until its environment says
 * otherwise. Choosing never happens automatically: enabling a plugin only adds a choice.
 */
export function useSidebarView() {
  const environments = useEnvironmentIdentities();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const reported = useSidebarViewSourceStore((state) => state.sources);
  const [remembered, setRemembered] = useLocalStorage(
    SIDEBAR_VIEW_KEY,
    null,
    SidebarViewPreference,
  );
  const ordered = environments.toSorted(
    (left, right) =>
      Number(right.environmentId === primaryEnvironmentId) -
      Number(left.environmentId === primaryEnvironmentId),
  );
  const { options, selected } = resolvePluginSidebarView({
    remembered,
    sources: new Map(
      ordered.map((environment) => [
        environment.environmentId,
        reported.get(environment.environmentId) ?? PENDING,
      ]),
    ),
  });
  // Keep the remembered rules current so the next launch renders what the plugin last declared.
  const staleRemembered =
    selected !== null &&
    remembered !== null &&
    JSON.stringify(selected) !== JSON.stringify(remembered);
  useEffect(() => {
    if (staleRemembered && selected !== null) setRemembered(selected);
  }, [selected, setRemembered, staleRemembered]);
  return {
    options,
    selected,
    select: (option: PluginSidebarChoice | null) => setRemembered(option),
  };
}

/**
 * Per environment, the trees whose owned conversations Activity leaves to them. An environment that
 * has not reported its plugins has no entry, so its threads stay in Activity.
 */
export function usePluginTreeOwnerGrants(): ReadonlyMap<
  EnvironmentId,
  ReadonlyArray<PluginTreeOwnerGrant>
> {
  const reported = useSidebarViewSourceStore((state) => state.sources);
  const grants = new Map<EnvironmentId, ReadonlyArray<PluginTreeOwnerGrant>>();
  for (const [environmentId, source] of reported) {
    if (source.status === "ready" && source.owners !== undefined) {
      grants.set(environmentId, source.owners);
    }
  }
  return grants;
}

/** "N more projects" stays open for the session, across Settings visits, but not relaunches. */
export const useSidebarViewSessionStore = create<{
  readonly quietProjectsExpanded: boolean;
  readonly toggleQuietProjects: () => void;
}>()((set) => ({
  quietProjectsExpanded: false,
  toggleQuietProjects: () =>
    set((state) => ({ quietProjectsExpanded: !state.quietProjectsExpanded })),
}));

const SIDEBAR_PROJECT_FOLDS_KEY = "t3code:sidebar:project-folds";
const FoldedProjects = Schema.Array(Schema.String);
const NO_FOLDS: ReadonlyArray<string> = [];

/**
 * Folded project headings in project views, per device and shared across views. Plugin trees keep
 * their headings here too, including ones the person opened against the plugin's default.
 */
export function useSidebarProjectFolds() {
  const [folded, setFolded] = useLocalStorage(SIDEBAR_PROJECT_FOLDS_KEY, NO_FOLDS, FoldedProjects);
  return {
    foldedKeys: new Set(folded),
    toggleFold: (projectKey: string) =>
      setFolded((current) =>
        current.includes(projectKey)
          ? current.filter((key) => key !== projectKey)
          : [...current, projectKey],
      ),
    toggleTreeFold: (sectionKey: string, collapsedByDefault: boolean) =>
      setFolded((current) => togglePluginTreeFold(current, sectionKey, collapsedByDefault)),
  };
}
