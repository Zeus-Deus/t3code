import type {
  ExecutionEnvironmentCapabilities,
  PluginEventBacklog,
  PluginEventBacklogPolicy,
  PluginError,
  PluginInstallation,
} from "@t3tools/contracts";

import {
  isPluginActive,
  isPluginRecordReadOnly,
  isPluginUnavailable,
  pluginObserverError,
  pluginRecordIssueMessage,
  pluginSourceLabel,
} from "./model.ts";

/**
 * Repair, previous-version and missed-event RPCs exist only on servers that advertise them. Older
 * servers keep the plain review/enable/restart flow.
 */
export const pluginRecoverySupported = (
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
) => capabilities?.plugins?.recovery === true;

/** Safe mode: plugin code does not run, but plugins can still be reviewed, disabled or removed. */
export const pluginExecutionDisabled = (
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
  catalogue?: { readonly executionDisabled?: boolean } | null,
) => capabilities?.plugins?.executionDisabled === true || catalogue?.executionDisabled === true;

export type PluginAttentionKind = "unavailable" | "fault" | "events-paused" | "read-only" | "other";

export interface PluginAttention {
  readonly installationId: string;
  readonly name: string;
  readonly kind: PluginAttentionKind;
  readonly title: string;
  readonly message: string;
  readonly since: string;
  /** Changes whenever a new problem is reported, so dismissing an old one never hides it. */
  readonly key: string;
  /** Counted in the grouped notice. A plugin the user turned off only nags about real failures. */
  readonly notify: boolean;
}

const ATTENTION_TITLES: Record<PluginAttentionKind, string> = {
  unavailable: "Unavailable on this environment",
  fault: "Stopped after a failure",
  "events-paused": "Background events paused",
  "read-only": "Read-only record",
  other: "Needs attention",
};

const isKnownAttentionKind = (kind: string): kind is PluginAttentionKind =>
  kind in ATTENTION_TITLES;
// Servers may report kinds this client does not know yet; they still show, generically.
const attentionKind = (kind: string): PluginAttentionKind =>
  isKnownAttentionKind(kind) ? kind : "other";

/** What servers without derived attention still tell us, read from the persisted status. */
function legacyAttention(
  installation: PluginInstallation,
): { kind: PluginAttentionKind; message: string } | null {
  const recordIssue = pluginRecordIssueMessage(installation);
  if (recordIssue !== null) return { kind: "read-only", message: recordIssue };
  if (isPluginUnavailable(installation)) {
    const missing = installation.compatibility?.missingCapabilities ?? [];
    return {
      kind: "unavailable",
      message:
        installation.error ??
        (missing.length > 0
          ? `Needs ${missing.join(", ")}, which this environment does not support.`
          : "Needs something this environment does not support."),
    };
  }
  if (installation.status === "error" || installation.status === "quarantined") {
    return {
      kind: "fault",
      message:
        installation.error ??
        (installation.status === "quarantined"
          ? "Stopped after repeated failures."
          : "The plugin stopped after an error."),
    };
  }
  const observerError = pluginObserverError(installation);
  return observerError === null ? null : { kind: "events-paused", message: observerError };
}

export function pluginAttention(installation: PluginInstallation): PluginAttention | null {
  // Safe mode stops every plugin at once; the environment's notice says so, not each plugin.
  const reported =
    installation.attention?.kind === "safe-mode" ? undefined : installation.attention;
  const attention = reported
    ? { kind: attentionKind(reported.kind), message: reported.message, since: reported.since }
    : (() => {
        const legacy = legacyAttention(installation);
        return legacy === null ? null : { ...legacy, since: installation.updatedAt };
      })();
  if (attention === null) return null;
  // A plugin the user turned off observes nothing; the missed-runs choice comes when it is enabled.
  if (attention.kind === "events-paused" && !installation.enabled) return null;
  return {
    installationId: installation.installationId,
    name: installation.manifest.name,
    kind: attention.kind,
    title: ATTENTION_TITLES[attention.kind],
    message: attention.message,
    since: attention.since,
    key: `${installation.installationId}:${attention.kind}:${attention.since}`,
    notify: installation.enabled || attention.kind !== "unavailable",
  };
}

export interface PluginAttentionNotice {
  readonly key: string;
  readonly tone: "warning" | "error";
  readonly title: string;
  readonly description: string;
  readonly entries: ReadonlyArray<PluginAttention>;
}

/** One grouped notice per environment, so an update that breaks several plugins says it once. */
export function pluginAttentionNotice(input: {
  readonly installations: ReadonlyArray<PluginInstallation>;
  /** The environment's plugin data could not be opened. */
  readonly unavailableMessage?: string | null | undefined;
  /** The catalogue itself could not be loaded from the environment. */
  readonly loadError?: string | null | undefined;
  /** Shown when several environments may each have a notice. */
  readonly environmentLabel?: string | null | undefined;
}): PluginAttentionNotice | null {
  const where = input.environmentLabel ? ` on ${input.environmentLabel}` : "";
  if (input.loadError) {
    return {
      key: `load-error:${input.loadError}`,
      tone: "error",
      title: `Could not load plugins${where}`,
      description: input.loadError,
      entries: [],
    };
  }
  if (input.unavailableMessage) {
    return {
      key: `unavailable:${input.unavailableMessage}`,
      tone: "error",
      title: `Plugins unavailable${where}`,
      description: input.unavailableMessage,
      entries: [],
    };
  }
  const entries = input.installations
    .map(pluginAttention)
    .filter((entry): entry is PluginAttention => entry !== null && entry.notify);
  const [first] = entries;
  if (first === undefined) return null;
  return {
    key: entries
      .map((entry) => entry.key)
      .sort()
      .join("|"),
    tone: entries.every((entry) => entry.kind === "events-paused") ? "warning" : "error",
    title:
      entries.length === 1
        ? `${first.name} needs attention${where}`
        : `${entries.length} plugins need attention${where}`,
    description: entries.map((entry) => `${entry.name}: ${entry.title}.`).join(" "),
    entries,
  };
}

export interface PluginDetailRow {
  readonly label: string;
  readonly value: string;
  /** Paths, digests and identifiers read better in a monospace face and must be selectable. */
  readonly code?: boolean;
}

const runtimeLabel = (observation: {
  readonly hostVersion: string;
  readonly nodeVersion: string;
}) => `T3 Code ${observation.hostVersion} · Node ${observation.nodeVersion}`;

const isLater = (left: string, right: string) => Date.parse(left) > Date.parse(right);

/**
 * The facts behind a plugin's state, for a details view that stays after the notice is dismissed.
 * Versions are shown side by side as recorded; nothing here claims which update caused a failure.
 * Fault observations carry no revision, so a failure is history, never blamed on what is active now.
 */
export function pluginRecoveryDetails(
  installation: PluginInstallation,
  formatTime: (iso: string) => string,
): ReadonlyArray<PluginDetailRow> {
  // A read-only record's capabilities, source and fingerprint are placeholders, not facts.
  if (isPluginRecordReadOnly(installation)) return [];
  const rows: PluginDetailRow[] = [];
  const attention = pluginAttention(installation);
  if (attention !== null) rows.push({ label: attention.title, value: attention.message });
  const missing = installation.compatibility?.missingCapabilities ?? [];
  if (missing.length > 0) {
    rows.push({ label: "Not supported here", value: missing.join(", "), code: true });
  }
  const fault = installation.health?.fault;
  const lastHealthy = installation.health?.lastHealthy;
  if (fault !== undefined) {
    if (fault.message !== attention?.message) {
      rows.push({ label: "Last recorded failure", value: fault.message });
    }
    if (fault.handler !== undefined) {
      rows.push({ label: "Failed in", value: fault.handler, code: true });
    }
    rows.push({
      label: "When it failed",
      value: `${formatTime(fault.at)} · ${runtimeLabel(fault)}`,
    });
  }
  if (lastHealthy !== undefined) {
    rows.push({
      label:
        fault !== undefined && isLater(lastHealthy.at, fault.at)
          ? "Ran normally after that"
          : "Last ran normally",
      value: `${formatTime(lastHealthy.at)} · ${runtimeLabel(lastHealthy)}`,
    });
  }
  const recovery = installation.recovery;
  if (recovery !== undefined) {
    rows.push({
      label: "Active revision",
      value:
        recovery.activeSource === "local-repair"
          ? `Your local fix, v${installation.manifest.version}`
          : `Publisher version, v${installation.manifest.version}`,
    });
    if (recovery.activeSource === "local-repair" && recovery.upstreamSource !== undefined) {
      rows.push({
        label: "Publisher source",
        value: pluginSourceLabel(recovery.upstreamSource),
        code: true,
      });
    }
    if (recovery.previous !== undefined) {
      rows.push({ label: "Previous version kept", value: `v${recovery.previous.version}` });
    }
    if (recovery.repair !== undefined) {
      rows.push({ label: "Repair folder", value: recovery.repair.directory, code: true });
    }
  }
  return rows;
}

/**
 * What happens to the installed revision while a staged one waits for review. A plugin that is
 * off, failed or unavailable runs nothing, so it only stays selected.
 */
export function pluginCurrentRevisionNote(installation: PluginInstallation): string {
  const current =
    installation.recovery?.activeSource === "local-repair"
      ? "Your local fix"
      : `Version ${installation.manifest.version}`;
  return isPluginActive(installation)
    ? `${current} keeps running until you approve.`
    : `${current} stays selected until you approve.`;
}

/**
 * Why an installed plugin's code is not offered right now, from what the record says today. Safe
 * mode is the environment's state and is explained before this is asked.
 */
export function pluginInactiveReason(installation: PluginInstallation): string | null {
  const recordIssue = pluginRecordIssueMessage(installation);
  if (recordIssue !== null) return recordIssue;
  if (isPluginActive(installation)) return null;
  const attention = pluginAttention(installation);
  const explained = (fallback: string) =>
    attention !== null && attention.kind !== "events-paused"
      ? `${attention.title}: ${attention.message}`
      : fallback;
  if (isPluginUnavailable(installation)) return explained("Unavailable on this environment.");
  if (installation.consentedDigest !== installation.digest) {
    return installation.consentedDigest === null
      ? "The plugin needs review before it can run."
      : "The plugin's files changed. Review them before it can run.";
  }
  if (!installation.enabled) return "The plugin is turned off.";
  return explained("The plugin is not running.");
}

const withoutTrailingSeparators = (directory: string) => directory.replace(/[\\/]+$/, "");

/**
 * Whether the repair folder belongs to what runs now: it was copied from these exact files, or the
 * running local fix was staged from it, so repeated fixes keep one folder. After switching to other
 * files the folder stays on disk, but a repair needs a fresh copy. The server decides with
 * canonical paths; this only picks the label.
 */
function pluginRepairWorkspaceCurrent(
  installation: PluginInstallation,
  repair: { readonly baseDigest: string; readonly directory: string },
): boolean {
  if (repair.baseDigest === installation.digest) return true;
  return (
    installation.recovery?.activeSource === "local-repair" &&
    installation.source.kind === "local" &&
    withoutTrailingSeparators(installation.source.directory) ===
      withoutTrailingSeparators(repair.directory)
  );
}

export interface PluginRecoveryActions {
  /** Materialize the running files for an agent, or reopen the folder made earlier. */
  readonly repair: "prepare" | "open" | null;
  /** Stage the repair folder's current files for review. */
  readonly stageRepair: boolean;
  /** Stage the kept previous version; it runs with today's data. */
  readonly usePrevious: { readonly version: string; readonly digest: string } | null;
  readonly runningLocalFix: boolean;
}

const NO_RECOVERY: PluginRecoveryActions = {
  repair: null,
  stageRepair: false,
  usePrevious: null,
  runningLocalFix: false,
};

export function pluginRecoveryActions(
  installation: PluginInstallation,
  recoverySupported: boolean,
): PluginRecoveryActions {
  if (!recoverySupported || isPluginRecordReadOnly(installation)) return NO_RECOVERY;
  const recovery = installation.recovery;
  const pendingKind = installation.pendingUpdate?.kind;
  const previous = recovery?.previous;
  const repairCurrent =
    recovery?.repair !== undefined && pluginRepairWorkspaceCurrent(installation, recovery.repair);
  return {
    repair: repairCurrent ? "open" : "prepare",
    stageRepair: repairCurrent && pendingKind !== "local-repair",
    usePrevious:
      previous !== undefined && pendingKind !== "previous"
        ? { version: previous.version, digest: previous.digest }
        : null,
    runningLocalFix: recovery?.activeSource === "local-repair",
  };
}

export type PluginBacklogDecision =
  | { readonly kind: "none" }
  /** Nothing was missed, but the server still wants the gap closed explicitly. */
  | { readonly kind: "resolved"; readonly eventBacklog: PluginEventBacklogPolicy }
  | { readonly kind: "choose"; readonly count: number; readonly throughSequence: number };

/**
 * Missed runs are never delivered in a surprise burst: when the server asks for a choice and runs
 * were missed, the user picks deliver or skip.
 */
export function pluginBacklogDecision(backlog: PluginEventBacklog): PluginBacklogDecision {
  if (!backlog.requiresChoice) return { kind: "none" };
  if (backlog.count === 0) {
    return {
      kind: "resolved",
      eventBacklog: { policy: "skip", throughSequence: backlog.throughSequence },
    };
  }
  return { kind: "choose", count: backlog.count, throughSequence: backlog.throughSequence };
}

/**
 * Which request of an approval carries the missed-runs choice. The server asks only when the
 * plugin is, or is about to start, observing: consent of an enabled plugin, or the enable that
 * follows re-approving a disabled one. A first approval starts from new runs, and approving a
 * staged revision leaves a disabled plugin off.
 */
export function pluginApprovalBacklogStep(
  installation: PluginInstallation,
): "consent" | "enable" | null {
  if (installation.consentedDigest === null) return null;
  if (installation.enabled) return "consent";
  return installation.pendingUpdate === undefined ? "enable" : null;
}

const PLUGIN_STOPPED_REASONS: ReadonlySet<string> = new Set([
  "incompatible",
  "start_failed",
  "crashed",
  "timeout",
  "quarantined",
  "disabled",
  "needs_consent",
]);

/**
 * A request failed because of the plugin's state, not its input: the plugin's details explain
 * why and offer the way back. Safe mode answers `disabled` with code `execution_disabled`.
 */
export const pluginFailureNeedsDetails = (error: PluginError) =>
  PLUGIN_STOPPED_REASONS.has(error.reason);

/** What a notice counts toward a badge: each affected plugin, or the environment once. */
export const pluginAttentionCount = (notice: PluginAttentionNotice | null) =>
  notice === null ? 0 : Math.max(notice.entries.length, 1);

/**
 * What removing leaves alone. Repair folders hold the user's edits, so they are never deleted with
 * the plugin, and nothing the plugin already did is rolled back.
 */
export function pluginRemovalNote(installation: PluginInstallation): string {
  const repair = installation.recovery?.repair;
  return [
    "Removing doesn't undo anything it already did, in T3 Code or outside it.",
    repair === undefined
      ? undefined
      : `Your repair folder stays at ${repair.directory}, under T3 home's userdata/plugins/workspaces.`,
  ]
    .filter(Boolean)
    .join(" ");
}
