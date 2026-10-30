import { useAtomValue } from "@effect/atom-react";
import { parseScopedProjectKey, scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectCloneSnapshot, ScopedProjectRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./server";
import { sourceControlEnvironment } from "./sourceControl";

const EMPTY_CLONES: ReadonlyArray<ProjectCloneSnapshot> = [];
const EMPTY_CLONE_ATOM = Atom.make<ProjectCloneSnapshot | null>(null).pipe(
  Atom.withLabel("web-project-clone:empty"),
);

export const environmentProjectClonesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<ProjectCloneSnapshot> => {
    if (!get(environmentServerConfigsAtom).has(environmentId)) return EMPTY_CLONES;
    const result = get(sourceControlEnvironment.projectClones({ environmentId, input: {} }));
    return AsyncResult.getOrElse(result, () => EMPTY_CLONES);
  }).pipe(Atom.withLabel(`web-project-clones:${environmentId}`)),
);

const projectCloneAtom = Atom.family((key: string) => {
  const ref = parseScopedProjectKey(key);
  return Atom.make((get): ProjectCloneSnapshot | null => {
    if (ref === null) return null;
    const clones = get(environmentProjectClonesAtom(ref.environmentId));
    return clones.find((clone) => clone.projectId === ref.projectId) ?? null;
  }).pipe(Atom.withLabel(`web-project-clone:${key}`));
});

export function useProjectClone(ref: ScopedProjectRef | null): ProjectCloneSnapshot | null {
  return useAtomValue(ref === null ? EMPTY_CLONE_ATOM : projectCloneAtom(scopedProjectKey(ref)));
}

export function useEnvironmentProjectClones(
  environmentId: EnvironmentId,
): ReadonlyArray<ProjectCloneSnapshot> {
  return useAtomValue(environmentProjectClonesAtom(environmentId));
}

/** Resolves with the clone once `isSettled` accepts it, or null once it is removed. */
export function waitForProjectClone(
  ref: ScopedProjectRef,
  isSettled: (clone: ProjectCloneSnapshot) => boolean,
) {
  return new Promise<ProjectCloneSnapshot | null>((resolve) => {
    const atom = environmentProjectClonesAtom(ref.environmentId);
    let seen = false;
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const check = (clones: ReadonlyArray<ProjectCloneSnapshot>) => {
      if (settled) return;
      const clone = clones.find((candidate) => candidate.projectId === ref.projectId);
      if (clone) seen = true;
      const result = clone && isSettled(clone) ? clone : !clone && seen ? null : undefined;
      if (result === undefined) return;
      settled = true;
      unsubscribe?.();
      resolve(result);
    };
    unsubscribe = appAtomRegistry.subscribe(atom, check);
    check(appAtomRegistry.get(atom));
  });
}

const silencedCloneToasts = new Set<string>();

/**
 * Keeps a clone's progress out of toasts once the user is looking at its
 * project, whose composer shows the same progress. Failures still toast
 * whenever the project is not on screen.
 */
export function silenceProjectCloneToasts(ref: ScopedProjectRef) {
  silencedCloneToasts.add(scopedProjectKey(ref));
}

export function isProjectCloneToastSilenced(ref: ScopedProjectRef): boolean {
  return silencedCloneToasts.has(scopedProjectKey(ref));
}
