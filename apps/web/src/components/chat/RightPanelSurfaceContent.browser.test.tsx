import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type PluginInstallation,
  type PluginInvokeResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  html: "",
  installation: null as PluginInstallation | null,
  contexts: [] as Array<{ name: string; threadId: unknown }>,
  answer: (_name: string): Promise<PluginInvokeResult> => Promise.resolve({}),
  shell: { status: "live", missingThreadIds: new Set<string>() },
  shellListeners: new Set<() => void>(),
  previews: [] as unknown[],
}));

vi.mock(import("../../state/plugins"), async (original) => ({
  ...(await original()),
  usePluginCatalogue: () => ({
    availability: "available" as const,
    installations: state.installation ? [state.installation] : [],
    loaded: true,
    error: null,
  }),
}));
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const actual = await original();
  const { pluginEnvironment } = await import("../../state/plugins");
  return {
    ...actual,
    useAtomCommand: ((command: { label: string }) =>
      async (request: { input: { handler?: string; context?: { threadId?: unknown } } }) => {
        if (command.label === pluginEnvironment.readView.label) {
          return AsyncResult.success({ html: state.html });
        }
        const name = request.input.handler?.split(":").at(-1) ?? "";
        state.contexts.push({ name, threadId: request.input.context?.threadId });
        return AsyncResult.success(await state.answer(name));
      }) as never,
  };
});
vi.mock(import("../../state/shell"), async (original) => {
  const actual = await original();
  const { useSyncExternalStore } = await import("react");
  return {
    ...actual,
    // Subscribed like the real shell, so a change reaches memoized components.
    useEnvironmentShellStatus: (() =>
      useSyncExternalStore(
        (listener) => {
          state.shellListeners.add(listener);
          return () => state.shellListeners.delete(listener);
        },
        () => state.shell,
      ).status) as never,
  };
});
vi.mock(import("../../state/entities"), async (original) => {
  const actual = await original();
  const { useSyncExternalStore } = await import("react");
  const useShell = (ref: ScopedThreadRef | null) => {
    const { missingThreadIds } = useSyncExternalStore(
      (listener) => {
        state.shellListeners.add(listener);
        return () => state.shellListeners.delete(listener);
      },
      () => state.shell,
    );
    return ref === null || missingThreadIds.has(ref.threadId) ? null : { projectId: "project" };
  };
  return { ...actual, useQuietThreadShell: useShell as never, useThreadShell: useShell as never };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../browser/previewRuntime"), async (original) => ({
  ...(await original()),
  isPreviewAvailableFor: () => true,
}));
vi.mock(import("../../browser/openFileInPreview"), async (original) => ({
  ...(await original()),
  openUrlInPreview: (async (input: { threadRef: ScopedThreadRef }) => {
    state.previews.push(input.threadRef);
    return AsyncResult.success(undefined);
  }) as never,
}));
vi.mock("./SideChatPane", () => ({ default: () => null }));

import { useComposerDraftStore } from "../../composerDraftStore";
import { hostRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { usePluginActionRunner } from "../plugins/usePluginActions";
import { RightPanelSurfaceContent } from "./RightPanelSurfaceContent";

const environmentId = EnvironmentId.make("environment");
const parent = scopeThreadRef(environmentId, ThreadId.make("parent"));
const sideChat = scopeThreadRef(environmentId, ThreadId.make("side-chat"));
const deletedNotice = "This side chat was deleted.";
const legacyView = {
  id: "plugin:inst:notes",
  kind: "plugin",
  installationId: "inst",
  viewId: "notes",
  title: "Notes",
} as const;
const sideChatView = {
  ...legacyView,
  id: `plugin:inst:notes:${sideChat.threadId}`,
  originThreadId: sideChat.threadId,
} as const;

function setup(answer: (name: string) => Promise<PluginInvokeResult>) {
  const digest = "a".repeat(64);
  state.html = `<script>t3.invoke("act");</script>`;
  state.contexts = [];
  state.previews = [];
  state.answer = answer;
  state.shell = { status: "live", missingThreadIds: new Set() };
  state.installation = {
    installationId: "inst",
    generation: "gen-1",
    manifest: {
      id: "examples.notes",
      name: "Notes",
      version: "1.0.0",
      apiVersion: 1,
      entry: "plugin.mjs",
      capabilities: ["ui"],
      actions: [],
      views: [
        { id: "notes", title: "Notes", entry: "notes.html", placement: "side-panel" },
        { id: "second", title: "Second", entry: "second.html", placement: "side-panel" },
      ],
      settings: [],
    },
    source: { kind: "local", directory: "/plugins/notes" },
    digest,
    enabled: true,
    consentedDigest: digest,
    status: "idle",
    error: null,
    settings: {},
    grants: { capabilities: ["ui"], projectIds: [] },
    updatedAt: "2026-10-22T00:00:00.000Z",
  };
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  for (const ref of [parent, sideChat]) useComposerDraftStore.getState().setPrompt(ref, "");
}

const changeShell = (shell: typeof state.shell) =>
  act(() => {
    state.shell = shell;
    for (const listener of state.shellListeners) listener();
  });

const panel = (surface: Parameters<typeof RightPanelSurfaceContent>[0]["surface"]) => (
  <RightPanelSurfaceContent
    surface={surface}
    activeSurfaceId={surface?.id ?? null}
    threadRef={parent}
    environmentId={environmentId}
    visible
    composerDraftTarget={parent}
    keybindings={[]}
    configuredPreviewUrls={[]}
    workspaceMutationId={null}
    getShortcutContext={() => ({}) as never}
    onSendAnnotation={() => {}}
    onCloseSurface={() => {}}
    terminal={{} as never}
    pullRequest={{} as never}
    files={{} as never}
    sideChatParentPanel={{} as never}
  />
);

const surfaces = (ref: ScopedThreadRef) =>
  useRightPanelStore.getState().byThreadKey[scopedThreadKey(ref)]?.surfaces;
const prompt = (ref: ScopedThreadRef) =>
  useComposerDraftStore.getState().getComposerDraft(ref)?.prompt ?? "";
const frames = () => document.querySelectorAll("iframe").length;

it("keeps a side chat's view on that conversation, in the panel that shows it", async () => {
  setup(async () => ({
    intents: [
      { type: "composer.insert", text: "from the view" },
      { type: "view.open", viewId: "second" },
    ],
  }));
  // Showing the view unmounted the side chat's pane, so its host registration is gone.
  await using _screen = await render(panel(sideChatView), { router: "/environment/parent" });
  await vi.waitFor(() => expect(surfaces(parent)).toHaveLength(1));
  expect(state.contexts).toEqual([{ name: "act", threadId: sideChat.threadId }]);
  expect(surfaces(parent)).toEqual([
    {
      id: `plugin:inst:second:${sideChat.threadId}`,
      kind: "plugin",
      installationId: "inst",
      viewId: "second",
      title: "Second",
      originThreadId: sideChat.threadId,
    },
  ]);
  expect(surfaces(sideChat)).toBeUndefined();
  expect(prompt(sideChat)).toBe("from the view");
  expect(prompt(parent)).toBe("");
});

it("opens a side chat view's link in the panel that shows it", async () => {
  setup(async () => ({ intents: [{ type: "preview.open", url: "https://example.com/" }] }));
  await using _screen = await render(panel(sideChatView), { router: "/environment/parent" });
  await vi.waitFor(() => expect(state.previews).toEqual([parent]));
});

it("leaves a stored view without an origin on the panel's own thread", async () => {
  setup(async () => ({
    intents: [
      { type: "composer.insert", text: "from the view" },
      { type: "view.open", viewId: "second" },
    ],
  }));
  await using _screen = await render(panel(legacyView), { router: "/environment/parent" });
  await vi.waitFor(() => expect(surfaces(parent)).toHaveLength(1));
  expect(state.contexts).toEqual([{ name: "act", threadId: parent.threadId }]);
  expect(surfaces(parent)).toEqual([
    {
      id: "plugin:inst:second",
      kind: "plugin",
      installationId: "inst",
      viewId: "second",
      title: "Second",
    },
  ]);
  expect(prompt(parent)).toBe("from the view");
});

it("holds a side chat's view until a live shell has the conversation, without retiring it", async () => {
  setup(async () => ({}));
  state.shell = { status: "synchronizing", missingThreadIds: new Set([sideChat.threadId]) };
  await using _screen = await render(panel(sideChatView), { router: "/environment/parent" });
  await expect.element(page.getByLabelText("Side chat loading")).toBeInTheDocument();
  expect(frames()).toBe(0);
  expect(page.getByText(deletedNotice).query()).toBeNull();

  await changeShell({ status: "live", missingThreadIds: new Set() });
  await vi.waitFor(() => expect(state.contexts).toHaveLength(1));
  expect(page.getByText(deletedNotice).query()).toBeNull();
});

it("retires a view whose side chat was deleted, dropping its late insert", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  setup(async () => {
    await held;
    return { intents: [{ type: "composer.insert", text: "too late" }] };
  });
  await using _screen = await render(panel(sideChatView), { router: "/environment/parent" });
  await vi.waitFor(() => expect(state.contexts).toHaveLength(1));

  await changeShell({ status: "live", missingThreadIds: new Set([sideChat.threadId]) });
  await expect.element(page.getByText(deletedNotice)).toBeVisible();
  expect(frames()).toBe(0);
  await act(async () => {
    release();
    await held;
  });
  expect(prompt(sideChat)).toBe("");
});

it("keeps an action's panel when the side chat pane leaves before its answer", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  setup(async () => {
    await held;
    return { intents: [{ type: "view.open", viewId: "second" }] };
  });
  function RunAction() {
    const run = usePluginActionRunner();
    return (
      <button
        onClick={() =>
          void run(
            {
              environmentId,
              installation: state.installation!,
              threadRef: sideChat,
              composerTarget: sideChat,
              locationKey: "/environment/parent",
            },
            { id: "review", title: "Review", placements: ["message-selection"] },
            { threadId: sideChat.threadId },
          )
        }
      >
        Run
      </button>
    );
  }
  await using _screen = await render(<RunAction />, { router: "/environment/parent" });
  const unhost = hostRightPanel(sideChat, parent);
  await userEvent.click(page.getByRole("button", { name: "Run" }));
  await vi.waitFor(() => expect(state.contexts).toHaveLength(1));
  unhost();
  release();
  await vi.waitFor(() => expect(surfaces(parent)).toHaveLength(1));
  expect(surfaces(sideChat)).toBeUndefined();
});
