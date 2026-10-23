import type {
  EnvironmentId,
  PluginClientIntent,
  PluginInvokeResult,
  PluginManifest,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Where the user invoked a plugin, captured before the request goes out. Results apply to this
 * client and this target only: a reply that lands after the user moved on must not write into
 * whatever is active by then.
 */
export interface PluginInvocationOrigin {
  readonly environmentId: EnvironmentId;
  readonly installationId: string;
  /** Compared with the client's location when the result arrives. */
  readonly locationKey: string;
  /** The composer the action was invoked against, if any; composer inserts go only here. */
  readonly composerKey: string | null;
  readonly threadId: ThreadId | null;
}

type NavigationIntent = Exclude<PluginClientIntent, { readonly type: "composer.insert" }>;

export type PluginIntentStep =
  | {
      readonly kind: "insert";
      readonly composerKey: string;
      readonly text: string;
      /** False when the user left the origin; the client says where the text went. */
      readonly visible: boolean;
    }
  | {
      readonly kind: "navigate";
      readonly intent: NavigationIntent;
      /** `offer` leaves the user where they are and asks first, e.g. with a toast action. */
      readonly mode: "apply" | "offer";
    }
  | { readonly kind: "rejected"; readonly intent: PluginClientIntent; readonly reason: string };

function formatPluginComposerText(text: string, quote: boolean | undefined): string {
  if (quote !== true) return text;
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * Decides how each intent a plugin returned reaches the invoking client. At most one navigation
 * applies directly, and only while the user is still where they invoked; the rest are offered.
 */
export function planPluginIntents(input: {
  readonly origin: PluginInvocationOrigin;
  readonly manifest: Pick<PluginManifest, "views">;
  readonly intents: ReadonlyArray<PluginClientIntent>;
  readonly currentLocationKey: string;
  /** Whether this client can open the url inside T3 for the origin thread. */
  readonly canOpenPreview: boolean;
}): ReadonlyArray<PluginIntentStep> {
  const stayed = input.currentLocationKey === input.origin.locationKey;
  let navigated = false;
  // An applied navigation that leaves the origin thread hides its composer, wherever the insert
  // sits in the list.
  let leaves = false;
  const navigate = (intent: NavigationIntent, canApply: boolean): PluginIntentStep => {
    const apply = stayed && !navigated && canApply;
    if (apply) {
      navigated = true;
      leaves = leavesOrigin(intent);
    }
    return { kind: "navigate", intent, mode: apply ? "apply" : "offer" };
  };
  // Mirrors the client opener: side-panel views open beside the origin thread, others as a page.
  const leavesOrigin = (intent: NavigationIntent): boolean => {
    switch (intent.type) {
      case "thread.reveal":
        return intent.threadId !== input.origin.threadId;
      case "view.open":
        return !(
          input.origin.threadId !== null &&
          input.manifest.views.some(
            (view) => view.id === intent.viewId && view.placement === "side-panel",
          )
        );
      case "preview.open":
        return false;
    }
  };
  const steps = input.intents.map((intent): PluginIntentStep => {
    switch (intent.type) {
      case "composer.insert":
        if (input.origin.composerKey === null) {
          return { kind: "rejected", intent, reason: "There is no composer for this action." };
        }
        if (intent.text.trim() === "") {
          return { kind: "rejected", intent, reason: "The plugin returned empty text." };
        }
        return {
          kind: "insert",
          composerKey: input.origin.composerKey,
          text: formatPluginComposerText(intent.text, intent.quote),
          visible: stayed,
        };
      case "view.open":
        if (!input.manifest.views.some((view) => view.id === intent.viewId)) {
          return { kind: "rejected", intent, reason: `The plugin has no view "${intent.viewId}".` };
        }
        if (
          input.manifest.views.some(
            (view) => view.id === intent.viewId && view.placement === "conversation",
          )
        ) {
          return { kind: "rejected", intent, reason: "That view only opens from a card in chat." };
        }
        return navigate(intent, true);
      case "thread.reveal":
        return navigate(intent, true);
      case "preview.open":
        return navigate(intent, input.canOpenPreview && input.origin.threadId !== null);
    }
  });
  return leaves
    ? steps.map((step) => (step.kind === "insert" ? { ...step, visible: false } : step))
    : steps;
}

/**
 * Intents from a newer plugin API that this client's contracts dropped while decoding. Read by
 * shape so it works with servers that do not send the count.
 */
export function pluginUnsupportedIntentCount(result: PluginInvokeResult): number {
  if (!("unsupportedIntentCount" in result)) return 0;
  const count = result.unsupportedIntentCount;
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : 0;
}

/** One notice per result, however many intents were dropped. */
export function pluginUnsupportedIntentNotice(pluginName: string, count: number) {
  return {
    title: `${pluginName} asked for something this app can't do yet`,
    description:
      count === 1
        ? "One request needs a newer version of T3 Code and was skipped."
        : `${count} requests need a newer version of T3 Code and were skipped.`,
  };
}
