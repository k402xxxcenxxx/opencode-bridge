// bridge-server.js
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

// ─── Model List (for OpenCode compatibility) ───────────────
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

// ─── Chat Completions (main endpoint) ──────────────────────
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages, stream } = req.body;

    if (stream) {
      // ── Streaming Response (SSE) ──────────────────────
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const fullResponse = await conversation.processRequest(messages);

      // Simulate streaming by chunking the response
      const chunkSize = 20;
      for (let i = 0; i < fullResponse.length; i += chunkSize) {
        const chunk = fullResponse.slice(i, i + chunkSize);
        const payload = {
          id: `chatcmpl-bridge-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "bridge-llm",
          choices: [
            {
              index: 0,
              delta: { content: chunk },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }

      // Send final [DONE] marker
      res.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-bridge-${Date.now()}`,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      // ── Non-Streaming Response ────────────────────────
      const fullResponse = await conversation.processRequest(messages);

      res.json({
        id: `chatcmpl-bridge-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "bridge-llm",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: fullResponse },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
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