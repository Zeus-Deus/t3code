import { CommandId, PluginError, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as CoreReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const effectHandle = Schema.Struct({ threadId: ThreadId });
const decodeEffectHandle = Schema.decodeUnknownOption(effectHandle);
const decodeEffectJson = Schema.decodeUnknownEffect(Schema.fromJsonString(effectHandle));
const failed = () =>
  new PluginError({
    reason: "storage_failed",
    message: "The plugin operation receipt could not be read or saved.",
  });
const isPluginError = Schema.is(PluginError);
interface Identity {
  readonly installationId: string;
  readonly generation: string;
}
export class PluginReceipts extends Context.Service<
  PluginReceipts,
  {
    readonly createdThread: (input: {
      readonly installationId: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<boolean, PluginError>;
    readonly reserve: (
      input: Identity & {
        readonly key: string;
        readonly requestDigest: string;
        readonly deliveryId?: string;
      },
    ) => Effect.Effect<{ readonly result?: unknown }, PluginError>;
    readonly releaseUncommitted: (
      key: string,
      requestDigest: string,
    ) => Effect.Effect<void, PluginError>;
    readonly complete: (key: string, result: unknown) => Effect.Effect<void, PluginError>;
    readonly delivered: (
      input: Identity & { readonly runId: string },
    ) => Effect.Effect<boolean, PluginError>;
    readonly acknowledge: (
      input: Identity & { readonly runId: string; readonly deliveryId: string },
    ) => Effect.Effect<void, PluginError>;
    readonly prune: (
      installationId: string,
      keepGeneration?: string,
    ) => Effect.Effect<void, PluginError>;
  }
>()("t3/plugins/PluginReceipts") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const coreReceipts = yield* CoreReceipts.OrchestrationCommandReceiptRepository;
  const prepare = yield* Effect.cached(
    sql.withTransaction(
      Effect.gen(function* () {
        // Only old, unshipped development schemas need upgrading; fresh homes have the final ledger.
        const columns = yield* sql<{ name: string }>`PRAGMA table_info(plugin_operation_receipts)`;
        if (!columns.some((column) => column.name === "effect_json"))
          yield* sql`ALTER TABLE plugin_operation_receipts ADD COLUMN effect_json TEXT`;
        const indices = yield* sql<{
          name: string;
        }>`SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name IN ('plugin_operation_receipts','plugin_run_deliveries','plugin_event_reservations')`;
        const names = new Set(indices.map((index) => index.name));
        if (!names.has("plugin_receipts_results"))
          yield* sql`CREATE INDEX plugin_receipts_results ON plugin_operation_receipts(installation_id,sequence DESC) WHERE result_json IS NOT NULL`;
        if (!names.has("plugin_run_deliveries_identity")) {
          yield* sql`DELETE FROM plugin_run_deliveries WHERE rowid NOT IN (SELECT MIN(rowid) FROM plugin_run_deliveries GROUP BY installation_id,run_id)`;
          yield* sql`CREATE UNIQUE INDEX plugin_run_deliveries_identity ON plugin_run_deliveries(installation_id,run_id)`;
        }
        if (!names.has("plugin_event_reservations_logical"))
          yield* sql`CREATE INDEX plugin_event_reservations_logical ON plugin_event_reservations(installation_id,delivery_id)`;
      }),
    ),
  );
  const reserve = Effect.fn("PluginReceipts.reserve")(
    function* (
      input: Identity & {
        readonly key: string;
        readonly requestDigest: string;
        readonly deliveryId?: string;
      },
    ) {
      yield* prepare;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const previous = yield* sql<{
            request_digest: string;
            result_json: string | null;
            effect_json: string | null;
          }>`SELECT request_digest,result_json,effect_json FROM plugin_operation_receipts WHERE operation_key=${input.key}`;
          if (previous[0]) {
            if (previous[0].request_digest !== input.requestDigest) {
              const priorEffect =
                previous[0].effect_json === null
                  ? undefined
                  : yield* decodeEffectJson(previous[0].effect_json);
              return yield* new PluginError({
                reason: "invalid_input",
                code: "idempotency_conflict",
                message: "An idempotency key cannot identify different plugin requests.",
                ...(priorEffect === undefined ? {} : { priorEffect }),
              });
            }
            return previous[0].result_json === null
              ? {}
              : { result: yield* decodeJson(previous[0].result_json) };
          }
          if (input.deliveryId !== undefined) {
            const reservation =
              yield* sql`SELECT operation_key FROM plugin_event_reservations WHERE operation_key=${input.key}`;
            if (reservation.length === 0) {
              const count = yield* sql<{
                count: number;
              }>`SELECT COUNT(*) AS count FROM plugin_event_reservations WHERE installation_id=${input.installationId} AND delivery_id=${input.deliveryId}`;
              if ((count[0]?.count ?? 0) >= 3)
                return yield* new PluginError({
                  reason: "permission_denied",
                  message: "A finalized-run delivery can create at most three thread operations.",
                });
              yield* sql`INSERT INTO plugin_event_reservations(installation_id,generation,delivery_id,operation_key) VALUES(${input.installationId},${input.generation},${input.deliveryId},${input.key})`;
            }
          }
          yield* sql`INSERT INTO plugin_operation_receipts(operation_key,installation_id,generation,request_digest) VALUES(${input.key},${input.installationId},${input.generation},${input.requestDigest})`;
          return {};
        }),
      );
    },
    Effect.mapError((error) => (isPluginError(error) ? error : failed())),
  );
  const releaseUncommitted = Effect.fn("PluginReceipts.releaseUncommitted")(function* (
    key: string,
    requestDigest: string,
  ) {
    // A failed lookup is an unknown outcome, never proof that the command did not commit.
    const receipt = yield* coreReceipts
      .getByCommandId({ commandId: CommandId.make(key) })
      .pipe(Effect.option);
    if (receipt._tag === "None" || Option.isSome(receipt.value)) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const deleted = yield* sql`DELETE FROM plugin_operation_receipts
        WHERE operation_key=${key} AND request_digest=${requestDigest} AND result_json IS NULL AND effect_json IS NULL
        RETURNING operation_key`;
        if (deleted.length > 0)
          yield* sql`DELETE FROM plugin_event_reservations WHERE operation_key=${key}`;
      }),
    );
  }, Effect.mapError(failed));
  const complete = Effect.fn("PluginReceipts.complete")(function* (key: string, result: unknown) {
    yield* prepare;
    const value = yield* encodeJson(result);
    const effect = decodeEffectHandle(result);
    const effectJson = effect._tag === "Some" ? yield* encodeJson(effect.value) : null;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE plugin_operation_receipts SET result_json=${value},effect_json=COALESCE(effect_json,${effectJson}) WHERE operation_key=${key}`;
        // Only results expire. Request fingerprints and effect bindings outlive the cache.
        yield* sql`UPDATE plugin_operation_receipts SET result_json=NULL
        WHERE installation_id=(SELECT installation_id FROM plugin_operation_receipts WHERE operation_key=${key})
        AND result_json IS NOT NULL AND sequence NOT IN (
          SELECT sequence FROM plugin_operation_receipts
          WHERE installation_id=(SELECT installation_id FROM plugin_operation_receipts WHERE operation_key=${key}) AND result_json IS NOT NULL
          ORDER BY sequence DESC LIMIT 2048)`;
      }),
    );
  }, Effect.mapError(failed));
  const delivered = Effect.fn("PluginReceipts.delivered")(function* (
    input: Identity & { readonly runId: string },
  ) {
    yield* prepare;
    const rows =
      yield* sql`SELECT run_id FROM plugin_run_deliveries WHERE installation_id=${input.installationId} AND run_id=${input.runId}`;
    return rows.length > 0;
  }, Effect.mapError(failed));
  const acknowledge = Effect.fn("PluginReceipts.acknowledge")(function* (
    input: Identity & { readonly runId: string; readonly deliveryId: string },
  ) {
    yield* prepare;
    yield* sql.withTransaction(
      sql`INSERT INTO plugin_run_deliveries(installation_id,generation,run_id) VALUES(${input.installationId},${input.generation},${input.runId}) ON CONFLICT DO NOTHING`,
    );
  }, Effect.mapError(failed));
  const prune = Effect.fn("PluginReceipts.prune")(function* (
    installationId: string,
    keepGeneration?: string,
  ) {
    if (keepGeneration !== undefined) return;
    // Core history still owns these effects after plugin data is removed.
    yield* sql`UPDATE plugin_operation_receipts SET result_json=NULL WHERE installation_id=${installationId} AND result_json IS NOT NULL`;
  }, Effect.mapError(failed));
  const createdThread = Effect.fn("PluginReceipts.createdThread")(function* (input: {
    readonly installationId: string;
    readonly threadId: ThreadId;
  }) {
    const rows = yield* sql`SELECT 1 FROM orchestration_command_receipts AS core
      INNER JOIN plugin_operation_receipts AS plugin ON plugin.operation_key=core.command_id
      WHERE core.aggregate_kind='thread' AND core.aggregate_id=${input.threadId}
        AND core.command_type='thread.create' AND core.status='accepted'
        AND plugin.installation_id=${input.installationId} LIMIT 1`;
    return rows.length > 0;
  }, Effect.mapError(failed));
  return PluginReceipts.of({
    createdThread,
    reserve,
    releaseUncommitted,
    complete,
    delivered,
    acknowledge,
    prune,
  });
});
export const layer = Layer.effect(PluginReceipts, make).pipe(Layer.provide(CoreReceipts.layer));
