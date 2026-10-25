import type { PluginThreadStatusValue } from "@t3tools/client-runtime/plugins";
import type {
  PluginThreadStatus,
  PluginThreadStatusIcon,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ActivityIcon,
  BotIcon,
  BoxIcon,
  GlobeIcon,
  MonitorIcon,
  PuzzleIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import {
  pluginThreadStatusDescription,
  usePluginThreadStatusesContext,
  usePluginThreadStatusOpener,
} from "../plugins/PluginThreadStatuses";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./threadDetailsPanelStyles";

const STATUS_ICON = {
  monitor: MonitorIcon,
  globe: GlobeIcon,
  bot: BotIcon,
  terminal: TerminalIcon,
  box: BoxIcon,
  activity: ActivityIcon,
} as const satisfies Record<PluginThreadStatusIcon, LucideIcon>;

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
  const { item } = props.value.entry;
  const { label, tone } = props.value.status;
  const Icon = item.icon === undefined ? PuzzleIcon : STATUS_ICON[item.icon];
  const content = (
    <>
      <Icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      <span className={cn("min-w-0 flex-1 truncate text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
        {item.title}
      </span>
      {/* Read as "Realm · Live", like the header chip. */}
      <span className="sr-only"> · </span>
      <span className="flex min-w-0 max-w-1/2 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT_CLASS[tone])} />
        <span className={cn("truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>{label}</span>
      </span>
    </>
  );
  return (
    <Tooltip>
      {open === undefined ? (
        // A status without a panel still needs a focus target so its detail stays reachable.
        <TooltipTrigger
          render={
            <div
              tabIndex={0}
              className={cn(
                "flex items-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
              )}
            />
          }
        >
          {content}
          <span className="sr-only">{`, ${description}`}</span>
        </TooltipTrigger>
      ) : (
        <TooltipTrigger
          render={
            <ThreadDetailsControl
              variant="ghost"
              size="sm"
              part="row"
              aria-description={description}
              onClick={open}
            />
          }
        >
          {content}
        </TooltipTrigger>
      )}
      <TooltipPopup side="left">{description}</TooltipPopup>
    </Tooltip>
  );
}

/** Plugin-provided statuses for the thread, such as "Realm · Live", as rows in its details card. */
export function ThreadDetailsPluginStatuses() {
  const context = usePluginThreadStatusesContext();
  if (context === null || context.statuses.length === 0) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-plugin-status-heading"
      title="Plugin status"
      showHeading={false}
    >
      <div className="flex flex-col">
        {context.statuses.map((value) => (
          <PluginStatusRow key={value.key} threadRef={context.threadRef} value={value} />
        ))}
      </div>
    </ThreadDetailsSection>
  );
}
