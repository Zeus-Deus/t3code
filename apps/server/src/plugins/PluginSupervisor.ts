// @effect-diagnostics nodeBuiltinImport:off -- Node IPC is the child-process adapter boundary.
import * as NodeChildProcess from "node:child_process";
import {
  PLUGIN_CAPABILITIES,
  PluginError,
  type PluginActionContext,
  type PluginCaller,
  type PluginInvokeResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  resolveSelfInvocation,
  selfInvocationArgs,
  type SelfInvocation,
} from "@t3tools/shared/nodeRuntime";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import {
  MAX_PLUGIN_PENDING_HOST_CALLS,
  decodeChildMessage,
  pluginMessageFits,
  type PluginChildMessage,
  type PluginHostMethod,
  type PluginParentMessage,
  type PluginWorkerImage,
} from "./pluginIpc.ts";

const isPluginError = Schema.is(PluginError);
const workerFaults = new WeakSet<PluginError>();

// Invocation failures share wire reasons with process faults; health tracks only the latter.
export const isPluginWorkerFault = (error: PluginError): boolean => workerFaults.has(error);

export interface PluginExecutionInput {
  readonly installationId: string;
  readonly generation: string;
  readonly directory: string;
  readonly entry: string;
  readonly dataDirectory: string;
  readonly handler: string;
  readonly operationId: string;
  readonly input?: unknown;
  readonly context?: PluginActionContext;
  readonly caller: PluginCaller;
  readonly capabilities?: readonly string[];
}
/** A handler's result plus any image files it named, which the caller must resolve. */
export type PluginWorkerOutput = PluginInvokeResult & {
  readonly workerImages?: ReadonlyArray<PluginWorkerImage>;
};
export type PluginHostCall = (
  method: PluginHostMethod,
  input: unknown,
) => Effect.Effect<unknown, PluginError>;

export class PluginRuntimeConfig extends Context.Reference<{
  readonly selfInvocation?: SelfInvocation;
  readonly startupTimeoutMs: number;
  readonly invocationTimeoutMs: number;
  readonly stopGraceMs: number;
  readonly cancelGraceMs?: number;
  readonly restartBackoffMs: number;
  readonly maxFailures: number;
}>("t3/plugins/PluginRuntimeConfig", {
  defaultValue: () => ({
    startupTimeoutMs: 10_000,
    invocationTimeoutMs: 30_000,
    stopGraceMs: 500,
    restartBackoffMs: 1_000,
    maxFailures: 3,
  }),
}) {}

export class PluginSupervisor extends Context.Service<
  PluginSupervisor,
  {
    readonly invoke: (
      input: PluginExecutionInput,
      hostCall: PluginHostCall,
    ) => Effect.Effect<PluginWorkerOutput, PluginError>;
    readonly stop: (installationId: string) => Effect.Effect<void>;
    readonly resume: (installationId: string) => Effect.Effect<void>;
  }
>()("t3/plugins/PluginSupervisor") {}

type HostRequest = Extract<PluginChildMessage, { type: "host-call" }>;
type PluginLog = Extract<PluginChildMessage, { type: "log" }> & {
  readonly installationId: string;
  readonly generation: string;
};
const logAtLevel = {
  debug: Effect.logDebug,
  info: Effect.logInfo,
  warn: Effect.logWarning,
  error: Effect.logError,
};
interface Invocation {
  readonly done: Deferred.Deferred<PluginWorkerOutput, PluginError>;
  readonly cancelled: Deferred.Deferred<void>;
  readonly requests: Queue.Queue<HostRequest>;
  readonly callIds: Set<string>;
  settled: boolean;
  closed: boolean;
}
interface Worker {
  readonly child: NodeChildProcess.ChildProcess;
  readonly generation: string;
  readonly directory: string;
  readonly entry: string;
  readonly dataDirectory: string;
  readonly ready: Deferred.Deferred<void, PluginError>;
  readonly exited: Deferred.Deferred<void>;
  readonly active: Map<string, Invocation>;
  booted: boolean;
  stopping: boolean;
  failed: boolean;
  messageCount: number;
}

const make = Effect.gen(function* () {
  const config = yield* PluginRuntimeConfig;
  const selfInvocation = config.selfInvocation ?? (yield* resolveSelfInvocation());
  const environment = yield* HostProcess.Environment;
  const scope = yield* Effect.scope;
  const logs = yield* Queue.make<PluginLog>({ capacity: 100, strategy: "dropping" });
  yield* Effect.gen(function* () {
    while (true) {
      const log = yield* Queue.take(logs);
      yield* logAtLevel[log.level](log.message).pipe(
        Effect.annotateLogs({ installationId: log.installationId, generation: log.generation }),
      );
    }
  }).pipe(Effect.forkIn(scope));
  const workers = new Map<string, Worker>();
  const failures = new Map<string, { readonly generation: string; readonly count: number }>();
  const epochs = new Map<string, number>();
  let sequence = 0;
  // Sanitization prevents accidental credential inheritance; it is not a Node security sandbox.
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "WINDIR",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
  ]) {
    const value = environment[key];
    if (value !== undefined) childEnvironment[key] = value;
  }
  childEnvironment.ELECTRON_RUN_AS_NODE = "1";

  const send = (worker: Worker, message: PluginParentMessage) => {
    if (!worker.child.connected || !pluginMessageFits(message)) return false;
    try {
      worker.child.send(message, (error) => {
        if (error) failWorker(worker, "crashed");
      });
      return true;
    } catch {
      return false;
    }
  };
  const failInvocation = (invocation: Invocation, error: PluginError) => {
    invocation.settled = true;
    invocation.closed = true;
    Deferred.doneUnsafe(invocation.done, Effect.fail(error));
    Deferred.doneUnsafe(invocation.cancelled, Effect.void);
  };
  const failWorker = (
    worker: Worker,
    reason: "crashed" | "start_failed" | "invalid_result" | "timeout",
  ) => {
    const error = new PluginError({
      reason,
      message:
        reason === "start_failed"
          ? "Plugin activation failed."
          : reason === "timeout"
            ? "The plugin worker exceeded its deadline."
            : "The plugin worker failed.",
    });
    workerFaults.add(error);
    if (!worker.failed && !worker.stopping) {
      worker.failed = true;
      const installationId = [...workers].find(([, candidate]) => candidate === worker)?.[0];
      if (installationId) {
        const previous = failures.get(installationId);
        failures.set(installationId, {
          generation: worker.generation,
          count: (previous?.generation === worker.generation ? previous.count : 0) + 1,
        });
      }
    }
    Deferred.doneUnsafe(worker.ready, Effect.fail(error));
    for (const invocation of worker.active.values()) failInvocation(invocation, error);
    if (worker.child.exitCode === null && worker.child.signalCode === null)
      worker.child.kill("SIGKILL");
  };
  const stopWorker = Effect.fn("PluginSupervisor.stopWorker")(function* (worker: Worker) {
    worker.stopping = true;
    const error = new PluginError({
      reason: "cancelled",
      message: "Plugin execution was revoked.",
    });
    Deferred.doneUnsafe(worker.ready, Effect.fail(error));
    for (const invocation of worker.active.values()) failInvocation(invocation, error);
    send(worker, { type: "stop" });
    yield* Deferred.await(worker.exited).pipe(
      Effect.timeoutOrElse({
        duration: config.stopGraceMs,
        orElse: () =>
          Effect.sync(() => {
            worker.child.kill("SIGKILL");
          }).pipe(Effect.andThen(Deferred.await(worker.exited))),
      }),
    );
  }, Effect.uninterruptible);

  const stop = Effect.fn("PluginSupervisor.stop")(function* (installationId: string) {
    epochs.set(installationId, (epochs.get(installationId) ?? 0) + 1);
    const worker = workers.get(installationId);
    if (worker) {
      yield* stopWorker(worker);
      if (workers.get(installationId) === worker) workers.delete(installationId);
    }
  }, Effect.uninterruptible);

  const acquireWorker = Effect.fn("PluginSupervisor.acquireWorker")(function* (
    input: PluginExecutionInput,
    epoch: number,
  ) {
    const previous = failures.get(input.installationId);
    if (previous && previous.generation !== input.generation) failures.delete(input.installationId);
    const failureCount = failures.get(input.installationId)?.count ?? 0;
    if (failureCount >= config.maxFailures)
      return yield* new PluginError({
        reason: "quarantined",
        message: "This plugin repeatedly failed. Resume it to try again.",
      });
    if (!workers.has(input.installationId) && failureCount > 0)
      yield* Effect.sleep(Math.min(30_000, config.restartBackoffMs * 2 ** (failureCount - 1)));
    let created = false;
    const worker = yield* Effect.try({
      try: () => {
        if ((epochs.get(input.installationId) ?? 0) !== epoch)
          throw new PluginError({ reason: "cancelled", message: "Plugin execution was revoked." });
        const existing = workers.get(input.installationId);
        if (existing) {
          if (
            existing.stopping ||
            existing.generation !== input.generation ||
            existing.directory !== input.directory ||
            existing.entry !== input.entry ||
            existing.dataDirectory !== input.dataDirectory
          )
            throw new PluginError({
              reason: "stale_generation",
              message: "The plugin worker belongs to another generation.",
            });
          if (existing.failed)
            throw new PluginError({
              reason: "crashed",
              message: "The plugin worker is stopping after a failure.",
            });
          return existing;
        }
        const child = NodeChildProcess.spawn(
          selfInvocation.command,
          [...selfInvocationArgs(selfInvocation, ["plugin-host"])],
          {
            cwd: input.directory,
            env: childEnvironment,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            windowsHide: true,
          },
        );
        const worker: Worker = {
          child,
          generation: input.generation,
          directory: input.directory,
          entry: input.entry,
          dataDirectory: input.dataDirectory,
          ready: Deferred.makeUnsafe(),
          exited: Deferred.makeUnsafe(),
          active: new Map(),
          booted: false,
          stopping: false,
          failed: false,
          messageCount: 0,
        };
        workers.set(input.installationId, worker);
        created = true;
        const receive = (raw: unknown) => {
          let message: PluginChildMessage;
          try {
            if (!pluginMessageFits(raw)) throw new Error("IPC limit");
            message = decodeChildMessage(raw);
            if (++worker.messageCount > 10_000) throw new Error("IPC count limit");
          } catch {
            failWorker(worker, "invalid_result");
            return;
          }
          if (worker.stopping || worker.failed) return;
          if (message.type !== "booted" && !worker.booted) {
            failWorker(worker, "invalid_result");
            return;
          }
          switch (message.type) {
            case "booted":
              if (worker.booted) {
                failWorker(worker, "invalid_result");
                break;
              }
              worker.booted = true;
              if (
                !send(worker, {
                  type: "init",
                  protocol: 1,
                  directory: input.directory,
                  entry: input.entry,
                  dataDirectory: input.dataDirectory,
                  capabilities: [...(input.capabilities ?? PLUGIN_CAPABILITIES)],
                })
              )
                failWorker(worker, "start_failed");
              break;
            case "ready":
              Deferred.doneUnsafe(worker.ready, Effect.void);
              break;
            case "cancelled": {
              const invocation = worker.active.get(message.invocationId);
              if (invocation?.closed) Deferred.doneUnsafe(invocation.cancelled, Effect.void);
              worker.messageCount = 0;
              break;
            }
            case "failure": {
              if (message.invocationId === undefined) failWorker(worker, "start_failed");
              else {
                const invocation = worker.active.get(message.invocationId);
                if (invocation)
                  failInvocation(
                    invocation,
                    new PluginError({
                      reason: "operation_failed",
                      message: message.message?.trim()
                        ? message.message
                        : "The plugin handler failed.",
                    }),
                  );
                worker.messageCount = 0;
              }
              break;
            }
            case "result": {
              const invocation = worker.active.get(message.invocationId);
              if (invocation && !invocation.closed) {
                invocation.settled = true;
                invocation.closed = true;
                Deferred.doneUnsafe(
                  invocation.done,
                  Effect.succeed({
                    ...message.result,
                    ...(message.images === undefined ? {} : { workerImages: message.images }),
                  }),
                );
              }
              break;
            }
            case "host-call": {
              const invocation = worker.active.get(message.invocationId);
              if (!invocation || invocation.closed) {
                send(worker, {
                  type: "host-result",
                  invocationId: message.invocationId,
                  callId: message.callId,
                  ok: false,
                });
                break;
              }
              if (invocation.callIds.has(message.callId)) {
                failWorker(worker, "invalid_result");
                break;
              }
              if (
                invocation.callIds.size >= MAX_PLUGIN_PENDING_HOST_CALLS ||
                !Queue.offerUnsafe(invocation.requests, message)
              ) {
                send(worker, {
                  type: "host-result",
                  invocationId: message.invocationId,
                  callId: message.callId,
                  ok: false,
                });
                break;
              }
              invocation.callIds.add(message.callId);
              break;
            }
            case "log":
              Queue.offerUnsafe(logs, {
                ...message,
                installationId: input.installationId,
                generation: input.generation,
              });
              break;
          }
        };
        child.on("message", receive);
        // Drain without retaining output or accumulating a lifetime quota.
        child.stdout?.resume();
        child.stderr?.resume();
        child.once("error", () => {
          failWorker(worker, "start_failed");
          if (workers.get(input.installationId) === worker) workers.delete(input.installationId);
          Deferred.doneUnsafe(worker.exited, Effect.void);
        });
        child.once("exit", () => {
          if (!worker.stopping) failWorker(worker, "crashed");
          if (workers.get(input.installationId) === worker) workers.delete(input.installationId);
          Deferred.doneUnsafe(worker.exited, Effect.void);
        });
        return worker;
      },
      catch: (error) => {
        if (isPluginError(error)) {
          if (error.reason === "crashed") workerFaults.add(error);
          return error;
        }
        const fault = new PluginError({
          reason: "start_failed",
          message: "Could not launch the plugin worker.",
        });
        workerFaults.add(fault);
        return fault;
      },
    });
    if (created) {
      // Startup remains bounded even if its first caller disconnects before activation.
      yield* Deferred.await(worker.ready).pipe(
        Effect.timeoutOrElse({
          duration: config.startupTimeoutMs,
          orElse: () => Effect.sync(() => failWorker(worker, "timeout")),
        }),
        Effect.ignore,
        Effect.forkIn(scope),
      );
    }
    return worker;
  });

  const invoke = Effect.fn("PluginSupervisor.invoke")(function* (
    input: PluginExecutionInput,
    hostCall: PluginHostCall,
  ) {
    if (!pluginMessageFits(input))
      return yield* new PluginError({
        reason: "invalid_input",
        message: "Plugin input exceeds the transport limit.",
      });
    const epoch = epochs.get(input.installationId) ?? 0;
    const worker = yield* acquireWorker(input, epoch);
    const execute = Effect.gen(function* () {
      yield* Deferred.await(worker.ready);
      if (worker.stopping || worker.failed || (epochs.get(input.installationId) ?? 0) !== epoch)
        return yield* new PluginError({
          reason: "cancelled",
          message: "Plugin execution was revoked.",
        });
      if (worker.active.size >= 8)
        return yield* new PluginError({
          reason: "busy",
          message: "This plugin has too many active invocations.",
        });
      const requests = yield* Queue.make<HostRequest>({
        capacity: MAX_PLUGIN_PENDING_HOST_CALLS,
        strategy: "dropping",
      });
      const invocation: Invocation = {
        requests,
        done: Deferred.makeUnsafe(),
        cancelled: Deferred.makeUnsafe(),
        callIds: new Set(),
        closed: false,
        settled: false,
      };
      const invocationId = String(++sequence);
      worker.active.set(invocationId, invocation);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          invocation.closed = true;
          if (!invocation.settled && !worker.failed && !worker.stopping) {
            if (!send(worker, { type: "cancel", invocationId })) failWorker(worker, "crashed");
            yield* Deferred.await(invocation.cancelled).pipe(
              Effect.timeoutOrElse({
                duration: config.cancelGraceMs ?? 500,
                orElse: () => Effect.sync(() => failWorker(worker, "timeout")),
              }),
            );
          }
          worker.active.delete(invocationId);
          if (worker.failed) yield* Deferred.await(worker.exited);
        }),
      );
      yield* Effect.gen(function* () {
        while (true) {
          const request = yield* Queue.take(requests);
          if (invocation.closed || worker.stopping || worker.failed) continue;
          // The callback belongs to this invocation, and is interrupted when it ends.
          const result = yield* Effect.exit(hostCall(request.method, request.input));
          if (invocation.closed || worker.stopping || worker.failed) continue;
          const failure = Exit.isFailure(result)
            ? result.cause.reasons.find(Cause.isFailReason)?.error
            : undefined;
          const error = isPluginError(failure)
            ? {
                reason: failure.reason,
                message: failure.message,
                ...(failure.code === undefined ? {} : { code: failure.code }),
                ...(failure.priorEffect === undefined ? {} : { priorEffect: failure.priorEffect }),
              }
            : undefined;
          const message: PluginParentMessage =
            Exit.isSuccess(result) && pluginMessageFits({ value: result.value })
              ? {
                  type: "host-result",
                  invocationId,
                  callId: request.callId,
                  ok: true,
                  value: result.value,
                }
              : {
                  type: "host-result",
                  invocationId,
                  callId: request.callId,
                  ok: false,
                  ...(error === undefined ? {} : { error }),
                };
          if (!send(worker, message)) failWorker(worker, "crashed");
        }
      }).pipe(Effect.forkScoped);
      if (
        !send(worker, {
          type: "invoke",
          invocationId,
          operationId: input.operationId,
          handler: input.handler,
          ...(input.input === undefined ? {} : { input: input.input }),
          ...(input.context === undefined ? {} : { context: input.context }),
          caller: input.caller,
        })
      )
        return yield* new PluginError({
          reason: "crashed",
          message: "The plugin worker disconnected.",
        });
      return yield* Deferred.await(invocation.done).pipe(
        Effect.timeoutOrElse({
          duration: config.invocationTimeoutMs,
          orElse: () =>
            Effect.fail(
              new PluginError({
                reason: "timeout",
                message: "Plugin invocation exceeded its deadline.",
              }),
            ),
        }),
      );
    }).pipe(Effect.scoped);
    return yield* execute.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          // A deadline starts locally, but a missing cancel acknowledgement escalates it.
          if (worker.failed) workerFaults.add(error);
        }),
      ),
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit))
          return Effect.sync(() => {
            if (!worker.failed && !worker.stopping) failures.delete(input.installationId);
            worker.messageCount = 0;
          });
        return worker.failed ? Deferred.await(worker.exited) : Effect.void;
      }),
    );
  });
  const resume = Effect.fn("PluginSupervisor.resume")(function* (installationId: string) {
    yield* stop(installationId);
    failures.delete(installationId);
  });
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...workers.keys()], stop, { concurrency: "unbounded", discard: true }),
  );
  return PluginSupervisor.of({ invoke, stop, resume });
});

export const layer = Layer.effect(PluginSupervisor, make);
