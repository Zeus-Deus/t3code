import * as Schema from "effect/Schema";
import {
  MAX_PLUGIN_RESULT_IMAGES,
  PLUGIN_RESULT_IMAGE_MIME_TYPES,
  PluginInvocationContext,
  PluginCaller,
  PluginConversationCard,
  PluginClientIntent,
  PluginResultImage,
  ThreadId,
} from "@t3tools/contracts";

export const PluginWorkerResult = Schema.Struct({
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_000))),
  data: Schema.optionalKey(Schema.Unknown),
  intents: Schema.optionalKey(Schema.Array(PluginClientIntent).check(Schema.isMaxLength(20))),
  unsupportedIntentCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  images: Schema.optionalKey(Schema.Array(PluginResultImage).check(Schema.isMaxLength(4))),
  card: Schema.optionalKey(PluginConversationCard),
});

const PLUGIN_IPC_VERSION = 1;
const MAX_PLUGIN_MESSAGE_BYTES = 1_048_576;
export const MAX_PLUGIN_PENDING_HOST_CALLS = 128;
export const MAX_PLUGIN_FAILURE_MESSAGE_CHARS = 2_000;
export const PluginHostMethod = Schema.Literals([
  "settings.get",
  "storage.get",
  "storage.set",
  "storage.delete",
  "threads.read",
  "threads.send",
  "threads.create",
  "threads.list",
  "threads.metadata",
  "threads.adopt",
  "threads.unarchive",
  "projects.list",
  "models.list",
  "ui.invalidate",
]);
export type PluginHostMethod = typeof PluginHostMethod.Type;
const id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const PluginHostFailure = Schema.Struct({
  reason: Schema.String.check(Schema.isMaxLength(128)),
  message: Schema.String.check(Schema.isMaxLength(MAX_PLUGIN_FAILURE_MESSAGE_CHARS)),
  code: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  priorEffect: Schema.optionalKey(Schema.Struct({ threadId: ThreadId })),
});
/** A worker names image files in its data directory; the parent reads and verifies the bytes. */
export const PluginWorkerImage = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  mimeType: Schema.Literals(PLUGIN_RESULT_IMAGE_MIME_TYPES),
});
export type PluginWorkerImage = typeof PluginWorkerImage.Type;
export const PluginWorkerImages = Schema.Array(PluginWorkerImage).check(
  Schema.isMaxLength(MAX_PLUGIN_RESULT_IMAGES),
);
export const PluginParentMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("init"),
    protocol: Schema.Literal(PLUGIN_IPC_VERSION),
    directory: Schema.String,
    entry: Schema.String,
    dataDirectory: Schema.String,
    capabilities: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("invoke"),
    invocationId: id,
    operationId: id,
    handler: id,
    input: Schema.optionalKey(Schema.Unknown),
    context: Schema.optionalKey(PluginInvocationContext),
    caller: PluginCaller,
  }),
  Schema.Struct({
    type: Schema.Literal("host-result"),
    invocationId: id,
    callId: id,
    ok: Schema.Boolean,
    value: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(PluginHostFailure),
  }),
  Schema.Struct({ type: Schema.Literal("cancel"), invocationId: id }),
  Schema.Struct({ type: Schema.Literal("stop") }),
]);
export type PluginParentMessage = typeof PluginParentMessage.Type;
export const PluginChildMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("booted"), protocol: Schema.Literal(1) }),
  Schema.Struct({ type: Schema.Literal("ready"), protocol: Schema.Literal(PLUGIN_IPC_VERSION) }),
  Schema.Struct({ type: Schema.Literal("cancelled"), invocationId: id }),
  Schema.Struct({
    type: Schema.Literal("result"),
    invocationId: id,
    result: PluginWorkerResult,
    images: Schema.optionalKey(PluginWorkerImages),
  }),
  Schema.Struct({
    type: Schema.Literal("failure"),
    invocationId: Schema.optionalKey(id),
    message: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(MAX_PLUGIN_FAILURE_MESSAGE_CHARS)),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("host-call"),
    invocationId: id,
    callId: id,
    method: PluginHostMethod,
    input: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("log"),
    level: Schema.Literals(["debug", "info", "warn", "error"]),
    message: Schema.String.check(Schema.isMaxLength(2_000)),
  }),
]);
export type PluginChildMessage = typeof PluginChildMessage.Type;
export const decodeParentMessage = Schema.decodeUnknownSync(PluginParentMessage);
export const decodeChildMessage = Schema.decodeUnknownSync(PluginChildMessage);

export const pluginMessageFits = (value: unknown): boolean => {
  try {
    const encoded = JSON.stringify(value);
    return encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= MAX_PLUGIN_MESSAGE_BYTES;
  } catch {
    return false;
  }
};
