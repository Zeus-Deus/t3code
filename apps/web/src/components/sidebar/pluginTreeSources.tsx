import {
  findPluginTreeInstallation,
  pluginRunnableInstallations,
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
          readonly kind: "loading" | "failed";
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
      const kept =
        previous?.installationId === update.installationId &&
        previous.generation === update.generation
          ? previous.nodes
          : null;
      snapshots.set(environmentId, {
        installationId: update.installationId,
        generation: update.generation,
        nodes: update.kind === "ready" ? update.nodes : kept,
        failed: update.kind === "failed",
      });
      return { key, snapshots };
    }),
}));

/**
 * Reads one environment's snapshot of the chosen tree while the tree is shown: when it mounts,
 * when the plugin or a core change touches the tree, and after reconnecting. Never per row.
 */
function PluginTreeSnapshotSource(props: {
  readonly environmentId: EnvironmentId;
  readonly choice: PluginSidebarTreeOption;
}) {
  const { environmentId, choice } = props;
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new change count reads again.
  }, [choice.key, environmentId, installationId, generation, treeId, known, revision, report]);
  return null;
}

/** Mounted only while a tree is the sidebar's view, so nothing is read for a hidden tree. */
export function PluginTreeSnapshotSources(props: { readonly choice: PluginSidebarTreeOption }) {
  const environmentIds = useConnectedEnvironmentIds();
  return environmentIds.map((environmentId) => (
    <PluginTreeSnapshotSource
      key={`${environmentId}:${props.choice.key}`}
      environmentId={environmentId}
      choice={props.choice}
    />
  ));
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
