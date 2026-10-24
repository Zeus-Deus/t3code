import { RegistryProvider } from "@effect/atom-react";
import { EnvironmentId, type PluginInstallation } from "@t3tools/contracts";
import {
  createBrowserHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../../test/render";

// The desktop shell. Its unload cannot show a page's leave prompt.
vi.mock(import("../../env"), async (original) => ({ ...(await original()), isElectron: true }));

const DIGEST = "a".repeat(64);
const installation: PluginInstallation = {
  installationId: "inst-1",
  generation: "gen-1",
  manifest: {
    id: "examples.workflow-board",
    name: "Workflow Board",
    version: "1.0.0",
    apiVersion: 1,
    entry: "plugin.mjs",
    capabilities: ["ui"],
    actions: [],
    views: [],
    settings: [{ key: "label", label: "Board label", type: "string" }],
  },
  source: { kind: "local", directory: "/plugins/board" },
  digest: DIGEST,
  enabled: true,
  consentedDigest: DIGEST,
  status: "idle",
  error: null,
  settings: { label: "Board" },
  grants: { capabilities: ["ui"], projectIds: [] },
  updatedAt: "2026-10-22T00:00:00.000Z",
};

vi.mock(import("../../state/plugins"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const environment = actual.pluginEnvironment;
  return {
    ...actual,
    pluginEnvironment: {
      ...environment,
      install: { ...environment.install, permissionAtom: () => allowed },
      setEnabled: { ...environment.setEnabled, permissionAtom: () => allowed },
      prepareRepair: { ...environment.prepareRepair, permissionAtom: () => allowed },
    },
    usePluginCatalogue: () => ({
      availability: "available" as const,
      installations: [installation],
      loaded: true,
      error: null,
      recoverySupported: false,
      executionDisabled: false,
      unavailableMessage: null,
    }),
  };
});
// Nothing here runs a command or reads projects, and the real ones would reach for a server.
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => async () => {
    throw new Error("No command runs in this test.");
  }) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environment = {
      environmentId: EnvironmentId.make("env-1"),
      label: "Workstation",
      connection: { phase: "connected" },
      serverConfig: {
        environment: {
          platform: { os: "darwin", machine: "laptop" },
          capabilities: { plugins: { apiVersion: 1 } },
        },
      },
    };
    return {
      scope: { kind: "environment" },
      environment,
      environments: [environment],
      connectedEnvironments: [environment],
    };
  }) as never,
}));
// The real layout reads settings scope overrides and search targets; this suite is about plugins.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({
    children,
    className,
  }: {
    children: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>) as never,
  SettingsSection: (({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  )) as never,
  SettingsRow: (({ title, description, status, control }: Record<string, ReactNode>) => (
    <div>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {status}
      {control}
    </div>
  )) as never,
}));

import { PluginsSettings } from "./PluginsSettings";

it("leaves closing to the desktop shell, which cannot prompt, but still guards in-app navigation", async () => {
  // Browser history, as the app's routers use, is what answers a page unload.
  const history = createBrowserHistory();
  using _history = { [Symbol.dispose]: () => history.destroy() };
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <RegistryProvider>
          <PluginsSettings />
        </RegistryProvider>
      ),
    }),
    history,
  });
  const container = document.createElement("div");
  container.style.width = "1100px";
  // The shared test router uses memory history, which never sees an unload.
  await using _screen = await render(<RouterProvider router={router} />, {
    router: false,
    container,
  });

  await userEvent.fill(page.getByRole("textbox", { name: "Board label" }), "Sprint board");
  await expect.element(page.getByText("Unsaved changes")).toBeInTheDocument();
  // Commits the page's leave guard for the edit.
  await act(() => {});

  // Electron cancels a prevented unload without asking, so closing or updating would stall.
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(false);

  using confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const start = router.state.location.href;
  // A blocked navigation never settles, as in the app where callers do not await it.
  void router.navigate({ to: "/settings/general" });
  await vi.waitFor(() =>
    expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to Workflow Board settings?"),
  );
  expect(router.state.location.href).toBe(start);
});
