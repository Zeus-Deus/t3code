import {
  AuthOrchestrationOperateScope,
  MAX_PLUGIN_RESULT_IMAGE_BYTES,
  pluginCompatibility,
  pluginRequestedCapabilities,
  PluginCatalogue,
  PluginError,
  PluginFailureReason,
  PluginInvokeInput,
  PluginInvokeResult,
  PluginThreadStatus,
  type PluginEventBacklogPolicy,
  type PluginEventBacklog,
  type PluginRepairWorkspace,
  type PluginCaller,
  type PluginGrants,
  type PluginInstallation,
  type PluginSettingValue,
  type PluginSource,
  type PluginViewInput,
  type PluginViewResult,
  type PluginRunFinalizedEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ProcessRunner from "../processRunner.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { PluginExecutionPolicy, assertPluginExecutionAllowed } from "./PluginExecutionPolicy.ts";
import { preparePluginRepair } from "./PluginRepair.ts";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import * as PluginStore from "./PluginStore.ts";
import * as PluginReceipts from "./PluginReceipts.ts";
import * as PluginHost from "./PluginHost.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";
import * as PluginGitSource from "./PluginGitSource.ts";
import type { PluginWorkerImage } from "./pluginIpc.ts";
import { safePluginPath, snapshotPluginSource, verifyPluginSnapshot } from "./pluginSource.ts";
import {
  assertPluginActive,
  pluginCapabilityAllowed,
  pluginPermissionDenied,
  type PluginActor,
} from "./PluginAuthority.ts";

const isPluginError = Schema.is(PluginError);
const isFailureReason = Schema.is(PluginFailureReason);
const isInvokeHandler = Schema.is(PluginInvokeInput.fields.handler);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(PluginInvokeResult));
const decodeInvoke = Schema.decodeUnknownEffect(PluginInvokeInput);
const decodeResult = Schema.decodeUnknownEffect(PluginInvokeResult);
const decodeThreadStatus = Schema.decodeUnknownEffect(Schema.NullOr(PluginThreadStatus));
const encodeCatalogue = Schema.encodeSync(Schema.fromJsonString(PluginCatalogue));
const failure = () =>
  new PluginError({
    reason: "storage_failed",
    message: "The plugin catalogue could not be read or saved.",
  });
const notFound = () =>
  new PluginError({ reason: "not_found", message: "The plugin installation was not found." });
const compatible = (installation: PluginInstallation) =>
  pluginCompatibility(installation.manifest).available;
const sourceIdentity = (source: PluginSource) => {
  if (source.kind === "local") return `local:${source.directory}`;
  if (!URL.canParse(source.url)) return `invalid:${source.url}`;
  const url = new URL(source.url);
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return `git:${url.href}`;
};
const MAX_PLUGIN_RESULT_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024;
const imageSignatures = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff],
} as const;
const invalidImage = () =>
  new PluginError({
    reason: "invalid_result",
    message: "The plugin returned an image the host could not read from its data directory.",
  });
// Only an agent's MCP credential binds it to a thread; a client session never names one.
const callerFor = (actor: PluginActor): PluginCaller =>
  actor.source === "agent" && actor.threadId !== undefined
    ? { kind: "agent", threadId: actor.threadId }
    : { kind: actor.source };
const dataKeyFor = (record: PluginStore.StoredInstallation) =>
  record.dataKey ?? record.installation.installationId;
const recordFor = (state: PluginStore.PluginState, id: string) =>
  state.installations.find(
    (record) => !record.removed && record.installation.installationId === id,
  );

export class PluginService extends Context.Service<
  PluginService,
  {
    readonly prepareRepair: (input: {
      readonly installationId: string;
    }) => Effect.Effect<PluginRepairWorkspace, PluginError>;
    readonly stageRepair: (input: {
      readonly installationId: string;
      readonly workspaceId: string;
      readonly baseDigest: string;
    }) => Effect.Effect<PluginInstallation, PluginError>;
    readonly usePrevious: (input: {
      readonly installationId: string;
      readonly expectedDigest: string;
      readonly acknowledgeCurrentData: true;
    }) => Effect.Effect<PluginInstallation, PluginError>;
    readonly backlog: (input: {
      readonly installationId: string;
    }) => Effect.Effect<PluginEventBacklog, PluginError>;
    readonly list: () => Effect.Effect<PluginCatalogue, PluginError>;
    readonly subscribe: Stream.Stream<PluginCatalogue, PluginError>;
    readonly install: (input: {
      readonly source: PluginSource;
    }) => Effect.Effect<PluginInstallation, PluginError>;
    readonly refresh: (input: {
      readonly installationId: string;
    }) => Effect.Effect<PluginInstallation, PluginError>;
    readonly discardPendingUpdate: (input: {
      readonly installationId: string;
    }) => Effect.Effect<PluginInstallation, PluginError>;
    readonly consent: (input: {
      readonly installationId: string;
      readonly digest: string;
      readonly grants: PluginGrants;
      readonly eventBacklog?: PluginEventBacklogPolicy;
    }) => Effect.Effect<PluginInstallation, PluginError>;
    readonly setEnabled: (input: {
      readonly installationId: string;
      readonly enabled: boolean;
      readonly eventBacklog?: PluginEventBacklogPolicy;
    }) => Effect.Effect<PluginInstallation, PluginError>;
    readonly resume: (input: {
      readonly installationId: string;
      readonly eventBacklog?: PluginEventBacklogPolicy;
    }) => Effect.Effect<PluginInstallation, PluginError>;
    readonly remove: (input: {
      readonly installationId: string;
      readonly deleteData?: boolean;
    }) => Effect.Effect<void, PluginError>;
    readonly updateSettings: (input: {
      readonly installationId: string;
      readonly values: Readonly<Record<string, PluginSettingValue>>;
    }) => Effect.Effect<PluginInstallation, PluginError>;
    readonly invoke: (
      input: PluginInvokeInput,
      actor: PluginActor,
    ) => Effect.Effect<PluginInvokeResult, PluginError>;
    readonly readView: (input: PluginViewInput) => Effect.Effect<PluginViewResult, PluginError>;
    readonly deliver: (input: {
      readonly installationId: string;
      readonly generation: string;
      readonly event: PluginRunFinalizedEvent;
      readonly sequence: number;
    }) => Effect.Effect<void, PluginError>;
  }
>()("t3/plugins/PluginService") {}

const make = Effect.gen(function* () {
  const store = yield* PluginStore.PluginStore;
  const policy = yield* PluginExecutionPolicy;
  const runner = yield* ProcessRunner.ProcessRunner;
  const threads = yield* Threads.ThreadManagementService;
  const applicationEvents = yield* ApplicationEvents.OrchestrationEventStore;
  const receipts = yield* PluginReceipts.PluginReceipts;
  const host = yield* PluginHost.PluginHost;
  const supervisor = yield* PluginSupervisor.PluginSupervisor;
  const git = yield* PluginGitSource.PluginGitSource;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const lifecycleLocks = new Map<string, Semaphore.Semaphore>();
  const deliveryLocks = new Map<string, Semaphore.Semaphore>();
  const locked =
    (locks: Map<string, Semaphore.Semaphore>) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>, input: { readonly installationId: string }) => {
      let lock = locks.get(input.installationId);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(input.installationId, lock);
      }
      return lock.withPermits(1)(effect);
    };
  const lifecycle = locked(lifecycleLocks);
  const deliveryLock = locked(deliveryLocks);
  const runtimeTransitions = new Set<string>();
  const transition = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    input: { readonly installationId: string },
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => runtimeTransitions.add(input.installationId)),
      () => effect,
      () => Effect.sync(() => runtimeTransitions.delete(input.installationId)),
    );
  const assertNotTransitioning = (installationId: string) =>
    runtimeTransitions.has(installationId)
      ? new PluginError({
          reason: "busy",
          message:
            "This plugin is switching revisions or stopping. Try again after the transition finishes.",
        })
      : undefined;
  const verifiedSnapshots = new Set<string>();
  const id = crypto.randomUUIDv4().pipe(Effect.mapError(failure));
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const read = store.read.pipe(Effect.mapError(failure));
  const get = Effect.fn("PluginService.get")(function* (installationId: string) {
    const record = recordFor(yield* read, installationId);
    if (!record) return yield* notFound();
    return record;
  });
  const mutable = Effect.fn("PluginService.mutable")(function* (installationId: string) {
    const record = yield* get(installationId);
    const denied = PluginStore.assertMutablePluginRecord(record);
    if (denied) return yield* denied;
    return record;
  });
  const update = Effect.fn("PluginService.update")(function* (
    installationId: string,
    f: (record: PluginStore.StoredInstallation) => PluginStore.StoredInstallation,
  ) {
    let previousGeneration: string | undefined;
    let nextGeneration: string | undefined;
    const result = yield* store
      .update((state) => {
        const current = recordFor(state, installationId);
        if (!current) return Effect.fail(notFound());
        const denied = PluginStore.assertMutablePluginRecord(current);
        if (denied) return Effect.fail(denied);
        const next = f(current);
        if (next === current) return Effect.succeed([present(current), state] as const);
        previousGeneration = current.installation.generation;
        nextGeneration = next.removed ? undefined : next.installation.generation;
        return Effect.succeed([
          present(next),
          {
            ...state,
            installations: state.installations.map((record) =>
              record === current ? next : record,
            ),
          },
        ] as const);
      })
      .pipe(Effect.mapError((error) => (isPluginError(error) ? error : failure())));
    if (previousGeneration !== nextGeneration) {
      verifiedSnapshots.delete(`${installationId}:${previousGeneration}`);
    }
    return result;
  });
  // Snapshot references belong to this store, including legacy absolute references.
  const snapshotDirectory = Effect.fn("PluginService.snapshotDirectory")(function* (
    installationId: string,
    storedDirectory = path.join("snapshots", installationId),
  ) {
    const root = path.resolve(store.directory, "snapshots", installationId);
    const directory = path.resolve(store.directory, storedDirectory);
    const within = (parent: string, target: string) =>
      target === parent || target.startsWith(`${parent}${path.sep}`);
    const invalid = () =>
      new PluginError({
        reason: "changed_source",
        message: "The plugin snapshot does not belong to this T3 home. Refresh its source.",
      });
    if (!within(root, directory)) return yield* invalid();
    if (yield* fs.exists(directory).pipe(Effect.mapError(failure))) {
      const realStore = yield* fs.realPath(store.directory).pipe(Effect.mapError(failure));
      const realDirectory = yield* fs.realPath(directory).pipe(Effect.mapError(failure));
      if (!within(path.join(realStore, "snapshots", installationId), realDirectory))
        return yield* invalid();
    }
    return directory;
  });
  const removeSnapshot = Effect.fn("PluginService.removeSnapshot")(function* (
    installationId: string,
    directory?: string,
  ) {
    const owned = yield* snapshotDirectory(installationId, directory);
    yield* fs.remove(owned, { recursive: true, force: true }).pipe(Effect.mapError(failure));
  });
  const releaseObsoleteSnapshots = Effect.fn("PluginService.releaseObsoleteSnapshots")(function* (
    before: PluginStore.StoredInstallation,
  ) {
    const installationId = before.installation.installationId;
    const current = yield* get(installationId);
    const retained = [current.directory, current.pendingDirectory, current.previous?.directory]
      .filter((directory) => directory !== undefined)
      .map((directory) => path.resolve(store.directory, directory));
    for (const directory of new Set([
      before.directory,
      before.pendingDirectory,
      before.previous?.directory,
    ])) {
      if (directory === undefined) continue;
      const candidate = path.resolve(store.directory, directory);
      if (retained.some((keep) => keep === candidate || keep.startsWith(`${candidate}${path.sep}`)))
        continue;
      yield* removeSnapshot(installationId, directory).pipe(Effect.ignore);
    }
  });
  const dataRoot = path.join(store.directory, "data");
  const dataDirectory = Effect.fn("PluginService.dataDirectory")(function* (
    record: PluginStore.StoredInstallation,
  ) {
    const directory = path.join(dataRoot, dataKeyFor(record));
    yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(failure));
    yield* fs.chmod(dataRoot, 0o700).pipe(Effect.mapError(failure));
    yield* fs.chmod(directory, 0o700).pipe(Effect.mapError(failure));
    return directory;
  });
  const removeDataDirectory = (dataKey: string) =>
    fs
      .remove(path.join(dataRoot, dataKey), { recursive: true, force: true })
      .pipe(Effect.mapError(failure));
  const readResultImages = Effect.fn("PluginService.readResultImages")(function* (
    directory: string,
    images: ReadonlyArray<PluginWorkerImage>,
  ) {
    const realDirectory = yield* fs.realPath(directory).pipe(Effect.mapError(invalidImage));
    let total = 0;
    return yield* Effect.forEach(images, (image) =>
      Effect.gen(function* () {
        const target = path.resolve(realDirectory, image.path);
        if (!target.startsWith(`${realDirectory}${path.sep}`)) return yield* invalidImage();
        const real = yield* fs.realPath(target).pipe(Effect.mapError(invalidImage));
        if (!real.startsWith(`${realDirectory}${path.sep}`)) return yield* invalidImage();
        const info = yield* fs.stat(real).pipe(Effect.mapError(invalidImage));
        const size = Number(info.size);
        total += size;
        if (
          info.type !== "File" ||
          size > MAX_PLUGIN_RESULT_IMAGE_BYTES ||
          total > MAX_PLUGIN_RESULT_IMAGE_TOTAL_BYTES
        )
          return yield* invalidImage();
        const bytes = yield* fs.readFile(real).pipe(Effect.mapError(invalidImage));
        const signature = imageSignatures[image.mimeType];
        if (
          bytes.byteLength > MAX_PLUGIN_RESULT_IMAGE_BYTES ||
          signature.some((byte, index) => bytes[index] !== byte)
        )
          return yield* invalidImage();
        return { mimeType: image.mimeType, data: Buffer.from(bytes).toString("base64") };
      }),
    );
  });
  const verifySnapshot = Effect.fn("PluginService.verifySnapshot")(function* (
    record: PluginStore.StoredInstallation,
  ) {
    const key = `${record.installation.installationId}:${record.installation.generation}`;
    const directory = yield* snapshotDirectory(
      record.installation.installationId,
      record.directory,
    );
    if (verifiedSnapshots.has(key)) return directory;
    yield* verifyPluginSnapshot({
      directory,
      digest: record.installation.digest,
    }).pipe(
      Effect.tapError(() =>
        Effect.gen(function* () {
          const generation = yield* id;
          const timestamp = yield* now;
          yield* update(record.installation.installationId, (current) =>
            current.installation.generation === record.installation.generation
              ? {
                  ...current,
                  installation: {
                    ...current.installation,
                    generation,
                    status: "needs-consent",
                    error:
                      "Installed plugin bytes changed. Refresh the source and review consent again.",
                    updatedAt: timestamp,
                  },
                }
              : current,
          );
          yield* supervisor.stop(record.installation.installationId);
        }),
      ),
    );
    verifiedSnapshots.add(key);
    return directory;
  });
  const present = (record: PluginStore.StoredInstallation): PluginInstallation => {
    const installation = record.installation;
    const compatibility = pluginCompatibility(installation.manifest);
    const observerNeedsAttention =
      !policy.safeMode &&
      installation.enabled &&
      installation.grants.capabilities.includes("events.run-finalized") &&
      (record.eventBacklogChoiceRequired || record.deliveryError);
    const status = policy.safeMode
      ? "disabled"
      : !compatibility.available
        ? "incompatible"
        : installation.status === "incompatible"
          ? installation.consentedDigest !== installation.digest
            ? "needs-consent"
            : installation.enabled
              ? "idle"
              : "disabled"
          : installation.status === "running"
            ? "idle"
            : installation.status;
    const message =
      record.rawRecord !== undefined
        ? "This saved plugin record is read-only on this T3 version. Keep it and use a compatible T3 version."
        : !compatibility.available
          ? `Unsupported required capabilities: ${compatibility.missingCapabilities.join(", ")}`
          : observerNeedsAttention && record.eventBacklogChoiceRequired
            ? "Choose whether to skip or deliver pending events before resuming."
            : observerNeedsAttention
              ? record.deliveryError
              : installation.error;
    const kind =
      record.rawRecord !== undefined
        ? "read-only"
        : !compatibility.available
          ? "unavailable"
          : observerNeedsAttention
            ? "events-paused"
            : "fault";
    const { attention: _attention, recovery: _recovery, ...rest } = installation;
    return {
      ...rest,
      status,
      compatibility,
      observerError: record.deliveryError ?? null,
      ...(record.rawRecord !== undefined ? { recordIssue: record.recordIssue ?? "corrupt" } : {}),
      ...(message
        ? {
            attention: {
              kind,
              message,
              since: installation.health?.fault?.at ?? installation.updatedAt,
            },
          }
        : {}),
      recovery: {
        activeSource: record.activeSource ?? "upstream",
        ...(record.previous
          ? {
              previous: {
                version: record.previous.manifest.version,
                digest: record.previous.digest,
                source: record.previous.source,
              },
            }
          : {}),
        ...(record.repair ? { repair: record.repair } : {}),
        ...(record.sourceRequest ? { upstreamSource: record.sourceRequest } : {}),
      },
    };
  };
  const list = Effect.fn("PluginService.list")(function* () {
    return yield* read.pipe(
      Effect.map((state) => ({
        installations: state.installations.filter((record) => !record.removed).map(present),
        executionDisabled: policy.safeMode,
      })),
      Effect.catch(() =>
        Effect.succeed({
          installations: [],
          executionDisabled: policy.safeMode,
          unavailable: {
            message:
              "The plugin catalogue is unavailable. Core T3 remains usable; plugin files and data were retained.",
          },
        }),
      ),
    );
  });
  const stage = Effect.fn("PluginService.stage")(function* (
    source: PluginSource,
    installationId: string,
    generation: string,
  ) {
    yield* fs.makeDirectory(store.directory, { recursive: true }).pipe(Effect.mapError(failure));
    yield* fs.chmod(store.directory, 0o700).pipe(Effect.mapError(failure));
    const destinationDirectory = path.join(
      store.directory,
      "snapshots",
      installationId,
      generation,
    );
    if (source.kind === "local") {
      const directory = yield* fs.realPath(source.directory).pipe(
        Effect.mapError(
          () =>
            new PluginError({
              reason: "invalid_source",
              message: "The local plugin directory could not be resolved.",
            }),
        ),
      );
      const snapshot = yield* snapshotPluginSource({
        directory,
        destinationDirectory,
      });
      return { ...snapshot, source: { kind: "local" as const, directory } };
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const checkout = yield* git.checkout(source);
        return {
          ...(yield* snapshotPluginSource({ directory: checkout.directory, destinationDirectory })),
          source: checkout.source,
        };
      }),
    );
  });
  const install = Effect.fn("PluginService.install")(function* (input: {
    readonly source: PluginSource;
  }) {
    const installationId = yield* id;
    const generation = yield* id;
    const staged = yield* stage(input.source, installationId, generation);
    let retainSnapshot = false;
    yield* Effect.addFinalizer(() =>
      retainSnapshot
        ? Effect.void
        : fs.remove(staged.directory, { recursive: true, force: true }).pipe(Effect.ignore),
    );
    const timestamp = yield* now;
    const installation: PluginInstallation = {
      installationId,
      generation,
      manifest: staged.manifest,
      source: staged.source,
      digest: staged.digest,
      enabled: false,
      consentedDigest: null,
      status: "needs-consent",
      error: null,
      settings: Object.fromEntries(
        staged.manifest.settings
          .filter((s) => s.type !== "secret" && s.default !== undefined)
          .map((s) => [s.key, s.default!]),
      ),
      grants: { capabilities: [], projectIds: [] },
      updatedAt: timestamp,
    };
    const entry = {
      ...installation,
      status: compatible(installation) ? ("needs-consent" as const) : ("incompatible" as const),
    };
    const observationStart = yield* applicationEvents.latestApplicationSequence.pipe(
      Effect.mapError(failure),
    );
    const persisted = yield* store
      .update((state) => {
        const duplicate = state.installations.find(
          (record) => !record.removed && record.installation.manifest.id === staged.manifest.id,
        );
        if (duplicate)
          return Effect.fail(
            duplicate.rawRecord !== undefined || duplicate.recordIssue !== undefined
              ? new PluginError({
                  reason: "incompatible",
                  code: duplicate.recordIssue === "newer" ? "newer_record" : "unreadable_record",
                  message:
                    "This plugin already has a read-only saved installation. Use a compatible T3 version to manage it; its original data has been preserved.",
                })
              : new PluginError({
                  reason: "invalid_source",
                  message: "This plugin is already installed. Refresh its existing installation.",
                }),
          );
        const previous = state.installations.findLast(
          (record) =>
            record.removed &&
            record.rawRecord === undefined &&
            record.installation.manifest.id === staged.manifest.id &&
            sourceIdentity(record.sourceRequest ?? record.installation.source) ===
              sourceIdentity(staged.source),
        );
        const restored = {
          ...entry,
          settings: Object.fromEntries(
            staged.manifest.settings
              .filter((setting) => setting.type !== "secret")
              .flatMap((setting) => {
                const oldValue = previous?.installation.settings[setting.key];
                const value = typeof oldValue === setting.type ? oldValue : setting.default;
                return value === undefined ? [] : [[setting.key, value]];
              }),
          ),
        };
        return Effect.succeed([
          restored,
          {
            ...state,
            installations: [
              ...state.installations.filter(
                (record) =>
                  !(
                    record.removed &&
                    record.rawRecord === undefined &&
                    record.installation.manifest.id === staged.manifest.id &&
                    sourceIdentity(record.sourceRequest ?? record.installation.source) ===
                      sourceIdentity(staged.source)
                  ),
              ),
              {
                formatVersion: 1,
                installation: restored,
                directory: path.relative(store.directory, staged.directory),
                sourceRequest: input.source.kind === "local" ? staged.source : input.source,
                ...(previous === undefined ? {} : { dataKey: dataKeyFor(previous) }),
                secrets: Object.fromEntries(
                  Object.entries(previous?.secrets ?? {}).filter(([key]) =>
                    staged.manifest.settings.some(
                      (setting) => setting.key === key && setting.type === "secret",
                    ),
                  ),
                ),
                storage: previous?.storage ?? {},
                eventCursor: observationStart,
              },
            ],
          },
        ] as const);
      })
      .pipe(
        Effect.mapError((error) => (isPluginError(error) ? error : failure())),
        Effect.tap(() =>
          Effect.sync(() => {
            retainSnapshot = true;
          }),
        ),
        Effect.uninterruptible,
      );
    retainSnapshot = true;
    return persisted;
  }, Effect.scoped);
  const refresh = Effect.fn("PluginService.refresh")(function* (input: {
    readonly installationId: string;
  }) {
    const current = yield* mutable(input.installationId);
    const generation = yield* id;
    const staged = yield* stage(
      current.sourceRequest ?? current.installation.source,
      input.installationId,
      generation,
    );
    let retainSnapshot = false;
    yield* Effect.addFinalizer(() =>
      retainSnapshot
        ? Effect.void
        : fs.remove(staged.directory, { recursive: true, force: true }).pipe(Effect.ignore),
    );
    if (staged.manifest.id !== current.installation.manifest.id)
      return yield* new PluginError({
        reason: "invalid_manifest",
        message: "A refresh cannot change the plugin identity.",
      });
    if (staged.digest === current.installation.digest && current.activeSource !== "local-repair") {
      const verified = yield* snapshotDirectory(input.installationId, current.directory).pipe(
        Effect.flatMap((directory) =>
          verifyPluginSnapshot({ directory, digest: current.installation.digest }),
        ),
        Effect.option,
      );
      if (Option.isSome(verified))
        return yield* lifecycle(
          Effect.gen(function* () {
            const latest = yield* get(input.installationId);
            if (
              latest.installation.generation !== current.installation.generation ||
              latest.installation.pendingUpdate?.generation !==
                current.installation.pendingUpdate?.generation
            )
              return yield* new PluginError({
                reason: "changed_source",
                message: "The installation changed while the update was staged. Refresh again.",
              });
            const result = yield* update(input.installationId, (record) => {
              if (!record.installation.pendingUpdate) return record;
              const { pendingUpdate: _pending, ...installation } = record.installation;
              const {
                pendingDirectory: _directory,
                pendingKind: _kind,
                pendingSettings: _settings,
                pendingSecrets: _secrets,
                pendingSourceRequest: _sourceRequest,
                ...rest
              } = record;
              return { ...rest, installation };
            });
            yield* releaseObsoleteSnapshots(latest);
            return result;
          }),
          input,
        );
    }
    const timestamp = yield* now;
    return yield* lifecycle(
      Effect.gen(function* () {
        const latest = yield* get(input.installationId);
        if (
          latest.installation.generation !== current.installation.generation ||
          latest.installation.pendingUpdate?.generation !==
            current.installation.pendingUpdate?.generation
        ) {
          return yield* new PluginError({
            reason: "changed_source",
            message: "The installation changed while the update was staged. Refresh again.",
          });
        }
        const result = yield* update(input.installationId, (record) => {
          const {
            pendingSettings: _settings,
            pendingSecrets: _secrets,
            pendingSourceRequest: _sourceRequest,
            ...rest
          } = record;
          return {
            ...rest,
            pendingDirectory: path.relative(store.directory, staged.directory),
            pendingKind: "upstream",
            installation: {
              ...record.installation,
              pendingUpdate: {
                kind: "upstream",
                manifest: staged.manifest,
                source: staged.source,
                digest: staged.digest,
                generation,
                updatedAt: timestamp,
              },
            },
          };
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              retainSnapshot = true;
            }),
          ),
          Effect.uninterruptible,
        );
        yield* releaseObsoleteSnapshots(latest);
        return result;
      }),
      input,
    );
  }, Effect.scoped);
  const discardPendingUpdate = Effect.fn("PluginService.discardPendingUpdate")(function* (input: {
    readonly installationId: string;
  }) {
    const current = yield* mutable(input.installationId);
    if (!current.installation.pendingUpdate) return current.installation;
    const result = yield* update(input.installationId, (record) => {
      const { pendingUpdate: _pending, ...installation } = record.installation;
      const {
        pendingDirectory: _directory,
        pendingKind: _kind,
        pendingSettings: _settings,
        pendingSecrets: _secrets,
        pendingSourceRequest: _sourceRequest,
        ...rest
      } = record;
      return { ...rest, installation };
    });
    yield* releaseObsoleteSnapshots(current);
    return result;
  }, lifecycle);
  const backlogFor = Effect.fn("PluginService.backlogFor")(function* (
    record: PluginStore.StoredInstallation,
  ) {
    const throughSequence = yield* applicationEvents.latestApplicationSequence.pipe(
      Effect.mapError(failure),
    );
    const runs = new Set<string>();
    const threadShells = new Map<
      string,
      Effect.Success<ReturnType<typeof threads.getThreadShell>>
    >();
    if (record.installation.grants.capabilities.includes("events.run-finalized"))
      yield* applicationEvents
        .readAgentEvents({
          afterSequence: record.eventCursor,
          throughSequence,
          eventType: "run.updated",
        })
        .pipe(
          Stream.runForEach(
            Effect.fn("PluginService.countBacklog")(function* (stored) {
              const event = stored.event;
              if (
                event.type !== "run.updated" ||
                !["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
                  event.payload.status,
                ) ||
                event.payload.userMessageId.startsWith("plugin:")
              )
                return;
              if (!threadShells.has(event.threadId))
                threadShells.set(
                  event.threadId,
                  yield* threads.getThreadShell(event.threadId).pipe(Effect.mapError(failure)),
                );
              const thread = threadShells.get(event.threadId);
              if (
                !thread ||
                thread.deletedAt !== null ||
                !record.installation.grants.projectIds.includes(thread.projectId) ||
                stored.sequence <=
                  (record.projectGrantStarts?.[thread.projectId] ?? record.eventCursor)
              )
                return;
              if (
                yield* receipts.delivered({
                  installationId: record.installation.installationId,
                  generation: record.installation.generation,
                  runId: event.payload.id,
                })
              )
                return;
              runs.add(event.payload.id);
            }),
          ),
          Effect.mapError(failure),
        );
    return {
      count: runs.size,
      afterSequence: record.eventCursor,
      throughSequence,
      requiresChoice:
        !!record.eventBacklogChoiceRequired ||
        !record.installation.enabled ||
        !compatible(record.installation) ||
        !!record.deliveryError,
    };
  });
  const backlog = Effect.fn("PluginService.backlog")(function* (input: {
    readonly installationId: string;
  }) {
    return yield* backlogFor(yield* get(input.installationId));
  });
  const chooseBacklog = Effect.fn("PluginService.chooseBacklog")(function* (
    record: PluginStore.StoredInstallation,
    choice?: PluginEventBacklogPolicy,
  ) {
    const backlog = yield* backlogFor(record);
    if (
      choice !== undefined &&
      ((choice.policy !== "skip" && choice.policy !== "deliver") ||
        !Number.isSafeInteger(choice.throughSequence) ||
        choice.throughSequence < record.eventCursor ||
        choice.throughSequence > backlog.throughSequence)
    )
      return yield* new PluginError({
        reason: "invalid_input",
        code: "event_backlog_changed",
        message: "The event backlog changed or the choice is invalid. Review it again.",
      });
    if (backlog.requiresChoice && backlog.count > 0 && choice === undefined)
      return yield* new PluginError({
        reason: "invalid_input",
        code: "event_backlog_choice_required",
        message: `Choose whether to skip or deliver ${backlog.count} pending events before resuming.`,
      });
    return { eventCursor: choice?.policy === "skip" ? choice.throughSequence : record.eventCursor };
  });
  const repairDirectory = Effect.fn("PluginService.repairDirectory")(function* (
    installationId: string,
    repair: PluginRepairWorkspace,
  ) {
    const owned = path.join(store.directory, "workspaces", installationId, repair.workspaceId);
    const realRoot = yield* fs.realPath(owned).pipe(Effect.mapError(failure));
    const realStore = yield* fs.realPath(store.directory).pipe(Effect.mapError(failure));
    if (realRoot !== path.join(realStore, "workspaces", installationId, repair.workspaceId))
      return yield* new PluginError({
        reason: "changed_source",
        message: "The repair workspace no longer belongs to this installation.",
      });
    return realRoot;
  });
  const acceptsRepairBaseline = Effect.fn("PluginService.acceptsRepairBaseline")(function* (
    record: PluginStore.StoredInstallation,
    repair: PluginRepairWorkspace,
    directory: string,
  ) {
    if (repair.baseDigest === record.installation.digest) return true;
    if (record.activeSource !== "local-repair" || record.installation.source.kind !== "local")
      return false;
    // A moved home changes the folder's absolute path, not its recorded repair lineage.
    if (path.resolve(record.installation.source.directory) === path.resolve(repair.directory))
      return true;
    const source = yield* fs.realPath(record.installation.source.directory).pipe(Effect.option);
    return Option.isSome(source) && source.value === directory;
  });
  const repairDraft = (installation: PluginInstallation, baseDigest: string) => {
    const observation = installation.health;
    const fault = observation?.fault;
    const handler = fault?.handler;
    const [kind, name] = handler?.split(":") ?? [];
    const declaredHandler =
      handler === "event:run.finalized"
        ? pluginRequestedCapabilities(installation.manifest).includes("events.run-finalized")
        : isInvokeHandler(handler) &&
          (kind === "action"
            ? installation.manifest.actions.some((action) => action.id === name)
            : kind === "status"
              ? (installation.manifest.threadStatus ?? []).some((status) => status.id === name)
              : kind === "view" && installation.manifest.views.some((view) => view.id === name));
    // View message names are chosen by the caller, so disclose only the declared view id.
    const diagnosticHandler = declaredHandler
      ? kind === "view"
        ? `view:${name}`
        : handler
      : undefined;
    const missingCapabilities = pluginCompatibility(installation.manifest).missingCapabilities;
    // A plugin can put credentials in arbitrary reason, handler and message strings. Only
    // known reason tokens and manifest-declared handlers belong in the unsent agent draft.
    return [
      `Repair the T3 plugin ${installation.manifest.id}@${installation.manifest.version} in this workspace.`,
      `Original baseline digest: ${baseDigest}. The baseline commit preserves the exact verified snapshot copied when this workspace was prepared.`,
      `Current active digest: ${installation.digest}. Workspace edits are staged separately for explicit review.`,
      `T3 host: ${policy.hostVersion}; Node: ${policy.nodeVersion}.`,
      ...(observation?.lastHealthy
        ? [
            `Last healthy host: ${observation.lastHealthy.hostVersion}; Node: ${observation.lastHealthy.nodeVersion}; at ${observation.lastHealthy.at}.`,
          ]
        : []),
      ...(fault
        ? [
            `Fault host: ${fault.hostVersion}; Node: ${fault.nodeVersion}; at ${fault.at}. Current host and Node match the fault: ${fault.hostVersion === policy.hostVersion && fault.nodeVersion === policy.nodeVersion ? "yes" : "no"}.`,
            `Fault reason: ${isFailureReason(fault.reason) ? fault.reason : "other"}.`,
            ...(diagnosticHandler ? [`Fault handler: ${diagnosticHandler}.`] : []),
            "Free-form errors are omitted because they may contain credentials. The full error is in Settings > Plugins > Details; copy it manually only after checking it contains no credentials.",
          ]
        : []),
      ...(missingCapabilities.length > 0
        ? [`Missing required capabilities: ${missingCapabilities.join(", ")}.`]
        : []),
      `Public API: 1. Setting keys: ${installation.manifest.settings.map((setting) => setting.key).join(", ") || "none"}. Setting values, secrets and plugin data are omitted.`,
      "Keep the public manifest and JavaScript facade compatible. Missing optional capabilities must degrade. Plugins run as trusted Node code with this OS user's permissions, not in an OS sandbox.",
      "Diagnose and edit this local workspace. Test the fix. Do not install, activate, or change grants automatically. The person must stage the local fix and review its exact digest and permissions in Plugins settings.",
      "Do not modify the publisher source or plugin data directory. Publisher updates remain tracked separately.",
    ].join("\n\n");
  };
  const prepareRepair = Effect.fn("PluginService.prepareRepair")(function* (input: {
    readonly installationId: string;
  }) {
    const current = yield* mutable(input.installationId);
    const directory = yield* snapshotDirectory(input.installationId, current.directory);
    yield* verifyPluginSnapshot({ directory, digest: current.installation.digest });
    if (
      current.repair &&
      (yield* fs
        .exists(
          path.join(
            store.directory,
            "workspaces",
            input.installationId,
            current.repair.workspaceId,
          ),
        )
        .pipe(Effect.mapError(failure)))
    ) {
      const workspaceDirectory = yield* repairDirectory(input.installationId, current.repair);
      if (yield* acceptsRepairBaseline(current, current.repair, workspaceDirectory)) {
        const repair = {
          ...current.repair,
          directory: workspaceDirectory,
          draft: repairDraft(current.installation, current.repair.baseDigest),
        };
        if (repair.draft !== current.repair.draft || repair.directory !== current.repair.directory)
          yield* update(input.installationId, (record) => ({
            ...record,
            repair,
            installation:
              record.activeSource === "local-repair"
                ? {
                    ...record.installation,
                    source: { kind: "local", directory: workspaceDirectory },
                  }
                : record.installation,
          }));
        return repair;
      }
    }
    const workspaceId = yield* id;
    const destinationDirectory = path.join(
      store.directory,
      "workspaces",
      input.installationId,
      workspaceId,
    );
    yield* preparePluginRepair({
      directory,
      destinationDirectory,
      digest: current.installation.digest,
      pluginId: current.installation.manifest.id,
      version: current.installation.manifest.version,
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    const repair: PluginRepairWorkspace = {
      workspaceId,
      directory: yield* fs.realPath(destinationDirectory).pipe(Effect.mapError(failure)),
      baseDigest: current.installation.digest,
      baseGeneration: current.installation.generation,
      draft: repairDraft(current.installation, current.installation.digest),
    };
    yield* update(input.installationId, (record) => ({ ...record, repair }));
    return repair;
  }, lifecycle);
  const stageRepair = Effect.fn("PluginService.stageRepair")(function* (input: {
    readonly installationId: string;
    readonly workspaceId: string;
    readonly baseDigest: string;
  }) {
    const current = yield* mutable(input.installationId);
    const repair = current.repair;
    if (
      !repair ||
      repair.workspaceId !== input.workspaceId ||
      repair.baseDigest !== input.baseDigest
    )
      return yield* new PluginError({
        reason: "changed_source",
        message:
          "This repair does not belong to the active installation baseline. Prepare a new repair workspace.",
      });
    const realRoot = yield* repairDirectory(input.installationId, repair);
    if (!(yield* acceptsRepairBaseline(current, repair, realRoot)))
      return yield* new PluginError({
        reason: "changed_source",
        message:
          "This repair does not belong to the active installation baseline. Prepare a new repair workspace.",
      });
    const generation = yield* id;
    const staged = yield* stage(
      { kind: "local", directory: realRoot },
      input.installationId,
      generation,
    );
    if (staged.manifest.id !== current.installation.manifest.id)
      return yield* new PluginError({
        reason: "invalid_manifest",
        message: "A local repair must retain this plugin's identity.",
      });
    const updatedAt = yield* now;
    const result = yield* update(input.installationId, (record) => {
      const {
        pendingSettings: _settings,
        pendingSecrets: _secrets,
        pendingSourceRequest: _sourceRequest,
        ...rest
      } = record;
      return {
        ...rest,
        pendingDirectory: path.relative(store.directory, staged.directory),
        pendingKind: "local-repair",
        installation: {
          ...record.installation,
          pendingUpdate: {
            manifest: staged.manifest,
            source: staged.source,
            digest: staged.digest,
            generation,
            updatedAt,
            kind: "local-repair",
          },
        },
      };
    });
    yield* releaseObsoleteSnapshots(current);
    return result;
  }, lifecycle);
  const usePrevious = Effect.fn("PluginService.usePrevious")(function* (input: {
    readonly installationId: string;
    readonly expectedDigest: string;
    readonly acknowledgeCurrentData: true;
  }) {
    const current = yield* mutable(input.installationId);
    const previous = current.previous;
    if (
      !previous ||
      previous.digest !== input.expectedDigest ||
      input.acknowledgeCurrentData !== true
    )
      return yield* new PluginError({
        reason: "invalid_input",
        message:
          "Review the retained revision and acknowledge that it will use current plugin data. External files, services and data are not restored.",
      });
    const directory = yield* snapshotDirectory(input.installationId, previous.directory);
    yield* verifyPluginSnapshot({ directory, digest: previous.digest });
    const generation = yield* id;
    const staged = yield* stage({ kind: "local", directory }, input.installationId, generation);
    if (staged.digest !== previous.digest)
      return yield* new PluginError({
        reason: "changed_source",
        message: "The retained revision changed. It was not staged.",
      });
    const updatedAt = yield* now;
    const result = yield* update(input.installationId, (record) => ({
      ...record,
      pendingDirectory: path.relative(store.directory, staged.directory),
      pendingKind: "previous",
      pendingSettings: previous.settings,
      pendingSecrets: previous.secrets,
      installation: {
        ...record.installation,
        pendingUpdate: {
          kind: "previous",
          manifest: previous.manifest,
          source: previous.source,
          digest: previous.digest,
          generation,
          updatedAt,
        },
      },
    }));
    yield* releaseObsoleteSnapshots(current);
    return result;
  }, lifecycle);
  const consent = Effect.fn("PluginService.consent")(
    function* (input: {
      readonly installationId: string;
      readonly digest: string;
      readonly grants: PluginGrants;
      readonly eventBacklog?: PluginEventBacklogPolicy;
    }) {
      const current = yield* mutable(input.installationId);
      const pending = current.installation.pendingUpdate;
      const selected = pending ? { ...current.installation, ...pending } : current.installation;
      const storedDirectory = pending ? current.pendingDirectory : current.directory;
      if (selected.digest !== input.digest || !storedDirectory)
        return yield* new PluginError({
          reason: "changed_source",
          message: "The plugin snapshot changed. Review the current digest.",
        });
      if (!compatible(selected))
        return yield* new PluginError({
          reason: "incompatible",
          message: "This plugin requires an unsupported capability.",
        });
      if (
        input.grants.capabilities.some(
          (cap) => !pluginRequestedCapabilities(selected.manifest).includes(cap),
        )
      )
        return yield* pluginPermissionDenied();
      const directory = yield* snapshotDirectory(input.installationId, storedDirectory);
      // A pending update cannot revoke the working version until its exact bytes pass consent.
      if (pending) yield* verifyPluginSnapshot({ directory, digest: selected.digest });
      else yield* verifySnapshot(current);
      const timestamp = yield* now;
      const generation = yield* id;
      const observationStart = yield* applicationEvents.latestApplicationSequence.pipe(
        Effect.mapError(failure),
      );
      const firstConsent = current.installation.consentedDigest === null;
      const enabled = firstConsent ? true : current.installation.enabled;
      const choice =
        enabled && !firstConsent
          ? yield* chooseBacklog(current, input.eventBacklog)
          : { eventCursor: current.eventCursor };
      const newObserver =
        input.grants.capabilities.includes("events.run-finalized") &&
        !current.installation.grants.capabilities.includes("events.run-finalized");
      const projectGrantStarts = Object.fromEntries(
        input.grants.projectIds.map((projectId) => [
          projectId,
          !newObserver && current.installation.grants.projectIds.includes(projectId)
            ? (current.projectGrantStarts?.[projectId] ?? current.eventCursor)
            : observationStart,
        ]),
      );
      const result = yield* update(input.installationId, (record) => {
        const { pendingUpdate: _pending, ...active } = record.installation;
        const {
          pendingDirectory: _directory,
          pendingKind: _kind,
          pendingSettings: _settings,
          pendingSecrets: _secrets,
          pendingSourceRequest: _sourceRequest,
          deliveryError: _error,
          ...rest
        } = record;
        // Code switches keep matching current values, including rotated secrets. Retained config
        // only recovers keys the intervening manifest removed or changed to a different type.
        const settingsSources = [
          record.installation.settings,
          record.pendingSettings,
          record.previous?.settings,
        ];
        const secretsSources = [record.secrets, record.pendingSecrets, record.previous?.secrets];
        const previous = pending
          ? {
              directory: record.directory,
              manifest: record.installation.manifest,
              source: record.installation.source,
              digest: record.installation.digest,
              ...(record.sourceRequest ? { sourceRequest: record.sourceRequest } : {}),
              // Retain hidden publisher keys across further edits of a local repair. Matching
              // current keys supersede retained values; explicit clears scrub both maps.
              settings: { ...record.previous?.settings, ...record.installation.settings },
              secrets: { ...record.previous?.secrets, ...record.secrets },
              activeSource: record.activeSource ?? ("upstream" as const),
            }
          : record.previous;
        return {
          ...rest,
          directory: path.relative(store.directory, directory),
          sourceRequest: record.sourceRequest ?? record.installation.source,
          ...(previous ? { previous } : {}),
          activeSource: pending
            ? record.pendingKind === "local-repair"
              ? "local-repair"
              : record.pendingKind === "previous"
                ? (record.previous?.activeSource ?? "upstream")
                : "upstream"
            : (record.activeSource ?? "upstream"),
          eventCursor: Math.max(
            record.eventCursor,
            firstConsent ? observationStart : choice.eventCursor,
          ),
          eventBacklogChoiceRequired: enabled
            ? false
            : (record.eventBacklogChoiceRequired ?? false),
          projectGrantStarts,
          secrets: Object.fromEntries(
            selected.manifest.settings
              .filter((setting) => setting.type === "secret")
              .flatMap((setting) => {
                const value = secretsSources
                  .map((source) => source?.[setting.key])
                  .find((value) => typeof value === "string");
                return value === undefined ? [] : [[setting.key, value]];
              }),
          ),
          installation: {
            ...active,
            manifest: selected.manifest,
            source: selected.source,
            digest: selected.digest,
            settings: Object.fromEntries(
              selected.manifest.settings
                .filter((setting) => setting.type !== "secret")
                .flatMap((setting) => {
                  const value =
                    settingsSources
                      .map((source) => source?.[setting.key])
                      .find((value) => typeof value === setting.type) ?? setting.default;
                  return value === undefined ? [] : [[setting.key, value]];
                }),
            ),
            generation,
            consentedDigest: input.digest,
            grants: input.grants,
            enabled,
            status: enabled ? "idle" : "disabled",
            error: null,
            updatedAt: timestamp,
          },
        };
      });
      yield* supervisor.stop(input.installationId);
      yield* releaseObsoleteSnapshots(current);
      return result;
    },
    transition,
    lifecycle,
  );
  const setEnabled = Effect.fn("PluginService.setEnabled")(
    function* (input: {
      readonly installationId: string;
      readonly enabled: boolean;
      readonly eventBacklog?: PluginEventBacklogPolicy;
    }) {
      const current = yield* mutable(input.installationId);
      if (
        input.enabled &&
        (!compatible(current.installation) ||
          current.installation.consentedDigest !== current.installation.digest)
      )
        return yield* new PluginError({
          reason: "needs_consent",
          message: "Consent to this exact compatible plugin snapshot first.",
        });
      if (current.installation.enabled === input.enabled && !current.eventBacklogChoiceRequired)
        return present(current);
      if (input.enabled) yield* verifySnapshot(current);
      const choice = input.enabled
        ? yield* chooseBacklog(current, input.eventBacklog)
        : { eventCursor: current.eventCursor };
      const generation = yield* id;
      const timestamp = yield* now;
      const result = yield* update(input.installationId, (record) => ({
        ...record,
        eventCursor: Math.max(record.eventCursor, choice.eventCursor),
        eventBacklogChoiceRequired:
          !input.enabled &&
          current.installation.grants.capabilities.includes("events.run-finalized"),
        deliveryError: null,
        installation: {
          ...record.installation,
          generation,
          enabled: input.enabled,
          status: input.enabled ? "idle" : "disabled",
          error: null,
          updatedAt: timestamp,
        },
      }));
      yield* supervisor.stop(input.installationId);
      return result;
    },
    transition,
    lifecycle,
  );
  const resume = Effect.fn("PluginService.resume")(
    function* (input: {
      readonly installationId: string;
      readonly eventBacklog?: PluginEventBacklogPolicy;
    }) {
      const current = yield* mutable(input.installationId);
      if (
        current.installation.consentedDigest !== current.installation.digest ||
        !compatible(current.installation)
      )
        return yield* new PluginError({
          reason: "needs_consent",
          message: "Consent to this exact compatible plugin snapshot first.",
        });
      if (
        !current.deliveryError &&
        !current.eventBacklogChoiceRequired &&
        current.installation.status !== "error" &&
        current.installation.status !== "quarantined"
      )
        return yield* new PluginError({
          reason: "invalid_input",
          message: "This plugin has no failed runtime to resume.",
        });
      yield* verifySnapshot(current);
      const choice = yield* chooseBacklog(current, input.eventBacklog);
      yield* supervisor.resume(input.installationId);
      const generation = current.installation.generation;
      const timestamp = yield* now;
      const result = yield* update(input.installationId, (record) => ({
        ...record,
        deliveryError: null,
        eventCursor: Math.max(record.eventCursor, choice.eventCursor),
        eventBacklogChoiceRequired: false,
        installation: {
          ...record.installation,
          generation,
          enabled: true,
          status: "idle",
          error: null,
          updatedAt: timestamp,
        },
      }));
      return result;
    },
    transition,
    lifecycle,
  );
  const remove = Effect.fn("PluginService.remove")(
    function* (input: { readonly installationId: string; readonly deleteData?: boolean }) {
      const current = yield* mutable(input.installationId);
      const generation = yield* id;
      yield* update(input.installationId, (record) => ({
        ...record,
        installation: { ...record.installation, generation, enabled: false, status: "disabled" },
      }));
      yield* supervisor.stop(input.installationId);
      yield* removeSnapshot(input.installationId);
      // Keep a disabled, retryable entry if stopping or removing executable bytes fails.
      if (input.deleteData) {
        // A reinstall must see the purge, never a removed record with data it can restore.
        const removedIds = yield* store
          .update((state) => {
            const records = state.installations.filter(
              (record) =>
                (record.installation.installationId === input.installationId || record.removed) &&
                (current.rawRecord !== undefined
                  ? record.installation.installationId === input.installationId
                  : record.rawRecord === undefined &&
                    record.installation.manifest.id === current.installation.manifest.id &&
                    sourceIdentity(record.sourceRequest ?? record.installation.source) ===
                      sourceIdentity(current.sourceRequest ?? current.installation.source)),
            );
            const ids = records.map((record) => record.installation.installationId);
            return Effect.succeed([
              { ids, dataKeys: records.map(dataKeyFor) },
              {
                ...state,
                installations: state.installations.filter(
                  (record) => !ids.includes(record.installation.installationId),
                ),
                receipts: Object.fromEntries(
                  Object.entries(state.receipts).filter(
                    ([key]) =>
                      !ids.some(
                        (id) =>
                          key.startsWith(`plugin:${id}:`) || key.startsWith(`delivery:${id}:`),
                      ),
                  ),
                ),
                origins: Object.fromEntries(
                  Object.entries(state.origins).filter(
                    ([key]) => !ids.some((id) => key.startsWith(`plugin:${id}:`)),
                  ),
                ),
              },
            ] as const);
          })
          .pipe(Effect.mapError(failure));
        yield* Effect.forEach(removedIds.ids, (id) => receipts.prune(id), { discard: true });
        yield* Effect.forEach(removedIds.ids, (id) => removeSnapshot(id), { discard: true });
        yield* Effect.forEach(removedIds.dataKeys, removeDataDirectory, { discard: true });
      } else {
        yield* update(input.installationId, (record) => ({ ...record, removed: true }));
      }
    },
    transition,
    lifecycle,
  );
  const updateSettings = Effect.fn("PluginService.updateSettings")(function* (input: {
    readonly installationId: string;
    readonly values: Readonly<Record<string, PluginSettingValue>>;
  }) {
    const current = yield* mutable(input.installationId);
    for (const [key, value] of Object.entries(input.values)) {
      const setting = current.installation.manifest.settings.find((s) => s.key === key);
      if (
        !setting ||
        typeof value !== (setting.type === "secret" ? "string" : setting.type) ||
        (typeof value === "number" && !Number.isFinite(value)) ||
        (typeof value === "string" && value.length > 16_384)
      )
        return yield* new PluginError({
          reason: "invalid_input",
          message: "A plugin setting is unknown or has the wrong type.",
        });
    }
    const timestamp = yield* now;
    return yield* update(input.installationId, (record) => {
      const settings = { ...record.installation.settings };
      const secrets = { ...record.secrets };
      for (const [key, value] of Object.entries(input.values)) {
        if (
          record.installation.manifest.settings.some((s) => s.key === key && s.type === "secret")
        ) {
          if (typeof value === "string") {
            if (value === "") delete secrets[key];
            else secrets[key] = value;
          }
        } else settings[key] = value;
      }
      return {
        ...record,
        secrets,
        ...(record.previous
          ? {
              previous: {
                ...record.previous,
                secrets: Object.fromEntries(
                  Object.entries(record.previous.secrets).filter(
                    ([key]) => input.values[key] !== "",
                  ),
                ),
              },
            }
          : {}),
        ...(record.pendingSecrets
          ? {
              pendingSecrets: Object.fromEntries(
                Object.entries(record.pendingSecrets).filter(([key]) => input.values[key] !== ""),
              ),
            }
          : {}),
        installation: { ...record.installation, settings, updatedAt: timestamp },
      };
    });
  }, lifecycle);
  const execute = Effect.fn("PluginService.execute")(
    function* (
      input: {
        readonly installationId: string;
        readonly generation: string;
        readonly handler: string;
        readonly input?: unknown;
        readonly context?: NonNullable<PluginInvokeInput["context"]>;
        readonly operationId: string;
      },
      actor: PluginActor,
      event = false,
    ) {
      yield* actor.authorize?.() ?? Effect.void;
      const record = yield* get(input.installationId);
      const disabled = assertPluginExecutionAllowed(policy);
      if (disabled) return yield* disabled;
      const denied = assertPluginActive(present(record), input.generation);
      if (denied) return yield* denied;
      const transitioning = assertNotTransitioning(input.installationId);
      if (transitioning) return yield* transitioning;
      const directory = yield* verifySnapshot(record);
      const data = yield* dataDirectory(record);
      if (
        Buffer.byteLength(
          yield* encodeJson(input).pipe(
            Effect.mapError(
              () =>
                new PluginError({
                  reason: "invalid_input",
                  message: "The plugin input must be JSON.",
                }),
            ),
          ),
        ) > 128_000
      )
        return yield* new PluginError({
          reason: "invalid_input",
          message: "The plugin invocation is too large.",
        });
      let callId = 0;
      const output = yield* supervisor.invoke(
        {
          ...input,
          capabilities: record.installation.grants.capabilities.filter((capability) =>
            pluginRequestedCapabilities(record.installation.manifest).includes(capability),
          ),
          directory,
          entry: record.installation.manifest.entry,
          dataDirectory: data,
          caller: callerFor(actor),
        },
        (method, value) => {
          if (++callId > 100)
            return Effect.fail(
              new PluginError({
                reason: "permission_denied",
                message: "The plugin invocation exceeded its host-call limit.",
              }),
            );
          return host.call(
            {
              installationId: input.installationId,
              generation: input.generation,
              operationId: input.operationId,
              callId,
              actor,
              event,
              ...(input.context === undefined ? {} : { context: input.context }),
            },
            method,
            value,
          );
        },
      );
      const latest = yield* get(input.installationId);
      const revoked = assertPluginActive(present(latest), input.generation);
      if (revoked) return yield* revoked;
      // Only files the host verified become images; a worker cannot inline unchecked bytes.
      const { images: _unverified, workerImages, ...result } = output;
      if (
        Buffer.byteLength(
          yield* encodeResult(result).pipe(
            Effect.mapError(
              () =>
                new PluginError({
                  reason: "invalid_result",
                  message: "The plugin result must be JSON.",
                }),
            ),
          ),
        ) > 128_000
      )
        return yield* new PluginError({
          reason: "invalid_result",
          message: "The plugin result is too large.",
        });
      const decoded = yield* decodeResult(result).pipe(
        Effect.mapError(
          () =>
            new PluginError({
              reason: "invalid_result",
              message: "The plugin returned an invalid result.",
            }),
        ),
      );
      if (decoded.intents && decoded.intents.length > 0) {
        if (!pluginCapabilityAllowed(latest.installation, actor, "ui"))
          return yield* pluginPermissionDenied();
        if (
          decoded.intents.some(
            (intent) =>
              intent.type === "view.open" &&
              !latest.installation.manifest.views.some((view) => view.id === intent.viewId),
          )
        )
          return yield* new PluginError({
            reason: "invalid_result",
            message: "The plugin requested an undeclared view.",
          });
      }
      const images =
        workerImages === undefined || workerImages.length === 0
          ? undefined
          : yield* readResultImages(data, workerImages);
      if (
        latest.installation.status === "error" ||
        latest.installation.health?.lastHealthy?.hostVersion !== policy.hostVersion ||
        latest.installation.health?.lastHealthy?.nodeVersion !== policy.nodeVersion
      ) {
        const at = yield* now;
        yield* update(input.installationId, (current) =>
          current.installation.generation === input.generation &&
          (current.installation.status === "error" ||
            current.installation.health?.lastHealthy?.hostVersion !== policy.hostVersion ||
            current.installation.health?.lastHealthy?.nodeVersion !== policy.nodeVersion)
            ? {
                ...current,
                installation: {
                  ...current.installation,
                  status: "idle",
                  error: null,
                  health: {
                    ...current.installation.health,
                    lastHealthy: {
                      hostVersion: policy.hostVersion,
                      nodeVersion: policy.nodeVersion,
                      at,
                    },
                  },
                },
              }
            : current,
        );
      }
      return images === undefined ? decoded : { ...decoded, images };
    },
    (effect, input, _actor, event = false) =>
      effect.pipe(
        Effect.tapError(
          Effect.fn("PluginService.observeFault")(function* (error) {
            const workerFault =
              PluginSupervisor.isPluginWorkerFault(error) || error.reason === "quarantined";
            const pauseObserver =
              event &&
              !["storage_failed", "busy", "cancelled", "stale_generation", "not_found"].includes(
                error.reason,
              );
            const at = yield* now;
            if (!workerFault && !pauseObserver) return;
            yield* update(input.installationId, (record) =>
              record.installation.generation === input.generation
                ? {
                    ...record,
                    ...(pauseObserver
                      ? { deliveryError: error.message, eventBacklogChoiceRequired: true }
                      : {}),
                    installation: {
                      ...record.installation,
                      ...(workerFault
                        ? {
                            status:
                              error.reason === "quarantined"
                                ? ("quarantined" as const)
                                : ("error" as const),
                            error: error.message,
                          }
                        : {}),
                      health: {
                        ...record.installation.health,
                        fault: {
                          hostVersion: policy.hostVersion,
                          nodeVersion: policy.nodeVersion,
                          at,
                          reason: error.reason,
                          message: error.message,
                          handler: input.handler,
                        },
                      },
                    },
                  }
                : record,
            ).pipe(Effect.ignore);
          }),
        ),
      ),
  );
  const invoke = Effect.fn("PluginService.invoke")(function* (
    input: PluginInvokeInput,
    actor: PluginActor,
  ) {
    if (!actor.scopes.includes(AuthOrchestrationOperateScope))
      return yield* pluginPermissionDenied();
    const validated = yield* decodeInvoke(input).pipe(
      Effect.mapError(
        () =>
          new PluginError({
            reason: "invalid_input",
            message: "The plugin invocation is invalid.",
          }),
      ),
    );
    const record = yield* get(validated.installationId);
    const [kind, name] = validated.handler.split(":");
    if (kind === "action") {
      const action = record.installation.manifest.actions.find((a) => a.id === name);
      if (
        !action ||
        (actor.source === "agent" && action.agentCallable !== true) ||
        actor.source === "background"
      )
        return yield* new PluginError({
          reason: "invalid_handler",
          message: "This plugin action is not available to this caller.",
        });
    } else if (kind === "status") {
      // A status is shown to the person looking at a thread; agents and observers never ask.
      if (
        actor.source !== "client" ||
        validated.context?.threadId === undefined ||
        !(record.installation.manifest.threadStatus ?? []).some((item) => item.id === name) ||
        !pluginCapabilityAllowed(record.installation, actor, "ui")
      )
        return yield* new PluginError({
          reason: "invalid_handler",
          message: "The plugin status is not declared for this caller.",
        });
      const result = yield* execute(validated, actor);
      const status = yield* decodeThreadStatus(result.data ?? null).pipe(
        Effect.mapError(
          () =>
            new PluginError({
              reason: "invalid_result",
              message: "The plugin returned an invalid thread status.",
            }),
        ),
      );
      return { data: status };
    } else if (
      kind !== "view" ||
      actor.source !== "client" ||
      !record.installation.manifest.views.some((view) => view.id === name) ||
      !pluginCapabilityAllowed(record.installation, actor, "ui")
    )
      return yield* new PluginError({
        reason: "invalid_handler",
        message: "The plugin handler is not declared for this caller.",
      });
    return yield* execute(validated, actor);
  });
  const readView = Effect.fn("PluginService.readView")(function* (input: PluginViewInput) {
    const record = yield* get(input.installationId);
    const disabled = assertPluginExecutionAllowed(policy);
    if (disabled) return yield* disabled;
    const denied = assertPluginActive(present(record), input.generation);
    if (denied) return yield* denied;
    const transitioning = assertNotTransitioning(input.installationId);
    if (transitioning) return yield* transitioning;
    if (!record.installation.grants.capabilities.includes("ui"))
      return yield* pluginPermissionDenied();
    const view = record.installation.manifest.views.find((view) => view.id === input.viewId);
    if (!view)
      return yield* new PluginError({
        reason: "invalid_handler",
        message: "The plugin view is not declared.",
      });
    const directory = yield* verifySnapshot(record);
    const html = yield* fs
      .readFileString(safePluginPath(directory, view.entry))
      .pipe(Effect.mapError(failure));
    if (Buffer.byteLength(html) > 1_000_000)
      return yield* new PluginError({
        reason: "invalid_result",
        message: "The plugin view exceeds its size limit.",
      });
    return { html };
  });
  const deliver = Effect.fn("PluginService.deliver")(function* (input: {
    readonly installationId: string;
    readonly generation: string;
    readonly event: PluginRunFinalizedEvent;
    readonly sequence: number;
  }) {
    const record = yield* get(input.installationId);
    const disabled = assertPluginExecutionAllowed(policy);
    if (disabled) return yield* disabled;
    const denied = assertPluginActive(present(record), input.generation);
    if (denied) return yield* denied;
    const transitioning = assertNotTransitioning(input.installationId);
    if (transitioning) return yield* transitioning;
    if (record.eventBacklogChoiceRequired)
      return yield* new PluginError({
        reason: "disabled",
        code: "event_backlog_choice_required",
        message: "Choose whether to skip or deliver pending events before resuming.",
      });
    if (
      input.sequence <= (record.projectGrantStarts?.[input.event.projectId] ?? record.eventCursor)
    )
      return;
    if (record.eventCursor >= input.sequence) return;
    if (yield* receipts.delivered({ ...input, runId: input.event.runId })) return;
    const actor: PluginActor = {
      principalId: `plugin:${input.installationId}`,
      source: "background",
      scopes: ["orchestration:read", "orchestration:operate"],
      runtimeMode: "full-access",
      projectIds: [input.event.projectId],
    };
    if (
      !pluginCapabilityAllowed(
        record.installation,
        actor,
        "events.run-finalized",
        input.event.projectId,
      )
    )
      return;
    yield* execute(
      {
        installationId: input.installationId,
        generation: input.generation,
        handler: "event:run.finalized",
        input: input.event,
        context: { projectId: input.event.projectId, threadId: input.event.threadId },
        operationId: input.event.deliveryId,
      },
      actor,
      true,
    );
    yield* receipts.acknowledge({
      ...input,
      runId: input.event.runId,
      deliveryId: input.event.deliveryId,
    });
  }, deliveryLock);
  return PluginService.of({
    prepareRepair,
    stageRepair,
    usePrevious,
    backlog,
    list,
    subscribe: Stream.unwrap(
      Effect.map(store.subscribeChanges, (changes) =>
        Stream.concat(Stream.fromEffect(list()), changes.pipe(Stream.mapEffect(list))),
      ),
    ).pipe(
      Stream.catch(() => Stream.fromEffect(list())),
      Stream.changesWith((a, b) => encodeCatalogue(a) === encodeCatalogue(b)),
    ),
    install,
    refresh,
    discardPendingUpdate,
    consent,
    setEnabled,
    resume,
    remove,
    updateSettings,
    invoke,
    readView,
    deliver,
  });
});
export const layer = Layer.effect(PluginService, make).pipe(Layer.provide(ProcessRunner.layer));
