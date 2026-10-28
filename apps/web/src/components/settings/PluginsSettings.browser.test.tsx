import { RegistryProvider } from "@effect/atom-react";
import {
  createBrowserHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { EnvironmentId, ProjectId, type PluginInstallation } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  /** Each environment's installations, in catalogue order. */
  catalogues: {} as Record<string, PluginInstallation[]>,
  calls: [] as Array<{ label: string; environmentId: string; input: unknown }>,
  /** Connected environments; the Settings scope shows `selected`. */
  environmentIds: ["env-1"] as string[],
  selected: "env-1",
  /** Environments whose session lacks the install scopes. */
  installDenied: [] as string[],
  /** Advertised plugin API per environment; unlisted ones speak the current one. */
  apiVersions: {} as Record<string, number | undefined>,
  /** What install returns, when the catalogue does not list it yet. */
  installResult: null as PluginInstallation | null,
  /** The server advertises repair, previous-version and missed-event requests. */
  recovery: false,
  executionDisabled: false,
  /** Results for commands whose label contains the key, instead of the first installation. */
  results: {} as Record<string, unknown>,
  catalogueListeners: new Set<() => void>(),
}));

vi.mock(import("../../state/plugins"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.catalogueListeners.add(listener);
    return () => state.catalogueListeners.delete(listener);
  };
  const allowed = Atom.make(true);
  const withPermission = <C extends object>(command: C) => ({
    ...command,
    permissionAtom: () => allowed,
  });
  const installAllowed = Atom.family((environmentId: string | null) =>
    Atom.make(() => environmentId !== null && !state.installDenied.includes(environmentId)),
  );
  const environment = actual.pluginEnvironment;
  const none: PluginInstallation[] = [];
  return {
    ...actual,
    pluginEnvironment: {
      ...environment,
      install: { ...environment.install, permissionAtom: installAllowed },
      consent: withPermission(environment.consent),
      setEnabled: withPermission(environment.setEnabled),
      prepareRepair: withPermission(environment.prepareRepair),
      invoke: withPermission(environment.invoke),
    },
    usePluginCatalogue: (environmentId: string | null) => {
      const installations = useSyncExternalStore(subscribe, () =>
        environmentId === null ? none : (state.catalogues[environmentId] ?? none),
      );
      return {
        availability: "available" as const,
        installations,
        loaded: true,
        error: null,
        recoverySupported: state.recovery,
        executionDisabled: state.executionDisabled,
        unavailableMessage: null,
      };
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label: string }) =>
    async (request: { environmentId: string; input: unknown }) => {
      state.calls.push({
        label: command.label,
        environmentId: request.environmentId,
        input: request.input,
      });
      const result = Object.entries(state.results).find(([fragment]) =>
        command.label.includes(fragment),
      );
      return AsyncResult.success(
        result
          ? await result[1]
          : (state.installResult ?? state.catalogues[request.environmentId]?.[0] ?? null),
      );
    }) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [
    {
      id: ProjectId.make("proj-showcase"),
      environmentId: EnvironmentId.make("env-1"),
      title: "Plugin Showcase",
      workspaceRoot: "/work/showcase",
    } as never,
  ],
}));
// The route resolves Settings scope to one environment for this page, as it does for Providers.
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environments = state.environmentIds.map((id, index) => ({
      environmentId: EnvironmentId.make(id),
      label: index === 0 ? "Workstation" : `Machine ${index + 1}`,
      connection: { phase: "connected" },
      serverConfig: {
        environment: {
          platform: { os: "linux", machine: "desktop" },
          capabilities: {
            plugins: { apiVersion: id in state.apiVersions ? state.apiVersions[id] : 1 },
          },
        },
      },
    }));
    const selected = environments.filter((entry) => entry.environmentId === state.selected);
    return {
      scope: { kind: "environment" },
      environment: selected[0] ?? null,
      environments: selected,
      connectedEnvironments: selected,
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
  SettingsSection: (({
    title,
    children,
    headerAction,
  }: {
    title: string;
    children: ReactNode;
    headerAction?: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  )) as never,
  SettingsRow: (({ title, description, status, control, children }: Record<string, ReactNode>) => (
    <div>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {status}
      {control}
      {children}
    </div>
  )) as never,
}));

import { PluginsSettings } from "./PluginsSettings";

const DIGEST = "a".repeat(64);
const PENDING_DIGEST = "b".repeat(64);

function installationFixture(overrides: Partial<PluginInstallation>): PluginInstallation {
  return {
    installationId: "inst-1",
    generation: "gen-1",
    manifest: {
      id: "examples.workflow-board",
      name: "Workflow Board",
      version: "1.0.0",
      apiVersion: 1,
      entry: "plugin.mjs",
      capabilities: ["ui", "threads.send"],
      actions: [],
      views: [],
      settings: [],
    },
    source: { kind: "local", directory: "/plugins/board" },
    digest: DIGEST,
    enabled: false,
    consentedDigest: null,
    status: "needs-consent",
    error: null,
    settings: {},
    grants: { capabilities: [], projectIds: [] },
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...overrides,
  };
}

function setup(
  installations: PluginInstallation | PluginInstallation[] | null,
  options: {
    environmentIds?: string[];
    selected?: string;
    catalogues?: Record<string, PluginInstallation[]>;
    installDenied?: string[];
    apiVersions?: Record<string, number | undefined>;
    installResult?: PluginInstallation;
    recovery?: boolean;
    executionDisabled?: boolean;
    results?: Record<string, unknown>;
  } = {},
) {
  state.environmentIds = options.environmentIds ?? ["env-1"];
  state.selected = options.selected ?? state.environmentIds[0]!;
  state.catalogues = {
    ...options.catalogues,
    [state.selected]:
      installations === null ? [] : Array.isArray(installations) ? installations : [installations],
  };
  state.calls = [];
  state.installDenied = options.installDenied ?? [];
  state.apiVersions = options.apiVersions ?? {};
  state.installResult = options.installResult ?? null;
  state.recovery = options.recovery ?? false;
  state.executionDisabled = options.executionDisabled ?? false;
  state.results = options.results ?? {};
  state.catalogueListeners.clear();
}

/** A catalogue push from the environment, such as another device installing or removing. */
const pushCatalogue = (
  installations: PluginInstallation | PluginInstallation[] | null,
  environmentId = state.selected,
) =>
  act(() => {
    state.catalogues = {
      ...state.catalogues,
      [environmentId]:
        installations === null
          ? []
          : Array.isArray(installations)
            ? installations
            : [installations],
    };
    for (const listener of state.catalogueListeners) listener();
  });

const settings = (target?: { environmentId?: EnvironmentId; installationId?: string }) => (
  <RegistryProvider>
    <PluginsSettings {...(target ? { target } : {})} />
  </RegistryProvider>
);
/** The page lays out by its own width: list beside the plugin when wide, one at a time when narrow. */
function sized(width: number) {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  return container;
}
const renderWide = (ui = settings()) =>
  render(ui, { router: "/settings/plugins", container: sized(1100) });
const renderNarrow = (ui = settings()) =>
  render(ui, { router: "/settings/plugins", container: sized(400) });
// Base UI dialogs mark the page behind them inert, which blocks pointer clicks in tests; the
// locator still finds each control by its accessible role and name.
const press = (locator: ReturnType<typeof page.getByRole>) =>
  act(() => (locator.element() as HTMLElement).click());
const callsTo = (fragment: string) =>
  state.calls.filter((call) => call.label.includes(fragment)).map((call) => call.input);
const callsWithEnvironment = (fragment: string) =>
  state.calls
    .filter((call) => call.label.includes(fragment))
    .map((call) => ({ environmentId: call.environmentId, input: call.input }));
const pluginHeading = (name: string) => page.getByRole("heading", { name, exact: true, level: 2 });
const rowNames = () =>
  page
    .getByRole("button", { name: /^Select / })
    .elements()
    .map((element) => element.getAttribute("aria-label"));

it("approves the reviewed digest with exactly the permissions and projects left on", async () => {
  setup(installationFixture({}));
  await using _screen = await renderWide();

  await press(page.getByRole("button", { name: "Review", exact: true }));
  const sendMessages = page.getByRole("checkbox", { name: "Send messages" });
  await expect.element(sendMessages).toBeChecked();
  await press(page.getByRole("checkbox", { name: "Plugin Showcase" }));
  await press(page.getByRole("checkbox", { name: "Show views" }));
  await press(page.getByRole("button", { name: "Approve and enable" }));

  await vi.waitFor(() => expect(callsTo(":consent")).toHaveLength(1));
  expect(callsTo(":consent")[0]).toEqual({
    installationId: "inst-1",
    digest: DIGEST,
    grants: { capabilities: ["threads.send"], projectIds: ["proj-showcase"] },
  });
  await vi.waitFor(() =>
    expect(callsTo(":set-enabled")).toEqual([{ installationId: "inst-1", enabled: true }]),
  );
});

function stagedUpdate() {
  return installationFixture({
    enabled: true,
    consentedDigest: DIGEST,
    status: "idle",
    grants: { capabilities: ["ui"], projectIds: [] },
    manifest: { ...installationFixture({}).manifest, capabilities: ["ui"] },
    pendingUpdate: {
      manifest: {
        ...installationFixture({}).manifest,
        version: "1.1.0",
        capabilities: ["ui", "threads.send"],
      },
      source: { kind: "local", directory: "/plugins/board" },
      digest: PENDING_DIGEST,
      generation: "gen-2",
      updatedAt: "2026-10-22T01:00:00.000Z",
    },
  });
}

it("approves a staged update without widening grants or re-enabling", async () => {
  setup(stagedUpdate());
  await using _screen = await renderWide();

  await press(page.getByRole("button", { name: "Review update" }));
  // New in the update, so it starts off; the running version never had it.
  await expect.element(page.getByRole("checkbox", { name: "Send messages" })).not.toBeChecked();
  await expect.element(page.getByRole("checkbox", { name: "Show views" })).toBeChecked();
  await press(page.getByRole("button", { name: "Approve update" }));

  await vi.waitFor(() => expect(callsTo(":consent")).toHaveLength(1));
  expect(callsTo(":consent")[0]).toEqual({
    installationId: "inst-1",
    digest: PENDING_DIGEST,
    grants: { capabilities: ["ui"], projectIds: [] },
  });
  expect(callsTo(":set-enabled")).toEqual([]);
});

it("keeps the running version when an update is discarded", async () => {
  setup(stagedUpdate());
  await using _screen = await renderWide();

  await press(page.getByRole("button", { name: "Review update" }));
  await press(page.getByRole("button", { name: "Discard update" }));

  await vi.waitFor(() =>
    expect(callsTo(":discard-pending-update")).toEqual([{ installationId: "inst-1" }]),
  );
  expect(callsTo(":consent")).toEqual([]);
});

const configurable = (overrides: Partial<PluginInstallation> = {}) =>
  installationFixture({
    enabled: true,
    consentedDigest: DIGEST,
    status: "idle",
    grants: { capabilities: ["ui", "threads.send"], projectIds: [] },
    settings: { label: "Board" },
    manifest: {
      ...installationFixture({}).manifest,
      settings: [
        { key: "label", label: "Board label", type: "string" },
        {
          key: "autoFollowup",
          label: "Request a review automatically",
          description: "Off by default.",
          type: "boolean",
          default: false,
        },
      ],
    },
    ...overrides,
  });

it("names setting switches and saves only the settings the user changed", async () => {
  setup(configurable());
  await using _screen = await renderWide();

  const save = page.getByRole("button", { name: "Save" });
  await expect.element(save).toBeDisabled();
  const autoFollowup = page.getByRole("switch", { name: "Request a review automatically" });
  await expect.element(autoFollowup).not.toBeChecked();
  await press(autoFollowup);
  await press(save);

  await vi.waitFor(() =>
    expect(callsTo(":update-settings")).toEqual([
      { installationId: "inst-1", values: { autoFollowup: true } },
    ]),
  );
});

it("keeps an unsaved value through status pushes and asks before another plugin replaces it", async () => {
  const lens = installationFixture({
    installationId: "inst-2",
    manifest: { ...installationFixture({}).manifest, id: "examples.lens", name: "Lens" },
  });
  setup([configurable(), lens]);
  await using _screen = await renderWide();

  const label = page.getByRole("textbox", { name: "Board label" });
  await userEvent.fill(label, "Sprint board");
  // The plugin stops on its host while the user is typing; the form keeps their value.
  await pushCatalogue([configurable({ status: "error", error: "Crashed" }), lens]);
  await expect.element(page.getByText("Stopped after a failure")).toBeInTheDocument();
  await expect.element(label).toHaveValue("Sprint board");

  using confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await press(page.getByRole("button", { name: "Select Lens" }));
  expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to Workflow Board settings?");
  await expect.element(pluginHeading("Workflow Board")).toBeInTheDocument();
  await expect.element(label).toHaveValue("Sprint board");

  confirm.mockReturnValue(true);
  await press(page.getByRole("button", { name: "Select Lens" }));
  await expect.element(pluginHeading("Lens")).toBeInTheDocument();
  expect(callsTo(":update-settings")).toEqual([]);
});

it("shows another device's saved value while nothing is being edited", async () => {
  setup(configurable());
  await using _screen = await renderWide();

  const label = page.getByRole("textbox", { name: "Board label" });
  await expect.element(label).toHaveValue("Board");
  await pushCatalogue(configurable({ settings: { label: "Renamed elsewhere" } }));
  await expect.element(label).toHaveValue("Renamed elsewhere");
  await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();
});

function lineup() {
  return [
    installationFixture({
      installationId: "inst-board",
      enabled: true,
      consentedDigest: DIGEST,
      status: "idle",
    }),
    installationFixture({
      installationId: "inst-lens",
      enabled: true,
      consentedDigest: DIGEST,
      status: "idle",
      manifest: {
        ...installationFixture({}).manifest,
        id: "examples.repository-lens",
        name: "Repository Lens",
        description: "Shows a repository overview.",
      },
    }),
    installationFixture({
      installationId: "inst-notes",
      enabled: true,
      consentedDigest: DIGEST,
      status: "idle",
      manifest: { ...installationFixture({}).manifest, id: "examples.notes", name: "Notes" },
    }),
  ];
}

it("filters by search and attention without reordering rows when a status changes", async () => {
  setup(lineup());
  await using _screen = await renderWide();

  expect(rowNames()).toEqual(["Select Workflow Board", "Select Repository Lens", "Select Notes"]);
  // Nothing needs attention, so there is nothing to filter by.
  expect(page.getByRole("button", { name: /Needs attention/ }).query()).toBeNull();

  const [board, lens, notes] = lineup();
  await pushCatalogue([board!, { ...lens!, status: "error", error: "Crashed" }, notes!]);
  expect(rowNames()).toEqual(["Select Workflow Board", "Select Repository Lens", "Select Notes"]);
  await press(page.getByRole("button", { name: "Needs attention (1)" }));
  expect(rowNames()).toEqual(["Select Repository Lens"]);

  await userEvent.fill(page.getByRole("searchbox", { name: "Search plugins" }), "board");
  await expect.element(page.getByText("No plugins match.")).toBeInTheDocument();
  await press(page.getByRole("button", { name: "Clear filters" }));
  expect(rowNames()).toHaveLength(3);
  await expect.element(page.getByRole("searchbox", { name: "Search plugins" })).toHaveValue("");

  await userEvent.fill(page.getByRole("searchbox", { name: "Search plugins" }), "overview");
  expect(rowNames()).toEqual(["Select Repository Lens"]);
});

it("selects a plugin without turning it on and keeps the selection through pushes", async () => {
  const disabled = lineup().map((entry) => ({
    ...entry,
    enabled: false,
    status: "disabled" as const,
  }));
  setup(disabled);
  await using _screen = await renderWide();

  await expect.element(pluginHeading("Workflow Board")).toBeInTheDocument();
  await press(page.getByRole("button", { name: "Select Notes" }));
  await expect.element(pluginHeading("Notes")).toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "Select Notes" }))
    .toHaveAttribute("aria-pressed", "true");
  expect(callsTo(":set-enabled")).toEqual([]);

  // A failure elsewhere in the list, and a fresh record for the selected one.
  await pushCatalogue([
    { ...disabled[0]!, status: "error", error: "Crashed" },
    disabled[1]!,
    { ...disabled[2]!, updatedAt: "2026-10-23T00:00:00.000Z" },
  ]);
  await expect.element(pluginHeading("Notes")).toBeInTheDocument();
});

it("says so when the selected plugin is removed elsewhere, without showing its old details", async () => {
  setup(lineup());
  await using _screen = await renderWide();

  await press(page.getByRole("button", { name: "Select Notes" }));
  await expect.element(pluginHeading("Notes")).toBeInTheDocument();
  const [board, lens] = lineup();
  await pushCatalogue([board!, lens!]);

  await expect
    .element(page.getByText("This plugin is no longer installed on Workstation."))
    .toBeInTheDocument();
  expect(pluginHeading("Notes").query()).toBeNull();
  expect(callsTo(":set-enabled")).toEqual([]);
});

it("acts only on the environment Settings selected, and starts fresh on another", async () => {
  const [board, lens, notes] = lineup();
  setup([configurable({ installationId: "inst-board-2" }), lens!], {
    environmentIds: ["env-1", "env-2", "env-3"],
    selected: "env-2",
    catalogues: { "env-1": [board!], "env-3": [notes!] },
  });
  await using screen = await renderWide();

  expect(rowNames()).toEqual(["Select Workflow Board", "Select Repository Lens"]);
  await press(page.getByRole("button", { name: "Select Repository Lens" }));
  await press(page.getByRole("switch", { name: "Enable Repository Lens" }));
  await vi.waitFor(() =>
    expect(callsWithEnvironment(":set-enabled")).toEqual([
      { environmentId: "env-2", input: { installationId: "inst-lens", enabled: false } },
    ]),
  );

  await press(page.getByRole("button", { name: "Install plugin" }).first());
  await expect.element(page.getByText("Install plugin on Machine 2")).toBeInTheDocument();
  await userEvent.fill(page.getByRole("textbox", { name: "Source" }), "/plugins/board");
  await press(page.getByRole("button", { name: "Install and review" }));
  await vi.waitFor(() =>
    expect(callsWithEnvironment(":install")).toEqual([
      expect.objectContaining({ environmentId: "env-2" }),
    ]),
  );
  await press(page.getByRole("button", { name: "Not now" }));

  // The Settings scope menu picks another environment.
  state.selected = "env-3";
  await screen.rerender(settings());
  expect(rowNames()).toEqual(["Select Notes"]);
  await expect.element(pluginHeading("Notes")).toBeInTheDocument();
  expect(pluginHeading("Repository Lens").query()).toBeNull();
});

it("opens the plugin a link names, but only on that environment", async () => {
  setup(lineup(), { environmentIds: ["env-1", "env-2"], selected: "env-1" });
  await using screen = await renderWide(
    settings({ environmentId: EnvironmentId.make("env-1"), installationId: "inst-notes" }),
  );
  await expect.element(pluginHeading("Notes")).toBeInTheDocument();

  await screen.rerender(
    settings({ environmentId: EnvironmentId.make("env-2"), installationId: "inst-lens" }),
  );
  await expect.element(pluginHeading("Workflow Board")).toBeInTheDocument();
});

it("drills into one plugin on a narrow screen and returns focus to its row", async () => {
  setup(lineup());
  await using _screen = await renderNarrow();

  await expect.element(page.getByRole("button", { name: "Select Notes" })).toBeVisible();
  expect(pluginHeading("Workflow Board").query()).toBeNull();
  await press(page.getByRole("button", { name: "Select Notes" }));
  await expect.element(pluginHeading("Notes")).toHaveFocus();
  expect(page.getByRole("button", { name: "Select Notes" }).query()).toBeNull();

  await press(page.getByRole("button", { name: "All plugins on Workstation" }));
  await expect.element(page.getByRole("button", { name: "Select Notes" })).toHaveFocus();
});

it("lists commands as information, with nothing to run from Settings", async () => {
  setup(
    installationFixture({
      enabled: true,
      consentedDigest: DIGEST,
      status: "idle",
      grants: { capabilities: ["ui"], projectIds: [] },
      manifest: {
        ...installationFixture({}).manifest,
        actions: [
          {
            id: "summarize",
            title: "Summarize thread",
            placements: ["thread-menu"],
            agentCallable: true,
          },
        ],
        views: [{ id: "board", title: "Board", entry: "board.html", placement: "page" }],
      },
    }),
  );
  await using _screen = await renderWide();

  await expect.element(page.getByRole("button", { name: "Open Board" })).toBeEnabled();
  expect(page.getByRole("button", { name: /^Run/ }).query()).toBeNull();
  await press(page.getByRole("button", { name: "Commands it adds (1)" }));
  await expect.element(page.getByText("Thread menu · Agents can call it")).toBeInTheDocument();
  expect(page.getByRole("button", { name: /^Run/ }).query()).toBeNull();
});

it("installs on the environment Settings selected and says which one", async () => {
  setup(null, {
    environmentIds: ["env-1", "env-2", "env-3"],
    selected: "env-3",
    installResult: installationFixture({}),
  });
  await using _screen = await renderWide();

  await press(page.getByRole("button", { name: "Install plugin" }));
  await expect.element(page.getByText("Install plugin on Machine 3")).toBeInTheDocument();
  await userEvent.fill(page.getByRole("textbox", { name: "Source" }), "/plugins/board");
  await press(page.getByRole("button", { name: "Install and review" }));

  await vi.waitFor(() =>
    expect(callsWithEnvironment(":install")).toEqual([
      expect.objectContaining({ environmentId: "env-3" }),
    ]),
  );
});

it("disables Install when the selected environment does not allow it", async () => {
  setup(null, { environmentIds: ["env-1", "env-2"], selected: "env-2", installDenied: ["env-2"] });
  await using _screen = await renderWide();

  await expect.element(page.getByRole("button", { name: "Install plugin" })).toBeDisabled();
});

it("disables Install when the selected environment's plugin API is not one this client renders", async () => {
  setup(null, { apiVersions: { "env-1": 2 } });
  await using _screen = await renderWide();

  await expect.element(page.getByRole("button", { name: "Install plugin" })).toBeDisabled();
});

it("stops standing in the install result once the catalogue has listed and then dropped it", async () => {
  setup(null, { installResult: installationFixture({}) });
  await using _screen = await renderWide();

  await press(page.getByRole("button", { name: "Install plugin" }));
  await userEvent.fill(page.getByRole("textbox", { name: "Source" }), "/plugins/board");
  await press(page.getByRole("button", { name: "Install and review" }));
  // The install result arrives before the catalogue push that lists it.
  const approve = page.getByRole("button", { name: "Approve and enable" });
  await expect.element(approve).toBeInTheDocument();

  await pushCatalogue(installationFixture({}));
  await expect.element(approve).toBeInTheDocument();

  // Removed from another device while the review is open.
  await pushCatalogue(null);
  await expect.element(page.getByText("This plugin is no longer installed.")).toBeInTheDocument();
  expect(approve.query()).toBeNull();
});

const ready = (overrides: Partial<PluginInstallation> = {}) =>
  installationFixture({
    enabled: true,
    consentedDigest: DIGEST,
    status: "idle",
    grants: { capabilities: ["ui"], projectIds: [] },
    ...overrides,
  });
const PREVIOUS_DIGEST = "c".repeat(64);

it("asks before delivering runs missed while disabled, and passes the choice on", async () => {
  setup(ready({ enabled: false, status: "disabled" }), {
    recovery: true,
    results: {
      ":backlog": { count: 3, afterSequence: 10, throughSequence: 42, requiresChoice: true },
    },
  });
  await using _screen = await renderWide();

  await press(page.getByRole("switch", { name: "Enable Workflow Board" }));
  await expect.element(page.getByText("Workflow Board missed 3 runs")).toBeInTheDocument();
  expect(callsTo(":set-enabled")).toEqual([]);
  await press(page.getByRole("button", { name: "Skip missed runs" }));

  await vi.waitFor(() =>
    expect(callsTo(":set-enabled")).toEqual([
      {
        installationId: "inst-1",
        enabled: true,
        eventBacklog: { policy: "skip", throughSequence: 42 },
      },
    ]),
  );
});

it("asks about missed runs before re-approving a disabled plugin turns it on", async () => {
  setup(ready({ enabled: false, status: "disabled" }), {
    recovery: true,
    results: {
      ":backlog": { count: 2, afterSequence: 10, throughSequence: 42, requiresChoice: true },
    },
  });
  await using _screen = await renderWide();

  await press(page.getByRole("button", { name: "Review permissions" }));
  await press(page.getByRole("button", { name: "Approve and enable" }));
  await expect.element(page.getByText("Workflow Board missed 2 runs")).toBeInTheDocument();
  expect(callsTo(":consent")).toEqual([]);
  await press(page.getByRole("button", { name: "Deliver 2 runs" }));

  await vi.waitFor(() =>
    expect(callsTo(":set-enabled")).toEqual([
      {
        installationId: "inst-1",
        enabled: true,
        eventBacklog: { policy: "deliver", throughSequence: 42 },
      },
    ]),
  );
  // The plugin is off while consenting, so the server takes the choice only when it turns on.
  expect(callsTo(":consent")).toEqual([
    { installationId: "inst-1", digest: DIGEST, grants: { capabilities: ["ui"], projectIds: [] } },
  ]);
});

it("offers no restart while plugin code is off, but keeps repair and management", async () => {
  setup(ready({ status: "quarantined" }), { recovery: true, executionDisabled: true });
  await using _screen = await renderWide();

  await expect.element(page.getByText("Paused · plugin code off").first()).toBeInTheDocument();
  expect(page.getByRole("button", { name: "Restart" }).query()).toBeNull();
  await expect.element(page.getByRole("button", { name: "Repair with agent" })).toBeEnabled();
  await expect.element(page.getByRole("button", { name: "Remove…" })).toBeEnabled();
});

it("restarts a stopped plugin from its problem, not from a menu", async () => {
  setup(ready({ status: "error", error: "The worker exited." }));
  await using _screen = await renderWide();

  await expect.element(page.getByText("The worker exited.")).toBeInTheDocument();
  await press(page.getByRole("button", { name: "Restart" }));
  await vi.waitFor(() => expect(callsTo(":resume")).toEqual([{ installationId: "inst-1" }]));
});

it("sends nothing new to a server without recovery support", async () => {
  setup(ready({ enabled: false, status: "disabled" }));
  await using _screen = await renderWide();

  await press(page.getByRole("switch", { name: "Enable Workflow Board" }));
  await vi.waitFor(() =>
    expect(callsTo(":set-enabled")).toEqual([{ installationId: "inst-1", enabled: true }]),
  );
  expect(callsTo(":backlog")).toEqual([]);
  expect(page.getByRole("button", { name: "Repair with agent" }).query()).toBeNull();
});

it("keeps the user's choice visible when this host cannot run the plugin, and lets them turn it off", async () => {
  setup(
    ready({ compatibility: { available: false, missingCapabilities: ["experimental.boards"] } }),
    { recovery: true },
  );
  await using _screen = await renderWide();

  const toggle = page.getByRole("switch", { name: "Enable Workflow Board" });
  await expect.element(toggle).toBeChecked();
  await expect.element(page.getByText("Unavailable", { exact: true })).toBeInTheDocument();
  await press(toggle);
  await vi.waitFor(() =>
    expect(callsTo(":set-enabled")).toEqual([{ installationId: "inst-1", enabled: false }]),
  );
});

it("shows a record saved by a newer T3 Code as read-only, without reinstall or remove", async () => {
  setup(ready({ recordIssue: "newer", status: "error" }), { recovery: true });
  await using _screen = await renderWide();

  await expect.element(page.getByRole("switch", { name: "Enable Workflow Board" })).toBeDisabled();
  await expect
    .element(page.getByText(/Update T3 Code on this environment/).first())
    .toBeInTheDocument();
  expect(page.getByText(/reinstall/i).query()).toBeNull();
  expect(page.getByRole("button", { name: "Remove…" }).query()).toBeNull();

  // The server wraps such a record in a placeholder source and fingerprint; they are not facts.
  await press(page.getByRole("button", { name: "View details" }));
  const details = page.getByRole("dialog");
  await expect.element(details.getByText("Version", { exact: true })).toBeInTheDocument();
  expect(details.getByText("Fingerprint", { exact: true }).query()).toBeNull();
  expect(details.getByText("Source", { exact: true }).query()).toBeNull();
});

it("approves a local fix as an update: grants unchanged, a disabled plugin stays off", async () => {
  const running = ready({ enabled: false, status: "disabled" });
  setup(
    {
      ...running,
      recovery: { activeSource: "upstream" },
      pendingUpdate: {
        kind: "local-repair",
        manifest: {
          ...running.manifest,
          capabilities: ["ui", "threads.create"],
          settings: [{ key: "channel", label: "Channel", type: "string" }],
        },
        source: { kind: "local", directory: "/t3/plugins/workspaces/inst-1/1" },
        digest: PENDING_DIGEST,
        generation: "gen-2",
        updatedAt: "2026-10-23T00:00:00.000Z",
      },
    },
    { recovery: true },
  );
  await using _screen = await renderWide();

  await press(page.getByRole("button", { name: "Review local fix" }));
  await expect.element(page.getByText("Channel setting added")).toBeInTheDocument();
  await expect.element(page.getByRole("checkbox", { name: "Create threads" })).not.toBeChecked();
  await press(page.getByRole("button", { name: "Use local fix" }));

  await vi.waitFor(() =>
    expect(callsTo(":consent")).toEqual([
      {
        installationId: "inst-1",
        digest: PENDING_DIGEST,
        grants: { capabilities: ["ui"], projectIds: [] },
      },
    ]),
  );
  expect(callsTo(":set-enabled")).toEqual([]);
});

it("stages the kept previous version only after the current-data warning", async () => {
  setup(
    ready({
      recovery: {
        activeSource: "upstream",
        previous: {
          version: "0.9.0",
          digest: PREVIOUS_DIGEST,
          source: { kind: "local", directory: "/plugins/board" },
        },
      },
    }),
    { recovery: true },
  );
  await using _screen = await renderWide();

  await press(page.getByRole("button", { name: "Use previous version (v0.9.0)…" }));
  await expect
    .element(page.getByText(/T3 Code can.t undo that or anything either version did/))
    .toBeInTheDocument();
  expect(callsTo(":use-previous")).toEqual([]);
  await press(page.getByRole("button", { name: "Continue to review" }));

  await vi.waitFor(() =>
    expect(callsTo(":use-previous")).toEqual([
      { installationId: "inst-1", expectedDigest: PREVIOUS_DIGEST, acknowledgeCurrentData: true },
    ]),
  );
});

it("removes the selected plugin with its data only when asked, then shows the next one", async () => {
  const [board, lens] = lineup();
  setup([board!, lens!]);
  await using _screen = await renderWide();

  await press(page.getByRole("button", { name: "Select Repository Lens" }));
  await press(page.getByRole("button", { name: "Remove…" }));
  await press(page.getByRole("checkbox", { name: "Also delete its settings and stored data" }));
  await press(page.getByRole("button", { name: "Remove", exact: true }));
  await vi.waitFor(() =>
    expect(callsTo(":remove")).toEqual([{ installationId: "inst-lens", deleteData: true }]),
  );
  await pushCatalogue([board!]);
  await expect.element(pluginHeading("Workflow Board")).toBeInTheDocument();
});

it("keeps an unsaved value when the host stamps a new generation of the same files", async () => {
  const lens = installationFixture({
    installationId: "inst-2",
    manifest: { ...installationFixture({}).manifest, id: "examples.lens", name: "Lens" },
  });
  setup([configurable(), lens]);
  await using _screen = await renderWide();

  const label = page.getByRole("textbox", { name: "Board label" });
  await userEvent.fill(label, "Sprint board");
  // Turning a plugin off, on another device or with the switch beside the form, records a new
  // generation of the same approved files.
  await pushCatalogue([
    configurable({ generation: "gen-2", enabled: false, status: "disabled" }),
    lens,
  ]);
  await expect.element(label).toHaveValue("Sprint board");
  await expect.element(page.getByText("Unsaved changes")).toBeInTheDocument();

  using confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await press(page.getByRole("button", { name: "Select Lens" }));
  expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to Workflow Board settings?");
  await expect.element(label).toHaveValue("Sprint board");
});

it("asks before an install replaces unsaved settings, from either Install button", async () => {
  setup(configurable(), {
    environmentIds: ["env-1", "env-2"],
    selected: "env-2",
    installResult: installationFixture({ installationId: "inst-new" }),
  });
  await using _screen = await renderWide();

  const label = page.getByRole("textbox", { name: "Board label" });
  await userEvent.fill(label, "Sprint board");
  using confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const [header, listRow] = page.getByRole("button", { name: "Install plugin" }).elements();
  await act(() => (header as HTMLElement).click());
  expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to Workflow Board settings?");
  expect(page.getByRole("dialog").query()).toBeNull();
  await expect.element(label).toHaveValue("Sprint board");

  confirm.mockClear();
  await act(() => (listRow as HTMLElement).click());
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(page.getByRole("dialog").query()).toBeNull();

  confirm.mockReturnValue(true);
  await act(() => (listRow as HTMLElement).click());
  await expect.element(page.getByText("Install plugin on Machine 2")).toBeInTheDocument();
  await userEvent.fill(page.getByRole("textbox", { name: "Source" }), "/plugins/board");
  await press(page.getByRole("button", { name: "Install and review" }));
  await expect
    .element(page.getByRole("button", { name: "Approve and enable" }))
    .toBeInTheDocument();
  expect(callsWithEnvironment(":install")).toEqual([
    expect.objectContaining({ environmentId: "env-2" }),
  ]);
});

it("returns focus to the list when the plugin left behind is filtered out", async () => {
  const [board, lens, notes] = lineup();
  const crashed = { status: "error" as const, error: "Crashed" };
  setup([{ ...board!, ...crashed }, lens!, { ...notes!, ...crashed }]);
  await using _screen = await renderNarrow();

  await press(page.getByRole("button", { name: "Needs attention (2)" }));
  await press(page.getByRole("button", { name: "Select Notes" }));
  await expect.element(pluginHeading("Notes")).toHaveFocus();
  // Fixed elsewhere while it is open, so the attention filter no longer lists it.
  await pushCatalogue([{ ...board!, ...crashed }, lens!, notes!]);

  await press(page.getByRole("button", { name: "All plugins on Workstation" }));
  expect(page.getByRole("button", { name: "Select Notes" }).query()).toBeNull();
  await expect.element(page.getByRole("searchbox", { name: "Search plugins" })).toHaveFocus();
});

/** Mounted on browser history, the kind the app uses, which is what answers a page unload. */
async function renderOnBrowserHistory() {
  const history = createBrowserHistory();
  const router = createRouter({
    routeTree: createRootRoute({ component: () => settings() }),
    history,
  });
  // The shared test router uses memory history, which never sees an unload.
  const screen = await render(<RouterProvider router={router} />, {
    router: false,
    container: sized(1100),
  });
  return {
    router,
    [Symbol.asyncDispose]: async () => {
      await screen[Symbol.asyncDispose]();
      history.destroy();
    },
  };
}
const unloadPrevented = () => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
async function editBoardLabel() {
  await userEvent.fill(page.getByRole("textbox", { name: "Board label" }), "Sprint board");
  await expect.element(page.getByText("Unsaved changes")).toBeInTheDocument();
  // Commits the page's leave guard for the edit.
  await act(() => {});
}

it("asks the browser to confirm leaving with unsaved settings", async () => {
  setup(configurable());
  await using _screen = await renderOnBrowserHistory();

  await expect.element(page.getByRole("textbox", { name: "Board label" })).toBeInTheDocument();
  expect(unloadPrevented()).toBe(false);
  await editBoardLabel();
  expect(unloadPrevented()).toBe(true);
});

it("keeps a new form guarded when an earlier discarded form finishes saving", async () => {
  const lens = installationFixture({
    installationId: "inst-2",
    manifest: { ...installationFixture({}).manifest, id: "examples.lens", name: "Lens" },
  });
  setup([configurable(), lens]);
  let finishSave!: (installation: PluginInstallation) => void;
  state.results[":update-settings"] = new Promise<PluginInstallation>((resolve) => {
    finishSave = resolve;
  });
  await using _screen = await renderWide();
  using confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  await userEvent.fill(page.getByRole("textbox", { name: "Board label" }), "Earlier edit");
  await press(page.getByRole("button", { name: "Save" }));
  await expect.element(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await press(page.getByRole("button", { name: "Select Lens" }));
  await press(page.getByRole("button", { name: "Select Workflow Board" }));
  await userEvent.fill(page.getByRole("textbox", { name: "Board label" }), "Current edit");
  await act(async () => finishSave(configurable({ settings: { label: "Earlier edit" } })));
  confirm.mockClear();
  confirm.mockReturnValue(false);
  await press(page.getByRole("button", { name: "Select Lens" }));
  expect(confirm).toHaveBeenCalledWith("Discard unsaved changes to Workflow Board settings?");
  await expect
    .element(page.getByRole("textbox", { name: "Board label" }))
    .toHaveValue("Current edit");
});
