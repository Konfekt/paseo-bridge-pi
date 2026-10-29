import test from "node:test";
import assert from "node:assert/strict";
import { openGoalForm } from "../client/goal-form.ts";

test("paused goal draft validates objective and optional budget without triggering effects", () => {
  const form = openGoalForm();
  assert.equal(form.getState().canSubmit, false);
  form.setObjective("  Verify independent child execution  ");
  assert.equal(form.getState().canSubmit, true);
  assert.equal(form.getState().tokenBudget, undefined);
  for (const value of ["0", "-1", "1.5", "1e3", "1000001", "Infinity", "not a number"]) {
    form.setBudget(value);
    assert.equal(form.getState().canSubmit, false, value);
    assert.ok(form.getState().budgetError, value);
  }
  form.setBudget("1000000");
  assert.equal(form.getState().canSubmit, true);
  assert.equal(form.getState().tokenBudget, 1000000);
  form.setBudget(" ");
  assert.equal(form.getState().tokenBudget, undefined);
  form.setObjective("x".repeat(4001));
  assert.equal(form.getState().canSubmit, false);
  form.setObjective("  ");
  assert.equal(form.getState().canSubmit, false);
});

test("continuation limits validate independently and blank resets to inherited defaults", () => {
  const form = openGoalForm({ objective: "Verify limits", continuationLimits: { automaticTurns: 7, noProgressTurns: 2 } });
  assert.deepEqual(form.getState().continuationLimits, { automaticTurns: 7, noProgressTurns: 2 });
  for (const set of [form.setAutomaticTurns, form.setNoProgressTurns]) {
    for (const invalid of ["0", "-1", "1.5", "1e3", "Infinity", "9007199254740992"]) {
      set(invalid); assert.equal(form.getState().canSubmit, false, invalid);
    }
    set(""); assert.equal(form.getState().canSubmit, true);
  }
  assert.deepEqual(form.getState().continuationLimits, { automaticTurns: null, noProgressTurns: null });
});

test("draft retains edits for subscribers and closes without contaminating another form", () => {
  const edit = openGoalForm({ objective: "Existing goal", tokenBudget: 3000 });
  const create = openGoalForm();
  let updates = 0;
  const unsubscribe = edit.subscribe(() => { updates++; });
  edit.setObjective("Edited goal");
  edit.setBudget("4000");
  assert.equal(updates, 2);
  assert.equal(edit.getState().objective, "Edited goal");
  assert.equal(create.getState().objective, "");
  unsubscribe();
  edit.close();
  edit.setObjective("Must not publish");
  assert.equal(edit.getState().objective, "Edited goal");
  assert.equal(updates, 2);
});
