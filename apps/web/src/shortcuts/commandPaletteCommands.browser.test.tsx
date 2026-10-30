import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { openCommandPalette, type CommandPaletteProjectChoice } from "../commandPaletteBus";
import {
  dispatchCommandPalette,
  isCommandPaletteMounted,
  useCommandPaletteMount,
  useCommandPaletteStore,
  useLiveProjectChoice,
} from "../commandPaletteStore";
import { createProjectPicker } from "../components/CommandPalette.logic";
import { installCommandPaletteCommands } from "./commandPaletteCommands";

const keybindings = compileResolvedKeybindingsConfig([
  { key: "mod+k", command: "commandPalette.toggle" },
]);

function MountedPalette() {
  useCommandPaletteMount();
  return null;
}

function setup() {
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
}

describe("command palette shortcuts", () => {
  it("stay inert on routes without the palette", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(null, { router: "/pair" });
    using commands = new DisposableStack();
    commands.defer(
      installCommandPaletteCommands(screen.router!, { keybindings: () => keybindings }),
    );

    await userEvent.keyboard("{Control>}k{/Control}");

    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it("open the palette while it is mounted, and it closes when it unmounts", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(<MountedPalette />, { router: "/" });
    using commands = new DisposableStack();
    commands.defer(
      installCommandPaletteCommands(screen.router!, { keybindings: () => keybindings }),
    );

    await userEvent.keyboard("{Control>}k{/Control}");
    expect(useCommandPaletteStore.getState().open).toBe(true);

    await screen.rerender(<div />);
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });
});

describe("openCommandPalette", () => {
  it("drops a request made while no palette is mounted", async () => {
    setup();
    await using screen = await render(null, { router: "/pair" });

    openCommandPalette({ open: "new-thread-in" });
    await screen.rerender(<MountedPalette />);
    expect(useCommandPaletteStore.getState()).toMatchObject({ open: false, openIntent: null });

    openCommandPalette({ open: "new-thread-in" });
    expect(useCommandPaletteStore.getState()).toMatchObject({
      open: true,
      openIntent: { kind: "new-thread-in" },
    });
  });
});

function MountedProjectChooser(props: { picker: ReturnType<typeof createProjectPicker> }) {
  useCommandPaletteMount(props.picker);
  return null;
}

function ChooserView(props: {
  picker: ReturnType<typeof createProjectPicker>;
  choice: CommandPaletteProjectChoice;
}) {
  useLiveProjectChoice(props.picker, props.choice);
  return null;
}

describe("project chooser lifetime in the shared palette store", () => {
  it("stays live through StrictMode's replayed cleanup, and ends with its view", async () => {
    setup();
    const picker = createProjectPicker();
    const choice = { environmentIds: [EnvironmentId.make("env-picker")], choose: vi.fn() };
    await using screen = await render(
      <StrictMode>
        <ChooserView picker={picker} choice={choice} />
      </StrictMode>,
      // Under the test router, StrictMode does not replay the mount this test is about.
      { router: false },
    );
    expect(picker.attempt(choice)).not.toBeNull();
    await screen.rerender(<div />);
    expect(picker.attempt(choice)).toBeNull();
  });

  it("invalidates pending work synchronously on close, replacement or mode change", async () => {
    setup();
    const picker = createProjectPicker();
    const choose = vi.fn();
    const environmentId = EnvironmentId.make("env-picker");
    const choice = { environmentIds: [environmentId], choose };
    await using screen = await render(<MountedProjectChooser picker={picker} />);
    for (const action of [
      { _tag: "SetOpen", open: false },
      { _tag: "ToggleMode", mode: "files" },
      { _tag: "OpenAddProject" },
      { _tag: "OpenSearch", query: "replacement" },
    ] as const) {
      dispatchCommandPalette({ _tag: "OpenChooseProject", choice });
      picker.set(choice);
      const attempt = picker.attempt(choice);
      expect(attempt).not.toBeNull();
      dispatchCommandPalette(action);
      // The owner remains mounted throughout the popup's exit animation.
      expect(isCommandPaletteMounted()).toBe(true);
      expect(
        attempt &&
          picker.deliver(attempt, {
            environmentId,
            projectId: ProjectId.make("project-picker"),
          }),
      ).toBe(false);
    }
    expect(choose).not.toHaveBeenCalled();
    await screen.rerender(<div />);
    expect(isCommandPaletteMounted()).toBe(false);
  });

  it("keeps a live attempt in the same open session, but never revives a cancelled one", async () => {
    setup();
    const picker = createProjectPicker();
    const choice = { environmentIds: [EnvironmentId.make("env-picker")], choose: vi.fn() };
    await using screen = await render(<MountedProjectChooser picker={picker} />);
    dispatchCommandPalette({ _tag: "OpenChooseProject", choice });
    picker.set(choice);
    const attempt = picker.attempt(choice);
    dispatchCommandPalette({ _tag: "SetOpen", open: true });
    dispatchCommandPalette({ _tag: "BackToCommand" });
    expect(attempt && picker.isLive(attempt)).toBe(true);
    picker.leaveView();
    expect(attempt && picker.isLive(attempt)).toBe(false);
    expect(picker.attempt(choice)).not.toBeNull();
    expect(attempt && picker.isLive(attempt)).toBe(false);
    await screen.rerender(<div />);
    expect(picker.attempt(choice)).toBeNull();
  });
});
