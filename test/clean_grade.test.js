// Unit tests for the clean/loose hit grade (_ndGradeClean), ported from
// slopsmith note_detect 1.39.1. `clean` is a tighter sub-grade INSIDE the hit
// window — it never turns a hit into a miss, only labels a technically-hit
// note as loose (too-late/too-off) so the coach can surface sloppy spots.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadDetectionCore } = require('./_loader');

const { gradeClean } = loadDetectionCore();

test('a miss is never clean', () => {
    const r = gradeClean(false, 5, 2, 50, 12);
    assert.strictEqual(r.clean, false);
    assert.strictEqual(r.looseReason, null);
});

test('a hit well inside both clean bands is clean', () => {
    const r = gradeClean(true, 20, 5, 50, 12);
    assert.strictEqual(r.clean, true);
    assert.strictEqual(r.looseReason, null);
});

test('a hit past the clean TIMING band is loose (timing)', () => {
    const r = gradeClean(true, 80, 5, 50, 12);
    assert.strictEqual(r.clean, false);
    assert.strictEqual(r.looseReason, 'timing');
});

test('a hit past the clean PITCH band is loose (pitch)', () => {
    const r = gradeClean(true, 20, 19, 50, 12);
    assert.strictEqual(r.clean, false);
    assert.strictEqual(r.looseReason, 'pitch');
});

test('a hit past BOTH clean bands is loose (both)', () => {
    const r = gradeClean(true, 90, 30, 50, 12);
    assert.strictEqual(r.clean, false);
    assert.strictEqual(r.looseReason, 'both');
});

test('exactly at the clean threshold is still clean (strictly-greater is loose)', () => {
    const r = gradeClean(true, 50, 12, 50, 12);
    assert.strictEqual(r.clean, true);
});

test('null pitch error (chord / unmeasured) does not force loose', () => {
    const r = gradeClean(true, 20, null, 50, 12);
    assert.strictEqual(r.clean, true);
    assert.strictEqual(r.looseReason, null);
});
