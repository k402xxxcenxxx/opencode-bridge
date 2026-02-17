// prompt-manager.js
// Orchestrates size detection, compression, and splitting

const { PromptSizeDetector } = require('./prompt-size-detector');
const { PromptCompressor } = require('./prompt-compressor');
const { PromptSplitter } = require('./prompt-splitter');
const config = require('./config');

class PromptManager {
  constructor(options = {}) {
    this.log = options.logger || console;

    this.detector = new PromptSizeDetector({
      targetModel: options.targetModel || config.target?.model,
      charLimit: options.charLimit,
      logger: this.log,
    });

    this.compressor = new PromptCompressor({
      endpoint: options.llamaEndpoint,
      model: options.llamaModel,
      logger: this.log,
    });

    this.splitter = new PromptSplitter({
      logger: this.log,
    });

    this.strategy = options.strategy || 'auto'; // 'auto' | 'compress' | 'split' | 'compress-then-split'
    this._llamaAvailable = null; // cached availability
  }

  /**
   * Main entry point: process messages before sending to LLM web chat
   * Returns { messages, chunks?, strategy, metrics }
   */
  async processMessages(messages) {
    const analysis = this.detector.analyzeMessages(messages);

    this.log.log(
      `[PromptManager] Prompt analysis: ${analysis.charCount} chars, ` +
      `${analysis.utilizationPercent} utilization, action=${analysis.action}`
    );

    // No intervention needed
    if (analysis.action === 'pass') {
      return {
        strategy: 'none',
        messages,
        chunks: null,
        metrics: analysis,
      };
    }

    // Determine strategy
    const strategy = await this._resolveStrategy(analysis);

    switch (strategy) {
      case 'compress':
        return await this._executeCompression(messages, analysis);
      case 'split':
        return this._executeSplit(messages, analysis);
      case 'compress-then-split':
        return await this._executeCompressThenSplit(messages, analysis);
      default:
        this.log.warn(`[PromptManager] Unknown strategy "${strategy}", passing through`);
        return { strategy: 'none', messages, chunks: null, metrics: analysis };
    }
  }

  /**
   * Resolve which strategy to use
   */
  async _resolveStrategy(analysis) {
    if (this.strategy !== 'auto') return this.strategy;

    // Auto strategy: prefer compression, fall back to split
    if (analysis.action === 'compress') {
      const llama = await this._checkLlamaAvailability();
      return llama.available ? 'compress' : 'split';
    }

    if (analysis.action === 'split') {
      const llama = await this._checkLlamaAvailability();
      return llama.available ? 'compress-then-split' : 'split';
    }

    return 'split';
  }

  async _checkLlamaAvailability() {
    if (this._llamaAvailable === null) {
      this._llamaAvailable = await this.compressor.isAvailable();
      this.log.log(
        `[PromptManager] Llama availability: ${JSON.stringify(this._llamaAvailable)}`
      );
    }
    return this._llamaAvailable;
  }

  /**
   * Execute compression strategy
   */
  async _executeCompression(messages, analysis) {
    const targetLimit = this.detector.effectiveLimit;
    const compressed = await this.compressor.compressMessages(messages, targetLimit);

    const postAnalysis = this.detector.analyzeMessages(compressed);

    this.log.log(
      `[PromptManager] Post-compression: ${postAnalysis.charCount} chars ` +
      `(${postAnalysis.utilizationPercent} utilization)`
    );

    // If still over limit after compression, fall back to split
    if (postAnalysis.overLimit) {
      this.log.warn('[PromptManager] Still over limit after compression, falling back to split');
      return this._executeSplit(compressed, postAnalysis);
    }

    return {
      strategy: 'compress',
      messages: compressed,
      chunks: null,
      metrics: {
        before: analysis,
        after: postAnalysis,
        reductionPercent: `${Math.round((1 - postAnalysis.charCount / analysis.charCount) * 100)}%`,
      },
    };
  }

  /**
   * Execute split strategy
   */
  _executeSplit(messages, analysis) {
    const plan = this.splitter.planSplit(messages, this.detector.effectiveLimit);

    return {
      strategy: 'split',
      messages: plan.chunks[plan.chunks.length - 1], // final chunk with actual question
      chunks: plan.chunks,
      metrics: {
        ...analysis,
        chunkCount: plan.chunkCount || 1,
      },
    };
  }

  /**
   * Execute compress-then-split strategy
   */
  async _executeCompressThenSplit(messages, analysis) {
    // First compress
    const targetLimit = this.detector.effectiveLimit;
    const compressed = await this.compressor.compressMessages(messages, targetLimit);

    const postAnalysis = this.detector.analyzeMessages(compressed);

    // If compression brought it under limit, we're done
    if (!postAnalysis.overLimit) {
      return {
        strategy: 'compress',
        messages: compressed,
        chunks: null,
        metrics: {
          before: analysis,
          after: postAnalysis,
        },
      };
    }

    // Still over — split the compressed version
    const plan = this.splitter.planSplit(compressed, this.detector.effectiveLimit);

    return {
      strategy: 'compress-then-split',
      messages: plan.chunks[plan.chunks.length - 1],
      chunks: plan.chunks,
      metrics: {
        before: analysis,
        afterCompression: postAnalysis,
        chunkCount: plan.chunkCount || 1,
      },
    };
  }
}

module.exports = { PromptManager };