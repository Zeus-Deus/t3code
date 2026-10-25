export function activate(ctx) {
  ctx.handle("action:open-pad", () => ({
    intents: [{ type: "view.open", viewId: "quote-pad" }],
  }));
  ctx.handle("view:quote-pad:insert", (input) => {
    const text = typeof input?.text === "string" ? input.text.trim().slice(0, 8000) : "";
    if (!text) return { message: "Enter text to insert into the composer." };
    return {
      message: "Text inserted into the composer.",
      intents: [{ type: "composer.insert", text }],
    };
  });
  ctx.handle("action:quote", (_input, invocation) => {
    const selection = invocation.context?.selection?.trim();
    if (!selection) {
      return { message: "Select text in a message, then choose Review selected text." };
    }
    const quote = selection
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return {
      message: "Review prompt inserted into the composer.",
      intents: [
        {
          type: "composer.insert",
          text: `${quote}\n\nPlease review this and suggest improvements.\n`,
        },
      ],
    };
  });

  ctx.handle("action:ticket", async (input, invocation) => {
    const selection =
      typeof input?.ticket === "string" ? input.ticket : invocation.context?.selection;
    const ticket = selection?.trim();
    if (!ticket || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(ticket)) {
      return { message: "Select a ticket identifier, such as 1234 or PROJ-1234." };
    }
    const template = await ctx.settings.get("ticketUrl");
    if (typeof template !== "string" || !template.includes("{ticket}")) {
      return {
        message: "Set a ticket URL template containing {ticket} in this plugin's settings.",
      };
    }
    const url = new URL(template.replaceAll("{ticket}", encodeURIComponent(ticket)));
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { message: "The ticket URL must use HTTP or HTTPS." };
    }
    return {
      message: `Open ticket ${ticket}.`,
      data: { url: url.href },
      intents: [{ type: "preview.open", url: url.href }],
    };
  });
}
