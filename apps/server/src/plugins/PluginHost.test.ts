import { expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Queue from "effect/Queue";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as CoreReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Config from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import {
  DispatchModeLimit,
  type DispatchModeLimitValue,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import { pluginPermissionDenied, type PluginActor } from "./PluginAuthority.ts";
import * as Database from "./PluginDatabase.ts";
import * as Store from "./PluginStore.ts";
import * as Receipts from "./PluginReceipts.ts";
import * as Host from "./PluginHost.ts";
import * as Supervisor from "./PluginSupervisor.ts";

const projectId = ProjectId.make("project");
const actor: PluginActor = {
  principalId: "client",
  source: "client",
  runtimeMode: "full-access",
  scopes: [AuthOrchestrationOperateScope, AuthOrchestrationReadScope],
};
const base = (database?: ReturnType<typeof Sqlite.layerFromPath>) =>
  Database.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        (database ?? Sqlite.layerMemory).pipe(Layer.provide(NodeServices.layer)),
        Config.layerTest(process.cwd(), { prefix: "plugin-host-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
const fixture = Effect.gen(function* () {
  const shell = v2PullRequestThread({
    id: ThreadId.make("thread"),
    projectId,
    title: "Test",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestUserMessageAt: null,
    createdAt: "2026-10-23T12:00:00.000Z",
    updatedAt: "2026-10-23T12:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
  });
  let effectProject = projectId;
  let effectModes = { runtimeMode: shell.runtimeMode, interactionMode: shell.interactionMode };
  let launches = 0;
  const launchInputs: Array<Launch.ThreadLaunchInput> = [];
  let listedThreads: ReadonlyArray<OrchestrationV2ThreadShell> = [shell];
  let modelEnabled = true;
  let catalog: ReadonlyArray<ServerProvider> = [
    {
      instanceId: shell.modelSelection.instanceId,
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      checkedAt: "2026-10-23T12:00:00.000Z",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: "test", name: "Test model", isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
    },
  ];
  const sends: Array<Threads.ThreadManagementSendInput> = [];
  const limits: Array<DispatchModeLimitValue | undefined> = [];
  let beforeRead: (() => Effect.Effect<void>) | undefined;
  const ownedShells = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const lifecycleCommands: OrchestrationV2ServerCommand[] = [];
  let beforeDispatch: (() => Effect.Effect<void>) | undefined;
  const projection = (id: ThreadId) => ({
    thread: { ...shell, ...ownedShells.get(id), id, projectId: effectProject, lastVisitedAt: null },
    runs: [],
    messages: [
      {
        id: MessageId.make("private-message"),
        threadId: id,
        runId: null,
        nodeId: null,
        role: "assistant" as const,
        text: "private transcript",
        attachments: [],
        streaming: false,
        createdAt: shell.createdAt,
        updatedAt: shell.updatedAt,
        createdBy: "system" as const,
        creationSource: "server" as const,
      },
    ] as const,
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
  });
  const domain = Layer.mock(Threads.ThreadManagementService)({
    getThreadShell: (id) =>
      Effect.sync(() => ({
        ...shell,
        ...effectModes,
        ...ownedShells.get(id),
        id,
        projectId: effectProject,
      })),
    dispatchAuthorized: (command, authorize) =>
      Effect.gen(function* () {
        const before = beforeDispatch;
        beforeDispatch = undefined;
        yield* before?.() ?? Effect.void;
        if (!(yield* authorize)) return null;
        lifecycleCommands.push(command);
        const current = ownedShells.get(command.threadId) ?? { ...shell, id: command.threadId };
        ownedShells.set(
          command.threadId,
          command.type === "thread.unarchive"
            ? { ...current, archivedAt: null }
            : {
                ...current,
                ...(command.pluginOwner === undefined ? {} : { pluginOwner: command.pluginOwner }),
              },
        );
        return { sequence: lifecycleCommands.length, storedEvents: [] };
      }),
    getThreadRecords: (id) => Effect.sync(() => projection(id)),
    listProjectThreads: () => Effect.sync(() => listedThreads),
    isProviderInstanceEnabledForProject: () => Effect.sync(() => modelEnabled),
    ensureLegacyTranscript: () => Effect.void,
    getThreadSnapshotWindow: (id) =>
      Effect.sync(() => ({ schemaVersion: 1, snapshotSequence: 1, projection: projection(id) })),
    sendToThread: (input) =>
      Effect.gen(function* () {
        limits.push(yield* DispatchModeLimit);
        sends.push(input);
        const run = {
          id: RunId.make("run"),
          threadId: input.threadId,
          ordinal: 1,
          providerInstanceId: shell.providerInstanceId,
          modelSelection: shell.modelSelection,
          providerThreadId: null,
          userMessageId: input.messageId,
          rootNodeId: null,
          activeAttemptId: null,
          status: "queued" as const,
          requestedAt: shell.createdAt,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        };
        const message = {
          ...projection(input.threadId).messages[0],
          id: input.messageId,
          role: "user" as const,
          runId: run.id,
          text: input.text,
        };
        return {
          dispatch: { sequence: 1, storedEvents: [] },
          projection: { ...projection(input.threadId), runs: [run], messages: [message] },
          message,
          run,
          turnItem: null,
          delivery: "queued" as const,
        };
      }),
  });
  let beforeLaunch: (commandId: CommandId) => Effect.Effect<void, Launch.ThreadLaunchError> = () =>
    Effect.void;
  let projectDefaultModelSelection: OrchestrationV2ThreadShell["modelSelection"] | null =
    shell.modelSelection;
  const projectShell = {
    id: projectId,
    title: "Test",
    workspaceRoot: "/fixture",
    defaultModelSelection: shell.modelSelection,
    scripts: [],
    createdAt: "2026-10-23T12:00:00.000Z",
    updatedAt: "2026-10-23T12:00:00.000Z",
  };
  const layer = Host.layer.pipe(
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
          }),
        ),
      ).pipe(Layer.provide(Store.layer)),
    ),
    Layer.provideMerge(Receipts.layer),
    Layer.provideMerge(domain),
    Layer.provideMerge(
      Layer.mock(Launch.ThreadLaunchService)({
        checkWorktreeBase: () => Effect.void,
        launch: (input) =>
          Effect.gen(function* () {
            yield* beforeLaunch(input.commandId);
            launches++;
            launchInputs.push(input);
            const launchedThreadId = input.threadId ?? ThreadId.make("fixture-thread");
            return {
              threadId: launchedThreadId,
              projection: projection(launchedThreadId),
              resumed: false,
            };
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(Projects.ProjectService)({
        listShells: () => Effect.succeed([projectShell]),
        getShell: () =>
          Effect.succeed(
            Option.some({
              id: projectId,
              title: "Test",
              workspaceRoot: "/fixture",
              defaultModelSelection: projectDefaultModelSelection,
              scripts: [],
              createdAt: "2026-10-23T12:00:00.000Z",
              updatedAt: "2026-10-23T12:00:00.000Z",
            }),
          ),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.sync(() => catalog) }),
    ),
    Layer.provideMerge(Settings.layerTest({ defaultModelSelection: shell.modelSelection })),
  );
  const context = yield* Layer.build(layer);
  const host = Context.get(context, Host.PluginHost);
  const store = Context.get(context, Store.PluginStore);
  const receipts = Context.get(context, Receipts.PluginReceipts);
  yield* store.update((state) =>
    Effect.succeed([
      undefined,
      {
        ...state,
        installations: [
          {
            directory: "/fixture",
            secrets: {},
            storage: {},
            eventCursor: 0,
            installation: {
              installationId: "plugin",
              generation: "one",
              manifest: {
                id: "test.host",
                name: "Test",
                version: "1.0.0",
                apiVersion: 1,
                entry: "plugin.mjs",
                capabilities: ["threads.create", "threads.read", "threads.send", "workflow.query"],
                actions: [],
                views: [],
                settings: [],
              },
              source: { kind: "local", directory: "/fixture" },
              digest: "0".repeat(64),
              enabled: true,
              consentedDigest: "0".repeat(64),
              status: "idle",
              error: null,
              settings: {},
              grants: {
                capabilities: ["threads.create", "threads.read", "threads.send", "workflow.query"],
                projectIds: [projectId],
              },
              updatedAt: "2026-10-23T12:00:00.000Z",
            },
          },
        ],
      },
    ] as const),
  );
  const invocation = {
    installationId: "plugin",
    generation: "one",
    actor,
    operationId: "run-1",
    callId: 1,
    event: true,
  };
  const request = { idempotencyKey: "follow-up", projectId, text: "Same request" };
  return {
    host,
    store,
    receipts,
    threads: Context.get(context, Threads.ThreadManagementService),
    beforeRead: (value: NonNullable<typeof beforeRead>) => {
      beforeRead = value;
    },
    invocation,
    request,
    launches: () => launches,
    launchInputs,
    lifecycleCommands,
    setShell: (value: OrchestrationV2ThreadShell) => {
      ownedShells.set(value.id, value);
    },
    beforeDispatch: (value: NonNullable<typeof beforeDispatch>) => {
      beforeDispatch = value;
    },
    shell,
    registry: Context.get(context, ProviderRegistry.ProviderRegistry),
    projects: Context.get(context, Projects.ProjectService),
    launch: Context.get(context, Launch.ThreadLaunchService),
    settings: Context.get(context, Settings.ServerSettingsService),
    setListedThreads: (value: typeof listedThreads) => {
      listedThreads = value;
    },
    setProjectDefaultModelSelection: (value: typeof projectDefaultModelSelection) => {
      projectDefaultModelSelection = value;
    },
    setCatalog: (value: typeof catalog) => {
      catalog = value;
    },
    setModelEnabled: (value: boolean) => {
      modelEnabled = value;
    },
    sends,
    limits,
    setEffectModes: (value: typeof effectModes) => {
      effectModes = value;
    },
    setBeforeLaunch: (value: typeof beforeLaunch) => {
      beforeLaunch = value;
    },
    setEffectProject: (value: ProjectId) => {
      effectProject = value;
    },
  };
});
it.effect.each([false, true])("reads a transcript with a stable actor (live=%s)", (live) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const result = yield* f.host.call(
      { ...f.invocation, actor: { ...actor, ...(live ? { authorize: () => Effect.void } : {}) } },
      "threads.read",
      { threadId: ThreadId.make("thread") },
    );
    expect(result).toMatchObject({
      projectId,
      messages: [{ text: "private transcript" }],
    });
  }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect.each([false, true])(
  "sends with a stable actor and preserves its mode ceiling (live=%s)",
  (live) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const modes = { runtimeMode: "approval-required", interactionMode: "plan" } as const;
      f.setEffectModes(modes);
      const result = yield* f.host.call(
        {
          ...f.invocation,
          actor: { ...actor, ...modes, ...(live ? { authorize: () => Effect.void } : {}) },
        },
        "threads.send",
        { ...f.request, threadId: ThreadId.make("thread") },
      );
      expect(result).toMatchObject({ threadId: "thread", delivery: "queued" });
      expect(f.sends).toHaveLength(1);
      expect(f.limits).toEqual([modes]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect("denies a transcript when the session is revoked during its final catalogue wait", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const snapshotEntered = yield* Deferred.make<void>();
    const releaseSnapshot = yield* Deferred.make<void>();
    const lockEntered = yield* Deferred.make<void>();
    const releaseLock = yield* Deferred.make<void>();
    const readEntered = yield* Deferred.make<void>();
    const snapshot = f.threads.getThreadSnapshotWindow;
    using _snapshot = vi
      .spyOn(f.threads, "getThreadSnapshotWindow")
      .mockImplementationOnce((...args) =>
        snapshot(...args).pipe(
          Effect.tap(() =>
            Deferred.succeed(snapshotEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseSnapshot)),
            ),
          ),
        ),
      );
    let revoked = false;
    const pending = yield* f.host
      .call(
        {
          ...f.invocation,
          actor: {
            ...actor,
            authorize: () =>
              Effect.suspend(() => (revoked ? Effect.fail(pluginPermissionDenied()) : Effect.void)),
          },
        },
        "threads.read",
        { threadId: ThreadId.make("thread") },
      )
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(snapshotEntered);
    const lock = yield* f.store
      .update((state) =>
        Deferred.succeed(lockEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseLock)),
          Effect.as([undefined, state] as const),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(lockEntered);
    f.beforeRead(() => Deferred.succeed(readEntered, undefined));
    yield* Deferred.succeed(releaseSnapshot, undefined);
    yield* Deferred.await(readEntered);
    revoked = true;
    yield* Deferred.succeed(releaseLock, undefined);
    yield* Fiber.join(lock);
    expect(yield* Fiber.join(pending)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "permission_denied" },
    });
  }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect.each(["project-grant", "generation"] as const)(
  "denies a transcript after its %s changes during snapshot IO",
  (change) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const snapshot = f.threads.getThreadSnapshotWindow;
      using _snapshot = vi
        .spyOn(f.threads, "getThreadSnapshotWindow")
        .mockImplementationOnce((...args) =>
          snapshot(...args).pipe(
            Effect.tap(() =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            ),
          ),
        );
      const pending = yield* f.host
        .call(f.invocation, "threads.read", { threadId: ThreadId.make("thread") })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              installation: {
                ...record.installation,
                ...(change === "generation"
                  ? { generation: "two" }
                  : {
                      grants: { ...record.installation.grants, projectIds: [] },
                    }),
              },
            })),
          },
        ] as const),
      );
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { reason: change === "generation" ? "stale_generation" : "permission_denied" },
      });
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect(
  "does not create a thread after session revocation during its pre-dispatch catalogue wait",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const lockEntered = yield* Deferred.make<void>();
      const releaseLock = yield* Deferred.make<void>();
      const readEntered = yield* Deferred.make<void>();
      const reserve = f.receipts.reserve;
      using _reserve = vi.spyOn(f.receipts, "reserve").mockImplementationOnce((input) =>
        reserve(input).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
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
            }),
          ),
        ),
      );
      let revoked = false;
      const pending = yield* f.host
        .call(
          {
            ...f.invocation,
            actor: {
              ...actor,
              authorize: () =>
                Effect.suspend(() =>
                  revoked ? Effect.fail(pluginPermissionDenied()) : Effect.void,
                ),
            },
          },
          "threads.create",
          f.request,
        )
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(readEntered);
      revoked = true;
      yield* Deferred.succeed(releaseLock, undefined);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "permission_denied" },
      });
      expect(f.launches()).toBe(0);
      expect(
        yield* (yield* SqlClient.SqlClient)`SELECT operation_key FROM plugin_operation_receipts`,
      ).toEqual([]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect.each(
  (["new-result", "cached-result", "prior-effect"] as const).flatMap((response) =>
    (["session", "project-grant", "generation"] as const).map((change) => ({ response, change })),
  ),
)(
  "does not disclose $response after $change revocation during effect target IO",
  ({ response, change }) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      if (response !== "new-result") yield* f.host.call(f.invocation, "threads.create", f.request);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const getShell = f.threads.getThreadShell;
      using _shell = vi
        .spyOn(f.threads, "getThreadShell")
        .mockImplementationOnce((id) =>
          getShell(id).pipe(
            Effect.tap(() =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            ),
          ),
        );
      let revoked = false;
      const pending = yield* f.host
        .call(
          {
            ...f.invocation,
            actor: {
              ...actor,
              authorize: () =>
                Effect.suspend(() =>
                  revoked ? Effect.fail(pluginPermissionDenied()) : Effect.void,
                ),
            },
          },
          "threads.create",
          response === "prior-effect" ? { ...f.request, text: "Changed" } : f.request,
        )
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      if (change === "session") revoked = true;
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
                  ...(change === "generation"
                    ? { generation: "two" }
                    : {
                        grants: { ...record.installation.grants, projectIds: [] },
                      }),
                },
              })),
            },
          ] as const),
        );
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(pending);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.priorEffect).toBeUndefined();
        if (response !== "prior-effect") expect(result.failure.reason).toBe("permission_denied");
      }
      expect(f.launches()).toBe(1);
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect.each(["session", "project-grant", "generation"] as const)(
  "does not send after %s revocation during pre-dispatch target IO",
  (change) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let reserved = false;
      const reserve = f.receipts.reserve;
      using _reserve = vi.spyOn(f.receipts, "reserve").mockImplementationOnce((input) =>
        reserve(input).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              reserved = true;
            }),
          ),
        ),
      );
      const getShell = f.threads.getThreadShell;
      using _shell = vi.spyOn(f.threads, "getThreadShell").mockImplementation((id) =>
        getShell(id).pipe(
          Effect.tap(() => {
            if (!reserved) return Effect.void;
            reserved = false;
            return Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            );
          }),
        ),
      );
      let revoked = false;
      const pending = yield* f.host
        .call(
          {
            ...f.invocation,
            actor: {
              ...actor,
              authorize: () =>
                Effect.suspend(() =>
                  revoked ? Effect.fail(pluginPermissionDenied()) : Effect.void,
                ),
            },
          },
          "threads.send",
          { ...f.request, threadId: ThreadId.make("thread") },
        )
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      if (change === "session") revoked = true;
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
                  ...(change === "generation"
                    ? { generation: "two" }
                    : {
                        grants: { ...record.installation.grants, projectIds: [] },
                      }),
                },
              })),
            },
          ] as const),
        );
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "permission_denied" },
      });
      expect(f.sends).toEqual([]);
      expect(
        yield* (yield* SqlClient.SqlClient)`SELECT operation_key FROM plugin_operation_receipts`,
      ).toEqual([]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect.each(
  (["threads.create", "threads.send"] as const).flatMap((method) =>
    (["session", "generation"] as const).map((change) => ({ method, change })),
  ),
)(
  "revalidates $method after $change revocation while waiting for its command lock",
  ({ method, change }) =>
    Effect.gen(function* () {
      const waiting = yield* Deferred.make<void>();
      const makeLock = KeyedLock.make;
      let attempts = 0;
      using _lock = vi.spyOn(KeyedLock, "make").mockImplementationOnce(function <Key>() {
        return makeLock<Key>().pipe(
          Effect.map(
            (lock) =>
              ({
                ...lock,
                withLock: (key, effect) =>
                  Effect.suspend(() => {
                    const entered =
                      ++attempts === 2 ? Deferred.succeed(waiting, undefined) : Effect.void;
                    return entered.pipe(Effect.andThen(lock.withLock(key, effect)));
                  }),
              }) satisfies KeyedLock.KeyedLock<Key>,
          ),
        );
      });
      const f = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const wait = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      f.setBeforeLaunch(() => wait);
      const send = f.threads.sendToThread;
      using _send = vi
        .spyOn(f.threads, "sendToThread")
        .mockImplementationOnce((input) => wait.pipe(Effect.andThen(send(input))));
      const request =
        method === "threads.create"
          ? f.request
          : { ...f.request, threadId: ThreadId.make("thread") };
      const first = yield* f.host
        .call(f.invocation, method, request)
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      let revoked = false;
      const second = yield* f.host
        .call(
          {
            ...f.invocation,
            actor: {
              ...actor,
              authorize: () =>
                Effect.suspend(() =>
                  revoked ? Effect.fail(pluginPermissionDenied()) : Effect.void,
                ),
            },
          },
          method,
          request,
        )
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(waiting);
      if (change === "session") revoked = true;
      else
        yield* f.store.update((state) =>
          Effect.succeed([
            undefined,
            {
              ...state,
              installations: state.installations.map((record) => ({
                ...record,
                installation: { ...record.installation, generation: "two" },
              })),
            },
          ] as const),
        );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      expect(yield* Fiber.join(second)).toMatchObject({
        _tag: "Failure",
        failure: { reason: change === "generation" ? "stale_generation" : "permission_denied" },
      });
      expect(f.launches() + f.sends.length).toBe(1);
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect.each(["runtime", "interaction"] as const)(
  "rechecks a send target's %s mode before dispatch after a domain wait",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const modes = { runtimeMode: "approval-required", interactionMode: "plan" } as const;
      f.setEffectModes(modes);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const reserve = f.receipts.reserve;
      using _reserve = vi
        .spyOn(f.receipts, "reserve")
        .mockImplementationOnce((input) =>
          reserve(input).pipe(
            Effect.tap(() =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            ),
          ),
        );
      const pending = yield* f.host
        .call({ ...f.invocation, actor: { ...actor, ...modes } }, "threads.send", {
          ...f.request,
          threadId: ThreadId.make("thread"),
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      f.setEffectModes(
        mode === "runtime"
          ? { ...modes, runtimeMode: "full-access" }
          : { ...modes, interactionMode: "default" },
      );
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "permission_denied" },
      });
      expect(f.sends).toEqual([]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect("uses one effect key across revisions while separating actor namespaces", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const first = yield* f.host.call(f.invocation, "threads.create", f.request);
    yield* f.store.update((state) =>
      Effect.succeed([
        undefined,
        {
          ...state,
          installations: state.installations.map((record) => ({
            ...record,
            installation: { ...record.installation, generation: "two" },
          })),
        },
      ] as const),
    );
    expect(
      yield* f.host.call({ ...f.invocation, generation: "two" }, "threads.create", f.request),
    ).toEqual(first);
    expect(f.launches()).toBe(1);
    yield* f.host.call(
      { ...f.invocation, generation: "two", actor: { ...actor, principalId: "other" } },
      "threads.create",
      f.request,
    );
    expect(f.launches()).toBe(2);
  }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect(
  "redacts prior effects and cached results when their project leaves current authority",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.host.call(f.invocation, "threads.create", f.request);
      const conflict = yield* f.host
        .call(f.invocation, "threads.create", { ...f.request, text: "Changed" })
        .pipe(Effect.flip, Effect.orDie);
      expect(conflict).toMatchObject({ code: "idempotency_conflict", priorEffect: first });
      f.setEffectProject(ProjectId.make("revoked-project"));
      const redacted = yield* f.host
        .call(f.invocation, "threads.create", { ...f.request, text: "Changed" })
        .pipe(Effect.flip, Effect.orDie);
      expect(redacted.code).toBe("idempotency_conflict");
      expect(redacted.priorEffect).toBeUndefined();
      expect(
        (yield* f.host
          .call(f.invocation, "threads.create", f.request)
          .pipe(Effect.flip, Effect.orDie)).reason,
      ).toBe("permission_denied");
      expect(f.launches()).toBe(1);
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect("revokes an in-flight reservation before returning its cached privileged result", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.host.call(f.invocation, "threads.create", f.request);
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let checks = 0;
    const liveActor: PluginActor = {
      ...actor,
      authorize: () =>
        Effect.gen(function* () {
          checks++;
          if (checks === 4) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
        }),
    };
    const pending = yield* f.host
      .call({ ...f.invocation, actor: liveActor }, "threads.create", f.request)
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* f.store.update((state) =>
      Effect.succeed([
        undefined,
        {
          ...state,
          installations: state.installations.map((record) => ({
            ...record,
            installation: { ...record.installation, generation: "two" },
          })),
        },
      ] as const),
    );
    yield* Deferred.succeed(release, undefined);
    expect((yield* Fiber.join(pending).pipe(Effect.flip, Effect.orDie)).reason).toBe(
      "stale_generation",
    );
    expect(f.launches()).toBe(1);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

const failLaunch = (commandId: CommandId) =>
  Effect.fail(
    new Launch.ThreadLaunchError({
      commandId,
      projectId,
      operation: "create-thread",
      cause: "fixture pre-dispatch failure",
    }),
  );
it.effect(
  "releases failed pre-dispatch fingerprints and budgets for a corrected same-key retry",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      f.setBeforeLaunch(failLaunch);
      for (let attempt = 0; attempt < 4; attempt++) {
        expect(
          (yield* f.host
            .call(f.invocation, "threads.create", { ...f.request, text: `Broken ${attempt}` })
            .pipe(Effect.flip, Effect.orDie)).reason,
        ).toBe("operation_failed");
        expect(yield* sql`SELECT operation_key FROM plugin_operation_receipts`).toEqual([]);
        expect(yield* sql`SELECT operation_key FROM plugin_event_reservations`).toEqual([]);
      }
      f.setBeforeLaunch(() => Effect.void);
      yield* f.host.call(f.invocation, "threads.create", { ...f.request, text: "Corrected" });
      expect(f.launches()).toBe(1);
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect.each([false, true])(
  "releases interrupted pre-dispatch fingerprints for a corrected retry (event=%s)",
  (event) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const invocation = { ...f.invocation, event };
      for (let attempt = 0; attempt < 4; attempt++) {
        const entered = yield* Deferred.make<void>();
        f.setBeforeLaunch(() =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        );
        const pending = yield* f.host
          .call(invocation, "threads.create", { ...f.request, text: `Interrupted ${attempt}` })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(pending);
        expect(Exit.hasInterrupts(yield* Fiber.await(pending))).toBe(true);
        expect(yield* sql`SELECT command_id FROM orchestration_command_receipts`).toEqual([]);
        expect(yield* sql`SELECT operation_key FROM plugin_operation_receipts`).toEqual([]);
        expect(yield* sql`SELECT operation_key FROM plugin_event_reservations`).toEqual([]);
      }
      f.setBeforeLaunch(() => Effect.void);
      yield* f.host.call(invocation, "threads.create", { ...f.request, text: "Repaired text" });
      expect(f.launches()).toBe(1);
      expect(yield* sql`SELECT operation_key FROM plugin_event_reservations`).toHaveLength(
        event ? 1 : 0,
      );
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect.each([false, true])(
  "releases interruption immediately after the reservation commits (event=%s)",
  (event) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const persisted = yield* Deferred.make<void>();
      const reserve = f.receipts.reserve;
      using _reserve = vi
        .spyOn(f.receipts, "reserve")
        .mockImplementationOnce((input) =>
          reserve(input).pipe(
            Effect.tap(() =>
              Deferred.succeed(persisted, undefined).pipe(Effect.andThen(Effect.never)),
            ),
          ),
        );
      const invocation = { ...f.invocation, event };
      const pending = yield* f.host
        .call(invocation, "threads.create", f.request)
        .pipe(Effect.forkChild);
      yield* Deferred.await(persisted);
      expect(f.launches()).toBe(0);
      expect(yield* sql`SELECT operation_key FROM plugin_operation_receipts`).toHaveLength(1);
      expect(yield* sql`SELECT operation_key FROM plugin_event_reservations`).toHaveLength(
        event ? 1 : 0,
      );
      yield* Fiber.interrupt(pending);
      expect(Exit.hasInterrupts(yield* Fiber.await(pending))).toBe(true);
      expect(yield* sql`SELECT command_id FROM orchestration_command_receipts`).toEqual([]);
      expect(yield* sql`SELECT operation_key FROM plugin_operation_receipts`).toEqual([]);
      expect(yield* sql`SELECT operation_key FROM plugin_event_reservations`).toEqual([]);
      yield* f.host.call(invocation, "threads.create", { ...f.request, text: "Repaired text" });
      expect(f.launches()).toBe(1);
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect("waits for core rollback and domain cleanup before releasing a same-key retry", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    const entered = yield* Deferred.make<void>();
    const unwinding = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let first = true;
    f.setBeforeLaunch((commandId) => {
      if (!first) return Effect.void;
      first = false;
      return sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO orchestration_command_receipts
              (command_id,aggregate_kind,aggregate_id,command_type,accepted_at,result_sequence,status,error)
              VALUES(${commandId},'thread',${`${commandId}:thread`},'thread.create','2026-10-23T12:00:00.000Z',1,'accepted',NULL)`;
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
        )
        .pipe(
          Effect.orDie,
          Effect.ensuring(
            Deferred.succeed(unwinding, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
    });
    const pending = yield* f.host
      .call(f.invocation, "threads.create", f.request)
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const interrupted = yield* Fiber.interrupt(pending).pipe(Effect.forkChild);
    yield* Deferred.await(unwinding);
    expect(yield* sql`SELECT command_id FROM orchestration_command_receipts`).toEqual([]);
    expect(yield* sql`SELECT operation_key FROM plugin_operation_receipts`).toHaveLength(1);
    expect(yield* sql`SELECT operation_key FROM plugin_event_reservations`).toHaveLength(1);
    const retried = yield* f.host
      .call(f.invocation, "threads.create", { ...f.request, text: "Repaired text" })
      .pipe(Effect.forkChild);
    yield* f.host.call(f.invocation, "threads.create", {
      ...f.request,
      idempotencyKey: "independent",
    });
    expect(f.launches()).toBe(1);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(interrupted);
    expect(Exit.hasInterrupts(yield* Fiber.await(pending))).toBe(true);
    yield* Fiber.join(retried);
    expect(f.launches()).toBe(2);
    expect(yield* sql`SELECT operation_key FROM plugin_event_reservations`).toHaveLength(2);
  }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect("review: frozen v1 create-only client action still creates with a thread context", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.store.update((state) =>
      Effect.succeed([
        undefined,
        {
          ...state,
          installations: state.installations.map((record) => ({
            ...record,
            installation: {
              ...record.installation,
              manifest: { ...record.installation.manifest, capabilities: ["threads.create"] },
              grants: { capabilities: ["threads.create"], projectIds: [projectId] },
            },
          })),
        },
      ] as const),
    );
    const result = yield* f.host
      .call(
        {
          ...f.invocation,
          event: false,
          context: { threadId: f.shell.id, projectId },
        },
        "threads.create",
        f.request,
      )
      .pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Success" });
    expect(f.launches()).toBe(1);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(
  (["client", "agent"] as const).flatMap((source) => [
    ...(["capability", "scope", "source-project", "actor-project"] as const).map(
      (readAuthority) => ({ source, readAuthority, limited: false }),
    ),
    { source, readAuthority: "capability" as const, limited: true },
  ]),
)(
  "uses project defaults without source $readAuthority authority for $source (limited=$limited)",
  ({ source, readAuthority, limited }) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const sourceProject = ProjectId.make("source-project");
      const capabilities =
        readAuthority === "capability"
          ? (["threads.create"] as const)
          : (["threads.create", "threads.read"] as const);
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              installation: {
                ...record.installation,
                manifest: { ...record.installation.manifest, capabilities },
                grants: {
                  capabilities,
                  projectIds:
                    readAuthority === "actor-project" ? [projectId, sourceProject] : [projectId],
                },
              },
            })),
          },
        ] as const),
      );
      yield* f.settings.updateSettings({ defaultRuntimeMode: "full-access" });
      const modes = limited
        ? ({ runtimeMode: "approval-required", interactionMode: "plan" } as const)
        : ({ runtimeMode: "full-access", interactionMode: "default" } as const);
      f.setEffectModes(modes);
      const getShell = f.threads.getThreadShell;
      using _shell = vi.spyOn(f.threads, "getThreadShell").mockImplementation((id) =>
        id === f.shell.id
          ? Effect.succeed({
              ...f.shell,
              modelSelection: { ...f.shell.modelSelection, model: "source-model" },
              runtimeMode: "approval-required",
              interactionMode: "plan",
              projectId:
                readAuthority === "source-project" || readAuthority === "actor-project"
                  ? sourceProject
                  : projectId,
            })
          : getShell(id),
      );
      yield* f.host.call(
        {
          ...f.invocation,
          event: false,
          actor: {
            ...actor,
            ...modes,
            source,
            ...(source === "agent" ? { threadId: f.shell.id } : {}),
            ...(readAuthority === "scope" ? { scopes: [AuthOrchestrationOperateScope] } : {}),
            ...(readAuthority === "actor-project" ? { projectIds: [projectId] } : {}),
          },
          context: { threadId: f.shell.id, projectId },
        },
        "threads.create",
        { ...f.request, launchedFrom: { threadId: "forged" } },
      );
      expect(f.launchInputs).toHaveLength(1);
      expect(f.launchInputs[0]).toMatchObject({ modelSelection: f.shell.modelSelection, ...modes });
      expect(f.launchInputs[0]).not.toHaveProperty("launchedFrom");
      if (readAuthority === "capability" || readAuthority === "scope")
        expect(_shell.mock.calls.some(([id]) => id === f.shell.id)).toBe(false);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("inherits source defaults and verified provenance with source read authority", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const source = {
      ...f.shell,
      modelSelection: { ...f.shell.modelSelection, model: "source-model" },
      runtimeMode: "approval-required" as const,
      interactionMode: "plan" as const,
    };
    const getShell = f.threads.getThreadShell;
    using _shell = vi
      .spyOn(f.threads, "getThreadShell")
      .mockImplementation((id) => (id === source.id ? Effect.succeed(source) : getShell(id)));
    yield* f.host.call({ ...f.invocation, context: { threadId: source.id } }, "threads.create", {
      ...f.request,
      launchedFrom: { threadId: "forged" },
    });
    expect(f.launchInputs).toHaveLength(1);
    expect(f.launchInputs[0]).toMatchObject({
      modelSelection: source.modelSelection,
      runtimeMode: source.runtimeMode,
      interactionMode: source.interactionMode,
      launchedFrom: { threadId: source.id },
    });
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("releases a pre-dispatch defect without changing its cause", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.setBeforeLaunch(() => Effect.die("fixture pre-dispatch defect"));
    const failed = yield* f.host.call(f.invocation, "threads.create", f.request).pipe(Effect.exit);
    expect(Exit.isFailure(failed) && failed.cause.reasons).toEqual([
      expect.objectContaining({ defect: "fixture pre-dispatch defect" }),
    ]);
    f.setBeforeLaunch(() => Effect.void);
    yield* f.host.call(f.invocation, "threads.create", { ...f.request, text: "Repaired text" });
    expect(f.launches()).toBe(1);
  }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect.each(["accepted", "rejected"] as const)(
  "retains the binding when interrupted after a committed %s core receipt",
  (status) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const core = Context.get(
        yield* Layer.build(CoreReceipts.layer),
        CoreReceipts.OrchestrationCommandReceiptRepository,
      );
      const committed = yield* Deferred.make<void>();
      f.setBeforeLaunch((commandId) =>
        sql
          .withTransaction(
            core.upsert({
              commandId,
              aggregateKind: "thread",
              aggregateId: ThreadId.make(`${commandId}:thread`),
              commandType: "thread.create",
              acceptedAt: "2026-10-23T12:00:00.000Z",
              resultSequence: 1,
              status,
              error: status === "rejected" ? "fixture rejection" : null,
            }),
          )
          .pipe(
            Effect.orDie,
            Effect.andThen(Deferred.succeed(committed, undefined)),
            Effect.andThen(Effect.never),
          ),
      );
      const pending = yield* f.host
        .call(f.invocation, "threads.create", f.request)
        .pipe(Effect.forkChild);
      yield* Deferred.await(committed);
      yield* Fiber.interrupt(pending);
      expect(Exit.hasInterrupts(yield* Fiber.await(pending))).toBe(true);
      expect(yield* sql`SELECT status FROM orchestration_command_receipts`).toEqual([{ status }]);
      expect(yield* sql`SELECT result_json,effect_json FROM plugin_operation_receipts`).toEqual([
        { result_json: null, effect_json: null },
      ]);
      const conflict = yield* f.host
        .call(f.invocation, "threads.create", { ...f.request, text: "Changed after commit" })
        .pipe(Effect.flip, Effect.orDie);
      expect(conflict.code).toBe("idempotency_conflict");
      expect(yield* sql`SELECT operation_key FROM plugin_event_reservations`).toHaveLength(1);
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect("checks current grants before creating fingerprints or consuming event budget", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    let checks = 0;
    const liveActor: PluginActor = {
      ...actor,
      authorize: () =>
        Effect.gen(function* () {
          checks++;
          if (checks !== 3) return;
          yield* f.store
            .update((state) =>
              Effect.succeed([
                undefined,
                {
                  ...state,
                  installations: state.installations.map((record) => ({
                    ...record,
                    installation: {
                      ...record.installation,
                      grants: { capabilities: [], projectIds: [] },
                    },
                  })),
                },
              ] as const),
            )
            .pipe(Effect.orDie);
        }),
    };
    expect(
      (yield* f.host
        .call({ ...f.invocation, actor: liveActor }, "threads.create", f.request)
        .pipe(Effect.flip, Effect.orDie)).reason,
    ).toBe("permission_denied");
    expect(f.launches()).toBe(0);
    expect(yield* sql`SELECT operation_key FROM plugin_operation_receipts`).toEqual([]);
    expect(yield* sql`SELECT operation_key FROM plugin_event_reservations`).toEqual([]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect("serializes same-key failure and retry while allowing unrelated keys to finish", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let first = true;
    f.setBeforeLaunch((commandId) =>
      Effect.gen(function* () {
        if (!first) return;
        first = false;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return yield* failLaunch(commandId);
      }),
    );
    const failed = yield* f.host
      .call(f.invocation, "threads.create", f.request)
      .pipe(Effect.flip, Effect.orDie, Effect.forkChild);
    yield* Deferred.await(entered);
    const retried = yield* f.host
      .call(f.invocation, "threads.create", { ...f.request, text: "Corrected" })
      .pipe(Effect.forkChild);
    yield* f.host.call(f.invocation, "threads.create", {
      ...f.request,
      idempotencyKey: "independent",
    });
    yield* Deferred.succeed(release, undefined);
    expect((yield* Fiber.join(failed)).reason).toBe("operation_failed");
    yield* Fiber.join(retried);
    expect(f.launches()).toBe(2);
  }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect.each(["accepted", "rejected"] as const)(
  "retains the binding after a %s core receipt even when dispatch reports failure",
  (status) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const core = Context.get(
        yield* Layer.build(CoreReceipts.layer),
        CoreReceipts.OrchestrationCommandReceiptRepository,
      );
      f.setBeforeLaunch((commandId) =>
        core
          .upsert({
            commandId,
            aggregateKind: "thread",
            aggregateId: ThreadId.make(`${commandId}:thread`),
            commandType: "thread.create",
            acceptedAt: "2026-10-23T12:00:00.000Z",
            resultSequence: 1,
            status,
            error: status === "rejected" ? "fixture rejection" : null,
          })
          .pipe(Effect.orDie, Effect.andThen(failLaunch(commandId))),
      );
      expect(
        (yield* f.host
          .call(f.invocation, "threads.create", f.request)
          .pipe(Effect.flip, Effect.orDie)).reason,
      ).toBe("operation_failed");
      const conflict = yield* f.host
        .call(f.invocation, "threads.create", { ...f.request, text: "Changed after commit" })
        .pipe(Effect.flip, Effect.orDie);
      expect(conflict.code).toBe("idempotency_conflict");
      expect(
        yield* (yield* SqlClient.SqlClient)`SELECT operation_key FROM plugin_event_reservations`,
      ).toHaveLength(1);
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect("retains the binding when core receipt lookup cannot establish the outcome", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE orchestration_command_receipts RENAME TO unavailable_receipts`;
    f.setBeforeLaunch(failLaunch);
    expect(
      (yield* f.host
        .call(f.invocation, "threads.create", f.request)
        .pipe(Effect.flip, Effect.orDie)).reason,
    ).toBe("operation_failed");
    expect(
      (yield* f.host
        .call(f.invocation, "threads.create", { ...f.request, text: "Unknown prior outcome" })
        .pipe(Effect.flip, Effect.orDie)).code,
    ).toBe("idempotency_conflict");
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("concurrent identical requests dispatch one core effect", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    f.setBeforeLaunch(() =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    const first = yield* f.host
      .call(f.invocation, "threads.create", f.request)
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const second = yield* f.host
      .call(f.invocation, "threads.create", f.request)
      .pipe(Effect.forkChild);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(second)).toEqual(yield* Fiber.join(first));
    expect(f.launches()).toBe(1);
  }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect(
  "keeps the fingerprint when the host crashes after a core commit before caching its result",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const core = Context.get(
        yield* Layer.build(CoreReceipts.layer),
        CoreReceipts.OrchestrationCommandReceiptRepository,
      );
      f.setBeforeLaunch((commandId) =>
        core
          .upsert({
            commandId,
            aggregateKind: "thread",
            aggregateId: ThreadId.make(`${commandId}:thread`),
            commandType: "thread.create",
            acceptedAt: "2026-10-23T12:00:00.000Z",
            resultSequence: 1,
            status: "accepted",
            error: null,
          })
          .pipe(Effect.orDie, Effect.andThen(Effect.die("fixture crash after commit"))),
      );
      const crashed = yield* f.host
        .call(f.invocation, "threads.create", f.request)
        .pipe(Effect.exit);
      expect(crashed._tag).toBe("Failure");
      expect(
        yield* (yield* SqlClient.SqlClient)`SELECT result_json FROM plugin_operation_receipts`,
      ).toEqual([{ result_json: null }]);
      expect(
        (yield* f.host
          .call(f.invocation, "threads.create", { ...f.request, text: "Changed after crash" })
          .pipe(Effect.flip, Effect.orDie)).code,
      ).toBe("idempotency_conflict");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.live(
  "retains a guarded core commit when its real plugin worker is SIGKILLed, restarted and reopened",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "plugin-guarded-kill-" });
      const database = Sqlite.layerFromPath(`${directory}/core.sqlite`);
      yield* fs.writeFileString(
        `${directory}/plugin.mjs`,
        `
      export function activate(ctx) {
        ctx.handle("action:pid", () => ({data: process.pid}));
        ctx.handle("action:create", async input => ({data: await ctx.threads.create(input)}));
      }
    `,
      );
      const key = yield* Effect.gen(function* () {
        const f = yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        const core = Context.get(
          yield* Layer.build(CoreReceipts.layer),
          CoreReceipts.OrchestrationCommandReceiptRepository,
        );
        const supervisor = Context.get(
          yield* Layer.build(
            Supervisor.layer.pipe(
              Layer.provide(
                Layer.succeed(Supervisor.PluginRuntimeConfig, {
                  selfInvocation: {
                    command: process.execPath,
                    entrypoint: new URL("../bin.ts", import.meta.url).pathname,
                  },
                  startupTimeoutMs: 10000,
                  invocationTimeoutMs: 10000,
                  cancelGraceMs: 500,
                  stopGraceMs: 500,
                  restartBackoffMs: 0,
                  maxFailures: 3,
                }),
              ),
            ),
          ),
          Supervisor.PluginSupervisor,
        );
        const input = {
          installationId: "plugin",
          generation: "one",
          directory,
          entry: "plugin.mjs",
          dataDirectory: directory,
          capabilities: ["threads.create"],
          caller: { kind: "client" as const },
          operationId: f.invocation.operationId,
        };
        const pid = (yield* supervisor.invoke(
          { ...input, handler: "action:pid" },
          () => Effect.void,
        )).data;
        if (typeof pid !== "number") return yield* Effect.die("Expected the fixture worker PID");
        const committed = yield* Deferred.make<CommandId>();
        const stopped = yield* Deferred.make<void>();
        f.setBeforeLaunch((commandId) =>
          core
            .upsert({
              commandId,
              aggregateKind: "thread",
              aggregateId: ThreadId.make(`${commandId}:thread`),
              commandType: "thread.create",
              acceptedAt: "2026-10-23T12:00:00.000Z",
              resultSequence: 1,
              status: "accepted",
              error: null,
            })
            .pipe(
              Effect.orDie,
              Effect.andThen(Deferred.succeed(committed, commandId)),
              Effect.andThen(Effect.never),
            ),
        );
        const call: Supervisor.PluginHostCall = (method, value) =>
          f.host
            .call(f.invocation, method, value)
            .pipe(Effect.onExit(() => Deferred.succeed(stopped, undefined)));
        const pending = yield* supervisor
          .invoke({ ...input, handler: "action:create", input: f.request }, call)
          .pipe(Effect.result, Effect.forkScoped);
        const commandId = yield* Deferred.await(committed);
        process.kill(pid, "SIGKILL");
        expect(yield* Fiber.join(pending)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "crashed" },
        });
        yield* Deferred.await(stopped);
        expect(yield* sql`SELECT status FROM orchestration_command_receipts`).toEqual([
          { status: "accepted" },
        ]);
        expect(yield* sql`SELECT result_json FROM plugin_operation_receipts`).toEqual([
          { result_json: null },
        ]);
        expect(
          (yield* f.host
            .call(f.invocation, "threads.create", { ...f.request, text: "Changed after kill" })
            .pipe(Effect.flip, Effect.orDie)).code,
        ).toBe("idempotency_conflict");
        f.setBeforeLaunch((retriedKey) =>
          core.getByCommandId({ commandId: retriedKey }).pipe(
            Effect.orDie,
            Effect.tap((receipt) => Effect.sync(() => expect(Option.isSome(receipt)).toBe(true))),
            Effect.asVoid,
          ),
        );
        const restarted = yield* supervisor.invoke(
          { ...input, handler: "action:pid" },
          () => Effect.void,
        );
        expect(restarted.data).not.toBe(pid);
        expect(
          (yield* supervisor.invoke({ ...input, handler: "action:create", input: f.request }, call))
            .data,
        ).toEqual({ threadId: `${commandId}:thread` });
        expect(f.launches()).toBe(1);
        expect(yield* sql`SELECT status FROM orchestration_command_receipts`).toHaveLength(1);
        return commandId;
      }).pipe(Effect.provide(base(database)), Effect.scoped);
      yield* Effect.gen(function* () {
        const receipts = yield* Receipts.PluginReceipts;
        const sql = yield* SqlClient.SqlClient;
        const row = (yield* sql<{
          request_digest: string;
        }>`SELECT request_digest FROM plugin_operation_receipts WHERE operation_key=${key}`)[0];
        if (!row) return yield* Effect.die("The committed plugin receipt was lost on reopen");
        expect(
          yield* receipts.reserve({
            installationId: "plugin",
            generation: "after-reopen",
            key,
            requestDigest: row.request_digest,
          }),
        ).toEqual({ result: { threadId: `${key}:thread` } });
        expect(yield* (yield* SqlClient.SqlClient)`PRAGMA integrity_check`).toEqual([
          { integrity_check: "ok" },
        ]);
      }).pipe(Effect.provide(Receipts.layer.pipe(Layer.provideMerge(database))));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

const grantWorktrees = Effect.fn("test.grantWorktrees")(function* (
  store: Store.PluginStore["Service"],
) {
  yield* store.update((state) =>
    Effect.succeed([
      undefined,
      {
        ...state,
        installations: state.installations.map((record) => ({
          ...record,
          installation: {
            ...record.installation,
            manifest: {
              ...record.installation.manifest,
              capabilities: [...record.installation.manifest.capabilities, "worktrees.create"],
            },
            grants: {
              ...record.installation.grants,
              capabilities: [...record.installation.grants.capabilities, "worktrees.create"],
            },
          },
        })),
      },
    ] as const),
  );
});

it.effect("requires an explicit worktree grant before a plugin can create a checkout", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const result = yield* f.host
      .call(f.invocation, "threads.create", {
        ...f.request,
        workspaceStrategy: { type: "worktree", baseRef: "main" },
      })
      .pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "permission_denied" } });
    expect(f.launchInputs).toEqual([]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "forwards public model, modes and worktree settings while deriving independent provenance from host context",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* grantWorktrees(f.store);
      const modelSelection = {
        ...f.shell.modelSelection,
        options: [{ id: "reasoningEffort", value: "high" }],
      };
      const workspaceStrategy = {
        type: "worktree",
        baseRef: "feature/base",
        branch: "feature/child",
        startFromOrigin: false,
      };
      const input = {
        ...f.request,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        workspaceStrategy,
        launchedFrom: { threadId: "forged" },
      };
      yield* f.host.call(
        { ...f.invocation, context: { threadId: f.shell.id, projectId } },
        "threads.create",
        input,
      );
      expect(f.launchInputs).toHaveLength(1);
      expect(f.launchInputs[0]).toMatchObject({
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "plan",
        workspaceStrategy,
        launchedFrom: { threadId: f.shell.id },
      });
      expect(f.shell.activeRunId).toBeNull();
      expect(f.launchInputs[0]).not.toHaveProperty("parentThreadId");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "derives plugin launch provenance from the agent caller rather than a selected target or supplied parent",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.host.call(
        {
          ...f.invocation,
          actor: { ...actor, source: "agent", threadId: f.shell.id },
          context: { threadId: ThreadId.make("selected-other") },
        },
        "threads.create",
        { ...f.request, launchedFrom: { threadId: "forged" } },
      );
      expect(f.launchInputs[0]).toHaveProperty("launchedFrom", { threadId: f.shell.id });
      yield* f.host.call({ ...f.invocation, operationId: "fresh-action" }, "threads.create", {
        ...f.request,
        launchedFrom: { threadId: "forged" },
      });
      expect(f.launchInputs[1]).not.toHaveProperty("launchedFrom");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("refuses arbitrary existing-checkout paths in the public plugin workflow", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const result = yield* f.host
      .call(f.invocation, "threads.create", {
        ...f.request,
        workspaceStrategy: { type: "existing_worktree", worktreePath: "/private" },
      })
      .pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "invalid_input" } });
    expect(f.launchInputs).toEqual([]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("creates nothing when the plugin's worktree base does not resolve", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* grantWorktrees(f.store);
    using _check = vi.spyOn(f.launch, "checkWorktreeBase").mockImplementation(() =>
      Effect.fail(
        new Launch.ThreadLaunchBaseRefError({
          projectId,
          projectTitle: "Test",
          workspaceRoot: "/fixture",
          baseRef: "missing",
        }),
      ),
    );
    const result = yield* f.host
      .call(f.invocation, "threads.create", {
        ...f.request,
        workspaceStrategy: { type: "worktree", baseRef: "missing" },
      })
      .pipe(Effect.result);
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "invalid_input" } });
    expect(f.launchInputs).toEqual([]);
    expect(
      yield* (yield* SqlClient.SqlClient)`SELECT operation_key FROM plugin_operation_receipts`,
    ).toEqual([]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "rechecks worktree authority after preflight IO and releases an uncommitted receipt",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* grantWorktrees(f.store);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      using _check = vi
        .spyOn(f.launch, "checkWorktreeBase")
        .mockImplementation(() =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
      const pending = yield* f.host
        .call(f.invocation, "threads.create", {
          ...f.request,
          workspaceStrategy: { type: "worktree", baseRef: "main" },
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              installation: {
                ...record.installation,
                grants: {
                  ...record.installation.grants,
                  capabilities: record.installation.grants.capabilities.filter(
                    (c) => c !== "worktrees.create",
                  ),
                },
              },
            })),
          },
        ] as const),
      );
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "permission_denied" },
      });
      expect(f.launchInputs).toEqual([]);
      expect(
        yield* (yield* SqlClient.SqlClient)`SELECT operation_key FROM plugin_operation_receipts`,
      ).toEqual([]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "worktree receipts replay once, fresh clicks create independently, and changed workspaces conflict",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* grantWorktrees(f.store);
      const request = { ...f.request, workspaceStrategy: { type: "worktree", baseRef: "main" } };
      const first = yield* f.host.call(f.invocation, "threads.create", request);
      expect(yield* f.host.call(f.invocation, "threads.create", request)).toEqual(first);
      expect(f.launchInputs).toHaveLength(1);
      const conflict = yield* f.host
        .call(f.invocation, "threads.create", {
          ...request,
          workspaceStrategy: { ...request.workspaceStrategy, baseRef: "other" },
        })
        .pipe(Effect.result);
      expect(conflict).toMatchObject({
        _tag: "Failure",
        failure: { code: "idempotency_conflict", priorEffect: first },
      });
      yield* f.host.call(
        { ...f.invocation, operationId: "fresh-click" },
        "threads.create",
        request,
      );
      expect(f.launchInputs).toHaveLength(2);
      expect(f.launchInputs[0]?.threadId).not.toEqual(f.launchInputs[1]?.threadId);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("pages granted metadata without transcripts and exposes semantic grouping state", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const stamp = DateTime.makeUnsafe("2026-10-23T12:00:00.000Z");
    const rows = ["a", "b", "c"].map((id) => ({
      ...f.shell,
      id: ThreadId.make(id),
      pinnedAt: stamp,
      snoozedUntil: stamp,
      snoozedAt: stamp,
      settledAt: stamp,
      settledOverride: "settled" as const,
    }));
    f.setListedThreads(rows);
    const first = yield* f.host.call(f.invocation, "threads.list", { projectId, limit: 2 });
    expect(first).toMatchObject({
      threads: [
        {
          id: "a",
          pinnedAt: "2026-10-23T12:00:00.000Z",
          snoozedUntil: "2026-10-23T12:00:00.000Z",
          settledOverride: "settled",
        },
        { id: "b" },
      ],
      nextCursor: 2,
    });
    expect(JSON.stringify(first)).not.toContain("private transcript");
    expect(
      yield* f.host.call(f.invocation, "threads.list", { projectId, limit: 2, cursor: 2 }),
    ).toMatchObject({ threads: [{ id: "c" }], nextCursor: null });
    expect(
      yield* f.host.call(f.invocation, "threads.metadata", { threadId: f.shell.id }),
    ).toMatchObject({ id: f.shell.id, lineage: f.shell.lineage });
    expect(yield* f.host.call(f.invocation, "projects.list", {})).toMatchObject({
      projects: [{ id: projectId, workspaceRoot: "/fixture" }],
      nextCursor: null,
    });
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("lists project-enabled models from the live registry with bounded pagination", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    expect(yield* f.host.call(f.invocation, "models.list", { projectId, limit: 1 })).toEqual({
      models: [
        {
          modelSelection: f.shell.modelSelection,
          title: "Test model",
          providerTitle: "Codex",
          options: [],
        },
      ],
      nextCursor: null,
    });
    f.setModelEnabled(false);
    expect(yield* f.host.call(f.invocation, "models.list", { projectId })).toEqual({
      models: [],
      nextCursor: null,
    });
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(["threads.list", "threads.metadata", "models.list", "projects.list"])(
  "denies %s to an actor without read scope",
  (method) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const denied = yield* f.host
        .call(
          { ...f.invocation, actor: { ...actor, scopes: [AuthOrchestrationOperateScope] } },
          method,
          { projectId, threadId: f.shell.id },
        )
        .pipe(Effect.result);
      expect(denied).toMatchObject({ _tag: "Failure", failure: { reason: "permission_denied" } });
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(
  (["threads.list", "threads.metadata", "models.list", "projects.list"] as const).flatMap(
    (method) =>
      (["session", "generation", "project-grant", "query-grant"] as const).map((change) => ({
        method,
        change,
      })),
  ),
)("does not disclose $method after $change revocation during domain IO", ({ method, change }) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const pause = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    );
    using spies = new DisposableStack();
    if (method === "threads.list") {
      const original = f.threads.listProjectThreads;
      spies.use(
        vi
          .spyOn(f.threads, "listProjectThreads")
          .mockImplementationOnce((input) => original(input).pipe(Effect.tap(() => pause))),
      );
    } else if (method === "threads.metadata") {
      const original = f.threads.getThreadShell;
      spies.use(
        vi
          .spyOn(f.threads, "getThreadShell")
          .mockImplementationOnce((input) => original(input).pipe(Effect.tap(() => pause))),
      );
    } else if (method === "models.list") {
      const original = f.projects.getShell;
      spies.use(
        vi
          .spyOn(f.projects, "getShell")
          .mockImplementationOnce((input) => original(input).pipe(Effect.tap(() => pause))),
      );
    } else {
      const original = f.projects.listShells;
      spies.use(
        vi
          .spyOn(f.projects, "listShells")
          .mockImplementationOnce((input) => original(input).pipe(Effect.tap(() => pause))),
      );
    }
    let revoked = false;
    const pending = yield* f.host
      .call(
        {
          ...f.invocation,
          actor: {
            ...actor,
            authorize: () =>
              Effect.suspend(() => (revoked ? pluginPermissionDenied() : Effect.void)),
          },
        },
        method,
        { projectId, threadId: f.shell.id },
      )
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(entered);
    if (change === "session") revoked = true;
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
                ...(change === "generation"
                  ? { generation: "two" }
                  : {
                      grants: {
                        ...record.installation.grants,
                        ...(change === "query-grant"
                          ? {
                              capabilities: record.installation.grants.capabilities.filter(
                                (capability) => capability !== "workflow.query",
                              ),
                            }
                          : { projectIds: [] }),
                      },
                    }),
              },
            })),
          },
        ] as const),
      );
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(pending)).toMatchObject({
      _tag: "Failure",
      failure: { reason: change === "generation" ? "stale_generation" : "permission_denied" },
    });
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "does not replay a worktree effect or disclose its conflict handle after worktree revocation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* grantWorktrees(f.store);
      const request = { ...f.request, workspaceStrategy: { type: "worktree", baseRef: "main" } };
      yield* f.host.call(f.invocation, "threads.create", request);
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              installation: {
                ...record.installation,
                grants: {
                  ...record.installation.grants,
                  capabilities: record.installation.grants.capabilities.filter(
                    (c) => c !== "worktrees.create",
                  ),
                },
              },
            })),
          },
        ] as const),
      );
      for (const input of [request, { ...request, text: "changed request" }]) {
        const denied = yield* f.host
          .call(f.invocation, "threads.create", input)
          .pipe(Effect.result);
        expect(denied).toMatchObject({ _tag: "Failure", failure: { reason: "permission_denied" } });
        expect(denied).not.toHaveProperty("failure.priorEffect");
      }
      expect(f.launchInputs).toHaveLength(1);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("rechecks the host-derived source's read grant after receipt reservation", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const sourceId = ThreadId.make("source-thread");
    const sourceProject = ProjectId.make("source-project");
    const original = f.threads.getThreadShell;
    using _shell = vi
      .spyOn(f.threads, "getThreadShell")
      .mockImplementation((id) =>
        id === sourceId
          ? Effect.succeed({ ...f.shell, id, projectId: sourceProject })
          : original(id),
      );
    yield* f.store.update((state) =>
      Effect.succeed([
        undefined,
        {
          ...state,
          installations: state.installations.map((record) => ({
            ...record,
            installation: {
              ...record.installation,
              grants: { ...record.installation.grants, projectIds: [projectId, sourceProject] },
            },
          })),
        },
      ] as const),
    );
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const reserve = f.receipts.reserve;
    using _reserve = vi
      .spyOn(f.receipts, "reserve")
      .mockImplementationOnce((input) =>
        reserve(input).pipe(
          Effect.tap(() =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        ),
      );
    const invocation = { ...f.invocation, context: { threadId: sourceId } };
    const pending = yield* f.host
      .call(invocation, "threads.create", f.request)
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(entered);
    yield* f.store.update((state) =>
      Effect.succeed([
        undefined,
        {
          ...state,
          installations: state.installations.map((record) => ({
            ...record,
            installation: {
              ...record.installation,
              grants: { ...record.installation.grants, projectIds: [projectId] },
            },
          })),
        },
      ] as const),
    );
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(pending)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "permission_denied" },
    });
    expect(f.launchInputs).toEqual([]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("bounds metadata pages by item count and measured JSON bytes", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const invalid = yield* f.host
      .call(f.invocation, "threads.list", { projectId, limit: 201 })
      .pipe(Effect.result);
    expect(invalid).toMatchObject({ _tag: "Failure", failure: { reason: "invalid_input" } });
    f.setListedThreads([
      { ...f.shell, modelSelection: { ...f.shell.modelSelection, model: "😀".repeat(260_000) } },
    ]);
    const oversized = yield* f.host
      .call(f.invocation, "threads.list", { projectId })
      .pipe(Effect.result);
    expect(oversized).toMatchObject({ _tag: "Failure", failure: { reason: "invalid_result" } });
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(
  (["new-result", "cached-result", "prior-effect"] as const).flatMap((response) =>
    (["source-read", "worktree-grant"] as const).map((change) => ({ response, change })),
  ),
)(
  "does not disclose $response after $change revocation during result target IO",
  ({ response, change }) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* grantWorktrees(f.store);
      const sourceId = ThreadId.make("source-thread");
      const sourceProject = ProjectId.make("source-project");
      const original = f.threads.getThreadShell;
      let revokeOnResult = false;
      let revoked = false;
      using _target = vi.spyOn(f.threads, "getThreadShell").mockImplementation((id) =>
        (id === sourceId
          ? Effect.succeed({ ...f.shell, id, projectId: sourceProject })
          : original(id)
        ).pipe(
          Effect.tap(() => {
            if (!revokeOnResult || revoked || !id.startsWith("plugin:")) return Effect.void;
            revoked = true;
            return f.store
              .update((state) =>
                Effect.succeed([
                  undefined,
                  {
                    ...state,
                    installations: state.installations.map((record) => ({
                      ...record,
                      installation: {
                        ...record.installation,
                        grants: {
                          ...record.installation.grants,
                          ...(change === "source-read"
                            ? { projectIds: [projectId] }
                            : {
                                capabilities: record.installation.grants.capabilities.filter(
                                  (c) => c !== "worktrees.create",
                                ),
                              }),
                        },
                      },
                    })),
                  },
                ] as const),
              )
              .pipe(Effect.orDie);
          }),
        ),
      );
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              installation: {
                ...record.installation,
                grants: { ...record.installation.grants, projectIds: [projectId, sourceProject] },
              },
            })),
          },
        ] as const),
      );
      const invocation = { ...f.invocation, context: { threadId: sourceId } };
      const request = { ...f.request, workspaceStrategy: { type: "worktree", baseRef: "main" } };
      if (response !== "new-result") yield* f.host.call(invocation, "threads.create", request);
      revokeOnResult = true;
      const result = yield* f.host
        .call(
          invocation,
          "threads.create",
          response === "prior-effect" ? { ...request, text: "changed request" } : request,
        )
        .pipe(Effect.result);
      expect(revoked).toBe(true);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure:
          response === "prior-effect"
            ? { code: "idempotency_conflict" }
            : { reason: "permission_denied" },
      });
      expect(result).not.toHaveProperty("failure.priorEffect");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("publishes cheap running and attention semantics without reading transcripts", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const before = DateTime.makeUnsafe("2026-10-23T11:00:00.000Z");
    const snoozed = DateTime.makeUnsafe("2026-10-23T12:00:00.000Z");
    const after = DateTime.makeUnsafe("2026-10-23T13:00:00.000Z");
    f.setListedThreads([
      { ...f.shell, id: ThreadId.make("a-running"), status: "running" },
      {
        ...f.shell,
        id: ThreadId.make("b-question"),
        status: "running",
        snoozedAt: snoozed,
        snoozedUntil: after,
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("question"),
          kind: "user_input",
          createdAt: after,
          blocking: false,
        },
      },
      {
        ...f.shell,
        id: ThreadId.make("c-old-failure"),
        status: "failed",
        snoozedAt: snoozed,
        latestRunCompletedAt: before,
        updatedAt: after,
      },
      {
        ...f.shell,
        id: ThreadId.make("d-new-failure"),
        status: "failed",
        snoozedAt: snoozed,
        latestRunCompletedAt: after,
      },
      { ...f.shell, id: ThreadId.make("e-draining"), status: "waiting" },
    ]);
    using _transcript = vi.spyOn(f.threads, "getThreadSnapshotWindow");
    const result = yield* f.host.call(f.invocation, "threads.list", { projectId });
    expect(result).toMatchObject({
      threads: [
        { id: "a-running", isRunning: true, needsAttention: false },
        { id: "b-question", isRunning: true, needsAttention: true },
        { id: "c-old-failure", isRunning: false, needsAttention: false },
        { id: "d-new-failure", isRunning: false, needsAttention: true },
        { id: "e-draining", isRunning: false, needsAttention: false },
      ],
    });
    expect(_transcript).not.toHaveBeenCalled();
  }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(["threads.list", "threads.metadata", "models.list", "projects.list"])(
  "requires workflow.query for new %s while preserving old transcript reads",
  (method) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              installation: {
                ...record.installation,
                grants: {
                  ...record.installation.grants,
                  capabilities: record.installation.grants.capabilities.filter(
                    (capability) => capability !== "workflow.query",
                  ),
                },
              },
            })),
          },
        ] as const),
      );
      const denied = yield* f.host
        .call(f.invocation, method, { projectId, threadId: f.shell.id })
        .pipe(Effect.result);
      expect(denied).toMatchObject({ _tag: "Failure", failure: { reason: "permission_denied" } });
      expect(
        yield* f.host.call(f.invocation, "threads.read", { threadId: f.shell.id }),
      ).toMatchObject({ messages: [{ text: "private transcript" }] });
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "publishes host-derived creation sources so Projects can distinguish owned tasks from provider helpers",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const source = (
        id: string,
        creationSource: OrchestrationV2ThreadShell["creationSource"],
        relationshipToParent: "subagent" | "fork" | null,
      ) => ({
        ...f.shell,
        id: ThreadId.make(id),
        creationSource,
        lineage: {
          parentThreadId: relationshipToParent === null ? null : f.shell.id,
          relationshipToParent,
          rootThreadId: f.shell.id,
        },
      });
      f.setListedThreads([
        source("a-owned", "mcp", "subagent"),
        source("b-helper", "provider", "subagent"),
        source("c-fork", "web", "fork"),
        { ...source("d-independent", "server", null), launchedFrom: { threadId: f.shell.id } },
      ]);
      expect(yield* f.host.call(f.invocation, "threads.list", { projectId })).toMatchObject({
        threads: [
          { id: "a-owned", creationSource: "mcp", lineage: { relationshipToParent: "subagent" } },
          {
            id: "b-helper",
            creationSource: "provider",
            lineage: { relationshipToParent: "subagent" },
          },
          { id: "c-fork", creationSource: "web", lineage: { relationshipToParent: "fork" } },
          { id: "d-independent", creationSource: "server", launchedFrom: { threadId: f.shell.id } },
        ],
      });
      yield* f.host.call(f.invocation, "threads.create", { ...f.request, creationSource: "mcp" });
      expect(f.launchInputs[0]?.creationSource).toBe("server");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(["storage.set", "storage.delete"] as const)(
  "%s authorizers can reenter the catalogue before committing",
  (method) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              storage: { board: "before" },
              installation: {
                ...record.installation,
                manifest: {
                  ...record.installation.manifest,
                  capabilities: [...record.installation.manifest.capabilities, "storage"],
                },
                grants: {
                  ...record.installation.grants,
                  capabilities: [...record.installation.grants.capabilities, "storage"],
                },
              },
            })),
          },
        ] as const),
      );
      const result = yield* f.host.call(
        {
          ...f.invocation,
          actor: {
            ...actor,
            authorize: () =>
              f.store.read.pipe(
                Effect.andThen(() =>
                  f.store.update((state) => Effect.succeed([undefined, state] as const)),
                ),
                Effect.asVoid,
                Effect.orDie,
              ),
          },
        },
        method,
        { key: "board", ...(method === "storage.set" ? { value: "after" } : {}) },
      );
      expect(result).toBeNull();
      expect((yield* f.store.read).installations[0]?.storage.board).toBe(
        method === "storage.set" ? "after" : undefined,
      );
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(["storage.set", "storage.delete"] as const)(
  "%s waits and reauthorizes through repeated catalogue contention",
  (method) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              storage: { board: "before" },
              installation: {
                ...record.installation,
                manifest: {
                  ...record.installation.manifest,
                  capabilities: [...record.installation.manifest.capabilities, "storage"],
                },
                grants: {
                  ...record.installation.grants,
                  capabilities: [...record.installation.grants.capabilities, "storage"],
                },
              },
            })),
          },
        ] as const),
      );
      const authorizing = yield* Queue.unbounded<Deferred.Deferred<void>>();
      const attempted = yield* Queue.unbounded<void>();
      const original = f.store.tryUpdate;
      using _attempt = vi.spyOn(f.store, "tryUpdate").mockImplementation(function <A, E, R>(
        callback: (
          state: Store.PluginState,
        ) => Effect.Effect<readonly [A, Store.PluginState], E, R>,
      ) {
        return original(callback).pipe(Effect.tap(() => Queue.offer(attempted, undefined)));
      });
      let checks = 0;
      const pending = yield* f.host
        .call(
          {
            ...f.invocation,
            actor: {
              ...actor,
              authorize: () =>
                Effect.gen(function* () {
                  if (++checks < 3 || checks > 4) return;
                  const release = yield* Deferred.make<void>();
                  yield* Queue.offer(authorizing, release);
                  yield* Deferred.await(release);
                }),
            },
          },
          method,
          { key: "board", ...(method === "storage.set" ? { value: "after" } : {}) },
        )
        .pipe(Effect.result, Effect.forkScoped);
      for (const _round of [1, 2]) {
        const releaseAuthorization = yield* Queue.take(authorizing);
        const entered = yield* Deferred.make<void>();
        const releaseLock = yield* Deferred.make<void>();
        const lock = yield* f.store
          .update((state) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseLock)),
              Effect.as([undefined, state] as const),
            ),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* Deferred.succeed(releaseAuthorization, undefined);
        yield* Queue.take(attempted);
        yield* Deferred.succeed(releaseLock, undefined);
        yield* Fiber.join(lock);
      }
      expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "Success" });
      expect((yield* f.store.read).installations[0]?.storage.board).toBe(
        method === "storage.set" ? "after" : undefined,
      );
      expect(checks).toBe(5);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(["storage.set", "storage.delete"] as const)(
  "%s stops waiting for catalogue admission when its invocation is cancelled",
  (method) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              storage: { board: "before" },
              installation: {
                ...record.installation,
                manifest: {
                  ...record.installation.manifest,
                  capabilities: [...record.installation.manifest.capabilities, "storage"],
                },
                grants: {
                  ...record.installation.grants,
                  capabilities: [...record.installation.grants.capabilities, "storage"],
                },
              },
            })),
          },
        ] as const),
      );
      const authorizing = yield* Deferred.make<void>();
      const releaseAuthorization = yield* Deferred.make<void>();
      const missed = yield* Deferred.make<void>();
      const original = f.store.tryUpdate;
      using _try = vi.spyOn(f.store, "tryUpdate").mockImplementation(function <A, E, R>(
        callback: (
          state: Store.PluginState,
        ) => Effect.Effect<readonly [A, Store.PluginState], E, R>,
      ) {
        return original(callback).pipe(
          Effect.tap((result) =>
            Option.isNone(result) ? Deferred.succeed(missed, undefined) : Effect.void,
          ),
        );
      });
      let checks = 0;
      const pending = yield* f.host
        .call(
          {
            ...f.invocation,
            actor: {
              ...actor,
              authorize: () =>
                Effect.gen(function* () {
                  if (++checks === 3) {
                    yield* Deferred.succeed(authorizing, undefined);
                    yield* Deferred.await(releaseAuthorization);
                  }
                }),
            },
          },
          method,
          { key: "board", ...(method === "storage.set" ? { value: "after" } : {}) },
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(authorizing);
      const entered = yield* Deferred.make<void>();
      const releaseLock = yield* Deferred.make<void>();
      const owner = yield* f.store
        .update((state) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseLock)),
            Effect.as([undefined, state] as const),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Deferred.succeed(releaseAuthorization, undefined);
      yield* Deferred.await(missed);
      yield* Fiber.interrupt(pending);
      expect(Exit.hasInterrupts(yield* Fiber.await(pending))).toBe(true);
      yield* Deferred.succeed(releaseLock, undefined);
      yield* Fiber.join(owner);
      expect((yield* f.store.read).installations[0]?.storage.board).toBe("before");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect(
  "creates with the automatic catalog default when neither project nor machine saved a model",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setProjectDefaultModelSelection(null);
      yield* f.settings.updateSettings({ defaultModelSelection: null });
      const catalog = yield* f.registry.getProviders;
      f.setCatalog([
        {
          ...catalog[0]!,
          models: [
            { slug: "other", name: "Other", isCustom: false, capabilities: null },
            {
              slug: "automatic",
              name: "Automatic",
              isCustom: false,
              isDefault: true,
              capabilities: null,
            },
          ],
        },
      ]);
      yield* f.host.call(f.invocation, "threads.create", f.request);
      expect(f.launchInputs[0]?.modelSelection).toEqual({
        instanceId: "codex",
        model: "automatic",
      });
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(["request", "caller", "project", "machine"] as const)(
  "preserves the %s model ahead of automatic selection",
  (source) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      if (source !== "project") f.setProjectDefaultModelSelection(null);
      yield* f.settings.updateSettings({
        defaultModelSelection: source === "machine" ? f.shell.modelSelection : null,
      });
      f.setCatalog([]);
      const invocation =
        source === "caller" ? { ...f.invocation, context: { threadId: f.shell.id } } : f.invocation;
      const request =
        source === "request" ? { ...f.request, modelSelection: f.shell.modelSelection } : f.request;
      yield* f.host.call(invocation, "threads.create", request);
      expect(f.launchInputs[0]?.modelSelection).toEqual(f.shell.modelSelection);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each(["empty", "disabled"] as const)(
  "does not invent a model for an %s catalog",
  (state) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.setProjectDefaultModelSelection(null);
      yield* f.settings.updateSettings({ defaultModelSelection: null });
      if (state === "empty") f.setCatalog([]);
      else f.setModelEnabled(false);
      expect(
        yield* f.host.call(f.invocation, "threads.create", f.request).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "invalid_input" } });
      expect(f.launchInputs).toEqual([]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect.each([
  { title: "Shelf", expected: "Shelf" },
  { title: undefined, expected: "Plugin thread" },
])("keeps the requested title $title and retains message provenance", ({ title, expected }) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.host.call(f.invocation, "threads.create", {
      ...f.request,
      ...(title === undefined ? {} : { title }),
    });
    expect(f.launchInputs[0]?.title).toBe(expected);
    expect(f.launchInputs[0]?.creationSource).toBe("server");
    expect(f.launchInputs[0]?.initialMessage?.text).toBe("[Plugin: Test]\nSame request");
  }).pipe(Effect.provide(base()), Effect.scoped),
);

const setBriefCapability = Effect.fn("PluginHostTest.setBriefCapability")(function* (
  store: Store.PluginStore["Service"],
  enabled: boolean,
) {
  yield* store.update((state) =>
    Effect.succeed([
      undefined,
      {
        ...state,
        installations: state.installations.map((record) => ({
          ...record,
          installation: {
            ...record.installation,
            manifest: {
              ...record.installation.manifest,
              optionalCapabilities: ["ui.native-tree-conversations"],
            },
            grants: {
              ...record.installation.grants,
              capabilities: enabled
                ? [...record.installation.grants.capabilities, "ui.native-tree-conversations"]
                : record.installation.grants.capabilities.filter(
                    (capability) => capability !== "ui.native-tree-conversations",
                  ),
            },
          },
        })),
      },
    ] as const),
  );
});

it.effect.each([false, true])(
  "requires the optional capability for brief create (granted=%s)",
  (granted) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* setBriefCapability(f.store, granted);
      const request = {
        idempotencyKey: "brief",
        projectId,
        title: "Shelf",
        brief: "Coordinate Shelf.",
      };
      if (!granted) {
        const denied = yield* f.host
          .call(f.invocation, "threads.create", request)
          .pipe(Effect.result);
        expect(denied).toMatchObject({ _tag: "Failure", failure: { reason: "permission_denied" } });
        expect(f.launchInputs).toHaveLength(0);
        return;
      }
      yield* f.host.call(f.invocation, "threads.create", request);
      expect(f.launchInputs).toHaveLength(1);
      expect(f.launchInputs[0]).toMatchObject({
        title: "Shelf",
        pluginBrief: { pluginName: "Test", text: request.brief },
      });
      expect(f.launchInputs[0]).not.toHaveProperty("initialMessage");
    }).pipe(Effect.provide(base()), Effect.scoped),
);

it.effect("rechecks the brief capability before returning a created thread", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* setBriefCapability(f.store, true);
    f.setBeforeLaunch(() => setBriefCapability(f.store, false).pipe(Effect.orDie));
    const denied = yield* f.host
      .call(f.invocation, "threads.create", {
        idempotencyKey: "brief",
        projectId,
        brief: "Coordinate Shelf.",
      })
      .pipe(Effect.result);
    expect(f.launchInputs).toHaveLength(1);
    expect(denied).toMatchObject({ _tag: "Failure", failure: { reason: "permission_denied" } });
  }).pipe(Effect.provide(base()), Effect.scoped),
);

const grantProjectTree = Effect.fn("test.grantProjectTree")(function* (
  store: Store.PluginStore["Service"],
) {
  yield* store.update((state) =>
    Effect.succeed([
      undefined,
      {
        ...state,
        installations: state.installations.map((record) => ({
          ...record,
          installation: {
            ...record.installation,
            manifest: {
              ...record.installation.manifest,
              optionalCapabilities: ["ui.native-trees", "ui.native-tree-projects"],
              nativeTrees: [{ id: "projects", title: "Projects" }],
            },
            grants: {
              ...record.installation.grants,
              capabilities: [
                ...record.installation.grants.capabilities,
                "ui.native-trees",
                "ui.native-tree-projects",
              ],
            },
          },
        })),
      },
    ] as const),
  );
});
const provePluginCreation = Effect.fn("test.provePluginCreation")(function* (
  f: Effect.Success<typeof fixture>,
  threadId: ThreadId,
) {
  const key = `creation:${threadId}`;
  yield* f.receipts.reserve({
    key,
    installationId: "plugin",
    generation: "old-generation",
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
    acceptedAt: "2026-10-23T12:00:00.000Z",
    resultSequence: 1,
    status: "accepted",
    error: null,
  });
});
it.effect("stamps the declared owner on creation and exposes it in plugin metadata", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const request = {
      ...f.request,
      owner: "tree:projects",
      pluginOwner: { installationId: "forged", treeId: "other" },
    };
    expect(
      (yield* f.host.call(f.invocation, "threads.create", request).pipe(Effect.asVoid, Effect.flip))
        .reason,
    ).toBe("permission_denied");
    yield* grantProjectTree(f.store);
    expect(
      (yield* f.host
        .call(f.invocation, "threads.create", { ...request, owner: "tree:undeclared" })
        .pipe(Effect.asVoid, Effect.flip)).reason,
    ).toBe("permission_denied");
    yield* f.host.call(f.invocation, "threads.create", request);
    const pluginOwner = { installationId: "plugin", treeId: "projects" };
    expect(f.launchInputs[0]?.pluginOwner).toEqual(pluginOwner);
    f.setShell({ ...f.shell, pluginOwner });
    expect(
      yield* f.host.call(f.invocation, "threads.metadata", { threadId: f.shell.id }),
    ).toHaveProperty("pluginOwner", pluginOwner);
    f.setListedThreads([{ ...f.shell, pluginOwner }]);
    expect(yield* f.host.call(f.invocation, "threads.list", { projectId })).toHaveProperty(
      "threads.0.pluginOwner",
      pluginOwner,
    );
  }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect("adopts only receipt-proven own threads idempotently during a writable tree read", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* grantProjectTree(f.store);
    const request = { threadId: ThreadId.make("legacy-without-prefix"), owner: "tree:projects" };
    expect(
      (yield* f.host.call(f.invocation, "threads.adopt", request).pipe(Effect.asVoid, Effect.flip))
        .reason,
    ).toBe("permission_denied");
    yield* provePluginCreation(f, request.threadId);
    expect(yield* f.host.call(f.invocation, "threads.adopt", request)).toEqual({
      threadId: request.threadId,
    });
    expect(
      yield* f.host.call(
        { ...f.invocation, operationId: "later-tree-read" },
        "threads.adopt",
        request,
      ),
    ).toEqual({ threadId: request.threadId });
    expect(f.lifecycleCommands).toHaveLength(1);
    expect(f.lifecycleCommands[0]).toMatchObject({
      type: "thread.metadata.update",
      pluginOwner: { installationId: "plugin", treeId: "projects" },
    });
    f.setShell({
      ...f.shell,
      id: request.threadId,
      pluginOwner: { installationId: "other-installation", treeId: "projects" },
    });
    expect(
      (yield* f.host.call(f.invocation, "threads.adopt", request).pipe(Effect.asVoid, Effect.flip))
        .reason,
    ).toBe("permission_denied");
  }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect(
  "unarchives an own thread only for a verified client action and preserves quiet state",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* grantProjectTree(f.store);
      const archived = {
        ...f.shell,
        archivedAt: f.shell.createdAt,
        settledOverride: "settled" as const,
        settledAt: f.shell.createdAt,
        snoozedUntil: DateTime.makeUnsafe("2027-01-01T00:00:00.000Z"),
        snoozedAt: f.shell.createdAt,
      };
      f.setShell(archived);
      yield* provePluginCreation(f, archived.id);
      const request = { threadId: archived.id, clientAction: true };
      expect(
        (yield* f.host
          .call(f.invocation, "threads.unarchive", request)
          .pipe(Effect.asVoid, Effect.flip)).reason,
      ).toBe("permission_denied");
      const invocation = { ...f.invocation, event: false, clientAction: true };
      expect(yield* f.host.call(invocation, "threads.unarchive", request)).toEqual({
        threadId: archived.id,
      });
      expect(
        yield* f.host.call(
          { ...invocation, operationId: "later-action" },
          "threads.unarchive",
          request,
        ),
      ).toEqual({ threadId: archived.id });
      expect(f.lifecycleCommands).toHaveLength(1);
      expect(yield* f.threads.getThreadShell(archived.id)).toMatchObject({
        archivedAt: null,
        settledOverride: "settled",
        settledAt: archived.settledAt,
        snoozedUntil: archived.snoozedUntil,
        snoozedAt: archived.snoozedAt,
      });
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect.each(["threads.adopt", "threads.unarchive"] as const)(
  "rechecks live authority at the thread dispatch boundary for %s",
  (method) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* grantProjectTree(f.store);
      f.setShell({ ...f.shell, archivedAt: f.shell.createdAt });
      yield* provePluginCreation(f, f.shell.id);
      let revoked = false;
      f.beforeDispatch(() =>
        Effect.sync(() => {
          revoked = true;
        }),
      );
      const invocation = {
        ...f.invocation,
        event: false,
        clientAction: true,
        actor: {
          ...actor,
          authorize: () => (revoked ? Effect.fail(pluginPermissionDenied()) : Effect.void),
        },
      };
      expect(
        (yield* f.host
          .call(invocation, method, { threadId: f.shell.id, owner: "tree:projects" })
          .pipe(Effect.asVoid, Effect.flip)).reason,
      ).toBe("permission_denied");
      expect(f.lifecycleCommands).toEqual([]);
    }).pipe(Effect.provide(base()), Effect.scoped),
);
it.effect.each([
  "agent",
  "event",
  "read-scope",
  "project-limit",
  "mode-limit",
  "capability",
  "stale",
  "deleted",
] as const)("rejects unarchive with %s authority", (reason) =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* grantProjectTree(f.store);
    yield* provePluginCreation(f, f.shell.id);
    f.setShell({
      ...f.shell,
      archivedAt: f.shell.createdAt,
      ...(reason === "deleted" ? { deletedAt: f.shell.createdAt } : {}),
    });
    const invocation: Host.PluginHostInvocation = {
      ...f.invocation,
      event: reason === "event",
      clientAction: true,
      generation: reason === "stale" ? "stale" : "one",
      actor: {
        ...actor,
        source: reason === "agent" ? "agent" : "client",
        ...(reason === "read-scope" ? { scopes: [AuthOrchestrationReadScope] } : {}),
        ...(reason === "project-limit" ? { projectIds: [] } : {}),
        ...(reason === "mode-limit" ? { runtimeMode: "approval-required" } : {}),
      },
    };
    if (reason === "capability")
      yield* f.store.update((state) =>
        Effect.succeed([
          undefined,
          {
            ...state,
            installations: state.installations.map((record) => ({
              ...record,
              installation: {
                ...record.installation,
                grants: { ...record.installation.grants, capabilities: [] },
              },
            })),
          },
        ] as const),
      );
    expect(
      (yield* f.host
        .call(invocation, "threads.unarchive", { threadId: f.shell.id })
        .pipe(Effect.asVoid, Effect.flip)).reason,
    ).toBe(reason === "stale" ? "stale_generation" : "permission_denied");
    expect(f.lifecycleCommands).toEqual([]);
  }).pipe(Effect.provide(base()), Effect.scoped),
);
