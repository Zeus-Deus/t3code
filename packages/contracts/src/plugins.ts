import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Effect from "effect/Effect";

import {
  ForwardCompatibleArray,
  ForwardCompatibleUnion,
  isUnknownUnionMember,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadId,
} from "./baseSchemas.ts";

const text = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));
const identifier = text(128).check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/));
const relativeEntry = text(512).check(
  Schema.isPattern(/^(?![./\\])(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\0]+$/),
);

export const PLUGIN_API_VERSION = 1;
export const PLUGIN_CAPABILITIES = [
  "storage",
  "settings",
  "threads.read",
  "threads.send",
  "threads.create",
  "events.run-finalized",
  "ui",
] as const;
export const PluginCapability = Schema.Literals(PLUGIN_CAPABILITIES);
export type PluginCapability = typeof PluginCapability.Type;

export const PluginAction = Schema.Struct({
  id: identifier,
  title: text(200),
  description: Schema.optionalKey(text(2_000)),
  placements: Schema.Array(Schema.Literals(["palette", "thread-menu", "message-selection"])).check(
    Schema.isMaxLength(3),
  ),
  agentCallable: Schema.optionalKey(Schema.Boolean),
});
export type PluginAction = typeof PluginAction.Type;

export const PluginView = Schema.Struct({
  id: identifier,
  title: text(200),
  entry: relativeEntry.check(Schema.isPattern(/\.html$/)),
  placement: Schema.Literals(["page", "side-panel"]),
});
export type PluginView = typeof PluginView.Type;

/**
 * A compact, host-rendered status for the open thread, such as "Realm live". The client asks the
 * plugin's `status:<id>` handler while the thread is visible; activating it opens `viewId`.
 */
export const PluginThreadStatusItem = Schema.Struct({
  id: identifier,
  title: text(200),
  viewId: Schema.optionalKey(identifier),
});
export type PluginThreadStatusItem = typeof PluginThreadStatusItem.Type;
const PLUGIN_THREAD_STATUS_TONES = ["neutral", "info", "success", "warning", "danger"] as const;
export const PluginThreadStatus = Schema.Struct({
  label: text(40).check(Schema.isMinLength(1)),
  tone: Schema.Literals(PLUGIN_THREAD_STATUS_TONES),
  detail: Schema.optionalKey(text(300)),
});
export type PluginThreadStatus = typeof PluginThreadStatus.Type;

export const PluginSettingValue = Schema.Union([text(16_384), Schema.Finite, Schema.Boolean]);
export type PluginSettingValue = typeof PluginSettingValue.Type;
export const PluginSetting = Schema.Struct({
  key: identifier,
  label: text(200),
  description: Schema.optionalKey(text(2_000)),
  type: Schema.Literals(["string", "boolean", "number", "secret"]),
  default: Schema.optionalKey(PluginSettingValue),
});
export type PluginSetting = typeof PluginSetting.Type;

export const PluginManifest = Schema.Struct({
  id: text(128).check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/)),
  name: text(200),
  description: Schema.optionalKey(text(2_000)),
  version: text(128).check(
    Schema.isPattern(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/,
    ),
  ),
  apiVersion: Schema.Literal(1),
  entry: relativeEntry.check(Schema.isPattern(/\.(?:mjs|js)$/)),
  // Preserve unknown requirements so installation can explain incompatibility before execution.
  capabilities: Schema.Array(identifier).check(Schema.isMaxLength(64)),
  optionalCapabilities: Schema.optionalKey(Schema.Array(identifier).check(Schema.isMaxLength(64))),
  actions: Schema.Array(PluginAction).check(Schema.isMaxLength(100)),
  views: Schema.Array(PluginView).check(Schema.isMaxLength(30)),
  settings: Schema.Array(PluginSetting).check(Schema.isMaxLength(100)),
  threadStatus: Schema.optionalKey(
    Schema.Array(PluginThreadStatusItem).check(Schema.isMaxLength(4)),
  ),
});
export type PluginManifest = typeof PluginManifest.Type;

// Installation snapshots remain readable when newer hosts add presentation hints.
// The author manifest above stays strict so unsupported declarations fail at install.
const PluginManifestWire = Schema.Struct({
  ...PluginManifest.fields,
  actions: Schema.Array(
    Schema.Struct({
      ...PluginAction.fields,
      placements: ForwardCompatibleArray(PluginAction.fields.placements.value).check(
        Schema.isMaxLength(3),
      ),
    }),
  ).check(Schema.isMaxLength(100)),
  views: ForwardCompatibleArray(PluginView).check(Schema.isMaxLength(30)),
});

export const PluginSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local"), directory: text(4_096) }),
  Schema.Struct({
    kind: Schema.Literal("git"),
    url: text(4_096),
    ref: Schema.optionalKey(text(256)),
  }),
]);
export type PluginSource = typeof PluginSource.Type;
export const PluginGrants = Schema.Struct({
  capabilities: ForwardCompatibleArray(PluginCapability).check(Schema.isMaxLength(64)),
  projectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(1_000)),
});
export type PluginGrants = typeof PluginGrants.Type;
export const PluginEventBacklogPolicy = Schema.Struct({
  policy: Schema.Literals(["skip", "deliver"]),
  throughSequence: NonNegativeInt,
});
export type PluginEventBacklogPolicy = typeof PluginEventBacklogPolicy.Type;
export const PluginEventBacklog = Schema.Struct({
  count: NonNegativeInt,
  afterSequence: NonNegativeInt,
  throughSequence: NonNegativeInt,
  requiresChoice: Schema.Boolean,
});
export type PluginEventBacklog = typeof PluginEventBacklog.Type;
export const PluginRepairWorkspace = Schema.Struct({
  workspaceId: identifier,
  directory: text(4_096),
  baseDigest: text(64).check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  baseGeneration: identifier,
  draft: text(32_000),
});
export type PluginRepairWorkspace = typeof PluginRepairWorkspace.Type;
const PluginRevisionKind = Schema.Literals(["upstream", "local-repair", "previous"]);
const PluginRuntimeObservation = Schema.Struct({
  hostVersion: text(128),
  nodeVersion: text(128),
  at: IsoDateTime,
});
const PluginCompatibility = Schema.Struct({
  available: Schema.Boolean,
  missingCapabilities: Schema.Array(text(128)),
});
type PluginCompatibility = typeof PluginCompatibility.Type;
export const pluginRequestedCapabilities = (
  manifest: Pick<PluginManifest, "capabilities" | "optionalCapabilities">,
) => [...new Set([...manifest.capabilities, ...(manifest.optionalCapabilities ?? [])])];
export const pluginCompatibility = (
  manifest: Pick<PluginManifest, "capabilities">,
): PluginCompatibility => {
  const missingCapabilities = manifest.capabilities.filter(
    (capability) => !PLUGIN_CAPABILITIES.some((known) => known === capability),
  );
  return { available: missingCapabilities.length === 0, missingCapabilities };
};
export const PluginPendingUpdate = Schema.Struct({
  kind: Schema.optionalKey(PluginRevisionKind),
  manifest: PluginManifestWire,
  source: PluginSource,
  digest: text(64).check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  generation: identifier,
  updatedAt: IsoDateTime,
});
export type PluginPendingUpdate = typeof PluginPendingUpdate.Type;
export const PluginInstallation = Schema.Struct({
  installationId: identifier,
  generation: identifier,
  pendingUpdate: Schema.optionalKey(PluginPendingUpdate),
  recordIssue: Schema.optionalKey(text(64)),
  compatibility: Schema.optionalKey(PluginCompatibility),
  health: Schema.optionalKey(
    Schema.Struct({
      lastHealthy: Schema.optionalKey(PluginRuntimeObservation),
      fault: Schema.optionalKey(
        Schema.Struct({
          ...PluginRuntimeObservation.fields,
          reason: text(128),
          message: text(2_000),
          handler: Schema.optionalKey(text(256)),
        }),
      ),
    }),
  ),
  attention: Schema.optionalKey(
    Schema.Struct({ kind: text(128), message: text(2_000), since: IsoDateTime }),
  ),
  recovery: Schema.optionalKey(
    Schema.Struct({
      activeSource: Schema.Literals(["upstream", "local-repair"]),
      previous: Schema.optionalKey(
        Schema.Struct({ version: text(128), digest: text(64), source: PluginSource }),
      ),
      repair: Schema.optionalKey(PluginRepairWorkspace),
      upstreamSource: Schema.optionalKey(PluginSource),
    }),
  ),
  manifest: PluginManifestWire,
  source: PluginSource,
  digest: text(64).check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  enabled: Schema.Boolean,
  consentedDigest: Schema.NullOr(text(64)),
  status: Schema.Literals([
    "needs-consent",
    "disabled",
    "idle",
    "running",
    "error",
    "quarantined",
    "incompatible",
  ]),
  error: Schema.NullOr(text(2_000)),
  observerError: Schema.optionalKey(Schema.NullOr(text(2_000))),
  // Secret keys are omitted, never replaced with their stored values.
  settings: Schema.Record(identifier, PluginSettingValue),
  grants: PluginGrants,
  updatedAt: IsoDateTime,
});
export type PluginInstallation = typeof PluginInstallation.Type;

export const PluginActionContext = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  threadId: Schema.optionalKey(ThreadId),
  messageId: Schema.optionalKey(text(256)),
  selection: Schema.optionalKey(text(64_000)),
});
export type PluginActionContext = typeof PluginActionContext.Type;
/**
 * Who started an invocation, as established by the host. `threadId` is present only when the host
 * verified the caller acts for that T3 thread (an agent's own thread); it is never taken from
 * invocation input or target context.
 */
export const PluginCaller = Schema.Struct({
  kind: Schema.Literals(["client", "agent", "background"]),
  threadId: Schema.optionalKey(ThreadId),
});
export type PluginCaller = typeof PluginCaller.Type;
export const PLUGIN_RESULT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg"] as const;
export const MAX_PLUGIN_RESULT_IMAGES = 4;
export const MAX_PLUGIN_RESULT_IMAGE_BYTES = 4 * 1024 * 1024;
/** Image bytes the host read from the plugin's data directory and verified by signature. */
export const PluginResultImage = Schema.Struct({
  mimeType: Schema.Literals(PLUGIN_RESULT_IMAGE_MIME_TYPES),
  data: Schema.String.check(
    Schema.isMaxLength(Math.ceil(MAX_PLUGIN_RESULT_IMAGE_BYTES / 3) * 4),
    Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
  ),
});
export type PluginResultImage = typeof PluginResultImage.Type;
export const PluginClientIntent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("composer.insert"),
    text: text(64_000),
    quote: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("preview.open"),
    url: text(4_096).check(Schema.isPattern(/^https?:\/\//)),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.reveal"),
    threadId: ThreadId,
    messageId: Schema.optionalKey(text(256)),
  }),
  Schema.Struct({ type: Schema.Literal("view.open"), viewId: identifier }),
]);
export type PluginClientIntent = typeof PluginClientIntent.Type;
export const PluginInvokeInput = Schema.Struct({
  installationId: identifier,
  generation: identifier,
  handler: text(256).check(
    Schema.isPattern(
      /^(?:action:[a-zA-Z0-9][a-zA-Z0-9._-]*|status:[a-zA-Z0-9][a-zA-Z0-9._-]*|view:[a-zA-Z0-9][a-zA-Z0-9._-]*:[a-zA-Z0-9][a-zA-Z0-9._-]*)$/,
    ),
  ),
  input: Schema.optionalKey(Schema.Unknown),
  context: Schema.optionalKey(PluginActionContext),
  operationId: identifier,
});
export type PluginInvokeInput = typeof PluginInvokeInput.Type;
const invokeResultFields = {
  message: Schema.optionalKey(text(16_000)),
  data: Schema.optionalKey(Schema.Unknown),
  intents: Schema.optionalKey(Schema.Array(PluginClientIntent).check(Schema.isMaxLength(20))),
  unsupportedIntentCount: Schema.optionalKey(NonNegativeInt),
  images: Schema.optionalKey(
    Schema.Array(PluginResultImage).check(Schema.isMaxLength(MAX_PLUGIN_RESULT_IMAGES)),
  ),
};
const PluginInvokeResultDecoded = Schema.Struct(invokeResultFields);
const PluginInvokeResultWire = Schema.Struct({
  ...invokeResultFields,
  intents: Schema.optionalKey(
    Schema.Array(ForwardCompatibleUnion(PluginClientIntent.members, "type")).check(
      Schema.isMaxLength(20),
    ),
  ),
});
export const PluginInvokeResult = PluginInvokeResultWire.pipe(
  Schema.decodeTo(
    Schema.toType(PluginInvokeResultDecoded),
    SchemaTransformation.transform<
      typeof PluginInvokeResultDecoded.Type,
      typeof PluginInvokeResultWire.Type
    >({
      decode: ({ intents, ...result }) => {
        if (intents === undefined) return result;
        const known = intents.filter(
          (intent): intent is PluginClientIntent => !isUnknownUnionMember(intent),
        );
        const unsupportedIntentCount =
          (result.unsupportedIntentCount ?? 0) + intents.length - known.length;
        return {
          ...result,
          intents: known,
          ...(unsupportedIntentCount > 0 ? { unsupportedIntentCount } : {}),
        };
      },
      encode: (result) => result,
    }),
  ),
);
export type PluginInvokeResult = typeof PluginInvokeResult.Type;
export const PluginViewInput = Schema.Struct({
  installationId: identifier,
  generation: identifier,
  viewId: identifier,
});
export type PluginViewInput = typeof PluginViewInput.Type;
export const PluginViewResult = Schema.Struct({ html: text(1_000_000) });
export type PluginViewResult = typeof PluginViewResult.Type;
export const PluginCatalogue = Schema.Struct({
  executionDisabled: Schema.optionalKey(Schema.Boolean),
  unavailable: Schema.optionalKey(Schema.Struct({ message: text(2_000) })),
  // Decode each record before filtering: the shared array's encoding fallback validates
  // nested grants and placements before their tolerant decoders can run.
  installations: Schema.Array(
    Schema.UndefinedOr(PluginInstallation).pipe(
      Schema.catchDecoding(() => Effect.succeedSome(undefined)),
    ),
  ).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.toType(PluginInstallation)),
      SchemaTransformation.transform<
        ReadonlyArray<PluginInstallation>,
        ReadonlyArray<PluginInstallation | undefined>
      >({
        decode: (records) => records.filter((record) => record !== undefined),
        encode: (records) => records,
      }),
    ),
  ),
});
export type PluginCatalogue = typeof PluginCatalogue.Type;
export const PluginRunFinalizedEvent = Schema.Struct({
  deliveryId: text(256),
  threadId: ThreadId,
  projectId: ProjectId,
  runId: RunId,
  outcome: Schema.Literals(["completed", "failed", "interrupted"]),
  summary: Schema.optionalKey(text(16_000)),
});
export type PluginRunFinalizedEvent = typeof PluginRunFinalizedEvent.Type;

export const PluginFailureReason = Schema.Literals([
  "not_found",
  "invalid_source",
  "invalid_manifest",
  "incompatible",
  "changed_source",
  "needs_consent",
  "disabled",
  "stale_generation",
  "permission_denied",
  "invalid_handler",
  "invalid_input",
  "invalid_result",
  "start_failed",
  "crashed",
  "timeout",
  "cancelled",
  "busy",
  "quarantined",
  "storage_failed",
  "operation_failed",
]);
export type PluginFailureReason = typeof PluginFailureReason.Type;
export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  // Unknown failure codes must remain visible when a newer server replies to an older client.
  reason: Schema.Union([PluginFailureReason, text(128)]),
  message: text(2_000),
  code: Schema.optionalKey(text(128)),
  priorEffect: Schema.optionalKey(Schema.Struct({ threadId: ThreadId })),
}) {}
