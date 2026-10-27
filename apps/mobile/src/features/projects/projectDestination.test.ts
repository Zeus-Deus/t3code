import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  projectDestinationOffers,
  readProjectDestination,
  registerProjectDestination,
  releaseProjectDestination,
  takeProjectDestination,
} from "./projectDestination";

const local = EnvironmentId.make("environment-local");
const remote = EnvironmentId.make("environment-remote");
const project = { environmentId: local, projectId: ProjectId.make("project-1") };

describe("project destinations", () => {
  it("hands one chosen project to the caller, once", () => {
    const choose = vi.fn();
    const token = registerProjectDestination({ environmentIds: [local], choose });
    expect(readProjectDestination([token])).not.toBeNull();
    takeProjectDestination(token)?.choose(project);
    expect(takeProjectDestination(token)).toBeNull();
    expect(readProjectDestination(token)).toBeNull();
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledWith(project);
  });

  it("forgets a destination whose chooser closed without a choice", () => {
    const choose = vi.fn();
    const token = registerProjectDestination({ environmentIds: [local], choose });
    releaseProjectDestination(token);
    expect(takeProjectDestination(token)).toBeNull();
    expect(choose).not.toHaveBeenCalled();
  });

  it("reads no destination from a route without a registered token", () => {
    expect(readProjectDestination(undefined)).toBeNull();
    expect(readProjectDestination("restored-after-relaunch")).toBeNull();
  });

  it("offers only the destination's environments, and every environment otherwise", () => {
    const destination = { environmentIds: [local], choose: vi.fn() };
    expect(projectDestinationOffers(destination, local)).toBe(true);
    expect(projectDestinationOffers(destination, remote)).toBe(false);
    expect(projectDestinationOffers(null, remote)).toBe(true);
  });
});
