import {
  AVAILABLE_CONNECTION_STATE,
  connectionRegistrationCatalogEntry,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import {
  EnvironmentId,
  PLUGIN_API_VERSION,
  type PluginInstallation,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
} from "@t3tools/contracts";
import { useLocation, useRouter, type AnyRouter } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useEffectEvent } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";

type SessionResult = AsyncResult.AsyncResult<{ readonly granted: boolean }>;
type CatalogueResult = AsyncResult.AsyncResult<{
  readonly installations: ReadonlyArray<PluginInstallation>;
}>;

// The sources the real environment hooks read as the app boots: the connection catalog, the
// supervisor's state, server config, session and plugin list.
const boot = await vi.hoisted(async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    catalog: Atom.keepAlive(
      Atom.make<EnvironmentCatalogState>({ isReady: false, entries: new Map() }),
    ),
    // Initial until the supervisor reports; the presentation reads that as never connected.
    connection: Atom.keepAlive(
      Atom.make<AsyncResult.AsyncResult<SupervisorConnectionState>>(AsyncResult.initial(true)),
    ),
    config: Atom.keepAlive(Atom.make<ServerConfig | null>(null)),
    session: Atom.keepAlive(Atom.make<SessionResult>(AsyncResult.initial(true))),
    catalogue: Atom.keepAlive(Atom.make<CatalogueResult>(AsyncResult.initial(true))),
    navigate: vi.fn(),
  };
});

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => boot.navigate) as never,
}));
vi.mock(import("../../connection/catalog"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original();
  return {
    environmentCatalog: {
      ...actual.environmentCatalog,
      catalogValueAtom: boot.catalog,
      networkStatusValueAtom: Atom.make("online" as const),
      stateAtom: () => boot.connection,
    },
  };
});
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: () => boot.config },
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

import { useBootstrapThreadNavigation } from "../../hooks/useBootstrapThreadNavigation";
import {
  resetPluginStartPageForTests,
  useHoldLandingForStartPage,
  useStartPageDecided,
} from "./pluginStartPage";

const environmentId = "3efb6998-96fa-4265-872e-4eb43d15a9c7";
const pluginsConfig = {
  environment: { capabilities: { plugins: { apiVersion: PLUGIN_API_VERSION } } },
} as ServerConfig;

// Platform discovery registers the primary environment; it is never in the persisted catalog.
function primaryEntry(id: string) {
  return connectionRegistrationCatalogEntry(
    new PrimaryConnectionRegistration({
      target: new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make(id),
        label: "This machine",
        httpBaseUrl: "http://localhost:3773",
        wsBaseUrl: "ws://localhost:3773",
      }),
    }),
  );
}

function catalogOf(...entries: ReadonlyArray<ReturnType<typeof primaryEntry>>) {
  return {
    isReady: true,
    entries: new Map(entries.map((entry) => [entry.target.environmentId, entry])),
  };
}

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
  appAtomRegistry.set(boot.catalog, { isReady: false, entries: new Map() });
  appAtomRegistry.set(boot.connection, AsyncResult.initial(true));
  appAtomRegistry.set(boot.config, null);
  appAtomRegistry.set(boot.session, AsyncResult.initial(true));
  appAtomRegistry.set(boot.catalogue, AsyncResult.initial(true));
  boot.navigate.mockReset();
  boot.navigate.mockResolvedValue(undefined);
}

function bootReady() {
  appAtomRegistry.set(boot.catalog, catalogOf(primaryEntry(environmentId)));
  appAtomRegistry.set(boot.connection, AsyncResult.success(connected));
  appAtomRegistry.set(boot.config, pluginsConfig);
  appAtomRegistry.set(boot.session, AsyncResult.success({ granted: true }));
  appAtomRegistry.set(boot.catalogue, AsyncResult.success({ installations: [board()] }));
}

// The landing's hold, and whether other startup navigation (the bootstrap thread) may run.
function Probe() {
  const holding = useHoldLandingForStartPage();
  const decided = useStartPageDecided();
  return (
    <>
      <p>{holding ? "holding" : "landing"}</p>
      <p>{decided ? "decided" : "undecided"}</p>
    </>
  );
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
    [
      "persisted catalog read before the primary registers",
      () => appAtomRegistry.set(boot.catalog, catalogOf()),
    ],
    [
      "primary registered",
      () => appAtomRegistry.set(boot.catalog, catalogOf(primaryEntry(environmentId))),
    ],
    ["connecting", () => appAtomRegistry.set(boot.connection, AsyncResult.success(connecting))],
    ["connected", () => appAtomRegistry.set(boot.connection, AsyncResult.success(connected))],
    ["config loaded", () => appAtomRegistry.set(boot.config, pluginsConfig)],
    [
      "session loaded",
      () => appAtomRegistry.set(boot.session, AsyncResult.success({ granted: true })),
    ],
  ];
  for (const [label, step] of steps) {
    await act(step);
    await expect.element(screen.getByText("holding"), { message: label }).toBeVisible();
    await expect.element(screen.getByText("undecided"), { message: label }).toBeVisible();
    expect(boot.navigate, label).not.toHaveBeenCalled();
  }

  await act(() =>
    appAtomRegistry.set(boot.catalogue, AsyncResult.success({ installations: [board()] })),
  );
  await vi.waitFor(() => expect(boot.navigate).toHaveBeenCalledWith(pluginRoute));
  await expect.element(screen.getByText("decided")).toBeVisible();
});

it("leaves startup navigation alone without a start page", async () => {
  setup();
  localStorage.removeItem("t3code:plugins:start-page");
  await using screen = await renderLanding();
  await expect.element(screen.getByText("landing")).toBeVisible();
  await expect.element(screen.getByText("decided")).toBeVisible();
  expect(boot.navigate).not.toHaveBeenCalled();
});

it("starts the usual way at once when the environment cannot open the page", async () => {
  const cases: ReadonlyArray<readonly [string, () => void]> = [
    [
      "removed",
      () =>
        appAtomRegistry.set(
          boot.catalog,
          catalogOf(primaryEntry("a1b2c3d4-0000-4000-8000-000000000000")),
        ),
    ],
    [
      "disabled",
      () => {
        appAtomRegistry.set(
          boot.catalog,
          catalogOf({ ...primaryEntry(environmentId), enabled: false }),
        );
        appAtomRegistry.set(boot.connection, AsyncResult.success(AVAILABLE_CONNECTION_STATE));
      },
    ],
    [
      "failed",
      () =>
        appAtomRegistry.set(
          boot.connection,
          AsyncResult.success({ ...connected, phase: "blocked", lastFailure: null }),
        ),
    ],
    [
      "session without access",
      () => appAtomRegistry.set(boot.session, AsyncResult.success({ granted: false })),
    ],
    [
      "plugin missing",
      () => appAtomRegistry.set(boot.catalogue, AsyncResult.success({ installations: [] })),
    ],
    // Mixed versions: neither side may leave the landing waiting for plugins it cannot list.
    [
      "server without plugins",
      () =>
        appAtomRegistry.set(boot.config, {
          environment: { capabilities: {} },
        } as ServerConfig),
    ],
    [
      "server with a newer plugin API",
      () =>
        appAtomRegistry.set(boot.config, {
          environment: { capabilities: { plugins: { apiVersion: PLUGIN_API_VERSION + 1 } } },
        } as ServerConfig),
    ],
    [
      "client no longer supported",
      () =>
        appAtomRegistry.set(
          boot.catalog,
          catalogOf({ ...primaryEntry(environmentId), unsupportedReason: "Update T3 Code" }),
        ),
    ],
    [
      "first connection failed and is retrying",
      () =>
        appAtomRegistry.set(
          boot.connection,
          AsyncResult.success({ ...connected, phase: "backoff", lastFailure: null }),
        ),
    ],
  ];
  for (const [label, change] of cases) {
    setup();
    bootReady();
    change();
    await using screen = await renderLanding();
    await expect.element(screen.getByText("landing"), { message: label }).toBeVisible();
    await expect.element(screen.getByText("decided"), { message: label }).toBeVisible();
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
    await expect.element(screen.getByText("undecided"), { message: render }).toBeVisible();
  }

  // The route never committed, so the usual landing and bootstrap thread take over.
  await act(() => finishNavigation());
  await expect.element(screen.getByText("landing")).toBeVisible();
  await expect.element(screen.getByText("decided")).toBeVisible();
  expect(boot.navigate).toHaveBeenCalledTimes(1);
});

it("leaves a page the person opened while the start page was loading", async () => {
  setup();
  await using screen = await renderLanding();
  await expect.element(screen.getByText("holding")).toBeVisible();

  await act(() => screen.router?.navigate({ to: "/settings" }));
  await act(bootReady);
  expect(boot.navigate).not.toHaveBeenCalled();
  await expect.element(screen.getByText("decided")).toBeVisible();

  // Settled for this app load: a later visit to the landing starts the usual way.
  await screen.rerender(
    <AppAtomRegistryProvider>
      <Probe />
    </AppAtomRegistryProvider>,
  );
  await expect.element(screen.getByText("landing")).toBeVisible();
  expect(boot.navigate).not.toHaveBeenCalled();
});

const welcome = {
  environment: { environmentId },
  bootstrapProjectId: "project-boot",
  bootstrapThreadId: "thread-boot",
} as unknown as ServerLifecycleWelcomePayload;

// The landing's own guard before it starts a draft: hold released and still on "/".
function DraftGuard(props: { readonly onDraft: () => void }) {
  const holding = useHoldLandingForStartPage();
  const router = useRouter();
  const onDraft = useEffectEvent(() => props.onDraft());
  useEffect(() => {
    if (!holding && router.state.location.pathname === "/") onDraft();
  }, [holding, router]);
  return <p>{holding ? "holding" : "landing"}</p>;
}

function WelcomeHandler(props: { readonly welcome: ServerLifecycleWelcomePayload | null }) {
  const openBootstrapThread = useBootstrapThreadNavigation(false);
  const handleWelcome = useEffectEvent((welcome: ServerLifecycleWelcomePayload | null) => {
    if (welcome !== null) void openBootstrapThread(welcome);
  });
  useEffect(() => {
    handleWelcome(props.welcome);
  }, [props.welcome]);
  return null;
}

function IndexRoute(props: { readonly onDraft: () => void }) {
  const onIndex = useLocation({ select: (location) => location.pathname === "/" });
  return onIndex ? <DraftGuard onDraft={props.onDraft} /> : <p>elsewhere</p>;
}

// Startup as the app arranges it: the welcome handler is a sibling ahead of the routed landing,
// so its effects run first in a commit.
function Startup(props: {
  readonly welcome: ServerLifecycleWelcomePayload | null;
  readonly onDraft: () => void;
}) {
  return (
    <>
      <WelcomeHandler welcome={props.welcome} />
      <IndexRoute onDraft={props.onDraft} />
    </>
  );
}

async function renderStartup(onDraft: () => void) {
  const screen = await render(
    <AppAtomRegistryProvider>
      <Startup welcome={null} onDraft={onDraft} />
    </AppAtomRegistryProvider>,
  );
  const router: AnyRouter = screen.router!;
  // Both startup navigations go through the real router, so later effects see where it went.
  boot.navigate.mockImplementation((options) => router.navigate(options));
  const welcomeArrives = () =>
    screen.rerender(
      <AppAtomRegistryProvider>
        <Startup welcome={welcome} onDraft={onDraft} />
      </AppAtomRegistryProvider>,
    );
  return { screen, router, welcomeArrives };
}

const bootstrapRoute = {
  to: "/$environmentId/$threadId",
  params: { environmentId, threadId: "thread-boot" },
  replace: true,
};

it("opens the start page, not the bootstrap thread, when the welcome arrives first", async () => {
  setup();
  const onDraft = vi.fn();
  const { screen, router, welcomeArrives } = await renderStartup(onDraft);
  await using _screen = screen;
  await welcomeArrives();
  await expect.element(screen.getByText("holding")).toBeVisible();
  expect(boot.navigate).not.toHaveBeenCalled();

  await act(bootReady);
  await expect.element(screen.getByText("elsewhere")).toBeVisible();
  expect(router.state.location.pathname).toBe(`/plugins/${environmentId}/inst-board/board`);
  expect(boot.navigate.mock.calls).toEqual([[pluginRoute]]);
  expect(onDraft).not.toHaveBeenCalled();
});

it("hands the landing to the bootstrap thread, not a draft, when the start page cannot open", async () => {
  setup();
  const onDraft = vi.fn();
  const { screen, router, welcomeArrives } = await renderStartup(onDraft);
  await using _screen = screen;
  await welcomeArrives();
  expect(boot.navigate).not.toHaveBeenCalled();

  await act(() => {
    bootReady();
    appAtomRegistry.set(boot.catalogue, AsyncResult.success({ installations: [] }));
  });
  await expect.element(screen.getByText("elsewhere")).toBeVisible();
  expect(router.state.location.pathname).toBe(`/${environmentId}/thread-boot`);
  expect(boot.navigate.mock.calls).toEqual([[bootstrapRoute]]);
  expect(onDraft).not.toHaveBeenCalled();
});

it("opens the bootstrap thread at once without a start page", async () => {
  setup();
  localStorage.removeItem("t3code:plugins:start-page");
  const { screen, router, welcomeArrives } = await renderStartup(vi.fn());
  await using _screen = screen;
  await welcomeArrives();
  await expect.element(screen.getByText("elsewhere")).toBeVisible();
  expect(router.state.location.pathname).toBe(`/${environmentId}/thread-boot`);
  expect(boot.navigate.mock.calls).toEqual([[bootstrapRoute]]);
});

it("leaves a page the person opened while the welcome waited", async () => {
  setup();
  const { screen, router, welcomeArrives } = await renderStartup(vi.fn());
  await using _screen = screen;
  await welcomeArrives();
  await act(() => router.navigate({ to: "/settings" }));
  await act(bootReady);
  await expect.element(screen.getByText("elsewhere")).toBeVisible();
  expect(router.state.location.pathname).toBe("/settings");
  expect(boot.navigate).not.toHaveBeenCalled();
});

it("does not open the start page on a later visit after the app opened elsewhere", async () => {
  setup();
  bootReady();
  const onDraft = vi.fn();
  await using screen = await render(
    <AppAtomRegistryProvider>
      <Startup welcome={null} onDraft={onDraft} />
    </AppAtomRegistryProvider>,
    { router: "/settings" },
  );
  await expect.element(screen.getByText("elsewhere")).toBeVisible();

  // Later in the session, e.g. after deleting the last thread, the app returns to the landing.
  await act(() => screen.router?.navigate({ to: "/" }));
  await expect.element(screen.getByText("landing")).toBeVisible();
  expect(boot.navigate).not.toHaveBeenCalled();
  expect(onDraft).toHaveBeenCalledTimes(1);
});
