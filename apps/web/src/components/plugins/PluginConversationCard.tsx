import {
  pluginConversationCardsSupported,
  resolvePluginCardPresentation,
} from "@t3tools/client-runtime/plugins";
import type { EnvironmentId, PluginCardReference, ScopedThreadRef } from "@t3tools/contracts";
import { PuzzleIcon, RotateCcwIcon } from "lucide-react";

import { useEnvironment } from "../../state/environments";
import { usePluginCatalogue } from "../../state/plugins";
import { Button } from "../ui/button";
import { PluginViewFrame } from "./PluginViewHost";

/**
 * The text the tool result recorded, which every client can read. It stays plain: the card's
 * history must not depend on the plugin still being installed, trusted or running.
 */
function PluginCardSummary(props: {
  readonly card: PluginCardReference;
  readonly pluginName: string | null;
  readonly reason: string | null;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2 text-xs">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <PuzzleIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{props.pluginName ?? "Plugin card"}</span>
      </span>
      <p className="whitespace-pre-wrap break-words text-foreground text-sm">
        {props.card.summary}
      </p>
      {props.reason === null ? null : (
        <div className="flex items-center justify-between gap-2 text-muted-foreground">
          <span>{props.reason}</span>
          {props.onRetry === undefined ? null : (
            <Button size="xs" variant="ghost" onClick={props.onRetry}>
              <RotateCcwIcon />
              Try again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** A card an agent's plugin call left in the conversation. */
export function PluginConversationCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly card: PluginCardReference;
}) {
  const environment = useEnvironment(props.environmentId);
  const catalogue = usePluginCatalogue(props.environmentId);
  const presentation = resolvePluginCardPresentation({
    card: props.card,
    supported: pluginConversationCardsSupported(
      environment?.serverConfig?.environment.capabilities,
    ),
    installations:
      catalogue.availability === "available" && catalogue.loaded ? catalogue.installations : null,
    executionDisabled: catalogue.executionDisabled === true,
  });
  if (presentation.kind === "summary") {
    return (
      <PluginCardSummary
        card={props.card}
        pluginName={presentation.pluginName}
        reason={presentation.reason}
      />
    );
  }
  return (
    <PluginViewFrame
      // A new generation is new code: it must not inherit the old document.
      key={presentation.installation.generation}
      environmentId={props.environmentId}
      installation={presentation.installation}
      view={presentation.view}
      placement="conversation"
      threadRef={props.threadRef}
      composerTarget={null}
      card={props.card}
      renderFailure={(message, retry) => (
        <PluginCardSummary
          card={props.card}
          pluginName={presentation.installation.manifest.name}
          reason={message}
          onRetry={retry}
        />
      )}
    />
  );
}
