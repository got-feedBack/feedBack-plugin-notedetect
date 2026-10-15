// Per-section stats on the desktop engine-verifier path.
//
// Section tracking (`currentSection`) used to be advanced only at the tail of
// checkMisses(), which returns early when the engine verifier is in use — the
// engine finalizes misses itself. So on desktop every judgment hit
// updateSectionStat() with currentSection still null: getStats().sectionStats
// stayed empty and notedetect:session.sections shipped as [] for the practice
// journal and the results card. Engine verdicts also land late (a note's
// verdict arrives after its sustain window closes, often after the playhead has
// crossed into the next section), so a judgment is now binned by the section
// its NOTE sits in, not by where the playhead happens to be.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

async function flushPendingAsync(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

// Four notes: two in "Intro" (0–2 s), two in "Verse" (2 s →).
const CHART = [
    { s: 0, f: 3, t: 0.5, sus: 0 },
    { s: 0, f: 3, t: 1.5, sus: 0 },
    { s: 0, f: 5, t: 2.5, sus: 0 },
    { s: 0, f: 5, t: 3.5, sus: 0 },
];
const SECTIONS = [
    { name: 'Intro', time: 0 },
    { name: 'Verse', time: 2.0 },
];

function sandbox() {
    const calls = { getNoteVerdicts: 0, getPitchDetection: 0 };
    let pushedChart = null;
    const verdictQueue = [];
    const intervalCallbacks = [];
    let hwTime = 0;

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

    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            sb.highway.getNotes = () => CHART.map((n) => ({ ...n }));
            sb.highway.getChords = () => ([]);
            sb.highway.getSections = () => SECTIONS.map((s) => ({ ...s }));
            sb.highway.getTime = () => hwTime;
            sb.highway.getAvOffset = () => 0;
            sb.window.feedBackDesktop = { isDesktop: true, platform: 'linux', audio };
        },
    });

    return {
        createNoteDetector, calls, intervalCallbacks, verdictQueue,
        setHwTime: (t) => { hwTime = t; },
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

// Plain-realm copy so deepStrictEqual doesn't trip on the vm's prototypes.
const plain = (rows) => Array.from(rows || [], (s) => ({ name: s.name, hits: s.hits, misses: s.misses }));

test('engine verifier: verdicts are binned into per-section stats', async () => {
    const env = sandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function', 'a detect tick should be registered');

    const ids = env.chartIds();
    assert.equal(ids.length, CHART.length);

    // Intro: hit + miss, both delivered while the playhead is still in the Intro.
    env.setHwTime(1.9);
    env.verdictQueue.push([
        { id: ids[0], detected: true, detectedSongTime: 0.5, centsError: 0, snr: 6 },
        { id: ids[1], detected: false },
    ]);
    await detectTick();
    await flushPendingAsync();

    // Verse: two hits, delivered after the song has run on past them.
    env.setHwTime(4.5);
    env.verdictQueue.push([
        { id: ids[2], detected: true, detectedSongTime: 2.5, centsError: 0, snr: 6 },
        { id: ids[3], detected: true, detectedSongTime: 3.5, centsError: 0, snr: 6 },
    ]);
    await detectTick();
    await flushPendingAsync();

    const stats = det.getStats();
    assert.equal(stats.hits, 3);
    assert.equal(stats.misses, 1);
    assert.deepEqual(plain(stats.sectionStats), [
        { name: 'Intro', hits: 1, misses: 1 },
        { name: 'Verse', hits: 2, misses: 0 },
    ]);

    det.destroy();
    await flushPendingAsync();
});

test('engine verifier: a late verdict is binned by its note, not the playhead', async () => {
    const env = sandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    const ids = env.chartIds();

    // The playhead is already in the Verse when the Intro's last note is
    // finalized — the engine only reports once the note's window has closed.
    env.setHwTime(2.3);
    // Let the other intervals (checkMisses' section tracker among them) see the
    // playhead first, so currentSection really is the Verse.
    for (const cb of env.intervalCallbacks) {
        if (cb === detectTick) continue;
        // eslint-disable-next-line no-await-in-loop
        await cb();
    }
    await flushPendingAsync();
    assert.ok(plain(det.getStats().sectionStats).some((s) => s.name === 'Verse'),
        'the section tracker should have opened the Verse on the engine path');
    env.verdictQueue.push([
        { id: ids[1], detected: true, detectedSongTime: 1.5, centsError: 0, snr: 6 },
    ]);
    await detectTick();
    await flushPendingAsync();

    const intro = plain(det.getStats().sectionStats).find((s) => s.name === 'Intro');
    assert.deepEqual(intro, { name: 'Intro', hits: 1, misses: 0 },
        'the Intro note must count toward the Intro, not the Verse the playhead is in');

    det.destroy();
    await flushPendingAsync();
});
