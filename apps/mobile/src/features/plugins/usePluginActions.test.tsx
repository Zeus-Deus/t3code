import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type PluginClientIntent,
  type PluginInstallation,
} from "@t3tools/contracts";

import { pluginInstallationFixture } from "../../../../../packages/client-runtime/src/plugins/testFixtures";

const harness = vi.hoisted(() => ({
  calls: [] as unknown[],
  confirms: [] as Array<() => void>,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: (...args: unknown[]) => harness.calls.push(args) }),
}));
vi.mock("../workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => (detail: unknown) => harness.calls.push(detail),
}));
vi.mock("../../components/ui/Dialog", () => ({
  alert: (
    _title: string,
    _message: string,
    buttons: Array<{ text: string; onPress?: () => void }>,
  ) => {
    const confirm = buttons.find((button) => button.text === "Open")?.onPress;
    if (confirm) harness.confirms.push(confirm);
  },
}));
vi.mock("../../lib/openExternalUrl", () => ({ tryOpenExternalUrl: () => {} }));
vi.mock("../../lib/uuid", () => ({ randomHex: () => "test" }));
vi.mock("../../state/plugins", () => ({ pluginEnvironment: {} }));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => () => {} }));
vi.mock("../../state/use-composer-drafts", () => ({
  appendComposerDraftText: () => {},
  getComposerDraftSnapshot: () => ({ text: "" }),
}));

import { usePluginIntentApplier } from "./usePluginActions";

const environmentId = EnvironmentId.make("destination-environment");
const originThread = ThreadId.make("origin");
const coordinator = ThreadId.make("coordinator");

async function renderIntent(intent: PluginClientIntent, stillInFront = true) {
  harness.calls = [];
  harness.confirms = [];
  const fixture = pluginInstallationFixture();
  const installation: PluginInstallation = {
    ...fixture,
    manifest: {
      ...fixture.manifest,
      views: [
        { id: "overview", title: "Overview", entry: "view.html", placement: "side-panel" },
        { id: "page", title: "Page", entry: "view.html", placement: "page" },
      ],
    },
  };
  const target = { environmentId, threadId: originThread, installation };
  function Invoke() {
    const apply = usePluginIntentApplier();
    return <button onClick={() => apply(target, [intent], stillInFront)}>Open</button>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => root.render(<Invoke />));
  return {
    installation,
    click: () => act(() => container.querySelector("button")!.click()),
    async [Symbol.asyncDispose]() {
      await act(() => root.unmount());
      container.remove();
    },
  };
}

it("reveals the requested thread and opens its full-screen panel in the same environment", async () => {
  await using screen = await renderIntent({
    type: "view.open",
    viewId: "overview",
    threadId: coordinator,
  });
  await screen.click();
  expect(harness.calls).toEqual([
    { name: "Thread", params: { environmentId, threadId: coordinator } },
    [
      "PluginView",
      {
        environmentId,
        installationId: screen.installation.installationId,
        viewId: "overview",
        threadId: coordinator,
      },
    ],
  ]);
});

it("offers late results and navigates only after the person accepts", async () => {
  await using screen = await renderIntent(
    { type: "view.open", viewId: "overview", threadId: coordinator },
    false,
  );
  await screen.click();
  expect(harness.calls).toEqual([]);
  expect(harness.confirms).toHaveLength(1);
  await act(() => harness.confirms[0]!());
  expect(harness.calls[0]).toEqual({
    name: "Thread",
    params: { environmentId, threadId: coordinator },
  });
});

it.each([
  { type: "view.open", viewId: "overview" },
  { type: "view.open", viewId: "page", threadId: coordinator },
] as const)(
  "keeps origin context without targeted side-panel navigation: $viewId",
  async (intent) => {
    await using screen = await renderIntent(intent);
    await screen.click();
    expect(harness.calls).toEqual([
      [
        "PluginView",
        {
          environmentId,
          installationId: screen.installation.installationId,
          viewId: intent.viewId,
          threadId: originThread,
        },
      ],
    ]);
  },
);
