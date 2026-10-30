import type {
  PluginInstallation,
  PluginProjectAccessRequest,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import { isPluginActive } from "./model.ts";

const PROJECT_ACCESS_CAPABILITY = "projects.request-access";

/**
 * The project request a thread should show now. One at a time, oldest first: a plugin's next
 * request takes the card's place only once this one is answered, so it can neither pile up cards
 * nor slide a different project under the pointer.
 */
export function pluginProjectAccessRequest(
  installations: ReadonlyArray<PluginInstallation>,
  threadId: ThreadId,
  /** Unknown ids are stored too; they must not hold up a real project's card. */
  isKnownProject: (projectId: ProjectId) => boolean,
): {
  readonly installation: PluginInstallation;
  readonly request: PluginProjectAccessRequest;
} | null {
  for (const installation of installations) {
    if (
      !isPluginActive(installation) ||
      !installation.grants.capabilities.includes(PROJECT_ACCESS_CAPABILITY)
    )
      continue;
    const request = installation.projectAccessRequests?.find(
      (entry) =>
        entry.threadId === threadId &&
        entry.declinedAt === undefined &&
        !installation.grants.projectIds.includes(entry.projectId) &&
        isKnownProject(entry.projectId),
    );
    if (request !== undefined) return { installation, request };
  }
  return null;
}
