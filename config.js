// config.js
module.exports = {
  server: {
    port: 5100,
    host: "127.0.0.1",
  },

  target: {
    url: "https://chatgpt.com",
    type: "chatgpt",
    headless: false,
    userDataDir: "./browser-profile",
  },

  iteration: {
    maxIterations: 20,
    responseStabilityTimeout: 3000,
    pollInterval: 500,
    idleTimeout: 120000,
  },

  // ─── Tool-call bridging ──────────────────────────────────
  tools: {
    enabled: true,
    maxToolCallsPerResponse: 8,
    // The safe marker format we instruct the web LLM to use
    // instead of <file> tags (which break in HTML)
    fileMarkerStart: "[[WRITE_FILE:",   // e.g. [[WRITE_FILE: src/index.js]]
    fileMarkerEnd: "[[END_FILE]]",
    toolCallMarkerStart: "[[TOOL_CALL]]",
    toolCallMarkerEnd: "[[/TOOL_CALL]]",
  },

  selectors: {
    chatgpt: {
      textArea: '#prompt-textarea > p',
      sendButton: 'button[data-testid="send-button"]',
      responseBlock: 'div[data-message-author-role="assistant"]',
      stopButton: 'button[aria-label="Stop generating"]',
      thinkingIndicator: '.result-streaming',
      textdocPopover: 'div[id^="textdoc-message-"]',
      textdocContent: 'div.ProseMirror',
      textdocTitle: 'span.text-token-text-primary.font-semibold',
    },
    claude: {
      textArea: 'div.ProseMirror[contenteditable="true"]',
      sendButton: 'button[aria-label="Send Message"]',
      responseBlock: 'div[data-is-streaming],.font-claude-message',
      stopButton: 'button[aria-label="Stop Response"]',
      thinkingIndicator: '[data-is-streaming="true"]',
    },
  },
};