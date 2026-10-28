import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Config from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
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
    const committed = yield* store.read;
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
                secrets: { token: "uncommitted secret" },
              })),
            },
          ] as const),
        )
        .pipe(Effect.flip)).operation,
    ).toBe("write");
    expect((yield* store.read).installations[0]?.installation.error).toBe(null);
    expect(store.isCurrent(committed)).toBe(true);
    const reopened = (yield* (yield* buildStore).read).installations[0];
    expect(reopened?.installation.error).toBe(null);
    expect(reopened?.secrets).toEqual(valid.secrets);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);

it.effect("keeps committed secrets when the protected write fails", () =>
  Effect.gen(function* () {
    const store = yield* buildStore;
    yield* store.update((state) =>
      Effect.succeed([undefined, { ...state, installations: [valid] }] as const),
    );
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Config.ServerConfig;
    yield* fs.rename(config.secretsDir, `${config.secretsDir}-held`);
    yield* fs.writeFileString(config.secretsDir, "temporary secret-store blocker");
    expect(
      (yield* store
        .update((state) =>
          Effect.succeed([
            undefined,
            {
              ...state,
              installations: [{ ...valid, secrets: { token: "uncommitted secret" } }],
            },
          ] as const),
        )
        .pipe(Effect.flip)).operation,
    ).toBe("write");
    expect((yield* store.read).installations[0]?.secrets).toEqual(valid.secrets);
    yield* fs.remove(config.secretsDir);
    yield* fs.rename(`${config.secretsDir}-held`, config.secretsDir);
    expect((yield* (yield* buildStore).read).installations[0]?.secrets).toEqual(valid.secrets);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
it.effect("isolates a missing protected secret without overwriting it or blocking peers", () =>
  Effect.gen(function* () {
    const store = yield* buildStore;
    yield* store.update((state) =>
      Effect.succeed([
        undefined,
        {
          ...state,
          installations: [
            valid,
            {
              ...valid,
              secrets: {},
              installation: { ...valid.installation, installationId: "peer" },
            },
          ],
        },
      ] as const),
    );
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Config.ServerConfig;
    const files = (yield* fs.readDirectory(config.secretsDir)).filter((name) =>
      name.startsWith("plugin-settings-"),
    );
    yield* fs.remove(`${config.secretsDir}/${files[0]}`);
    const reopened = yield* (yield* buildStore).read;
    expect(reopened.installations[0]).toMatchObject({
      recordIssue: "corrupt",
      installation: { status: "incompatible" },
    });
    expect(reopened.installations[1]).toMatchObject({
      installation: { installationId: "peer", status: "needs-consent" },
    });
    const sql = yield* (yield* Database.PluginDatabase).client;
    expect(yield* sql`SELECT installation_id FROM plugin_records ORDER BY installation_id`).toEqual(
      [{ installation_id: "peer" }, { installation_id: "valid" }],
    );
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
it.effect("validates snapshot identity without waiting for an uncommitted update", () =>
  Effect.gen(function* () {
    const store = yield* buildStore;
    const committed = yield* store.read;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const pending = yield* store
      .update((state) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as([undefined, { ...state, installations: [valid] }] as const),
        ),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    expect(store.isCurrent(committed)).toBe(true);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(pending);
    expect(store.isCurrent(committed)).toBe(false);
    const current = yield* store.read;
    expect(current.installations).toEqual([valid]);
    expect(store.isCurrent(current)).toBe(true);
    yield* store.update((state) => Effect.succeed([undefined, state] as const));
    expect(store.isCurrent(current)).toBe(true);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
it.effect("keeps secret revisions out of the catalogue and restores them after reopening", () =>
  Effect.gen(function* () {
    const store = yield* buildStore;
    const record = {
      ...valid,
      previous: {
        directory: valid.directory,
        manifest: valid.installation.manifest,
        source: valid.installation.source,
        digest: valid.installation.digest,
        settings: {},
        secrets: { token: "previous private fixture" },
      },
      pendingSecrets: { token: "pending private fixture" },
    };
    yield* store.update((state) =>
      Effect.succeed([undefined, { ...state, installations: [record] }] as const),
    );
    const sql = yield* (yield* Database.PluginDatabase).client;
    const rows = yield* sql<{ record_json: string }>`SELECT record_json FROM plugin_records`;
    expect(rows[0]?.record_json).not.toContain("private fixture");
    expect(rows[0]?.record_json).toContain('"formatVersion":2');
    const reopened = (yield* (yield* buildStore).read).installations[0];
    expect(reopened?.secrets).toEqual(record.secrets);
    expect(reopened?.previous?.secrets).toEqual(record.previous.secrets);
    expect(reopened?.pendingSecrets).toEqual(record.pendingSecrets);
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Config.ServerConfig;
    if ((yield* HostProcess.Platform) !== "win32")
      expect((yield* fs.stat(config.secretsDir)).mode & 0o777).toBe(0o700);
    const files = (yield* fs.readDirectory(config.secretsDir)).filter((name) =>
      name.startsWith("plugin-settings-"),
    );
    expect(files).toHaveLength(1);
    if ((yield* HostProcess.Platform) !== "win32")
      expect((yield* fs.stat(`${config.secretsDir}/${files[0]}`)).mode & 0o777).toBe(0o600);
    yield* store.update((state) =>
      Effect.succeed([undefined, { ...state, installations: [] }] as const),
    );
    expect(
      (yield* fs.readDirectory(config.secretsDir)).filter((name) =>
        name.startsWith("plugin-settings-"),
      ),
    ).toEqual([]);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
it.effect("moves existing catalogue secrets before publishing the hydrated state", () =>
  Effect.gen(function* () {
    const sql = yield* (yield* Database.PluginDatabase).client;
    yield* sql`INSERT INTO plugin_records VALUES('valid',0,${yield* encodeJson(valid)},12)`;
    const store = yield* buildStore;
    expect((yield* store.read).installations[0]?.secrets).toEqual(valid.secrets);
    const rows = yield* sql<{ record_json: string }>`SELECT record_json FROM plugin_records`;
    expect(rows[0]?.record_json).not.toContain("private fixture");
    expect(rows[0]?.record_json).toContain('"formatVersion":2');
    expect((yield* (yield* buildStore).read).installations[0]?.secrets).toEqual(valid.secrets);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
it.effect("ignores the unshipped JSON catalogue without modifying its bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Config.ServerConfig;
    const directory = `${config.stateDir}/plugins`;
    yield* fs.makeDirectory(directory, { recursive: true });
    const legacy = yield* encodeJson({ version: 1, installations: [valid] });
    yield* fs.writeFileString(`${directory}/state.json`, legacy);
    expect((yield* (yield* buildStore).read).installations).toEqual([]);
    expect(yield* fs.readFileString(`${directory}/state.json`)).toBe(legacy);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
it.effect("preserves newer record bytes through peer writes and refuses ordinary deletion", () =>
  Effect.gen(function* () {
    const core = yield* (yield* Database.PluginDatabase).client;
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
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
it.effect("isolates invalid JSON and corrupt KV per installation", () =>
  Effect.gen(function* () {
    const core = yield* (yield* Database.PluginDatabase).client;
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
        formatVersion: 3,
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

it.effect.each(["corrupt", "blocked", "newer"] as const)(
  "keeps core project commits and replay available while plugin startup is %s",
  (fault) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      const directory = `${config.stateDir}/plugins`;
      const filename = `${directory}/state.sqlite`;
      if (fault === "blocked") yield* fs.writeFileString(directory, "blocked plugin directory");
      else {
        yield* fs.makeDirectory(directory, { recursive: true });
        if (fault === "corrupt") yield* fs.writeFileString(filename, "corrupt plugin database");
        else
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TABLE future_state(value TEXT)`;
            yield* sql`INSERT INTO future_state VALUES('private future bytes')`;
            yield* sql`PRAGMA user_version=99`;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      }
      const artifact = fault === "blocked" ? directory : filename;
      const before = yield* fs.readFile(artifact);
      const store = yield* buildStore;
      expect((yield* store.read.pipe(Effect.flip)).operation).toBe("read");
      const core = Context.get(
        yield* Layer.build(
          EventSink.layer.pipe(
            Layer.provide(EventStore.layer),
            Layer.provide(ProjectionStore.layer),
          ),
        ),
        EventSink.EventSinkV2,
      );
      const projectId = ProjectId.make("core-project-during-plugin-fault");
      const commandId = CommandId.make("core-project-during-plugin-fault");
      const stamp = "2026-10-23T12:00:00.000Z";
      const command = {
        commandId,
        projectId,
        commandType: "project.create",
        acceptedAt: DateTime.makeUnsafe(stamp),
        event: {
          eventId: EventId.make("core-project-during-plugin-fault"),
          aggregateKind: "project" as const,
          aggregateId: projectId,
          occurredAt: stamp,
          commandId,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created" as const,
          payload: {
            projectId,
            title: "Core remains writable",
            workspaceRoot: "/fixture/core",
            defaultModelSelection: null,
            scripts: [],
            createdAt: stamp,
            updatedAt: stamp,
          },
        },
      };
      const first = yield* core.commitProjectCommand(command);
      expect(first.committed).toBe(true);
      const replay = yield* core.commitProjectCommand(command);
      expect(replay.committed).toBe(false);
      expect(replay.receipt).toEqual(first.receipt);
      const sql = yield* SqlClient.SqlClient;
      expect(
        yield* sql`SELECT title FROM projection_projects WHERE project_id=${projectId}`,
      ).toEqual([{ title: "Core remains writable" }]);
      expect(
        yield* sql`SELECT status FROM orchestration_command_receipts WHERE command_id=${commandId}`,
      ).toEqual([{ status: "accepted" }]);
      expect((yield* store.read.pipe(Effect.flip)).operation).toBe("read");
      expect(yield* fs.readFile(artifact)).toEqual(before);
    }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
it.effect("catalogue and KV writes do not take the core writer lock", () =>
  Effect.gen(function* () {
    const core = yield* SqlClient.SqlClient;
    yield* core`CREATE TABLE fixture_lock(value TEXT)`;
    const store = yield* buildStore;
    yield* store.read;
    yield* core.withTransaction(
      Effect.gen(function* () {
        yield* core`INSERT INTO fixture_lock VALUES('core-only')`;
        yield* store.update((state) =>
          Effect.succeed([undefined, { ...state, installations: [valid] }] as const),
        );
      }),
    );
    expect((yield* store.read).installations[0]?.storage).toEqual(valid.storage);
    expect(yield* core`SELECT * FROM fixture_lock`).toEqual([{ value: "core-only" }]);
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

it.effect("tryUpdate never queues a commit behind a catalogue owner", () =>
  Effect.gen(function* () {
    const store = yield* buildStore;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const owner = yield* store
      .update((state) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as([undefined, state] as const),
        ),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    let mutations = 0;
    const write = (state: Store.PluginState) =>
      Effect.sync(() => {
        mutations++;
        return ["saved", { ...state, installations: [valid] }] as const;
      });
    expect(yield* store.tryUpdate(write)).toEqual(Option.none());
    expect(mutations).toBe(0);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(owner);
    expect(yield* store.tryUpdate(write)).toEqual(Option.some("saved"));
    expect(mutations).toBe(1);
    expect((yield* store.read).installations).toEqual([valid]);
  }).pipe(Effect.provide(testLayer()), Effect.scoped),
);
