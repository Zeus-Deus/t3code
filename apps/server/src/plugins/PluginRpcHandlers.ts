import { WS_METHODS, WsRpcGroup, PluginError } from "@t3tools/contracts";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type { SocketCredential } from "../auth/SessionStore.ts";
import * as Effect from "effect/Effect";
import * as PluginService from "./PluginService.ts";
import type { PluginActor } from "./PluginAuthority.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";

export const pluginRpcTags = [
  WS_METHODS.pluginsPrepareRepair,
  WS_METHODS.pluginsStageRepair,
  WS_METHODS.pluginsUsePrevious,
  WS_METHODS.pluginsBacklog,
  WS_METHODS.pluginsList,
  WS_METHODS.pluginsSubscribe,
  WS_METHODS.pluginsInstall,
  WS_METHODS.pluginsRefresh,
  WS_METHODS.pluginsDiscardPendingUpdate,
  WS_METHODS.pluginsConsent,
  WS_METHODS.pluginsGrantProject,
  WS_METHODS.pluginsAnswerProjectAccess,
  WS_METHODS.pluginsSetEnabled,
  WS_METHODS.pluginsResume,
  WS_METHODS.pluginsRemove,
  WS_METHODS.pluginsUpdateSettings,
  WS_METHODS.pluginsInvoke,
  WS_METHODS.pluginsReadView,
  WS_METHODS.pluginsReadTree,
  WS_METHODS.pluginsReadCardView,
  WS_METHODS.pluginsSubscribeChanges,
] as const;
const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"], (typeof pluginRpcTags)[number]> =>
      !pluginRpcTags.some((pluginTag) => pluginTag === tag),
  ),
).middleware(RpcInstrumentation);

export const layer = (actor: PluginActor, credential: Pick<SocketCredential, "assertActive">) =>
  group.toLayer(
    Effect.gen(function* () {
      const plugins = yield* PluginService.PluginService;
      const authorizedActor: PluginActor = {
        ...actor,
        authorize: () =>
          credential.assertActive.pipe(
            Effect.andThen(() => actor.authorize?.() ?? Effect.void),
            Effect.mapError(
              () =>
                new PluginError({
                  reason: "permission_denied",
                  message: "The invoking session is no longer authorized.",
                }),
            ),
          ),
      };
      return group.of({
        [WS_METHODS.pluginsPrepareRepair]: (input) => plugins.prepareRepair(input),
        [WS_METHODS.pluginsStageRepair]: (input) => plugins.stageRepair(input),
        [WS_METHODS.pluginsUsePrevious]: (input) => plugins.usePrevious(input),
        [WS_METHODS.pluginsBacklog]: (input) => plugins.backlog(input),
        [WS_METHODS.pluginsList]: () => plugins.list(),
        [WS_METHODS.pluginsSubscribe]: () => plugins.subscribe,
        [WS_METHODS.pluginsInstall]: (input) => plugins.install(input),
        [WS_METHODS.pluginsRefresh]: (input) => plugins.refresh(input),
        [WS_METHODS.pluginsDiscardPendingUpdate]: (input) => plugins.discardPendingUpdate(input),
        [WS_METHODS.pluginsConsent]: (input) => plugins.consent(input),
        [WS_METHODS.pluginsGrantProject]: (input) => plugins.grantProject(input, authorizedActor),
        [WS_METHODS.pluginsAnswerProjectAccess]: (input) =>
          plugins.answerProjectAccess(input, authorizedActor),
        [WS_METHODS.pluginsSetEnabled]: (input) => plugins.setEnabled(input),
        [WS_METHODS.pluginsResume]: (input) => plugins.resume(input),
        [WS_METHODS.pluginsRemove]: (input) => plugins.remove(input),
        [WS_METHODS.pluginsUpdateSettings]: (input) => plugins.updateSettings(input),
        [WS_METHODS.pluginsInvoke]: (input) => plugins.invoke(input, authorizedActor),
        [WS_METHODS.pluginsReadView]: (input) => plugins.readView(input),
        [WS_METHODS.pluginsReadTree]: (input) => plugins.readTree(input, authorizedActor),
        [WS_METHODS.pluginsReadCardView]: (input) => plugins.readCardView(input, authorizedActor),
        [WS_METHODS.pluginsSubscribeChanges]: () => plugins.subscribeChanges(authorizedActor),
      });
    }),
  );
