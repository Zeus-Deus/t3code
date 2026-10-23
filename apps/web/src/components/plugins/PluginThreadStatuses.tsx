import {
  createPluginThreadStatusPoller,
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
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useThreadShell } from "../../state/entities";
import { pluginEnvironment, usePluginCatalogue } from "../../state/plugins";
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
  threadRef: ScopedThreadRef,
): ReadonlyArray<PluginThreadStatusValue> {
  const catalogue = usePluginCatalogue(threadRef.environmentId);
  // The server answers statuses only to sessions that may operate the environment.
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const projectId = useThreadShell(threadRef)?.projectId ?? null;
  const invoke = useAtomCommand(pluginEnvironment.invoke, { reportFailure: false });
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible);
  const entries =
    canOperate && catalogue.availability === "available"
      ? pluginThreadStatusEntries(pluginRunnableInstallations(catalogue))
      : [];
  const target = {
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    projectId,
  };

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
  const values = useSyncExternalStore(
    poller?.subscribe ?? noSubscription,
    poller?.getSnapshot ?? noValues,
  );
  return pluginThreadStatusesFor(values, target, entries);
}

function PluginThreadStatusChip(props: {
  readonly threadRef: ScopedThreadRef;
  readonly value: PluginThreadStatusValue;
}) {
  const openView = usePluginViewOpener();
  const { installation, item } = props.value.entry;
  const { label, tone, detail } = props.value.status;
  const description =
    detail === undefined ? installation.manifest.name : `${installation.manifest.name}: ${detail}`;
  const viewId = item.viewId;
  return (
    <Tooltip>
      {viewId === undefined ? (
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
              onClick={() =>
                openView(
                  {
                    environmentId: props.threadRef.environmentId,
                    installation,
                    threadRef: props.threadRef,
                  },
                  viewId,
                )
              }
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

/**
 * Compact plugin-provided statuses for the open thread, such as "Realm live". Nothing renders
 * until a plugin reports one, and a failing plugin stays quiet.
 */
export function PluginThreadStatuses(props: { readonly threadRef: ScopedThreadRef }) {
  const statuses = usePluginThreadStatuses(props.threadRef);
  if (statuses.length === 0) return null;
  return (
    <div role="group" aria-label="Plugin status" className="flex shrink-0 items-center gap-1">
      {statuses.map((value) => (
        <PluginThreadStatusChip key={value.key} threadRef={props.threadRef} value={value} />
      ))}
    </div>
  );
}
