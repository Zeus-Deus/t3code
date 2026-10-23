import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  buildPluginSettingsPatch,
  describePluginCapabilities,
  initialPluginGrants,
  isPluginActive,
  isPluginRecordReadOnly,
  isPluginUnavailable,
  parsePluginSourceInput,
  pluginApprovalBacklogStep,
  pluginAttention,
  pluginAttentionNotice,
  pluginCurrentRevisionNote,
  pluginDisplayVersion,
  pluginHasUnsupportedRequirement,
  pluginNeedsProjects,
  pluginRecoveryActions,
  pluginRecoveryDetails,
  pluginRemovalNote,
  pluginReviewSubject,
  pluginSettingsDraft,
  pluginSourceLabel,
  pluginStatusPresentation,
  type PluginReviewRevision,
  type PluginSettingDraft,
} from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  resolveEnvironmentMachineKind,
  type PluginGrants,
  type PluginInstallation,
  type ProjectId,
} from "@t3tools/contracts";
import { useState, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects } from "../../state/entities";
import { appAtomRegistry } from "../../state/atom-registry";
import { lastPluginInstallAtom, pluginEnvironment, usePluginCatalogue } from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsChoiceRow } from "../settings/components/SettingsChoiceRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "../settings/components/SettingsEnvironmentFilterHeader";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import {
  useSettingsEnvironmentFilter,
  type SettingsTarget,
} from "../settings/settings-environment-filter";
import {
  pluginFailureMessage,
  usePluginActionRunner,
  usePluginIntentApplier,
} from "./usePluginActions";
import { usePluginEventBacklog } from "./usePluginEventBacklog";
import { usePluginRepair } from "./usePluginRepair";

const REVIEW_ROW_LABELS: Record<PluginReviewRevision, string> = {
  install: "Review permissions",
  update: "Review update",
  "local-repair": "Review local fix",
  previous: "Review previous version",
};

const formatTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

type PluginRouteParams = { readonly environmentId: string; readonly installationId: string };

// These screens live in the settings stack, which the root navigator type does not describe.
type PluginRoutes = {
  SettingsPluginInstall: undefined;
  SettingsPluginDetail: PluginRouteParams;
  SettingsPluginReview: PluginRouteParams;
  SettingsPluginSettings: PluginRouteParams;
};
const usePluginNavigation = () => useNavigation<NativeStackNavigationProp<PluginRoutes>>();

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag !== "Failure") return false;
  if (!isAtomCommandInterrupted(result)) {
    Dialog.alert(title, pluginFailureMessage(squashAtomCommandFailure(result)));
  }
  return true;
}

/** Android draws its own header; iOS uses the native stack header. */
function PluginScreen(props: {
  readonly title: string;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}) {
  const navigation = usePluginNavigation();
  const insets = useSafeAreaInsets();
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={props.title}
            trailing={props.trailing}
            onBack={() => navigation.goBack()}
          />
        </>
      ) : null}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {props.children}
      </ScrollView>
    </View>
  );
}

function Message(props: { readonly children: ReactNode; readonly tone?: "danger" }) {
  return (
    <Text
      className={
        props.tone === "danger"
          ? "p-4 text-base text-danger-foreground"
          : "p-4 text-base text-foreground-muted"
      }
    >
      {props.children}
    </Text>
  );
}

function useInstallation(params: PluginRouteParams) {
  const environmentId = EnvironmentId.make(params.environmentId);
  const catalogue = usePluginCatalogue(environmentId);
  const installation =
    catalogue.installations.find((entry) => entry.installationId === params.installationId) ?? null;
  return { environmentId, catalogue, installation };
}

export function SettingsPluginsRouteScreen() {
  const { availableTargets, selectedTargets } = useSettingsEnvironmentFilter();
  const navigation = usePluginNavigation();
  const install = () => navigation.navigate("SettingsPluginInstall");
  return (
    <>
      <SettingsEnvironmentFilterHeader
        trailingItems={[
          withNativeGlassHeaderItem({
            type: "button",
            label: "",
            accessibilityLabel: "Install plugin",
            icon: { type: "sfSymbol", name: "plus" } as const,
            disabled: selectedTargets.length === 0,
            onPress: install,
          }),
        ]}
      />
      <PluginScreen
        title="Plugins"
        trailing={
          <View className="flex-row items-center">
            <AndroidSettingsEnvironmentFilter />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Install plugin"
              disabled={selectedTargets.length === 0}
              onPress={install}
              className="size-11 items-center justify-center rounded-full disabled:opacity-50"
            >
              <SymbolView name="plus" size={22} tintColorClassName="accent-icon" />
            </Pressable>
          </View>
        }
      >
        <Text className="px-2 text-sm text-foreground-muted">
          Plugins run as separate processes on the environment you install them on, with that
          machine user&apos;s access. They are not sandboxed; install plugins you trust.
        </Text>
        {selectedTargets.length === 0 ? (
          <Text className="px-2 text-base text-foreground-muted">
            {availableTargets.length === 0
              ? "Connect an environment to manage its plugins."
              : "No environments match these filters. Change the filter above."}
          </Text>
        ) : (
          selectedTargets.map((target) => (
            <EnvironmentPlugins key={target.environmentId} environment={target} />
          ))
        )}
      </PluginScreen>
    </>
  );
}

function EnvironmentPlugins(props: { readonly environment: SettingsTarget }) {
  const { environment } = props;
  const catalogue = usePluginCatalogue(environment.environmentId);
  const navigation = usePluginNavigation();
  const body = (() => {
    switch (catalogue.availability) {
      case "unknown":
      case "disconnected":
        return <Message>Reconnect {environment.label} to manage its plugins.</Message>;
      case "unsupported":
        return <Message>Update the T3 Code server on {environment.label} to use plugins.</Message>;
      case "client-outdated":
        return (
          <Message>
            {environment.label} uses a newer plugin version. Update T3 Code on this device to manage
            its plugins.
          </Message>
        );
      case "forbidden":
        return <Message>This connection cannot read the environment&apos;s plugins.</Message>;
      case "available":
        if (catalogue.error !== null) return <Message tone="danger">{catalogue.error}</Message>;
        if (!catalogue.loaded) return <Message>Loading plugins…</Message>;
        if (catalogue.installations.length === 0) {
          return catalogue.unavailableMessage ? null : <Message>No plugins installed.</Message>;
        }
        return catalogue.installations.map((installation) => {
          const status = pluginStatusPresentation(installation, {
            executionDisabled: catalogue.executionDisabled,
          });
          const attention = pluginAttention(installation);
          return (
            <SettingsActionRow
              key={installation.installationId}
              icon="cube"
              label={installation.manifest.name}
              description={[
                status.label,
                pluginDisplayVersion(installation) === null
                  ? undefined
                  : `v${pluginDisplayVersion(installation)}`,
                attention?.notify ? attention.title : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
              onPress={() =>
                navigation.navigate("SettingsPluginDetail", {
                  environmentId: environment.environmentId,
                  installationId: installation.installationId,
                })
              }
            />
          );
        });
    }
  })();
  return (
    <SettingsSection
      title={environment.label}
      titleIcon={
        <EnvironmentMachineSymbol
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          size={16}
          tintColorClassName={
            Platform.OS === "android" ? "accent-primary" : "accent-foreground-muted"
          }
        />
      }
    >
      {catalogue.availability === "available" && catalogue.loaded ? (
        <PluginEnvironmentNotices catalogue={catalogue} />
      ) : null}
      {body}
    </SettingsSection>
  );
}

/** The same grouped facts as the web sidebar notice, shown where they can be acted on. */
function PluginEnvironmentNotices(props: {
  readonly catalogue: ReturnType<typeof usePluginCatalogue>;
}) {
  const { catalogue } = props;
  const notice = pluginAttentionNotice({
    installations: catalogue.installations,
    unavailableMessage: catalogue.unavailableMessage,
  });
  return (
    <>
      {catalogue.unavailableMessage ? (
        <View className="p-4">
          <Notice
            tone="danger"
            icon="exclamationmark.triangle"
            message={`Plugins here are off: ${catalogue.unavailableMessage} Your plugins and their data were left untouched.`}
          />
        </View>
      ) : notice ? (
        <View className="p-4">
          <Notice
            icon="exclamationmark.triangle"
            iconTone={notice.tone === "error" ? "danger" : "default"}
            message={`${notice.title}. ${notice.description}`}
          />
        </View>
      ) : null}
      {catalogue.executionDisabled ? (
        <View className="p-4">
          <Notice
            icon="info.circle"
            message="Plugin code is turned off on this environment. Nothing runs until T3 Code starts with plugins on, but you can still review, disable, or remove plugins."
          />
        </View>
      ) : null}
    </>
  );
}

export function SettingsPluginDetailRouteScreen({ route }: StaticScreenProps<PluginRouteParams>) {
  const { environmentId, catalogue, installation } = useInstallation(route.params);
  return (
    <PluginScreen title={installation?.manifest.name ?? "Plugin"}>
      {installation === null ? (
        <Text className="px-2 text-base text-foreground-muted">
          {catalogue.loaded ? "This plugin is no longer installed." : "Loading plugin…"}
        </Text>
      ) : (
        <PluginDetail
          key={installation.installationId}
          environmentId={environmentId}
          installation={installation}
          recoverySupported={catalogue.recoverySupported}
          executionDisabled={catalogue.executionDisabled}
        />
      )}
    </PluginScreen>
  );
}

function PluginDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly recoverySupported: boolean;
  readonly executionDisabled: boolean;
}) {
  const { environmentId, installation, recoverySupported } = props;
  const { manifest } = installation;
  const navigation = usePluginNavigation();
  const status = pluginStatusPresentation(installation, {
    executionDisabled: props.executionDisabled,
  });
  const attention = pluginAttention(installation);
  const readOnly = isPluginRecordReadOnly(installation);
  const unavailable = isPluginUnavailable(installation);
  const recovery = pluginRecoveryActions(installation, recoverySupported);
  const displayVersion = pluginDisplayVersion(installation);
  const details = [
    ...pluginRecoveryDetails(installation, formatTime),
    // The Source section is hidden for a read-only record, so its validated version shows here.
    ...(readOnly && displayVersion !== null
      ? [{ label: "Version", value: `v${displayVersion}` }]
      : []),
  ];
  const pendingRevision = installation.pendingUpdate
    ? pluginReviewSubject(installation).revision
    : null;
  const active = isPluginActive(installation) && !props.executionDisabled;
  const canManage = useAtomValue(pluginEnvironment.setEnabled.permissionAtom(environmentId));
  const canRepair = useAtomValue(pluginEnvironment.prepareRepair.permissionAtom(environmentId));
  const canInvoke = useAtomValue(pluginEnvironment.invoke.permissionAtom(environmentId));
  const setEnabled = useAtomCommand(pluginEnvironment.setEnabled, { reportFailure: false });
  const refresh = useAtomCommand(pluginEnvironment.refresh, { reportFailure: false });
  const resume = useAtomCommand(pluginEnvironment.resume, { reportFailure: false });
  const remove = useAtomCommand(pluginEnvironment.remove, { reportFailure: false });
  const stageRepair = useAtomCommand(pluginEnvironment.stageRepair, { reportFailure: false });
  const stagePrevious = useAtomCommand(pluginEnvironment.stagePrevious, { reportFailure: false });
  const resolveBacklog = usePluginEventBacklog();
  const repair = usePluginRepair();
  const runAction = usePluginActionRunner();
  const applyIntents = usePluginIntentApplier();
  const [busy, setBusy] = useState<string | null>(null);
  const routeParams = { environmentId, installationId: installation.installationId };
  const target = { installationId: installation.installationId };
  const review = () => navigation.navigate("SettingsPluginReview", routeParams);
  const pluginTarget = { environmentId, installation, threadId: null };

  // Promise#finally because React Compiler cannot compile a try/finally without a catch. The
  // executor turns a synchronous throw into a rejection; failures still reach the caller.
  const withBusy = (key: string, run: () => Promise<void>) => {
    setBusy(key);
    return new Promise<void>((resolve) => resolve(run())).finally(() => setBusy(null));
  };
  const toggle = (enabled: boolean) => {
    if (enabled && status.primary === "review") {
      review();
      return;
    }
    void withBusy("enable", async () => {
      const backlog = enabled
        ? await resolveBacklog(environmentId, installation, recoverySupported)
        : ({ proceed: true } as const);
      if (!backlog.proceed) return;
      reportFailure(
        `Could not ${enabled ? "enable" : "disable"} ${manifest.name}`,
        await setEnabled({
          environmentId,
          input: {
            ...target,
            enabled,
            ...(backlog.eventBacklog ? { eventBacklog: backlog.eventBacklog } : {}),
          },
        }),
      );
    });
  };
  const runResume = (title: string) =>
    void withBusy("resume", async () => {
      const backlog = await resolveBacklog(environmentId, installation, recoverySupported);
      if (!backlog.proceed) return;
      reportFailure(
        title,
        await resume({
          environmentId,
          input: {
            ...target,
            ...(backlog.eventBacklog ? { eventBacklog: backlog.eventBacklog } : {}),
          },
        }),
      );
    });
  const checkForChanges = () =>
    withBusy("refresh", async () => {
      const result = await refresh({ environmentId, input: target });
      if (
        reportFailure(`Could not refresh ${manifest.name}`, result) ||
        result._tag !== "Success"
      ) {
        return;
      }
      const pending = result.value.pendingUpdate;
      if (pending === undefined && result.value.digest === installation.digest) {
        Dialog.alert(`${manifest.name} is up to date`);
        return;
      }
      Dialog.alert(
        pending
          ? `${manifest.name} ${pending.manifest.version} is available`
          : `${manifest.name} changed`,
        pending
          ? pluginCurrentRevisionNote(result.value)
          : "Review the new files before they can run.",
        [
          { text: "Later", style: "cancel" },
          { text: "Review", onPress: review },
        ],
      );
    });
  const runStageRepair = () =>
    withBusy("stage-repair", async () => {
      const workspace = installation.recovery?.repair;
      if (workspace === undefined) return;
      const result = await stageRepair({
        environmentId,
        input: { ...target, workspaceId: workspace.workspaceId, baseDigest: workspace.baseDigest },
      });
      if (!reportFailure(`Could not stage the ${manifest.name} fix`, result)) review();
    });
  const confirmUsePrevious = (previous: { readonly version: string; readonly digest: string }) =>
    Dialog.alert(
      `Use v${previous.version} with current data?`,
      `Version ${previous.version} uses your current settings and data. Version ${manifest.version} may have changed them, and T3 Code can't undo that or anything either version did outside T3 Code, such as files, VMs or web services. If v${previous.version} can't read the data, it should stop with an error. You review it next. ${pluginCurrentRevisionNote(installation)}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue to review",
          onPress: () =>
            void withBusy("use-previous", async () => {
              const result = await stagePrevious({
                environmentId,
                input: {
                  ...target,
                  expectedDigest: previous.digest,
                  acknowledgeCurrentData: true,
                },
              });
              if (
                !reportFailure(`Could not prepare ${manifest.name} v${previous.version}`, result)
              ) {
                review();
              }
            }),
        },
      ],
    );
  const confirmRemove = () =>
    Dialog.alert(
      `Remove ${manifest.name}?`,
      `The plugin stops and its files are removed. ${pluginRemovalNote(installation)} Keep its settings and data so a reinstall picks up where it left off?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove, keep data",
          onPress: () => void removePlugin(false),
        },
        {
          text: "Remove and delete data",
          style: "destructive",
          onPress: () => void removePlugin(true),
        },
      ],
    );
  const removePlugin = (deleteData: boolean) =>
    withBusy("remove", async () => {
      const result = await remove({
        environmentId,
        input: { ...target, ...(deleteData ? { deleteData } : {}) },
      });
      if (!reportFailure(`Could not remove ${manifest.name}`, result)) navigation.goBack();
    });

  return (
    <>
      {manifest.description ? (
        <Text className="px-2 text-base text-foreground-muted">{manifest.description}</Text>
      ) : null}
      <SettingsSection
        title="Status"
        footer={
          attention ? `${attention.title}: ${attention.message}` : (installation.error ?? undefined)
        }
      >
        <SettingsSwitchRow
          label="Enabled"
          subtitle={recovery.runningLocalFix ? `${status.label} · Local fix` : status.label}
          value={installation.enabled}
          // Turning a plugin off always works; turning it on needs a host that can run it.
          disabled={
            !canManage || busy !== null || readOnly || (!installation.enabled && unavailable)
          }
          onValueChange={toggle}
        />
        {readOnly ? null : status.primary === "review" ? (
          <SettingsActionRow
            icon="exclamationmark.shield"
            label="Review permissions"
            description="Nothing runs until you approve this version."
            disabled={!canManage}
            onPress={review}
          />
        ) : installation.pendingUpdate && pendingRevision !== null ? (
          <SettingsActionRow
            icon="arrow.down.circle"
            label={
              pendingRevision === "update"
                ? `Update ${installation.pendingUpdate.manifest.version} available`
                : REVIEW_ROW_LABELS[pendingRevision]
            }
            description={`Review it. ${pluginCurrentRevisionNote(installation)}`}
            disabled={!canManage}
            onPress={review}
          />
        ) : status.primary === "resume" ? (
          <SettingsActionRow
            icon="arrow.clockwise"
            label="Restart"
            loading={busy === "resume"}
            disabled={!canManage}
            onPress={() => runResume(`Could not restart ${manifest.name}`)}
          />
        ) : null}
        {!readOnly &&
        attention?.kind === "events-paused" &&
        installation.enabled &&
        !props.executionDisabled ? (
          <SettingsActionRow
            icon="arrow.clockwise"
            label="Resume background events"
            description={attention.message}
            loading={busy === "resume"}
            disabled={!canManage}
            onPress={() => runResume(`Could not resume ${manifest.name}`)}
          />
        ) : null}
      </SettingsSection>

      {recovery.repair !== null ? (
        <SettingsSection
          title="Recovery"
          footer="Repair copies the exact running files into a folder under T3 home and opens a draft for an agent. Nothing is sent, installed or enabled until you choose."
        >
          <SettingsActionRow
            icon="square.and.pencil"
            label={recovery.repair === "open" ? "Open repair draft" : "Repair with agent"}
            loading={busy === "repair"}
            disabled={!canRepair}
            onPress={() => void withBusy("repair", () => repair(environmentId, installation))}
          />
          {recovery.stageRepair ? (
            <SettingsActionRow
              icon="doc.text"
              label="Review local fix"
              description="Stage the repair folder's files and review what changed."
              loading={busy === "stage-repair"}
              disabled={!canManage}
              onPress={() => void runStageRepair()}
            />
          ) : null}
          {recovery.usePrevious !== null ? (
            <SettingsActionRow
              icon="arrow.uturn.backward"
              label={`Use previous version (v${recovery.usePrevious.version})`}
              description="Runs with your current data; this is not a rollback."
              loading={busy === "use-previous"}
              disabled={!canManage}
              onPress={() => recovery.usePrevious && confirmUsePrevious(recovery.usePrevious)}
            />
          ) : null}
        </SettingsSection>
      ) : null}

      {manifest.actions.length > 0 ? (
        <SettingsSection
          title="Actions"
          footer="Long-press a thread in the list, or the copy button under an assistant message, to run these on that thread or message."
        >
          {manifest.actions.map((action) => (
            <SettingsActionRow
              key={action.id}
              icon="play"
              label={action.title}
              description={action.description}
              disabled={!active || !canInvoke}
              loading={busy === `action:${action.id}`}
              onPress={() =>
                void withBusy(`action:${action.id}`, () => runAction(pluginTarget, action, {}))
              }
            />
          ))}
        </SettingsSection>
      ) : null}

      {manifest.views.length > 0 ? (
        <SettingsSection title="Views">
          {manifest.views.map((view) => (
            <SettingsActionRow
              key={view.id}
              icon="square.on.square"
              label={view.title}
              disabled={!active || !installation.grants.capabilities.includes("ui")}
              onPress={() =>
                applyIntents(pluginTarget, [{ type: "view.open", viewId: view.id }], true)
              }
            />
          ))}
        </SettingsSection>
      ) : null}

      {(manifest.sidebarViews ?? []).length > 0 ? (
        // Sidebar views rearrange the web and desktop sidebar only; say so rather than hide them.
        <SettingsSection
          title="Sidebar views"
          footer="Shown in the web and desktop sidebar. The thread list on mobile keeps its activity layout."
        >
          {(manifest.sidebarViews ?? []).map((view) => (
            <SettingsRow key={view.id} icon="sidebar.left" label={view.title} disabled />
          ))}
        </SettingsSection>
      ) : null}

      {readOnly ? null : (
        <SettingsSection title="Manage">
          <SettingsActionRow
            icon="exclamationmark.shield"
            label="Permissions"
            disabled={!canManage}
            onPress={review}
          />
          {manifest.settings.length > 0 ? (
            <SettingsActionRow
              icon="gearshape"
              label="Settings"
              disabled={!canManage}
              onPress={() => navigation.navigate("SettingsPluginSettings", routeParams)}
            />
          ) : null}
          <SettingsActionRow
            icon="arrow.clockwise"
            label={
              recovery.runningLocalFix ? "Check publisher for updates" : "Check source for changes"
            }
            loading={busy === "refresh"}
            disabled={!canManage}
            onPress={() => void checkForChanges()}
          />
          <SettingsActionRow
            icon="trash"
            label="Remove"
            tone="danger"
            loading={busy === "remove"}
            disabled={!canManage}
            onPress={confirmRemove}
          />
        </SettingsSection>
      )}

      {details.length > 0 ? (
        <SettingsSection
          title="Details"
          footer="Versions are shown as they were when each event happened. Plugins are trusted code with this machine user's access; they are not sandboxed."
        >
          <View className="gap-3 p-4">
            {details.map((row) => (
              <View key={row.label} className="gap-0.5">
                <Text className="text-sm text-foreground-muted">{row.label}</Text>
                <Text
                  selectable
                  className={
                    row.code === true
                      ? "font-mono text-xs text-foreground"
                      : "text-sm text-foreground"
                  }
                >
                  {row.value}
                </Text>
              </View>
            ))}
          </View>
        </SettingsSection>
      ) : null}

      {/* A read-only record's id, source and fingerprint are placeholders around the saved record. */}
      {readOnly ? null : (
        <SettingsSection title="Source">
          <View className="gap-1 p-4">
            <Text className="text-sm text-foreground-muted">
              {manifest.id} · v{manifest.version}
            </Text>
            <Text className="text-sm text-foreground" selectable>
              {pluginSourceLabel(installation.source)}
            </Text>
            <Text className="font-mono text-xs text-foreground-muted" selectable>
              {installation.digest}
            </Text>
          </View>
        </SettingsSection>
      )}
    </>
  );
}

export function SettingsPluginInstallRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const navigation = usePluginNavigation();
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const environmentId = chosen ?? selectedTargets[0]?.environmentId ?? null;
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const install = useAtomCommand(pluginEnvironment.install, { reportFailure: false });
  const canInstall = useAtomValue(pluginEnvironment.install.permissionAtom(environmentId));
  const catalogue = usePluginCatalogue(environmentId);
  const submit = async () => {
    if (environmentId === null) return;
    const parsed = parsePluginSourceInput(source);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setInstalling(true);
    setError(null);
    const result = await install({ environmentId, input: { source: parsed.source } });
    setInstalling(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(pluginFailureMessage(squashAtomCommandFailure(result)));
      }
      return;
    }
    appAtomRegistry.set(lastPluginInstallAtom, { environmentId, installation: result.value });
    navigation.navigate("SettingsPluginReview", {
      environmentId,
      installationId: result.value.installationId,
    });
  };
  const unavailable =
    environmentId === null
      ? "Connect an environment first."
      : catalogue.availability === "unsupported"
        ? "This environment's T3 Code server does not support plugins."
        : catalogue.availability === "client-outdated"
          ? "This environment uses a newer plugin version. Update T3 Code on this device to install plugins there."
          : !canInstall
            ? "This connection cannot install plugins. Installing needs access and terminal permissions."
            : null;
  return (
    <PluginScreen title="Install plugin">
      <Text className="px-2 text-sm text-foreground-muted">
        T3 Code copies the plugin and reads its manifest. Nothing runs until you review and enable
        it.
      </Text>
      {selectedTargets.length > 1 ? (
        <SettingsSection title="Environment">
          {selectedTargets.map((target, index) => (
            <SettingsChoiceRow
              key={target.environmentId}
              label={target.label}
              selected={target.environmentId === environmentId}
              separated={index > 0}
              onPress={() => setChosen(target.environmentId)}
            />
          ))}
        </SettingsSection>
      ) : null}
      <SettingsSection
        title="Source"
        footer="A folder on the environment, or an https Git URL. Add #tag or #commit to pin a version."
      >
        <View className="gap-2 p-4">
          <AppTextInput
            accessibilityLabel="Plugin source"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="/path/to/plugin or https://…/plugin.git#v1.0.0"
            value={source}
            onChangeText={(next) => {
              setSource(next);
              setError(null);
            }}
            onSubmitEditing={() => void submit()}
            returnKeyType="go"
            editable={!installing}
          />
          {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
          {unavailable ? (
            <Text className="text-sm text-foreground-muted">{unavailable}</Text>
          ) : null}
        </View>
      </SettingsSection>
      <Button
        label="Install and review"
        tone="primary"
        fullWidth
        loading={installing}
        disabled={source.trim() === "" || unavailable !== null}
        onPress={() => void submit()}
      />
    </PluginScreen>
  );
}

export function SettingsPluginReviewRouteScreen({ route }: StaticScreenProps<PluginRouteParams>) {
  const { environmentId, installationId } = route.params;
  return <PluginReviewScreen key={`${environmentId}:${installationId}`} params={route.params} />;
}

function PluginReviewScreen(props: { readonly params: PluginRouteParams }) {
  const { environmentId, catalogue, installation: listed } = useInstallation(props.params);
  // The review opens before the catalogue push includes a new install; its result stands in
  // until the catalogue first lists it, as the web review dialog does. After that, a missing
  // entry means it was removed.
  const [installed, setInstalled] = useState(() => {
    const last = appAtomRegistry.get(lastPluginInstallAtom);
    return last?.environmentId === environmentId &&
      last.installation.installationId === props.params.installationId
      ? last.installation
      : null;
  });
  if (listed !== null && installed !== null) setInstalled(null);
  const installation = listed ?? installed;
  return (
    <PluginScreen title="Review plugin">
      {installation === null ? (
        <Text className="px-2 text-base text-foreground-muted">
          {catalogue.loaded ? "This plugin is no longer installed." : "Loading plugin…"}
        </Text>
      ) : (
        <PluginReview
          key={pluginReviewSubject(installation).digest}
          environmentId={environmentId}
          installation={installation}
          recoverySupported={catalogue.recoverySupported}
        />
      )}
    </PluginScreen>
  );
}

function reviewLabels(revision: PluginReviewRevision, runningLocalFix: boolean) {
  switch (revision) {
    case "install":
      return { keep: "Not now", discard: "Discard", approve: "Approve and enable" };
    case "update":
      return runningLocalFix
        ? {
            keep: "Keep local fix",
            discard: "Discard update",
            approve: "Switch to publisher version",
          }
        : { keep: "Keep current version", discard: "Discard update", approve: "Approve update" };
    case "local-repair":
      return {
        keep: "Keep current version",
        discard: "Discard staged fix",
        approve: "Use local fix",
      };
    case "previous":
      return { keep: "Keep current version", discard: "Discard", approve: "Use previous version" };
  }
}

const SETTING_CHANGE_TEXT = {
  added: "added",
  removed: "no longer used; its value stays with the previous version",
  "type-changed": "changes type; the stored value may reset",
} as const;

function PluginReview(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly recoverySupported: boolean;
}) {
  const { environmentId, installation } = props;
  const subject = pluginReviewSubject(installation);
  const { manifest } = subject;
  const isUpdate = subject.kind === "update";
  const navigation = usePluginNavigation();
  const capabilities = describePluginCapabilities(manifest);
  const runningLocalFix = installation.recovery?.activeSource === "local-repair";
  const labels = reviewLabels(subject.revision, runningLocalFix);
  const unsupported = capabilities
    .filter((entry) => !entry.known && !entry.optional)
    .map((entry) => entry.capability);
  // The running version's availability says nothing about a staged update.
  const incompatible =
    (!isUpdate && isPluginUnavailable(installation)) || pluginHasUnsupportedRequirement(manifest);
  const resolveBacklog = usePluginEventBacklog();
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );
  const [grants, setGrants] = useState<PluginGrants>(() => initialPluginGrants(installation));
  const [saving, setSaving] = useState(false);
  const consent = useAtomCommand(pluginEnvironment.consent, { reportFailure: false });
  const setEnabled = useAtomCommand(pluginEnvironment.setEnabled, { reportFailure: false });
  const discard = useAtomCommand(pluginEnvironment.discardPendingUpdate, { reportFailure: false });
  const canManage = useAtomValue(pluginEnvironment.consent.permissionAtom(environmentId));
  const changed =
    !isUpdate &&
    installation.consentedDigest !== null &&
    installation.consentedDigest !== installation.digest;
  const discardUpdate = async () => {
    setSaving(true);
    const result = await discard({
      environmentId,
      input: { installationId: installation.installationId },
    });
    setSaving(false);
    if (!reportFailure(`Could not discard the ${manifest.name} update`, result)) {
      navigation.goBack();
    }
  };
  const projectScopedGranted = capabilities.some(
    (entry) => entry.known && entry.projectScoped && grants.capabilities.includes(entry.capability),
  );
  const approve = async () => {
    setSaving(true);
    // Asked before anything is saved, so cancelling leaves the plugin as it was.
    const backlogStep = pluginApprovalBacklogStep(installation);
    const backlog =
      backlogStep === null
        ? ({ proceed: true } as const)
        : await resolveBacklog(environmentId, installation, props.recoverySupported);
    if (!backlog.proceed) {
      setSaving(false);
      return;
    }
    const eventBacklog = backlog.eventBacklog ? { eventBacklog: backlog.eventBacklog } : {};
    const consented = await consent({
      environmentId,
      input: {
        installationId: installation.installationId,
        digest: subject.digest,
        grants,
        ...(backlogStep === "consent" ? eventBacklog : {}),
      },
    });
    if (reportFailure(`Could not approve ${manifest.name}`, consented)) {
      setSaving(false);
      return;
    }
    // Approving an update keeps the plugin's enabled state; a first approval turns it on.
    if (!isUpdate && consented._tag === "Success" && !consented.value.enabled) {
      const enabled = await setEnabled({
        environmentId,
        input: {
          installationId: installation.installationId,
          enabled: true,
          ...(backlogStep === "enable" ? eventBacklog : {}),
        },
      });
      if (reportFailure(`Approved, but could not enable ${manifest.name}`, enabled)) {
        setSaving(false);
        return;
      }
    }
    setSaving(false);
    navigation.goBack();
  };
  return (
    <>
      <View className="gap-1 px-2">
        <Text className="text-lg font-t3-medium text-foreground">
          {manifest.name} v{manifest.version}
        </Text>
        {manifest.description ? (
          <Text className="text-base text-foreground-muted">{manifest.description}</Text>
        ) : null}
      </View>
      {subject.revision === "update" ? (
        <Text className="px-2 text-sm text-foreground-muted">
          {runningLocalFix
            ? `This is the publisher's version ${manifest.version}. ${pluginCurrentRevisionNote(installation)} After switching, your local fix stays available as the previous version.`
            : pluginCurrentRevisionNote(installation)}
        </Text>
      ) : null}
      {subject.revision === "local-repair" ? (
        <Text className="px-2 text-sm text-foreground-muted">
          These files come from your repair folder. {pluginCurrentRevisionNote(installation)}{" "}
          Settings, data and event position carry over, and T3 Code keeps tracking the
          publisher&apos;s source so you can switch back later.
        </Text>
      ) : null}
      {subject.revision === "previous" ? (
        <Text className="px-2 text-sm text-warning-foreground">
          Version {manifest.version} uses your current settings and data, not the data it had
          before. T3 Code can&apos;t undo what version {installation.manifest.version} changed,
          inside or outside T3 Code.
        </Text>
      ) : null}
      {subject.removedCapabilities.length > 0 || subject.settingChanges.length > 0 ? (
        <SettingsSection title={`Changes from v${installation.manifest.version}`}>
          <View className="gap-1 p-4">
            {subject.removedCapabilities.map((capability) => (
              <Text key={`cap:${capability}`} className="text-sm text-foreground-muted">
                No longer asks for {capability}
              </Text>
            ))}
            {subject.settingChanges.map((change) => (
              <Text key={`setting:${change.key}`} className="text-sm text-foreground-muted">
                {change.label} setting {SETTING_CHANGE_TEXT[change.change]}
              </Text>
            ))}
          </View>
        </SettingsSection>
      ) : null}
      {changed ? (
        <Text className="px-2 text-sm text-warning-foreground">
          The plugin&apos;s files changed since you approved them. It stays stopped until you
          approve this version.
        </Text>
      ) : null}
      <SettingsSection title="Permissions">
        {capabilities.length === 0 ? (
          <Message>This plugin asks for no permissions.</Message>
        ) : (
          capabilities.map((entry) => (
            <SettingsSwitchRow
              key={entry.capability}
              label={[
                entry.title,
                subject.newCapabilities.includes(entry.capability) ? "(new)" : undefined,
                entry.optional ? "(optional)" : undefined,
              ]
                .filter(Boolean)
                .join(" ")}
              subtitle={entry.detail}
              value={entry.known && grants.capabilities.includes(entry.capability)}
              disabled={!entry.known || saving}
              onValueChange={(next) => {
                if (!entry.known) return;
                setGrants((current) => ({
                  ...current,
                  capabilities: next
                    ? [...current.capabilities, entry.capability]
                    : current.capabilities.filter((capability) => capability !== entry.capability),
                }));
              }}
            />
          ))
        )}
      </SettingsSection>
      {pluginNeedsProjects(manifest) ? (
        <SettingsSection
          title="Projects"
          footer="Thread and background permissions apply only to the projects you pick."
        >
          {projects.length === 0 ? (
            <Message>No projects on this environment.</Message>
          ) : (
            projects.map((project) => (
              <SettingsSwitchRow
                key={project.id}
                label={project.title}
                subtitle={project.workspaceRoot}
                value={grants.projectIds.includes(project.id)}
                disabled={!projectScopedGranted || saving}
                onValueChange={(next) =>
                  setGrants((current) => ({
                    ...current,
                    projectIds: next
                      ? [...current.projectIds, project.id]
                      : current.projectIds.filter((id: ProjectId) => id !== project.id),
                  }))
                }
              />
            ))
          )}
        </SettingsSection>
      ) : null}
      <SettingsSection title="Source">
        <View className="gap-1 p-4">
          <Text className="text-sm text-foreground" selectable>
            {pluginSourceLabel(subject.source)}
          </Text>
          <Text className="font-mono text-xs text-foreground-muted" selectable>
            {subject.digest}
          </Text>
        </View>
      </SettingsSection>
      {incompatible ? (
        <Text className="px-2 text-sm text-danger-foreground">
          {unsupported.length > 0
            ? `Needs ${unsupported.join(", ")}, which this environment does not support, so it cannot be enabled.`
            : (installation.error ??
              "This plugin needs permissions this environment does not support, so it cannot be enabled.")}
        </Text>
      ) : (
        <Button
          label={labels.approve}
          tone="primary"
          fullWidth
          loading={saving}
          disabled={!canManage}
          onPress={() => void approve()}
        />
      )}
      {isUpdate ? (
        <>
          <Button
            label={labels.keep}
            tone="secondary"
            fullWidth
            disabled={saving}
            onPress={() => navigation.goBack()}
          />
          <Button
            label={labels.discard}
            tone="danger"
            fullWidth
            disabled={saving || !canManage}
            onPress={() => void discardUpdate()}
          />
        </>
      ) : null}
    </>
  );
}

export function SettingsPluginSettingsRouteScreen({ route }: StaticScreenProps<PluginRouteParams>) {
  const { environmentId, installation } = useInstallation(route.params);
  return (
    <PluginScreen title="Plugin settings">
      {installation === null ? (
        <Text className="px-2 text-base text-foreground-muted">
          This plugin is no longer installed.
        </Text>
      ) : (
        <PluginSettingsForm environmentId={environmentId} installation={installation} />
      )}
    </PluginScreen>
  );
}

function PluginSettingsForm(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
}) {
  const { installation } = props;
  const navigation = usePluginNavigation();
  // Diffed against what the form opened with; see the web settings form.
  const [base] = useState(() => installation.settings);
  const [draft, setDraft] = useState<PluginSettingDraft>(() => pluginSettingsDraft(installation));
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const update = useAtomCommand(pluginEnvironment.updateSettings, { reportFailure: false });
  const set = (key: string, value: string | boolean) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors({});
  };
  const save = async () => {
    const patch = buildPluginSettingsPatch(installation.manifest.settings, base, draft, cleared);
    if (!patch.ok) {
      setErrors(patch.errors);
      return;
    }
    if (Object.keys(patch.values).length > 0) {
      setSaving(true);
      const result = await update({
        environmentId: props.environmentId,
        input: { installationId: installation.installationId, values: patch.values },
      });
      setSaving(false);
      if (reportFailure(`Could not save ${installation.manifest.name} settings`, result)) return;
    }
    navigation.goBack();
  };
  return (
    <>
      <Text className="px-2 text-sm text-foreground-muted">
        Stored on this environment. Secrets are write-only: T3 Code never shows them again.
      </Text>
      <SettingsSection title={installation.manifest.name}>
        {installation.manifest.settings.map((setting, index) => {
          const value = draft[setting.key];
          if (setting.type === "boolean") {
            return (
              <SettingsSwitchRow
                key={setting.key}
                label={setting.label}
                subtitle={setting.description}
                value={value === true}
                onValueChange={(next) => set(setting.key, next)}
              />
            );
          }
          const isSecret = setting.type === "secret";
          const isCleared = cleared.has(setting.key);
          return (
            <View
              key={setting.key}
              className={index === 0 ? "gap-2 p-4" : "gap-2 border-t border-border-subtle p-4"}
            >
              <Text className="text-sm font-t3-medium text-foreground-muted">{setting.label}</Text>
              <AppTextInput
                accessibilityLabel={setting.label}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={isSecret}
                keyboardType={setting.type === "number" ? "decimal-pad" : "default"}
                placeholder={isSecret ? "Enter a new value to replace it" : undefined}
                value={typeof value === "string" ? value : ""}
                onChangeText={(next) => {
                  set(setting.key, next);
                  if (isSecret && isCleared) {
                    setCleared((current) => {
                      const nextSet = new Set(current);
                      nextSet.delete(setting.key);
                      return nextSet;
                    });
                  }
                }}
              />
              {errors[setting.key] ? (
                <Text className="text-sm text-danger-foreground">{errors[setting.key]}</Text>
              ) : isSecret ? (
                <View className="flex-row items-center justify-between gap-3">
                  <Text className="min-w-0 flex-1 text-sm text-foreground-muted">
                    {isCleared
                      ? "The stored value will be deleted when you save."
                      : (setting.description ?? "Leave empty to keep the stored value.")}
                  </Text>
                  <Button
                    label="Clear"
                    tone="text"
                    disabled={isCleared}
                    onPress={() => {
                      set(setting.key, "");
                      setCleared((current) => new Set(current).add(setting.key));
                    }}
                  />
                </View>
              ) : setting.description ? (
                <Text className="text-sm text-foreground-muted">{setting.description}</Text>
              ) : null}
            </View>
          );
        })}
      </SettingsSection>
      <Button label="Save" tone="primary" fullWidth loading={saving} onPress={() => void save()} />
    </>
  );
}
