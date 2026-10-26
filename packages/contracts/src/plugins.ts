import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SchemaGetter from "effect/SchemaGetter";

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

import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";
import { ProviderOptionDescriptor } from "./model.ts";

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
  "ui.sidebar-views",
  "ui.native-trees",
  "ui.conversation-cards",
  "ui.changes",
  "worktrees.create",
  "workflow.query",
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
  placement: Schema.Literals(["page", "side-panel", "conversation"]),
});
export type PluginView = typeof PluginView.Type;

/** Host glyphs a thread status may name; plugins cannot ship their own. */
const PLUGIN_THREAD_STATUS_ICONS = [
  "monitor",
  "globe",
  "bot",
  "terminal",
  "box",
  "activity",
] as const;
export const PluginThreadStatusIcon = Schema.Literals(PLUGIN_THREAD_STATUS_ICONS);
export type PluginThreadStatusIcon = typeof PluginThreadStatusIcon.Type;

/**
 * A compact, host-rendered status for the open thread, shown as "Realm · Live". The client asks
 * the plugin's `status:<id>` handler while the thread is visible; activating it opens `viewId`.
 */
export const PluginThreadStatusItem = Schema.Struct({
  id: identifier,
  title: text(200),
  icon: Schema.optionalKey(PluginThreadStatusIcon),
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

/**
 * An alternative arrangement of the client's thread sidebar. The plugin only declares the rules;
 * the client derives the view from the threads it already has and renders its own rows, so no
 * thread data reaches the plugin. Requires the `ui.sidebar-views` capability, which older hosts
 * refuse, so the declaration cannot be silently ignored at install.
 */
export const PluginSidebarView = Schema.Struct({
  id: identifier,
  title: text(40).check(Schema.isMinLength(1)),
  description: Schema.optionalKey(text(300)),
  groupBy: Schema.Literal("project"),
  /** Projects with nothing active and no activity for this many days fold away. Absent: never. */
  quietAfterDays: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(365)),
  ),
  /** Whether projects without any threads get a heading. Defaults to `hide`. */
  emptyProjects: Schema.optionalKey(Schema.Literals(["show", "hide"])),
});
export type PluginSidebarView = typeof PluginSidebarView.Type;
export const PLUGIN_SIDEBAR_VIEW_CAPABILITY: PluginCapability = "ui.sidebar-views";

export const PluginNativeTree = Schema.Struct({
  id: identifier,
  title: text(40).check(Schema.isMinLength(1)),
  description: Schema.optionalKey(text(300)),
});
export type PluginNativeTree = typeof PluginNativeTree.Type;
export const MAX_PLUGIN_TREE_NODES = 2_000;
export const MAX_PLUGIN_TREE_DEPTH = 16;
export const MAX_PLUGIN_TREE_BYTES = 128_000;
const treeNodeFields = {
  id: identifier,
  parentId: Schema.optionalKey(identifier),
  collapsedByDefault: Schema.optionalKey(Schema.Boolean),
};
export const PluginTreeNode = Schema.Union([
  Schema.Struct({
    ...treeNodeFields,
    kind: Schema.Literal("group"),
    title: text(200).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({ ...treeNodeFields, kind: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({ ...treeNodeFields, kind: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type PluginTreeNode = typeof PluginTreeNode.Type;
export const PluginTreeSnapshot = Schema.Struct({
  nodes: Schema.Array(PluginTreeNode).check(Schema.isMaxLength(MAX_PLUGIN_TREE_NODES)),
});
export type PluginTreeSnapshot = typeof PluginTreeSnapshot.Type;
export const PluginTreeInput = Schema.Struct({
  installationId: identifier,
  generation: identifier,
  treeId: identifier,
  operationId: identifier,
});
export type PluginTreeInput = typeof PluginTreeInput.Type;
export const PluginChanged = Schema.Struct({
  installationId: identifier,
  generation: identifier,
  topic: text(256).check(Schema.isPattern(/^(?:tree|view|status):[a-zA-Z0-9][a-zA-Z0-9._-]*$/)),
});
export type PluginChanged = typeof PluginChanged.Type;
export const PluginInvalidateInput = Schema.Struct({
  topics: Schema.Array(PluginChanged.fields.topic).check(Schema.isMaxLength(36)),
});
export const PLUGIN_VIEW_BRIDGE_FEATURES = [
  "changes",
  "local-intents",
  "resize",
  "card-context",
] as const;
export const MAX_PLUGIN_CARD_DATA_BYTES = 2_048;
export const MAX_PLUGIN_CARD_BYTES = 4_096;
export const MAX_PLUGIN_RESULT_BYTES = 128_000;
export const PluginConversationCard = Schema.Struct({
  viewId: identifier,
  summary: text(1_000).check(Schema.isMinLength(1)),
  data: Schema.optionalKey(Schema.Json),
});
export type PluginConversationCard = typeof PluginConversationCard.Type;
/** Host-stamped provenance. A retained data owner may mount a prior generation; identity grants no authority. */
export const PluginCardReference = Schema.Struct({
  ...PluginConversationCard.fields,
  installationId: identifier,
  generation: identifier,
  dataOwner: identifier,
});
export type PluginCardReference = typeof PluginCardReference.Type;
export const PluginCardViewInput = Schema.Struct({
  installationId: identifier,
  generation: identifier,
  card: PluginCardReference,
});
export type PluginCardViewInput = typeof PluginCardViewInput.Type;
export const PluginWorkspaceStrategy = Schema.Union([
  Schema.Struct({ type: Schema.Literal("root") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    branch: Schema.optionalKey(text(256)),
    baseRef: text(256),
    startFromOrigin: Schema.optionalKey(Schema.Boolean),
  }),
]);
export const PluginThreadCreateInput = Schema.Struct({
  idempotencyKey: identifier,
  projectId: ProjectId,
  title: Schema.optionalKey(text(200).check(Schema.isMinLength(1))),
  text: text(64_000).check(Schema.isMinLength(1)),
  modelSelection: Schema.optionalKey(ModelSelection),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  workspaceStrategy: Schema.optionalKey(PluginWorkspaceStrategy),
});
export type PluginThreadCreateInput = typeof PluginThreadCreateInput.Type;
const pluginPageFields = {
  cursor: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ),
};
export const PluginProjectsListInput = Schema.Struct(pluginPageFields);
export const PluginThreadsListInput = Schema.Struct({ ...pluginPageFields, projectId: ProjectId });
export const PluginThreadMetadataInput = Schema.Struct({ threadId: ThreadId });
export const PluginProjectMetadata = Schema.Struct({
  id: ProjectId,
  title: text(200),
  workspaceRoot: text(4_096),
  defaultModelSelection: Schema.optionalKey(ModelSelection),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PluginProjectMetadata = typeof PluginProjectMetadata.Type;
export const PluginThreadMetadata = Schema.Struct({
  creationSource: Schema.optionalKey(text(128)),
  isRunning: Schema.optionalKey(Schema.Boolean),
  needsAttention: Schema.optionalKey(Schema.Boolean),
  id: ThreadId,
  projectId: ProjectId,
  title: text(200),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  settledAt: Schema.NullOr(IsoDateTime),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  snoozedAt: Schema.NullOr(IsoDateTime),
  pinnedAt: Schema.NullOr(IsoDateTime),
  branch: Schema.NullOr(text(256)),
  worktreePath: Schema.NullOr(text(4_096)),
  lineage: Schema.Struct({
    parentThreadId: Schema.NullOr(ThreadId),
    relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
    rootThreadId: ThreadId,
  }),
  launchedFrom: Schema.optionalKey(Schema.Struct({ threadId: ThreadId })),
});
export type PluginThreadMetadata = typeof PluginThreadMetadata.Type;
export const PluginProjectsList = Schema.Struct({
  projects: Schema.Array(PluginProjectMetadata).check(Schema.isMaxLength(200)),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export const PluginThreadsList = Schema.Struct({
  threads: Schema.Array(PluginThreadMetadata).check(Schema.isMaxLength(200)),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export const PluginModel = Schema.Struct({
  modelSelection: ModelSelection,
  title: text(200),
  providerTitle: text(200),
  options: Schema.Array(ProviderOptionDescriptor).check(Schema.isMaxLength(32)),
});
export type PluginModel = typeof PluginModel.Type;
export const PluginModelsListInput = Schema.Struct({ ...pluginPageFields, projectId: ProjectId });
export const PluginModelsList = Schema.Struct({
  models: Schema.Array(PluginModel).check(Schema.isMaxLength(200)),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type PluginModelsList = typeof PluginModelsList.Type;

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
  sidebarViews: Schema.optionalKey(Schema.Array(PluginSidebarView).check(Schema.isMaxLength(2))),
  nativeTrees: Schema.optionalKey(Schema.Array(PluginNativeTree).check(Schema.isMaxLength(2))),
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
  nativeTrees: Schema.optionalKey(
    ForwardCompatibleArray(PluginNativeTree).check(Schema.isMaxLength(2)),
  ),
  // A view using a rule value from a newer host is dropped; the rest of the plugin still loads.
  sidebarViews: Schema.optionalKey(
    ForwardCompatibleArray(PluginSidebarView).check(Schema.isMaxLength(2)),
  ),
  threadStatus: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        ...PluginThreadStatusItem.fields,
        // An icon from a newer host is cosmetic, so it falls back to the default glyph.
        icon: Schema.optionalKey(Schema.Unknown).pipe(
          Schema.decodeTo(Schema.optionalKey(PluginThreadStatusIcon), {
            decode: SchemaGetter.transformOptional(
              Option.filter(Schema.is(PluginThreadStatusIcon)),
            ),
            encode: SchemaGetter.passthroughSupertype(),
          }),
        ),
      }),
    ).check(Schema.isMaxLength(4)),
  ),
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
  /** Matches retained card data after reinstall; the server still authorizes every card read. */
  dataOwner: Schema.optionalKey(identifier),
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
 * Handler context enriched by the host; lineage describes the target, never caller identity.
 * `lineage: "unresolved"` means a read failed or ancestry is missing, deleted, cyclic or over the
 * depth bound; `subagentOf` is then omitted. Retry before choosing an owner from `threadId`.
 * This optional v1 addition is absent on older hosts, so omission alone is not proof of a root.
 */
export const PluginInvocationContext = Schema.Struct({
  ...PluginActionContext.fields,
  subagentOf: Schema.optionalKey(ThreadId),
  lineage: Schema.optionalKey(Schema.Literal("unresolved")),
});
export type PluginInvocationContext = typeof PluginInvocationContext.Type;
// Caller identity is host-verified, never derived from target input. subagentOf follows only
// subagent edges to their first non-subagent ancestor. Unresolved lineage omits that field;
// missing lineage on an older v1 host is not proof of a root thread.
export const PluginCaller = Schema.Struct({
  kind: Schema.Literals(["client", "agent", "background"]),
  threadId: Schema.optionalKey(ThreadId),
  subagentOf: Schema.optionalKey(ThreadId),
  lineage: Schema.optionalKey(Schema.Literal("unresolved")),
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
  Schema.Struct({
    type: Schema.Literal("view.open"),
    viewId: identifier,
    threadId: Schema.optionalKey(ThreadId),
  }),
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
  card: Schema.optionalKey(PluginCardReference),
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
