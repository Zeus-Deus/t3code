// @effect-diagnostics globalTimers:off - Visibility-driven polling owned by React hooks, outside an Effect runtime.
import {
  PluginThreadStatus,
  type EnvironmentId,
  type PluginInvokeInput,
  type PluginInvokeResult,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { pluginStatusHandler, type PluginThreadStatusEntry } from "./model.ts";

export const PLUGIN_THREAD_STATUS_INTERVAL_MS = 30_000;
/**
 * A plugin action or a view's handler call often changes what its status would say. A burst of
 * them (a view refreshing itself, several clicks) settles into one status request.
 */
export const PLUGIN_THREAD_STATUS_ACTIVITY_SETTLE_MS = 1_500;

/** The thread the person is looking at. */
export interface PluginThreadStatusTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
}

export interface PluginThreadStatusValue {
  /** Stable per thread, installation generation and status id. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly entry: PluginThreadStatusEntry;
  readonly status: PluginThreadStatus;
}

export interface PluginThreadStatusPollerOptions {
  /** Resolves with the RPC result and rejects on any failure. */
  readonly invoke: (request: {
    readonly environmentId: EnvironmentId;
    readonly input: PluginInvokeInput;
  }) => Promise<PluginInvokeResult>;
  readonly operationId: () => string;
}

export interface PluginThreadStatusPoller {
  /**
   * What should be shown now. `entries` must already be limited to active installations the
   * session may ask; anything missing from them is dropped at once.
   */
  readonly update: (state: {
    readonly target: PluginThreadStatusTarget | null;
    readonly entries: ReadonlyArray<PluginThreadStatusEntry>;
    /** The document or app is in front and this thread is on screen. */
    readonly visible: boolean;
  }) => void;
  /** Asks every status again, for example when the window regains focus. */
  readonly refresh: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => ReadonlyArray<PluginThreadStatusValue>;
  readonly dispose: () => void;
}

const isThreadStatus = Schema.is(PluginThreadStatus);

const statusKey = (target: PluginThreadStatusTarget, entry: PluginThreadStatusEntry) =>
  [
    target.environmentId,
    target.threadId,
    entry.installation.installationId,
    entry.installation.generation,
    entry.item.id,
  ].join("\n");

interface Slot {
  readonly key: string;
  readonly target: PluginThreadStatusTarget;
  entry: PluginThreadStatusEntry;
  status: PluginThreadStatus | null;
  /** Asked while a request was in flight; ask once more when it answers. */
  again: boolean;
}

interface PluginThreadActivity {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly installationId: string;
}

const activityListeners = new Set<(activity: PluginThreadActivity) => void>();

/**
 * Tells mounted status pollers that a plugin just ran something for a thread, so its status can
 * catch up before the next interval.
 */
export function notifyPluginThreadActivity(activity: PluginThreadActivity): void {
  for (const listener of activityListeners) listener(activity);
}

const sameStatus = (left: PluginThreadStatus | null, right: PluginThreadStatus | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.label === right.label &&
    left.tone === right.tone &&
    left.detail === right.detail);

const EMPTY: ReadonlyArray<PluginThreadStatusValue> = [];

/**
 * Polls the open thread's plugin statuses. One request is in flight per thread, installation
 * generation and status id; an answer for a thread or generation that is no longer shown is
 * dropped. Failures and `null` both show nothing.
 */
export function createPluginThreadStatusPoller(
  options: PluginThreadStatusPollerOptions,
): PluginThreadStatusPoller {
  let slots = new Map<string, Slot>();
  const inFlight = new Set<string>();
  let target: PluginThreadStatusTarget | null = null;
  let visible = false;
  let disposed = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let activityTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshot = EMPTY;
  const listeners = new Set<() => void>();

  const publish = () => {
    const next = [...slots.values()].flatMap((slot): PluginThreadStatusValue[] =>
      slot.status === null
        ? []
        : [
            {
              key: slot.key,
              environmentId: slot.target.environmentId,
              threadId: slot.target.threadId,
              entry: slot.entry,
              status: slot.status,
            },
          ],
    );
    // The key pins the installation generation, so the manifest behind an entry cannot differ.
    // Comparing by value keeps a caller that rebuilds its entries each render from re-rendering.
    const unchanged =
      next.length === snapshot.length &&
      next.every((value, index) => {
        const previous = snapshot[index]!;
        return previous.key === value.key && sameStatus(previous.status, value.status);
      });
    if (unchanged) return;
    snapshot = next.length === 0 ? EMPTY : next;
    for (const listener of listeners) listener();
  };

  const ask = (slot: Slot) => {
    if (disposed || !visible) return;
    if (inFlight.has(slot.key)) {
      slot.again = true;
      return;
    }
    inFlight.add(slot.key);
    slot.again = false;
    const { installation, item } = slot.entry;
    const settle = (status: PluginThreadStatus | null) => {
      inFlight.delete(slot.key);
      // The slot may have been replaced by one for the same key after a quick switch away and
      // back; the answer is still for this thread and generation, so it applies to the current one.
      const current = slots.get(slot.key);
      if (disposed || current === undefined) return;
      if (!sameStatus(current.status, status)) {
        current.status = status;
        publish();
      }
      if (current.again) ask(current);
    };
    options
      .invoke({
        environmentId: slot.target.environmentId,
        input: {
          installationId: installation.installationId,
          generation: installation.generation,
          handler: pluginStatusHandler(item.id),
          context: {
            threadId: slot.target.threadId,
            ...(slot.target.projectId === null ? {} : { projectId: slot.target.projectId }),
          },
          operationId: options.operationId(),
        },
      })
      .then(
        (result) => settle(isThreadStatus(result.data) ? result.data : null),
        () => settle(null),
      );
  };

  const askAll = (installationId?: string) => {
    for (const slot of slots.values()) {
      if (installationId === undefined || slot.entry.installation.installationId === installationId)
        ask(slot);
    }
  };

  const syncInterval = () => {
    const wanted = !disposed && visible && slots.size > 0;
    if (wanted && interval === null) {
      interval = setInterval(() => askAll(), PLUGIN_THREAD_STATUS_INTERVAL_MS);
    } else if (!wanted && interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };

  const pendingActivity = new Set<string>();
  const onActivity = (activity: PluginThreadActivity) => {
    if (
      target === null ||
      activity.environmentId !== target.environmentId ||
      activity.threadId !== target.threadId
    )
      return;
    pendingActivity.add(activity.installationId);
    if (activityTimer !== null) return;
    activityTimer = setTimeout(() => {
      activityTimer = null;
      const installationIds = [...pendingActivity];
      pendingActivity.clear();
      for (const installationId of installationIds) askAll(installationId);
    }, PLUGIN_THREAD_STATUS_ACTIVITY_SETTLE_MS);
  };
  activityListeners.add(onActivity);

  return {
    update: (state) => {
      if (disposed) return;
      const becameVisible = state.visible && !visible;
      visible = state.visible;
      const threadChanged =
        target?.environmentId !== state.target?.environmentId ||
        target?.threadId !== state.target?.threadId;
      target = state.target;
      if (threadChanged) pendingActivity.clear();
      const next = new Map<string, Slot>();
      const added: Slot[] = [];
      if (state.target !== null) {
        for (const entry of state.entries) {
          const key = statusKey(state.target, entry);
          const existing = slots.get(key);
          if (existing !== undefined) {
            existing.entry = entry;
            next.set(key, existing);
          } else {
            const slot: Slot = { key, target: state.target, entry, status: null, again: false };
            next.set(key, slot);
            added.push(slot);
          }
        }
      }
      slots = next;
      publish();
      syncInterval();
      if (becameVisible) askAll();
      else for (const slot of added) ask(slot);
    },
    refresh: () => askAll(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    dispose: () => {
      disposed = true;
      activityListeners.delete(onActivity);
      if (activityTimer !== null) clearTimeout(activityTimer);
      activityTimer = null;
      syncInterval();
      slots = new Map();
      listeners.clear();
    },
  };
}

/**
 * The statuses to render for `target`. A snapshot can trail a thread switch or catalogue change
 * by one render; this keeps it from ever showing another thread's or a revoked generation's value.
 */
export function pluginThreadStatusesFor(
  values: ReadonlyArray<PluginThreadStatusValue>,
  target: PluginThreadStatusTarget | null,
  entries: ReadonlyArray<PluginThreadStatusEntry>,
): ReadonlyArray<PluginThreadStatusValue> {
  if (target === null || values.length === 0) return EMPTY;
  const live = new Set(entries.map((entry) => statusKey(target, entry)));
  const shown = values.filter((value) => live.has(value.key));
  return shown.length === values.length ? values : shown;
}
