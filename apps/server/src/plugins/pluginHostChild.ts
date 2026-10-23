// @effect-diagnostics nodeBuiltinImport:off -- this module is the isolated Node IPC entry point.
import * as NodeAsyncHooks from "node:async_hooks";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import type {
  PluginContext,
  PluginHandler,
  PluginInvocation,
  PluginModule,
} from "../../../../packages/plugin-sdk/src/index.ts";
import {
  PLUGIN_CAPABILITIES,
  PluginRunFinalizedEvent,
  PluginInvokeResult,
} from "@t3tools/contracts";
import {
  MAX_PLUGIN_FAILURE_MESSAGE_CHARS,
  MAX_PLUGIN_PENDING_HOST_CALLS,
  PluginWorkerImages,
  PluginWorkerResult,
  decodeParentMessage,
  pluginMessageFits,
  type PluginChildMessage,
  type PluginHostMethod,
  type PluginParentMessage,
} from "./pluginIpc.ts";
import { safePluginPath } from "./pluginSource.ts";

const decodeWorkerResult = Schema.decodeUnknownSync(
  Schema.Struct({ ...PluginWorkerResult.fields, intents: Schema.optionalKey(Schema.Unknown) }),
);
const decodePublicResult = Schema.decodeUnknownSync(PluginInvokeResult);
const decodeResult = (value: unknown) => {
  const { card, ...rest } = decodeWorkerResult(value);
  const decoded = decodePublicResult(rest);
  return card === undefined ? decoded : { ...decoded, card };
};
const decodeEvent = Schema.decodeUnknownSync(PluginRunFinalizedEvent);
const decodeImages = Schema.decodeUnknownSync(PluginWorkerImages);
const handlerFailureMessage = (error: unknown): string | undefined => {
  try {
    if (!(error instanceof Error) || typeof error.message !== "string") return undefined;
    const message = error.message.slice(0, MAX_PLUGIN_FAILURE_MESSAGE_CHARS);
    return message.trim() ? message : undefined;
  } catch {
    return undefined;
  }
};
const decodeModule = Schema.decodeUnknownSync(
  Schema.declare(
    (input): input is PluginModule =>
      typeof input === "object" &&
      input !== null &&
      "activate" in input &&
      typeof input.activate === "function" &&
      (!("deactivate" in input) ||
        input.deactivate === undefined ||
        typeof input.deactivate === "function"),
  ),
);

const loadPluginModule = async (url: string): Promise<unknown> => {
  if (!NodeSea.isSea()) return import(url);
  // An injected SEA script cannot import filesystem modules. A file-backed
  // bridge uses Node's ordinary ESM loader, including top-level await.
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-plugin-loader-"));
  try {
    const entry = NodePath.join(directory, "loader.cjs");
    await NodeFSP.writeFile(entry, "module.exports = (url) => import(url);\n", { mode: 0o600 });
    const load: unknown = NodeModule.createRequire(import.meta.url)(entry);
    if (typeof load !== "function") throw new Error("Plugin module loader is unavailable.");
    return await load(url);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** Called only by the hidden CLI fast path, before the normal server graph loads. */
export const runPluginHostChild = async (): Promise<void> => {
  if (!process.send || !process.connected)
    throw new Error("The plugin host requires a parent IPC channel.");
  const lifetime = new AbortController();
  const invocationScope = new NodeAsyncHooks.AsyncLocalStorage<{
    readonly id: string;
    readonly invocation: PluginInvocation;
  }>();
  const handlers = new Map<string, PluginHandler>();
  const invocations = new Map<string, AbortController>();
  const pending = new Map<
    string,
    {
      readonly invocationId: string;
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  let module: PluginModule | undefined;
  let initialized = false;
  let ready = false;
  let counter = 0;
  let logCount = 0;
  const send = (message: PluginChildMessage) => {
    if (!pluginMessageFits(message) || !process.connected) return false;
    try {
      process.send?.(message);
      return true;
    } catch {
      return false;
    }
  };
  const log: PluginContext["log"] = (level, message) => {
    if (logCount++ < 100) send({ type: "log", level, message: String(message).slice(0, 2_000) });
  };
  // Invocation cleanup must reject abandoned calls without taking siblings down.
  process.on("unhandledRejection", () => {
    log(
      "warn",
      "Unhandled plugin promise rejection. Await host calls inside handlers; pending calls are rejected when the invocation ends.",
    );
  });
  const hostCall = (method: PluginHostMethod, input: unknown): Promise<unknown> => {
    const scope = invocationScope.getStore();
    if (
      !scope ||
      !invocations.has(scope.id) ||
      scope.invocation.signal.aborted ||
      lifetime.signal.aborted
    )
      return Promise.reject(new Error("Host APIs require an active plugin invocation."));
    if (pending.size >= MAX_PLUGIN_PENDING_HOST_CALLS)
      return Promise.reject(new Error("Too many pending plugin host calls."));
    const callId = String(++counter);
    return new Promise((resolve, reject) => {
      pending.set(callId, { invocationId: scope.id, resolve, reject });
      if (!send({ type: "host-call", invocationId: scope.id, callId, method, input })) {
        pending.delete(callId);
        reject(new Error("Plugin host call exceeds the transport limit or is disconnected."));
      }
    });
  };
  const closeInvocation = (id: string) => {
    invocations.get(id)?.abort();
    invocations.delete(id);
    for (const [callId, call] of pending) {
      if (call.invocationId === id) {
        pending.delete(callId);
        call.reject(new Error("Plugin invocation ended."));
      }
    }
  };
  const shutdown = async () => {
    lifetime.abort();
    for (const id of invocations.keys()) closeInvocation(id);
    try {
      await module?.deactivate?.();
    } finally {
      process.exit(0);
    }
  };
  const invoke = async (message: Extract<PluginParentMessage, { type: "invoke" }>) => {
    const handler = handlers.get(message.handler);
    if (!ready || !handler || invocations.size >= 8 || invocations.has(message.invocationId)) {
      send({ type: "failure", invocationId: message.invocationId });
      return;
    }
    const controller = new AbortController();
    const invocation: PluginInvocation = Object.freeze({
      signal: controller.signal,
      operationId: message.operationId,
      caller: Object.freeze({ ...message.caller }),
      ...(message.context === undefined ? {} : { context: Object.freeze({ ...message.context }) }),
    });
    invocations.set(message.invocationId, controller);
    try {
      let result: Awaited<ReturnType<PluginHandler>>;
      try {
        result = await invocationScope.run({ id: message.invocationId, invocation }, () =>
          handler(message.input, invocation),
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          const failureMessage = handlerFailureMessage(error);
          send({
            type: "failure",
            invocationId: message.invocationId,
            ...(failureMessage === undefined ? {} : { message: failureMessage }),
          });
        }
        return;
      }
      if (!controller.signal.aborted) {
        // Keep output-schema diagnostics private; only handler errors carry author messages.
        const { images, ...rest }: { readonly images?: unknown } = result ?? {};
        const output = decodeResult(rest);
        if (
          !send({
            type: "result",
            invocationId: message.invocationId,
            result: output,
            ...(images === undefined ? {} : { images: decodeImages(images) }),
          })
        )
          send({ type: "failure", invocationId: message.invocationId });
      }
    } catch {
      if (!controller.signal.aborted) send({ type: "failure", invocationId: message.invocationId });
    } finally {
      closeInvocation(message.invocationId);
    }
  };
  const init = async (message: Extract<PluginParentMessage, { type: "init" }>) => {
    if (initialized) return;
    initialized = true;
    const handle: PluginContext["handle"] = (name, handler) => {
      if (
        ready ||
        handlers.has(name) ||
        handlers.size >= 256 ||
        !/^(?:action:[\w.-]+|status:[\w.-]+|tree:[\w.-]+|view:[\w.-]+:[\w.-]+|event:run\.finalized)$/.test(
          name,
        )
      )
        throw new Error("Plugin handler registration is invalid.");
      handlers.set(name, handler);
    };
    const context: PluginContext = {
      apiVersion: 1,
      dataDirectory: message.dataDirectory,
      capabilities: PLUGIN_CAPABILITIES.filter((capability) =>
        message.capabilities.includes(capability),
      ),
      signal: lifetime.signal,
      handle,
      log,
      settings: {
        get: async (key) =>
          (await hostCall("settings.get", { key })) as string | number | boolean | null,
      },
      storage: {
        get: async (key) =>
          (await hostCall("storage.get", { key })) as Awaited<
            ReturnType<PluginContext["storage"]["get"]>
          >,
        set: async (key, value) => {
          await hostCall("storage.set", { key, value });
        },
        delete: async (key) => {
          await hostCall("storage.delete", { key });
        },
      },
      projects: {
        list: async (input = {}) =>
          (await hostCall("projects.list", input)) as Awaited<
            ReturnType<PluginContext["projects"]["list"]>
          >,
      },
      models: {
        list: async (input) =>
          (await hostCall("models.list", input)) as Awaited<
            ReturnType<PluginContext["models"]["list"]>
          >,
      },
      ui: {
        invalidate: async (topics) => {
          await hostCall("ui.invalidate", { topics });
        },
      },
      trees: {
        register: (id, handler) =>
          handle(`tree:${id}`, async (_input, invocation) => ({ data: await handler(invocation) })),
      },
      threads: {
        list: async (input) =>
          (await hostCall("threads.list", input)) as Awaited<
            ReturnType<PluginContext["threads"]["list"]>
          >,
        metadata: async (input) =>
          (await hostCall("threads.metadata", input)) as Awaited<
            ReturnType<PluginContext["threads"]["metadata"]>
          >,
        read: async (input) =>
          (await hostCall("threads.read", input)) as Awaited<
            ReturnType<PluginContext["threads"]["read"]>
          >,
        send: async (input) =>
          (await hostCall("threads.send", input)) as Awaited<
            ReturnType<PluginContext["threads"]["send"]>
          >,
        create: async (input) =>
          (await hostCall("threads.create", input)) as Awaited<
            ReturnType<PluginContext["threads"]["create"]>
          >,
      },
      events: {
        onRunFinalized: (handler) =>
          handle("event:run.finalized", (input, invocation) =>
            handler(decodeEvent(input), invocation),
          ),
      },
    };
    try {
      // Dynamic package import is deliberate: only snapshot bytes execute in this child.
      const imported = await loadPluginModule(
        NodeURL.pathToFileURL(safePluginPath(message.directory, message.entry)).href,
      );
      module = decodeModule(imported);
      await module.activate(context);
      ready = true;
      send({ type: "ready", protocol: 1 });
    } catch {
      send({ type: "failure" });
    }
  };
  process.on("message", (raw) => {
    let message: PluginParentMessage;
    try {
      if (!pluginMessageFits(raw)) throw new Error("IPC limit exceeded");
      message = decodeParentMessage(raw);
    } catch {
      send({ type: "failure" });
      void shutdown();
      return;
    }
    switch (message.type) {
      case "init":
        void init(message);
        break;
      case "invoke":
        void invoke(message);
        break;
      case "host-result": {
        const call = pending.get(message.callId);
        if (call && call.invocationId === message.invocationId) {
          pending.delete(message.callId);
          if (message.ok) call.resolve(message.value);
          else
            call.reject(
              message.error === undefined
                ? new Error("The host rejected this plugin operation.")
                : Object.assign(new Error(message.error.message), message.error),
            );
        }
        break;
      }
      case "cancel":
        closeInvocation(message.invocationId);
        send({ type: "cancelled", invocationId: message.invocationId });
        break;
      case "stop":
        void shutdown();
        break;
    }
  });
  process.once("disconnect", () => {
    void shutdown();
  });
  // In an executable, the IPC channel can receive while the module graph is
  // still loading. Announce readiness only after installing the init listener.
  send({ type: "booted", protocol: 1 });
};
