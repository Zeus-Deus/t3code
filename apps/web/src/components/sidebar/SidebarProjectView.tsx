import {
  pluginSidebarChoiceTitle,
  type PluginSidebarChoice,
} from "@t3tools/client-runtime/plugins";
import { ChevronRightIcon, FolderIcon, ListTreeIcon, SquarePenIcon } from "lucide-react";
import { Fragment, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import type { ProjectViewRow } from "./projectView.logic";

const ACTIVITY_VALUE = "activity";
const ACTIVITY_TITLE = "Activity";

const sameTitle = (left: string, right: string) =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * Titles are plugins' own words, so two plugins, or a plugin and the built-in list, can both say
 * "Projects". Only then does a choice name its plugin. The key is the last resort when one plugin
 * repeats a title, since it is the one name guaranteed to differ.
 */
function sidebarChoiceLabels(options: ReadonlyArray<PluginSidebarChoice>) {
  return new Map(
    options.map((option) => {
      const title = pluginSidebarChoiceTitle(option);
      const twins = options.filter(
        (other) => other.key !== option.key && sameTitle(pluginSidebarChoiceTitle(other), title),
      );
      const owner =
        twins.length === 0 && !sameTitle(title, ACTIVITY_TITLE)
          ? null
          : twins.some((other) => other.pluginName === option.pluginName)
            ? option.key
            : option.pluginName;
      return [option.key, { title, owner, name: owner === null ? title : `${title} (${owner})` }];
    }),
  );
}

/**
 * One offered view toggles directly; several views use a menu without growing the header.
 */
export function SidebarViewSwitch(props: {
  options: ReadonlyArray<PluginSidebarChoice>;
  selectedKey: string | null;
  onSelect: (option: PluginSidebarChoice | null) => void;
}) {
  if (props.options.length === 0) return null;
  const labels = sidebarChoiceLabels(props.options);
  const selected = props.options.find((option) => option.key === props.selectedKey);
  const first = props.options[0]!;
  if (props.options.length === 1) {
    const { name } = labels.get(first.key)!;
    return (
      <SidebarHeaderIconButton
        label={`Toggle ${name} view`}
        tooltip={selected ? "Show Activity in sidebar" : `Show ${name} in sidebar`}
        aria-pressed={selected !== undefined}
        active={selected !== undefined}
        onClick={() => props.onSelect(selected ? null : first)}
      >
        <ListTreeIcon />
      </SidebarHeaderIconButton>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label="Sidebar view"
            tooltip={`Sidebar view: ${selected === undefined ? ACTIVITY_TITLE : labels.get(selected.key)!.name}`}
          />
        }
      >
        <ListTreeIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuRadioGroup
          value={props.selectedKey ?? ACTIVITY_VALUE}
          onValueChange={(key) =>
            props.onSelect(props.options.find((option) => option.key === key) ?? null)
          }
        >
          <MenuRadioItem value={ACTIVITY_VALUE} closeOnClick>
            {ACTIVITY_TITLE}
          </MenuRadioItem>
          {props.options.map((option) => {
            const { title, owner, name } = labels.get(option.key)!;
            return (
              <MenuRadioItem
                key={option.key}
                value={option.key}
                closeOnClick
                aria-label={owner === null ? undefined : name}
              >
                {owner === null ? (
                  title
                ) : (
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">{title}</span>
                    <span className="min-w-0 truncate text-xs text-muted-foreground">{owner}</span>
                  </span>
                )}
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

// Plugin trees nest headings; deeper levels stop indenting so rows keep room for their titles.
const DEPTH_INDENT = ["", "pl-4", "pl-8", "pl-12"] as const;
const depthIndent = (depth: number) => DEPTH_INDENT[Math.min(Math.max(depth, 0), 3)];

export function SidebarProjectThreadTree<TThread>(props: {
  rows: ReadonlyArray<ProjectViewRow<TThread>>;
  renderRow: (thread: TThread) => ReactNode;
  /** Headings above these rows in a plugin tree. */
  depth?: number;
}) {
  const depth = props.depth ?? 0;
  if (depth > 0 && props.rows.length > 0) {
    return (
      <li role="presentation" className={cn("list-none", depthIndent(depth))}>
        <ul role="presentation" className="flex flex-col gap-px">
          <SidebarProjectThreadTree rows={props.rows} renderRow={props.renderRow} />
        </ul>
      </li>
    );
  }
  return props.rows.map((row) => (
    <Fragment key={row.key}>
      {props.renderRow(row.thread)}
      {row.children.length > 0 ? (
        <SidebarThreadNest parentThreadKey={row.key}>
          <SidebarProjectThreadTree rows={row.children} renderRow={props.renderRow} />
        </SidebarThreadNest>
      ) : null}
    </Fragment>
  ));
}

/** Insets what sits under a thread, or under a conversation's heading, behind a guide rail. */
export function SidebarThreadNest(props: {
  parentThreadKey?: string;
  /** Plugin-tree headings above the one this nests under, which keep their own indent. */
  depth?: number;
  children: ReactNode;
}) {
  const nest = (
    <li role="presentation" className="ml-[18px] list-none pl-2">
      <ul
        role="presentation"
        data-parent-thread-key={props.parentThreadKey}
        className="relative flex flex-col gap-px before:pointer-events-none before:absolute before:-left-2 before:top-0 before:bottom-4 before:border-l before:border-sidebar-border/70 [&>li[data-thread-item]]:relative [&>li[data-thread-item]]:before:pointer-events-none [&>li[data-thread-item]]:before:absolute [&>li[data-thread-item]]:before:-left-2 [&>li[data-thread-item]]:before:top-0 [&>li[data-thread-item]]:before:h-4 [&>li[data-thread-item]]:before:w-2 [&>li[data-thread-item]]:before:rounded-bl-md [&>li[data-thread-item]]:before:border-b [&>li[data-thread-item]]:before:border-l [&>li[data-thread-item]]:before:border-sidebar-border/70"
      >
        {props.children}
      </ul>
    </li>
  );
  if (!props.depth) return nest;
  return (
    <li role="presentation" className={cn("list-none", depthIndent(props.depth))}>
      <ul role="presentation" className="flex flex-col gap-px">
        {nest}
      </ul>
    </li>
  );
}

function ProjectAge(props: { timestamp: string }) {
  const nowMinute = useNowMinute();
  const label = formatRelativeTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`));
  return <>{label === "just now" ? "now" : label.replace(/ ago$/, "")}</>;
}

const headingClassName =
  "flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

/** A plugin tree's project heading that stands for a conversation instead of only folding. */
interface SidebarProjectHeadingConversation {
  readonly threadKey?: string;
  readonly revealRef?: ((row: HTMLElement, threadKey: string) => void) | undefined;
  /** The thread, or the action that starts one; folding moves to the chevron. */
  readonly onOpen: (event: ReactMouseEvent) => void;
  readonly label: string;
  /** Its thread is the open one. */
  readonly selected: boolean;
  /** Its thread is among the threads the person selected. */
  readonly inSelection: boolean;
  readonly busy: boolean;
  /** The thread's status, in the icon column its worker rows use. */
  readonly status: ReactNode;
  /** Named when several environments each give this project a conversation. */
  readonly environmentLabel: string | null;
  /** Shown while jump hints are, as on a thread row. */
  readonly jumpHint: ReactNode;
  /** A thread's own menu, which keeps project settings; without it right-click opens those. */
  readonly onContextMenu?: ((event: ReactMouseEvent) => void) | undefined;
}

/**
 * One heading in a project view or plugin tree: folds its rows, and for a project starts a thread
 * there. Without a project it is a plugin's group, or the threads nothing else placed.
 */
export function SidebarProjectSectionHeader(props: {
  project: SidebarProjectSnapshot | null;
  /** A plugin group's name; ignored for projects. */
  title?: string | undefined;
  /** Headings above this one in a plugin tree. */
  depth?: number;
  sectionKey: string;
  liveCount: number;
  lastActivityAt: string | null;
  folded: boolean;
  onToggleFold: (sectionKey: string) => void;
  onNewThread: (project: SidebarProjectSnapshot) => void;
  /** Right-click opens project settings, as it does in the project filter. */
  onOpenSettings: (event: ReactMouseEvent, project: SidebarProjectSnapshot) => void;
  conversation?: SidebarProjectHeadingConversation | undefined;
}) {
  const { project, conversation } = props;
  const name = project?.displayName ?? props.title ?? "Other threads";
  const foldable = props.liveCount > 0;
  const openSettings = (event: ReactMouseEvent) => {
    if (project) props.onOpenSettings(event, project);
  };
  const icon = (
    <span
      className={cn(
        "flex",
        foldable &&
          "group-hover/project-section:opacity-0 group-focus-within/project-section:opacity-0 pointer-coarse:opacity-0",
      )}
    >
      {project ? (
        <ProjectFavicon project={project} className="size-4 shrink-0" />
      ) : (
        <FolderIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
      )}
    </span>
  );
  const chevron = (
    <ChevronRightIcon
      aria-hidden
      className={cn(
        "size-3.5 text-sidebar-muted-foreground/70 transition-transform duration-150",
        !props.folded && "rotate-90",
      )}
    />
  );
  const trailing = (
    <span
      className={cn(
        "shrink-0 text-xs tabular-nums text-sidebar-muted-foreground/70 group-hover/project-section:opacity-0 group-focus-within/project-section:opacity-0 pointer-coarse:opacity-0",
        // Sized like a row's trailing cell, so the status icon sits in the rows' column.
        conversation && "-mr-1.5 min-w-12 pr-1.5 text-right",
      )}
    >
      {foldable ? (
        props.liveCount
      ) : props.lastActivityAt !== null ? (
        <ProjectAge timestamp={props.lastActivityAt} />
      ) : null}
    </span>
  );
  const heading = (
    <>
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <span
          className={cn(
            "absolute flex opacity-0 group-hover/project-section:opacity-100 group-focus-within/project-section:opacity-100 pointer-coarse:opacity-100",
            !foldable && "invisible",
          )}
        >
          {chevron}
        </span>
        {icon}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-medium",
          !foldable && "text-sidebar-muted-foreground",
        )}
      >
        {name}
      </span>
      {trailing}
    </>
  );
  return (
    <li
      className={cn(
        "group/project-section mt-2 flex h-8 list-none items-center gap-1 first:mt-0",
        depthIndent(props.depth ?? 0),
      )}
      data-thread-selection-safe
      data-testid="sidebar-project-section"
      data-project-key={props.sectionKey}
    >
      {conversation ? (
        <div className="relative flex min-w-0 flex-1">
          <button
            type="button"
            ref={(node) => {
              if (node !== null && conversation.threadKey !== undefined)
                conversation.revealRef?.(node, conversation.threadKey);
            }}
            data-sidebar-row={conversation.threadKey}
            aria-label={conversation.label}
            aria-current={conversation.selected ? "page" : undefined}
            aria-busy={conversation.busy || undefined}
            data-selected={conversation.inSelection || undefined}
            disabled={conversation.busy}
            onClick={(event) => {
              event.stopPropagation();
              conversation.onOpen(event);
            }}
            onContextMenu={conversation.onContextMenu ?? openSettings}
            className={cn(
              headingClassName,
              "relative cursor-pointer disabled:cursor-default",
              conversation.selected
                ? "bg-sidebar-row-active text-sidebar-foreground light:shadow-xs light:ring-1 light:ring-inset light:ring-sidebar-border/70"
                : conversation.inSelection
                  ? "bg-sidebar-row-selected text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
                  : "hover:bg-sidebar-row-hover",
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
            {conversation.environmentLabel === null ? null : (
              <span className="shrink-0 truncate text-xs text-sidebar-muted-foreground">
                {conversation.environmentLabel}
              </span>
            )}
            {conversation.status}
            {trailing}
            {conversation.jumpHint}
          </button>
          {foldable ? (
            // Over the icon, with room for a fingertip; never opens the conversation.
            <button
              type="button"
              aria-expanded={!props.folded}
              aria-label={`${props.folded ? "Expand" : "Collapse"} ${name}, ${props.liveCount} active`}
              onClick={(event) => {
                event.stopPropagation();
                props.onToggleFold(props.sectionKey);
              }}
              className="absolute top-1 left-1.5 flex size-6 cursor-pointer items-center justify-center rounded-sm opacity-0 group-hover/project-section:opacity-100 group-focus-within/project-section:opacity-100 pointer-coarse:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            >
              {chevron}
            </button>
          ) : null}
        </div>
      ) : foldable ? (
        <button
          type="button"
          aria-expanded={!props.folded}
          aria-label={`${name}, ${props.liveCount} active`}
          onClick={() => props.onToggleFold(props.sectionKey)}
          onContextMenu={openSettings}
          className={cn(headingClassName, "cursor-pointer hover:bg-sidebar-row-hover")}
        >
          {heading}
        </button>
      ) : (
        // Nothing live to fold: its settled and snoozed threads are on the shelves below.
        <div className={headingClassName} onContextMenu={openSettings}>
          {heading}
        </div>
      )}
      {project ? (
        <span className="-ml-8 mr-1 flex opacity-0 group-hover/project-section:opacity-100 group-focus-within/project-section:opacity-100 pointer-coarse:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`New thread in ${name}`}
                  onClick={() => props.onNewThread(project)}
                />
              }
            >
              <SquarePenIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">New thread in {name}</TooltipPopup>
          </Tooltip>
        </span>
      ) : null}
    </li>
  );
}

/** Folds idle projects behind one row atop the bottom shelves; open for this session only. */
export function SidebarQuietProjectsToggle(props: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="mx-0.5 mt-auto h-8 list-none" data-thread-selection-safe>
      <CollapsibleSectionHeader
        expanded={props.expanded}
        onClick={props.onToggle}
        data-testid="sidebar-quiet-projects-toggle"
      >
        {props.count === 1 ? "1 more project" : `${props.count} more projects`}
      </CollapsibleSectionHeader>
    </li>
  );
}
