/** The stable author API. Plugins run as the server's OS user, with ordinary Node access. */
export const apiVersion = 1;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type PluginCapability =
  | "storage"
  | "settings"
  | "threads.read"
  | "threads.send"
  | "threads.create"
  | "events.run-finalized"
  | "ui";
export type PluginSettingValue = string | number | boolean;
export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly entry: string;
  readonly capabilities: readonly string[];
  /** Unavailable optional capabilities are omitted from context.capabilities. */
  readonly optionalCapabilities?: readonly string[];
  readonly actions: readonly {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly placements: readonly ("palette" | "thread-menu" | "message-selection")[];
    readonly agentCallable?: boolean;
  }[];
  readonly views: readonly {
    readonly id: string;
    readonly title: string;
    readonly entry: string;
    readonly placement: "page" | "side-panel";
  }[];
  /** Compact statuses shown with the open thread. Register `status:<id>` for each. */
  readonly threadStatus?: readonly {
    readonly id: string;
    readonly title: string;
    /** A declared side-panel view opened when the person activates the status. */
    readonly viewId?: string;
  }[];
  readonly settings: readonly {
    readonly key: string;
    readonly label: string;
    readonly description?: string;
    readonly type: "string" | "boolean" | "number" | "secret";
    readonly default?: PluginSettingValue;
  }[];
}
export interface PluginActionContext {
  readonly projectId?: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly selection?: string;
}
export type PluginClientIntent =
  | { readonly type: "composer.insert"; readonly text: string; readonly quote?: boolean }
  | { readonly type: "preview.open"; readonly url: string }
  | { readonly type: "thread.reveal"; readonly threadId: string; readonly messageId?: string }
  | { readonly type: "view.open"; readonly viewId: string };
/** An image file the plugin wrote under `context.dataDirectory`, named by its relative path. */
export interface PluginResultImage {
  readonly path: string;
  readonly mimeType: "image/png" | "image/jpeg";
}
export interface PluginInvokeResult {
  readonly message?: string;
  readonly data?: unknown;
  readonly intents?: readonly PluginClientIntent[];
  /**
   * Up to four PNG or JPEG files, each at most 4 MiB. The host reads and verifies them after the
   * handler returns; agents receive them as image content and views as base64 `data`.
   */
  readonly images?: readonly PluginResultImage[];
  /** Host-reported presentation requests this host or client could not interpret. */
  readonly unsupportedIntentCount?: number;
}
/**
 * Who started the invocation, established by the host. `threadId` is present only for an agent the
 * host verified is acting for that T3 thread. `context` is only the requested target: use `caller`,
 * not `context.threadId`, to decide what an agent owns.
 */
export interface PluginCaller {
  readonly kind: "client" | "agent" | "background";
  readonly threadId?: string;
}
export interface PluginInvocation {
  readonly signal: AbortSignal;
  readonly operationId: string;
  readonly caller: PluginCaller;
  readonly context?: PluginActionContext;
}
/**
 * What a `status:<id>` handler returns as `data`, or `null` to show nothing. Clients ask while
 * the thread is visible and may show the last answer for a short while, so keep it cheap and
 * describe current state, not a transient event.
 */
export interface PluginThreadStatus {
  readonly label: string;
  readonly tone: "neutral" | "info" | "success" | "warning" | "danger";
  readonly detail?: string;
}
export interface PluginRunFinalizedEvent {
  /** Delivery is at least once. Persist this id before producing a non-idempotent external effect. */
  readonly deliveryId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly outcome: "completed" | "failed" | "interrupted";
  readonly summary?: string;
}
/** Host call failures preserve these fields on the Error thrown to a plugin handler. */
export interface PluginHostError extends Error {
  readonly reason: string;
  /** `idempotency_conflict` means this operation key is already bound to a different request. */
  readonly code?: string;
  /** Present only when the current caller still has authority to see the earlier effect. */
  readonly priorEffect?: { readonly threadId: string };
}
export interface PluginThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly messages: readonly {
    readonly id: string;
    readonly role: string;
    readonly text: string;
  }[];
}
/** Await host calls before returning; invocation completion revokes outstanding calls. */
export type PluginHandler = (
  input: unknown,
  invocation: PluginInvocation,
) => Promise<PluginInvokeResult | void> | PluginInvokeResult | void;
export interface PluginContext {
  readonly apiVersion: 1;
  readonly capabilities: readonly PluginCapability[];
  /**
   * A private 0700 directory for this plugin's files on the server. It survives updates and
   * restarts, follows the same retention as `storage` on removal, and is deleted with its data.
   */
  readonly dataDirectory: string;
  readonly signal: AbortSignal;
  /** Register during activation. Host calls are available only inside a handler invocation. */
  readonly handle: (
    name:
      | `action:${string}`
      | `status:${string}`
      | `view:${string}:${string}`
      | "event:run.finalized",
    handler: PluginHandler,
  ) => void;
  readonly log: (level: "debug" | "info" | "warn" | "error", message: string) => void;
  readonly settings: { readonly get: (key: string) => Promise<PluginSettingValue | null> };
  readonly storage: {
    readonly get: (key: string) => Promise<JsonValue>;
    readonly set: (key: string, value: JsonValue) => Promise<void>;
    readonly delete: (key: string) => Promise<void>;
  };
  readonly threads: {
    readonly read: (input: { readonly threadId: string }) => Promise<PluginThread>;
    /**
     * Keep this key stable across retries and revisions of the same logical mutation. Reusing it
     * for a different request rejects with code `idempotency_conflict`; it never repeats the effect.
     */
    readonly send: (input: {
      readonly threadId: string;
      readonly text: string;
      readonly idempotencyKey: string;
    }) => Promise<{ readonly threadId: string }>;
    readonly create: (input: {
      readonly projectId: string;
      readonly title?: string;
      readonly text: string;
      readonly idempotencyKey: string;
    }) => Promise<{ readonly threadId: string }>;
  };
  readonly events: {
    readonly onRunFinalized: (
      handler: (
        event: PluginRunFinalizedEvent,
        invocation: PluginInvocation,
      ) => Promise<PluginInvokeResult | void> | PluginInvokeResult | void,
    ) => void;
  };
}
export interface PluginModule {
  readonly activate: (context: PluginContext) => Promise<void> | void;
  readonly deactivate?: () => Promise<void> | void;
}
