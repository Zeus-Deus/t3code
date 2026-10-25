import { useIsFocused, useNavigation } from "@react-navigation/native";
import {
  createPluginThreadStatusPoller,
  pluginChangeKey,
  pluginStatusTopic,
  pluginRunnableInstallations,
  pluginThreadStatusEntries,
  pluginThreadStatusesFor,
  type PluginThreadStatusPoller,
  type PluginThreadStatusValue,
} from "@t3tools/client-runtime/plugins";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState, ScrollView, View } from "react-native";

import { Chip } from "../../components/ui/Chip";
import {
  pluginEnvironment,
  usePluginCatalogue,
  usePluginChangeRevisions,
} from "../../state/plugins";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { newPluginOperationId } from "./usePluginActions";

const NO_VALUES: ReadonlyArray<PluginThreadStatusValue> = [];
const noSubscription = () => () => {};
const noValues = () => NO_VALUES;

/** Asked only while the app is in front and this thread screen is focused. */
function usePluginThreadStatuses(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
}): ReadonlyArray<PluginThreadStatusValue> {
  const catalogue = usePluginCatalogue(props.environmentId);
  // The server answers statuses only to sessions that may operate the environment.
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const invoke = useAtomCommand(pluginEnvironment.invoke, { reportFailure: false });
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  const entries =
    canOperate && catalogue.availability === "available"
      ? pluginThreadStatusEntries(pluginRunnableInstallations(catalogue))
      : [];
  const target = {
    environmentId: props.environmentId,
    threadId: props.threadId,
    projectId: props.projectId,
  };

  const latestInvoke = useRef(invoke);
  useEffect(() => {
    latestInvoke.current = invoke;
  });
  const [poller, setPoller] = useState<PluginThreadStatusPoller | null>(null);
  useEffect(() => {
    const next = createPluginThreadStatusPoller({
      operationId: newPluginOperationId,
      invoke: async (request) => {
        const result = await latestInvoke.current(request);
        if (result._tag === "Success") return result.value;
        throw squashAtomCommandFailure(result);
      },
    });
    setPoller(next);
    return () => next.dispose();
  }, []);
  // Returning to the app or this screen (such as closing the plugin's view) asks again.
  useEffect(() => {
    poller?.update({ target, entries, visible: focused && appActive });
  });
  // A plugin that says a shown status changed is asked again now, not at the next poll.
  const revisions = usePluginChangeRevisions(entries.length > 0 ? props.environmentId : null);
  const statusRevision =
    revisions === null
      ? null
      : entries
          .map(
            ({ installation, item }) =>
              revisions.get(
                pluginChangeKey({
                  installationId: installation.installationId,
                  generation: installation.generation,
                  topic: pluginStatusTopic(item.id),
                }),
              ) ?? 0,
          )
          .join(",");
  const seenStatusRevision = useRef(statusRevision);
  useEffect(() => {
    const seen = seenStatusRevision.current;
    seenStatusRevision.current = statusRevision;
    if (seen !== null && statusRevision !== null && seen !== statusRevision) poller?.refresh();
  }, [poller, statusRevision]);
  const values = useSyncExternalStore(
    poller?.subscribe ?? noSubscription,
    poller?.getSnapshot ?? noValues,
  );
  return pluginThreadStatusesFor(values, target, entries);
}

/**
 * Compact plugin-provided statuses above the composer, such as "Realm · Live". Nothing renders
 * until a plugin reports one. A status with a view opens it full screen, as side panels do here.
 */
export function PluginThreadStatuses(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
}) {
  const navigation = useNavigation();
  const statuses = usePluginThreadStatuses(props);
  if (statuses.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="shrink-0"
      contentContainerClassName="gap-2 px-4 pb-2"
      keyboardShouldPersistTaps="handled"
    >
      {statuses.map(({ key, entry, status }) => {
        const viewId = entry.item.viewId;
        const description =
          status.detail === undefined
            ? entry.installation.manifest.name
            : `${entry.installation.manifest.name}: ${status.detail}`;
        const label = `${entry.item.title} · ${status.label}`;
        const accessibilityLabel = `${label}. ${description}`;
        return viewId === undefined ? (
          <View key={key} accessible accessibilityLabel={accessibilityLabel}>
            <Chip label={label} />
          </View>
        ) : (
          <Chip
            key={key}
            label={label}
            accessibilityLabel={accessibilityLabel}
            onPress={() =>
              navigation.navigate("PluginView", {
                environmentId: props.environmentId,
                installationId: entry.installation.installationId,
                viewId,
                threadId: props.threadId,
              })
            }
          />
        );
      })}
    </ScrollView>
  );
}
