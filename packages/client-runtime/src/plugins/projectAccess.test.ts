import { ProjectId, ThreadId, type PluginInstallation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pluginProjectAccessRequest } from "./projectAccess.ts";
import { pluginInstallationFixture } from "./testFixtures.ts";

const thread = ThreadId.make("conversation");
const first = ProjectId.make("project-first");
const second = ProjectId.make("project-second");
const request = (projectId: ProjectId, threadId = thread) => ({
  projectId,
  threadId,
  actionId: "decided",
  requestedAt: "2026-10-23T12:00:00.000Z",
});
const installation = (overrides: Partial<PluginInstallation>) =>
  pluginInstallationFixture({
    grants: { capabilities: ["projects.request-access"], projectIds: [] },
    ...overrides,
  });

describe("pluginProjectAccessRequest", () => {
  it("shows one request per thread, oldest first", () => {
    const owner = installation({ projectAccessRequests: [request(first), request(second)] });
    expect(pluginProjectAccessRequest([owner], thread)?.request.projectId).toBe(first);
  });

  it.each([
    {
      name: "another thread",
      overrides: { projectAccessRequests: [request(first, ThreadId.make("other"))] },
    },
    {
      name: "a request already declined",
      overrides: {
        projectAccessRequests: [{ ...request(first), declinedAt: "2026-10-23T12:30:00.000Z" }],
      },
    },
    {
      name: "a project granted since",
      overrides: {
        projectAccessRequests: [request(first)],
        grants: { capabilities: ["projects.request-access"], projectIds: [first] },
      },
    },
    {
      name: "a plugin that lost the capability",
      overrides: {
        projectAccessRequests: [request(first)],
        grants: { capabilities: [], projectIds: [] },
      },
    },
    {
      name: "a disabled plugin",
      overrides: { projectAccessRequests: [request(first)], enabled: false },
    },
  ] satisfies ReadonlyArray<{ name: string; overrides: Partial<PluginInstallation> }>)(
    "shows nothing for $name",
    ({ overrides }) => {
      expect(pluginProjectAccessRequest([installation(overrides)], thread)).toBeNull();
    },
  );
});
