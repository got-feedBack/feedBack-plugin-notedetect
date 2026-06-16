// Tests _ndResolveDisplayFingering — the chart-context-aware resolver that
// picks the (string, fret) to show in the HUD and highway overlay.
//
// Rule (from research on score-followers and our app's needs):
//   If a candidate chart note's expected pitch is within the pitch tolerance
//   of the detected MIDI, including whole-octave detector mistakes, report
//   that note's (s, f). Otherwise fall back to the geometric first-match on
//   the arrangement's tuning.
//
// This avoids the need to pick between multiple geometrically-valid
// fingerings for the same pitch — the chart already tells us which one
// the player is supposed to be on.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();
const CENTS = 50;

// ── Guitar ──────────────────────────────────────────────────────────────────

test('guitar A2 played, chart expects open A (string 1 fret 0): display shows (1, 0)', () => {
    // Geometric fallback would say (0, 5) — first match on low-E string.
    // With the chart in play, we should show the charted fingering.
    const r = core.resolveDisplayFingering(45, [{ s: 1, f: 0, t: 0 }], 'guitar', CENTS);
    assert.deepEqual(r, { string: 1, fret: 0 });
});

test('guitar A2 played, chart expects (string 0 fret 5): display shows (0, 5)', () => {
    // Same pitch, different charted fingering — resolver matches the chart.
    const r = core.resolveDisplayFingering(45, [{ s: 0, f: 5, t: 0 }], 'guitar', CENTS);
    assert.deepEqual(r, { string: 0, fret: 5 });
});

test('guitar A2 played with no chart candidates: falls back to geometric (0, 5)', () => {
    const r = core.resolveDisplayFingering(45, [], 'guitar', CENTS);
    assert.deepEqual(r, { string: 0, fret: 5 });
});

test('guitar: detected pitch close (30 cents) to chart note still resolves to chart fingering', () => {
    // MIDI 45.3 ≈ 30 cents sharp of A2; within the 50-cent tolerance.
    const r = core.resolveDisplayFingering(45.3, [{ s: 1, f: 0, t: 0 }], 'guitar', CENTS);
    assert.deepEqual(r, { string: 1, fret: 0 });
});

test('guitar low E octave-up detector result resolves to charted open low E', () => {
    // YIN can lock onto the second harmonic and report E3 (MIDI 52) for
    // open low E (MIDI 40). During a chart note, the HUD should still show
    // the authored fingering instead of the geometric fallback (0, 12).
    const r = core.resolveDisplayFingering(52, [{ s: 0, f: 0, t: 0 }], 'guitar', CENTS);
    assert.deepEqual(r, { string: 0, fret: 0 });
});

test('guitar open A octave-up detector result resolves to charted open A', () => {
    // Without octave-aware chart matching this would fall through to (0, 17).
    const r = core.resolveDisplayFingering(57, [{ s: 1, f: 0, t: 0 }], 'guitar', CENTS);
    assert.deepEqual(r, { string: 1, fret: 0 });
});

test('guitar octave-up pitch with no chart candidates still uses geometric fallback', () => {
    const r = core.resolveDisplayFingering(52, [], 'guitar', CENTS);
    assert.deepEqual(r, { string: 0, fret: 12 });
});

test('guitar: detected pitch far (120 cents) from any chart note: geometric fallback', () => {
    // Player is playing something that doesn't match the chart note; show the
    // geometric guess for the played pitch, not the chart's fingering.
    const r = core.resolveDisplayFingering(47.2, [{ s: 1, f: 0, t: 0 }], 'guitar', CENTS);
    // 47.2 ≈ B2; first match on guitar low-E string at fret 7
    assert.deepEqual(r, { string: 0, fret: 7 });
});

// ── Bass ────────────────────────────────────────────────────────────────────

test('bass G2 played, chart expects open G string (string 3 fret 0): display shows (3, 0)', () => {
    // Without chart context the bass geometric fallback gives (0, 15).
    // With the chart, we want to show the open G where the player actually is.
    const r = core.resolveDisplayFingering(43, [{ s: 3, f: 0, t: 0 }], 'bass', CENTS);
    assert.deepEqual(r, { string: 3, fret: 0 });
});

test('bass A1 played, chart expects open A (string 1 fret 0): display shows (1, 0)', () => {
    const r = core.resolveDisplayFingering(33, [{ s: 1, f: 0, t: 0 }], 'bass', CENTS);
    assert.deepEqual(r, { string: 1, fret: 0 });
});

test('bass E1 played with no chart candidates: falls back to (0, 0)', () => {
    const r = core.resolveDisplayFingering(28, [], 'bass', CENTS);
    assert.deepEqual(r, { string: 0, fret: 0 });
});

test('bass low E octave-up detector result resolves to charted open low E', () => {
    const r = core.resolveDisplayFingering(40, [{ s: 0, f: 0, t: 0 }], 'bass', CENTS);
    assert.deepEqual(r, { string: 0, fret: 0 });
});

test('bass: chord candidate (multiple notes) — resolver picks the note matching detected pitch', () => {
    // A bass "chord" of open E + open A; player plays the A. Resolver should
    // identify which note in the chord the player is on.
    const r = core.resolveDisplayFingering(33, [
        { s: 0, f: 0, t: 0 }, // open E — MIDI 28, off by 5 semitones
        { s: 1, f: 0, t: 0 }, // open A — MIDI 33, matches
    ], 'bass', CENTS);
    assert.deepEqual(r, { string: 1, fret: 0 });
});

test('bass: detected pitch matches no chart note — geometric fallback still first-match-wins', () => {
    // Player noodling on bass D2 while chart expects G2 — no match, fall back.
    const r = core.resolveDisplayFingering(38, [{ s: 3, f: 0, t: 0 }], 'bass', CENTS);
    assert.deepEqual(r, { string: 0, fret: 10 });
});
