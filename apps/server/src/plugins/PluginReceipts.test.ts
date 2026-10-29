// @effect-diagnostics nodeBuiltinImport:off -- captured fixture processes prove recovery after SIGKILL.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Receipts from "./PluginReceipts.ts";
import * as CoreReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import { migrationManifest, runMigrations } from "../persistence/Migrations.ts";
const layer = Receipts.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(NodeServices.layer),
);
it.effect(
  "persists fingerprinted mutation results, bounds event operations, and retains logical receipts across revoked generations",
  () =>
    Effect.gen(function* () {
      const receipts = yield* Receipts.PluginReceipts;
      const input = {
        installationId: "plugin",
        generation: "one",
        key: "first",
        requestDigest: "digest",
        deliveryId: "run",
      };
      expect(yield* receipts.reserve(input)).toEqual({});
      yield* receipts.complete(input.key, { threadId: "result" });
      expect(yield* receipts.reserve(input)).toEqual({ result: { threadId: "result" } });
      expect(
        (yield* receipts.reserve({ ...input, requestDigest: "different" }).pipe(Effect.flip))
          .reason,
      ).toBe("invalid_input");
      yield* receipts.reserve({ ...input, key: "second" });
      yield* receipts.reserve({ ...input, key: "third" });
      expect((yield* receipts.reserve({ ...input, key: "fourth" }).pipe(Effect.flip)).reason).toBe(
        "permission_denied",
      );
      yield* receipts.acknowledge({ ...input, runId: "run" });
      expect(yield* receipts.delivered({ ...input, runId: "run" })).toBe(true);
      yield* receipts.prune(input.installationId, "two");
      expect(yield* receipts.delivered({ ...input, generation: "two", runId: "run" })).toBe(true);
      expect(yield* receipts.reserve(input)).toEqual({ result: { threadId: "result" } });
      expect(
        (yield* receipts.reserve({ ...input, generation: "two", key: "fourth" }).pipe(Effect.flip))
          .reason,
      ).toBe("permission_denied");
    }).pipe(Effect.provide(layer)),
);
it.effect("bounds the result cache without making every operation scan the catalogue", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Receipts.ensureSchema;
    yield* sql`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<2048)
      INSERT INTO plugin_operation_receipts(operation_key,installation_id,generation,request_digest,result_json,effect_json)
      SELECT 'old-'||n,'plugin','one','digest','{"threadId":"prior"}','{"threadId":"prior"}' FROM numbers`;
    const receipts = yield* Receipts.PluginReceipts;
    const core = Context.get(
      yield* Layer.build(CoreReceipts.layer),
      CoreReceipts.OrchestrationCommandReceiptRepository,
    );
    yield* core.upsert({
      commandId: CommandId.make("old-1"),
      aggregateKind: "thread",
      aggregateId: ThreadId.make("prior"),
      commandType: "thread.create",
      acceptedAt: "2026-10-27T00:00:00.000Z",
      resultSequence: 1,
      status: "accepted",
      error: null,
    });
    yield* receipts.reserve({
      installationId: "plugin",
      generation: "one",
      key: "new",
      requestDigest: "digest",
    });
    yield* receipts.complete("new", { threadId: "new-thread" });
    expect(
      yield* sql`SELECT result_json,effect_json FROM plugin_operation_receipts WHERE operation_key='old-1'`,
    ).toEqual([{ result_json: null, effect_json: '{"threadId":"prior"}' }]);
    expect(
      yield* receipts.createdThread({ installationId: "plugin", threadId: ThreadId.make("prior") }),
    ).toBe(true);
    expect(
      yield* receipts
        .reserve({
          installationId: "plugin",
          generation: "two",
          key: "old-1",
          requestDigest: "changed",
        })
        .pipe(Effect.flip),
    ).toMatchObject({ code: "idempotency_conflict", priorEffect: { threadId: "prior" } });
    const count = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM plugin_operation_receipts`;
    expect(count[0]?.count).toBe(2049);
    expect(
      yield* sql`SELECT operation_key FROM plugin_operation_receipts WHERE operation_key='old-1'`,
    ).toHaveLength(1);
    expect(
      (yield* receipts
        .reserve({
          installationId: "plugin",
          generation: "two",
          key: "old-1",
          requestDigest: "changed",
        })
        .pipe(Effect.flip)).reason,
    ).toBe("invalid_input");
    yield* receipts.prune("plugin");
    expect(yield* sql`SELECT operation_key FROM plugin_operation_receipts`).toHaveLength(2049);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps effect bindings, delivery acknowledgements and budgets after reopening SQLite",
  () =>
    Effect.gen(function* () {
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "plugin-ledger-reopen-",
      });
      const database = Sqlite.layerFromPath(`${directory}/core.sqlite`);
      const service = Receipts.layer.pipe(Layer.provideMerge(database));
      const input = {
        installationId: "plugin",
        generation: "one",
        key: "effect",
        requestDigest: "digest",
        deliveryId: "run",
      };
      yield* Effect.gen(function* () {
        const receipts = yield* Receipts.PluginReceipts;
        yield* receipts.reserve(input);
        const core = Context.get(
          yield* Layer.build(CoreReceipts.layer),
          CoreReceipts.OrchestrationCommandReceiptRepository,
        );
        yield* core.upsert({
          commandId: CommandId.make(input.key),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("retained"),
          commandType: "thread.create",
          acceptedAt: "2026-10-27T00:00:00.000Z",
          resultSequence: 1,
          status: "accepted",
          error: null,
        });
        expect(
          yield* receipts.createdThread({
            installationId: "plugin",
            threadId: ThreadId.make("retained"),
          }),
        ).toBe(true);
        yield* receipts.complete(input.key, { threadId: "retained" });
        yield* receipts.reserve({ ...input, key: "second" });
        yield* receipts.reserve({ ...input, key: "third" });
        yield* receipts.acknowledge({ ...input, runId: "run" });
      }).pipe(Effect.provide(service));
      yield* Effect.gen(function* () {
        const receipts = yield* Receipts.PluginReceipts;
        const current = { ...input, generation: "two" };
        yield* receipts.prune("plugin", "two");
        expect(
          yield* receipts.createdThread({
            installationId: "plugin",
            threadId: ThreadId.make("retained"),
          }),
        ).toBe(true);
        expect(
          yield* receipts.createdThread({
            installationId: "other",
            threadId: ThreadId.make("retained"),
          }),
        ).toBe(false);
        expect(yield* receipts.reserve(current)).toEqual({ result: { threadId: "retained" } });
        expect(yield* receipts.delivered({ ...current, runId: "run" })).toBe(true);
        expect(
          yield* receipts.reserve({ ...current, requestDigest: "changed" }).pipe(Effect.flip),
        ).toMatchObject({ code: "idempotency_conflict", priorEffect: { threadId: "retained" } });
        expect(
          (yield* receipts.reserve({ ...current, key: "fourth" }).pipe(Effect.flip)).reason,
        ).toBe("permission_denied");
        yield* receipts.prune("plugin");
        expect(
          (yield* receipts.reserve({ ...current, requestDigest: "changed" }).pipe(Effect.flip))
            .code,
        ).toBe("idempotency_conflict");
      }).pipe(Effect.provide(service));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "opens old development ledger state without rewinding fingerprints, acknowledgements or budgets",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE plugin_operation_receipts(sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_key TEXT UNIQUE NOT NULL, installation_id TEXT NOT NULL, generation TEXT NOT NULL, request_digest TEXT NOT NULL, result_json TEXT)`;
      yield* sql`CREATE TABLE plugin_run_deliveries(installation_id TEXT NOT NULL,generation TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(installation_id,generation,run_id))`;
      yield* sql`CREATE TABLE plugin_event_reservations(installation_id TEXT NOT NULL,generation TEXT NOT NULL,delivery_id TEXT NOT NULL,operation_key TEXT UNIQUE NOT NULL)`;
      yield* sql`INSERT INTO plugin_operation_receipts(operation_key,installation_id,generation,request_digest,result_json) VALUES('old','plugin','one','digest','{"threadId":"retained"}')`;
      yield* sql`INSERT INTO plugin_run_deliveries VALUES('plugin','one','run'),('plugin','two','run')`;
      yield* sql`INSERT INTO plugin_event_reservations VALUES('plugin','one','delivery','old'),('plugin','two','delivery','second'),('plugin','two','delivery','third')`;
      yield* sql`INSERT INTO effect_sql_migrations(migration_id,name) VALUES(${Math.max(...migrationManifest.map(([id]) => id)) + 1},'PluginState')`;
      expect(yield* runMigrations()).toEqual([]);
      const receipts = yield* Receipts.PluginReceipts;
      const identity = { installationId: "plugin", generation: "new" };
      expect(yield* receipts.reserve({ ...identity, key: "old", requestDigest: "digest" })).toEqual(
        { result: { threadId: "retained" } },
      );
      expect(yield* receipts.delivered({ ...identity, runId: "run" })).toBe(true);
      expect(yield* sql`SELECT installation_id,run_id FROM plugin_run_deliveries`).toEqual([
        { installation_id: "plugin", run_id: "run" },
      ]);
      expect(
        (yield* receipts
          .reserve({ ...identity, key: "old", requestDigest: "changed" })
          .pipe(Effect.flip)).code,
      ).toBe("idempotency_conflict");
      expect(
        (yield* receipts
          .reserve({ ...identity, key: "fourth", requestDigest: "digest", deliveryId: "delivery" })
          .pipe(Effect.flip)).reason,
      ).toBe("permission_denied");
    }).pipe(Effect.provide(layer)),
);
it.effect("creates its ledger on first use outside the core migration chain", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const schema = sql`SELECT name FROM sqlite_schema WHERE name GLOB 'plugin_*' ORDER BY name`;
    const history = sql`SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id`;
    expect(migrationManifest.filter(([, name]) => /plugin/i.test(name))).toEqual([]);
    expect(yield* schema).toEqual([]);
    const migrated = yield* history;
    const receipts = yield* Receipts.PluginReceipts;
    const identity = { installationId: "plugin", generation: "one" };
    expect(yield* receipts.delivered({ ...identity, runId: "run" })).toBe(false);
    expect((yield* schema).map((row) => row.name)).toEqual([
      "plugin_event_reservations",
      "plugin_event_reservations_logical",
      "plugin_operation_receipts",
      "plugin_receipts_results",
      "plugin_run_deliveries",
      "plugin_run_deliveries_identity",
    ]);
    yield* receipts.acknowledge({ ...identity, runId: "run", deliveryId: "run" });
    yield* receipts.acknowledge({
      ...identity,
      generation: "two",
      runId: "run",
      deliveryId: "run",
    });
    expect(yield* sql`SELECT installation_id,run_id FROM plugin_run_deliveries`).toEqual([
      { installation_id: "plugin", run_id: "run" },
    ]);
    expect(yield* runMigrations()).toEqual([]);
    expect(yield* history).toEqual(migrated);
  }).pipe(Effect.provide(layer)),
);
it.effect("does not rewrite an already-current ledger when it is prepared again", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Receipts.ensureSchema;
    const before = yield* sql`PRAGMA schema_version`;
    yield* Receipts.ensureSchema;
    yield* (yield* Receipts.PluginReceipts).reserve({
      installationId: "plugin",
      generation: "one",
      key: "first",
      requestDigest: "digest",
    });
    expect(yield* sql`PRAGMA schema_version`).toEqual(before);
  }).pipe(Effect.provide(layer)),
);

it.effect("retries the ledger setup after a failed first attempt", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // A view under a ledger table's name makes the setup fail (no index on a view).
    yield* sql`CREATE VIEW plugin_event_reservations AS SELECT 1 AS operation_key`;
    const receipts = yield* Receipts.PluginReceipts;
    const input = {
      installationId: "plugin",
      generation: "one",
      key: "first",
      requestDigest: "digest",
      deliveryId: "run",
    };
    expect((yield* receipts.reserve(input).pipe(Effect.flip)).reason).toBe("storage_failed");
    yield* sql`DROP VIEW plugin_event_reservations`;
    expect(yield* receipts.reserve(input)).toEqual({});
  }).pipe(Effect.provide(layer)),
);

it.live.each(["reserved", "transaction", "committed"] as const)(
  "recovers after SIGKILL at the %s boundary without losing or duplicating a core receipt",
  (stage) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "plugin-receipt-kill-" });
      const filename = NodePath.join(directory, "core.sqlite");
      const database = Sqlite.layerFromPath(filename);
      const services = Layer.mergeAll(Receipts.layer, CoreReceipts.layer).pipe(
        Layer.provideMerge(database),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE fixture_effects(thread_id TEXT NOT NULL)`;
      }).pipe(Effect.provide(database));
      const child = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const process = NodeChildProcess.fork(
            new URL("./fixtures/receiptCrashChild.ts", import.meta.url),
            [filename, stage],
            { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] },
          );
          let stderr = "";
          process.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
            stderr = (stderr + chunk).slice(-4000);
          });
          const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve) => process.once("close", (code, signal) => resolve({ code, signal })),
          );
          const ready = new Promise<void>((resolve, reject) => {
            process.once("error", reject);
            process.once("message", (message) => {
              if (
                typeof message === "object" &&
                message !== null &&
                "stage" in message &&
                message.stage === stage
              )
                resolve();
              else reject(new Error("Unexpected receipt fixture barrier"));
            });
            void exited.then(({ code, signal }) =>
              reject(new Error(`Receipt fixture exited before kill: ${code}/${signal}: ${stderr}`)),
            );
          });
          return { process, exited, ready };
        }),
        (child) =>
          Effect.promise(async () => {
            if (child.process.exitCode === null && child.process.signalCode === null)
              child.process.kill("SIGKILL");
            await child.exited;
          }),
      );
      yield* Effect.tryPromise(() => child.ready);
      expect(child.process.pid).toBeTypeOf("number");
      expect(child.process.kill("SIGKILL")).toBe(true);
      expect(yield* Effect.promise(() => child.exited)).toEqual({ code: null, signal: "SIGKILL" });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const receipts = yield* Receipts.PluginReceipts;
        const core = yield* CoreReceipts.OrchestrationCommandReceiptRepository;
        const committed = stage === "committed";
        expect(yield* sql`PRAGMA integrity_check`).toEqual([{ integrity_check: "ok" }]);
        expect(yield* sql`SELECT status FROM orchestration_command_receipts`).toEqual(
          committed ? [{ status: "accepted" }] : [],
        );
        expect(yield* sql`SELECT * FROM fixture_effects`).toHaveLength(committed ? 1 : 0);
        expect(yield* sql`SELECT result_json FROM plugin_operation_receipts`).toEqual([
          { result_json: null },
        ]);
        yield* receipts.releaseUncommitted("crash-operation", "original");
        expect(yield* sql`SELECT operation_key FROM plugin_operation_receipts`).toHaveLength(
          committed ? 1 : 0,
        );
        expect(yield* sql`SELECT operation_key FROM plugin_event_reservations`).toHaveLength(
          committed ? 1 : 0,
        );
        if (committed) {
          expect(
            yield* receipts
              .reserve({
                installationId: "plugin",
                generation: "two",
                key: "crash-operation",
                requestDigest: "changed",
              })
              .pipe(Effect.flip),
          ).toMatchObject({ code: "idempotency_conflict" });
        }
        yield* receipts.reserve({
          installationId: "plugin",
          generation: "two",
          key: "crash-operation",
          requestDigest: "original",
          deliveryId: "run",
        });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const inserted = yield* core.insertIfAbsent({
              commandId: CommandId.make("crash-operation"),
              aggregateKind: "thread",
              aggregateId: ThreadId.make("retained-thread"),
              commandType: "thread.create",
              acceptedAt: "2026-10-23T12:00:00.000Z",
              resultSequence: 1,
              status: "accepted",
              error: null,
            });
            expect(inserted).toBe(!committed);
            if (inserted) yield* sql`INSERT INTO fixture_effects VALUES('retained-thread')`;
          }),
        );
        yield* receipts.complete("crash-operation", { threadId: "retained-thread" });
        yield* receipts.acknowledge({
          installationId: "plugin",
          generation: "two",
          runId: "run",
          deliveryId: "run",
        });
        expect(yield* sql`SELECT * FROM fixture_effects`).toEqual([
          { thread_id: "retained-thread" },
        ]);
        expect(yield* sql`SELECT status FROM orchestration_command_receipts`).toEqual([
          { status: "accepted" },
        ]);
      }).pipe(Effect.provide(services));
      yield* Effect.gen(function* () {
        const receipts = yield* Receipts.PluginReceipts;
        const identity = { installationId: "plugin", generation: "three" };
        expect(
          yield* receipts.reserve({
            ...identity,
            key: "crash-operation",
            requestDigest: "original",
          }),
        ).toEqual({ result: { threadId: "retained-thread" } });
        expect(yield* receipts.delivered({ ...identity, runId: "run" })).toBe(true);
        expect(
          yield* receipts
            .reserve({ ...identity, key: "crash-operation", requestDigest: "changed" })
            .pipe(Effect.flip),
        ).toMatchObject({
          code: "idempotency_conflict",
          priorEffect: { threadId: "retained-thread" },
        });
      }).pipe(Effect.provide(services));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("verifies creation provenance from accepted core receipts across generations", () =>
  Effect.gen(function* () {
    const receipts = yield* Receipts.PluginReceipts;
    const core = yield* CoreReceipts.OrchestrationCommandReceiptRepository;
    const threadId = ThreadId.make("ordinary-id-without-a-plugin-prefix");
    const input = {
      installationId: "plugin",
      generation: "one",
      key: "creation",
      requestDigest: "digest",
    };
    yield* receipts.reserve(input);
    yield* receipts.complete(input.key, { threadId });
    expect(yield* receipts.createdThread({ installationId: "plugin", threadId })).toBe(false);
    const command = {
      commandId: CommandId.make(input.key),
      aggregateKind: "thread" as const,
      aggregateId: threadId,
      commandType: "thread.create",
      acceptedAt: "2026-10-27T00:00:00.000Z",
      resultSequence: 1,
      status: "accepted" as const,
      error: null,
    };
    yield* core.upsert({ ...command, status: "rejected" });
    expect(yield* receipts.createdThread({ installationId: "plugin", threadId })).toBe(false);
    yield* core.upsert({ ...command, commandType: "message.dispatch" });
    expect(yield* receipts.createdThread({ installationId: "plugin", threadId })).toBe(false);
    yield* core.upsert(command);
    yield* receipts.prune("plugin");
    expect(yield* receipts.createdThread({ installationId: "plugin", threadId })).toBe(true);
    expect(yield* receipts.createdThread({ installationId: "other-installation", threadId })).toBe(
      false,
    );
    expect(
      yield* receipts.createdThread({
        installationId: "plugin",
        threadId: ThreadId.make("plugin:plugin:forged:thread"),
      }),
    ).toBe(false);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Receipts.layer, CoreReceipts.layer).pipe(
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
