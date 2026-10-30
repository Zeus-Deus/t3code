import type {
  EnvironmentId,
  PullRequestLinkedThreadsResult,
  ScopedProjectRef,
} from "@t3tools/contracts";

import { dispatchCommandPalette, isCommandPaletteMounted } from "./commandPaletteStore";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

/**
 * Lists these environments' projects and the Add project flow, and hands the project the person
 * chose, created or cloned to `choose` instead of opening a draft. Closing the palette chooses
 * nothing.
 */
export interface CommandPaletteProjectChoice {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly choose: (project: ScopedProjectRef) => void;
  /** Why a connected environment outside `environmentIds` is not offered; shown beside it. */
  readonly unavailableReason?: string;
}

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in";
  readonly chooseProject?: CommandPaletteProjectChoice;
  readonly query?: string;
  readonly linkedThreads?: CommandPaletteLinkedThreads;
}

export function openCommandPalette(detail: CommandPaletteOpenDetail = {}): void {
  // With no palette on screen (e.g. /pair) the request is dropped; kept in the
  // store, it would pop a stale palette once the app shell mounts.
  if (!isCommandPaletteMounted()) return;
  if (detail.chooseProject !== undefined) {
    dispatchCommandPalette({ _tag: "OpenChooseProject", choice: detail.chooseProject });
  } else if (detail.open === "new-thread-in") {
    dispatchCommandPalette({ _tag: "OpenNewThreadIn" });
  } else if (detail.open === "add-project") {
    dispatchCommandPalette({ _tag: "OpenAddProject" });
  } else if (detail.query !== undefined) {
    dispatchCommandPalette({
      _tag: "OpenSearch",
      query: detail.query,
      ...(detail.linkedThreads ? { linkedThreads: detail.linkedThreads } : {}),
    });
  } else {
    dispatchCommandPalette({ _tag: "SetOpen", open: true });
  }
}

/** True while the palette popup is on screen, including its closing animation. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
