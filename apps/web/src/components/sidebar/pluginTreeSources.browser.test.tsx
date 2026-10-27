import { pluginSidebarTreeOptions } from "@t3tools/client-runtime/plugins";
import { EnvironmentId, PluginError, ThreadId, type PluginInstallation } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import {
  PluginTreeSnapshotSources,
  resetPluginTreeSnapshotsForTests,
  usePluginTreeConversationScope,
  usePluginTreeNotice,
  usePluginTreeSources,
} from "./pluginTreeSources";

// The catalogue and change count are subscriptions in the app; the mocks notify the same way.
const state = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let snapshot = {
    catalogue: null as unknown,
    // Undefined while the change subscription has not reported its first count.
    revision: 0 as number | undefined,
  };
  return {
    reads: 0,
    // The next read's result; a pending promise holds it open.
    next: null as unknown,
    read: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update: (patch: Partial<typeof snapshot>) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("../../state/environments", () => ({
  useConnectedEnvironmentIds: () => ["env-laptop"],
  useEnvironmentIdentities: () => [{ environmentId: "env-laptop" }],
  usePrimaryEnvironmentId: () => "env-laptop",
}));
vi.mock("../../state/plugins", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    pluginEnvironment: { readTree: {} },
    usePluginCatalogue: () => useSyncExternalStore(state.subscribe, () => state.read().catalogue),
    usePluginChangeRevision: () =>
      useSyncExternalStore(state.subscribe, () => state.read().revision),
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => {
    state.reads += 1;
    return state.next;
  },
}));
vi.mock("../plugins/usePluginActions", () => ({ newPluginOperationId: () => "op-test" }));

const installation: PluginInstallation = {
  installationId: "inst-projects",
  generation: "gen-1",
  manifest: {
    id: "acme.projects",
    name: "Projects",
    version: "1.0.0",
    apiVersion: 1,
    entry: "plugin.mjs",
    capabilities: ["ui.native-trees", "threads.read"],
    actions: [],
    views: [],
    settings: [],
    nativeTrees: [{ id: "projects", title: "Projects" }],
  },
  source: { kind: "local", directory: "/plugins/projects" },
  digest: "a".repeat(64),
  enabled: true,
  consentedDigest: "a".repeat(64),
  status: "idle",
  error: null,
  settings: {},
  grants: { capabilities: ["ui.native-trees", "threads.read"], projectIds: [] },
  updatedAt: "2026-10-24T00:00:00.000Z",
};
const choice = pluginSidebarTreeOptions(EnvironmentId.make("env-laptop"), [installation])[0]!;
const available = (generation: string, capabilities = installation.grants.capabilities) => ({
  availability: "available",
  loaded: true,
  error: null,
  executionDisabled: false,
  installations: [{ ...installation, generation, grants: { capabilities, projectIds: [] } }],
});
const disconnected = {
  availability: "disconnected",
  loaded: false,
  error: null,
  installations: [],
};
const mine = [{ id: "mine", kind: "group", title: "Mine" }];
const served = { _tag: "Success", value: { nodes: mine } };
const denied = {
  _tag: "Failure",
  cause: new PluginError({ reason: "permission_denied", message: "denied" }),
};

function setup() {
  resetPluginTreeSnapshotsForTests();
  state.update({ catalogue: available("gen-1"), revision: 0 });
  state.reads = 0;
  state.next = served;
}

function Probe() {
  const sources = usePluginTreeSources(choice);
  const notice = usePluginTreeNotice(choice);
  return (
    <>
      <PluginTreeSnapshotSources choice={choice} snoozeWake={0} />
      <output>{JSON.stringify({ sources, notice })}</output>
    </>
  );
}

const shown = (screen: { container: HTMLElement }) =>
  JSON.parse(screen.container.querySelector("output")!.textContent!) as {
    sources: unknown;
    notice: string | null;
  };

const staleGeneration = {
  sources: [{ environmentId: "env-laptop", nodes: mine, conversations: false }],
};

it("drops the previous generation's rows and failure as soon as the catalogue names a new one", async () => {
  setup();
  await using screen = await render(<Probe />);
  await vi.waitFor(() => expect(shown(screen)).toEqual({ ...staleGeneration, notice: null }));
  state.next = denied;
  await act(() => state.update({ revision: 1 }));
  await vi.waitFor(() =>
    expect(shown(screen)).toEqual({ ...staleGeneration, notice: "Projects may be out of date." }),
  );

  // New grants: a new generation, while its change subscription has not answered yet.
  await act(() => state.update({ catalogue: available("gen-2"), revision: undefined }));
  expect(shown(screen)).toEqual({ sources: null, notice: null });
  expect(state.reads).toBe(2);

  // Its first read is still in flight.
  let finish!: (result: unknown) => void;
  state.next = new Promise((resolve) => {
    finish = resolve;
  });
  await act(() => state.update({ revision: 0 }));
  expect(state.reads).toBe(3);
  expect(shown(screen)).toEqual({ sources: null, notice: null });

  await act(() => finish(denied));
  await vi.waitFor(() =>
    expect(shown(screen)).toEqual({
      sources: null,
      notice: "Couldn't load Projects. Showing Activity.",
    }),
  );
  expect(state.reads).toBe(3);
});

it("keeps the same generation's rows while disconnected or resubscribing, until a read succeeds", async () => {
  setup();
  await using screen = await render(<Probe />);
  await vi.waitFor(() => expect(shown(screen)).toEqual({ ...staleGeneration, notice: null }));
  state.next = denied;
  await act(() => state.update({ revision: 1 }));
  const stale = { ...staleGeneration, notice: "Projects may be out of date." };
  await vi.waitFor(() => expect(shown(screen)).toEqual(stale));

  await act(() => state.update({ catalogue: disconnected }));
  expect(shown(screen)).toEqual(stale);

  // Reconnected to the same generation; its change subscription has not counted yet.
  await act(() => state.update({ catalogue: available("gen-1"), revision: undefined }));
  expect(shown(screen)).toEqual(stale);
  expect(state.reads).toBe(2);

  state.next = served;
  await act(() => state.update({ revision: 0 }));
  await vi.waitFor(() => expect(shown(screen)).toEqual({ ...staleGeneration, notice: null }));
  expect(state.reads).toBe(3);
});

it("stops honouring project conversations as soon as the grant goes, even if the re-read fails", async () => {
  setup();
  const granted = [...installation.grants.capabilities, "ui.native-tree-conversations" as const];
  state.update({ catalogue: available("gen-1", granted) });
  await using screen = await render(<Probe />);
  const withConversations = {
    sources: [{ environmentId: "env-laptop", nodes: mine, conversations: true }],
    notice: null,
  };
  await vi.waitFor(() => expect(shown(screen)).toEqual(withConversations));

  // Same generation, grant revoked: the tree reads again and the server refuses it.
  state.next = denied;
  await act(() => state.update({ catalogue: available("gen-1") }));
  await vi.waitFor(() =>
    expect(shown(screen)).toEqual({ ...staleGeneration, notice: "Projects may be out of date." }),
  );
  expect(state.reads).toBe(2);
});

it("tells a project conversation and its direct workers apart from any other thread", async () => {
  setup();
  window.localStorage.setItem(SIDEBAR_VIEW_KEY, JSON.stringify(choice));
  using _view = { [Symbol.dispose]: () => window.localStorage.removeItem(SIDEBAR_VIEW_KEY) };
  const granted = [...installation.grants.capabilities, "ui.native-tree-conversations" as const];
  state.update({ catalogue: available("gen-1", granted) });
  state.next = {
    _tag: "Success",
    value: {
      nodes: [
        { id: "p", kind: "project", projectId: "p1", threadId: "coordinator" },
        // Placed under the heading without being the coordinator's child.
        { id: "w", kind: "thread", threadId: "placed", parentId: "p" },
      ],
    },
  };
  const laptop = EnvironmentId.make("env-laptop");
  const cases = [
    ["coordinator", laptop, null],
    ["worker", laptop, "coordinator"],
    ["grandchild", laptop, "worker"],
    ["placed", laptop, null],
    ["remote", EnvironmentId.make("env-server"), "coordinator"],
  ] as const;
  await using screen = await render(
    <>
      <PluginTreeSnapshotSources choice={choice} snoozeWake={0} />
      {cases.map(([threadId, environmentId, parent]) => (
        <ScopeCase
          key={threadId}
          threadId={threadId}
          environmentId={environmentId}
          parent={parent}
        />
      ))}
    </>,
  );
  await vi.waitFor(() =>
    expect(
      [...screen.container.querySelectorAll("[data-scoped=true]")].map((node) => node.id),
    ).toEqual(["coordinator", "worker"]),
  );
});

const SIDEBAR_VIEW_KEY = "t3code:sidebar:view";

function ScopeCase(props: {
  readonly threadId: string;
  readonly environmentId: EnvironmentId;
  readonly parent: string | null;
}) {
  const scoped = usePluginTreeConversationScope(
    props.environmentId,
    ThreadId.make(props.threadId),
    props.parent === null ? null : ThreadId.make(props.parent),
  );
  return <i id={props.threadId} data-scoped={scoped} />;
}
