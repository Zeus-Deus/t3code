// @effect-diagnostics nodeBuiltinImport:off -- Node's child IPC verifies the distributed executable.
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { selfInvocationArgs, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export class PluginHostSmokeError extends Schema.TaggedError<PluginHostSmokeError>()(
  "PluginHostSmokeError",
  { message: Schema.String },
) {}

/** Exercise filesystem ESM loading, IPC and teardown with no system Node on PATH. */
export const smokePluginHost = Effect.fn("smokePluginHost")(function* (invocation: SelfInvocation) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-smoke-" });
  yield* fs.writeFileString(
    path.join(directory, "helper.mjs"),
    'export const value = "filesystem-esm-with-await";\n',
  );
  yield* fs.writeFileString(
    path.join(directory, "plugin.mjs"),
    `
import { value } from "./helper.mjs";
await Promise.resolve();
export function activate(ctx) {
  ctx.handle("action:smoke", () => ({data: value}));
}
`,
  );
  const booted = yield* Deferred.make<void, PluginHostSmokeError>();
  const ready = yield* Deferred.make<void, PluginHostSmokeError>();
  const result = yield* Deferred.make<void, PluginHostSmokeError>();
  const exited = yield* Deferred.make<number | null>();
  const child = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const child = NodeChildProcess.spawn(
        invocation.command,
        [...selfInvocationArgs(invocation, ["plugin-host"])],
        {
          cwd: directory,
          env: {
            PATH: "",
            HOME: directory,
            USERPROFILE: directory,
            TMPDIR: directory,
            TEMP: directory,
            T3CODE_HOME: directory,
            ELECTRON_RUN_AS_NODE: "1",
            ...(environment.SystemRoot === undefined ? {} : { SystemRoot: environment.SystemRoot }),
            ...(environment.WINDIR === undefined ? {} : { WINDIR: environment.WINDIR }),
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          windowsHide: true,
        },
      );
      const fail = (message: string) => {
        const error = Effect.fail(new PluginHostSmokeError({ message }));
        Deferred.doneUnsafe(booted, error);
        Deferred.doneUnsafe(ready, error);
        Deferred.doneUnsafe(result, error);
      };
      child.stderr?.resume();
      child.on("message", (message: unknown) => {
        if (!Predicate.isObject(message)) return fail("The plugin worker sent invalid IPC.");
        if (message.type === "booted") Deferred.doneUnsafe(booted, Effect.void);
        else if (message.type === "ready") Deferred.doneUnsafe(ready, Effect.void);
        else if (
          message.type === "result" &&
          Predicate.isObject(message.result) &&
          message.result.data === "filesystem-esm-with-await"
        )
          Deferred.doneUnsafe(result, Effect.void);
        else fail("The distributed plugin worker failed to load an external ESM plugin.");
      });
      child.once("error", () => {
        fail("The distributed plugin worker could not be spawned.");
        Deferred.doneUnsafe(exited, Effect.succeed(null));
      });
      child.once("exit", (code) => {
        fail("The distributed plugin worker exited before completing its handshake.");
        Deferred.doneUnsafe(exited, Effect.succeed(code));
      });
      return child;
    }),
    (child) =>
      Effect.gen(function* () {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGKILL");
        yield* Deferred.await(exited);
      }),
  );
  const send = (message: Record<string, unknown>) =>
    Effect.try({
      try: () => {
        child.send(message, () => {});
      },
      catch: () => new PluginHostSmokeError({ message: "The plugin worker's IPC channel closed." }),
    });
  yield* Effect.gen(function* () {
    yield* Deferred.await(booted);
    yield* send({
      type: "init",
      protocol: 1,
      directory,
      dataDirectory: directory,
      entry: "plugin.mjs",
      capabilities: [],
    });
    yield* Deferred.await(ready);
    yield* send({
      type: "invoke",
      invocationId: "smoke",
      operationId: "smoke",
      handler: "action:smoke",
      caller: { kind: "client" },
    });
    yield* Deferred.await(result);
    yield* send({ type: "stop" });
    if ((yield* Deferred.await(exited)) !== 0)
      return yield* new PluginHostSmokeError({
        message: "The plugin worker did not stop cleanly.",
      });
  }).pipe(
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () =>
        Effect.fail(
          new PluginHostSmokeError({
            message: "The distributed plugin worker exceeded its deadline.",
          }),
        ),
    }),
  );
});
