import {
  PluginError,
  pluginRequestedCapabilities,
  PluginInstallation,
  PluginManifest,
  PluginSettingValue,
  PluginSource,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as PluginDatabase from "./PluginDatabase.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const activeSource = Schema.Literals(["upstream", "local-repair"]);
const settings = Schema.Record(Schema.String, PluginSettingValue);
const secrets = Schema.Record(Schema.String, Schema.String);
const StoredInstallation = Schema.Struct({
  formatVersion: Schema.optionalKey(Schema.Number),
  installation: PluginInstallation,
  removed: Schema.optionalKey(Schema.Boolean),
  directory: Schema.String,
  pendingDirectory: Schema.optionalKey(Schema.String),
  deliveryError: Schema.optionalKey(Schema.NullOr(Schema.String)),
  rawRecord: Schema.optionalKey(Schema.Unknown),
  rawRecordJson: Schema.optionalKey(Schema.String),
  recordIssue: Schema.optionalKey(Schema.Literals(["newer", "corrupt"])),
  sourceRequest: Schema.optionalKey(PluginSource),
  // Reinstallation from the same source retains the private directory identity.
  dataKey: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)),
  ),
  activeSource: Schema.optionalKey(activeSource),
  previous: Schema.optionalKey(
    Schema.Struct({
      directory: Schema.String,
      manifest: PluginManifest,
      source: PluginSource,
      digest: Schema.String,
      sourceRequest: Schema.optionalKey(PluginSource),
      settings,
      secrets,
      activeSource: Schema.optionalKey(activeSource),
    }),
  ),
  repair: Schema.optionalKey(
    Schema.Struct({
      workspaceId: Schema.String,
      directory: Schema.String,
      baseDigest: Schema.String,
      baseGeneration: Schema.String,
      draft: Schema.String,
    }),
  ),
  pendingKind: Schema.optionalKey(Schema.Literals(["upstream", "local-repair", "previous"])),
  pendingSourceRequest: Schema.optionalKey(PluginSource),
  pendingSettings: Schema.optionalKey(settings),
  pendingSecrets: Schema.optionalKey(secrets),
  projectGrantStarts: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  eventBacklogChoiceRequired: Schema.optionalKey(Schema.Boolean),
  secrets,
  storage: Schema.Record(Schema.String, Schema.Unknown),
  eventCursor: Schema.Number,
});
export type StoredInstallation = typeof StoredInstallation.Type;
export interface PluginState {
  readonly version: 1;
  readonly installations: ReadonlyArray<StoredInstallation>;
  // Kept in memory for old callers; SQL receipts are the only authoritative ledger.
  readonly receipts: Readonly<Record<string, unknown>>;
  readonly origins: Readonly<Record<string, string>>;
}
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const SecretBundle = Schema.Struct({
  secrets,
  previousSecrets: Schema.optionalKey(secrets),
  pendingSecrets: Schema.optionalKey(secrets),
});
const decodeSecretBundle = Schema.decodeUnknownEffect(Schema.fromJsonString(SecretBundle));
const secretReference = Schema.String.check(Schema.isPattern(/^plugin-settings-[a-f0-9-]{36}$/));
const readSecretReference = Schema.decodeUnknownOption(secretReference);
const decodeRecord = Schema.decodeUnknownEffect(StoredInstallation);
const decodeDisplayId = Schema.decodeUnknownOption(PluginManifest.fields.id);
const decodeDisplayName = Schema.decodeUnknownOption(PluginManifest.fields.name);
const decodeDisplayVersion = Schema.decodeUnknownOption(PluginManifest.fields.version);

export function assertMutablePluginRecord(record: StoredInstallation) {
  if (record.recordIssue !== undefined || record.rawRecord !== undefined)
    return new PluginError({
      reason: "incompatible",
      code: record.recordIssue === "newer" ? "newer_record" : "unreadable_record",
      message:
        record.recordIssue === "newer"
          ? "This plugin was saved by a newer T3 version. Update T3 to manage it; its data has been preserved."
          : "This plugin record cannot be read. Its original data has been preserved for recovery.",
    });
  return undefined;
}

const newerRecord = (raw: unknown) =>
  Predicate.isObject(raw) &&
  ((typeof raw.formatVersion === "number" && raw.formatVersion > 2) ||
    (Predicate.isObject(raw.installation) &&
      Predicate.isObject(raw.installation.manifest) &&
      typeof raw.installation.manifest.apiVersion === "number" &&
      raw.installation.manifest.apiVersion > 1));
const isolateRecord = Effect.fn("PluginStore.decodeRecord")(function* (
  rawRecord: unknown,
  identity?: string,
  rawRecordJson?: string,
) {
  const unsupported = newerRecord(rawRecord);
  const decoded = unsupported ? undefined : yield* decodeRecord(rawRecord).pipe(Effect.option);
  if (decoded?._tag === "Some" && decoded.value.rawRecord === undefined) return decoded.value;
  const crypto = yield* Crypto.Crypto;
  const hash = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(rawRecordJson ?? (yield* encodeJson(rawRecord))))
    .pipe(Effect.map(Hex.encode));
  const storedId =
    Predicate.isObject(rawRecord) && Predicate.isObject(rawRecord.installation)
      ? rawRecord.installation.installationId
      : undefined;
  const installationId =
    identity ??
    (typeof storedId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(storedId)
      ? storedId
      : `corrupt-record-${hash}`);
  // Display hints never participate in execution or replace the opaque saved record.
  const manifest =
    Predicate.isObject(rawRecord) &&
    Predicate.isObject(rawRecord.installation) &&
    Predicate.isObject(rawRecord.installation.manifest)
      ? rawRecord.installation.manifest
      : {};
  const displayId = decodeDisplayId(manifest.id);
  const displayName = decodeDisplayName(manifest.name);
  const displayVersion = decodeDisplayVersion(manifest.version);
  return {
    installation: {
      installationId,
      generation: "incompatible",
      manifest: {
        id: Option.getOrElse(displayId, () => "invalid.plugin"),
        name: Option.getOrElse(displayName, () => "Unavailable plugin record"),
        version: Option.getOrElse(displayVersion, () => "0.0.0"),
        apiVersion: 1,
        entry: "unavailable.mjs",
        capabilities: ["unsupported-record"],
        actions: [],
        views: [],
        settings: [],
      },
      source: { kind: "local", directory: "" },
      digest: "0".repeat(64),
      enabled: false,
      consentedDigest: null,
      status: "incompatible",
      error: unsupported
        ? "Saved by a newer T3 version. Update T3 to use this plugin; its data has been preserved."
        : "This plugin record could not be read. Its original data has been preserved for recovery.",
      recordIssue: unsupported ? "newer" : "corrupt",
      settings: {},
      grants: { capabilities: [], projectIds: [] },
      updatedAt: "1970-01-01T00:00:00.000Z",
    },
    directory: "",
    secrets: {},
    storage:
      Predicate.isObject(rawRecord) && Predicate.isObject(rawRecord.storage)
        ? rawRecord.storage
        : {},
    eventCursor:
      Predicate.isObject(rawRecord) && typeof rawRecord.eventCursor === "number"
        ? rawRecord.eventCursor
        : 0,
    rawRecord,
    ...(rawRecordJson === undefined ? {} : { rawRecordJson }),
    ...(Predicate.isObject(rawRecord) && rawRecord.removed === true ? { removed: true } : {}),
    recordIssue: unsupported ? "newer" : "corrupt",
  } satisfies StoredInstallation;
});

// Dev seeding replaces core sequence numbers. Observers must explicitly resume from the new history.
export const pausePluginObserversAfterReseed = Effect.fn("PluginStore.pauseObserversAfterReseed")(
  function* (throughSequence: number) {
    const sql = yield* SqlClient.SqlClient;
    const tables =
      yield* sql`SELECT name FROM sqlite_schema WHERE type='table' AND name='plugin_records'`;
    if (tables.length === 0) return;
    const rows = yield* sql<{
      installation_id: string;
      record_json: string;
      event_cursor: number;
    }>`SELECT installation_id,record_json,event_cursor FROM plugin_records`;
    for (const row of rows) {
      const decoded = yield* decodeJson(row.record_json).pipe(Effect.option);
      if (
        decoded._tag === "None" ||
        !Predicate.isObject(decoded.value) ||
        newerRecord(decoded.value)
      )
        continue;
      const raw = decoded.value;
      const parsed = yield* decodeRecord({
        ...raw,
        storage: {},
        eventCursor: row.event_cursor,
      }).pipe(Effect.option);
      if (
        parsed._tag === "None" ||
        assertMutablePluginRecord(parsed.value) ||
        !pluginRequestedCapabilities(parsed.value.installation.manifest).includes(
          "events.run-finalized",
        )
      )
        continue;
      const json = yield* encodeJson({
        ...raw,
        eventBacklogChoiceRequired: true,
        projectGrantStarts: Object.fromEntries(
          parsed.value.installation.grants.projectIds.map((projectId) => [
            projectId,
            throughSequence,
          ]),
        ),
      });
      yield* sql`UPDATE plugin_records SET record_json=${json},event_cursor=${throughSequence} WHERE installation_id=${row.installation_id}`;
    }
  },
);

export class PluginStoreError extends Schema.TaggedError<PluginStoreError>()("PluginStoreError", {
  operation: Schema.Literals(["read", "write"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    return "The plugin catalogue could not be persisted or read.";
  }
}
const isPluginStoreError = Schema.is(PluginStoreError);

export class PluginStore extends Context.Service<
  PluginStore,
  {
    readonly directory: string;
    readonly read: Effect.Effect<PluginState, PluginStoreError>;
    readonly isCurrent: (state: PluginState) => boolean;
    readonly update: <A, E, R>(
      f: (state: PluginState) => Effect.Effect<readonly [A, PluginState], E, R>,
    ) => Effect.Effect<A, E | PluginStoreError, R>;
    readonly tryUpdate: <A, E, R>(
      f: (state: PluginState) => Effect.Effect<readonly [A, PluginState], E, R>,
    ) => Effect.Effect<Option.Option<A>, E | PluginStoreError, R>;
    readonly changes: Stream.Stream<void>;
    readonly subscribeChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  }
>()("t3/plugins/PluginStore") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const database = yield* PluginDatabase.PluginDatabase;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<void>(1);
  const directory = path.join(config.stateDir, "plugins");
  let references = new Map<string, string>();
  let cached: PluginState | undefined;
  const empty: PluginState = { version: 1, installations: [], receipts: {}, origins: {} };
  const recordMetadata = ({
    storage: _storage,
    eventCursor: _cursor,
    rawRecordJson: _rawJson,
    recordIssue: _issue,
    ...record
  }: StoredInstallation) => ({ ...record, formatVersion: 1 });
  const bundleFor = (record: StoredInstallation) => ({
    secrets: record.secrets,
    ...(record.previous === undefined ? {} : { previousSecrets: record.previous.secrets }),
    ...(record.pendingSecrets === undefined ? {} : { pendingSecrets: record.pendingSecrets }),
  });
  const protectRecord = Effect.fn("PluginStore.protectRecord")(function* (
    record: StoredInstallation,
    written: Set<string>,
    old?: StoredInstallation,
  ) {
    const bundle = bundleFor(record);
    const hasSecrets = Object.values(bundle).some((values) => Object.keys(values).length > 0);
    let secretRef: string | undefined;
    if (hasSecrets) {
      const json = yield* encodeJson(bundle);
      const oldReference = references.get(record.installation.installationId);
      if (
        old !== undefined &&
        oldReference !== undefined &&
        json === (yield* encodeJson(bundleFor(old)))
      ) {
        secretRef = oldReference;
      } else {
        secretRef = `plugin-settings-${yield* crypto.randomUUIDv4()}`;
        // Immutable references keep a failed catalogue transaction on its previous secret revision.
        yield* secretStore.create(secretRef, new TextEncoder().encode(json));
        written.add(secretRef);
      }
    }
    return {
      ...recordMetadata(record),
      secrets: {},
      ...(record.previous === undefined ? {} : { previous: { ...record.previous, secrets: {} } }),
      ...(record.pendingSecrets === undefined ? {} : { pendingSecrets: {} }),
      ...(secretRef === undefined ? {} : { secretRef, formatVersion: 2 }),
    };
  });
  const discardReferences = (names: Iterable<string>) =>
    Effect.forEach(names, (name) => secretStore.remove(name).pipe(Effect.ignore), {
      discard: true,
    });
  const persist = Effect.fn("PluginStore.persist")(function* (
    sql: SqlClient.SqlClient,
    current: PluginState,
    state: PluginState,
    written: Set<string>,
  ) {
    const nextReferences = new Map(references);
    const previous = new Map(
      current.installations.map((record) => [record.installation.installationId, record]),
    );
    const next = new Map(
      state.installations.map((record) => [record.installation.installationId, record]),
    );
    for (const record of current.installations) {
      if (
        assertMutablePluginRecord(record) &&
        next.get(record.installation.installationId) !== record
      )
        return yield* new PluginStoreError({
          operation: "write",
          cause: "read-only-plugin-record",
        });
      if (!next.has(record.installation.installationId)) {
        yield* sql`DELETE FROM plugin_records WHERE installation_id=${record.installation.installationId}`;
        nextReferences.delete(record.installation.installationId);
      }
    }
    for (const [position, record] of state.installations.entries()) {
      const installationId = record.installation.installationId;
      const old = previous.get(installationId);
      if (record !== old) {
        const fields = recordMetadata(record);
        const previousFields: Readonly<Record<string, unknown>> =
          old === undefined ? {} : recordMetadata(old);
        const metadataChanged =
          old === undefined ||
          Object.keys(fields).length !== Object.keys(previousFields).length ||
          Object.entries(fields).some(([key, value]) => value !== previousFields[key]);
        if (metadataChanged) {
          const protectedFields = assertMutablePluginRecord(record)
            ? undefined
            : yield* protectRecord(record, written, old);
          const json =
            record.rawRecordJson ?? (yield* encodeJson(record.rawRecord ?? protectedFields));
          if (protectedFields?.secretRef === undefined) nextReferences.delete(installationId);
          else nextReferences.set(installationId, protectedFields.secretRef);
          yield* sql`INSERT INTO plugin_records(installation_id,position,record_json,event_cursor) VALUES(${installationId},${position},${json},${record.eventCursor})
            ON CONFLICT(installation_id) DO UPDATE SET position=excluded.position,record_json=excluded.record_json,event_cursor=excluded.event_cursor`;
        } else if (old && old.eventCursor !== record.eventCursor)
          yield* sql`UPDATE plugin_records SET event_cursor=${record.eventCursor} WHERE installation_id=${installationId}`;
        if (old?.storage !== record.storage) {
          for (const key of Object.keys(old?.storage ?? {})) {
            if (!Object.hasOwn(record.storage, key))
              yield* sql`DELETE FROM plugin_storage WHERE installation_id=${installationId} AND key=${key}`;
          }
          for (const [key, value] of Object.entries(record.storage)) {
            if (old && Object.hasOwn(old.storage, key) && old.storage[key] === value) continue;
            const json = yield* encodeJson(value);
            if (
              old &&
              Object.hasOwn(old.storage, key) &&
              (yield* encodeJson(old.storage[key])) === json
            )
              continue;
            yield* sql`INSERT INTO plugin_storage VALUES(${installationId},${key},${json}) ON CONFLICT(installation_id,key) DO UPDATE SET value_json=excluded.value_json`;
          }
        }
      }
      if (old && current.installations[position] !== old)
        yield* sql`UPDATE plugin_records SET position=${position} WHERE installation_id=${installationId}`;
    }
    if (current === empty)
      yield* sql`INSERT INTO plugin_state_metadata VALUES(1,'{}') ON CONFLICT DO NOTHING`;
    return nextReferences;
  });
  const readUnsafe = Effect.gen(function* () {
    if (cached !== undefined) return cached;
    const sql = yield* database.client;
    const loadedReferences = new Map<string, string>();
    const written = new Set<string>();
    const state = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const marker = yield* sql`SELECT id FROM plugin_state_metadata WHERE id=1`;
          if (marker.length === 0) yield* sql`INSERT INTO plugin_state_metadata VALUES(1,'{}')`;
          const rows = yield* sql<{
            installation_id: string;
            record_json: string;
            event_cursor: number;
          }>`SELECT installation_id,record_json,event_cursor FROM plugin_records ORDER BY position,installation_id`;
          const values = yield* sql<{
            installation_id: string;
            key: string;
            value_json: string;
          }>`SELECT * FROM plugin_storage`;
          const storage = new Map<string, Record<string, unknown>>();
          const corruptStorage = new Set<string>();
          for (const value of values) {
            const decoded = yield* decodeJson(value.value_json).pipe(Effect.option);
            if (decoded._tag === "None") {
              corruptStorage.add(value.installation_id);
              continue;
            }
            let entries = storage.get(value.installation_id);
            if (!entries) {
              entries = {};
              storage.set(value.installation_id, entries);
            }
            Object.defineProperty(entries, value.key, {
              value: decoded.value,
              enumerable: true,
              configurable: true,
              writable: true,
            });
          }
          const installations = yield* Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              const parsed = yield* decodeJson(row.record_json).pipe(Effect.option);
              let raw = parsed._tag === "Some" ? parsed.value : row.record_json;
              const reference = readSecretReference(
                Predicate.isObject(raw) ? raw.secretRef : undefined,
              );
              if (reference._tag === "Some") {
                loadedReferences.set(row.installation_id, reference.value);
                if (Predicate.isObject(raw) && !newerRecord(raw)) {
                  const bundle = yield* secretStore.get(reference.value).pipe(
                    Effect.flatMap(Effect.fromOption),
                    Effect.flatMap((bytes) => decodeSecretBundle(new TextDecoder().decode(bytes))),
                    Effect.option,
                  );
                  if (bundle._tag === "None")
                    return yield* isolateRecord(
                      { unreadableSecrets: true },
                      row.installation_id,
                      row.record_json,
                    );
                  raw = {
                    ...raw,
                    secrets: bundle.value.secrets,
                    ...(Predicate.isObject(raw.previous)
                      ? {
                          previous: {
                            ...raw.previous,
                            secrets: bundle.value.previousSecrets ?? {},
                          },
                        }
                      : {}),
                    ...(bundle.value.pendingSecrets === undefined
                      ? {}
                      : { pendingSecrets: bundle.value.pendingSecrets }),
                  };
                }
              }
              const invalidReference =
                Predicate.isObject(raw) && raw.secretRef !== undefined && reference._tag === "None";
              const input =
                Predicate.isObject(raw) &&
                !invalidReference &&
                !corruptStorage.has(row.installation_id)
                  ? {
                      ...raw,
                      storage: storage.get(row.installation_id) ?? {},
                      eventCursor: row.event_cursor,
                    }
                  : raw;
              const record = yield* isolateRecord(input, row.installation_id, row.record_json);
              if (
                (invalidReference || corruptStorage.has(row.installation_id)) &&
                !record.recordIssue
              )
                return yield* isolateRecord(
                  { unreadableStorage: true },
                  row.installation_id,
                  row.record_json,
                );
              if (!assertMutablePluginRecord(record) && reference._tag === "None") {
                const fields = yield* protectRecord(record, written);
                if (fields.secretRef !== undefined) {
                  yield* sql`UPDATE plugin_records SET record_json=${yield* encodeJson(fields)} WHERE installation_id=${row.installation_id}`;
                  loadedReferences.set(row.installation_id, fields.secretRef);
                }
              }
              return record.installation.installationId === row.installation_id
                ? record
                : {
                    ...record,
                    installation: { ...record.installation, installationId: row.installation_id },
                  };
            }),
          );
          return { ...empty, installations };
        }),
      )
      .pipe(Effect.onError(() => discardReferences(written)));
    references = loadedReferences;
    cached = state;
    return state;
  }).pipe(
    Effect.provideService(Crypto.Crypto, crypto),
    Effect.mapError((cause) => new PluginStoreError({ operation: "read", cause })),
  );
  const commit = Effect.fn("PluginStore.commit")(function* <A, E, R>(
    f: (state: PluginState) => Effect.Effect<readonly [A, PluginState], E, R>,
  ): Effect.fn.Return<A, E | PluginStoreError, R> {
    const current = yield* readUnsafe;
    const [value, state] = yield* f(current);
    if (state === current) return value;
    const sql = yield* database.client.pipe(
      Effect.mapError((cause) => new PluginStoreError({ operation: "write", cause })),
    );
    const written = new Set<string>();
    const nextReferences = yield* sql.withTransaction(persist(sql, current, state, written)).pipe(
      Effect.onError(() => discardReferences(written)),
      Effect.mapError((cause) =>
        isPluginStoreError(cause) ? cause : new PluginStoreError({ operation: "write", cause }),
      ),
    );
    const retained = new Set(nextReferences.values());
    const obsolete = new Set([...references.values()].filter((name) => !retained.has(name)));
    references = nextReferences;
    cached = state;
    yield* discardReferences(obsolete);
    if (
      current.installations.length !== state.installations.length ||
      state.installations.some((record, index) => {
        const previous = current.installations[index];
        return (
          record.installation !== previous?.installation ||
          record.removed !== previous?.removed ||
          record.deliveryError !== previous?.deliveryError ||
          record.eventBacklogChoiceRequired !== previous?.eventBacklogChoiceRequired ||
          record.repair !== previous?.repair ||
          record.previous !== previous?.previous ||
          record.activeSource !== previous?.activeSource ||
          record.sourceRequest !== previous?.sourceRequest
        );
      })
    )
      yield* PubSub.publish(changes, undefined);
    return value;
  });
  const update: PluginStore["Service"]["update"] = Effect.fn("PluginStore.update")(
    commit,
    lock.withPermits(1),
    Effect.uninterruptible,
  );
  const tryUpdate: PluginStore["Service"]["tryUpdate"] = Effect.fn("PluginStore.tryUpdate")(
    commit,
    lock.withPermitsIfAvailable(1),
    Effect.uninterruptible,
  );
  return PluginStore.of({
    directory,
    read: lock.withPermits(1)(readUnsafe),
    isCurrent: (state) => cached === state,
    update,
    tryUpdate,
    changes: Stream.fromPubSub(changes),
    subscribeChanges: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
  });
});
export const layer = Layer.effect(PluginStore, make).pipe(Layer.provide(ServerSecretStore.layer));
