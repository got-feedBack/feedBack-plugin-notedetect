// Verdicts the engine re-delivers must not be counted a second time.
//
// The engine re-delivers routinely. Any setChart un-finalizes the ENTIRE chart
// (NoteVerifier::setChart does state.assign(...)), so every note behind the
// playhead re-finalizes on the next worker pass and comes back through
// drainVerdicts() — which is an uncapped swap, so it arrives as one big batch.
// And a mid-song setChart is not exotic: the detect loop re-pushes whenever
// _ndChartSignature() changes, and that signature includes the timing/pitch
// tolerance sliders.
//
// The drain's double-count guard used to be `noteResults.has(key)`. But
// noteResults is pruned for memory by the gc interval — entries more than 5 s
// behind the playhead, once the map passes 500. So on any song long enough to
// trip the GC, a re-delivered note whose entry had been pruned counted AGAIN,
// and the HUD's `hits / total` leapt by however much the engine handed back.
//
// The guard now also consults _scoreLedger, which holds one entry per counted
// judgment under the same key and is never GC'd. This test pins that: it runs
// the REAL gc interval (hence the 600-note chart — the GC no-ops below 500
// entries) and then replays the same verdicts the engine already delivered.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

async function flushPendingAsync(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

// 600 single notes, 100 ms apart (0.0 s → 59.9 s). Over the GC's 500-entry
// floor once enough of them are judged, which is the whole point.
const NOTE_COUNT = 600;
const JUDGED = 550;
const CHART = Array.from({ length: NOTE_COUNT }, (_, i) => ({
    s: 0, f: 3, t: Number((i * 0.1).toFixed(3)), sus: 0,
}));

function sandbox() {
    const calls = { getNoteVerdicts: 0, getPitchDetection: 0 };
    let pushedChart = null;
    const verdictQueue = [];
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
        setChart: async (chart) => { pushedChart = chart; return true; },
        getNoteVerdicts: async () => {
            calls.getNoteVerdicts++;
            return verdictQueue.length ? verdictQueue.shift() : [];
        },
    };

    let hwTime = 0;
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            sb.highway.getNotes = () => CHART.map((n) => ({ ...n }));
            sb.highway.getChords = () => ([]);
            sb.highway.getTime = () => hwTime;
            sb.highway.getAvOffset = () => 0;
            sb.window.feedBackDesktop = { isDesktop: true, platform: 'linux', audio };
        },
    });

    return {
        createNoteDetector, calls, intervalCallbacks, verdictQueue,
        setHwTime: (t) => { hwTime = t; },
        // Every id the engine was told about, in chart order.
        chartIds: () => (pushedChart && pushedChart.notes
            ? pushedChart.notes.map((n) => n.id) : []),
    };
}

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

test('engine-verifier: re-delivered verdicts do not double-count after the noteResults GC', async () => {
    const env = sandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function', 'a detect tick should be registered');

    const ids = env.chartIds();
    assert.equal(ids.length, NOTE_COUNT, 'the whole chart should have been pushed to the engine');

    // The engine finalizes the first JUDGED notes as clean hits, on time.
    const verdicts = ids.slice(0, JUDGED).map((id, i) => ({
        id, detected: true, detectedSongTime: CHART[i].t, centsError: 0, snr: 6,
    }));

    env.verdictQueue.push(verdicts);
    await detectTick();
    await flushPendingAsync();

    const before = det.getStats();
    assert.equal(before.hits, JUDGED, 'every detected verdict should record exactly one hit');
    assert.equal(before.misses, 0, 'no miss should be recorded');

    // Move the playhead well past those notes, then run the real gc interval.
    // It prunes every noteResults entry more than 5 s behind — i.e. nearly all
    // of them — which is exactly what used to disarm the drain's dedup guard.
    // The detect tick is skipped; every other interval (gc, level meter,
    // checkMisses) is fair game and must not disturb the tally on its own.
    env.setHwTime(120);
    for (const cb of env.intervalCallbacks) {
        if (cb === detectTick) continue;
        try {
            // eslint-disable-next-line no-await-in-loop
            await cb();
        } catch (_) { /* unrelated interval; not under test */ }
        // eslint-disable-next-line no-await-in-loop
        await flushPendingAsync();
    }

    const afterGc = det.getStats();
    assert.equal(afterGc.hits, JUDGED, 'the gc must not change the score by itself');
    assert.equal(afterGc.misses, 0, 'the gc must not manufacture misses');

    // Now the engine hands back the very same verdicts — what it does after any
    // mid-song setChart. Every one of these notes is already counted.
    env.verdictQueue.push(verdicts.map((v) => ({ ...v })));
    await detectTick();
    await flushPendingAsync();

    const after = det.getStats();
    assert.equal(after.hits, JUDGED,
        're-delivered verdicts must be suppressed, not counted a second time');
    assert.equal(after.misses, 0, 're-delivery must not manufacture misses either');

    det.destroy();
    await flushPendingAsync();
});
