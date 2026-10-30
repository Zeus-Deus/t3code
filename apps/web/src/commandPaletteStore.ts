import { useEffect } from "react";
import { create } from "zustand";

import type { CommandPaletteProjectChoice } from "./commandPaletteBus";
import {
  type ProjectPicker,
  type CommandPaletteUiAction,
  type CommandPaletteUiState,
  reduceCommandPaletteUiState,
} from "./components/CommandPalette.logic";
import { getWorkspaceFocusRequestVersion } from "./lib/workspaceFocus";

const INITIAL_STATE: CommandPaletteUiState = {
  open: false,
  mode: "command",
  openIntent: null,
  session: 0,
};

export const useCommandPaletteStore = create<CommandPaletteUiState>(() => INITIAL_STATE);

let returnFocus: { element: HTMLElement | null; href: string; focusRequest: number } | null = null;

export function dispatchCommandPalette(action: CommandPaletteUiAction): void {
  const state = useCommandPaletteStore.getState();
  const next = reduceCommandPaletteUiState(state, action);
  if (!state.open && next.open) {
    // The workspace turns inert before the popup mounts, which blurs the opener.
    returnFocus = {
      element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      href: window.location.href,
      focusRequest: getWorkspaceFocusRequestVersion(),
    };
  }
  useCommandPaletteStore.setState(next, true);
}

/**
 * Where the closing palette should return focus: `false` when a command navigated or asked
 * for workspace focus (the destination owns it), else the opener, or `true` for the default.
 */
export function getCommandPaletteReturnFocus(): HTMLElement | boolean {
  if (
    !returnFocus ||
    window.location.href !== returnFocus.href ||
    getWorkspaceFocusRequestVersion() !== returnFocus.focusRequest
  )
    return false;
  const { element } = returnFocus;
  return element?.isConnected && !element.matches(":disabled") ? element : true;
}

// The palette is only mounted on app-shell routes (not /pair, sign-in or
// landings), so its shortcuts must stay inert elsewhere.
let mountedPalettes = 0;

export function isCommandPaletteMounted(): boolean {
  return mountedPalettes > 0;
}

/**
 * Keeps `choice` the picker's live choice while the calling view is mounted. Arming it during
 * render would lose it: a replaced session's cleanup and StrictMode's replayed one both run after.
 */
export function useLiveProjectChoice(
  picker: ProjectPicker,
  choice: CommandPaletteProjectChoice | null,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The picker outlives this view and pending adds read it outside React, so the view's lifetime has to be published to it.
  useEffect(() => {
    picker.set(choice);
    return () => picker.set(null);
  }, [choice, picker]);
}

/**
 * Marks the palette as mounted while the calling component is. An unmounted
 * palette cannot stay open, so the last unmount resets the store.
 */
export function useCommandPaletteMount(projectPicker?: ProjectPicker): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The palette's mount gates its global shortcuts, and leaving the route while it is open calls no close handler, so only unmount can reset the store.
  useEffect(() => {
    mountedPalettes += 1;
    const unsubscribe =
      projectPicker === undefined
        ? () => {}
        : useCommandPaletteStore.subscribe((state, previous) => {
            if (!state.open || state.mode !== "command" || state.session !== previous.session)
              projectPicker.set(null);
          });
    return () => {
      unsubscribe();
      projectPicker?.set(null);
      mountedPalettes -= 1;
      if (mountedPalettes === 0) {
        useCommandPaletteStore.setState(
          (state) => ({ ...INITIAL_STATE, session: state.session + 1 }),
          true,
        );
      }
    };
  }, [projectPicker]);
}
