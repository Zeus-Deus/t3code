import { mcpAppStyleVariables } from "@t3tools/client-runtime/mcp-apps";
import {
  bindPluginViewChannel,
  buildPluginViewDocument,
  findPluginView,
  makePluginViewHost,
  notifyPluginThreadActivity,
  pluginInactiveReason,
  pluginViewHandler,
  pluginViewFailure,
  type PluginViewContext,
  type PluginViewHost,
} from "@t3tools/client-runtime/plugins";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
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
import { useThreadShell } from "../../state/entities";
import { pluginEnvironment, usePluginCatalogue } from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { newPluginOperationId, usePluginIntentApplier } from "./usePluginActions";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly document: string; readonly token: string }
  | { readonly kind: "failed"; readonly message: string };

const documentToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/**
 * One plugin view document. It is keyed by installation generation, so a refreshed or re-enabled
 * plugin reloads instead of letting an old document call into the new code.
 */
function PluginViewFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly view: PluginView;
  readonly placement: "page" | "side-panel";
  readonly threadRef: ScopedThreadRef | null;
  readonly composerTarget: ComposerThreadTarget | null;
}) {
  const { environmentId, installation, view } = props;
  const theme = useHtmlRenderTheme();
  const router = useRouter();
  const readView = useAtomCommand(pluginEnvironment.readView, { reportFailure: false });
  const invoke = useAtomCommand(pluginEnvironment.invoke, { reportFailure: false });
  const applyIntents = usePluginIntentApplier();
  const thread = useThreadShell(props.threadRef);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<PluginViewHost | null>(null);
  const loads = useRef(0);
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [stopped, setStopped] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Read by the bridge on each message, so it sees current values without being rebuilt.
  const live = { props, theme, thread, invoke, readView, applyIntents, router };
  const latest = useRef(live);
  useEffect(() => {
    latest.current = live;
  });

  const { installationId, generation } = installation;
  useEffect(() => {
    let cancelled = false;
    void latest.current
      .readView({
        environmentId,
        input: { installationId, generation, viewId: view.id },
      })
      .then((result) => {
        if (cancelled) return;
        const token = documentToken();
        setLoad(
          result._tag === "Success"
            ? { kind: "ready", document: buildPluginViewDocument(result.value.html, token), token }
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
  }, [environmentId, installationId, generation, view.id, attempt]);

  const document = load.kind === "ready" ? load.document : null;
  const token = load.kind === "ready" ? load.token : null;
  // A layout effect, so the host listens before the frame's first script can post.
  useLayoutEffect(() => {
    if (document === null || token === null) return;
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
    });
    hostRef.current = host;
    return () => {
      channel.dispose();
      host.dispose();
      hostRef.current = null;
    };
    // The document string can repeat across a reload; `attempt` still means a new frame.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A reloaded frame needs a new host.
  }, [document, token, environmentId, installationId, generation, view.id, attempt]);

  useEffect(() => {
    hostRef.current?.sendContext();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A theme change is resent.
  }, [theme]);

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
    return (
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
      className="block size-full border-0 bg-transparent"
      style={{ colorScheme: theme.appearance }}
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
          <Button size="sm" variant="outline" render={<Link to="/settings/plugins" />}>
            Open plugin settings
          </Button>
        }
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
