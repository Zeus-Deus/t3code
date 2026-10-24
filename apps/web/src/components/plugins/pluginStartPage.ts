import { useAtomValue } from "@effect/atom-react";
import {
  PluginStartPage,
  pluginRunnableInstallations,
  resolvePluginStartPage,
} from "@t3tools/client-runtime/plugins";
import { type AuthSessionState, EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useReducer } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { usePluginCatalogue } from "../../state/plugins";
import { environmentSession } from "../../state/session";

const START_PAGE_KEY = "t3code:plugins:start-page";
const StartPagePreference = Schema.NullOr(PluginStartPage);

/** The plugin page this device starts on, if any. */
export function usePluginStartPage() {
  const [startPage, setStartPage] = useLocalStorage(START_PAGE_KEY, null, StartPagePreference);
  return { startPage, setStartPage };
}

// The start page applies when the app opens, not on every later visit to the landing. It is
// "opening" from the decision until its route has loaded, while the landing must keep holding.
let startPagePhase: "waiting" | "opening" | "settled" = "waiting";

export function resetPluginStartPageForTests(): void {
  startPagePhase = "waiting";
}

const NO_SESSION_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>());

/**
 * Opens this device's start page from the landing, once per app load. Returns true while the
 * landing should wait: the start page's environment is still making its first connection or
 * listing plugins, or the page is opening. Anything else falls back to the usual landing at once.
 */
export function useHoldLandingForStartPage(): boolean {
  const { startPage } = usePluginStartPage();
  const { isReady } = useEnvironments();
  const navigate = useNavigate();
  const router = useRouter();
  const isStillOnIndex = useEffectEvent(() => router.state.location.pathname === "/");
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const preference = startPagePhase === "waiting" ? startPage : null;
  const environmentId = preference === null ? null : EnvironmentId.make(preference.environmentId);
  const environment = useEnvironment(environmentId);
  const catalogue = usePluginCatalogue(environmentId);
  const session = useAtomValue(
    environmentId === null ? NO_SESSION_ATOM : environmentSession.sessionStateAtom(environmentId),
  );
  const phase = environment?.connection.phase;
  const environmentState =
    environmentId === null
      ? ("unavailable" as const)
      : !isReady ||
          phase === "connecting" ||
          // An enabled environment starts connecting as soon as it is registered; until its
          // supervisor reports, its state still reads as the never-connected default.
          (phase === "available" && environment?.entry.enabled === true)
        ? ("pending" as const)
        : environment === null || phase !== "connected"
          ? ("unavailable" as const)
          : catalogue.availability === "disconnected" ||
              // Read access is unknown, not refused, until the session's first answer.
              (catalogue.availability === "forbidden" && session._tag === "Initial") ||
              (catalogue.availability === "available" &&
                !catalogue.loaded &&
                catalogue.error === null)
            ? ("pending" as const)
            : catalogue.availability === "available" && catalogue.error === null
              ? ("ready" as const)
              : ("unavailable" as const);
  const resolution = resolvePluginStartPage({
    preference,
    environment: environmentState,
    installations: pluginRunnableInstallations(catalogue),
  });
  const installationId = resolution.kind === "open" ? resolution.installationId : null;
  const viewId = resolution.kind === "open" ? resolution.viewId : null;
  useEffect(() => {
    // Once opening, later renders resolve to the core landing; only the navigation ends that.
    if (resolution.kind === "pending" || startPagePhase !== "waiting") return;
    startPagePhase = "settled";
    if (environmentId === null || installationId === null || viewId === null) return;
    // A page the person opened while this was loading wins over the start page.
    if (!isStillOnIndex()) return;
    startPagePhase = "opening";
    void navigate({
      to: "/plugins/$environmentId/$installationId/$viewId",
      params: { environmentId, installationId, viewId },
      replace: true,
    }).finally(() => {
      startPagePhase = "settled";
      // Still here only if the route never committed: let the usual landing take over.
      rerender();
    });
  }, [navigate, resolution.kind, environmentId, installationId, viewId]);
  return startPagePhase === "opening" || resolution.kind !== "core";
}
