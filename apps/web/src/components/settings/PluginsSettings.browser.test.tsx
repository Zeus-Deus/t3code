import { RegistryProvider } from "@effect/atom-react";
import { EnvironmentId, ProjectId, type PluginInstallation } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  installation: null as PluginInstallation | null,
  calls: [] as Array<{ label: string; environmentId: string; input: unknown }>,
  /** Connected environments in settings order; one environment scopes the page to it. */
  environmentIds: ["env-1"] as string[],
  /** Environments whose session lacks the install scopes. */
  installDenied: [] as string[],
  /** Advertised plugin API per environment; unlisted ones speak the current one. */
  apiVersions: {} as Record<string, number | undefined>,
  /** What install returns, when the catalogue does not list it yet. */
  installResult: null as PluginInstallation | null,
  /** The server advertises repair, previous-version and missed-event requests. */
  recovery: false,
  executionDisabled: false,
  /** Results for commands whose label contains the key, instead of the installation. */
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
    usePluginCatalogue: () => {
      const installation = useSyncExternalStore(subscribe, () => state.installation);
      return {
        availability: "available" as const,
        installations: installation ? [installation] : [],
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
      return AsyncResult.success(result ? result[1] : (state.installResult ?? state.installation));
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
    return {
      scope: { kind: environments.length === 1 ? "environment" : "all" },
      environment: environments.length === 1 ? environments[0] : null,
      environments,
      connectedEnvironments: environments,
    };
  }) as never,
}));
// The real layout reads settings scope overrides and search targets; this suite is about plugins.
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
  SettingsSection: (({
    children,
    headerAction,
  }: {
    children: ReactNode;
    headerAction?: ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  )) as never,
  SettingsRow: (({ title, status, control, children }: Record<string, ReactNode>) => (
    <div>
      <h3>{title}</h3>
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
  installation: PluginInstallation | null,
  options: {
    environmentIds?: string[];
    installDenied?: string[];
    apiVersions?: Record<string, number | undefined>;
    installResult?: PluginInstallation;
    recovery?: boolean;
    executionDisabled?: boolean;
    results?: Record<string, unknown>;
  } = {},
) {
  state.installation = installation;
  state.calls = [];
  state.environmentIds = options.environmentIds ?? ["env-1"];
  state.installDenied = options.installDenied ?? [];
  state.apiVersions = options.apiVersions ?? {};
  state.installResult = options.installResult ?? null;
  state.recovery = options.recovery ?? false;
  state.executionDisabled = options.executionDisabled ?? false;
  state.results = options.results ?? {};
  state.catalogueListeners.clear();
}

/** A catalogue push from the environment, such as another device installing or removing. */
const pushCatalogue = (installation: PluginInstallation | null) =>
  act(() => {
    state.installation = installation;
    for (const listener of state.catalogueListeners) listener();
  });

const settings = () => (
  <RegistryProvider>
    <PluginsSettings />
  </RegistryProvider>
);
// Base UI dialogs mark the page behind them inert, which blocks pointer clicks in tests; the
// locator still finds each control by its accessible role and name.
const press = (locator: ReturnType<typeof page.getByRole>) =>
  act(() => (locator.element() as HTMLElement).click());
const callsTo = (fragment: string) =>
  state.calls.filter((call) => call.label.includes(fragment)).map((call) => call.input);

it("approves the reviewed digest with exactly the permissions and projects left on", async () => {
  setup(installationFixture({}));
  await using _screen = await render(settings(), { router: "/settings/plugins" });

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
  await using _screen = await render(settings(), { router: "/settings/plugins" });

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
  await using _screen = await render(settings(), { router: "/settings/plugins" });

  await press(page.getByRole("button", { name: "Review update" }));
  await press(page.getByRole("button", { name: "Discard update" }));

  await vi.waitFor(() =>
    expect(callsTo(":discard-pending-update")).toEqual([{ installationId: "inst-1" }]),
  );
  expect(callsTo(":consent")).toEqual([]);
});

it("names setting switches and sends only the settings the user changed", async () => {
  setup(
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
    }),
  );
  await using _screen = await render(settings(), { router: "/settings/plugins" });

  await press(page.getByRole("button", { name: "Actions for Workflow Board" }));
  await press(page.getByRole("menuitem", { name: "Settings" }));
  const autoFollowup = page.getByRole("switch", { name: "Request a review automatically" });
  await expect.element(autoFollowup).not.toBeChecked();
  await press(autoFollowup);
  await press(page.getByRole("button", { name: "Save" }));

  await vi.waitFor(() =>
    expect(callsTo(":update-settings")).toEqual([
      { installationId: "inst-1", values: { autoFollowup: true } },
    ]),
  );
});

it("installs on an environment that allows it when the first one does not", async () => {
  setup(installationFixture({}), {
    environmentIds: ["env-1", "env-2", "env-3"],
    installDenied: ["env-1"],
  });
  await using _screen = await render(settings(), { router: "/settings/plugins" });

  await press(page.getByRole("button", { name: "Install plugin" }));
  await expect
    .element(page.getByRole("combobox", { name: "Environment" }))
    .toHaveTextContent("Machine 2");
  await userEvent.fill(page.getByRole("textbox", { name: "Source" }), "/plugins/board");
  await press(page.getByRole("button", { name: "Install and review" }));

  await vi.waitFor(() =>
    expect(state.calls.filter((call) => call.label.includes(":install"))).toEqual([
      expect.objectContaining({ environmentId: "env-2" }),
    ]),
  );
});

it("disables Install when no environment allows it", async () => {
  setup(null, { environmentIds: ["env-1", "env-2"], installDenied: ["env-1", "env-2"] });
  await using _screen = await render(settings(), { router: "/settings/plugins" });

  await expect.element(page.getByRole("button", { name: "Install plugin" })).toBeDisabled();
});

it("skips permitted environments whose plugin API this client does not render", async () => {
  setup(null, {
    environmentIds: ["env-1", "env-2", "env-3"],
    // A newer server, then one without plugins.
    apiVersions: { "env-1": 2, "env-2": undefined },
  });
  await using _screen = await render(settings(), { router: "/settings/plugins" });

  await press(page.getByRole("button", { name: "Install plugin" }));
  await expect
    .element(page.getByRole("combobox", { name: "Environment" }))
    .toHaveTextContent("Machine 3");
});

it("disables Install when no permitted environment supports plugins", async () => {
  setup(null, {
    environmentIds: ["env-1", "env-2"],
    apiVersions: { "env-1": 2, "env-2": undefined },
  });
  await using _screen = await render(settings(), { router: "/settings/plugins" });

  await expect.element(page.getByRole("button", { name: "Install plugin" })).toBeDisabled();
});

it("stops standing in the install result once the catalogue has listed and then dropped it", async () => {
  setup(null, { installResult: installationFixture({}) });
  await using _screen = await render(settings(), { router: "/settings/plugins" });

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
  await using _screen = await render(settings(), { router: "/settings/plugins" });

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
  await using _screen = await render(settings(), { router: "/settings/plugins" });

  await press(page.getByRole("button", { name: "Actions for Workflow Board" }));
  await press(page.getByRole("menuitem", { name: "Review permissions" }));
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
  await using _screen = await render(settings(), { router: "/settings/plugins" });

  await expect.element(page.getByText("Paused · plugin code off")).toBeInTheDocument();
  expect(page.getByRole("button", { name: "Restart" }).query()).toBeNull();
  await press(page.getByRole("button", { name: "Actions for Workflow Board" }));
  await expect.element(page.getByRole("menuitem", { name: "Repair with agent" })).toBeEnabled();
  await expect.element(page.getByRole("menuitem", { name: "Remove" })).toBeEnabled();
});

it("sends nothing new to a server without recovery support", async () => {
  setup(ready({ enabled: false, status: "disabled" }));
  await using _screen = await render(settings(), { router: "/settings/plugins" });

  await press(page.getByRole("switch", { name: "Enable Workflow Board" }));
  await vi.waitFor(() =>
    expect(callsTo(":set-enabled")).toEqual([{ installationId: "inst-1", enabled: true }]),
  );
  expect(callsTo(":backlog")).toEqual([]);
  await press(page.getByRole("button", { name: "Actions for Workflow Board" }));
  expect(page.getByRole("menuitem", { name: "Repair with agent" }).query()).toBeNull();
});

it("keeps the user's choice visible when this host cannot run the plugin, and lets them turn it off", async () => {
  setup(
    ready({ compatibility: { available: false, missingCapabilities: ["experimental.boards"] } }),
    { recovery: true },
  );
  await using _screen = await render(settings(), { router: "/settings/plugins" });

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
  await using _screen = await render(settings(), { router: "/settings/plugins" });

  await expect.element(page.getByRole("switch", { name: "Enable Workflow Board" })).toBeDisabled();
  await expect.element(page.getByText(/Update T3 Code on this environment/)).toBeInTheDocument();
  expect(page.getByText(/reinstall/i).query()).toBeNull();
  await press(page.getByRole("button", { name: "Actions for Workflow Board" }));
  await expect.element(page.getByRole("menuitem", { name: "Details" })).toBeInTheDocument();
  expect(page.getByRole("menuitem", { name: "Remove" }).query()).toBeNull();

  // The server wraps such a record in a placeholder source and fingerprint; they are not facts.
  await press(page.getByRole("menuitem", { name: "Details" }));
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
  await using _screen = await render(settings(), { router: "/settings/plugins" });

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
  await using _screen = await render(settings(), { router: "/settings/plugins" });

  await press(page.getByRole("button", { name: "Actions for Workflow Board" }));
  await press(page.getByRole("menuitem", { name: "Use previous version (v0.9.0)…" }));
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
