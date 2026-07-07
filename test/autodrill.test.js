// Unit tests for the auto-drill trigger's pure functions
// (_ndAutoDrillShouldTrigger / _ndAutoDrillRange). Auto-drill drops the player
// straight into a drill loop after N contiguous missed notes, so they don't
// have to finish a run to reach the practice loop.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadDetectionCore } = require('./_loader');

const { autoDrillShouldTrigger, autoDrillRange } = loadDetectionCore();

test('does not trigger when disabled (threshold 0)', () => {
    assert.strictEqual(autoDrillShouldTrigger(10, 0, false, true), false);
});

test('does not trigger below the threshold', () => {
    assert.strictEqual(autoDrillShouldTrigger(2, 3, false, true), false);
});

test('triggers exactly at the threshold', () => {
    assert.strictEqual(autoDrillShouldTrigger(3, 3, false, true), true);
});

test('triggers above the threshold', () => {
    assert.strictEqual(autoDrillShouldTrigger(5, 3, false, true), true);
});

test('does not trigger while already drilling', () => {
    assert.strictEqual(autoDrillShouldTrigger(5, 3, true, true), false);
});

test('does not trigger when not playing', () => {
    assert.strictEqual(autoDrillShouldTrigger(5, 3, false, false), false);
});

test('range covers the missed span when it is wide enough', () => {
    const r = autoDrillRange(10, 13, 1.5);
    assert.strictEqual(r.start, 10);
    assert.strictEqual(r.end, 13);
});

test('range widens a tight cluster to the minimum span', () => {
    const r = autoDrillRange(10.0, 10.3, 1.5);
    assert.strictEqual(r.start, 10);
    assert.ok(Math.abs(r.end - 11.5) < 1e-9, `end ${r.end} should be start+minSpan`);
});

test('range clamps a negative start to 0', () => {
    const r = autoDrillRange(-2, 1, 1.5);
    assert.strictEqual(r.start, 0);
    // end = max(1, 0 + 1.5) = 1.5
    assert.ok(Math.abs(r.end - 1.5) < 1e-9);
});

test('range falls back to a min-span window when the last time is missing', () => {
    const r = autoDrillRange(5, NaN, 1.5);
    assert.strictEqual(r.start, 5);
    assert.ok(Math.abs(r.end - 6.5) < 1e-9);
});
