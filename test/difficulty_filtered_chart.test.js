// Scoring must follow the DISPLAYED difficulty, not the 100% chart (feedback#226).
//
// The highway filters the chart by the mastery slider, but getNotes()/getChords()
// still return every note in the full chart. Scoring the raw arrays retires notes
// that were never drawn as misses, so playing a lower difficulty perfectly still
// tanks the score. hw.getFilteredNotes()/getFilteredChords() are the "as drawn"
// view; every scoring path now reads the chart through _ndChartNotes/_ndChartChords,
// which prefer them and fall back to the raw arrays when they're absent (older core)
// or inactive (single-difficulty song, so the highway returns the raw arrays anyway).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadDetectionCore } = require('./_loader');

async function flushPendingAsync(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

// Four charted notes; the mastery slider only draws the two on t=1 and t=3.
const FULL = [
    { s: 0, f: 1, t: 1.0, sus: 0 },
    { s: 1, f: 2, t: 2.0, sus: 0 },
    { s: 2, f: 3, t: 3.0, sus: 0 },
    { s: 3, f: 4, t: 4.0, sus: 0 },
];
const DISPLAYED = [FULL[0], FULL[2]];

// `filtered: null` models a core with no getFilteredNotes at all (downlevel).
function engineSandbox({ filtered }) {
    const calls = { getNoteVerdicts: 0, getPitchDetection: 0 };
    const charts = [];              // every chart handed to setChart
    const intervalCallbacks = [];
    let live = filtered;            // mutable — tests move the slider mid-session
    let chordsFn = () => [];        // mutable — tests swap chord voicings mid-session

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
        setChart: async (chart) => { charts.push(chart); return true; },
        getNoteVerdicts: async () => { calls.getNoteVerdicts++; return []; },
    };

    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            sb.highway.getNotes = () => FULL.map((n) => ({ ...n }));
            sb.highway.getChords = () => chordsFn();
            if (live !== null) {
                sb.highway.getFilteredNotes = () => live.map((n) => ({ ...n }));
                sb.highway.getFilteredChords = () => chordsFn();
            }
            sb.highway.getTime = () => 0;
            sb.highway.getAvOffset = () => 0;
            sb.window.feedBackDesktop = { isDesktop: true, platform: 'linux', audio };
        },
    });

    return {
        createNoteDetector, calls, charts, intervalCallbacks,
        setDisplayed: (notes) => { live = notes; },
        setChords: (fn) => { chordsFn = fn; },
        lastChart: () => charts[charts.length - 1],
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

// Chart notes carry `t`; compare on that. Array.from (not .map) so the result is
// built in THIS realm — an array mapped from the vm's array carries the vm's
// Array.prototype, and deepStrictEqual compares prototypes.
const times = (chart) => Array.from(chart.notes || [], (n) => n.t).sort((a, b) => a - b);

test('engine verifier is given only the notes the highway actually draws', async () => {
    const env = engineSandbox({ filtered: DISPLAYED });
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const chart = env.lastChart();
    assert.ok(chart, 'a chart should have been pushed to the engine');
    assert.deepEqual(times(chart), [1.0, 3.0],
        'the engine must score the displayed notes only — not the notes the mastery '
        + 'slider filtered out (feedback#226)');

    det.destroy();
    await flushPendingAsync();
});

test('a single-difficulty song (no filtered getters) still scores the whole chart', async () => {
    const env = engineSandbox({ filtered: null });
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    assert.deepEqual(times(env.lastChart()), [1.0, 2.0, 3.0, 4.0],
        'with no difficulty filter available the full chart is the displayed chart');

    det.destroy();
    await flushPendingAsync();
});

test('moving the mastery slider mid-song re-pushes the reduced chart', async () => {
    const env = engineSandbox({ filtered: FULL });
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function');
    assert.deepEqual(times(env.lastChart()), [1.0, 2.0, 3.0, 4.0], 'starts at full difficulty');

    // Slider down: the highway now draws two notes. _ndChartSignature() is built
    // from the filtered chart, so it diverges and the detect loop re-pushes.
    env.setDisplayed(DISPLAYED);
    await detectTick();
    await flushPendingAsync();

    assert.deepEqual(times(env.lastChart()), [1.0, 3.0],
        'lowering the difficulty must re-push the reduced chart, or the engine keeps '
        + 'scoring notes that are no longer on screen');

    det.destroy();
    await flushPendingAsync();
});

test('a difficulty change that keeps the same note COUNT still re-pushes', async () => {
    // The trap: the signature used to be counts + first/last onset. Swap which
    // notes are displayed while holding the count (and the first/last onset)
    // fixed and the signature was identical — so the engine kept scoring notes
    // that were no longer on screen, which is the very bug this PR fixes.
    const before = [FULL[0], FULL[1], FULL[3]];   // t = 1, 2, 4
    const after = [FULL[0], FULL[2], FULL[3]];    // t = 1, 3, 4  — same count, same ends
    const env = engineSandbox({ filtered: before });
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function');
    assert.deepEqual(times(env.lastChart()), [1.0, 2.0, 4.0]);

    env.setDisplayed(after);
    await detectTick();
    await flushPendingAsync();

    assert.deepEqual(times(env.lastChart()), [1.0, 3.0, 4.0],
        'the chart signature must hash note identity, not just the note count — '
        + 'a same-count difficulty change still swaps which notes are on screen');

    det.destroy();
    await flushPendingAsync();
});

test('a chord VOICING swap at the same onset still re-pushes', async () => {
    // Same onset, same member count, different frets — the chord equivalent of
    // the same-count trap above. Hashing only (onset, memberCount) would miss it
    // and leave the engine verifying the old frets.
    const chordAt = (frets) => ({ t: 2.0, notes: frets.map((f, i) => ({ s: i, f, t: 2.0, sus: 0 })) });
    const env = engineSandbox({ filtered: [] });
    let voicing = chordAt([1, 1, 2]);
    env.setChords(() => [voicing]);

    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    const detectTick = await driveDetectTick(env.intervalCallbacks, env.calls);
    assert.equal(typeof detectTick, 'function');

    const frets = () => Array.from(env.lastChart().notes || [], (n) => n.f).sort((a, b) => a - b);
    assert.deepEqual(frets(), [1, 1, 2], 'starts on the first voicing');

    voicing = chordAt([3, 3, 5]);
    await detectTick();
    await flushPendingAsync();

    assert.deepEqual(frets(), [3, 3, 5],
        'the signature must hash each chord constituent\'s string/fret — a voicing '
        + 'swap at the same onset and member count must still re-push');

    det.destroy();
    await flushPendingAsync();
});

test('a chord-only difficulty falls back to chord constituents for A/V calibration', () => {
    // Filtering to chords-only used to leave the calibration sweep with an empty
    // note list, so _ndRunAutoCalibrate bailed with 'no notes' and never ran. It
    // must fall back to the chord constituents instead of skipping the take.
    const core = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.highway.getNotes = () => ([{ s: 0, f: 1, t: 1.0, sus: 0 }]);
            sb.highway.getChords = () => ([]);
            sb.highway.getFilteredNotes = () => ([]);          // difficulty hides every single
            sb.highway.getFilteredChords = () => ([
                { t: 2.0, notes: [{ s: 0, f: 3 }, { s: 1, f: 3 }, { s: 2, f: 5 }] },
            ]);
        },
    });
    const anchors = core.createNoteDetector()._calibrationNotes();
    assert.equal(anchors.length, 3,
        'the three chord constituents are the only anchors on screen — calibration '
        + 'must use them rather than report an empty chart and skip');
    assert.deepEqual(Array.from(anchors, (n) => n.t), [2.0, 2.0, 2.0],
        'constituents are flattened onto the chord onset');
});

test('calibration still uses singles alone when the chart has them', () => {
    // The fallback must not widen the anchor set on a normal chart: the sweep was
    // tuned on monophonic onsets, and chord constituents are a last resort.
    const core = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.highway.getNotes = () => ([{ s: 0, f: 1, t: 1.0, sus: 0 }]);
            sb.highway.getChords = () => ([
                { t: 2.0, notes: [{ s: 0, f: 3 }, { s: 1, f: 3 }] },
            ]);
        },
    });
    const anchors = core.createNoteDetector()._calibrationNotes();
    assert.deepEqual(Array.from(anchors, (n) => n.t), [1.0],
        'a chart with singles calibrates on the singles only — unchanged behaviour');
});

// A behavioural test can only cover the paths this vm can drive (no AudioContext
// stub → the browser scoring path can't be enabled here). This guards the rest:
// a scoring path that reads the raw chart directly is the whole bug, so no new
// one may appear. The allowlist is the reads that are deliberately NOT scoring.
test('no scoring path reads the unfiltered chart directly', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
    const ALLOWED = [
        // Test hook: reports the RAW chart size, on purpose.
        '_calDebug:',
        // ML training-bundle manifest — pins the chart as ground truth. Whether
        // that should be the drawn chart or the full one is a separate call
        // (see feedback#226 discussion); left raw deliberately.
        'notes:  (hw && hw.getNotes)  ? hw.getNotes()  : null,',
        'chords: (hw && hw.getChords) ? hw.getChords() : null,',
    ];
    const offenders = [];
    src.split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');           // strip trailing comments
        if (/^\s*\/\//.test(line)) return;                   // skip comment-only lines
        if (!/\b_?hw\.get(Notes|Chords)\s*\(\s*\)/.test(code)) return;
        // Compare on collapsed whitespace: the allowlist entries carry the source's
        // current double-spacing, and a formatter run that collapsed it would
        // otherwise turn every allowed read into a false offender and redden CI.
        const flat = (x) => x.replace(/\s+/g, ' ').trim();
        if (ALLOWED.some((a) => flat(line).includes(flat(a)))) return;
        offenders.push(`${i + 1}: ${line.trim()}`);
    });
    assert.deepEqual(offenders, [],
        'read the chart through _ndChartNotes()/_ndChartChords() so scoring follows the '
        + 'displayed difficulty (feedback#226); if this read is genuinely not a scoring '
        + 'path, add it to ALLOWED above with a reason');
});
