import { ProjectId, type PluginInstallation } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { addProjectToPluginTree, pluginTreeCreateTarget } from "./treeCreate.ts";
import { pluginInstallationFixture } from "./testFixtures.ts";

const projectId = ProjectId.make("project-1");
const choice = { pluginId: "t3code.projects", tree: { id: "projects", title: "Projects" } };

const coordinator = (
  overrides: {
    readonly capabilities?: ReadonlyArray<string>;
    readonly projectIds?: ReadonlyArray<ProjectId>;
    readonly generation?: string;
  } = {},
): PluginInstallation => {
  const base = pluginInstallationFixture();
  return {
    ...base,
    generation: overrides.generation ?? "gen-1",
    manifest: {
      ...base.manifest,
      id: "t3code.projects",
      name: "Projects",
      actions: [{ id: "open-project", title: "Open project", placements: ["palette"] }],
      nativeTrees: [
        {
          id: "projects",
          title: "Projects",
          create: { actionId: "open-project", title: "New project" },
        },
      ],
    },
    grants: {
      capabilities: (overrides.capabilities ?? [
        "threads.read",
        "ui.native-trees",
        "ui.native-tree-projects",
      ]) as PluginInstallation["grants"]["capabilities"],
      projectIds: [...(overrides.projectIds ?? [])],
    },
  };
};

describe("pluginTreeCreateTarget", () => {
  it("offers the tree's declared action only while ui.native-tree-projects is granted", () => {
    expect(pluginTreeCreateTarget([coordinator()], choice)).toMatchObject({
      action: { id: "open-project" },
      title: "New project",
    });
    expect(
      pluginTreeCreateTarget(
        [coordinator({ capabilities: ["threads.read", "ui.native-trees"] })],
        choice,
      ),
    ).toBeNull();
  });
});

describe("addProjectToPluginTree", () => {
  const setup = (installation: PluginInstallation) => {
    const target = pluginTreeCreateTarget([installation], choice);
    if (target === null) throw new Error("expected a target");
    return {
      target,
      confirmGrant: vi.fn(async () => true),
      grantProject: vi.fn(async (): Promise<PluginInstallation | null> =>
        coordinator({ projectIds: [projectId], generation: "gen-1" }),
      ),
      run: vi.fn(async () => {}),
    };
  };

  it("runs the action with only the project id when the project is already granted", async () => {
    const input = setup(coordinator({ projectIds: [projectId] }));
    await expect(addProjectToPluginTree({ ...input, choice, projectId })).resolves.toBe("ran");
    expect(input.confirmGrant).not.toHaveBeenCalled();
    expect(input.grantProject).not.toHaveBeenCalled();
    expect(input.run).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "inst-1" }),
      expect.objectContaining({ id: "open-project" }),
      { projectId },
    );
  });

  it("asks once, grants the project, then runs against the installation the grant returned", async () => {
    const input = setup(coordinator());
    input.grantProject.mockResolvedValueOnce(
      coordinator({ projectIds: [projectId], generation: "gen-2" }),
    );
    await expect(addProjectToPluginTree({ ...input, choice, projectId })).resolves.toBe("ran");
    expect(input.confirmGrant).toHaveBeenCalledTimes(1);
    expect(input.grantProject).toHaveBeenCalledWith({
      installationId: "inst-1",
      generation: "gen-1",
      projectId,
    });
    expect(input.run).toHaveBeenCalledWith(
      expect.objectContaining({ generation: "gen-2" }),
      expect.anything(),
      { projectId },
    );
  });

  it("invokes nothing when the person declines or the grant fails", async () => {
    const declined = setup(coordinator());
    declined.confirmGrant.mockResolvedValueOnce(false);
    await expect(addProjectToPluginTree({ ...declined, choice, projectId })).resolves.toBe(
      "cancelled",
    );
    expect(declined.grantProject).not.toHaveBeenCalled();
    expect(declined.run).not.toHaveBeenCalled();

    const failed = setup(coordinator());
    failed.grantProject.mockResolvedValueOnce(null);
    await expect(addProjectToPluginTree({ ...failed, choice, projectId })).resolves.toBe("failed");
    expect(failed.run).not.toHaveBeenCalled();
  });

  it("invokes nothing when the granted installation no longer offers the action or the grant", async () => {
    const withdrawn = setup(coordinator());
    withdrawn.grantProject.mockResolvedValueOnce(
      coordinator({ projectIds: [projectId], capabilities: ["threads.read", "ui.native-trees"] }),
    );
    await expect(addProjectToPluginTree({ ...withdrawn, choice, projectId })).resolves.toBe(
      "failed",
    );
    const ungranted = setup(coordinator());
    ungranted.grantProject.mockResolvedValueOnce(coordinator());
    await expect(addProjectToPluginTree({ ...ungranted, choice, projectId })).resolves.toBe(
      "failed",
    );
    expect(withdrawn.run).not.toHaveBeenCalled();
    expect(ungranted.run).not.toHaveBeenCalled();
  });
});
