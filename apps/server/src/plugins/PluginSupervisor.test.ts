// @effect-diagnostics nodeBuiltinImport:off -- these fixtures spawn the real Node IPC entrypoint.
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { PluginError, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as TestClock from "effect/testing/TestClock";
import * as PluginSupervisor from "./PluginSupervisor.ts";

const runtimeLayer = PluginSupervisor.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(
    Layer.succeed(PluginSupervisor.PluginRuntimeConfig, {
      selfInvocation: {
        command: process.execPath,
        entrypoint: NodePath.resolve(import.meta.dirname, "../bin.ts"),
      },
      startupTimeoutMs: 10_000,
      invocationTimeoutMs: 10_000,
      cancelGraceMs: 500,
      stopGraceMs: 0,
      restartBackoffMs: 0,
      maxFailures: 2,
    }),
  ),
  Layer.provide(
    Layer.succeed(HostProcess.Environment, {
      ...process.env,
      T3_PLUGIN_TEST_SECRET: "must-not-reach-worker",
    }),
  ),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-runtime-" });
  yield* fs.writeFileString(
    NodePath.join(directory, "plugin.mjs"),
    `
    let release;
    let late;
    export async function activate(ctx) {
      let activationDenied = false;
      try { await ctx.storage.get("activation"); } catch { activationDenied = true; }
      ctx.handle("action:echo", async (input, invocation) => {
        await ctx.storage.set("value", input);
        const caller = await ctx.settings.get("caller");
        return {data: {input, caller, operationId: invocation.operationId, activationDenied, leaked: process.env.T3_PLUGIN_TEST_SECRET ?? null}};
      });
      ctx.handle("action:hang", async () => { await ctx.storage.get("entered"); await new Promise(() => {}); });
      ctx.handle("action:spin", async () => { await ctx.storage.get("entered"); while (true) {} });
      ctx.handle("action:spin-on-cancel", async (_, invocation) => {
        invocation.signal.addEventListener("abort", () => { while (true) {} });
        await ctx.storage.get("entered");
        await new Promise(() => {});
      });
      ctx.handle("action:crash", () => { process.exit(42); });
      ctx.handle("action:fault", async mode => {
        await ctx.storage.get("fault-armed");
        if (mode === "throw") throw new Error("Isolated handler failure");
        if (mode === "hang") await new Promise(() => {});
        if (mode === "spin") while (true) {}
        if (mode === "crash") process.exit(42);
        if (mode === "malformed") process.send({type: "log", level: "invalid", message: "invalid protocol"});
        if (mode === "flood") {
          for (let index = 0; index < 10001; index++) {
            process.send({type: "log", level: "debug", message: "bounded adversarial IPC"});
          }
        }
        return {};
      });
      ctx.handle("action:throw", input => {
        const error = new Error(input ?? "ordinary handler failure");
        error.stack = "PRIVATE HANDLER STACK";
        throw error;
      });
      ctx.handle("action:throw-value", input => { throw input; });
      ctx.handle("action:throw-unusable-message", input => {
        const error = new Error();
        Object.defineProperty(error, "message", input === "getter"
          ? {get() { throw new Error("PRIVATE MESSAGE GETTER FAILURE"); }}
          : {value: input});
        throw error;
      });
      ctx.handle("action:invalid-result", () => ({message: false}));
      ctx.handle("action:oversize-result", () => ({message: "PRIVATE RESULT DIAGNOSTIC".repeat(1000)}));
      ctx.handle("action:future-intent", () => ({intents: [{type: "future.intent"}, {type: "composer.insert", text: "known"}]}));
      ctx.handle("action:protocol", () => { process.send({type: "log", level: "invalid", message: "invalid protocol"}); return {}; });
      ctx.handle("action:hold", async () => ({data: await ctx.storage.get("hold")}));
      ctx.events.onRunFinalized(async () => ({data: await ctx.storage.get("observer")}));
      ctx.handle("action:pid", () => ({data: process.pid}));
      ctx.handle("action:forget", async () => {
        ctx.storage.set("k", 1);
        return {message: "done", data: process.pid};
      });
      ctx.handle("action:catch-host-rejection", async () => {
        try { await ctx.storage.set("k", 1); }
        catch { return {message: "caught"}; }
        return {message: "unexpected success"};
      });
      ctx.handle("action:inspect-host-error", async () => {
        try { await ctx.threads.send({threadId:"thread", text:"hello", idempotencyKey:"review"}); }
        catch (error) {
          return {data:{message:error.message,reason:error.reason,code:error.code,priorEffect:error.priorEffect,stack:error.stack}};
        }
        return {message:"unexpected success"};
      });
      ctx.handle("action:reads", async count => ({data: await Promise.all(Array.from({length: count}, (_, index) => ctx.storage.get(String(index))))}));
      ctx.handle("action:burst", async count => {
        const results = await Promise.allSettled(Array.from({length: count}, (_, index) => ctx.storage.get(String(index))));
        return {data: {accepted: results.filter(result => result.status === "fulfilled").length, rejected: results.filter(result => result.status === "rejected").length}};
      });
      ctx.handle("action:serial", async count => {
        let accepted = 0, rejected = 0;
        for (let index = 0; index < count; index++) {
          try { await ctx.storage.get(String(index)); accepted++; } catch { rejected++; }
        }
        return {data: {accepted, rejected}};
      });
      ctx.handle("action:logs", () => {
        ctx.log("info", "x".repeat(2000));
        process.stdout.write("x".repeat(4000));
        process.stderr.write("x".repeat(4000));
        return {data: process.pid};
      });
      ctx.handle("action:log-levels", () => {
        for (const level of ["debug", "info", "warn", "error"]) ctx.log(level, level + ":" + "x".repeat(2500));
        return {};
      });
      ctx.handle("action:late-start", () => {
        late = new Promise(resolve => { release = resolve; }).then(() => ctx.storage.set("late", true)).then(() => "allowed", () => "denied");
        return {};
      });
      ctx.handle("action:late-hold", async () => {
        late = new Promise(resolve => { release = resolve; }).then(() => ctx.storage.set("late", true)).then(() => "allowed", () => "denied");
        await ctx.storage.get("entered");
        await new Promise(() => {});
      });
      ctx.handle("action:late-release", async () => { release(); return {data: await late}; });
      ctx.handle("action:identity", (_input, invocation) => {
        try { invocation.caller.threadId = "forged"; } catch {}
        try { invocation.caller.subagentOf = "forged"; } catch {}
        try { invocation.context.subagentOf = "forged"; } catch {}
        try { invocation.caller.lineage = "forged"; } catch {}
        try { invocation.context.lineage = "forged"; } catch {}
        return {
          data: { caller: invocation.caller, context: invocation.context, dataDirectory: ctx.dataDirectory },
          images: [{ path: "assets/screen.png", mimeType: "image/png" }],
        };
      });
      ctx.handle("action:send", async () => ({data: await ctx.threads.send({threadId: "thread", text: "hello", idempotencyKey: "review"})}));
    }
  `,
  );
  return {
    installationId: "test.plugin",
    generation: "generation-1",
    directory,
    entry: "plugin.mjs",
    dataDirectory: directory,
    caller: { kind: "client" as const },
    handler: "action:echo",
    operationId: "operation-1",
  };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.merge(runtimeLayer, NodeServices.layer)), Effect.scoped);

describe("PluginSupervisor real child", () => {
  it.effect.each([
    { mode: "throw", reason: "operation_failed", workerFault: false },
    { mode: "hang", reason: "timeout", workerFault: false },
    { mode: "spin", reason: "timeout", workerFault: true },
    { mode: "crash", reason: "crashed", workerFault: true },
    { mode: "malformed", reason: "invalid_result", workerFault: true },
    { mode: "flood", reason: "invalid_result", workerFault: true },
  ])("isolates $mode faults from another installation's actual worker", (testCase) =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const faulty = yield* fixture;
        const healthy = { ...(yield* fixture), installationId: "healthy.plugin" };
        const faultyPid = yield* supervisor.invoke(
          { ...faulty, handler: "action:pid" },
          () => Effect.void,
        );
        const healthyPid = yield* supervisor.invoke(
          { ...healthy, handler: "action:pid" },
          () => Effect.void,
        );
        expect(healthyPid.data).not.toBe(faultyPid.data);
        const healthyEntered = yield* Deferred.make<void>();
        const releaseHealthy = yield* Deferred.make<string>();
        const held = yield* supervisor
          .invoke({ ...healthy, handler: "action:hold", operationId: "healthy-held" }, () =>
            Deferred.succeed(healthyEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseHealthy)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(healthyEntered);
        const faultyEntered = yield* Deferred.make<void>();
        const failing = yield* supervisor
          .invoke({ ...faulty, handler: "action:fault", input: testCase.mode }, () =>
            Deferred.succeed(faultyEntered, undefined),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(faultyEntered);
        const duringFault = yield* supervisor.invoke(
          { ...healthy, input: "during-fault", operationId: "healthy-during" },
          (method) => Effect.succeed(method === "settings.get" ? "healthy caller" : null),
        );
        expect(duringFault.data).toMatchObject({
          input: "during-fault",
          caller: "healthy caller",
          operationId: "healthy-during",
        });
        yield* Deferred.succeed(releaseHealthy, "healthy held call completed");
        expect(yield* Fiber.await(held)).toEqual(
          Exit.succeed({ data: "healthy held call completed" }),
        );
        if (testCase.reason === "timeout")
          yield* TestClock.adjust(testCase.workerFault ? 10_500 : 10_000);
        const failure = yield* Fiber.join(failing).pipe(Effect.flip);
        expect(failure.reason).toBe(testCase.reason);
        expect(PluginSupervisor.isPluginWorkerFault(failure)).toBe(testCase.workerFault);
        yield* supervisor.stop(faulty.installationId);
        const afterFault = yield* supervisor.invoke(
          { ...healthy, handler: "action:pid" },
          () => Effect.void,
        );
        expect(afterFault.data).toBe(healthyPid.data);
      }),
    ),
  );

  it.effect("delivers the host caller and data directory and returns named images", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const result = yield* supervisor.invoke(
          {
            ...input,
            handler: "action:identity",
            caller: {
              kind: "agent",
              threadId: ThreadId.make("thread:verified"),
              subagentOf: ThreadId.make("thread:owner"),
            },
            context: {
              threadId: ThreadId.make("thread:target"),
              subagentOf: ThreadId.make("thread:target-owner"),
            },
          },
          () => Effect.void,
        );
        expect(result.data).toEqual({
          caller: { kind: "agent", threadId: "thread:verified", subagentOf: "thread:owner" },
          context: { threadId: "thread:target", subagentOf: "thread:target-owner" },
          dataDirectory: input.dataDirectory,
        });
        expect(result.images).toBeUndefined();
        expect(result.workerImages).toEqual([{ path: "assets/screen.png", mimeType: "image/png" }]);
      }),
    ),
  );

  it.effect("preserves unresolved lineage across IPC and freezes it in the child", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const result = yield* supervisor.invoke(
          {
            ...input,
            handler: "action:identity",
            caller: {
              kind: "agent",
              threadId: ThreadId.make("thread:verified"),
              lineage: "unresolved",
            },
            context: {
              threadId: ThreadId.make("thread:target"),
              lineage: "unresolved",
            },
          },
          () => Effect.void,
        );
        expect(result.data).toEqual({
          caller: { kind: "agent", threadId: "thread:verified", lineage: "unresolved" },
          context: { threadId: "thread:target", lineage: "unresolved" },
          dataDirectory: input.dataDirectory,
        });
      }),
    ),
  );

  it.effect("runs source-bin CLI dispatch and isolates concurrent host authority", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const calls: string[] = [];
        const invoke = (caller: string) =>
          supervisor.invoke({ ...input, input: caller, operationId: caller }, (method) => {
            calls.push(`${caller}:${method}`);
            return Effect.succeed(method === "settings.get" ? caller : undefined);
          });
        const results = yield* Effect.all([invoke("first"), invoke("second")], {
          concurrency: "unbounded",
        });
        expect(results.map((result) => result.data)).toEqual([
          {
            input: "first",
            caller: "first",
            operationId: "first",
            activationDenied: true,
            leaked: null,
          },
          {
            input: "second",
            caller: "second",
            operationId: "second",
            activationDenied: true,
            leaked: null,
          },
        ]);
        expect(calls).toHaveLength(4);
        yield* supervisor.stop(input.installationId);
      }),
    ),
  );

  it.effect("revokes async work inherited from an already completed invocation", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        let hostCalls = 0;
        const host = () =>
          Effect.sync(() => {
            hostCalls++;
          });
        yield* supervisor.invoke({ ...input, handler: "action:late-start" }, host);
        const result = yield* supervisor.invoke({ ...input, handler: "action:late-release" }, host);
        expect(result.data).toBe("denied");
        expect(hostCalls).toBe(0);
      }),
    ),
  );

  it.effect("passes author idempotency keys through host calls", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const received: unknown[] = [];
        const result = yield* supervisor.invoke(
          { ...input, handler: "action:send" },
          (method, payload) => {
            received.push({ method, payload });
            return Effect.succeed({ threadId: "thread" });
          },
        );
        expect(result.data).toEqual({ threadId: "thread" });
        expect(received).toEqual([
          {
            method: "threads.send",
            payload: { threadId: "thread", text: "hello", idempotencyKey: "review" },
          },
        ]);
      }),
    ),
  );

  it.effect("terminates CPU-hung children after cancel grace and quarantines repeated faults", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        for (const _ of [1, 2]) {
          const entered = yield* Deferred.make<void>();
          const running = yield* supervisor
            .invoke({ ...input, handler: "action:spin" }, () =>
              Deferred.succeed(entered, undefined),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* TestClock.adjust(10_500);
          const failure = yield* Fiber.join(running).pipe(Effect.flip);
          expect(failure.reason).toBe("timeout");
          expect(PluginSupervisor.isPluginWorkerFault(failure)).toBe(true);
        }
        const quarantined = yield* supervisor.invoke(input, () => Effect.void).pipe(Effect.flip);
        expect(quarantined.reason).toBe("quarantined");
        // A new generation can start only after the captured old worker exited.
        const result = yield* supervisor.invoke(
          { ...input, generation: "generation-2", input: "fresh" },
          () => Effect.succeed("fresh"),
        );
        expect(result.data).toMatchObject({ caller: "fresh" });
      }),
    ),
  );

  it.effect("stop revokes host calls and waits for child exit", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const entered = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        const running = yield* supervisor
          .invoke({ ...input, handler: "action:hang" }, () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(finished, undefined)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* supervisor.stop(input.installationId);
        const error = yield* Fiber.join(running).pipe(Effect.flip);
        yield* Deferred.await(finished);
        expect(error.reason).toBe("cancelled");
        const result = yield* supervisor.invoke({ ...input, generation: "generation-2" }, () =>
          Effect.succeed("new"),
        );
        expect(result.data).toMatchObject({ caller: "new" });
      }),
    ),
  );

  it.effect("responsive invocation deadlines preserve siblings and never quarantine", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const entered = yield* Deferred.make<void>();
        const revoked = yield* Deferred.make<void>();
        const running = yield* supervisor
          .invoke({ ...input, handler: "action:late-hold" }, () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(revoked, undefined)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        // The sibling has its own later deadline, so only the first caller expires.
        yield* TestClock.adjust(1);
        const siblingEntered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<string>();
        const sibling = yield* supervisor
          .invoke({ ...input, handler: "action:hold", operationId: "sibling" }, () =>
            Deferred.succeed(siblingEntered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(siblingEntered);
        yield* TestClock.adjust(9_999);
        const error = yield* Fiber.join(running).pipe(Effect.flip);
        expect(error.reason).toBe("timeout");
        expect(PluginSupervisor.isPluginWorkerFault(error)).toBe(false);
        yield* Deferred.await(revoked);
        yield* Deferred.succeed(release, "sibling completed");
        expect(yield* Fiber.await(sibling)).toEqual(Exit.succeed({ data: "sibling completed" }));
        let escaped = 0;
        const inherited = yield* supervisor.invoke(
          { ...input, handler: "action:late-release" },
          () => Effect.sync(() => escaped++),
        );
        expect(inherited.data).toBe("denied");
        expect(escaped).toBe(0);
        for (const _ of [1, 2, 3]) {
          const enteredAgain = yield* Deferred.make<void>();
          const next = yield* supervisor
            .invoke({ ...input, handler: "action:hang" }, () =>
              Deferred.succeed(enteredAgain, undefined),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(enteredAgain);
          yield* TestClock.adjust(10_000);
          const failure = yield* Fiber.join(next).pipe(Effect.flip);
          expect(failure.reason).toBe("timeout");
          expect(PluginSupervisor.isPluginWorkerFault(failure)).toBe(false);
        }
        const healthy = yield* supervisor.invoke(input, () => Effect.succeed("healthy"));
        expect(healthy.data).toMatchObject({ caller: "healthy" });
      }),
    ),
  );

  it.effect("keeps unsupported-intent metadata across the child IPC boundary", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const result = yield* supervisor.invoke(
          { ...input, handler: "action:future-intent" },
          () => Effect.void,
        );
        expect(result).toEqual({
          intents: [{ type: "composer.insert", text: "known" }],
          unsupportedIntentCount: 1,
        });
      }),
    ),
  );

  it.effect("interrupting a caller revokes only its invocation and pending host work", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const entered = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        const siblingEntered = yield* Deferred.make<void>();
        const releaseSibling = yield* Deferred.make<string>();
        const sibling = yield* supervisor
          .invoke({ ...input, handler: "action:hold", operationId: "sibling" }, () =>
            Deferred.succeed(siblingEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseSibling)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(siblingEntered);
        const running = yield* supervisor
          .invoke({ ...input, handler: "action:late-hold" }, () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(finished, undefined)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(running);
        yield* Deferred.await(finished);
        const exit = yield* Fiber.await(running);
        expect(Exit.isFailure(exit)).toBe(true);
        yield* Deferred.succeed(releaseSibling, "sibling completed");
        const siblingExit = yield* Fiber.await(sibling);
        expect(siblingExit).toEqual(Exit.succeed({ data: "sibling completed" }));
        let escaped = 0;
        const inherited = yield* supervisor.invoke(
          { ...input, handler: "action:late-release" },
          () => Effect.sync(() => escaped++),
        );
        expect(inherited.data).toBe("denied");
        expect(escaped).toBe(0);
      }),
    ),
  );

  it.effect("forwards bounded handler errors while preserving siblings and the same worker", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const pid = yield* supervisor.invoke(
          { ...input, handler: "action:pid" },
          () => Effect.void,
        );
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<string>();
        const sibling = yield* supervisor
          .invoke({ ...input, handler: "action:hold" }, () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const repositoryMessage =
          "Set Repository path in Repository Lens settings to an absolute Git working-tree path on this server.";
        const generic = "The plugin handler failed.";
        for (const testCase of [
          { handler: "action:throw", input: repositoryMessage, message: repositoryMessage },
          { handler: "action:throw", input: "x".repeat(5000), message: "x".repeat(2000) },
          { handler: "action:throw-value", input: "PRIVATE THROW TEXT", message: generic },
          {
            handler: "action:throw-value",
            input: { message: "PRIVATE OBJECT MESSAGE", stack: "PRIVATE OBJECT STACK" },
            message: generic,
          },
          { handler: "action:throw-value", input: null, message: generic },
          { handler: "action:throw", input: "", message: generic },
          { handler: "action:throw", input: " \n\t", message: generic },
          { handler: "action:throw-unusable-message", input: 42, message: generic },
          { handler: "action:throw-unusable-message", input: "getter", message: generic },
          { handler: "action:invalid-result", message: generic },
          { handler: "action:oversize-result", message: generic },
        ]) {
          const error = yield* supervisor
            .invoke(
              { ...input, handler: testCase.handler, input: testCase.input },
              () => Effect.void,
            )
            .pipe(Effect.flip);
          expect(error.reason).toBe("operation_failed");
          expect(error.message).toBe(testCase.message);
          expect(error.message.length).toBeLessThanOrEqual(2000);
          expect(PluginSupervisor.isPluginWorkerFault(error)).toBe(false);
        }
        yield* Deferred.succeed(release, "healthy");
        expect(yield* Fiber.await(sibling)).toEqual(Exit.succeed({ data: "healthy" }));
        const next = yield* supervisor.invoke(input, () => Effect.succeed("healthy"));
        expect(next.data).toMatchObject({ caller: "healthy" });
        const sameWorker = yield* supervisor.invoke(
          { ...input, handler: "action:pid" },
          () => Effect.void,
        );
        expect(sameWorker.data).toBe(pid.data);
      }),
    ),
  );

  it.effect("unawaited host calls preserve siblings and the worker with bounded warnings", () =>
    Effect.gen(function* () {
      const logs: {
        level: string;
        message: string;
        annotations: Readonly<Record<string, unknown>>;
      }[] = [];
      const warnings = yield* Queue.make<void>({ capacity: 100, strategy: "dropping" });
      const logger = Logger.make(({ fiber, message, logLevel }) => {
        logs.push({
          level: logLevel,
          message: String(message),
          annotations: fiber.getRef(References.CurrentLogAnnotations),
        });
        Queue.offerUnsafe(warnings, undefined);
      });
      yield* provide(
        Effect.gen(function* () {
          const supervisor = yield* PluginSupervisor.PluginSupervisor;
          const input = yield* fixture;
          const pid = yield* supervisor.invoke(
            { ...input, handler: "action:pid" },
            () => Effect.void,
          );
          yield* supervisor.invoke({ ...input, handler: "action:log-levels" }, () => Effect.void);
          for (const _ of [1, 2, 3, 4]) yield* Queue.take(warnings);
          const siblingEntered = yield* Deferred.make<void>();
          const observerEntered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<string>();
          const sibling = yield* supervisor
            .invoke({ ...input, handler: "action:hold", operationId: "sibling" }, () =>
              Deferred.succeed(siblingEntered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
              ),
            )
            .pipe(Effect.forkChild);
          const observer = yield* supervisor
            .invoke(
              {
                ...input,
                handler: "event:run.finalized",
                operationId: "observer",
                input: {
                  deliveryId: "delivery-1",
                  threadId: "thread-1",
                  projectId: "project-1",
                  runId: "run-1",
                  outcome: "completed",
                },
              },
              () =>
                Deferred.succeed(observerEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                ),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(siblingEntered);
          yield* Deferred.await(observerEntered);
          const releaseWrites = yield* Deferred.make<void>();
          let started = 0;
          let revoked = 0;
          let committed = 0;
          // Exceed both the quarantine threshold and the shared child log budget.
          for (let index = 0; index < 110; index++) {
            const result = yield* supervisor.invoke(
              { ...input, handler: "action:forget", operationId: `forget-${index}` },
              (method, payload) => {
                expect(method).toBe("storage.set");
                expect(payload).toEqual({ key: "k", value: 1 });
                return Effect.sync(() => started++).pipe(
                  Effect.andThen(Deferred.await(releaseWrites)),
                  Effect.andThen(Effect.sync(() => committed++)),
                  Effect.ensuring(Effect.sync(() => revoked++)),
                );
              },
            );
            expect(result).toEqual({ message: "done", data: pid.data });
            if (index < 96) {
              // A worker crash completes the sibling instead of leaving this wait hanging.
              const milestone = yield* Effect.raceFirst(
                Queue.take(warnings).pipe(Effect.as("warning")),
                Fiber.await(sibling),
              );
              expect(milestone).toBe("warning");
            }
          }
          yield* Deferred.succeed(releaseWrites, undefined);
          expect(revoked).toBe(started);
          expect(committed).toBe(0);
          yield* Deferred.succeed(release, "healthy");
          expect(yield* Fiber.await(sibling)).toEqual(Exit.succeed({ data: "healthy" }));
          expect(yield* Fiber.await(observer)).toEqual(Exit.succeed({ data: "healthy" }));
          const next = yield* supervisor.invoke(
            { ...input, handler: "action:pid" },
            () => Effect.void,
          );
          expect(next.data).toBe(pid.data);
          expect(logs).toHaveLength(100);
          expect(logs.slice(0, 4).map((log) => log.level)).toEqual([
            "Debug",
            "Info",
            "Warn",
            "Error",
          ]);
          expect(
            logs
              .slice(4)
              .every(
                (log) =>
                  log.level === "Warn" &&
                  log.message.includes("Unhandled plugin promise rejection") &&
                  log.message.includes("Await") &&
                  log.message.length <= 2_000 &&
                  log.annotations.installationId === input.installationId &&
                  log.annotations.generation === input.generation,
              ),
          ).toBe(true);
        }),
      ).pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      );
    }),
  );

  it.effect("awaited host rejections remain observable without worker faults", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const pid = yield* supervisor.invoke(
          { ...input, handler: "action:pid" },
          () => Effect.void,
        );
        const reject = () =>
          Effect.fail(new PluginError({ reason: "permission_denied", message: "Denied" }));
        const error = yield* supervisor.invoke(input, reject).pipe(Effect.flip);
        expect(error.reason).toBe("operation_failed");
        expect(PluginSupervisor.isPluginWorkerFault(error)).toBe(false);
        const caught = yield* supervisor.invoke(
          { ...input, handler: "action:catch-host-rejection" },
          reject,
        );
        expect(caught).toEqual({ message: "caught" });
        const next = yield* supervisor.invoke(
          { ...input, handler: "action:pid" },
          () => Effect.void,
        );
        expect(next.data).toBe(pid.data);
      }),
    ),
  );

  it.effect("lets plugin authors handle an idempotency conflict without exposing host stacks", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const conflict = new PluginError({
          reason: "invalid_input",
          code: "idempotency_conflict",
          message: "This operation already committed with different input.",
          priorEffect: { threadId: ThreadId.make("thread:previous-effect") },
        });
        conflict.stack = "PRIVATE HOST STACK";
        const result = yield* supervisor.invoke(
          { ...input, handler: "action:inspect-host-error" },
          () => Effect.fail(conflict),
        );
        expect(result.data).toEqual({
          reason: "invalid_input",
          code: "idempotency_conflict",
          message: "This operation already committed with different input.",
          priorEffect: { threadId: "thread:previous-effect" },
          stack: expect.any(String),
        });
        expect(JSON.stringify(result)).not.toContain("PRIVATE HOST STACK");
        const defect = yield* supervisor.invoke(
          { ...input, handler: "action:inspect-host-error" },
          () => Effect.die(new Error("PRIVATE HOST DEFECT")),
        );
        expect(defect.data).toMatchObject({
          message: "The host rejected this plugin operation.",
          stack: expect.any(String),
        });
        expect(JSON.stringify(defect)).not.toContain("PRIVATE HOST DEFECT");
      }),
    ),
  );

  it.effect("kills an unresponsive cancellation only after its acknowledgement grace", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const siblingEntered = yield* Deferred.make<void>();
        const siblingRevoked = yield* Deferred.make<void>();
        const sibling = yield* supervisor
          .invoke({ ...input, handler: "action:hold" }, () =>
            Deferred.succeed(siblingEntered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(siblingRevoked, undefined)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(siblingEntered);
        const entered = yield* Deferred.make<void>();
        const revoked = yield* Deferred.make<void>();
        const running = yield* supervisor
          .invoke({ ...input, handler: "action:spin-on-cancel" }, () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(revoked, undefined)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const interrupting = yield* Fiber.interrupt(running).pipe(Effect.forkChild);
        yield* Deferred.await(revoked);
        expect(yield* Deferred.isDone(siblingRevoked)).toBe(false);
        yield* TestClock.adjust(500);
        yield* Fiber.join(interrupting);
        const siblingError = yield* Fiber.join(sibling).pipe(Effect.flip);
        expect(siblingError.reason).toBe("timeout");
        const next = yield* supervisor.invoke(input, () => Effect.succeed("restarted"));
        expect(next.data).toMatchObject({ caller: "restarted" });
      }),
    ),
  );

  it.effect("still terminates a worker that violates the private IPC protocol", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const error = yield* supervisor
          .invoke({ ...input, handler: "action:protocol" }, () => Effect.void)
          .pipe(Effect.flip);
        expect(error.reason).toBe("invalid_result");
        expect(PluginSupervisor.isPluginWorkerFault(error)).toBe(true);
      }),
    ),
  );

  it.effect("accepts concurrent host reads within the pending-call bound", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        for (const count of [33, 128]) {
          const result = yield* supervisor.invoke(
            { ...input, handler: "action:reads", input: count },
            (_, payload) => Effect.succeed(payload),
          );
          expect(result.data).toEqual(
            Array.from({ length: count }, (_, index) => ({ key: String(index) })),
          );
        }
      }),
    ),
  );

  it.effect("rejects individual excess host calls while preserving a healthy sibling", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<string>();
        const sibling = yield* supervisor
          .invoke({ ...input, handler: "action:hold" }, () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        let calls = 0;
        const result = yield* supervisor.invoke(
          { ...input, handler: "action:serial", input: 131 },
          () => Effect.sync(() => ++calls),
        );
        expect(result.data).toEqual({ accepted: 128, rejected: 3 });
        expect(calls).toBe(128);
        const burst = yield* supervisor.invoke(
          { ...input, handler: "action:burst", input: 160 },
          () => Effect.succeed(null),
        );
        expect(burst.data).toEqual({ accepted: 127, rejected: 33 });
        yield* Deferred.succeed(release, "healthy");
        expect(yield* Fiber.await(sibling)).toEqual(Exit.succeed({ data: "healthy" }));
      }),
    ),
  );

  it.effect("bounds author diagnostics and stdout without recycling a healthy worker", () =>
    Effect.gen(function* () {
      const logs: {
        level: string;
        message: string;
        annotations: Readonly<Record<string, unknown>>;
      }[] = [];
      const observed = yield* Deferred.make<void>();
      const logger = Logger.make(({ fiber, message, logLevel }) => {
        logs.push({
          level: logLevel,
          message: String(message),
          annotations: fiber.getRef(References.CurrentLogAnnotations),
        });
        if (logs.length === 100) Deferred.doneUnsafe(observed, Effect.void);
      });
      yield* provide(
        Effect.gen(function* () {
          const supervisor = yield* PluginSupervisor.PluginSupervisor;
          const input = yield* fixture;
          yield* supervisor.invoke({ ...input, handler: "action:log-levels" }, () => Effect.void);
          const pids = yield* Effect.forEach(Array.from({ length: 110 }), () =>
            supervisor
              .invoke({ ...input, handler: "action:logs" }, () => Effect.void)
              .pipe(Effect.map((result) => result.data)),
          );
          expect(new Set(pids).size).toBe(1);
          const next = yield* supervisor.invoke(input, () => Effect.succeed("healthy"));
          expect(next.data).toMatchObject({ caller: "healthy" });
          yield* Deferred.await(observed);
          expect(logs).toHaveLength(100);
          expect(logs.slice(0, 4).map((log) => log.level)).toEqual([
            "Debug",
            "Info",
            "Warn",
            "Error",
          ]);
          expect(logs.every((log) => log.message.length === 2000)).toBe(true);
          expect(
            logs.every(
              (log) =>
                log.annotations.installationId === input.installationId &&
                log.annotations.generation === input.generation,
            ),
          ).toBe(true);
        }),
      ).pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      );
    }),
  );

  it.effect("a consented new generation clears crash quarantine", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        for (const _ of [1, 2]) {
          const error = yield* supervisor
            .invoke({ ...input, handler: "action:crash" }, () => Effect.void)
            .pipe(Effect.flip);
          expect(error.reason).toBe("crashed");
        }
        const quarantined = yield* supervisor.invoke(input, () => Effect.void).pipe(Effect.flip);
        expect(quarantined.reason).toBe("quarantined");
        const next = yield* supervisor.invoke({ ...input, generation: "generation-2" }, () =>
          Effect.succeed("fixed"),
        );
        expect(next.data).toMatchObject({ caller: "fixed" });
      }),
    ),
  );

  it.effect("quarantines repeated crashes and allows an explicit resume", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const first = yield* supervisor
          .invoke({ ...input, handler: "action:crash" }, () => Effect.void)
          .pipe(Effect.flip);
        const second = yield* supervisor
          .invoke({ ...input, handler: "action:crash" }, () => Effect.void)
          .pipe(Effect.flip);
        const quarantined = yield* supervisor.invoke(input, () => Effect.void).pipe(Effect.flip);
        expect(first.reason).toBe("crashed");
        expect(second.reason).toBe("crashed");
        expect(quarantined.reason).toBe("quarantined");
        yield* supervisor.resume(input.installationId);
        const resumed = yield* supervisor.invoke(input, () => Effect.succeed("resumed"));
        expect(resumed.data).toMatchObject({ caller: "resumed" });
      }),
    ),
  );

  it.effect("rejects oversized invocation inputs before launching code", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const failure = yield* supervisor
          .invoke({ ...input, input: "x".repeat(1_048_576) }, () =>
            Effect.fail(new PluginError({ reason: "permission_denied", message: "Denied" })),
          )
          .pipe(Effect.flip);
        expect(failure.reason).toBe("invalid_input");
      }),
    ),
  );

  it.effect("rejects excess concurrency without cancelling the existing invocations", () =>
    provide(
      Effect.gen(function* () {
        const supervisor = yield* PluginSupervisor.PluginSupervisor;
        const input = yield* fixture;
        const allEntered = yield* Deferred.make<void>();
        let entered = 0;
        let finished = 0;
        const host = () =>
          Effect.gen(function* () {
            if (++entered === 8) yield* Deferred.succeed(allEntered, undefined);
            return yield* Effect.never;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                finished++;
              }),
            ),
          );
        const running = yield* Effect.forEach(
          Array.from({ length: 8 }, (_, index) => index),
          (index) =>
            supervisor
              .invoke({ ...input, handler: "action:hang", operationId: `parallel-${index}` }, host)
              .pipe(Effect.forkChild),
        );
        yield* Deferred.await(allEntered);
        const error = yield* supervisor.invoke(input, () => Effect.void).pipe(Effect.flip);
        expect(error.reason).toBe("busy");
        expect(finished).toBe(0);
        yield* supervisor.stop(input.installationId);
        yield* Effect.forEach(running, (fiber) => Fiber.join(fiber).pipe(Effect.flip));
        expect(finished).toBe(8);
      }),
    ),
  );
});
