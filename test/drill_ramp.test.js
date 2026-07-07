// Unit tests for the drill conductor's pure ramp-decision function
// (_ndDrillRampDecision), ported from slopsmith note_detect 1.39.1 as part
// of the drill-conductor port. Covers the four actions: hold (missed the
// goal), advance (cleared below full speed), consolidate (cleared at the top
// but more full-speed reps to bank), and graduate (cleared at the top for
// the required Nth time).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadDetectionCore } = require('./_loader');

const { drillRampDecision } = loadDetectionCore();

test('missing the goal holds at the current rung', () => {
    const d = drillRampDecision(0.5, 0.85, 1, 3);
    assert.strictEqual(d.action, 'hold');
    assert.strictEqual(d.nextRung, 1);
});

test('clearing the goal below full speed advances one rung', () => {
    const d = drillRampDecision(0.9, 0.85, 0, 3);
    assert.strictEqual(d.action, 'advance');
    assert.strictEqual(d.nextRung, 1);
});

test('clearing at the top with reps still owed consolidates (no graduate yet)', () => {
    // rung 2 of a 3-rung ladder = full speed; 0 clears banked, 3 reps required.
    const d = drillRampDecision(1.0, 0.85, 2, 3, 0, 3);
    assert.strictEqual(d.action, 'consolidate');
    assert.strictEqual(d.nextRung, 2);
});

test('clearing at the top for the final rep graduates', () => {
    // 2 clears already banked + this one = 3 = reps required → graduate.
    const d = drillRampDecision(1.0, 0.85, 2, 3, 2, 3);
    assert.strictEqual(d.action, 'graduate');
    assert.strictEqual(d.nextRung, 2);
});

test('reps=1 graduates on the first full-speed clear (legacy behaviour)', () => {
    const d = drillRampDecision(0.85, 0.85, 2, 3, 0, 1);
    assert.strictEqual(d.action, 'graduate');
});

test('score exactly at the goal counts as cleared', () => {
    const d = drillRampDecision(0.85, 0.85, 0, 3);
    assert.strictEqual(d.action, 'advance');
});

test('non-finite score holds (never spuriously advances)', () => {
    assert.strictEqual(drillRampDecision(NaN, 0.85, 0, 3).action, 'hold');
    assert.strictEqual(drillRampDecision(undefined, 0.85, 1, 3).action, 'hold');
});
