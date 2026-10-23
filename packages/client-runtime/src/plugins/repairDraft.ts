import type {
  EnvironmentId,
  PluginRepairWorkspace,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";

export interface PluginRepairDraftDependencies<Draft> {
  readonly findProject: (environmentId: EnvironmentId, directory: string) => ProjectId | null;
  /** Adds the repair folder as a project. It already exists, so nothing is created on disk. */
  readonly createProject: (environmentId: EnvironmentId, directory: string) => Promise<ProjectId>;
  readonly waitForProject: (projectRef: ScopedProjectRef) => Promise<void>;
  /** Opens an empty draft in the folder itself, never a worktree: staging reads the folder. */
  readonly openDraft: (projectRef: ScopedProjectRef) => Promise<Draft | null>;
  readonly setDraftText: (draft: Draft, text: string) => void;
}

export type PluginRepairDraftResult<Draft> =
  | { readonly ok: true; readonly projectId: ProjectId; readonly draft: Draft }
  | {
      readonly ok: false;
      readonly step: "project" | "draft";
      readonly directory: string;
      readonly cause: unknown;
    };

/**
 * Puts the server's redacted diagnostics into an ordinary new-thread draft for the repair folder.
 * The draft is never sent: the user picks the agent and decides when to run it.
 */
export async function openPluginRepairDraft<Draft>(
  environmentId: EnvironmentId,
  workspace: PluginRepairWorkspace,
  dependencies: PluginRepairDraftDependencies<Draft>,
): Promise<PluginRepairDraftResult<Draft>> {
  let projectId = dependencies.findProject(environmentId, workspace.directory);
  if (projectId === null) {
    try {
      projectId = await dependencies.createProject(environmentId, workspace.directory);
      await dependencies.waitForProject({ environmentId, projectId });
    } catch (cause) {
      return { ok: false, step: "project", directory: workspace.directory, cause };
    }
  }
  let draft: Draft | null;
  try {
    draft = await dependencies.openDraft({ environmentId, projectId });
  } catch (cause) {
    return { ok: false, step: "draft", directory: workspace.directory, cause };
  }
  if (draft === null) {
    return { ok: false, step: "draft", directory: workspace.directory, cause: null };
  }
  dependencies.setDraftText(draft, workspace.draft);
  return { ok: true, projectId, draft };
}
