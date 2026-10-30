import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import { EMPTY_PLUGIN_CHANGE_REVISIONS, recordPluginChange } from "../plugins/changes.ts";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createPluginEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Install, consent, enable and remove change one environment's catalogue; running them in order
  // keeps a quick "review then enable" from racing itself.
  const managementScheduler = createAtomCommandScheduler();
  const management = {
    scheduler: managementScheduler,
    concurrency: {
      mode: "serial" as const,
      key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
    },
  };
  return {
    /** The environment's installations; the server pushes a fresh catalogue after every change. */
    catalogue: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugins:catalogue",
      tag: WS_METHODS.pluginsSubscribe,
    }),
    install: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:install",
      tag: WS_METHODS.pluginsInstall,
      ...management,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:refresh",
      tag: WS_METHODS.pluginsRefresh,
      ...management,
    }),
    consent: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:consent",
      tag: WS_METHODS.pluginsConsent,
      ...management,
    }),
    grantProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:grant-project",
      tag: WS_METHODS.pluginsGrantProject,
      ...management,
    }),
    /** A person's answer to a plugin's project request; the plugin is told before this settles. */
    answerProjectAccess: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:answer-project-access",
      tag: WS_METHODS.pluginsAnswerProjectAccess,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:set-enabled",
      tag: WS_METHODS.pluginsSetEnabled,
      ...management,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:remove",
      tag: WS_METHODS.pluginsRemove,
      ...management,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:resume",
      tag: WS_METHODS.pluginsResume,
      ...management,
    }),
    /** Drops a staged update; the running version is untouched. */
    discardPendingUpdate: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:discard-pending-update",
      tag: WS_METHODS.pluginsDiscardPendingUpdate,
      ...management,
    }),
    /** Copies the running files into an editable folder for an agent; never runs or enables. */
    prepareRepair: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:prepare-repair",
      tag: WS_METHODS.pluginsPrepareRepair,
      ...management,
    }),
    /** Stages the repair folder's files for review; the running version is untouched. */
    stageRepair: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:stage-repair",
      tag: WS_METHODS.pluginsStageRepair,
      ...management,
    }),
    /** Stages the kept previous version for review; it would run with current data. */
    stagePrevious: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:use-previous",
      tag: WS_METHODS.pluginsUsePrevious,
      ...management,
    }),
    /** Counts finalized runs missed while the plugin could not observe them. */
    backlog: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:backlog",
      tag: WS_METHODS.pluginsBacklog,
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:update-settings",
      tag: WS_METHODS.pluginsUpdateSettings,
      ...management,
    }),
    invoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:invoke",
      tag: WS_METHODS.pluginsInvoke,
    }),
    readView: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:read-view",
      tag: WS_METHODS.pluginsReadView,
    }),
    /** One full tree snapshot; only a mounted tree asks, on selection, change and reconnect. */
    readTree: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:read-tree",
      tag: WS_METHODS.pluginsReadTree,
    }),
    /** A conversation card's view; the server checks the card's provenance before serving it. */
    readCardView: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:plugins:read-card-view",
      tag: WS_METHODS.pluginsReadCardView,
    }),
    /** Per-topic change counts for the environment, while anything that reads them is mounted. */
    changes: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugins:changes",
      tag: WS_METHODS.pluginsSubscribeChanges,
      transform: (stream) =>
        stream.pipe(Stream.scan(() => EMPTY_PLUGIN_CHANGE_REVISIONS, recordPluginChange)),
    }),
  };
}

export type PluginEnvironmentAtoms = ReturnType<typeof createPluginEnvironmentAtoms>;
