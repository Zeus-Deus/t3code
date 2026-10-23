import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { mcpAppStyleVariables } from "@t3tools/client-runtime/mcp-apps";
import {
  buildPluginViewDocument,
  findPluginView,
  makePluginViewHost,
  notifyPluginThreadActivity,
  pluginInactiveReason,
  pluginViewFailure,
  pluginViewHandler,
  pluginViewOuterDocument,
  type PluginViewContext,
  type PluginViewHost,
} from "@t3tools/client-runtime/plugins";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  ThreadId,
  type PluginInstallation,
  type PluginView,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { randomHex, uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useThreadShell } from "../../state/entities";
import { pluginEnvironment, usePluginCatalogue } from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { newPluginOperationId, usePluginIntentApplier } from "./usePluginActions";

type PluginViewRouteParams = {
  readonly environmentId: string;
  readonly installationId: string;
  readonly viewId: string;
  readonly threadId?: string;
};

function Notice(props: { readonly title: string; readonly action?: ReactNode }) {
  return (
    <View className="flex-1 items-center justify-center gap-3 p-6">
      <Text className="text-center text-base text-foreground-muted">{props.title}</Text>
      {props.action ?? null}
    </View>
  );
}

export function PluginViewRouteScreen({ route }: StaticScreenProps<PluginViewRouteParams>) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = route.params.threadId ? ThreadId.make(route.params.threadId) : null;
  const catalogue = usePluginCatalogue(environmentId);
  const entry = findPluginView(
    catalogue.installations,
    route.params.installationId,
    route.params.viewId,
  );
  const title = entry?.view.title ?? "Plugin";
  const reason =
    catalogue.availability === "unsupported"
      ? "This environment's T3 Code server does not support plugins."
      : catalogue.availability === "client-outdated"
        ? "This view needs a newer version of T3 Code on this device."
        : catalogue.availability === "disconnected" || catalogue.availability === "unknown"
          ? "Reconnect the environment to show this view."
          : catalogue.availability === "forbidden"
            ? "This connection cannot read the environment's plugins."
            : catalogue.error
              ? catalogue.error
              : catalogue.loaded && entry === null
                ? "The plugin or view was removed."
                : catalogue.executionDisabled
                  ? "Plugin code is turned off on this environment, so its views cannot open."
                  : entry === null
                    ? null
                    : (pluginInactiveReason(entry.installation) ??
                      (entry.installation.grants.capabilities.includes("ui")
                        ? null
                        : "The plugin was not granted permission to show views."));
  return (
    <View collapsable={false} className="flex-1 bg-background">
      <NativeStackScreenOptions
        options={Platform.OS === "android" ? { headerShown: false } : { title }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title={title} onBack={() => navigation.goBack()} />
      ) : null}
      {reason !== null ? (
        <Notice title={reason} />
      ) : entry === null ? (
        <Notice title="Loading…" />
      ) : (
        <PluginViewDocument
          key={entry.installation.generation}
          environmentId={environmentId}
          installation={entry.installation}
          view={entry.view}
          threadId={threadId}
        />
      )}
    </View>
  );
}

/**
 * The view runs in a sandboxed srcdoc frame nested inside the WebView page; see
 * `pluginViewOuterDocument` for why the page relays with a secret.
 */
function PluginViewDocument(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly view: PluginView;
  readonly threadId: ThreadId | null;
}) {
  const { environmentId, installation, view } = props;
  const { installationId, generation } = installation;
  const readView = useAtomCommand(pluginEnvironment.readView, { reportFailure: false });
  const invoke = useAtomCommand(pluginEnvironment.invoke, { reportFailure: false });
  const applyIntents = usePluginIntentApplier();
  const navigation = useNavigation();
  const thread = useThreadShell(
    props.threadId === null ? null : { environmentId, threadId: props.threadId },
  );
  const { themeId, themeAppearance, themeVariables, systemColorsActive } =
    useAppearancePreferences();
  const theme = useMemo(
    () =>
      mobileHtmlRenderTheme({
        themeId,
        appearance: themeAppearance,
        variables: themeVariables,
        systemColors: systemColorsActive,
        platform: Platform.OS,
      }),
    [themeId, themeAppearance, themeVariables, systemColorsActive],
  );
  const [secret] = useState(uuidv4);
  const [loaded, setLoaded] = useState<{ readonly html: string; readonly token: string } | null>(
    null,
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [stopped, setStopped] = useState<"navigated" | "crashed" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const webView = useRef<WebView<object>>(null);
  const hostRef = useRef<PluginViewHost | null>(null);
  const live = { props, theme, thread, invoke, applyIntents, navigation };
  const latest = useRef(live);
  useEffect(() => {
    latest.current = live;
  });

  useEffect(() => {
    let cancelled = false;
    void readView({ environmentId, input: { installationId, generation, viewId: view.id } }).then(
      (result) => {
        if (cancelled) return;
        if (result._tag === "Success") {
          setFailure(null);
          // A fresh token per document; see `PluginViewHostOptions.token`.
          setLoaded({ html: result.value.html, token: randomHex(16) });
        } else {
          setFailure(pluginViewFailure(squashAtomCommandFailure(result)).message);
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Retry asks for the document again.
  }, [readView, environmentId, installationId, generation, view.id, attempt]);

  useEffect(() => {
    if (loaded === null) return;
    const context = (): PluginViewContext => {
      const current = latest.current;
      return {
        theme: current.theme.appearance,
        styles: mcpAppStyleVariables(current.theme.variables),
        platform: "mobile",
        placement: "page",
        view: { installationId, viewId: view.id },
        thread:
          current.props.threadId === null
            ? null
            : { threadId: current.props.threadId, projectId: current.thread?.projectId ?? null },
      };
    };
    const host = makePluginViewHost({
      token: loaded.token,
      // Fixed when the view asks; the screen may lose focus before the answer arrives.
      captureOrigin: () => ({ focused: latest.current.navigation.isFocused() }),
      post: (message) =>
        webView.current?.injectJavaScript(
          `window.__t3PluginReceive&&window.__t3PluginReceive(${JSON.stringify(message)});true;`,
        ),
      context,
      invoke: async (name, input) => {
        const current = latest.current;
        const result = await current.invoke({
          environmentId,
          input: {
            installationId,
            generation,
            handler: pluginViewHandler(view.id, name),
            ...(input === undefined ? {} : { input }),
            ...(current.props.threadId === null
              ? {}
              : { context: { threadId: current.props.threadId } }),
            operationId: newPluginOperationId(),
          },
        });
        if (current.props.threadId !== null) {
          notifyPluginThreadActivity({
            environmentId,
            threadId: current.props.threadId,
            installationId,
          });
        }
        if (result._tag === "Success") return result.value;
        throw squashAtomCommandFailure(result);
      },
      onIntents: (intents, origin, unsupported) => {
        const current = latest.current;
        current.applyIntents(
          {
            environmentId,
            installation: current.props.installation,
            // A full-screen view has no composer on screen; inserts are refused.
            threadId: null,
          },
          intents,
          origin.focused && current.navigation.isFocused(),
          unsupported,
        );
      },
    });
    hostRef.current = host;
    return () => {
      host.dispose();
      hostRef.current = null;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A reloaded document needs a new host.
  }, [loaded, environmentId, installationId, generation, view.id, attempt]);

  useEffect(() => {
    hostRef.current?.sendContext();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A theme change is resent.
  }, [theme]);

  const source = useMemo(
    () =>
      loaded === null
        ? null
        : {
            html: pluginViewOuterDocument(
              buildPluginViewDocument(loaded.html, loaded.token),
              secret,
            ),
          },
    [loaded, secret],
  );

  if (failure !== null || stopped !== null) {
    return (
      <Notice
        title={
          stopped === "navigated"
            ? `${view.title} tried to leave its page and was stopped.`
            : stopped === "crashed"
              ? `${view.title} stopped unexpectedly.`
              : failure!
        }
        action={
          <Button
            label="Try again"
            onPress={() => {
              setStopped(null);
              setLoaded(null);
              setAttempt((value) => value + 1);
            }}
          />
        }
      />
    );
  }
  if (source === null) {
    return (
      <View className="flex-1 items-center justify-center">
        <AppActivityIndicator />
      </View>
    );
  }
  return (
    <WebView<object>
      key={attempt}
      ref={webView}
      source={source}
      accessibilityLabel={view.title}
      style={{ flex: 1, backgroundColor: "transparent" }}
      originWhitelist={["*"]}
      // Only the outer page loads at the top level. Android reports nested frames as top-level,
      // so there the page never navigates and the view's sandbox forbids top navigation.
      onShouldStartLoadWithRequest={(request) =>
        Platform.OS === "android" || request.isTopFrame === false || request.url === "about:blank"
      }
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      onContentProcessDidTerminate={() => setStopped("crashed")}
      onRenderProcessGone={() => setStopped("crashed")}
      onMessage={(event: WebViewMessageEvent) => {
        let envelope: unknown;
        try {
          envelope = JSON.parse(event.nativeEvent.data);
        } catch {
          return;
        }
        if (!Predicate.isObject(envelope) || envelope.secret !== secret) return;
        const message = envelope.message;
        if (Predicate.isObject(message) && message.kind === "navigated") {
          hostRef.current?.dispose();
          setStopped("navigated");
          return;
        }
        hostRef.current?.receive(message);
      }}
    />
  );
}
