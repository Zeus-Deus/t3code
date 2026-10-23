import {
  PluginStartPage,
  pluginRunnableInstallations,
  resolvePluginStartPage,
} from "@t3tools/client-runtime/plugins";
import { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { usePluginCatalogue } from "../../state/plugins";

const START_PAGE_KEY = "t3code:plugins:start-page";
const StartPagePreference = Schema.NullOr(PluginStartPage);

/** The plugin page this device starts on, if any. */
export function usePluginStartPage() {
  const [startPage, setStartPage] = useLocalStorage(START_PAGE_KEY, null, StartPagePreference);
  return { startPage, setStartPage };
}

// The start page applies when the app opens, not on every later visit to the landing.
let startPageSettled = false;

/**
 * Opens this device's start page from the landing, once per app load. Returns true while the
 * landing should wait: the start page's environment is still connecting or listing plugins, or
 * the page is about to open. Anything else falls back to the usual landing at once.
 */
export function useHoldLandingForStartPage(): boolean {
  const { startPage } = usePluginStartPage();
  const { isReady } = useEnvironments();
  const navigate = useNavigate();
  const preference = startPageSettled ? null : startPage;
  const environmentId = preference === null ? null : EnvironmentId.make(preference.environmentId);
  const environment = useEnvironment(environmentId);
  const catalogue = usePluginCatalogue(environmentId);
  const phase = environment?.connection.phase;
  const environmentState =
    environmentId === null
      ? ("unavailable" as const)
      : !isReady || phase === "connecting"
        ? ("pending" as const)
        : environment === null || phase !== "connected"
          ? ("unavailable" as const)
          : catalogue.availability === "disconnected" ||
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
    if (resolution.kind === "pending") return;
    startPageSettled = true;
    if (environmentId === null || installationId === null || viewId === null) return;
    void navigate({
      to: "/plugins/$environmentId/$installationId/$viewId",
      params: { environmentId, installationId, viewId },
      replace: true,
    });
  }, [navigate, resolution.kind, environmentId, installationId, viewId]);
  return resolution.kind !== "core";
}
