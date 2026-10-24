import {
  findPluginTreeInstallation,
  pluginRunnableInstallations,
  pluginTreeNotice,
  pluginTreeTopic,
  type PluginSidebarTreeOption,
  type PluginTreeSource,
} from "@t3tools/client-runtime/plugins";
import type { EnvironmentId, PluginTreeNode } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import {
  pluginEnvironment,
  usePluginCatalogue,
  usePluginChangeRevision,
} from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { newPluginOperationId } from "../plugins/usePluginActions";

interface TreeSnapshot {
  readonly installationId: string;
  readonly generation: string;
  /** The last snapshot this generation served; kept while a refresh fails or the link drops. */
  readonly nodes: ReadonlyArray<PluginTreeNode> | null;
  readonly failed: boolean;
}

interface PluginTreeSnapshotState {
  /** The tree the snapshots belong to; choosing another one starts empty. */
  readonly key: string | null;
  readonly snapshots: ReadonlyMap<EnvironmentId, TreeSnapshot>;
  readonly report: (
    key: string,
    environmentId: EnvironmentId,
    update:
      | {
          /** The catalogue names this installation and generation; nothing was read yet. */
          readonly kind: "identity" | "loading" | "failed";
          readonly installationId: string;
          readonly generation: string;
        }
      | {
          readonly kind: "ready";
          readonly installationId: string;
          readonly generation: string;
          readonly nodes: ReadonlyArray<PluginTreeNode>;
        }
      | { readonly kind: "withdrawn" },
  ) => void;
}

const usePluginTreeSnapshotStore = create<PluginTreeSnapshotState>()((set) => ({
  key: null,
  snapshots: new Map(),
  report: (key, environmentId, update) =>
    set((state) => {
      const snapshots = new Map(state.key === key ? state.snapshots : []);
      const previous = snapshots.get(environmentId);
      if (update.kind === "withdrawn") {
        if (previous === undefined && state.key === key) return state;
        snapshots.delete(environmentId);
        return { key, snapshots };
      }
      // A new installation or generation may have other grants; its predecessor's rows go.
      const sameIdentity =
        previous?.installationId === update.installationId &&
        previous.generation === update.generation;
      // Knowing the same identity again (a reconnect) keeps its last rows and failure.
      if (update.kind === "identity" && sameIdentity && state.key === key) return state;
      const kept = sameIdentity ? previous.nodes : null;
      snapshots.set(environmentId, {
        installationId: update.installationId,
        generation: update.generation,
        nodes: update.kind === "ready" ? update.nodes : kept,
        failed: update.kind === "failed",
      });
      return { key, snapshots };
    }),
}));

export function resetPluginTreeSnapshotsForTests(): void {
  usePluginTreeSnapshotStore.setState({ key: null, snapshots: new Map() });
}

/**
 * Reads one environment's snapshot of the chosen tree while the tree is shown: when it mounts,
 * when the plugin or a core change touches the tree, when a snooze ends, and after reconnecting.
 * Never per row.
 */
function PluginTreeSnapshotSource(props: {
  readonly environmentId: EnvironmentId;
  readonly choice: PluginSidebarTreeOption;
  readonly snoozeWake: number;
}) {
  const { environmentId, choice, snoozeWake } = props;
  const catalogue = usePluginCatalogue(environmentId);
  const report = usePluginTreeSnapshotStore((state) => state.report);
  const readTree = useAtomCommand(pluginEnvironment.readTree, { reportFailure: false });
  const latestRead = useRef(readTree);
  useEffect(() => {
    latestRead.current = readTree;
  });
  // Unknown while disconnected or loading: the last snapshot stays until the catalogue answers.
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
    if (!known) return;
    if (installationId === null || generation === null) {
      report(choice.key, environmentId, { kind: "withdrawn" });
      return;
    }
    // Before waiting on the change subscription, so a new generation never shows its
    // predecessor's rows or failure.
    report(choice.key, environmentId, { kind: "identity", installationId, generation });
    if (revision === undefined) return;
    let cancelled = false;
    report(choice.key, environmentId, { kind: "loading", installationId, generation });
    void latestRead
      .current({
        environmentId,
        input: { installationId, generation, treeId, operationId: newPluginOperationId() },
      })
      .then((result) => {
        if (cancelled) return;
        report(
          choice.key,
          environmentId,
          result._tag === "Success"
            ? { kind: "ready", installationId, generation, nodes: result.value.nodes }
            : { kind: "failed", installationId, generation },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [
    choice.key,
    environmentId,
    installationId,
    generation,
    treeId,
    known,
    revision,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A snooze ending reads again.
    snoozeWake,
    report,
  ]);
  return null;
}

/** Mounted only while a tree is the sidebar's view, so nothing is read for a hidden tree. */
export function PluginTreeSnapshotSources(props: {
  readonly choice: PluginSidebarTreeOption;
  /**
   * Counts snooze ends among the listed threads. Ending a snooze is time alone, with no event to
   * signal the tree, so the plugin is asked again where it might shelve by snooze.
   */
  readonly snoozeWake: number;
}) {
  const environmentIds = useConnectedEnvironmentIds();
  return environmentIds.map((environmentId) => (
    <PluginTreeSnapshotSource
      key={`${environmentId}:${props.choice.key}`}
      environmentId={environmentId}
      choice={props.choice}
      snoozeWake={props.snoozeWake}
    />
  ));
}

/**
 * One line for the chosen tree when a read failed: nothing shown, rows that may be out of date, or
 * one environment missing. Null while every read succeeded or is still loading.
 */
export function usePluginTreeNotice(choice: PluginSidebarTreeOption | null): string | null {
  const environments = useEnvironmentIdentities();
  const key = usePluginTreeSnapshotStore((state) => state.key);
  const snapshots = usePluginTreeSnapshotStore((state) => state.snapshots);
  if (choice === null || key !== choice.key) return null;
  return pluginTreeNotice(
    choice.tree.title,
    environments.flatMap(({ environmentId }) => {
      const snapshot = snapshots.get(environmentId);
      return snapshot === undefined
        ? []
        : [{ failed: snapshot.failed, hasNodes: snapshot.nodes !== null }];
    }),
  );
}

/**
 * The chosen tree's snapshots, primary environment first. `null` until any environment has served
 * one: the sidebar shows activity meanwhile rather than an arrangement with nothing placed.
 */
export function usePluginTreeSources(
  choice: PluginSidebarTreeOption | null,
): ReadonlyArray<PluginTreeSource> | null {
  const environments = useEnvironmentIdentities();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const key = usePluginTreeSnapshotStore((state) => state.key);
  const snapshots = usePluginTreeSnapshotStore((state) => state.snapshots);
  if (choice === null || key !== choice.key) return null;
  const ordered = environments
    .map((environment) => environment.environmentId)
    .toSorted(
      (left, right) =>
        Number(right === primaryEnvironmentId) - Number(left === primaryEnvironmentId),
    );
  const sources = ordered.flatMap((environmentId) => {
    const nodes = snapshots.get(environmentId)?.nodes ?? null;
    return nodes === null ? [] : [{ environmentId, nodes }];
  });
  return sources.length === 0 ? null : sources;
}
