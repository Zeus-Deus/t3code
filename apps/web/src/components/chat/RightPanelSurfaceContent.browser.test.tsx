import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { RightPanelSurfaceContent } from "./RightPanelSurfaceContent";

vi.mock("../plugins/PluginViewHost", () => ({
  PluginSidePanel: (props: Record<string, unknown>) => (
    <output aria-label="plugin view">
      {JSON.stringify({ threadRef: props.threadRef, composerTarget: props.composerTarget })}
    </output>
  ),
}));
vi.mock("./SideChatPane", () => ({ default: () => null }));

const environmentId = EnvironmentId.make("environment");
const parent = scopeThreadRef(environmentId, ThreadId.make("parent"));
const sideChat = scopeThreadRef(environmentId, ThreadId.make("side-chat"));
const view = {
  id: "plugin:inst:notes",
  kind: "plugin",
  installationId: "inst",
  viewId: "notes",
  title: "Notes",
} as const;

const renderView = (surface: Parameters<typeof RightPanelSurfaceContent>[0]["surface"]) =>
  render(
    <RightPanelSurfaceContent
      surface={surface}
      activeSurfaceId={surface?.id ?? null}
      threadRef={parent}
      environmentId={environmentId}
      visible
      composerDraftTarget={parent}
      keybindings={[]}
      configuredPreviewUrls={[]}
      workspaceMutationId={null}
      getShortcutContext={() => ({}) as never}
      onSendAnnotation={() => {}}
      onCloseSurface={() => {}}
      terminal={{} as never}
      pullRequest={{} as never}
      files={{} as never}
      sideChatParentPanel={{} as never}
    />,
  );

it.each([
  { name: "a stored view without an origin", surface: view, target: parent },
  {
    name: "a view opened from a side chat",
    surface: {
      ...view,
      id: `plugin:inst:notes:${sideChat.threadId}`,
      originThreadId: sideChat.threadId,
    } as const,
    target: sideChat,
  },
])("targets the right thread and composer for $name", async ({ surface, target }) => {
  await using _screen = await renderView(surface);
  await expect
    .element(page.getByRole("status", { name: "plugin view" }))
    .toHaveTextContent(JSON.stringify({ threadRef: target, composerTarget: target }));
});
