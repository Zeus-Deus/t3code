import { PluginInvokeInput, PluginInvokeResult, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as PluginService from "../../../plugins/PluginService.ts";
import * as SessionStore from "../../../auth/SessionStore.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    PluginService.PluginService,
    SessionStore.SessionStore,
    ThreadManagement.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};

const ListTool = Tool.make("t3_plugin_list", {
  ...shared,
  description:
    "List enabled environment plugins and the actions their authors explicitly expose to agents. This never installs, enables, or starts a plugin. Retain installationId and generation for t3_plugin_invoke; refreshed or disabled installations revoke that generation.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    plugins: Schema.Array(
      Schema.Struct({
        installationId: PluginInvokeInput.fields.installationId,
        generation: PluginInvokeInput.fields.generation,
        id: Schema.String,
        name: Schema.String,
        description: Schema.optionalKey(Schema.String),
        observerError: Schema.optionalKey(Schema.String),
        actions: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            title: Schema.String,
            description: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const InvokeTool = Tool.make("t3_plugin_invoke", {
  ...shared,
  description:
    "Invoke an agent-callable action returned by t3_plugin_list. This runs trusted plugin code on the environment. Pass a unique operationId per intended action and reuse it when retrying that action. Plugin host operations stay within its project grants and the calling agent's permission modes. Omitted context uses this T3 thread; an outside agent supplies its target. Client intents are returned as data: this call never inserts into a user's composer or changes their navigation. Images an action returns arrive as image content.",
  parameters: Schema.Struct({
    installationId: PluginInvokeInput.fields.installationId,
    generation: PluginInvokeInput.fields.generation,
    actionId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)),
    operationId: PluginInvokeInput.fields.operationId,
    input: PluginInvokeInput.fields.input,
    context: PluginInvokeInput.fields.context,
    includeImages: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        "Images the action returns are attached as image content unless this is false. Providers resend images in later turns, so pass false when only the text result is needed.",
    }),
  }),
  success: PluginInvokeResult,
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const PluginToolkit = Toolkit.make(ListTool, InvokeTool);
export const PluginListToolkit = Toolkit.make(ListTool);
export const PluginInvokeToolkit = Toolkit.make(InvokeTool);
export { InvokeTool as PluginInvokeTool };
