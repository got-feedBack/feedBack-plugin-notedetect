// Tests the pure geometric fallback _ndMidiToStringFret for bass arrangements.
//
// The fallback is used when the player is noodling between chart notes; chart-
// aware display resolution happens in _ndResolveDisplayFingering (see
// display-fingering.test.js). For isolated pitches without context the
// research literature (Sayegh 1989, more recent CNN / DP approaches) consistently
// cites a lowest-position-wins baseline, but none have reliable single-note
// tie-breaks without biomechanical context — so we use first-match-wins on the
// arrangement's standard tuning for a deterministic, context-free answer.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const core = loadDetectionCore();

// Bass 4-string standard: E1 A1 D2 G2
const BASS_E1 = 28;
const BASS_A1 = 33;
const BASS_D2 = 38;
const BASS_G2 = 43;
const BASS_B0 = 23; // 5-string low B, below 4-string range

test('guitar E2 (MIDI 40) maps to string 0, fret 0 — baseline', () => {
    const r = core.midiToStringFret(40);
    assert.deepEqual(r, { string: 0, fret: 0 });
});

test('guitar E4 (MIDI 64) geometric fallback picks string 0 fret 24 (first match)', () => {
    // Research baseline: "lowest possible fret" is the common isolated-pitch
    // heuristic, but the plugin historically uses first-match-wins iterating
    // strings 0..N. Document the actual behavior — chart context flips this to
    // the charted fingering when relevant (see display-fingering tests).
    const r = core.midiToStringFret(64);
    assert.deepEqual(r, { string: 0, fret: 24 });
});

test('bass E1 (MIDI 28) in bass arrangement maps to open E (string 0, fret 0)', () => {
    const r = core.midiToStringFret(BASS_E1, 'bass');
    assert.deepEqual(r, { string: 0, fret: 0 });
});

test('bass A1 (MIDI 33) off-chart resolves to low-E string fret 5 (first match)', () => {
    // A1 is playable as open string-1 OR fret-5 on string-0; first-match-wins
    // gives the low-E interpretation. With chart context, the resolver picks
    // whichever matches the chart note.
    const r = core.midiToStringFret(BASS_A1, 'bass');
    assert.deepEqual(r, { string: 0, fret: 5 });
});

test('bass G2 (MIDI 43) off-chart resolves to low-E string fret 15 (first match)', () => {
    // Same rationale — chart context will override to (string 3, fret 0) when
    // the chart expects the open G. See display-fingering tests.
    const r = core.midiToStringFret(BASS_G2, 'bass');
    assert.deepEqual(r, { string: 0, fret: 15 });
});

test('5-string bass low B (MIDI 23) is out of range for a 4-string bass arrangement', () => {
    // Explicit stringCount=4 makes the "out of range because 4-string" framing
    // unambiguous; with stringCount=5 (below) this same MIDI is in range.
    const r = core.midiToStringFret(BASS_B0, 'bass', 4);
    assert.deepEqual(r, { string: -1, fret: -1 });
});

test('bass D2 (MIDI 38) off-chart resolves to low-E string fret 10 (first match)', () => {
    const r = core.midiToStringFret(BASS_D2, 'bass');
    assert.deepEqual(r, { string: 0, fret: 10 });
});

// ── 5-string bass — B0 E1 A1 D2 G2 ────────────────────────────────────────

test('5-string bass low B (MIDI 23) maps to open low-B string (s0, f0)', () => {
    const r = core.midiToStringFret(BASS_B0, 'bass', 5);
    assert.deepEqual(r, { string: 0, fret: 0 });
});

test('5-string bass E1 (MIDI 28) first-match on low-B string at fret 5', () => {
    // Playable as open string-1 OR fret-5 on string-0 (low B). First-match-wins
    // favours the low-B interpretation; chart context would flip it to open E1.
    const r = core.midiToStringFret(BASS_E1, 'bass', 5);
    assert.deepEqual(r, { string: 0, fret: 5 });
});

test('5-string bass G2 (MIDI 43) first-match on low-B string at fret 20', () => {
    const r = core.midiToStringFret(BASS_G2, 'bass', 5);
    assert.deepEqual(r, { string: 0, fret: 20 });
});

test('5-string bass midiFromStringFret(0, 0) returns MIDI 23 (open low B)', () => {
    assert.equal(core.midiFromStringFret(0, 0, 'bass', 5), 23);
});

test('5-string bass midiFromStringFret(4, 0) returns MIDI 43 (open G2 is now string 4)', () => {
    // Confirms the string indexing — on 4-string the open G was string 3;
    // on 5-string it's string 4 because the new low B shifted every other
    // string up by one.
    assert.equal(core.midiFromStringFret(4, 0, 'bass', 5), 43);
});
