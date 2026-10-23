import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";

const plugins = vi.hoisted(() => ({
  entries: [] as Array<{
    installation: { installationId: string; manifest: { name: string } };
    action: { id: string; title: string };
  }>,
  run: vi.fn(),
}));

vi.mock("../plugins/usePluginSelectionActions", () => ({
  usePluginSelectionActions: () => ({ entries: plugins.entries, run: plugins.run }),
}));

function setup(actionCount: number) {
  plugins.run.mockReset();
  plugins.entries = Array.from({ length: actionCount }, (_, index) => ({
    installation: { installationId: `plugin-${index}`, manifest: { name: `Plugin ${index}` } },
    action: { id: `action-${index}`, title: `Action ${index}` },
  }));
}

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

function Timeline() {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  return (
    <div ref={setViewport} data-assistant-citation-viewport="">
      <p
        data-assistant-citation-source="message"
        data-assistant-citation-environment={threadRef.environmentId}
        data-assistant-citation-thread={threadRef.threadId}
      >
        hello selected world
      </p>
      <AssistantSelectionToolbar viewport={viewport} threadRef={threadRef} onCite={() => true} />
    </div>
  );
}

async function selectWord(container: HTMLElement, word: string) {
  const text = container.querySelector("p")!.firstChild!;
  const start = text.textContent!.indexOf(word);
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, start + word.length);
  await act(() => {
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

it("reaches selection actions beyond the inline ones from an overflow menu", async () => {
  setup(5);
  await using screen = await render(<Timeline />);
  await selectWord(screen.container, "selected");

  const toolbar = page.getByRole("toolbar", { name: "Selection actions" });
  await expect.element(toolbar.getByRole("button", { name: "Action 2 (Plugin 2)" })).toBeVisible();
  expect(toolbar.getByRole("button", { name: "Action 3 (Plugin 3)" }).query()).toBeNull();

  await userEvent.click(toolbar.getByRole("button", { name: "More selection actions" }));
  const menu = page.getByRole("menu");
  await expect.element(menu.getByRole("menuitem", { name: /Action 4/ })).toBeVisible();
  // Opening the menu must not drop the selection the action will receive.
  expect(window.getSelection()?.toString()).toBe("selected");

  await userEvent.click(menu.getByRole("menuitem", { name: /Action 3/ }));
  expect(plugins.run).toHaveBeenCalledTimes(1);
  expect(plugins.run).toHaveBeenCalledWith(plugins.entries[3], {
    messageId: "message",
    text: "selected",
  });
  await expect.element(toolbar).not.toBeInTheDocument();
});

it("shows no overflow menu when every action fits inline", async () => {
  setup(3);
  await using screen = await render(<Timeline />);
  await selectWord(screen.container, "selected");

  const toolbar = page.getByRole("toolbar", { name: "Selection actions" });
  await expect.element(toolbar.getByRole("button", { name: "Action 2 (Plugin 2)" })).toBeVisible();
  expect(toolbar.getByRole("button", { name: "More selection actions" }).query()).toBeNull();
});
