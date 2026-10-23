import type { PluginSidebarViewOption } from "@t3tools/client-runtime/plugins";
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

/**
 * One offered view toggles directly; several views use a menu without growing the header.
 */
export function SidebarViewSwitch(props: {
  options: ReadonlyArray<PluginSidebarViewOption>;
  selectedKey: string | null;
  onSelect: (option: PluginSidebarViewOption | null) => void;
}) {
  if (props.options.length === 0) return null;
  const selected = props.options.find((option) => option.key === props.selectedKey);
  const first = props.options[0]!;
  if (props.options.length === 1) {
    return (
      <SidebarHeaderIconButton
        label={`Toggle ${first.view.title} view`}
        tooltip={selected ? "Show Activity in sidebar" : `Show ${first.view.title} in sidebar`}
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
            tooltip={`Sidebar view: ${selected?.view.title ?? "Activity"}`}
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
            Activity
          </MenuRadioItem>
          {props.options.map((option) => (
            <MenuRadioItem key={option.key} value={option.key} closeOnClick>
              {option.view.title}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

export function SidebarProjectThreadTree<TThread>(props: {
  rows: ReadonlyArray<ProjectViewRow<TThread>>;
  renderRow: (thread: TThread) => ReactNode;
}) {
  return props.rows.map((row) => (
    <Fragment key={row.key}>
      {props.renderRow(row.thread)}
      {row.children.length > 0 ? (
        <li role="presentation" className="ml-[18px] list-none pl-2">
          <ul
            role="presentation"
            data-parent-thread-key={row.key}
            className="relative flex flex-col gap-px before:pointer-events-none before:absolute before:-left-2 before:top-0 before:bottom-4 before:border-l before:border-sidebar-border/70 [&>li[data-thread-item]]:relative [&>li[data-thread-item]]:before:pointer-events-none [&>li[data-thread-item]]:before:absolute [&>li[data-thread-item]]:before:-left-2 [&>li[data-thread-item]]:before:top-0 [&>li[data-thread-item]]:before:h-4 [&>li[data-thread-item]]:before:w-2 [&>li[data-thread-item]]:before:rounded-bl-md [&>li[data-thread-item]]:before:border-b [&>li[data-thread-item]]:before:border-l [&>li[data-thread-item]]:before:border-sidebar-border/70"
          >
            <SidebarProjectThreadTree rows={row.children} renderRow={props.renderRow} />
          </ul>
        </li>
      ) : null}
    </Fragment>
  ));
}

function ProjectAge(props: { timestamp: string }) {
  const nowMinute = useNowMinute();
  const label = formatRelativeTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`));
  return <>{label === "just now" ? "now" : label.replace(/ ago$/, "")}</>;
}

const headingClassName =
  "flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

/** One project's heading in a project view: folds its rows and starts a thread there. */
export function SidebarProjectSectionHeader(props: {
  project: SidebarProjectSnapshot | null;
  sectionKey: string;
  liveCount: number;
  lastActivityAt: string | null;
  folded: boolean;
  onToggleFold: (sectionKey: string) => void;
  onNewThread: (project: SidebarProjectSnapshot) => void;
  /** Right-click opens project settings, as it does in the project filter. */
  onOpenSettings: (event: ReactMouseEvent, project: SidebarProjectSnapshot) => void;
}) {
  const { project } = props;
  const name = project?.displayName ?? "Other threads";
  const foldable = props.liveCount > 0;
  const openSettings = (event: ReactMouseEvent) => {
    if (project) props.onOpenSettings(event, project);
  };
  const heading = (
    <>
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "absolute size-3.5 text-sidebar-muted-foreground/70 opacity-0 transition-transform duration-150 group-hover/project-section:opacity-100 group-focus-within/project-section:opacity-100 pointer-coarse:opacity-100",
            !props.folded && "rotate-90",
            !foldable && "invisible",
          )}
        />
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
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-medium",
          !foldable && "text-sidebar-muted-foreground",
        )}
      >
        {name}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground/70 group-hover/project-section:opacity-0 group-focus-within/project-section:opacity-0 pointer-coarse:opacity-0">
        {foldable ? (
          props.liveCount
        ) : props.lastActivityAt !== null ? (
          <ProjectAge timestamp={props.lastActivityAt} />
        ) : null}
      </span>
    </>
  );
  return (
    <li
      className="group/project-section mt-2 flex h-8 list-none items-center gap-1 first:mt-0"
      data-thread-selection-safe
      data-testid="sidebar-project-section"
      data-project-key={props.sectionKey}
    >
      {foldable ? (
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

/** Folds idle projects behind one row; open for this session only. */
export function SidebarQuietProjectsToggle(props: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="mx-0.5 mt-2 h-8 list-none" data-thread-selection-safe>
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
