import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { pluginChangeKey, pluginStatusTopic } from "@t3tools/client-runtime/plugins";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { pluginInstallationFixture } from "../../../../../packages/client-runtime/src/plugins/testFixtures";

const environmentId = EnvironmentId.make("env-laptop");
const threadId = ThreadId.make("thread-1");
const installation = {
  ...pluginInstallationFixture(),
  manifest: {
    ...pluginInstallationFixture().manifest,
    threadStatus: [{ id: "realm", title: "Realm" }],
  },
};
const statusChange = (overrides: {
  installationId?: string;
  generation?: string;
  topic?: string;
}) =>
  pluginChangeKey({
    installationId: installation.installationId,
    generation: installation.generation,
    topic: pluginStatusTopic("realm"),
    ...overrides,
  });

const harness = vi.hoisted(() => ({
  label: "Idle",
  requests: 0,
  revisions: null as ReadonlyMap<string, number> | null,
  focused: true,
  appState: "active",
  appStateListener: null as ((state: string) => void) | null,
}));

vi.mock("@react-navigation/native", () => ({
  useIsFocused: () => harness.focused,
  useNavigation: () => ({ navigate: () => {} }),
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return harness.appState;
    },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      harness.appStateListener = listener;
      return { remove: () => (harness.appStateListener = null) };
    },
  },
  ScrollView: (props: { readonly children: ReactNode }) => props.children,
  View: (props: { readonly children: ReactNode }) => props.children,
}));
vi.mock("../../components/ui/Chip", () => ({
  Chip: (props: { readonly label: string }) => <span>{props.label}</span>,
}));
vi.mock("../../state/plugins", () => ({
  pluginEnvironment: { invoke: "invoke" },
  usePluginCatalogue: () => ({
    availability: "available",
    installations: [installation],
    executionDisabled: false,
  }),
  usePluginChangeRevisions: () => harness.revisions,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => {
    harness.requests += 1;
    return { _tag: "Success", value: { data: { label: harness.label, tone: "info" } } };
  },
}));
vi.mock("./usePluginActions", () => ({ newPluginOperationId: () => "op-test" }));

import { PluginThreadStatuses } from "./PluginThreadStatuses";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render() {
  await act(async () => {
    root!.render(
      <PluginThreadStatuses environmentId={environmentId} threadId={threadId} projectId={null} />,
    );
  });
  // Let each status answer land and re-render.
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function setAppState(state: string) {
  harness.appState = state;
  await act(async () => harness.appStateListener?.(state));
  await render();
}

const shown = () => container!.textContent;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  harness.label = "Idle";
  harness.requests = 0;
  harness.revisions = new Map();
  harness.focused = true;
  harness.appState = "active";
  harness.appStateListener = null;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container = null;
  vi.useRealTimers();
});

it("asks again as soon as the host says a shown status changed", async () => {
  await render();
  expect(shown()).toBe("Realm · Idle");
  expect(harness.requests).toBe(1);

  harness.label = "Live";
  harness.revisions = new Map([[statusChange({}), 1]]);
  await render();
  expect(shown()).toBe("Realm · Live");
  expect(harness.requests).toBe(2);
});

it("ignores changes to other topics, installations and generations", async () => {
  await render();
  harness.label = "Live";
  harness.revisions = new Map([
    [statusChange({ topic: "tree:projects" }), 1],
    [statusChange({ installationId: "inst-2" }), 1],
    [statusChange({ generation: "gen-0" }), 1],
  ]);
  await render();
  expect(shown()).toBe("Realm · Idle");
  expect(harness.requests).toBe(1);
});

it("treats the subscription's first report as the baseline, not a change", async () => {
  harness.revisions = null;
  await render();
  harness.revisions = new Map([[statusChange({}), 3]]);
  await render();
  expect(harness.requests).toBe(1);
});

it("asks nothing while the app is in the background and catches up on return", async () => {
  await render();
  await setAppState("background");

  harness.label = "Live";
  harness.revisions = new Map([[statusChange({}), 1]]);
  await render();
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(harness.requests).toBe(1);

  await setAppState("active");
  expect(shown()).toBe("Realm · Live");
  expect(harness.requests).toBe(2);
});

it("asks nothing while another screen covers the thread", async () => {
  await render();
  harness.focused = false;
  await render();
  harness.revisions = new Map([[statusChange({}), 1]]);
  await render();
  expect(harness.requests).toBe(1);
});

it("still polls when no change arrives", async () => {
  await render();
  harness.label = "Live";
  await act(async () => vi.advanceTimersByTime(30_000));
  await render();
  expect(shown()).toBe("Realm · Live");
  expect(harness.requests).toBe(2);
});
