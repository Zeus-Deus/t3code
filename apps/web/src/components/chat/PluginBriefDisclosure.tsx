import type { OrchestrationV2PluginBrief } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "~/lib/utils";
import { InlineButton } from "../ui/button";
import { DraftHeroProjectHeading } from "./DraftHeroProjectHeading";
import { DraftProjectName } from "./DraftProjectName";

function PluginBriefText({ id, brief }: { id: string; brief: OrchestrationV2PluginBrief }) {
  return (
    <div
      id={id}
      className="pointer-events-auto w-full rounded-xl border border-border/70 bg-muted/40 px-3 py-2 text-left"
      data-plugin-brief-text
    >
      <p className="text-2xs font-medium text-muted-foreground">Added by {brief.pluginName}</p>
      <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs text-foreground">
        {brief.text}
      </pre>
    </div>
  );
}

/** A plugin's empty conversation: the project is fixed, and its brief is readable before sending. */
export function PluginBriefHero({
  projectName,
  brief,
}: {
  projectName: string;
  brief: OrchestrationV2PluginBrief;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <DraftHeroProjectHeading projectName={projectName}>
        <span className="font-medium">
          <DraftProjectName value={projectName} singleLine />
        </span>
      </DraftHeroProjectHeading>
      <p className="mt-2 flex h-6 w-full items-center justify-center gap-1 text-sm text-muted-foreground">
        <span className="min-w-0 truncate">
          {brief.pluginName} adds its brief to your first message
        </span>
        <span aria-hidden>·</span>
        <InlineButton
          tone="muted"
          className="pointer-events-auto"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide" : "View"}
        </InlineButton>
      </p>
      {open ? (
        <div className="mt-2 w-full max-w-xl">
          <PluginBriefText id={id} brief={brief} />
        </div>
      ) : null}
    </div>
  );
}

/** Under a sent message: exactly what the plugin added for the agent, folded by default. */
export function SentPluginBriefDisclosure({ brief }: { brief: OrchestrationV2PluginBrief }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="flex w-full max-w-[80%] flex-col items-end gap-1 text-xs">
      <InlineButton
        tone="muted"
        className="me-1"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
        Includes {brief.pluginName}'s brief
      </InlineButton>
      {open ? <PluginBriefText id={id} brief={brief} /> : null}
    </div>
  );
}
