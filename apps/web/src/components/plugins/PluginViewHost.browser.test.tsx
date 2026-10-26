import {
  EnvironmentId,
  ThreadId,
  type PluginInstallation,
  type PluginInvokeResult,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  html: "",
  installation: null as PluginInstallation | null,
  catalogueListeners: new Set<() => void>(),
  calls: [] as string[],
  generations: [] as string[],
  answer: (_name: string): Promise<PluginInvokeResult> => Promise.resolve({}),
  applied: [] as Array<{ locationKey: string; intents: unknown }>,
}));

vi.mock(import("../../state/plugins"), async (original) => {
  const actual = await original();
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.catalogueListeners.add(listener);
    return () => state.catalogueListeners.delete(listener);
  };
  return {
    ...actual,
    usePluginCatalogue: () => {
      // Subscribed like the real catalogue, so an update reaches memoized components.
      const installation = useSyncExternalStore(subscribe, () => state.installation);
      return {
        availability: "available" as const,
        installations: installation ? [installation] : [],
        loaded: true,
        error: null,
      };
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const actual = await original();
  const { pluginEnvironment } = await import("../../state/plugins");
  return {
    ...actual,
    useAtomCommand: ((command: { label: string }) =>
      async (request: { input: { handler?: string; generation: string } }) => {
        if (command.label === pluginEnvironment.readView.label) {
          return AsyncResult.success({ html: state.html });
        }
        const name = request.input.handler?.split(":").at(-1) ?? "";
        state.calls.push(name);
        state.generations.push(request.input.generation);
        return AsyncResult.success(await state.answer(name));
      }) as never,
  };
});
vi.mock(import("./usePluginActions"), async (original) => ({
  ...(await original()),
  usePluginIntentApplier: () => (target: { locationKey: string }, intents: unknown) => {
    state.applied.push({ locationKey: target.locationKey, intents });
  },
}));

import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useRightPanelStore } from "../../rightPanelStore";
import { usePluginViewOpener } from "./usePluginActions";

import { PluginPageView } from "./PluginViewHost";

const environmentId = EnvironmentId.make("env-1");

function setup(html: string, answer: (name: string) => Promise<PluginInvokeResult>) {
  const digest = "a".repeat(64);
  state.html = html;
  state.calls = [];
  state.generations = [];
  state.applied = [];
  state.answer = answer;
  state.installation = {
    installationId: "inst-1",
    generation: "gen-1",
    manifest: {
      id: "examples.board",
      name: "Board",
      version: "1.0.0",
      apiVersion: 1,
      entry: "plugin.mjs",
      capabilities: ["ui"],
      actions: [],
      views: [{ id: "board", title: "Board", entry: "view.html", placement: "page" }],
      settings: [],
    },
    source: { kind: "local", directory: "/plugins/board" },
    digest,
    enabled: true,
    consentedDigest: digest,
    status: "idle",
    error: null,
    settings: {},
    grants: { capabilities: ["ui"], projectIds: [] },
    updatedAt: "2026-10-22T00:00:00.000Z",
  };
}

const view = () => (
  <PluginPageView environmentId={environmentId} installationId="inst-1" viewId="board" />
);

it("reloads a view that was stopped for leaving its page", async () => {
  let booted = 0;
  setup(
    `<script>t3.invoke("boot").then(function (r) {
      if (r.data && r.data.navigate) location.reload(); else t3.invoke("alive");
    });</script>`,
    async (name) => (name === "boot" ? { data: { navigate: ++booted === 1 } } : {}),
  );
  await using _screen = await render(view(), { router: "/plugins/env-1/inst-1/board" });

  await expect.element(page.getByText("Board was stopped")).toBeVisible();
  await page.getByRole("button", { name: "Reload view" }).click();

  await vi.waitFor(() => expect(state.calls).toContain("alive"));
  expect(page.getByText("Board was stopped").query()).toBeNull();
});

it("ignores bridge messages that do not carry the document's token", async () => {
  setup(
    `<script>
      // What a page the frame navigated to could send: right shape, no token.
      window.parent.postMessage({ t3Plugin: 1, kind: "invoke", id: 99, name: "forged" }, "*");
      t3.invoke("legit");
    </script>`,
    async () => ({}),
  );
  await using _screen = await render(view(), { router: "/plugins/env-1/inst-1/board" });

  await vi.waitFor(() => expect(state.calls).toContain("legit"));
  expect(state.calls).not.toContain("forged");
});

it("judges a view's intents against where the user was when it asked", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  setup(`<script>t3.invoke("review");</script>`, async () => {
    await held;
    return { intents: [{ type: "view.open", viewId: "board" }] };
  });
  await using screen = await render(view(), { router: "/plugins/env-1/inst-1/board" });

  await vi.waitFor(() => expect(state.calls).toContain("review"));
  await screen.router!.navigate({ to: "/settings" });
  release();

  await vi.waitFor(() => expect(state.applied).toHaveLength(1));
  expect(state.applied[0]!.locationKey).toBe("/plugins/env-1/inst-1/board");
});

it("drops a pending answer from the generation a plugin update replaced", async () => {
  let releaseOld!: () => void;
  const oldHeld = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let releaseNew!: () => void;
  const newHeld = new Promise<void>((resolve) => {
    releaseNew = resolve;
  });
  setup(`<script>t3.invoke("review");</script>`, async (name) => {
    if (name === "review") {
      await oldHeld;
      return { data: { stale: true }, intents: [{ type: "view.open", viewId: "board" }] };
    }
    await newHeld;
    return { data: { fresh: true } };
  });
  await using _screen = await render(view(), { router: "/plugins/env-1/inst-1/board" });
  await vi.waitFor(() => expect(state.calls).toEqual(["review"]));

  // Both documents number their first request 1, so a stray answer would settle the new one.
  state.html = `<script>t3.invoke("fresh").then(function (result) {
    parent.postMessage({ freshGot: result.data }, "*");
  });</script>`;
  await act(() => {
    state.installation = { ...state.installation!, generation: "gen-2" };
    for (const listener of state.catalogueListeners) listener();
  });
  await vi.waitFor(() => expect(state.calls).toEqual(["review", "fresh"]));
  const freshGot = new Promise<unknown>((resolve) => {
    const listener = (event: MessageEvent) => {
      if (!event.data?.freshGot) return;
      window.removeEventListener("message", listener);
      resolve(event.data.freshGot);
    };
    window.addEventListener("message", listener);
  });

  // The old answer settles first; the new one reaches the view in a later task, by which time
  // the old answer has been handled.
  releaseOld();
  releaseNew();

  expect(await freshGot).toEqual({ fresh: true });
  expect(state.generations).toEqual(["gen-1", "gen-2"]);
  expect(state.applied).toEqual([]);
});

it("reveals an explicit thread and opens the side panel there, leaving the origin's panels alone", async () => {
  setup("", async () => ({}));
  const installation: PluginInstallation = {
    ...state.installation!,
    manifest: {
      ...state.installation!.manifest,
      views: [{ id: "board", title: "Board", entry: "view.html", placement: "side-panel" }],
    },
  };
  const origin = scopeThreadRef(environmentId, ThreadId.make("origin"));
  const destination = scopeThreadRef(environmentId, ThreadId.make("coordinator"));
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  useRightPanelStore
    .getState()
    .openPluginView(destination, { installationId: "inst-1", viewId: "board", title: "Board" });
  useRightPanelStore.getState().close(destination);
  expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(destination)]?.isOpen).toBe(
    false,
  );
  function OpenOverview() {
    const open = usePluginViewOpener();
    return (
      <button
        onClick={() =>
          open({ environmentId, installation, threadRef: origin }, "board", destination.threadId)
        }
      >
        Open Overview
      </button>
    );
  }
  await using screen = await render(<OpenOverview />, { router: "/env-1/origin" });
  await page.getByRole("button", { name: "Open Overview" }).click();
  await vi.waitFor(() => expect(screen.router!.state.location.pathname).toBe("/env-1/coordinator"));
  expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(origin)]).toBeUndefined();
  expect(useRightPanelStore.getState().byThreadKey[scopedThreadKey(destination)]?.isOpen).toBe(
    true,
  );
  expect(
    useRightPanelStore.getState().byThreadKey[scopedThreadKey(destination)]?.surfaces,
  ).toMatchObject([{ kind: "plugin", installationId: "inst-1", viewId: "board" }]);
});
