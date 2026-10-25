import { useAtomValue } from "@effect/atom-react";
import {
  environmentSupportsPlugins,
  pluginApiSupport,
  pluginExecutionDisabled,
  pluginRecoverySupported,
  pluginActionEntries,
  pluginAttentionCount,
  pluginChangeKey,
  pluginChangesSupported,
  pluginSidebarTreeOptions,
  type PluginSidebarViewSource,
  pluginAttentionNotice,
  pluginRunnableInstallations,
  type PluginActionEntry,
  type PluginActionPlacement,
  type PluginChangeRevisions,
} from "@t3tools/client-runtime/plugins";
import { createPluginEnvironmentAtoms } from "@t3tools/client-runtime/state/plugins";
import {
  AuthOrchestrationReadScope,
  sessionGrantsScope,
  EnvironmentId,
  type PluginInstallation,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { environmentSession, useEnvironmentScope } from "./session";

export const pluginEnvironment = createPluginEnvironmentAtoms(connectionAtomRuntime);

/** The latest install result, so its review screen has the plugin before the catalogue push. */
export const lastPluginInstallAtom = Atom.make<{
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("mobile-plugin-last-install"));

const EMPTY_INSTALLATIONS: ReadonlyArray<PluginInstallation> = [];

export type PluginCatalogueAvailability =
  | "unknown"
  | "disconnected"
  /** The environment speaks a newer plugin API; this client must update. */
  | "client-outdated"
  | "unsupported"
  | "forbidden"
  | "available";

/**
 * One environment's plugins. Nothing is requested from an environment that does not advertise the
 * plugin API this client renders, or from a session without read access.
 */
export function usePluginCatalogue(environmentId: EnvironmentId | null) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const presentation = environmentId === null ? undefined : presentations.get(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const config = presentation?.serverConfig ?? null;
  const availability: PluginCatalogueAvailability =
    presentation === undefined
      ? "unknown"
      : presentation.connection.phase !== "connected" || config === null
        ? "disconnected"
        : pluginApiSupport(config.environment.capabilities) === "client-outdated"
          ? "client-outdated"
          : !environmentSupportsPlugins(config.environment.capabilities)
            ? "unsupported"
            : !canRead
              ? "forbidden"
              : "available";
  const query = useEnvironmentQuery(
    availability === "available" && environmentId !== null
      ? pluginEnvironment.catalogue({ environmentId, input: {} })
      : null,
  );
  const capabilities = config?.environment.capabilities;
  return {
    availability,
    installations: query.data?.installations ?? EMPTY_INSTALLATIONS,
    loaded: query.data !== null,
    error: query.error,
    /** Safe mode: plugin code does not run here, but plugins stay manageable. */
    executionDisabled:
      availability === "available" && pluginExecutionDisabled(capabilities, query.data),
    /** The environment could not open its plugin data at all. */
    unavailableMessage: query.data?.unavailable?.message ?? null,
    /** Repair, previous-version and missed-event requests are understood by this server. */
    recoverySupported: availability === "available" && pluginRecoverySupported(capabilities),
  };
}

const EMPTY_ENTRIES: ReadonlyArray<PluginActionEntry> = [];

/**
 * The environment's catalogue result for atoms outside React, or null when this client must not
 * ask for it: the same gate `usePluginCatalogue` applies.
 */
function readAvailableCatalogue(get: Atom.AtomContext, environmentId: EnvironmentId) {
  const presentation = get(environmentPresentations.presentationsAtom).get(environmentId);
  const session = Option.getOrNull(
    AsyncResult.value(get(environmentSession.sessionStateAtom(environmentId))),
  );
  const capabilities = presentation?.serverConfig?.environment.capabilities;
  const available =
    presentation?.connection.phase === "connected" &&
    environmentSupportsPlugins(capabilities) &&
    session !== null &&
    sessionGrantsScope(session, AuthOrchestrationReadScope);
  if (!available) return null;
  return {
    capabilities,
    result: get(pluginEnvironment.catalogue({ environmentId, input: {} })),
  };
}

/**
 * One environment's runnable actions for a placement, for list rows and message rows. The previous
 * array is returned while the entries are unchanged, so a connection or catalogue push that changes
 * nothing here does not re-render every row.
 */
const pluginPlacementEntriesFamily = Atom.family((key: string) => {
  const [rawEnvironmentId, placement] = key.split("\n") as [EnvironmentId, PluginActionPlacement];
  const environmentId = rawEnvironmentId;
  return Atom.make((get): ReadonlyArray<PluginActionEntry> => {
    const catalogue = readAvailableCatalogue(get, environmentId);
    const data = catalogue === null ? null : Option.getOrNull(AsyncResult.value(catalogue.result));
    const next =
      catalogue !== null && data !== null
        ? pluginActionEntries(
            pluginRunnableInstallations({
              installations: data.installations,
              executionDisabled: pluginExecutionDisabled(catalogue.capabilities, data),
            }),
            placement,
          )
        : EMPTY_ENTRIES;
    const previous = Option.getOrNull(get.self<ReadonlyArray<PluginActionEntry>>());
    const entryKey = (entries: ReadonlyArray<PluginActionEntry>) =>
      entries
        .map((entry) => `${entry.installation.generation}:${entry.action.id}:${entry.action.title}`)
        .join("\n");
    return previous !== null && entryKey(previous) === entryKey(next) ? previous : next;
  }).pipe(Atom.withLabel(`mobile-plugin-placement:${key}`));
});

export const pluginPlacementEntriesAtom = (
  environmentId: EnvironmentId,
  placement: PluginActionPlacement,
) => pluginPlacementEntriesFamily(`${environmentId}\n${placement}`);

/**
 * How many plugins need attention across environments, for the Settings index. Counts what the
 * Plugins screen's notices show; an environment whose plugins could not load counts once.
 */
const pluginAttentionCountFamily = Atom.family((key: string) =>
  Atom.make((get) =>
    key
      .split("\n")
      .filter((environmentId) => environmentId !== "")
      .reduce((total, environmentId) => {
        const catalogue = readAvailableCatalogue(get, EnvironmentId.make(environmentId));
        if (catalogue === null || AsyncResult.isInitial(catalogue.result)) return total;
        if (AsyncResult.isFailure(catalogue.result)) return total + 1;
        const notice = pluginAttentionNotice({
          installations: catalogue.result.value.installations,
          unavailableMessage: catalogue.result.value.unavailable?.message,
        });
        return total + pluginAttentionCount(notice);
      }, 0),
  ).pipe(Atom.withLabel(`mobile-plugin-attention-count:${key}`)),
);

export const pluginAttentionCountAtom = (environmentIds: ReadonlyArray<EnvironmentId>) =>
  pluginAttentionCountFamily(environmentIds.join("\n"));

const PENDING_SOURCE: PluginSidebarViewSource = { status: "pending" };

const NO_TREES_SOURCE: PluginSidebarViewSource = { status: "ready", options: [] };

/**
 * The plugin trees each environment offers, for the thread list's view choice. An environment
 * whose plugins are not known yet is pending, so a remembered tree survives a reconnect. One that
 * answered it cannot list them (no plugin support, a newer plugin API, no read access, a failed
 * list) offers none, so a remembered tree from it falls back to activity, as on web.
 */
const pluginTreeViewSourcesFamily = Atom.family((key: string) =>
  Atom.make((get): ReadonlyMap<EnvironmentId, PluginSidebarViewSource> => {
    const sources = new Map<EnvironmentId, PluginSidebarViewSource>();
    for (const rawEnvironmentId of key.split("\n")) {
      if (rawEnvironmentId === "") continue;
      const environmentId = EnvironmentId.make(rawEnvironmentId);
      const presentation = get(environmentPresentations.presentationsAtom).get(environmentId);
      const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
      const capabilities = presentation?.serverConfig?.environment.capabilities;
      if (presentation?.connection.phase !== "connected" || capabilities === undefined) {
        sources.set(environmentId, PENDING_SOURCE);
        continue;
      }
      if (!environmentSupportsPlugins(capabilities)) {
        sources.set(environmentId, NO_TREES_SOURCE);
        continue;
      }
      if (AsyncResult.isInitial(sessionResult)) {
        sources.set(environmentId, PENDING_SOURCE);
        continue;
      }
      const catalogue = readAvailableCatalogue(get, environmentId);
      if (catalogue === null || AsyncResult.isFailure(catalogue.result)) {
        sources.set(environmentId, NO_TREES_SOURCE);
        continue;
      }
      const data = Option.getOrNull(AsyncResult.value(catalogue.result));
      sources.set(
        environmentId,
        data === null
          ? PENDING_SOURCE
          : {
              status: "ready",
              options: pluginSidebarTreeOptions(
                environmentId,
                pluginRunnableInstallations({
                  installations: data.installations,
                  executionDisabled: pluginExecutionDisabled(catalogue.capabilities, data),
                }),
              ),
            },
      );
    }
    return sources;
  }).pipe(Atom.withLabel(`mobile-plugin-tree-sources:${key}`)),
);

export const pluginTreeViewSourcesAtom = (environmentIds: ReadonlyArray<EnvironmentId>) =>
  pluginTreeViewSourcesFamily(environmentIds.join("\n"));

// Undefined while the subscription has not reported its first count. A failed subscription
// counts as none, so readers fall back to reading once.
function usePluginChangeSubscription(
  environmentId: EnvironmentId | null,
): PluginChangeRevisions | null | undefined {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const presentation = environmentId === null ? undefined : presentations.get(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const capabilities = presentation?.serverConfig?.environment.capabilities;
  const subscribed =
    environmentId !== null &&
    canRead &&
    presentation?.connection.phase === "connected" &&
    environmentSupportsPlugins(capabilities) &&
    pluginChangesSupported(capabilities);
  const query = useEnvironmentQuery(
    subscribed ? pluginEnvironment.changes({ environmentId, input: {} }) : null,
  );
  if (!subscribed) return null;
  if (query.data !== null) return query.data;
  return query.error === null ? undefined : null;
}

/**
 * Change counts for an environment's plugin topics since this client subscribed, or null where
 * the environment sends no change signals. Pass null while nothing is shown, so hidden views keep
 * no subscription. Compare a topic's count with the value last acted on: any difference,
 * including a reset after reconnecting, means read again.
 */
export function usePluginChangeRevisions(
  environmentId: EnvironmentId | null,
): PluginChangeRevisions | null {
  return usePluginChangeSubscription(environmentId) ?? null;
}

/**
 * One topic's count from `usePluginChangeRevisions`, or undefined until the subscription first
 * reports. A snapshot read waits for that first count, so it follows the subscription instead of
 * racing ahead of it, and the first count is not itself a change.
 */
export function usePluginChangeRevision(
  environmentId: EnvironmentId | null,
  topic: {
    readonly installationId: string;
    readonly generation: string;
    readonly topic: string;
  } | null,
): number | null | undefined {
  const revisions = usePluginChangeSubscription(topic === null ? null : environmentId);
  if (revisions === null || topic === null) return null;
  if (revisions === undefined) return undefined;
  return revisions.get(pluginChangeKey(topic)) ?? 0;
}
