import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { applyRemoteModel } from "../extension/model-sync.ts";

function fixture() {
  const changes: unknown[] = [];
  // Execute the pinned Pi's real setModel and setThinkingLevel without auth,
  // network, resource discovery, or persistent user settings.
  const session = Object.assign(Object.create(AgentSession.prototype), {
    agent: { state: { model: { provider: "openai-codex", id: "gpt-6-luna" }, thinkingLevel: "high" } },
    _modelRuntime: { checkAuth: async () => true },
    settingsManager: { getModelThinkingLevel: () => undefined, getDefaultThinkingLevel: () => "low" },
    sessionManager: {
      appendModelChange: (...args: unknown[]) => changes.push(["model", ...args]),
      appendThinkingLevelChange: (level: string) => changes.push(["thinking", level]),
    },
    getAvailableThinkingLevels: () => ["off", "low", "medium", "high"],
    _emit: () => {},
    _extensionRunner: { emit: async () => {} },
    _emitModelSelect: async () => {},
  });
  let calls = 0;
  const apply = async (model: any) => { calls++; await session.setModel(model); return true; };
  return { session, changes, apply, calls: () => calls };
}

test("same-model import/reattach echo preserves explicit thinking with real Pi setters", async () => {
  const f = fixture();
  // Establish the native behavior responsible for the regression.
  await f.session.setModel({ ...f.session.model });
  assert.equal(f.session.thinkingLevel, "low");
  f.session.setThinkingLevel("high");
  f.changes.length = 0;
  for (let i = 0; i < 2; i++) {
    assert.equal(await applyRemoteModel(f.session.model, { ...f.session.model }, f.apply), true);
  }
  assert.equal(f.session.thinkingLevel, "high");
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.changes, []);
  // Deliberate reasoning changes remain allowed, not pinned to launch level.
  f.session.setThinkingLevel("medium");
  assert.equal(f.session.thinkingLevel, "medium");
});

test("different model or provider preserves Pi's intentional switch semantics", async () => {
  for (const model of [{ provider: "openai-codex", id: "gpt-6-astra" }, { provider: "other", id: "gpt-6-luna" }]) {
    const f = fixture();
    assert.equal(await applyRemoteModel(f.session.model, model, f.apply), true);
    assert.equal(f.calls(), 1);
    assert.deepEqual(f.session.model, model);
    assert.equal(f.session.thinkingLevel, "low");
    assert.deepEqual(f.changes, [["model", model.provider, model.id], ["thinking", "low"]]);
  }
});

test("unknown current model still applies; setter failures propagate", async () => {
  const model = { provider: "p", id: "m" };
  assert.equal(await applyRemoteModel(undefined, model, async () => false), false);
  await assert.rejects(applyRemoteModel(undefined, model, async () => { throw new Error("auth"); }), /auth/);
});
