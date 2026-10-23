import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  PluginError,
  pluginRequestedCapabilities,
  type AuthEnvironmentScope,
  type PluginCapability,
  type PluginInstallation,
  type ProjectId,
  type RuntimeMode,
  type ThreadId,
  type ProviderInteractionMode,
} from "@t3tools/contracts";

import { pluginCompatibilityForHost } from "./PluginCompatibility.ts";

export interface PluginActor {
  readonly principalId: string;
  readonly source: "client" | "agent" | "background";
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly threadId?: ThreadId;
  readonly projectIds?: ReadonlyArray<ProjectId>;
  /** Server supplied check, rerun before host operations when the caller has a live credential. */
  readonly authorize?: () => import("effect/Effect").Effect<void, PluginError>;
}

export function pluginPermissionDenied() {
  return new PluginError({
    reason: "permission_denied",
    message: "The plugin or invoking actor lacks permission for this operation.",
  });
}

export function assertPluginActive(installation: PluginInstallation, generation: string) {
  if (installation.generation !== generation)
    return new PluginError({
      reason: "stale_generation",
      message: "This plugin generation has been revoked. Reload the plugin catalogue.",
    });
  if (installation.consentedDigest !== installation.digest)
    return new PluginError({
      reason: "needs_consent",
      message: "Review and consent to this exact plugin snapshot before running it.",
    });
  if (!installation.enabled)
    return new PluginError({ reason: "disabled", message: "This plugin is disabled." });
  if (!pluginCompatibilityForHost(installation.manifest).available)
    return new PluginError({
      reason: "incompatible",
      message: "This plugin requires an unsupported host capability.",
    });
  if (installation.status === "quarantined")
    return new PluginError({
      reason: "quarantined",
      message: "This plugin is quarantined. Resume it from plugin settings.",
    });
  return undefined;
}

export function pluginCapabilityAllowed(
  installation: PluginInstallation,
  actor: PluginActor,
  capability: PluginCapability,
  projectId?: ProjectId,
) {
  if (
    !pluginRequestedCapabilities(installation.manifest).includes(capability) ||
    !installation.grants.capabilities.includes(capability)
  )
    return false;
  if (
    projectId !== undefined &&
    (!installation.grants.projectIds.includes(projectId) ||
      (actor.projectIds !== undefined && !actor.projectIds.includes(projectId)))
  )
    return false;
  const scope =
    capability === "threads.read"
      ? AuthOrchestrationReadScope
      : capability === "threads.send" || capability === "threads.create"
        ? AuthOrchestrationOperateScope
        : undefined;
  return scope === undefined || actor.scopes.includes(scope);
}

const modeRank: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
export function pluginTargetWithinCeiling(
  actor: PluginActor,
  target: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
) {
  return (
    modeRank[target.runtimeMode] <= modeRank[actor.runtimeMode] &&
    (actor.interactionMode !== "plan" || target.interactionMode === "plan")
  );
}
