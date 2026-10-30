import {
  AuthOrchestrationOperateScope,
  PluginThreadAdoptInput,
  CommandId,
  MessageId,
  PluginError,
  ProjectId,
  ThreadId,
  type PluginActionContext,
  type OrchestrationV2ThreadShell,
  type PluginThreadMetadata,
  PluginThreadCreateInput,
  PluginThreadsListInput,
  PluginThreadsList,
  PluginThreadMetadataInput,
  PluginThreadMetadata as PluginThreadMetadataSchema,
  PluginProjectsListInput,
  PluginProjectsList,
  PluginModelsListInput,
  PluginModelsList,
  PluginProjectAccessInput,
  MAX_PLUGIN_PROJECT_ACCESS_REQUESTS,
  isProviderAvailable,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Hex from "effect/encoding/Hex";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveDefaultProviderModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Option from "effect/Option";
import * as PluginReceipts from "./PluginReceipts.ts";
import * as ServerConfig from "../config.ts";
import { PluginExecutionPolicy } from "./PluginExecutionPolicy.ts";
import * as PluginStore from "./PluginStore.ts";
import { pluginThreadGroupingState } from "./pluginThreadMetadata.ts";
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
  fromConversation: Schema.optionalKey(Schema.Literal(true)),
});
const iso = (value: DateTime.DateTime | null | undefined) =>
  value == null ? null : DateTime.formatIso(value);

const threadMetadata = (thread: OrchestrationV2ThreadShell) =>
  ({
    id: thread.id,
    ...pluginThreadGroupingState(thread),
    projectId: thread.projectId,
    creationSource: thread.creationSource,
    title: thread.title.slice(0, 200),
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt: DateTime.formatIso(thread.createdAt),
    updatedAt: DateTime.formatIso(thread.updatedAt),
    archivedAt: iso(thread.archivedAt),
    settledAt: iso(thread.settledAt),
    settledOverride: thread.settledOverride,
    snoozedUntil: iso(thread.snoozedUntil),
    snoozedAt: iso(thread.snoozedAt),
    pinnedAt: iso(thread.pinnedAt),
    branch: thread.branch?.slice(0, 256) ?? null,
    worktreePath: thread.worktreePath?.slice(0, 4_096) ?? null,
    lineage: thread.lineage,
    ...(thread.pluginOwner === undefined ? {} : { pluginOwner: thread.pluginOwner }),
    ...(thread.launchedFrom === undefined ? {} : { launchedFrom: thread.launchedFrom }),
  }) satisfies PluginThreadMetadata;

const page = <A>(rows: ReadonlyArray<A>, cursor = 0, limit = 50) => ({
  rows: rows.slice(cursor, cursor + limit),
  nextCursor: cursor + limit < rows.length ? cursor + limit : null,
});

export interface PluginHostInvocation {
  readonly installationId: string;
  readonly generation: string;
  readonly actor: PluginActor;
  readonly context?: PluginActionContext;
  readonly operationId: string;
  readonly callId: number;
  readonly event?: boolean;
  readonly clientAction?: boolean;
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
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const readAuthorizedState = Effect.fn("PluginHost.readAuthorizedState")(function* (
    actor: PluginActor,
  ) {
    yield* actor.authorize?.() ?? Effect.void;
    let state = yield* store.read;
    if (actor.authorize !== undefined) {
      yield* actor.authorize();
      // Reads can wait on a commit; authorization can suspend across another commit.
      // Check snapshot identity synchronously, retrying once before failing closed.
      if (!store.isCurrent(state)) {
        state = yield* store.read;
        yield* actor.authorize();
        if (!store.isCurrent(state)) return yield* pluginPermissionDenied();
      }
    }
    return state;
  });
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
      const state = yield* readAuthorizedState(invocation.actor);
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
      const readCurrent = Effect.fn("PluginHost.readCurrent")(function* () {
        const state = yield* readAuthorizedState(actor);
        const current = state.installations.find(
          (r) => !r.removed && r.installation.installationId === invocation.installationId,
        );
        if (!current) return yield* pluginPermissionDenied();
        const denied =
          PluginStore.assertMutablePluginRecord(current) ??
          assertPluginActive(current.installation, invocation.generation);
        if (denied) return yield* denied;
        return { state, installation: current.installation };
      });
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
        execute: (
          commandKey: string,
          revalidate: () => Effect.Effect<typeof installation, PluginError>,
        ) => Effect.Effect<unknown, PluginError>,
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
              const current = yield* readCurrent();
              yield* authorizeTarget(current.installation);
              yield* actor.authorize?.() ?? Effect.void;
              // Target lookup is domain IO and can cross a grant or generation change.
              if (!store.isCurrent(current.state)) return yield* pluginPermissionDenied();
              return current.installation;
            });
            const canDisclose = Effect.fn("PluginHost.canDisclose")(
              function* (threadId: ThreadId) {
                const shell = yield* target(threadId);
                const current = yield* revalidate();
                return (
                  (method === "threads.create" || method === "threads.send") &&
                  pluginCapabilityAllowed(current, actor, method, shell.projectId) &&
                  pluginTargetWithinCeiling(actor, shell)
                );
              },
              Effect.orElseSucceed(() => false),
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
                  PluginError: Effect.fn("PluginHost.discloseReceiptConflict")(function* (error) {
                    if (error.code !== "idempotency_conflict") return yield* error;
                    yield* revalidate();
                    const disclose =
                      error.priorEffect !== undefined &&
                      (yield* canDisclose(error.priorEffect.threadId));
                    return yield* new PluginError({
                      reason: error.reason,
                      message: error.message,
                      code: error.code,
                      ...(disclose && error.priorEffect ? { priorEffect: error.priorEffect } : {}),
                    });
                  }),
                }),
              );
            if ("result" in previous) {
              yield* revalidate();
              const effect = decodeEffectHandle(previous.result);
              if (effect._tag === "Some" && !(yield* canDisclose(effect.value.threadId)))
                return yield* pluginPermissionDenied();
              return previous.result;
            }
            const result = yield* revalidate().pipe(
              Effect.andThen(
                execute(commandKey, () =>
                  revalidate().pipe(
                    Effect.mapError((error) =>
                      isPluginError(error) ? error : pluginPermissionDenied(),
                    ),
                  ),
                ),
              ),
              Effect.provideService(DispatchModeLimit, {
                runtimeMode: actor.runtimeMode,
                interactionMode: actor.interactionMode ?? "default",
              }),
            );
            yield* receipts.complete(commandKey, result);
            yield* revalidate();
            const effect = decodeEffectHandle(result);
            if (effect._tag === "Some" && !(yield* canDisclose(effect.value.threadId)))
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
        capability: "storage" | "projects.request-access" = "storage",
      ) {
        const attempt = () =>
          store.tryUpdate((currentState) =>
            Effect.gen(function* () {
              const current = currentState.installations.find(
                (r) => r.installation.installationId === invocation.installationId,
              );
              if (current === undefined || current.removed)
                return yield* new PluginError({
                  reason: "not_found",
                  message: "The plugin installation no longer exists.",
                });
              const denied =
                PluginStore.assertMutablePluginRecord(current) ??
                assertPluginActive(current.installation, invocation.generation);
              if (denied) return yield* denied;
              if (!pluginCapabilityAllowed(current.installation, actor, capability))
                return yield* pluginPermissionDenied();
              return yield* f(current, currentState);
            }),
          );
        // Authorizers may reenter this store. A missed admission waits for the owner, then
        // rechecks authority; the invocation's cancellation bounds contention, not a busy error.
        while (true) {
          yield* actor.authorize?.() ?? Effect.void;
          const result = yield* attempt();
          if (Option.isSome(result)) return result.value;
          yield* store.read;
        }
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
      // Credential for agents, and for people the thread their own action ran on. Reads and status
      // handlers also receive the open thread, but nobody in it asked for anything.
      const conversationSender = Effect.fn("PluginHost.conversationSender")(function* () {
        const threadId =
          actor.source === "agent"
            ? actor.threadId
            : invocation.clientAction === true
              ? invocation.context?.threadId
              : undefined;
        if (threadId === undefined) return yield* pluginPermissionDenied();
        const thread = yield* target(threadId);
        const project = yield* projects
          .getShell(thread.projectId)
          .pipe(Effect.mapError(() => pluginPermissionDenied()));
        if (Option.isNone(project)) return yield* pluginPermissionDenied();
        return {
          threadId: thread.id,
          projectId: thread.projectId,
          projectTitle: project.value.title.slice(0, 200),
        };
      });
      type ConversationSender = Effect.Success<ReturnType<typeof conversationSender>>;
      const pluginMessage = (text: string, sender: ConversationSender | null) =>
        sender === null
          ? { text: `[Plugin: ${installation.manifest.name}]\n${text}` }
          : {
              text: `[Plugin: ${installation.manifest.name}, from project ${JSON.stringify(sender.projectTitle)}]\n${text}`,
              senderThreadId: sender.threadId,
              context: {
                version: 1 as const,
                records: [],
                pluginSender: { projectTitle: sender.projectTitle, text },
              },
            };
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
      const boundResult = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
        Schema.encodeEffect(schema)(value).pipe(
          Effect.filterOrFail(
            (encoded) => Buffer.byteLength(JSON.stringify(encoded)) <= 1_000_000,
            () =>
              new PluginError({
                reason: "invalid_result",
                message: "The plugin metadata page is too large. Request a smaller page.",
              }),
          ),
          Effect.mapError((error) =>
            isPluginError(error)
              ? error
              : new PluginError({
                  reason: "invalid_result",
                  message: "The plugin metadata result exceeds its bounds.",
                }),
          ),
        );
      const authorizeRead = Effect.fn("PluginHost.authorizeRead")(function* (
        projectIds: ReadonlyArray<ProjectId>,
      ) {
        const current = yield* readCurrent();
        if (
          !pluginCapabilityAllowed(current.installation, actor, "threads.read") ||
          !pluginCapabilityAllowed(current.installation, actor, "workflow.query") ||
          projectIds.some(
            (id) =>
              !pluginCapabilityAllowed(current.installation, actor, "threads.read", id) ||
              !pluginCapabilityAllowed(current.installation, actor, "workflow.query", id),
          )
        )
          return yield* pluginPermissionDenied();
      });
      if (method === "threads.metadata") {
        const request = yield* decode(PluginThreadMetadataInput, input);
        const shell = yield* target(request.threadId);
        yield* requireCapability("threads.read", shell.projectId);
        yield* requireCapability("workflow.query", shell.projectId);
        const result = yield* boundResult(PluginThreadMetadataSchema, threadMetadata(shell));
        yield* authorizeRead([shell.projectId]);
        return result;
      }
      if (method === "threads.list") {
        const request = yield* decode(PluginThreadsListInput, input);
        yield* requireCapability("threads.read", request.projectId);
        yield* requireCapability("workflow.query", request.projectId);
        const shells = yield* threads.listProjectThreads({
          projectId: request.projectId,
          includeSubagents: true,
        });
        const selected = page(
          shells
            .filter((thread) => thread.projectId === request.projectId && thread.deletedAt === null)
            .toSorted((a, b) => a.id.localeCompare(b.id)),
          request.cursor,
          request.limit,
        );
        const result = yield* boundResult(PluginThreadsList, {
          threads: selected.rows.map(threadMetadata),
          nextCursor: selected.nextCursor,
        });
        yield* authorizeRead([request.projectId]);
        return result;
      }
      if (method === "projects.list") {
        const request = yield* decode(PluginProjectsListInput, input);
        yield* requireCapability("threads.read");
        yield* requireCapability("workflow.query");
        const grantedIds = installation.grants.projectIds.filter(
          (id) =>
            pluginCapabilityAllowed(installation, actor, "threads.read", id) &&
            pluginCapabilityAllowed(installation, actor, "workflow.query", id),
        );
        const shells = yield* projects.listShells({ projectIds: grantedIds });
        const selected = page(
          shells
            .filter((project) => grantedIds.includes(project.id))
            .toSorted((a, b) => a.id.localeCompare(b.id)),
          request.cursor,
          request.limit,
        );
        const result = yield* boundResult(PluginProjectsList, {
          projects: selected.rows.map((project) => ({
            id: project.id,
            title: project.title.slice(0, 200),
            workspaceRoot: project.workspaceRoot.slice(0, 4_096),
            ...(project.defaultModelSelection == null
              ? {}
              : { defaultModelSelection: project.defaultModelSelection }),
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          })),
          nextCursor: selected.nextCursor,
        });
        yield* authorizeRead(selected.rows.map((project) => project.id));
        return result;
      }
      if (method === "projects.requestAccess") {
        const request = yield* decode(PluginProjectAccessInput, input);
        yield* requireCapability("projects.request-access");
        if (actor.source !== "agent" && invocation.clientAction !== true)
          return yield* pluginPermissionDenied();
        const shell = yield* target(request.threadId);
        yield* requireCapability("projects.request-access", shell.projectId);
        if (shell.pluginOwner?.installationId !== invocation.installationId)
          return yield* pluginPermissionDenied();
        const decisionAction = installation.manifest.actions.find(
          (action) => action.id === request.actionId,
        );
        // An agent calling it could pass off its own input as a person's answer.
        if (decisionAction === undefined || decisionAction.agentCallable === true)
          return yield* new PluginError({
            reason: "invalid_input",
            message: "The project request needs a declared action agents cannot call.",
          });
        // From here every result for an ungranted id reads alike, whether or not the project exists.
        if (installation.grants.projectIds.includes(request.projectId))
          return { status: "granted" as const };
        const project = yield* projects
          .getShell(request.projectId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(project)) return { status: "pending" as const };
        const requestedAt = DateTime.formatIso(yield* DateTime.now);
        const personSpokeAt = iso(shell.latestUserAuthoredMessageAt);
        return yield* mutate((current, currentState) => {
          const { projectAccessRequests = [], grants } = current.installation;
          const unchanged = (status: "pending" | "granted" | "declined") =>
            Effect.succeed([{ status }, currentState] as const);
          if (grants.projectIds.includes(request.projectId)) return unchanged("granted");
          const existing = projectAccessRequests.find(
            (entry) => entry.projectId === request.projectId,
          );
          // After "Not now", only a new message from the person reopens the question.
          if (
            existing?.declinedAt !== undefined &&
            (personSpokeAt === null || personSpokeAt <= existing.declinedAt)
          )
            return unchanged("declined");
          if (
            existing !== undefined &&
            existing.declinedAt === undefined &&
            existing.threadId === request.threadId &&
            existing.actionId === request.actionId
          )
            return unchanged("pending");
          const next = { ...request, requestedAt };
          return Effect.succeed([
            { status: "pending" as const },
            {
              ...currentState,
              installations: currentState.installations.map((entry) =>
                entry === current
                  ? {
                      ...entry,
                      installation: {
                        ...entry.installation,
                        projectAccessRequests:
                          existing === undefined
                            ? [...projectAccessRequests, next].slice(
                                -MAX_PLUGIN_PROJECT_ACCESS_REQUESTS,
                              )
                            : projectAccessRequests.map((item) =>
                                item === existing ? next : item,
                              ),
                      },
                    }
                  : entry,
              ),
            },
          ] as const);
        }, "projects.request-access");
      }
      if (method === "models.list") {
        const request = yield* decode(PluginModelsListInput, input);
        yield* requireCapability("threads.read", request.projectId);
        yield* requireCapability("workflow.query", request.projectId);
        if (Option.isNone(yield* projects.getShell(request.projectId)))
          return yield* pluginPermissionDenied();
        const catalog = yield* providers.getProviders;
        const enabled = yield* Effect.filter(catalog, (provider) =>
          threads.isProviderInstanceEnabledForProject({
            projectId: request.projectId,
            instanceId: provider.instanceId,
          }),
        );
        const models = enabled
          .filter((provider) => provider.enabled && isProviderAvailable(provider))
          .flatMap((provider) =>
            provider.models.map((model) => ({
              modelSelection: { instanceId: provider.instanceId, model: model.slug },
              title: model.name.slice(0, 200),
              providerTitle: (provider.displayName ?? provider.driver).slice(0, 200),
              options: model.capabilities?.optionDescriptors ?? [],
            })),
          )
          .toSorted(
            (a, b) =>
              a.modelSelection.instanceId.localeCompare(b.modelSelection.instanceId) ||
              a.modelSelection.model.localeCompare(b.modelSelection.model),
          );
        const selected = page(models, request.cursor, request.limit);
        const result = yield* boundResult(PluginModelsList, {
          models: selected.rows,
          nextCursor: selected.nextCursor,
        });
        yield* authorizeRead([request.projectId]);
        return result;
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
        const latest = yield* readCurrent();
        if (!pluginCapabilityAllowed(latest.installation, actor, "threads.read", shell.projectId))
          return yield* pluginPermissionDenied();
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
        const sender = request.fromConversation === true ? yield* conversationSender() : null;
        if (sender !== null) yield* requireCapability("threads.send", sender.projectId);
        return yield* dispatch(
          method,
          request.idempotencyKey,
          { ...request, ...(sender === null ? {} : { senderThreadId: sender.threadId }) },
          Effect.fn("PluginHost.send")(function* (commandKey) {
            const result = yield* threads
              .sendToThread({
                projectId: shell.projectId,
                threadId: shell.id,
                commandId: CommandId.make(commandKey),
                messageId: MessageId.make(`${commandKey}:message`),
                ...pluginMessage(request.text, sender),
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
            if (sender !== null) {
              const source = yield* target(sender.threadId, sender.projectId);
              if (!pluginCapabilityAllowed(current, actor, "threads.send", source.projectId))
                return yield* pluginPermissionDenied();
            }
          }),
        );
      }
      if (method === "threads.adopt" || method === "threads.unarchive") {
        const adoption =
          method === "threads.adopt" ? yield* decode(PluginThreadAdoptInput, input) : undefined;
        const request = adoption ?? (yield* decode(ThreadRead, input));
        if (
          method === "threads.unarchive" &&
          (actor.source !== "client" ||
            invocation.clientAction !== true ||
            invocation.event === true)
        )
          return yield* pluginPermissionDenied();
        const treeId = adoption?.owner.slice("tree:".length);
        const authorize = Effect.fn("PluginHost.authorizeOwnedThread")(function* () {
          const current = yield* readCurrent();
          const shell = yield* target(request.threadId);
          if (
            !actor.scopes.includes(AuthOrchestrationOperateScope) ||
            !pluginCapabilityAllowed(
              current.installation,
              actor,
              "ui.native-tree-projects",
              shell.projectId,
            ) ||
            !pluginTargetWithinCeiling(actor, shell) ||
            (treeId !== undefined &&
              !(current.installation.manifest.nativeTrees ?? []).some(
                (tree) => tree.id === treeId,
              )) ||
            (shell.pluginOwner !== undefined &&
              (shell.pluginOwner.installationId !== invocation.installationId ||
                (treeId !== undefined && shell.pluginOwner.treeId !== treeId))) ||
            !(yield* receipts.createdThread({
              installationId: invocation.installationId,
              threadId: shell.id,
            }))
          )
            return yield* pluginPermissionDenied();
          yield* actor.authorize?.() ?? Effect.void;
          if (!store.isCurrent(current.state)) return yield* pluginPermissionDenied();
          return shell;
        });
        yield* authorize();
        const commandId = CommandId.make(
          `plugin:${invocation.installationId}:${yield* digest(yield* encodeJson([actor.principalId, invocation.operationId, method, request]).pipe(Effect.mapError(() => pluginPermissionDenied())))}`,
        );
        if (treeId !== undefined) {
          yield* threads
            .dispatchAuthorized(
              {
                type: "thread.metadata.update",
                commandId,
                threadId: request.threadId,
                pluginOwner: { installationId: invocation.installationId, treeId },
              },
              authorize().pipe(Effect.map((shell) => shell.pluginOwner === undefined)),
            )
            .pipe(
              Effect.mapError((error) =>
                isPluginError(error)
                  ? error
                  : new PluginError({
                      reason: "operation_failed",
                      message: "The plugin could not adopt the thread.",
                    }),
              ),
            );
        } else {
          yield* threads
            .dispatchAuthorized(
              { type: "thread.unarchive", commandId, threadId: request.threadId },
              authorize().pipe(Effect.map((shell) => shell.archivedAt !== null)),
            )
            .pipe(
              Effect.mapError((error) =>
                isPluginError(error)
                  ? error
                  : new PluginError({
                      reason: "operation_failed",
                      message: "The plugin could not unarchive the thread.",
                    }),
              ),
            );
        }
        yield* authorize();
        return { threadId: request.threadId };
      }
      if (method === "threads.create") {
        const request = yield* decode(PluginThreadCreateInput, input);
        yield* requireCapability("threads.create", request.projectId);
        const treeId = request.owner?.slice("tree:".length);
        if (
          treeId !== undefined &&
          (!pluginCapabilityAllowed(
            installation,
            actor,
            "ui.native-tree-projects",
            request.projectId,
          ) ||
            !(installation.manifest.nativeTrees ?? []).some((tree) => tree.id === treeId))
        )
          return yield* pluginPermissionDenied();
        if (request.brief !== undefined)
          yield* requireCapability("ui.native-tree-conversations", request.projectId);
        const sourceThreadId =
          actor.source === "agent" ? actor.threadId : invocation.context?.threadId;
        // Source inheritance is optional; v1 create-only plugins use project defaults.
        const source =
          sourceThreadId === undefined ||
          !pluginCapabilityAllowed(installation, actor, "threads.read")
            ? null
            : yield* target(sourceThreadId);
        const caller =
          source !== null &&
          pluginCapabilityAllowed(installation, actor, "threads.read", source.projectId)
            ? source
            : null;
        const workspaceStrategy = request.workspaceStrategy ?? { type: "root" as const };
        if (workspaceStrategy.type === "worktree")
          yield* requireCapability("worktrees.create", request.projectId);
        const project = yield* projects.getShell(request.projectId);
        if (Option.isNone(project)) return yield* pluginPermissionDenied();
        const defaults = resolveProjectSettings(
          yield* settings.getSettings,
          request.projectId,
          project.value,
        ).settings;
        let modelSelection =
          request.modelSelection ??
          caller?.modelSelection ??
          defaults.defaultModelSelection ??
          undefined;
        if (modelSelection === undefined) {
          const catalog = yield* providers.getProviders;
          const enabled = yield* Effect.filter(catalog, (provider) =>
            threads.isProviderInstanceEnabledForProject({
              projectId: request.projectId,
              instanceId: provider.instanceId,
            }),
          );
          modelSelection = resolveDefaultProviderModelSelection(enabled, null) ?? undefined;
        }
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
        const sender = request.fromConversation === true ? yield* conversationSender() : null;
        if (sender !== null) yield* requireCapability("threads.create", sender.projectId);
        return yield* dispatch(
          method,
          request.idempotencyKey,
          {
            ...request,
            ...(caller === null ? {} : { launchedFrom: { threadId: caller.id } }),
            ...(sender === null ? {} : { senderThreadId: sender.threadId }),
          },
          Effect.fn("PluginHost.create")(function* (commandKey, revalidate) {
            if (workspaceStrategy.type === "worktree") {
              yield* launch
                .checkWorktreeBase({ projectId: request.projectId, workspaceStrategy })
                .pipe(
                  Effect.mapError(
                    () =>
                      new PluginError({
                        reason: "invalid_input",
                        message: "The worktree base does not resolve in this project.",
                      }),
                  ),
                );
              yield* revalidate();
            }
            const result = yield* launch
              .launch({
                commandId: CommandId.make(commandKey),
                threadId: ThreadId.make(`${commandKey}:thread`),
                projectId: request.projectId,
                title: request.title ?? "Plugin thread",
                ...(treeId === undefined
                  ? {}
                  : { pluginOwner: { installationId: invocation.installationId, treeId } }),
                modelSelection,
                runtimeMode,
                interactionMode,
                workspaceStrategy,
                ...(caller === null ? {} : { launchedFrom: { threadId: caller.id } }),
                ...(request.brief === undefined
                  ? {
                      initialMessage: {
                        messageId: MessageId.make(`${commandKey}:message`),
                        ...pluginMessage(request.text ?? "", sender),
                        attachments: [],
                      },
                    }
                  : {
                      pluginBrief: { pluginName: installation.manifest.name, text: request.brief },
                    }),
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
          Effect.fn("PluginHost.authorizeCreate")(function* (current) {
            if (
              !pluginCapabilityAllowed(current, actor, "threads.create", request.projectId) ||
              (treeId !== undefined &&
                (!pluginCapabilityAllowed(
                  current,
                  actor,
                  "ui.native-tree-projects",
                  request.projectId,
                ) ||
                  !(current.manifest.nativeTrees ?? []).some((tree) => tree.id === treeId))) ||
              (request.brief !== undefined &&
                !pluginCapabilityAllowed(
                  current,
                  actor,
                  "ui.native-tree-conversations",
                  request.projectId,
                )) ||
              (workspaceStrategy.type === "worktree" &&
                !pluginCapabilityAllowed(current, actor, "worktrees.create", request.projectId))
            )
              return yield* pluginPermissionDenied();
            if (caller !== null) {
              const source = yield* target(caller.id, caller.projectId);
              if (!pluginCapabilityAllowed(current, actor, "threads.read", source.projectId))
                return yield* pluginPermissionDenied();
            }
            if (sender !== null) {
              const source = yield* target(sender.threadId, sender.projectId);
              if (!pluginCapabilityAllowed(current, actor, "threads.create", source.projectId))
                return yield* pluginPermissionDenied();
            }
          }),
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
