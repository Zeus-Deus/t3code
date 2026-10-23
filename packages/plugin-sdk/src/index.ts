/** Public author API. Capability-gated additions require host discovery. Plugins run as the server's OS user. */
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
  | "ui"
  | "ui.sidebar-views"
  | "ui.native-trees"
  | "ui.conversation-cards"
  | "ui.changes"
  | "worktrees.create"
  | "workflow.query";
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
    readonly placement: "page" | "side-panel" | "conversation";
  }[];
  /** Compact statuses shown with the open thread. Register `status:<id>` for each. */
  readonly threadStatus?: readonly {
    readonly id: string;
    readonly title: string;
    /** A declared side-panel view opened when the person activates the status. */
    readonly viewId?: string;
  }[];
  /**
   * Alternative arrangements of the client's thread sidebar, declared as rules. The client renders
   * them from threads it already has; no handler is called and no thread data reaches the plugin.
   * Requires the `ui.sidebar-views` capability.
   */
  readonly sidebarViews?: readonly {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly groupBy: "project";
    /** Projects with nothing active and no activity for this many days (1-365) fold away. */
    readonly quietAfterDays?: number;
    /** Whether projects without threads get a heading. Defaults to `hide`. */
    readonly emptyProjects?: "show" | "hide";
  }[];
  readonly nativeTrees?: readonly {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
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
export interface PluginInvocationContext extends PluginActionContext {
  /** Host-derived first non-subagent ancestor of the target; forks stop the chain. Not identity. */
  readonly subagentOf?: string;
  /**
   * A read failed or ancestry is missing, deleted, cyclic or over the depth bound; `subagentOf`
   * is omitted. Retry before choosing an owner from `threadId`. Optional in v1; older hosts omit
   * it, so absence alone does not prove a root. Retrying may not resolve deleted ancestry; ask the person before choosing an owner.
   */
  readonly lineage?: "unresolved";
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
export interface PluginConversationCard {
  readonly viewId: string;
  /** Historical plain text proposal, at most 1000 characters. */
  readonly summary: string;
  /** Small JSON reference (e.g. planId), at most 2048 UTF-8 bytes. Full state lives in storage. */
  readonly data?: JsonValue;
}
export interface PluginCardReference extends PluginConversationCard {
  readonly installationId: string;
  readonly generation: string;
  readonly dataOwner: string;
}
export type PluginTreeNode =
  | {
      readonly id: string;
      readonly parentId?: string;
      readonly collapsedByDefault?: boolean;
      readonly kind: "group";
      readonly title: string;
    }
  | {
      readonly id: string;
      readonly parentId?: string;
      readonly collapsedByDefault?: boolean;
      readonly kind: "project";
      readonly projectId: string;
    }
  | {
      readonly id: string;
      readonly parentId?: string;
      /** Applies to group and project headings; native thread rows remain expanded. */
      readonly collapsedByDefault?: boolean;
      readonly kind: "thread";
      readonly threadId: string;
    };
export interface PluginTreeSnapshot {
  readonly nodes: readonly PluginTreeNode[];
}
export interface PluginModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: readonly { readonly id: string; readonly value: string | boolean }[];
}
export type PluginRuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export interface PluginThreadCreateInput {
  readonly projectId: string;
  readonly title?: string;
  readonly text: string;
  readonly idempotencyKey: string;
  readonly modelSelection?: PluginModelSelection;
  readonly runtimeMode?: PluginRuntimeMode;
  readonly interactionMode?: "default" | "plan";
  readonly workspaceStrategy?:
    | { readonly type: "root" }
    | {
        readonly type: "worktree";
        readonly baseRef: string;
        readonly branch?: string;
        readonly startFromOrigin?: boolean;
      };
}
export interface PluginPageInput {
  readonly cursor?: number;
  readonly limit?: number;
}
export interface PluginProjectMetadata {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection?: PluginModelSelection;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface PluginThreadMetadata {
  /** Host-derived creation origin, for display grouping only. */
  readonly creationSource?: string;
  readonly isRunning?: boolean;
  readonly needsAttention?: boolean;
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly modelSelection: PluginModelSelection;
  readonly runtimeMode: PluginRuntimeMode;
  readonly interactionMode: "default" | "plan";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly snoozedUntil: string | null;
  readonly snoozedAt: string | null;
  readonly pinnedAt: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly lineage: {
    readonly parentThreadId: string | null;
    readonly relationshipToParent: "fork" | "subagent" | null;
    readonly rootThreadId: string;
  };
  readonly launchedFrom?: { readonly threadId: string };
}
export type PluginModelOption = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
} & (
  | { readonly type: "boolean"; readonly currentValue?: boolean }
  | {
      readonly type: "select";
      readonly currentValue?: string;
      readonly promptInjectedValues?: readonly string[];
      readonly options: readonly {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
        readonly isDefault?: boolean;
      }[];
    }
);
export interface PluginModel {
  readonly modelSelection: PluginModelSelection;
  readonly title: string;
  readonly providerTitle: string;
  readonly options: readonly PluginModelOption[];
}
export interface PluginInvokeResult {
  readonly card?: PluginConversationCard;
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
  /** Host-derived first non-subagent ancestor of this agent's thread; forks stop the chain. */
  readonly subagentOf?: string;
  /**
   * A read failed or ancestry is missing, deleted, cyclic or over the depth bound; `subagentOf`
   * is omitted. Retry before choosing an owner from `threadId`. Optional in v1; older hosts omit
   * it, so absence alone does not prove a root. Retrying may not resolve deleted ancestry; ask the person before choosing an owner.
   */
  readonly lineage?: "unresolved";
}
export interface PluginInvocation {
  readonly signal: AbortSignal;
  readonly operationId: string;
  readonly caller: PluginCaller;
  readonly context?: PluginInvocationContext;
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
      | `tree:${string}`
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
    readonly create: (input: PluginThreadCreateInput) => Promise<{ readonly threadId: string }>;
    readonly list: (input: PluginPageInput & { readonly projectId: string }) => Promise<{
      readonly threads: readonly PluginThreadMetadata[];
      readonly nextCursor: number | null;
    }>;
    readonly metadata: (input: { readonly threadId: string }) => Promise<PluginThreadMetadata>;
  };
  readonly projects: {
    readonly list: (input?: PluginPageInput) => Promise<{
      readonly projects: readonly PluginProjectMetadata[];
      readonly nextCursor: number | null;
    }>;
  };
  readonly models: {
    readonly list: (
      input: PluginPageInput & { readonly projectId: string },
    ) => Promise<{ readonly models: readonly PluginModel[]; readonly nextCursor: number | null }>;
  };
  /** Call inside a handler after changing state; topics must name declared contributions. */
  readonly ui: {
    readonly invalidate: (
      topics: readonly (`tree:${string}` | `view:${string}` | `status:${string}`)[],
    ) => Promise<void>;
  };
  readonly trees: {
    readonly register: (
      id: string,
      handler: (invocation: PluginInvocation) => Promise<PluginTreeSnapshot> | PluginTreeSnapshot,
    ) => void;
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
