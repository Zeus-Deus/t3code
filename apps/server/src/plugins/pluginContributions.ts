import {
  MAX_PLUGIN_CARD_BYTES,
  MAX_PLUGIN_CARD_DATA_BYTES,
  MAX_PLUGIN_TREE_BYTES,
  MAX_PLUGIN_TREE_DEPTH,
  PluginConversationCard,
  PluginError,
  PluginTreeSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const invalid = () =>
  new PluginError({
    reason: "invalid_result",
    message: "The plugin contribution is invalid or exceeds its bounds.",
  });
const jsonBytes = (value: unknown) => {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw invalid();
    return Buffer.byteLength(json, "utf8");
  } catch {
    throw invalid();
  }
};
const decodeTree = Schema.decodeUnknownSync(PluginTreeSnapshot);
const decodeCard = Schema.decodeUnknownSync(PluginConversationCard);

export function validatePluginTree(value: unknown): PluginTreeSnapshot {
  if (jsonBytes(value) > MAX_PLUGIN_TREE_BYTES) throw invalid();
  let tree: PluginTreeSnapshot;
  try {
    tree = decodeTree(value);
  } catch {
    throw invalid();
  }
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  if (nodes.size !== tree.nodes.length) throw invalid();
  const references = new Set<string>();
  for (const node of tree.nodes) {
    if (node.kind !== "group") {
      const reference =
        node.kind === "thread" ? `thread:${node.threadId}` : `project:${node.projectId}`;
      if (references.has(reference)) throw invalid();
      references.add(reference);
    }
    const seen = new Set<string>([node.id]);
    let parentId = node.parentId;
    while (parentId !== undefined) {
      if (seen.has(parentId) || seen.size >= MAX_PLUGIN_TREE_DEPTH) throw invalid();
      seen.add(parentId);
      const parent = nodes.get(parentId);
      if (parent === undefined) throw invalid();
      parentId = parent.parentId;
    }
  }
  return tree;
}

export function validatePluginCard(value: unknown): PluginConversationCard {
  if (jsonBytes(value) > MAX_PLUGIN_CARD_BYTES) throw invalid();
  let card: PluginConversationCard;
  try {
    card = decodeCard(value);
  } catch {
    throw invalid();
  }
  if (card.data !== undefined && jsonBytes(card.data) > MAX_PLUGIN_CARD_DATA_BYTES) throw invalid();
  return card;
}

export function isPluginTreeMembershipEvent(type: string): boolean {
  return (
    type.startsWith("project.") ||
    (type.startsWith("thread.") && !["thread.visited", "thread.marked-unread"].includes(type))
  );
}
