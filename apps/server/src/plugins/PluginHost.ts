import {
  CommandId,
  MessageId,
  ModelSelection,
  PluginError,
  ProjectId,
  RuntimeMode,
  ThreadId,
  type PluginActionContext,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Hex from "effect/encoding/Hex";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Option from "effect/Option";
import * as PluginReceipts from "./PluginReceipts.ts";
import * as ServerConfig from "../config.ts";
import { PluginExecutionPolicy } from "./PluginExecutionPolicy.ts";
import * as PluginStore from "./PluginStore.ts";
import {
  assertPluginActive,
  pluginCapabilityAllowed,
  pluginPermissionDenied,
  pluginTargetWithinCeiling,
  type PluginActor,
} from "./PluginAuthority.ts";

const isPluginError = Schema.is(PluginError);
const decodeEffectHandle = Schema.decodeUnknownOption(Schema.Struct({ threadId: ThreadId }));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeStorage = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const key = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/));
const KeyInput = Schema.Struct({ key });
const SetInput = Schema.Struct({ key, value: Schema.Json });
const ThreadRead = Schema.Struct({ threadId: ThreadId });
const ThreadSend = Schema.Struct({
  idempotencyKey: key,
  threadId: ThreadId,
  projectId: Schema.optionalKey(ProjectId),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
});
const ThreadCreate = Schema.Struct({
  idempotencyKey: key,
  projectId: ProjectId,
  title: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
  modelSelection: Schema.optionalKey(ModelSelection),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});

export interface PluginHostInvocation {
  readonly installationId: string;
  readonly generation: string;
  readonly actor: PluginActor;
  readonly context?: PluginActionContext;
  readonly operationId: string;
  readonly callId: number;
  readonly event?: boolean;
}

export class PluginHost extends Context.Service<
  PluginHost,
  {
    readonly call: (
      invocation: PluginHostInvocation,
      method: string,
      input: unknown,
    ) => Effect.Effect<unknown, PluginError>;
  }
>()("t3/plugins/PluginHost") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const policy = yield* PluginExecutionPolicy;
  const executionDisabled = config.pluginsEnabled === false || policy.safeMode;
  const store = yield* PluginStore.PluginStore;
  const receipts = yield* PluginReceipts.PluginReceipts;
  const dispatchLocks = yield* KeyedLock.make<string>();
  const crypto = yield* Crypto.Crypto;
  const digest = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(() => pluginPermissionDenied()),
    );
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launch = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const decode = <A, I>(schema: Schema.Codec<A, I>, input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError(
        () =>
          new PluginError({
            reason: "invalid_input",
            message: "The plugin host request is invalid.",
          }),
      ),
    );
  const call = Effect.fn("PluginHost.call")(
    function* (invocation: PluginHostInvocation, method: string, input: unknown) {
      if (executionDisabled)
        return yield* new PluginError({
          reason: "disabled",
          code: "safe_mode",
          message: "Plugin execution is disabled for this environment.",
        });
      yield* invocation.actor.authorize?.() ?? Effect.void;
      let state = yield* store.read;
      if (invocation.actor.authorize !== undefined) {
        yield* invocation.actor.authorize();
        // Reads can wait on a commit; authorization can suspend across another commit.
        // Check snapshot identity synchronously, retrying once before failing closed.
        if (!store.isCurrent(state)) {
          state = yield* store.read;
          yield* invocation.actor.authorize();
          if (!store.isCurrent(state)) return yield* pluginPermissionDenied();
        }
      }
      const record = state.installations.find(
        (r) => r.installation.installationId === invocation.installationId,
      );
      if (record === undefined || record.removed)
        return yield* new PluginError({
          reason: "not_found",
          message: "The plugin installation no longer exists.",
        });
      const installation = record.installation;
      const inactive =
        PluginStore.assertMutablePluginRecord(record) ??
        assertPluginActive(installation, invocation.generation);
      if (inactive) return yield* inactive;
      const actor = invocation.actor;
      const requireCapability = (
        capability: Parameters<typeof pluginCapabilityAllowed>[2],
        projectId?: ProjectId,
      ) =>
        pluginCapabilityAllowed(installation, actor, capability, projectId)
          ? Effect.void
          : Effect.fail(pluginPermissionDenied());
      const dispatch = Effect.fn("PluginHost.dispatch")(function* (
        method: string,
        idempotencyKey: string,
        request: unknown,
        execute: (commandKey: string) => Effect.Effect<unknown, PluginError>,
        authorizeTarget: (current: typeof installation) => Effect.Effect<void, PluginError>,
      ) {
        const commandKey = `plugin:${installation.installationId}:${yield* digest(yield* encodeJson([actor.principalId, invocation.operationId, method, idempotencyKey]).pipe(Effect.mapError(() => pluginPermissionDenied())))}`;
        const requestJson = yield* encodeJson(request).pipe(
          Effect.mapError(() => pluginPermissionDenied()),
        );
        const requestDigest = yield* digest(requestJson);
        return yield* dispatchLocks.withLock(
          commandKey,
          Effect.gen(function* () {
            const revalidate = Effect.fn("PluginHost.revalidate")(function* () {
              yield* actor.authorize?.() ?? Effect.void;
              const current = (yield* store.read).installations.find(
                (r) => !r.removed && r.installation.installationId === invocation.installationId,
              );
              if (!current) return yield* pluginPermissionDenied();
              const denied =
                PluginStore.assertMutablePluginRecord(current) ??
                assertPluginActive(current.installation, invocation.generation);
              if (denied) return yield* denied;
              yield* authorizeTarget(current.installation);
              return current.installation;
            });
            const canDisclose = Effect.fn("PluginHost.canDisclose")(
              function* (threadId: ThreadId, current: typeof installation) {
                const shell = yield* target(threadId);
                return (
                  (method === "threads.create" || method === "threads.send") &&
                  pluginCapabilityAllowed(current, actor, method, shell.projectId) &&
                  pluginTargetWithinCeiling(actor, shell)
                );
              },
              Effect.catch(() => Effect.succeed(false)),
            );
            yield* revalidate();
            const previous = yield* receipts
              .reserve({
                key: commandKey,
                installationId: invocation.installationId,
                generation: invocation.generation,
                requestDigest,
                ...(invocation.event ? { deliveryId: invocation.operationId } : {}),
              })
              .pipe(
                Effect.catchTags({
                  PluginError: (error) =>
                    Effect.gen(function* () {
                      if (error.code !== "idempotency_conflict") return yield* error;
                      const current = yield* revalidate();
                      const disclose =
                        error.priorEffect !== undefined &&
                        (yield* canDisclose(error.priorEffect.threadId, current));
                      return yield* new PluginError({
                        reason: error.reason,
                        message: error.message,
                        code: error.code,
                        ...(disclose && error.priorEffect
                          ? { priorEffect: error.priorEffect }
                          : {}),
                      });
                    }),
                }),
              );
            if ("result" in previous) {
              const current = yield* revalidate();
              const effect = decodeEffectHandle(previous.result);
              if (effect._tag === "Some" && !(yield* canDisclose(effect.value.threadId, current)))
                return yield* pluginPermissionDenied();
              return previous.result;
            }
            const result = yield* revalidate().pipe(
              Effect.andThen(execute(commandKey)),
              Effect.provideService(DispatchModeLimit, {
                runtimeMode: actor.runtimeMode,
                interactionMode: actor.interactionMode ?? "default",
              }),
            );
            yield* receipts.complete(commandKey, result);
            const latest = yield* revalidate();
            const effect = decodeEffectHandle(result);
            if (effect._tag === "Some" && !(yield* canDisclose(effect.value.threadId, latest)))
              return yield* pluginPermissionDenied();
            return result;
          }).pipe(
            // Reserve can commit before interruption arrives, so cleanup must also surround it.
            // Caller-fiber core transactions unwind before this uninterruptible finalizer.
            Effect.onError(() =>
              receipts.releaseUncommitted(commandKey, requestDigest).pipe(Effect.ignoreCause),
            ),
          ),
        );
      });
      const mutate = Effect.fn("PluginHost.mutate")(function* <A>(
        f: (
          current: PluginStore.StoredInstallation,
          currentState: PluginStore.PluginState,
        ) => Effect.Effect<readonly [A, PluginStore.PluginState], PluginError>,
      ) {
        // External session checks must not hold the global catalogue commit lock.
        yield* actor.authorize?.() ?? Effect.void;
        return yield* store.update((currentState) =>
          Effect.gen(function* () {
            const current = currentState.installations.find(
              (r) => r.installation.installationId === invocation.installationId,
            );
            if (current === undefined || current.removed)
              return yield* new PluginError({
                reason: "not_found",
                message: "The plugin installation no longer exists.",
              });
            const denied = assertPluginActive(current.installation, invocation.generation);
            if (denied) return yield* denied;
            return yield* f(current, currentState);
          }),
        );
      });
      const target = Effect.fn("PluginHost.target")(function* (
        threadId: ThreadId,
        suppliedProjectId?: ProjectId,
      ) {
        const shell = yield* threads
          .getThreadShell(threadId)
          .pipe(Effect.mapError(() => pluginPermissionDenied()));
        if (
          shell === null ||
          shell.deletedAt !== null ||
          (suppliedProjectId !== undefined && shell.projectId !== suppliedProjectId)
        )
          return yield* pluginPermissionDenied();
        return shell;
      });
      if (method === "settings.get") {
        yield* requireCapability("settings");
        const { key } = yield* decode(KeyInput, input);
        const setting = installation.manifest.settings.find((s) => s.key === key);
        if (setting === undefined)
          return yield* new PluginError({
            reason: "invalid_input",
            message: "The plugin setting is not declared.",
          });
        return setting.type === "secret"
          ? Object.hasOwn(record.secrets, key)
            ? record.secrets[key]
            : null
          : Object.hasOwn(installation.settings, key)
            ? installation.settings[key]
            : (setting.default ?? null);
      }
      if (method.startsWith("storage.")) {
        yield* requireCapability("storage");
        if (method === "storage.get") {
          const { key } = yield* decode(KeyInput, input);
          return Object.hasOwn(record.storage, key) ? record.storage[key] : null;
        }
        if (method !== "storage.set" && method !== "storage.delete")
          return yield* pluginPermissionDenied();
        const entry =
          method === "storage.set"
            ? yield* decode(SetInput, input)
            : yield* decode(KeyInput, input);
        return yield* mutate((current, currentState) => {
          const storage = { ...current.storage };
          if ("value" in entry) storage[entry.key] = entry.value;
          else delete storage[entry.key];
          const encoded = encodeStorage(storage);
          if (encoded === encodeStorage(current.storage))
            return Effect.succeed([null, currentState] as const);
          if (Buffer.byteLength(encoded) > 1_000_000)
            return Effect.fail(
              new PluginError({
                reason: "invalid_input",
                message: "The plugin storage quota is one megabyte.",
              }),
            );
          return Effect.succeed([
            null,
            {
              ...currentState,
              installations: currentState.installations.map((r) =>
                r === current ? { ...r, storage } : r,
              ),
            },
          ] as const);
        });
      }
      if (method === "threads.read") {
        const request = yield* decode(ThreadRead, input);
        const threadId = request.threadId;
        const shell = yield* target(threadId);
        yield* requireCapability("threads.read", shell.projectId);
        yield* threads.ensureLegacyTranscript(threadId);
        const { projection: records } = yield* threads.getThreadSnapshotWindow(threadId, {
          rowLimit: 30,
          userTurnLimit: 10,
        });
        yield* actor.authorize?.() ?? Effect.void;
        const latest = (yield* store.read).installations.find(
          (r) => !r.removed && r.installation.installationId === invocation.installationId,
        );
        if (!latest) return yield* pluginPermissionDenied();
        const revoked = assertPluginActive(latest.installation, invocation.generation);
        if (revoked) return yield* revoked;
        if (records.thread.projectId !== shell.projectId) return yield* pluginPermissionDenied();
        return {
          threadId: shell.id,
          projectId: shell.projectId,
          title: shell.title,
          messages: records.messages
            .slice(-30)
            .map((m) => ({ id: m.id, role: m.role, text: m.text.slice(0, 4_096) })),
        };
      }
      if (method === "threads.send") {
        const request = yield* decode(ThreadSend, input);
        const shell = yield* target(request.threadId, request.projectId);
        yield* requireCapability("threads.send", shell.projectId);
        if (!pluginTargetWithinCeiling(actor, shell)) return yield* pluginPermissionDenied();
        return yield* dispatch(
          method,
          request.idempotencyKey,
          request,
          Effect.fn("PluginHost.send")(function* (commandKey) {
            const result = yield* threads
              .sendToThread({
                projectId: shell.projectId,
                threadId: shell.id,
                commandId: CommandId.make(commandKey),
                messageId: MessageId.make(`${commandKey}:message`),
                text: `[Plugin: ${installation.manifest.name}]\n${request.text}`,
                attachments: [],
                mode: "queue",
                createdBy: "system",
                creationSource: "server",
              })
              .pipe(
                Effect.mapError(
                  () =>
                    new PluginError({
                      reason: "operation_failed",
                      message: "The plugin could not send to the thread.",
                    }),
                ),
              );
            return { threadId: shell.id, runId: result.run.id, delivery: result.delivery };
          }),
          Effect.fn("PluginHost.authorizeSend")(function* (current) {
            const latest = yield* target(request.threadId, request.projectId);
            if (
              !pluginCapabilityAllowed(current, actor, "threads.send", latest.projectId) ||
              !pluginTargetWithinCeiling(actor, latest)
            )
              return yield* pluginPermissionDenied();
          }),
        );
      }
      if (method === "threads.create") {
        const request = yield* decode(ThreadCreate, input);
        yield* requireCapability("threads.create", request.projectId);
        const caller = actor.threadId === undefined ? null : yield* target(actor.threadId);
        const project = yield* projects.getShell(request.projectId);
        if (Option.isNone(project)) return yield* pluginPermissionDenied();
        const defaults = resolveProjectSettings(
          yield* settings.getSettings,
          request.projectId,
          project.value,
        ).settings;
        const modelSelection =
          request.modelSelection ??
          caller?.modelSelection ??
          defaults.defaultModelSelection ??
          undefined;
        if (modelSelection === undefined)
          return yield* new PluginError({
            reason: "invalid_input",
            message: "Thread creation requires a model selection.",
          });
        const inheritedRuntimeMode = caller?.runtimeMode ?? defaults.defaultRuntimeMode;
        const runtimeMode =
          request.runtimeMode ??
          (pluginTargetWithinCeiling(actor, {
            runtimeMode: inheritedRuntimeMode,
            interactionMode: "plan",
          })
            ? inheritedRuntimeMode
            : actor.runtimeMode);
        const interactionMode =
          request.interactionMode ??
          (actor.interactionMode === "plan" ? "plan" : (caller?.interactionMode ?? "default"));
        if (!pluginTargetWithinCeiling(actor, { runtimeMode, interactionMode }))
          return yield* pluginPermissionDenied();
        return yield* dispatch(
          method,
          request.idempotencyKey,
          request,
          Effect.fn("PluginHost.create")(function* (commandKey) {
            const result = yield* launch
              .launch({
                commandId: CommandId.make(commandKey),
                threadId: ThreadId.make(`${commandKey}:thread`),
                projectId: request.projectId,
                title: `[${installation.manifest.name}] ${request.title ?? "Plugin thread"}`,
                modelSelection,
                runtimeMode,
                interactionMode,
                workspaceStrategy: { type: "root" },
                initialMessage: {
                  messageId: MessageId.make(`${commandKey}:message`),
                  text: `[Plugin: ${installation.manifest.name}]\n${request.text}`,
                  attachments: [],
                },
                createdBy: "system",
                creationSource: "server",
              })
              .pipe(
                Effect.mapError(
                  () =>
                    new PluginError({
                      reason: "operation_failed",
                      message: "The plugin could not create the thread.",
                    }),
                ),
              );
            return { threadId: result.threadId };
          }),
          (current) =>
            pluginCapabilityAllowed(current, actor, "threads.create", request.projectId)
              ? Effect.void
              : Effect.fail(pluginPermissionDenied()),
        );
      }
      return yield* pluginPermissionDenied();
    },
    Effect.mapError((error) =>
      isPluginError(error)
        ? error
        : new PluginError({
            reason: "operation_failed",
            message: "The plugin host operation failed.",
          }),
    ),
  );
  return PluginHost.of({ call });
});
export const layer = Layer.effect(PluginHost, make);
