// Verifies: YIN surfaces "buffer too small for requested min frequency" as a
// distinct state (result.underBuffered = true) rather than a silent -1.
//
// Mathematically YIN cannot detect a period longer than its halfLen; at 48 kHz
// a 41.2 Hz fundamental needs tau ~1165 samples, which requires halfLen > 1165,
// i.e. buffer.length >= ~2400. A 2048-sample buffer (halfLen 1024) is strictly
// incapable of detecting bass E1 — that's physics, not a bug. What WAS a bug:
// the "no detection" result was indistinguishable from "true silence", so any
// break in the frame-accumulation path would drop every bass note with no
// diagnostic. The fix: return {underBuffered: true} when halfLen is below the
// configured minimum frequency, and have the caller log once.
//
// Tests accept either a valid detection OR an explicit underBuffered flag.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');
const { sine } = require('./_signals');

const core = loadDetectionCore();
const SR = 48000;

test('YIN detects guitar E2 (82 Hz) with a single 2048-sample frame — baseline', () => {
    const buf = sine(82.4, SR, 2048 / SR);
    const r = core.yinDetect(buf, SR);
    assert.ok(r.freq > 0, 'expected detection, got nothing');
    assert.ok(Math.abs(r.freq - 82.4) < 2, `expected ~82.4, got ${r.freq}`);
});

test('YIN signals underBuffered (not silent -1) for bass E1 with a 2048-sample frame', () => {
    const buf = sine(41.2, SR, 2048 / SR);
    const r = core.yinDetect(buf, SR);
    assert.ok(
        r.freq > 0 || r.underBuffered === true,
        `expected either detection or underBuffered flag; got ${JSON.stringify(r)}`
    );
});

test('YIN signals underBuffered for 5-string low B with a 2048-sample frame', () => {
    const buf = sine(30.87, SR, 2048 / SR);
    const r = core.yinDetect(buf, SR);
    assert.ok(
        r.freq > 0 || r.underBuffered === true,
        `expected either detection or underBuffered flag; got ${JSON.stringify(r)}`
    );
});

test('YIN does NOT flag underBuffered at 4096 samples (enough for 30 Hz min)', () => {
    const buf = sine(41.2, SR, 4096 / SR);
    const r = core.yinDetect(buf, SR);
    assert.equal(r.underBuffered, false);
});

test('YIN detects bass E1 (41 Hz) with 4096-sample buffer — the accumulated path works', () => {
    const buf = sine(41.2, SR, 4096 / SR);
    const r = core.yinDetect(buf, SR);
    assert.ok(r.freq > 0);
    assert.ok(Math.abs(r.freq - 41.2) < 0.5, `expected ~41.2, got ${r.freq}`);
});
