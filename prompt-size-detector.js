// prompt-size-detector.js
// Detects prompt size and determines if intervention is needed

const config = require('./config');

const CHAR_LIMITS = {
  claude: 150000,
  chatgpt: 32000,
  gemini: 90000,
  default: 30000,
};

const TOKEN_ESTIMATE_RATIO = 3.8; // ~3.8 chars per token (English average)

class PromptSizeDetector {
  constructor(options = {}) {
    this.targetModel = options.targetModel || config.target?.model || 'default';
    this.charLimit = options.charLimit || CHAR_LIMITS[this.targetModel] || CHAR_LIMITS.default;
    this.safetyMargin = options.safetyMargin || 0.90; // use 90% of limit as threshold
    this.effectiveLimit = Math.floor(this.charLimit * this.safetyMargin);

    // Compression trigger: compress when prompt exceeds this % of limit
    this.compressionThreshold = options.compressionThreshold || 0.75;
    // Split trigger: split when prompt exceeds limit even after compression
    this.splitThreshold = options.splitThreshold || 0.95;

    this.log = options.logger || console;
  }

  /**
   * Analyze the full prompt and return size metrics + recommended action
   */
  analyze(prompt) {
    const charCount = typeof prompt === 'string'
      ? prompt.length
      : JSON.stringify(prompt).length;

    const estimatedTokens = Math.ceil(charCount / TOKEN_ESTIMATE_RATIO);
    const utilizationRatio = charCount / this.charLimit;

    let action = 'pass'; // no intervention needed
    if (utilizationRatio >= this.splitThreshold) {
      action = 'split';
    } else if (utilizationRatio >= this.compressionThreshold) {
      action = 'compress';
    }

    const result = {
      charCount,
      estimatedTokens,
      charLimit: this.charLimit,
      effectiveLimit: this.effectiveLimit,
      utilizationRatio: Math.round(utilizationRatio * 100) / 100,
      utilizationPercent: `${Math.round(utilizationRatio * 100)}%`,
      action,
      overLimit: charCount > this.effectiveLimit,
      headroom: this.effectiveLimit - charCount,
    };

    this.log.log(
      `[PromptSizeDetector] chars=${charCount}, tokens≈${estimatedTokens}, ` +
      `utilization=${result.utilizationPercent}, action=${action}`
    );

    return result;
  }

  /**
   * Analyze structured messages array (OpenAI-style)
   */
  analyzeMessages(messages) {
    const fullText = messages.map(m => {
      const content = typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content);
      return `${m.role}: ${content}`;
    }).join('\n');
    return this.analyze(fullText);
  }

  /**
   * Identify which parts of the prompt consume the most space
   */
  breakdown(messages) {
    const parts = [];
    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      parts.push({
        role: msg.role,
        charCount: content.length,
        estimatedTokens: Math.ceil(content.length / TOKEN_ESTIMATE_RATIO),
        preview: content.substring(0, 80) + (content.length > 80 ? '...' : ''),
      });
    }
    // Sort by size descending
    parts.sort((a, b) => b.charCount - a.charCount);
    return parts;
  }
}

module.exports = { PromptSizeDetector, CHAR_LIMITS, TOKEN_ESTIMATE_RATIO };