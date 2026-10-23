import {
  PluginError,
  PluginRunFinalizedEvent,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { ServerActivation, forkParked } from "../serverActivation.ts";
import * as ServerConfig from "../config.ts";
import { PluginExecutionPolicy } from "./PluginExecutionPolicy.ts";
import { pluginCompatibilityForHost } from "./PluginCompatibility.ts";
import { assertPluginActive } from "./PluginAuthority.ts";
import * as PluginStore from "./PluginStore.ts";
import * as PluginService from "./PluginService.ts";

export class PluginEventDelivery extends Context.Service<
  PluginEventDelivery,
  { readonly drain: Effect.Effect<void>; readonly catchUp: () => Effect.Effect<void> }
>()("t3/plugins/PluginEventDelivery") {}

function finalized(event: OrchestrationV2StoredEvent) {
  return (
    event.event.type === "run.updated" &&
    ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
      event.event.payload.status,
    ) &&
    !event.event.payload.userMessageId.startsWith("plugin:")
  );
}
const observerIntent = (record: PluginStore.StoredInstallation) =>
  !record.removed &&
  record.rawRecord === undefined &&
  record.installation.enabled &&
  record.installation.consentedDigest === record.installation.digest &&
  record.installation.grants.capabilities.includes("events.run-finalized");
const eligible = (record: PluginStore.StoredInstallation) =>
  observerIntent(record) &&
  !record.deliveryError &&
  !record.eventBacklogChoiceRequired &&
  assertPluginActive(record.installation, record.installation.generation) === undefined;
const isPluginError = Schema.is(PluginError);
const transient = (error: unknown) =>
  !isPluginError(error) || ["storage_failed", "busy"].includes(error.reason);
const retrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const policy = yield* PluginExecutionPolicy;
  const executionDisabled = config.pluginsEnabled === false || policy.safeMode;
  const events = yield* ApplicationEvents.OrchestrationEventStore;
  const store = yield* PluginStore.PluginStore;
  const plugins = yield* PluginService.PluginService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const activation = yield* ServerActivation;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const workers = new Map<
    string,
    { scope: Scope.Closeable; worker: DrainableWorker<void>; pending: boolean }
  >();
  const deliverBacklog = Effect.fn("PluginEventDelivery.deliverBacklog")(function* (
    installationId: string,
  ) {
    yield* activation ?? Effect.void;
    const record = (yield* store.read).installations.find(
      (record) => record.installation.installationId === installationId,
    );
    if (executionDisabled || !record || !eligible(record)) return;
    const throughSequence = yield* events.latestApplicationSequence;
    if (throughSequence <= record.eventCursor) return;
    yield* events
      .readAgentEvents({
        afterSequence: record.eventCursor,
        throughSequence,
        eventType: "run.updated",
      })
      .pipe(
        Stream.runForEach(
          Effect.fn("PluginEventDelivery.deliver")(function* (event) {
            if (!finalized(event) || event.event.type !== "run.updated") return;
            const shell = yield* threads.getThreadShell(event.event.threadId);
            if (
              shell === null ||
              shell.deletedAt !== null ||
              !record.installation.grants.projectIds.includes(shell.projectId) ||
              event.sequence <= (record.projectGrantStarts?.[shell.projectId] ?? record.eventCursor)
            )
              return;
            const curated: PluginRunFinalizedEvent = {
              deliveryId: `run-${event.event.payload.id}`,
              threadId: event.event.threadId,
              projectId: shell.projectId,
              runId: event.event.payload.id,
              outcome:
                event.event.payload.status === "completed"
                  ? "completed"
                  : event.event.payload.status === "failed"
                    ? "failed"
                    : "interrupted",
              summary: `${shell.title.slice(0, 200)}: ${event.event.payload.status}.`,
            };
            yield* plugins.deliver({
              installationId,
              generation: record.installation.generation,
              event: curated,
              sequence: event.sequence,
            });
          }),
        ),
      );
    // A failed batch retains its cursor; successful delivery receipts deduplicate its replay.
    yield* store.update((state) => {
      const current = state.installations.find(
        (record) => record.installation.installationId === installationId,
      );
      if (
        !current ||
        !eligible(current) ||
        executionDisabled ||
        current.installation.generation !== record.installation.generation ||
        current.eventCursor >= throughSequence
      )
        return Effect.succeed([undefined, state] as const);
      return Effect.succeed([
        undefined,
        {
          ...state,
          installations: state.installations.map((entry) =>
            entry === current ? { ...entry, eventCursor: throughSequence } : entry,
          ),
        },
      ] as const);
    });
  });
  const checkedRecovery = new WeakSet<PluginStore.StoredInstallation>();
  const schedule = Effect.fn("PluginEventDelivery.schedule")(function* () {
    let state = yield* store.read;
    const unavailable = state.installations.filter(
      (record) =>
        observerIntent(record) &&
        !record.eventBacklogChoiceRequired &&
        (executionDisabled || !pluginCompatibilityForHost(record.installation.manifest).available),
    );
    if (unavailable.length > 0) {
      const latest = yield* events.latestApplicationSequence;
      const unavailableIds = new Set(
        unavailable
          .filter((record) => record.eventCursor < latest)
          .map((record) => record.installation.installationId),
      );
      if (unavailableIds.size > 0) {
        yield* store.update((current) =>
          Effect.succeed([
            undefined,
            {
              ...current,
              installations: current.installations.map((record) =>
                unavailableIds.has(record.installation.installationId)
                  ? { ...record, eventBacklogChoiceRequired: true }
                  : record,
              ),
            },
          ] as const),
        );
        state = yield* store.read;
      }
    }
    if (!executionDisabled) {
      for (const record of state.installations) {
        if (
          !observerIntent(record) ||
          !record.eventBacklogChoiceRequired ||
          record.deliveryError ||
          assertPluginActive(record.installation, record.installation.generation) ||
          checkedRecovery.has(record)
        )
          continue;
        const backlog = yield* plugins.backlog({
          installationId: record.installation.installationId,
        });
        // Review the gap once when it becomes runnable, not on every live event while awaiting a choice.
        checkedRecovery.add(record);
        if (backlog.count !== 0) continue;
        yield* store.update((current) =>
          Effect.succeed([
            undefined,
            {
              ...current,
              installations: current.installations.map((entry) =>
                entry === record
                  ? {
                      ...entry,
                      eventBacklogChoiceRequired: false,
                      eventCursor: Math.max(entry.eventCursor, backlog.throughSequence),
                    }
                  : entry,
              ),
            },
          ] as const),
        );
      }
      state = yield* store.read;
    }
    const ids = new Set(
      state.installations
        .filter((record) => !executionDisabled && eligible(record))
        .map((record) => record.installation.installationId),
    );
    for (const [id, entry] of workers) {
      if (ids.has(id)) continue;
      workers.delete(id);
      // Do not wait for a slow author handler while scheduling other installations.
      yield* Scope.close(entry.scope, Exit.void).pipe(Effect.forkIn(scope));
    }
    for (const id of ids) {
      let entry = workers.get(id);
      if (!entry) {
        const workerScope = yield* Scope.fork(scope);
        const worker = yield* makeDrainableWorker<void, never, never>(() =>
          Effect.gen(function* () {
            const current = workers.get(id);
            if (current) current.pending = false;
            yield* deliverBacklog(id).pipe(
              Effect.retry({ while: transient, schedule: retrySchedule }),
              Effect.catch(() =>
                Effect.logWarning("Plugin observer paused at its durable cursor.", {
                  installationId: id,
                }),
              ),
            );
          }),
        ).pipe(Scope.provide(workerScope));
        entry = { scope: workerScope, worker, pending: false };
        workers.set(id, entry);
      }
      // At most one queued catch-up per installation in addition to the running batch.
      if (!entry.pending) {
        entry.pending = true;
        yield* entry.worker.enqueue(undefined);
      }
    }
  }, lock.withPermits(1));
  let schedulingPending = false;
  const dispatcher = yield* makeDrainableWorker<void, never, never>(() =>
    Effect.gen(function* () {
      schedulingPending = false;
      yield* activation ?? Effect.void;
      yield* schedule().pipe(
        Effect.tapError(() =>
          Effect.logWarning("Plugin event scheduling could not read its durable cursor; retrying."),
        ),
        Effect.retry({ schedule: retrySchedule }),
        Effect.catch(() => Effect.logWarning("Plugin event scheduling remains unavailable.")),
      );
    }),
  );
  const catchUp = Effect.fn("PluginEventDelivery.catchUp")(function* () {
    if (schedulingPending) return;
    schedulingPending = true;
    yield* dispatcher.enqueue(undefined);
  });
  const changes = yield* store.subscribeChanges;
  yield* changes.pipe(
    Stream.mapEffect(() => store.read.pipe(Effect.retry({ schedule: retrySchedule }))),
    Stream.map((state) =>
      state.installations
        .filter(eligible)
        .map((record) => `${record.installation.installationId}:${record.installation.generation}`)
        .join("|"),
    ),
    Stream.changes,
    Stream.runForEach(() => catchUp()),
    Effect.retry({ schedule: retrySchedule }),
    forkParked,
  );
  yield* Stream.unwrap(
    Effect.gen(function* () {
      // Durable cursors own backlog; this stream only wakes coalesced per-installation workers.
      const afterSequence = yield* events.latestApplicationSequence;
      yield* catchUp();
      return events.streamApplicationEvents({ afterSequence });
    }),
  ).pipe(
    Stream.filter((event) => "event" in event && event.event.type === "run.updated"),
    Stream.mapEffect(() => catchUp()),
    Stream.tapError(() => Effect.logWarning("Plugin live event stream interrupted; reconnecting.")),
    Stream.retry(retrySchedule),
    Stream.runDrain,
    forkParked,
  );
  yield* catchUp();
  return PluginEventDelivery.of({
    catchUp,
    drain: dispatcher.drain.pipe(
      Effect.andThen(
        Effect.suspend(() =>
          Effect.forEach([...workers.values()], (entry) => entry.worker.drain, {
            discard: true,
            concurrency: "unbounded",
          }),
        ),
      ),
    ),
  });
});
export const layer = Layer.effect(PluginEventDelivery, make);
