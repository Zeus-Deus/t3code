import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  findPluginTreeInstallation,
  isPluginSidebarTreeOption,
  pluginRunnableInstallations,
  pluginTreeConversationsGranted,
  pluginTreeConversationThreadKeys,
  pluginTreeNotice,
  pluginTreeProjectsGranted,
  pluginTreeTopic,
  type PluginSidebarTreeOption,
  type PluginTreeSource,
} from "@t3tools/client-runtime/plugins";
import {
  ProjectId,
  type EnvironmentId,
  type PluginInstallation,
  type PluginTreeNode,
  type ThreadId,
} from "@t3tools/contracts";
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
import { useSidebarView } from "./sidebarView";

interface TreeSnapshot {
  readonly installationId: string;
  readonly generation: string;
  /** The last snapshot this generation served; kept while a refresh fails or the link drops. */
  readonly nodes: ReadonlyArray<PluginTreeNode> | null;
  readonly failed: boolean;
  /** The installation currently holds ui.native-tree-conversations. */
  readonly conversations: boolean;
  /**
   * With ui.native-tree-projects it owns conversations, and declaring `unplaced: "omit"` makes the
   * tree exclusive. Known from the catalogue, so owned conversations show before any read lands.
   */
  readonly projects: TreeProjects;
  /** Its granted project ids, one per line: owned conversations show only in these. */
  readonly grantedProjects: string;
}

type TreeProjects = "none" | "owned" | "exclusive";

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
          readonly conversations: boolean;
          readonly projects: TreeProjects;
          readonly grantedProjects: string;
        }
      | {
          readonly kind: "ready";
          readonly installationId: string;
          readonly generation: string;
          readonly conversations: boolean;
          readonly projects: TreeProjects;
          readonly grantedProjects: string;
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
      if (
        update.kind === "identity" &&
        sameIdentity &&
        previous.conversations === update.conversations &&
        previous.projects === update.projects &&
        previous.grantedProjects === update.grantedProjects &&
        state.key === key
      )
        return state;
      const kept = sameIdentity ? previous.nodes : null;
      snapshots.set(environmentId, {
        installationId: update.installationId,
        generation: update.generation,
        nodes: update.kind === "ready" ? update.nodes : kept,
        failed:
          update.kind === "identity" && sameIdentity ? previous.failed : update.kind === "failed",
        conversations: update.conversations,
        projects: update.projects,
        grantedProjects: update.grantedProjects,
      });
      return { key, snapshots };
    }),
}));

/**
 * The installation whose snapshot an environment shows for the chosen tree, while that same
 * installation and generation is still runnable and still serves the tree; otherwise null.
 */
export function usePluginTreeInstallation(
  choice: PluginSidebarTreeOption,
  environmentId: EnvironmentId,
): PluginInstallation | null {
  const catalogue = usePluginCatalogue(environmentId);
  const snapshot = usePluginTreeSnapshotStore((state) =>
    state.key === choice.key ? state.snapshots.get(environmentId) : undefined,
  );
  if (catalogue.availability !== "available" || !catalogue.loaded) return null;
  if (snapshot === undefined || snapshot.nodes === null) return null;
  const installation = findPluginTreeInstallation(pluginRunnableInstallations(catalogue), choice);
  return installation?.installationId === snapshot.installationId &&
    installation.generation === snapshot.generation
    ? installation
    : null;
}

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
  // A grant change re-reads, so a revoked grant never keeps showing conversations.
  const conversations = installation !== null && pluginTreeConversationsGranted(installation);
  const treeId = choice.tree.id;
  const projects: TreeProjects =
    installation === null || !pluginTreeProjectsGranted(installation)
      ? "none"
      : installation.manifest.nativeTrees?.find((tree) => tree.id === treeId)?.unplaced === "omit"
        ? "exclusive"
        : "owned";
  const grantedProjects = installation?.grants.projectIds.join("\n") ?? "";
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
    report(choice.key, environmentId, {
      kind: "identity",
      installationId,
      generation,
      conversations,
      projects,
      grantedProjects,
    });
    if (revision === undefined) return;
    let cancelled = false;
    report(choice.key, environmentId, {
      kind: "loading",
      installationId,
      generation,
      conversations,
      projects,
      grantedProjects,
    });
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
            ? {
                kind: "ready",
                installationId,
                generation,
                conversations,
                projects,
                grantedProjects,
                nodes: result.value.nodes,
              }
            : {
                kind: "failed",
                installationId,
                generation,
                conversations,
                projects,
                grantedProjects,
              },
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
    conversations,
    projects,
    grantedProjects,
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
  const shown = environments.flatMap(({ environmentId }) => {
    const snapshot = snapshots.get(environmentId);
    return snapshot === undefined ? [] : [snapshot];
  });
  return pluginTreeNotice(
    choice.tree.title,
    shown.map((snapshot) => ({ failed: snapshot.failed, hasNodes: snapshot.nodes !== null })),
    shown.length > 0 && shown.every((snapshot) => snapshot.projects !== "none"),
  );
}

/**
 * Whether every environment serving the chosen tree has answered its latest read, so a tree with
 * nothing in it is really empty rather than still loading or failed.
 */
export function usePluginTreeLoaded(choice: PluginSidebarTreeOption | null): boolean {
  const key = usePluginTreeSnapshotStore((state) => state.key);
  const snapshots = usePluginTreeSnapshotStore((state) => state.snapshots);
  if (choice === null || key !== choice.key || snapshots.size === 0) return false;
  return [...snapshots.values()].every((snapshot) => snapshot.nodes !== null && !snapshot.failed);
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
  const sources = ordered.flatMap((environmentId): PluginTreeSource[] => {
    const snapshot = snapshots.get(environmentId);
    if (snapshot === undefined) return [];
    // Activity leaves owned conversations to this tree, so it lays out from the serving identity
    // alone while the first read is pending or after it failed.
    if (snapshot.nodes === null && snapshot.projects === "none") return [];
    return [
      {
        environmentId,
        nodes: snapshot.nodes ?? [],
        conversations: snapshot.conversations,
        ...(snapshot.projects === "none"
          ? {}
          : {
              projects: {
                installationId: snapshot.installationId,
                treeId: choice.tree.id,
                exclusive: snapshot.projects === "exclusive",
                projectIds: snapshot.grantedProjects
                  .split("\n")
                  .filter((id) => id !== "")
                  .map((id) => ProjectId.make(id)),
              },
            }),
      },
    ];
  });
  return sources.length === 0 ? null : sources;
}

/**
 * Whether a thread is the conversation a project heading of the chosen sidebar tree stands for,
 * or one of its direct workers: their breadcrumb need not repeat the project.
 */
export function usePluginTreeConversationScope(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  parentThreadId: ThreadId | null,
): boolean {
  const { selected } = useSidebarView();
  const sources = usePluginTreeSources(
    selected !== null && isPluginSidebarTreeOption(selected) ? selected : null,
  );
  if (sources === null) return false;
  const keys = pluginTreeConversationThreadKeys(sources);
  const has = (id: ThreadId) => keys.has(scopedThreadKey(scopeThreadRef(environmentId, id)));
  return has(threadId) || (parentThreadId !== null && has(parentThreadId));
}
