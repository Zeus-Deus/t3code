import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createPluginOperationId,
  notifyPluginThreadActivity,
  planPluginIntents,
  pluginActionHandler,
  pluginFailureNeedsDetails,
  pluginUnsupportedIntentCount,
  pluginUnsupportedIntentNotice,
  pluginViewThreadId,
  type PluginIntentStep,
} from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  PluginError,
  type EnvironmentId,
  type PluginAction,
  type PluginActionContext,
  type PluginClientIntent,
  type PluginInstallation,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { openUrlInPreview } from "../../browser/openFileInPreview";
import { isPreviewAvailableFor } from "../../browser/previewRuntime";
import { composerTargetKey, type ComposerThreadTarget } from "../../composerDraftStore";
import { readLocalApi } from "../../localApi";
import { rightPanelHostRef, useRightPanelStore } from "../../rightPanelStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { pluginEnvironment } from "../../state/plugins";
import { previewEnvironment } from "../../state/preview";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { insertPluginComposerText } from "./pluginComposerInserters";

/** What the user acted on, fixed before anything is awaited. */
interface PluginInvocationTarget {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly threadRef: ScopedThreadRef | null;
  /** The panel showing `threadRef`, when that is not its own: a side chat's parent. */
  readonly panelRef?: ScopedThreadRef;
  readonly composerTarget: ComposerThreadTarget | null;
  /** `router.state.location.pathname` when the user acted. */
  readonly locationKey: string;
}

const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export const newPluginOperationId = () => createPluginOperationId(randomHex);

const isPluginError = Schema.is(PluginError);

export function pluginFailureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim() !== ""
    ? cause.message
    : "The plugin request failed.";
}

const openExternally = (url: string) => {
  const api = readLocalApi();
  if (api) void api.shell.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
};

/**
 * Applies plugin intents to this client, for the target the user acted on. Results that arrive
 * after the user moved away never write into whatever became active; they are offered instead.
 */
/** Side panels retain their thread context; other views open as pages. */
export function usePluginViewOpener() {
  const navigate = useNavigate();
  return (
    target: Pick<
      PluginInvocationTarget,
      "environmentId" | "installation" | "threadRef" | "panelRef"
    >,
    viewId: string,
    requestedThreadId?: ThreadId,
  ) => {
    const view = target.installation.manifest.views.find((entry) => entry.id === viewId);
    if (!view) return;
    const threadId = pluginViewThreadId(
      target.installation.manifest,
      {
        type: "view.open",
        viewId,
        ...(requestedThreadId === undefined ? {} : { threadId: requestedThreadId }),
      },
      target.threadRef?.threadId ?? null,
    );
    if (view.placement === "side-panel" && threadId !== null) {
      const threadRef = scopeThreadRef(target.environmentId, threadId);
      useRightPanelStore.getState().openPluginView(
        threadRef,
        {
          installationId: target.installation.installationId,
          viewId: view.id,
          title: view.title,
        },
        requestedThreadId === undefined ? target.panelRef : undefined,
      );
      if (requestedThreadId !== undefined) {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      }
      return;
    }
    void navigate({
      to: "/plugins/$environmentId/$installationId/$viewId",
      params: {
        environmentId: target.environmentId,
        installationId: target.installation.installationId,
        viewId: view.id,
      },
    });
  };
}

export function usePluginIntentApplier() {
  const navigate = useNavigate();
  const router = useRouter();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const openView = usePluginViewOpener();

  const openInPreview = async (threadRef: ScopedThreadRef, url: string) => {
    const result = await openUrlInPreview({ threadRef, url, openPreview });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) openExternally(url);
  };

  const run = (target: PluginInvocationTarget, step: PluginIntentStep & { kind: "navigate" }) => {
    const { intent } = step;
    switch (intent.type) {
      case "thread.reveal":
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(target.environmentId, intent.threadId)),
        });
        return;
      case "view.open":
        openView(target, intent.viewId, intent.threadId);
        return;
      case "preview.open":
        if (target.threadRef !== null && step.mode === "apply") {
          void openInPreview(target.panelRef ?? target.threadRef, intent.url);
        } else {
          openExternally(intent.url);
        }
    }
  };

  const offerLabel = (intent: PluginIntentStep & { kind: "navigate" }) =>
    intent.intent.type === "thread.reveal"
      ? { title: "wants to open a thread", action: "Open thread" }
      : intent.intent.type === "view.open"
        ? { title: "wants to open a view", action: "Open" }
        : { title: "suggested a link", action: "Open link" };

  return (
    target: PluginInvocationTarget,
    intents: ReadonlyArray<PluginClientIntent>,
    unsupported = 0,
  ) => {
    const name = target.installation.manifest.name;
    if (unsupported > 0) {
      toastManager.add({ type: "warning", ...pluginUnsupportedIntentNotice(name, unsupported) });
    }
    const canOpenPreview =
      target.threadRef !== null &&
      isPreviewAvailableFor(target.environmentId) &&
      readEnvironmentScope(target.environmentId, AuthPreviewOperateScope);
    const steps = planPluginIntents({
      origin: {
        environmentId: target.environmentId,
        installationId: target.installation.installationId,
        locationKey: target.locationKey,
        composerKey:
          target.composerTarget === null ? null : composerTargetKey(target.composerTarget),
        threadId: target.threadRef?.threadId ?? null,
      },
      manifest: target.installation.manifest,
      intents,
      currentLocationKey: router.state.location.pathname,
      canOpenPreview,
    });
    for (const step of steps) {
      if (step.kind === "rejected") {
        toastManager.add({
          type: "warning",
          title: `${name} request ignored`,
          description: step.reason,
        });
        continue;
      }
      if (step.kind === "insert") {
        const composerTarget = target.composerTarget;
        if (composerTarget === null) continue;
        if (!insertPluginComposerText(composerTarget, step.text)) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "The composer is busy; try again once it is ready.",
          });
        } else if (!step.visible && target.threadRef !== null) {
          const threadRef = target.threadRef;
          const id = toastManager.add({
            type: "info",
            title: `${name} added text to a draft`,
            description: "It is in the composer of the thread you started from.",
            actionProps: {
              children: "Open thread",
              onClick: () => {
                toastManager.close(id);
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(threadRef),
                });
              },
            },
          });
        }
        continue;
      }
      if (step.mode === "apply") {
        run(target, step);
        continue;
      }
      const label = offerLabel(step);
      const id = toastManager.add({
        type: "info",
        title: `${name} ${label.title}`,
        ...(step.intent.type === "preview.open" ? { description: step.intent.url } : {}),
        actionProps: {
          children: label.action,
          onClick: () => {
            toastManager.close(id);
            run(target, step);
          },
        },
      });
    }
  };
}

/** Runs a declared action against the target the user picked it from. */
export function usePluginActionRunner() {
  const navigate = useNavigate();
  const invoke = useAtomCommand(pluginEnvironment.invoke, { reportFailure: false });
  const applyIntents = usePluginIntentApplier();
  return async (
    actedOn: PluginInvocationTarget,
    action: PluginAction,
    context: PluginActionContext,
  ): Promise<void> => {
    // Read before any await: a side chat pane that unmounts meanwhile drops its host mapping.
    const target =
      actedOn.threadRef === null || actedOn.panelRef !== undefined
        ? actedOn
        : { ...actedOn, panelRef: rightPanelHostRef(actedOn.threadRef) };
    const name = target.installation.manifest.name;
    if (!readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope)) {
      toastManager.add({
        type: "error",
        title: `Unable to run ${action.title}`,
        description: "This connection cannot run actions on that environment.",
      });
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
      // A dormant plugin first fails here; point at the details and repair in Settings.
      const pluginStopped = isPluginError(cause) && pluginFailureNeedsDetails(cause);
      const id = toastManager.add({
        type: "error",
        title: `${name}: ${action.title} failed`,
        description: pluginFailureMessage(cause),
        ...(pluginStopped
          ? {
              actionProps: {
                children: "Details",
                onClick: () => {
                  toastManager.close(id);
                  void navigate({
                    to: "/settings/plugins",
                    search: {
                      environmentId: target.environmentId,
                      installationId: target.installation.installationId,
                    },
                  });
                },
              },
            }
          : {}),
      });
      return;
    }
    if (result.value.message !== undefined && result.value.message.trim() !== "") {
      toastManager.add({ type: "success", title: action.title, description: result.value.message });
    }
    const intents = result.value.intents ?? [];
    const unsupported = pluginUnsupportedIntentCount(result.value);
    if (intents.length > 0 || unsupported > 0) applyIntents(target, intents, unsupported);
  };
}
