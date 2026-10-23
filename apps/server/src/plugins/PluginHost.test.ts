import { expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  ProjectId,
  ProviderInstanceId,
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
import * as CoreReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Config from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import type { PluginActor } from "./PluginAuthority.ts";
import * as Database from "./PluginDatabase.ts";
import * as Store from "./PluginStore.ts";
import * as Receipts from "./PluginReceipts.ts";
import * as Host from "./PluginHost.ts";

const projectId = ProjectId.make("project");
const actor: PluginActor = {
  principalId: "client",
  source: "client",
  runtimeMode: "full-access",
  scopes: [AuthOrchestrationOperateScope],
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
  let launches = 0;
  let beforeLaunch: (commandId: CommandId) => Effect.Effect<void, Launch.ThreadLaunchError> = () =>
    Effect.void;
  const layer = Host.layer.pipe(
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(Receipts.layer),
    Layer.provide(
      Layer.mock(Threads.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed({ ...shell, id, projectId: effectProject }),
      }),
    ),
    Layer.provide(
      Layer.mock(Launch.ThreadLaunchService)({
        launch: (input) =>
          Effect.gen(function* () {
            yield* beforeLaunch(input.commandId);
            launches++;
            const launchedThreadId = input.threadId ?? ThreadId.make("fixture-thread");
            return {
              threadId: launchedThreadId,
              projection: {
                thread: { ...shell, id: launchedThreadId, lastVisitedAt: null },
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
              },
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
                capabilities: ["threads.create"],
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
              grants: { capabilities: ["threads.create"], projectIds: [projectId] },
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
    invocation,
    request,
    launches: () => launches,
    setBeforeLaunch: (value: typeof beforeLaunch) => {
      beforeLaunch = value;
    },
    setEffectProject: (value: ProjectId) => {
      effectProject = value;
    },
  };
});
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
