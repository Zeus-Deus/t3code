import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type PluginInstallation,
  type PluginInvokeInput,
  type PluginInvokeResult,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";

const state = vi.hoisted(() => ({
  installation: null as PluginInstallation | null,
  // Change counts the environment reported, by plugin topic key.
  revisions: null as Map<string, number> | null,
  revisionListeners: new Set<() => void>(),
  answer: (_input: PluginInvokeInput): Promise<PluginInvokeResult> => Promise.resolve({}),
}));

vi.mock(import("../../state/plugins"), async (original) => {
  const actual = await original();
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.revisionListeners.add(listener);
    return () => state.revisionListeners.delete(listener);
  };
  return {
    ...actual,
    usePluginChangeRevisions: () => useSyncExternalStore(subscribe, () => state.revisions),
    usePluginCatalogue: () => ({
      availability: "available" as const,
      installations: state.installation ? [state.installation] : [],
      loaded: true,
      error: null,
    }),
  };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => async (request: { input: PluginInvokeInput }) =>
    AsyncResult.success(await state.answer(request.input))) as never,
}));

import { ThreadDetailsPluginStatuses } from "../chat/ThreadDetailsPluginStatuses";
import { PluginThreadStatuses, PluginThreadStatusesProvider } from "./PluginThreadStatuses";

const environmentId = EnvironmentId.make("env-1");
const threadA = scopeThreadRef(environmentId, ThreadId.make("thread-a"));
const threadB = scopeThreadRef(environmentId, ThreadId.make("thread-b"));

function setup(answer: (input: PluginInvokeInput) => Promise<PluginInvokeResult>) {
  const digest = "a".repeat(64);
  state.answer = answer;
  state.revisions = null;
  state.installation = {
    installationId: "inst-realms",
    generation: "gen-1",
    manifest: {
      id: "zeus-deus.t3code-realms",
      name: "Realms",
      version: "0.1.0",
      apiVersion: 1,
      entry: "plugin.mjs",
      capabilities: ["ui"],
      actions: [],
      views: [{ id: "realm", title: "Realm", entry: "views/realm.html", placement: "side-panel" }],
      threadStatus: [{ id: "realm", title: "Realm", viewId: "realm" }],
      settings: [],
    },
    source: { kind: "local", directory: "/plugins/realms" },
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

const live: PluginInvokeResult = {
  data: { label: "Realm live", tone: "success", detail: "1920x1080 desktop. Agent can use it." },
};

it("shows the open thread's status and opens its side panel", async () => {
  const asked: PluginInvokeInput[] = [];
  setup(async (input) => {
    asked.push(input);
    return live;
  });
  await using _screen = await render(
    <PluginThreadStatusesProvider threadRef={threadA}>
      <PluginThreadStatuses />
    </PluginThreadStatusesProvider>,
  );

  const status = page.getByRole("button", { name: "Realm live" });
  await expect.element(status).toBeVisible();
  await expect
    .element(status)
    .toHaveAccessibleDescription("Realms: 1920x1080 desktop. Agent can use it.");
  expect(asked[0]).toMatchObject({
    installationId: "inst-realms",
    generation: "gen-1",
    handler: "status:realm",
    context: { threadId: "thread-a" },
  });

  await userEvent.click(status);
  expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadA)).toEqual(
    expect.objectContaining({ kind: "plugin", installationId: "inst-realms", viewId: "realm" }),
  );
});

it("hides the status when the plugin answers null", async () => {
  let answer: PluginInvokeResult = live;
  setup(async () => answer);
  await using _screen = await render(
    <PluginThreadStatusesProvider threadRef={threadA}>
      <PluginThreadStatuses />
    </PluginThreadStatusesProvider>,
  );
  await expect.element(page.getByRole("button", { name: "Realm live" })).toBeVisible();

  answer = { data: null };
  window.dispatchEvent(new Event("focus"));
  await expect.element(page.getByRole("button", { name: "Realm live" })).not.toBeInTheDocument();
  expect(page.getByRole("group", { name: "Plugin status" }).query()).toBeNull();
});

it("never shows the previous thread's status after switching threads", async () => {
  let releaseB!: (result: PluginInvokeResult) => void;
  const heldB = new Promise<PluginInvokeResult>((resolve) => {
    releaseB = resolve;
  });
  setup((input) => (input.context?.threadId === "thread-a" ? Promise.resolve(live) : heldB));
  await using screen = await render(
    <PluginThreadStatusesProvider threadRef={threadA}>
      <PluginThreadStatuses />
    </PluginThreadStatusesProvider>,
  );
  await expect.element(page.getByRole("button", { name: "Realm live" })).toBeVisible();

  await screen.rerender(
    <PluginThreadStatusesProvider threadRef={threadB}>
      <PluginThreadStatuses />
    </PluginThreadStatusesProvider>,
  );
  expect(page.getByRole("button", { name: "Realm live" }).query()).toBeNull();

  releaseB({ data: { label: "Realm off", tone: "neutral" } });
  await expect.element(page.getByRole("button", { name: "Realm off" })).toBeVisible();
  expect(page.getByRole("button", { name: "Realm live" }).query()).toBeNull();
});

it("lists the status in the thread details card and opens its side panel from there", async () => {
  let answer: PluginInvokeResult = live;
  setup(async () => answer);
  await using _screen = await render(
    <PluginThreadStatusesProvider threadRef={threadA}>
      <ThreadDetailsPluginStatuses />
    </PluginThreadStatusesProvider>,
  );

  const row = page.getByRole("button", { name: "Realm live" });
  await expect.element(row).toBeVisible();
  await expect
    .element(row)
    .toHaveAccessibleDescription("Realms: 1920x1080 desktop. Agent can use it.");
  await userEvent.click(row);
  expect(selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadA)).toEqual(
    expect.objectContaining({ kind: "plugin", installationId: "inst-realms", viewId: "realm" }),
  );

  answer = { data: null };
  window.dispatchEvent(new Event("focus"));
  await expect.element(row).not.toBeInTheDocument();
  expect(page.getByRole("region", { name: "Plugin status" }).query()).toBeNull();
});

it("keeps the status and its poller when the details card opens and closes", async () => {
  const asked: PluginInvokeInput[] = [];
  setup(async (input) => {
    asked.push(input);
    return live;
  });
  // As in ChatView: one provider, with the header or the open details card showing statuses.
  const Statuses = (props: { readonly card: boolean }) => (
    <PluginThreadStatusesProvider threadRef={threadA}>
      {props.card ? <ThreadDetailsPluginStatuses /> : <PluginThreadStatuses />}
    </PluginThreadStatusesProvider>
  );
  await using screen = await render(<Statuses card={false} />);
  await expect.element(page.getByRole("button", { name: "Realm live" })).toBeVisible();
  expect(asked).toHaveLength(1);

  await screen.rerender(<Statuses card />);
  expect(page.getByRole("button", { name: "Realm live" }).query()).not.toBeNull();
  await screen.rerender(<Statuses card={false} />);
  expect(page.getByRole("button", { name: "Realm live" }).query()).not.toBeNull();
  expect(asked).toHaveLength(1);
});

it("keeps a card status without a panel readable instead of disabled", async () => {
  setup(async () => live);
  state.installation = {
    ...state.installation!,
    manifest: { ...state.installation!.manifest, threadStatus: [{ id: "realm", title: "Realm" }] },
  };
  await using _screen = await render(
    <PluginThreadStatusesProvider threadRef={threadA}>
      <ThreadDetailsPluginStatuses />
    </PluginThreadStatusesProvider>,
  );

  await expect.element(page.getByText("Realm live")).toBeVisible();
  expect(page.getByRole("button", { name: "Realm live" }).query()).toBeNull();
  await expect
    .element(page.getByText("Realms: 1920x1080 desktop. Agent can use it.", { exact: false }))
    .toBeInTheDocument();
});

it("asks again at once when the plugin says a shown status changed", async () => {
  const asked: PluginInvokeInput[] = [];
  setup(async (input) => {
    asked.push(input);
    return asked.length === 1 ? live : { data: { label: "Realm idle", tone: "neutral" } };
  });
  state.revisions = new Map();
  await using _screen = await render(
    <PluginThreadStatusesProvider threadRef={threadA}>
      <PluginThreadStatuses />
    </PluginThreadStatusesProvider>,
  );
  await expect.element(page.getByRole("button", { name: "Realm live" })).toBeVisible();

  // Another topic changing does not ask the plugin again.
  state.revisions = new Map([["inst-realms\0gen-1\0view:realm", 1]]);
  for (const listener of state.revisionListeners) listener();
  state.revisions = new Map([
    ["inst-realms\0gen-1\0view:realm", 1],
    ["inst-realms\0gen-1\0status:realm", 1],
  ]);
  for (const listener of state.revisionListeners) listener();
  await expect.element(page.getByRole("button", { name: "Realm idle" })).toBeVisible();
  expect(asked).toHaveLength(2);
});
