"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractFileBlocks,
  extractToolCallBlocks,
  stripAllMarkers,
  fileBlocksToToolCalls,
  toOpenAIToolCalls,
} = require("../file-block-parser");

test("extractFileBlocks parses safe marker blocks", () => {
  const input = [
    "hello",
    "[[WRITE_FILE: src/index.js]]",
    "console.log('ok');",
    "[[END_FILE]]",
  ].join("\n");

  const blocks = extractFileBlocks(input);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].filePath, "src/index.js");
  assert.equal(blocks[0].content, "console.log('ok');");
});

test("extractToolCallBlocks parses structured tool call markers", () => {
  const input = [
    "prefix",
    "[[TOOL_CALL]]",
    '{"name":"bash","arguments":{"command":"npm test"}}',
    "[[/TOOL_CALL]]",
  ].join("\n");

  const calls = extractToolCallBlocks(input);
  assert.deepEqual(calls, [{ name: "bash", arguments: { command: "npm test" } }]);
});

test("stripAllMarkers removes file and tool marker payloads", () => {
  const input = [
    "Before",
    "[[WRITE_FILE: src/a.js]]",
    "const a = 1;",
    "[[END_FILE]]",
    "Middle",
    "[[TOOL_CALL]]",
    '{"name":"bash","arguments":{"command":"echo test"}}',
    "[[/TOOL_CALL]]",
    "After",
  ].join("\n");

  const cleaned = stripAllMarkers(input);
  assert.equal(cleaned, "Before\n\nMiddle\n\nAfter");
});

test("fileBlocksToToolCalls and toOpenAIToolCalls produce OpenAI tool call format", () => {
  const blocks = [{ filePath: "src/main.js", content: "module.exports = {};" }];
  const rawCalls = fileBlocksToToolCalls(blocks);
  assert.deepEqual(rawCalls, [{
    name: "write",
    arguments: {
      filePath: "src/main.js",
      content: "module.exports = {};",
    },
  }]);

  const openAICalls = toOpenAIToolCalls(rawCalls);
  assert.equal(openAICalls.length, 1);
  assert.equal(openAICalls[0].type, "function");
  assert.equal(openAICalls[0].function.name, "write");
  assert.equal(typeof openAICalls[0].function.arguments, "string");
});
