import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  findPluginTreeInstallation,
  isPluginSidebarTreeOption,
  pluginRunnableInstallations,
  pluginTreeNotice,
  pluginTreeTopic,
  resolvePluginSidebarView,
  togglePluginTreeFold,
  type PluginSidebarTreeOption,
  type PluginTreeSource,
} from "@t3tools/client-runtime/plugins";
import type { EnvironmentId, PluginTreeNode } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  pluginEnvironment,
  pluginTreeViewSourcesAtom,
  usePluginCatalogue,
  usePluginChangeRevision,
} from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { newPluginOperationId } from "./usePluginActions";

interface TreeSnapshot {
  readonly installationId: string;
  readonly generation: string;
  /** The last snapshot this generation served; kept while a refresh fails or the link drops. */
  readonly nodes: ReadonlyArray<PluginTreeNode> | null;
  /** The latest read failed. */
  readonly failed: boolean;
}

type SnapshotUpdate = {
  readonly installationId: string;
  readonly generation: string;
  readonly nodes: ReadonlyArray<PluginTreeNode> | null;
  readonly failed: boolean;
} | null;

/**
 * Reads one environment's snapshot of the chosen tree while the list shows it: on mount, when the
 * plugin or a core change touches the tree, when a snooze ends, and after reconnecting. Never per
 * row.
 */
function PluginTreeSnapshotFetcher(props: {
  readonly environmentId: EnvironmentId;
  readonly choice: PluginSidebarTreeOption;
  readonly snoozeWake: number;
  readonly onReport: (environmentId: EnvironmentId, update: SnapshotUpdate) => void;
}) {
  const { environmentId, choice, snoozeWake, onReport } = props;
  const catalogue = usePluginCatalogue(environmentId);
  const readTree = useAtomCommand(pluginEnvironment.readTree, { reportFailure: false });
  const latest = useRef({ readTree, onReport });
  useEffect(() => {
    latest.current = { readTree, onReport };
  });
  const known = catalogue.availability === "available" && catalogue.loaded;
  const installation = known
    ? findPluginTreeInstallation(pluginRunnableInstallations(catalogue), choice)
    : null;
  const installationId = installation?.installationId ?? null;
  const generation = installation?.generation ?? null;
  const treeId = choice.tree.id;
  const revision = usePluginChangeRevision(
    installationId === null ? null : environmentId,
    installationId === null || generation === null
      ? null
      : { installationId, generation, topic: pluginTreeTopic(treeId) },
  );
  useEffect(() => {
    // Unknown while disconnected or loading: the last snapshot stays until the catalogue answers.
    if (!known) return;
    if (installationId === null || generation === null) {
      latest.current.onReport(environmentId, null);
      return;
    }
    // Read after the change subscription first reports, not before it and again at its first count.
    if (revision === undefined) return;
    let cancelled = false;
    void latest.current
      .readTree({
        environmentId,
        input: { installationId, generation, treeId, operationId: newPluginOperationId() },
      })
      .then((result) => {
        if (cancelled) return;
        latest.current.onReport(environmentId, {
          installationId,
          generation,
          nodes: result._tag === "Success" ? result.value.nodes : null,
          failed: result._tag !== "Success",
        });
      });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new change count or snooze end reads again.
  }, [environmentId, installationId, generation, treeId, known, revision, snoozeWake]);
  return null;
}

/**
 * The thread list's plugin tree on this device: the trees offered, the chosen one, its
 * snapshots, and the person's folds. `fetchers` must be rendered while the list is shown.
 */
export function usePluginTreeList(
  environmentIds: ReadonlyArray<EnvironmentId>,
  /**
   * Counts snooze ends in the list that renders `fetchers`: ending one is time alone, with no
   * event to signal the tree.
   */
  snoozeWake = 0,
): {
  readonly options: ReadonlyArray<PluginSidebarTreeOption>;
  readonly selected: PluginSidebarTreeOption | null;
  readonly select: (choice: PluginSidebarTreeOption | null) => void;
  /** Null until any environment has served the chosen tree; the list stays as it is meanwhile. */
  readonly sources: ReadonlyArray<PluginTreeSource> | null;
  /** One line when a read of the chosen tree failed; null otherwise. */
  readonly notice: string | null;
  readonly folds: ReadonlySet<string>;
  readonly toggleFold: (sectionKey: string, collapsedByDefault: boolean) => void;
  readonly fetchers: ReactNode;
} {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  const viewSources = useAtomValue(pluginTreeViewSourcesAtom(environmentIds));
  const { options, selected } = resolvePluginSidebarView({
    remembered: preferences?.threadListPluginTree ?? null,
    sources: viewSources,
  });
  const treeOptions = options.filter(isPluginSidebarTreeOption);
  const selectedTree = selected !== null && isPluginSidebarTreeOption(selected) ? selected : null;

  const [snapshots, setSnapshots] = useState<{
    readonly key: string | null;
    readonly byEnvironment: ReadonlyMap<EnvironmentId, TreeSnapshot>;
  }>({ key: null, byEnvironment: new Map() });
  const report = (key: string, environmentId: EnvironmentId, update: SnapshotUpdate) =>
    setSnapshots((current) => {
      const byEnvironment = new Map(current.key === key ? current.byEnvironment : []);
      const previous = byEnvironment.get(environmentId);
      if (update === null) byEnvironment.delete(environmentId);
      else {
        // A new installation or generation may have other grants; its predecessor's rows go.
        const kept =
          previous?.installationId === update.installationId &&
          previous.generation === update.generation
            ? previous.nodes
            : null;
        byEnvironment.set(environmentId, { ...update, nodes: update.nodes ?? kept });
      }
      return { key, byEnvironment };
    });
  const sources =
    selectedTree === null || snapshots.key !== selectedTree.key
      ? []
      : environmentIds.flatMap((environmentId) => {
          const nodes = snapshots.byEnvironment.get(environmentId)?.nodes ?? null;
          return nodes === null ? [] : [{ environmentId, nodes }];
        });

  const notice =
    selectedTree === null || snapshots.key !== selectedTree.key
      ? null
      : pluginTreeNotice(
          selectedTree.tree.title,
          environmentIds.flatMap((environmentId) => {
            const snapshot = snapshots.byEnvironment.get(environmentId);
            return snapshot === undefined
              ? []
              : [{ failed: snapshot.failed, hasNodes: snapshot.nodes !== null }];
          }),
        );

  const folds = new Set(preferences?.threadListTreeFolds ?? []);
  return {
    options: treeOptions,
    selected: selectedTree,
    select: (choice) => savePreferences({ threadListPluginTree: choice }),
    sources: sources.length === 0 ? null : sources,
    notice,
    folds,
    toggleFold: (sectionKey, collapsedByDefault) =>
      savePreferences({
        transform: (current) => ({
          threadListTreeFolds: togglePluginTreeFold(
            current.threadListTreeFolds ?? [],
            sectionKey,
            collapsedByDefault,
          ),
        }),
      }),
    fetchers:
      selectedTree === null
        ? null
        : environmentIds.map((environmentId) => (
            <PluginTreeSnapshotFetcher
              key={`${environmentId}:${selectedTree.key}`}
              environmentId={environmentId}
              choice={selectedTree}
              snoozeWake={snoozeWake}
              onReport={(id, update) => report(selectedTree.key, id, update)}
            />
          )),
  };
}
