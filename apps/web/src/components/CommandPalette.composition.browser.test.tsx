import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, render } from "../../test/render";
import { CommandPalette } from "./CommandPalette";
import { toastManager } from "./ui/toast";
import { openCommandPalette } from "../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../state/server";

const state = vi.hoisted(() => ({
  projects: [] as unknown[],
  command: (): Promise<unknown> => Promise.resolve({ _tag: "Success", value: undefined }),
}));

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) =>
    atom === primaryServerKeybindingsAtom ? DEFAULT_RESOLVED_KEYBINDINGS : [],
}));
vi.mock("./plugins/usePluginPaletteItems", () => ({
  usePluginPaletteItems: () => [],
  useSidebarViewPaletteItems: () => [],
  useWallpaperPaletteItems: () => [],
}));
vi.mock("../hooks/useTheme", () => ({
  useRenderedAppearance: () => "light",
  useTheme: () => ({ theme: "t3-chat", resolvedTheme: "light", appearanceMode: "light" }),
}));
vi.mock("../hooks/useCustomThemes", () => ({ useCustomThemes: () => [] }));
vi.mock("../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeDefinitions: () => [] }));
vi.mock("../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../hooks/useSettings")>()),
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
}));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchEnvironmentId: () => null }),
}));
vi.mock("../hooks/useNewProject", () => ({ useNewProject: () => async () => undefined }));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: async () => undefined,
  }),
  useNewThreadHandler: () => async () => undefined,
}));
vi.mock("../hooks/useOpenPanelPullRequestUrl", () => ({ useOpenPanelPullRequestUrl: () => null }));
vi.mock("../connection/useDesktopLocalBootstraps", () => ({ useDesktopLocalBootstraps: () => [] }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => () => state.command(),
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "local",
        label: "Local",
        connection: { phase: "connected" },
        entry: { target: { _tag: "PrimaryConnectionTarget" } },
        serverConfig: {
          environment: { platform: { os: "linux" }, capabilities: { projectCloneTracking: true } },
          settings: { addProjectBaseDirectory: "/workspace/" },
        },
      },
    ],
  }),
  usePrimaryEnvironmentId: () => "local",
  useEnvironmentProviders: () => new Map(),
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => state.projects,
  useThreadShells: () => [],
  useServerConfigs: () => new Map(),
  waitForProject: async () => undefined,
}));
vi.mock("../state/queries", async (original) => ({
  ...(await original<typeof import("../state/queries")>()),
  useThreadSearch: (_environmentIds: unknown, query: string) => ({
    matches: [],
    query,
    isPending: false,
  }),
}));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/filesystem", async (original) => ({
  ...(await original<typeof import("../state/filesystem")>()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("../state/query", async (original) => ({
  ...(await original<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("./settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

// The real palette and Base UI input must agree that confirming composition is typing.
describe.each(["repository", "folder", "destination"] as const)("add-project %s", (step) => {
  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("keeps Enter in the input during composition: %j", async (composition) => {
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText(step === "folder" ? "Local folder" : "Git URL", { exact: true }).click();
    const input = () => page.getByRole("combobox");
    if (step === "destination") {
      await input().fill("https://example.com/team/project.git");
      await userEvent.keyboard("{Enter}");
    }
    const value = step === "repository" ? "https://example.com/team/計画.git" : "/workspace/計画";
    await input().fill(value);
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...composition,
    });
    await act(() => input().element().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    await expect.element(input()).toHaveValue(value);
    if (step === "repository") {
      await userEvent.keyboard("{Enter}");
      await expect.element(input()).toHaveValue("/workspace/計画");
    } else {
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
    }
  });
});

// The real palette: a project choice must not receive a folder whose project stayed archived.
describe("adding an archived project's folder to a project choice", () => {
  const environmentId = EnvironmentId.make("local");

  async function submitArchivedFolder() {
    let settle: (result: unknown) => void = () => {};
    const pending = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    const revival = { resolve: (result: unknown) => settle(result) };
    const choose = vi.fn();
    const unarchive = vi.fn(() => pending);
    state.command = unarchive;
    state.projects = [
      {
        environmentId,
        id: ProjectId.make("archived"),
        title: "Archived",
        workspaceRoot: "/workspace/archived",
        archivedAt: "2026-10-31T00:00:00.000Z",
      },
    ];
    await act(() =>
      openCommandPalette({ chooseProject: { environmentIds: [environmentId], choose } }),
    );
    await page.getByText("Add project", { exact: true }).click();
    await page.getByText("Local folder", { exact: true }).click();
    await page.getByRole("combobox").fill("/workspace/archived");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(unarchive).toHaveBeenCalledOnce());
    return { choose, revival };
  }

  it("delivers the project only once it is back", async () => {
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    const { choose, revival } = await submitArchivedFolder();
    expect(choose).not.toHaveBeenCalled();
    await act(() => revival.resolve({ _tag: "Success", value: undefined }));
    await vi.waitFor(() =>
      expect(choose).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        projectId: ProjectId.make("archived"),
      }),
    );
    await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
  });

  it("keeps the choice open when the project stays archived", async () => {
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    using toast = vi.spyOn(toastManager, "add");
    const { choose, revival } = await submitArchivedFolder();
    await act(() => revival.resolve(AsyncResult.failure(Cause.fail(new Error("Archive locked")))));
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Failed to unarchive project" }),
      ),
    );
    expect(choose).not.toHaveBeenCalled();
    await expect.element(page.getByRole("combobox")).toBeInTheDocument();
  });

  it("delivers nothing to a choice left while the project came back", async () => {
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    const { choose, revival } = await submitArchivedFolder();
    await userEvent.keyboard("{Escape}");
    await act(() => revival.resolve({ _tag: "Success", value: undefined }));
    await act(() => Promise.resolve());
    expect(choose).not.toHaveBeenCalled();
  });
});
