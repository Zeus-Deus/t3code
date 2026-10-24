import { pluginAttentionNotice } from "@t3tools/client-runtime/plugins";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { PuzzleIcon, XIcon } from "lucide-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useConnectedEnvironmentIds, useEnvironment } from "../../state/environments";
import { usePluginCatalogue } from "../../state/plugins";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Matches the provider update pill so both notices read as one family.
const PILL_STYLES = {
  warning:
    "bg-warning/12 text-warning group-has-[button[data-plugin-attention-main]:hover]/plugin-attention:bg-warning/18",
  error:
    "bg-destructive/12 text-destructive group-has-[button[data-plugin-attention-main]:hover]/plugin-attention:bg-destructive/18",
} as const;

/** The notice key each environment's pill was dismissed at; one entry per environment. */
const DismissedNotices = Schema.Record(Schema.String, Schema.String);
const DISMISSED_STORAGE_KEY = "t3code:plugin-attention-dismissed:v1";

function PluginAttentionPill(props: {
  readonly environmentId: EnvironmentId;
  readonly showEnvironment: boolean;
}) {
  const navigate = useNavigate();
  const environment = useEnvironment(props.environmentId);
  const catalogue = usePluginCatalogue(props.environmentId);
  const [dismissed, setDismissed] = useLocalStorage(DISMISSED_STORAGE_KEY, {}, DismissedNotices);
  if (catalogue.availability !== "available") return null;
  if (!catalogue.loaded && catalogue.error === null) return null;
  const notice = pluginAttentionNotice({
    installations: catalogue.installations,
    unavailableMessage: catalogue.unavailableMessage,
    loadError: catalogue.error,
    environmentLabel: props.showEnvironment ? environment?.label : null,
  });
  // A dismissed notice returns as soon as anything in it changes, such as a new failure.
  if (notice === null || dismissed[props.environmentId] === notice.key) return null;
  const only = notice.entries.length === 1 ? notice.entries[0] : undefined;
  return (
    <div
      className={`group/plugin-attention relative flex min-h-7 w-full shrink-0 items-center overflow-hidden rounded-lg text-2xs leading-4 font-medium ${PILL_STYLES[notice.tone]}`}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-plugin-attention-main
              aria-label={`${notice.title}. ${notice.description} Open plugin settings.`}
              className="relative z-[1] flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
              onClick={() =>
                void navigate({
                  to: "/settings/plugins",
                  search: {
                    environmentId: props.environmentId,
                    // One plugin's notice opens it; several land on the list.
                    ...(only ? { installationId: only.installationId } : {}),
                  },
                })
              }
            >
              <PuzzleIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 wrap-break-word">{notice.title}</span>
            </button>
          }
        />
        <TooltipPopup side="top">{notice.description}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Dismiss plugin notice"
              className="relative z-[1] mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-70 outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() =>
                setDismissed((current) => ({ ...current, [props.environmentId]: notice.key }))
              }
            >
              <XIcon className="size-3.5 shrink-0" />
            </button>
          }
        />
        <TooltipPopup side="top">Dismiss until something else changes</TooltipPopup>
      </Tooltip>
    </div>
  );
}

/**
 * One grouped notice per environment whose plugins need attention. Details and fixes live in
 * Settings → Plugins, which keeps showing them after the notice is dismissed.
 */
export function SidebarPluginAttentionPill() {
  const environmentIds = useConnectedEnvironmentIds();
  return environmentIds.map((environmentId) => (
    <PluginAttentionPill
      key={environmentId}
      environmentId={environmentId}
      showEnvironment={environmentIds.length > 1}
    />
  ));
}
