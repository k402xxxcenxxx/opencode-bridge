// prompt-splitter.js
// Splits oversized prompts into sequential chunked requests

const config = require('./config');

class PromptSplitter {
  constructor(options = {}) {
    this.maxChunkChars = options.maxChunkChars || 25000;
    this.overlapChars = options.overlapChars || 500; // overlap between chunks for continuity
    this.log = options.logger || console;
  }

  /**
   * Determine if messages need splitting and create a split plan
   */
  planSplit(messages, charLimit) {
    const totalChars = messages.reduce((sum, m) => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + c.length;
    }, 0);

    if (totalChars <= charLimit) {
      return { needsSplit: false, chunks: [messages], totalChars, charLimit };
    }

    const chunks = this._splitMessages(messages, charLimit);

    this.log.log(
      `[PromptSplitter] Split ${totalChars} chars into ${chunks.length} chunks ` +
      `(limit: ${charLimit} chars/chunk)`
    );

    return {
      needsSplit: true,
      chunks,
      totalChars,
      charLimit,
      chunkCount: chunks.length,
    };
  }

  /**
   * Split messages into chunks, each under charLimit
   * Strategy: System prompt goes in every chunk. Conversation is split chronologically.
   * Last chunk always contains the final user message.
   */
  _splitMessages(messages, charLimit) {
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    const lastUserMsg = [...nonSystem].reverse().find(m => m.role === 'user');
    const conversation = nonSystem.filter(m => m !== lastUserMsg);

    // Calculate overhead per chunk
    const systemChars = systemMessages.reduce((sum, m) => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + c.length;
    }, 0);
    const lastUserChars = lastUserMsg
      ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content.length : JSON.stringify(lastUserMsg.content).length)
      : 0;

    // Available space for conversation per chunk
    const chunkBudget = charLimit - systemChars - 200; // 200 char buffer for framing

    // If even the system prompt + last user message exceeds limit, we need to compress system prompt
    if (systemChars + lastUserChars > charLimit) {
      this.log.warn('[PromptSplitter] System prompt + user message alone exceeds limit — needs compression first');
      return [messages]; // Return unsplit; caller should compress first
    }

    const chunks = [];
    let currentChunk = [];
    let currentChunkChars = 0;

    // Process conversation messages into chunks
    for (let i = 0; i < conversation.length; i++) {
      const msg = conversation[i];
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const msgChars = content.length;

      // If single message exceeds budget, we need to split the message itself
      if (msgChars > chunkBudget) {
        // Flush current chunk
        if (currentChunk.length > 0) {
          chunks.push(this._buildChunk(systemMessages, currentChunk, null, chunks.length, true));
          currentChunk = [];
          currentChunkChars = 0;
        }

        // Split the large message
        const subChunks = this._splitLargeMessage(msg, chunkBudget);
        for (const sub of subChunks) {
          chunks.push(this._buildChunk(systemMessages, [sub], null, chunks.length, true));
        }
        continue;
      }

      if (currentChunkChars + msgChars > chunkBudget) {
        // Flush current chunk
        chunks.push(this._buildChunk(systemMessages, currentChunk, null, chunks.length, true));
        currentChunk = [];
        currentChunkChars = 0;
      }

      currentChunk.push(msg);
      currentChunkChars += msgChars;
    }

    // Final chunk: remaining conversation + last user message
    if (currentChunk.length > 0 || lastUserMsg) {
      chunks.push(this._buildChunk(systemMessages, currentChunk, lastUserMsg, chunks.length, false));
    } else if (chunks.length === 0) {
      chunks.push(this._buildChunk(systemMessages, [], lastUserMsg, 0, false));
    }

    return chunks;
  }

  /**
   * Build a single chunk with proper framing
   */
  _buildChunk(systemMessages, conversationSlice, lastUserMsg, chunkIndex, isIntermediate) {
    const chunk = [];

    // System prompt always included
    chunk.push(...systemMessages);

    // Add chunk context marker
    if (chunkIndex > 0) {
      chunk.push({
        role: 'system',
        content: `[Context continuation - Part ${chunkIndex + 1}. Previous context was provided in earlier messages.]`,
      });
    }

    // Add conversation slice
    chunk.push(...conversationSlice);

    // If intermediate chunk, add continuation instruction
    if (isIntermediate) {
      chunk.push({
        role: 'user',
        content: 'Please acknowledge you have received this context. Respond with "Context received, ready for next part." only.',
      });
    } else if (lastUserMsg) {
      // Final chunk: add the actual user message
      chunk.push(lastUserMsg);
    }

    return chunk;
  }

  /**
   * Split a single large message into sub-messages
   */
  _splitLargeMessage(msg, maxChars) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    const parts = [];

    // Try to split on natural boundaries
    const segments = this._findSplitPoints(content, maxChars);

    for (let i = 0; i < segments.length; i++) {
      parts.push({
        role: msg.role,
        content: `[Part ${i + 1}/${segments.length}]\n${segments[i]}`,
      });
    }

    return parts;
  }

  /**
   * Find natural split points in text (paragraph breaks, sentence endings, etc.)
   */
  _findSplitPoints(text, maxChars) {
    const segments = [];
    let remaining = text;

    while (remaining.length > maxChars) {
      let splitAt = maxChars;

      // Try to find a good split point (paragraph break > sentence end > word boundary)
      const searchWindow = remaining.substring(Math.floor(maxChars * 0.8), maxChars);

      // Look for double newline (paragraph break)
      const paraBreak = searchWindow.lastIndexOf('\n\n');
      if (paraBreak !== -1) {
        splitAt = Math.floor(maxChars * 0.8) + paraBreak + 2;
      } else {
        // Look for sentence ending
        const sentenceEnd = searchWindow.search(/[.!?]\s/);
        if (sentenceEnd !== -1) {
          splitAt = Math.floor(maxChars * 0.8) + sentenceEnd + 2;
        } else {
          // Look for newline
          const newline = searchWindow.lastIndexOf('\n');
          if (newline !== -1) {
            splitAt = Math.floor(maxChars * 0.8) + newline + 1;
          }
        }
      }

      segments.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt);
    }

    if (remaining.length > 0) {
      segments.push(remaining);
    }

    return segments;
  }
}

module.exports = { PromptSplitter };