// Verifies the opt-in "native-frame detection" sub-mode of the desktop
// bridge (slopsmith#818).
//
// When the user enables the gear toggle (`nativeDetection`) on a desktop
// build whose engine exposes getRawAudioFrame, note_detect runs its OWN
// YIN/HPS/CREPE on the engine-captured PCM pulled via getRawAudioFrame —
// instead of consuming the engine's getPitchDetection/detectNotes verdicts —
// while CHORDS are still scored by the engine's harmonic-comb ChordScorer
// (scoreChord), because usingDesktopBridge stays true. This is the
// "own monophonic detector + engine chord verifier on engine audio"
// combination, and it bypasses Chromium's broken getUserMedia entirely.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');
const { sine } = require('./_signals');

async function flushPendingAsync(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

// A mono PCM frame long enough for the guitar analysis window (>= 4096
// samples at 48 kHz). C4 sine so YIN locks cleanly if it runs.
function nativeFrame() {
    return sine(261.63, 48000, 0.12, 0.5); // ~5760 samples
}

// Build a bridge sandbox with getRawAudioFrame wired and `nativeDetection`
// persisted on. `withRawFrames:false` simulates a downlevel addon that lacks
// the pull API, so the mode must NOT engage (verdict path stays).
function loadNativeFrameBridge({ withRawFrames = true } = {}) {
    const calls = {
        isAvailable: 0, isAudioRunning: 0, startAudio: 0,
        getPitchDetection: 0, getRawAudioFrame: 0, scoreChord: 0,
        getLevels: 0, getSampleRate: 0, getUserMedia: 0,
    };
    const intervalCallbacks = [];
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            // Persisted: native detection on + Detect enabled out of the gate.
            sandbox.localStorage.getItem = () => JSON.stringify({
                nativeDetection: true,
                detectEnabled: true,
            });
            sandbox.navigator.mediaDevices.getUserMedia = () => {
                calls.getUserMedia++;
                return Promise.reject(new Error('getUserMedia must not be called on the native-frame path'));
            };
            // Capture every interval; the test picks the detect tick by behaviour.
            sandbox.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            // One three-note chord at t=0 so the detect tick routes through
            // matchNotes()'s chord branch → engine scoreChord on the bridge.
            sandbox.highway.getChords = () => ([
                { t: 0, notes: [{ s: 0, f: 0 }, { s: 1, f: 0 }, { s: 2, f: 0 }] },
            ]);
            const audio = {
                isAvailable: async () => { calls.isAvailable++; return true; },
                isAudioRunning: async () => { calls.isAudioRunning++; return true; },
                startAudio: async () => { calls.startAudio++; },
                getPitchDetection: async () => {
                    calls.getPitchDetection++;
                    return { midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' };
                },
                getLevels: async () => {
                    calls.getLevels++;
                    return { inputLevel: 0.2, inputPeak: 0.3, outputLevel: 0, outputPeak: 0 };
                },
                getSampleRate: async () => { calls.getSampleRate++; return 48000; },
                scoreChord: async (ctx) => {
                    calls.scoreChord++;
                    return {
                        score: 0, hitStrings: 0, totalStrings: ctx.notes.length, isHit: false,
                        results: ctx.notes.map(n => ({
                            s: n.s, f: n.f, hit: false, bandEnergy: 0, centsDiff: null, centsError: null,
                        })),
                    };
                },
            };
            if (withRawFrames) {
                audio.getRawAudioFrame = async () => { calls.getRawAudioFrame++; return nativeFrame(); };
            }
            sandbox.window.slopsmithDesktop = { isDesktop: true, platform: 'darwin', audio };
        },
    });
    return { createNoteDetector, calls, intervalCallbacks };
}

test('native-frame: detect tick pulls getRawAudioFrame and bypasses the engine verdict path', async () => {
    const { createNoteDetector, calls, intervalCallbacks } = loadNativeFrameBridge();
    const det = createNoteDetector({ isDefault: true });
    await det.enable();
    await flushPendingAsync();

    assert.equal(calls.getUserMedia, 0, 'getUserMedia must not be called on the native-frame path');
    assert.ok(calls.getSampleRate >= 1, 'getSampleRate is still queried to drive the detector sample rate');
    assert.ok(intervalCallbacks.length >= 1, 'startAudio should register at least one interval');

    // Drive every captured interval once (one of them is the detect tick).
    for (const cb of intervalCallbacks) {
        // eslint-disable-next-line no-await-in-loop
        await cb();
        // eslint-disable-next-line no-await-in-loop
        await flushPendingAsync();
    }

    assert.ok(calls.getRawAudioFrame >= 1, 'the detect tick must pull engine PCM via getRawAudioFrame');
    assert.equal(calls.getPitchDetection, 0, 'the engine verdict path (getPitchDetection) must be bypassed');
    // Chords still go through the engine's harmonic-comb ChordScorer — the
    // mode keeps usingDesktopBridge true, so matchNotes' chord branch is
    // unchanged. This is byron's "include the chromatic-comb verifier too".
    assert.ok(calls.scoreChord >= 1, 'chords must still be scored by the engine scoreChord (harmonic-comb verifier)');

    det.destroy();
    await flushPendingAsync();
});

test('native-frame: downlevel addon without getRawAudioFrame falls back to the verdict path', async () => {
    const { createNoteDetector, calls, intervalCallbacks } = loadNativeFrameBridge({ withRawFrames: false });
    const det = createNoteDetector({ isDefault: true });
    await det.enable();
    await flushPendingAsync();

    for (const cb of intervalCallbacks) {
        // eslint-disable-next-line no-await-in-loop
        await cb();
        // eslint-disable-next-line no-await-in-loop
        await flushPendingAsync();
    }

    assert.equal(calls.getRawAudioFrame, 0, 'no raw-frame pull exists to call');
    assert.ok(calls.getPitchDetection >= 1, 'without getRawAudioFrame the engine verdict path must drive detection');
    assert.equal(calls.getUserMedia, 0, 'still a bridge build — getUserMedia must not be used');

    det.destroy();
    await flushPendingAsync();
});
