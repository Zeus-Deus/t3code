import {
  createPluginThreadStatusPoller,
  pluginChangeKey,
  pluginStatusTopic,
  pluginRunnableInstallations,
  pluginThreadStatusEntries,
  pluginThreadStatusesFor,
  type PluginThreadStatusPoller,
  type PluginThreadStatusValue,
} from "@t3tools/client-runtime/plugins";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type PluginThreadStatus,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { useThreadShell } from "../../state/entities";
import {
  pluginEnvironment,
  usePluginCatalogue,
  usePluginChangeRevisions,
} from "../../state/plugins";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { newPluginOperationId, usePluginViewOpener } from "./usePluginActions";

const TONE_VARIANT = {
  neutral: "outline",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "error",
} as const satisfies Record<PluginThreadStatus["tone"], string>;

const NO_VALUES: ReadonlyArray<PluginThreadStatusValue> = [];
const noSubscription = () => () => {};
const noValues = () => NO_VALUES;

const subscribeVisibility = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};
const documentVisible = () => document.visibilityState === "visible";

/** The open thread's plugin statuses; asked only while this document is visible. */
function usePluginThreadStatuses(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<PluginThreadStatusValue> {
  const environmentId = threadRef?.environmentId ?? null;
  const catalogue = usePluginCatalogue(environmentId);
  // The server answers statuses only to sessions that may operate the environment.
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const projectId = useThreadShell(threadRef)?.projectId ?? null;
  const invoke = useAtomCommand(pluginEnvironment.invoke, { reportFailure: false });
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible);
  const entries =
    threadRef !== null && canOperate && catalogue.availability === "available"
      ? pluginThreadStatusEntries(pluginRunnableInstallations(catalogue))
      : [];
  const target =
    threadRef === null
      ? null
      : { environmentId: threadRef.environmentId, threadId: threadRef.threadId, projectId };

  const latestInvoke = useRef(invoke);
  useEffect(() => {
    latestInvoke.current = invoke;
  });
  const [poller, setPoller] = useState<PluginThreadStatusPoller | null>(null);
  useEffect(() => {
    const next = createPluginThreadStatusPoller({
      operationId: newPluginOperationId,
      invoke: async (request) => {
        const result = await latestInvoke.current(request);
        if (result._tag === "Success") return result.value;
        throw squashAtomCommandFailure(result);
      },
    });
    setPoller(next);
    const onFocus = () => next.refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      next.dispose();
    };
  }, []);
  // Reconciling is cheap and idempotent, so it follows every render rather than a dependency list.
  useEffect(() => {
    poller?.update({ target, entries, visible });
  });
  // A plugin that says a shown status changed is asked again now, not at the next poll.
  const revisions = usePluginChangeRevisions(entries.length > 0 ? environmentId : null);
  const statusRevision =
    revisions === null
      ? null
      : entries
          .map(
            ({ installation, item }) =>
              revisions.get(
                pluginChangeKey({
                  installationId: installation.installationId,
                  generation: installation.generation,
                  topic: pluginStatusTopic(item.id),
                }),
              ) ?? 0,
          )
          .join(",");
  const seenStatusRevision = useRef(statusRevision);
  useEffect(() => {
    const seen = seenStatusRevision.current;
    seenStatusRevision.current = statusRevision;
    if (seen !== null && statusRevision !== null && seen !== statusRevision) poller?.refresh();
  }, [poller, statusRevision]);
  const values = useSyncExternalStore(
    poller?.subscribe ?? noSubscription,
    poller?.getSnapshot ?? noValues,
  );
  return pluginThreadStatusesFor(values, target, entries);
}

export function pluginThreadStatusDescription(value: PluginThreadStatusValue) {
  const name = value.entry.installation.manifest.name;
  return value.status.detail === undefined ? name : `${name}: ${value.status.detail}`;
}

/** Opens the status's view, or undefined when the plugin declared none. */
export function usePluginThreadStatusOpener(
  threadRef: ScopedThreadRef,
  value: PluginThreadStatusValue,
) {
  const openView = usePluginViewOpener();
  const { installation, item } = value.entry;
  const viewId = item.viewId;
  if (viewId === undefined) return undefined;
  return () =>
    openView({ environmentId: threadRef.environmentId, installation, threadRef }, viewId);
}

function PluginThreadStatusChip(props: {
  readonly threadRef: ScopedThreadRef;
  readonly value: PluginThreadStatusValue;
}) {
  const { label, tone } = props.value.status;
  const description = pluginThreadStatusDescription(props.value);
  const open = usePluginThreadStatusOpener(props.threadRef, props.value);
  return (
    <Tooltip>
      {open === undefined ? (
        <TooltipTrigger render={<Badge variant={TONE_VARIANT[tone]} />}>
          {label}
          <span className="sr-only">{`, ${description}`}</span>
        </TooltipTrigger>
      ) : (
        <TooltipTrigger
          render={
            <Badge
              variant={TONE_VARIANT[tone]}
              render={<button type="button" />}
              aria-description={description}
              onClick={open}
            />
          }
        >
          {label}
        </TooltipTrigger>
      )}
      <TooltipPopup side="bottom">{description}</TooltipPopup>
    </Tooltip>
  );
}

interface PluginThreadStatusesValue {
  readonly threadRef: ScopedThreadRef;
  readonly statuses: ReadonlyArray<PluginThreadStatusValue>;
}

const PluginThreadStatusesContext = createContext<PluginThreadStatusesValue | null>(null);

/**
 * Polls the thread's plugin statuses once for everything below it. The header and the thread
 * details card take turns showing them, so the poller and its last answers outlive either.
 * Pass `null` for a thread the server does not know yet.
 */
export function PluginThreadStatusesProvider(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly children: ReactNode;
}) {
  const { threadRef } = props;
  const statuses = usePluginThreadStatuses(threadRef);
  const value = threadRef === null ? null : { threadRef, statuses };
  return <PluginThreadStatusesContext value={value}>{props.children}</PluginThreadStatusesContext>;
}

/** The statuses polled by the nearest provider; empty outside one. */
export function usePluginThreadStatusesContext(): PluginThreadStatusesValue | null {
  return use(PluginThreadStatusesContext);
}

/**
 * Compact plugin-provided statuses for the open thread, such as "Realm live", for the header
 * while the thread details card is closed. Nothing renders until a plugin reports one, and a
 * failing plugin stays quiet.
 */
export function PluginThreadStatuses() {
  const context = usePluginThreadStatusesContext();
  if (context === null || context.statuses.length === 0) return null;
  return (
    <div role="group" aria-label="Plugin status" className="flex shrink-0 items-center gap-1">
      {context.statuses.map((value) => (
        <PluginThreadStatusChip key={value.key} threadRef={context.threadRef} value={value} />
      ))}
    </div>
  );
}
