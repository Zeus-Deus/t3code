import { expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
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
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import { pluginPermissionDenied, type PluginActor } from "./PluginAuthority.ts";
import * as Database from "./PluginDatabase.ts";
import * as Store from "./PluginStore.ts";
import * as Receipts from "./PluginReceipts.ts";
import * as Host from "./PluginHost.ts";

const projectId = ProjectId.make("project");
const actor: PluginActor = {
  principalId: "client",
  source: "client",
  runtimeMode: "full-access",
  scopes: [AuthOrchestrationOperateScope, AuthOrchestrationReadScope],
};
const base = () =>
  Database.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        Sqlite.layerMemory,
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
  const sends: Array<Threads.ThreadManagementSendInput> = [];
  const limits: Array<DispatchModeLimitValue | undefined> = [];
  let beforeRead: (() => Effect.Effect<void>) | undefined;
  const projection = (id: ThreadId) => ({
    thread: { ...shell, id, projectId: effectProject, lastVisitedAt: null },
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
      Effect.sync(() => ({ ...shell, ...effectModes, id, projectId: effectProject })),
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
    Layer.provide(
      Layer.mock(Launch.ThreadLaunchService)({
        launch: (input) =>
          Effect.gen(function* () {
            yield* beforeLaunch(input.commandId);
            launches++;
            const launchedThreadId = input.threadId ?? ThreadId.make("fixture-thread");
            return {
              threadId: launchedThreadId,
              projection: projection(launchedThreadId),
              resumed: false,
            };
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(Projects.ProjectService)({
        getShell: () =>
          Effect.succeed(
            Option.some({
              id: projectId,
              title: "Test",
              workspaceRoot: "/fixture",
              defaultModelSelection: shell.modelSelection,
              scripts: [],
              createdAt: "2026-10-23T12:00:00.000Z",
              updatedAt: "2026-10-23T12:00:00.000Z",
            }),
          ),
      }),
    ),
    Layer.provide(Settings.layerTest({ defaultModelSelection: shell.modelSelection })),
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
                capabilities: ["threads.create", "threads.read", "threads.send"],
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
                capabilities: ["threads.create", "threads.read", "threads.send"],
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
