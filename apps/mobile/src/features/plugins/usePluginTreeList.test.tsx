import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { PluginSidebarViewSource } from "@t3tools/client-runtime/plugins";
import { EnvironmentId, PluginError, type PluginTreeNode } from "@t3tools/contracts";

import { pluginInstallationFixture } from "../../../../../packages/client-runtime/src/plugins/testFixtures";

const laptop = EnvironmentId.make("env-laptop");
const server = EnvironmentId.make("env-server");
const tree = { id: "projects", title: "Projects" };
const installation = {
  ...pluginInstallationFixture(),
  manifest: { ...pluginInstallationFixture().manifest, nativeTrees: [tree] },
  grants: { capabilities: ["ui.native-trees" as const, "threads.read" as const], projectIds: [] },
};
const choice = {
  kind: "tree" as const,
  key: "acme.quote-helper/tree:projects",
  environmentId: laptop,
  pluginId: "acme.quote-helper",
  pluginName: "Quote helper",
  tree,
};

const harness = vi.hoisted(() => ({
  // Per environment: the nodes its next read serves, or undefined to fail it.
  served: new Map<string, unknown>(),
  // Undefined while the change subscription has not reported its first count.
  revision: 0 as number | undefined,
  generation: "gen-1",
  conversations: false,
  connected: true,
  // A read for this environment stays in flight until the test settles it.
  pending: new Map<string, Promise<unknown>>(),
  reads: [] as string[],
  result: null as null | {
    readonly sources: unknown;
    readonly notice: string | null;
    readonly selected: unknown;
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { readonly read: () => unknown }) => atom.read(),
  useAtomSet: () => () => {},
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {
    read: () => AsyncResult.success({ threadListPluginTree: choice, threadListTreeFolds: [] }),
  },
  updateMobilePreferencesAtom: {},
}));
vi.mock("../../state/plugins", () => ({
  pluginEnvironment: { readTree: "readTree" },
  pluginTreeViewSourcesAtom: (environmentIds: ReadonlyArray<string>) => ({
    read: () =>
      new Map<string, PluginSidebarViewSource>(
        environmentIds.map((environmentId) => [
          environmentId,
          { status: "ready", options: [{ ...choice, environmentId }] },
        ]),
      ),
  }),
  usePluginCatalogue: () => ({
    availability: harness.connected ? "available" : "disconnected",
    loaded: harness.connected,
    error: null,
    installations: harness.connected
      ? [
          {
            ...installation,
            generation: harness.generation,
            grants: {
              ...installation.grants,
              capabilities: [
                ...installation.grants.capabilities,
                ...(harness.conversations ? ["ui.native-tree-conversations" as const] : []),
              ],
            },
          },
        ]
      : [],
    executionDisabled: false,
  }),
  usePluginChangeRevision: () => harness.revision,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (request: { readonly environmentId: string }) => {
    harness.reads.push(request.environmentId);
    const pending = harness.pending.get(request.environmentId);
    if (pending !== undefined) return pending;
    const nodes = harness.served.get(request.environmentId);
    // The hook only tells a read that served nodes from one that did not.
    return nodes === undefined
      ? {
          _tag: "Failure",
          cause: new PluginError({ reason: "permission_denied", message: "denied" }),
        }
      : { _tag: "Success", value: { nodes } };
  },
}));
vi.mock("./usePluginActions", () => ({ newPluginOperationId: () => "op-test" }));

import { usePluginTreeList } from "./usePluginTreeList";

let root: Root | null = null;

function Consumer(props: { readonly environmentIds: ReadonlyArray<EnvironmentId> }) {
  const list = usePluginTreeList(props.environmentIds);
  harness.result = { sources: list.sources, notice: list.notice, selected: list.selected };
  return list.fetchers as ReactNode;
}

async function renderList(environmentIds: ReadonlyArray<EnvironmentId>) {
  await act(async () => {
    root!.render(<Consumer environmentIds={environmentIds} />);
  });
  // Let each read's result land and re-render.
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const group = (id: string): PluginTreeNode => ({ id, kind: "group", title: id });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.served = new Map();
  harness.revision = 0;
  harness.generation = "gen-1";
  harness.conversations = false;
  harness.connected = true;
  harness.pending = new Map();
  harness.reads = [];
  harness.result = null;
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
});

it("says a tree that never loaded leaves the list as activity, keeping the choice", async () => {
  await renderList([laptop]);
  expect(harness.reads).toEqual([laptop]);
  expect(harness.result).toMatchObject({
    sources: null,
    notice: "Couldn't load Projects. Showing Activity.",
    selected: { key: choice.key },
  });
});

it("keeps the last rows after a failed refresh and calls them out of date until a read succeeds", async () => {
  harness.served.set(laptop, [group("mine")]);
  await renderList([laptop]);
  expect(harness.result).toMatchObject({ notice: null });

  harness.served.delete(laptop);
  harness.revision = 1;
  await renderList([laptop]);
  expect(harness.result).toMatchObject({
    sources: [{ environmentId: laptop, nodes: [group("mine")] }],
    notice: "Projects may be out of date.",
  });

  harness.served.set(laptop, [group("mine"), group("new")]);
  harness.revision = 2;
  await renderList([laptop]);
  expect(harness.result).toMatchObject({
    sources: [{ environmentId: laptop, nodes: [group("mine"), group("new")] }],
    notice: null,
  });
  // Each change signal read once; nothing polled in between.
  expect(harness.reads).toEqual([laptop, laptop, laptop]);
});

it("calls the tree incomplete, not activity, when only another environment served it", async () => {
  harness.served.set(laptop, [group("mine")]);
  await renderList([laptop, server]);
  expect(harness.result).toMatchObject({
    sources: [{ environmentId: laptop, nodes: [group("mine")] }],
    notice: "Part of Projects couldn't load. It may be incomplete.",
  });
});

it("drops the previous generation's rows and failure while the new generation waits", async () => {
  harness.served.set(laptop, [group("old-generation")]);
  await renderList([laptop]);
  harness.served.delete(laptop);
  harness.revision = 1;
  await renderList([laptop]);
  expect(harness.result).toMatchObject({ notice: "Projects may be out of date." });

  // New grants: a new generation, before its change subscription answers.
  harness.generation = "gen-2";
  harness.revision = undefined;
  await renderList([laptop]);
  expect(harness.result).toMatchObject({ sources: null, notice: null });

  // Its first read is in flight.
  let finish!: (result: unknown) => void;
  harness.pending.set(
    laptop,
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  harness.revision = 0;
  await renderList([laptop]);
  expect(harness.result).toMatchObject({ sources: null, notice: null });

  await act(async () =>
    finish({
      _tag: "Failure",
      cause: new PluginError({ reason: "permission_denied", message: "new grants" }),
    }),
  );
  expect(harness.result).toMatchObject({
    sources: null,
    notice: "Couldn't load Projects. Showing Activity.",
  });
  expect(harness.reads).toEqual([laptop, laptop, laptop]);
});

it("keeps the same generation's rows while disconnected or resubscribing", async () => {
  harness.served.set(laptop, [group("mine")]);
  await renderList([laptop]);
  harness.served.delete(laptop);
  harness.revision = 1;
  await renderList([laptop]);
  const stale = {
    sources: [{ environmentId: laptop, nodes: [group("mine")] }],
    notice: "Projects may be out of date.",
  };
  expect(harness.result).toMatchObject(stale);

  harness.connected = false;
  await renderList([laptop]);
  expect(harness.result).toMatchObject(stale);

  // Reconnected to the same generation; its change subscription has not counted yet.
  harness.connected = true;
  harness.revision = undefined;
  await renderList([laptop]);
  expect(harness.result).toMatchObject(stale);
  expect(harness.reads).toEqual([laptop, laptop]);

  harness.served.set(laptop, [group("mine")]);
  harness.revision = 0;
  await renderList([laptop]);
  expect(harness.result).toMatchObject({ notice: null });
  expect(harness.reads).toEqual([laptop, laptop, laptop]);
});

it("stops honouring project conversations as soon as the grant goes, even if the re-read fails", async () => {
  harness.conversations = true;
  harness.served.set(laptop, [group("mine")]);
  await renderList([laptop]);
  expect(harness.result).toMatchObject({
    sources: [{ environmentId: laptop, nodes: [group("mine")], conversations: true }],
  });

  // Same generation, grant revoked: the tree reads again and the server refuses it.
  harness.conversations = false;
  harness.served.delete(laptop);
  await renderList([laptop]);
  expect(harness.result).toMatchObject({
    sources: [{ environmentId: laptop, nodes: [group("mine")], conversations: false }],
    notice: "Projects may be out of date.",
  });
  expect(harness.reads).toEqual([laptop, laptop]);
});
