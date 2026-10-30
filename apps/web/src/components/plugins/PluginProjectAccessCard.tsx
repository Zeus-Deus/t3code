import { pluginProjectAccessRequest } from "@t3tools/client-runtime/plugins";
import {
  buildProjectGroups,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PluginInstallation,
  PluginProjectAccessRequest,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { pluginEnvironment, usePluginCatalogue } from "../../state/plugins";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { pluginFailureMessage } from "./usePluginActions";

interface PluginProjectAccess {
  readonly installation: PluginInstallation;
  readonly request: PluginProjectAccessRequest;
  readonly projectTitle: string;
  readonly workspaceRoot: string;
  /** Set when the folder alone would not say which machine this grant is about. */
  readonly environmentLabel: string | null;
}

/** The request to show in this thread. A project this client cannot name never shows a card. */
export function usePluginProjectAccess(threadRef: ScopedThreadRef): PluginProjectAccess | null {
  const { environmentId, threadId } = threadRef;
  const { installations } = usePluginCatalogue(environmentId);
  const projects = useProjects();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environment = useEnvironment(environmentId);
  const find = (projectId: ProjectId) =>
    projects.find((entry) => entry.environmentId === environmentId && entry.id === projectId);
  const access = pluginProjectAccessRequest(
    installations,
    threadId,
    (projectId) => find(projectId) !== undefined,
  );
  const project = access === null ? undefined : find(access.request.projectId);
  if (access === null || project === undefined) return null;
  const group = buildProjectGroups({ projects, settings: groupingSettings }).find((entry) =>
    entry.members.some(
      (member) =>
        member.project.environmentId === environmentId && member.project.id === project.id,
    ),
  );
  const spansEnvironments =
    new Set(group?.members.map((member) => member.project.environmentId)).size > 1;
  return {
    ...access,
    projectTitle: project.title,
    workspaceRoot: project.workspaceRoot,
    environmentLabel:
      environmentId !== primaryEnvironmentId || spansEnvironments
        ? (environment?.label ?? null)
        : null,
  };
}

/**
 * Everything here comes from the host: the plugin supplied only ids, so its text cannot change what
 * the person is agreeing to. The answer is available to a person's session alone, never to tools.
 */
export function PluginProjectAccessCard(props: {
  readonly environmentId: EnvironmentId;
  readonly access: PluginProjectAccess;
}) {
  const { environmentId, access } = props;
  const { installation, request, projectTitle, workspaceRoot, environmentLabel } = access;
  const pluginName = installation.manifest.name;
  const destination = installation.manifest.nativeTrees?.[0]?.title ?? pluginName;
  const answer = useAtomCommand(pluginEnvironment.answerProjectAccess, { reportFailure: false });
  const canAnswer = useAtomValue(
    pluginEnvironment.answerProjectAccess.permissionAtom(environmentId),
  );
  const [answering, setAnswering] = useState(false);

  const respond = async (decision: "grant" | "decline") => {
    setAnswering(true);
    const result = await answer({
      environmentId,
      input: {
        installationId: installation.installationId,
        generation: installation.generation,
        projectId: request.projectId,
        decision,
        shown: { title: projectTitle, workspaceRoot },
      },
    }).finally(() => setAnswering(false));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: `Unable to answer ${pluginName}`,
        description: pluginFailureMessage(squashAtomCommandFailure(result)),
      });
    }
  };

  return (
    <div className="chat-content-lane">
      <div
        role="group"
        aria-label={`${pluginName} project request`}
        className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium wrap-anywhere text-foreground">
            Bring {projectTitle} into {destination}?
          </p>
          <p className="text-sm wrap-anywhere text-muted-foreground">
            This work belongs there, so its coordinator should run it. {pluginName} will be able to
            see {projectTitle}'s threads.
          </p>
          <p className="text-xs text-muted-foreground/80">
            It can use this project with the permissions you already gave it.
          </p>
          {/* The title is editable by agents; the grant goes to this folder's project. */}
          <p className="pt-1 font-mono text-xs wrap-anywhere text-muted-foreground">
            {environmentLabel === null ? workspaceRoot : `${environmentLabel}: ${workspaceRoot}`}
          </p>
        </div>
        {canAnswer ? (
          <div className="flex min-w-0 items-center justify-end gap-2">
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              disabled={answering}
              onClick={() => void respond("decline")}
            >
              Not now
            </Button>
            <Button
              type="button"
              size="xs"
              disabled={answering}
              onClick={() => void respond("grant")}
            >
              <span className="max-w-40 truncate">Add {projectTitle}</span>
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Only a session that manages access here can answer this.
          </p>
        )}
      </div>
    </div>
  );
}
