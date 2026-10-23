import type { PluginThreadStatusValue } from "@t3tools/client-runtime/plugins";
import type { PluginThreadStatus, ScopedThreadRef } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import {
  pluginThreadStatusDescription,
  usePluginThreadStatusOpener,
  usePluginThreadStatuses,
} from "../plugins/PluginThreadStatuses";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "./threadDetailsPanelStyles";

const TONE_DOT_CLASS = {
  neutral: "bg-muted-foreground/40",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-destructive",
} as const satisfies Record<PluginThreadStatus["tone"], string>;

function PluginStatusRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly value: PluginThreadStatusValue;
}) {
  const open = usePluginThreadStatusOpener(props.threadRef, props.value);
  const description = pluginThreadStatusDescription(props.value);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ThreadDetailsControl
            variant="ghost"
            size="sm"
            part="row"
            disabled={open === undefined}
            aria-description={description}
            onClick={open}
          />
        }
      >
        <span aria-hidden className="inline-flex size-4 shrink-0 items-center justify-center">
          <span className={cn("size-2 rounded-full", TONE_DOT_CLASS[props.value.status.tone])} />
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          {props.value.status.label}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="left">{description}</TooltipPopup>
    </Tooltip>
  );
}

/** Plugin-provided statuses for the thread, such as "Realm live", as rows in its details card. */
export function ThreadDetailsPluginStatuses(props: { readonly threadRef: ScopedThreadRef }) {
  const statuses = usePluginThreadStatuses(props.threadRef);
  if (statuses.length === 0) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-plugin-status-heading"
      title="Plugin status"
      showHeading={false}
    >
      <div className="flex flex-col">
        {statuses.map((value) => (
          <PluginStatusRow key={value.key} threadRef={props.threadRef} value={value} />
        ))}
      </div>
    </ThreadDetailsSection>
  );
}
