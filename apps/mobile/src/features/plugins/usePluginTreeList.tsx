import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  findPluginTreeInstallation,
  isPluginSidebarTreeOption,
  pluginRunnableInstallations,
  pluginTreeConversationsGranted,
  pluginTreeNotice,
  pluginTreeTopic,
  resolvePluginSidebarView,
  togglePluginTreeFold,
  type PluginSidebarTreeOption,
  type PluginTreeConversation,
  type PluginTreeSource,
} from "@t3tools/client-runtime/plugins";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, PluginInstallation, PluginTreeNode } from "@t3tools/contracts";
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
import { newPluginOperationId, usePluginActionRunner } from "./usePluginActions";

interface TreeSnapshot {
  readonly installationId: string;
  readonly generation: string;
  /** The last snapshot this generation served; kept while a refresh fails or the link drops. */
  readonly nodes: ReadonlyArray<PluginTreeNode> | null;
  /** The latest read failed. */
  readonly failed: boolean;
  /** The installation as last reported; its grants decide whether headings are conversations. */
  readonly installation: PluginInstallation;
}

type SnapshotUpdate =
  | {
      /** The catalogue names this installation and generation; nothing was read yet. */
      readonly kind: "identity";
      readonly installation: PluginInstallation;
    }
  | {
      readonly kind: "result";
      readonly installation: PluginInstallation;
      readonly nodes: ReadonlyArray<PluginTreeNode> | null;
      readonly failed: boolean;
    }
  | null;

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
  const known = catalogue.availability === "available" && catalogue.loaded;
  const installation = known
    ? findPluginTreeInstallation(pluginRunnableInstallations(catalogue), choice)
    : null;
  const latest = useRef({ readTree, onReport, installation });
  useEffect(() => {
    latest.current = { readTree, onReport, installation };
  });
  const installationId = installation?.installationId ?? null;
  const generation = installation?.generation ?? null;
  // A grant change re-reads, so a revoked grant never keeps showing conversations.
  const conversations = installation !== null && pluginTreeConversationsGranted(installation);
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
    const current = latest.current.installation;
    if (installationId === null || generation === null || current === null) {
      latest.current.onReport(environmentId, null);
      return;
    }
    // Before waiting on the change subscription, so a new generation never shows its
    // predecessor's rows or failure.
    latest.current.onReport(environmentId, { kind: "identity", installation: current });
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
          kind: "result",
          installation: current,
          nodes: result._tag === "Success" ? result.value.nodes : null,
          failed: result._tag !== "Success",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    environmentId,
    installationId,
    generation,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A grant change reads again.
    conversations,
    treeId,
    known,
    revision,
    snoozeWake,
  ]);
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
  /** The installation that served an environment's shown snapshot, for its heading actions. */
  readonly installationFor: (environmentId: EnvironmentId) => PluginInstallation | null;
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
      const previous = current.key === key ? current.byEnvironment.get(environmentId) : undefined;
      // A new installation or generation may have other grants; its predecessor's rows go.
      const sameIdentity =
        update !== null &&
        previous?.installationId === update.installation.installationId &&
        previous.generation === update.installation.generation;
      // Knowing the same identity again (a reconnect) keeps its last rows and failure.
      if (
        update?.kind === "identity" &&
        sameIdentity &&
        pluginTreeConversationsGranted(previous.installation) ===
          pluginTreeConversationsGranted(update.installation)
      )
        return current;
      const byEnvironment = new Map(current.key === key ? current.byEnvironment : []);
      if (update === null) byEnvironment.delete(environmentId);
      else {
        const kept = sameIdentity ? (previous?.nodes ?? null) : null;
        byEnvironment.set(environmentId, {
          installationId: update.installation.installationId,
          generation: update.installation.generation,
          nodes: update.kind === "result" ? (update.nodes ?? kept) : kept,
          failed:
            update.kind === "result"
              ? update.failed
              : sameIdentity && previous !== undefined && previous.failed,
          installation: update.installation,
        });
      }
      return { key, byEnvironment };
    });
  const sources =
    selectedTree === null || snapshots.key !== selectedTree.key
      ? []
      : environmentIds.flatMap((environmentId) => {
          const snapshot = snapshots.byEnvironment.get(environmentId);
          return snapshot === undefined || snapshot.nodes === null
            ? []
            : [
                {
                  environmentId,
                  nodes: snapshot.nodes,
                  conversations: pluginTreeConversationsGranted(snapshot.installation),
                },
              ];
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
    installationFor: (environmentId) =>
      selectedTree === null || snapshots.key !== selectedTree.key
        ? null
        : (snapshots.byEnvironment.get(environmentId)?.installation ?? null),
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

/**
 * A tree heading's props for opening its project conversation: its thread, or the declared action
 * that starts one, run with only that project's id. Its results apply as any action's do.
 */
export function usePluginTreeConversationOpener(
  installationFor: (environmentId: EnvironmentId) => PluginInstallation | null,
  onSelectThread: (thread: EnvironmentThreadShell) => void,
): (heading: {
  readonly conversation?: PluginTreeConversation<EnvironmentThreadShell>;
  readonly selected?: boolean;
}) => { readonly open?: { readonly onPress: () => void; readonly selected: boolean } } {
  const runAction = usePluginActionRunner();
  const running = useRef(false);
  const open = (conversation: PluginTreeConversation<EnvironmentThreadShell>) => {
    if (conversation.kind === "thread") {
      onSelectThread(conversation.thread);
      return;
    }
    const installation = installationFor(conversation.environmentId);
    const declared = installation?.manifest.actions.find(
      (action) => action.id === conversation.actionId,
    );
    if (installation == null || declared === undefined || running.current) return;
    running.current = true;
    void runAction(
      { environmentId: conversation.environmentId, installation, threadId: null },
      declared,
      { projectId: conversation.projectId },
    ).finally(() => {
      running.current = false;
    });
  };
  return ({ conversation, selected }) =>
    conversation === undefined
      ? {}
      : { open: { onPress: () => open(conversation), selected: selected === true } };
}
