const LIMIT = 100;

export function activate(ctx) {
  let pending = Promise.resolve();
  const serial = (operation) => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  const read = async () => {
    const items = await ctx.storage.get("items");
    return Array.isArray(items) ? items : [];
  };
  const write = (items) => ctx.storage.set("items", items.slice(0, LIMIT));
  const itemInput = (input) => {
    if (input === null || typeof input !== "object" || typeof input.id !== "string") {
      throw new Error("An item id is required.");
    }
    return input.id;
  };

  ctx.handle("action:open-board", () => ({ intents: [{ type: "view.open", viewId: "board" }] }));
  ctx.handle("action:save-selection", (_input, invocation) =>
    serial(async () => {
      const text = invocation.context?.selection?.trim();
      if (!text) return { message: "Select text in a message to save it to the workflow board." };
      const items = await read();
      if (!items.some((item) => item.id === invocation.operationId)) {
        await write([
          {
            id: invocation.operationId,
            text: text.slice(0, 8000),
            ...(invocation.context?.threadId ? { threadId: invocation.context.threadId } : {}),
            createdAt: new Date().toISOString(),
          },
          ...items,
        ]);
      }
      return {
        message: "Saved to the workflow board.",
        intents: [{ type: "view.open", viewId: "board" }],
      };
    }),
  );

  ctx.handle("action:new-review-thread", async (input, invocation) => {
    const projectId = invocation.context?.projectId;
    if (!projectId) return { message: "Run this action from a project thread." };
    const text =
      typeof input?.text === "string"
        ? input.text.trim().slice(0, 8000)
        : "Review the project and report one concrete improvement. Do not edit files.";
    if (!text) return { message: "A review prompt is required." };
    const result = await ctx.threads.create({
      projectId,
      title: "Plugin review",
      text,
      idempotencyKey: "new-review",
    });
    return {
      message: "Review thread created.",
      data: result,
      intents: [{ type: "thread.reveal", threadId: result.threadId }],
    };
  });

  ctx.handle("view:board:list", () => serial(async () => ({ data: { items: await read() } })));
  ctx.handle("view:board:add", (input, invocation) =>
    serial(async () => {
      const text = typeof input?.text === "string" ? input.text.trim().slice(0, 8000) : "";
      if (!text) return { message: "Enter a note first." };
      const items = await read();
      if (!items.some((item) => item.id === invocation.operationId)) {
        await write([
          {
            id: invocation.operationId,
            text,
            createdAt: new Date().toISOString(),
            ...(invocation.context?.threadId ? { threadId: invocation.context.threadId } : {}),
          },
          ...items,
        ]);
      }
      return { data: { items: await read() } };
    }),
  );
  ctx.handle("view:board:remove", (input) =>
    serial(async () => {
      const id = itemInput(input);
      await write((await read()).filter((item) => item.id !== id));
      return { data: { items: await read() } };
    }),
  );
  ctx.handle("view:board:review", (input) =>
    serial(async () => {
      const item = (await read()).find((candidate) => candidate.id === itemInput(input));
      if (!item?.threadId) return { message: "This note has no linked thread." };
      const thread = await ctx.threads.read({ threadId: item.threadId });
      return {
        message: `Open ${thread.title}.`,
        intents: [{ type: "thread.reveal", threadId: thread.threadId }],
      };
    }),
  );
  ctx.handle("view:board:followup", (input) =>
    serial(async () => {
      const item = (await read()).find((candidate) => candidate.id === itemInput(input));
      if (!item?.threadId) return { message: "This note has no linked thread." };
      const result = await ctx.threads.send({
        idempotencyKey: "review-note",
        threadId: item.threadId,
        text: `Review this workflow-board note and report your findings without editing files:\n\n${item.text}`,
      });
      return { message: "Review requested.", data: result };
    }),
  );

  ctx.events.onRunFinalized((event) =>
    serial(async () => {
      const items = await read();
      const id = `run-${event.deliveryId}`;
      if (!items.some((item) => item.id === id)) {
        await write([
          {
            id,
            threadId: event.threadId,
            runId: event.runId,
            outcome: event.outcome,
            text: event.summary || `Turn ${event.outcome}.`,
            createdAt: new Date().toISOString(),
          },
          ...items,
        ]);
      }
      // The host gives repeated delivery the same operation identity. Its thread
      // command receipt prevents a second send if this process dies after sending.
      if (event.outcome === "completed" && (await ctx.settings.get("autoFollowup")) === true) {
        await ctx.threads.send({
          idempotencyKey: "completion-review",
          threadId: event.threadId,
          text: "Review the previous result for correctness. Report any issue concisely; do not edit files or request another follow-up.",
        });
      }
    }),
  );
}
