import type { ExecutionEnvironmentCapabilities, PluginChanged } from "@t3tools/contracts";

/** Servers before change signals reject the subscription; mounted views then never refresh. */
export const pluginChangesSupported = (
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
) => capabilities?.plugins?.changes === true;

export const pluginNativeTreesSupported = (
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
) => capabilities?.plugins?.nativeTrees === true;

export const pluginConversationCardsSupported = (
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
) => capabilities?.plugins?.conversationCards === true;

/**
 * How many times each topic changed since this client subscribed. The server only says that
 * something changed; a mounted consumer compares the count with the one it last read and fetches
 * again when it differs. A reconnect starts a fresh subscription at zero, which also differs, so
 * every mounted consumer rereads after a gap instead of trusting what it missed.
 */
export type PluginChangeRevisions = ReadonlyMap<string, number>;

export const EMPTY_PLUGIN_CHANGE_REVISIONS: PluginChangeRevisions = new Map();

/** Generation is part of the key: a refreshed installation's signals never reach old consumers. */
export const pluginChangeKey = (
  change: Pick<PluginChanged, "installationId" | "generation" | "topic">,
) => `${change.installationId}\0${change.generation}\0${change.topic}`;

export function recordPluginChange(
  revisions: PluginChangeRevisions,
  change: PluginChanged,
): PluginChangeRevisions {
  const key = pluginChangeKey(change);
  return new Map(revisions).set(key, (revisions.get(key) ?? 0) + 1);
}

export const pluginTreeTopic = (treeId: string) => `tree:${treeId}`;
export const pluginViewTopic = (viewId: string) => `view:${viewId}`;
export const pluginStatusTopic = (statusId: string) => `status:${statusId}`;
