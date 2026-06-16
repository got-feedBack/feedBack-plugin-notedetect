// Verifies the slopsmith-desktop JUCE bridge branch in startAudio().
//
// When the renderer is hosted by slopsmith-desktop, `window.slopsmithDesktop`
// is exposed by the preload script (see slopsmith-desktop/src/main/preload.ts).
// In that environment the note-detect plugin MUST NOT call
// `navigator.mediaDevices.getUserMedia` — the native JUCE engine already owns
// the audio device and pitch detection runs over the `audio:getPitchDetection`
// IPC. Without this branch the Linux .deb build hits
// "Could not access audio input" (slopsmith-desktop#52).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

function freshSandboxWithBridge(overrides = {}) {
    const calls = {
        isAvailable: 0,
        isAudioRunning: 0,
        startAudio: 0,
        getPitchDetection: 0,
        getLevels: 0,
        getUserMedia: 0,
    };
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            // getUserMedia must NOT be reached on the bridge path. Throw
            // loudly if it is so the test fails with a clear cause
            // rather than silently passing because both code paths
            // happened to behave similarly under the stubs.
            sandbox.navigator.mediaDevices.getUserMedia = () => {
                calls.getUserMedia++;
                return Promise.reject(new Error('getUserMedia should not be called on the bridge path'));
            };
            sandbox.window.slopsmithDesktop = Object.assign({
                isDesktop: true,
                platform: 'linux',
                audio: {
                    isAvailable: async () => { calls.isAvailable++; return true; },
                    isAudioRunning: async () => { calls.isAudioRunning++; return false; },
                    startAudio: async () => { calls.startAudio++; },
                    getPitchDetection: async () => {
                        calls.getPitchDetection++;
                        return { midiNote: 60, confidence: 0.9, frequency: 261.63, cents: 0, noteName: 'C4' };
                    },
                    getLevels: async () => {
                        calls.getLevels++;
                        return { inputLevel: 0.2, inputPeak: 0.3, outputLevel: 0, outputPeak: 0 };
                    },
                },
            }, overrides);
        },
    });
    return { createNoteDetector, calls };
}

// Yield a few event-loop turns so the async work queued through
// `enable()` → `queueAudioOp(...)` → `startAudio()` has a chance to
// reach `await desktop.audio.isAvailable()` and the subsequent bridge
// calls before the test runs its assertions. setImmediate runs on the
// macrotask queue, which is what we want — awaiting it gives the
// promise chain time to drain between turns.
async function flushPendingAsync(turns = 5) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

test('bridge path: enable() consults the desktop bridge instead of getUserMedia', async () => {
    const { createNoteDetector, calls } = freshSandboxWithBridge();
    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    assert.equal(calls.getUserMedia, 0, 'getUserMedia must not be called when the desktop bridge is available');
    assert.ok(calls.isAvailable >= 1, 'desktop.audio.isAvailable should be probed');
    // isAudioRunning + startAudio are best-effort wakes — at least one
    // should be touched so the engine is alive before pitch polling.
    assert.ok(calls.isAudioRunning + calls.startAudio >= 1,
        'desktop bridge should wake the engine if it isn\'t already running');
    det.destroy();
});

test('bridge path: falls back to getUserMedia when audio.isAvailable() resolves false', async () => {
    const { createNoteDetector, calls } = freshSandboxWithBridge({
        audio: {
            isAvailable: async () => false,
            isAudioRunning: async () => false,
            startAudio: async () => {},
            getPitchDetection: async () => ({ midiNote: -1, confidence: 0 }),
            getLevels: async () => ({ inputLevel: 0, inputPeak: 0 }),
        },
    });
    const det = createNoteDetector({ isDefault: false });
    // enable() will resolve false because the fallback getUserMedia
    // stub rejects in vm — what we're asserting is that the fallback
    // WAS attempted (the bridge correctly refused). isAvailable was
    // checked through the override so calls.isAvailable stays 0 here;
    // instead we observe getUserMedia being invoked.
    await det.enable();
    await flushPendingAsync();
    assert.ok(calls.getUserMedia >= 1,
        'bridge present but engine unavailable should fall through to getUserMedia');
    det.destroy();
});

test('bridge path: browser environment (no window.slopsmithDesktop) still uses getUserMedia', async () => {
    // No bridge sandbox — vanilla loader. getUserMedia in the default
    // navigator stub rejects, so enable() returns false; we just want
    // to confirm the bridge branch did NOT swallow execution.
    const { createNoteDetector } = loadDetectionCore();
    const det = createNoteDetector({ isDefault: false });
    const result = await det.enable();
    // enable() returns false when startAudio() returns false; the
    // important invariant is that we don't crash trying to read
    // window.slopsmithDesktop.
    assert.equal(typeof result, 'boolean');
    det.destroy();
});

test('bridge path: chord scoring wiring — calls scoreChord IPC, never subscribes to onInputFrame', async () => {
    // The slopsmith-desktop release that unblocks polyphonic chord
    // scoring on Electron exposes audio.scoreChord — a request/reply
    // IPC that the native JUCE ChordScorer evaluates against the
    // engine's internal input ring. No audio buffers cross IPC.
    // We pin three things here:
    //  1. The bridge wins (no getUserMedia / Web-Audio fallback).
    //  2. scoreChord is actually invoked when a chord falls inside
    //     the timing tolerance window, with a request shape that
    //     mirrors the chart-note metadata.
    //  3. The removed onInputFrame push-stream surface is never
    //     subscribed — the stub throws if called so a regression
    //     resurfacing the streaming path would trip immediately.
    // Chord-scoring accuracy itself is covered by chord-detection.
    // test.js against the JS reference implementation that backs the
    // browser path.
    const calls = {
        isAvailable: 0,
        isAudioRunning: 0,
        startAudio: 0,
        getPitchDetection: 0,
        getLevels: 0,
        getSampleRate: 0,
        scoreChord: 0,
        onInputFrame: 0,
        getUserMedia: 0,
    };
    const scoreChordRequests = [];
    const intervalCallbacks = [];
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.navigator.mediaDevices.getUserMedia = () => {
                calls.getUserMedia++;
                return Promise.reject(new Error('getUserMedia should not be called when bridge is fully wired'));
            };
            // Capture every setInterval callback the plugin registers
            // — the test will pick the detect tick out by behaviour
            // below (the one that calls getPitchDetection / scoreChord
            // on the bridge audio mock). Earlier revisions of this
            // test hard-coded "first registration", which broke when
            // startAudio()'s timer ordering shifted; behaviour-based
            // probing is robust to refactors.
            sandbox.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            // Highway returns a single three-note chord at t=0 inside
            // the default 100 ms timing-tolerance window, so the
            // bridge's detect tick routes it through matchNotes()'s
            // chord branch (group.length >= 2).
            sandbox.highway.getChords = () => ([
                { t: 0, notes: [
                    { s: 0, f: 0 },
                    { s: 1, f: 0 },
                    { s: 2, f: 0 },
                ]},
            ]);
            sandbox.window.slopsmithDesktop = {
                isDesktop: true,
                platform: 'linux',
                audio: {
                    isAvailable: async () => { calls.isAvailable++; return true; },
                    isAudioRunning: async () => { calls.isAudioRunning++; return true; },
                    startAudio: async () => { calls.startAudio++; },
                    getPitchDetection: async () => {
                        calls.getPitchDetection++;
                        return { midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' };
                    },
                    getLevels: async () => {
                        calls.getLevels++;
                        return { inputLevel: 0.0, inputPeak: 0.0, outputLevel: 0, outputPeak: 0 };
                    },
                    getSampleRate: async () => { calls.getSampleRate++; return 48000; },
                    scoreChord: async (ctx) => {
                        calls.scoreChord++;
                        scoreChordRequests.push(ctx);
                        return {
                            score: 0,
                            hitStrings: 0,
                            totalStrings: ctx.notes.length,
                            isHit: false,
                            results: ctx.notes.map(n => ({
                                s: n.s, f: n.f, hit: false,
                                bandEnergy: 0, centsDiff: null, centsError: null,
                            })),
                        };
                    },
                    // Regression guard: the previous implementation
                    // subscribed to this push stream. The new path
                    // dispatches scoreChord on demand instead, so any
                    // call here is a bug — throw loudly.
                    onInputFrame: () => {
                        calls.onInputFrame++;
                        throw new Error('bridge should not subscribe to onInputFrame on the scoreChord path');
                    },
                },
            };
        },
    });

    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    assert.equal(calls.getUserMedia, 0, 'getUserMedia must not be called when the bridge is fully wired');
    assert.ok(calls.getSampleRate >= 1, 'getSampleRate should still be queried on the bridge path');
    assert.equal(calls.onInputFrame, 0, 'onInputFrame must not be invoked on the scoreChord path');
    assert.ok(intervalCallbacks.length >= 1, 'startAudio should register at least one interval');

    // Pick the detect tick by behaviour: invoke each captured
    // callback until one increments getPitchDetection. Robust to
    // refactors that reorder intervals or add new ones. The probe
    // itself drives one detect cycle, which is what the assertions
    // below need anyway.
    let detectTick = null;
    for (const cb of intervalCallbacks) {
        const before = calls.getPitchDetection;
        await cb();
        await flushPendingAsync();
        if (calls.getPitchDetection > before) {
            detectTick = cb;
            break;
        }
    }
    assert.equal(typeof detectTick, 'function',
        'one of the registered intervals should drive getPitchDetection (the detect tick)');

    assert.equal(calls.scoreChord, 1, 'scoreChord should be invoked exactly once for the single chord tick');
    assert.equal(calls.onInputFrame, 0, 'onInputFrame still not called after a chord tick');
    const req = scoreChordRequests[0];
    assert.ok(req && Array.isArray(req.notes), 'scoreChord request should carry a notes array');
    assert.equal(req.notes.length, 3, 'request should mirror the 3-note chord');
    // JSON round-trip neutralises the sandbox/test realm split that
    // makes structural deepEqual flaky on objects constructed inside
    // the vm context (different Object.prototype). The shape and
    // values are what matter.
    assert.equal(
        JSON.stringify(req.notes.map(n => ({ s: n.s, f: n.f }))),
        JSON.stringify([{ s: 0, f: 0 }, { s: 1, f: 0 }, { s: 2, f: 0 }]),
        'request notes should preserve chord shape',
    );
    assert.ok(Array.isArray(req.offsets), 'request should include tuning offsets');

    det.destroy();
    await flushPendingAsync();
});

test('bridge path: dedup guard — chord already recorded skips scoreChord on subsequent ticks', async () => {
    // The matchNotes() chord branch checks `noteResults.has(chordKey)`
    // BEFORE issuing the scoreChord IPC. This test covers exactly
    // that pre-await dedup: drive two ticks with the same chord still
    // in the timing window — the first records a hit, the second
    // must short-circuit before issuing a second scoreChord IPC.
    //
    // The post-await chord-key re-check uses the same predicate
    // (`noteResults.has(chordKey)`) immediately after the awaited
    // scoreChord returns, so it's structurally identical to the
    // pre-await branch covered here. The other post-await branch —
    // `!enabled || gen !== sessionGen` — is exercised by the
    // separate destroy-mid-scoreChord test below.
    const calls = { scoreChord: 0, getPitchDetection: 0 };
    const intervalCallbacks = [];
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.navigator.mediaDevices.getUserMedia = () =>
                Promise.reject(new Error('bridge should win'));
            sandbox.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            sandbox.highway.getChords = () => ([
                { t: 0, notes: [
                    { s: 0, f: 0 },
                    { s: 1, f: 0 },
                    { s: 2, f: 0 },
                ]},
            ]);
            sandbox.window.slopsmithDesktop = {
                isDesktop: true,
                platform: 'linux',
                audio: {
                    isAvailable: async () => true,
                    isAudioRunning: async () => true,
                    startAudio: async () => {},
                    getPitchDetection: async () => {
                        calls.getPitchDetection++;
                        return { midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' };
                    },
                    getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
                    getSampleRate: async () => 48000,
                    // Score as a clean hit so the first tick records
                    // the chord-level key and the second tick's
                    // pre-await dedup check trips.
                    scoreChord: async (ctx) => {
                        calls.scoreChord++;
                        return {
                            score: 1,
                            hitStrings: ctx.notes.length,
                            totalStrings: ctx.notes.length,
                            isHit: true,
                            results: ctx.notes.map(n => ({
                                s: n.s, f: n.f, hit: true,
                                bandEnergy: 1, centsDiff: 0, centsError: 0,
                            })),
                        };
                    },
                },
            };
        },
    });

    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    let detectTick = null;
    for (const cb of intervalCallbacks) {
        const before = calls.getPitchDetection;
        await cb();
        await flushPendingAsync();
        if (calls.getPitchDetection > before) {
            detectTick = cb;
            break;
        }
    }
    assert.equal(typeof detectTick, 'function');
    assert.equal(calls.scoreChord, 1, 'first tick should score the chord exactly once');

    // Second tick against the same chord (still inside the default
    // timing-tolerance window at t=0). The chord-key dedup check
    // must short-circuit before issuing a second scoreChord IPC.
    await detectTick();
    await flushPendingAsync();
    assert.equal(calls.scoreChord, 1,
        'second tick must not re-score a chord that has already been recorded');

    det.destroy();
    await flushPendingAsync();
});

test('bridge path: destroy mid-scoreChord does not throw and does not record a late judgment', async () => {
    // Race guard: scoreChord is async, so checkMisses() / destroy()
    // can fire while the await is pending. The post-await guard
    // (`if (!enabled || gen !== sessionGen) return;`) must bail out
    // cleanly when the instance was torn down mid-await. This test
    // pins that behaviour by holding scoreChord open with a deferred
    // promise, destroying the detector, then resolving — and
    // asserting nothing throws on the now-stale resolution.
    const calls = { scoreChord: 0, getPitchDetection: 0 };
    const intervalCallbacks = [];
    let resolveScoreChord = null;
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.navigator.mediaDevices.getUserMedia = () =>
                Promise.reject(new Error('bridge should win'));
            sandbox.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            sandbox.highway.getChords = () => ([
                { t: 0, notes: [{ s: 0, f: 0 }, { s: 1, f: 0 }] },
            ]);
            sandbox.window.slopsmithDesktop = {
                isDesktop: true,
                platform: 'linux',
                audio: {
                    isAvailable: async () => true,
                    isAudioRunning: async () => true,
                    startAudio: async () => {},
                    getPitchDetection: async () => {
                        calls.getPitchDetection++;
                        return { midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' };
                    },
                    getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
                    getSampleRate: async () => 48000,
                    scoreChord: (ctx) => {
                        calls.scoreChord++;
                        return new Promise((resolve) => {
                            resolveScoreChord = () => resolve({
                                score: 1,
                                hitStrings: ctx.notes.length,
                                totalStrings: ctx.notes.length,
                                isHit: true,
                                results: ctx.notes.map(n => ({
                                    s: n.s, f: n.f, hit: true,
                                    bandEnergy: 1, centsDiff: 0, centsError: 0,
                                })),
                            });
                        });
                    },
                },
            };
        },
    });

    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    let detectTick = null;
    let inFlightTickPromise = null;
    for (const cb of intervalCallbacks) {
        const before = calls.getPitchDetection;
        // Don't await yet — the detect callback's chord branch will
        // hang on the deferred scoreChord promise. Capture the
        // returned promise so any errors thrown from the in-flight
        // tick (after scoreChord resolves) propagate to the test
        // instead of becoming an unhandled rejection that node:test
        // silently absorbs.
        const p = cb();
        await flushPendingAsync();
        if (calls.getPitchDetection > before) {
            detectTick = cb;
            inFlightTickPromise = p;
            break;
        }
        // Non-detect interval (e.g. level meter) — drain its promise
        // so we don't leak unhandled rejections from probe steps.
        await p;
    }
    assert.equal(typeof detectTick, 'function');
    assert.ok(inFlightTickPromise && typeof inFlightTickPromise.then === 'function',
        'detect tick should return a promise we can observe');
    assert.equal(calls.scoreChord, 1, 'scoreChord should have been invoked once');
    assert.equal(typeof resolveScoreChord, 'function',
        'scoreChord should have created a deferred we can resolve');

    // Destroy mid-await. enabled flips to false and sessionGen bumps.
    det.destroy();
    await flushPendingAsync();

    // Resolve the in-flight scoreChord. The post-await guard
    // (!enabled || gen !== sessionGen) should bail out cleanly
    // — the awaited tick promise must resolve without throwing,
    // and the destroyed instance must not record a late judgment.
    resolveScoreChord();
    await assert.doesNotReject(inFlightTickPromise,
        'late scoreChord resolution must not throw after destroy');
    await flushPendingAsync();
});

// ── Phase 2: raw polyphonic transcription via audio.detectNotes ──────────────

// Build a bridge sandbox whose audio mock exposes detectNotes (the ML
// transcription API). `detectNotesImpl` controls what detectNotes resolves.
function bridgeWithDetectNotes(detectNotesImpl) {
    const calls = {
        detectNotes: 0, getPitchDetection: 0, scoreChord: 0, getUserMedia: 0,
    };
    const intervalCallbacks = [];
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.navigator.mediaDevices.getUserMedia = () => {
                calls.getUserMedia++;
                return Promise.reject(new Error('getUserMedia should not be called on the bridge path'));
            };
            sandbox.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            // Standard-tuning guitar: string 0/1/2 open = E2(40) A2(45) D3(50).
            sandbox.highway.getChords = () => ([
                { t: 0, notes: [{ s: 0, f: 0 }, { s: 1, f: 0 }, { s: 2, f: 0 }] },
            ]);
            sandbox.window.slopsmithDesktop = {
                isDesktop: true,
                platform: 'linux',
                audio: {
                    isAvailable: async () => true,
                    isAudioRunning: async () => true,
                    startAudio: async () => {},
                    getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
                    getSampleRate: async () => 48000,
                    getPitchDetection: async () => {
                        calls.getPitchDetection++;
                        return { midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' };
                    },
                    scoreChord: async (ctx) => {
                        calls.scoreChord++;
                        return {
                            score: 0, hitStrings: 0, totalStrings: ctx.notes.length,
                            isHit: false,
                            results: ctx.notes.map(n => ({
                                s: n.s, f: n.f, hit: false,
                                bandEnergy: 0, centsDiff: null, centsError: null,
                            })),
                        };
                    },
                    detectNotes: async () => {
                        calls.detectNotes++;
                        return detectNotesImpl();
                    },
                },
            };
        },
    });
    return { createNoteDetector, calls, intervalCallbacks };
}

async function driveDetectTick(intervalCallbacks, calls) {
    // The detect tick is the interval that calls detectNotes (the ML path)
    // or getPitchDetection (the fallback). Pick it by behaviour.
    for (const cb of intervalCallbacks) {
        const before = calls.detectNotes + calls.getPitchDetection;
        // eslint-disable-next-line no-await-in-loop
        await cb();
        // eslint-disable-next-line no-await-in-loop
        await flushPendingAsync();
        if (calls.detectNotes + calls.getPitchDetection > before) return cb;
    }
    return null;
}

test('detectNotes path: detectNotes drives single-note detection, chords via scoreChord IPC', async () => {
    // When the desktop exposes audio.detectNotes, the bridge poll uses it for
    // single-note detection (replacing getPitchDetection); chords are still
    // scored by the native scoreChord IPC, which times them correctly.
    let seq = 10;
    const { createNoteDetector, calls, intervalCallbacks } = bridgeWithDetectNotes(
        () => {
            // Each poll reports a fresh onset (rising onsetSeq) so the chord's
            // onset gate is satisfied and scoreChord runs.
            seq += 1;
            return {
                notes: [
                    { midi: 40, confidence: 0.82, onsetMs: 60, onsetSeq: seq },
                    { midi: 45, confidence: 0.78, onsetMs: 55, onsetSeq: seq },
                    { midi: 50, confidence: 0.71, onsetMs: 50, onsetSeq: seq },
                ],
                sampleRate: 48000,
            };
        },
    );
    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const detectTick = await driveDetectTick(intervalCallbacks, calls);
    assert.equal(typeof detectTick, 'function', 'a detect tick should be registered');
    assert.ok(calls.detectNotes >= 1, 'detectNotes should be polled for single-note detection');
    assert.equal(calls.getPitchDetection, 0, 'getPitchDetection is replaced by detectNotes on the ML path');
    assert.ok(calls.scoreChord >= 1, 'the chord is scored via the scoreChord IPC');
    assert.equal(calls.getUserMedia, 0, 'getUserMedia must not be called on the bridge path');

    det.destroy();
    await flushPendingAsync();
});

test('detectNotes path: onset-event consumption — a static onsetSeq is not re-fired', async () => {
    // A note whose onsetSeq never changes is one sustained note, not a stream
    // of new notes. After the first (priming) poll it must not keep producing
    // fresh single-note detections — the onset is consumed once. Driving many
    // ticks against a fixed onsetSeq must stay stable and never throw.
    const { createNoteDetector, calls, intervalCallbacks } = bridgeWithDetectNotes(
        () => ({
            notes: [{ midi: 43, confidence: 0.9, onsetMs: 70, onsetSeq: 7 }],
            sampleRate: 48000,
        }),
    );
    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const detectTick = await driveDetectTick(intervalCallbacks, calls);
    assert.equal(typeof detectTick, 'function');
    await assert.doesNotReject(async () => {
        for (let i = 0; i < 6; i++) { await detectTick(); await flushPendingAsync(); }
    }, 'repeated ticks against a static onsetSeq must not throw');
    assert.equal(calls.getUserMedia, 0, 'no getUserMedia on the bridge path');

    det.destroy();
    await flushPendingAsync();
});

test('detectNotes path: null result falls back to the scoreChord IPC', async () => {
    // detectNotes resolves null when the desktop ML detector is inactive
    // (no model / ONNX support absent). The chord branch must then fall
    // back to the scoreChord IPC, and the monophonic path to
    // getPitchDetection — exactly the Phase 1 behaviour.
    const { createNoteDetector, calls, intervalCallbacks } = bridgeWithDetectNotes(
        () => null,
    );
    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const detectTick = await driveDetectTick(intervalCallbacks, calls);
    assert.equal(typeof detectTick, 'function');
    assert.ok(calls.detectNotes >= 1, 'detectNotes is still probed');
    assert.ok(calls.getPitchDetection >= 1,
        'null detectNotes falls back to getPitchDetection for the monophonic path');
    assert.ok(calls.scoreChord >= 1,
        'null detectNotes falls back to the scoreChord IPC for the chord');
    assert.equal(calls.getUserMedia, 0, 'still no getUserMedia');

    det.destroy();
    await flushPendingAsync();
});

test('bridge path: downlevel desktop without scoreChord — chord branch silently skips, monophonic still works', async () => {
    // Compatibility guard: an older slopsmith-desktop build can
    // expose getPitchDetection (monophonic path) without yet shipping
    // audio.scoreChord. The plugin should still take the bridge path
    // for monophonic detection (no getUserMedia fallback) and just
    // skip the chord branch silently — no throws, no crashes,
    // chord-group ticks return without recording judgments.
    const calls = {
        isAvailable: 0,
        getPitchDetection: 0,
        getSampleRate: 0,
        getUserMedia: 0,
    };
    const intervalCallbacks = [];
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.navigator.mediaDevices.getUserMedia = () => {
                calls.getUserMedia++;
                return Promise.reject(new Error('getUserMedia should not be called on the downlevel bridge path'));
            };
            sandbox.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            // Same 3-note chord at t=0 as the happy-path test.
            sandbox.highway.getChords = () => ([
                { t: 0, notes: [
                    { s: 0, f: 0 },
                    { s: 1, f: 0 },
                    { s: 2, f: 0 },
                ]},
            ]);
            sandbox.window.slopsmithDesktop = {
                isDesktop: true,
                platform: 'linux',
                audio: {
                    // Deliberately omit scoreChord (and onInputFrame —
                    // any older build that lacked scoreChord would
                    // also lack the streaming surface in this
                    // configuration).
                    isAvailable: async () => { calls.isAvailable++; return true; },
                    isAudioRunning: async () => true,
                    startAudio: async () => {},
                    getPitchDetection: async () => {
                        calls.getPitchDetection++;
                        return { midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' };
                    },
                    getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
                    getSampleRate: async () => { calls.getSampleRate++; return 48000; },
                },
            };
        },
    });

    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    assert.equal(calls.getUserMedia, 0, 'downlevel bridge should still take the bridge path, not fall back to getUserMedia');
    assert.ok(intervalCallbacks.length >= 1, 'startAudio should register at least one interval');

    // Pick the detect tick by behaviour and drive it. The chord
    // branch must short-circuit (no scoreChord function to call)
    // without throwing. Test asserts no exception propagated out of
    // the async call chain.
    await assert.doesNotReject(async () => {
        for (const cb of intervalCallbacks) {
            const before = calls.getPitchDetection;
            await cb();
            await flushPendingAsync();
            if (calls.getPitchDetection > before) break;
        }
    }, 'downlevel chord tick must not throw');

    det.destroy();
    await flushPendingAsync();
});
