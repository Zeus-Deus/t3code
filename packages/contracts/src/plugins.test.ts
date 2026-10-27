import * as Schema from "effect/Schema";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";
import {
  AuthAccessWriteScope,
  AuthTerminalOperateScope,
  AuthOrchestrationReadScope,
} from "./auth.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  PluginCatalogue,
  PluginInvokeResult,
  PluginManifest,
  PluginError,
  PluginTreeSnapshot,
  PluginThreadCreateInput,
  PluginCardReference,
  PluginThreadMetadata,
  pluginCompatibility,
  pluginRequestedCapabilities,
} from "./plugins.ts";

const manifest = {
  id: "test.plugin",
  name: "Test",
  version: "1.0.0",
  apiVersion: 1,
  entry: "plugin.mjs",
  capabilities: ["storage", "future.capability"],
  actions: [{ id: "run", title: "Run", placements: ["palette", "future-placement"] }],
  views: [
    { id: "known", title: "Known", entry: "known.html", placement: "page" },
    { id: "future", title: "Future", entry: "future.html", placement: "future-placement" },
  ],
  settings: [],
};
const installation = {
  installationId: "test.plugin",
  generation: "one",
  manifest,
  source: { kind: "local", directory: "/plugins/test" },
  digest: "a".repeat(64),
  enabled: true,
  consentedDigest: "a".repeat(64),
  status: "idle",
  error: null,
  settings: {},
  grants: { capabilities: ["storage", "future.capability"], projectIds: [] },
  updatedAt: "2026-10-22T00:00:00.000Z",
};
const catalogueCodec = Schema.toCodecJson(PluginCatalogue);
const decodeCatalogue = Schema.decodeUnknownSync(catalogueCodec);
const encodeCatalogue = Schema.encodeSync(catalogueCodec);
const decodeManifest = Schema.decodeUnknownSync(PluginManifest);
const resultCodec = Schema.toCodecJson(PluginInvokeResult);
const decodeResult = Schema.decodeUnknownSync(resultCodec);
const decodeThreadCreate = Schema.decodeUnknownSync(PluginThreadCreateInput);
const decodeTreeSnapshot = Schema.decodeUnknownSync(PluginTreeSnapshot);
const decodeCardReference = Schema.decodeUnknownSync(PluginCardReference);
const decodeThreadMetadata = Schema.decodeUnknownSync(PluginThreadMetadata);
const decodePluginError = Schema.decodeUnknownSync(Schema.toCodecJson(PluginError));

it("keeps exclusive tree declarations and ownership additive in API 1", () => {
  const tree = {
    id: "projects",
    title: "Projects",
    unplaced: "omit",
    create: { actionId: "open", title: "New project" },
    emptyText: "Choose a project to begin.",
  };
  const author = {
    ...manifest,
    capabilities: ["ui.native-trees"],
    actions: [],
    views: [],
    nativeTrees: [tree],
  };
  expect(decodeManifest(author).nativeTrees).toEqual([tree]);
  expect(
    decodeCatalogue({ installations: [{ ...installation, manifest: author }] }).installations[0]
      ?.manifest.nativeTrees,
  ).toEqual([tree]);
  expect(pluginCompatibility({ capabilities: ["ui.native-tree-projects"] }).available).toBe(true);
  expect(
    decodeThreadCreate({
      projectId: "p",
      idempotencyKey: "one",
      brief: "Help",
      owner: "tree:projects",
    }),
  ).toHaveProperty("owner", "tree:projects");
  for (const owner of ["projects", "tree:", "tree:bad/ref", 1]) {
    expect(() =>
      decodeThreadCreate({ projectId: "p", idempotencyKey: "one", brief: "Help", owner }),
    ).toThrow();
  }
  for (const invalid of [
    { ...tree, unplaced: "hide" },
    { ...tree, create: { actionId: "", title: "New project" } },
    { ...tree, emptyText: "x".repeat(301) },
  ]) {
    expect(() => decodeManifest({ ...author, nativeTrees: [invalid] })).toThrow();
  }
});

it("requires management authority to add exactly one project grant", () => {
  expect(clientRpcRequiredScopes("plugins.grantProject", {})).toEqual([
    AuthAccessWriteScope,
    AuthTerminalOperateScope,
  ]);
});

it("keeps optional project conversations in API 1 trees with only one opening target", () => {
  const project = { id: "project", kind: "project", projectId: "p" };
  expect(decodeTreeSnapshot({ nodes: [project] }).nodes).toEqual([project]);
  const actionable = { ...project, actionId: "open-coordinator" };
  expect(decodeTreeSnapshot({ nodes: [actionable] }).nodes).toEqual([actionable]);
  const conversation = { ...project, threadId: "coordinator" };
  expect(decodeTreeSnapshot({ nodes: [conversation] }).nodes).toEqual([conversation]);
  expect(() =>
    decodeTreeSnapshot({ nodes: [{ ...conversation, actionId: "open-coordinator" }] }),
  ).toThrow();
  for (const actionId of ["", 1, "x".repeat(201)]) {
    expect(() => decodeTreeSnapshot({ nodes: [{ ...project, actionId }] })).toThrow();
  }
});

it("advertises native tree conversations independently of API 1's existing native tree support", () => {
  const feature = "ui.native-tree-conversations";
  expect(pluginCompatibility({ capabilities: ["ui.native-trees", feature] }).available).toBe(true);
  expect(pluginCompatibility({ capabilities: ["ui.native-tree-actions"] }).available).toBe(false);
});

it("accepts exactly one initial text or first-message brief when creating a plugin thread", () => {
  const request = { projectId: "p", idempotencyKey: "create" };
  expect(decodeThreadCreate({ ...request, text: "Start now" })).toMatchObject({
    text: "Start now",
  });
  expect(decodeThreadCreate({ ...request, brief: "Help with this project" })).toMatchObject({
    brief: "Help with this project",
  });
  expect(decodeThreadCreate({ ...request, brief: "x".repeat(4_000) })).toHaveProperty("brief");
  for (const content of [
    {},
    { text: "Start", brief: "Brief" },
    { brief: "" },
    { brief: "x".repeat(4_001) },
  ]) {
    expect(() => decodeThreadCreate({ ...request, ...content })).toThrow();
  }
});

it("decodes additive workflow choices, bounded native trees and historical card references", () => {
  expect(
    decodeThreadCreate({
      projectId: "p",
      text: "start",
      idempotencyKey: "one",
      modelSelection: {
        instanceId: "codex",
        model: "custom",
        options: { reasoningEffort: "high" },
      },
      runtimeMode: "auto",
      interactionMode: "plan",
      workspaceStrategy: { type: "worktree", baseRef: "HEAD", branch: "task/test" },
    }),
  ).toMatchObject({ workspaceStrategy: { type: "worktree" }, modelSelection: { model: "custom" } });
  expect(
    decodeTreeSnapshot({
      nodes: [
        { id: "project", kind: "project", projectId: "p" },
        { id: "thread", parentId: "project", kind: "thread", threadId: "t" },
      ],
    }).nodes,
  ).toHaveLength(2);
  expect(
    decodeCardReference({
      installationId: "test.plugin",
      generation: "one",
      dataOwner: "owner",
      viewId: "card",
      summary: "Historical proposal",
      data: { planId: "one" },
    }).data,
  ).toEqual({ planId: "one" });
  expect(() => decodeCardReference({ viewId: "card", summary: "unowned" })).toThrow();
});

describe("plugin wire compatibility", () => {
  it("keeps optional retained card ownership without requiring it from older hosts", () => {
    expect(decodeCatalogue({ installations: [installation] }).installations[0]).not.toHaveProperty(
      "dataOwner",
    );
    expect(
      decodeCatalogue({
        installations: [{ ...installation, dataOwner: "retained-owner" }],
      }).installations[0],
    ).toMatchObject({ installationId: "test.plugin", dataOwner: "retained-owner" });
  });

  it("keeps known catalogue features when a newer host adds capabilities and placements", () => {
    const catalogue = decodeCatalogue({
      installations: [
        installation,
        { ...installation, installationId: "future.plugin", status: "future-status" },
        { ...installation, source: { kind: "future-source" } },
        { ...installation, manifest: { ...manifest, apiVersion: 2 } },
        {
          ...installation,
          manifest: { ...manifest, settings: [{ key: "future", label: "Future", type: "future" }] },
        },
      ],
    });
    expect(catalogue.installations).toHaveLength(1);
    expect(catalogue.installations[0]?.manifest.capabilities).toEqual([
      "storage",
      "future.capability",
    ]);
    expect(catalogue.installations[0]?.grants.capabilities).toEqual(["storage"]);
    expect(catalogue.installations[0]?.manifest.actions[0]?.placements).toEqual(["palette"]);
    expect(catalogue.installations[0]?.manifest.views.map((view) => view.id)).toEqual(["known"]);
    expect(decodeCatalogue(encodeCatalogue(catalogue))).toEqual(catalogue);
  });

  it("still validates author manifests strictly", () => {
    expect(() => decodeManifest(manifest)).toThrow();
  });

  it("drops only sidebar views that use rules from a newer host", () => {
    const projects = { id: "projects", title: "Projects", groupBy: "project", quietAfterDays: 3 };
    const decoded = decodeCatalogue({
      installations: [
        {
          ...installation,
          manifest: {
            ...manifest,
            sidebarViews: [projects, { id: "tags", title: "Tags", groupBy: "future-grouping" }],
          },
        },
      ],
    }).installations[0];
    expect(decoded?.manifest.sidebarViews).toEqual([projects]);
    expect(decoded?.manifest.views.map((view) => view.id)).toEqual(["known"]);
  });

  it("lets a client ignore contribution kinds it does not know", () => {
    // How a client from before sidebar views reads a newer installation.
    const decoded = decodeCatalogue({
      installations: [
        { ...installation, manifest: { ...manifest, futureContribution: [{ id: "x" }] } },
      ],
    }).installations[0];
    expect(decoded?.installationId).toBe("test.plugin");
    expect(decoded?.manifest).not.toHaveProperty("futureContribution");
  });

  it("validates sidebar view rules strictly in author manifests", () => {
    const author = {
      ...manifest,
      capabilities: ["ui.sidebar-views"],
      actions: [],
      views: [],
    };
    expect(
      decodeManifest({
        ...author,
        sidebarViews: [{ id: "projects", title: "Projects", groupBy: "project" }],
      }).sidebarViews,
    ).toEqual([{ id: "projects", title: "Projects", groupBy: "project" }]);
    for (const view of [
      { id: "projects", title: "Projects", groupBy: "future-grouping" },
      { id: "projects", title: "Projects", groupBy: "project", quietAfterDays: 0 },
      { id: "projects", title: "", groupBy: "project" },
    ]) {
      expect(() => decodeManifest({ ...author, sidebarViews: [view] })).toThrow();
    }
  });

  it("validates thread status icons strictly in author manifests", () => {
    const author = { ...manifest, capabilities: ["ui"], actions: [], views: [] };
    const status = { id: "realm", title: "Realm" };
    expect(
      decodeManifest({ ...author, threadStatus: [status] }).threadStatus?.[0],
    ).not.toHaveProperty("icon");
    expect(
      decodeManifest({ ...author, threadStatus: [{ ...status, icon: "monitor" }] }).threadStatus,
    ).toEqual([{ ...status, icon: "monitor" }]);
    for (const icon of ["future-icon", "", 1]) {
      expect(() => decodeManifest({ ...author, threadStatus: [{ ...status, icon }] })).toThrow();
    }
  });

  it("keeps a thread status whose icon comes from a newer host, with the default glyph", () => {
    const catalogue = decodeCatalogue({
      installations: [
        {
          ...installation,
          manifest: {
            ...manifest,
            threadStatus: [
              { id: "realm", title: "Realm", icon: "future-icon" },
              { id: "desk", title: "Desk", icon: "monitor" },
            ],
          },
        },
      ],
    });
    const statuses = catalogue.installations[0]?.manifest.threadStatus;
    expect(statuses).toEqual([
      { id: "realm", title: "Realm" },
      { id: "desk", title: "Desk", icon: "monitor" },
    ]);
    expect(statuses?.[0]).not.toHaveProperty("icon");
    expect(decodeCatalogue(encodeCatalogue(catalogue))).toEqual(catalogue);
  });

  it("preserves independent observer health and tolerant pending update manifests", () => {
    const decoded = decodeCatalogue({
      installations: [
        {
          ...installation,
          observerError: "Observer paused after a handler failure.",
          pendingUpdate: {
            manifest,
            source: installation.source,
            digest: "b".repeat(64),
            generation: "two",
            updatedAt: installation.updatedAt,
          },
        },
      ],
    }).installations[0];
    expect(decoded?.observerError).toBe("Observer paused after a handler failure.");
    expect(decoded?.status).toBe("idle");
    expect(decoded?.error).toBeNull();
    expect(decoded?.pendingUpdate?.manifest.actions[0]?.placements).toEqual(["palette"]);
  });

  it("preserves known intents and counts unsupported intents across repeated wire round trips", () => {
    const decoded = decodeResult({
      message: "Already performed the action",
      intents: [
        { type: "composer.insert", text: "hello" },
        { type: "future.intent", payload: "ignored" },
        { type: "preview.open", url: "https://example.com" },
      ],
      unsupportedIntentCount: 2,
    });
    expect(decoded).toEqual({
      message: "Already performed the action",
      intents: [
        { type: "composer.insert", text: "hello" },
        { type: "preview.open", url: "https://example.com" },
      ],
      unsupportedIntentCount: 3,
    });
    const encoded = Schema.encodeSync(resultCodec)(decoded);
    expect(decodeResult(encoded)).toEqual(decoded);
    expect(decodeResult(Schema.encodeSync(resultCodec)(decodeResult(encoded)))).toEqual(decoded);
    expect(decodeResult({ intents: [{ type: "future.intent" }] })).toEqual({
      intents: [],
      unsupportedIntentCount: 1,
    });
    expect(decodeResult({ intents: [] })).toEqual({ intents: [] });
    expect(decodeResult({ unsupportedIntentCount: 1 })).toEqual({ unsupportedIntentCount: 1 });
  });

  it("rejects malformed known intents, invalid metadata and excessive intent counts", () => {
    for (const raw of [
      { intents: [{ type: "composer.insert", text: false }] },
      { intents: [{ type: "preview.open", url: "file:///secret" }] },
      { intents: [{ payload: "missing tag" }] },
      { unsupportedIntentCount: -1 },
      { unsupportedIntentCount: 0.5 },
      { intents: Array.from({ length: 21 }, () => ({ type: "future.intent" })) },
    ]) {
      expect(() => decodeResult(raw)).toThrow();
    }
  });
});

it("distinguishes unsupported required capabilities from degrading optional features", () => {
  const required = {
    capabilities: ["storage", "future.required"],
    optionalCapabilities: ["future.optional", "storage"],
  };
  expect(pluginCompatibility(required)).toEqual({
    available: false,
    missingCapabilities: ["future.required"],
  });
  expect(pluginCompatibility({ capabilities: ["storage"] })).toEqual({
    available: true,
    missingCapabilities: [],
  });
  expect(pluginRequestedCapabilities(required)).toEqual([
    "storage",
    "future.required",
    "future.optional",
  ]);
});

it("retains recovery metadata and unknown error codes without adding status values", () => {
  const decoded = decodeCatalogue({
    executionDisabled: true,
    unavailable: { message: "Catalogue unavailable" },
    installations: [
      {
        ...installation,
        recordIssue: "newer",
        compatibility: { available: false, missingCapabilities: ["future.required"] },
        attention: {
          kind: "future-attention",
          message: "Update this host",
          since: installation.updatedAt,
        },
        recovery: {
          activeSource: "local-repair",
          previous: { version: "0.9.0", digest: "b".repeat(64), source: installation.source },
        },
      },
    ],
  });
  expect(decoded.executionDisabled).toBe(true);
  expect(decoded.installations[0]?.recordIssue).toBe("newer");
  expect(decoded.installations[0]?.recovery?.previous?.version).toBe("0.9.0");
  expect(decodeCatalogue(encodeCatalogue(decoded))).toEqual(decoded);
  const error = decodePluginError({
    _tag: "PluginError",
    reason: "future_reason",
    message: "New host explanation",
    code: "future_code",
  });
  expect(error.reason).toBe("future_reason");
  expect(error.message).toBe("New host explanation");
  expect(error.code).toBe("future_code");
});

it("requires installation-management scopes for recovery mutations and read scope for backlog inspection", () => {
  for (const method of [
    WS_METHODS.pluginsPrepareRepair,
    WS_METHODS.pluginsStageRepair,
    WS_METHODS.pluginsUsePrevious,
  ])
    expect(clientRpcRequiredScopes(method, {})).toEqual([
      AuthAccessWriteScope,
      AuthTerminalOperateScope,
    ]);
  expect(clientRpcRequiredScopes(WS_METHODS.pluginsBacklog, {})).toEqual([
    AuthOrchestrationReadScope,
  ]);
});

it("protects contribution reads with read authority and keeps unknown required feature names incompatible", () => {
  for (const method of [
    WS_METHODS.pluginsReadTree,
    WS_METHODS.pluginsSubscribeChanges,
    WS_METHODS.pluginsReadCardView,
  ])
    expect(clientRpcRequiredScopes(method, {})).toEqual([AuthOrchestrationReadScope]);
  expect(
    pluginCompatibility({
      capabilities: ["ui.native-trees", "ui.conversation-cards", "ui.changes", "worktrees.create"],
    }).available,
  ).toBe(true);
  expect(pluginCompatibility({ capabilities: ["ui.native-trees", "ui.future-required"] })).toEqual({
    available: false,
    missingCapabilities: ["ui.future-required"],
  });
});

it("keeps query feature requirements outside the frozen v1 catalogue and accepts optional grouping metadata", () => {
  const frozenCapabilities = new Set([
    "storage",
    "settings",
    "threads.read",
    "threads.send",
    "threads.create",
    "events.run-finalized",
    "ui",
    "ui.sidebar-views",
  ]);
  const queryOnly = decodeManifest({
    ...manifest,
    capabilities: ["threads.read", "workflow.query"],
    actions: [],
    views: [],
  });
  expect(
    queryOnly.capabilities.filter((capability) => !frozenCapabilities.has(capability)),
  ).toEqual(["workflow.query"]);
  expect(pluginCompatibility(queryOnly).available).toBe(true);
  const metadata = {
    id: "t",
    projectId: "p",
    title: "Task",
    modelSelection: { instanceId: "codex", model: "test" },
    runtimeMode: "auto",
    interactionMode: "default",
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    branch: null,
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "t" },
  };
  const decode = decodeThreadMetadata;
  expect(decode(metadata)).not.toHaveProperty("creationSource");
  expect(
    decode({
      ...metadata,
      creationSource: "future-source",
      isRunning: true,
      needsAttention: false,
    }),
  ).toMatchObject({ creationSource: "future-source", isRunning: true, needsAttention: false });
  expect(() => decode({ ...metadata, creationSource: "x".repeat(129) })).toThrow();
});

it("preserves an optional target thread on view.open while accepting old intents", () => {
  expect(
    decodeResult({ intents: [{ type: "view.open", viewId: "overview", threadId: "coordinator" }] })
      .intents,
  ).toEqual([{ type: "view.open", viewId: "overview", threadId: "coordinator" }]);
  expect(decodeResult({ intents: [{ type: "view.open", viewId: "overview" }] }).intents).toEqual([
    { type: "view.open", viewId: "overview" },
  ]);
});
