import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Config from "../config.ts";
import * as Database from "./PluginDatabase.ts";
import * as Store from "./PluginStore.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const testLayer = () =>
  Database.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        Sqlite.layerMemory,
        Config.layerTest(process.cwd(), { prefix: "plugin-store-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
const legacyCatalogue = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE plugin_records (installation_id TEXT PRIMARY KEY, position INTEGER NOT NULL, record_json TEXT NOT NULL, event_cursor INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE plugin_storage (installation_id TEXT NOT NULL REFERENCES plugin_records(installation_id) ON DELETE CASCADE, key TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(installation_id,key))`;
  yield* sql`CREATE TABLE plugin_state_metadata (id INTEGER PRIMARY KEY CHECK(id=1), value_json TEXT NOT NULL)`;
});
const valid: Store.StoredInstallation = {
  installation: {
    installationId: "valid",
    generation: "one",
    manifest: {
      id: "test.valid",
      name: "Valid",
      version: "1.0.0",
      apiVersion: 1,
      entry: "plugin.mjs",
      capabilities: [],
      actions: [],
      views: [],
      settings: [],
    },
    source: { kind: "local", directory: "/fixture" },
    digest: "0".repeat(64),
    enabled: false,
    consentedDigest: null,
    status: "needs-consent",
    error: null,
    settings: {},
    grants: { capabilities: [], projectIds: [] },
    updatedAt: "2026-10-22T12:00:00.000Z",
  },
  directory: "/fixture",
  sourceRequest: { kind: "git", url: "https://example.com/board.git", ref: "main" },
  secrets: { token: "private fixture" },
  storage: { board: [{ note: "Actual note" }] },
  eventCursor: 12,
};
const buildStore = Effect.map(Layer.build(Store.layer), (context) =>
  Context.get(context, Store.PluginStore),
);

it.effect("an interrupted atomic publish retains committed records and the read cache", () =>
  Effect.gen(function* () {
    const sql = yield* (yield* Database.PluginDatabase).client;
    const store = yield* buildStore;
    yield* store.update((state) =>
      Effect.succeed([undefined, { ...state, installations: [valid] }] as const),
    );
    yield* sql`CREATE TRIGGER reject_plugin_commit BEFORE UPDATE ON plugin_records BEGIN SELECT RAISE(ABORT,'fixture'); END`;
    expect(
      (yield* store
        .update((state) =>
          Effect.succeed([
            undefined,
            {
              ...state,
              installations: state.installations.map((record) => ({
                ...record,
                installation: { ...record.installation, error: "partial" },
              })),
            },
          ] as const),
        )
        .pipe(Effect.flip)).operation,
    ).toBe("write");
    expect((yield* store.read).installations[0]?.installation.error).toBe(null);
    expect((yield* (yield* buildStore).read).installations[0]?.installation.error).toBe(null);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
it.effect("imports legacy state atomically and keeps incompatible private bytes recoverable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Config.ServerConfig;
    const directory = `${config.stateDir}/plugins`;
    const future = {
      ...valid,
      formatVersion: 2,
      installation: {
        ...valid.installation,
        installationId: "future",
        manifest: { ...valid.installation.manifest, apiVersion: 2 },
      },
    };
    yield* fs.makeDirectory(directory, { recursive: true });
    const legacy = yield* encodeJson({
      version: 1,
      installations: [valid, future],
      receipts: {},
      origins: {},
    });
    yield* fs.writeFileString(`${directory}/state.json`, legacy);
    const sql = yield* (yield* Database.PluginDatabase).client;
    yield* sql`CREATE TRIGGER reject_import BEFORE INSERT ON plugin_storage BEGIN SELECT RAISE(ABORT,'fixture'); END`;
    const store = yield* buildStore;
    expect((yield* store.read.pipe(Effect.flip)).operation).toBe("read");
    expect(yield* sql`SELECT * FROM plugin_records`).toHaveLength(0);
    expect(yield* sql`SELECT * FROM plugin_state_metadata`).toHaveLength(0);
    yield* sql`DROP TRIGGER reject_import`;
    const state = yield* store.read;
    expect(state.installations[0]).toMatchObject({
      storage: valid.storage,
      secrets: valid.secrets,
      sourceRequest: valid.sourceRequest,
      eventCursor: 12,
    });
    expect(state.installations[1]?.rawRecord).toEqual(future);
    expect(state.installations[1]?.installation).toMatchObject({
      recordIssue: "newer",
      status: "incompatible",
    });
    const original =
      yield* sql`SELECT record_json FROM plugin_records WHERE installation_id='future'`;
    yield* store.update((current) =>
      Effect.succeed([
        undefined,
        {
          ...current,
          installations: current.installations.filter(
            (record) => record.installation.installationId !== "valid",
          ),
        },
      ] as const),
    );
    expect(
      yield* sql`SELECT record_json FROM plugin_records WHERE installation_id='future'`,
    ).toEqual(original);
    expect((yield* (yield* buildStore).read).installations[0]?.rawRecord).toEqual(future);
    expect(yield* fs.readFileString(`${directory}/state.json`)).toBe(legacy);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
it.effect("preserves newer record bytes through peer writes and refuses ordinary deletion", () =>
  Effect.gen(function* () {
    const core = yield* SqlClient.SqlClient;
    yield* legacyCatalogue;
    const raw =
      '{ "formatVersion": 99, "installation": { "installationId": "future", "manifest": { "id": "publisher.future", "name": "Future Plugin", "version": "2.3.4" } }, "private": "retained" }';
    yield* core`INSERT INTO plugin_state_metadata VALUES(1,'not-json')`;
    yield* core`INSERT INTO plugin_records VALUES('future',0,${raw},7)`;
    yield* core`INSERT INTO plugin_storage VALUES('future','private','{"value":"retained"}')`;
    const store = yield* buildStore;
    expect((yield* store.read).installations[0]?.recordIssue).toBe("newer");
    expect((yield* store.read).installations[0]?.installation.manifest).toMatchObject({
      id: "publisher.future",
      name: "Future Plugin",
      version: "2.3.4",
    });
    const sql = yield* (yield* Database.PluginDatabase).client;
    const before = yield* sql`SELECT * FROM plugin_records`;
    yield* store.update((state) =>
      Effect.succeed([
        undefined,
        { ...state, installations: [...state.installations, valid] },
      ] as const),
    );
    const error = yield* store
      .update((state) => Effect.succeed([undefined, { ...state, installations: [] }] as const))
      .pipe(Effect.flip);
    expect(error.operation).toBe("write");
    expect(yield* sql`SELECT * FROM plugin_records WHERE installation_id='future'`).toEqual(before);
    expect(yield* sql`SELECT * FROM plugin_storage WHERE installation_id='future'`).toEqual([
      { installation_id: "future", key: "private", value_json: '{"value":"retained"}' },
    ]);
    expect(yield* core`SELECT record_json FROM plugin_records`).toEqual([{ record_json: raw }]);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
it.effect("isolates invalid JSON and corrupt KV per installation", () =>
  Effect.gen(function* () {
    const core = yield* SqlClient.SqlClient;
    yield* legacyCatalogue;
    yield* core`INSERT INTO plugin_state_metadata VALUES(1,'{}')`;
    yield* core`INSERT INTO plugin_records VALUES('broken',0,'{broken',7)`;
    yield* core`INSERT INTO plugin_records VALUES('valid',1,${yield* encodeJson(valid)},12)`;
    yield* core`INSERT INTO plugin_storage VALUES('valid','bad','{invalid')`;
    const state = yield* (yield* buildStore).read;
    expect(
      state.installations.map((record) => [record.installation.installationId, record.recordIssue]),
    ).toEqual([
      ["broken", "corrupt"],
      ["valid", "corrupt"],
    ]);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
it.effect.each([true, false, "true", 1, null, undefined])(
  "preserves only a literal removed tombstone in an opaque record (removed=%s)",
  (removed) =>
    Effect.gen(function* () {
      const sql = yield* (yield* Database.PluginDatabase).client;
      const raw = ` ${yield* encodeJson({
        ...valid,
        formatVersion: 2,
        removed,
        installation: {
          ...valid.installation,
          installationId: "future",
          enabled: true,
          settings: { private: "opaque setting" },
        },
      })}\n`;
      yield* sql`INSERT INTO plugin_records VALUES('future',0,${raw},12)`;
      yield* sql`INSERT INTO plugin_state_metadata VALUES(1,'{}')`;
      const store = yield* buildStore;
      const placeholder = (yield* store.read).installations[0];
      expect(placeholder?.removed).toBe(removed === true ? true : undefined);
      expect(placeholder).toMatchObject({
        recordIssue: "newer",
        installation: {
          manifest: { id: "test.valid", name: "Valid", version: "1.0.0" },
          enabled: false,
          settings: {},
          grants: { capabilities: [], projectIds: [] },
        },
        secrets: {},
      });
      yield* store.update((state) =>
        Effect.succeed([
          undefined,
          { ...state, installations: [...state.installations, valid] },
        ] as const),
      );
      expect(
        yield* sql`SELECT record_json FROM plugin_records WHERE installation_id='future'`,
      ).toEqual([{ record_json: raw }]);
      expect((yield* (yield* buildStore).read).installations[0]?.removed).toBe(
        removed === true ? true : undefined,
      );
    }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
it.effect("defers an unreadable database failure to plugin operations and preserves the file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Config.ServerConfig;
    yield* fs.makeDirectory(`${config.stateDir}/plugins`, { recursive: true });
    const bytes = "unreadable database fixture";
    yield* fs.writeFileString(`${config.stateDir}/plugins/state.sqlite`, bytes);
    const store = yield* buildStore;
    expect((yield* store.read.pipe(Effect.flip)).operation).toBe("read");
    expect(yield* fs.readFileString(`${config.stateDir}/plugins/state.sqlite`)).toBe(bytes);
    expect(yield* (yield* SqlClient.SqlClient)`SELECT 1 AS available`).toEqual([{ available: 1 }]);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
it.effect("catalogue and KV writes do not take the core writer lock after import", () =>
  Effect.gen(function* () {
    const core = yield* SqlClient.SqlClient;
    yield* legacyCatalogue;
    const store = yield* buildStore;
    yield* store.read;
    yield* core.withTransaction(
      Effect.gen(function* () {
        yield* core`INSERT INTO plugin_state_metadata VALUES(1,'core-only')`;
        yield* store.update((state) =>
          Effect.succeed([undefined, { ...state, installations: [valid] }] as const),
        );
      }),
    );
    expect((yield* store.read).installations[0]?.storage).toEqual(valid.storage);
    expect(yield* core`SELECT * FROM plugin_records`).toHaveLength(0);
    const reopenedDatabase = Context.get(
      yield* Layer.build(Database.layer),
      Database.PluginDatabase,
    );
    const reopenedSql = yield* reopenedDatabase.client;
    expect(yield* reopenedSql`SELECT installation_id FROM plugin_records`).toEqual([
      { installation_id: "valid" },
    ]);
    expect(
      yield* (yield* (yield* Database.PluginDatabase)
        .client)`SELECT installation_id FROM plugin_records`,
    ).toEqual([{ installation_id: "valid" }]);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("leaves a newer plugin database opaque and preserves its schema and bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Config.ServerConfig;
    const directory = `${config.stateDir}/plugins`;
    yield* fs.makeDirectory(directory, { recursive: true });
    const filename = `${directory}/state.sqlite`;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE future_state (value TEXT NOT NULL)`;
      yield* sql`INSERT INTO future_state VALUES('retained future state')`;
      yield* sql`PRAGMA user_version=99`;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    const before = yield* fs.readFile(filename);
    const store = yield* buildStore;
    expect((yield* store.read.pipe(Effect.flip)).operation).toBe("read");
    expect(yield* fs.readFile(filename)).toEqual(before);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("retries a transient catalogue open failure and shares the successful connection", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Config.ServerConfig;
    const directory = `${config.stateDir}/plugins`;
    yield* fs.writeFileString(directory, "temporary blocker");
    const database = yield* Database.PluginDatabase;
    expect((yield* database.client.pipe(Effect.flip)).operation).toBe("open");
    yield* fs.remove(directory);
    const clients = yield* Effect.all([database.client, database.client, database.client], {
      concurrency: "unbounded",
    });
    expect(clients[1]).toBe(clients[0]);
    expect(clients[2]).toBe(clients[0]);
    expect(yield* clients[0]!`SELECT 1 AS available`).toEqual([{ available: 1 }]);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("validates opaque display fields independently without trusting invalid metadata", () =>
  Effect.gen(function* () {
    const sql = yield* (yield* Database.PluginDatabase).client;
    const raw = yield* encodeJson({
      formatVersion: 99,
      installation: {
        manifest: {
          id: "publisher.future",
          name: "x".repeat(201),
          version: "unverified publisher claim",
        },
      },
    });
    yield* sql`INSERT INTO plugin_records VALUES('opaque',0,${raw},0)`;
    yield* sql`INSERT INTO plugin_state_metadata VALUES(1,'{}')`;
    const store = yield* buildStore;
    expect((yield* store.read).installations[0]?.installation.manifest).toMatchObject({
      id: "publisher.future",
      name: "Unavailable plugin record",
      version: "0.0.0",
    });
    expect(yield* sql`SELECT record_json FROM plugin_records`).toEqual([{ record_json: raw }]);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
