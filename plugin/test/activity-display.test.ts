import test from "node:test";
import assert from "node:assert/strict";
import {
	progressSummary,
	prioritizeSteps,
	percent,
	count,
	cost,
	duration,
} from "../shared/activity-display.ts";
test("progress bars count completed steps only and prioritize active and blocked work", () => {
	const steps = [
		{ text: "done", status: "completed" as const },
		{ text: "waiting", status: "blocked" as const },
		{ text: "next", status: "pending" as const },
		{ text: "working", status: "in_progress" as const },
	];
	assert.deepEqual(progressSummary(steps), {
		completed: 1,
		total: 4,
		blocked: 1,
		percent: 25,
	});
	assert.equal(progressSummary([]).percent, null);
	assert.deepEqual(
		prioritizeSteps(steps).map((x) => x.step.text),
		["working", "waiting", "next", "done"],
	);
	assert.equal(steps[0].text, "done");
});
test("unknown meters stay unknown while malformed values cannot overflow the track", () => {
	assert.equal(percent(undefined), null);
	assert.equal(percent(null), null);
	assert.equal(percent(NaN), null);
	assert.equal(percent(0), 0);
	assert.equal(percent(-5), 0);
	assert.equal(percent(200), 100);
});
test("compact values retain small costs and format elapsed time", () => {
	assert.equal(cost(null), "—");
	assert.equal(cost(0), "$0");
	assert.equal(cost(0.00001), "<$0.001");
	assert.equal(cost(0.03), "$0.030");
	assert.equal(count(1000), "1,000");
	assert.equal(duration(undefined), "—");
	assert.equal(duration(150), "150ms");
	assert.equal(duration(1500), "1.5s");
	assert.equal(duration(65000), "1m 5s");
	assert.equal(duration(3660000), "1h 1m");
});
