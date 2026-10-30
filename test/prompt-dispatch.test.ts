import assert from "node:assert/strict";
import test from "node:test";
import { dispatchPaseoPrompt } from "../extension/prompt-dispatch.ts";

const commands = () => [{ name: "slow-mode", source: "extension" }, { name: "review", source: "prompt" }];

test("ordinary streaming prompts queue follow-up input with template expansion", async () => {
  let options: unknown;
  const pi = { getCommands: commands, sendUserMessage(_content: unknown, received: unknown) { options = received; } };
  assert.deepEqual(await dispatchPaseoPrompt(pi, "/review", "/review", true), {});
  assert.deepEqual(options, { deliverAs: "followUp", expandPromptTemplates: true });
});

test("synchronous native submission failures reject instead of acknowledging acceptance", async () => {
  const pi = { getCommands: commands, sendUserMessage() { throw new Error("extension runtime is no longer active"); } };
  await assert.rejects(dispatchPaseoPrompt(pi, "literal", "literal", false), /runtime is no longer active/);
});

test("extension-command attachments fail before stock Pi can discard them", async () => {
  const pi = { getCommands: commands, sendUserMessage() { assert.fail("must not submit image-losing command"); } };
  await assert.rejects(dispatchPaseoPrompt(pi, [{ type: "image", data: "a", mimeType: "image/png" }], "/slow-mode", false), /do not accept image attachments/);
});
