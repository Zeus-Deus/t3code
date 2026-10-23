import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Receipts from "./PluginReceipts.ts";
import { runMigrations } from "../persistence/Migrations.ts";
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
    yield* sql`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<2048)
      INSERT INTO plugin_operation_receipts(operation_key,installation_id,generation,request_digest,result_json,effect_json)
      SELECT 'old-'||n,'plugin','one','digest','{"threadId":"prior"}','{"threadId":"prior"}' FROM numbers`;
    const receipts = yield* Receipts.PluginReceipts;
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
        yield* receipts.complete(input.key, { threadId: "retained" });
        yield* receipts.reserve({ ...input, key: "second" });
        yield* receipts.reserve({ ...input, key: "third" });
        yield* receipts.acknowledge({ ...input, runId: "run" });
      }).pipe(Effect.provide(service));
      yield* Effect.gen(function* () {
        const receipts = yield* Receipts.PluginReceipts;
        const current = { ...input, generation: "two" };
        yield* receipts.prune("plugin", "two");
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
      yield* sql`DROP TABLE plugin_operation_receipts`;
      yield* sql`DROP TABLE plugin_run_deliveries`;
      yield* sql`DROP TABLE plugin_event_reservations`;
      yield* sql`CREATE TABLE plugin_operation_receipts(sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_key TEXT UNIQUE NOT NULL, installation_id TEXT NOT NULL, generation TEXT NOT NULL, request_digest TEXT NOT NULL, result_json TEXT)`;
      yield* sql`CREATE TABLE plugin_run_deliveries(installation_id TEXT NOT NULL,generation TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(installation_id,generation,run_id))`;
      yield* sql`CREATE TABLE plugin_event_reservations(installation_id TEXT NOT NULL,generation TEXT NOT NULL,delivery_id TEXT NOT NULL,operation_key TEXT UNIQUE NOT NULL)`;
      yield* sql`INSERT INTO plugin_operation_receipts(operation_key,installation_id,generation,request_digest,result_json) VALUES('old','plugin','one','digest','{"threadId":"retained"}')`;
      yield* sql`INSERT INTO plugin_run_deliveries VALUES('plugin','one','run'),('plugin','two','run')`;
      yield* sql`INSERT INTO plugin_event_reservations VALUES('plugin','one','delivery','old'),('plugin','two','delivery','second'),('plugin','two','delivery','third')`;
      yield* sql`INSERT INTO effect_sql_migrations(migration_id,name) VALUES(69,'PluginState')`;
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
it.effect("does not migrate or rewrite an already-current ledger on first use", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const before = yield* sql`PRAGMA schema_version`;
    yield* (yield* Receipts.PluginReceipts).reserve({
      installationId: "plugin",
      generation: "one",
      key: "first",
      requestDigest: "digest",
    });
    expect(yield* sql`PRAGMA schema_version`).toEqual(before);
  }).pipe(Effect.provide(layer)),
);
