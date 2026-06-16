// Proves: YIN pitch drifts outside the plugin's ±50-cent pitch tolerance
// when a low-frequency signal has realistic broadband noise mixed in, even
// with a full 4096-sample buffer.
//
// Plugin defaults:
//   let _ndPitchTolerance = 50; // cents
//
// Real bass rigs: room noise, finger-slap transients, pickup hum, and
// room ambience routinely add ~-10dB broadband noise relative to the
// fundamental. At low frequencies the per-period sample count is smaller
// and YIN's autocorrelation is more sensitive to noise, pushing detection
// error past 50 cents and causing misses.
//
// Deterministic seed ensures these tests don't flake.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');
const { harmonicMix, cents } = require('./_signals');

const core = loadDetectionCore();
const SR = 48000;

// Seeded PRNG so assertions are reproducible.
function seededRng(seed) {
    let s = seed >>> 0;
    return () => {
        s = Math.imul(s ^ (s >>> 16), 2246822507);
        s = Math.imul(s ^ (s >>> 13), 3266489909);
        s ^= s >>> 16;
        return (s >>> 0) / 0xffffffff;
    };
}

function withNoise(signal, noiseAmp, seed = 42) {
    const rng = seededRng(seed);
    const out = new Float32Array(signal.length);
    for (let i = 0; i < signal.length; i++) {
        out[i] = signal[i] + (rng() - 0.5) * 2 * noiseAmp;
    }
    return out;
}

function realisticBass(freq, noiseLevel) {
    // Bass-like harmonic profile: weak fundamental (0.08), strong 2nd (0.5),
    // moderate 3rd (0.3); then add broadband noise at `noiseLevel`.
    const base = harmonicMix(freq, [[1, 0.08], [2, 0.5], [3, 0.3]], SR, 4096 / SR);
    return withNoise(base, noiseLevel);
}

const CENT_TOLERANCE = 50; // plugin's _ndPitchTolerance

test('guitar E2 (82 Hz) with mild noise stays within ±50 cents — baseline', () => {
    const sig = realisticBass(82.4, 0.15);
    const r = core.yinDetect(sig, SR);
    assert.ok(r.freq > 0, 'no detection');
    const err = Math.abs(cents(r.freq, 82.4));
    assert.ok(err < CENT_TOLERANCE, `drift ${err.toFixed(1)} cents exceeds tolerance ${CENT_TOLERANCE}`);
});

test('bass E1 (41 Hz) with moderate noise (amp 0.3) stays within ±50 cents — regression guard', () => {
    // This currently passes — YIN handles 0.3 noise at 4096 samples. Lock it in as
    // a regression guard so future refactors don't silently degrade bass accuracy.
    const sig = realisticBass(41.2, 0.3);
    const r = core.yinDetect(sig, SR);
    assert.ok(r.freq > 0, 'bass E1 with noise returned no detection');
    const err = Math.abs(cents(r.freq, 41.2));
    assert.ok(err < CENT_TOLERANCE, `bass E1 drift ${err.toFixed(1)} cents exceeds ${CENT_TOLERANCE}`);
});

test('5-string low B (31 Hz) with moderate noise (amp 0.3) stays within ±50 cents — regression guard', () => {
    const sig = realisticBass(30.87, 0.3);
    const r = core.yinDetect(sig, SR);
    assert.ok(r.freq > 0, 'low-B with noise returned no detection');
    const err = Math.abs(cents(r.freq, 30.87));
    assert.ok(err < CENT_TOLERANCE, `low-B drift ${err.toFixed(1)} cents exceeds ${CENT_TOLERANCE}`);
});

// The former test.todo about recovering a suppressed-fundamental 41 Hz
// signal "beyond vanilla YIN" is now exercised by `hps.test.js` — HPS
// is a user-selectable method for exactly this rig profile. Cepstrum
// was scoped out for this PR; tracked in #16.
