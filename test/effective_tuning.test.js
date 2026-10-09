// Effective-tuning follow — scoring maps (string, fret) → pitch through the
// host's EFFECTIVE tuning / capo / reference pitch, not the original song_info.
//
// Regression target (notedetect#24): when the chart is retuned / converted to
// E standard, the highway shows the new notes but detection kept expecting the
// old pitches. Core's chart-transform domain (feedBack#952) is the official
// signal for "the chart the player sees differs from the original": a provider
// may replace tuning, capo and centOffset, exposed through
// `highway.getTuning()` / `getCapo()` / `getCentOffset()` while
// `getSongInfo()` keeps the original metadata. These tests pin:
//   1. _ndRefShiftCents keeps only the sub-octave part of a centOffset.
//   2. _syncChartStateFromHw prefers the effective getters over song_info.
//   3. A whole-semitone centOffset shifts every expected MIDI; the common
//      extended-range-bass -1200 changes nothing.
//   4. A mid-song transform restage (no song/arrangement event) is picked up
//      by the per-tick resync.
//   5. The desktop engine receives integer offsets (it reads Int32).
//   6. A pre-chart-transform host (no getters) keeps the song_info path.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

function mountWith(core, { info, tuning, capo, centOffset, stringCount = 6 }) {
    core.highway.getSongInfo = () => info;
    core.highway.getStringCount = () => stringCount;
    if (tuning !== undefined) core.highway.getTuning = () => tuning;
    if (capo !== undefined) core.highway.getCapo = () => capo;
    if (centOffset !== undefined) core.highway.getCentOffset = () => centOffset;
    return core.createNoteDetector();
}

test('_ndRefShiftCents drops whole octaves, keeps the remainder', () => {
    const core = loadDetectionCore();
    const f = core.refShiftCents;
    assert.equal(f(0), 0);
    assert.equal(f(undefined), 0);
    assert.equal(f(NaN), 0);
    assert.equal(f('x'), 0);
    assert.equal(f(-1200), 0, 'extended-range bass octave is not a retune');
    assert.equal(f(2400), 0);
    assert.equal(f(-100), -100, 'a half-step-down retune');
    assert.equal(f(-1300), -100, 'octave + semitone keeps the semitone');
    assert.ok(Math.abs(f(11.8) - 11.8) < 1e-9, 'A443 true-tuning');
});

test('_ndEngineOffsets rounds to whole semitones for the Int32 engine', () => {
    const core = loadDetectionCore();
    assert.deepEqual(core.engineOffsets([-1, -1.3, 0.118, -2.6]), [-1, -1, 0, -3]);
    assert.equal(core.engineOffsets(null), null);
});

test('effective tuning/capo from a chart transform beat original song_info', () => {
    const core = loadDetectionCore();
    // Original chart: Eb standard, capo 0. Transform: converted to E standard
    // with a capo-2 view.
    const det = mountWith(core, {
        info: { arrangement: 'Lead', tuning: [-1, -1, -1, -1, -1, -1], capo: 0, centOffset: 0 },
        tuning: [0, 0, 0, 0, 0, 0],
        capo: 2,
        centOffset: 0,
    });
    det._syncChartStateFromHw();
    const st = det._getChartState();
    assert.equal(st.tuningOffsets.join(','), '0,0,0,0,0,0', 'transformed tuning, not the original');
    assert.equal(st.capo, 2, 'transformed capo');
    assert.equal(st.stringCount, 6);
    det.destroy();
});

test('a semitone centOffset shifts every expected pitch; -1200 bass does not', () => {
    const core = loadDetectionCore();
    const det = mountWith(core, {
        info: { arrangement: 'Lead', tuning: [0, 0, 0, 0, 0, 0], centOffset: 0 },
        tuning: [0, 0, 0, 0, 0, 0],
        capo: 0,
        centOffset: -100,
    });
    det._syncChartStateFromHw();
    const st = det._getChartState();
    assert.equal(st.tuningOffsets.join(','), '-1,-1,-1,-1,-1,-1');
    // Low E open → Eb2 (39) instead of E2 (40); the chokepoint is unchanged.
    assert.equal(core.rawMidiFromStringFret(0, 0, 'guitar', 6, st.tuningOffsets, st.capo), 39);
    det.destroy();

    const core2 = loadDetectionCore();
    const bass = mountWith(core2, {
        info: { arrangement: 'Bass', tuning: [0, 0, 0, 0], centOffset: -1200 },
        tuning: [0, 0, 0, 0],
        capo: 0,
        centOffset: -1200,
        stringCount: 4,
    });
    bass._syncChartStateFromHw();
    const bs = bass._getChartState();
    assert.equal(bs.tuningOffsets.join(','), '0,0,0,0', 'octave offset leaves bass scoring as before');
    assert.equal(bs.arrangement, 'bass');
    bass.destroy();
});

test('a mid-song transform restage is picked up by the per-tick resync', () => {
    const core = loadDetectionCore();
    let tuning = [0, 0, 0, 0, 0, 0];
    let cents = 0;
    core.highway.getSongInfo = () => ({ arrangement: 'Lead', tuning: [0, 0, 0, 0, 0, 0] });
    core.highway.getStringCount = () => 6;
    core.highway.getTuning = () => tuning;
    core.highway.getCapo = () => 0;
    core.highway.getCentOffset = () => cents;
    const det = core.createNoteDetector();
    det._syncChartStateFromHw();
    assert.equal(det._resyncIfTuningChanged(), false, 'unchanged inputs → no resync');

    // Live retune provider restages: whole-step down via tuning…
    tuning = [-2, -2, -2, -2, -2, -2];
    assert.equal(det._resyncIfTuningChanged(), true);
    assert.equal(det._getChartState().tuningOffsets.join(','), '-2,-2,-2,-2,-2,-2');
    assert.equal(det._resyncIfTuningChanged(), false);

    // …then a reference-pitch nudge via centOffset.
    cents = 50;
    assert.equal(det._resyncIfTuningChanged(), true);
    assert.equal(det._getChartState().tuningOffsets.join(','), '-1.5,-1.5,-1.5,-1.5,-1.5,-1.5');
    det.destroy();
});

test('pre-chart-transform host (no getters) keeps the song_info path', () => {
    const core = loadDetectionCore();
    delete core.highway.getTuning;
    delete core.highway.getCapo;
    delete core.highway.getCentOffset;
    core.highway.getSongInfo = () => ({ arrangement: 'Lead', tuning: [-2, 0, 0, 0, 0, 0], capo: 3 });
    core.highway.getStringCount = () => 6;
    const det = core.createNoteDetector();
    det._syncChartStateFromHw();
    const st = det._getChartState();
    assert.equal(st.tuningOffsets.join(','), '-2,0,0,0,0,0');
    assert.equal(st.capo, 3);
    assert.equal(det._resyncIfTuningChanged(), false, 'nothing to poll without the getters');
    det.destroy();
});

test('the desktop engine chart gets integer offsets under a fractional shift', async () => {
    const pushed = [];
    const audio = {
        isAvailable: async () => true,
        isAudioRunning: async () => true,
        startAudio: async () => {},
        getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
        getSampleRate: async () => 48000,
        getPitchDetection: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
        getRawPitch: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
        setChart: async (chart) => { pushed.push(chart); return true; },
        getNoteVerdicts: async () => [],
    };
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.setInterval = () => 1;
            sandbox.dispatchEvent = () => true;
            sandbox.highway.getNotes = () => ([{ s: 1, f: 2, t: 3.0, sus: 0 }]);
            sandbox.highway.getChords = () => ([]);
            sandbox.highway.getTime = () => 0;
            sandbox.highway.getAvOffset = () => 0;
            sandbox.highway.getSongInfo = () => ({ arrangement: 'Lead', tuning: [0, 0, 0, 0, 0, 0] });
            sandbox.highway.getStringCount = () => 6;
            sandbox.highway.getTuning = () => [-1, -1, -1, -1, -1, -1];
            sandbox.highway.getCapo = () => 0;
            sandbox.highway.getCentOffset = () => -30;   // -1.3 semitones
            sandbox.window.feedBackDesktop = { isDesktop: true, platform: 'linux', audio };
        },
    });
    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    // Host live tuning (no ctx) → the funnel rounds before the engine sees it.
    const armed = await det.setContainedChart([{ id: 'x', t: 0.5, s: 0, f: 0 }]);
    assert.equal(armed, true);
    const last = pushed[pushed.length - 1];
    assert.equal(last.tuningOffsets.join(','), '-1,-1,-1,-1,-1,-1');
    assert.equal(det._getChartState().tuningOffsets.join(','), '-1.3,-1.3,-1.3,-1.3,-1.3,-1.3',
        'the JS path keeps the sub-semitone shift');
    det.destroy();
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
});
