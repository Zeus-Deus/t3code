import {
  AVAILABLE_CONNECTION_STATE,
  presentEnvironmentConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { PLUGIN_API_VERSION, type PluginInstallation } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";

type SessionResult = AsyncResult.AsyncResult<{ readonly granted: boolean }>;
type CatalogueResult = AsyncResult.AsyncResult<{
  readonly installations: ReadonlyArray<PluginInstallation>;
}>;

// The start page's environment as it boots: catalog, connection, config, session, plugin list.
const boot = await vi.hoisted(async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { AVAILABLE_CONNECTION_STATE } = await import("@t3tools/client-runtime/connection");
  return {
    catalogReady: Atom.keepAlive(Atom.make(false)),
    enabled: Atom.keepAlive(Atom.make(true)),
    // The connection state atom starts here before the supervisor reports anything.
    connection: Atom.keepAlive(Atom.make(AVAILABLE_CONNECTION_STATE)),
    config: Atom.keepAlive(Atom.make<unknown>(null)),
    session: Atom.keepAlive(Atom.make<SessionResult>(AsyncResult.initial(true))),
    catalogue: Atom.keepAlive(Atom.make<CatalogueResult>(AsyncResult.initial(true))),
    navigate: vi.fn(),
  };
});

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => boot.navigate) as never,
}));
vi.mock(import("../../state/environments"), async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...(await original()),
    useEnvironments: () => ({
      isReady: useAtomValue(boot.catalogReady),
      networkStatus: "online" as const,
      environments: [],
      presentationById: new Map(),
    }),
    useEnvironment: ((environmentId: string | null) => {
      const enabled = useAtomValue(boot.enabled);
      const connection = useAtomValue(boot.connection);
      const config = useAtomValue(boot.config);
      return environmentId === null
        ? null
        : {
            environmentId,
            entry: { enabled },
            connection: presentEnvironmentConnection(connection),
            serverConfig: config,
          };
    }) as never,
  };
});
vi.mock(import("../../state/session"), async (original) => {
  const actual = await original();
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    ...actual,
    useEnvironmentScope: () => {
      const result = useAtomValue(boot.session);
      return result._tag === "Success" && result.value.granted;
    },
    environmentSession: {
      ...actual.environmentSession,
      sessionStateAtom: (() => boot.session) as never,
    },
  };
});
vi.mock(import("../../state/query"), async (original) => {
  const { useAtomValue } = await import("@effect/atom-react");
  const Option = await import("effect/Option");
  return {
    ...(await original()),
    useEnvironmentQuery: ((atom: unknown) => {
      const result = useAtomValue(boot.catalogue);
      return {
        data: atom === null ? null : Option.getOrNull(AsyncResult.value(result)),
        error: atom !== null && result._tag === "Failure" ? "Could not list plugins" : null,
      };
    }) as never,
  };
});

import { resetPluginStartPageForTests, useHoldLandingForStartPage } from "./pluginStartPage";

const environmentId = "3efb6998-96fa-4265-872e-4eb43d15a9c7";
const pluginsConfig = {
  environment: { capabilities: { plugins: { apiVersion: PLUGIN_API_VERSION } } },
};

function board(): PluginInstallation {
  const digest = "b".repeat(64);
  return {
    installationId: "inst-board",
    generation: "gen-1",
    manifest: {
      id: "examples.workflow-board",
      name: "Workflow Board",
      version: "0.1.0",
      apiVersion: 1,
      entry: "plugin.mjs",
      capabilities: ["ui"],
      actions: [],
      views: [{ id: "board", title: "Board", entry: "views/board.html", placement: "page" }],
      settings: [],
    },
    source: { kind: "local", directory: "/plugins/workflow-board" },
    digest,
    enabled: true,
    consentedDigest: digest,
    status: "idle",
    error: null,
    settings: {},
    grants: { capabilities: ["ui"], projectIds: [] },
    updatedAt: "2026-10-22T00:00:00.000Z",
  } as PluginInstallation;
}

const connecting: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  phase: "connecting",
  stage: "preparing",
  attempt: 1,
};
const connected: SupervisorConnectionState = { ...connecting, phase: "connected", stage: null };

function setup() {
  resetPluginStartPageForTests();
  localStorage.setItem(
    "t3code:plugins:start-page",
    JSON.stringify({ environmentId, pluginId: "examples.workflow-board", viewId: "board" }),
  );
  appAtomRegistry.set(boot.catalogReady, false);
  appAtomRegistry.set(boot.enabled, true);
  appAtomRegistry.set(boot.connection, AVAILABLE_CONNECTION_STATE);
  appAtomRegistry.set(boot.config, null);
  appAtomRegistry.set(boot.session, AsyncResult.initial(true));
  appAtomRegistry.set(boot.catalogue, AsyncResult.initial(true));
  boot.navigate.mockReset();
  boot.navigate.mockResolvedValue(undefined);
}

function bootReady() {
  appAtomRegistry.set(boot.catalogReady, true);
  appAtomRegistry.set(boot.connection, connected);
  appAtomRegistry.set(boot.config, pluginsConfig);
  appAtomRegistry.set(boot.session, AsyncResult.success({ granted: true }));
  appAtomRegistry.set(boot.catalogue, AsyncResult.success({ installations: [board()] }));
}

function Probe() {
  return <p>{useHoldLandingForStartPage() ? "holding" : "landing"}</p>;
}

function renderLanding() {
  return render(
    <AppAtomRegistryProvider>
      <Probe />
    </AppAtomRegistryProvider>,
  );
}

const pluginRoute = {
  to: "/plugins/$environmentId/$installationId/$viewId",
  params: { environmentId, installationId: "inst-board", viewId: "board" },
  replace: true,
};

it("holds the landing through a cold start and then opens the start page", async () => {
  setup();
  await using screen = await renderLanding();
  const steps: ReadonlyArray<readonly [string, () => void]> = [
    ["catalog read", () => appAtomRegistry.set(boot.catalogReady, true)],
    ["connecting", () => appAtomRegistry.set(boot.connection, connecting)],
    ["connected", () => appAtomRegistry.set(boot.connection, connected)],
    ["config loaded", () => appAtomRegistry.set(boot.config, pluginsConfig)],
    [
      "session loaded",
      () => appAtomRegistry.set(boot.session, AsyncResult.success({ granted: true })),
    ],
  ];
  for (const [label, step] of steps) {
    await act(step);
    await expect.element(screen.getByText("holding"), { message: label }).toBeVisible();
    expect(boot.navigate, label).not.toHaveBeenCalled();
  }

  await act(() =>
    appAtomRegistry.set(boot.catalogue, AsyncResult.success({ installations: [board()] })),
  );
  await vi.waitFor(() => expect(boot.navigate).toHaveBeenCalledWith(pluginRoute));
});

it("starts the usual way at once when the environment cannot open the page", async () => {
  const cases: ReadonlyArray<readonly [string, () => void]> = [
    [
      "disabled",
      () => {
        appAtomRegistry.set(boot.enabled, false);
        appAtomRegistry.set(boot.connection, AVAILABLE_CONNECTION_STATE);
      },
    ],
    [
      "failed",
      () =>
        appAtomRegistry.set(boot.connection, {
          ...connected,
          phase: "blocked",
          lastFailure: null,
        }),
    ],
    [
      "session without access",
      () => appAtomRegistry.set(boot.session, AsyncResult.success({ granted: false })),
    ],
    [
      "plugin missing",
      () => appAtomRegistry.set(boot.catalogue, AsyncResult.success({ installations: [] })),
    ],
  ];
  for (const [label, change] of cases) {
    setup();
    bootReady();
    change();
    await using screen = await renderLanding();
    await expect.element(screen.getByText("landing"), { message: label }).toBeVisible();
    expect(boot.navigate, label).not.toHaveBeenCalled();
  }
});

it("keeps holding until the start page has opened", async () => {
  setup();
  bootReady();
  let finishNavigation = () => {};
  boot.navigate.mockReturnValue(
    new Promise<void>((resolve) => {
      finishNavigation = resolve;
    }),
  );
  await using screen = await renderLanding();
  await vi.waitFor(() => expect(boot.navigate).toHaveBeenCalledWith(pluginRoute));

  // Startup keeps re-rendering the landing while the plugin route loads.
  for (const render of ["first", "second"]) {
    await screen.rerender(
      <AppAtomRegistryProvider>
        <Probe />
      </AppAtomRegistryProvider>,
    );
    await expect.element(screen.getByText("holding"), { message: render }).toBeVisible();
  }

  // The route never committed, so the landing takes over rather than staying blank.
  await act(() => finishNavigation());
  await expect.element(screen.getByText("landing")).toBeVisible();
  expect(boot.navigate).toHaveBeenCalledTimes(1);
});

it("leaves a page the person opened while the start page was loading", async () => {
  setup();
  await using screen = await renderLanding();
  await expect.element(screen.getByText("holding")).toBeVisible();

  await act(() => screen.router?.navigate({ to: "/settings" }));
  await act(bootReady);
  expect(boot.navigate).not.toHaveBeenCalled();

  // Settled for this app load: a later visit to the landing starts the usual way.
  await screen.rerender(
    <AppAtomRegistryProvider>
      <Probe />
    </AppAtomRegistryProvider>,
  );
  await expect.element(screen.getByText("landing")).toBeVisible();
  expect(boot.navigate).not.toHaveBeenCalled();
});
