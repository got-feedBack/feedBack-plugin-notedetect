// Constraint-based chord detection tests.
//
// The chord path bypasses YIN/HPS and asks a different question: instead of
// "what one frequency dominates this buffer?", it asks "for each string in
// the expected chord, is there enough energy in that string's frequency
// band?". These tests exercise the four building blocks individually and
// then the integrated `_ndScoreChord` to lock in:
//
//   1. Per-string frequency band math (default tuning, 8-string, capo offset)
//   2. _ndBandEnergy ratio behaviour (in-band, out-of-band, mixed)
//   3. _ndConstraintCheckString energy-only and pitch-check paths
//   4. _ndScoreChord aggregation, default 60% hit-ratio threshold,
//      and technique-flag adjustments (hammer-on lowers energy threshold,
//      harmonic skips pitch check).
//
// Six-string standard tuning string bands (computed from fret-0 to fret-24,
// with ±10% headroom) used as expected values throughout these tests:
//
//   string 0 (low E,  MIDI 40): [ 74.17,  362.59] Hz
//   string 1 (A,      MIDI 45): [ 99.00,  484.41] Hz
//   string 2 (D,      MIDI 50): [132.04,  645.50] Hz
//   string 3 (G,      MIDI 55): [176.39,  862.94] Hz
//   string 4 (B,      MIDI 59): [222.40, 1080.74] Hz
//   string 5 (high E, MIDI 64): [296.69, 1450.27] Hz

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');
const { sine } = require('./_signals');

const core = loadDetectionCore();
const SR = 48000;
const BUF_SAMPLES = 4096;
const DURATION = BUF_SAMPLES / SR;

const GUITAR_6 = { arrangement: 'guitar', stringCount: 6, offsets: [0, 0, 0, 0, 0, 0], capo: 0 };
const GUITAR_8 = { arrangement: 'guitar', stringCount: 8, offsets: [0, 0, 0, 0, 0, 0, 0, 0], capo: 0 };

// ── _ndStringBandHz ─────────────────────────────────────────────────────────

test('stringBandHz: 6-string standard low E spans ~74–363 Hz', () => {
    const [lo, hi] = core.stringBandHz(0, 'guitar', 6, GUITAR_6.offsets, 0);
    assert.ok(Math.abs(lo - 74.17) < 0.5, `lo ${lo.toFixed(2)} != ~74.17`);
    assert.ok(Math.abs(hi - 362.59) < 0.5, `hi ${hi.toFixed(2)} != ~362.59`);
});

test('stringBandHz: 6-string standard high E spans ~297–1450 Hz', () => {
    const [lo, hi] = core.stringBandHz(5, 'guitar', 6, GUITAR_6.offsets, 0);
    assert.ok(Math.abs(lo - 296.69) < 0.5, `lo ${lo.toFixed(2)} != ~296.69`);
    assert.ok(Math.abs(hi - 1450.27) < 1, `hi ${hi.toFixed(2)} != ~1450.27`);
});

test('stringBandHz: 8-string string 0 (F#1) starts ~41.6 Hz — uses _ND_TUNING_GUITAR_8', () => {
    // F#1 = MIDI 30 = 46.25 Hz. With −10% margin: 41.625 Hz.
    const [lo, hi] = core.stringBandHz(0, 'guitar', 8, GUITAR_8.offsets, 0);
    assert.ok(Math.abs(lo - 41.62) < 0.5, `lo ${lo.toFixed(2)} != ~41.62`);
    // fret-24 from F#1 is F#3 = MIDI 54 = 185 Hz. +10% margin: 203.5 Hz.
    assert.ok(Math.abs(hi - 203.5) < 0.5, `hi ${hi.toFixed(2)} != ~203.5`);
});

test('stringBandHz: capo 2 shifts the low-E band up by 2 semitones', () => {
    const [loCapo, hiCapo] = core.stringBandHz(0, 'guitar', 6, GUITAR_6.offsets, 2);
    // capo 2 raises openMidi from 40 (E2 ~82.41 Hz) to 42 (F#2 ~92.50 Hz).
    // lo with −10% margin: 92.50 * 0.9 = 83.25 Hz.
    assert.ok(Math.abs(loCapo - 83.25) < 0.5, `capo-2 lo ${loCapo.toFixed(2)} != ~83.25`);
    // fret-24 raises from MIDI 64 to MIDI 66 (369.99 Hz). hi with +10%: 406.99.
    assert.ok(Math.abs(hiCapo - 406.99) < 0.5, `capo-2 hi ${hiCapo.toFixed(2)} != ~406.99`);
});

// ── _ndBandEnergy ───────────────────────────────────────────────────────────

test('bandEnergy: ~100% when a single sine sits inside the band', () => {
    // FFT a 300 Hz sine and confirm the string-0 band captures essentially
    // all the energy. The production FFT path applies a Hann window, which
    // cuts sidelobe leakage, but the floor is still lenient to allow for
    // bin-edge / windowing effects.
    const buf = sine(300, SR, DURATION);
    // Use the constraint checker to get magnitudes via the same code path:
    // energy-only result.bandEnergy is the ratio we want.
    const r = core.constraintCheckString(buf, SR, /*string*/ 0, /*fret*/ 0,
        'guitar', 6, GUITAR_6.offsets, 0, /*pitchCheckCents*/ 0);
    assert.ok(r.bandEnergy > 0.9, `band energy ${r.bandEnergy.toFixed(3)} should be >0.9 (sine in band)`);
});

test('bandEnergy: ~0 when all energy is far above the band', () => {
    // 5000 Hz is well above string 0's [74, 363] Hz band.
    const buf = sine(5000, SR, DURATION);
    const r = core.constraintCheckString(buf, SR, 0, 0,
        'guitar', 6, GUITAR_6.offsets, 0, 0);
    assert.ok(r.bandEnergy < 0.05, `band energy ${r.bandEnergy.toFixed(3)} should be ~0 (sine out of band)`);
});

// ── _ndConstraintCheckString ────────────────────────────────────────────────

test('constraintCheckString: energy-only path passes when sine is in band', () => {
    const buf = sine(300, SR, DURATION);
    const r = core.constraintCheckString(buf, SR, 0, 0,
        'guitar', 6, GUITAR_6.offsets, 0, /*pitchCheckCents*/ 0);
    assert.equal(r.hit, true);
    assert.equal(r.centsDiff, null);
});

test('constraintCheckString: energy-only path fails when band has < 3% energy', () => {
    const buf = sine(5000, SR, DURATION);
    const r = core.constraintCheckString(buf, SR, 0, 0,
        'guitar', 6, GUITAR_6.offsets, 0, 0);
    assert.equal(r.hit, false);
});

test('constraintCheckString: pitch check fails when in-band signal is far off pitch', () => {
    // Expected pitch for string 0 fret 0 is E2 = 82.41 Hz. A 305 Hz sine sits
    // in the band but is ~2266 cents sharp. With a 50-cent tolerance the
    // octave-folded check must still reject it because it is not close to an
    // octave-equivalent E.
    const buf = sine(305, SR, DURATION);
    const r = core.constraintCheckString(buf, SR, 0, 0,
        'guitar', 6, GUITAR_6.offsets, 0, /*pitchCheckCents*/ 50);
    assert.equal(r.hit, false);
    assert.ok(r.centsDiff > 50, `centsDiff ${r.centsDiff} should be > 50`);
});

test('constraintCheckString: pitch check accepts within-tolerance signal', () => {
    // E2 = 82.41 Hz. A pure 82 Hz sine is ~9 cents flat — inside ±50 cents.
    // _ndFftMagnitude zero-pads up to a sample-rate-derived resolution
    // floor (~3 Hz/bin target), but a longer 16384-sample buffer here
    // gives a cleaner peak at this low frequency anyway.
    const longDur = 16384 / SR;
    const buf = sine(82, SR, longDur);
    const r = core.constraintCheckString(buf, SR, 0, 0,
        'guitar', 6, GUITAR_6.offsets, 0, /*pitchCheckCents*/ 50);
    assert.equal(r.hit, true);
    assert.ok(r.centsDiff < 50, `centsDiff ${r.centsDiff} should be < 50`);
});

test('constraintCheckString: pitch check accepts octave-up detector peak', () => {
    // E3 is an octave above the expected open low E. When the fundamental is
    // weak and the second harmonic dominates, the string should still count.
    const longDur = 16384 / SR;
    const buf = sine(164.81377845643496, SR, longDur);
    const r = core.constraintCheckString(buf, SR, 0, 0,
        'guitar', 6, GUITAR_6.offsets, 0, /*pitchCheckCents*/ 50);
    assert.equal(r.hit, true);
    assert.ok(r.centsDiff < 50, `centsDiff ${r.centsDiff} should be < 50`);
});

// ── _ndScoreChord ──────────────────────────────────────────────────────────

test('scoreChord: full chord with all bands ringing → 6/6 hit, isHit:true', () => {
    // 300 Hz lands in every 6-string band — confirmed by inspecting the
    // band table at the top of this file. Drives the chord scorer to
    // count every requested string as ringing.
    const buf = sine(300, SR, DURATION);
    const chord = [0, 1, 2, 3, 4, 5].map(s => ({ s, f: 0 }));
    const r = core.scoreChord(buf, SR, chord,
        'guitar', 6, GUITAR_6.offsets, 0, /*pitchCheckCents*/ 0, /*minHitRatio*/ 0.6);
    assert.equal(r.totalStrings, 6);
    assert.equal(r.hitStrings, 6);
    assert.equal(r.score, 1);
    assert.equal(r.isHit, true);
});

test('scoreChord: 4-of-6 strings (66%) clears default 60% threshold → isHit:true', () => {
    // 600 Hz lands in bands of strings 2,3,4,5 only (string 1 hi=484.4,
    // string 0 hi=362.6 — both excluded). Documented in the band table.
    const buf = sine(600, SR, DURATION);
    const chord = [0, 1, 2, 3, 4, 5].map(s => ({ s, f: 0 }));
    const r = core.scoreChord(buf, SR, chord,
        'guitar', 6, GUITAR_6.offsets, 0, 0, 0.6);
    assert.equal(r.hitStrings, 4);
    assert.equal(r.totalStrings, 6);
    assert.ok(r.score > 0.6, `score ${r.score} should clear 0.6`);
    assert.equal(r.isHit, true);
});

test('scoreChord: low-frequency-only signal misses default 60% threshold → isHit:false', () => {
    // 120 Hz nominally lands in strings 0 and 1 only (string 2 lo=132). With
    // FFT bin width ~11.7 Hz at 4096 samples leakage can spill into the
    // adjacent string-2 bin, so the exact hitStrings count is sensitive to
    // FFT geometry — the meaningful invariant is "score stays well below
    // 60%". hitStrings ≤ 3 keeps the test robust to leakage.
    const buf = sine(120, SR, DURATION);
    const chord = [0, 1, 2, 3, 4, 5].map(s => ({ s, f: 0 }));
    const r = core.scoreChord(buf, SR, chord,
        'guitar', 6, GUITAR_6.offsets, 0, 0, 0.6);
    assert.ok(r.hitStrings <= 3, `hitStrings ${r.hitStrings} should be ≤ 3`);
    assert.ok(r.score < 0.6, `score ${r.score} should be below 0.6`);
    assert.equal(r.isHit, false);
});

test('scoreChord: lowering minHitRatio to 0.3 flips a sub-60% chord to isHit:true', () => {
    // Same low-frequency-only chord; only the leniency setting changes.
    // Confirms the new chordHitRatio slider affects the hit decision.
    const buf = sine(120, SR, DURATION);
    const chord = [0, 1, 2, 3, 4, 5].map(s => ({ s, f: 0 }));
    const r = core.scoreChord(buf, SR, chord,
        'guitar', 6, GUITAR_6.offsets, 0, 0, /*minHitRatio*/ 0.3);
    assert.equal(r.isHit, true);
});

test('scoreChord: hammer-on flag lowers energy threshold so weak in-band signal still hits', () => {
    // Build a signal where the in-band fundamental carries ~2% of total
    // energy — below the default 3% threshold but above the hammer-on 1.5%
    // threshold. Out-of-band energy at 5000 Hz dominates total energy.
    const n = Math.round(SR * DURATION);
    const buf = new Float32Array(n);
    const inBand = 300, outBand = 5000;
    const inAmp = 0.15, outAmp = 1.0;
    for (let i = 0; i < n; i++) {
        buf[i] =
            inAmp * Math.sin(2 * Math.PI * inBand * i / SR) +
            outAmp * Math.sin(2 * Math.PI * outBand * i / SR);
    }
    // Normalize to 0.9 peak — preserves the in/out energy ratio.
    let peak = 0;
    for (let i = 0; i < n; i++) if (Math.abs(buf[i]) > peak) peak = Math.abs(buf[i]);
    if (peak > 0) for (let i = 0; i < n; i++) buf[i] *= 0.9 / peak;

    // String 0 only — single-note "chord" so we can read the result directly.
    const note = { s: 0, f: 0 };

    const noFlag = core.scoreChord(buf, SR, [{ ...note }],
        'guitar', 6, GUITAR_6.offsets, 0, 0, 0.5);
    const hammered = core.scoreChord(buf, SR, [{ ...note, ho: true }],
        'guitar', 6, GUITAR_6.offsets, 0, 0, 0.5);

    assert.equal(noFlag.hitStrings, 0,
        `expected weak in-band signal to miss without ho flag (bandEnergy=${noFlag.results[0].bandEnergy.toFixed(4)})`);
    assert.equal(hammered.hitStrings, 1,
        `expected ho:true to lower threshold and hit (bandEnergy=${hammered.results[0].bandEnergy.toFixed(4)})`);
});

test('scoreChord: harmonic flag bypasses pitch check so off-pitch in-band energy still hits', () => {
    // String 0 expected = E2 (82.41 Hz). A 305 Hz sine is in the band but
    // ~2266 cents sharp — a 50-cent pitch check rejects it. With hm:true
    // the check switches to energy-only and accepts.
    const buf = sine(305, SR, DURATION);

    const pitched = core.scoreChord(buf, SR, [{ s: 0, f: 0 }],
        'guitar', 6, GUITAR_6.offsets, 0, /*pitchCheckCents*/ 50, 0.5);
    const harmonic = core.scoreChord(buf, SR, [{ s: 0, f: 0, hm: true }],
        'guitar', 6, GUITAR_6.offsets, 0, 50, 0.5);

    assert.equal(pitched.hitStrings, 0, 'expected off-pitch signal to fail pitch check');
    assert.equal(harmonic.hitStrings, 1, 'expected hm:true to skip pitch check and hit');
});

// ── voicing-reduction credit ──────────────────────────────────────────────
//
// Real-song data (American Jesus, Bad Religion rhythm) showed players
// playing power-chord voicings (root + fifth on the bottom 2 strings)
// of full-chord charts and scoring "miss" because score = 2/6 = 0.33 fell
// below the default cr = 0.40. The voicing-reduction path in
// _ndScoreChord credits those as hits whenever ≥2 of the chord's
// strings ring at their expected pitches — no bass requirement, so
// non-bass two-string combinations (e.g. string skipping or muted-root
// strums) also qualify. These tests pin the conditions: hit on any
// 2 pitch-verified chord strings; miss on a single string alone; off
// when pitch checking is disabled (energy-only path).

function _summed(amps) {
    // Sum multiple sine() outputs into one buffer (truncate to shortest).
    let len = Infinity;
    for (const b of amps) if (b.length < len) len = b.length;
    const out = new Float32Array(len);
    for (const b of amps) for (let i = 0; i < len; i++) out[i] += b[i];
    return out;
}

test('voicing-reduction: root + fifth on a full E major chart flags voicingHit (rescue at retire)', () => {
    // Chart: full E major (all 6 strings). Audio: only the bottom two
    // strings of the voicing ring — low E (E2 = 82.4 Hz, MIDI 40) and
    // A-string fret 2 (B2 = 123.47 Hz, MIDI 47, the chord's fifth).
    // This is the classic power-chord interpretation of an open E.
    // Strict score = 2/6 = 0.33 → fails the 0.6 ratio, so `isHit`
    // (which mirrors the strict-ratio path now) stays false on the
    // scoreChord call. The `voicingHit` flag is what marks the chord
    // as "rescue this at retire time" — checkMisses (not exercised
    // here) reads it and records a hit judgment instead of a miss.
    const buf = _summed([sine(82.41, SR, DURATION, 0.5), sine(123.47, SR, DURATION, 0.5)]);
    const chord = [
        { s: 0, f: 0 }, { s: 1, f: 2 }, { s: 2, f: 2 },
        { s: 3, f: 1 }, { s: 4, f: 0 }, { s: 5, f: 0 },
    ];
    const r = core.scoreChord(buf, SR, chord, 'guitar', 6, GUITAR_6.offsets, 0, 50, 0.6);
    assert.equal(r.voicingHit, true, 'expected voicing-reduction flag');
    assert.equal(r.isHit, false, 'isHit reflects strict ratio only — voicing is rescued at retire');
    assert.ok(r.score < 0.6, `score ${r.score} should be below the strict ratio`);
    assert.ok(r.hitStrings >= 2, `hitStrings ${r.hitStrings} should be ≥ 2`);
});

test('voicing-reduction: bass-string only (root alone) does NOT credit', () => {
    // Just the low E ringing, no other chord string. Voicing-reduction
    // requires ≥ 2 strings to fire — a single string can't fake a chord.
    const buf = sine(82.4, SR, DURATION, 0.5);
    const chord = [
        { s: 0, f: 0 }, { s: 1, f: 2 }, { s: 2, f: 2 },
        { s: 3, f: 1 }, { s: 4, f: 0 }, { s: 5, f: 0 },
    ];
    const r = core.scoreChord(buf, SR, chord, 'guitar', 6, GUITAR_6.offsets, 0, 50, 0.6);
    assert.equal(r.voicingHit, false, 'single-string strum must not credit voicing');
    assert.equal(r.isHit, false);
});

test('voicing-reduction: any two pitch-verified chord strings credit voicing (no bass requirement)', () => {
    // Strings 4 (B3 = 246.94 Hz) and 5 (E4 = 329.63 Hz) ring but the
    // chord's bass (string 0) does not. Strict score is 2/6 = 0.33,
    // same hitStrings count as the root+fifth case. An earlier
    // formulation required the bass specifically to ring, but real-
    // song data showed players strumming mid/high chord strings
    // without sounding the bass (string skipping, hand position on
    // open chords, fast strumming) — those are still valid 2-note
    // chord voicings. As long as both strings ring at their
    // CORRECT pitches for the chord, voicing-reduction credits.
    const buf = _summed([sine(246.94, SR, DURATION, 0.5), sine(329.63, SR, DURATION, 0.5)]);
    const chord = [
        { s: 0, f: 0 }, { s: 1, f: 2 }, { s: 2, f: 2 },
        { s: 3, f: 1 }, { s: 4, f: 0 }, { s: 5, f: 0 },
    ];
    const r = core.scoreChord(buf, SR, chord, 'guitar', 6, GUITAR_6.offsets, 0, 50, 0.6);
    assert.equal(r.voicingHit, true, 'two pitch-verified chord-string hits should credit voicing');
    assert.ok(r.score < 0.6, `score ${r.score} should still be below the strict ratio`);
});

test('voicing-reduction: energy-only mode (pitchCheckCents=0) gates off voicing-reduction', () => {
    // 120 Hz sine — same signal as the "score < 60%, isHit false" test
    // above. With pitchCheckCents=0 the per-string `hit` flag is true
    // for any band with enough energy, so leakage can produce 2-3
    // hitStrings without actually matching pitches. Voicing-reduction
    // must NOT credit this: the bass-pitch-verified gate (centsDiff
    // finite) requires real pitch checking to have happened.
    const buf = sine(120, SR, DURATION);
    const chord = [0, 1, 2, 3, 4, 5].map(s => ({ s, f: 0 }));
    const r = core.scoreChord(buf, SR, chord, 'guitar', 6, GUITAR_6.offsets, 0, 0, 0.6);
    assert.equal(r.voicingHit, false, 'energy-only mode must not trigger voicing-reduction');
    assert.equal(r.isHit, false);
});

test('voicing-reduction: 2-string power-chord chart (already 2 strings) hits via ratio, voicingHit is informational', () => {
    // A 2-string chord chart (E5 power chord) with both strings ringing
    // hits 2/2 = 1.00 via the strict ratio path, regardless of voicing-
    // reduction. The bass-string condition is still satisfied so
    // voicingHit also fires — both paths agree on the hit. Confirms the
    // two paths are a disjunction (either-or) not exclusive.
    const buf = _summed([sine(82.4, SR, DURATION, 0.5), sine(123.47, SR, DURATION, 0.5)]);
    const chord = [{ s: 0, f: 0 }, { s: 1, f: 2 }];
    const r = core.scoreChord(buf, SR, chord, 'guitar', 6, GUITAR_6.offsets, 0, 50, 0.6);
    assert.equal(r.isHit, true);
    assert.equal(r.score, 1.0);
    assert.equal(r.voicingHit, true, 'voicingHit fires alongside the ratio path on full voicings');
});
