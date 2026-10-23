import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE plugin_operation_receipts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_key TEXT UNIQUE NOT NULL,
    installation_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    result_json TEXT,
    effect_json TEXT
  )`;
  yield* sql`CREATE INDEX plugin_receipts_results ON plugin_operation_receipts(installation_id,sequence DESC) WHERE result_json IS NOT NULL`;
  yield* sql`CREATE TABLE plugin_run_deliveries (
    installation_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    run_id TEXT NOT NULL,
    PRIMARY KEY(installation_id,run_id)
  )`;
  yield* sql`CREATE TABLE plugin_event_reservations (
    installation_id TEXT NOT NULL,
    generation TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    operation_key TEXT UNIQUE NOT NULL
  )`;
  yield* sql`CREATE INDEX plugin_event_reservations_logical ON plugin_event_reservations(installation_id,delivery_id)`;
  yield* sql`CREATE UNIQUE INDEX plugin_run_deliveries_identity ON plugin_run_deliveries(installation_id,run_id)`;
});
