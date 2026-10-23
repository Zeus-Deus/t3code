import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  pluginConversationCardsSupported,
  resolvePluginCardPresentation,
} from "@t3tools/client-runtime/plugins";
import type { EnvironmentId, PluginCardReference, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { usePluginCatalogue } from "../../state/plugins";
import { environmentPresentations } from "../../state/presentation";

/**
 * A card an agent's plugin call left in the conversation. The phone shows the summary the tool
 * result recorded; Open shows the plugin's card view full screen when the plugin can serve it.
 */
export function ThreadPluginCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly card: PluginCardReference;
}) {
  const navigation = useNavigation();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const catalogue = usePluginCatalogue(props.environmentId);
  const presentation = resolvePluginCardPresentation({
    card: props.card,
    supported: pluginConversationCardsSupported(
      presentations.get(props.environmentId)?.serverConfig?.environment.capabilities,
    ),
    installations:
      catalogue.availability === "available" && catalogue.loaded ? catalogue.installations : null,
    executionDisabled: catalogue.executionDisabled,
  });
  const pluginName =
    presentation.kind === "live"
      ? presentation.installation.manifest.name
      : (presentation.pluginName ?? "Plugin card");
  return (
    <View className="mb-3 gap-2 rounded-xl border border-border bg-card p-3">
      <Text className="text-xs font-t3-medium text-foreground-muted">{pluginName}</Text>
      <Text selectable className="text-sm text-foreground">
        {props.card.summary}
      </Text>
      {presentation.kind === "summary" ? (
        presentation.reason === null ? null : (
          <Text className="text-xs text-foreground-muted">{presentation.reason}</Text>
        )
      ) : (
        <Button
          label="Open"
          accessibilityLabel={`Open ${presentation.view.title}`}
          onPress={() =>
            navigation.navigate("PluginView", {
              environmentId: props.environmentId,
              installationId: presentation.installation.installationId,
              viewId: presentation.view.id,
              threadId: props.threadId,
              card: JSON.stringify(props.card),
            })
          }
        />
      )}
    </View>
  );
}
