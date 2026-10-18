import assert from "node:assert/strict";
import test from "node:test";
import { dispatchPaseoPrompt, isExtensionCommand } from "../extension/prompt-dispatch.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("recognizes only exact extension commands", () => {
  const pi = {
    getCommands: () => [
      { name: "slow-mode", source: "extension" },
      { name: "review", source: "prompt" },
    ],
    sendUserMessage() {},
  };
  assert.equal(isExtensionCommand(pi, "/slow-mode"), true);
  assert.equal(isExtensionCommand(pi, "/slow-mode off"), true);
  assert.equal(isExtensionCommand(pi, "/slow-mode-extra"), false);
  assert.equal(isExtensionCommand(pi, "/review"), false);
  assert.equal(isExtensionCommand(pi, "plain text"), false);
});

test("dispatches Paseo extension commands and waits for completion", async () => {
  const completion = deferred();
  let options: unknown;
  const pi = {
    getCommands: () => [{ name: "slow-mode", source: "extension" }],
    sendUserMessage(_content: unknown, received: unknown) {
      options = received;
      return completion.promise;
    },
  };

  let settled = false;
  const dispatched = dispatchPaseoPrompt(pi, "/slow-mode", "/slow-mode", false).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  completion.resolve();

  assert.deepEqual(await dispatched, { agentInvoked: false });
  assert.deepEqual(options, { expandPromptTemplates: true });
});

test("expands ordinary prompts while acknowledging them asynchronously", async () => {
  const completion = deferred();
  let options: unknown;
  const pi = {
    getCommands: () => [{ name: "review", source: "prompt" }],
    sendUserMessage(_content: unknown, received: unknown) {
      options = received;
      return completion.promise;
    },
  };

  assert.deepEqual(await dispatchPaseoPrompt(pi, "/review", "/review", true), { agentInvoked: true });
  assert.deepEqual(options, { deliverAs: "followUp", expandPromptTemplates: true });
  completion.resolve();
});

test("cancellable ordinary prompt preserves the draft on cancellation", async () => {
  let submissions = 0;
  let received: unknown;
  const pi = {
    getCommands: () => [],
    sendUserMessage() { submissions += 1; },
    async dispatchCancellablePrompt(_content: unknown, options: unknown) {
      received = options;
      return false;
    },
  };
  assert.deepEqual(await dispatchPaseoPrompt(pi, "draft", "draft", false), { agentInvoked: false, cancelled: true });
  assert.equal(submissions, 0);
  assert.deepEqual(received, { expandPromptTemplates: true });
});

test("cancellable ordinary prompt submits exactly once on Ignore", async () => {
  let submissions = 0;
  const pi = {
    getCommands: () => [],
    sendUserMessage() { submissions += 1; },
    async dispatchCancellablePrompt(content: unknown, options: unknown) {
      pi.sendUserMessage(content, options);
      return true;
    },
  };
  assert.deepEqual(await dispatchPaseoPrompt(pi, "draft", "draft", false), { agentInvoked: true });
  assert.equal(submissions, 1);
});

test("reports extension command failures", async () => {
  const failure = new Error("command failed");
  const pi = {
    getCommands: () => [{ name: "slow-mode", source: "extension" }],
    sendUserMessage() {
      return Promise.reject(failure);
    },
  };

  await assert.rejects(dispatchPaseoPrompt(pi, "/slow-mode", "/slow-mode", false), failure);
});
