import { EnvironmentId, ProjectId, ThreadId, type PluginInstallation } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  answers: [] as unknown[],
  canAnswer: true,
  installations: [] as PluginInstallation[],
  primaryEnvironmentId: "environment-test",
  projects: [] as unknown[],
}));

vi.mock(import("../../state/plugins"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const refused = Atom.make(false);
  return {
    ...actual,
    pluginEnvironment: {
      ...actual.pluginEnvironment,
      answerProjectAccess: {
        ...actual.pluginEnvironment.answerProjectAccess,
        permissionAtom: () => (state.canAnswer ? allowed : refused),
      },
    },
    usePluginCatalogue: () => ({
      availability: "available" as const,
      installations: state.installations,
      loaded: true,
      error: null,
    }),
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => state.projects as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: () => ({ label: "build-box" }) as never,
  usePrimaryEnvironmentId: () => state.primaryEnvironmentId as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => async (input: unknown) => {
    state.answers.push(input);
    return AsyncResult.success(undefined);
  }) as never,
}));

import { PluginProjectAccessCard, usePluginProjectAccess } from "./PluginProjectAccessCard";

const environmentId = EnvironmentId.make("environment-test");
const threadId = ThreadId.make("conversation");
const projectId = ProjectId.make("project-alpha");
const digest = "a".repeat(64);

const project = (title: string, workspaceRoot: string) => ({
  id: projectId,
  environmentId,
  title,
  workspaceRoot,
  repositoryIdentity: null,
  createdAt: "2026-10-23T12:00:00.000Z",
  updatedAt: "2026-10-23T12:00:00.000Z",
});

function setup(canAnswer = true) {
  state.answers = [];
  state.canAnswer = canAnswer;
  state.primaryEnvironmentId = environmentId;
  state.projects = [project("alpha-service", "/srv/alpha-service")];
  state.installations = [
    {
      installationId: "inst-coordinator",
      generation: "gen-1",
      manifest: {
        id: "examples.coordinator",
        name: "Project Coordinator",
        version: "1.0.0",
        apiVersion: 1,
        entry: "plugin.mjs",
        capabilities: ["projects.request-access"],
        actions: [{ id: "decided", title: "Decided", placements: [] }],
        views: [],
        nativeTrees: [{ id: "projects", title: "Projects" }],
        settings: [],
      },
      source: { kind: "local", directory: "/plugins/coordinator" },
      digest,
      enabled: true,
      consentedDigest: digest,
      status: "idle",
      error: null,
      settings: {},
      grants: { capabilities: ["projects.request-access"], projectIds: [] },
      projectAccessRequests: [
        { projectId, threadId, actionId: "decided", requestedAt: "2026-10-23T12:00:00.000Z" },
      ],
      updatedAt: "2026-10-23T12:00:00.000Z",
    },
  ];
}

function Card() {
  const access = usePluginProjectAccess({ environmentId, threadId });
  return access === null ? null : (
    <PluginProjectAccessCard environmentId={environmentId} access={access} />
  );
}

it("names the real project and plugin and answers for exactly that project", async () => {
  setup();
  await using screen = await render(<Card />);
  await expect.element(screen.getByText("Bring alpha-service into Projects?")).toBeVisible();
  await expect
    .element(screen.getByText(/Project Coordinator will be able to see alpha-service's threads/))
    .toBeVisible();
  await expect.element(screen.getByText("/srv/alpha-service", { exact: true })).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Add alpha-service" }));
  await vi.waitFor(() =>
    expect(state.answers).toEqual([
      {
        environmentId,
        input: {
          installationId: "inst-coordinator",
          generation: "gen-1",
          projectId,
          decision: "grant",
          shown: { title: "alpha-service", workspaceRoot: "/srv/alpha-service" },
        },
      },
    ]),
  );
});

it("names the environment of a project that is not local", async () => {
  setup();
  state.primaryEnvironmentId = "environment-laptop";
  await using screen = await render(<Card />);
  await expect.element(screen.getByText("build-box: /srv/alpha-service")).toBeVisible();
});

it("answers for what it shows after a project changes while the card is open", async () => {
  setup();
  await using screen = await render(<Card />);
  await expect.element(screen.getByText("/srv/alpha-service", { exact: true })).toBeVisible();

  state.projects = [project("Sandbox", "/srv/sandbox")];
  await screen.rerender(<Card />);
  await expect.element(screen.getByText("/srv/sandbox", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Add Sandbox" }));
  await vi.waitFor(() =>
    expect(state.answers).toMatchObject([
      { input: { shown: { title: "Sandbox", workspaceRoot: "/srv/sandbox" } } },
    ]),
  );
});

it("shows no card for a project this client does not know", async () => {
  setup();
  state.projects = [];
  await using screen = await render(<Card />);
  await expect.element(screen.getByRole("group")).not.toBeInTheDocument();
});

it("offers no answer to a session that cannot manage access", async () => {
  setup(false);
  await using screen = await render(<Card />);
  await expect
    .element(screen.getByText("Only a session that manages access here can answer this."))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Add alpha-service" }))
    .not.toBeInTheDocument();
});
