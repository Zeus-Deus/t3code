import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/** The chosen plugin tree's failed-read line above the thread list. */
export function PluginTreeNotice(props: { readonly notice: string | null }) {
  if (props.notice === null) return null;
  return (
    <View className="px-4 pb-1.5 pt-1">
      <Text className="text-xs text-foreground-muted">{props.notice}</Text>
    </View>
  );
}
