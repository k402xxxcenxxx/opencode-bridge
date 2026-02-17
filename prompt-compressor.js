// prompt-compressor.js
// Routes context to local Llama 3.2 (via Ollama) for intelligent compression

const http = require('http');
const https = require('https');
const config = require('./config');

const DEFAULT_LLAMA_ENDPOINT = 'http://localhost:11434/api/generate';
const DEFAULT_LLAMA_CHAT_ENDPOINT = 'http://localhost:11434/api/chat';
const DEFAULT_MODEL = 'llama3.2';

class PromptCompressor {
  constructor(options = {}) {
    this.endpoint = options.endpoint || config.llama?.endpoint || DEFAULT_LLAMA_ENDPOINT;
    this.chatEndpoint = options.chatEndpoint || config.llama?.chatEndpoint || DEFAULT_LLAMA_CHAT_ENDPOINT;
    this.model = options.model || config.llama?.model || DEFAULT_MODEL;
    this.timeout = options.timeout || 60000; // 60s timeout for compression
    this.maxRetries = options.maxRetries || 2;
    this.log = options.logger || console;

    // Compression targets
    this.targetRatio = options.targetRatio || 0.5; // compress to ~50% of original
    this.maxCompressedChars = options.maxCompressedChars || null; // hard cap if set
  }

  /**
   * Compress conversation history, preserving the system prompt and latest user message
   */
  async compressMessages(messages, targetCharLimit) {
    if (!messages || messages.length === 0) return messages;

    // Strategy: Keep system prompt + last user message intact
    // Compress the middle conversation history
    const systemMessages = messages.filter(m => m.role === 'system');
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const conversationHistory = messages.filter(m =>
      m.role !== 'system' && m !== lastUserMsg
    );

    if (conversationHistory.length === 0) {
      this.log.log('[PromptCompressor] No conversation history to compress');
      return messages;
    }

    const historyText = conversationHistory.map(m =>
      `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
    ).join('\n---\n');

    const historyChars = historyText.length;
    const otherChars = messages.reduce((sum, m) => {
      if (conversationHistory.includes(m)) return sum;
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return sum + c.length;
    }, 0);

    const availableForHistory = targetCharLimit
      ? Math.max(1000, targetCharLimit - otherChars - 500) // 500 char buffer
      : Math.floor(historyChars * this.targetRatio);

    this.log.log(
      `[PromptCompressor] History: ${historyChars} chars, target: ${availableForHistory} chars, ` +
      `ratio: ${Math.round((availableForHistory / historyChars) * 100)}%`
    );

    // If history is already small enough, skip compression
    if (historyChars <= availableForHistory) {
      this.log.log('[PromptCompressor] History already within target, skipping compression');
      return messages;
    }

    try {
      const compressed = await this._compressViaLlama(historyText, availableForHistory);

      // Rebuild messages array
      const result = [
        ...systemMessages,
        {
          role: 'assistant',
          content: `[Compressed conversation context]\n${compressed}`,
        },
      ];
      if (lastUserMsg) result.push(lastUserMsg);

      const newTotal = result.reduce((sum, m) => {
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return sum + c.length;
      }, 0);

      this.log.log(
        `[PromptCompressor] Compressed: ${historyChars} → ${compressed.length} chars ` +
        `(${Math.round((compressed.length / historyChars) * 100)}%), ` +
        `total prompt: ${newTotal} chars`
      );

      return result;
    } catch (err) {
      this.log.error(`[PromptCompressor] Compression failed: ${err.message}`);
      // Fallback: truncate history instead of failing
      return this._fallbackTruncate(messages, conversationHistory, systemMessages, lastUserMsg, availableForHistory);
    }
  }

  /**
   * Compress a single large text block (e.g., system prompt)
   */
  async compressText(text, targetChars) {
    if (text.length <= targetChars) return text;

    try {
      return await this._compressViaLlama(text, targetChars);
    } catch (err) {
      this.log.error(`[PromptCompressor] Text compression failed: ${err.message}`);
      // Fallback: smart truncation
      return this._smartTruncateText(text, targetChars);
    }
  }

  /**
   * Core: Send compression request to local Llama 3.2
   */
  async _compressViaLlama(text, targetChars) {
    const compressionPrompt = `You are a precise text compressor. Your task is to compress the following conversation history into a concise summary that preserves ALL key information, decisions, code references, file names, technical details, and action items.

RULES:
- Output MUST be under ${targetChars} characters
- Preserve all file names, function names, variable names, and technical terms exactly
- Preserve all decisions made and their reasoning
- Preserve all code snippets if they are short; summarize long ones
- Use concise language; remove pleasantries and filler
- Maintain chronological order of events
- Format as a structured summary with clear sections

CONVERSATION HISTORY TO COMPRESS:
${text}

COMPRESSED SUMMARY (under ${targetChars} characters):`;

    let lastError;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await this._callLlama(compressionPrompt);
        // Verify length constraint
        if (response.length > targetChars * 1.2) {
          // If still too long, do a second pass
          this.log.log('[PromptCompressor] First pass too long, doing second compression pass');
          const secondPass = await this._callLlama(
            `Shorten this text to under ${targetChars} characters while keeping all technical details:\n\n${response}`
          );
          return secondPass.substring(0, targetChars);
        }
        return response;
      } catch (err) {
        lastError = err;
        this.log.warn(`[PromptCompressor] Attempt ${attempt + 1} failed: ${err.message}`);
        // Exponential backoff
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
    throw lastError || new Error('Compression failed after retries');
  }

  /**
   * HTTP call to Ollama API
   */
  async _callLlama(prompt) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.endpoint);
      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const payload = JSON.stringify({
        model: this.model,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.1, // low temperature for faithful compression
          num_predict: 4096,
        },
      });

      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: this.timeout,
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`Llama API returned ${res.statusCode}: ${data}`));
              return;
            }
            const parsed = JSON.parse(data);
            resolve(parsed.response || parsed.message?.content || '');
          } catch (e) {
            reject(new Error(`Failed to parse Llama response: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Llama API request timed out'));
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Check if local Llama is available
   */
  async isAvailable() {
    try {
      const url = new URL(this.endpoint);
      const baseUrl = `${url.protocol}//${url.host}`;
      return new Promise((resolve) => {
        const client = url.protocol === 'https:' ? https : http;
        const req = client.get(`${baseUrl}/api/tags`, { timeout: 3000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              const models = parsed.models || [];
              const hasModel = models.some(m => m.name?.includes(this.model));
              resolve({ available: true, hasModel, models: models.map(m => m.name) });
            } catch {
              resolve({ available: true, hasModel: false, models: [] });
            }
          });
        });
        req.on('error', () => resolve({ available: false, hasModel: false, models: [] }));
        req.on('timeout', () => {
          req.destroy();
          resolve({ available: false, hasModel: false, models: [] });
        });
      });
    } catch {
      return { available: false, hasModel: false, models: [] };
    }
  }

  /**
   * Fallback: Truncate conversation history keeping most recent messages
   */
  _fallbackTruncate(messages, conversationHistory, systemMessages, lastUserMsg, targetChars) {
    this.log.log('[PromptCompressor] Using fallback truncation strategy');

    // Keep messages from the end (most recent), drop oldest
    const kept = [];
    let charCount = 0;

    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const msg = conversationHistory[i];
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (charCount + content.length > targetChars) break;
      kept.unshift(msg);
      charCount += content.length;
    }

    const droppedCount = conversationHistory.length - kept.length;
    if (droppedCount > 0) {
      kept.unshift({
        role: 'system',
        content: `[Note: ${droppedCount} earlier messages were trimmed to fit context window]`,
      });
    }

    const result = [...systemMessages, ...kept];
    if (lastUserMsg) result.push(lastUserMsg);
    return result;
  }

  /**
   * Smart truncation for plain text
   */
  _smartTruncateText(text, targetChars) {
    if (text.length <= targetChars) return text;

    // Keep beginning and end, remove middle
    const keepStart = Math.floor(targetChars * 0.6);
    const keepEnd = targetChars - keepStart - 50; // 50 chars for separator
    const start = text.substring(0, keepStart);
    const end = text.substring(text.length - keepEnd);

    return `${start}\n\n[... content trimmed for size ...]\n\n${end}`;
  }
}

module.exports = { PromptCompressor };