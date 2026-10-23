import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { openPluginRepairDraft, type PluginRepairDraftDependencies } from "./repairDraft.ts";

const environmentId = EnvironmentId.make("env-1");
const workspace = {
  workspaceId: "ws-1",
  directory: "/home/u/.t3/plugins/workspaces/inst-1/1",
  baseDigest: "a".repeat(64),
  baseGeneration: "gen-1",
  draft: "The plugin Quote helper failed with: Cannot find module",
};

function dependencies(
  overrides: Partial<PluginRepairDraftDependencies<string>> = {},
): PluginRepairDraftDependencies<string> {
  return {
    findProject: () => null,
    createProject: async () => ProjectId.make("project-new"),
    waitForProject: async () => undefined,
    openDraft: async (ref: ScopedProjectRef) => `draft:${ref.projectId}`,
    setDraftText: () => undefined,
    ...overrides,
  };
}

describe("openPluginRepairDraft", () => {
  it("reuses the project already open on the repair folder and leaves the draft unsent", async () => {
    const createProject = vi.fn(async () => ProjectId.make("unused"));
    const setDraftText = vi.fn();
    const result = await openPluginRepairDraft(
      environmentId,
      workspace,
      dependencies({
        findProject: () => ProjectId.make("project-existing"),
        createProject,
        setDraftText,
      }),
    );
    expect(result).toEqual({
      ok: true,
      projectId: "project-existing",
      draft: "draft:project-existing",
    });
    expect(createProject).not.toHaveBeenCalled();
    expect(setDraftText).toHaveBeenCalledWith("draft:project-existing", workspace.draft);
  });

  it("adds the folder as a project and waits for it before opening a draft", async () => {
    const order: string[] = [];
    const result = await openPluginRepairDraft(
      environmentId,
      workspace,
      dependencies({
        createProject: async (_, directory) => {
          order.push(`create:${directory}`);
          return ProjectId.make("project-new");
        },
        waitForProject: async (ref) => {
          order.push(`wait:${ref.projectId}`);
        },
        openDraft: async (ref) => {
          order.push(`open:${ref.projectId}`);
          return "draft-1";
        },
      }),
    );
    expect(result.ok).toBe(true);
    expect(order).toEqual([
      `create:${workspace.directory}`,
      "wait:project-new",
      "open:project-new",
    ]);
  });

  it("returns the folder path when the project cannot be added, so the user can open it", async () => {
    const setDraftText = vi.fn();
    const result = await openPluginRepairDraft(
      environmentId,
      workspace,
      dependencies({
        createProject: async () => {
          throw new Error("No permission");
        },
        setDraftText,
      }),
    );
    expect(result).toMatchObject({ ok: false, step: "project", directory: workspace.directory });
    expect(setDraftText).not.toHaveBeenCalled();
  });
});
