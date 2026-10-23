import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";

export class PluginDatabaseError extends Schema.TaggedError<PluginDatabaseError>()(
  "PluginDatabaseError",
  { operation: Schema.Literals(["open", "migrate"]), cause: Schema.Defect() },
) {
  override get message() {
    return "The plugin database could not be opened. Plugin data has been preserved.";
  }
}

export class PluginDatabase extends Context.Service<
  PluginDatabase,
  { readonly client: Effect.Effect<SqlClient.SqlClient, PluginDatabaseError> }
>()("t3/plugins/PluginDatabase") {}

const isPluginDatabaseError = Schema.is(PluginDatabaseError);

const migrate = Effect.fn("PluginDatabase.migrate")(
  function* (sql: SqlClient.SqlClient) {
    yield* sql`PRAGMA busy_timeout = 5000`;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const version = yield* sql<{ user_version: number }>`PRAGMA user_version`;
        if ((version[0]?.user_version ?? 0) > 1)
          return yield* new PluginDatabaseError({ operation: "migrate", cause: "newer-schema" });
        const tables = yield* sql<{
          name: string;
        }>`SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`;
        if ((version[0]?.user_version ?? 0) === 0 && tables.length > 0)
          return yield* new PluginDatabaseError({
            operation: "migrate",
            cause: "unrecognized-schema",
          });
        if ((version[0]?.user_version ?? 0) === 1) {
          for (const [table, required] of [
            ["plugin_records", ["installation_id", "position", "record_json", "event_cursor"]],
            ["plugin_storage", ["installation_id", "key", "value_json"]],
            ["plugin_state_metadata", ["id", "value_json"]],
          ] as const) {
            const columns = yield* sql<{ name: string }>`PRAGMA table_info(${sql(table)})`;
            if (required.some((name) => !columns.some((column) => column.name === name)))
              return yield* new PluginDatabaseError({
                operation: "migrate",
                cause: "incomplete-schema",
              });
          }
        } else {
          yield* sql`CREATE TABLE IF NOT EXISTS plugin_records (
      installation_id TEXT PRIMARY KEY, position INTEGER NOT NULL,
      record_json TEXT NOT NULL, event_cursor INTEGER NOT NULL
    )`;
          yield* sql`CREATE TABLE IF NOT EXISTS plugin_storage (
      installation_id TEXT NOT NULL REFERENCES plugin_records(installation_id) ON DELETE CASCADE,
      key TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(installation_id,key)
    )`;
          yield* sql`CREATE TABLE IF NOT EXISTS plugin_state_metadata (
      id INTEGER PRIMARY KEY CHECK(id=1), value_json TEXT NOT NULL
    )`;
          yield* sql`PRAGMA user_version = 1`;
        }
      }),
    );
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* sql`PRAGMA synchronous = NORMAL`;
  },
  Effect.mapError((cause) =>
    isPluginDatabaseError(cause) ? cause : new PluginDatabaseError({ operation: "migrate", cause }),
  ),
);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  let successfulClient: SqlClient.SqlClient | undefined;
  // Failed attempts close their connection; only a successful open is shared for this scope.
  const client = Effect.gen(function* () {
    if (successfulClient !== undefined) return successfulClient;
    const attemptScope = yield* Scope.fork(scope);
    const sql = yield* Effect.gen(function* () {
      const directory = path.join(config.stateDir, "plugins");
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const filename = path.join(directory, "state.sqlite");
      const existed = yield* fs.exists(filename);
      const context = yield* Layer.buildWithScope(
        NodeSqliteClient.layer({ filename }),
        attemptScope,
      );
      const sql = Context.get(context, SqlClient.SqlClient);
      if (!existed) yield* fs.chmod(filename, 0o600);
      yield* migrate(sql);
      return sql;
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? Scope.close(attemptScope, exit) : Effect.void,
      ),
      Effect.mapError((cause) =>
        isPluginDatabaseError(cause)
          ? cause
          : new PluginDatabaseError({ operation: "open", cause }),
      ),
    );
    successfulClient = sql;
    return sql;
  }).pipe(lock.withPermits(1));
  return PluginDatabase.of({ client });
});
export const layer = Layer.effect(PluginDatabase, make);
