"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { PromptManager } = require("../prompt-manager");

test("buildPrompt includes per-turn execution reminder near latest turn", async () => {
  const manager = new PromptManager({
    templates: {
      systemWrapper: (s) => s,
      contextSummary: () => "",
      continuePrompt: "continue",
      toolInstructions: () => "",
      executionReminder: "Act immediately",
    },
  });

  const prompt = await manager.buildPrompt({
    systemPrompt: "SYSTEM",
    tools: [],
    formattedTurns: [{ role: "user", text: "Do work" }],
  });

  assert.match(prompt, /<execution_reminder>\nAct immediately\n<\/execution_reminder>/);
  assert.ok(
    prompt.indexOf("<execution_reminder>") < prompt.indexOf("Do work"),
    "execution reminder should appear before latest user turn"
  );
});

test("buildPrompt enforces no-plan imperative in kick suffix", async () => {
  const manager = new PromptManager();

  const prompt = await manager.buildPrompt({
    systemPrompt: null,
    tools: [],
    formattedTurns: [{ role: "user", text: "Do work" }],
  });

  assert.match(prompt, /Begin now\. No planning prose\./);
  assert.match(prompt, /\[\[TOOL_CALL\]\], \[\[WRITE_FILE: \.\.\.\]\], or \[\[TASK_FINISHED\]\] block\./);
});
