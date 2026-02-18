// conversation-manager.js
"use strict";
const { PromptManager } = require('./prompt-manager');
const { estimateTokens }  = require('./prompt-manager'); // re-export helper (optional)

const config = require("./config");
const {
  extractFileBlocks,
  extractToolCallBlocks,
  stripAllMarkers,
  fileBlocksToToolCalls,
  toOpenAIToolCalls,
} = require("./file-block-parser");

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

  // ─── Tool usage instructions appended to system prompt ───
  toolInstructions: (availableTools) => {
    if (!availableTools || availableTools.length === 0) return "";
    const toolList = availableTools.map((t) => {
      const fn = t.function || t;
      const params = fn.parameters
        ? JSON.stringify(fn.parameters, null, 2)
        : "{}";
      // return `- **${fn.name}**: ${fn.description || "No description"}\n  Parameters: ${params}`;
      return `- **${fn.name}**\n  Parameters: ${params}`;
    }).join("\n");
    return (
      `\n\n---\n` +
      // `AVAILABLE TOOLS FOR THIS SESSION:\n${toolList}\n` +
      `AVAILABLE TOOLS FOR THIS SESSION:\n` +
      `Use the [[TOOL_CALL]] / [[WRITE_FILE:]] formats described in your system instructions.\n` +
      `---\n\n`
    );
  },
};

// ─── Utility Request Interceptors ──────────────────────────
const INTERCEPTORS = [
  {
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
      let text = userMessage;
      const textMatch = text.match(/<text>\s*([\s\S]*?)\s*<\/text>/i);
      if (textMatch) text = textMatch[1];
      text = text
        .replace(/```[\s\S]*?```/g, "code")
        .replace(/`[^`]+`/g, "")
        .replace(/@[\w/.:-]+/g, "")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/[#*_~>$$\](){}|]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text || text.length < 2) return "New conversation";
      const words = text.split(" ").slice(0, 7).join(" ");
      const title = words.length > 50 ? words.substring(0, 47) + "..." : words;
      return title.charAt(0).toUpperCase() + title.slice(1);
    },
  },
  // {
  //   name: "summarization",
  //   detect: (systemPrompt, _userMessage) => {
  //     if (!systemPrompt) return false;
  //     const lower = systemPrompt.toLowerCase();
  //     return (
  //       (lower.includes("summarize") || lower.includes("summary")) &&
  //       (lower.includes("conversation") || lower.includes("thread")) &&
  //       lower.includes("brief") &&
  //       !lower.includes("assist") &&
  //       !lower.includes("help")
  //     );
  //   },
  //   handle: (_systemPrompt, userMessage) => {
  //     const text = userMessage.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  //     const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 5);
  //     if (sentences.length === 0) return "General conversation.";
  //     return sentences.slice(0, 3).join(". ").trim() + ".";
  //   },
  // },
  {
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
      const text = userMessage.replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ").trim();
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
    this.currentTools = [];          // Tools from latest request
    this.promptManager = new PromptManager({
      targetModel: config.target?.model,
      charLimit: config.promptLimits?.charLimit,
      llamaEndpoint: config.llama?.endpoint,
      llamaModel: config.llama?.model,
      strategy: config.promptLimits?.strategy || 'auto',
      logger: this.log || console,
      // ── Wire in META templates so PromptManager owns the full prompt ──
      templates: {
        systemWrapper:    META.systemWrapper,
        contextSummary:   META.contextSummary,
        continuePrompt:   META.continuePrompt,
        toolInstructions: META.toolInstructions,
      },
      maxContinuations: config.iteration?.maxIterations ?? 5,
    });
    
  }

  /**
   * Main entry point.
   *
   * @param {Array} messages  - OpenAI-format messages array
   * @param {Object} options  - { tools, tool_choice, ... } from the request body
   * @returns {Object} { kind, content, tool_calls } — bridge-server uses `kind` to decide response format
   */
  async processRequest(messages, options = {}) {
    console.log(messages);
    const systemPrompt = this._extractSystemPrompt(messages);
    const userMessage = this._extractLatestUserMessage(messages);

    // Store available tools from the request
    if (options.tools && options.tools.length > 0) {
      this.currentTools = options.tools;
    }

    // ─── Step 1: Check interceptors ───────────────────────
    const intercepted = this._tryIntercept(systemPrompt, userMessage);
    if (intercepted !== null) {
      return { kind: "text", content: intercepted };
    }

    // ─── Step 2: Real conversation via browser ────────────
    const conversationTurns = messages.filter((m) => m.role !== "system");
    const needsNew = this._needsNewChat(systemPrompt, conversationTurns);
    if (needsNew) {
      console.log("[Manager] Starting new browser chat session.");
      await this.browser.startNewChat();
      this.currentSystemPrompt = systemPrompt;
      this.sentTurnCount = 0;
      // Reset PromptManager state for the new session
      this.promptManager.resetSession();
    }

    const newTurns = conversationTurns.slice(this.sentTurnCount);

    if (newTurns.length === 0) {
      console.warn("[Manager] No new messages to send.");
      return { kind: "text", content: "[Bridge] No new user message found." };
    }

    // ─── Handle tool result messages ─────────────────────
    // When OpenCode sends back tool results (role: "tool"), we need to
    // format them and forward to the web LLM so it knows the outcome.
    const formattedTurns = this._formatTurnsForBrowser(newTurns);

    // ─── Delegate prompt assembly to PromptManager ───────
    const prompt = await this.promptManager.buildPrompt({
      systemPrompt:  this.currentSystemPrompt,
      tools:         config.tools.enabled ? this.currentTools : [],
      formattedTurns,
    });

    console.log(
      `[Manager] PromptManager produced prompt ` +
      `(${prompt.length} chars, ~${estimateTokens ? estimateTokens(prompt) : '?'} tokens)`
    );

    // ─── Send to browser and collect response ────────────
    let response = await this.browser.sendMessage(prompt);

    // ─── Auto-continue on truncation (via PromptManager) ─
    response = await this._autoContinue(response);

    this.sentTurnCount = conversationTurns.length;

    // ─── Parse response for tool calls ───────────────────
    if (config.tools.enabled) {
      const result = this._parseToolCalls(response);
      if (result.toolCalls.length > 0) {
        console.log(`[Manager] Detected ${result.toolCalls.length} tool call(s) in response.`);
        return {
          kind: "tool_calls",
          content: result.cleanText || null,
          tool_calls: toOpenAIToolCalls(
            result.toolCalls.slice(0, config.tools.maxToolCallsPerResponse)
          ),
        };
      }
    }

    return { kind: "text", content: response };
  }

   // ─── Auto-continue loop (delegates prompts to PromptManager) ─
  async _autoContinue(response) {
    const maxIter = config.iteration?.maxIterations ?? 5;
    let iteration = 1;

    while (iteration < maxIter) {
      const check = this._detectTruncation(response);
      if (!check.isTruncated) break;

      iteration++;
      console.log(`[Manager] Auto-continue #${iteration}: ${check.reason}`);

      // Let PromptManager produce the continuation prompt
      // (it may wrap with additional context if the model needs it)
      const continueText = this.promptManager.getContinuePrompt({
        iterationNumber: iteration,
        truncationReason: check.reason,
        tailChars: response.slice(-200),   // give PM context about where we stopped
      });

      const continuation = await this.browser.sendMessage(continueText);
      response = this._mergeResponses(response, continuation);
    }

    console.log(
      `[Manager] Done in ${iteration} turn(s), response: ${response.length} chars.`
    );

    return response;
  }

  // ─── Parse tool calls from LLM response ──────────────────
  _parseToolCalls(responseText) {
    // Extract file write blocks → convert to write tool calls
    const fileBlocks = extractFileBlocks(responseText);
    const fileToolCalls = fileBlocksToToolCalls(fileBlocks);

    // Extract explicit tool call blocks
    const explicitToolCalls = extractToolCallBlocks(responseText);

    // Combine
    const allToolCalls = [...fileToolCalls, ...explicitToolCalls];

    // Strip markers from the text to get clean conversational content
    const cleanText = stripAllMarkers(responseText);

    return {
      toolCalls: allToolCalls,
      cleanText: cleanText || null,
    };
  }

  // ─── Format turns for browser (handle tool results) ──────
  _formatTurnsForBrowser(turns) {
    return turns.map((turn) => {
      if (turn.role === "tool") {
        // Tool result from OpenCode — format as readable context
        const toolName = turn.tool_call_id
          ? `(tool_call_id: ${turn.tool_call_id})`
          : "";
        return {
          role: "user",
          text: `[Tool Result ${toolName}]:\n${turn.content}\n[/Tool Result]`,
        };
      }

      if (turn.role === "assistant" && turn.tool_calls) {
        // Assistant message that contained tool calls (echo back)
        const callSummary = turn.tool_calls
          .map((tc) => {
            const fn = tc.function || {};
            return `Called ${fn.name}(${fn.arguments || "{}"})`;
          })
          .join("\n");
        return {
          role: "assistant",
          text: `[Previous tool invocations]:\n${callSummary}`,
        };
      }

      return {
        role: turn.role,
        text: typeof turn.content === "string" ? turn.content : JSON.stringify(turn.content),
      };
    });
  }

  // ─── Interceptor Engine ──────────────────────────────────
  _tryIntercept(systemPrompt, userMessage) {
    for (const interceptor of INTERCEPTORS) {
      if (interceptor.detect(systemPrompt, userMessage)) {
        console.log(`[Manager] Intercepted: "${interceptor.name}"`);
        try {
          const result = interceptor.handle(systemPrompt, userMessage);
          console.log(`[Manager] Interceptor responded: "${result.substring(0, 80)}..."`);
          return result;
        } catch (err) {
          console.error(`[Manager] Interceptor "${interceptor.name}" failed:`, err.message);
          return null;
        }
      }
    }
    return null;
  }

  // ─── Truncation Detection (EN / zh-TW / zh-CN) ──────────────────────────
  _detectTruncation(response) {
    const trimmed = response.trim();
    if (trimmed.length === 0) return { isTruncated: false, reason: null };

    // ─── 1. Structural: Unclosed code blocks (language-agnostic) ─────────
    const codeBlockCount = (trimmed.match(/```/g) || []).length;
    if (codeBlockCount % 2 !== 0) {
      return { isTruncated: true, reason: "Unclosed code block" };
    }

    // ─── 2. Structural: Unclosed [[WRITE_FILE:]] blocks ──────────────────
    const writeStarts = (trimmed.match(/$$\[WRITE_FILE:/gi) || []).length;
    const writeEnds   = (trimmed.match(/\[\[END_FILE$$\]/gi) || []).length;
    if (writeStarts > writeEnds) {
      console.log(trimmed);
      console.log(
        `[Manager] Detected ${writeStarts} [[WRITE_FILE:]] starts ` +
        `but only ${writeEnds} [[END_FILE]] ends.`
      );
      return { isTruncated: true, reason: "Unclosed [[WRITE_FILE]] block" };
    }

    // ─── 3. Structural: Unclosed CJK bracket / quotation pairs ──────────
    const cjkPairs = [
      ["\u300c", "\u300d"],  // 「 」 — primary CJK quotation
      ["\u300e", "\u300f"],  // 『 』 — secondary CJK quotation
      ["\u3010", "\u3011"],  // 【 】 — lenticular brackets
      ["\u300a", "\u300b"],  // 《 》 — double angle brackets
      ["\uff08", "\uff09"],  // （ ） — fullwidth parentheses
    ];
    for (const [open, close] of cjkPairs) {
      const opens  = trimmed.split(open).length - 1;
      const closes = trimmed.split(close).length - 1;
      if (opens > closes) {
        return {
          isTruncated: true,
          reason: `Unclosed CJK bracket pair: ${open}…${close} `
                + `(opened ${opens}, closed ${closes})`,
        };
      }
    }

    // ─── 4. Continuation signals (EN / zh-CN / zh-TW) ───────────────────
    //   Chinese characters are case-insensitive by nature, so a single
    //   toLowerCase() pass covers all three languages safely.
    const lower = trimmed.toLowerCase();

    const continuationSignals = [
      // ── English ──
      "let me continue",      "i'll continue",
      "i will continue",      "continuing from",
      "in the next part",     "to be continued",
      "[continued]",          "i'll provide the rest",
      "continued in part",    "see next message",

      // ── Simplified Chinese ──
      "让我继续",   "我会继续",    "我将继续",
      "接下来继续", "继续提供",    "未完待续",
      "待续",       "以下是剩余",  "下面继续",
      "请看下文",   "后续部分",    "篇幅限制",
      "字数限制",   "由于长度",

      // ── Traditional Chinese ──
      "讓我繼續",   "我會繼續",    "我將繼續",
      "接下來繼續", "繼續提供",    "未完待續",
      "待續",       "以下是剩餘",  "下面繼續",
      "請看下文",   "後續部分",    "篇幅限制",
      "字數限制",   "由於長度",
    ];

    for (const signal of continuationSignals) {
      if (lower.includes(signal)) {
        return { isTruncated: true, reason: `Continuation signal: "${signal}"` };
      }
    }

    // ─── 5. Mid-sentence termination (multi-script aware) ────────────────
    const lastChar = trimmed.slice(-1);

    const terminators = new Set([
      // ASCII
      ".", "!", "?", "`", '"', "'", ")", "]", "}", ">", "|", "-",

      // CJK sentence-final punctuation
      "\u3002",   // 。 — ideographic full stop
      "\uff01",   // ！ — fullwidth exclamation
      "\uff1f",   // ？ — fullwidth question mark

      // CJK closing brackets / quotes (mirrors the pairs above)
      "\u300d",   // 」
      "\u300f",   // 』
      "\u3011",   // 】
      "\u300b",   // 》
      "\uff09",   // ）

      // Fullwidth sentence-ending variants
      "\uff0e",   // ．
      "\uff1b",   // ；
      "\uff1a",   // ：

      // Ellipsis (common valid ending in all three languages)
      "\u2026",   // … — horizontal ellipsis
      "\u22ef",   // ⋯ — midline horizontal ellipsis
    ]);

    // CJK-heavy text carries more meaning per character,
    // so apply a lower threshold when the text is predominantly CJK.
    // Range U+4E00–U+9FFF covers CJK Unified Ideographs (both SC & TC).
    // Range U+3400–U+4DBF covers CJK Extension A.
    const cjkCount = (trimmed.match(/[\u3400-\u9fff]/g) || []).length;
    const cjkRatio = cjkCount / trimmed.length;
    const minLength = cjkRatio > 0.3 ? 100 : 300;

    if (trimmed.length > minLength && !terminators.has(lastChar)) {
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
    if (this.sentTurnCount === 0 && !this.systemPromptSent) return true;
    if (systemPrompt && systemPrompt !== this.currentSystemPrompt) return true;
    if (conversationTurns.length < this.sentTurnCount) return true;
    return false;
  }

  // ─── Message Extraction ──────────────────────────────────
  _extractSystemPrompt(messages) {
    const sys = messages.find((m) => m.role === "system");
    return sys ? sys.content : null;
  }

  _extractLatestUserMessage(messages) {
    const userMsgs = messages.filter((m) => m.role === "user");
    return userMsgs.length > 0 ? userMsgs[userMsgs.length - 1].content : "";
  }

  reset() {
    this.sentTurnCount = 0;
    this.currentSystemPrompt = null;
    this.promptManager.resetSession();
  }
}

module.exports = ConversationManager;