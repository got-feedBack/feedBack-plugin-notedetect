// Multi-input source binding (WS3).
//
// An instance created with { ownSource: true } allocates its own engine input
// source on enable (addSource), routes EVERY bridge call to the *Source* methods
// keyed by that sourceId (never the legacy source-0 methods), and frees it on
// destroy (removeSource). A default instance (no ownSource) stays on the legacy
// source-0 methods — byte-identical.
//
// The invariant we assert is path-independent: whichever scoring sub-path runs
// (engine-verifier or per-tick), a bound instance touches ONLY *Source* methods
// and a default instance touches ONLY legacy methods. The per-tick pitch poll
// fires every detect tick, giving a deterministic positive signal.
//
// In its own file so the per-detector timers/instances it creates don't perturb
// the shared-state assertions in desktop-bridge.test.js (Node isolates by file).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

async function flushPendingAsync(turns = 5) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

function sandboxWithSourceBridge({ partial = false } = {}) {
    const calls = {
        addSource: 0, removeSource: 0,
        // legacy (source-0) surface
        scoreChord: 0, setChart: 0, getNoteVerdicts: 0, getRawPitch: 0, getPitchDetection: 0,
        // source-indexed surface
        scoreSourceChord: 0, setSourceChart: 0, getSourceNoteVerdicts: 0,
        getSourceRawPitch: 0, getSourcePitchDetection: 0,
    };
    const seen = { addChannel: null, removeId: null, scoreSourceId: null };
    const intervalCallbacks = [];
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.navigator.mediaDevices.getUserMedia = () =>
                Promise.reject(new Error('getUserMedia should not be called on the bridge path'));
            sandbox.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            sandbox.highway.getChords = () => ([
                { t: 0, notes: [{ s: 0, f: 0 }, { s: 1, f: 0 }, { s: 2, f: 0 }] },
            ]);
            const okResult = (ctx) => ({
                score: 0, hitStrings: 0, totalStrings: ctx.notes.length, isHit: false,
                results: ctx.notes.map(n => ({ s: n.s, f: n.f, hit: false, bandEnergy: 0, centsDiff: null, centsError: null })),
            });
            const noDet = { midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' };
            sandbox.window.feedBackDesktop = {
                isDesktop: true, platform: 'linux',
                audio: {
                    isAvailable: async () => true,
                    isAudioRunning: async () => true,
                    startAudio: async () => {},
                    getSampleRate: async () => 48000,
                    getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
                    // Legacy (source 0)
                    getPitchDetection: async () => { calls.getPitchDetection++; return noDet; },
                    getRawPitch: async () => { calls.getRawPitch++; return noDet; },
                    scoreChord: async (ctx) => { calls.scoreChord++; return okResult(ctx); },
                    setChart: async () => { calls.setChart++; return true; },
                    getNoteVerdicts: async () => { calls.getNoteVerdicts++; return []; },
                    // Source-indexed — the FULL API, so an ownSource instance binds.
                    addSource: async (ch) => { calls.addSource++; seen.addChannel = ch; return 3; },
                    removeSource: (id) => { calls.removeSource++; seen.removeId = id; return true; },
                    getSourceRawPitch: async () => { calls.getSourceRawPitch++; return noDet; },
                    setSourceChart: async () => { calls.setSourceChart++; return true; },
                    getSourceNoteVerdicts: async () => { calls.getSourceNoteVerdicts++; return []; },
                    // `partial` drops scoreSourceChord so the FULL-source-API check
                    // (_ndDesktopSourceApiReady) fails → binding must NOT happen.
                    ...(partial ? {} : {
                        getSourcePitchDetection: async () => { calls.getSourcePitchDetection++; return noDet; },
                        scoreSourceChord: async (id, ctx) => { calls.scoreSourceChord++; seen.scoreSourceId = id; return okResult(ctx); },
                    }),
                },
            };
        },
    });
    return { createNoteDetector, calls, seen, intervalCallbacks };
}

async function driveDetectTicks(intervalCallbacks) {
    // Drive every captured interval a few times so the detect poll (pitch +
    // scoring) runs regardless of which timer it landed on.
    for (let round = 0; round < 3; round++) {
        for (const cb of intervalCallbacks) {
            // eslint-disable-next-line no-await-in-loop
            try { await cb(); } catch (_) { /* not the detect tick */ }
            // eslint-disable-next-line no-await-in-loop
            await flushPendingAsync();
        }
    }
}

const legacyTotal = (c) =>
    c.scoreChord + c.setChart + c.getNoteVerdicts + c.getRawPitch + c.getPitchDetection;
const sourceTotal = (c) =>
    c.scoreSourceChord + c.setSourceChart + c.getSourceNoteVerdicts + c.getSourceRawPitch + c.getSourcePitchDetection;

test('multi-input: ownSource instance binds a source and uses ONLY *Source* methods, freed on destroy', async () => {
    const { createNoteDetector, calls, seen, intervalCallbacks } = sandboxWithSourceBridge();
    const det = createNoteDetector({ isDefault: false, ownSource: true, channel: 1 });
    await det.enable();
    await flushPendingAsync();

    assert.equal(calls.addSource, 1, 'enable allocates exactly one engine source');
    assert.equal(seen.addChannel, 1, 'addSource is bound to the instance channel (right=1)');

    await driveDetectTicks(intervalCallbacks);

    assert.ok(sourceTotal(calls) >= 1, 'a bound instance drives the *Source* bridge methods');
    assert.equal(legacyTotal(calls), 0, 'a bound instance must NEVER touch the legacy source-0 methods');
    if (calls.scoreSourceChord > 0) {
        assert.equal(seen.scoreSourceId, 3, 'scoreSourceChord is keyed by the allocated sourceId');
    }

    det.destroy();
    await flushPendingAsync();
    assert.equal(calls.removeSource, 1, 'destroy frees the allocated source');
    assert.equal(seen.removeId, 3, 'removeSource is called with the allocated sourceId');
});

test('multi-input: default instance (no ownSource) uses ONLY legacy source-0 methods', async () => {
    const { createNoteDetector, calls, intervalCallbacks } = sandboxWithSourceBridge();
    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    assert.equal(calls.addSource, 0, 'a non-opted instance does not allocate a source');

    await driveDetectTicks(intervalCallbacks);

    assert.ok(legacyTotal(calls) >= 1, 'the default instance drives the legacy bridge methods');
    assert.equal(sourceTotal(calls), 0, 'the default instance must NEVER touch the *Source* methods');

    det.destroy();
    await flushPendingAsync();
    assert.equal(calls.removeSource, 0, 'nothing to free for the legacy path');
});

test('multi-input: caller-managed opts.sourceId binds without addSource and is not freed on destroy', async () => {
    const { createNoteDetector, calls, seen, intervalCallbacks } = sandboxWithSourceBridge();
    const det = createNoteDetector({ isDefault: false, sourceId: 5 });
    await det.enable();
    await flushPendingAsync();

    assert.equal(calls.addSource, 0, 'a caller-managed sourceId must NOT self-allocate');

    await driveDetectTicks(intervalCallbacks);

    assert.ok(sourceTotal(calls) >= 1, 'routes to the *Source* methods for the caller id');
    assert.equal(legacyTotal(calls), 0, 'never touches the legacy source-0 methods');
    if (calls.scoreSourceChord > 0) {
        assert.equal(seen.scoreSourceId, 5, 'routed to the caller-provided sourceId');
    }

    det.destroy();
    await flushPendingAsync();
    assert.equal(calls.removeSource, 0, 'a caller-managed source is the caller\'s to free, not ours');
});

test('multi-input: ownSource on a PARTIAL addon (no full source API) degrades to legacy, never binds', async () => {
    const { createNoteDetector, calls, intervalCallbacks } = sandboxWithSourceBridge({ partial: true });
    const det = createNoteDetector({ isDefault: false, ownSource: true, channel: 1 });
    await det.enable();
    await flushPendingAsync();

    assert.equal(calls.addSource, 0, 'must NOT bind a source the addon cannot score');

    await driveDetectTicks(intervalCallbacks);

    assert.ok(legacyTotal(calls) >= 1, 'falls back to the legacy source-0 path');
    assert.equal(sourceTotal(calls), 0, 'never routes to *Source* methods when unbound');

    det.destroy();
    await flushPendingAsync();
    assert.equal(calls.removeSource, 0, 'nothing was allocated, so nothing to free');
});
