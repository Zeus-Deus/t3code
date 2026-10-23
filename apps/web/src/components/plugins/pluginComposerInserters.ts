import {
  composerTargetKey,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "../../composerDraftStore";

type Inserter = (text: string) => boolean;

// Mounted composers by target, so plugin text reaches the live editor at its cursor state
// instead of racing it through the store.
const inserters = new Map<string, Inserter>();

export function registerPluginComposerInserter(target: ComposerThreadTarget, insert: Inserter) {
  const key = composerTargetKey(target);
  inserters.set(key, insert);
  return () => {
    if (inserters.get(key) === insert) inserters.delete(key);
  };
}

/**
 * Appends to the composer of `target` only. With no composer mounted for it, the text joins that
 * thread's saved draft and shows up when the user returns.
 */
export function insertPluginComposerText(target: ComposerThreadTarget, text: string): boolean {
  const live = inserters.get(composerTargetKey(target));
  if (live !== undefined) return live(text);
  const store = useComposerDraftStore.getState();
  const prompt = store.getComposerDraft(target)?.prompt ?? "";
  const separator = prompt === "" ? "" : prompt.endsWith("\n") ? "\n" : "\n\n";
  store.setPrompt(target, `${prompt}${separator}${text}`);
  return true;
}
