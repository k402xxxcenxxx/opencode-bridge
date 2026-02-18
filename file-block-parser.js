// file-block-parser.js
"use strict";

// ─── Safe marker format (primary) ──────────────────────────
// [[WRITE_FILE: path/to/file.js]]
// ...content...
// [[END_FILE]]
//
// ─── Legacy HTML-style (fallback, fragile) ─────────────────
// <file path="path/to/file.js">...content...</file>
//
// ─── Generic tool call block ───────────────────────────────
// [[TOOL_CALL]]
// {"name":"bash","arguments":{"command":"npm test"}}
// [[/TOOL_CALL]]
// ────────────────────────────────────────────────────────────

/**
 * Parse all file-write blocks from the LLM response text.
 * Returns array of { filePath, content } objects.
 */
function extractFileBlocks(text) {
  const blocks = [];
  if (!text) return blocks;

  // 1) Primary: safe bracket markers
  //    [[WRITE_FILE: some/path.js]]
  //    content
  //    [[END_FILE]]
  const safeRe = /\[\[WRITE_FILE:\s*(.+?)\]\]\s*\n([\s\S]*?)\n?\s*\[\[END_FILE\]\]/gi;
  let m;
  while ((m = safeRe.exec(text)) !== null) {
    blocks.push({
      filePath: m[1].trim(),
      content: m[2], // preserve content exactly
    });
  }

  // 2) Also try fenced code block variant:
  //    ```write:some/path.js
  //    content
  //    ```
  const fencedRe = /```write:([^\n]+)\n([\s\S]*?)```/gi;
  while ((m = fencedRe.exec(text)) !== null) {
    // Avoid duplicates
    const fp = m[1].trim();
    if (!blocks.some((b) => b.filePath === fp)) {
      blocks.push({ filePath: fp, content: m[2] });
    }
  }

  // 3) Fallback: legacy <file path="...">...</file> (may be mangled)
  const legacyRe = /<file\s+path=["']([^"']+)["']>([\s\S]*?)<\/file>/gi;
  while ((m = legacyRe.exec(text)) !== null) {
    const fp = m[1].trim();
    if (!blocks.some((b) => b.filePath === fp)) {
      blocks.push({ filePath: fp, content: m[2].trim() });
    }
  }

  return blocks;
}

/**
 * Parse generic tool call blocks from LLM response.
 * Returns array of { name, arguments } objects.
 */
function extractToolCallBlocks(text) {
  const calls = [];
  if (!text) return calls;

  // [[TOOL_CALL]]
  // {"name":"bash","arguments":{"command":"ls -la"}}
  // [[/TOOL_CALL]]
  const re = /\[\[TOOL_CALL\]\]\s*\n?([\s\S]*?)\n?\s*\[\[\/TOOL_CALL\]\]/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed.name) {
        calls.push({
          name: parsed.name,
          arguments: parsed.arguments || {},
        });
      }
    } catch (e) {
      console.warn("[Parser] Failed to parse tool call JSON:", e.message);
    }
  }

  // Also try ```tool_call fenced blocks
  const fencedRe = /```tool_call\s*\n([\s\S]*?)```/gi;
  while ((m = fencedRe.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed.name) {
        calls.push({
          name: parsed.name,
          arguments: parsed.arguments || {},
        });
      }
    } catch (e) {
      console.warn("[Parser] Failed to parse fenced tool call:", e.message);
    }
  }

  return calls;
}

/**
 * Strip all file/tool markers from text, leaving only the conversational part.
 */
function stripAllMarkers(text) {
  if (!text) return "";

  return text
    .replace(/\[\[WRITE_FILE:\s*.+?\]\]\s*\n[\s\S]*?\n?\s*\[\[END_FILE\]\]/gi, "")
    .replace(/```write:[^\n]+\n[\s\S]*?```/gi, "")
    .replace(/<file\s+path=["'][^"']+["']>[\s\S]*?<\/file>/gi, "")
    .replace(/\[\[TOOL_CALL\]\]\s*\n?[\s\S]*?\n?\s*\[\[\/TOOL_CALL\]\]/gi, "")
    .replace(/```tool_call\s*\n[\s\S]*?```/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convert file blocks to tool call objects (write tool format).
 */
function fileBlocksToToolCalls(fileBlocks) {
  return fileBlocks.map((block) => ({
    name: "write",
    arguments: {
      filePath: block.filePath,
      content: block.content,
    },
  }));
}

/**
 * Convert raw tool call objects to OpenAI-compatible tool_calls array.
 */
function toOpenAIToolCalls(toolCalls) {
  return toolCalls.map((tc, idx) => ({
    id: `call_bridge_${Date.now()}_${idx}`,
    type: "function",
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
    },
  }));
}

module.exports = {
  extractFileBlocks,
  extractToolCallBlocks,
  stripAllMarkers,
  fileBlocksToToolCalls,
  toOpenAIToolCalls,
};
