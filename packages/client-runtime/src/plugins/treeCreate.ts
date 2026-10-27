import type {
  PluginAction,
  PluginActionContext,
  PluginGrantProjectInput,
  PluginInstallation,
  ProjectId,
} from "@t3tools/contracts";

import { findPluginTreeInstallation, type PluginSidebarTreeOption } from "./sidebarViews.ts";

const TREE_PROJECTS_CAPABILITY = "ui.native-tree-projects";

type TreeChoice = Pick<PluginSidebarTreeOption, "pluginId" | "tree">;

export interface PluginTreeCreateTarget {
  readonly installation: PluginInstallation;
  readonly action: PluginAction;
  readonly title: string;
}

/**
 * On one environment, the installation that adds projects to a tree and the action its own
 * manifest declares for that, while it holds ui.native-tree-projects; otherwise null.
 */
export function pluginTreeCreateTarget(
  installations: ReadonlyArray<PluginInstallation>,
  choice: TreeChoice,
): PluginTreeCreateTarget | null {
  const installation = findPluginTreeInstallation(installations, choice);
  if (installation === null || !installation.grants.capabilities.includes(TREE_PROJECTS_CAPABILITY))
    return null;
  const create = installation.manifest.nativeTrees?.find(
    (tree) => tree.id === choice.tree.id,
  )?.create;
  const action =
    create === undefined
      ? undefined
      : installation.manifest.actions.find((entry) => entry.id === create.actionId);
  return create === undefined || action === undefined
    ? null
    : { installation, action, title: create.title };
}

/**
 * Runs a tree's create action for a project the person chose. A project the plugin was not
 * granted is granted only after the person confirms; declining or a failed grant runs nothing.
 */
export async function addProjectToPluginTree(input: {
  readonly target: PluginTreeCreateTarget;
  readonly choice: TreeChoice;
  readonly projectId: ProjectId;
  readonly confirmGrant: () => Promise<boolean>;
  /** Null when the grant failed; the caller reports why. */
  readonly grantProject: (grant: PluginGrantProjectInput) => Promise<PluginInstallation | null>;
  readonly run: (
    installation: PluginInstallation,
    action: PluginAction,
    context: PluginActionContext,
  ) => Promise<void>;
}): Promise<"ran" | "cancelled" | "failed"> {
  const { projectId } = input;
  let target = input.target;
  if (!target.installation.grants.projectIds.includes(projectId)) {
    if (!(await input.confirmGrant())) return "cancelled";
    const granted = await input.grantProject({
      installationId: target.installation.installationId,
      generation: target.installation.generation,
      projectId,
    });
    const next = granted === null ? null : pluginTreeCreateTarget([granted], input.choice);
    if (next === null || !next.installation.grants.projectIds.includes(projectId)) return "failed";
    target = next;
  }
  await input.run(target.installation, target.action, { projectId });
  return "ran";
}
