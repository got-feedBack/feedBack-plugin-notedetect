// HPS (Harmonic Product Spectrum) detector tests.
//
// HPS exists to solve a specific failure mode of YIN: bass signals with
// suppressed fundamentals (amp-sim DI, small-speaker playback, heavy
// compression) where YIN's time-domain autocorrelation locks onto the
// 2nd harmonic and reports the pitch one octave high. These tests lock
// in the core win (suppressed-fundamental recovery), guard against
// clean-signal regressions, and document the under-buffered contract.
//
// Real instrument signals always carry some harmonic content, so clean-
// signal regression guards use `harmonicMix` rather than pure sines —
// pure sines are a pathological case for HPS (no harmonics means the
// product collapses at the fundamental bin), not representative of
// actual guitar/bass notes users will play.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');
const { harmonicMix, cents } = require('./_signals');

const core = loadDetectionCore();
const SR = 48000;
const DURATION = 4096 / SR;  // match the plugin's YIN buffer size for parity
const CENT_TOLERANCE = 50;

test('HPS recovers bass E1 (41.2 Hz) with fundamental ~26dB below 2nd harmonic', () => {
    // YIN reports this as 82.4 Hz (octave-up). HPS should land on ~41.2 Hz.
    const sig = harmonicMix(41.2, [[1, 0.05], [2, 1.0], [3, 0.5]], SR, DURATION);
    const r = core.hpsDetect(sig, SR);
    assert.ok(r.freq > 0, 'HPS returned no detection');
    const err = Math.abs(cents(r.freq, 41.2));
    assert.ok(err < CENT_TOLERANCE, `HPS drift ${err.toFixed(1)} cents exceeds ${CENT_TOLERANCE}`);
});

test('HPS recovers 5-string low B (30.87 Hz) with suppressed fundamental', () => {
    const sig = harmonicMix(30.87, [[1, 0.05], [2, 1.0], [3, 0.5]], SR, DURATION);
    const r = core.hpsDetect(sig, SR);
    assert.ok(r.freq > 0, 'HPS returned no detection on low B');
    const err = Math.abs(cents(r.freq, 30.87));
    assert.ok(err < CENT_TOLERANCE, `low-B drift ${err.toFixed(1)} cents exceeds ${CENT_TOLERANCE}`);
});

test('HPS on a guitar-like 82 Hz signal stays within ±50 cents — regression guard', () => {
    // HPS must not actively fail on signals YIN handles cleanly; users
    // who opt into HPS for bass shouldn't be punished on occasional
    // clean guitar/bass notes. Real guitar/bass always has harmonic
    // content — modelled here with fundamental + 2nd + 3rd harmonic.
    const sig = harmonicMix(82.4, [[1, 1.0], [2, 0.5], [3, 0.3]], SR, DURATION);
    const r = core.hpsDetect(sig, SR);
    assert.ok(r.freq > 0, 'HPS returned no detection on guitar-like signal');
    const err = Math.abs(cents(r.freq, 82.4));
    assert.ok(err < CENT_TOLERANCE, `drift ${err.toFixed(1)} cents exceeds ${CENT_TOLERANCE}`);
});

test('HPS on a guitar-like 220 Hz signal (A3) stays within ±50 cents', () => {
    const sig = harmonicMix(220, [[1, 1.0], [2, 0.5], [3, 0.3]], SR, DURATION);
    const r = core.hpsDetect(sig, SR);
    assert.ok(r.freq > 0, 'HPS returned no detection on A3 signal');
    const err = Math.abs(cents(r.freq, 220));
    assert.ok(err < CENT_TOLERANCE, `A3 drift ${err.toFixed(1)} cents exceeds ${CENT_TOLERANCE}`);
});

test('HPS under-buffered guard mirrors YIN: 1024 samples at 30 Hz → underBuffered:true', () => {
    // At 30 Hz a usable FFT bin width needs >3200 samples. HPS uses the
    // same minHalfLenForFreq check as YIN; confirm it signals the
    // shortfall instead of returning a garbage pitch.
    const sig = harmonicMix(30, [[1, 1.0], [2, 0.5]], SR, 1024 / SR);
    const r = core.hpsDetect(sig, SR);
    assert.equal(r.underBuffered, true);
    assert.equal(r.freq, -1);
});
