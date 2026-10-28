import {
  pluginConversationCardsSupported,
  resolvePluginCardPresentation,
} from "@t3tools/client-runtime/plugins";
import type { EnvironmentId, PluginCardReference, ScopedThreadRef } from "@t3tools/contracts";
import { PuzzleIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

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

/**
 * How far outside the viewport a card's frame is kept. The timeline's virtualizer keeps rows
 * mounted beyond the screen; without this every card in that overscan would hold a document,
 * its bridge and a change subscription.
 */
const CARD_FRAME_MARGIN = "400px";
/** The frame's height before its document reports one. */
const CARD_FRAME_INITIAL_HEIGHT = 96;

/**
 * Mounts the card's frame only while the row is near the viewport. A card scrolled away drops
 * its document, so it stops answering change signals; its space is kept so the timeline does not
 * jump, and it reloads when it comes back.
 */
function NearViewport(props: { readonly children: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [reservedHeight, setReservedHeight] = useState(CARD_FRAME_INITIAL_HEIGHT);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the card’s IntersectionObserver and releases it when the DOM card unmounts
  useEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry === undefined) return;
        if (!entry.isIntersecting) {
          const height = box.getBoundingClientRect().height;
          if (height > 0) setReservedHeight(height);
        }
        setNear(entry.isIntersecting);
      },
      { rootMargin: CARD_FRAME_MARGIN },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={boxRef} data-plugin-card-frame={near ? "live" : "parked"}>
      {near ? (
        props.children
      ) : (
        <div
          aria-hidden
          className="rounded-lg border border-border"
          style={{ height: reservedHeight }}
        />
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
  const capabilities = environment?.serverConfig?.environment.capabilities;
  const presentation = resolvePluginCardPresentation({
    card: props.card,
    supported: capabilities === undefined ? null : pluginConversationCardsSupported(capabilities),
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
    <NearViewport>
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
    </NearViewport>
  );
}
