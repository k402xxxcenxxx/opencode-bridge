// prompt-manager.js
"use strict";

// ═══════════════════════════════════════════════════════════
//  Token / char estimation helpers
// ═══════════════════════════════════════════════════════════

/**
 * Rough token estimate — ~4 chars per token for English text.
 * Replace with a real tokeniser (tiktoken, llama-tokenizer, etc.)
 * for production accuracy.
 *
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ═══════════════════════════════════════════════════════════
//  Budget-strategy helpers
// ═══════════════════════════════════════════════════════════

/**
 * Determines the effective character budget for the prompt body
 * based on the configured strategy.
 *
 * @param {object} opts
 * @param {string} opts.strategy   - 'char' | 'token' | 'auto'
 * @param {number} opts.charLimit
 * @param {number} opts.tokenLimit
 * @returns {number} charBudget
 */
function resolveCharBudget({ strategy, charLimit, tokenLimit }) {
  if (strategy === "token" && tokenLimit) {
    // Convert token ceiling → approximate char ceiling
    return tokenLimit * 4;
  }
  if (strategy === "auto") {
    // Use the tighter of the two limits
    const fromTokens = tokenLimit ? tokenLimit * 4 : Infinity;
    return Math.min(charLimit || Infinity, fromTokens);
  }
  // Default: plain char strategy
  return charLimit || Infinity;
}

// ═══════════════════════════════════════════════════════════
//  PromptManager class
// ═══════════════════════════════════════════════════════════

class PromptManager {
  /**
   * @param {object} opts
   * @param {string}  opts.targetModel       – e.g. "claude-3-opus"
   * @param {number}  [opts.charLimit]        – hard character ceiling
   * @param {number}  [opts.tokenLimit]       – hard token ceiling
   * @param {string}  [opts.llamaModel]       – llama backend model id
   * @param {string}  [opts.strategy='auto']  – 'char' | 'token' | 'auto'
   * @param {object}  [opts.logger=console]
   * @param {object}  opts.templates          – META template functions
   * @param {Function} opts.templates.systemWrapper
   * @param {Function} opts.templates.contextSummary
   * @param {Function} opts.templates.continuePrompt
   * @param {Function} opts.templates.toolInstructions
   * @param {number}  [opts.maxContinuations=5]
   */
  constructor(opts = {}) {
    // ── Model & limits ──────────────────────────────────
    this.targetModel      = opts.targetModel   || "unknown";
    this.charLimit        = opts.charLimit      || 0;
    this.tokenLimit       = opts.tokenLimit     || 0;
    this.llamaModel       = opts.llamaModel     || null;
    this.strategy         = opts.strategy       || "auto";
    this.maxContinuations = opts.maxContinuations ?? 5;
    this.log              = opts.logger         || console;

    // ── Templates (injected from META in conversation-manager) ──
    this.templates = {
      systemWrapper:    opts.templates?.systemWrapper    || ((s) => s),
      contextSummary:   opts.templates?.contextSummary   || ((turns) => ""),
      continuePrompt:   opts.templates?.continuePrompt   || "Please continue.",
      toolInstructions: opts.templates?.toolInstructions  || ((_tools) => ""),
    };

    // ── Budget ──────────────────────────────────────────
    this.charBudget = resolveCharBudget({
      strategy:   this.strategy,
      charLimit:  this.charLimit,
      tokenLimit: this.tokenLimit,
    });

    // ── Per-session state (cleared on resetSession) ─────
    this._sessionState = this._freshSessionState();
  }

  // ─────────────────────────────────────────────────────────
  //  Session lifecycle
  // ─────────────────────────────────────────────────────────

  /** Returns a blank session-state object. */
  _freshSessionState() {
    return {
      systemPromptSent:    false,
      toolInstructionsSent: false,
      turnsSentCount:       0,
    };
  }

  /**
   * Reset all per-session flags.
   * Call this whenever a new browser chat is opened.
   */
  resetSession() {
    this.log.log?.("[PromptManager] Session reset.");
    this._sessionState = this._freshSessionState();
  }

  // ─────────────────────────────────────────────────────────
  //  Core: buildPrompt
  // ─────────────────────────────────────────────────────────

  /**
   * Assembles the full prompt string from the constituent parts,
   * respecting per-session "send once" rules and the char/token budget.
   *
   * @param {object}  params
   * @param {string|null} params.systemPrompt   – raw system prompt text
   * @param {Array}       params.tools          – tool definitions array
   * @param {Array}       params.formattedTurns – { role, text } objects
   * @returns {Promise<string>}  the assembled prompt
   */
  async buildPrompt({ systemPrompt, tools, formattedTurns }) {
    const parts = [];               // ordered prompt segments
    let reservedChars = 0;          // chars consumed by fixed segments

    // ── 1. System prompt (once per session) ─────────────
    if (!this._sessionState.systemPromptSent && systemPrompt) {
      const wrapped = this.templates.systemWrapper(systemPrompt);
      parts.push({ tag: "system", text: wrapped });
      reservedChars += wrapped.length;
      this._sessionState.systemPromptSent = true;
      this.log.log?.("[PromptManager] Injected system prompt.");
    }

    // ── 2. Tool instructions (once per session) ─────────
    if (!this._sessionState.toolInstructionsSent && tools && tools.length > 0) {
      const toolBlock = this.templates.toolInstructions(tools);
      parts.push({ tag: "tools", text: toolBlock });
      reservedChars += toolBlock.length;
      this._sessionState.toolInstructionsSent = true;
      this.log.log?.("[PromptManager] Injected tool instructions.");
    }

    // ── 3. Missed-context turns (all but the last turn) ─
    const latestTurn    = formattedTurns[formattedTurns.length - 1];
    const missedTurns   = formattedTurns.slice(0, -1);

    // Reserve space for the latest user turn (mandatory)
    const latestText    = latestTurn?.text ?? "";
    reservedChars      += latestText.length;

    if (missedTurns.length > 0) {
      const contextBlock = this._buildContextBlock(missedTurns, reservedChars);
      if (contextBlock) {
        parts.push({ tag: "context", text: contextBlock });
      }
    }

    // ── 4. Latest user turn (always last) ───────────────
    parts.push({ tag: "user", text: latestText });

    // ── 5. Concatenate & final budget guard ─────────────
    let prompt = parts.map((p) => p.text).join("\n\n");

    if (this.charBudget < Infinity && prompt.length > this.charBudget) {
      this.log.log?.(
        `[PromptManager] Prompt exceeds budget (${prompt.length}/${this.charBudget}). Trimming context.`
      );
      prompt = this._trimToBudget(parts);
    }

    this.log.log?.(
      `[PromptManager] Prompt ready — ${prompt.length} chars, ~${estimateTokens(prompt)} tokens.`
    );

    const kickSuffix = "\n\nBegin now. Your first output must contain a [[TOOL_CALL]] or [[WRITE_FILE:]] or [[TASK_FINISHED]] block.";
    prompt += kickSuffix;

    return prompt;
  }

  // ─────────────────────────────────────────────────────────
  //  Context block: summarise / compress missed turns
  // ─────────────────────────────────────────────────────────

  /**
   * Builds the "missed context" section.
   * If the raw context exceeds the remaining budget, it is compressed
   * via the contextSummary template (which may summarise or truncate).
   *
   * @param {Array}  missedTurns   – { role, text } objects
   * @param {number} reservedChars – chars already claimed by other parts
   * @returns {string|null}
   */
  _buildContextBlock(missedTurns, reservedChars) {
    const available = this.charBudget - reservedChars;

    // Full-fidelity context
    const fullContext = this.templates.contextSummary(
      missedTurns.map((t) => ({ role: t.role, content: t.text }))
    );

    if (fullContext.length <= available || available >= Infinity) {
      this.log.log?.(
        `[PromptManager] Injecting ${missedTurns.length} missed turn(s) in full (${fullContext.length} chars).`
      );
      return fullContext;
    }

    // ── Over budget: progressive compression ────────────
    this.log.log?.(
      `[PromptManager] Context too large (${fullContext.length}/${available}). Compressing…`
    );
    return this._compressContext(missedTurns, available);
  }

  /**
   * Progressively drops the oldest turns until the context block
   * fits within `budget` characters.  Falls back to a hard truncation
   * of the summarised string if even a single turn is too large.
   *
   * @param {Array}  turns  – missed turns (oldest → newest)
   * @param {number} budget – available chars
   * @returns {string}
   */
  _compressContext(turns, budget) {
    let slice = [...turns];

    while (slice.length > 0) {
      const candidate = this.templates.contextSummary(
        slice.map((t) => ({ role: t.role, content: t.text }))
      );

      if (candidate.length <= budget) {
        this.log.log?.(
          `[PromptManager] Compressed context to ${slice.length} turn(s) (${candidate.length} chars).`
        );
        return candidate;
      }

      // Drop the oldest turn
      slice = slice.slice(1);
    }

    // Nothing fits — return empty
    this.log.log?.("[PromptManager] All context dropped to fit budget.");
    return "";
  }

  // ─────────────────────────────────────────────────────────
  //  Budget trimming (last-resort)
  // ─────────────────────────────────────────────────────────

  /**
   * Given an array of tagged parts, removes the "context" part first,
   * then hard-truncates if still over budget.
   *
   * @param {Array} parts – [{ tag, text }]
   * @returns {string}
   */
  _trimToBudget(parts) {
    // Priority: keep system, tools, and user turn; sacrifice context first
    const priority = ["system", "tools", "user"];
    const kept = parts.filter((p) => priority.includes(p.tag));
    let prompt = kept.map((p) => p.text).join("");

    if (prompt.length > this.charBudget) {
      // Hard truncate (preserve tail = user turn)
      this.log.log?.("[PromptManager] Hard-truncating prompt to budget.");
      prompt = prompt.slice(0, this.charBudget);
    }
    return prompt;
  }

  // ─────────────────────────────────────────────────────────
  //  Continuation prompts
  // ─────────────────────────────────────────────────────────

  /**
   * Builds a continuation prompt for the auto-continue loop.
   *
   * @param {object} opts
   * @param {number} opts.iterationNumber    – which continuation pass (2, 3, …)
   * @param {string} opts.truncationReason   – why we think the response was cut off
   * @param {string} [opts.tailChars]        – last N chars of the current response
   * @returns {string}
   */
  getContinuePrompt({ iterationNumber, truncationReason, tailChars } = {}) {
    // If the template is a function, call it; otherwise use the static string.
    const base =
      typeof this.templates.continuePrompt === "function"
        ? this.templates.continuePrompt()
        : this.templates.continuePrompt;

    // ── Enrich with context for smarter continuation ────
    const enriched = this._enrichContinuation({
      base,
      iterationNumber,
      truncationReason,
      tailChars,
    });

    this.log.log?.(
      `[PromptManager] Continue prompt #${iterationNumber} (${enriched.length} chars).`
    );

    return enriched;
  }

  /**
   * Optionally enriches the base continuation prompt with context
   * about where the response was cut off, helping the model resume
   * more accurately.
   *
   * @param {object} opts
   * @returns {string}
   */
  _enrichContinuation({ base, iterationNumber, truncationReason, tailChars }) {
    // For the first couple of continuations, keep it simple
    if (!tailChars || iterationNumber <= 2) {
      return base;
    }

    // For later continuations, hint at the last content produced
    // so the model can pick up exactly where it left off.
    const hint = tailChars.length > 150 ? tailChars.slice(-150) : tailChars;
    return [
      base,
      "",
      `[Context: The response was truncated (${truncationReason}).`,
      `Last output ended with: "…${hint.trim()}"]`,
      "",
      "Continue exactly from where you left off.",
    ].join("\n");
  }

  // ─────────────────────────────────────────────────────────
  //  Diagnostics / introspection
  // ─────────────────────────────────────────────────────────

  /** Returns a snapshot of the current session state (for debugging). */
  getSessionState() {
    return { ...this._sessionState };
  }

  /** Returns the resolved character budget. */
  getBudget() {
    return {
      charBudget: this.charBudget,
      strategy:   this.strategy,
      charLimit:  this.charLimit,
      tokenLimit: this.tokenLimit,
    };
  }
}

// ═══════════════════════════════════════════════════════════
//  Exports
// ═══════════════════════════════════════════════════════════

module.exports = { PromptManager, estimateTokens };