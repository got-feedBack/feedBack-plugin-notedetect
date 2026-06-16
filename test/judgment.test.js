const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

test('classifyTiming uses signed millisecond errors', () => {
    assert.equal(core.classifyTiming(0, 100), 'OK');
    assert.equal(core.classifyTiming(100, 100), 'OK');
    assert.equal(core.classifyTiming(-101, 100), 'EARLY');
    assert.equal(core.classifyTiming(101, 100), 'LATE');
    assert.equal(core.classifyTiming(null, 100), null);
});

test('classifyPitch uses signed cent errors', () => {
    assert.equal(core.classifyPitch(0, 20), 'OK');
    assert.equal(core.classifyPitch(-20, 20), 'OK');
    assert.equal(core.classifyPitch(21, 20), 'SHARP');
    assert.equal(core.classifyPitch(-21, 20), 'FLAT');
    assert.equal(core.classifyPitch(null, 20), null);
});

test('nearestOctaveCents folds octave-up detector readings into hit-range pitch error', () => {
    assert.equal(core.nearestOctaveCents(52, 40), 0);
    assert.equal(Math.round(core.nearestOctaveCents(52.25, 40)), 25);
    assert.equal(Math.round(core.nearestOctaveCents(51.8, 40)), -20);
});

test('makeJudgment marks a clean matched note as hit', () => {
    const j = core.makeJudgment({
        matched: true,
        note: { s: 1, f: 3 },
        noteTime: 10,
        judgedAt: 10.04,
        expectedMidi: 48,
        detectedMidi: 48.1,
        pitchError: 10,
        timingThresholdMs: 100,
        pitchThresholdCents: 20,
        confidence: 0.9,
    });
    assert.equal(j.hit, true);
    assert.equal(j.timingState, 'OK');
    assert.equal(j.timingError, 40);
    assert.equal(j.pitchState, 'OK');
    assert.equal(j.pitchError, 10);
    assert.deepEqual(j.note, { s: 1, f: 3 });
});

test('makeJudgment preserves independent timing and pitch failures', () => {
    const j = core.makeJudgment({
        matched: true,
        noteTime: 10,
        judgedAt: 10.14,
        pitchError: -35,
        timingThresholdMs: 100,
        pitchThresholdCents: 20,
    });
    assert.equal(j.hit, false);
    assert.equal(j.timingState, 'LATE');
    assert.equal(j.timingError, 140);
    assert.equal(j.pitchState, 'FLAT');
    assert.equal(j.pitchError, -35);
});

// ── Chord-specific timing threshold (issue #38) ──────────────────────────
//
// Chord events get a wider timing-OK window than single notes — chord
// strums span 5–10 ms across strings, the per-string FFT analysis smears
// strike timing by another 50–100 ms, and fast power-chord punk players
// anticipate the beat by 80–120 ms. The pipeline pipes a separate
// `chordTimingHitThreshold` setting through to `_ndMakeJudgment` via
// `timingThresholdMs` for chord judgments; these tests pin the contract
// that `_ndMakeJudgment` honors whatever threshold the caller passed.

test('makeJudgment (chord): -130ms timing error hits at chord threshold 150ms', () => {
    // Player anticipated the chord by 130 ms (well outside the 100 ms
    // single-note window). Chord scorer cleared isHit, so the per-string
    // score is fine; only the timing classification is in doubt. With
    // chord threshold 150 ms, this should classify OK and the judgment
    // should be a hit.
    const j = core.makeJudgment({
        matched: true,
        chord: true,
        notes: [{ s: 0, f: 5 }, { s: 1, f: 7 }, { s: 2, f: 7 }],
        noteTime: 10,
        judgedAt: 9.87,    // 130 ms early
        expectedMidi: 45,
        timingThresholdMs: 150,
        pitchError: null,  // chord judgments don't carry a monophonic pitch
        score: 0.667,
        hitStrings: 2,
        totalStrings: 3,
    });
    assert.equal(j.timingError, -130);
    assert.equal(j.timingState, 'OK', 'chord threshold 150 ms should accept -130 ms');
    assert.equal(j.hit, true, 'chord with OK timing and no pitch state must hit');
});

test('makeJudgment (chord): -130ms timing error misses at single-note threshold 100ms', () => {
    // Same chord scenario but with the old single-note 100 ms threshold —
    // this is the pre-fix behavior. Confirms the wider threshold is what's
    // actually doing the rescuing, not some other tweak in the judgment
    // path.
    const j = core.makeJudgment({
        matched: true,
        chord: true,
        notes: [{ s: 0, f: 5 }, { s: 1, f: 7 }, { s: 2, f: 7 }],
        noteTime: 10,
        judgedAt: 9.87,    // 130 ms early
        expectedMidi: 45,
        timingThresholdMs: 100,
        pitchError: null,
        score: 0.667,
        hitStrings: 2,
        totalStrings: 3,
    });
    assert.equal(j.timingState, 'EARLY');
    assert.equal(j.hit, false, 'chord at -130 ms must miss when threshold is 100 ms');
});

test('makeJudgment: timing classification is threshold-agnostic for chord vs single-note', () => {
    // _ndMakeJudgment itself does not branch on `chord` for the timing
    // classification — it honours whatever `timingThresholdMs` the
    // caller passed. The chord-only widening lives at the call site
    // (createNoteDetector's makeMatchedJudgment / makeMissJudgment
    // closures), which select chordTimingHitThreshold vs
    // timingHitThreshold based on extra.chord. End-to-end coverage of
    // that selection is via the harness regression fixture (Bad Habit)
    // — the harness drives the closures and a divergence between chord
    // and single-note thresholds shows up directly in the hit count.
    // What this test pins is the unit-level contract: when a caller
    // hands _ndMakeJudgment a 150 ms threshold (chord-typical) for a
    // single-note judgment, the classifier still accepts -130 ms — so
    // the wider threshold isn't silently capped by some chord-specific
    // gate inside the function.
    const j = core.makeJudgment({
        matched: true,
        chord: false,
        note: { s: 0, f: 5 },
        noteTime: 10,
        judgedAt: 9.87,
        expectedMidi: 45,
        detectedMidi: 45,
        pitchError: 0,
        timingThresholdMs: 150,
        pitchThresholdCents: 20,
    });
    assert.equal(j.timingState, 'OK');
    assert.equal(j.hit, true);
});

test('makeJudgment represents an unmatched pure miss without pitch labels', () => {
    const j = core.makeJudgment({
        matched: false,
        note: { s: 2, f: 5 },
        noteTime: 12,
        judgedAt: 12.4,
        expectedMidi: 55,
    });
    assert.equal(j.hit, false);
    assert.equal(j.timingState, null);
    assert.equal(j.timingError, null);
    assert.equal(j.pitchState, null);
    assert.equal(j.pitchError, null);
    assert.equal(j.detectedAt, null);
    assert.equal(j.expectedMidi, 55);
});
