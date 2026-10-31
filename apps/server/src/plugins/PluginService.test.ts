// @effect-diagnostics nodeBuiltinImport:off -- a disposable loopback WS fixture exercises real transport authorization.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthTerminalOperateScope,
  AuthSessionId,
  WS_METHODS,
  WsRpcGroup,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  PluginError,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ApplicationStoredEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type PluginManifest,
  type PluginCapability,
  type PluginInstallation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as Option from "effect/Option";
import { ServerActivation } from "../serverActivation.ts";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Config from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { PluginExecutionPolicy } from "./PluginExecutionPolicy.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as Database from "./PluginDatabase.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Receipts from "./PluginReceipts.ts";
import * as CoreReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Store from "./PluginStore.ts";
import * as Service from "./PluginService.ts";
import * as Host from "./PluginHost.ts";
import * as Supervisor from "./PluginSupervisor.ts";
import * as Source from "./pluginSource.ts";
import * as Git from "./PluginGitSource.ts";
import * as Delivery from "./PluginEventDelivery.ts";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcServer from "effect/rpc/RpcServer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as HttpServer from "effect/http/HttpServer";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as Sessions from "../auth/SessionStore.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RpcHandlers from "./PluginRpcHandlers.ts";
import { rpcInstrumentationLayer } from "../observability/RpcInstrumentation.ts";
import { pluginPermissionDenied, type PluginActor } from "./PluginAuthority.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const projectId = ProjectId.make("project:plugin-test");
const threadId = ThreadId.make("thread:plugin-test");
const stamp = "2026-10-22T12:00:00.000Z";
const at = DateTime.makeUnsafe(stamp);
const actor: PluginActor = {
  principalId: "client:test",
  source: "client",
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
  runtimeMode: "full-access",
};
const manifest: PluginManifest = {
  id: "test.workflow",
  name: "Test workflow",
  version: "1.0.0",
  apiVersion: 1,
  entry: "plugin.mjs",
  capabilities: [
    "storage",
    "settings",
    "threads.read",
    "threads.send",
    "threads.create",
    "events.run-finalized",
    "ui",
  ],
  actions: [
    { id: "review", title: "Review", placements: ["palette"], agentCallable: true },
    { id: "private", title: "Private", placements: [] },
  ],
  views: [{ id: "board", title: "Board", entry: "view.html", placement: "page" }],
  threadStatus: [{ id: "lane", title: "Lane" }],
  settings: [
    { key: "token", label: "Token", type: "secret" },
    { key: "auto", label: "Automatic", type: "boolean", default: false },
  ],
};
const shell = v2PullRequestThread({
  id: threadId,
  projectId,
  title: "Plugin test",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestUserMessageAt: null,
  createdAt: stamp,
  updatedAt: stamp,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
});
const run: OrchestrationV2Run = {
  id: RunId.make("run:plugin-test"),
  threadId,
  ordinal: 1,
  providerInstanceId: shell.providerInstanceId,
  modelSelection: shell.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("message:user"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: at,
  startedAt: at,
  completedAt: at,
  checkpointId: null,
  contextHandoffId: null,
};

const base = (home?: string) => {
  const common = Layer.mergeAll(
    NodeServices.layer,
    Sqlite.layerMemory,
    Config.layerTest(process.cwd(), home ?? { prefix: "plugin-service-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );
  return Database.layer.pipe(Layer.provideMerge(common));
};
const makeFixture = Effect.fn("PluginServiceTest.fixture")(function* (realWorker = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "plugin-source-" });
  yield* fs.writeFileString(path.join(directory, "t3-plugin.json"), yield* encodeJson(manifest));
  yield* fs.writeFileString(path.join(directory, "plugin.mjs"), "export function activate() {}\n");
  yield* fs.writeFileString(path.join(directory, "view.html"), "<!doctype html><p>Board</p>");
  const calls: Array<Supervisor.PluginExecutionInput> = [];
  const commands: Array<Threads.ThreadManagementSendInput> = [];
  const launches: Array<Launch.ThreadLaunchInput> = [];
  const limits: Array<unknown> = [];
  const stopped: Array<string> = [];
  let stopEntered: Deferred.Deferred<void> | undefined;
  let stopBarrier: Deferred.Deferred<void> | undefined;
  let afterUpdate: (() => Effect.Effect<void>) | undefined;
  let beforeUpdate: (() => Effect.Effect<void>) | undefined;
  let beforeRead: (() => Effect.Effect<void>) | undefined;
  let projectExists = true;
  let projectIdentity: { readonly title?: string; readonly workspaceRoot?: string } = {};
  const lifecycleCommands: OrchestrationV2ServerCommand[] = [];
  const shellReads: Array<string> = [];
  const metadataReads: Array<ThreadId> = [];
  let metadataReadFailure: ThreadId | undefined;
  let beforeMetadata: (() => Effect.Effect<void>) | undefined;
  const threadShells = new Map<ThreadId, OrchestrationV2ThreadShell | null>();
  let gitCheckout: Git.PluginGitSource["Service"]["checkout"] = (source) =>
    Effect.succeed({ directory, source: { ...source, ref: source.ref ?? "a".repeat(40) } });
  let latest = 40;
  let hostOperation: Supervisor.PluginHostCall | undefined;
  let handler: (
    input: Supervisor.PluginExecutionInput,
    host: Supervisor.PluginHostCall,
  ) => Effect.Effect<Supervisor.PluginWorkerOutput, PluginError> = () =>
    Effect.succeed({ message: "done" });
  let sendBarrier: Deferred.Deferred<void> | undefined;
  let sendEntered: Deferred.Deferred<void> | undefined;
  const stored: Array<OrchestrationV2StoredEvent> = [];
  const reads: Array<number> = [];
  let live: Events.OrchestrationEventStore["Service"]["streamApplicationEvents"] = () =>
    Stream.never;
  const eventLayer = Layer.mock(Events.OrchestrationEventStore)({
    latestApplicationSequence: Effect.sync(() => latest),
    readAgentEvents: (input) =>
      Stream.unwrap(
        Effect.sync(() => {
          reads.push(input?.afterSequence ?? 0);
          return Stream.fromIterable(
            stored.filter(
              (event) =>
                event.sequence > (input?.afterSequence ?? 0) &&
                event.sequence <= (input?.throughSequence ?? latest),
            ),
          );
        }),
      ),
    streamApplicationEvents: (input) => live(input),
  });
  const domainLayer = Layer.mock(Threads.ThreadManagementService)({
    dispatchAuthorized: (command, authorize) =>
      Effect.gen(function* () {
        if (!(yield* authorize)) return null;
        const current = threadShells.get(command.threadId) ?? shell;
        threadShells.set(
          command.threadId,
          command.type === "thread.unarchive"
            ? { ...current, archivedAt: null }
            : {
                ...current,
                ...(command.pluginOwner === undefined ? {} : { pluginOwner: command.pluginOwner }),
              },
        );
        lifecycleCommands.push(command);
        return { sequence: 1, storedEvents: [] };
      }),
    getThreadRecords: (id) =>
      Effect.sync(() => ({
        thread: { ...(threadShells.get(id) ?? shell), lastVisitedAt: null },
        runs: [],
        messages: [],
        turnItems: [],
        attempts: [],
        nodes: [],
        subagents: [],
        providerSessions: [],
        providerThreads: [],
        providerTurns: [],
        runtimeRequests: [],
        plans: [],
        checkpointScopes: [],
        checkpoints: [],
        contextHandoffs: [],
        contextTransfers: [],
        visibleTurnItems: [],
        updatedAt: shell.updatedAt,
      })),
    getThreadMetadata: (id) =>
      Effect.gen(function* () {
        const before = beforeMetadata;
        beforeMetadata = undefined;
        yield* before?.() ?? Effect.void;
        metadataReads.push(id);
        if (metadataReadFailure === id) {
          metadataReadFailure = undefined;
          return yield* new OrchestratorProjectionError({ threadId: id });
        }
        const thread = threadShells.has(id) ? (threadShells.get(id) ?? null) : shell;
        return thread === null ? null : { lineage: thread.lineage, deletedAt: thread.deletedAt };
      }),
    getThreadShell: (id) =>
      Effect.sync(() => {
        shellReads.push(id);
        return threadShells.has(id) ? (threadShells.get(id) ?? null) : shell;
      }),
    sendToThread: (input) =>
      Effect.gen(function* () {
        limits.push(yield* DispatchModeLimit);
        commands.push(input);
        if (sendEntered) yield* Deferred.succeed(sendEntered, undefined);
        if (sendBarrier) yield* Deferred.await(sendBarrier);
        const message = {
          id: input.messageId,
          threadId,
          runId: run.id,
          nodeId: null,
          role: "user" as const,
          text: input.text,
          attachments: [],
          streaming: false,
          createdAt: at,
          updatedAt: at,
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        };
        return {
          dispatch: { sequence: 1, storedEvents: [] },
          projection: {
            thread: { ...shell, lastVisitedAt: null },
            runs: [run],
            messages: [message],
            turnItems: [],
          },
          message,
          run,
          turnItem: null,
          delivery: "queued" as const,
        };
      }),
  });
  const layer = Service.layer.pipe(
    Layer.provideMerge(Host.layer),
    Layer.provideMerge(
      Layer.effect(
        Store.PluginStore,
        Effect.map(Store.PluginStore, (store) =>
          Store.PluginStore.of({
            ...store,
            read: Effect.suspend(() => {
              const before = beforeRead;
              beforeRead = undefined;
              return (before?.() ?? Effect.void).pipe(Effect.andThen(store.read));
            }),
            tryUpdate: (f) =>
              Effect.suspend(() => {
                const before = beforeUpdate;
                beforeUpdate = undefined;
                return (before?.() ?? Effect.void).pipe(
                  Effect.andThen(store.tryUpdate(f)),
                  Effect.tap((result) =>
                    Option.isSome(result) ? (afterUpdate?.() ?? Effect.void) : Effect.void,
                  ),
                );
              }),
            update: (f) =>
              Effect.suspend(() => {
                const before = beforeUpdate;
                beforeUpdate = undefined;
                return (before?.() ?? Effect.void).pipe(
                  Effect.andThen(store.update(f)),
                  Effect.tap(() => afterUpdate?.() ?? Effect.void),
                );
              }),
          }),
        ),
      ).pipe(Layer.provide(Store.layer)),
    ),
    Layer.provideMerge(Receipts.layer),
    Layer.provideMerge(
      realWorker
        ? Supervisor.layer.pipe(
            Layer.provide(
              Layer.succeed(Supervisor.PluginRuntimeConfig, {
                selfInvocation: {
                  command: process.execPath,
                  entrypoint: path.join(import.meta.dirname, "../bin.ts"),
                },
                startupTimeoutMs: 10000,
                invocationTimeoutMs: 10000,
                cancelGraceMs: 500,
                stopGraceMs: 500,
                restartBackoffMs: 0,
                maxFailures: 3,
              }),
            ),
          )
        : Layer.succeed(Supervisor.PluginSupervisor, {
            invoke: (input, host, admission = Effect.void) =>
              admission.pipe(
                Effect.andThen(() => {
                  calls.push(input);
                  hostOperation = host;
                  return handler(input, host);
                }),
              ),
            stop: (id) =>
              Effect.gen(function* () {
                stopped.push(id);
                if (stopEntered) yield* Deferred.succeed(stopEntered, undefined);
                if (stopBarrier) yield* Deferred.await(stopBarrier);
              }),
            resume: () => Effect.void,
          }),
    ),
    Layer.provide(
      Layer.succeed(Git.PluginGitSource, { checkout: (source) => gitCheckout(source) }),
    ),
    Layer.provide(domainLayer),
    Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
    Layer.provide(
      Layer.mock(Launch.ThreadLaunchService)({
        launch: (input) =>
          Effect.sync(() => {
            launches.push(input);
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new Launch.ThreadLaunchError({
                  operation: "create-thread",
                  projectId,
                  commandId: CommandId.make("fixture"),
                  cause: "fixture stops before starting a provider",
                }),
              ),
            ),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(Projects.ProjectService)({
        getIdentity: () =>
          Effect.sync(() =>
            projectExists
              ? Option.some({ title: "Test", workspaceRoot: directory, ...projectIdentity })
              : Option.none(),
          ),
        getShell: (id) =>
          Effect.succeed(
            projectExists
              ? Option.some({
                  id,
                  title: "Test",
                  workspaceRoot: directory,
                  defaultModelSelection: shell.modelSelection,
                  scripts: [],
                  createdAt: stamp,
                  updatedAt: stamp,
                  ...projectIdentity,
                })
              : Option.none(),
          ),
      }),
    ),
    Layer.provide(Settings.layerTest({ defaultRuntimeMode: "approval-required" })),
    Layer.provide(eventLayer),
  );
  const context = yield* Layer.build(layer);
  const plugins = Context.get(context, Service.PluginService);
  const store = Context.get(context, Store.PluginStore);
  const host = Context.get(context, Host.PluginHost);
  const install = () => plugins.install({ source: { kind: "local", directory } });
  const enable = Effect.fn("test.enable")(function* (extra: ReadonlyArray<PluginCapability> = []) {
    const item = yield* install();
    return yield* plugins.consent({
      installationId: item.installationId,
      digest: item.digest,
      grants: {
        capabilities: [
          "storage",
          "settings",
          "threads.read",
          "threads.send",
          "threads.create",
          "events.run-finalized",
          "ui",
          ...extra,
        ],
        projectIds: [projectId],
      },
    });
  });
  return {
    plugins,
    store,
    host,
    context,
    fs,
    path,
    directory,
    install,
    enable,
    setProjectExists: (value: boolean) => {
      projectExists = value;
    },
    setProjectIdentity: (value: typeof projectIdentity) => {
      projectIdentity = value;
    },
    calls,
    commands,
    launches,
    limits,
    stopped,
    stored,
    reads,
    shellReads,
    metadataReads,
    supervisor: Context.get(context, Supervisor.PluginSupervisor),
    beforeMetadata: (hook: () => Effect.Effect<void>) => {
      beforeMetadata = hook;
    },
    failMetadataReadOnce: (id: ThreadId) => {
      metadataReadFailure = id;
    },
    threadShells,
    lifecycleCommands,
    eventLayer,
    domainLayer,
    setLive: (stream: typeof live) => {
      live = stream;
    },
    setGitCheckout: (checkout: typeof gitCheckout) => {
      gitCheckout = checkout;
    },
    setLatest: (value: number) => {
      latest = value;
    },
    setHandler: (value: typeof handler) => {
      handler = value;
    },
    beforeUpdate: (hook: typeof beforeUpdate) => {
      beforeUpdate = hook;
    },
    beforeRead: (hook: typeof beforeRead) => {
      beforeRead = hook;
    },
    afterUpdate: (hook: typeof afterUpdate) => {
      afterUpdate = hook;
    },
    hostOperation: () => hostOperation,
    blockStop: (entered: Deferred.Deferred<void>, barrier: Deferred.Deferred<void>) => {
      stopEntered = entered;
      stopBarrier = barrier;
    },
    blockSend: (entered: Deferred.Deferred<void>, barrier: Deferred.Deferred<void>) => {
      sendEntered = entered;
      sendBarrier = barrier;
    },
  };
});
const fixture = makeFixture();

it.live(
  "revoking a persisted session blocks a late effect across real WS, service and worker IPC",
  () =>
    Effect.gen(function* () {
      const f = yield* makeFixture(true);
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "plugin.mjs"),
        `
      export function activate(ctx) {
        let release, rejection;
        ctx.handle("action:private", input => {
          if (input === "report") return {data: rejection};
          release(); return {};
        });
        ctx.handle("action:review", async () => {
          const gate = new Promise(resolve => { release = resolve; });
          await ctx.storage.set("entered", true);
          await gate;
          try { await ctx.threads.send({threadId: ${JSON.stringify(threadId)}, text: "Must not dispatch", idempotencyKey: "late"}); }
          catch (error) { rejection = error.reason; }
          return {};
        });
      }
    `,
      );
      const enabled = yield* f.enable();
      const sessions = Context.get(
        yield* Layer.build(
          Sessions.layer.pipe(
            Layer.provide(Secrets.layer),
            Layer.provide(
              Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(EnvironmentId.make("plugin-ws-fixture")),
              }),
            ),
          ),
        ),
        Sessions.SessionStore,
      );
      const session = yield* sessions.issue({ subject: "plugin-ws-fixture", scopes: actor.scopes });
      const credential = yield* sessions.socketCredential(session.sessionId);
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"],
            typeof WS_METHODS.pluginsInvoke
          > => tag !== WS_METHODS.pluginsInvoke,
        ),
      );
      const http = Context.get(
        yield* Layer.build(
          NodeHttpServer.layer(NodeHttp.createServer, {
            host: "127.0.0.1",
            port: 0,
          }),
        ),
        HttpServer.HttpServer,
      );
      const handler = yield* RpcServer.toHttpEffectWebsocket(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            RpcHandlers.layer(actor, credential).pipe(
              Layer.provide(Layer.succeed(Service.PluginService, f.plugins)),
            ),
            rpcInstrumentationLayer,
            RpcAuthorization.layer(actor.scopes),
            RpcSerialization.layerJson,
          ),
        ),
      );
      yield* http.serve(handler);
      if (http.address._tag === "UnixPathAddress")
        return yield* Effect.die("Expected loopback TCP fixture");
      const protocol = yield* Layer.build(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(NodeSocket.layerWebSocket(`ws://127.0.0.1:${http.address.port}/rpc`)),
          Layer.provide(RpcSerialization.layerJson),
        ),
      );
      const client = yield* RpcClient.make(group).pipe(Effect.provideContext(protocol));
      const entered = yield* Deferred.make<void>();
      f.afterUpdate(() => Deferred.succeed(entered, undefined));
      const pending = yield* client[WS_METHODS.pluginsInvoke]({
        installationId: enabled.installationId,
        generation: enabled.generation,
        handler: "action:review",
        operationId: "revoked-session",
      }).pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      f.afterUpdate(undefined);
      expect(yield* sessions.revoke(session.sessionId)).toBe(true);
      yield* f.plugins.invoke(
        {
          installationId: enabled.installationId,
          generation: enabled.generation,
          handler: "action:private",
          operationId: "release-from-authorized-client",
        },
        actor,
      );
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "permission_denied" },
      });
      expect(f.commands).toEqual([]);
      expect(
        (yield* f.plugins.invoke(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            handler: "action:private",
            operationId: "inspect-host-rejection",
            input: "report",
          },
          actor,
        )).data,
      ).toBe("permission_denied");
      expect((yield* f.store.read).installations[0]?.storage.entered).toBe(true);
      expect((yield* sessions.assertActive(session.sessionId).pipe(Effect.flip))._tag).toBe(
        "SessionCredentialVerificationError",
      );
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.live("rejects hostile trees and cards from real IPC and keeps the same worker usable", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture(true);
    const extended: PluginManifest = {
      ...manifest,
      capabilities: [...manifest.capabilities, "ui.native-trees", "ui.conversation-cards"],
      nativeTrees: [{ id: "hostile", title: "Hostile fixture" }],
      views: [
        ...manifest.views,
        { id: "card", title: "Card", entry: "view.html", placement: "conversation" },
      ],
    };
    yield* f.fs.writeFileString(
      f.path.join(f.directory, "t3-plugin.json"),
      yield* encodeJson(extended),
    );
    yield* f.fs.writeFileString(
      f.path.join(f.directory, "plugin.mjs"),
      `
      export function activate(ctx) {
        let mode = "healthy";
        ctx.handle("action:review", input => {
          mode = input;
          if (mode === "card") return {card: {viewId: "card", summary: "Bounded fixture", data: "😀".repeat(600)}};
          return {data: process.pid};
        });
        ctx.trees.register("hostile", () => {
          if (mode === "cycle") return {nodes: [{id: "a", kind: "group", title: "A", parentId: "b"}, {id: "b", kind: "group", title: "B", parentId: "a"}]};
          if (mode === "depth") return {nodes: Array.from({length: 17}, (_, i) => ({id: String(i), kind: "group", title: "Group", ...(i ? {parentId: String(i - 1)} : {})}))};
          if (mode === "nodes") return {nodes: Array.from({length: 2001}, (_, i) => ({id: String(i), kind: "group", title: "Group"}))};
          if (mode === "bytes") return {nodes: [], extra: "😀".repeat(33000)};
          return {nodes: Array.from({length: 2000}, (_, i) => ({id: String(i), kind: "group", title: "Group"}))};
        });
      }
    `,
    );
    const installed = yield* f.install();
    const enabled = yield* f.plugins.consent({
      installationId: installed.installationId,
      digest: installed.digest,
      grants: {
        capabilities: ["threads.read", "ui", "ui.native-trees", "ui.conversation-cards"],
        projectIds: [projectId],
      },
    });
    const invocation = {
      installationId: enabled.installationId,
      generation: enabled.generation,
      handler: "action:review",
    };
    const healthy = yield* f.plugins.invoke(
      { ...invocation, operationId: "healthy", input: "healthy" },
      actor,
    );
    expect(healthy.data).toBeTypeOf("number");
    const tree = {
      installationId: enabled.installationId,
      generation: enabled.generation,
      treeId: "hostile",
    };
    expect(
      (yield* f.plugins.readTree({ ...tree, operationId: "max-valid" }, actor)).nodes,
    ).toHaveLength(2000);
    for (const mode of ["cycle", "depth", "nodes", "bytes", "card"]) {
      const selected = yield* f.plugins
        .invoke({ ...invocation, operationId: `select-${mode}`, input: mode }, actor)
        .pipe(Effect.result);
      const invalid =
        mode === "card"
          ? selected
          : yield* f.plugins
              .readTree({ ...tree, operationId: `reject-${mode}` }, actor)
              .pipe(Effect.result);
      expect(invalid).toMatchObject({ _tag: "Failure", failure: { reason: "invalid_result" } });
      expect(
        (yield* f.plugins.invoke(
          { ...invocation, operationId: `recover-${mode}`, input: "healthy" },
          actor,
        )).data,
      ).toBe(healthy.data);
      expect((yield* f.plugins.list()).installations[0]).toMatchObject({
        status: "idle",
        error: null,
      });
    }
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.live.each(["disable", "revoke", "generation"] as const)(
  "a real worker cannot dispatch a late host effect after a service %s transition",
  (transition) =>
    Effect.gen(function* () {
      const f = yield* makeFixture(true);
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "plugin.mjs"),
        `
      export function activate(ctx) {
        ctx.handle("action:review", async (_, invocation) => {
          const canceled = new Promise(resolve => invocation.signal.addEventListener("abort", resolve, {once: true}));
          await ctx.storage.set("entered", true);
          await canceled;
          try { await ctx.threads.send({threadId: ${JSON.stringify(threadId)}, text: "Must not dispatch", idempotencyKey: "late"}); }
          catch { return {message: "revoked"}; }
          throw new Error("Late authority survived");
        });
      }
    `,
      );
      const enabled = yield* f.enable();
      const entered = yield* Deferred.make<void>();
      f.afterUpdate(() => Deferred.succeed(entered, undefined));
      const pending = yield* f.plugins
        .invoke(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            handler: "action:review",
            operationId: "transition",
          },
          actor,
        )
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      f.afterUpdate(undefined);
      const current =
        transition === "disable"
          ? yield* f.plugins.setEnabled({ installationId: enabled.installationId, enabled: false })
          : yield* f.plugins.consent({
              installationId: enabled.installationId,
              digest: enabled.digest,
              grants:
                transition === "revoke" ? { capabilities: [], projectIds: [] } : enabled.grants,
            });
      expect(current.generation).not.toBe(enabled.generation);
      expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "Failure" });
      expect(f.commands).toEqual([]);
      expect((yield* f.store.read).installations[0]?.storage.entered).toBe(true);
      expect((yield* f.plugins.list()).installations[0]?.generation).toBe(current.generation);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.live.each(
  (["lineage", "snapshot"] as const).flatMap((preflight) =>
    (["healthy", "disable", "re-enable", "generation", "update", "remove", "session"] as const).map(
      (change) => ({ preflight, change }),
    ),
  ),
)(
  "does not start a worker revoked during $preflight preflight ($change)",
  ({ preflight, change }) =>
    Effect.gen(function* () {
      const f = yield* makeFixture(true);
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "plugin.mjs"),
        `
      import { writeFile } from "node:fs/promises";
      import { join } from "node:path";
      export async function activate(ctx) {
        await writeFile(join(ctx.dataDirectory, "activated"), "started");
        ctx.handle("action:review", () => ({message: "healthy"}));
      }
    `,
      );
      const enabled = yield* f.enable();
      const marker = f.path.join(f.store.directory, "data", enabled.installationId, "activated");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const pause = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      using spies = new DisposableStack();
      if (preflight === "lineage") f.beforeMetadata(() => pause);
      else {
        const verify = Source.verifyPluginSnapshot;
        spies.use(
          vi
            .spyOn(Source, "verifyPluginSnapshot")
            .mockImplementationOnce((input) => verify(input).pipe(Effect.tap(() => pause))),
        );
      }
      let revoked = false;
      const invocation = {
        installationId: enabled.installationId,
        generation: enabled.generation,
        handler: "action:review",
        operationId: "preflight",
      };
      const pending = yield* f.plugins
        .invoke(invocation, {
          ...actor,
          source: "agent",
          threadId,
          authorize: () =>
            Effect.suspend(() =>
              revoked
                ? Effect.fail(
                    new PluginError({ reason: "permission_denied", message: "Caller revoked." }),
                  )
                : Effect.void,
            ),
        })
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      let current = enabled;
      if (change === "disable" || change === "re-enable") {
        current = yield* f.plugins.setEnabled({
          installationId: enabled.installationId,
          enabled: false,
        });
        if (change === "re-enable")
          current = yield* f.plugins.setEnabled({
            installationId: enabled.installationId,
            enabled: true,
          });
      } else if (change === "generation" || change === "update") {
        let digest = enabled.digest;
        if (change === "update") {
          yield* f.fs.writeFileString(
            f.path.join(f.directory, "plugin.mjs"),
            (yield* f.fs.readFileString(f.path.join(f.directory, "plugin.mjs"))) +
              "\n// New revision.\n",
          );
          digest = (yield* f.plugins.refresh({ installationId: enabled.installationId }))
            .pendingUpdate!.digest;
        }
        current = yield* f.plugins.consent({
          installationId: enabled.installationId,
          digest,
          grants: enabled.grants,
        });
      } else if (change === "remove")
        yield* f.plugins.remove({ installationId: enabled.installationId });
      else if (change === "session") revoked = true;
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(pending);
      if (change === "healthy") {
        expect(result).toMatchObject({ _tag: "Success", success: { message: "healthy" } });
        expect(yield* f.fs.exists(marker)).toBe(true);
      } else {
        expect(result).toMatchObject({ _tag: "Failure" });
        expect(yield* f.fs.exists(marker)).toBe(false);
      }
      // A fresh generation remains usable after revoking the older preflight invocation.
      if (["re-enable", "generation", "update"].includes(change)) {
        expect(
          (yield* f.plugins.invoke(
            { ...invocation, generation: current.generation, operationId: "current" },
            actor,
          )).message,
        ).toBe("healthy");
        expect(yield* f.fs.exists(marker)).toBe(true);
      }
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.live.each(["disable", "consent", "remove", "snapshot"] as const)(
  "interruption after the %s revocation commit still stops its real worker",
  (change) =>
    Effect.gen(function* () {
      const f = yield* makeFixture(true);
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "plugin.mjs"),
        `
      export function activate(ctx) {ctx.handle("action:review", () => ({data: process.pid}));}
    `,
      );
      const enabled = yield* f.enable();
      const record = (yield* f.store.read).installations[0]!;
      yield* f.supervisor.invoke(
        {
          installationId: enabled.installationId,
          generation: enabled.generation,
          directory: f.path.resolve(f.store.directory, record.directory),
          entry: "plugin.mjs",
          dataDirectory: f.directory,
          handler: "action:review",
          operationId: "running",
          caller: { kind: "client" },
        },
        () => Effect.void,
      );
      if (change === "snapshot") {
        const entry = f.path.resolve(f.store.directory, record.directory, "plugin.mjs");
        yield* f.fs.chmod(entry, 0o600);
        yield* f.fs.writeFileString(entry, "export function activate() {}\n");
      }
      const committed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const stop = f.supervisor.stop;
      using _stop = vi
        .spyOn(f.supervisor, "stop")
        .mockImplementation((id) =>
          stop(id).pipe(Effect.tap(() => Deferred.succeed(stopped, undefined))),
        );
      f.afterUpdate(() =>
        Deferred.succeed(committed, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const transition =
        change === "disable"
          ? f.plugins.setEnabled({ installationId: enabled.installationId, enabled: false })
          : change === "consent"
            ? f.plugins.consent({
                installationId: enabled.installationId,
                digest: enabled.digest,
                grants: enabled.grants,
              })
            : change === "remove"
              ? f.plugins.remove({ installationId: enabled.installationId })
              : f.plugins.readView({
                  installationId: enabled.installationId,
                  generation: enabled.generation,
                  viewId: "board",
                });
      const pending = yield* transition.pipe(Effect.forkScoped);
      yield* Deferred.await(committed);
      const interrupting = yield* Fiber.interrupt(pending).pipe(Effect.forkScoped);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupting);
      f.afterUpdate(undefined);
      expect(yield* Deferred.isDone(stopped)).toBe(true);
      expect((yield* f.store.read).installations[0]?.installation.generation).not.toBe(
        enabled.generation,
      );
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.live("ordinary repeated catalogue contention does not pause a real run observer", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture(true);
    yield* f.fs.writeFileString(
      f.path.join(f.directory, "plugin.mjs"),
      `
      export function activate(ctx) {
        ctx.events.onRunFinalized(async event => {await ctx.storage.set("completed-event", event.deliveryId);});
      }
    `,
    );
    const enabled = yield* f.enable();
    const attempts = yield* Queue.unbounded<Deferred.Deferred<void>>();
    const tried = yield* Queue.unbounded<void>();
    const tryUpdate = f.store.tryUpdate;
    let count = 0;
    using _try = vi.spyOn(f.store, "tryUpdate").mockImplementation(function <A, E, R>(
      callback: (state: Store.PluginState) => Effect.Effect<readonly [A, Store.PluginState], E, R>,
    ) {
      return Effect.gen(function* () {
        if (++count <= 2) {
          const release = yield* Deferred.make<void>();
          yield* Queue.offer(attempts, release);
          yield* Deferred.await(release);
        }
        const result = yield* tryUpdate(callback);
        if (count <= 2) yield* Queue.offer(tried, undefined);
        return result;
      });
    });
    const pending = yield* f.plugins
      .deliver({
        installationId: enabled.installationId,
        generation: enabled.generation,
        sequence: 41,
        event: {
          deliveryId: "contended-event",
          threadId,
          projectId,
          runId: run.id,
          outcome: "completed",
        },
      })
      .pipe(Effect.result, Effect.forkScoped);
    for (const _round of [1, 2]) {
      const releaseAttempt = yield* Queue.take(attempts);
      const entered = yield* Deferred.make<void>();
      const releaseLock = yield* Deferred.make<void>();
      const owner = yield* f.store
        .update((state) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseLock)),
            Effect.as([
              undefined,
              {
                ...state,
                installations: state.installations.map((record) => ({
                  ...record,
                  eventCursor: record.eventCursor + 1,
                })),
              },
            ] as const),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Deferred.succeed(releaseAttempt, undefined);
      yield* Queue.take(tried);
      yield* Deferred.succeed(releaseLock, undefined);
      yield* Fiber.join(owner);
    }
    const result = yield* Fiber.join(pending);
    const record = (yield* f.store.read).installations[0]!;
    expect({
      result,
      observerError: record.deliveryError,
      value: record.storage["completed-event"],
    }).toMatchObject({
      result: { _tag: "Success" },
      observerError: undefined,
      value: "contended-event",
    });
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.live("two observing installations retain writes across an unrelated cursor commit", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture(true);
    yield* f.fs.writeFileString(
      f.path.join(f.directory, "plugin.mjs"),
      `
      export function activate(ctx) {
        ctx.events.onRunFinalized(async event => {await ctx.storage.set("completed-event", event.deliveryId);});
      }
    `,
    );
    const first = yield* f.enable();
    yield* f.fs.writeFileString(
      f.path.join(f.directory, "t3-plugin.json"),
      yield* encodeJson({ ...manifest, id: "test.peer", name: "Peer" }),
    );
    const peer = yield* f.install();
    const second = yield* f.plugins.consent({
      installationId: peer.installationId,
      digest: peer.digest,
      grants: first.grants,
    });
    const entered = yield* Deferred.make<void>();
    const releaseAttempt = yield* Deferred.make<void>();
    const missed = yield* Deferred.make<void>();
    const tryUpdate = f.store.tryUpdate;
    let gated = false;
    using _try = vi.spyOn(f.store, "tryUpdate").mockImplementation(function <A, E, R>(
      callback: (state: Store.PluginState) => Effect.Effect<readonly [A, Store.PluginState], E, R>,
    ) {
      if (gated) return tryUpdate(callback);
      gated = true;
      return Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(releaseAttempt)),
        Effect.andThen(tryUpdate(callback)),
        Effect.tap((result) =>
          Option.isNone(result) ? Deferred.succeed(missed, undefined) : Effect.void,
        ),
      );
    });
    const deliver = (installation: typeof first, deliveryId: string, sequence: number) =>
      f.plugins.deliver({
        installationId: installation.installationId,
        generation: installation.generation,
        sequence,
        event: { deliveryId, threadId, projectId, runId: run.id, outcome: "completed" },
      });
    const one = yield* deliver(first, "one", 41).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const cursorEntered = yield* Deferred.make<void>();
    const releaseCursor = yield* Deferred.make<void>();
    const cursor = yield* f.store
      .update((state) =>
        Deferred.succeed(cursorEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCursor)),
          Effect.as([
            undefined,
            {
              ...state,
              installations: state.installations.map((record) =>
                record.installation.installationId === second.installationId
                  ? { ...record, eventCursor: record.eventCursor + 1 }
                  : record,
              ),
            },
          ] as const),
        ),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(cursorEntered);
    const two = yield* deliver(second, "two", 42).pipe(Effect.forkScoped);
    yield* Deferred.succeed(releaseAttempt, undefined);
    yield* Deferred.await(missed);
    yield* Deferred.succeed(releaseCursor, undefined);
    yield* Fiber.join(cursor);
    yield* Fiber.join(one);
    yield* Fiber.join(two);
    const records = (yield* f.store.read).installations;
    expect(records.map((record) => record.storage["completed-event"])).toEqual(["one", "two"]);
    expect(records.map((record) => record.deliveryError)).toEqual([undefined, undefined]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each([1, 2])(
  "execution admission tolerates one catalogue change and fails closed after %s changes",
  (changes) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      let checks = 0;
      let remaining = changes;
      const result = yield* f.plugins
        .invoke(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            handler: "action:review",
            operationId: "catalogue-admission",
          },
          {
            ...actor,
            authorize: () =>
              Effect.gen(function* () {
                if (++checks < 3 || remaining === 0) return;
                remaining--;
                yield* f.store
                  .update((state) =>
                    Effect.succeed([
                      undefined,
                      {
                        ...state,
                        installations: state.installations.map((record) => ({
                          ...record,
                          eventCursor: record.eventCursor + 1,
                        })),
                      },
                    ] as const),
                  )
                  .pipe(Effect.orDie);
              }),
          },
        )
        .pipe(Effect.result);
      expect(result).toMatchObject(
        changes === 1
          ? { _tag: "Success", success: { message: "done" } }
          : { _tag: "Failure", failure: { reason: "permission_denied" } },
      );
      expect(f.calls).toHaveLength(changes === 1 ? 1 : 0);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "stages updates without stopping the working version and promotes only exact consent",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const item = yield* f.install();
      const input = {
        installationId: item.installationId,
        generation: item.generation,
        handler: "action:review",
        operationId: "review",
      };
      expect((yield* f.plugins.invoke(input, actor).pipe(Effect.flip, Effect.orDie)).reason).toBe(
        "needs_consent",
      );
      expect(
        (yield* f.plugins
          .consent({
            installationId: item.installationId,
            digest: "0".repeat(64),
            grants: { capabilities: [], projectIds: [] },
          })
          .pipe(Effect.flip, Effect.orDie)).reason,
      ).toBe("changed_source");
      const enabled = yield* f.plugins.consent({
        installationId: item.installationId,
        digest: item.digest,
        grants: { capabilities: [], projectIds: [] },
      });
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "plugin.mjs"),
        "export function activate() { throw Error('new source') }\n",
      );
      expect(
        (yield* f.plugins.invoke({ ...input, generation: enabled.generation }, actor)).message,
      ).toBe("done");
      const refreshed = yield* f.plugins.refresh({ installationId: item.installationId });
      expect(refreshed.status).toBe("idle");
      expect(refreshed.digest).toBe(item.digest);
      expect(refreshed.pendingUpdate?.digest).not.toBe(item.digest);
      yield* f.plugins.invoke({ ...input, generation: enabled.generation }, actor);
      const promoted = yield* f.plugins.consent({
        installationId: item.installationId,
        digest: refreshed.pendingUpdate!.digest,
        grants: { capabilities: [], projectIds: [] },
      });
      expect(promoted.pendingUpdate).toBeUndefined();
      expect(promoted.digest).toBe(refreshed.pendingUpdate!.digest);
      expect(
        (yield* f.plugins
          .invoke({ ...input, generation: enabled.generation }, actor)
          .pipe(Effect.flip, Effect.orDie)).reason,
      ).toBe("stale_generation");
      expect(f.stopped).toContain(item.installationId);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "never publishes secret values and retains plugin storage across default removal and reinstall",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      yield* f.plugins.updateSettings({
        installationId: enabled.installationId,
        values: { token: "private-secret", auto: true },
      });
      const invocation = {
        installationId: enabled.installationId,
        generation: enabled.generation,
        operationId: "store",
        callId: 1,
        actor,
      };
      yield* f.host.call(invocation, "storage.set", {
        key: "board",
        value: [{ text: "retained" }],
      });
      const catalogue = yield* f.plugins.list();
      expect(catalogue.installations[0]?.settings).toEqual({ auto: true });
      expect(yield* encodeJson(catalogue)).not.toContain("private-secret");
      yield* f.plugins.remove({ installationId: enabled.installationId });
      expect((yield* f.plugins.list()).installations).toEqual([]);
      const again = yield* f.enable();
      expect(
        yield* f.host.call(
          { ...invocation, installationId: again.installationId, generation: again.generation },
          "storage.get",
          { key: "board" },
        ),
      ).toEqual([{ text: "retained" }]);
      expect(
        yield* f.host.call(
          { ...invocation, installationId: again.installationId, generation: again.generation },
          "settings.get",
          { key: "token" },
        ),
      ).toBe("private-secret");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "isolates coexisting installations' settings, storage, project grants and actor ceilings",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.enable();
      const peerDirectory = yield* f.fs.makeTempDirectoryScoped({ prefix: "plugin-peer-source-" });
      yield* f.fs.writeFileString(
        f.path.join(peerDirectory, "t3-plugin.json"),
        yield* encodeJson({ ...manifest, id: "test.peer", name: "Peer workflow" }),
      );
      for (const name of ["plugin.mjs", "view.html"])
        yield* f.fs.copyFile(f.path.join(f.directory, name), f.path.join(peerDirectory, name));
      const installed = yield* f.plugins.install({
        source: { kind: "local", directory: peerDirectory },
      });
      const peer = yield* f.plugins.consent({
        installationId: installed.installationId,
        digest: installed.digest,
        grants: { capabilities: ["settings", "storage", "threads.send"], projectIds: [] },
      });
      const invocation = (item: PluginInstallation) => ({
        installationId: item.installationId,
        generation: item.generation,
        operationId: "same-operation",
        callId: 1,
        actor,
      });
      yield* Effect.forEach(
        [first, peer],
        (item, index) =>
          f.plugins
            .updateSettings({
              installationId: item.installationId,
              values: { token: `secret-${index}`, auto: index === 0 },
            })
            .pipe(
              Effect.andThen(
                f.host.call(invocation(item), "storage.set", { key: "board", value: index }),
              ),
            ),
        { concurrency: "unbounded" },
      );
      for (const [index, item] of [first, peer].entries()) {
        expect(yield* f.host.call(invocation(item), "settings.get", { key: "token" })).toBe(
          `secret-${index}`,
        );
        expect(yield* f.host.call(invocation(item), "settings.get", { key: "auto" })).toBe(
          index === 0,
        );
        expect(
          yield* f.host.call(invocation(item), "storage.get", {
            key: "board",
            installationId: index === 0 ? peer.installationId : first.installationId,
          }),
        ).toBe(index);
      }
      const request = { threadId, text: "Review", idempotencyKey: "same-key" };
      for (const limited of [
        invocation(peer),
        { ...invocation(first), actor: { ...actor, projectIds: [] } },
        { ...invocation(first), actor: { ...actor, runtimeMode: "approval-required" as const } },
        { ...invocation(first), actor: { ...actor, interactionMode: "plan" as const } },
      ]) {
        expect(
          (yield* f.host.call(limited, "threads.send", request).pipe(Effect.flip, Effect.orDie))
            .reason,
        ).toBe("permission_denied");
      }
      expect(f.commands).toHaveLength(0);
      yield* f.host.call(invocation(first), "threads.send", request);
      expect(f.commands).toHaveLength(1);
      const revoked = yield* f.plugins.consent({
        installationId: peer.installationId,
        digest: peer.digest,
        grants: { capabilities: [], projectIds: [] },
      });
      expect(
        (yield* f.host
          .call(invocation(peer), "storage.get", { key: "board" })
          .pipe(Effect.flip, Effect.orDie)).reason,
      ).toBe("stale_generation");
      expect(
        (yield* f.host
          .call(invocation(revoked), "storage.get", { key: "board" })
          .pipe(Effect.flip, Effect.orDie)).reason,
      ).toBe("permission_denied");
      expect(yield* f.host.call(invocation(first), "settings.get", { key: "token" })).toBe(
        "secret-0",
      );
      expect(yield* f.host.call(invocation(first), "storage.get", { key: "board" })).toBe(0);
      const catalogue = yield* f.plugins.list();
      expect(catalogue.installations).toHaveLength(2);
      expect(yield* encodeJson(catalogue)).not.toContain("secret-");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "rejects missing grants, forged target projects, stale actors, and reserved or non-agent-callable handlers",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      const invoke = {
        installationId: enabled.installationId,
        generation: enabled.generation,
        operationId: "send",
        callId: 1,
        actor,
      };
      expect(
        (yield* f.host
          .call(
            { ...invoke, actor: { ...actor, scopes: [AuthOrchestrationReadScope] } },
            "threads.send",
            { threadId, text: "hello", idempotencyKey: "send" },
          )
          .pipe(Effect.flip, Effect.orDie)).reason,
      ).toBe("permission_denied");
      expect(
        (yield* f.host
          .call(invoke, "threads.send", {
            threadId,
            projectId: ProjectId.make("project:forged"),
            text: "hello",
            idempotencyKey: "send",
          })
          .pipe(Effect.flip, Effect.orDie)).reason,
      ).toBe("permission_denied");
      expect(
        (yield* f.host
          .call(
            {
              ...invoke,
              actor: {
                ...actor,
                authorize: () =>
                  Effect.fail(new PluginError({ reason: "permission_denied", message: "revoked" })),
              },
            },
            "storage.get",
            { key: "board" },
          )
          .pipe(Effect.flip, Effect.orDie)).reason,
      ).toBe("permission_denied");
      for (const handler of ["event:run.finalized", "action:private", "view:board:list"])
        expect(
          (yield* f.plugins
            .invoke(
              {
                installationId: enabled.installationId,
                generation: enabled.generation,
                handler,
                operationId: "forged",
              },
              { ...actor, source: "agent" },
            )
            .pipe(Effect.flip, Effect.orDie)).reason,
        ).toMatch(/invalid_(input|handler)/);
      expect(f.commands).toHaveLength(0);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "deduplicates author mutation keys regardless of host-call order and caps finalized-run followups",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      const invocation = {
        installationId: enabled.installationId,
        generation: enabled.generation,
        operationId: "delivery-1",
        callId: 5,
        actor,
        event: true,
      };
      const input = { threadId, text: "Review", idempotencyKey: "followup" };
      yield* f.host.call(invocation, "threads.send", input);
      yield* f.host.call({ ...invocation, callId: 3 }, "threads.send", input);
      expect(f.commands).toHaveLength(1);
      expect(f.commands[0]?.text).toContain("[Plugin: Test workflow]");
      expect(f.limits).toEqual([{ runtimeMode: "full-access", interactionMode: "default" }]);
      expect(
        (yield* f.host
          .call(invocation, "threads.send", { ...input, text: "Changed request" })
          .pipe(Effect.flip, Effect.orDie)).reason,
      ).toBe("invalid_input");
      yield* f.host.call(invocation, "threads.send", { ...input, idempotencyKey: "second" });
      yield* f.host.call(invocation, "threads.send", { ...input, idempotencyKey: "third" });
      expect(
        (yield* f.host
          .call(invocation, "threads.send", { ...input, idempotencyKey: "fourth" })
          .pipe(Effect.flip, Effect.orDie)).reason,
      ).toBe("permission_denied");
      expect(f.commands).toHaveLength(3);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "revokes the generation while a domain send is waiting without holding the catalogue lock",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.blockSend(entered, release);
      const pending = yield* f.host
        .call(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            operationId: "slow-send",
            callId: 1,
            actor,
          },
          "threads.send",
          { threadId, text: "Review", idempotencyKey: "followup" },
        )
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      const disabled = yield* f.plugins.setEnabled({
        installationId: enabled.installationId,
        enabled: false,
      });
      expect(disabled.enabled).toBe(false);
      expect(disabled.generation).not.toBe(enabled.generation);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale_generation" },
      });
      expect(
        (yield* f.host
          .call(
            {
              installationId: enabled.installationId,
              generation: enabled.generation,
              operationId: "old",
              callId: 2,
              actor,
            },
            "storage.get",
            { key: "board" },
          )
          .pipe(Effect.flip, Effect.orDie)).reason,
      ).toBe("stale_generation");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(
  (["disable", "revoke", "update"] as const).flatMap((transition) =>
    (["settings.get", "storage.get", "storage.set", "storage.delete"] as const).map((method) => ({
      transition,
      method,
    })),
  ),
)(
  "rejects $method across $transition while the host operation is waiting",
  ({ transition, method }) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      yield* f.plugins.updateSettings({
        installationId: enabled.installationId,
        values: { token: "private-before-revocation" },
      });
      const invocation = {
        installationId: enabled.installationId,
        generation: enabled.generation,
        operationId: "pending-host-operation",
        callId: 1,
        actor,
      };
      yield* f.host.call(invocation, "storage.set", { key: "board", value: "before" });
      let updateDigest = enabled.digest;
      if (transition === "update") {
        yield* f.fs.writeFileString(
          f.path.join(f.directory, "plugin.mjs"),
          "export function activate() {}\n// updated worker\n",
        );
        const staged = yield* f.plugins.refresh({ installationId: enabled.installationId });
        updateDigest = staged.pendingUpdate!.digest;
      }
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writing = method === "storage.set" || method === "storage.delete";
      const wait = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      if (writing) f.beforeUpdate(() => wait);
      let checks = 0;
      const pending = yield* f.host
        .call(
          {
            ...invocation,
            actor: {
              ...actor,
              authorize: () =>
                Effect.gen(function* () {
                  if (++checks === 2 && !writing) yield* wait;
                }),
            },
          },
          method,
          method === "settings.get"
            ? { key: "token" }
            : { key: "board", ...(method === "storage.set" ? { value: "late write" } : {}) },
        )
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      const changed =
        transition === "disable"
          ? yield* f.plugins.setEnabled({ installationId: enabled.installationId, enabled: false })
          : yield* f.plugins.consent({
              installationId: enabled.installationId,
              digest: updateDigest,
              grants:
                transition === "revoke" ? { capabilities: [], projectIds: [] } : enabled.grants,
            });
      expect(changed.generation).not.toBe(enabled.generation);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "stale_generation" },
      });
      expect((yield* f.store.read).installations[0]?.storage.board).toBe("before");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(
  (["storage.set", "storage.delete"] as const).flatMap((method) =>
    (["session", "healthy"] as const).map((change) => ({ method, change })),
  ),
)("rechecks $method caller admission after a catalogue lock wait ($change)", ({ method, change }) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enabled = yield* f.enable();
    const invocation = {
      installationId: enabled.installationId,
      generation: enabled.generation,
      operationId: "storage-admission",
      callId: 1,
      actor,
    };
    yield* f.host.call(invocation, "storage.set", { key: "board", value: "before" });
    const beforeMutation = yield* Deferred.make<void>();
    const releaseAuthorization = yield* Deferred.make<void>();
    const lockEntered = yield* Deferred.make<void>();
    const releaseLock = yield* Deferred.make<void>();
    const mutationEntered = yield* Deferred.make<void>();
    let checks = 0;
    let revoked = false;
    const pending = yield* f.host
      .call(
        {
          ...invocation,
          actor: {
            ...actor,
            authorize: () =>
              Effect.gen(function* () {
                if (++checks === 3) {
                  yield* Deferred.succeed(beforeMutation, undefined);
                  yield* Deferred.await(releaseAuthorization);
                }
                if (revoked)
                  return yield* new PluginError({
                    reason: "permission_denied",
                    message: "Caller revoked.",
                  });
              }),
          },
        },
        method,
        { key: "board", ...(method === "storage.set" ? { value: "after" } : {}) },
      )
      .pipe(Effect.result, Effect.forkScoped);
    yield* Deferred.await(beforeMutation);
    const lock = yield* f.store
      .update((state) =>
        Deferred.succeed(lockEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseLock)),
          Effect.as([undefined, state] as const),
        ),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(lockEntered);
    f.beforeUpdate(() => Deferred.succeed(mutationEntered, undefined));
    yield* Deferred.succeed(releaseAuthorization, undefined);
    yield* Deferred.await(mutationEntered);
    if (change === "session") revoked = true;
    yield* Deferred.succeed(releaseLock, undefined);
    yield* Fiber.join(lock);
    const result = yield* Fiber.join(pending);
    const value = (yield* f.store.read).installations[0]?.storage.board;
    if (change === "session") {
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "permission_denied" } });
      expect(value).toBe("before");
    } else {
      expect(result).toMatchObject({ _tag: "Success" });
      expect(value).toBe(method === "storage.set" ? "after" : undefined);
    }
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(["settings.get", "storage.get"] as const)(
  "rejects $0 when the session is revoked while its final catalogue read waits on a commit",
  (method) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      yield* f.plugins.updateSettings({
        installationId: enabled.installationId,
        values: { token: "private-session-secret" },
      });
      const invocation = {
        installationId: enabled.installationId,
        generation: enabled.generation,
        operationId: "session-read-race",
        callId: 1,
        actor,
      };
      yield* f.host.call(invocation, "storage.set", { key: "board", value: "private-storage" });
      const lockEntered = yield* Deferred.make<void>();
      const releaseLock = yield* Deferred.make<void>();
      const readEntered = yield* Deferred.make<void>();
      let checks = 0;
      let revoked = false;
      const pending = yield* f.host
        .call(
          {
            ...invocation,
            actor: {
              ...actor,
              authorize: () =>
                Effect.gen(function* () {
                  if (++checks === 2) {
                    // Force a fresh snapshot without changing the invocation's generation.
                    yield* f.store
                      .update((state) =>
                        Effect.succeed([
                          undefined,
                          {
                            ...state,
                            installations: state.installations.map((record) => ({
                              ...record,
                              eventCursor: record.eventCursor + 1,
                            })),
                          },
                        ] as const),
                      )
                      .pipe(Effect.orDie);
                    yield* f.store
                      .update((state) =>
                        Deferred.succeed(lockEntered, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseLock)),
                          Effect.as([undefined, state] as const),
                        ),
                      )
                      .pipe(Effect.forkChild);
                    yield* Deferred.await(lockEntered);
                    f.beforeRead(() => Deferred.succeed(readEntered, undefined));
                  }
                  if (revoked)
                    return yield* new PluginError({
                      reason: "permission_denied",
                      message: "The client session has been revoked.",
                    });
                }),
            },
          },
          method,
          { key: method === "settings.get" ? "token" : "board" },
        )
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(readEntered);
      revoked = true;
      yield* Deferred.succeed(releaseLock, undefined);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "permission_denied" },
      });
      expect((yield* f.plugins.list()).installations[0]?.generation).toBe(enabled.generation);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("fails closed when both host read authorizations cross catalogue commits", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enabled = yield* f.enable();
    yield* f.plugins.updateSettings({
      installationId: enabled.installationId,
      values: { token: "private-session-secret" },
    });
    let checks = 0;
    const result = yield* f.host
      .call(
        {
          installationId: enabled.installationId,
          generation: enabled.generation,
          operationId: "catalogue-churn",
          callId: 1,
          actor: {
            ...actor,
            authorize: () =>
              Effect.gen(function* () {
                if (++checks === 1) return;
                yield* f.store
                  .update((state) =>
                    Effect.succeed([
                      undefined,
                      {
                        ...state,
                        installations: state.installations.map((record) => ({
                          ...record,
                          eventCursor: record.eventCursor + 1,
                        })),
                      },
                    ] as const),
                  )
                  .pipe(Effect.orDie);
              }),
          },
        },
        "settings.get",
        { key: "token" },
      )
      .pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { reason: "permission_denied" },
    });
    expect(checks).toBe(3);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "fences first consent at current history, delivers each finalized run once, and retains the durable cursor on restart",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const item = yield* f.install();
      f.setLatest(100);
      const enabled = yield* f.plugins.consent({
        installationId: item.installationId,
        digest: item.digest,
        grants: { capabilities: ["events.run-finalized"], projectIds: [projectId] },
      });
      expect((yield* f.store.read).installations[0]?.eventCursor).toBe(100);
      const event = (sequence: number, plugin = false): OrchestrationV2StoredEvent => ({
        sequence,
        commandId: CommandId.make(`command:${sequence}`),
        event: {
          id: EventId.make(`event:${sequence}`),
          threadId,
          runId: run.id,
          type: "run.updated",
          occurredAt: at,
          payload: {
            ...run,
            ...(plugin
              ? {
                  id: RunId.make("run:plugin-followup"),
                  userMessageId: MessageId.make("plugin:source:message"),
                }
              : {}),
          },
        },
      });
      f.stored.push(event(50), event(110), event(120), event(130, true));
      f.setLatest(130);
      const layer = Delivery.layer.pipe(
        Layer.provide(Layer.succeed(Service.PluginService, f.plugins)),
        Layer.provide(Layer.succeed(Store.PluginStore, f.store)),
        Layer.provide(f.domainLayer),
        Layer.provide(f.eventLayer),
      );
      const context = yield* Layer.build(layer);
      const delivery = Context.get(context, Delivery.PluginEventDelivery);
      yield* delivery.drain;
      expect(f.calls.filter((input) => input.handler === "event:run.finalized")).toHaveLength(1);
      expect(f.calls[0]?.operationId).toBe(`run-${run.id}`);
      expect((yield* f.store.read).installations[0]?.eventCursor).toBe(130);
      yield* delivery.catchUp();
      yield* delivery.drain;
      expect(f.calls).toHaveLength(1);
      expect(f.reads.every((cursor) => cursor >= 100)).toBe(true);
      const persisted = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(Store.layer);
          return yield* Context.get(context, Store.PluginStore).read;
        }),
      );
      expect(persisted.installations[0]?.eventCursor).toBe(130);
      yield* f.plugins.setEnabled({ installationId: enabled.installationId, enabled: false });
      f.setLatest(200);
      yield* f.plugins.setEnabled({ installationId: enabled.installationId, enabled: true });
      expect((yield* f.store.read).installations[0]?.eventCursor).toBe(130);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "creates threads with project defaults constrained by the actor rather than the actor's broadest mode",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      const invocation = {
        installationId: enabled.installationId,
        generation: enabled.generation,
        operationId: "create",
        callId: 1,
        actor,
      };
      yield* f.host
        .call(invocation, "threads.create", { projectId, text: "Review", idempotencyKey: "review" })
        .pipe(Effect.flip, Effect.orDie);
      expect(f.launches[0]).toMatchObject({
        runtimeMode: "approval-required",
        interactionMode: "default",
        modelSelection: shell.modelSelection,
      });
      yield* f.host
        .call(
          { ...invocation, operationId: "plan", actor: { ...actor, interactionMode: "plan" } },
          "threads.create",
          { projectId, text: "Review", idempotencyKey: "review" },
        )
        .pipe(Effect.flip, Effect.orDie);
      expect(f.launches[1]).toMatchObject({
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "retries a failed delivery after resume without duplicating its committed host send",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      let first = true;
      f.setHandler((_input, host) =>
        Effect.gen(function* () {
          if (first) yield* host("storage.set", { key: "visited", value: true });
          yield* host("threads.send", { threadId, text: "Review", idempotencyKey: "followup" });
          if (first) {
            first = false;
            return yield* new PluginError({
              reason: "crashed",
              message: "Fixture interrupted after dispatch.",
            });
          }
          return {};
        }),
      );
      const input = {
        installationId: enabled.installationId,
        generation: enabled.generation,
        event: {
          deliveryId: `run-${run.id}`,
          threadId,
          projectId,
          runId: run.id,
          outcome: "completed" as const,
        },
        sequence: 101,
      };
      expect((yield* f.plugins.deliver(input).pipe(Effect.flip, Effect.orDie)).reason).toBe(
        "crashed",
      );
      expect(f.commands).toHaveLength(1);
      const resumed = yield* f.plugins.resume({ installationId: enabled.installationId });
      expect(resumed.generation).toBe(enabled.generation);
      yield* f.plugins.deliver({ ...input, generation: resumed.generation });
      expect(f.commands).toHaveLength(1);
      expect((yield* f.store.read).installations[0]?.eventCursor).toBe(40);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("waits for server activation before delivering any plugin observer", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enabled = yield* f.enable();
    const ready = yield* Deferred.make<void>();
    const waiting = yield* Deferred.make<void>();
    f.stored.push({
      sequence: 50,
      commandId: null,
      event: {
        id: EventId.make("event:activation"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: at,
        payload: run,
      },
    });
    f.setLatest(50);
    const layer = Delivery.layer.pipe(
      Layer.provide(Layer.succeed(Service.PluginService, f.plugins)),
      Layer.provide(Layer.succeed(Store.PluginStore, f.store)),
      Layer.provide(f.domainLayer),
      Layer.provide(f.eventLayer),
      Layer.provide(
        Layer.succeed(
          ServerActivation,
          Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Deferred.await(ready))),
        ),
      ),
    );
    const context = yield* Layer.build(layer);
    yield* Deferred.await(waiting);
    expect(f.calls).toHaveLength(0);
    yield* Deferred.succeed(ready, undefined);
    yield* Context.get(context, Delivery.PluginEventDelivery).drain;
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.installationId).toBe(enabled.installationId);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "pauses a failed observer instead of scheduling a retry loop from its own status writes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      f.stored.push({
        sequence: 50,
        commandId: null,
        event: {
          id: EventId.make("event:failed-observer"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: at,
          payload: run,
        },
      });
      f.setLatest(50);
      f.setHandler(() =>
        Effect.fail(
          new PluginError({
            reason: "operation_failed",
            message: "Fixture observer rejects delivery.",
          }),
        ),
      );
      const layer = Delivery.layer.pipe(
        Layer.provide(Layer.succeed(Service.PluginService, f.plugins)),
        Layer.provide(Layer.succeed(Store.PluginStore, f.store)),
        Layer.provide(f.domainLayer),
        Layer.provide(f.eventLayer),
      );
      const context = yield* Layer.build(layer);
      const delivery = Context.get(context, Delivery.PluginEventDelivery);
      yield* delivery.drain;
      yield* delivery.catchUp();
      yield* delivery.drain;
      expect(f.calls).toHaveLength(1);
      expect((yield* f.store.read).installations[0]?.eventCursor).toBe(40);
      expect((yield* f.plugins.list()).installations[0]?.status).toBe("idle");
      expect((yield* f.plugins.list()).installations[0]?.observerError).toContain(
        "Fixture observer",
      );
      expect((yield* f.plugins.list()).installations[0]?.error).toBeNull();
      f.setHandler(() => Effect.succeed({}));
      yield* f.plugins.resume({
        installationId: enabled.installationId,
        eventBacklog: {
          policy: "deliver",
          throughSequence: (yield* f.plugins.backlog({ installationId: enabled.installationId }))
            .throughSequence,
        },
      });
      yield* delivery.catchUp();
      yield* delivery.drain;
      expect(f.calls).toHaveLength(2);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("explicit data removal also forgets retained data from earlier installations", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const first = yield* f.enable();
    yield* f.plugins.updateSettings({
      installationId: first.installationId,
      values: { token: "private" },
    });
    yield* f.plugins.remove({ installationId: first.installationId });
    const second = yield* f.enable();
    yield* f.plugins.remove({ installationId: second.installationId, deleteData: true });
    const third = yield* f.enable();
    expect(
      yield* f.host.call(
        {
          installationId: third.installationId,
          generation: third.generation,
          operationId: "lookup",
          callId: 1,
          actor,
        },
        "settings.get",
        { key: "token" },
      ),
    ).toBe(null);
    expect(
      yield* f.host.call(
        {
          installationId: third.installationId,
          generation: third.generation,
          operationId: "lookup",
          callId: 2,
          actor,
        },
        "storage.get",
        { key: "constructor" },
      ),
    ).toBe(null);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "revokes a modified installed snapshot and refreshes clean bytes even when the source digest is unchanged",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      const installed = (yield* f.store.read).installations[0]!;
      yield* f.fs.chmod(
        f.path.resolve(f.store.directory, installed.directory, "plugin.mjs"),
        0o600,
      );
      yield* f.fs.writeFileString(
        f.path.resolve(f.store.directory, installed.directory, "plugin.mjs"),
        "export function activate() {throw Error('changed')}\n",
      );
      expect(
        (yield* f.plugins
          .readView({
            installationId: enabled.installationId,
            generation: enabled.generation,
            viewId: "board",
          })
          .pipe(Effect.flip, Effect.orDie)).reason,
      ).toBe("changed_source");
      expect((yield* f.plugins.list()).installations[0]).toMatchObject({
        enabled: true,
        status: "needs-consent",
      });
      const clean = yield* f.plugins.refresh({ installationId: enabled.installationId });
      expect(clean.digest).toBe(enabled.digest);
      expect(clean.pendingUpdate?.digest).toBe(enabled.digest);
      const consented = yield* f.plugins.consent({
        installationId: clean.installationId,
        digest: clean.digest,
        grants: { capabilities: ["ui"], projectIds: [] },
      });
      expect(
        (yield* f.plugins.readView({
          installationId: consented.installationId,
          generation: consented.generation,
          viewId: "board",
        })).html,
      ).toContain("Board");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "normalizes persisted running and keeps catalogue availability idle during invocations",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              installation: { ...record.installation, status: "running" as const },
            })),
          },
        ] as const),
      );
      expect((yield* f.plugins.list()).installations[0]?.status).toBe("idle");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.setHandler(() =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({}),
        ),
      );
      const pending = yield* f.plugins
        .invoke(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            handler: "action:review",
            operationId: "running",
          },
          actor,
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      expect((yield* f.plugins.list()).installations[0]?.status).toBe("idle");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pending);
      expect((yield* f.plugins.list()).installations[0]?.status).toBe("idle");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "clears write-only secrets and rejects client intents without a granted UI capability",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      yield* f.plugins.updateSettings({
        installationId: enabled.installationId,
        values: { token: "private" },
      });
      yield* f.plugins.updateSettings({
        installationId: enabled.installationId,
        values: { token: "" },
      });
      expect(
        yield* f.host.call(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            operationId: "clear",
            callId: 1,
            actor,
          },
          "settings.get",
          { key: "token" },
        ),
      ).toBe(null);
      const limited = yield* f.plugins.consent({
        installationId: enabled.installationId,
        digest: enabled.digest,
        grants: { capabilities: [], projectIds: [] },
      });
      f.setHandler(() => Effect.succeed({ intents: [{ type: "composer.insert", text: "hello" }] }));
      expect(
        (yield* f.plugins
          .invoke(
            {
              installationId: limited.installationId,
              generation: limited.generation,
              operationId: "intent",
              handler: "action:review",
            },
            actor,
          )
          .pipe(Effect.flip, Effect.orDie)).reason,
      ).toBe("permission_denied");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "does not give retained secrets or storage to a different package source with the same id",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.enable();
      yield* f.plugins.updateSettings({
        installationId: first.installationId,
        values: { token: "private", auto: true },
      });
      yield* f.host.call(
        {
          installationId: first.installationId,
          generation: first.generation,
          operationId: "data",
          callId: 1,
          actor,
        },
        "storage.set",
        { key: "private", value: "retained" },
      );
      yield* f.plugins.remove({ installationId: first.installationId });
      const other = yield* f.fs.makeTempDirectoryScoped({ prefix: "plugin-other-source-" });
      for (const name of ["t3-plugin.json", "plugin.mjs", "view.html"])
        yield* f.fs.copyFile(f.path.join(f.directory, name), f.path.join(other, name));
      const second = yield* f.plugins.install({ source: { kind: "local", directory: other } });
      expect(second.settings.auto).toBe(false);
      const stored = (yield* f.store.read).installations.find(
        (r) => r.installation.installationId === second.installationId,
      )!;
      expect(stored.secrets).toEqual({});
      expect(stored.storage).toEqual({});
      yield* f.plugins.remove({ installationId: second.installationId });
      const original = yield* f.plugins.install({
        source: { kind: "local", directory: f.path.join(f.directory, ".") },
      });
      const restored = (yield* f.store.read).installations.find(
        (r) => r.installation.installationId === original.installationId,
      )!;
      expect(restored.secrets.token).toBe("private");
      expect(restored.storage.private).toBe("retained");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("matches normalized Git repository provenance across pinned revisions", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const first = yield* f.plugins.install({
      source: { kind: "git", url: "https://EXAMPLE.com:443/acme/plugin/", ref: "a".repeat(40) },
    });
    yield* f.plugins.updateSettings({
      installationId: first.installationId,
      values: { token: "private" },
    });
    yield* f.plugins.remove({ installationId: first.installationId });
    const second = yield* f.plugins.install({
      source: { kind: "git", url: "https://example.com/acme/plugin", ref: "b".repeat(40) },
    });
    expect(
      (yield* f.store.read).installations.find(
        (r) => r.installation.installationId === second.installationId,
      )?.secrets.token,
    ).toBe("private");
    yield* f.plugins.remove({ installationId: second.installationId });
    const third = yield* f.plugins.install({
      source: { kind: "git", url: "https://example.com/other/plugin", ref: "b".repeat(40) },
    });
    expect(
      (yield* f.store.read).installations.find(
        (r) => r.installation.installationId === third.installationId,
      )?.secrets,
    ).toEqual({});
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("namespaces semantic operation identities by the server-owned actor principal", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enabled = yield* f.enable();
    const invocation = {
      installationId: enabled.installationId,
      generation: enabled.generation,
      operationId: "review",
      callId: 1,
      actor,
    };
    const request = { threadId, text: "Review", idempotencyKey: "followup" };
    yield* f.host.call(invocation, "threads.send", request);
    yield* f.host.call({ ...invocation, callId: 8 }, "threads.send", request);
    yield* f.host.call(
      { ...invocation, actor: { ...actor, principalId: "thread:another" } },
      "threads.send",
      request,
    );
    expect(f.commands).toHaveLength(2);
    expect(f.commands[0]?.commandId).not.toBe(f.commands[1]?.commandId);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("lets disable revoke immediately while the same installation is fetching an update", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const installed = yield* f.plugins.install({
      source: { kind: "git", url: "https://example.com/acme/plugin" },
    });
    const enabled = yield* f.plugins.consent({
      installationId: installed.installationId,
      digest: installed.digest,
      grants: { capabilities: [], projectIds: [] },
    });
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    f.setGitCheckout((source) =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as({ directory: f.directory, source: { ...source, ref: "b".repeat(40) } }),
      ),
    );
    yield* f.fs.writeFileString(
      f.path.join(f.directory, "plugin.mjs"),
      "export function activate() { /* updated */ }",
    );
    const refresh = yield* f.plugins
      .refresh({ installationId: enabled.installationId })
      .pipe(Effect.result, Effect.forkScoped);
    yield* Deferred.await(entered);
    const disabled = yield* f.plugins.setEnabled({
      installationId: enabled.installationId,
      enabled: false,
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.generation).not.toBe(enabled.generation);
    yield* Deferred.succeed(release, undefined);
    expect((yield* Fiber.join(refresh))._tag).toBe("Failure");
    expect((yield* f.plugins.list()).installations[0]?.enabled).toBe(false);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "discards pending updates without changing working grants and drops orphan secrets on promotion",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      yield* f.plugins.updateSettings({
        installationId: enabled.installationId,
        values: { token: "private" },
      });
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson({ ...manifest, version: "2.0.0", settings: [] }),
      );
      const pending = yield* f.plugins.refresh({ installationId: enabled.installationId });
      expect(pending.generation).toBe(enabled.generation);
      expect(pending.grants).toEqual(enabled.grants);
      expect(pending.pendingUpdate?.manifest.version).toBe("2.0.0");
      const discarded = yield* f.plugins.discardPendingUpdate({
        installationId: enabled.installationId,
      });
      expect(discarded.pendingUpdate).toBeUndefined();
      expect(discarded.generation).toBe(enabled.generation);
      expect(discarded.manifest.version).toBe("1.0.0");
      const staged = yield* f.plugins.refresh({ installationId: enabled.installationId });
      const promoted = yield* f.plugins.consent({
        installationId: enabled.installationId,
        digest: staged.pendingUpdate!.digest,
        grants: { capabilities: ["settings"], projectIds: [] },
      });
      expect(promoted.manifest.version).toBe("2.0.0");
      expect((yield* f.store.read).installations[0]?.secrets).toEqual({});
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "does not persist action activity or change availability when a concurrent invocation finishes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      const firstEntered = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const firstRelease = yield* Deferred.make<void>();
      const secondRelease = yield* Deferred.make<void>();
      f.setHandler((input) =>
        Deferred.succeed(
          input.operationId === "first" ? firstEntered : secondEntered,
          undefined,
        ).pipe(
          Effect.andThen(
            Deferred.await(input.operationId === "first" ? firstRelease : secondRelease),
          ),
          Effect.as({}),
        ),
      );
      const input = {
        installationId: enabled.installationId,
        generation: enabled.generation,
        handler: "action:review",
        operationId: "first",
      };
      const first = yield* f.plugins.invoke(input, actor).pipe(Effect.forkScoped);
      yield* Deferred.await(firstEntered);
      const second = yield* f.plugins
        .invoke({ ...input, operationId: "second" }, actor)
        .pipe(Effect.forkScoped);
      yield* Deferred.await(secondEntered);
      yield* Deferred.succeed(firstRelease, undefined);
      yield* Fiber.join(first);
      const afterFirst = yield* f.store.read;
      expect((yield* f.plugins.list()).installations[0]?.status).toBe("idle");
      yield* Deferred.succeed(secondRelease, undefined);
      yield* Fiber.join(second);
      expect((yield* f.plugins.list()).installations[0]?.status).toBe("idle");
      expect(yield* f.store.read).toBe(afterFirst);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("keeps observers available after ordinary action errors", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enabled = yield* f.enable();
    f.setHandler((input) =>
      input.handler.startsWith("action:")
        ? Effect.fail(new PluginError({ reason: "operation_failed", message: "Bad action input." }))
        : Effect.succeed({}),
    );
    yield* f.plugins
      .invoke(
        {
          installationId: enabled.installationId,
          generation: enabled.generation,
          handler: "action:review",
          operationId: "bad",
        },
        actor,
      )
      .pipe(Effect.flip);
    expect((yield* f.plugins.list()).installations[0]?.status).toBe("idle");
    yield* f.plugins.deliver({
      installationId: enabled.installationId,
      generation: enabled.generation,
      event: {
        deliveryId: `run-${run.id}`,
        threadId,
        projectId,
        runId: run.id,
        outcome: "completed",
      },
      sequence: 50,
    });
    expect((yield* f.store.read).installations[0]?.eventCursor).toBe(40);
    expect(f.calls).toHaveLength(2);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("caches verified immutable bytes per generation across view and action requests", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enabled = yield* f.enable();
    yield* f.plugins.readView({
      installationId: enabled.installationId,
      generation: enabled.generation,
      viewId: "board",
    });
    const stored = (yield* f.store.read).installations[0]!;
    // A missing unrelated entry would fail another full snapshot scan; active bytes were already verified.
    yield* f.fs.remove(f.path.resolve(f.store.directory, stored.directory, "plugin.mjs"));
    expect(
      (yield* f.plugins.readView({
        installationId: enabled.installationId,
        generation: enabled.generation,
        viewId: "board",
      })).html,
    ).toContain("Board");
    yield* f.plugins.invoke(
      {
        installationId: enabled.installationId,
        generation: enabled.generation,
        handler: "action:review",
        operationId: "cached",
      },
      actor,
    );
    const disabled = yield* f.plugins.setEnabled({
      installationId: enabled.installationId,
      enabled: false,
    });
    expect(
      (yield* f.plugins
        .setEnabled({ installationId: disabled.installationId, enabled: true })
        .pipe(Effect.flip)).reason,
    ).toBe("invalid_manifest");
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("delivers to healthy installations while another observer is waiting", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const first = yield* f.enable();
    yield* f.fs.writeFileString(
      f.path.join(f.directory, "t3-plugin.json"),
      yield* encodeJson({ ...manifest, id: "test.second" }),
    );
    const installed = yield* f.install();
    const second = yield* f.plugins.consent({
      installationId: installed.installationId,
      digest: installed.digest,
      grants: { capabilities: ["events.run-finalized"], projectIds: [projectId] },
    });
    const blocked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const healthy = yield* Deferred.make<void>();
    f.setHandler((input) =>
      input.installationId === first.installationId
        ? Deferred.succeed(blocked, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({}),
          )
        : Deferred.succeed(healthy, undefined).pipe(Effect.as({})),
    );
    f.stored.push({
      sequence: 50,
      commandId: null,
      event: {
        id: EventId.make("event:parallel"),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: at,
        payload: run,
      },
    });
    f.setLatest(50);
    const context = yield* Layer.build(
      Delivery.layer.pipe(
        Layer.provide(Layer.succeed(Service.PluginService, f.plugins)),
        Layer.provide(Layer.succeed(Store.PluginStore, f.store)),
        Layer.provide(f.domainLayer),
        Layer.provide(f.eventLayer),
      ),
    );
    yield* Deferred.await(blocked);
    yield* Deferred.await(healthy);
    expect(f.calls.some((call) => call.installationId === second.installationId)).toBe(true);
    yield* Deferred.succeed(release, undefined);
    yield* Context.get(context, Delivery.PluginEventDelivery).drain;
    expect(f.calls).toHaveLength(2);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("rechecks the WS session before a host effect after the invocation was accepted", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enabled = yield* f.enable();
    const sessionId = AuthSessionId.make("client-session");
    let revoked = false;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    f.setHandler((_input, host) =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(
          host("threads.send", { threadId, text: "Must not dispatch", idempotencyKey: "send" }),
        ),
        Effect.as({}),
      ),
    );
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"],
          typeof WS_METHODS.pluginsInvoke
        > => tag !== WS_METHODS.pluginsInvoke,
      ),
    );
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          RpcHandlers.layer(actor, {
            assertActive: Effect.suspend(() =>
              revoked
                ? Effect.fail(
                    new Sessions.SessionCredentialVerificationError({
                      sessionId,
                      cause: "revoked",
                    }),
                  )
                : Effect.void,
            ),
          }).pipe(Layer.provide(Layer.succeed(Service.PluginService, f.plugins))),
          rpcInstrumentationLayer,
          RpcAuthorization.layer(actor.scopes),
        ),
      ),
    );
    const pending = yield* client[WS_METHODS.pluginsInvoke]({
      installationId: enabled.installationId,
      generation: enabled.generation,
      handler: "action:review",
      operationId: "revoke",
    }).pipe(Effect.result, Effect.forkScoped);
    yield* Deferred.await(entered);
    revoked = true;
    yield* Deferred.succeed(release, undefined);
    const result = yield* Fiber.join(pending);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({ reason: "permission_denied" });
    expect(f.commands).toHaveLength(0);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("keeps the working version active when pending consent fails snapshot verification", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const active = yield* f.enable();
    yield* f.fs.writeFileString(
      f.path.join(f.directory, "plugin.mjs"),
      "export function activate(){ /* staged */ }",
    );
    const staged = yield* f.plugins.refresh({ installationId: active.installationId });
    const record = (yield* f.store.read).installations[0]!;
    yield* f.fs.chmod(
      f.path.resolve(f.store.directory, record.pendingDirectory!, "plugin.mjs"),
      0o600,
    );
    yield* f.fs.writeFileString(
      f.path.resolve(f.store.directory, record.pendingDirectory!, "plugin.mjs"),
      "export function activate(){ /* changed after stage */ }",
    );
    expect(
      (yield* f.plugins
        .consent({
          installationId: active.installationId,
          digest: staged.pendingUpdate!.digest,
          grants: active.grants,
        })
        .pipe(Effect.flip)).reason,
    ).toBe("changed_source");
    expect((yield* f.plugins.list()).installations[0]).toMatchObject({
      generation: active.generation,
      enabled: true,
      digest: active.digest,
    });
    yield* f.plugins.invoke(
      {
        installationId: active.installationId,
        generation: active.generation,
        handler: "action:review",
        operationId: "still-working",
      },
      actor,
    );
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "pauses invalid event results and clears delivery health when explicitly re-enabled",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      f.setHandler(() =>
        Effect.succeed({ intents: [{ type: "view.open", viewId: "undeclared" }] }),
      );
      const input = {
        installationId: enabled.installationId,
        generation: enabled.generation,
        event: {
          deliveryId: `run-${run.id}`,
          threadId,
          projectId,
          runId: run.id,
          outcome: "completed" as const,
        },
        sequence: 50,
      };
      expect((yield* f.plugins.deliver(input).pipe(Effect.flip)).reason).toBe("invalid_result");
      expect((yield* f.store.read).installations[0]?.deliveryError).toBeTruthy();
      yield* f.plugins.setEnabled({ installationId: enabled.installationId, enabled: false });
      f.setLatest(50);
      const restarted = yield* f.plugins.setEnabled({
        installationId: enabled.installationId,
        enabled: true,
        eventBacklog: { policy: "skip", throughSequence: 50 },
      });
      expect((yield* f.store.read).installations[0]?.deliveryError).toBeNull();
      f.setHandler(() => Effect.succeed({}));
      yield* f.plugins.deliver({ ...input, generation: restarted.generation, sequence: 51 });
      expect((yield* f.store.read).installations[0]?.eventCursor).toBe(50);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("keeps invalid author action results invocation-local", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enabled = yield* f.enable();
    f.setHandler(() => Effect.succeed({ intents: [{ type: "view.open", viewId: "undeclared" }] }));
    expect(
      (yield* f.plugins
        .invoke(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            handler: "action:review",
            operationId: "bad-result",
          },
          actor,
        )
        .pipe(Effect.flip)).reason,
    ).toBe("invalid_result");
    expect((yield* f.plugins.list()).installations[0]).toMatchObject({
      status: "idle",
      error: null,
    });
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "compacts restored records and discards a stale update when source returns to active bytes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.enable();
      yield* f.plugins.remove({ installationId: first.installationId });
      const restored = yield* f.install();
      expect((yield* f.store.read).installations).toHaveLength(1);
      const original = yield* f.fs.readFileString(f.path.join(f.directory, "plugin.mjs"));
      yield* f.fs.writeFileString(f.path.join(f.directory, "plugin.mjs"), original + "\n// update");
      yield* f.plugins.refresh({ installationId: restored.installationId });
      yield* f.fs.writeFileString(f.path.join(f.directory, "plugin.mjs"), original);
      expect(
        (yield* f.plugins.refresh({ installationId: restored.installationId })).pendingUpdate,
      ).toBeUndefined();
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "writes only changed storage keys and makes identical sets and absent deletes no-ops",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.enable();
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson({ ...manifest, id: "test.peer" }),
      );
      const peer = yield* f.enable();
      const invocation = (item: typeof first) => ({
        installationId: item.installationId,
        generation: item.generation,
        operationId: "storage",
        callId: 1,
        actor,
      });
      yield* f.host.call(invocation(first), "storage.set", { key: "other", value: "retained" });
      yield* f.host.call(invocation(peer), "storage.set", {
        key: "large",
        value: "p".repeat(900_000),
      });
      const sql = yield* (yield* Database.PluginDatabase).client;
      yield* sql`CREATE TABLE plugin_write_audit(installation_id TEXT, key TEXT)`;
      yield* sql`CREATE TRIGGER audit_record BEFORE UPDATE ON plugin_records BEGIN INSERT INTO plugin_write_audit VALUES(NEW.installation_id,'record'); END`;
      yield* sql`CREATE TRIGGER audit_storage_insert BEFORE INSERT ON plugin_storage BEGIN INSERT INTO plugin_write_audit VALUES(NEW.installation_id,NEW.key); END`;
      yield* sql`CREATE TRIGGER audit_storage_update BEFORE UPDATE ON plugin_storage BEGIN INSERT INTO plugin_write_audit VALUES(NEW.installation_id,NEW.key); END`;
      for (let value = 0; value < 100; value++)
        yield* f.host.call(invocation(first), "storage.set", { key: "counter", value });
      const audit = yield* sql<{
        installation_id: string;
        key: string;
      }>`SELECT * FROM plugin_write_audit`;
      expect(audit).toHaveLength(199);
      expect(
        audit.every((row) => row.installation_id === first.installationId && row.key === "counter"),
      ).toBe(true);
      const before = yield* f.store.read;
      yield* f.host.call(invocation(first), "storage.set", { key: "counter", value: 99 });
      yield* f.host.call(invocation(first), "storage.delete", { key: "absent" });
      expect(yield* f.store.read).toBe(before);
      expect(yield* sql`SELECT * FROM plugin_write_audit`).toEqual(audit);
      const reloaded = Context.get(yield* Layer.build(Store.layer), Store.PluginStore);
      const state = yield* reloaded.read;
      expect(
        state.installations.find(
          (record) => record.installation.installationId === first.installationId,
        )?.storage,
      ).toEqual({ other: "retained", counter: 99 });
      expect(
        state.installations.find(
          (record) => record.installation.installationId === peer.installationId,
        )?.storage.large,
      ).toBe("p".repeat(900_000));
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("refuses deleteData for an opaque record and preserves every peer", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.install();
    yield* f.store.update((state) =>
      Effect.succeed([
        undefined,
        {
          ...state,
          installations: state.installations.map((record) => ({
            ...record,
            rawRecord: { private: "preserve" },
          })),
        },
      ] as const),
    );
    const before = yield* f.store.read;
    const error = yield* f.plugins
      .remove({ installationId: item.installationId, deleteData: true })
      .pipe(Effect.flip);
    expect(error.reason).toBe("incompatible");
    expect(yield* f.store.read).toBe(before);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

const finalizedEvent = (sequence: number): OrchestrationV2StoredEvent => ({
  sequence,
  commandId: null,
  event: {
    id: EventId.make(`event:liveness:${sequence}`),
    type: "run.updated",
    threadId,
    runId: RunId.make(`run:liveness:${sequence}`),
    occurredAt: at,
    payload: { ...run, id: RunId.make(`run:liveness:${sequence}`) },
  },
});
const deliveryFor = (f: Effect.Success<typeof fixture>) =>
  Delivery.layer.pipe(
    Layer.provide(Layer.succeed(Service.PluginService, f.plugins)),
    Layer.provide(Layer.succeed(Store.PluginStore, f.store)),
    Layer.provide(f.domainLayer),
    Layer.provide(f.eventLayer),
  );

it.effect(
  "reconnects the live stream from latest and catches durable events missed during backoff",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.enable();
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const starts: Array<number | undefined> = [];
      f.setLatest(50);
      f.stored.push(finalizedEvent(50));
      f.setLive((input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            starts.push(input?.afterSequence);
            if (starts.length === 1) {
              yield* Deferred.succeed(first, undefined);
              return Stream.fail(new PersistenceSqlError({ operation: "fixture.stream" }));
            }
            yield* Deferred.succeed(second, undefined);
            return Stream.never;
          }),
        ),
      );
      const context = yield* Layer.build(deliveryFor(f));
      const delivery = Context.get(context, Delivery.PluginEventDelivery);
      yield* Deferred.await(first);
      f.setLatest(60);
      f.stored.push(finalizedEvent(60));
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(second);
      yield* delivery.drain;
      expect(starts).toEqual([50, 60]);
      expect(f.calls).toHaveLength(2);
      expect((yield* f.store.read).installations[0]?.eventCursor).toBe(60);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "retries a transient observer storage error without requiring a new event or resume",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.enable();
      f.setLatest(50);
      f.stored.push(finalizedEvent(50));
      const failed = yield* Deferred.make<void>();
      let attempts = 0;
      f.setHandler(() =>
        ++attempts === 1
          ? Deferred.succeed(failed, undefined).pipe(
              Effect.andThen(
                Effect.fail(
                  new PluginError({
                    reason: "storage_failed",
                    message: "Fixture storage unavailable.",
                  }),
                ),
              ),
            )
          : Effect.succeed({}),
      );
      const context = yield* Layer.build(deliveryFor(f));
      const delivery = Context.get(context, Delivery.PluginEventDelivery);
      yield* Deferred.await(failed);
      yield* TestClock.adjust("1 second");
      yield* delivery.drain;
      expect(attempts).toBe(2);
      expect((yield* f.plugins.list()).installations[0]).toMatchObject({
        status: "idle",
        observerError: null,
      });
      expect((yield* f.store.read).installations[0]?.eventCursor).toBe(50);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "coalesces new triggers per installation while a slow observer cannot block another's new runs",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const slow = yield* f.enable();
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson({ ...manifest, id: "test.fast" }),
      );
      const fast = yield* f.enable();
      const blocked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const initial = yield* Deferred.make<void>();
      const newRun = yield* Deferred.make<void>();
      const subscribed = yield* Deferred.make<void>();
      const triggers = yield* Queue.unbounded<{
        event: OrchestrationV2StoredEvent;
        accepted: Deferred.Deferred<void>;
      }>();
      f.setLive(() =>
        Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
          Stream.drain,
          Stream.concat(
            Stream.fromQueue(triggers).pipe(
              Stream.flatMap(({ event, accepted }) =>
                Stream.concat(
                  Stream.make(event),
                  Stream.fromEffect(Deferred.succeed(accepted, undefined)).pipe(Stream.drain),
                ),
              ),
            ),
          ),
        ),
      );
      f.setHandler((input) =>
        input.installationId === slow.installationId
          ? Deferred.succeed(blocked, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({}),
            )
          : Deferred.succeed(input.operationId.endsWith(":60") ? newRun : initial, undefined).pipe(
              Effect.as({}),
            ),
      );
      f.setLatest(50);
      f.stored.push(finalizedEvent(50));
      const context = yield* Layer.build(deliveryFor(f));
      const delivery = Context.get(context, Delivery.PluginEventDelivery);
      yield* Deferred.await(subscribed);
      yield* Deferred.await(blocked);
      yield* Deferred.await(initial);
      f.setLatest(60);
      f.stored.push(finalizedEvent(60));
      for (let count = 0; count < 100; count++) {
        const accepted = yield* Deferred.make<void>();
        yield* Queue.offer(triggers, { event: finalizedEvent(60), accepted });
        yield* Deferred.await(accepted);
      }
      yield* Deferred.await(newRun);
      expect(f.calls.filter((call) => call.installationId === fast.installationId)).toHaveLength(2);
      const before = f.reads.length;
      yield* Deferred.succeed(release, undefined);
      yield* delivery.drain;
      expect(f.reads.length - before).toBeLessThanOrEqual(1);
      expect(f.calls.filter((call) => call.installationId === slow.installationId)).toHaveLength(2);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "deleteData preserves retained data belonging to a different source with the same manifest id",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.enable();
      yield* f.host.call(
        {
          installationId: first.installationId,
          generation: first.generation,
          actor,
          operationId: "retain",
          callId: 1,
        },
        "storage.set",
        { key: "notes", value: ["source A"] },
      );
      yield* f.plugins.remove({ installationId: first.installationId });
      const sourceB = yield* f.fs.makeTempDirectoryScoped({ prefix: "plugin-source-b-" });
      for (const name of ["t3-plugin.json", "plugin.mjs", "view.html"])
        yield* f.fs.copyFile(f.path.join(f.directory, name), f.path.join(sourceB, name));
      const second = yield* f.plugins.install({ source: { kind: "local", directory: sourceB } });
      yield* f.plugins.remove({ installationId: second.installationId, deleteData: true });
      const restored = yield* f.install();
      expect(
        (yield* f.store.read).installations.find(
          (record) => record.installation.installationId === restored.installationId,
        )?.storage.notes,
      ).toEqual(["source A"]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "advances a non-finalized backlog in one private cursor commit and leaves a caught-up state identical",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      const sql = yield* (yield* Database.PluginDatabase).client;
      yield* sql`CREATE TABLE cursor_audit(kind TEXT)`;
      yield* sql`CREATE TRIGGER audit_cursor AFTER UPDATE OF event_cursor ON plugin_records BEGIN INSERT INTO cursor_audit VALUES('cursor'); END`;
      yield* sql`CREATE TRIGGER audit_catalogue AFTER UPDATE OF record_json ON plugin_records BEGIN INSERT INTO cursor_audit VALUES('catalogue'); END`;
      for (let sequence = 50; sequence <= 150; sequence++) {
        const event = finalizedEvent(sequence);
        if (event.event.type === "run.updated")
          f.stored.push({
            ...event,
            event: { ...event.event, payload: { ...event.event.payload, status: "running" } },
          });
      }
      f.setLatest(150);
      const context = yield* Layer.build(deliveryFor(f));
      const delivery = Context.get(context, Delivery.PluginEventDelivery);
      yield* delivery.drain;
      expect(f.calls).toHaveLength(0);
      expect(yield* sql`SELECT * FROM cursor_audit`).toEqual([{ kind: "cursor" }]);
      const caughtUp = yield* f.store.read;
      expect(
        caughtUp.installations.find(
          (record) => record.installation.installationId === enabled.installationId,
        )?.eventCursor,
      ).toBe(150);
      yield* delivery.catchUp();
      yield* delivery.drain;
      expect(yield* f.store.read).toBe(caughtUp);
      expect(yield* sql`SELECT * FROM cursor_audit`).toEqual([{ kind: "cursor" }]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("keeps a cooperative invocation timeout out of persisted worker health", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enabled = yield* f.enable();
    const before = yield* f.store.read;
    f.setHandler(() =>
      Effect.fail(new PluginError({ reason: "timeout", message: "Invocation deadline." })),
    );
    expect(
      (yield* f.plugins
        .invoke(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            handler: "action:review",
            operationId: "async-timeout",
          },
          actor,
        )
        .pipe(Effect.flip)).reason,
    ).toBe("timeout");
    expect(yield* f.store.read).toBe(before);
    expect((yield* f.plugins.list()).installations[0]).toMatchObject({
      status: "idle",
      error: null,
    });
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "retries a transient catalogue read during scheduling without blocking layer startup",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.enable();
      f.setLatest(50);
      f.stored.push(finalizedEvent(50));
      const failed = yield* Deferred.make<void>();
      let attempts = 0;
      const store: Store.PluginStore["Service"] = {
        ...f.store,
        read: Effect.gen(function* () {
          if (++attempts === 1) {
            yield* Deferred.succeed(failed, undefined);
            return yield* new Store.PluginStoreError({
              operation: "read",
              cause: "transient fixture",
            });
          }
          return yield* f.store.read;
        }),
      };
      const context = yield* Layer.build(
        Delivery.layer.pipe(
          Layer.provide(Layer.succeed(Service.PluginService, f.plugins)),
          Layer.provide(Layer.succeed(Store.PluginStore, store)),
          Layer.provide(f.domainLayer),
          Layer.provide(f.eventLayer),
        ),
      );
      yield* Deferred.await(failed);
      yield* TestClock.adjust("1 second");
      yield* Context.get(context, Delivery.PluginEventDelivery).drain;
      expect(f.calls).toHaveLength(1);
      expect((yield* f.store.read).installations[0]?.eventCursor).toBe(50);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("preserves unsupported presentation intent counts through service validation", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enabled = yield* f.enable();
    f.setHandler(() =>
      Effect.succeed({
        unsupportedIntentCount: 2,
        intents: [{ type: "view.open", viewId: "board" }],
      }),
    );
    const result = yield* f.plugins.invoke(
      {
        installationId: enabled.installationId,
        generation: enabled.generation,
        handler: "action:review",
        operationId: "future-hint",
      },
      actor,
    );
    expect(result.unsupportedIntentCount).toBe(2);
    expect(result.intents).toEqual([{ type: "view.open", viewId: "board" }]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "default removal deletes only its executable snapshots after stopping while retaining same-source data",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.enable();
      yield* f.plugins.updateSettings({
        installationId: first.installationId,
        values: { token: "retained secret", auto: true },
      });
      yield* f.host.call(
        {
          installationId: first.installationId,
          generation: first.generation,
          operationId: "retain-files",
          callId: 1,
          actor,
        },
        "storage.set",
        { key: "notes", value: ["keep"] },
      );
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "plugin.mjs"),
        "export function activate() {}\n// pending update\n",
      );
      yield* f.plugins.refresh({ installationId: first.installationId });
      const record = (yield* f.store.read).installations.find(
        (entry) => entry.installation.installationId === first.installationId,
      )!;
      expect(yield* f.fs.exists(f.path.resolve(f.store.directory, record.directory))).toBe(true);
      expect(yield* f.fs.exists(f.path.resolve(f.store.directory, record.pendingDirectory!))).toBe(
        true,
      );
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson({ ...manifest, id: "test.keep-files" }),
      );
      const peer = yield* f.enable();
      const peerRecord = (yield* f.store.read).installations.find(
        (entry) => entry.installation.installationId === peer.installationId,
      )!;
      const stopping = yield* Deferred.make<void>();
      const allowExit = yield* Deferred.make<void>();
      f.blockStop(stopping, allowExit);
      const removing = yield* f.plugins
        .remove({ installationId: first.installationId })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(stopping);
      expect(
        (yield* f.plugins.list()).installations.find(
          (entry) => entry.installationId === first.installationId,
        )?.status,
      ).toBe("disabled");
      expect(yield* f.fs.exists(f.path.resolve(f.store.directory, record.directory))).toBe(true);
      expect(yield* f.fs.exists(f.path.resolve(f.store.directory, record.pendingDirectory!))).toBe(
        true,
      );
      yield* Deferred.succeed(allowExit, undefined);
      yield* Fiber.join(removing);
      expect(yield* f.fs.exists(f.path.resolve(f.store.directory, record.directory))).toBe(false);
      expect(yield* f.fs.exists(f.path.resolve(f.store.directory, record.pendingDirectory!))).toBe(
        false,
      );
      expect(
        yield* f.fs.exists(f.path.join(f.store.directory, "snapshots", first.installationId)),
      ).toBe(false);
      expect(yield* f.fs.exists(f.path.resolve(f.store.directory, peerRecord.directory))).toBe(
        true,
      );
      const retained = (yield* f.store.read).installations.find(
        (entry) => entry.installation.installationId === first.installationId,
      )!;
      expect(retained.storage.notes).toEqual(["keep"]);
      expect(retained.secrets.token).toBe("retained secret");
      expect(retained.installation.settings.auto).toBe(true);
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson(manifest),
      );
      const restored = yield* f.install();
      const restoredRecord = (yield* f.store.read).installations.find(
        (entry) => entry.installation.installationId === restored.installationId,
      )!;
      expect(yield* f.fs.exists(f.path.resolve(f.store.directory, restoredRecord.directory))).toBe(
        true,
      );
      expect(restoredRecord.storage.notes).toEqual(["keep"]);
      expect(restoredRecord.secrets.token).toBe("retained secret");
      expect(restored.settings.auto).toBe(true);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("deleteData preserves a fresh same-source reinstall without restoring deleted data", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const first = yield* f.enable();
    yield* f.plugins.updateSettings({
      installationId: first.installationId,
      values: { token: "delete this secret", auto: true },
    });
    yield* f.host.call(
      {
        installationId: first.installationId,
        generation: first.generation,
        operationId: "private-before-delete",
        callId: 1,
        actor,
      },
      "storage.set",
      { key: "notes", value: ["delete these notes"] },
    );
    let replacement: PluginInstallation | undefined;
    f.afterUpdate(() =>
      Effect.gen(function* () {
        const old = (yield* f.store.read).installations.find(
          (record) => record.installation.installationId === first.installationId,
        );
        if (old && !old.removed) return;
        f.afterUpdate(undefined);
        replacement = yield* f.enable();
      }).pipe(Effect.orDie),
    );
    yield* f.plugins.remove({ installationId: first.installationId, deleteData: true });
    const catalogue = yield* f.plugins.list();
    expect(catalogue.installations).toEqual([{ ...replacement, observerError: null }]);
    const active = (yield* f.store.read).installations[0]!;
    expect(yield* f.fs.exists(f.path.resolve(f.store.directory, active.directory))).toBe(true);
    const result = yield* f.plugins.invoke(
      {
        installationId: active.installation.installationId,
        generation: active.installation.generation,
        handler: "action:review",
        operationId: "surviving-reinstall",
      },
      actor,
    );
    expect(result.message).toBe("done");
    const invocation = {
      installationId: active.installation.installationId,
      generation: active.installation.generation,
      operationId: "private-after-delete",
      callId: 1,
      actor,
    };
    expect(yield* f.host.call(invocation, "settings.get", { key: "token" })).toBeNull();
    expect(yield* f.host.call(invocation, "settings.get", { key: "auto" })).toBe(false);
    expect(yield* f.host.call(invocation, "storage.get", { key: "notes" })).toBeNull();
    const reloaded = Context.get(yield* Layer.build(Store.layer), Store.PluginStore);
    const records = (yield* reloaded.read).installations;
    expect(records).toHaveLength(1);
    expect(records[0]?.installation.installationId).toBe(active.installation.installationId);
    expect(records[0]?.installation.settings).toEqual({ auto: false });
    expect(records[0]?.secrets).toEqual({});
    expect(records[0]?.storage).toEqual({});
    const sql = yield* (yield* Database.PluginDatabase).client;
    expect(yield* sql`SELECT * FROM plugin_storage`).toEqual([]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "successful same-generation recovery restores agent-visible idle once and retains observer pause",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              deliveryError: "Observer remains paused.",
              installation: {
                ...record.installation,
                status: "error" as const,
                error: "Worker crashed.",
              },
            })),
          },
        ] as const),
      );
      const sql = yield* (yield* Database.PluginDatabase).client;
      yield* sql`CREATE TABLE recovery_audit (id TEXT)`;
      yield* sql`CREATE TRIGGER audit_recovery AFTER UPDATE OF record_json ON plugin_records
      BEGIN INSERT INTO recovery_audit VALUES (NEW.installation_id); END`;
      const input = {
        installationId: enabled.installationId,
        generation: enabled.generation,
        handler: "action:review",
        operationId: "recover",
      };
      yield* f.plugins.invoke(input, { ...actor, source: "agent" });
      expect((yield* f.plugins.list()).installations[0]).toMatchObject({
        status: "idle",
        error: null,
        observerError: "Observer remains paused.",
      });
      const recovered = yield* f.store.read;
      yield* f.plugins.invoke({ ...input, operationId: "healthy" }, actor);
      expect(yield* f.store.read).toBe(recovered);
      expect(yield* sql`SELECT * FROM recovery_audit`).toHaveLength(1);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("rejects copied snapshot paths before reading or deleting another home's bytes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enabled = yield* f.enable();
    const externalHome = yield* f.fs.makeTempDirectoryScoped({ prefix: "plugin-live-shaped-" });
    const external = f.path.join(
      externalHome,
      "userdata",
      "plugins",
      "snapshots",
      enabled.installationId,
    );
    const active = f.path.join(external, "active");
    const pending = f.path.join(external, "pending");
    for (const target of [active, pending]) {
      yield* f.fs.makeDirectory(target, { recursive: true });
      for (const name of ["t3-plugin.json", "plugin.mjs", "view.html"])
        yield* f.fs.copyFile(f.path.join(f.directory, name), f.path.join(target, name));
    }
    const original = (yield* f.store.read).installations[0]!;
    const pointOutside = (directory: string) =>
      f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: [
              {
                ...original,
                directory,
                pendingDirectory: pending,
                installation: {
                  ...enabled,
                  pendingUpdate: {
                    manifest: enabled.manifest,
                    source: enabled.source,
                    digest: enabled.digest,
                    generation: "pending",
                    updatedAt: stamp,
                  },
                },
              },
            ],
          },
        ] as const),
      );
    yield* pointOutside(active);
    const view = yield* f.plugins
      .readView({
        installationId: enabled.installationId,
        generation: enabled.generation,
        viewId: "board",
      })
      .pipe(Effect.result);
    expect(view._tag).toBe("Failure");
    yield* pointOutside(active);
    expect(
      (yield* f.plugins
        .invoke(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            handler: "action:review",
            operationId: "copied",
          },
          actor,
        )
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(f.calls).toHaveLength(0);
    yield* pointOutside(active);
    yield* f.plugins
      .discardPendingUpdate({ installationId: enabled.installationId })
      .pipe(Effect.ignore);
    expect(yield* f.fs.readFileString(f.path.join(pending, "view.html"))).toContain("Board");
    yield* pointOutside(active);
    yield* f.plugins
      .consent({
        installationId: enabled.installationId,
        digest: enabled.digest,
        grants: enabled.grants,
      })
      .pipe(Effect.ignore);
    expect(yield* f.fs.exists(active)).toBe(true);
    yield* pointOutside(original.directory);
    yield* f.plugins.refresh({ installationId: enabled.installationId });
    expect(yield* f.fs.exists(pending)).toBe(true);
    yield* pointOutside(active);
    const refreshed = yield* f.plugins.refresh({ installationId: enabled.installationId });
    expect(yield* f.fs.exists(pending)).toBe(true);
    yield* f.plugins.consent({
      installationId: enabled.installationId,
      digest: refreshed.pendingUpdate!.digest,
      grants: enabled.grants,
    });
    expect(yield* f.fs.exists(active)).toBe(true);
    // Relative traversal must be rejected by the same ownership check.
    yield* pointOutside(f.path.relative(f.store.directory, active));
    expect(
      (yield* f.plugins
        .readView({
          installationId: enabled.installationId,
          generation: enabled.generation,
          viewId: "board",
        })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    yield* f.plugins.remove({ installationId: enabled.installationId, deleteData: true });
    for (const target of [active, pending])
      expect(yield* f.fs.readFileString(f.path.join(target, "plugin.mjs"))).toBe(
        "export function activate() {}\n",
      );
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "relative active and pending snapshots follow a moved home while owned legacy absolute paths still work",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "plugin.mjs"),
        "export function activate() {}\n// moved pending\n",
      );
      const staged = yield* f.plugins.refresh({ installationId: enabled.installationId });
      const record = (yield* f.store.read).installations[0]!;
      expect(f.path.isAbsolute(record.directory)).toBe(false);
      expect(f.path.isAbsolute(record.pendingDirectory!)).toBe(false);
      const config = yield* Config.ServerConfig;
      const movedState = yield* f.fs.makeTempDirectoryScoped({ prefix: "plugin-moved-home-" });
      yield* f.fs.rename(f.store.directory, f.path.join(movedState, "plugins"));
      const moved = yield* fixture.pipe(
        Effect.provideService(Config.ServerConfig, {
          ...config,
          stateDir: movedState,
        }),
      );
      expect(
        (yield* moved.plugins.readView({
          installationId: enabled.installationId,
          generation: enabled.generation,
          viewId: "board",
        })).html,
      ).toContain("Board");
      const promoted = yield* moved.plugins.consent({
        installationId: enabled.installationId,
        digest: staged.pendingUpdate!.digest,
        grants: enabled.grants,
      });
      expect(
        yield* moved.fs.exists(moved.path.resolve(moved.store.directory, record.directory)),
      ).toBe(true);
      // Existing development data used absolute paths within its own store.
      yield* moved.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((entry) => ({
              ...entry,
              directory: moved.path.resolve(moved.store.directory, entry.directory),
            })),
          },
        ] as const),
      );
      yield* moved.plugins.invoke(
        {
          installationId: promoted.installationId,
          generation: promoted.generation,
          handler: "action:review",
          operationId: "legacy-owned",
        },
        actor,
      );
      expect(moved.calls[0]?.directory).toBe(
        moved.path.resolve(moved.store.directory, record.pendingDirectory!),
      );
      yield* moved.plugins.remove({ installationId: promoted.installationId });
      expect(
        yield* moved.fs.exists(moved.path.resolve(moved.store.directory, record.pendingDirectory!)),
      ).toBe(false);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "a completing invocation cannot clear quarantine, incompatibility or a newer generation's error",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      const initial = yield* f.store.read;
      for (const status of ["quarantined", "incompatible", "error"] as const) {
        yield* f.store.update(() => Effect.succeed([undefined, initial] as const));
        const generation = status === "error" ? "new-generation" : enabled.generation;
        f.setHandler(() =>
          f.store
            .update((state) =>
              Effect.succeed([
                {},
                {
                  ...state,
                  installations: state.installations.map((record) => ({
                    ...record,
                    installation: {
                      ...record.installation,
                      status,
                      manifest:
                        status === "incompatible"
                          ? { ...record.installation.manifest, capabilities: ["unknown.required"] }
                          : record.installation.manifest,
                      generation,
                      error: "Keep this failure.",
                    },
                  })),
                },
              ] as const),
            )
            .pipe(
              Effect.mapError(
                () =>
                  new PluginError({ reason: "storage_failed", message: "Fixture write failed." }),
              ),
            ),
        );
        yield* f.plugins
          .invoke(
            {
              installationId: enabled.installationId,
              generation: enabled.generation,
              handler: "action:review",
              operationId: status,
            },
            actor,
          )
          .pipe(Effect.flip);
        expect((yield* f.plugins.list()).installations[0]).toMatchObject({ status, generation });
        if (status !== "quarantined")
          expect((yield* f.plugins.list()).installations[0]?.error).toBe("Keep this failure.");
      }
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "records initial health once and keeps successful host calls, views and events quiet afterwards",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      const changes = yield* f.store.subscribeChanges;
      const observed = yield* Queue.unbounded<PluginInstallation>();
      yield* changes.pipe(
        Stream.runForEach(() =>
          f.plugins
            .list()
            .pipe(
              Effect.flatMap((catalogue) => Queue.offer(observed, catalogue.installations[0]!)),
            ),
        ),
        Effect.forkScoped,
      );
      f.setHandler((_input, host) =>
        Effect.gen(function* () {
          yield* host("storage.set", { key: "counter", value: 1 });
          yield* host("storage.get", { key: "counter" });
          yield* host("settings.get", { key: "auto" });
          return {};
        }),
      );
      for (const handler of ["action:review", "view:board:list"])
        yield* f.plugins.invoke(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            handler,
            operationId: handler.replaceAll(":", "-"),
          },
          actor,
        );
      expect((yield* Queue.take(observed)).health?.lastHealthy).toBeDefined();
      const delivery = {
        installationId: enabled.installationId,
        generation: enabled.generation,
        event: {
          deliveryId: "catalogue-success",
          threadId,
          projectId,
          runId: run.id,
          outcome: "completed" as const,
        },
        sequence: 50,
      };
      yield* f.plugins.deliver(delivery);
      yield* f.plugins.readView({
        installationId: enabled.installationId,
        generation: enabled.generation,
        viewId: "board",
      });
      // A lifecycle notification is the ordered barrier after the quiet operations.
      yield* f.plugins.updateSettings({
        installationId: enabled.installationId,
        values: { auto: true },
      });
      expect(yield* Queue.take(observed)).toMatchObject({
        status: "idle",
        settings: { auto: true },
      });
      expect(yield* Queue.size(observed)).toBe(0);
      f.setHandler(() =>
        Effect.fail(new PluginError({ reason: "operation_failed", message: "Observer failed." })),
      );
      yield* f.plugins
        .deliver({
          ...delivery,
          event: {
            ...delivery.event,
            runId: RunId.make("run:catalogue-fail"),
            deliveryId: "catalogue-fail",
          },
        })
        .pipe(Effect.flip);
      expect(yield* Queue.take(observed)).toMatchObject({
        observerError: "Observer failed.",
        status: "idle",
      });
      yield* f.plugins.resume({ installationId: enabled.installationId });
      expect(yield* Queue.take(observed)).toMatchObject({ observerError: null, status: "idle" });
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              installation: {
                ...record.installation,
                status: "error" as const,
                error: "Worker fault.",
              },
            })),
          },
        ] as const),
      );
      expect(yield* Queue.take(observed)).toMatchObject({
        status: "error",
        error: "Worker fault.",
      });
      f.setHandler(() => Effect.succeed({}));
      yield* f.plugins.invoke(
        {
          installationId: enabled.installationId,
          generation: enabled.generation,
          handler: "action:review",
          operationId: "catalogue-recovery",
        },
        actor,
      );
      expect(yield* Queue.take(observed)).toMatchObject({ status: "idle", error: null });
      yield* f.plugins.setEnabled({ installationId: enabled.installationId, enabled: false });
      expect(yield* Queue.take(observed)).toMatchObject({ status: "disabled", enabled: false });
      expect(yield* Queue.size(observed)).toBe(0);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("rejects a snapshot ancestor symlink into another home before execution or removal", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enabled = yield* f.enable();
    const externalHome = yield* f.fs.makeTempDirectoryScoped({ prefix: "plugin-symlink-home-" });
    const ownRoot = f.path.join(f.store.directory, "snapshots", enabled.installationId);
    const externalRoot = f.path.join(externalHome, enabled.installationId);
    yield* f.fs.rename(ownRoot, externalRoot);
    yield* f.fs.symlink(externalRoot, ownRoot);
    expect(
      (yield* f.plugins
        .readView({
          installationId: enabled.installationId,
          generation: enabled.generation,
          viewId: "board",
        })
        .pipe(Effect.flip)).reason,
    ).toBe("changed_source");
    expect(
      (yield* f.plugins.remove({ installationId: enabled.installationId }).pipe(Effect.flip))
        .reason,
    ).toBe("changed_source");
    const record = (yield* f.store.read).installations[0]!;
    const snapshot = f.path.basename(record.directory);
    expect(yield* f.fs.readFileString(f.path.join(externalRoot, snapshot, "view.html"))).toContain(
      "Board",
    );
    expect(record.removed).not.toBe(true);
    expect(record.installation.enabled).toBe(false);
    expect(f.calls).toHaveLength(0);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("gives handlers only the host-verified caller, never a requested thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    const input = {
      installationId: item.installationId,
      generation: item.generation,
      handler: "action:review",
      operationId: "caller",
      context: { threadId: ThreadId.make("thread:someone-else") },
    };
    yield* f.plugins.invoke(input, actor);
    yield* f.plugins.invoke(input, {
      ...actor,
      principalId: "thread:agent",
      source: "agent",
      threadId,
    });
    yield* f.plugins.invoke(input, { ...actor, principalId: "mcp:outside", source: "agent" });
    expect(f.calls.map((call) => call.caller)).toEqual([
      { kind: "client" },
      { kind: "agent", threadId },
      { kind: "agent" },
    ]);
    // The requested target still reaches the handler, separately from who asked.
    expect(f.calls.every((call) => call.context?.threadId === "thread:someone-else")).toBe(true);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each([
  { name: "a direct subagent", edges: ["subagent"], owner: 1 },
  { name: "nested subagents", edges: ["subagent", "subagent"], owner: 2 },
  { name: "a fork", edges: ["fork", "subagent"], owner: undefined },
  { name: "subagents below a fork", edges: ["subagent", "fork", "subagent"], owner: 1 },
  { name: "an unrelated thread", edges: [], owner: undefined },
] as const)("resolves subagent ownership for $name from current thread metadata", (scenario) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    const ids = Array.from({ length: scenario.edges.length + 1 }, (_, index) =>
      ThreadId.make(`thread:lineage-${index}`),
    );
    for (const [index, id] of ids.entries()) {
      f.threadShells.set(id, {
        ...shell,
        id,
        lineage: {
          parentThreadId: ids[index + 1] ?? null,
          relationshipToParent: scenario.edges[index] ?? null,
          rootThreadId: ids.at(-1)!,
        },
      });
    }
    yield* f.plugins.invoke(
      {
        installationId: item.installationId,
        generation: item.generation,
        handler: "action:review",
        operationId: "lineage",
        context: { threadId },
      },
      { ...actor, source: "agent", threadId: ids[0]! },
    );
    expect(f.calls[0]!.caller).toEqual({
      kind: "agent",
      threadId: ids[0],
      ...(scenario.owner === undefined ? {} : { subagentOf: ids[scenario.owner] }),
    });
    expect(f.calls[0]!.context).toEqual({ threadId });
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each([1, 16, 128])(
  "reads one metadata row for a non-subagent fork with %s fork ancestors",
  (depth) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const item = yield* f.enable();
      const ids = Array.from({ length: depth + 1 }, (_, index) =>
        ThreadId.make(`thread:fork-${index}`),
      );
      for (const [index, id] of ids.entries()) {
        f.threadShells.set(id, {
          ...shell,
          id,
          lineage: {
            parentThreadId: ids[index + 1] ?? null,
            relationshipToParent: index < depth ? "fork" : null,
            rootThreadId: ids.at(-1)!,
          },
        });
      }
      yield* f.plugins.invoke(
        {
          installationId: item.installationId,
          generation: item.generation,
          handler: "action:review",
          operationId: "fork-read-count",
          context: { threadId: ids[0]! },
        },
        { ...actor, source: "agent", threadId: ids[0]! },
      );
      expect(f.metadataReads).toEqual([ids[0]]);
      expect(f.shellReads).toEqual([]);
      expect(f.calls[0]!.caller).toEqual({ kind: "agent", threadId: ids[0] });
      expect(f.calls[0]!.context).toEqual({ threadId: ids[0] });
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each([1, 2, 63, 64, 80])(
  "reads each visited ancestor once for %s nested subagent edges within the bound",
  (depth) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const item = yield* f.enable();
      const ids = Array.from({ length: depth + 1 }, (_, index) =>
        ThreadId.make(`thread:nested-${index}`),
      );
      for (const [index, id] of ids.entries()) {
        f.threadShells.set(id, {
          ...shell,
          id,
          lineage: {
            parentThreadId: ids[index + 1] ?? null,
            relationshipToParent: index < depth ? "subagent" : null,
            rootThreadId: ids.at(-1)!,
          },
        });
      }
      yield* f.plugins.invoke(
        {
          installationId: item.installationId,
          generation: item.generation,
          handler: "action:review",
          operationId: "nested-read-count",
          context: { threadId: ids[0]! },
        },
        { ...actor, source: "agent", threadId: ids[0]! },
      );
      expect(f.metadataReads).toEqual(ids.slice(0, 64));
      expect(f.shellReads).toEqual([]);
      const ownership = depth < 64 ? { subagentOf: ids.at(-1) } : { lineage: "unresolved" };
      expect(f.calls[0]!.caller).toEqual({ kind: "agent", threadId: ids[0], ...ownership });
      expect(f.calls[0]!.context).toEqual({ threadId: ids[0], ...ownership });
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("marks a failed subagent lineage read unresolved and recovers on the next call", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    const parent = ThreadId.make("thread:retry-parent");
    f.threadShells.set(threadId, {
      ...shell,
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
    });
    f.threadShells.set(parent, { ...shell, id: parent });
    f.failMetadataReadOnce(parent);
    const input = {
      installationId: item.installationId,
      generation: item.generation,
      handler: "action:review",
      operationId: "retry-lineage",
      context: { threadId },
    };
    const agent = { ...actor, source: "agent" as const, threadId };
    yield* f.plugins.invoke(input, agent);
    expect(f.calls[0]!.caller).toEqual({ kind: "agent", threadId, lineage: "unresolved" });
    expect(f.calls[0]!.context).toEqual({ threadId, lineage: "unresolved" });
    yield* f.plugins.invoke(input, agent);
    expect(f.calls[1]!.caller).toEqual({ kind: "agent", threadId, subagentOf: parent });
    expect(f.calls[1]!.context).toEqual({ threadId, subagentOf: parent });
    expect(f.metadataReads).toEqual([threadId, parent, threadId, parent]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(["action:review", "status:lane"])(
  "allows ordinary client %s calls on lineage read failure and recovers",
  (handler) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const item = yield* f.enable();
      f.setHandler(() => Effect.succeed({ data: null }));
      f.failMetadataReadOnce(threadId);
      const input = {
        installationId: item.installationId,
        generation: item.generation,
        handler,
        operationId: "client-lineage-failure",
        context: { threadId },
      };
      expect(yield* f.plugins.invoke(input, actor)).toEqual({ data: null });
      expect(f.calls[0]!.caller).toEqual({ kind: "client" });
      expect(f.calls[0]!.context).toEqual({ threadId, lineage: "unresolved" });
      yield* f.plugins.invoke(input, actor);
      expect(f.calls[1]!.context).toEqual({ threadId });
      expect(f.metadataReads).toEqual([threadId, threadId]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(["permission_denied", "storage_failed"] as const)(
  "still rejects mandatory caller authorization with %s before lineage enrichment",
  (reason) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const item = yield* f.enable();
      f.failMetadataReadOnce(threadId);
      const error = new PluginError({ reason, message: "Caller authorization failed." });
      expect(
        yield* f.plugins
          .invoke(
            {
              installationId: item.installationId,
              generation: item.generation,
              handler: "action:review",
              operationId: "authorize-before-lineage",
              context: { threadId },
            },
            { ...actor, source: "agent", threadId, authorize: () => Effect.fail(error) },
          )
          .pipe(Effect.flip),
      ).toBe(error);
      expect(f.calls).toEqual([]);
      expect(f.metadataReads).toEqual([]);
      expect(f.shellReads).toEqual([]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("derives client action and status target subagent ownership without trusting input", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    const parent = ThreadId.make("thread:parent");
    const forged = ThreadId.make("thread:forged");
    f.threadShells.set(threadId, {
      ...shell,
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
    });
    f.threadShells.set(parent, { ...shell, id: parent });
    f.setHandler(() => Effect.succeed({ data: null }));
    const input = {
      installationId: item.installationId,
      generation: item.generation,
      handler: "action:review",
      operationId: "target-lineage",
      caller: { kind: "agent", threadId: forged, subagentOf: forged, lineage: "unresolved" },
      context: { threadId, subagentOf: forged, lineage: "unresolved" },
      input: { subagentOf: forged, parentThreadId: forged },
    };
    yield* f.plugins.invoke(input, actor);
    yield* f.plugins.invoke({ ...input, handler: "status:lane" }, actor);
    yield* f.plugins.invoke(input, { ...actor, source: "agent", threadId });
    expect(f.calls.map((call) => call.caller)).toEqual([
      { kind: "client" },
      { kind: "client" },
      { kind: "agent", threadId, subagentOf: parent },
    ]);
    expect(f.calls.map((call) => call.context)).toEqual([
      { threadId, subagentOf: parent },
      { threadId, subagentOf: parent },
      { threadId, subagentOf: parent },
    ]);
    f.threadShells.set(threadId, shell);
    yield* f.plugins.invoke(input, actor);
    expect(f.calls.at(-1)!.context).toEqual({ threadId });
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each([
  "cycle",
  "depth limit",
  "missing parent",
  "missing parent id",
  "deleted parent",
] as const)("omits subagent ownership for a lineage with %s", (scenario) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    const ids = Array.from({ length: scenario === "depth limit" ? 66 : 2 }, (_, index) =>
      ThreadId.make(`thread:invalid-lineage-${index}`),
    );
    for (const [index, id] of ids.entries()) {
      f.threadShells.set(id, {
        ...shell,
        id,
        lineage: {
          parentThreadId: scenario === "missing parent id" ? null : (ids[index + 1] ?? ids[0]!),
          relationshipToParent: "subagent",
          rootThreadId: ids.at(-1)!,
        },
      });
    }
    if (scenario === "missing parent") f.threadShells.set(ids[1]!, null);
    if (scenario === "deleted parent")
      f.threadShells.set(ids[1]!, { ...shell, id: ids[1]!, deletedAt: at });
    if (scenario === "depth limit") {
      f.threadShells.set(ids.at(-1)!, { ...shell, id: ids.at(-1)! });
    }
    yield* f.plugins.invoke(
      {
        installationId: item.installationId,
        generation: item.generation,
        handler: "action:review",
        operationId: "invalid-lineage",
      },
      { ...actor, source: "agent", threadId: ids[0]! },
    );
    expect(f.calls[0]!.caller).toEqual({ kind: "agent", threadId: ids[0], lineage: "unresolved" });
    expect(f.metadataReads).toHaveLength(
      scenario === "depth limit" ? 64 : scenario === "missing parent id" ? 1 : 2,
    );
    expect(f.shellReads).toEqual([]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("keeps a private data directory across reinstall and deletes it with the data", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    const input = {
      installationId: item.installationId,
      generation: item.generation,
      handler: "action:review",
      operationId: "data",
    };
    yield* f.plugins.invoke(input, actor);
    const directory = f.calls[0]!.dataDirectory;
    expect(directory.startsWith(f.path.join(f.store.directory, "data") + f.path.sep)).toBe(true);
    expect(((yield* f.fs.stat(directory)).mode & 0o777).toString(8)).toBe("700");
    yield* f.fs.writeFileString(f.path.join(directory, "state.json"), "{}");

    yield* f.plugins.remove({ installationId: item.installationId });
    const again = yield* f.enable();
    expect(again.installationId).not.toBe(item.installationId);
    yield* f.plugins.invoke(
      { ...input, installationId: again.installationId, generation: again.generation },
      actor,
    );
    expect(f.calls[1]!.dataDirectory).toBe(directory);
    expect(yield* f.fs.exists(f.path.join(directory, "state.json"))).toBe(true);

    yield* f.plugins.remove({ installationId: again.installationId, deleteData: true });
    expect(yield* f.fs.exists(directory)).toBe(false);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

const withPrivateFile = Effect.fn("test.withPrivateFile")(function* (
  f: Effect.Success<typeof fixture>,
) {
  const item = yield* f.enable();
  yield* f.plugins.invoke(
    {
      installationId: item.installationId,
      generation: item.generation,
      handler: "action:review",
      operationId: "private-file",
    },
    actor,
  );
  const directory = f.calls.at(-1)!.dataDirectory;
  const file = f.path.join(directory, "private.json");
  yield* f.fs.writeFileString(file, "private fixture");
  return { item, directory, file };
});

it.effect("keeps a failed private data purge visible until a retry finishes it", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const { item, directory, file } = yield* withPrivateFile(f);
    const remove = f.fs.remove;
    let fail = true;
    using _remove = vi
      .spyOn(f.fs, "remove")
      .mockImplementation((target, options) =>
        fail && target === directory
          ? remove(f.path.join(directory, "missing-fault-fixture"))
          : remove(target, options),
      );
    const first = yield* f.plugins
      .remove({ installationId: item.installationId, deleteData: true })
      .pipe(Effect.flip);
    expect(first.reason).toBe("storage_failed");
    expect(yield* f.fs.exists(file)).toBe(true);
    expect((yield* f.plugins.list()).installations).toMatchObject([
      { installationId: item.installationId, enabled: false, status: "disabled" },
    ]);
    // The pending purge still owns the data, so neither reinstall nor re-enable can reach it.
    expect((yield* f.install().pipe(Effect.flip)).message).toBe(
      "This plugin is already installed. Refresh its existing installation.",
    );
    expect(
      (yield* f.plugins
        .setEnabled({ installationId: item.installationId, enabled: true })
        .pipe(Effect.flip)).message,
    ).toBe("Could not read the plugin package.");

    fail = false;
    yield* f.plugins.remove({ installationId: item.installationId, deleteData: true });
    expect(yield* f.fs.exists(directory)).toBe(false);
    expect((yield* f.plugins.list()).installations).toEqual([]);
    expect(
      (yield* f.plugins
        .remove({ installationId: item.installationId, deleteData: true })
        .pipe(Effect.flip)).reason,
    ).toBe("not_found");
    const again = yield* f.enable();
    expect(again.dataOwner).not.toBe(item.dataOwner);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("keeps an interrupted private data purge visible until a retry finishes it", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const { item, directory, file } = yield* withPrivateFile(f);
    const remove = f.fs.remove;
    const entered = yield* Deferred.make<void>();
    let block = true;
    using _remove = vi
      .spyOn(f.fs, "remove")
      .mockImplementation((target, options) =>
        block && target === directory
          ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
          : remove(target, options),
      );
    const removing = yield* f.plugins
      .remove({ installationId: item.installationId, deleteData: true })
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(removing);
    expect(yield* f.fs.exists(file)).toBe(true);
    expect((yield* f.plugins.list()).installations).toMatchObject([
      { installationId: item.installationId, enabled: false, status: "disabled" },
    ]);

    block = false;
    yield* f.plugins.remove({ installationId: item.installationId, deleteData: true });
    expect(yield* f.fs.exists(directory)).toBe(false);
    expect((yield* f.plugins.list()).installations).toEqual([]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("has already purged private data when the catalogue removal commits", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const { item, directory } = yield* withPrivateFile(f);
    const committed = yield* Deferred.make<boolean>();
    f.afterUpdate(() =>
      Effect.gen(function* () {
        const records = (yield* f.store.read).installations;
        if (records.some((entry) => entry.installation.installationId === item.installationId))
          return;
        f.afterUpdate(undefined);
        yield* Deferred.succeed(committed, yield* f.fs.exists(directory));
        return yield* Effect.never;
      }).pipe(Effect.orDie),
    );
    const removing = yield* f.plugins
      .remove({ installationId: item.installationId, deleteData: true })
      .pipe(Effect.forkChild);
    expect(yield* Deferred.await(committed)).toBe(false);
    yield* Fiber.interrupt(removing);
    expect(yield* f.fs.exists(directory)).toBe(false);
    expect((yield* f.plugins.list()).installations).toEqual([]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("returns verified image files from the data directory and refuses anything else", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    const input = {
      installationId: item.installationId,
      generation: item.generation,
      handler: "action:review",
      operationId: "image",
    };
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const outside = yield* f.fs.makeTempDirectoryScoped({ prefix: "plugin-outside-" });
    yield* f.fs.writeFile(f.path.join(outside, "secret.png"), png);
    let images: NonNullable<Supervisor.PluginWorkerOutput["workerImages"]> = [];
    f.setHandler((call) =>
      Effect.gen(function* () {
        yield* f.fs.makeDirectory(f.path.join(call.dataDirectory, "assets"), { recursive: true });
        yield* f.fs.writeFile(f.path.join(call.dataDirectory, "assets", "screen.png"), png);
        yield* f.fs.writeFileString(
          f.path.join(call.dataDirectory, "assets", "fake.png"),
          "<svg/>",
        );
        yield* f.fs
          .symlink(
            f.path.join(outside, "secret.png"),
            f.path.join(call.dataDirectory, "assets", "link.png"),
          )
          .pipe(Effect.ignore);
        return {
          message: "shot",
          // A worker cannot smuggle unverified bytes past the host.
          images: [{ mimeType: "image/png" as const, data: "AAAA" }],
          workerImages: images,
        };
      }).pipe(Effect.orDie),
    );
    expect((yield* f.plugins.invoke(input, actor)).images).toBeUndefined();
    images = [{ path: "assets/screen.png", mimeType: "image/png" }];
    expect((yield* f.plugins.invoke(input, actor)).images).toEqual([
      { mimeType: "image/png", data: png.toString("base64") },
    ]);
    for (const rejected of [
      { path: "../secret.png", mimeType: "image/png" as const },
      { path: f.path.join(outside, "secret.png"), mimeType: "image/png" as const },
      { path: "assets/link.png", mimeType: "image/png" as const },
      { path: "assets/fake.png", mimeType: "image/png" as const },
      { path: "assets/screen.png", mimeType: "image/jpeg" as const },
      { path: "assets", mimeType: "image/png" as const },
      { path: "assets/missing.png", mimeType: "image/png" as const },
    ]) {
      images = [rejected];
      const error = yield* f.plugins.invoke(input, actor).pipe(Effect.flip, Effect.orDie);
      expect([rejected.path, error.reason]).toEqual([rejected.path, "invalid_result"]);
    }
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("answers thread status only to a person viewing a thread, with a validated shape", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    const input = {
      installationId: item.installationId,
      generation: item.generation,
      handler: "status:lane",
      operationId: "status",
      context: { threadId },
    };
    f.setHandler(() =>
      Effect.succeed({
        data: { label: "Live", tone: "success", detail: "1 window" },
        message: "ignored",
        intents: [{ type: "view.open" as const, viewId: "board" }],
      }),
    );
    expect(yield* f.plugins.invoke(input, actor)).toEqual({
      data: { label: "Live", tone: "success", detail: "1 window" },
    });
    for (const [caller, request] of [
      [{ ...actor, source: "agent" as const, threadId }, input],
      [actor, { ...input, context: {} }],
      [actor, { ...input, handler: "status:undeclared" }],
    ] as const) {
      const error = yield* f.plugins.invoke(request, caller).pipe(Effect.flip, Effect.orDie);
      expect(error.reason).toBe("invalid_handler");
    }
    f.setHandler(() => Effect.succeed({ data: { label: "x".repeat(41), tone: "success" } }));
    expect((yield* f.plugins.invoke(input, actor).pipe(Effect.flip, Effect.orDie)).reason).toBe(
      "invalid_result",
    );
    f.setHandler(() => Effect.succeed({}));
    expect(yield* f.plugins.invoke(input, actor)).toEqual({ data: null });
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("keeps observer cursor and disabled intent when consenting to a healthy update", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    yield* f.plugins.setEnabled({ installationId: item.installationId, enabled: false });
    f.setLatest(90);
    yield* f.fs.writeFileString(
      f.path.join(f.directory, "plugin.mjs"),
      "export function activate() { /* revision 2 */ }\n",
    );
    const staged = yield* f.plugins.refresh({ installationId: item.installationId });
    const selected = yield* f.plugins.consent({
      installationId: item.installationId,
      digest: staged.pendingUpdate!.digest,
      grants: item.grants,
    });
    expect(selected.enabled).toBe(false);
    expect((yield* f.store.read).installations[0]?.eventCursor).toBe(40);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("derives current compatibility instead of trusting a stale persisted status", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    yield* f.store.update((state) =>
      Effect.succeed([
        undefined,
        {
          ...state,
          installations: state.installations.map((record) => ({
            ...record,
            installation: { ...record.installation, status: "incompatible" as const },
          })),
        },
      ] as const),
    );
    const listed = (yield* f.plugins.list()).installations[0];
    expect(listed?.status).toBe("idle");
    const result = yield* f.plugins.invoke(
      {
        installationId: item.installationId,
        generation: item.generation,
        handler: "action:review",
        operationId: "compatible-again",
      },
      actor,
    );
    expect(result.message).toBe("done");
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.live("keeps iterative repairs usable when T3 state is behind a symlink", () =>
  Effect.gen(function* () {
    const config = yield* Config.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const realStateDir = `${config.stateDir}-real`;
    yield* fs.rename(config.stateDir, realStateDir);
    yield* fs.symlink(realStateDir, config.stateDir);
    const f = yield* fixture;
    const item = yield* f.enable();
    const repair = yield* f.plugins.prepareRepair({ installationId: item.installationId });
    expect(repair.directory).toBe(yield* fs.realPath(repair.directory));
    const code = f.path.join(repair.directory, "plugin.mjs");
    yield* fs.writeFileString(code, "export function activate() {}\n// first fix\n");
    const staged = yield* f.plugins.stageRepair({
      installationId: item.installationId,
      workspaceId: repair.workspaceId,
      baseDigest: repair.baseDigest,
    });
    const active = yield* f.plugins.consent({
      installationId: item.installationId,
      digest: staged.pendingUpdate!.digest,
      grants: item.grants,
    });
    expect(active.source).toEqual({ kind: "local", directory: repair.directory });
    const reopened = yield* f.plugins.prepareRepair({ installationId: item.installationId });
    expect(reopened.directory).toBe(repair.directory);
    expect(reopened.workspaceId).toBe(repair.workspaceId);
    yield* fs.writeFileString(code, "export function activate() {}\n// second fix\n");
    const restaged = yield* f.plugins.stageRepair({
      installationId: item.installationId,
      workspaceId: repair.workspaceId,
      baseDigest: repair.baseDigest,
    });
    expect(restaged.pendingUpdate?.digest).not.toBe(active.digest);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.live.each(["copy", "move"] as const)(
  "keeps the repair workspace after a symlinked T3 home %s",
  (relocation) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "plugin-relocated-home-" });
      const original = path.join(root, "original");
      const relocated = path.join(root, "relocated");
      const home = path.join(root, "current");
      yield* fs.makeDirectory(original);
      yield* fs.symlink(original, home);
      const before = yield* Effect.gen(function* () {
        const f = yield* fixture;
        const item = yield* f.enable();
        const repair = yield* f.plugins.prepareRepair({ installationId: item.installationId });
        yield* fs.writeFileString(
          path.join(repair.directory, "plugin.mjs"),
          "export function activate() {}\n// first fix\n",
        );
        const staged = yield* f.plugins.stageRepair({
          installationId: item.installationId,
          workspaceId: repair.workspaceId,
          baseDigest: repair.baseDigest,
        });
        yield* f.plugins.consent({
          installationId: item.installationId,
          digest: staged.pendingUpdate!.digest,
          grants: item.grants,
        });
        return { item, repair };
      }).pipe(Effect.provide(base(home)), Effect.scoped);
      if (relocation === "copy") yield* fs.copy(original, relocated);
      else yield* fs.rename(original, relocated);
      yield* fs.remove(home);
      yield* fs.symlink(relocated, home);
      yield* Effect.gen(function* () {
        const f = yield* fixture;
        const repair = yield* f.plugins.prepareRepair({
          installationId: before.item.installationId,
        });
        expect(repair.workspaceId).toBe(before.repair.workspaceId);
        expect(repair.baseDigest).toBe(before.repair.baseDigest);
        expect(repair.directory).toBe(
          path.join(
            yield* fs.realPath(relocated),
            "userdata/plugins/workspaces",
            before.item.installationId,
            before.repair.workspaceId,
          ),
        );
        const code = path.join(repair.directory, "plugin.mjs");
        expect(yield* fs.readFileString(code)).toContain("first fix");
        yield* fs.writeFileString(code, "export function activate() {}\n// second fix\n");
        const staged = yield* f.plugins.stageRepair({
          installationId: before.item.installationId,
          workspaceId: repair.workspaceId,
          baseDigest: repair.baseDigest,
        });
        expect(staged.pendingUpdate?.kind).toBe("local-repair");
        const active = yield* f.plugins.consent({
          installationId: before.item.installationId,
          digest: staged.pendingUpdate!.digest,
          grants: before.item.grants,
        });
        const previous = yield* f.plugins.usePrevious({
          installationId: before.item.installationId,
          expectedDigest: active.recovery!.previous!.digest,
          acknowledgeCurrentData: true,
        });
        yield* f.plugins.consent({
          installationId: before.item.installationId,
          digest: previous.pendingUpdate!.digest,
          grants: before.item.grants,
        });
        expect(
          (yield* f.plugins.prepareRepair({ installationId: before.item.installationId }))
            .workspaceId,
        ).toBe(repair.workspaceId);
        if (relocation === "copy")
          expect(
            yield* fs.readFileString(path.join(before.repair.directory, "plugin.mjs")),
          ).not.toContain("second fix");
      }).pipe(Effect.provide(base(home)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "keeps opaque removed records hidden and reinstalls without adopting unreadable data",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const item = yield* f.enable();
      yield* f.plugins.updateSettings({
        installationId: item.installationId,
        values: { auto: true, token: "opaque private fixture" },
      });
      yield* f.plugins.remove({ installationId: item.installationId });
      const sql = yield* (yield* Database.PluginDatabase).client;
      const saved = (yield* f.store.read).installations[0]!;
      const raw = `  ${yield* encodeJson({ ...saved, formatVersion: 3 })}\n`;
      yield* sql`UPDATE plugin_records SET record_json=${raw} WHERE installation_id=${item.installationId}`;
      const g = yield* fixture;
      expect((yield* g.plugins.list()).installations).toEqual([]);
      const reinstalled = yield* g.plugins.install({
        source: { kind: "local", directory: f.directory },
      });
      expect(reinstalled.installationId).not.toBe(item.installationId);
      expect(reinstalled.settings).toEqual({ auto: false });
      expect(
        (yield* g.plugins.list()).installations.map((record) => record.installationId),
      ).toEqual([reinstalled.installationId]);
      const current = (yield* g.store.read).installations.find(
        (record) => record.installation.installationId === reinstalled.installationId,
      );
      expect(current?.secrets).toEqual({});
      expect(current?.storage).toEqual({});
      expect(current?.dataKey).toBeUndefined();
      expect(
        yield* sql`SELECT record_json FROM plugin_records WHERE installation_id=${item.installationId}`,
      ).toEqual([{ record_json: raw }]);
      expect(
        (yield* g.store.read).installations.find(
          (record) => record.installation.installationId === item.installationId,
        )?.removed,
      ).toBe(true);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("refuses lifecycle mutations of an opaque saved record", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.install();
    yield* f.store.update((state) =>
      Effect.succeed([
        undefined,
        {
          ...state,
          installations: state.installations.map((record) => ({
            ...record,
            rawRecord: { newer: "preserve" },
          })),
        },
      ] as const),
    );
    const before = yield* f.store.read;
    const rejected = yield* f.plugins
      .remove({ installationId: item.installationId })
      .pipe(Effect.flip);
    expect(rejected.reason).toBe("incompatible");
    expect(yield* f.store.read).toBe(before);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.live(
  "prepares exact active bytes as an editable committed baseline and preserves existing repair edits",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const item = yield* f.enable();
      yield* f.plugins.updateSettings({
        installationId: item.installationId,
        values: { token: "private-secret-value", auto: true },
      });
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "plugin.mjs"),
        "export function activate() { throw Error('publisher moved'); }\n",
      );
      const repair = yield* f.plugins.prepareRepair({ installationId: item.installationId });
      expect(repair.baseDigest).toBe(item.digest);
      expect(repair.draft).not.toContain("private-secret-value");
      const runner = yield* ProcessRunner.make();
      const baseline = yield* runner.run({
        command: "git",
        args: ["show", "HEAD:plugin.mjs"],
        cwd: repair.directory,
      });
      expect(baseline.stdout).toBe("export function activate() {}\n");
      const code = f.path.join(repair.directory, "plugin.mjs");
      yield* f.fs.writeFileString(code, "export function activate() {}\n// local fix\n");
      yield* f.plugins.setEnabled({ installationId: item.installationId, enabled: false });
      expect(yield* f.plugins.prepareRepair({ installationId: item.installationId })).toEqual(
        repair,
      );
      expect(yield* f.fs.readFileString(code)).toContain("local fix");
      const wrong = yield* f.plugins
        .stageRepair({
          installationId: item.installationId,
          workspaceId: repair.workspaceId,
          baseDigest: "0".repeat(64),
        })
        .pipe(Effect.flip);
      expect(wrong.reason).toBe("changed_source");
      const candidate = yield* f.plugins.stageRepair({
        installationId: item.installationId,
        workspaceId: repair.workspaceId,
        baseDigest: repair.baseDigest,
      });
      expect(candidate.digest).toBe(item.digest);
      expect(candidate.pendingUpdate?.kind).toBe("local-repair");
      expect(candidate.pendingUpdate?.digest).not.toBe(item.digest);
      expect((yield* f.store.read).installations).toHaveLength(1);
      const active = yield* f.plugins.consent({
        installationId: item.installationId,
        digest: candidate.pendingUpdate!.digest,
        grants: item.grants,
      });
      expect(active.enabled).toBe(false);
      expect(active.recovery?.activeSource).toBe("local-repair");
      expect(active.recovery?.previous?.digest).toBe(item.digest);
      expect((yield* f.store.read).installations[0]?.sourceRequest).toEqual({
        kind: "local",
        directory: f.directory,
      });
      yield* f.fs.writeFileString(code, "export function activate() {}\n// second local fix\n");
      const reopened = yield* f.plugins.prepareRepair({ installationId: item.installationId });
      expect(reopened.workspaceId).toBe(repair.workspaceId);
      expect(reopened.directory).toBe(repair.directory);
      expect(reopened.baseDigest).toBe(item.digest);
      expect(reopened.draft).toContain(`Original baseline digest: ${item.digest}`);
      expect(reopened.draft).toContain(`Current active digest: ${active.digest}`);
      expect(yield* f.fs.readFileString(code)).toContain("second local fix");
      expect(
        (yield* runner.run({
          command: "git",
          args: ["show", "HEAD:plugin.mjs"],
          cwd: repair.directory,
        })).stdout,
      ).toBe(baseline.stdout);
      const secondCandidate = yield* f.plugins.stageRepair({
        installationId: item.installationId,
        workspaceId: repair.workspaceId,
        baseDigest: repair.baseDigest,
      });
      const second = yield* f.plugins.consent({
        installationId: item.installationId,
        digest: secondCandidate.pendingUpdate!.digest,
        grants: active.grants,
      });
      expect(second.digest).not.toBe(active.digest);
      const upstream = yield* f.plugins.refresh({ installationId: item.installationId });
      yield* f.plugins.consent({
        installationId: item.installationId,
        digest: upstream.pendingUpdate!.digest,
        grants: second.grants,
      });
      const stale = yield* f.plugins
        .stageRepair({
          installationId: item.installationId,
          workspaceId: repair.workspaceId,
          baseDigest: repair.baseDigest,
        })
        .pipe(Effect.flip);
      expect(stale.reason).toBe("changed_source");
      expect(yield* f.fs.readFileString(code)).toContain("second local fix");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "retains previous code configuration without restoring cleared secrets, revoked grants or old data",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const item = yield* f.enable();
      yield* f.plugins.updateSettings({
        installationId: item.installationId,
        values: { auto: true, token: "old-secret" },
      });
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson({
          ...manifest,
          version: "2.0.0",
          settings: [
            { key: "token", label: "Token", type: "secret" },
            { key: "auto", label: "New numeric setting", type: "number", default: 2 },
            { key: "renamed", label: "Renamed", type: "boolean", default: false },
          ],
        }),
      );
      const staged = yield* f.plugins.refresh({ installationId: item.installationId });
      const updated = yield* f.plugins.consent({
        installationId: item.installationId,
        digest: staged.pendingUpdate!.digest,
        grants: { capabilities: ["storage", "settings"], projectIds: [] },
      });
      expect(updated.settings.auto).toBe(2);
      yield* f.plugins.updateSettings({
        installationId: item.installationId,
        values: { token: "" },
      });
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              storage: { current: "keep" },
              eventCursor: 75,
            })),
          },
        ] as const),
      );
      expect(
        (yield* f.plugins.usePrevious({
          installationId: item.installationId,
          expectedDigest: item.digest,
          acknowledgeCurrentData: true,
        })).pendingUpdate?.kind,
      ).toBe("previous");
      const restored = yield* f.plugins.consent({
        installationId: item.installationId,
        digest: item.digest,
        grants: updated.grants,
      });
      expect(restored.settings.auto).toBe(true);
      expect(restored.grants).toEqual(updated.grants);
      const record = (yield* f.store.read).installations[0]!;
      expect(record.secrets.token).toBeUndefined();
      expect(record.storage).toEqual({ current: "keep" });
      expect(record.eventCursor).toBe(75);
      expect(
        yield* f.fs.exists(f.path.resolve(f.store.directory, record.previous!.directory)),
      ).toBe(true);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("requires a bounded explicit backlog choice and excludes pre-grant project history", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    yield* f.plugins.setEnabled({ installationId: item.installationId, enabled: false });
    f.stored.push(finalizedEvent(41), finalizedEvent(42));
    f.setLatest(42);
    const backlog = yield* f.plugins.backlog({ installationId: item.installationId });
    expect(backlog).toEqual({
      count: 2,
      afterSequence: 40,
      throughSequence: 42,
      requiresChoice: true,
    });
    const error = yield* f.plugins
      .setEnabled({ installationId: item.installationId, enabled: true })
      .pipe(Effect.flip);
    expect(error.code).toBe("event_backlog_choice_required");
    const invalid = yield* f.plugins
      .setEnabled({
        installationId: item.installationId,
        enabled: true,
        eventBacklog: { policy: "skip", throughSequence: 43 },
      })
      .pipe(Effect.flip);
    expect(invalid.code).toBe("event_backlog_changed");
    f.stored.push(finalizedEvent(43));
    f.setLatest(43);
    yield* f.plugins.setEnabled({
      installationId: item.installationId,
      enabled: true,
      eventBacklog: { policy: "skip", throughSequence: 42 },
    });
    expect((yield* f.store.read).installations[0]?.eventCursor).toBe(42);
    expect((yield* f.plugins.backlog({ installationId: item.installationId })).count).toBe(1);
    yield* f.plugins.consent({
      installationId: item.installationId,
      digest: item.digest,
      grants: { capabilities: item.grants.capabilities, projectIds: [] },
    });
    f.setLatest(60);
    yield* f.plugins.consent({
      installationId: item.installationId,
      digest: item.digest,
      grants: item.grants,
    });
    expect((yield* f.store.read).installations[0]?.projectGrantStarts?.[projectId]).toBe(60);
    expect((yield* f.plugins.backlog({ installationId: item.installationId })).count).toBe(0);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.live("keeps management available in safe mode and blocks executable views and actions", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    const catalogue = yield* f.plugins.list();
    expect(catalogue.executionDisabled).toBe(true);
    expect(catalogue.installations[0]).toMatchObject({ enabled: true, status: "disabled" });
    expect(catalogue.installations[0]?.attention).toBeUndefined();
    const denied = yield* f.plugins
      .invoke(
        {
          installationId: item.installationId,
          generation: item.generation,
          handler: "action:review",
          operationId: "safe-mode",
        },
        actor,
      )
      .pipe(Effect.flip);
    expect(denied.code).toBe("execution_disabled");
    expect(
      (yield* f.plugins
        .readView({
          installationId: item.installationId,
          generation: item.generation,
          viewId: "board",
        })
        .pipe(Effect.flip)).code,
    ).toBe("execution_disabled");
    expect(f.calls).toHaveLength(0);
    const repair = yield* f.plugins.prepareRepair({ installationId: item.installationId });
    expect(
      (yield* f.plugins.setEnabled({ installationId: item.installationId, enabled: false }))
        .enabled,
    ).toBe(false);
    yield* f.plugins.remove({ installationId: item.installationId });
    expect((yield* f.plugins.list()).installations).toHaveLength(0);
    expect(yield* f.fs.exists(repair.directory)).toBe(true);
  }).pipe(
    Effect.provideService(PluginExecutionPolicy, {
      safeMode: true,
      hostVersion: "test-host",
      nodeVersion: "test-node",
    }),
    Effect.provide(base()),
    Effect.scoped,
  ),
);

it.effect("turns off a non-observer without inventing a background-event problem", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.install();
    yield* f.plugins.consent({
      installationId: item.installationId,
      digest: item.digest,
      grants: { capabilities: ["storage", "ui"], projectIds: [] },
    });
    const disabled = yield* f.plugins.setEnabled({
      installationId: item.installationId,
      enabled: false,
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.attention).toBeUndefined();
    expect((yield* f.plugins.list()).installations[0]?.attention).toBeUndefined();
    expect((yield* f.plugins.backlog({ installationId: item.installationId })).count).toBe(0);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "starts a newly granted observer at the grant rather than replaying its old read access",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const item = yield* f.enable();
      yield* f.plugins.consent({
        installationId: item.installationId,
        digest: item.digest,
        grants: {
          ...item.grants,
          capabilities: item.grants.capabilities.filter(
            (capability) => capability !== "events.run-finalized",
          ),
        },
      });
      f.stored.push(finalizedEvent(41));
      f.setLatest(50);
      yield* f.plugins.consent({
        installationId: item.installationId,
        digest: item.digest,
        grants: item.grants,
      });
      expect((yield* f.plugins.backlog({ installationId: item.installationId })).count).toBe(0);
      f.stored.push(finalizedEvent(51));
      f.setLatest(51);
      expect((yield* f.plugins.backlog({ installationId: item.installationId })).count).toBe(1);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.live(
  "keeps the pinned publisher source while switching local repair and upstream in one installation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const requested: Array<Parameters<Git.PluginGitSource["Service"]["checkout"]>[0]> = [];
      f.setGitCheckout((source) => {
        requested.push(source);
        return Effect.succeed({
          directory: f.directory,
          source: { ...source, ref: source.ref ?? "a".repeat(40) },
        });
      });
      const source = {
        kind: "git" as const,
        url: "https://example.com/publisher/plugin.git",
        ref: "a".repeat(40),
      };
      const installed = yield* f.plugins.install({ source });
      const active = yield* f.plugins.consent({
        installationId: installed.installationId,
        digest: installed.digest,
        grants: { capabilities: ["storage"], projectIds: [] },
      });
      const repair = yield* f.plugins.prepareRepair({ installationId: active.installationId });
      yield* f.fs.writeFileString(
        f.path.join(repair.directory, "plugin.mjs"),
        "export function activate() {}\n// local repair\n",
      );
      const candidate = yield* f.plugins.stageRepair({
        installationId: active.installationId,
        workspaceId: repair.workspaceId,
        baseDigest: repair.baseDigest,
      });
      const local = yield* f.plugins.consent({
        installationId: active.installationId,
        digest: candidate.pendingUpdate!.digest,
        grants: active.grants,
      });
      expect(local.source.kind).toBe("local");
      const upstream = yield* f.plugins.refresh({ installationId: active.installationId });
      expect(requested).toEqual([source, source]);
      expect(upstream.pendingUpdate).toMatchObject({
        kind: "upstream",
        digest: active.digest,
        manifest: { version: "1.0.0" },
      });
      expect(upstream.recovery?.upstreamSource).toEqual(source);
      const switched = yield* f.plugins.consent({
        installationId: active.installationId,
        digest: upstream.pendingUpdate!.digest,
        grants: local.grants,
      });
      expect(switched.source).toEqual(source);
      expect(switched.recovery?.activeSource).toBe("upstream");
      expect(switched.recovery?.previous?.digest).toBe(local.digest);
      const prior = yield* f.plugins.usePrevious({
        installationId: active.installationId,
        expectedDigest: local.digest,
        acknowledgeCurrentData: true,
      });
      const restored = yield* f.plugins.consent({
        installationId: active.installationId,
        digest: prior.pendingUpdate!.digest,
        grants: switched.grants,
      });
      expect(restored.recovery?.activeSource).toBe("local-repair");
      expect(restored.recovery?.upstreamSource).toEqual(source);
      expect((yield* f.store.read).installations).toHaveLength(1);
      expect(yield* f.fs.exists(repair.directory)).toBe(true);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "releases only obsolete owned snapshots after candidate replacement and revision promotion",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const item = yield* f.enable();
      const initial = (yield* f.store.read).installations[0]!;
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "plugin.mjs"),
        "export function activate() {}\n// candidate one\n",
      );
      yield* f.plugins.refresh({ installationId: item.installationId });
      const firstCandidate = (yield* f.store.read).installations[0]!.pendingDirectory!;
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "plugin.mjs"),
        "export function activate() {}\n// candidate two\n",
      );
      const next = yield* f.plugins.refresh({ installationId: item.installationId });
      expect(yield* f.fs.exists(f.path.resolve(f.store.directory, firstCandidate))).toBe(false);
      const second = yield* f.plugins.consent({
        installationId: item.installationId,
        digest: next.pendingUpdate!.digest,
        grants: item.grants,
      });
      expect(yield* f.fs.exists(f.path.resolve(f.store.directory, initial.directory))).toBe(true);
      const secondRecord = (yield* f.store.read).installations[0]!;
      const userFiles = f.path.join(
        f.store.directory,
        "workspaces",
        item.installationId,
        "user-edits",
      );
      yield* f.fs.makeDirectory(userFiles, { recursive: true });
      yield* f.fs.writeFileString(f.path.join(userFiles, "notes"), "retain this");
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "plugin.mjs"),
        "export function activate() {}\n// candidate three\n",
      );
      const third = yield* f.plugins.refresh({ installationId: item.installationId });
      yield* f.plugins.consent({
        installationId: item.installationId,
        digest: third.pendingUpdate!.digest,
        grants: second.grants,
      });
      expect(yield* f.fs.exists(f.path.resolve(f.store.directory, initial.directory))).toBe(false);
      expect(yield* f.fs.exists(f.path.resolve(f.store.directory, secondRecord.directory))).toBe(
        true,
      );
      expect(yield* f.fs.readFileString(f.path.join(userFiles, "notes"))).toBe("retain this");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "blocks the new revision until the old worker has stopped while keeping enabled intent",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const item = yield* f.enable();
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "plugin.mjs"),
        "export function activate() {}\n// new generation\n",
      );
      const staged = yield* f.plugins.refresh({ installationId: item.installationId });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      f.blockStop(entered, release);
      const switching = yield* f.plugins
        .consent({
          installationId: item.installationId,
          digest: staged.pendingUpdate!.digest,
          grants: item.grants,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const selected = (yield* f.plugins.list()).installations[0]!;
      expect(selected.enabled).toBe(true);
      const input = {
        installationId: item.installationId,
        generation: selected.generation,
        handler: "action:review",
        operationId: "during-switch",
      };
      expect((yield* f.plugins.invoke(input, actor).pipe(Effect.flip)).reason).toBe("busy");
      expect(f.calls).toHaveLength(0);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(switching);
      expect((yield* f.plugins.invoke(input, actor)).message).toBe("done");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "checks required capabilities freshly on read and execution while optional unsupported features degrade",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson({
          ...manifest,
          capabilities: ["storage"],
          optionalCapabilities: ["ui", "future.optional"],
        }),
      );
      const item = yield* f.install();
      const active = yield* f.plugins.consent({
        installationId: item.installationId,
        digest: item.digest,
        grants: { capabilities: ["storage", "ui"], projectIds: [] },
      });
      f.setHandler(() => Effect.succeed({ intents: [{ type: "view.open", viewId: "board" }] }));
      const input = {
        installationId: item.installationId,
        generation: active.generation,
        handler: "action:review",
        operationId: "optional",
      };
      yield* f.plugins.invoke(input, actor);
      expect(f.calls[0]?.capabilities).toEqual(["storage", "ui"]);
      expect((yield* f.plugins.list()).installations[0]?.compatibility?.available).toBe(true);
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              installation: {
                ...record.installation,
                manifest: { ...record.installation.manifest, capabilities: ["future.required"] },
              },
            })),
          },
        ] as const),
      );
      expect((yield* f.plugins.list()).installations[0]?.attention).toMatchObject({
        kind: "unavailable",
        message: "Unsupported required capabilities: future.required",
      });
      expect(
        (yield* f.plugins
          .invoke({ ...input, operationId: "required-missing" }, actor)
          .pipe(Effect.flip)).reason,
      ).toBe("incompatible");
      expect(f.calls).toHaveLength(1);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

const editManifest = Effect.fn("test.editManifest")(function* (
  f: Effect.Success<typeof fixture>,
  directory: string,
  next: PluginManifest,
) {
  yield* f.fs.writeFileString(f.path.join(directory, "t3-plugin.json"), yield* encodeJson(next));
});

it.live(
  "recovers publisher settings and secrets after a repair renames keys and switches back upstream",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const item = yield* f.enable();
      yield* f.plugins.updateSettings({
        installationId: item.installationId,
        values: { auto: true, token: "publisher-secret" },
      });
      const repair = yield* f.plugins.prepareRepair({ installationId: item.installationId });
      yield* editManifest(f, repair.directory, {
        ...manifest,
        settings: [
          { key: "apiToken", label: "Token", type: "secret" },
          { key: "automatic", label: "Automatic", type: "boolean", default: false },
        ],
      });
      const staged = yield* f.plugins.stageRepair({
        installationId: item.installationId,
        workspaceId: repair.workspaceId,
        baseDigest: repair.baseDigest,
      });
      yield* f.plugins.consent({
        installationId: item.installationId,
        digest: staged.pendingUpdate!.digest,
        grants: item.grants,
      });
      // Further edits from the same agent workspace must retain the publisher's renamed keys.
      yield* f.fs.writeFileString(
        f.path.join(repair.directory, "plugin.mjs"),
        "export function activate() {}\n// second repair\n",
      );
      const iteration = yield* f.plugins.stageRepair({
        installationId: item.installationId,
        workspaceId: repair.workspaceId,
        baseDigest: repair.baseDigest,
      });
      yield* f.plugins.consent({
        installationId: item.installationId,
        digest: iteration.pendingUpdate!.digest,
        grants: item.grants,
      });
      // Publisher source unchanged; user explicitly switches back to tracked upstream.
      const upstream = yield* f.plugins.refresh({ installationId: item.installationId });
      expect(upstream.pendingUpdate?.kind).toBe("upstream");
      const back = yield* f.plugins.consent({
        installationId: item.installationId,
        digest: upstream.pendingUpdate!.digest,
        grants: item.grants,
      });
      const record = (yield* f.store.read).installations[0]!;
      expect(back.settings.auto).toBe(true);
      expect(record.secrets.token).toBe("publisher-secret");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("keeps current settings and rotated secrets when running the previous revision", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    yield* f.plugins.updateSettings({
      installationId: item.installationId,
      values: { token: "leaked", auto: true },
    });
    yield* editManifest(f, f.directory, { ...manifest, version: "2.0.0" });
    const staged = yield* f.plugins.refresh({ installationId: item.installationId });
    yield* f.plugins.consent({
      installationId: item.installationId,
      digest: staged.pendingUpdate!.digest,
      grants: item.grants,
    });
    yield* f.plugins.updateSettings({
      installationId: item.installationId,
      values: { token: "rotated", auto: false },
    });
    yield* f.plugins.usePrevious({
      installationId: item.installationId,
      expectedDigest: item.digest,
      acknowledgeCurrentData: true,
    });
    yield* f.plugins.consent({
      installationId: item.installationId,
      digest: item.digest,
      grants: item.grants,
    });
    const record = (yield* f.store.read).installations[0]!;
    expect(record.secrets.token).toBe("rotated");
    expect(record.installation.settings.auto).toBe(false);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("scrubs retained and staged secret copies when a secret is explicitly cleared", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    yield* f.plugins.updateSettings({
      installationId: item.installationId,
      values: { token: "old" },
    });
    yield* editManifest(f, f.directory, { ...manifest, version: "2.0.0" });
    const staged = yield* f.plugins.refresh({ installationId: item.installationId });
    yield* f.plugins.consent({
      installationId: item.installationId,
      digest: staged.pendingUpdate!.digest,
      grants: item.grants,
    });
    yield* f.plugins.usePrevious({
      installationId: item.installationId,
      expectedDigest: item.digest,
      acknowledgeCurrentData: true,
    });
    yield* f.plugins.updateSettings({ installationId: item.installationId, values: { token: "" } });
    const cleared = (yield* f.store.read).installations[0]!;
    expect(cleared.secrets).toEqual({});
    expect(cleared.previous?.secrets).toEqual({});
    expect(cleared.pendingSecrets).toEqual({});
    yield* f.plugins.consent({
      installationId: item.installationId,
      digest: item.digest,
      grants: item.grants,
    });
    expect((yield* f.store.read).installations[0]!.secrets).toEqual({});
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("refuses a duplicate opaque newer installation without changing its saved bytes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    const sql = yield* (yield* Database.PluginDatabase).client;
    const saved = (yield* f.store.read).installations[0]!;
    const raw = `  ${yield* encodeJson({ ...saved, formatVersion: 3, future: { preserve: "opaque" } })}\n`;
    yield* sql`UPDATE plugin_records SET record_json=${raw} WHERE installation_id=${item.installationId}`;
    const g = yield* fixture;
    const listed = yield* g.plugins.list();
    expect(listed.installations[0]?.manifest.id).toBe(manifest.id);
    expect(listed.installations[0]?.recordIssue).toBe("newer");
    const rejected = yield* g.install().pipe(Effect.result);
    expect(rejected._tag).toBe("Failure");
    if (rejected._tag === "Failure") {
      expect(rejected.failure.code).toBe("newer_record");
      expect(rejected.failure.message).toContain("compatible T3");
    }
    expect(yield* sql`SELECT record_json FROM plugin_records`).toEqual([{ record_json: raw }]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.live(
  "includes only allowlisted fault diagnostics and required capabilities in the unsent repair draft",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* editManifest(f, f.directory, {
        ...manifest,
        capabilities: [...manifest.capabilities, "future.required"],
      });
      const item = yield* f.install();
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              deliveryError: "private-event-thread-text",
              storage: { private: "private-kv-value" },
              installation: {
                ...record.installation,
                error: "private-installation-error",
                health: {
                  lastHealthy: { hostVersion: "0.9.0", nodeVersion: "22.0.0", at: stamp },
                  fault: {
                    hostVersion: "1.0.0",
                    nodeVersion: "24.0.0",
                    at: stamp,
                    reason: "crashed",
                    handler: "action:review",
                    message: "private-fault-message",
                  },
                },
              },
            })),
          },
        ] as const),
      );
      const repair = yield* f.plugins.prepareRepair({ installationId: item.installationId });
      expect(repair.draft).toContain("Fault reason: crashed");
      expect(repair.draft).toContain("Fault handler: action:review");
      expect(repair.draft).toContain("Fault host: 1.0.0; Node: 24.0.0");
      expect(repair.draft).toContain("Last healthy host: 0.9.0; Node: 22.0.0");
      expect(repair.draft).toContain("Missing required capabilities: future.required");
      expect(repair.draft).not.toContain("private-");
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              installation: {
                ...record.installation,
                health: {
                  fault: {
                    hostVersion: "1.0.0",
                    nodeVersion: "24.0.0",
                    at: stamp,
                    reason: "private-reason-value",
                    handler: "action:private-handler-value",
                    message: "private-fault-message",
                  },
                },
              },
            })),
          },
        ] as const),
      );
      const reopened = yield* f.plugins.prepareRepair({ installationId: item.installationId });
      expect(reopened.workspaceId).toBe(repair.workspaceId);
      expect(reopened.draft).toContain("Fault reason: other");
      expect(reopened.draft).not.toContain("Fault handler:");
      expect(reopened.draft).not.toContain("private-");
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              installation: {
                ...record.installation,
                health: {
                  fault: {
                    hostVersion: "1.0.0",
                    nodeVersion: "24.0.0",
                    at: stamp,
                    reason: "crashed",
                    handler: "view:board:private-message-name",
                    message: "private-fault-message",
                  },
                },
              },
            })),
          },
        ] as const),
      );
      const viewFault = yield* f.plugins.prepareRepair({ installationId: item.installationId });
      expect(viewFault.draft).toContain("Fault handler: view:board.");
      expect(viewFault.draft).not.toContain("private-");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(["consent", "disable", "resume"] as const)(
  "keeps a concurrently advanced event cursor during %s",
  (operation) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const item = yield* f.enable();
      if (operation === "resume")
        yield* f.store.update((state) =>
          Effect.succeed([
            undefined,
            {
              ...state,
              installations: state.installations.map((record) => ({
                ...record,
                deliveryError: "failed",
                eventBacklogChoiceRequired: true,
              })),
            },
          ] as const),
        );
      f.beforeUpdate(() =>
        f.store
          .update((state) =>
            Effect.succeed([
              undefined,
              {
                ...state,
                installations: state.installations.map((record) => ({
                  ...record,
                  eventCursor: 75,
                })),
              },
            ] as const),
          )
          .pipe(Effect.orDie),
      );
      if (operation === "consent")
        yield* f.plugins.consent({
          installationId: item.installationId,
          digest: item.digest,
          grants: item.grants,
        });
      else if (operation === "disable")
        yield* f.plugins.setEnabled({ installationId: item.installationId, enabled: false });
      else yield* f.plugins.resume({ installationId: item.installationId });
      expect((yield* f.store.read).installations[0]?.eventCursor).toBe(75);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("looks up each thread shell once when counting a backlog of finalized runs", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const item = yield* f.enable();
    f.stored.push(finalizedEvent(41), finalizedEvent(42), finalizedEvent(43));
    f.setLatest(43);
    const readsBefore = f.shellReads.length;
    expect((yield* f.plugins.backlog({ installationId: item.installationId })).count).toBe(3);
    expect(f.shellReads.length - readsBefore).toBe(1);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "validates a project conversation against its exact project and current thread access",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson({
          ...manifest,
          capabilities: [...manifest.capabilities, "ui.native-trees"],
          optionalCapabilities: ["ui.native-tree-conversations"],
          nativeTrees: [{ id: "projects", title: "Projects" }],
        }),
      );
      const installed = yield* f.install();
      let enabled = yield* f.plugins.consent({
        installationId: installed.installationId,
        digest: installed.digest,
        grants: {
          capabilities: ["threads.read", "ui.native-trees", "ui.native-tree-conversations"],
          projectIds: [projectId],
        },
      });
      const node = { id: "project", kind: "project", projectId, threadId };
      f.setHandler(() => Effect.succeed({ data: { nodes: [node] } }));
      const request = () => ({
        installationId: enabled.installationId,
        generation: enabled.generation,
        treeId: "projects",
        operationId: "conversation-tree",
      });
      expect((yield* f.plugins.readTree(request(), actor)).nodes).toEqual([node]);
      for (const inaccessible of [
        null,
        { ...shell, deletedAt: at },
        { ...shell, projectId: ProjectId.make("other-project") },
      ]) {
        f.threadShells.set(threadId, inaccessible);
        expect((yield* f.plugins.readTree(request(), actor).pipe(Effect.flip)).reason).toBe(
          "permission_denied",
        );
      }
      f.threadShells.set(threadId, shell);
      expect(
        (yield* f.plugins.readTree(request(), { ...actor, projectIds: [] }).pipe(Effect.flip))
          .reason,
      ).toBe("permission_denied");
      enabled = yield* f.plugins.consent({
        installationId: enabled.installationId,
        digest: enabled.digest,
        grants: { capabilities: ["threads.read", "ui.native-trees"], projectIds: [projectId] },
      });
      expect((yield* f.plugins.readTree(request(), actor).pipe(Effect.flip)).reason).toBe(
        "permission_denied",
      );
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("nests only direct workers under a granted cross-project conversation", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const otherProject = ProjectId.make("project:worker");
    const workerId = ThreadId.make("thread:worker");
    const capabilities = [
      "threads.read",
      "ui.native-trees",
      "ui.native-tree-conversations",
    ] as const;
    yield* f.fs.writeFileString(
      f.path.join(f.directory, "t3-plugin.json"),
      yield* encodeJson({
        ...manifest,
        capabilities,
        nativeTrees: [{ id: "projects", title: "Projects" }],
      }),
    );
    const installed = yield* f.install();
    const enabled = yield* f.plugins.consent({
      installationId: installed.installationId,
      digest: installed.digest,
      grants: { capabilities, projectIds: [projectId, otherProject] },
    });
    const nodes = [
      { id: "p", kind: "project", projectId, threadId },
      { id: "group", kind: "group", title: "Workers", parentId: "p" },
      { id: "w", kind: "thread", threadId: workerId, parentId: "group" },
    ];
    f.setHandler(() => Effect.succeed({ data: { nodes } }));
    const request = {
      installationId: enabled.installationId,
      generation: enabled.generation,
      treeId: "projects",
      operationId: "cross-project-workers",
    };
    const worker = { ...shell, id: workerId, projectId: otherProject, launchedFrom: { threadId } };
    f.threadShells.set(workerId, worker);
    expect((yield* f.plugins.readTree(request, actor)).nodes).toEqual(nodes);
    expect(
      (yield* f.plugins.readTree(request, { ...actor, projectIds: [projectId] }).pipe(Effect.flip))
        .reason,
    ).toBe("permission_denied");
    for (const launchedFrom of [undefined, { threadId: workerId }]) {
      f.threadShells.set(workerId, { ...worker, launchedFrom });
      expect((yield* f.plugins.readTree(request, actor).pipe(Effect.flip)).reason).toBe(
        "invalid_result",
      );
    }
    f.threadShells.set(workerId, worker);
    nodes[0] = { id: "p", kind: "project", projectId, threadId: workerId };
    expect((yield* f.plugins.readTree(request, actor).pipe(Effect.flip)).reason).toBe(
      "permission_denied",
    );
    nodes[0] = { id: "p", kind: "project", projectId, threadId };
    const restricted = yield* f.plugins.consent({
      installationId: enabled.installationId,
      digest: enabled.digest,
      grants: { capabilities, projectIds: [projectId] },
    });
    expect(
      (yield* f.plugins
        .readTree({ ...request, generation: restricted.generation }, actor)
        .pipe(Effect.flip)).reason,
    ).toBe("permission_denied");
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "keeps declared project tree actions scoped without invoking them during tree reads",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson({
          ...manifest,
          capabilities: [
            ...manifest.capabilities,
            "ui.native-trees",
            "ui.native-tree-conversations",
          ],
          nativeTrees: [{ id: "projects", title: "Projects" }],
        }),
      );
      const installed = yield* f.install();
      const enabled = yield* f.plugins.consent({
        installationId: installed.installationId,
        digest: installed.digest,
        grants: {
          capabilities: ["threads.read", "ui", "ui.native-trees", "ui.native-tree-conversations"],
          projectIds: [projectId],
        },
      });
      const node = { id: "project", kind: "project", projectId, actionId: "review" };
      f.setHandler((input) =>
        Effect.succeed(
          input.handler === "tree:projects"
            ? { data: { nodes: [node] } }
            : { intents: [{ type: "view.open", viewId: "board", threadId }] },
        ),
      );
      const request = {
        installationId: enabled.installationId,
        generation: enabled.generation,
        treeId: "projects",
        operationId: "project-action-tree",
      };
      expect((yield* f.plugins.readTree(request, actor)).nodes).toEqual([node]);
      expect(f.calls.map((call) => call.handler)).toEqual(["tree:projects"]);
      expect(f.launches).toHaveLength(0);
      expect(
        (yield* f.plugins.readTree(request, { ...actor, projectIds: [] }).pipe(Effect.flip)).reason,
      ).toBe("permission_denied");
      const action = {
        installationId: enabled.installationId,
        generation: enabled.generation,
        handler: "action:review",
        context: { projectId },
        operationId: "project-action-click",
      };
      expect((yield* f.plugins.invoke(action, actor)).intents).toEqual([
        { type: "view.open", viewId: "board", threadId },
      ]);
      expect(f.calls.at(-1)).toMatchObject({ handler: "action:review", context: { projectId } });
      yield* f.plugins.consent({
        installationId: enabled.installationId,
        digest: enabled.digest,
        grants: {
          capabilities: ["threads.read", "ui", "ui.native-trees", "ui.native-tree-conversations"],
          projectIds: [],
        },
      });
      expect((yield* f.plugins.invoke(action, actor).pipe(Effect.flip)).reason).toBe(
        "stale_generation",
      );
      expect(f.calls.filter((call) => call.handler === "action:review")).toHaveLength(1);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "requires a granted native-tree-conversations feature without blocking legacy project nodes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson({
          ...manifest,
          capabilities: [...manifest.capabilities, "ui.native-trees"],
          optionalCapabilities: ["ui.native-tree-conversations"],
          nativeTrees: [{ id: "projects", title: "Projects" }],
        }),
      );
      const installed = yield* f.install();
      let enabled = yield* f.plugins.consent({
        installationId: installed.installationId,
        digest: installed.digest,
        grants: { capabilities: ["threads.read", "ui.native-trees"], projectIds: [projectId] },
      });
      let offerAction = true;
      f.setHandler(() =>
        Effect.succeed({
          data: {
            nodes: [
              {
                id: "project",
                kind: "project",
                projectId,
                ...(offerAction ? { actionId: "review" } : {}),
              },
            ],
          },
        }),
      );
      const request = () => ({
        installationId: enabled.installationId,
        generation: enabled.generation,
        treeId: "projects",
        operationId: "feature-gated-action",
      });
      const denied = yield* f.plugins.readTree(request(), actor).pipe(Effect.result);
      expect(denied._tag).toBe("Failure");
      if (denied._tag === "Failure") expect(denied.failure.reason).toBe("permission_denied");
      offerAction = false;
      expect((yield* f.plugins.readTree(request(), actor)).nodes).toEqual([
        { id: "project", kind: "project", projectId },
      ]);
      offerAction = true;
      enabled = yield* f.plugins.consent({
        installationId: enabled.installationId,
        digest: enabled.digest,
        grants: {
          capabilities: ["threads.read", "ui.native-trees", "ui.native-tree-conversations"],
          projectIds: [projectId],
        },
      });
      expect((yield* f.plugins.readTree(request(), actor)).nodes).toEqual([
        { id: "project", kind: "project", projectId, actionId: "review" },
      ]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "rejects undeclared project tree actions instead of returning an inert or arbitrary control",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson({
          ...manifest,
          capabilities: [
            ...manifest.capabilities,
            "ui.native-trees",
            "ui.native-tree-conversations",
          ],
          nativeTrees: [{ id: "projects", title: "Projects" }],
        }),
      );
      const installed = yield* f.install();
      const enabled = yield* f.plugins.consent({
        installationId: installed.installationId,
        digest: installed.digest,
        grants: {
          capabilities: ["threads.read", "ui.native-trees", "ui.native-tree-conversations"],
          projectIds: [projectId],
        },
      });
      f.setHandler(() =>
        Effect.succeed({
          data: { nodes: [{ id: "project", kind: "project", projectId, actionId: "undeclared" }] },
        }),
      );
      const result = yield* f.plugins
        .readTree(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            treeId: "projects",
            operationId: "undeclared-project-action",
          },
          actor,
        )
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.reason).toBe("invalid_result");
      expect(f.calls.map((call) => call.handler)).toEqual(["tree:projects"]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "serves authorized native trees, rechecks grant revocation and stamps card data ownership",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const extended: PluginManifest = {
        ...manifest,
        capabilities: [
          ...manifest.capabilities,
          "ui.native-trees",
          "ui.conversation-cards",
          "ui.changes",
        ],
        nativeTrees: [{ id: "projects", title: "Projects" }],
        views: [
          ...manifest.views,
          { id: "card", title: "Plan", entry: "view.html", placement: "conversation" },
        ],
      };
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson(extended),
      );
      const installed = yield* f.install();
      const enabled = yield* f.plugins.consent({
        installationId: installed.installationId,
        digest: installed.digest,
        grants: {
          capabilities: [
            "storage",
            "threads.read",
            "ui",
            "ui.native-trees",
            "ui.conversation-cards",
            "ui.changes",
          ],
          projectIds: [projectId],
        },
      });
      f.setHandler(() =>
        Effect.succeed({
          data: {
            nodes: [
              { id: "p", kind: "project", projectId },
              { id: "t", parentId: "p", kind: "thread", threadId },
            ],
          },
        }),
      );
      const request = {
        installationId: enabled.installationId,
        generation: enabled.generation,
        treeId: "projects",
        operationId: "tree-read",
      };
      expect(
        (yield* f.plugins.readTree(request, { ...actor, scopes: [AuthOrchestrationReadScope] }))
          .nodes,
      ).toHaveLength(2);
      f.threadShells.set(threadId, { ...shell, deletedAt: at });
      expect((yield* f.plugins.readTree(request, actor).pipe(Effect.flip)).reason).toBe(
        "permission_denied",
      );
      f.threadShells.set(threadId, { ...shell, projectId: ProjectId.make("foreign") });
      const denied = yield* f.plugins.readTree(request, actor).pipe(Effect.flip);
      expect(denied.reason).toBe("permission_denied");
      f.threadShells.set(threadId, shell);
      f.setHandler(() =>
        Effect.succeed({
          card: { viewId: "card", summary: "Historical proposal", data: { planId: "one" } },
          data: "x".repeat(20_000),
        }),
      );
      const result = yield* f.plugins.invoke(
        {
          installationId: enabled.installationId,
          generation: enabled.generation,
          handler: "action:review",
          operationId: "card",
        },
        actor,
      );
      expect(result.message).toContain("Historical proposal: Historical proposal");
      expect(result.data).toBe("x".repeat(20_000));
      expect(result.card).toMatchObject({
        installationId: enabled.installationId,
        generation: enabled.generation,
        viewId: "card",
        summary: "Historical proposal",
        dataOwner: enabled.installationId,
      });
      if (!result.card) return yield* Effect.die("Expected a host card reference");
      expect(
        (yield* f.plugins.list()).installations.find(
          (entry) => entry.installationId === enabled.installationId,
        ),
      ).toMatchObject({ dataOwner: result.card.dataOwner });
      expect(
        (yield* f.plugins.readCardView(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            card: result.card,
          },
          actor,
        )).html,
      ).toContain("Board");
      const foreign = yield* f.plugins
        .readCardView(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            card: { ...result.card, dataOwner: "foreign" },
          },
          actor,
        )
        .pipe(Effect.flip);
      expect(foreign.reason).toBe("permission_denied");
      yield* f.plugins.setEnabled({ installationId: enabled.installationId, enabled: false });
      expect((yield* f.plugins.readTree(request, actor).pipe(Effect.flip)).reason).toBe(
        "stale_generation",
      );
      const resumed = yield* f.plugins.setEnabled({
        installationId: enabled.installationId,
        enabled: true,
      });
      expect(
        (yield* f.plugins.readCardView(
          {
            installationId: resumed.installationId,
            generation: resumed.generation,
            card: result.card,
          },
          actor,
        )).html,
      ).toContain("Board");
      yield* f.plugins.remove({ installationId: resumed.installationId });
      const reinstalled = yield* f.install();
      const restored = yield* f.plugins.consent({
        installationId: reinstalled.installationId,
        digest: reinstalled.digest,
        grants: enabled.grants,
      });
      expect(restored).toMatchObject({ dataOwner: result.card.dataOwner });
      expect(
        (yield* f.plugins.list()).installations.find(
          (entry) => entry.installationId === restored.installationId,
        ),
      ).toMatchObject({ dataOwner: result.card.dataOwner });
      expect(
        (yield* f.plugins.readCardView(
          {
            installationId: restored.installationId,
            generation: restored.generation,
            card: result.card,
          },
          actor,
        )).html,
      ).toContain("Board");
      yield* f.plugins.remove({ installationId: restored.installationId });
      const otherSource = yield* f.fs.makeTempDirectoryScoped({ prefix: "plugin-other-source-" });
      for (const file of ["t3-plugin.json", "plugin.mjs", "view.html"])
        yield* f.fs.writeFileString(
          f.path.join(otherSource, file),
          yield* f.fs.readFileString(f.path.join(f.directory, file)),
        );
      const foreignInstalled = yield* f.plugins.install({
        source: { kind: "local", directory: otherSource },
      });
      const foreignEnabled = yield* f.plugins.consent({
        installationId: foreignInstalled.installationId,
        digest: foreignInstalled.digest,
        grants: enabled.grants,
      });
      expect(
        (yield* f.plugins
          .readCardView(
            {
              installationId: foreignEnabled.installationId,
              generation: foreignEnabled.generation,
              card: result.card,
            },
            actor,
          )
          .pipe(Effect.flip)).reason,
      ).toBe("permission_denied");
      yield* f.plugins.remove({ installationId: foreignEnabled.installationId, deleteData: true });
      const retained = yield* f.install();
      yield* f.plugins.remove({ installationId: retained.installationId, deleteData: true });
      const fresh = yield* f.install();
      const freshEnabled = yield* f.plugins.consent({
        installationId: fresh.installationId,
        digest: fresh.digest,
        grants: enabled.grants,
      });
      expect(freshEnabled).toMatchObject({ dataOwner: freshEnabled.installationId });
      expect(
        (yield* f.plugins
          .readCardView(
            {
              installationId: freshEnabled.installationId,
              generation: freshEnabled.generation,
              card: result.card,
            },
            actor,
          )
          .pipe(Effect.flip)).reason,
      ).toBe("permission_denied");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("review: native-tree-only plugin can explicitly invalidate its declared tree", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const capabilities = ["threads.read", "ui.native-trees", "ui.changes"] as const;
    const extended: PluginManifest = {
      ...manifest,
      capabilities,
      views: [],
      threadStatus: [],
      nativeTrees: [{ id: "native", title: "Native" }],
    };
    yield* f.fs.writeFileString(
      f.path.join(f.directory, "t3-plugin.json"),
      yield* encodeJson(extended),
    );
    const installed = yield* f.install();
    const enabled = yield* f.plugins.consent({
      installationId: installed.installationId,
      digest: installed.digest,
      grants: { capabilities, projectIds: [projectId] },
    });
    const changes = yield* Queue.unbounded<import("@t3tools/contracts").PluginChanged>();
    yield* f.plugins.subscribeChanges(actor).pipe(
      Stream.runForEach((change) => Queue.offer(changes, change)),
      Effect.forkChild,
    );
    expect((yield* Queue.take(changes)).topic).toBe("tree:native");
    f.setHandler(() => Effect.succeed({ data: { nodes: [] } }));
    expect(
      yield* f.plugins.readTree(
        {
          installationId: enabled.installationId,
          generation: enabled.generation,
          treeId: "native",
          operationId: "read",
        },
        actor,
      ),
    ).toEqual({ nodes: [] });
    f.setHandler((_input, host) =>
      host("ui.invalidate", { topics: ["tree:native"] }).pipe(Effect.as({ data: { nodes: [] } })),
    );
    yield* f.plugins.readTree(
      {
        installationId: enabled.installationId,
        generation: enabled.generation,
        treeId: "native",
        operationId: "invalidate-from-tree",
      },
      actor,
    );
    yield* TestClock.adjust("25 millis");
    expect(yield* Queue.size(changes)).toBe(1);
    expect((yield* Queue.take(changes)).topic).toBe("tree:native");
    f.setHandler((_input, host) =>
      host("ui.invalidate", { topics: ["tree:native"] }).pipe(Effect.as({ message: "changed" })),
    );
    const result = yield* f.plugins
      .invoke(
        {
          installationId: enabled.installationId,
          generation: enabled.generation,
          handler: "action:review",
          operationId: "invalidate",
        },
        actor,
      )
      .pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Success", success: { message: "changed" } });
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each([
  { missing: "ui.changes", topics: ["tree:native", "view:board"], reason: "permission_denied" },
  {
    missing: "ui.native-trees",
    topics: ["view:board", "tree:native"],
    reason: "permission_denied",
  },
  { missing: "threads.read", topics: ["view:board", "tree:native"], reason: "permission_denied" },
  { missing: "ui", topics: ["tree:native", "view:board"], reason: "permission_denied" },
  { missing: "ui", topics: ["tree:native", "status:lane"], reason: "permission_denied" },
  { missing: null, topics: ["tree:native", "tree:undeclared"], reason: "invalid_handler" },
] as const)(
  "rejects the entire invalidation batch $topics with missing grant $missing",
  ({ missing, topics, reason }) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const capabilities = ["threads.read", "ui", "ui.native-trees", "ui.changes"] as const;
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson({
          ...manifest,
          capabilities,
          nativeTrees: [{ id: "native", title: "Native" }],
        }),
      );
      const installed = yield* f.install();
      const granted = capabilities.filter((capability) => capability !== missing);
      const enabled = yield* f.plugins.consent({
        installationId: installed.installationId,
        digest: installed.digest,
        grants: { capabilities: granted, projectIds: [projectId] },
      });
      const changes = yield* Queue.unbounded<import("@t3tools/contracts").PluginChanged>();
      yield* f.plugins.subscribeChanges(actor).pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkChild,
      );
      const initialCount =
        (granted.includes("ui") ? 2 : 0) +
        (granted.includes("ui.native-trees") && granted.includes("threads.read") ? 1 : 0);
      for (let index = 0; index < initialCount; index++) yield* Queue.take(changes);
      f.setHandler((_input, host) =>
        host("ui.invalidate", { topics }).pipe(Effect.as({ message: "changed" })),
      );
      expect(
        yield* f.plugins
          .invoke(
            {
              installationId: enabled.installationId,
              generation: enabled.generation,
              handler: "action:review",
              operationId: "invalidate",
            },
            actor,
          )
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason } });
      yield* TestClock.adjust("25 millis");
      expect(yield* Queue.size(changes)).toBe(0);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("invalidates declared views and statuses without native-tree or thread-read grants", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const capabilities = ["ui", "ui.changes"] as const;
    yield* f.fs.writeFileString(
      f.path.join(f.directory, "t3-plugin.json"),
      yield* encodeJson({ ...manifest, capabilities }),
    );
    const installed = yield* f.install();
    const enabled = yield* f.plugins.consent({
      installationId: installed.installationId,
      digest: installed.digest,
      grants: { capabilities, projectIds: [projectId] },
    });
    f.setHandler((_input, host) =>
      host("ui.invalidate", { topics: ["view:board", "status:lane"] }).pipe(
        Effect.as({ message: "changed" }),
      ),
    );
    expect(
      yield* f.plugins.invoke(
        {
          installationId: enabled.installationId,
          generation: enabled.generation,
          handler: "action:review",
          operationId: "invalidate",
        },
        actor,
      ),
    ).toMatchObject({ message: "changed" });
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("coalesces payload-free contribution invalidations and revokes session callbacks", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const extended: PluginManifest = {
      ...manifest,
      capabilities: [...manifest.capabilities, "ui.native-trees", "ui.changes"],
      nativeTrees: [{ id: "native", title: "Native" }],
    };
    yield* f.fs.writeFileString(
      f.path.join(f.directory, "t3-plugin.json"),
      yield* encodeJson(extended),
    );
    const installed = yield* f.install();
    const enabled = yield* f.plugins.consent({
      installationId: installed.installationId,
      digest: installed.digest,
      grants: {
        capabilities: ["threads.read", "ui", "ui.native-trees", "ui.changes"],
        projectIds: [projectId],
      },
    });
    const changes = yield* Queue.unbounded<import("@t3tools/contracts").PluginChanged>();
    let active = true;
    const subscriber = yield* f.plugins
      .subscribeChanges({
        ...actor,
        authorize: () =>
          active
            ? Effect.void
            : Effect.fail(
                new PluginError({ reason: "permission_denied", message: "Session revoked" }),
              ),
      })
      .pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkChild,
      );
    const initial = [
      yield* Queue.take(changes),
      yield* Queue.take(changes),
      yield* Queue.take(changes),
    ];
    expect(new Set(initial.map((change) => change.topic))).toEqual(
      new Set(["tree:native", "view:board", "status:lane"]),
    );
    const emitted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    f.setHandler((_input, host) =>
      host("ui.invalidate", { topics: ["tree:native", "tree:native", "view:board"] }).pipe(
        Effect.andThen(Deferred.succeed(emitted, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.as({ message: "changed" }),
      ),
    );
    const invocation = yield* f.plugins
      .invoke(
        {
          installationId: enabled.installationId,
          generation: enabled.generation,
          handler: "action:review",
          operationId: "invalidate",
        },
        actor,
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(emitted);
    yield* TestClock.adjust("25 millis");
    const received = [yield* Queue.take(changes), yield* Queue.take(changes)];
    expect(new Set(received.map((change) => change.topic))).toEqual(
      new Set(["tree:native", "view:board"]),
    );
    expect(
      received.every(
        (change) => Object.keys(change).sort().join(",") === "generation,installationId,topic",
      ),
    ).toBe(true);
    expect(yield* Queue.size(changes)).toBe(0);
    active = false;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(invocation);
    yield* TestClock.adjust("25 millis");
    expect((yield* Fiber.join(subscriber).pipe(Effect.flip)).reason).toBe("permission_denied");
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "invalidates native grouping, statuses and views on distinct run and attention edges without reading streamed updates",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const extended: PluginManifest = {
        ...manifest,
        capabilities: [...manifest.capabilities, "ui.native-trees"],
        nativeTrees: [{ id: "native", title: "Native" }],
      };
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson(extended),
      );
      const installed = yield* f.install();
      yield* f.plugins.consent({
        installationId: installed.installationId,
        digest: installed.digest,
        grants: {
          capabilities: ["threads.read", "ui", "ui.native-trees"],
          projectIds: [projectId],
        },
      });
      const requestId = RuntimeRequestId.make("request:grouping");
      const events: ApplicationStoredEvent[] = [
        ...(["starting", "running", "running", "completed"] as const).map(
          (status, index): OrchestrationV2StoredEvent => ({
            sequence: 50 + index,
            commandId: null,
            event: {
              id: EventId.make(`event:grouping:${index}`),
              threadId,
              occurredAt: at,
              type: "run.updated",
              payload: { ...run, status },
            },
          }),
        ),
        ...(["pending", "pending", "resolved"] as const).map(
          (status, index): OrchestrationV2StoredEvent => ({
            sequence: 54 + index,
            commandId: null,
            event: {
              id: EventId.make(`event:attention:${index}`),
              threadId,
              occurredAt: at,
              type: "runtime-request.updated",
              payload: {
                id: requestId,
                nodeId: NodeId.make("node:grouping"),
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "command",
                status,
                responseCapability: { type: "not_resumable", reason: "fixture" },
                createdAt: at,
                resolvedAt: status === "resolved" ? at : null,
              },
            },
          }),
        ),
      ];
      const drained = yield* Deferred.make<void>();
      f.setLive(() =>
        Stream.fromIterable(events).pipe(
          Stream.rechunk(1),
          Stream.tap((stored) =>
            Effect.sync(() => {
              if (!("event" in stored)) return;
              if (stored.event.type === "run.updated") {
                const status = stored.event.payload.status;
                f.threadShells.set(threadId, {
                  ...shell,
                  status,
                  activityRunStatus: status === "starting" || status === "running" ? status : null,
                });
              } else if (stored.event.type === "runtime-request.updated") {
                f.threadShells.set(threadId, {
                  ...shell,
                  pendingRuntimeRequest:
                    stored.event.payload.status === "pending"
                      ? { id: requestId, kind: "command", createdAt: at }
                      : null,
                });
              }
            }),
          ),
          Stream.ensuring(Deferred.succeed(drained, undefined)),
        ),
      );
      const changes = yield* Queue.unbounded<import("@t3tools/contracts").PluginChanged>();
      yield* f.plugins.subscribeChanges(actor).pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkChild,
      );
      yield* Queue.take(changes);
      yield* Queue.take(changes);
      yield* Queue.take(changes);
      yield* Deferred.await(drained);
      yield* TestClock.adjust("25 millis");
      expect(f.shellReads).toHaveLength(5);
      expect(yield* Queue.size(changes)).toBe(3);
      expect(
        new Set([
          (yield* Queue.take(changes)).topic,
          (yield* Queue.take(changes)).topic,
          (yield* Queue.take(changes)).topic,
        ]),
      ).toEqual(new Set(["tree:native", "status:lane", "view:board"]));
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each([
  { type: "thread.snoozed", access: "allowed" },
  { type: "thread.unsnoozed", access: "allowed" },
  { type: "thread.deleted", access: "allowed" },
  { type: "thread.visited", access: "allowed" },
  { type: "thread.snoozed", access: "no-ui" },
  { type: "thread.snoozed", access: "no-thread-read" },
  { type: "thread.snoozed", access: "plugin-project" },
  { type: "thread.snoozed", access: "actor-project" },
] as const)(
  "invalidates status-only contributions for $type with $access access",
  ({ type, access }) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const capabilities = ["ui", "threads.read"] as const;
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson({ ...manifest, capabilities, actions: [], views: [] }),
      );
      const installed = yield* f.install();
      const granted = capabilities.filter(
        (capability) =>
          !(access === "no-ui" && capability === "ui") &&
          !(access === "no-thread-read" && capability === "threads.read"),
      );
      const enabled = yield* f.plugins.consent({
        installationId: installed.installationId,
        digest: installed.digest,
        grants: {
          capabilities: granted,
          projectIds: access === "plugin-project" ? [] : [projectId],
        },
      });
      const drained = yield* Deferred.make<void>();
      const event: OrchestrationV2StoredEvent = {
        sequence: 50,
        commandId: null,
        event: {
          id: EventId.make(`event:status:${type}`),
          threadId,
          occurredAt: at,
          type,
          payload: { ...shell, lastVisitedAt: null },
        },
      };
      f.setLive(() =>
        Stream.make(event).pipe(Stream.ensuring(Deferred.succeed(drained, undefined))),
      );
      const changes = yield* Queue.unbounded<import("@t3tools/contracts").PluginChanged>();
      yield* f.plugins
        .subscribeChanges({
          ...actor,
          projectIds: access === "actor-project" ? [ProjectId.make("project:other")] : [projectId],
        })
        .pipe(
          Stream.runForEach((change) => Queue.offer(changes, change)),
          Effect.forkChild,
        );
      if (granted.includes("ui")) expect((yield* Queue.take(changes)).topic).toBe("status:lane");
      yield* Deferred.await(drained);
      yield* TestClock.adjust("25 millis");
      const shouldNotify = access === "allowed" && type !== "thread.visited";
      expect(yield* Queue.size(changes)).toBe(shouldNotify ? 1 : 0);
      if (shouldNotify)
        expect(yield* Queue.take(changes)).toEqual({
          installationId: enabled.installationId,
          generation: enabled.generation,
          topic: "status:lane",
        });
      expect(f.shellReads).toEqual([]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each([
  { type: "thread.snoozed", access: "allowed" },
  { type: "thread.unsnoozed", access: "allowed" },
  { type: "thread.deleted", access: "allowed" },
  { type: "thread.visited", access: "allowed" },
  { type: "thread.snoozed", access: "no-ui" },
  { type: "thread.snoozed", access: "no-thread-read" },
  { type: "thread.snoozed", access: "plugin-project" },
  { type: "thread.snoozed", access: "actor-project" },
] as const)(
  "invalidates view-only contributions for $type with $access access",
  ({ type, access }) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const capabilities = ["ui", "threads.read"] as const;
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson({ ...manifest, capabilities, actions: [], threadStatus: [] }),
      );
      const installed = yield* f.install();
      const granted = capabilities.filter(
        (capability) =>
          !(access === "no-ui" && capability === "ui") &&
          !(access === "no-thread-read" && capability === "threads.read"),
      );
      const enabled = yield* f.plugins.consent({
        installationId: installed.installationId,
        digest: installed.digest,
        grants: {
          capabilities: granted,
          projectIds: access === "plugin-project" ? [] : [projectId],
        },
      });
      const drained = yield* Deferred.make<void>();
      const event: OrchestrationV2StoredEvent = {
        sequence: 50,
        commandId: null,
        event: {
          id: EventId.make(`event:status:${type}`),
          threadId,
          occurredAt: at,
          type,
          payload: { ...shell, lastVisitedAt: null },
        },
      };
      f.setLive(() =>
        Stream.make(event).pipe(Stream.ensuring(Deferred.succeed(drained, undefined))),
      );
      const changes = yield* Queue.unbounded<import("@t3tools/contracts").PluginChanged>();
      yield* f.plugins
        .subscribeChanges({
          ...actor,
          projectIds: access === "actor-project" ? [ProjectId.make("project:other")] : [projectId],
        })
        .pipe(
          Stream.runForEach((change) => Queue.offer(changes, change)),
          Effect.forkChild,
        );
      if (granted.includes("ui")) expect((yield* Queue.take(changes)).topic).toBe("view:board");
      yield* Deferred.await(drained);
      yield* TestClock.adjust("25 millis");
      const shouldNotify = access === "allowed" && type !== "thread.visited";
      expect(yield* Queue.size(changes)).toBe(shouldNotify ? 1 : 0);
      if (shouldNotify)
        expect(yield* Queue.take(changes)).toEqual({
          installationId: enabled.installationId,
          generation: enabled.generation,
          topic: "view:board",
        });
      expect(f.shellReads).toEqual([]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(["not-requested", "not-granted"] as const)(
  "does not add project access when the project-tree capability is %s",
  (missing) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      if (missing === "not-granted")
        yield* f.fs.writeFileString(
          f.path.join(f.directory, "t3-plugin.json"),
          yield* encodeJson({ ...manifest, optionalCapabilities: ["ui.native-tree-projects"] }),
        );
      const enabled = yield* f.enable();
      const before = yield* f.store.read;
      const manager: PluginActor = {
        ...actor,
        scopes: [AuthAccessWriteScope, AuthTerminalOperateScope],
      };
      expect(
        yield* f.plugins
          .grantProject(
            {
              installationId: enabled.installationId,
              generation: enabled.generation,
              projectId: ProjectId.make("extra"),
            },
            manager,
          )
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "permission_denied" } });
      expect(yield* f.store.read).toBe(before);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "grants only another project without approving pending bytes or restarting a generation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson({ ...manifest, optionalCapabilities: ["ui.native-tree-projects"] }),
      );
      const enabled = yield* f.enable(["ui.native-tree-projects"]);
      const extra = ProjectId.make("project:extra");
      yield* f.plugins.updateSettings({
        installationId: enabled.installationId,
        values: { auto: true, token: "fixture-secret" },
      });
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "plugin.mjs"),
        "export function activate() { /* pending revision */ }\n",
      );
      yield* f.plugins.refresh({ installationId: enabled.installationId });
      const before = (yield* f.plugins.list()).installations[0]!;
      expect(before.pendingUpdate).toBeDefined();
      expect(before.pendingUpdate?.digest).not.toBe(before.digest);
      const beforeRecord = (yield* f.store.read).installations[0]!;
      const manager: PluginActor = {
        ...actor,
        scopes: [AuthAccessWriteScope, AuthTerminalOperateScope],
      };
      const result = yield* f.plugins.grantProject(
        {
          installationId: enabled.installationId,
          generation: enabled.generation,
          projectId: extra,
        },
        manager,
      );
      expect(result).toEqual({
        ...before,
        grants: { ...before.grants, projectIds: [...before.grants.projectIds, extra] },
      });
      const snapshot = yield* f.store.read;
      expect(snapshot.installations[0]).toEqual({
        ...beforeRecord,
        installation: { ...beforeRecord.installation, grants: result.grants },
      });
      expect(
        yield* f.plugins.grantProject(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            projectId: extra,
          },
          manager,
        ),
      ).toEqual(result);
      expect(yield* f.store.read).toBe(snapshot);
      expect(f.stopped).toEqual([enabled.installationId]);
      expect(
        (yield* f.plugins
          .grantProject(
            { installationId: enabled.installationId, generation: "stale", projectId: extra },
            manager,
          )
          .pipe(Effect.flip)).reason,
      ).toBe("stale_generation");
      expect(
        (yield* f.plugins
          .grantProject(
            {
              installationId: enabled.installationId,
              generation: enabled.generation,
              projectId: extra,
            },
            actor,
          )
          .pipe(Effect.flip)).reason,
      ).toBe("permission_denied");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "rechecks management authority after waiting and can authorize without holding the plugin store lock",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson({ ...manifest, optionalCapabilities: ["ui.native-tree-projects"] }),
      );
      const enabled = yield* f.enable(["ui.native-tree-projects"]);
      const before = yield* f.store.read;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const blocker = yield* f.store
        .update((state) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return [undefined, state] as const;
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      let revoked = false;
      const manager: PluginActor = {
        ...actor,
        scopes: [AuthAccessWriteScope, AuthTerminalOperateScope],
        authorize: () =>
          f.store.read.pipe(
            Effect.mapError(() => pluginPermissionDenied()),
            Effect.andThen(() => (revoked ? Effect.fail(pluginPermissionDenied()) : Effect.void)),
          ),
      };
      const call = yield* f.plugins
        .grantProject(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            projectId: ProjectId.make("extra"),
          },
          manager,
        )
        .pipe(Effect.result, Effect.forkChild);
      revoked = true;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(blocker);
      expect(yield* Fiber.join(call)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "permission_denied" },
      });
      expect(yield* f.store.read).toBe(before);
      revoked = false;
      expect(
        (yield* f.plugins.grantProject(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            projectId: ProjectId.make("extra"),
          },
          manager,
        )).grants.projectIds,
      ).toContain("extra");
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect("rejects a project grant when its generation changes before commit", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enabled = yield* f.enable();
    const manager: PluginActor = {
      ...actor,
      scopes: [AuthAccessWriteScope, AuthTerminalOperateScope],
    };
    f.beforeUpdate(() =>
      f.store
        .update((state) =>
          Effect.succeed([
            undefined,
            {
              ...state,
              installations: state.installations.map((record) => ({
                ...record,
                installation: { ...record.installation, generation: "new" },
              })),
            },
          ] as const),
        )
        .pipe(Effect.orDie),
    );
    expect(
      yield* f.plugins
        .grantProject(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            projectId: ProjectId.make("extra"),
          },
          manager,
        )
        .pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { reason: "stale_generation" } });
    expect((yield* f.plugins.list()).installations[0]?.grants.projectIds).toEqual([projectId]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(["action", "view", "status", "agent"] as const)(
  "only a host-verified client action can restore through %s execution",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const declared = {
        ...manifest,
        optionalCapabilities: ["ui.native-trees", "ui.native-tree-projects"],
        nativeTrees: [{ id: "projects", title: "Projects" }],
      };
      yield* f.fs.writeFileString(
        f.path.join(f.directory, "t3-plugin.json"),
        yield* encodeJson(declared),
      );
      const installed = yield* f.install();
      const enabled = yield* f.plugins.consent({
        installationId: installed.installationId,
        digest: installed.digest,
        grants: {
          capabilities: ["ui", "threads.read", "ui.native-trees", "ui.native-tree-projects"],
          projectIds: [projectId],
        },
      });
      const receipts = Context.get(f.context, Receipts.PluginReceipts);
      const key = "creation:restorable";
      yield* receipts.reserve({
        key,
        installationId: enabled.installationId,
        generation: "older",
        requestDigest: "creation",
      });
      const core = Context.get(
        yield* Layer.build(CoreReceipts.layer),
        CoreReceipts.OrchestrationCommandReceiptRepository,
      );
      yield* core.upsert({
        commandId: CommandId.make(key),
        aggregateKind: "thread",
        aggregateId: threadId,
        commandType: "thread.create",
        acceptedAt: stamp,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });
      f.threadShells.set(threadId, { ...shell, archivedAt: at });
      f.setHandler((_invocation, host) =>
        host("threads.unarchive", { threadId, clientAction: true }).pipe(
          Effect.map((data) => ({ data })),
        ),
      );
      const result = yield* f.plugins
        .invoke(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            handler:
              kind === "view"
                ? "view:board:restore"
                : kind === "status"
                  ? "status:lane"
                  : "action:review",
            operationId: "restore",
            context: { threadId },
            input: { clientAction: true },
          },
          { ...actor, source: kind === "agent" ? "agent" : "client" },
        )
        .pipe(Effect.result);
      if (kind === "action") {
        expect(result).toMatchObject({ _tag: "Success", success: { data: { threadId } } });
        expect(f.threadShells.get(threadId)?.archivedAt).toBeNull();
        expect(f.lifecycleCommands).toHaveLength(1);
      } else {
        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "permission_denied" } });
        expect(f.threadShells.get(threadId)?.archivedAt).toEqual(at);
        expect(f.lifecycleCommands).toEqual([]);
      }
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(["missing-project", "disabled", "unconsented"] as const)(
  "does not expand grants for %s installations or targets",
  (reason) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const enabled = yield* f.enable();
      if (reason === "missing-project") f.setProjectExists(false);
      else
        yield* f.store.update((state) =>
          Effect.succeed([
            undefined,
            {
              ...state,
              installations: state.installations.map((record) => ({
                ...record,
                installation: {
                  ...record.installation,
                  ...(reason === "disabled"
                    ? { enabled: false }
                    : { consentedDigest: "f".repeat(64) }),
                },
              })),
            },
          ] as const),
        );
      const before = yield* f.store.read;
      const manager: PluginActor = {
        ...actor,
        scopes: [AuthAccessWriteScope, AuthTerminalOperateScope],
      };
      expect(
        yield* f.plugins
          .grantProject(
            {
              installationId: enabled.installationId,
              generation: enabled.generation,
              projectId: ProjectId.make("extra"),
            },
            manager,
          )
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: {
          reason:
            reason === "missing-project"
              ? "permission_denied"
              : reason === "disabled"
                ? "disabled"
                : "needs_consent",
        },
      });
      expect(yield* f.store.read).toBe(before);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

const projectAccessManager: PluginActor = {
  ...actor,
  scopes: [AuthAccessWriteScope, AuthTerminalOperateScope, AuthOrchestrationOperateScope],
};
const requestedProject = ProjectId.make("project:requested");
const projectAccessFixture = Effect.gen(function* () {
  const f = yield* fixture;
  yield* f.fs.writeFileString(
    f.path.join(f.directory, "t3-plugin.json"),
    yield* encodeJson({ ...manifest, optionalCapabilities: ["projects.request-access"] }),
  );
  const enabled = yield* f.enable(["projects.request-access"]);
  const seed = (requests: ReadonlyArray<ProjectId>) =>
    f.store.update((state) =>
      Effect.succeed([
        undefined,
        {
          ...state,
          installations: state.installations.map((record) => ({
            ...record,
            installation: {
              ...record.installation,
              projectAccessRequests: requests.map((id) => ({
                projectId: id,
                threadId,
                actionId: "private",
                requestedAt: stamp,
              })),
            },
          })),
        },
      ] as const),
    );
  yield* seed([requestedProject]);
  return {
    ...f,
    enabled,
    seed,
    answer: {
      installationId: enabled.installationId,
      generation: enabled.generation,
      projectId: requestedProject,
      decision: "grant" as const,
      shown: { title: "Test", workspaceRoot: f.directory },
    },
  };
});

it.effect.each([
  { name: "an agent", caller: { ...projectAccessManager, source: "agent" as const } },
  {
    name: "a background delivery",
    caller: { ...projectAccessManager, source: "background" as const },
  },
  { name: "a session without access management", caller: actor },
  {
    name: "a session that cannot operate the terminal",
    caller: { ...actor, scopes: [AuthAccessWriteScope, AuthOrchestrationOperateScope] },
  },
  {
    name: "a session outside the project",
    caller: { ...projectAccessManager, projectIds: [projectId] },
  },
] satisfies ReadonlyArray<{ name: string; caller: PluginActor }>)(
  "never lets $name answer a project request",
  ({ caller }) =>
    Effect.gen(function* () {
      const f = yield* projectAccessFixture;
      const before = yield* f.store.read;
      for (const decision of ["grant", "decline"] as const)
        expect(
          (yield* f.plugins
            .answerProjectAccess({ ...f.answer, decision }, caller)
            .pipe(Effect.flip)).reason,
        ).toBe("permission_denied");
      expect(yield* f.store.read).toBe(before);
      expect(f.calls).toEqual([]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("grants only the requested project and tells the plugin through its action", () =>
  Effect.gen(function* () {
    const f = yield* projectAccessFixture;
    const untouched = ProjectId.make("project:untouched");
    yield* f.seed([requestedProject, untouched]);
    const result = yield* f.plugins.answerProjectAccess(f.answer, projectAccessManager);
    expect(result.grants.projectIds).toEqual([projectId, requestedProject]);
    expect(result.projectAccessRequests).toMatchObject([{ projectId: untouched }]);
    expect(f.calls).toMatchObject([
      {
        handler: "action:private",
        input: { projectAccess: "granted" },
        context: { projectId: requestedProject, threadId },
        caller: { kind: "client" },
      },
    ]);
    // A second device's click after the first committed changes nothing.
    expect(
      (yield* f.plugins
        .answerProjectAccess({ ...f.answer, decision: "decline" }, projectAccessManager)
        .pipe(Effect.flip)).reason,
    ).toBe("not_found");
    expect(f.calls).toHaveLength(1);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("records Not now without granting, and tells the plugin the same way", () =>
  Effect.gen(function* () {
    const f = yield* projectAccessFixture;
    const result = yield* f.plugins.answerProjectAccess(
      { ...f.answer, decision: "decline" },
      projectAccessManager,
    );
    expect(result.grants.projectIds).toEqual([projectId]);
    expect(result.projectAccessRequests?.[0]?.declinedAt).toEqual(expect.any(String));
    expect(f.calls).toMatchObject([
      {
        handler: "action:private",
        input: { projectAccess: "declined" },
        context: { projectId: requestedProject, threadId },
      },
    ]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("cannot grant a project nothing asked for, or through a stale generation", () =>
  Effect.gen(function* () {
    const f = yield* projectAccessFixture;
    const before = yield* f.store.read;
    expect(
      (yield* f.plugins
        .answerProjectAccess(
          { ...f.answer, projectId: ProjectId.make("project:unasked") },
          projectAccessManager,
        )
        .pipe(Effect.flip)).reason,
    ).toBe("not_found");
    expect(
      (yield* f.plugins
        .answerProjectAccess({ ...f.answer, generation: "stale" }, projectAccessManager)
        .pipe(Effect.flip)).reason,
    ).toBe("stale_generation");
    expect(yield* f.store.read).toBe(before);
    expect(f.calls).toEqual([]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each([
  { changed: "title", identity: { title: "Sandbox" } },
  { changed: "folder", identity: { workspaceRoot: "/projects/sandbox" } },
])("refuses a grant when the project's $changed changed since the card was shown", ({ identity }) =>
  Effect.gen(function* () {
    const f = yield* projectAccessFixture;
    f.setProjectIdentity(identity);
    const before = yield* f.store.read;
    expect(
      yield* f.plugins.answerProjectAccess(f.answer, projectAccessManager).pipe(Effect.flip),
    ).toMatchObject({ reason: "permission_denied", code: "project_changed" });
    expect(yield* f.store.read).toBe(before);
    expect(f.calls).toEqual([]);

    // The request survives, so the re-rendered card can be answered for what it now shows.
    const result = yield* f.plugins.answerProjectAccess(
      { ...f.answer, shown: { ...f.answer.shown, ...identity } },
      projectAccessManager,
    );
    expect(result.grants.projectIds).toContain(requestedProject);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("refuses a grant when the folder changes during authorization", () =>
  Effect.gen(function* () {
    const f = yield* projectAccessFixture;
    const before = yield* f.store.read;
    const moving: PluginActor = {
      ...projectAccessManager,
      authorize: () =>
        Effect.sync(() => f.setProjectIdentity({ workspaceRoot: "/projects/moved" })),
    };
    expect(yield* f.plugins.answerProjectAccess(f.answer, moving).pipe(Effect.flip)).toMatchObject({
      reason: "permission_denied",
      code: "project_changed",
    });
    expect(yield* f.store.read).toBe(before);
    expect(f.calls).toEqual([]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("refuses a grant when the folder changes just before the store update", () =>
  Effect.gen(function* () {
    const f = yield* projectAccessFixture;
    f.beforeUpdate(() =>
      Effect.sync(() => f.setProjectIdentity({ workspaceRoot: "/projects/moved" })),
    );
    expect(
      yield* f.plugins.answerProjectAccess(f.answer, projectAccessManager).pipe(Effect.flip),
    ).toMatchObject({ code: "project_changed" });
    expect(f.calls).toEqual([]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("still takes Not now for a project renamed while the card was open", () =>
  Effect.gen(function* () {
    const f = yield* projectAccessFixture;
    f.setProjectIdentity({ title: "Sandbox" });
    const result = yield* f.plugins.answerProjectAccess(
      { ...f.answer, decision: "decline" },
      projectAccessManager,
    );
    expect(result.grants.projectIds).toEqual([projectId]);
    expect(result.projectAccessRequests?.[0]?.declinedAt).toEqual(expect.any(String));
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("does not answer for a plugin without the capability", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const enabled = yield* f.enable();
    yield* f.store.update((state) =>
      Effect.succeed([
        undefined,
        {
          ...state,
          installations: state.installations.map((record) => ({
            ...record,
            installation: {
              ...record.installation,
              projectAccessRequests: [
                { projectId: requestedProject, threadId, actionId: "private", requestedAt: stamp },
              ],
            },
          })),
        },
      ] as const),
    );
    expect(
      (yield* f.plugins
        .answerProjectAccess(
          {
            installationId: enabled.installationId,
            generation: enabled.generation,
            projectId: requestedProject,
            decision: "grant",
            shown: { title: "Test", workspaceRoot: f.directory },
          },
          projectAccessManager,
        )
        .pipe(Effect.flip)).reason,
    ).toBe("permission_denied");
  }).pipe(Effect.provide(base()), Effect.scoped),
);
