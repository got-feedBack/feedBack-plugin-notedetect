// Unit tests for the clean/loose hit grade (_ndGradeClean), ported from
// slopsmith note_detect 1.39.1. `clean` is a tighter sub-grade INSIDE the hit
// window — it never turns a hit into a miss, only labels a technically-hit
// note as loose (too-late/too-off) so the coach can surface sloppy spots.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadDetectionCore } = require('./_loader');

const { gradeClean, makeJudgment, createNoteDetector } = loadDetectionCore();

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

// Invariant through the full judgment path (not gradeClean directly): a
// loose grade must NEVER downgrade a real hit. A note 80 ms late is inside
// the 100 ms hit window (hit) but past the 50 ms clean band (loose/timing).
test('_ndMakeJudgment: late-but-in-window note stays hit while clean is false', () => {
    const j = makeJudgment({
        matched: true,
        note: { s: 0, f: 3 },
        noteTime: 1.0,
        judgedAt: 1.080,               // 80 ms late
        expectedMidi: 55,
        detectedMidi: 55,              // dead-on pitch
        pitchError: 0,
        timingThresholdMs: 100,
        pitchThresholdCents: 20,
        cleanTimingThresholdMs: 50,
        cleanPitchThresholdCents: 12,
    });
    assert.strictEqual(j.hit, true, 'must remain a hit');
    assert.strictEqual(j.clean, false, 'loose on timing');
    assert.strictEqual(j.looseReason, 'timing');
});

// Harness clamp: a clean threshold set absurdly high is capped at the hit
// threshold (the clean band lives strictly inside the hit window).
test('_harness.setSettings clamps an absurdly-high clean threshold to <= hit threshold', () => {
    const det = createNoteDetector({ isDefault: false });
    det._harness.setSettings({
        pitchHitThreshold: 20,
        timingHitThreshold: 0.1,
        cleanPitchThreshold: 999,
        cleanTimingThreshold: 999,
    });
    const s = det._harness.getSettings();
    assert.ok(s.cleanPitchThreshold <= s.pitchHitThreshold,
        `cleanPitch ${s.cleanPitchThreshold} must be <= hit ${s.pitchHitThreshold}`);
    assert.ok(s.cleanTimingThreshold <= s.timingHitThreshold,
        `cleanTiming ${s.cleanTimingThreshold} must be <= hit ${s.timingHitThreshold}`);
    assert.strictEqual(s.cleanPitchThreshold, 20);
});
