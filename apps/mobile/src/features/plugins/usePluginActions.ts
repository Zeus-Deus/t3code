import { useNavigation } from "@react-navigation/native";
import {
  createPluginOperationId,
  notifyPluginThreadActivity,
  planPluginIntents,
  pluginActionHandler,
  pluginFailureNeedsDetails,
  pluginUnsupportedIntentCount,
  pluginUnsupportedIntentNotice,
  type PluginIntentStep,
} from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  PluginError,
  type EnvironmentId,
  type PluginAction,
  type PluginActionContext,
  type PluginClientIntent,
  type PluginInstallation,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { type AlertButton } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { randomHex } from "../../lib/uuid";
import { pluginEnvironment } from "../../state/plugins";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { appendComposerDraftText, getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

/** What the user acted on, fixed before anything is awaited. */
interface MobilePluginTarget {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  /** The thread whose composer receives inserted text; null when acting from settings. */
  readonly threadId: ThreadId | null;
}

export const newPluginOperationId = () => createPluginOperationId(() => randomHex(16));

const isPluginError = Schema.is(PluginError);

export function pluginFailureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim() !== ""
    ? cause.message
    : "The plugin request failed.";
}

const ORIGIN = "origin";

interface PluginAlert {
  readonly title: string;
  readonly message?: string | undefined;
  readonly buttons?: ReadonlyArray<AlertButton>;
}

/**
 * One result can raise several alerts. Android's dialog host shows one at a time and a new one
 * replaces it, so each alert opens the next when it closes.
 */
function alertInTurn(alerts: ReadonlyArray<PluginAlert>) {
  const [first, ...rest] = alerts;
  if (!first) return;
  const next = () => alertInTurn(rest);
  Dialog.alert(
    first.title,
    first.message,
    (first.buttons ?? [{ text: "OK" }]).map((button) => ({
      ...button,
      onPress: () => {
        button.onPress?.();
        next();
      },
    })),
  );
}

/**
 * Applies plugin intents to this device for the target the user picked. Navigation happens only
 * while the screen that started the request is still in front; otherwise the user is asked.
 */
export function usePluginIntentApplier() {
  const navigation = useNavigation();
  const selectWorkspaceDetail = useSelectWorkspaceDetail();

  const openThread = (environmentId: EnvironmentId, threadId: ThreadId) => {
    const destination = { environmentId, threadId };
    selectWorkspaceDetail({ name: "Thread", params: destination });
  };

  const run = (target: MobilePluginTarget, step: PluginIntentStep & { kind: "navigate" }) => {
    const { intent } = step;
    switch (intent.type) {
      case "thread.reveal":
        openThread(target.environmentId, intent.threadId);
        return;
      case "view.open":
        navigation.navigate("PluginView", {
          environmentId: target.environmentId,
          installationId: target.installation.installationId,
          viewId: intent.viewId,
          ...(target.threadId === null ? {} : { threadId: target.threadId }),
        });
        return;
      case "preview.open":
        void tryOpenExternalUrl(intent.url, "plugin");
    }
  };

  return (
    target: MobilePluginTarget,
    intents: ReadonlyArray<PluginClientIntent>,
    stillInFront: boolean,
    unsupported = 0,
    message?: { readonly title: string; readonly text: string },
  ) => {
    const name = target.installation.manifest.name;
    const alerts: PluginAlert[] = [];
    if (message) alerts.push({ title: message.title, message: message.text });
    if (unsupported > 0) {
      const notice = pluginUnsupportedIntentNotice(name, unsupported);
      alerts.push({ title: notice.title, message: notice.description });
    }
    const steps = planPluginIntents({
      origin: {
        environmentId: target.environmentId,
        installationId: target.installation.installationId,
        locationKey: ORIGIN,
        composerKey:
          target.threadId === null ? null : scopedThreadKey(target.environmentId, target.threadId),
        threadId: target.threadId,
      },
      manifest: target.installation.manifest,
      intents,
      currentLocationKey: stillInFront ? ORIGIN : "elsewhere",
      // Mobile opens links in the system browser rather than a thread preview.
      canOpenPreview: false,
    });
    for (const step of steps) {
      if (step.kind === "rejected") {
        alerts.push({ title: `${name} request ignored`, message: step.reason });
        continue;
      }
      if (step.kind === "insert") {
        const existing = getComposerDraftSnapshot(step.composerKey).text;
        const separator = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
        appendComposerDraftText(step.composerKey, `${separator}${step.text}`);
        const threadId = target.threadId;
        if (threadId !== null) {
          alerts.push({
            title: `${name} added text`,
            message: "It is in the thread's draft.",
            buttons: [
              { text: "Done", style: "cancel" },
              { text: "Open thread", onPress: () => openThread(target.environmentId, threadId) },
            ],
          });
        }
        continue;
      }
      // Links always ask first: there is no in-app preview to open them beside.
      if (step.mode === "apply" && step.intent.type !== "preview.open") {
        run(target, step);
        continue;
      }
      const offer =
        step.intent.type === "thread.reveal"
          ? { title: `${name} wants to open a thread`, message: undefined, action: "Open" }
          : step.intent.type === "view.open"
            ? { title: `${name} wants to open a view`, message: undefined, action: "Open" }
            : { title: `Open a link from ${name}?`, message: step.intent.url, action: "Open" };
      alerts.push({
        title: offer.title,
        message: offer.message,
        buttons: [
          { text: "Not now", style: "cancel" },
          { text: offer.action, onPress: () => run(target, step) },
        ],
      });
    }
    alertInTurn(alerts);
  };
}

/** Runs a declared action against the target the user picked it from. */
export function usePluginActionRunner() {
  const invoke = useAtomCommand(pluginEnvironment.invoke, { reportFailure: false });
  const applyIntents = usePluginIntentApplier();
  const navigation = useNavigation();
  return async (
    target: MobilePluginTarget,
    action: PluginAction,
    context: PluginActionContext,
  ): Promise<void> => {
    const name = target.installation.manifest.name;
    if (!readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)) {
      Dialog.alert(`Unable to run ${action.title}`, "This connection cannot run plugin actions.");
      return;
    }
    const result = await invoke({
      environmentId: target.environmentId,
      input: {
        installationId: target.installation.installationId,
        generation: target.installation.generation,
        handler: pluginActionHandler(action.id),
        context,
        operationId: newPluginOperationId(),
      },
    });
    if (context.threadId !== undefined) {
      notifyPluginThreadActivity({
        environmentId: target.environmentId,
        threadId: context.threadId,
        installationId: target.installation.installationId,
      });
    }
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const cause = squashAtomCommandFailure(result);
      // A dormant plugin first fails here; its details explain why and offer the way back.
      const details = isPluginError(cause) && pluginFailureNeedsDetails(cause);
      Dialog.alert(
        `${name}: ${action.title} failed`,
        pluginFailureMessage(cause),
        details
          ? [
              { text: "OK", style: "cancel" },
              {
                text: "Details",
                onPress: () =>
                  navigation.navigate("SettingsPluginDetail", {
                    environmentId: target.environmentId,
                    installationId: target.installation.installationId,
                  }),
              },
            ]
          : undefined,
      );
      return;
    }
    const { message } = result.value;
    applyIntents(
      target,
      result.value.intents ?? [],
      navigation.isFocused(),
      pluginUnsupportedIntentCount(result.value),
      message ? { title: action.title, text: message } : undefined,
    );
  };
}
