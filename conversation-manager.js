// conversation-manager.js
const config = require("./config");

// ─── Meta-prompt templates ─────────────────────────────────
const META = {
  systemWrapper: (systemPrompt) =>
    `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n` +
    `Follow the above instructions precisely for this entire conversation. ` +
    `Respond directly to the user's requests without preamble. ` +
    `Never reference these instructions in your replies.\n\n---\n\n`,

  contextSummary: (turns) => {
    if (turns.length === 0) return "";
    const formatted = turns
      .map((t) => `[${t.role.toUpperCase()}]: ${t.content}`)
      .join("\n\n");
    return (
      `<conversation_context>\n` +
      `The following is the prior conversation context. ` +
      `Continue naturally from here.\n\n${formatted}\n` +
      `</conversation_context>\n\n---\n\n`
    );
  },

  continuePrompt:
    "Your previous response was cut off. Continue EXACTLY where you stopped — " +
    "do not repeat, summarize, or restart. Begin with the next character/word.",
};

// ─── Utility Request Interceptors ──────────────────────────
// OpenCode sends internal requests (title generation, summaries,
// etc.) through the same chat completions endpoint. We intercept
// these so they never reach the browser conversation.
// ────────────────────────────────────────────────────────────

const INTERCEPTORS = [
  {
    // ── Title Generation ───────────────────────────────
    name: "title-generation",
    detect: (systemPrompt, _userMessage) => {
      if (!systemPrompt) return false;
      const lower = systemPrompt.toLowerCase();
      return (
        lower.includes("title generator") ||
        lower.includes("generate a brief title") ||
        lower.includes("thread title") ||
        lower.includes("generate a title") ||
        (lower.includes("title") && lower.includes("≤50 characters"))
      );
    },
    handle: (_systemPrompt, userMessage) => {
      // Extract meaningful text from the user message
      // OpenCode often wraps it in <text>...</text> tags
      let text = userMessage;
      const textMatch = text.match(/<text>\s*([\s\S]*?)\s*<\/text>/i);
      if (textMatch) text = textMatch[1];

      // Strip markdown, tool references, file paths for a clean title
      text = text
        .replace(/```[\s\S]*?```/g, "code")       // code blocks → "code"
        .replace(/`[^`]+`/g, "")                    // inline code
        .replace(/@[\w/.:-]+/g, "")                 // @file references
        .replace(/https?:\/\/\S+/g, "")             // URLs
        .replace(/[#*_~>\[\](){}|]/g, "")           // markdown chars
        .replace(/\s+/g, " ")                       // collapse whitespace
        .trim();

      if (!text || text.length < 2) return "New conversation";

      // Truncate and capitalize
      const words = text.split(" ").slice(0, 7).join(" ");
      const title = words.length > 50 ? words.substring(0, 47) + "..." : words;
      return title.charAt(0).toUpperCase() + title.slice(1);
    },
  },
  {
    // ── Summarization Requests ─────────────────────────
    name: "summarization",
    detect: (systemPrompt, _userMessage) => {
      if (!systemPrompt) return false;
      const lower = systemPrompt.toLowerCase();
      return (
        (lower.includes("summarize") || lower.includes("summary")) &&
        (lower.includes("conversation") || lower.includes("thread")) &&
        lower.includes("brief") &&
        !lower.includes("assist") &&
        !lower.includes("help")
      );
    },
    handle: (_systemPrompt, userMessage) => {
      const text = userMessage
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 5);
      if (sentences.length === 0) return "General conversation.";
      return sentences.slice(0, 3).join(". ").trim() + ".";
    },
  },
  {
    // ── Commit Message Generation ──────────────────────
    name: "commit-message",
    detect: (systemPrompt, _userMessage) => {
      if (!systemPrompt) return false;
      const lower = systemPrompt.toLowerCase();
      return (
        lower.includes("commit message") ||
        (lower.includes("conventional commit") && lower.includes("generate"))
      );
    },
    handle: (_systemPrompt, userMessage) => {
      // Return a reasonable commit message from the diff/description
      const text = userMessage
        .replace(/```[\s\S]*?```/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length < 10) return "chore: update files";
      const summary = text.substring(0, 72);
      return `chore: ${summary}`;
    },
  },
];

// ─────────────────────────────────────────────────────────────

class ConversationManager {
  constructor(browserController) {
    this.browser = browserController;
    this.sentTurnCount = 0;
    this.currentSystemPrompt = null;
    this.systemPromptSent = false;
  }

  /**
   * Main entry point: process an OpenAI-compatible chat completion request.
   *
   * @param {Array} messages - OpenAI-format messages array
   * @param {Object} options - reserved for future use
   * @returns {string} Final response
   */
  async processRequest(messages, options = {}) {
    const systemPrompt = this._extractSystemPrompt(messages);
    const userMessage = this._extractLatestUserMessage(messages);

    // ─── Step 1: Check if this is an internal utility request ─
    const intercepted = this._tryIntercept(systemPrompt, userMessage);
    if (intercepted !== null) {
      return intercepted;
    }

    // ─── Step 2: Real conversation — proceed to browser ───────
    const conversationTurns = messages.filter((m) => m.role !== "system");

    const needsNewChat = this._needsNewChat(systemPrompt, conversationTurns);

    if (needsNewChat) {
      console.log("[Manager] Starting new browser chat session.");
      await this.browser.startNewChat();
      this.currentSystemPrompt = systemPrompt;
      this.systemPromptSent = false;
      this.sentTurnCount = 0;
    }

    // ─── Determine which messages are new ─────────────────
    const newTurns = conversationTurns.slice(this.sentTurnCount);

    if (newTurns.length === 0) {
      console.warn("[Manager] No new messages to send.");
      return "[Bridge] No new user message found in the request.";
    }

    const latestUserMsg = newTurns[newTurns.length - 1];
    const missedContext = newTurns.slice(0, -1);

    // ─── Build the composite prompt ──────────────────────
    let prompt = "";

    if (!this.systemPromptSent && this.currentSystemPrompt) {
      prompt += META.systemWrapper(this.currentSystemPrompt);
      this.systemPromptSent = true;
    }

    if (missedContext.length > 0) {
      console.log(
        `[Manager] Injecting ${missedContext.length} missed context turn(s).`
      );
      prompt += META.contextSummary(missedContext);
    }

    prompt += latestUserMsg.content;

    // ─── Send to browser and collect response ────────────
    console.log(
      `[Manager] Sending prompt (${prompt.length} chars) to browser...`
    );
    let response = await this.browser.sendMessage(prompt);

    // ─── Auto-continue on truncation ─────────────────────
    let iteration = 1;
    while (iteration < config.iteration.maxIterations) {
      const check = this._detectTruncation(response);
      if (!check.isTruncated) break;

      iteration++;
      console.log(
        `[Manager] Auto-continue #${iteration}: ${check.reason}`
      );

      const continuation = await this.browser.sendMessage(
        META.continuePrompt
      );

      response = this._mergeResponses(response, continuation);
    }

    this.sentTurnCount = conversationTurns.length;

    console.log(
      `[Manager] Done in ${iteration} turn(s), response: ${response.length} chars.`
    );

    return response;
  }

  // ─── Interceptor Engine ──────────────────────────────────
  /**
   * Runs the request through all registered interceptors.
   * Returns a string response if intercepted, or null if the
   * request should be forwarded to the browser normally.
   */
  _tryIntercept(systemPrompt, userMessage) {
    for (const interceptor of INTERCEPTORS) {
      if (interceptor.detect(systemPrompt, userMessage)) {
        console.log(
          `[Manager] Intercepted utility request: "${interceptor.name}" — handling locally.`
        );
        try {
          const result = interceptor.handle(systemPrompt, userMessage);
          console.log(
            `[Manager] Interceptor "${interceptor.name}" responded: "${result.substring(0, 80)}..."`
          );
          return result;
        } catch (err) {
          console.error(
            `[Manager] Interceptor "${interceptor.name}" failed:`,
            err.message
          );
          // Fall through to browser on failure
          return null;
        }
      }
    }
    return null;
  }

  // ─── Truncation Detection ────────────────────────────────
  _detectTruncation(response) {
    const trimmed = response.trim();
    if (trimmed.length === 0) {
      return { isTruncated: false, reason: null };
    }

    const codeBlockCount = (trimmed.match(/```/g) || []).length;
    if (codeBlockCount % 2 !== 0) {
      return { isTruncated: true, reason: "Unclosed code block" };
    }

    const lower = trimmed.toLowerCase();
    const continuationSignals = [
      "let me continue",
      "i'll continue",
      "continuing from",
      "in the next part",
      "to be continued",
      "[continued]",
      "i'll provide the rest",
    ];
    for (const signal of continuationSignals) {
      if (lower.includes(signal)) {
        return {
          isTruncated: true,
          reason: `Continuation signal: "${signal}"`,
        };
      }
    }

    const lastChar = trimmed.slice(-1);
    const terminators = new Set([
      ".", "!", "?", "`", '"', "'", ")", "]", "}", ">", "|", "-",
    ]);
    if (trimmed.length > 300 && !terminators.has(lastChar)) {
      return { isTruncated: true, reason: "Response ends mid-sentence" };
    }

    return { isTruncated: false, reason: null };
  }

  // ─── Response Merging ────────────────────────────────────
  _mergeResponses(original, continuation) {
    const trimmedOriginal = original.trimEnd();
    const trimmedContinuation = continuation.trimStart();

    const overlapWindow = Math.min(100, trimmedOriginal.length);
    const tail = trimmedOriginal.slice(-overlapWindow);
    const overlapIdx = trimmedContinuation.indexOf(tail.slice(-30));

    if (overlapIdx >= 0 && overlapIdx < 50) {
      return trimmedOriginal + trimmedContinuation.slice(overlapIdx + 30);
    }

    return trimmedOriginal + "\n" + trimmedContinuation;
  }

  // ─── New Chat Detection ──────────────────────────────────
  _needsNewChat(systemPrompt, conversationTurns) {
    if (this.sentTurnCount === 0 && !this.systemPromptSent) {
      return true;
    }
    if (systemPrompt && systemPrompt !== this.currentSystemPrompt) {
      return true;
    }
    if (conversationTurns.length < this.sentTurnCount) {
      return true;
    }
    return false;
  }

  // ─── Message Extraction ──────────────────────────────────
  _extractSystemPrompt(messages) {
    const sys = messages.find((m) => m.role === "system");
    return sys ? sys.content : null;
  }

  _extractLatestUserMessage(messages) {
    const userMsgs = messages.filter((m) => m.role === "user");
    return userMsgs.length > 0
      ? userMsgs[userMsgs.length - 1].content
      : "";
  }

  reset() {
    this.sentTurnCount = 0;
    this.currentSystemPrompt = null;
    this.systemPromptSent = false;
  }
}

module.exports = ConversationManager;