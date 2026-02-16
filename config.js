// config.js
module.exports = {
  // Bridge server settings
  server: {
    port: 5100,
    host: "127.0.0.1",
  },

  // Target LLM chat web page
  target: {
    url: "https://chatgpt.com",          // or https://claude.ai, etc.
    type: "chatgpt",                      // chatgpt | claude | gemini | custom
    headless: false,                      // set true once stable
    userDataDir: "./browser-profile",     // persist login sessions
  },

  // Iteration control
  iteration: {
    maxIterations: 20,                    // safety cap per request
    responseStabilityTimeout: 3000,       // ms to wait for response to stop changing
    pollInterval: 500,                    // ms between DOM polls
    idleTimeout: 120000,                  // max wait for any single response (2 min)
  },

  // Selectors for each supported LLM web page
  selectors: {
    chatgpt: {
      textArea:     '#prompt-textarea > p',
      sendButton:   'button[data-testid="send-button"]',
      responseBlock:'div[data-message-author-role="assistant"]',
      stopButton:   'button[aria-label="Stop generating"]',
      thinkingIndicator: '.result-streaming',

      textdocPopover: 'div[id^="textdoc-message-"]',
      textdocContent: 'div.ProseMirror', // inside popover
      textdocTitle: 'span.text-token-text-primary.font-semibold', // "Agents" in your sample (optional)
    },
    claude: {
      textArea:     'div.ProseMirror[contenteditable="true"]',
      sendButton:   'button[aria-label="Send Message"]',
      responseBlock:'div[data-is-streaming],.font-claude-message',
      stopButton:   'button[aria-label="Stop Response"]',
      thinkingIndicator: '[data-is-streaming="true"]',
    },
    // Add more targets as needed
  },
};