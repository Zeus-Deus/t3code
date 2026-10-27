import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";

/**
 * Where the project chooser and add-folder flow hand a project instead of opening a draft.
 * Route params cannot carry the callback, so routes carry a token for it.
 */
export interface ProjectDestination {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly choose: (project: ScopedProjectRef) => void;
}

const destinations = new Map<string, ProjectDestination>();
// Unique across launches too, so a chooser route restored after a relaunch never matches.
const launch = Date.now().toString(36);
let registered = 0;

const tokenOf = (param: string | ReadonlyArray<string> | undefined) =>
  typeof param === "string" ? param : param?.[0];

export function registerProjectDestination(destination: ProjectDestination): string {
  registered += 1;
  const token = `${launch}-${registered}`;
  destinations.set(token, destination);
  return token;
}

/** Null for ordinary routes, and for a token that was used, released, or lost with a relaunch. */
export function readProjectDestination(
  param: string | ReadonlyArray<string> | undefined,
): ProjectDestination | null {
  const token = tokenOf(param);
  return token === undefined ? null : (destinations.get(token) ?? null);
}

/** One choice per destination: the first taker gets it, later ones get null. */
export function takeProjectDestination(
  param: string | ReadonlyArray<string> | undefined,
): ProjectDestination | null {
  const destination = readProjectDestination(param);
  const token = tokenOf(param);
  if (token !== undefined) destinations.delete(token);
  return destination;
}

export function releaseProjectDestination(param: string | ReadonlyArray<string> | undefined) {
  const token = tokenOf(param);
  if (token !== undefined) destinations.delete(token);
}

export const projectDestinationOffers = (
  destination: ProjectDestination | null,
  environmentId: EnvironmentId,
) => destination === null || destination.environmentIds.includes(environmentId);
