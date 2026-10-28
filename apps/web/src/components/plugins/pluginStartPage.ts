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
import { useEffect, useEffectEvent } from "react";

import { isHostedStaticApp } from "../../hostedPairing";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
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
const startPagePhaseAtom = Atom.make<"waiting" | "opening" | "settled">("waiting").pipe(
  Atom.keepAlive,
  Atom.withLabel("web-plugin-start-page-phase"),
);

export function resetPluginStartPageForTests(): void {
  appAtomRegistry.set(startPagePhaseAtom, "waiting");
}

/**
 * False while this app load's start page may still replace "/". Other startup navigation from
 * "/" waits for it, so the start page and the usual landing are one decision.
 */
export function useStartPageDecided(): boolean {
  const { startPage } = usePluginStartPage();
  return useAtomValue(startPagePhaseAtom) === "settled" || startPage === null;
}

/**
 * Settles the start page when the app shell first mounts away from "/": the app opened on
 * another page, so a later visit to "/" is not the app opening. Mount it in every app shell,
 * hosted or not, but not on pairing or connection pages, which hand over to "/" once signed in.
 */
export function PluginStartPageLaunchCoordinator(): null {
  const router = useRouter();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- settles the startup navigation registry when the app shell first mounts on a deep link
  useEffect(() => {
    if (router.state.location.pathname !== "/") appAtomRegistry.set(startPagePhaseAtom, "settled");
  }, [router]);
  return null;
}

const NO_SESSION_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>());
// The persisted catalog is ready before platform discovery registers the primary environment,
// which is never persisted. Only the hosted app has no primary environment to wait for.
const REQUIRES_PRIMARY_ENVIRONMENT = !isHostedStaticApp();

/**
 * Opens this device's start page from the landing, once per app load. Returns true while the
 * landing should wait: the start page's environment is still making its first connection or
 * listing plugins, or the page is opening. Anything else falls back to the usual landing at once.
 */
export function useHoldLandingForStartPage(): boolean {
  const { startPage } = usePluginStartPage();
  const { isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const catalogComplete =
    isReady && (!REQUIRES_PRIMARY_ENVIRONMENT || primaryEnvironmentId !== null);
  const navigate = useNavigate();
  const router = useRouter();
  const isStillOnIndex = useEffectEvent(() => router.state.location.pathname === "/");
  const startPagePhase = useAtomValue(startPagePhaseAtom);
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
      : !catalogComplete ||
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves the initial router destination after asynchronous environment discovery and plugin startup
  useEffect(() => {
    // Once opening, later renders resolve to the core landing; only the navigation ends that.
    if (resolution.kind === "pending" || appAtomRegistry.get(startPagePhaseAtom) !== "waiting") {
      return;
    }
    if (
      environmentId === null ||
      installationId === null ||
      viewId === null ||
      // A page the person opened while this was loading wins over the start page.
      !isStillOnIndex()
    ) {
      appAtomRegistry.set(startPagePhaseAtom, "settled");
      return;
    }
    appAtomRegistry.set(startPagePhaseAtom, "opening");
    void navigate({
      to: "/plugins/$environmentId/$installationId/$viewId",
      params: { environmentId, installationId, viewId },
      replace: true,
    }).finally(() => {
      // Still on the landing only if the route never committed: the usual landing takes over.
      appAtomRegistry.set(startPagePhaseAtom, "settled");
    });
  }, [navigate, resolution.kind, environmentId, installationId, viewId]);
  // Released together with `useStartPageDecided`, so the bootstrap thread goes before a draft.
  return startPage !== null && startPagePhase !== "settled";
}
