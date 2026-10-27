import type { OrchestrationV2PluginBrief } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ThreadDisclosureChevron } from "./thread-work-log";

function PluginBriefText(props: { readonly brief: OrchestrationV2PluginBrief }) {
  return (
    <View className="w-full gap-1 rounded-[14px] border border-border bg-card px-3 py-2">
      <Text className="font-t3-medium text-2xs text-foreground-muted">
        Added by {props.brief.pluginName}
      </Text>
      <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
        <Text selectable className="text-xs leading-normal text-foreground">
          {props.brief.text}
        </Text>
      </ScrollView>
    </View>
  );
}

/** A plugin's empty conversation: the project is fixed, and its brief is readable before sending. */
export function PluginBriefEmptyThread(props: {
  readonly projectName: string;
  readonly brief: OrchestrationV2PluginBrief;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View className="w-full max-w-[420px] items-center gap-3 px-6" testID="plugin-brief-hero">
      <View className="w-full items-center gap-1.5">
        <Text className="text-center text-2xl font-t3-medium tracking-tight text-foreground">
          What should we build
        </Text>
        <Text
          className="text-center text-2xl font-t3-medium tracking-tight text-foreground"
          numberOfLines={1}
        >
          in {props.projectName}?
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityHint={`Double tap to ${open ? "hide" : "show"} the brief.`}
        hitSlop={8}
        onPress={() => setOpen((value) => !value)}
      >
        <Text className="text-center text-sm text-foreground-secondary">
          {props.brief.pluginName} adds its brief to your first message ·{" "}
          <Text className="font-t3-medium text-sm text-foreground">{open ? "Hide" : "View"}</Text>
        </Text>
      </Pressable>
      {open ? <PluginBriefText brief={props.brief} /> : null}
    </View>
  );
}

/** Under a sent message: exactly what the plugin added for the agent, folded by default. */
export function SentPluginBriefDisclosure(props: {
  readonly brief: OrchestrationV2PluginBrief;
  readonly maxWidth: number | `${number}%`;
  readonly iconSubtleColor: ColorValue;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View className="mt-1 items-end gap-1" style={{ maxWidth: props.maxWidth }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={6}
        className="flex-row items-center gap-1 pr-0.5"
        onPress={() => setOpen((value) => !value)}
      >
        <ThreadDisclosureChevron
          expanded={open}
          collapsedDirection="right"
          size={10}
          tintColor={props.iconSubtleColor}
        />
        <Text className="font-t3-medium text-xs text-foreground-secondary">
          Includes {props.brief.pluginName}'s brief
        </Text>
      </Pressable>
      {open ? <PluginBriefText brief={props.brief} /> : null}
    </View>
  );
}
