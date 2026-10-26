import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ShellStopRequestIndex from "./Migrations/068_ShellStopRequestIndex.ts";
import ThreadMessageSearch from "./Migrations/069_ThreadMessageSearch.ts";

// Local plugin previews used id 68 before main reserved it; retain their ledger without skipping main.
export const reconcilePluginPreviewMigration = Effect.fn("reconcilePluginPreviewMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
        if (tables.length === 0) return [];
        const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 68
        `;
        if (!history.some((row) => row.migration_id === 68 && row.name === "PluginReceipts")) {
          return [];
        }
        if (
          !history.every(
            (row) =>
              (row.migration_id === 68 && row.name === "PluginReceipts") ||
              (row.migration_id === 69 && row.name === "PluginState"),
          )
        ) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot upgrade plugin preview with unexpected later migrations.",
          });
        }
        yield* ShellStopRequestIndex;
        yield* ThreadMessageSearch;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 69 AND name = 'PluginState'`;
        yield* sql`UPDATE effect_sql_migrations SET migration_id = 70 WHERE migration_id = 68 AND name = 'PluginReceipts'`;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (68, 'ShellStopRequestIndex'), (69, 'ThreadMessageSearch')`;
        return [
          [68, "ShellStopRequestIndex"],
          [69, "ThreadMessageSearch"],
        ] as const;
      }),
    );
  },
);
