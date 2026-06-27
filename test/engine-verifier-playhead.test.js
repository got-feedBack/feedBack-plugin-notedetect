// Verifies the desktop engine-verifier path pushes the renderer's playhead.
//
// On slopsmith-desktop the note_detect plugin offloads chart scoring to the
// engine's background NoteVerifier thread: it pushes the chart via
// audio.setChart() and drains finalized verdicts via audio.getNoteVerdicts().
// The engine's own backing-transport clock is frozen for HTML5-routed
// (sloppak) songs, so the renderer MUST push its unified, already-corrected
// playhead — hw.getTime() + avOffset - latencyOffset — into getNoteVerdicts
// every detect tick. These tests pin:
//   1. getNoteVerdicts is called with (number songTime, boolean playing).
//   2. A detected verdict is judged at detectedSongTime directly — the
//      avOffset/latency correction is NOT re-applied (it already is, engine
//      side), so a verdict whose detectedSongTime equals the note time scores
//      a clean, on-time hit even with a large avOffset configured.
//   3. A downlevel addon without setChart/getNoteVerdicts stays on the legacy
//      renderer matchNotes path.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

async function flushPendingAsync(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

// A single guitar chart note: high-E string (s=0), fret 3, onset at t=5.000s.
const CHART_NOTE = { s: 0, f: 3, t: 5.0, sus: 0 };
// Non-zero so a double-applied correction would be plainly visible in the
// resulting judgment's timing error.
const AV_OFFSET_MS = 240;

// Build an engine-verifier sandbox. `verdictQueue` is drained one entry per
// getNoteVerdicts call; each entry is the array that call resolves to.
function engineVerifierSandbox({ withVerifierApi = true, withRawPitch = false } = {}) {
    const calls = {
        setChart: 0,
        getNoteVerdicts: 0,
        getPitchDetection: 0,
        getRawPitch: 0,
        getUserMedia: 0,
    };
    const getVerdictsArgs = [];   // [songTime, playing] per call
    let pushedChart = null;       // last chart handed to setChart
    const verdictQueue = [];      // FIFO of verdict arrays
    const intervalCallbacks = [];

    const audio = {
        isAvailable: async () => true,
        isAudioRunning: async () => true,
        startAudio: async () => {},
        getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
        getSampleRate: async () => 48000,
        getPitchDetection: async () => {
            calls.getPitchDetection++;
            return { midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' };
        },
    };
    if (withRawPitch) {
        // Post-noise-gate live pitch. The engine-verifier detect tick should
        // prefer this over getPitchDetection for the provisional on-strike glow.
        audio.getRawPitch = async () => {
            calls.getRawPitch++;
            return { midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' };
        };
    }
    if (withVerifierApi) {
        audio.setChart = async (chart) => {
            calls.setChart++;
            pushedChart = chart;
            return true;
        };
        audio.getNoteVerdicts = async (songTime, playing) => {
            calls.getNoteVerdicts++;
            getVerdictsArgs.push([songTime, playing]);
            return verdictQueue.length ? verdictQueue.shift() : [];
        };
    }

    const hitEvents = [];
    const missEvents = [];
    let hwTime = CHART_NOTE.t;   // mutable playhead — tests drive seeks/loops
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.navigator.mediaDevices.getUserMedia = () => {
                calls.getUserMedia++;
                return Promise.reject(new Error('getUserMedia must not run on the engine-verifier path'));
            };
            sandbox.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            // Capture judgments — dispatchInstanceEvent calls window.dispatchEvent.
            sandbox.dispatchEvent = (ev) => {
                if (ev && ev.type === 'notedetect:hit') hitEvents.push(ev.detail);
                if (ev && ev.type === 'notedetect:miss') missEvents.push(ev.detail);
                return true;
            };
            sandbox.highway.getNotes = () => ([{ ...CHART_NOTE }]);
            sandbox.highway.getChords = () => ([]);
            sandbox.highway.getTime = () => hwTime;             // mutable playhead
            sandbox.highway.getAvOffset = () => AV_OFFSET_MS;
            sandbox.window.feedBackDesktop = { isDesktop: true, platform: 'linux', audio };
        },
    });

    return {
        createNoteDetector, calls, getVerdictsArgs, intervalCallbacks,
        hitEvents, missEvents, verdictQueue,
        setHwTime: (t) => { hwTime = t; },
        chartNoteId: () => (pushedChart && pushedChart.notes && pushedChart.notes[0]
            ? pushedChart.notes[0].id : null),
    };
}

// Drive each registered interval until one exercises the detect tick — the
// callback that calls getNoteVerdicts (engine path) or getPitchDetection
// (legacy fallback). Returns that callback.
async function driveDetectTick(intervalCallbacks, calls) {
    for (const cb of intervalCallbacks) {
        const before = calls.getNoteVerdicts + calls.getPitchDetection;
        // eslint-disable-next-line no-await-in-loop
        await cb();
        // eslint-disable-next-line no-await-in-loop
        await flushPendingAsync();
        if (calls.getNoteVerdicts + calls.getPitchDetection > before) return cb;
    }
    return null;
}

test('engine-verifier path: getNoteVerdicts is called with (songTime, playing)', async () => {
    const env = engineVerifierSandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function', 'a detect tick should be registered');
    assert.ok(env.calls.setChart >= 1, 'the chart should be pushed to the engine via setChart');
    assert.ok(env.calls.getNoteVerdicts >= 1, 'verdicts should be drained via getNoteVerdicts');
    assert.equal(env.calls.getUserMedia, 0, 'getUserMedia must not run on the engine-verifier path');

    const lastArgs = env.getVerdictsArgs[env.getVerdictsArgs.length - 1];
    assert.equal(typeof lastArgs[0], 'number', 'getNoteVerdicts arg 0 (songTime) must be a number');
    assert.equal(typeof lastArgs[1], 'boolean', 'getNoteVerdicts arg 1 (playing) must be a boolean');
    // hw.getTime()=5.0 + avOffset 0.24 - latencyOffset(default 0.08) = 5.16.
    assert.ok(Math.abs(lastArgs[0] - 5.16) < 1e-6,
        'pushed playhead should be hw.getTime() + avOffset - latencyOffset');

    det.destroy();
    await flushPendingAsync();
});

test('engine-verifier path: a detected verdict is judged at detectedSongTime, not re-corrected', async () => {
    const env = engineVerifierSandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    // First detect tick: signature matches the enable()-time push, so this
    // just drains — and the chart id is now known. Queue a detected verdict
    // whose detectedSongTime is exactly the note's chart time.
    const id = env.chartNoteId();
    assert.equal(typeof id, 'string', 'setChart should have received a note with a string id');
    env.verdictQueue.push([
        { id, detected: true, detectedSongTime: CHART_NOTE.t, centsError: 0, snr: 6 },
    ]);

    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function');
    // Drain again so the queued verdict is delivered and judged.
    await detectTick();
    await flushPendingAsync();

    const stats = det.getStats();
    assert.equal(stats.hits, 1, 'the detected verdict should record exactly one hit');
    assert.equal(stats.misses, 0, 'no miss should be recorded');
    assert.equal(env.hitEvents.length, 1, 'one notedetect:hit judgment should be dispatched');

    const j = env.hitEvents[0];
    // detectedSongTime is already avOffset/latency-corrected engine-side. The
    // judgment time must equal it verbatim. If the plugin re-applied
    // avOffset (240ms) the note would be judged 240ms late — a non-OK timing
    // state — and would not be a hit at all.
    assert.equal(j.detectedAt, CHART_NOTE.t,
        'judgment time must equal detectedSongTime (no double avOffset correction)');
    assert.equal(j.timingError, 0,
        'a verdict at the note time must score 0ms timing error, not avOffset ms');
    assert.equal(j.timingState, 'OK', 'on-time verdict should classify as OK timing');

    det.destroy();
    await flushPendingAsync();
});

test('engine-verifier path: a backward playhead jump clears dedup so a drilled note re-scores', async () => {
    // A drill A-B loop wrap (or manual seek-back) jumps the playhead
    // backward. The engine re-opens notes at/after the new position; the
    // plugin must drop its matching noteResults dedup entries so the
    // re-scored verdict is not skipped by the `noteResults.has(key)` guard.
    const env = engineVerifierSandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const id = env.chartNoteId();
    assert.equal(typeof id, 'string');

    // First iteration: detect the note.
    env.verdictQueue.push([{ id, detected: true, detectedSongTime: CHART_NOTE.t, centsError: 0, snr: 6 }]);
    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function');
    await detectTick();
    await flushPendingAsync();
    assert.equal(det.getStats().hits, 1, 'first iteration should record one hit');

    // Drill loop wraps back to the top of the section — playhead jumps
    // backward well past the 0.25s threshold. The engine re-emits a verdict
    // for the same note on the next iteration.
    env.setHwTime(2.0);
    env.verdictQueue.push([{ id, detected: true, detectedSongTime: CHART_NOTE.t, centsError: 0, snr: 6 }]);
    await detectTick();
    await flushPendingAsync();

    assert.equal(det.getStats().hits, 2,
        'the re-scored verdict should record a second hit after the backward jump');

    det.destroy();
    await flushPendingAsync();
});

test('engine-verifier path: silence gate forces miss when input level is sub-threshold around chart time', async () => {
    // Regression guard for the CREPE-on-silence false-positive: the engine
    // can return `detected: true` on silence (CREPE emits a high-confidence
    // stuck-pitch from induced signal even with the guitar muted), and the
    // bent-note 600¢ pitch leniency widens the window enough that those
    // phantoms pass as hits. The plugin's silence gate (an _ndLevelSamples
    // ring populated from the bridge's getLevels poll) must override
    // `v.detected = true` to false when no real signal was present in the
    // ±_ND_LEVEL_WIN_HALF window around the note's chart time. Without it
    // a muted-guitar playthrough scored ~57% hits instead of ~0%.
    const env = engineVerifierSandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    // Drive every registered interval at least once so the bridge level
    // meter records at least one (songT, level) sample with the silent
    // getLevels stub (inputLevel: 0). Without this the gate's "no
    // telemetry → skip" branch would let the engine's optimistic verdict
    // through, defeating the test.
    for (const cb of env.intervalCallbacks) {
        // eslint-disable-next-line no-await-in-loop
        await cb();
        // eslint-disable-next-line no-await-in-loop
        await flushPendingAsync();
    }

    // Queue an engine verdict saying the note WAS detected. Without the
    // silence gate this would record a hit; with the gate it should be
    // overridden to a miss because the only recorded level samples are
    // sub-threshold around cn.t + latencyOffset.
    const id = env.chartNoteId();
    assert.equal(typeof id, 'string', 'setChart should have received a note with a string id');
    env.verdictQueue.push([
        { id, detected: true, detectedSongTime: CHART_NOTE.t, centsError: 0, snr: 6 },
    ]);

    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function');
    // Drain again so the queued verdict is delivered + gated.
    await detectTick();
    await flushPendingAsync();

    const stats = det.getStats();
    assert.equal(stats.hits, 0,
        'silence-gate must override the engine\'s detected:true → no hit on a silent input');
    assert.equal(stats.misses, 1, 'the gated verdict should be recorded as a miss instead');
    assert.equal(env.hitEvents.length, 0,
        'no notedetect:hit event should be dispatched when the gate fires');
    assert.equal(env.missEvents.length, 1, 'one notedetect:miss event should be dispatched');

    det.destroy();
    await flushPendingAsync();
});

test('engine-verifier path: live-pitch poll prefers getRawPitch when the addon exposes it', async () => {
    // The provisional on-strike sustain glow reads detectedMidi from a live
    // monophonic poll. It must prefer getRawPitch (post-noise-gate → -1 the
    // instant the string is muted) over getPitchDetection (holds the note
    // through its decay, keeping muted sustains lit). When getRawPitch exists,
    // getPitchDetection must NOT be used for this poll.
    const env = engineVerifierSandbox({ withRawPitch: true });
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function', 'a detect tick should be registered');
    assert.ok(env.calls.getNoteVerdicts >= 1, 'still the engine-verifier path');
    assert.ok(env.calls.getRawPitch >= 1,
        'getRawPitch should drive the live-pitch poll when available');
    assert.equal(env.calls.getPitchDetection, 0,
        'getPitchDetection must not be polled when getRawPitch is present');

    det.destroy();
    await flushPendingAsync();
});

test('engine-verifier path: live-pitch poll falls back to getPitchDetection without getRawPitch', async () => {
    // An addon that predates getRawPitch still gets a live-pitch poll, via the
    // getPitchDetection fallback (its decay-hold is a known downlevel tradeoff).
    const env = engineVerifierSandbox({ withRawPitch: false });
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function', 'a detect tick should be registered');
    assert.ok(env.calls.getNoteVerdicts >= 1, 'still the engine-verifier path');
    assert.equal(env.calls.getRawPitch, 0, 'no getRawPitch on a downlevel addon');
    assert.ok(env.calls.getPitchDetection >= 1,
        'getPitchDetection should be the fallback live-pitch poll');

    det.destroy();
    await flushPendingAsync();
});

test('engine-verifier path: downlevel addon without the verifier API stays on the legacy path', async () => {
    const env = engineVerifierSandbox({ withVerifierApi: false });
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function', 'a detect tick should still run');
    assert.equal(env.calls.setChart, 0, 'no setChart on an addon that lacks the verifier API');
    assert.equal(env.calls.getNoteVerdicts, 0, 'no getNoteVerdicts on a downlevel addon');
    assert.ok(env.calls.getPitchDetection >= 1,
        'the legacy renderer detect path (getPitchDetection) should run instead');
    assert.equal(env.calls.getUserMedia, 0, 'still the desktop bridge — no getUserMedia fallback');

    det.destroy();
    await flushPendingAsync();
});
