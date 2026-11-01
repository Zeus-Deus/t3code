import { useAtomValue } from "@effect/atom-react";
import {
  buildPluginSettingsPatch,
  describePluginCapabilities,
  environmentSupportsPlugins,
  initialPluginGrants,
  isPluginActive,
  isPluginRecordReadOnly,
  isPluginUnavailable,
  parsePluginSourceInput,
  pluginApprovalBacklogStep,
  pluginAttention,
  pluginCurrentRevisionNote,
  pluginDisplayVersion,
  pluginHasUnsupportedRequirement,
  pluginInactiveReason,
  pluginNeedsProjects,
  pluginQuickUpdate,
  pluginRecoveryActions,
  pluginRemovalNote,
  pluginReviewSubject,
  pluginSettingsDraft,
  pluginSourceLabel,
  pluginStatusPresentation,
  pluginUpdateProjects,
  pluginUpdateScopeNote,
  type PluginQuickUpdate,
  type PluginReviewRevision,
  type PluginSettingDraft,
  type PluginStatusTone,
} from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type PluginAction,
  type PluginCapability,
  type PluginGrants,
  type PluginInstallation,
  type PluginManifest,
  type ProjectId,
} from "@t3tools/contracts";
import { useBlocker, useLocation } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FileSearchIcon,
  HistoryIcon,
  HouseIcon,
  InfoIcon,
  PlusIcon,
  PuzzleIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useId, useRef, useState, type ReactNode, type Ref } from "react";
import { flushSync } from "react-dom";

import { requestConfirmDialog } from "../../confirmDialog";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useProjects } from "../../state/entities";
import type { EnvironmentPresentation } from "../../state/environments";
import { pluginEnvironment, usePluginCatalogue } from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { PluginDetailsDialog, UsePreviousPluginDialog } from "../plugins/PluginRecoveryDialogs";
import { pluginFailureMessage, usePluginIntentApplier } from "../plugins/usePluginActions";
import { usePluginEventBacklog } from "../plugins/usePluginEventBacklog";
import { usePluginStartPage } from "../plugins/pluginStartPage";
import { usePluginRepair } from "../plugins/usePluginRepair";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ExpandableText } from "./ExpandableText";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SecretInput } from "./SecretInput";
import { SettingsGroup } from "./SettingsGroup";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/** Dialogs act on the environment the page shows; switching it remounts the page. */
type PluginDialog =
  | { readonly kind: "install" }
  | {
      readonly kind: "review";
      readonly installationId: string;
      /** The install result, shown until the catalogue push includes it. */
      readonly installed?: PluginInstallation;
    }
  | { readonly kind: "remove"; readonly installation: PluginInstallation }
  | { readonly kind: "details" | "use-previous"; readonly installationId: string };

const TONE_BADGE: Record<PluginStatusTone, "success" | "warning" | "error" | "outline"> = {
  success: "success",
  warning: "warning",
  error: "error",
  muted: "outline",
};

const TONE_DOT: Record<PluginStatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

const PLACEMENT_LABELS: Record<PluginAction["placements"][number], string> = {
  palette: "Command palette",
  "thread-menu": "Thread menu",
  "message-selection": "Text selection",
};

const REVIEW_LABELS: Record<PluginReviewRevision, string> = {
  install: "Review",
  update: "Review update",
  "local-repair": "Review local fix",
  previous: "Review previous version",
};

// Matches Providers so both list/editor cards scroll the same way.
const PLUGIN_CARD_HEIGHT =
  "@min-[48rem]/plugins:h-[min(44rem,calc(100dvh-11rem))] @min-[48rem]/plugins:min-h-[32rem]";

type PluginStatusPresentation = ReturnType<typeof pluginStatusPresentation>;

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastManager.add({
    type: "error",
    title,
    description: pluginFailureMessage(squashAtomCommandFailure(result)),
  });
}

async function confirmDiscardSettings(name: string): Promise<boolean> {
  const message = `Discard unsaved changes to ${name} settings?`;
  return (
    (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message)
  );
}

/** Needs review, an update waiting, a failure, or anything else the user should look at. */
function pluginNeedsAttention(installation: PluginInstallation, status: PluginStatusPresentation) {
  return (
    status.primary !== "none" ||
    installation.pendingUpdate !== undefined ||
    pluginAttention(installation) !== null
  );
}

function pluginMatchesQuery(installation: PluginInstallation, query: string) {
  if (query === "") return true;
  const { name, id, description } = installation.manifest;
  return `${name}\n${id}\n${description ?? ""}`.toLowerCase().includes(query);
}

/** The visible element is the one the user can reach; the other is hidden by a container query. */
const isRendered = (element: HTMLElement | null) =>
  element !== null && element.getClientRects().length > 0;

export function PluginsSettings(props: {
  /** A deep link to one plugin, honoured only on the environment it names. */
  readonly target?: { readonly environmentId?: EnvironmentId; readonly installationId?: string };
}) {
  const { scope, environments, environment } = useSettingsScope();
  // Installs belong to one environment, so the page shows the one the Settings scope selects.
  const selected = environment ?? environments[0] ?? null;
  const target = props.target;
  const targetInstallationId =
    target?.installationId !== undefined &&
    (target.environmentId === undefined || target.environmentId === selected?.environmentId)
      ? target.installationId
      : undefined;
  return (
    <SettingsPageContainer className="@container/plugins">
      {scope.kind === "unavailable" ? (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">{scope.message}</p>
      ) : selected === null ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <PuzzleIcon />
            </EmptyMedia>
            <EmptyTitle>No environments available</EmptyTitle>
            <EmptyDescription>Connect an environment to manage its plugins.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <EnvironmentPlugins
          // A new link to a plugin selects it, as a fresh visit would.
          key={`${selected.environmentId}:${targetInstallationId ?? ""}`}
          environment={selected}
          targetInstallationId={targetInstallationId}
        />
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentPlugins(props: {
  readonly environment: EnvironmentPresentation;
  readonly targetInstallationId: string | undefined;
}) {
  const { environmentId, label } = props.environment;
  const catalogue = usePluginCatalogue(environmentId);
  const canInstall = useAtomValue(pluginEnvironment.install.permissionAtom(environmentId));
  const [dialog, setDialog] = useState<PluginDialog | null>(null);
  // Set when the user picks a plugin, or by a deep link; until then the first one is shown.
  const [selectedId, setSelectedId] = useState<string | null>(props.targetInstallationId ?? null);
  // On a narrow screen the list and the selected plugin take turns.
  const [detailOpen, setDetailOpen] = useState(props.targetInstallationId !== undefined);
  const supported = environmentSupportsPlugins(
    props.environment.serverConfig?.environment.capabilities,
  );
  // The installation whose settings form has unsaved values, if any.
  const [dirtyForm, setDirtyForm] = useState<{
    installationId: string;
    digest: string;
    formId: string;
  } | null>(null);
  const edited =
    selectedId === null
      ? catalogue.installations[0]
      : catalogue.installations.find((entry) => entry.installationId === selectedId);
  const formMounted =
    catalogue.availability === "available" &&
    catalogue.loaded &&
    catalogue.error === null &&
    edited !== undefined &&
    !isPluginRecordReadOnly(edited) &&
    edited.manifest.settings.length > 0;
  const dirtyId = dirtyForm?.installationId ?? null;
  const keepsDraft =
    formMounted && edited.installationId === dirtyId && edited.digest === dirtyForm?.digest;
  if (dirtyForm !== null && !keepsDraft) setDirtyForm(null);
  const dirtyName = keepsDraft ? edited.manifest.name : null;
  const reportDirty = (installationId: string, digest: string, formId: string, dirty: boolean) =>
    setDirtyForm((current) =>
      dirty
        ? { installationId, digest, formId }
        : current?.installationId === installationId &&
            current.digest === digest &&
            current.formId === formId
          ? null
          : current,
    );
  const select = (installationId: string) => {
    setSelectedId(installationId);
    setDetailOpen(true);
  };
  // A finished install selects the new plugin, which would drop the unsaved values.
  const startInstall = async () => {
    if (dirtyName !== null && !(await confirmDiscardSettings(dirtyName))) return;
    setDialog({ kind: "install" });
  };

  // Leaving the page or switching environment would drop the unsaved values. Electron cancels a
  // prevented unload without asking, so closing, quitting or updating the desktop app would
  // silently stall; there only in-app navigation asks.
  useBlocker({
    disabled: dirtyName === null,
    enableBeforeUnload: dirtyName !== null && !isElectron,
    shouldBlockFn: async ({ current, next }) => {
      if (
        current.pathname === next.pathname &&
        JSON.stringify(current.search) === JSON.stringify(next.search)
      ) {
        return false;
      }
      return !(await confirmDiscardSettings(dirtyName ?? "this plugin"));
    },
  });
  const body = (() => {
    switch (catalogue.availability) {
      case "unknown":
      case "disconnected":
        return (
          <PluginsMessage
            title="Environment disconnected"
            description={`Reconnect ${label} to manage its plugins.`}
          />
        );
      case "unsupported":
        return (
          <PluginsMessage
            title="Plugins unavailable"
            description={`Update the T3 Code server on ${label} to use plugins.`}
          />
        );
      case "client-outdated":
        return (
          <PluginsMessage
            title="Plugins unavailable"
            description={`${label} uses a newer plugin version. Update T3 Code on this device to manage its plugins.`}
          />
        );
      case "forbidden":
        return (
          <PluginsMessage
            title="No access"
            description="This connection cannot read the environment's plugins."
          />
        );
      case "available":
        if (catalogue.error !== null) {
          return <PluginsMessage title="Could not load plugins" description={catalogue.error} />;
        }
        if (!catalogue.loaded) return <PluginsMessage title="Loading plugins…" status />;
        return (
          <>
            {catalogue.unavailableMessage ? (
              <Alert variant="error" controlAlignment="first-line">
                <TriangleAlertIcon aria-hidden />
                <AlertDescription>
                  Plugins on {label} are off: {catalogue.unavailableMessage} Your plugins and their
                  data were left untouched.
                </AlertDescription>
              </Alert>
            ) : null}
            {catalogue.executionDisabled === true ? (
              <Alert variant="warning" controlAlignment="first-line">
                <TriangleAlertIcon aria-hidden />
                <AlertDescription>
                  Plugin code is turned off on {label}. Nothing runs until T3 Code starts with
                  plugins on, but you can still review, disable, or remove plugins here.
                </AlertDescription>
              </Alert>
            ) : null}
            {catalogue.installations.length === 0 ? (
              catalogue.unavailableMessage ? null : (
                <PluginsMessage
                  title="No plugins installed"
                  description={`Install one from a folder on ${label} or an https Git repository.`}
                />
              )
            ) : (
              <PluginBrowser
                environment={props.environment}
                installations={catalogue.installations}
                recoverySupported={catalogue.recoverySupported === true}
                executionDisabled={catalogue.executionDisabled === true}
                selectedId={selectedId}
                detailOpen={detailOpen}
                canInstall={canInstall && supported}
                dirtyId={dirtyId}
                dirtyName={dirtyName}
                onDirtyChange={reportDirty}
                onSelect={select}
                onBack={() => setDetailOpen(false)}
                onInstall={() => void startInstall()}
                onDialog={setDialog}
              />
            )}
          </>
        );
    }
  })();
  return (
    <>
      <SettingsSection
        id="plugins"
        title="Plugins"
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canInstall || !supported}
            onClick={() => void startInstall()}
          >
            <PlusIcon className="size-3" />
            Install plugin
          </Button>
        }
      >
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          Plugins run as separate processes on {label}, with that machine user&apos;s access. T3
          Code does not sandbox plugin code; install plugins you trust.
        </p>
        {body}
      </SettingsSection>
      {dialog?.kind === "install" ? (
        <InstallPluginDialog
          environment={props.environment}
          onClose={() => setDialog(null)}
          onInstalled={(installation) => {
            select(installation.installationId);
            setDialog({
              kind: "review",
              installationId: installation.installationId,
              installed: installation,
            });
          }}
        />
      ) : null}
      {dialog?.kind === "review" ? (
        <ReviewPluginDialog
          key={dialog.installationId}
          environmentId={environmentId}
          installationId={dialog.installationId}
          installed={dialog.installed}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "remove" ? (
        <RemovePluginDialog
          environmentId={environmentId}
          installation={dialog.installation}
          onClose={() => setDialog(null)}
          onRemoved={() => {
            setDialog(null);
            setSelectedId(null);
            setDetailOpen(false);
          }}
        />
      ) : null}
      {dialog?.kind === "details" || dialog?.kind === "use-previous" ? (
        <PluginRecoveryDialog
          kind={dialog.kind}
          environmentId={environmentId}
          installationId={dialog.installationId}
          onDialog={setDialog}
        />
      ) : null}
    </>
  );
}

function PluginsMessage(props: {
  readonly title: string;
  readonly description?: string;
  readonly status?: boolean;
}) {
  return (
    <SettingsGroup>
      <SettingsRow
        title={props.title}
        description={props.description}
        {...(props.status ? { role: "status" } : {})}
      />
    </SettingsGroup>
  );
}

/** Turning a plugin on asks about missed runs first; one prompt serves the whole list. */
function usePluginEnabledToggle(props: {
  readonly environmentId: EnvironmentId;
  readonly recoverySupported: boolean;
  readonly onReview: (installationId: string) => void;
}) {
  const { environmentId, recoverySupported } = props;
  const setEnabled = useAtomCommand(pluginEnvironment.setEnabled, { reportFailure: false });
  const { resolveBacklog, backlogDialog } = usePluginEventBacklog();
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const mark = (installationId: string, on: boolean) =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(installationId);
      else next.delete(installationId);
      return next;
    });
  const toggle = (installation: PluginInstallation, enabled: boolean) => {
    const { installationId } = installation;
    if (enabled && pluginStatusPresentation(installation).primary === "review") {
      props.onReview(installationId);
      return;
    }
    mark(installationId, true);
    // Promise#finally because React Compiler cannot compile a try/finally without a catch.
    void new Promise<void>((resolve) =>
      resolve(
        (async () => {
          const backlog = enabled
            ? await resolveBacklog(environmentId, installation, recoverySupported)
            : ({ proceed: true } as const);
          if (!backlog.proceed) return;
          const result = await setEnabled({
            environmentId,
            input: {
              installationId,
              enabled,
              ...(backlog.eventBacklog ? { eventBacklog: backlog.eventBacklog } : {}),
            },
          });
          reportFailure(
            `Could not ${enabled ? "enable" : "disable"} ${installation.manifest.name}`,
            result,
          );
        })(),
      ),
    ).finally(() => mark(installationId, false));
  };
  return { toggle, busy, backlogDialog };
}

function PluginBrowser(props: {
  readonly environment: EnvironmentPresentation;
  readonly installations: ReadonlyArray<PluginInstallation>;
  readonly recoverySupported: boolean;
  readonly executionDisabled: boolean;
  readonly selectedId: string | null;
  readonly detailOpen: boolean;
  readonly canInstall: boolean;
  readonly dirtyId: string | null;
  readonly dirtyName: string | null;
  readonly onDirtyChange: (
    installationId: string,
    digest: string,
    formId: string,
    dirty: boolean,
  ) => void;
  readonly onSelect: (installationId: string) => void;
  readonly onBack: () => void;
  readonly onInstall: () => void;
  readonly onDialog: (dialog: PluginDialog) => void;
}) {
  const { environment, installations, executionDisabled, detailOpen, dirtyId, dirtyName } = props;
  const { environmentId } = environment;
  const idPrefix = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const canManage = useAtomValue(pluginEnvironment.setEnabled.permissionAtom(environmentId));
  const { toggle, busy, backlogDialog } = usePluginEnabledToggle({
    environmentId,
    recoverySupported: props.recoverySupported,
    onReview: (installationId) => props.onDialog({ kind: "review", installationId }),
  });

  const entries = installations.map((installation) => {
    const status = pluginStatusPresentation(installation, { executionDisabled });
    return { installation, status, attention: pluginNeedsAttention(installation, status) };
  });
  const attentionCount = entries.filter((entry) => entry.attention).length;
  const filterAttention = attentionOnly && attentionCount > 0;
  const needle = query.trim().toLowerCase();
  const visible = entries.filter(
    (entry) =>
      (!filterAttention || entry.attention) && pluginMatchesQuery(entry.installation, needle),
  );
  const filtering = needle !== "" || filterAttention;
  const selected =
    props.selectedId === null
      ? (installations[0] ?? null)
      : (installations.find((entry) => entry.installationId === props.selectedId) ?? null);
  const rowId = (installationId: string) => `${idPrefix}-plugin-${installationId}`;

  const select = async (installationId: string) => {
    if (dirtyName !== null && dirtyId !== installationId) {
      if (!(await confirmDiscardSettings(dirtyName))) return;
    }
    flushSync(() => props.onSelect(installationId));
    // On a narrow screen the list just went away; take focus to what replaced it.
    if (!isRendered(listRef.current)) headingRef.current?.focus();
  };
  const back = () => {
    flushSync(props.onBack);
    const row = selected === null ? null : document.getElementById(rowId(selected.installationId));
    // A search or the attention filter may have hidden the row since it was opened.
    if (isRendered(row)) row?.focus();
    else searchRef.current?.focus();
  };
  const clearFilters = () => {
    setQuery("");
    setAttentionOnly(false);
  };

  return (
    <SettingsGroup
      divided={false}
      className={cn(
        PLUGIN_CARD_HEIGHT,
        "overflow-hidden @min-[48rem]/plugins:grid @min-[48rem]/plugins:grid-cols-[17rem_minmax(0,1fr)]",
      )}
    >
      <div
        ref={listRef}
        className={cn(
          "min-w-0 bg-muted/10 @min-[48rem]/plugins:flex @min-[48rem]/plugins:min-h-0 @min-[48rem]/plugins:flex-col @min-[48rem]/plugins:border-r @min-[48rem]/plugins:border-border/60",
          detailOpen && "@max-[48rem]/plugins:hidden",
        )}
      >
        <div className="space-y-2 border-b border-border/50 px-3 py-3 sm:px-4">
          <Input
            ref={searchRef}
            type="search"
            size="sm"
            aria-label="Search plugins"
            placeholder="Search plugins"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="flex min-h-7 items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {filtering
                ? `${visible.length} of ${installations.length} plugins`
                : `${installations.length} ${installations.length === 1 ? "plugin" : "plugins"}`}
            </span>
            {attentionCount > 0 ? (
              <Toggle
                size="sm"
                variant="outline"
                pressed={filterAttention}
                onPressedChange={setAttentionOnly}
              >
                <TriangleAlertIcon aria-hidden />
                Needs attention ({attentionCount})
              </Toggle>
            ) : null}
          </div>
        </div>
        <ScrollArea
          scrollFade
          chainVerticalScroll
          className="@min-[48rem]/plugins:min-h-0 @min-[48rem]/plugins:flex-1"
        >
          <ul aria-label={`Plugins on ${environment.label}`} className="divide-y divide-border/50">
            {visible.map((entry) => (
              <PluginListRow
                key={entry.installation.installationId}
                id={rowId(entry.installation.installationId)}
                installation={entry.installation}
                status={entry.status}
                selected={entry.installation.installationId === selected?.installationId}
                busy={busy.has(entry.installation.installationId)}
                canManage={canManage}
                onSelect={(installationId) => void select(installationId)}
                onToggle={toggle}
              />
            ))}
            {visible.length === 0 ? (
              <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-4 text-sm text-muted-foreground sm:px-4">
                <span>No plugins match.</span>
                <Button size="sm" variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              </li>
            ) : null}
            <li>
              <button
                type="button"
                disabled={!props.canInstall}
                className="flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-muted/25 hover:text-foreground focus-visible:bg-muted/25 focus-visible:text-foreground disabled:pointer-events-none disabled:opacity-64 sm:px-4"
                onClick={props.onInstall}
              >
                <PlusIcon className="size-4 shrink-0" />
                Install plugin
              </button>
            </li>
          </ul>
        </ScrollArea>
      </div>

      <div
        className={cn(
          "min-w-0 @min-[48rem]/plugins:min-h-0",
          !detailOpen && "@max-[48rem]/plugins:hidden",
        )}
      >
        <ScrollArea scrollFade chainVerticalScroll className="@min-[48rem]/plugins:h-full">
          <div className="space-y-6 p-4">
            <Button
              size="sm"
              variant="ghost"
              className="-ms-2 @min-[48rem]/plugins:hidden"
              onClick={back}
            >
              <ChevronLeftIcon aria-hidden />
              All plugins on {environment.label}
            </Button>
            {selected ? (
              <PluginEditor
                key={selected.installationId}
                headingRef={headingRef}
                environment={environment}
                installation={selected}
                recoverySupported={props.recoverySupported}
                executionDisabled={executionDisabled}
                busy={busy.has(selected.installationId)}
                canManage={canManage}
                onToggle={toggle}
                onDialog={props.onDialog}
                onDirtyChange={props.onDirtyChange}
              />
            ) : (
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="px-3 text-sm font-normal text-muted-foreground outline-none sm:px-4"
              >
                This plugin is no longer installed on {environment.label}.
              </h2>
            )}
          </div>
        </ScrollArea>
      </div>
      {backlogDialog}
    </SettingsGroup>
  );
}

/** Selecting a row only shows its plugin; the switch beside it is the one control that acts. */
function PluginListRow(props: {
  readonly id: string;
  readonly installation: PluginInstallation;
  readonly status: PluginStatusPresentation;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly canManage: boolean;
  readonly onSelect: (installationId: string) => void;
  readonly onToggle: (installation: PluginInstallation, enabled: boolean) => void;
}) {
  const { installation, status, selected } = props;
  const { manifest } = installation;
  const statusId = `${props.id}-status`;
  const version = pluginDisplayVersion(installation);
  const attention = pluginAttention(installation);
  const pending = installation.pendingUpdate
    ? pluginReviewSubject(installation).revision === "update"
      ? `Update ${installation.pendingUpdate.manifest.version} available`
      : REVIEW_LABELS[pluginReviewSubject(installation).revision]
    : null;
  const unavailable = isPluginUnavailable(installation);
  const readOnly = isPluginRecordReadOnly(installation);
  return (
    <li
      className={cn(
        "group flex min-h-18 items-center gap-3 px-3 py-3 transition-colors sm:px-4",
        selected ? "bg-muted/45" : "hover:bg-muted/25",
      )}
    >
      <div
        className={cn(
          "pointer-events-none relative min-w-0 flex-1 rounded-md transition-opacity",
          !installation.enabled && !selected && "opacity-60 group-hover:opacity-100",
        )}
      >
        <button
          id={props.id}
          type="button"
          className="pointer-events-auto absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-label={`Select ${manifest.name}`}
          aria-describedby={statusId}
          aria-pressed={selected}
          onClick={() => props.onSelect(installation.installationId)}
        />
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{manifest.name}</span>
          {version === null ? null : (
            <code className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
              v{version}
            </code>
          )}
        </span>
        <span
          id={statusId}
          className="mt-0.5 flex items-start gap-1.5 text-xs leading-normal text-muted-foreground"
        >
          <span className="flex h-[1.45em] shrink-0 items-center">
            <span aria-hidden className={cn("size-1.5 rounded-full", TONE_DOT[status.tone])} />
          </span>
          <span className="line-clamp-2 [overflow-wrap:anywhere]">
            {[
              status.label,
              pending,
              attention && attention.kind !== "read-only" ? attention.title : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      </div>
      <Switch
        checked={installation.enabled}
        // Turning a plugin off always works; turning it on needs a host that can run it.
        disabled={
          props.busy || !props.canManage || readOnly || (!installation.enabled && unavailable)
        }
        aria-label={`Enable ${manifest.name}`}
        onCheckedChange={(enabled) => props.onToggle(installation, enabled)}
      />
    </li>
  );
}

/** The selected plugin: what needs doing first, then its settings, then everything else. */
function PluginEditor(props: {
  readonly headingRef: Ref<HTMLHeadingElement>;
  readonly environment: EnvironmentPresentation;
  readonly installation: PluginInstallation;
  readonly recoverySupported: boolean;
  readonly executionDisabled: boolean;
  readonly busy: boolean;
  readonly canManage: boolean;
  readonly onToggle: (installation: PluginInstallation, enabled: boolean) => void;
  readonly onDialog: (dialog: PluginDialog) => void;
  readonly onDirtyChange: (
    installationId: string,
    digest: string,
    formId: string,
    dirty: boolean,
  ) => void;
}) {
  const { environment, installation, recoverySupported, executionDisabled, canManage } = props;
  const { headingRef, onDialog, onToggle } = props;
  const { environmentId } = environment;
  const { manifest, installationId } = installation;
  const sectionId = useId();
  const status = pluginStatusPresentation(installation, { executionDisabled });
  const readOnly = isPluginRecordReadOnly(installation);
  const unavailable = isPluginUnavailable(installation);
  const version = pluginDisplayVersion(installation);
  const recovery = pluginRecoveryActions(installation, recoverySupported);
  const canRepair = useAtomValue(pluginEnvironment.prepareRepair.permissionAtom(environmentId));
  const lifecycle = usePluginLifecycle({
    environmentId,
    installation,
    recoverySupported,
    onReview: () => onDialog({ kind: "review", installationId }),
  });
  const working = props.busy || lifecycle.busy;
  const sidebarViews = manifest.sidebarViews ?? [];
  return (
    <>
      <div className="space-y-2 px-3 sm:px-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="min-w-0 text-base font-medium [overflow-wrap:anywhere] outline-none"
          >
            {manifest.name}
          </h2>
          {version === null ? null : (
            <code className="text-xs text-muted-foreground">v{version}</code>
          )}
          <Badge variant={TONE_BADGE[status.tone]}>{status.label}</Badge>
          {recovery.runningLocalFix ? <Badge variant="outline">Local fix</Badge> : null}
          {/* The list's switch is beside this on wide screens; narrow screens show one at a time. */}
          <span className="ms-auto flex items-center @min-[48rem]/plugins:hidden">
            <Switch
              checked={installation.enabled}
              disabled={working || !canManage || readOnly || (!installation.enabled && unavailable)}
              aria-label={`Enable ${manifest.name}`}
              onCheckedChange={(enabled) => onToggle(installation, enabled)}
            />
          </span>
        </div>
        {manifest.description ? (
          <p className="line-clamp-3 text-sm text-muted-foreground">{manifest.description}</p>
        ) : null}
      </div>

      <PluginAttentionBanner
        installation={installation}
        status={status}
        executionDisabled={executionDisabled}
        recoverySupported={recoverySupported}
        disabled={working}
        canManage={canManage}
        canRepair={canRepair}
        onResume={() => void lifecycle.resume()}
        onRepair={() => void lifecycle.repair()}
        onDialog={onDialog}
      />

      {manifest.settings.length > 0 && !readOnly ? (
        <PluginSettingsForm
          // New generations of the same files (enable, disable, consent) keep the draft. Other
          // files may declare other settings, so a draft never carries across a digest.
          key={installation.digest}
          environmentId={environmentId}
          installation={installation}
          canManage={canManage}
          onDirtyChange={props.onDirtyChange}
        />
      ) : null}

      {manifest.views.length > 0 || sidebarViews.length > 0 ? (
        <PluginViews
          environmentId={environmentId}
          installation={installation}
          executionDisabled={executionDisabled}
        />
      ) : null}

      {readOnly ? null : (
        <PluginPermissions
          environmentId={environmentId}
          installation={installation}
          canManage={canManage}
          onReview={() => onDialog({ kind: "review", installationId })}
        />
      )}

      {readOnly ? null : (
        <SettingsSection title="Source">
          <SettingsRow
            title={installation.source.kind === "local" ? "Local folder" : "Git repository"}
            description={
              <span className="font-mono text-xs [overflow-wrap:anywhere]">
                {pluginSourceLabel(installation.source)}
              </span>
            }
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={working || !canManage}
                onClick={() => void lifecycle.checkForChanges()}
              >
                <RefreshCwIcon aria-hidden />
                {recovery.runningLocalFix
                  ? "Check publisher for updates"
                  : "Check source for changes"}
              </Button>
            }
          />
        </SettingsSection>
      )}

      {readOnly ? null : (
        <SettingsSection title="Manage">
          {recovery.repair !== null ? (
            <SettingsRow
              title={recovery.repair === "open" ? "Repair draft" : "Repair with an agent"}
              description="Copies the plugin's files into a folder an agent can fix. Nothing changes until you review the fix."
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={working || !canRepair}
                  onClick={() => void lifecycle.repair()}
                >
                  <BotIcon aria-hidden />
                  {recovery.repair === "open" ? "Open repair draft" : "Repair with agent"}
                </Button>
              }
            />
          ) : null}
          {recovery.stageRepair ? (
            <SettingsRow
              title="Local fix"
              description="Review the repair folder's current files before they run."
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={working || !canManage}
                  onClick={() => void lifecycle.stageRepair()}
                >
                  <FileSearchIcon aria-hidden />
                  Review local fix
                </Button>
              }
            />
          ) : null}
          {recovery.usePrevious !== null ? (
            <SettingsRow
              title="Previous version"
              description={`Version ${recovery.usePrevious.version} is kept. It would run with today's settings and data.`}
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={working || !canManage}
                  onClick={() => onDialog({ kind: "use-previous", installationId })}
                >
                  <HistoryIcon aria-hidden />
                  Use previous version (v{recovery.usePrevious.version})…
                </Button>
              }
            />
          ) : null}
          <SettingsRow
            title="Remove plugin"
            description={`Removes it from ${environment.label}. You choose whether to keep its settings and data.`}
            control={
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={working || !canManage}
                onClick={() => onDialog({ kind: "remove", installation })}
              >
                <Trash2Icon aria-hidden />
                Remove…
              </Button>
            }
          />
        </SettingsSection>
      )}

      {manifest.actions.length > 0 ? (
        <FoldedSettingsSection
          id={`${sectionId}-commands`}
          title={`Commands it adds (${manifest.actions.length})`}
          headerPlacement="outside"
        >
          {manifest.actions.map((action) => (
            <SettingsRow
              key={action.id}
              title={action.title}
              description={[
                action.description,
                action.placements.map((placement) => PLACEMENT_LABELS[placement]).join(", "),
                action.agentCallable ? "Agents can call it" : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          ))}
        </FoldedSettingsSection>
      ) : null}

      <FoldedSettingsSection id={`${sectionId}-details`} title="Details" headerPlacement="outside">
        {readOnly ? null : (
          <>
            <SettingsRow
              title="Identifier"
              description={<span className="font-mono text-xs">{manifest.id}</span>}
            />
            <SettingsRow
              title="Fingerprint"
              description={
                <span className="font-mono text-xs break-all">{installation.digest}</span>
              }
            />
          </>
        )}
        <SettingsRow
          title="History and diagnostics"
          description="What T3 Code recorded about this plugin's versions and failures."
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => onDialog({ kind: "details", installationId })}
            >
              <InfoIcon aria-hidden />
              View details
            </Button>
          }
        />
      </FoldedSettingsSection>
      {lifecycle.backlogDialog}
    </>
  );
}

/** Refresh, restart and repair for one plugin, with the outcome toasts the old menu showed. */
function usePluginLifecycle(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly recoverySupported: boolean;
  readonly onReview: () => void;
}) {
  const { environmentId, installation, recoverySupported } = props;
  const { manifest } = installation;
  const refresh = useAtomCommand(pluginEnvironment.refresh, { reportFailure: false });
  const resume = useAtomCommand(pluginEnvironment.resume, { reportFailure: false });
  const stageRepair = useAtomCommand(pluginEnvironment.stageRepair, { reportFailure: false });
  const repair = usePluginRepair();
  const { resolveBacklog, backlogDialog } = usePluginEventBacklog();
  const [busy, setBusy] = useState(false);
  const target = { installationId: installation.installationId };
  // Promise#finally because React Compiler cannot compile a try/finally without a catch. The
  // executor turns a synchronous throw into a rejection; failures still reach the caller.
  const withBusy = (run: () => Promise<void>) => {
    setBusy(true);
    return new Promise<void>((resolve) => resolve(run())).finally(() => setBusy(false));
  };
  return {
    busy,
    backlogDialog,
    checkForChanges: () =>
      withBusy(async () => {
        const result = await refresh({ environmentId, input: target });
        if (result._tag === "Failure") {
          reportFailure(`Could not refresh ${manifest.name}`, result);
          return;
        }
        const pending = result.value.pendingUpdate;
        if (pending === undefined && result.value.digest === installation.digest) {
          toastManager.add({ type: "info", title: `${manifest.name} is up to date` });
          return;
        }
        const id = toastManager.add({
          type: "info",
          title: pending
            ? `${manifest.name} ${pending.manifest.version} is available`
            : `${manifest.name} changed`,
          description: pending
            ? pluginCurrentRevisionNote(result.value)
            : "Review the new files before they can run.",
          actionProps: {
            children: "Review",
            onClick: () => {
              toastManager.close(id);
              props.onReview();
            },
          },
        });
      }),
    resume: () =>
      withBusy(async () => {
        const backlog = await resolveBacklog(environmentId, installation, recoverySupported);
        if (!backlog.proceed) return;
        const result = await resume({
          environmentId,
          input: {
            ...target,
            ...(backlog.eventBacklog ? { eventBacklog: backlog.eventBacklog } : {}),
          },
        });
        reportFailure(`Could not restart ${manifest.name}`, result);
      }),
    repair: () => withBusy(() => repair(environmentId, installation)),
    stageRepair: () =>
      withBusy(async () => {
        const workspace = installation.recovery?.repair;
        if (workspace === undefined) return;
        const result = await stageRepair({
          environmentId,
          input: {
            ...target,
            workspaceId: workspace.workspaceId,
            baseDigest: workspace.baseDigest,
          },
        });
        if (result._tag === "Failure") {
          reportFailure(`Could not stage the ${manifest.name} fix`, result);
          return;
        }
        props.onReview();
      }),
  };
}

/** The one thing to do next, with the problem in full so it is never only in a menu. */
function PluginAttentionBanner(props: {
  readonly installation: PluginInstallation;
  readonly status: PluginStatusPresentation;
  readonly executionDisabled: boolean;
  readonly recoverySupported: boolean;
  readonly disabled: boolean;
  readonly canManage: boolean;
  readonly canRepair: boolean;
  readonly onResume: () => void;
  readonly onRepair: () => void;
  readonly onDialog: (dialog: PluginDialog) => void;
}) {
  const { installation, status } = props;
  const { installationId } = installation;
  const readOnly = isPluginRecordReadOnly(installation);
  const attention = pluginAttention(installation);
  const recovery = pluginRecoveryActions(installation, props.recoverySupported);
  const review = () => props.onDialog({ kind: "review", installationId });
  const details = () => props.onDialog({ kind: "details", installationId });
  const actionButton = (label: string, icon: ReactNode, onClick: () => void, allowed = true) => (
    <Button size="sm" variant="outline" disabled={props.disabled || !allowed} onClick={onClick}>
      {icon}
      {label}
    </Button>
  );

  if (readOnly) {
    return (
      <Alert variant="info" controlAlignment="first-line">
        <InfoIcon aria-hidden />
        <AlertTitle>{attention?.title ?? "Read-only record"}</AlertTitle>
        {attention ? <AlertDescription>{attention.message}</AlertDescription> : null}
        <AlertAction>{actionButton("View details", <InfoIcon aria-hidden />, details)}</AlertAction>
      </Alert>
    );
  }
  if (status.primary === "review") {
    const changed = installation.consentedDigest !== null;
    return (
      <Alert variant="warning" controlAlignment="first-line">
        <ShieldCheckIcon aria-hidden />
        <AlertTitle>{status.label}</AlertTitle>
        <AlertDescription>
          {changed
            ? "Its files changed since you approved them. It stays stopped until you approve this version."
            : "Nothing from this plugin runs until you choose what it may do."}
        </AlertDescription>
        <AlertAction>
          {actionButton("Review", <ShieldCheckIcon aria-hidden />, review, props.canManage)}
        </AlertAction>
      </Alert>
    );
  }
  if (installation.pendingUpdate) {
    const revision = pluginReviewSubject(installation).revision;
    return (
      <Alert variant="info" controlAlignment="first-line">
        <InfoIcon aria-hidden />
        <AlertTitle>
          {revision === "update"
            ? `Update ${installation.pendingUpdate.manifest.version} available`
            : revision === "local-repair"
              ? "Local fix ready for review"
              : `Version ${installation.pendingUpdate.manifest.version} ready for review`}
        </AlertTitle>
        <AlertDescription>{pluginCurrentRevisionNote(installation)}</AlertDescription>
        <AlertAction>
          {actionButton(
            REVIEW_LABELS[revision],
            <ShieldCheckIcon aria-hidden />,
            review,
            props.canManage,
          )}
        </AlertAction>
      </Alert>
    );
  }
  if (attention === null) return null;
  const primary =
    status.primary === "resume"
      ? actionButton("Restart", <RotateCcwIcon aria-hidden />, props.onResume, props.canManage)
      : attention.kind === "events-paused" && installation.enabled && !props.executionDisabled
        ? actionButton(
            "Resume events",
            <RotateCcwIcon aria-hidden />,
            props.onResume,
            props.canManage,
          )
        : isPluginUnavailable(installation) && recovery.repair !== null
          ? actionButton(
              "Repair with agent",
              <BotIcon aria-hidden />,
              props.onRepair,
              props.canRepair,
            )
          : null;
  return (
    <Alert
      variant={attention.kind === "events-paused" ? "warning" : "error"}
      controlAlignment="first-line"
    >
      <TriangleAlertIcon aria-hidden />
      <AlertTitle>{attention.title}</AlertTitle>
      <AlertDescription>
        <ExpandableText text={attention.message} />
      </AlertDescription>
      <AlertAction>
        {primary}
        {actionButton("View details", <InfoIcon aria-hidden />, details)}
      </AlertAction>
    </Alert>
  );
}

function PluginViews(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly executionDisabled: boolean;
}) {
  const { environmentId, installation } = props;
  const { manifest } = installation;
  const applyIntents = usePluginIntentApplier();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { startPage, setStartPage } = usePluginStartPage();
  const active = isPluginActive(installation) && !props.executionDisabled;
  const uiGranted = installation.grants.capabilities.includes("ui");
  const blocked = props.executionDisabled
    ? "Plugin code is turned off on this environment, so its views cannot open."
    : !active
      ? (pluginInactiveReason(installation) ?? "The plugin is not running.")
      : !uiGranted
        ? "Showing views is not allowed. Change this in Permissions."
        : null;
  const target = {
    environmentId,
    installation,
    threadRef: null,
    composerTarget: null,
    locationKey: pathname,
  };
  return (
    <SettingsSection title="Views">
      {blocked ? <SettingsRow title={blocked} /> : null}
      {manifest.views.map((view) => (
        <SettingsRow
          key={`view:${view.id}`}
          title={view.title}
          description={
            view.placement === "page"
              ? "Page"
              : view.placement === "conversation"
                ? "Card in chat. It appears in a conversation when an agent uses it."
                : "Side panel beside a thread"
          }
          control={
            view.placement === "conversation" ? null : (
              <div className="flex items-center gap-2">
                {view.placement === "page" ? (
                  <PluginStartPageToggle
                    viewTitle={view.title}
                    chosen={
                      startPage?.environmentId === environmentId &&
                      startPage.pluginId === manifest.id &&
                      startPage.viewId === view.id
                    }
                    onChange={(chosen) =>
                      setStartPage(
                        chosen ? { environmentId, pluginId: manifest.id, viewId: view.id } : null,
                      )
                    }
                  />
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked !== null}
                  aria-label={`Open ${view.title}`}
                  onClick={() => applyIntents(target, [{ type: "view.open", viewId: view.id }])}
                >
                  <SquareArrowOutUpRightIcon aria-hidden />
                  Open
                </Button>
              </div>
            )
          }
        />
      ))}
      {(manifest.sidebarViews ?? []).map((view) => (
        <SettingsRow
          key={`sidebar:${view.id}`}
          title={view.title}
          description="Sidebar layout. Not selected on install; choose it from the sidebar's view control or the command palette."
        />
      ))}
    </SettingsSection>
  );
}

/** This device opens the page when the app starts; it falls back at once if the page can't open. */
function PluginStartPageToggle(props: {
  readonly viewTitle: string;
  readonly chosen: boolean;
  readonly onChange: (chosen: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={props.chosen}
            aria-label={
              props.chosen
                ? `Stop starting on ${props.viewTitle}`
                : `Start on ${props.viewTitle} on this device`
            }
            onClick={() => props.onChange(!props.chosen)}
          />
        }
      >
        <HouseIcon aria-hidden />
        {props.chosen ? "Start page" : "Start here"}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {props.chosen
          ? "This device opens this page when T3 Code starts"
          : "Open this page when T3 Code starts on this device"}
      </TooltipPopup>
    </Tooltip>
  );
}

function PluginPermissions(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly canManage: boolean;
  readonly onReview: () => void;
}) {
  const { installation } = props;
  const { manifest, grants } = installation;
  const granted = describePluginCapabilities(manifest).filter(
    (entry) => entry.known && grants.capabilities.includes(entry.capability),
  );
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === props.environmentId && grants.projectIds.includes(project.id),
  );
  return (
    <SettingsSection title="Permissions">
      <SettingsRow
        title={granted.length === 0 ? "No permissions granted" : "Allowed to"}
        description={
          granted.length === 0 ? undefined : granted.map((entry) => entry.title).join(" · ")
        }
        control={
          <Button size="sm" variant="outline" disabled={!props.canManage} onClick={props.onReview}>
            <ShieldCheckIcon aria-hidden />
            Review permissions
          </Button>
        }
      />
      {pluginNeedsProjects(manifest) ? (
        <SettingsRow
          title="Projects"
          description={
            projects.length === 0
              ? "No projects chosen. Thread and background permissions apply only to the projects you pick."
              : projects.map((project) => project.title).join(", ")
          }
        />
      ) : null}
    </SettingsSection>
  );
}

/**
 * Edits apply only on Save, and only the values the user changed. While nothing is edited the
 * form follows the environment, so another device's change shows up instead of a stale value.
 */
function PluginSettingsForm(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly canManage: boolean;
  readonly onDirtyChange: (
    installationId: string,
    digest: string,
    formId: string,
    dirty: boolean,
  ) => void;
}) {
  const { installation, onDirtyChange } = props;
  const { installationId } = installation;
  const { manifest } = installation;
  const idPrefix = useId();
  // The values the draft was taken from; a save diffs against these.
  const [base, setBase] = useState(() => installation.settings);
  const [seen, setSeen] = useState(() => installation.settings);
  const [draft, setDraft] = useState<PluginSettingDraft>(() => pluginSettingsDraft(installation));
  const [clearedSecrets, setClearedSecrets] = useState<ReadonlySet<string>>(() => new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const update = useAtomCommand(pluginEnvironment.updateSettings, { reportFailure: false });
  const patch = buildPluginSettingsPatch(manifest.settings, base, draft, clearedSecrets);
  const dirty = !patch.ok || Object.keys(patch.values).length > 0;
  const adopt = (from: PluginInstallation) => {
    setBase(from.settings);
    setDraft(pluginSettingsDraft(from));
    setClearedSecrets(new Set());
    setErrors({});
  };
  if (installation.settings !== seen) {
    setSeen(installation.settings);
    if (!dirty && !saving) adopt(installation);
  }
  const change = (next: PluginSettingDraft, cleared: ReadonlySet<string>) => {
    setDraft(next);
    setClearedSecrets(cleared);
    const patch = buildPluginSettingsPatch(manifest.settings, base, next, cleared);
    onDirtyChange(
      installationId,
      installation.digest,
      idPrefix,
      !patch.ok || Object.keys(patch.values).length > 0,
    );
  };

  const save = async () => {
    if (!patch.ok) {
      setErrors(patch.errors);
      return;
    }
    if (Object.keys(patch.values).length === 0) return;
    setSaving(true);
    const result = await update({
      environmentId: props.environmentId,
      input: { installationId: installation.installationId, values: patch.values },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      reportFailure(`Could not save ${manifest.name} settings`, result);
      return;
    }
    adopt(result.value);
    onDirtyChange(installationId, installation.digest, idPrefix, false);
  };
  const disabled = saving || !props.canManage;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <SettingsSection
        title="Settings"
        headerAction={
          <span className="text-xs text-muted-foreground">Stored on this environment</span>
        }
      >
        {manifest.settings.map((setting) => {
          const id = `${idPrefix}-${setting.key}`;
          const value = draft[setting.key];
          const error = errors[setting.key];
          const set = (next: string | boolean) => {
            change({ ...draft, [setting.key]: next }, clearedSecrets);
            setErrors((current) => {
              const remaining = { ...current };
              delete remaining[setting.key];
              return remaining;
            });
          };
          if (setting.type === "boolean") {
            return (
              <SettingsRow
                key={setting.key}
                title={<span id={`${id}-label`}>{setting.label}</span>}
                description={
                  setting.description ? (
                    <span id={`${id}-description`}>{setting.description}</span>
                  ) : undefined
                }
                control={
                  // The switch is a span, which a label cannot name, so it names itself.
                  <Switch
                    id={id}
                    aria-labelledby={`${id}-label`}
                    aria-describedby={setting.description ? `${id}-description` : undefined}
                    disabled={disabled}
                    checked={value === true}
                    onCheckedChange={(checked) => set(checked)}
                  />
                }
              />
            );
          }
          if (setting.type === "secret") {
            const cleared = clearedSecrets.has(setting.key);
            return (
              <SettingsRow
                key={setting.key}
                title={<Label htmlFor={id}>{setting.label}</Label>}
                description={
                  cleared
                    ? "The stored value will be deleted when you save."
                    : (setting.description ?? "Leave empty to keep the stored value.")
                }
                control={
                  <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-72">
                    <SecretInput
                      id={id}
                      size="sm"
                      className="min-w-0 flex-1"
                      disabled={disabled}
                      placeholder="Enter a new value to replace it"
                      value={typeof value === "string" ? value : ""}
                      onChange={(event) => {
                        const cleared = new Set(clearedSecrets);
                        cleared.delete(setting.key);
                        change({ ...draft, [setting.key]: event.target.value }, cleared);
                      }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      disabled={disabled || cleared}
                      onClick={() => {
                        change(
                          { ...draft, [setting.key]: "" },
                          new Set(clearedSecrets).add(setting.key),
                        );
                      }}
                    >
                      Clear
                    </Button>
                  </div>
                }
              />
            );
          }
          return (
            <SettingsRow
              key={setting.key}
              title={<Label htmlFor={id}>{setting.label}</Label>}
              description={setting.description}
              status={
                error ? (
                  <span className="text-destructive-foreground" role="alert">
                    {error}
                  </span>
                ) : undefined
              }
              control={
                <Input
                  id={id}
                  size="sm"
                  className="w-full @min-[32rem]/settings-row:w-72"
                  disabled={disabled}
                  aria-invalid={error ? true : undefined}
                  inputMode={setting.type === "number" ? "decimal" : undefined}
                  value={typeof value === "string" ? value : ""}
                  onChange={(event) => set(event.target.value)}
                />
              }
            />
          );
        })}
        <div className="flex items-center justify-end gap-2 px-3 py-3 sm:px-4">
          {dirty ? (
            <span className="me-auto text-xs text-muted-foreground" role="status">
              Unsaved changes
            </span>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            type="button"
            disabled={!dirty || saving}
            onClick={() => {
              adopt(installation);
              onDirtyChange(installationId, installation.digest, idPrefix, false);
            }}
          >
            Revert
          </Button>
          <Button size="sm" type="submit" disabled={!dirty || disabled}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </SettingsSection>
    </form>
  );
}

/** Details and the previous-version warning read the live record, so a push updates them. */
function PluginRecoveryDialog(props: {
  readonly kind: "details" | "use-previous";
  readonly environmentId: EnvironmentId;
  readonly installationId: string;
  readonly onDialog: (dialog: PluginDialog | null) => void;
}) {
  const { environmentId, installationId } = props;
  const catalogue = usePluginCatalogue(environmentId);
  const installation = catalogue.installations.find(
    (entry) => entry.installationId === installationId,
  );
  const stagePrevious = useAtomCommand(pluginEnvironment.stagePrevious, { reportFailure: false });
  const close = () => props.onDialog(null);
  if (installation === undefined) return null;
  if (props.kind === "details") {
    return <PluginDetailsDialog installation={installation} onClose={close} />;
  }
  const previous = installation.recovery?.previous;
  if (previous === undefined) return null;
  return (
    <UsePreviousPluginDialog
      installation={installation}
      previousVersion={previous.version}
      onClose={close}
      onConfirm={async () => {
        const result = await stagePrevious({
          environmentId,
          input: { installationId, expectedDigest: previous.digest, acknowledgeCurrentData: true },
        });
        if (result._tag === "Failure") {
          reportFailure(
            `Could not prepare ${installation.manifest.name} v${previous.version}`,
            result,
          );
          return;
        }
        props.onDialog({ kind: "review", installationId });
      }}
    />
  );
}

function Field(props: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.htmlFor}>{props.label}</Label>
      {props.children}
      {props.error ? (
        <p className="text-xs text-destructive-foreground" role="alert">
          {props.error}
        </p>
      ) : props.hint ? (
        <p className="text-xs text-muted-foreground">{props.hint}</p>
      ) : null}
    </div>
  );
}

/** Installs on the environment the page shows; the Settings scope is where to pick another. */
function InstallPluginDialog(props: {
  readonly environment: EnvironmentPresentation;
  readonly onClose: () => void;
  readonly onInstalled: (installation: PluginInstallation) => void;
}) {
  const { environmentId, label } = props.environment;
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const install = useAtomCommand(pluginEnvironment.install, { reportFailure: false });
  const canInstall = useAtomValue(pluginEnvironment.install.permissionAtom(environmentId));
  const catalogue = usePluginCatalogue(environmentId);
  const submit = async () => {
    const parsed = parsePluginSourceInput(source);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setInstalling(true);
    setError(null);
    const result = await install({ environmentId, input: { source: parsed.source } });
    setInstalling(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(pluginFailureMessage(squashAtomCommandFailure(result)));
      }
      return;
    }
    props.onInstalled(result.value);
  };
  const unavailable =
    catalogue.availability === "unsupported"
      ? "This environment's T3 Code server does not support plugins."
      : catalogue.availability === "client-outdated"
        ? "This environment uses a newer plugin version. Update T3 Code on this device to install plugins there."
        : catalogue.availability === "disconnected"
          ? "This environment is not connected."
          : !canInstall
            ? "This connection cannot install plugins. Installing needs access and terminal permissions."
            : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !installing) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Install plugin on {label}</DialogTitle>
            <DialogDescription>
              T3 Code copies the plugin to {label} and reads its manifest. Nothing runs until you
              review and enable it.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              <Field
                label="Source"
                htmlFor="plugin-install-source"
                hint={`A folder on ${label}, or an https Git URL. Add #tag or #commit to pin a version.`}
                error={error ?? undefined}
              >
                <Input
                  id="plugin-install-source"
                  autoFocus
                  spellCheck={false}
                  placeholder="/path/to/plugin or https://github.com/owner/plugin.git#v1.0.0"
                  value={source}
                  onChange={(event) => {
                    setSource(event.target.value);
                    setError(null);
                  }}
                />
              </Field>
              {unavailable ? (
                <p className="text-sm text-muted-foreground" role="status">
                  {unavailable}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" disabled={installing} />}>
              Cancel
            </DialogClose>
            <Button
              size="sm"
              type="submit"
              disabled={installing || source.trim() === "" || unavailable !== null}
            >
              {installing ? "Installing…" : "Install and review"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function ReviewPluginDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly installationId: string;
  readonly installed?: PluginInstallation | undefined;
  readonly onClose: () => void;
}) {
  const catalogue = usePluginCatalogue(props.environmentId);
  const listed = catalogue.installations.find(
    (entry) => entry.installationId === props.installationId,
  );
  // The install result stands in only until the catalogue first lists the plugin. After that, a
  // missing entry means it was removed, not that the push is late.
  const [installed, setInstalled] = useState(props.installed);
  if (listed !== undefined && installed !== undefined) setInstalled(undefined);
  const installation = listed ?? installed;
  const quickUpdate = installation ? pluginQuickUpdate(installation) : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className={quickUpdate ? "max-w-md" : "max-w-xl"}>
        {installation && quickUpdate ? (
          <UpdatePluginForm
            key={pluginReviewSubject(installation).digest}
            environmentId={props.environmentId}
            installation={installation}
            quickUpdate={quickUpdate}
            recoverySupported={catalogue.recoverySupported === true}
            onClose={props.onClose}
          />
        ) : installation ? (
          <ReviewPluginForm
            key={pluginReviewSubject(installation).digest}
            environmentId={props.environmentId}
            installation={installation}
            recoverySupported={catalogue.recoverySupported === true}
            onClose={props.onClose}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Review plugin</DialogTitle>
              <DialogDescription>
                {catalogue.loaded ? "This plugin is no longer installed." : "Loading plugin…"}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button size="sm" />}>Close</DialogClose>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

const REVIEW_TITLES: Record<PluginReviewRevision, string> = {
  install: "Review",
  update: "Update",
  "local-repair": "Use local fix for",
  previous: "Use previous version of",
};

const SETTING_CHANGE_LABELS = {
  added: "added",
  removed: "no longer used; its value stays with the previous version",
  "type-changed": "changes type; the stored value may reset",
} as const;

function reviewFooterLabels(revision: PluginReviewRevision, runningLocalFix: boolean) {
  switch (revision) {
    case "install":
      return { keep: "Not now", discard: "Discard", approve: "Approve and enable" };
    case "update":
      return runningLocalFix
        ? {
            keep: "Keep local fix",
            discard: "Discard update",
            approve: "Switch to publisher version",
          }
        : { keep: "Not now", discard: "Discard update", approve: "Update" };
    case "local-repair":
      return {
        keep: "Keep current version",
        discard: "Discard staged fix",
        approve: "Use local fix",
      };
    case "previous":
      return {
        keep: "Keep current version",
        discard: "Discard",
        approve: "Use previous version",
      };
  }
}

/** Saving a review's decision, shared by the full review and the one-click update. */
function usePluginApproval(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly recoverySupported: boolean;
  readonly onClose: () => void;
}) {
  const { environmentId, installation } = props;
  const subject = pluginReviewSubject(installation);
  const { manifest } = subject;
  const isUpdate = subject.kind === "update";
  const [saving, setSaving] = useState(false);
  const consent = useAtomCommand(pluginEnvironment.consent, { reportFailure: false });
  const setEnabled = useAtomCommand(pluginEnvironment.setEnabled, { reportFailure: false });
  const discard = useAtomCommand(pluginEnvironment.discardPendingUpdate, { reportFailure: false });
  const { resolveBacklog, backlogDialog } = usePluginEventBacklog();
  const canManage = useAtomValue(pluginEnvironment.consent.permissionAtom(environmentId));
  const discardUpdate = async () => {
    setSaving(true);
    const result = await discard({
      environmentId,
      input: { installationId: installation.installationId },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      reportFailure(`Could not discard the ${manifest.name} update`, result);
      return;
    }
    props.onClose();
  };
  const approve = async (grants: PluginGrants) => {
    setSaving(true);
    // Asked before anything is saved, so cancelling leaves the plugin as it was.
    const backlogStep = pluginApprovalBacklogStep(installation);
    const backlog =
      backlogStep === null
        ? ({ proceed: true } as const)
        : await resolveBacklog(environmentId, installation, props.recoverySupported);
    if (!backlog.proceed) {
      setSaving(false);
      return;
    }
    const eventBacklog = backlog.eventBacklog ? { eventBacklog: backlog.eventBacklog } : {};
    const consented = await consent({
      environmentId,
      input: {
        installationId: installation.installationId,
        digest: subject.digest,
        grants,
        ...(backlogStep === "consent" ? eventBacklog : {}),
      },
    });
    if (consented._tag === "Failure") {
      setSaving(false);
      reportFailure(`Could not approve ${manifest.name}`, consented);
      return;
    }
    // Approving an update keeps the plugin's enabled state; a first approval turns it on.
    if (!isUpdate && !consented.value.enabled) {
      const enabled = await setEnabled({
        environmentId,
        input: {
          installationId: installation.installationId,
          enabled: true,
          ...(backlogStep === "enable" ? eventBacklog : {}),
        },
      });
      setSaving(false);
      if (enabled._tag === "Failure") {
        reportFailure(`Approved, but could not enable ${manifest.name}`, enabled);
        return;
      }
    } else {
      setSaving(false);
    }
    props.onClose();
  };
  return { saving, canManage, approve, discardUpdate, backlogDialog };
}

function PluginIdentity(props: { readonly subject: ReturnType<typeof pluginReviewSubject> }) {
  const { subject } = props;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      <dt className="text-muted-foreground">Identifier</dt>
      <dd className="truncate font-mono text-xs leading-5">{subject.manifest.id}</dd>
      <dt className="text-muted-foreground">Source</dt>
      <dd className="truncate">{pluginSourceLabel(subject.source)}</dd>
      <dt className="text-muted-foreground">Fingerprint</dt>
      <dd className="break-all font-mono text-xs leading-5">{subject.digest}</dd>
    </dl>
  );
}

function PluginRevisionChanges(props: {
  readonly installation: PluginInstallation;
  readonly subject: ReturnType<typeof pluginReviewSubject>;
}) {
  const { subject } = props;
  if (subject.removedCapabilities.length === 0 && subject.settingChanges.length === 0) return null;
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-medium">Changes from v{props.installation.manifest.version}</h3>
      <ul className="space-y-0.5 text-sm text-muted-foreground">
        {subject.removedCapabilities.map((capability) => (
          <li key={`cap:${capability}`}>No longer asks for {capability}</li>
        ))}
        {subject.settingChanges.map((change) => (
          <li key={`setting:${change.key}`}>
            {change.label} setting {SETTING_CHANGE_LABELS[change.change]}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PluginContributions(props: { readonly manifest: PluginManifest }) {
  const { manifest } = props;
  if (
    manifest.actions.length === 0 &&
    manifest.views.length === 0 &&
    (manifest.sidebarViews ?? []).length === 0
  ) {
    return null;
  }
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-medium">Adds</h3>
      <ul className="space-y-0.5 text-sm text-muted-foreground">
        {manifest.actions.map((action) => (
          <li key={`a:${action.id}`}>
            {action.title}
            {action.agentCallable ? " (agents can call it)" : ""}
          </li>
        ))}
        {manifest.views.map((view) => (
          <li key={`v:${view.id}`}>{view.title} view</li>
        ))}
        {(manifest.sidebarViews ?? []).map((view) => (
          <li key={`s:${view.id}`}>{view.title} sidebar layout (off until you choose it)</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * An update to a plugin the user already approved: one button, naming only what it adds. Grants
 * and projects carry over, and Not now keeps the running version, so nothing widens unseen.
 */
function UpdatePluginForm(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly quickUpdate: PluginQuickUpdate;
  readonly recoverySupported: boolean;
  readonly onClose: () => void;
}) {
  const { environmentId, installation, quickUpdate } = props;
  const subject = pluginReviewSubject(installation);
  const { manifest } = subject;
  const { added, offered } = quickUpdate;
  const idPrefix = useId();
  const runningLocalFix = installation.recovery?.activeSource === "local-repair";
  const labels = reviewFooterLabels(subject.revision, runningLocalFix);
  const projectTitles = useProjects()
    .filter(
      (project) =>
        project.environmentId === environmentId &&
        quickUpdate.grants.projectIds.includes(project.id),
    )
    .map((project) => project.title);
  const projects = pluginUpdateProjects(quickUpdate.grants.projectIds, projectTitles);
  const [allowed, setAllowed] = useState<ReadonlyArray<PluginCapability>>([]);
  const { saving, canManage, approve, discardUpdate, backlogDialog } = usePluginApproval(props);
  const capabilities = [
    ...quickUpdate.grants.capabilities,
    ...offered.map((entry) => entry.capability).filter((entry) => allowed.includes(entry)),
  ];
  const note = (entry: PluginQuickUpdate["added"][number]) =>
    entry.projectScoped ? pluginUpdateScopeNote(projects) : entry.detail;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Update {manifest.name}</DialogTitle>
        <DialogDescription>
          v{installation.manifest.version} → v{manifest.version}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-4">
          {added.length === 0 ? (
            <p className="text-sm">
              {offered.length === 0 ? "Nothing new to approve. " : ""}It keeps the access it has
              now.
            </p>
          ) : (
            <section className="space-y-2">
              <h3 className="text-sm">This update can also:</h3>
              <ul className="space-y-2">
                {added.map((entry) => (
                  <li key={entry.capability} className="flex items-start gap-2.5 text-sm">
                    <PlusIcon
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0">
                      {entry.title}
                      <span className="block text-xs text-muted-foreground">{note(entry)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {offered.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-sm">You can also allow:</h3>
              <ul className="space-y-2">
                {offered.map((entry) => (
                  <li key={entry.capability}>
                    <label className="flex items-start justify-between gap-3 text-sm">
                      <span className="min-w-0">
                        <span id={`${idPrefix}-offer-${entry.capability}`}>{entry.title}</span>
                        <span className="block text-xs text-muted-foreground">{note(entry)}</span>
                      </span>
                      <Switch
                        aria-labelledby={`${idPrefix}-offer-${entry.capability}`}
                        checked={allowed.includes(entry.capability)}
                        disabled={saving}
                        onCheckedChange={(checked) =>
                          setAllowed((current) =>
                            checked
                              ? [...current, entry.capability]
                              : current.filter((capability) => capability !== entry.capability),
                          )
                        }
                      />
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <PluginRevisionChanges installation={installation} subject={subject} />
          {runningLocalFix ? (
            <p className="text-xs text-muted-foreground">
              This is the publisher&apos;s version {manifest.version}.{" "}
              {pluginCurrentRevisionNote(installation)} After switching, your local fix stays
              available as the previous version.
            </p>
          ) : added.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Everything else stays the same. {pluginCurrentRevisionNote(installation)}
            </p>
          ) : null}
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronRightIcon
                aria-hidden
                className="size-3.5 transition-transform group-data-panel-open:rotate-90"
              />
              Details
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="space-y-4 pt-3">
                <PluginIdentity subject={subject} />
                <section className="space-y-1">
                  <h3 className="text-sm font-medium">Allowed after updating</h3>
                  <p className="text-sm text-muted-foreground">
                    {capabilities.length === 0
                      ? "No permissions."
                      : describePluginCapabilities(manifest)
                          .filter((entry) => entry.known && capabilities.includes(entry.capability))
                          .map((entry) => entry.title)
                          .join(" · ")}
                  </p>
                </section>
                {pluginNeedsProjects(manifest) ? (
                  <section className="space-y-1">
                    <h3 className="text-sm font-medium">Projects</h3>
                    <p className="text-sm text-muted-foreground">
                      {projects ?? "No projects chosen."}
                    </p>
                  </section>
                ) : null}
                <PluginContributions manifest={manifest} />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving || !canManage}
                  onClick={() => void discardUpdate()}
                >
                  {labels.discard}
                </Button>
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" size="sm" disabled={saving} />}>
          {labels.keep}
        </DialogClose>
        <Button
          size="sm"
          disabled={saving || !canManage}
          onClick={() => void approve({ capabilities, projectIds: quickUpdate.grants.projectIds })}
        >
          {saving ? "Saving…" : labels.approve}
        </Button>
      </DialogFooter>
      {backlogDialog}
    </>
  );
}

function ReviewPluginForm(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly recoverySupported: boolean;
  readonly onClose: () => void;
}) {
  const { environmentId, installation } = props;
  const subject = pluginReviewSubject(installation);
  const { manifest } = subject;
  const idPrefix = useId();
  const isUpdate = subject.kind === "update";
  const capabilities = describePluginCapabilities(manifest);
  const runningLocalFix = installation.recovery?.activeSource === "local-repair";
  const currentRevisionNote = pluginCurrentRevisionNote(installation);
  const unsupported = capabilities
    .filter((entry) => !entry.known && !entry.optional)
    .map((entry) => entry.capability);
  const labels = reviewFooterLabels(subject.revision, runningLocalFix);
  // The running version's availability says nothing about a staged update.
  const incompatible =
    (!isUpdate && isPluginUnavailable(installation)) || pluginHasUnsupportedRequirement(manifest);
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );
  const [grants, setGrants] = useState(() => initialPluginGrants(installation));
  const { saving, canManage, approve, discardUpdate, backlogDialog } = usePluginApproval(props);
  const changed =
    !isUpdate &&
    installation.consentedDigest !== null &&
    installation.consentedDigest !== installation.digest;
  const projectScopedGranted = capabilities.some(
    (entry) => entry.known && entry.projectScoped && grants.capabilities.includes(entry.capability),
  );
  const toggleCapability = (capability: PluginCapability, granted: boolean) =>
    setGrants((current) => ({
      ...current,
      capabilities: granted
        ? [...current.capabilities, capability]
        : current.capabilities.filter((entry) => entry !== capability),
    }));
  const toggleProject = (projectId: ProjectId, granted: boolean) =>
    setGrants((current) => ({
      ...current,
      projectIds: granted
        ? [...current.projectIds, projectId]
        : current.projectIds.filter((entry) => entry !== projectId),
    }));
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {REVIEW_TITLES[subject.revision]} {manifest.name}{" "}
          <span className="font-normal text-muted-foreground">v{manifest.version}</span>
        </DialogTitle>
        <DialogDescription>
          {manifest.description ?? "Choose what this plugin may do before any of its code runs."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-5">
          {subject.revision === "update" ? (
            <Alert variant="info" controlAlignment="first-line">
              <InfoIcon aria-hidden />
              <AlertDescription>
                {runningLocalFix
                  ? `This is the publisher's version ${manifest.version}. ${currentRevisionNote} After switching, your local fix stays available as the previous version.`
                  : `${currentRevisionNote} Keeping the current version leaves the update waiting.`}
              </AlertDescription>
            </Alert>
          ) : null}
          {subject.revision === "local-repair" ? (
            <Alert variant="info" controlAlignment="first-line">
              <InfoIcon aria-hidden />
              <AlertDescription>
                These files come from your repair folder. {currentRevisionNote} Settings, data and
                event position carry over, and T3 Code keeps tracking the publisher&apos;s source so
                you can switch back later.
              </AlertDescription>
            </Alert>
          ) : null}
          {subject.revision === "previous" ? (
            <Alert variant="warning" controlAlignment="first-line">
              <TriangleAlertIcon aria-hidden />
              <AlertDescription>
                Version {manifest.version} uses your current settings and data, not the data it had
                before. T3 Code can&apos;t undo what version {installation.manifest.version}{" "}
                changed, inside or outside T3 Code.
              </AlertDescription>
            </Alert>
          ) : null}
          {changed ? (
            <Alert variant="warning" controlAlignment="first-line">
              <TriangleAlertIcon aria-hidden />
              <AlertDescription>
                The plugin&apos;s files changed since you approved them. It stays stopped until you
                approve this version.
              </AlertDescription>
            </Alert>
          ) : null}
          <PluginIdentity subject={subject} />
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Permissions</h3>
            {capabilities.length === 0 ? (
              <p className="text-sm text-muted-foreground">This plugin asks for no permissions.</p>
            ) : (
              <ul className="space-y-2">
                {capabilities.map((entry) => (
                  <li key={entry.capability}>
                    {/* The checkbox is a span, which a label cannot name, so it names itself. */}
                    <label className="flex items-start gap-2.5">
                      <Checkbox
                        className="mt-0.5"
                        aria-labelledby={`${idPrefix}-grant-${entry.capability}`}
                        aria-describedby={`${idPrefix}-grant-${entry.capability}-detail`}
                        disabled={!entry.known || saving}
                        checked={entry.known && grants.capabilities.includes(entry.capability)}
                        onCheckedChange={(checked) => {
                          if (entry.known) toggleCapability(entry.capability, checked === true);
                        }}
                      />
                      <span className="min-w-0 text-sm">
                        <span
                          id={`${idPrefix}-grant-${entry.capability}`}
                          className={entry.known ? "" : "text-destructive-foreground"}
                        >
                          {entry.title}
                        </span>
                        {subject.newCapabilities.includes(entry.capability) ? (
                          <Badge variant="info" className="ms-2">
                            New
                          </Badge>
                        ) : null}
                        {entry.optional ? (
                          <Badge variant="outline" className="ms-2">
                            Optional
                          </Badge>
                        ) : null}
                        <span
                          id={`${idPrefix}-grant-${entry.capability}-detail`}
                          className="block text-xs text-muted-foreground"
                        >
                          {entry.detail}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <PluginRevisionChanges installation={installation} subject={subject} />
          {pluginNeedsProjects(manifest) ? (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Projects</h3>
              <p className="text-xs text-muted-foreground">
                Thread and background permissions apply only to the projects you pick.
              </p>
              {projects.length === 0 ? (
                <p className="text-sm text-muted-foreground">No projects on this environment.</p>
              ) : (
                <ul className="max-h-48 space-y-1.5 overflow-y-auto">
                  {projects.map((project) => (
                    <li key={project.id}>
                      <label className="flex items-center gap-2.5">
                        <Checkbox
                          aria-labelledby={`${idPrefix}-project-${project.id}`}
                          aria-describedby={`${idPrefix}-project-${project.id}-path`}
                          disabled={!projectScopedGranted || saving}
                          checked={grants.projectIds.includes(project.id)}
                          onCheckedChange={(checked) => toggleProject(project.id, checked === true)}
                        />
                        <span className="min-w-0 text-sm">
                          <span id={`${idPrefix}-project-${project.id}`} className="block truncate">
                            {project.title}
                          </span>
                          <span
                            id={`${idPrefix}-project-${project.id}-path`}
                            className="block truncate text-xs text-muted-foreground"
                          >
                            {project.workspaceRoot}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
          <PluginContributions manifest={manifest} />
          {incompatible ? (
            <p className="text-sm text-destructive-foreground" role="alert">
              {unsupported.length > 0
                ? `Needs ${unsupported.join(", ")}, which this environment does not support, so it cannot be enabled.`
                : (installation.error ??
                  "This plugin needs permissions this environment does not support, so it cannot be enabled.")}
            </p>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" size="sm" disabled={saving} />}>
          {isUpdate ? labels.keep : incompatible ? "Close" : "Not now"}
        </DialogClose>
        {isUpdate ? (
          <Button
            size="sm"
            variant="outline"
            disabled={saving || !canManage}
            onClick={() => void discardUpdate()}
          >
            {labels.discard}
          </Button>
        ) : null}
        {incompatible ? null : (
          <Button size="sm" disabled={saving || !canManage} onClick={() => void approve(grants)}>
            {saving ? "Saving…" : labels.approve}
          </Button>
        )}
      </DialogFooter>
      {backlogDialog}
    </>
  );
}

function RemovePluginDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}) {
  const { installation } = props;
  const [deleteData, setDeleteData] = useState(false);
  const [removing, setRemoving] = useState(false);
  const remove = useAtomCommand(pluginEnvironment.remove, { reportFailure: false });
  const confirm = async () => {
    setRemoving(true);
    const result = await remove({
      environmentId: props.environmentId,
      input: { installationId: installation.installationId, ...(deleteData ? { deleteData } : {}) },
    });
    setRemoving(false);
    if (result._tag === "Failure") {
      reportFailure(`Could not remove ${installation.manifest.name}`, result);
      return;
    }
    props.onRemoved();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !removing) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {installation.manifest.name}?</DialogTitle>
          <DialogDescription>
            The plugin stops and its files are removed from this environment. Its settings and
            stored data are kept unless you delete them, so reinstalling picks up where it left off.{" "}
            {pluginRemovalNote(installation)}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="flex items-center gap-2.5 text-sm">
            <Checkbox
              aria-labelledby="plugin-remove-data-label"
              checked={deleteData}
              onCheckedChange={(checked) => setDeleteData(checked === true)}
            />
            <span id="plugin-remove-data-label">Also delete its settings and stored data</span>
          </label>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" disabled={removing} />}>
            Cancel
          </DialogClose>
          <Button
            size="sm"
            variant="destructive"
            disabled={removing}
            onClick={() => void confirm()}
          >
            {removing ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
