import type { PluginSidebarViewOption } from "@t3tools/client-runtime/plugins";
import { ChevronRightIcon, FolderIcon, SquarePenIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ACTIVITY_VALUE = "activity";

/**
 * Switches between the built-in activity list and plugin-contributed views. Rendered only when a
 * plugin offers one; selecting the current segment again never clears the choice.
 */
export function SidebarViewSwitch(props: {
  options: ReadonlyArray<PluginSidebarViewOption>;
  selectedKey: string | null;
  onSelect: (option: PluginSidebarViewOption | null) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Sidebar view"
      className="w-full *:flex-1"
      variant="segmented"
      value={[props.selectedKey ?? ACTIVITY_VALUE]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === undefined) return;
        if (next === ACTIVITY_VALUE) props.onSelect(null);
        else {
          const option = props.options.find((candidate) => candidate.key === next);
          if (option) props.onSelect(option);
        }
      }}
    >
      <ToggleGroupItem value={ACTIVITY_VALUE}>Activity</ToggleGroupItem>
      {props.options.map((option) => (
        <Tooltip key={option.key}>
          <TooltipTrigger render={<ToggleGroupItem value={option.key} />}>
            <span className="truncate">{option.view.title}</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {option.view.description ?? `${option.view.title} view`} · {option.pluginName} plugin
          </TooltipPopup>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}

function ProjectAge(props: { timestamp: string }) {
  const nowMinute = useNowMinute();
  const label = formatRelativeTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`));
  return <>{label === "just now" ? "now" : label.replace(/ ago$/, "")}</>;
}

const headingClassName =
  "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm text-sidebar-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

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
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "-ml-0.5 size-3.5 shrink-0 text-sidebar-muted-foreground/70 transition-transform duration-150",
          !props.folded && "rotate-90",
          !foldable && "invisible",
        )}
      />
      {project ? (
        <ProjectFavicon project={project} className="size-4 shrink-0" />
      ) : (
        <FolderIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
      )}
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
      className="group/project-section mx-0.5 mt-2 flex h-8 list-none items-center gap-1 first:mt-0"
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
