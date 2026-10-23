import { boundedText, inspectRepository, repositoryDiff } from "./git.mjs";

export function activate(ctx) {
  const inspect = async (invocation) => {
    const signal = AbortSignal.any([invocation.signal, AbortSignal.timeout(5000)]);
    const repositoryPath = await ctx.settings.get("repositoryPath");
    return { snapshot: await inspectRepository(repositoryPath, signal), signal };
  };

  ctx.handle("action:open-inspector", () => ({
    intents: [{ type: "view.open", viewId: "repository" }],
  }));
  ctx.handle("view:repository:inspect", async (_input, invocation) => ({
    data: (await inspect(invocation)).snapshot,
  }));
  ctx.handle("action:inspect", async (_input, invocation) => {
    const { snapshot } = await inspect(invocation);
    return {
      message: `Branch ${boundedText(snapshot.branch, 512)}: ${snapshot.files.length} changed file${snapshot.files.length === 1 ? "" : "s"}${snapshot.truncated ? " (partial snapshot)" : ""}.`,
      data: snapshot,
    };
  });
  ctx.handle("view:repository:diff", async (input, invocation) => {
    const { snapshot, signal } = await inspect(invocation);
    return { data: await repositoryDiff(snapshot, input?.path, signal) };
  });
  const insertReview = async (_input, invocation) => {
    if (!invocation.context?.threadId) {
      throw new Error(
        "Open Repository Lens from a thread to insert a review prompt into its composer.",
      );
    }
    const { snapshot } = await inspect(invocation);
    const files = snapshot.files.map(
      (file) =>
        `- [${file.indexStatus}${file.worktreeStatus}] ${JSON.stringify(file.path)}${file.originalPath ? ` (from ${JSON.stringify(file.originalPath)})` : ""}`,
    );
    const details = [
      `Repository: ${JSON.stringify(snapshot.repositoryPath)}`,
      `Branch: ${JSON.stringify(snapshot.branch)}`,
      "Changed files (index/worktree status):",
      ...(files.length ? files : ["Working tree is clean."]),
    ].join("\n");
    const summary = boundedText(details, 14 * 1024);
    const partial = snapshot.truncated || Buffer.byteLength(details) > 14 * 1024;
    return {
      message: "Review request prepared.",
      intents: [
        {
          type: "composer.insert",
          text: `${summary}${partial ? "\nFile list is partial; inspect the remaining changes before reviewing." : ""}\n\nReview this repository and its changes for correctness. Report findings without editing files.\n`,
        },
      ],
    };
  };
  ctx.handle("view:repository:insert-review", insertReview);
  ctx.handle("action:insert-review", insertReview);
}
