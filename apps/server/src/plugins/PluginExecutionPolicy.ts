import { PluginError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import packageJson from "../../package.json" with { type: "json" };

export class PluginExecutionPolicy extends Context.Reference<{
  readonly safeMode: boolean;
  readonly hostVersion: string;
  readonly nodeVersion: string;
}>("t3/plugins/PluginExecutionPolicy", {
  defaultValue: () => ({
    safeMode: false,
    hostVersion: packageJson.version,
    nodeVersion: process.versions.node,
  }),
}) {}

export const assertPluginExecutionAllowed = (policy: { readonly safeMode: boolean }) =>
  policy.safeMode
    ? new PluginError({
        reason: "disabled",
        code: "execution_disabled",
        message: "Plugin execution is disabled in safe mode. Plugin management remains available.",
      })
    : undefined;
