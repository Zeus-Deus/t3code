import { EnvironmentId, type PluginInstallation } from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SidebarPluginAttentionPill } from "./SidebarPluginAttentionPill";

const environmentId = EnvironmentId.make("env-1");
const state = vi.hoisted(() => ({
  installations: [] as PluginInstallation[],
  unavailableMessage: null as string | null,
  error: null as string | null,
  executionDisabled: false,
}));
vi.mock("../../state/environments", () => ({
  useConnectedEnvironmentIds: () => [environmentId],
  useEnvironment: () => ({ label: "Laptop" }),
}));
vi.mock("../../state/plugins", () => ({
  usePluginCatalogue: () => ({
    availability: "available",
    loaded: state.error === null,
    error: state.error,
    installations: state.installations,
    unavailableMessage: state.unavailableMessage,
    executionDisabled: state.executionDisabled,
    recoverySupported: true,
  }),
}));

function pluginInstallationFixture(
  overrides: Partial<PluginInstallation> = {},
): PluginInstallation {
  return {
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
      settings: [],
    },
    source: { kind: "local", directory: "/plugins/board" },
    digest: "a".repeat(64),
    enabled: true,
    consentedDigest: "a".repeat(64),
    status: "idle",
    error: null,
    settings: {},
    grants: { capabilities: ["ui"], projectIds: [] },
    updatedAt: "2026-10-22T00:00:00.000Z",
    ...overrides,
  };
}

function setup(
  installations: PluginInstallation[],
  unavailableMessage: string | null = null,
  options: { error?: string; executionDisabled?: boolean } = {},
) {
  window.localStorage.clear();
  state.installations = installations;
  state.unavailableMessage = unavailableMessage;
  state.error = options.error ?? null;
  state.executionDisabled = options.executionDisabled ?? false;
}

const failed = (since: string, overrides: Partial<PluginInstallation> = {}) =>
  pluginInstallationFixture({
    attention: { kind: "fault", message: "Cannot find module", since },
    ...overrides,
  });

describe("SidebarPluginAttentionPill", () => {
  it("groups the environment's plugins and stays dismissed until a new problem appears", async () => {
    setup([
      failed("2026-10-23T10:00:00.000Z"),
      failed("2026-10-23T10:00:00.000Z", { installationId: "inst-2" }),
    ]);
    await using screen = await render(<SidebarPluginAttentionPill />);
    await expect.element(page.getByText("2 plugins need attention")).toBeVisible();

    await page.getByRole("button", { name: "Dismiss plugin notice" }).click();
    await expect.element(page.getByText("2 plugins need attention")).not.toBeInTheDocument();

    // The same problems pushed again stay dismissed.
    state.installations = [...state.installations];
    await screen.rerender(<SidebarPluginAttentionPill />);
    expect(screen.container.textContent).toBe("");

    state.installations = [failed("2026-10-23T12:00:00.000Z"), state.installations[1]!];
    await screen.rerender(<SidebarPluginAttentionPill />);
    await expect.element(page.getByText("2 plugins need attention")).toBeVisible();
  });

  it("does not nag about a plugin the user turned off that this host cannot run", async () => {
    setup([
      pluginInstallationFixture({
        enabled: false,
        status: "disabled",
        compatibility: { available: false, missingCapabilities: ["experimental.boards"] },
      }),
    ]);
    await using screen = await render(<SidebarPluginAttentionPill />);
    expect(screen.container.textContent).toBe("");
  });

  it("leaves safe mode to the environment banner instead of listing every plugin", async () => {
    const safeMode = (installationId: string, enabled: boolean) =>
      pluginInstallationFixture({
        installationId,
        enabled,
        status: "disabled",
        attention: {
          kind: "safe-mode",
          message: "Plugin execution is disabled in safe mode.",
          since: "2026-10-23T10:00:00.000Z",
        },
      });
    setup([safeMode("a", true), safeMode("b", true), safeMode("c", false)], null, {
      executionDisabled: true,
    });
    await using screen = await render(<SidebarPluginAttentionPill />);
    expect(screen.container.textContent).toBe("");
  });

  it("reports a plugin catalogue that could not be loaded", async () => {
    setup([], null, { error: "Request timed out" });
    await using _screen = await render(<SidebarPluginAttentionPill />);
    await expect.element(page.getByText("Could not load plugins")).toBeVisible();
  });

  it("reports plugin data the environment could not open", async () => {
    setup([], "Plugin data could not be opened: database is locked");
    await using _screen = await render(<SidebarPluginAttentionPill />);
    await expect.element(page.getByText("Plugins unavailable")).toBeVisible();
  });
});
