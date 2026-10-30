import { EnvironmentId, ProjectId, type ProjectCloneSnapshot } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../rpc/atomRegistry";

const mocks = vi.hoisted(() => ({ clones: null as unknown }));

vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  const { EnvironmentId } = await import("@t3tools/contracts");
  return {
    environmentServerConfigsAtom: Atom.make(
      new Map([[EnvironmentId.make("environment-local"), {}]]),
    ),
  };
});

vi.mock("./sourceControl", async () => {
  const { Atom } = await import("effect/reactivity");
  const { AsyncResult } = await import("effect/reactivity");
  mocks.clones = Atom.make(AsyncResult.success([]));
  return { sourceControlEnvironment: { projectClones: () => mocks.clones } };
});

import { waitForProjectCloneDone } from "./projectClones";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const clone = (phase: ProjectCloneSnapshot["phase"]) =>
  ({ projectId, phase }) as ProjectCloneSnapshot;
const publish = (clones: ReadonlyArray<ProjectCloneSnapshot>) =>
  appAtomRegistry.set(
    mocks.clones as Atom.Writable<AsyncResult.AsyncResult<ReadonlyArray<ProjectCloneSnapshot>>>,
    AsyncResult.success(clones),
  );

describe("waitForProjectCloneDone", () => {
  it("waits through a failure until a retry finishes the clone", async () => {
    publish([clone("running")]);
    const settled = vi.fn();
    const waiting = waitForProjectCloneDone({ environmentId, projectId }).then(settled);

    publish([clone("failed")]);
    publish([clone("running")]);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    publish([clone("done")]);
    await waiting;
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ phase: "done" }));
  });

  it("ends with null when the failed project is removed", async () => {
    publish([clone("failed")]);
    const waiting = waitForProjectCloneDone({ environmentId, projectId });
    publish([]);
    await expect(waiting).resolves.toBeNull();
  });
});
