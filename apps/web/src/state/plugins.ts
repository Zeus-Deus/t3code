import {
  environmentSupportsPlugins,
  pluginApiSupport,
  pluginExecutionDisabled,
  pluginRecoverySupported,
  pluginRunnableInstallations,
} from "@t3tools/client-runtime/plugins";
import { createPluginEnvironmentAtoms } from "@t3tools/client-runtime/state/plugins";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type PluginInstallation,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironment } from "./environments";
import { useEnvironmentQuery } from "./query";
import { useEnvironmentScope } from "./session";

export const pluginEnvironment = createPluginEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_INSTALLATIONS: ReadonlyArray<PluginInstallation> = [];

export type PluginCatalogueAvailability =
  | "unknown"
  | "disconnected"
  /** The environment speaks a newer plugin API; this client must update. */
  | "client-outdated"
  | "unsupported"
  | "forbidden"
  | "available";

interface PluginCatalogueView {
  readonly availability: PluginCatalogueAvailability;
  readonly installations: ReadonlyArray<PluginInstallation>;
  readonly loaded: boolean;
  readonly error: string | null;
  // Optional so views mocked before recovery existed stay valid; absent reads as false/null.
  /** Safe mode: plugin code does not run here, but plugins stay manageable. */
  readonly executionDisabled?: boolean;
  /** The environment could not open its plugin data at all. */
  readonly unavailableMessage?: string | null;
  /** Repair, previous-version and missed-event requests are understood by this server. */
  readonly recoverySupported?: boolean;
}

const catalogueTarget = (environmentId: EnvironmentId) => ({ environmentId, input: {} });

/**
 * One environment's plugins. Nothing is requested from an environment that does not advertise the
 * plugin API this client renders, or from a session without read access.
 */
export function usePluginCatalogue(environmentId: EnvironmentId | null): PluginCatalogueView {
  const environment = useEnvironment(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const config = environment?.serverConfig ?? null;
  const connected = environment?.connection.phase === "connected" && config !== null;
  const availability: PluginCatalogueAvailability =
    environment === null
      ? "unknown"
      : !connected
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
      ? pluginEnvironment.catalogue(catalogueTarget(environmentId))
      : null,
  );
  const capabilities = config?.environment.capabilities;
  return {
    availability,
    installations: query.data?.installations ?? EMPTY_INSTALLATIONS,
    loaded: query.data !== null,
    error: query.error,
    executionDisabled:
      availability === "available" && pluginExecutionDisabled(capabilities, query.data),
    unavailableMessage: query.data?.unavailable?.message ?? null,
    recoverySupported: availability === "available" && pluginRecoverySupported(capabilities),
  };
}

/**
 * The runnable installations as last delivered, for menus built inside event handlers. Something
 * must be subscribed (see `PluginCatalogueSubscriptions`) or this returns nothing.
 */
export function readRunnablePluginInstallations(
  environmentId: EnvironmentId,
): ReadonlyArray<PluginInstallation> {
  const result = appAtomRegistry.get(pluginEnvironment.catalogue(catalogueTarget(environmentId)));
  const catalogue = Option.getOrNull(AsyncResult.value(result));
  return catalogue === null ? EMPTY_INSTALLATIONS : pluginRunnableInstallations(catalogue);
}
