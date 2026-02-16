// bridge-server.js
"use strict";

const express = require("express");
const config = require("./config");
const BrowserController = require("./browser-controller");
const ConversationManager = require("./conversation-manager");

const app = express();
app.use(express.json({ limit: "10mb" }));

const browser = new BrowserController();
const conversation = new ConversationManager(browser);

// ─── Health Check ──────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", ready: browser.ready });
});

// ─── Model List ────────────────────────────────────────────
app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "bridge-llm",
        object: "model",
        created: Date.now(),
        owned_by: "local-bridge",
      },
    ],
  });
});

// ─── Helper: generate a unique completion ID ───────────────
function completionId() {
  return `chatcmpl-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Chat Completions (main endpoint) ──────────────────────
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages, stream, tools, tool_choice } = req.body;

    // Pass tools and options into the conversation manager
    const result = await conversation.processRequest(messages, {
      tools: tools || [],
      tool_choice: tool_choice || "auto",
    });

    const id = completionId();
    const created = Math.floor(Date.now() / 1000);

    // ────────────────────────────────────────────────────────
    // CASE A: Response contains tool_calls
    // ────────────────────────────────────────────────────────
    if (result.kind === "tool_calls" && result.tool_calls && result.tool_calls.length > 0) {
      if (stream) {
        // ── Streaming tool_calls (SSE) ──────────────────
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        // If there's also text content, stream it first
        if (result.content) {
          const chunkSize = 20;
          for (let i = 0; i < result.content.length; i += chunkSize) {
            const chunk = result.content.slice(i, i + chunkSize);
            res.write(`data: ${JSON.stringify({
              id, object: "chat.completion.chunk", created, model: "bridge-llm",
              choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
            })}\n\n`);
          }
        }

        // Stream tool_calls — first chunk includes full structure
        for (let i = 0; i < result.tool_calls.length; i++) {
          const tc = result.tool_calls[i];

          // Initial chunk: id, type, function name, start of arguments
          res.write(`data: ${JSON.stringify({
            id, object: "chat.completion.chunk", created, model: "bridge-llm",
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i,
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.function.name,
                    arguments: "",
                  },
                }],
              },
              finish_reason: null,
            }],
          })}\n\n`);

          // Stream the arguments in chunks
          const args = tc.function.arguments;
          const argChunkSize = 200;
          for (let j = 0; j < args.length; j += argChunkSize) {
            const argChunk = args.slice(j, j + argChunkSize);
            res.write(`data: ${JSON.stringify({
              id, object: "chat.completion.chunk", created, model: "bridge-llm",
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: i,
                    function: { arguments: argChunk },
                  }],
                },
                finish_reason: null,
              }],
            })}\n\n`);
          }
        }

        // Final chunk with finish_reason
        res.write(`data: ${JSON.stringify({
          id, object: "chat.completion.chunk", created, model: "bridge-llm",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();

      } else {
        // ── Non-streaming tool_calls ────────────────────
        res.json({
          id, object: "chat.completion", created, model: "bridge-llm",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: result.content || null,
              tool_calls: result.tool_calls,
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }

      return;
    }

    // ────────────────────────────────────────────────────────
    // CASE B: Normal text response (no tool calls)
    // ────────────────────────────────────────────────────────
    const content = result.content || result || "";

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const text = typeof content === "string" ? content : String(content);
      const chunkSize = 20;

      for (let i = 0; i < text.length; i += chunkSize) {
        const chunk = text.slice(i, i + chunkSize);
        res.write(`data: ${JSON.stringify({
          id, object: "chat.completion.chunk", created, model: "bridge-llm",
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        })}\n\n`);
      }

      res.write(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model: "bridge-llm",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();

    } else {
      res.json({
        id, object: "chat.completion", created, model: "bridge-llm",
        choices: [{
          index: 0,
          message: { role: "assistant", content: typeof content === "string" ? content : String(content) },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

  } catch (err) {
    console.error("[Server] Error:", err);
    res.status(500).json({
      error: { message: err.message, type: "bridge_error" },
    });
  }
});

// ─── New Chat Endpoint ─────────────────────────────────────
app.post("/v1/chat/new", async (req, res) => {
  await browser.startNewChat();
  conversation.reset();
  res.json({ status: "new_chat_started" });
});

// ─── Start Everything ──────────────────────────────────────
(async () => {
  await browser.initialize();
  app.listen(config.server.port, config.server.host, () => {
    console.log(
      `\n[Bridge] Server running at http://${config.server.host}:${config.server.port}`
    );
    console.log(`[Bridge] Target: ${config.target.url}`);
    console.log(`[Bridge] Endpoint: /v1/chat/completions\n`);
  });
})();