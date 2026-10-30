import {
  PLUGIN_API_VERSION,
  PLUGIN_CAPABILITIES,
  pluginRequestedCapabilities,
  type ExecutionEnvironmentCapabilities,
  type PluginAction,
  type PluginCapability,
  type PluginGrants,
  type PluginInstallation,
  type PluginManifest,
  type PluginSetting,
  type PluginSettingValue,
  type PluginSource,
  type PluginThreadStatusItem,
  type PluginView,
} from "@t3tools/contracts";

/** The plugin API this client can render. An environment advertising another one gets no plugin UI. */
const CLIENT_PLUGIN_API_VERSION = PLUGIN_API_VERSION;

export type PluginActionPlacement = PluginAction["placements"][number];

/** Which side must update when an environment's plugin API is not the one this client renders. */
export function pluginApiSupport(
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
): "supported" | "server-outdated" | "client-outdated" {
  const version = capabilities?.plugins?.apiVersion;
  if (version === CLIENT_PLUGIN_API_VERSION) return "supported";
  return version !== undefined && version > CLIENT_PLUGIN_API_VERSION
    ? "client-outdated"
    : "server-outdated";
}

export function environmentSupportsPlugins(
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
): boolean {
  return pluginApiSupport(capabilities) === "supported";
}

/**
 * Ready to run code: enabled, consent matches the installed bytes, supported by this host, and not
 * stopped by failure. `compatibility` is derived by newer servers on every read; older ones only
 * report the persisted status.
 */
export function isPluginActive(installation: PluginInstallation): boolean {
  return (
    installation.enabled &&
    installation.consentedDigest === installation.digest &&
    installation.compatibility?.available !== false &&
    (installation.status === "idle" || installation.status === "running")
  );
}

/**
 * The installations whose actions, views and statuses may be offered. None while the environment
 * runs with plugin code off (safe mode): the server refuses them, so no entry point offers them.
 */
export const pluginRunnableInstallations = (catalogue: {
  readonly installations: ReadonlyArray<PluginInstallation>;
  readonly executionDisabled?: boolean | undefined;
}): ReadonlyArray<PluginInstallation> =>
  catalogue.executionDisabled === true ? [] : catalogue.installations;

export interface PluginActionEntry {
  readonly installation: PluginInstallation;
  readonly action: PluginAction;
}

interface PluginViewEntry {
  readonly installation: PluginInstallation;
  readonly view: PluginView;
}

const byTitle =
  <T extends { readonly installation: PluginInstallation }>(title: (entry: T) => string) =>
  (left: T, right: T) =>
    left.installation.manifest.name.localeCompare(right.installation.manifest.name) ||
    title(left).localeCompare(title(right));

export function pluginActionEntries(
  installations: ReadonlyArray<PluginInstallation>,
  placement: PluginActionPlacement,
): ReadonlyArray<PluginActionEntry> {
  return installations
    .filter(isPluginActive)
    .flatMap((installation) =>
      installation.manifest.actions
        .filter((action) => action.placements.includes(placement))
        .map((action) => ({ installation, action })),
    )
    .sort(byTitle((entry) => entry.action.title));
}

/**
 * Views a person can open on their own. They need the `ui` capability granted; the server refuses
 * to read them otherwise. Conversation views render a card and only open from one.
 */
export function pluginViewEntries(
  installations: ReadonlyArray<PluginInstallation>,
): ReadonlyArray<PluginViewEntry> {
  return installations
    .filter(
      (installation) =>
        isPluginActive(installation) && installation.grants.capabilities.includes("ui"),
    )
    .flatMap((installation) =>
      installation.manifest.views
        .filter((view) => view.placement === "page" || view.placement === "side-panel")
        .map((view) => ({ installation, view })),
    )
    .sort(byTitle((entry) => entry.view.title));
}

export interface PluginThreadStatusEntry {
  readonly installation: PluginInstallation;
  readonly item: PluginThreadStatusItem;
}

/** Statuses render host-side, but the server answers them only with `ui` granted, like views. */
export function pluginThreadStatusEntries(
  installations: ReadonlyArray<PluginInstallation>,
): ReadonlyArray<PluginThreadStatusEntry> {
  return installations
    .filter(
      (installation) =>
        isPluginActive(installation) && installation.grants.capabilities.includes("ui"),
    )
    .flatMap((installation) =>
      (installation.manifest.threadStatus ?? []).map((item) => ({ installation, item })),
    )
    .sort(byTitle((entry) => entry.item.title));
}

export function findPluginView(
  installations: ReadonlyArray<PluginInstallation>,
  installationId: string,
  viewId: string,
): PluginViewEntry | null {
  const installation = installations.find((entry) => entry.installationId === installationId);
  const view = installation?.manifest.views.find((entry) => entry.id === viewId);
  return installation && view ? { installation, view } : null;
}

export const pluginActionHandler = (actionId: string) => `action:${actionId}`;
export const pluginViewHandler = (viewId: string, name: string) => `view:${viewId}:${name}`;
export const pluginStatusHandler = (statusId: string) => `status:${statusId}`;

const VIEW_HANDLER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export const isPluginViewHandlerName = (name: unknown): name is string =>
  typeof name === "string" && VIEW_HANDLER_NAME.test(name);

/**
 * One id per user invocation; retries of that invocation reuse it so the server can dedupe.
 * Each client supplies its randomness: `crypto.randomUUID` is missing over plain-HTTP LAN
 * origins and in Hermes.
 */
export function createPluginOperationId(random: () => string): string {
  return `op-${random()
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 64)}`;
}

interface PluginCapabilityText {
  /** The plugin runs without it, so an unknown optional capability does not block it. */
  readonly optional: boolean;
  readonly title: string;
  readonly detail: string;
  /** Needs projects selected before the grant does anything. */
  readonly projectScoped: boolean;
}

/** Only capabilities this client knows can be granted; others are named as the manifest has them. */
type PluginCapabilityDescription =
  | (PluginCapabilityText & { readonly known: true; readonly capability: PluginCapability })
  | (PluginCapabilityText & { readonly known: false; readonly capability: string });

const CAPABILITY_TEXT: Record<
  PluginCapability,
  { title: string; detail: string; projectScoped: boolean }
> = {
  storage: {
    title: "Private storage",
    detail: "Keep its own data on this environment.",
    projectScoped: false,
  },
  settings: {
    title: "Read its settings",
    detail: "Read the values you enter for it, including secrets.",
    projectScoped: false,
  },
  "threads.read": {
    title: "Read threads",
    detail: "Read messages in threads of the projects you choose.",
    projectScoped: true,
  },
  "threads.send": {
    title: "Send messages",
    detail: "Send messages to existing threads of the projects you choose.",
    projectScoped: true,
  },
  "threads.create": {
    title: "Create threads",
    detail: "Start new threads in the projects you choose.",
    projectScoped: true,
  },
  "events.run-finalized": {
    title: "Run in the background",
    detail: "Be notified when a run finishes, even with no client connected.",
    projectScoped: true,
  },
  ui: {
    title: "Show views",
    detail: "Render its own pages in a sandboxed frame.",
    projectScoped: false,
  },
  "ui.sidebar-views": {
    title: "Arrange the sidebar",
    detail:
      "Offer another layout for your thread list. T3 draws it; the plugin never reads threads.",
    projectScoped: false,
  },
  "ui.native-trees": {
    title: "Arrange threads in the sidebar",
    detail: "Group and nest the threads it can read in its own sidebar layout. T3 draws the rows.",
    projectScoped: false,
  },
  "ui.native-tree-conversations": {
    title: "Use project conversations",
    detail:
      "Open a project conversation from its sidebar heading and attach a brief to its first message.",
    projectScoped: false,
  },
  "ui.native-tree-projects": {
    title: "Keep project conversations in its view",
    detail:
      "Own project conversations in its sidebar, choose projects to add, and restore its archived threads when you ask.",
    projectScoped: false,
  },
  "ui.conversation-cards": {
    title: "Show cards in chat",
    detail: "Show its own interactive cards in a conversation when an agent uses it.",
    projectScoped: false,
  },
  "ui.wallpapers": {
    title: "Show a wallpaper",
    detail:
      "Offer animated wallpapers behind the app. They never see your threads or receive clicks.",
    projectScoped: false,
  },
  "ui.changes": {
    title: "Refresh its views",
    detail: "Tell its open views and sidebar layout when its data changed.",
    projectScoped: false,
  },
  "worktrees.create": {
    title: "Create worktrees",
    detail: "Start new threads in a new git worktree of the projects you choose.",
    projectScoped: true,
  },
  "workflow.query": {
    title: "List projects, threads and models",
    detail:
      "See titles, states and settings of threads in the projects you choose, without their messages, and the models they can use.",
    projectScoped: true,
  },
};

const isKnownCapability = (capability: string): capability is PluginCapability =>
  (PLUGIN_CAPABILITIES as ReadonlyArray<string>).includes(capability);

export function describePluginCapabilities(
  manifest: PluginManifest,
): ReadonlyArray<PluginCapabilityDescription> {
  const required = new Set(manifest.capabilities);
  return pluginRequestedCapabilities(manifest).map((capability) => {
    const optional = !required.has(capability);
    return isKnownCapability(capability)
      ? { capability, known: true as const, optional, ...CAPABILITY_TEXT[capability] }
      : {
          capability,
          known: false as const,
          optional,
          title: capability,
          detail: optional
            ? "Not supported by this environment. The plugin runs without it."
            : "Not supported by this environment. The plugin cannot be enabled.",
          projectScoped: false,
        };
  });
}

/** Unknown required capabilities only; unknown optional ones degrade instead of blocking. */
export const pluginHasUnsupportedRequirement = (manifest: PluginManifest) =>
  describePluginCapabilities(manifest).some((entry) => !entry.known && !entry.optional);

export const pluginNeedsProjects = (manifest: PluginManifest) =>
  describePluginCapabilities(manifest).some((entry) => entry.known && entry.projectScoped);

/** Where a staged revision came from. Servers before recovery stage only publisher updates. */
export type PluginReviewRevision = "install" | "update" | "local-repair" | "previous";

export interface PluginSettingChange {
  readonly key: string;
  readonly label: string;
  readonly change: "added" | "removed" | "type-changed";
}

/**
 * What a review approves: a staged update when there is one (the installed version stays selected
 * until it is approved), otherwise the installed files.
 */
interface PluginReviewSubject {
  readonly kind: "install" | "update";
  readonly revision: PluginReviewRevision;
  readonly manifest: PluginManifest;
  readonly source: PluginSource;
  readonly digest: string;
  /** Requested by this version but not the running one; empty for a first review. */
  readonly newCapabilities: ReadonlyArray<string>;
  /** Requested by the running version but no longer by this one. */
  readonly removedCapabilities: ReadonlyArray<string>;
  /** Setting keys that appear, disappear, or change type compared with the running version. */
  readonly settingChanges: ReadonlyArray<PluginSettingChange>;
}

function pluginSettingChanges(
  running: PluginManifest,
  staged: PluginManifest,
): ReadonlyArray<PluginSettingChange> {
  const before = new Map(running.settings.map((setting) => [setting.key, setting]));
  const after = new Map(staged.settings.map((setting) => [setting.key, setting]));
  const changes: PluginSettingChange[] = [];
  for (const setting of staged.settings) {
    const previous = before.get(setting.key);
    if (previous === undefined) {
      changes.push({ key: setting.key, label: setting.label, change: "added" });
    } else if (previous.type !== setting.type) {
      changes.push({ key: setting.key, label: setting.label, change: "type-changed" });
    }
  }
  for (const setting of running.settings) {
    if (!after.has(setting.key)) {
      changes.push({ key: setting.key, label: setting.label, change: "removed" });
    }
  }
  return changes;
}

export function pluginReviewSubject(installation: PluginInstallation): PluginReviewSubject {
  const pending = installation.pendingUpdate;
  if (pending === undefined) {
    return {
      kind: "install",
      revision: "install",
      manifest: installation.manifest,
      source: installation.source,
      digest: installation.digest,
      newCapabilities: [],
      removedCapabilities: [],
      settingChanges: [],
    };
  }
  const running = pluginRequestedCapabilities(installation.manifest);
  const staged = pluginRequestedCapabilities(pending.manifest);
  return {
    kind: "update",
    revision:
      pending.kind === "local-repair" || pending.kind === "previous" ? pending.kind : "update",
    manifest: pending.manifest,
    source: pending.source,
    digest: pending.digest,
    newCapabilities: staged.filter((capability) => !running.includes(capability)),
    removedCapabilities: running.filter((capability) => !staged.includes(capability)),
    settingChanges: pluginSettingChanges(installation.manifest, pending.manifest),
  };
}

/**
 * The grants a review starts with. A first review offers everything requested and known; a later
 * one keeps what the user granted before, so re-approving never widens access without a click.
 */
export function initialPluginGrants(
  installation: PluginInstallation,
  manifest: PluginManifest = pluginReviewSubject(installation).manifest,
): PluginGrants {
  const requested = pluginRequestedCapabilities(manifest).filter(isKnownCapability);
  return {
    capabilities:
      installation.consentedDigest === null
        ? requested
        : requested.filter((capability) => installation.grants.capabilities.includes(capability)),
    projectIds: installation.grants.projectIds,
  };
}

export type PluginStatusTone = "success" | "warning" | "error" | "muted";

interface PluginStatusPresentation {
  readonly label: string;
  readonly tone: PluginStatusTone;
  /** What the row's primary control should offer. */
  readonly primary: "review" | "resume" | "none";
}

/**
 * A record stored by a newer T3 Code, or one this host could not read. The server keeps it
 * byte-for-byte and refuses changes, so clients offer no management for it.
 */
export const isPluginRecordReadOnly = (installation: PluginInstallation) =>
  installation.recordIssue !== undefined || installation.attention?.kind === "read-only";

/** Copy for a read-only record. It never suggests reinstalling: that would orphan its data. */
export function pluginRecordIssueMessage(installation: PluginInstallation): string | null {
  if (!isPluginRecordReadOnly(installation)) return null;
  return installation.recordIssue === "newer"
    ? "Saved by a newer version of T3 Code. Update T3 Code on this environment to use it. Nothing was changed."
    : "T3 Code could not read this plugin's saved record, so it was left untouched.";
}

/**
 * The version a record really carries. A read-only record comes wrapped in a placeholder manifest,
 * source and fingerprint; only the name and version the server could validate are real, and its
 * version reads 0.0.0 when the saved one was unreadable.
 */
export function pluginDisplayVersion(installation: PluginInstallation): string | null {
  if (!isPluginRecordReadOnly(installation)) return installation.manifest.version;
  return installation.manifest.version === "0.0.0" ? null : installation.manifest.version;
}

/**
 * Newer servers derive compatibility on every read, and it wins over a status persisted by an older
 * host; older servers only persist `incompatible`.
 */
export const isPluginUnavailable = (installation: PluginInstallation) =>
  installation.compatibility === undefined
    ? installation.status === "incompatible"
    : !installation.compatibility.available;

export function pluginStatusPresentation(
  installation: PluginInstallation,
  /** Safe mode: nothing runs, so nothing claims to be ready or offers a restart. */
  options: { readonly executionDisabled?: boolean | undefined } = {},
): PluginStatusPresentation {
  if (isPluginRecordReadOnly(installation)) {
    return { label: "Read-only", tone: "muted", primary: "none" };
  }
  if (isPluginUnavailable(installation)) {
    // The switch keeps showing what the user chose; this says why it is not running.
    return installation.enabled
      ? { label: "Unavailable", tone: "error", primary: "none" }
      : { label: "Disabled · unavailable here", tone: "muted", primary: "none" };
  }
  if (
    installation.status === "needs-consent" ||
    installation.consentedDigest !== installation.digest
  ) {
    return {
      label: installation.consentedDigest === null ? "Needs review" : "Changed, needs review",
      tone: "warning",
      primary: "review",
    };
  }
  if (options.executionDisabled === true) {
    return installation.enabled
      ? { label: "Paused · plugin code off", tone: "muted", primary: "none" }
      : { label: "Disabled", tone: "muted", primary: "none" };
  }
  switch (installation.status) {
    case "disabled":
      return { label: "Disabled", tone: "muted", primary: "none" };
    case "idle":
      return { label: "Ready", tone: "success", primary: "none" };
    case "running":
      return { label: "Running", tone: "success", primary: "none" };
    case "error":
      return { label: "Error", tone: "error", primary: "resume" };
    case "quarantined":
      return { label: "Stopped after repeated failures", tone: "error", primary: "resume" };
    case "incompatible":
      // Persisted by an older host; this one reports it compatible but has not started it yet.
      return { label: "Not running", tone: "muted", primary: "none" };
  }
}

/**
 * Why background event delivery is paused, if it is. Separate from the worker status: actions keep
 * working while events wait for a resume. Read by shape so it works before servers send it.
 */
export function pluginObserverError(installation: PluginInstallation): string | null {
  if (!("observerError" in installation)) return null;
  const error = installation.observerError;
  return typeof error === "string" && error.trim() !== "" ? error : null;
}

type PluginSourceParseResult =
  | { readonly ok: true; readonly source: PluginSource }
  | { readonly ok: false; readonly message: string };

/**
 * Accepts an absolute directory on the environment's machine, or an https Git URL with an
 * optional `#ref`. The server validates again; this only gives quick feedback.
 */
export function parsePluginSourceInput(raw: string): PluginSourceParseResult {
  const value = raw.trim();
  if (value === "") return { ok: false, message: "Enter a folder path or Git URL." };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, message: "That URL is not valid." };
    }
    if (url.protocol !== "https:") {
      return { ok: false, message: "Git sources must use https." };
    }
    if (url.username !== "" || url.password !== "") {
      return { ok: false, message: "Remove credentials from the URL." };
    }
    let ref: string;
    try {
      ref = decodeURIComponent(url.hash.slice(1)).trim();
    } catch {
      return { ok: false, message: "That Git ref is not valid." };
    }
    url.hash = "";
    return {
      ok: true,
      source: { kind: "git", url: url.toString(), ...(ref === "" ? {} : { ref }) },
    };
  }
  if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    return { ok: true, source: { kind: "local", directory: value } };
  }
  return {
    ok: false,
    message: "Use an absolute folder path on the environment, or an https Git URL.",
  };
}

export function pluginSourceLabel(source: PluginSource): string {
  return source.kind === "local"
    ? source.directory
    : source.ref === undefined
      ? source.url
      : `${source.url}#${source.ref}`;
}

export type PluginSettingDraft = Readonly<Record<string, string | boolean>>;

/** Secrets never come back from the server, so their draft always starts empty. */
export function pluginSettingsDraft(installation: PluginInstallation): PluginSettingDraft {
  const draft: Record<string, string | boolean> = {};
  for (const setting of installation.manifest.settings) {
    const value = installation.settings[setting.key] ?? setting.default;
    if (setting.type === "boolean") draft[setting.key] = value === true;
    else if (setting.type === "secret") draft[setting.key] = "";
    else draft[setting.key] = value === undefined ? "" : String(value);
  }
  return draft;
}

type PluginSettingsPatchResult =
  | { readonly ok: true; readonly values: Record<string, PluginSettingValue> }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/**
 * Only changed values are sent. An empty secret field keeps the stored secret; a key in
 * `clearedSecrets` sends "" so the server deletes it.
 */
export function buildPluginSettingsPatch(
  settings: ReadonlyArray<PluginSetting>,
  current: Readonly<Record<string, PluginSettingValue>>,
  draft: PluginSettingDraft,
  clearedSecrets: ReadonlySet<string> = new Set(),
): PluginSettingsPatchResult {
  const values: Record<string, PluginSettingValue> = {};
  const errors: Record<string, string> = {};
  for (const setting of settings) {
    const raw = draft[setting.key];
    const previous = current[setting.key] ?? setting.default;
    switch (setting.type) {
      case "boolean": {
        const next = raw === true;
        if (next !== (previous === true)) values[setting.key] = next;
        break;
      }
      case "number": {
        const text = typeof raw === "string" ? raw.trim() : "";
        if (text === "") {
          if (previous !== undefined) errors[setting.key] = "Enter a number.";
          break;
        }
        const next = Number(text);
        if (!Number.isFinite(next)) {
          errors[setting.key] = "Enter a number.";
          break;
        }
        if (next !== previous) values[setting.key] = next;
        break;
      }
      case "string": {
        const next = typeof raw === "string" ? raw : "";
        if (next !== (previous === undefined ? "" : String(previous))) values[setting.key] = next;
        break;
      }
      case "secret": {
        const next = typeof raw === "string" ? raw : "";
        if (next !== "") values[setting.key] = next;
        else if (clearedSecrets.has(setting.key)) values[setting.key] = "";
        break;
      }
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, values };
}
