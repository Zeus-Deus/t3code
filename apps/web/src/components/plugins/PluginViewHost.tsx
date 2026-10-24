import { mcpAppStyleVariables } from "@t3tools/client-runtime/mcp-apps";
import {
  bindPluginViewChannel,
  buildPluginViewDocument,
  findPluginView,
  makePluginViewHost,
  notifyPluginThreadActivity,
  pluginInactiveReason,
  pluginChangesSupported,
  pluginViewBridgeFeatures,
  pluginViewHandler,
  pluginViewFailure,
  pluginViewTopic,
  type PluginViewBridgeFeature,
  type PluginViewContext,
  type PluginViewHost,
} from "@t3tools/client-runtime/plugins";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PluginCardReference,
  PluginInstallation,
  PluginView,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Link, useRouter } from "@tanstack/react-router";
import { PuzzleIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { ComposerThreadTarget } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { useHtmlRenderTheme } from "../../hooks/useHtmlRenderTheme";
import { useEnvironment } from "../../state/environments";
import { useThreadShell } from "../../state/entities";
import {
  pluginEnvironment,
  usePluginCatalogue,
  usePluginChangeRevision,
} from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { newPluginOperationId, usePluginIntentApplier } from "./usePluginActions";

type LoadState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly document: string;
      readonly token: string;
      /** Baked into the document; the host must offer the same ones. */
      readonly features: ReadonlyArray<PluginViewBridgeFeature>;
    }
  | { readonly kind: "failed"; readonly message: string };

const documentToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

type PluginViewPlacement = PluginViewContext["placement"];

/**
 * One plugin view document. It is keyed by installation generation, so a refreshed or re-enabled
 * plugin reloads instead of letting an old document call into the new code.
 */
export function PluginViewFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly view: PluginView;
  readonly placement: PluginViewPlacement;
  readonly threadRef: ScopedThreadRef | null;
  readonly composerTarget: ComposerThreadTarget | null;
  /** A conversation card: served only after the server checks where the card came from. */
  readonly card?: PluginCardReference;
  /** A card's frame is sized by its content; failures show this instead of a page notice. */
  readonly renderFailure?: (message: string, retry: () => void) => ReactNode;
}) {
  const { environmentId, installation, view } = props;
  const theme = useHtmlRenderTheme();
  const router = useRouter();
  const environment = useEnvironment(environmentId);
  const features = pluginViewBridgeFeatures({
    placement: props.placement,
    changes: pluginChangesSupported(environment?.serverConfig?.environment.capabilities),
  });
  const readView = useAtomCommand(pluginEnvironment.readView, { reportFailure: false });
  const readCardView = useAtomCommand(pluginEnvironment.readCardView, { reportFailure: false });
  const invoke = useAtomCommand(pluginEnvironment.invoke, { reportFailure: false });
  const applyIntents = usePluginIntentApplier();
  const thread = useThreadShell(props.threadRef);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<PluginViewHost | null>(null);
  const loads = useRef(0);
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [stopped, setStopped] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [cardHeight, setCardHeight] = useState<number | null>(null);

  // Read by the bridge on each message, so it sees current values without being rebuilt.
  const live = {
    props,
    theme,
    thread,
    features,
    invoke,
    readView,
    readCardView,
    applyIntents,
    router,
  };
  const latest = useRef(live);
  useEffect(() => {
    latest.current = live;
  });

  const { installationId, generation } = installation;
  const card = props.card ?? null;
  const cardKey = card === null ? null : JSON.stringify(card);
  useEffect(() => {
    let cancelled = false;
    const current = latest.current;
    const card = current.props.card;
    void (
      card === undefined
        ? current.readView({
            environmentId,
            input: { installationId, generation, viewId: view.id },
          })
        : current.readCardView({ environmentId, input: { installationId, generation, card } })
    ).then((result) => {
      if (cancelled) return;
      const token = documentToken();
      const { features } = latest.current;
      setLoad(
        result._tag === "Success"
          ? {
              kind: "ready",
              document: buildPluginViewDocument(result.value.html, token, features),
              token,
              features,
            }
          : {
              kind: "failed",
              message: pluginViewFailure(squashAtomCommandFailure(result)).message,
            },
      );
    });
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry asks for the document again.
  }, [latest, environmentId, installationId, generation, view.id, cardKey, attempt]);

  const document = load.kind === "ready" ? load.document : null;
  const token = load.kind === "ready" ? load.token : null;
  const documentFeatures = load.kind === "ready" ? load.features : null;
  // A layout effect, so the host listens before the frame's first script can post.
  useLayoutEffect(() => {
    if (document === null || token === null || documentFeatures === null) return;
    const features = documentFeatures;
    loads.current = 0;
    const context = (): PluginViewContext => {
      const current = latest.current;
      return {
        theme: current.theme.appearance,
        styles: mcpAppStyleVariables(current.theme.variables),
        platform: isElectron ? "desktop" : "web",
        placement: current.props.placement,
        view: { installationId, viewId: view.id },
        thread:
          current.props.threadRef === null
            ? null
            : {
                threadId: current.props.threadRef.threadId,
                projectId: current.thread?.projectId ?? null,
              },
        features,
        ...(current.props.card === undefined
          ? {}
          : {
              card: {
                viewId: current.props.card.viewId,
                summary: current.props.card.summary,
                ...(current.props.card.data === undefined ? {} : { data: current.props.card.data }),
              },
            }),
      };
    };
    const channel = bindPluginViewChannel({
      token,
      source: () => frameRef.current?.contentWindow ?? null,
      receive: (data) => host.receive(data),
    });
    const host = makePluginViewHost({
      token,
      post: channel.post,
      context,
      // Fixed when the view asks: a slow answer must not act on wherever the user went since.
      captureOrigin: () => {
        const current = latest.current;
        return {
          environmentId,
          installation: current.props.installation,
          threadRef: current.props.threadRef,
          // Only a view beside a thread has a composer to write into.
          composerTarget:
            current.props.placement === "side-panel" ? current.props.composerTarget : null,
          locationKey: current.router.state.location.pathname,
        };
      },
      invoke: async (name, input, origin) => {
        const current = latest.current;
        const result = await current.invoke({
          environmentId,
          input: {
            installationId,
            generation,
            handler: pluginViewHandler(view.id, name),
            ...(input === undefined ? {} : { input }),
            ...(origin.threadRef === null
              ? {}
              : { context: { threadId: origin.threadRef.threadId } }),
            operationId: newPluginOperationId(),
          },
        });
        if (origin.threadRef !== null) {
          notifyPluginThreadActivity({
            environmentId,
            threadId: origin.threadRef.threadId,
            installationId,
          });
        }
        if (result._tag === "Success") return result.value;
        throw squashAtomCommandFailure(result);
      },
      onIntents: (intents, origin, unsupported) =>
        latest.current.applyIntents(origin, intents, unsupported),
      features,
      onResize: setCardHeight,
    });
    hostRef.current = host;
    return () => {
      channel.dispose();
      host.dispose();
      hostRef.current = null;
    };
  }, [
    latest,
    document,
    token,
    documentFeatures,
    environmentId,
    installationId,
    generation,
    view.id,
    // The document string can repeat across a reload; `attempt` still means a new frame.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A reloaded frame needs a new host.
    attempt,
  ]);

  useEffect(() => {
    hostRef.current?.sendContext();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A theme change is resent.
  }, [theme]);

  // Only a mounted document listens; a hidden or closed view holds no subscription.
  const topic = pluginViewTopic(view.id);
  const revision = usePluginChangeRevision(features.includes("changes") ? environmentId : null, {
    installationId,
    generation,
    topic,
  });
  const seenRevision = useRef(revision);
  useEffect(() => {
    if (revision === null || revision === undefined) return;
    const seen = seenRevision.current;
    seenRevision.current = revision;
    if (seen !== null && seen !== undefined && seen !== revision) hostRef.current?.changed(topic);
  }, [revision, topic]);

  const retry = () => {
    setStopped(false);
    setLoad({ kind: "loading" });
    setAttempt((value) => value + 1);
  };
  if (load.kind === "failed" && props.renderFailure !== undefined) {
    return props.renderFailure(load.message, retry);
  }
  if (stopped && props.renderFailure !== undefined) {
    return props.renderFailure("The card tried to leave its page.", retry);
  }
  if (load.kind === "failed") {
    return (
      <PluginViewNotice
        title={`Unable to load ${view.title}`}
        description={load.message}
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setLoad({ kind: "loading" });
              setAttempt((value) => value + 1);
            }}
          >
            <RotateCcwIcon />
            Try again
          </Button>
        }
      />
    );
  }
  if (stopped) {
    return (
      <PluginViewNotice
        title={`${view.title} was stopped`}
        description="The view tried to leave its page."
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setStopped(false);
              setLoad({ kind: "loading" });
              setAttempt((value) => value + 1);
            }}
          >
            <RotateCcwIcon />
            Reload view
          </Button>
        }
      />
    );
  }
  if (document === null) {
    return props.placement === "conversation" ? null : (
      <div className="flex size-full items-center justify-center">
        <Spinner className="size-4" />
      </div>
    );
  }
  return (
    <iframe
      key={`${generation}:${attempt}`}
      ref={frameRef}
      srcDoc={document}
      title={`${installation.manifest.name}: ${view.title}`}
      // Scripts only: no same-origin (no app storage or session), popups, forms or top navigation.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={() => {
        loads.current += 1;
        if (loads.current > 1) {
          hostRef.current?.dispose();
          setStopped(true);
          return;
        }
        hostRef.current?.sendContext();
      }}
      className={cn(
        "block w-full border-0 bg-transparent",
        props.placement === "conversation" ? "h-24 rounded-lg border border-border" : "h-full",
      )}
      style={{
        colorScheme: theme.appearance,
        ...(props.placement === "conversation" && cardHeight !== null
          ? { height: cardHeight }
          : {}),
      }}
    />
  );
}

function PluginViewNotice(props: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <Empty className="size-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <PuzzleIcon />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      {props.action ?? null}
    </Empty>
  );
}

function unavailableReason(
  catalogue: ReturnType<typeof usePluginCatalogue>,
  installation: PluginInstallation | null,
): string | null {
  switch (catalogue.availability) {
    case "unknown":
      return "This environment is no longer available.";
    case "disconnected":
      return "Reconnect the environment to show this view.";
    case "unsupported":
      return "This environment's T3 Code server does not support plugins.";
    case "client-outdated":
      return "This view needs a newer version of T3 Code on this device.";
    case "forbidden":
      return "This connection cannot read the environment's plugins.";
    case "available":
      if (!catalogue.loaded) return null;
      if (installation === null) return "The plugin was removed.";
      if (catalogue.executionDisabled === true) {
        return "Plugin code is turned off on this environment, so its views cannot open.";
      }
      return (
        pluginInactiveReason(installation) ??
        (installation.grants.capabilities.includes("ui")
          ? null
          : "The plugin was not granted permission to show views.")
      );
  }
}

/** Resolves the installation live, so a view never outlives the plugin's enablement. */
function PluginViewResolver(props: {
  readonly environmentId: EnvironmentId;
  readonly installationId: string;
  readonly viewId: string;
  readonly placement: "page" | "side-panel";
  readonly threadRef: ScopedThreadRef | null;
  readonly composerTarget: ComposerThreadTarget | null;
}) {
  const catalogue = usePluginCatalogue(props.environmentId);
  const entry = findPluginView(catalogue.installations, props.installationId, props.viewId);
  const reason = unavailableReason(catalogue, entry?.installation ?? null);
  if (catalogue.error !== null) {
    return <PluginViewNotice title="Unable to load plugins" description={catalogue.error} />;
  }
  if (reason !== null) {
    return (
      <PluginViewNotice
        title="View unavailable"
        description={reason}
        action={
          <Button
            size="sm"
            variant="outline"
            render={
              <Link
                to="/settings/plugins"
                search={{
                  environmentId: props.environmentId,
                  installationId: props.installationId,
                }}
              />
            }
          >
            Open plugin settings
          </Button>
        }
      />
    );
  }
  if (entry !== null && entry.view.placement === "conversation") {
    return (
      <PluginViewNotice
        title="View unavailable"
        description="This view only opens from a card in chat."
      />
    );
  }
  if (entry === null) {
    return (
      <div className="flex size-full items-center justify-center">
        <Spinner className="size-4" />
      </div>
    );
  }
  return (
    <PluginViewFrame
      key={entry.installation.generation}
      environmentId={props.environmentId}
      installation={entry.installation}
      view={entry.view}
      placement={props.placement}
      threadRef={props.threadRef}
      composerTarget={props.composerTarget}
    />
  );
}

/** The panel's tab already names the view and closes it. */
export function PluginSidePanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly composerTarget: ComposerThreadTarget;
  readonly installationId: string;
  readonly viewId: string;
}) {
  return (
    <PluginViewResolver
      environmentId={props.threadRef.environmentId}
      installationId={props.installationId}
      viewId={props.viewId}
      placement="side-panel"
      threadRef={props.threadRef}
      composerTarget={props.composerTarget}
    />
  );
}

export function PluginPageView(props: {
  readonly environmentId: EnvironmentId;
  readonly installationId: string;
  readonly viewId: string;
}) {
  return (
    <PluginViewResolver
      environmentId={props.environmentId}
      installationId={props.installationId}
      viewId={props.viewId}
      placement="page"
      threadRef={null}
      composerTarget={null}
    />
  );
}
