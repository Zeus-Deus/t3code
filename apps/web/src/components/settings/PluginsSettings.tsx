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
  pluginNeedsProjects,
  pluginRecoveryActions,
  pluginRemovalNote,
  pluginReviewSubject,
  pluginSettingsDraft,
  pluginSourceLabel,
  pluginStatusPresentation,
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
  EnvironmentId,
  resolveEnvironmentMachineKind,
  type PluginAction,
  type PluginCapability,
  type PluginInstallation,
  type ProjectId,
} from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import {
  BotIcon,
  FileSearchIcon,
  HistoryIcon,
  HouseIcon,
  InfoIcon,
  MoreHorizontalIcon,
  PlayIcon,
  PlusIcon,
  PuzzleIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { useProjects } from "../../state/entities";
import type { EnvironmentPresentation } from "../../state/environments";
import { pluginEnvironment, usePluginCatalogue } from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { PluginDetailsDialog, UsePreviousPluginDialog } from "../plugins/PluginRecoveryDialogs";
import {
  pluginFailureMessage,
  usePluginActionRunner,
  usePluginIntentApplier,
} from "../plugins/usePluginActions";
import { usePluginEventBacklog } from "../plugins/usePluginEventBacklog";
import { usePluginStartPage } from "../plugins/pluginStartPage";
import { usePluginRepair } from "../plugins/usePluginRepair";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Checkbox } from "../ui/checkbox";
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
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SecretInput } from "./SecretInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type PluginDialog =
  | { readonly kind: "install"; readonly environmentId: EnvironmentId }
  | {
      readonly kind: "review";
      readonly environmentId: EnvironmentId;
      readonly installationId: string;
      /** The install result, shown until the catalogue push includes it. */
      readonly installed?: PluginInstallation;
    }
  | {
      readonly kind: "settings";
      readonly environmentId: EnvironmentId;
      readonly installationId: string;
    }
  | {
      readonly kind: "remove";
      readonly environmentId: EnvironmentId;
      readonly installation: PluginInstallation;
    }
  | {
      readonly kind: "details" | "use-previous";
      readonly environmentId: EnvironmentId;
      readonly installationId: string;
    };

const TONE_BADGE: Record<PluginStatusTone, "success" | "warning" | "error" | "outline"> = {
  success: "success",
  warning: "warning",
  error: "error",
  muted: "outline",
};

const PLACEMENT_LABELS: Record<PluginAction["placements"][number], string> = {
  palette: "Command palette",
  "thread-menu": "Thread menu",
  "message-selection": "Text selection",
};

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastManager.add({
    type: "error",
    title,
    description: pluginFailureMessage(squashAtomCommandFailure(result)),
  });
}

/** The first of these environments (keyed by comma-joined ids) this connection may install on. */
const installableEnvironmentAtom = Atom.family((environmentIds: string) =>
  Atom.make(
    (get) =>
      environmentIds
        .split(",")
        .filter(Boolean)
        .map((id) => EnvironmentId.make(id))
        .find((id) => get(pluginEnvironment.install.permissionAtom(id))) ?? null,
  ),
);

export function PluginsSettings() {
  const { scope, environments, connectedEnvironments, environment } = useSettingsScope();
  const [dialog, setDialog] = useState<PluginDialog | null>(null);
  // Permission is scope-based, so an environment without this client's plugin API can grant it.
  const candidates = (environment ? [environment] : connectedEnvironments).filter((entry) =>
    environmentSupportsPlugins(entry.serverConfig?.environment.capabilities),
  );
  const installTarget = useAtomValue(
    installableEnvironmentAtom(candidates.map((entry) => entry.environmentId).join(",")),
  );
  return (
    <SettingsPageContainer>
      <SettingsSection
        id="plugins"
        title="Plugins"
        variant="plain"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={installTarget === null}
            onClick={() =>
              installTarget && setDialog({ kind: "install", environmentId: installTarget })
            }
          >
            <PlusIcon className="size-3" />
            Install plugin
          </Button>
        }
      >
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          Plugins run as separate processes on the environment you install them on, with that
          machine user&apos;s access. T3 Code does not sandbox plugin code; install plugins you
          trust.
        </p>
        {scope.kind === "unavailable" ? (
          <SettingsRow title={scope.message} />
        ) : environments.length === 0 ? (
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
          <div className="space-y-8">
            {environments.map((entry) => (
              <PluginEnvironmentSection
                key={entry.environmentId}
                environment={entry}
                showHeading={environments.length > 1}
                onDialog={setDialog}
              />
            ))}
          </div>
        )}
      </SettingsSection>
      {dialog?.kind === "install" ? (
        <InstallPluginDialog
          initialEnvironmentId={dialog.environmentId}
          onClose={() => setDialog(null)}
          onInstalled={(environmentId, installation) =>
            setDialog({
              kind: "review",
              environmentId,
              installationId: installation.installationId,
              installed: installation,
            })
          }
        />
      ) : null}
      {dialog?.kind === "review" ? (
        <ReviewPluginDialog
          key={`${dialog.environmentId}:${dialog.installationId}`}
          environmentId={dialog.environmentId}
          installationId={dialog.installationId}
          installed={dialog.installed}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "settings" ? (
        <PluginSettingsDialog
          environmentId={dialog.environmentId}
          installationId={dialog.installationId}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "remove" ? (
        <RemovePluginDialog
          environmentId={dialog.environmentId}
          installation={dialog.installation}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "details" || dialog?.kind === "use-previous" ? (
        <PluginRecoveryDialog
          kind={dialog.kind}
          environmentId={dialog.environmentId}
          installationId={dialog.installationId}
          onDialog={setDialog}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function PluginEnvironmentSection(props: {
  readonly environment: EnvironmentPresentation;
  readonly showHeading: boolean;
  readonly onDialog: (dialog: PluginDialog) => void;
}) {
  const { environment } = props;
  const catalogue = usePluginCatalogue(environment.environmentId);
  const body = (() => {
    switch (catalogue.availability) {
      case "unknown":
      case "disconnected":
        return (
          <SettingsRow
            title="Environment disconnected"
            description={`Reconnect ${environment.label} to manage its plugins.`}
          />
        );
      case "unsupported":
        return (
          <SettingsRow
            title="Plugins unavailable"
            description={`Update the T3 Code server on ${environment.label} to use plugins.`}
          />
        );
      case "client-outdated":
        return (
          <SettingsRow
            title="Plugins unavailable"
            description={`${environment.label} uses a newer plugin version. Update T3 Code on this device to manage its plugins.`}
          />
        );
      case "forbidden":
        return (
          <SettingsRow
            title="No access"
            description="This connection cannot read the environment's plugins."
          />
        );
      case "available":
        if (catalogue.error !== null) {
          return <SettingsRow title="Could not load plugins" description={catalogue.error} />;
        }
        if (!catalogue.loaded) return <SettingsRow title="Loading plugins…" role="status" />;
        return (
          <>
            {catalogue.unavailableMessage ? (
              <Alert variant="error" controlAlignment="first-line">
                <TriangleAlertIcon aria-hidden />
                <AlertDescription>
                  Plugins on {environment.label} are off: {catalogue.unavailableMessage} Your
                  plugins and their data were left untouched.
                </AlertDescription>
              </Alert>
            ) : null}
            {catalogue.executionDisabled === true ? (
              <Alert variant="warning" controlAlignment="first-line">
                <TriangleAlertIcon aria-hidden />
                <AlertDescription>
                  Plugin code is turned off on {environment.label}. Nothing runs until T3 Code
                  starts with plugins on, but you can still review, disable, or remove plugins here.
                </AlertDescription>
              </Alert>
            ) : null}
            {catalogue.installations.length === 0 ? (
              !catalogue.unavailableMessage ? (
                <SettingsRow
                  title="No plugins installed"
                  description="Install one from a folder on this environment or an https Git repository."
                />
              ) : null
            ) : (
              catalogue.installations.map((installation) => (
                <PluginRow
                  key={installation.installationId}
                  environmentId={environment.environmentId}
                  installation={installation}
                  recoverySupported={catalogue.recoverySupported === true}
                  executionDisabled={catalogue.executionDisabled === true}
                  onDialog={props.onDialog}
                />
              ))
            )}
          </>
        );
    }
  })();
  return (
    <SettingsSection
      title={environment.label}
      hideTitle={!props.showHeading}
      icon={
        <EnvironmentMachineIcon
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-3.5"
        />
      }
    >
      {body}
    </SettingsSection>
  );
}

const REVIEW_LABELS: Record<PluginReviewRevision, string> = {
  install: "Review",
  update: "Review update",
  "local-repair": "Review local fix",
  previous: "Review previous version",
};

function PluginRow(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly recoverySupported: boolean;
  readonly executionDisabled: boolean;
  readonly onDialog: (dialog: PluginDialog) => void;
}) {
  const { environmentId, installation, recoverySupported, executionDisabled } = props;
  const { manifest } = installation;
  const status = pluginStatusPresentation(installation, { executionDisabled });
  const attention = pluginAttention(installation);
  const readOnly = isPluginRecordReadOnly(installation);
  const displayVersion = pluginDisplayVersion(installation);
  const unavailable = isPluginUnavailable(installation);
  const recovery = pluginRecoveryActions(installation, recoverySupported);
  const pendingRevision = installation.pendingUpdate
    ? pluginReviewSubject(installation).revision
    : null;
  const canManage = useAtomValue(pluginEnvironment.setEnabled.permissionAtom(environmentId));
  const canRepair = useAtomValue(pluginEnvironment.prepareRepair.permissionAtom(environmentId));
  const setEnabled = useAtomCommand(pluginEnvironment.setEnabled, { reportFailure: false });
  const refresh = useAtomCommand(pluginEnvironment.refresh, { reportFailure: false });
  const resume = useAtomCommand(pluginEnvironment.resume, { reportFailure: false });
  const stageRepair = useAtomCommand(pluginEnvironment.stageRepair, { reportFailure: false });
  const repair = usePluginRepair();
  const { resolveBacklog, backlogDialog } = usePluginEventBacklog();
  const [busy, setBusy] = useState(false);
  const target = { installationId: installation.installationId };
  const review = () =>
    props.onDialog({ kind: "review", environmentId, installationId: installation.installationId });
  const details = () =>
    props.onDialog({ kind: "details", environmentId, installationId: installation.installationId });
  // Promise#finally because React Compiler cannot compile a try/finally without a catch. The
  // executor turns a synchronous throw into a rejection; failures still reach the caller.
  const withBusy = (run: () => Promise<void>) => {
    setBusy(true);
    return new Promise<void>((resolve) => resolve(run())).finally(() => setBusy(false));
  };

  const toggle = (enabled: boolean) => {
    if (enabled && status.primary === "review") {
      review();
      return;
    }
    void withBusy(async () => {
      const backlog = enabled
        ? await resolveBacklog(environmentId, installation, recoverySupported)
        : ({ proceed: true } as const);
      if (!backlog.proceed) return;
      const result = await setEnabled({
        environmentId,
        input: {
          ...target,
          enabled,
          ...(backlog.eventBacklog ? { eventBacklog: backlog.eventBacklog } : {}),
        },
      });
      reportFailure(`Could not ${enabled ? "enable" : "disable"} ${manifest.name}`, result);
    });
  };
  const runRefresh = () =>
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
            review();
          },
        },
      });
    });
  const runResume = () =>
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
    });
  const runRepair = () => withBusy(() => repair(environmentId, installation));
  const runStageRepair = () =>
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
      review();
    });

  const primary = (() => {
    if (readOnly) return null;
    if (status.primary === "review") {
      return { icon: <ShieldCheckIcon />, label: "Review", onClick: review };
    }
    if (pendingRevision !== null) {
      return { icon: <ShieldCheckIcon />, label: REVIEW_LABELS[pendingRevision], onClick: review };
    }
    if (status.primary === "resume") {
      return { icon: <RotateCcwIcon />, label: "Restart", onClick: () => void runResume() };
    }
    if (attention?.kind === "events-paused" && installation.enabled && !executionDisabled) {
      return { icon: <RotateCcwIcon />, label: "Resume events", onClick: () => void runResume() };
    }
    if (unavailable && recovery.repair !== null && canRepair) {
      return { icon: <BotIcon />, label: "Repair with agent", onClick: () => void runRepair() };
    }
    return null;
  })();

  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{manifest.name}</span>
          {displayVersion === null ? null : (
            <span className="shrink-0 font-normal text-muted-foreground text-xs">
              v{displayVersion}
            </span>
          )}
          {recovery.runningLocalFix ? (
            <Badge variant="outline" className="shrink-0">
              Local fix
            </Badge>
          ) : null}
        </span>
      }
      description={
        manifest.description ? <span className="line-clamp-2">{manifest.description}</span> : null
      }
      status={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant={TONE_BADGE[status.tone]}>{status.label}</Badge>
          {installation.pendingUpdate && pendingRevision === "update" ? (
            <Badge variant="info">
              Update {installation.pendingUpdate.manifest.version} available
            </Badge>
          ) : null}
          {readOnly ? null : (
            <span className="min-w-0 truncate">{pluginSourceLabel(installation.source)}</span>
          )}
          {attention ? (
            <span
              className={`min-w-0 ${attention.kind === "events-paused" ? "text-warning-foreground" : attention.kind === "read-only" ? "text-muted-foreground" : "text-destructive-foreground"}`}
            >
              {attention.title}: {attention.message}
            </span>
          ) : null}
        </div>
      }
      control={
        <div className="flex items-center gap-2">
          {primary ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !canManage}
              onClick={primary.onClick}
            >
              {primary.icon}
              {primary.label}
            </Button>
          ) : null}
          <Switch
            checked={installation.enabled}
            // Turning a plugin off always works; turning it on needs a host that can run it.
            disabled={busy || !canManage || readOnly || (!installation.enabled && unavailable)}
            aria-label={`Enable ${manifest.name}`}
            onCheckedChange={toggle}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Actions for ${manifest.name}`}
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={details}>
                <InfoIcon />
                Details
              </MenuItem>
              {readOnly ? null : (
                <>
                  <MenuItem onClick={review} disabled={!canManage}>
                    <ShieldCheckIcon />
                    Review permissions
                  </MenuItem>
                  {manifest.settings.length > 0 ? (
                    <MenuItem
                      disabled={!canManage}
                      onClick={() =>
                        props.onDialog({
                          kind: "settings",
                          environmentId,
                          installationId: installation.installationId,
                        })
                      }
                    >
                      <Settings2Icon />
                      Settings
                    </MenuItem>
                  ) : null}
                  <MenuItem disabled={!canManage} onClick={() => void runRefresh()}>
                    <RefreshCwIcon />
                    {recovery.runningLocalFix
                      ? "Check publisher for updates"
                      : "Check source for changes"}
                  </MenuItem>
                  {recovery.repair !== null ? (
                    <>
                      <MenuSeparator />
                      <MenuItem disabled={!canRepair} onClick={() => void runRepair()}>
                        <BotIcon />
                        {recovery.repair === "open" ? "Open repair draft" : "Repair with agent"}
                      </MenuItem>
                      {recovery.stageRepair ? (
                        <MenuItem disabled={!canManage} onClick={() => void runStageRepair()}>
                          <FileSearchIcon />
                          Review local fix
                        </MenuItem>
                      ) : null}
                      {recovery.usePrevious !== null ? (
                        <MenuItem
                          disabled={!canManage}
                          onClick={() =>
                            props.onDialog({
                              kind: "use-previous",
                              environmentId,
                              installationId: installation.installationId,
                            })
                          }
                        >
                          <HistoryIcon />
                          Use previous version (v{recovery.usePrevious.version})…
                        </MenuItem>
                      ) : null}
                    </>
                  ) : null}
                  <MenuSeparator />
                  <MenuItem
                    disabled={!canManage}
                    onClick={() => props.onDialog({ kind: "remove", environmentId, installation })}
                  >
                    <Trash2Icon />
                    Remove
                  </MenuItem>
                </>
              )}
            </MenuPopup>
          </Menu>
        </div>
      }
    >
      <PluginContributions
        environmentId={environmentId}
        installation={installation}
        executionDisabled={props.executionDisabled}
      />
      {backlogDialog}
    </SettingsRow>
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
        props.onDialog({ kind: "review", environmentId, installationId });
      }}
    />
  );
}

/** What the plugin adds, with a way to run each action and open each view from here. */
function PluginContributions(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly executionDisabled: boolean;
}) {
  const { environmentId, installation } = props;
  const { actions, views } = installation.manifest;
  const active = isPluginActive(installation) && !props.executionDisabled;
  const canInvoke = useAtomValue(pluginEnvironment.invoke.permissionAtom(environmentId));
  const runAction = usePluginActionRunner();
  const applyIntents = usePluginIntentApplier();
  const pathname = useLocation({ select: (location) => location.pathname });
  const [running, setRunning] = useState<string | null>(null);
  const { startPage, setStartPage } = usePluginStartPage();
  if (actions.length === 0 && views.length === 0) return null;
  const target = {
    environmentId,
    installation,
    threadRef: null,
    composerTarget: null,
    locationKey: pathname,
  };
  const viewsAllowed = active && installation.grants.capabilities.includes("ui");
  return (
    <ul className="mt-2 divide-y divide-border/50 rounded-md border border-border/60">
      {actions.map((action) => (
        <li key={`action:${action.id}`} className="flex items-center gap-3 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{action.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[
                action.description,
                action.placements.map((placement) => PLACEMENT_LABELS[placement]).join(", "),
                action.agentCallable ? "Agents can call it" : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <Button
            size="xs"
            variant="ghost"
            disabled={!active || !canInvoke || running !== null}
            aria-label={`Run ${action.title}`}
            onClick={async () => {
              setRunning(action.id);
              await runAction(target, action, {});
              setRunning(null);
            }}
          >
            <PlayIcon />
            Run
          </Button>
        </li>
      ))}
      {views.map((view) => (
        <li key={`view:${view.id}`} className="flex items-center gap-3 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{view.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              {view.placement === "page"
                ? "Page"
                : view.placement === "conversation"
                  ? "Card in chat"
                  : "Side panel beside a thread"}
            </p>
          </div>
          {view.placement === "page" ? (
            <PluginStartPageToggle
              viewTitle={view.title}
              chosen={
                startPage?.environmentId === environmentId &&
                startPage.pluginId === installation.manifest.id &&
                startPage.viewId === view.id
              }
              onChange={(chosen) =>
                setStartPage(
                  chosen
                    ? { environmentId, pluginId: installation.manifest.id, viewId: view.id }
                    : null,
                )
              }
            />
          ) : null}
          {/* A card's view only opens from its card. */}
          {view.placement === "conversation" ? null : (
            <Button
              size="xs"
              variant="ghost"
              disabled={!viewsAllowed}
              aria-label={`Open ${view.title}`}
              onClick={() => applyIntents(target, [{ type: "view.open", viewId: view.id }])}
            >
              <SquareArrowOutUpRightIcon />
              Open
            </Button>
          )}
        </li>
      ))}
    </ul>
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
            size="xs"
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
        <HouseIcon />
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

function InstallPluginDialog(props: {
  readonly initialEnvironmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onInstalled: (environmentId: EnvironmentId, installation: PluginInstallation) => void;
}) {
  const { connectedEnvironments } = useSettingsScope();
  const [environmentId, setEnvironmentId] = useState(props.initialEnvironmentId);
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const install = useAtomCommand(pluginEnvironment.install, { reportFailure: false });
  const canInstall = useAtomValue(pluginEnvironment.install.permissionAtom(environmentId));
  const catalogue = usePluginCatalogue(environmentId);
  const selected = connectedEnvironments.find((entry) => entry.environmentId === environmentId);
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
    props.onInstalled(environmentId, result.value);
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
            <DialogTitle>Install plugin</DialogTitle>
            <DialogDescription>
              T3 Code copies the plugin and reads its manifest. Nothing runs until you review and
              enable it.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              {connectedEnvironments.length > 1 ? (
                <Field label="Environment" htmlFor="plugin-install-environment">
                  <Select
                    value={environmentId}
                    onValueChange={(value) => value && setEnvironmentId(value as EnvironmentId)}
                  >
                    <SelectTrigger size="sm" id="plugin-install-environment">
                      <SelectValue>{selected?.label ?? environmentId}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {connectedEnvironments.map((entry) => (
                        <SelectItem key={entry.environmentId} value={entry.environmentId}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
              ) : null}
              <Field
                label="Source"
                htmlFor="plugin-install-source"
                hint={`A folder on ${selected?.label ?? "the environment"}, or an https Git URL. Add #tag or #commit to pin a version.`}
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
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        {installation ? (
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
        : { keep: "Keep current version", discard: "Discard update", approve: "Approve update" };
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
  const [saving, setSaving] = useState(false);
  const consent = useAtomCommand(pluginEnvironment.consent, { reportFailure: false });
  const setEnabled = useAtomCommand(pluginEnvironment.setEnabled, { reportFailure: false });
  const discard = useAtomCommand(pluginEnvironment.discardPendingUpdate, { reportFailure: false });
  const { resolveBacklog, backlogDialog } = usePluginEventBacklog();
  const canManage = useAtomValue(pluginEnvironment.consent.permissionAtom(environmentId));
  const changed =
    !isUpdate &&
    installation.consentedDigest !== null &&
    installation.consentedDigest !== installation.digest;
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
  const approve = async () => {
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
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Identifier</dt>
            <dd className="truncate font-mono text-xs leading-5">{manifest.id}</dd>
            <dt className="text-muted-foreground">Source</dt>
            <dd className="truncate">{pluginSourceLabel(subject.source)}</dd>
            <dt className="text-muted-foreground">Fingerprint</dt>
            <dd className="break-all font-mono text-xs leading-5">{subject.digest}</dd>
          </dl>
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
          {subject.removedCapabilities.length > 0 || subject.settingChanges.length > 0 ? (
            <section className="space-y-1">
              <h3 className="text-sm font-medium">Changes from v{installation.manifest.version}</h3>
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
          ) : null}
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
          {manifest.actions.length > 0 ||
          manifest.views.length > 0 ||
          (manifest.sidebarViews ?? []).length > 0 ? (
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
                  <li key={`s:${view.id}`}>
                    {view.title} sidebar layout (off until you choose it)
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
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
          <Button size="sm" disabled={saving || !canManage} onClick={() => void approve()}>
            {saving ? "Saving…" : labels.approve}
          </Button>
        )}
      </DialogFooter>
      {backlogDialog}
    </>
  );
}

function PluginSettingsDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly installationId: string;
  readonly onClose: () => void;
}) {
  const catalogue = usePluginCatalogue(props.environmentId);
  const installation = catalogue.installations.find(
    (entry) => entry.installationId === props.installationId,
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        {installation ? (
          <PluginSettingsForm
            environmentId={props.environmentId}
            installation={installation}
            onClose={props.onClose}
          />
        ) : (
          <DialogHeader>
            <DialogTitle>Plugin settings</DialogTitle>
            <DialogDescription>This plugin is no longer installed.</DialogDescription>
          </DialogHeader>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function PluginSettingsForm(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly onClose: () => void;
}) {
  const { installation } = props;
  // Changes are diffed against what the form opened with, so a value another device changed
  // meanwhile is not sent back just because this form still shows the old one.
  const [base] = useState(() => installation.settings);
  const [draft, setDraft] = useState<PluginSettingDraft>(() => pluginSettingsDraft(installation));
  const [clearedSecrets, setClearedSecrets] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const update = useAtomCommand(pluginEnvironment.updateSettings, { reportFailure: false });
  const save = async () => {
    const patch = buildPluginSettingsPatch(
      installation.manifest.settings,
      base,
      draft,
      clearedSecrets,
    );
    if (!patch.ok) {
      setErrors(patch.errors);
      return;
    }
    if (Object.keys(patch.values).length === 0) {
      props.onClose();
      return;
    }
    setSaving(true);
    const result = await update({
      environmentId: props.environmentId,
      input: { installationId: installation.installationId, values: patch.values },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      reportFailure(`Could not save ${installation.manifest.name} settings`, result);
      return;
    }
    props.onClose();
  };
  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>{installation.manifest.name} settings</DialogTitle>
        <DialogDescription>
          Stored on this environment. Secrets are write-only: T3 Code never shows them again.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-4">
          {installation.manifest.settings.map((setting) => {
            const id = `plugin-setting-${setting.key}`;
            const value = draft[setting.key];
            const set = (next: string | boolean) => {
              setDraft((current) => ({ ...current, [setting.key]: next }));
              setErrors((current) => {
                const next = { ...current };
                delete next[setting.key];
                return next;
              });
            };
            if (setting.type === "boolean") {
              return (
                <div key={setting.key} className="flex items-start justify-between gap-4">
                  <div className="min-w-0 space-y-0.5">
                    <Label id={`${id}-label`} htmlFor={id}>
                      {setting.label}
                    </Label>
                    {setting.description ? (
                      <p id={`${id}-description`} className="text-xs text-muted-foreground">
                        {setting.description}
                      </p>
                    ) : null}
                  </div>
                  {/* The switch is a span, which a label cannot name, so it names itself. */}
                  <Switch
                    id={id}
                    aria-labelledby={`${id}-label`}
                    aria-describedby={setting.description ? `${id}-description` : undefined}
                    checked={value === true}
                    onCheckedChange={(checked) => set(checked)}
                  />
                </div>
              );
            }
            if (setting.type === "secret") {
              const cleared = clearedSecrets.has(setting.key);
              return (
                <Field
                  key={setting.key}
                  label={setting.label}
                  htmlFor={id}
                  hint={
                    cleared
                      ? "The stored value will be deleted when you save."
                      : (setting.description ?? "Leave empty to keep the stored value.")
                  }
                >
                  <div className="flex items-center gap-2">
                    <SecretInput
                      id={id}
                      className="min-w-0 flex-1"
                      placeholder="Enter a new value to replace it"
                      value={typeof value === "string" ? value : ""}
                      onChange={(event) => {
                        set(event.target.value);
                        setClearedSecrets((current) => {
                          const next = new Set(current);
                          next.delete(setting.key);
                          return next;
                        });
                      }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      disabled={cleared}
                      onClick={() => {
                        set("");
                        setClearedSecrets((current) => new Set(current).add(setting.key));
                      }}
                    >
                      Clear
                    </Button>
                  </div>
                </Field>
              );
            }
            return (
              <Field
                key={setting.key}
                label={setting.label}
                htmlFor={id}
                hint={setting.description}
                error={errors[setting.key]}
              >
                <Input
                  id={id}
                  inputMode={setting.type === "number" ? "decimal" : undefined}
                  value={typeof value === "string" ? value : ""}
                  onChange={(event) => set(event.target.value)}
                />
              </Field>
            );
          })}
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" size="sm" disabled={saving} />}>
          Cancel
        </DialogClose>
        <Button size="sm" type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RemovePluginDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly installation: PluginInstallation;
  readonly onClose: () => void;
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
    props.onClose();
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
