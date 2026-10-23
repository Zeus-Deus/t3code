export function activate(ctx) {
  ctx.handle("action:exercise", async (_input, invocation) => {
    const threadId = invocation.context.threadId;
    const projectId = invocation.context.projectId;
    const thread = await ctx.threads.read({ threadId });
    await ctx.storage.set("lastTitle", thread.title);
    const title = await ctx.storage.get("lastTitle");
    await ctx.storage.delete("temporary");
    const created = await ctx.threads.create({
      projectId,
      title: "Frozen v1 review",
      text: "Review the public API.",
      idempotencyKey: "review",
    });
    return {
      data: { apiVersion: ctx.apiVersion, title, threadId: created.threadId },
      intents: [
        { type: "composer.insert", text: "Review request prepared." },
        { type: "preview.open", url: "https://example.com/review" },
        { type: "thread.reveal", threadId: created.threadId },
        { type: "view.open", viewId: "summary" },
      ],
    };
  });
  ctx.handle("view:summary:read", async () => ({
    data: { title: await ctx.storage.get("lastTitle") },
  }));
  ctx.events.onRunFinalized(async (event) => {
    if (!(await ctx.settings.get("autoSend"))) return;
    await ctx.threads.send({
      threadId: event.threadId,
      text: "Review this completed run.",
      idempotencyKey: `review-${event.deliveryId}`,
    });
    await ctx.storage.set("lastDelivery", event.deliveryId);
  });
}
