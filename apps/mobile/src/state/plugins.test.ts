import {
  pluginSidebarTreeKey,
  resolvePluginSidebarView,
  type PluginSidebarTreeOption,
} from "@t3tools/client-runtime/plugins";
import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  PLUGIN_API_VERSION,
  type PluginInstallation,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { pluginInstallationFixture } from "../../../../packages/client-runtime/src/plugins/testFixtures";

// The sources the mobile plugin atoms read: connection presentations, the session, and the
// environment's plugin catalogue.
const sources = vi.hoisted(() => ({
  presentations: new Map<string, unknown>(),
  session: null as unknown,
  installations: null as ReadonlyArray<unknown> | null,
  catalogueFailed: false,
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./query", () => ({ useEnvironmentQuery: () => ({ data: null, error: null }) }));
vi.mock("./presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: { presentationsAtom: Atom.make(() => sources.presentations) },
  };
});
vi.mock("./session", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    useEnvironmentScope: () => false,
    environmentSession: {
      sessionStateAtom: () =>
        Atom.make(() =>
          sources.session === null ? AsyncResult.initial() : AsyncResult.success(sources.session),
        ),
    },
  };
});
vi.mock("@t3tools/client-runtime/state/plugins", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    createPluginEnvironmentAtoms: () => ({
      catalogue: () =>
        Atom.make(() =>
          sources.catalogueFailed
            ? AsyncResult.fail(new Error("Could not list plugins"))
            : sources.installations === null
              ? AsyncResult.initial()
              : AsyncResult.success({ installations: sources.installations }),
        ),
    }),
  };
});

const { pluginTreeViewSourcesAtom } = await import("./plugins");

const laptop = EnvironmentId.make("env-laptop");

function projectsTree(): PluginInstallation {
  const base = pluginInstallationFixture();
  return {
    ...base,
    manifest: {
      ...base.manifest,
      id: "examples.projects-tree",
      name: "Projects Tree",
      nativeTrees: [{ id: "projects", title: "Projects" }],
    },
    grants: { capabilities: ["ui.native-trees", "threads.read"], projectIds: [] },
  };
}

const remembered: PluginSidebarTreeOption = {
  kind: "tree",
  key: pluginSidebarTreeKey("examples.projects-tree", "projects"),
  environmentId: laptop,
  pluginId: "examples.projects-tree",
  pluginName: "Projects Tree",
  tree: { id: "projects", title: "Projects" },
};

function setup(input: {
  readonly phase: string;
  readonly capabilities: unknown;
  readonly session: unknown;
  readonly catalogueFailed?: boolean;
}) {
  sources.presentations = new Map([
    [
      laptop,
      {
        connection: { phase: input.phase, error: null, traceId: null },
        serverConfig: { environment: { capabilities: input.capabilities } },
      },
    ],
  ]);
  sources.session = input.session;
  sources.installations = [projectsTree()];
  sources.catalogueFailed = input.catalogueFailed ?? false;
}

const pluginsApi = { plugins: { apiVersion: PLUGIN_API_VERSION } };
const reader = { authenticated: true, permissions: [AuthOrchestrationReadScope] };

// Each case reads fresh atoms: the families are keyed only by environment ids.
function selectedTree() {
  const registry = AtomRegistry.make();
  const viewSources = registry.get(pluginTreeViewSourcesAtom([laptop]));
  return {
    source: viewSources.get(laptop),
    selected: resolvePluginSidebarView({ remembered, sources: viewSources }).selected,
  };
}

it("offers a connected environment's trees and keeps the remembered one", () => {
  setup({ phase: "connected", capabilities: pluginsApi, session: reader });
  expect(selectedTree().selected?.key).toBe(remembered.key);
});

it("keeps the remembered tree while its environment is still reporting", () => {
  for (const [label, input] of [
    ["reconnecting", { phase: "reconnecting", capabilities: pluginsApi, session: reader }],
    ["session not answered", { phase: "connected", capabilities: pluginsApi, session: null }],
  ] as const) {
    setup(input);
    expect(selectedTree(), label).toMatchObject({
      source: { status: "pending" },
      selected: { key: remembered.key },
    });
  }
});

it("falls back to activity where the environment can never serve the tree", () => {
  for (const [label, input] of [
    ["server without plugins", { phase: "connected", capabilities: {}, session: reader }],
    [
      "server with a newer plugin API",
      {
        phase: "connected",
        capabilities: { plugins: { apiVersion: PLUGIN_API_VERSION + 1 } },
        session: reader,
      },
    ],
    [
      "session without read access",
      {
        phase: "connected",
        capabilities: pluginsApi,
        session: { authenticated: true, permissions: [] },
      },
    ],
    [
      "plugin list failed",
      { phase: "connected", capabilities: pluginsApi, session: reader, catalogueFailed: true },
    ],
  ] as const) {
    setup(input);
    // Web reports these as ready with no choices, so the remembered tree stops showing as chosen.
    expect(selectedTree(), label).toMatchObject({
      source: { status: "ready", options: [] },
      selected: null,
    });
  }
});
