import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  PluginError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PluginService from "../../../plugins/PluginService.ts";
import * as SessionStore from "../../../auth/SessionStore.ts";
import type { PluginActor } from "../../../plugins/PluginAuthority.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertLiveCaller, assertTargetWithinLimits, readCaller } from "../../threadAccess.ts";
import type { Tool } from "effect/ai";
import {
  PluginInvokeTool,
  PluginInvokeToolkit,
  PluginListToolkit,
  PluginToolkit,
} from "./tools.ts";

const failure = (error: PluginError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "permission_denied"
        ? "capability_denied"
        : [
              "start_failed",
              "crashed",
              "timeout",
              "cancelled",
              "busy",
              "quarantined",
              "storage_failed",
              "operation_failed",
            ].includes(error.reason)
          ? "orchestration_error"
          : "invalid_request",
    message: error.message,
  });

const t3_plugin_list = McpToolAccess.reads(() =>
  Effect.gen(function* () {
    yield* McpInvocationContext.requireMcpCapability("orchestration").pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "This credential cannot access environment plugins.",
          }),
      ),
    );
    const service = yield* PluginService.PluginService;
    const catalogue = yield* service.list().pipe(Effect.mapError(failure));
    return {
      plugins: catalogue.installations
        .filter(
          (item) =>
            item.enabled &&
            item.consentedDigest === item.digest &&
            (item.status === "idle" || item.status === "running"),
        )
        .map((item) => ({
          installationId: item.installationId,
          generation: item.generation,
          id: item.manifest.id,
          name: item.manifest.name,
          ...(item.observerError ? { observerError: item.observerError } : {}),
          ...(item.manifest.description === undefined
            ? {}
            : { description: item.manifest.description }),
          actions: item.manifest.actions
            .filter((action) => action.agentCallable === true)
            .map(({ id, title, description }) => ({
              id,
              title,
              ...(description === undefined ? {} : { description }),
            })),
        }))
        .filter((item) => item.actions.length > 0),
    };
  }),
);
const t3_plugin_invoke = McpToolAccess.writes((input: Tool.Parameters<typeof PluginInvokeTool>) =>
  Effect.gen(function* () {
    const caller = yield* readCaller();
    const service = yield* PluginService.PluginService;
    const sessions = yield* SessionStore.SessionStore;
    const actor: PluginActor = {
      source: "agent",
      principalId:
        caller.scope.thread === undefined
          ? `mcp:${caller.scope.client?.sessionId ?? caller.scope.requestNamespace}`
          : `thread:${encodeURIComponent(caller.scope.thread.threadId)}:${encodeURIComponent(caller.scope.thread.providerInstanceId)}`,
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      runtimeMode: caller.limits.runtimeMode,
      interactionMode: caller.limits.interactionMode,
      ...(caller.scope.thread === undefined ? {} : { threadId: caller.scope.thread.threadId }),
      authorize: Effect.fn("mcp.plugins.authorize")(
        function* () {
          if (caller.scope.thread === undefined) {
            if (caller.scope.client !== undefined) {
              yield* sessions.assertActive(AuthSessionId.make(caller.scope.client.sessionId));
            }
            return;
          }
          const fresh = yield* caller.threads.getThreadShell(caller.scope.thread.threadId);
          if (fresh === null || fresh.deletedAt !== null) {
            return yield* new PluginError({
              reason: "permission_denied",
              message: "The invoking agent is no longer active.",
            });
          }
          yield* assertLiveCaller({ ...caller, caller: fresh });
          // A reduced caller mode revokes this invocation's previously captured authority.
          yield* assertTargetWithinLimits(fresh, caller.limits);
        },
        Effect.mapError(
          () =>
            new PluginError({
              reason: "permission_denied",
              message: "The invoking agent's authority has changed. Invoke the action again.",
            }),
        ),
      ),
    };
    return yield* service
      .invoke(
        {
          installationId: input.installationId,
          generation: input.generation,
          handler: `action:${input.actionId}`,
          operationId: input.operationId,
          ...(input.input === undefined ? {} : { input: input.input }),
          context: {
            ...(caller.caller === undefined
              ? {}
              : {
                  threadId: caller.caller.id,
                  projectId: caller.caller.projectId,
                }),
            ...input.context,
          },
        },
        actor,
      )
      .pipe(Effect.mapError(failure));
  }),
);

export const layer = McpToolAccess.toLayer(PluginToolkit, { t3_plugin_list, t3_plugin_invoke });
export const layerList = McpToolAccess.toLayer(PluginListToolkit, { t3_plugin_list });
export const layerInvoke = McpToolAccess.toLayer(PluginInvokeToolkit, { t3_plugin_invoke });
