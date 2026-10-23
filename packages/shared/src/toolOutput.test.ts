import { describe, expect, it } from "vite-plus/test";

import {
  compactDynamicToolOutput,
  pluginCardFromToolItem,
  MAX_TOOL_OUTPUT_IMAGES,
  toolOutputImages,
  toolOutputIndicatesFailure,
} from "./toolOutput.ts";

describe("compactDynamicToolOutput", () => {
  it("extracts IDs through the MCP result envelopes used by T3 summaries", () => {
    const metadata = { threadId: "thread-1", messageId: "message-1" };
    const json = JSON.stringify({ ...metadata, response: "Private response body" });
    for (const value of [
      { ...metadata, response: "Private response body" },
      { structuredContent: JSON.parse(json), content: "Ignored alternative body" },
      [{ type: "text", text: json }],
      { content: [{ text: { text: json } }], isError: false },
      json,
    ]) {
      expect(compactDynamicToolOutput(value)).toEqual(metadata);
    }
  });

  it("keeps nested thread identity and scalar task IDs without result bodies", () => {
    const output = {
      thread: { threadId: "thread-1", messages: ["Private message"] },
      taskId: "task-1",
      scheduledTaskId: "scheduled-1",
      status: "failed",
      summary: "A child failed; the tool itself succeeded.",
    };
    expect(compactDynamicToolOutput(output)).toEqual({
      thread: { threadId: "thread-1" },
      taskId: "task-1",
      scheduledTaskId: "scheduled-1",
    });
    expect(output.thread.messages).toEqual(["Private message"]);
  });

  it("keeps explicit envelope failure while dropping error text and arbitrary output", () => {
    for (const failure of [
      { isError: true },
      { is_error: true },
      { _tag: "OrchestratorMcpFailure" },
      { error: { message: "Private error" } },
    ]) {
      expect(
        compactDynamicToolOutput({
          ...failure,
          structuredContent: { threadId: "thread-1", error: "Private details" },
        }),
      ).toEqual({ isError: true, threadId: "thread-1" });
    }
    expect(compactDynamicToolOutput("Private plain text")).toBeUndefined();
    expect(compactDynamicToolOutput({ result: { body: "Private result" } })).toBeUndefined();
  });

  it("uses the first result data but combines explicit failure flags across content blocks", () => {
    expect(
      compactDynamicToolOutput([
        { text: JSON.stringify({ threadId: "first" }) },
        { text: JSON.stringify({ threadId: "second", isError: true, error: "Private error" }) },
      ]),
    ).toEqual({ threadId: "first", isError: true });
    expect(
      compactDynamicToolOutput([{ text: "{}" }, { text: JSON.stringify({ threadId: "second" }) }]),
    ).toBeUndefined();
  });

  it("keeps complete thread creation batches and rollback markers without row bodies", () => {
    expect(
      compactDynamicToolOutput({
        threads: [
          { threadId: "created", status: "running", messages: ["Private message"] },
          { threadId: "reverted", status: "rolled_back", error: "Private error" },
          { status: "rolled_back" },
        ],
      }),
    ).toEqual({
      threads: [
        { threadId: "created" },
        { threadId: "reverted", status: "rolled_back" },
        { status: "rolled_back" },
      ],
    });
    expect(compactDynamicToolOutput({ threadId: "reverted", status: "rolled_back" })).toEqual({
      threadId: "reverted",
      status: "rolled_back",
    });
    expect(compactDynamicToolOutput({ threads: [] })).toEqual({ threads: [] });
  });

  it("omits incomplete or oversized creation evidence instead of returning a partial count", () => {
    for (const threads of [
      [{ threadId: "known" }, { title: "No confirmed ID" }],
      Array.from({ length: 101 }, (_, index) => ({ threadId: `thread-${index}` })),
      Array.from({ length: 100 }, (_, index) => ({ threadId: `${index}`.padEnd(256, "x") })),
      [{ threadId: "x".repeat(257) }],
    ]) {
      expect(
        compactDynamicToolOutput({
          threadId: "must-not-be-counted-as-one",
          status: "rolled_back",
          taskId: "task-1",
          threads,
        }),
      ).toEqual({ taskId: "task-1" });
    }
    const normalBatch = {
      threads: Array.from({ length: 100 }, (_, index) => ({
        threadId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
    };
    expect(compactDynamicToolOutput(normalBatch)).toEqual(normalBatch);
    expect(
      new TextEncoder().encode(JSON.stringify(compactDynamicToolOutput(normalBatch))).byteLength,
    ).toBeLessThanOrEqual(8_192);
  });

  it("bounds parsing and envelope scanning while preserving an outer failure marker", () => {
    const oversizedJson = JSON.stringify({ threadId: "hidden", body: "😄".repeat(5_000) });
    for (const content of [
      "x".repeat(1_000_000),
      oversizedJson,
      Array.from({ length: 33 }, () => ({ text: JSON.stringify({ threadId: "hidden" }) })),
      { content: { content: { content: { content: { threadId: "too-deep" } } } } },
    ]) {
      expect(compactDynamicToolOutput({ isError: true, content })).toEqual({ isError: true });
    }
    expect(compactDynamicToolOutput({ threadId: "known", body: "x".repeat(1_000_000) })).toEqual({
      threadId: "known",
    });
  });
});

describe("plugin card tool output", () => {
  it("keeps a small valid card in a legal large plugin result from a text-only provider", () => {
    const card = {
      installationId: "tasks",
      generation: "generation-1",
      dataOwner: "retained-tasks",
      viewId: "launch",
      summary: "Proposed two tasks.",
      data: { planId: "plan-1" },
    };
    const result = { card, message: card.summary, data: "x".repeat(20_000) };
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(128_000);
    expect(compactDynamicToolOutput({ structuredContent: result })).toEqual({ card });
    const textOutput = [{ type: "text", text: JSON.stringify(result) }];
    expect(compactDynamicToolOutput(textOutput, "t3-code.t3_plugin_invoke")).toEqual({ card });
    expect(
      pluginCardFromToolItem({ toolName: "t3-code.t3_plugin_invoke", output: textOutput }),
    ).toEqual(card);
    // Arbitrary tools retain the smaller parsing budget.
    expect(compactDynamicToolOutput(textOutput)).toBeUndefined();
    expect(compactDynamicToolOutput(textOutput, "mcp__other__t3_plugin_invoke")).toBeUndefined();
    expect(
      compactDynamicToolOutput(
        JSON.stringify({ ...result, data: "x".repeat(128_000) }),
        "t3-code.t3_plugin_invoke",
      ),
    ).toBeUndefined();
  });

  it("preserves a plugin card across provider result envelopes without arbitrary output", () => {
    const card = {
      installationId: "tasks",
      generation: "generation-1",
      dataOwner: "retained-tasks",
      viewId: "launch",
      summary: "Proposed two tasks.",
      data: { planId: "plan-1" },
    };
    const result = { card, message: card.summary, privateValue: "not compact metadata" };
    for (const output of [
      result,
      { structuredContent: result },
      { content: [{ type: "text", text: JSON.stringify(result) }] },
      [{ type: "text", text: { text: JSON.stringify(result) } }],
      JSON.stringify(result),
    ]) {
      expect(compactDynamicToolOutput(output)).toEqual({ card });
    }
  });

  it("keeps the existing metadata budget when a card accompanies other tool references", () => {
    const id = "漢".repeat(256);
    const card = {
      installationId: "tasks",
      generation: "generation-1",
      dataOwner: "retained-tasks",
      viewId: "launch",
      summary: "漢".repeat(600),
      data: "b".repeat(2000),
    };
    expect(compactDynamicToolOutput({ card })).toEqual({ card });
    const output = compactDynamicToolOutput({
      card,
      threadId: id,
      messageId: id,
      taskId: id,
      scheduledTaskId: id,
      thread: { threadId: id },
      htmlRender: {
        attachmentId: id,
        title: "😄".repeat(100),
        height: 480,
        heights: Array.from({ length: 24 }, (_, index) => [index + 100, 480]),
      },
    });
    expect(output).toBeDefined();
    expect(new TextEncoder().encode(JSON.stringify(output)).byteLength).toBeLessThanOrEqual(8192);
  });

  it("drops malformed, oversized and unowned plugin card references", () => {
    const card = {
      installationId: "tasks",
      generation: "generation-1",
      dataOwner: "retained-tasks",
      viewId: "launch",
      summary: "Proposed two tasks.",
    };
    for (const invalid of [
      { ...card, dataOwner: "" },
      { ...card, viewId: "../outside" },
      { ...card, summary: "x".repeat(1001) },
      { ...card, data: "😄".repeat(513) },
      { viewId: "launch", summary: "Unstamped author result" },
    ]) {
      expect(compactDynamicToolOutput({ card: invalid })).toBeUndefined();
    }
  });

  it("recognizes only the successful plugin-invoke result from the T3 server", () => {
    const card = {
      installationId: "tasks",
      generation: "generation-1",
      dataOwner: "retained-tasks",
      viewId: "launch",
      summary: "Proposed two tasks.",
      data: { planId: "plan-1" },
    };
    for (const toolName of [
      "t3_plugin_invoke",
      "t3-code.t3_plugin_invoke",
      "mcp__t3_code__t3_plugin_invoke",
      "mcp__t3-code__t3_plugin_invoke",
      "t3-code-thread_1_t3_plugin_invoke",
    ]) {
      expect(pluginCardFromToolItem({ toolName, output: { card } })).toEqual(card);
      for (const status of ["running", "failed", "cancelled"]) {
        expect(pluginCardFromToolItem({ toolName, output: { card }, status })).toBeUndefined();
      }
      expect(pluginCardFromToolItem({ toolName, output: { card }, status: "completed" })).toEqual(
        card,
      );
      expect(pluginCardFromToolItem({ toolName, output: { card, isError: true } })).toBeUndefined();
    }
    for (const toolName of [
      "mcp__other__t3_plugin_invoke",
      "other.t3_plugin_invoke",
      "html_render",
      "t3_plugin_list",
      null,
    ]) {
      expect(pluginCardFromToolItem({ toolName, output: { card } })).toBeUndefined();
    }
  });
});

describe("toolOutputIndicatesFailure", () => {
  it("preserves the command failure phrases across shells without copying the output", () => {
    for (const text of [
      "FILE NOT FOUND",
      "No files found",
      "ENOENT",
      "No such file or directory",
      "CommandNotFoundException",
      "command not found",
      "Cannot find path 'a' because it does not exist",
      "The term 'example' is not recognized",
      "is not recognized as the name of a cmdlet",
      "A parameter cannot be found that matches parameter name",
      "<exited with exit code 2>",
      "Exited with exit code 1",
      "exit code: 127",
    ])
      expect(toolOutputIndicatesFailure(text)).toBe(true);
  });

  it("does not mark successful exit codes or incomplete failure phrases", () => {
    for (const text of [
      "Done",
      "exit code: 0",
      "Exited with exit code 0",
      "cannot find path",
      "is not recognized",
    ]) {
      expect(toolOutputIndicatesFailure(text)).toBe(false);
    }
  });
});

describe("toolOutputImages", () => {
  const mcpImage = { type: "image", data: "AAAA", mimeType: "image/png" };
  const claudeImage = {
    type: "image",
    source: { type: "base64", media_type: "image/JPEG", data: "BBBB" },
  };
  const text = { type: "text", text: "{}" };

  it("finds images in each place providers store them, in order", () => {
    expect(toolOutputImages({ content: [text, claudeImage, mcpImage] })).toEqual([
      { mimeType: "image/jpeg", data: "BBBB" },
      { mimeType: "image/png", data: "AAAA" },
    ]);
    expect(toolOutputImages([mcpImage])).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
    expect(toolOutputImages(mcpImage)).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
  });

  it("skips types the server must not serve inline", () => {
    expect(
      toolOutputImages([
        { ...mcpImage, mimeType: "image/svg+xml" },
        { ...mcpImage, mimeType: "text/html" },
        { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
      ]),
    ).toEqual([]);
  });

  it("stops after the first few images", () => {
    const images = toolOutputImages(Array.from({ length: 10_000 }, () => mcpImage));
    expect(images).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
  });
});
