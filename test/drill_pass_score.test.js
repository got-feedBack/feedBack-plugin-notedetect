// Unit tests for _ndDrillPassScore + the "no play, no pass" invariant.
// Regression for: a drill loop graduated ("Nailed! Now widening") even when the
// player did nothing, because the pass was scored hits/(notes the detector
// HEARD) — a silent pass collapsed to 0/0 and skipped, or stale hits read 100%.
// The fix scores hits/(CHARTED notes in the window): no play → score 0 → the
// ramp decision holds (never advances/graduates).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadDetectionCore } = require('./_loader');

const { drillPassScore, drillRampDecision } = loadDetectionCore();

test('null when nothing is charted (chart loading / rest-only window)', () => {
    assert.strictEqual(drillPassScore(0, 0), null);
    assert.strictEqual(drillPassScore(3, 0), null);
    assert.strictEqual(drillPassScore(0, NaN), null);
});

test('played nothing over N charted notes scores 0 (a fail, not a skip)', () => {
    assert.strictEqual(drillPassScore(0, 8), 0);
});

test('partial hits score the real fraction, not 100%', () => {
    assert.strictEqual(drillPassScore(2, 8), 0.25);
    assert.strictEqual(drillPassScore(6, 8), 0.75);
});

test('all charted notes hit scores 1', () => {
    assert.strictEqual(drillPassScore(8, 8), 1);
});

test('stray/negative hit counts are floored at 0', () => {
    assert.strictEqual(drillPassScore(-3, 4), 0);
});

// The end-to-end invariant the user hit: a silent pass must NOT advance the
// drill. Compose the (fixed) pass score with the unchanged ramp decision.
test('silent pass over a charted window holds the drill (no advance/graduate)', () => {
    const goal = 0.85;
    const score = drillPassScore(0, 10);            // played nothing, 10 charted
    const d = drillRampDecision(score, goal, /*rung*/ 0, /*ladderLength*/ 3);
    assert.strictEqual(d.action, 'hold');
});

test('a genuine clean pass still advances', () => {
    const goal = 0.85;
    const score = drillPassScore(10, 10);
    const d = drillRampDecision(score, goal, 0, 3);
    assert.strictEqual(d.action, 'advance');
});
