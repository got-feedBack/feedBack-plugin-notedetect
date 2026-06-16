// Chart-state sync tests — exercise the song:loaded / arrangement:changed
// listeners and the `_syncChartStateFromHw` reset semantics.
//
// Regression target: a session that started on a bass arrangement and
// then loaded a guitar song could carry `currentArrangement='bass'` /
// 4-string offsets into the new chart, so strings 4-5 of the guitar
// part scored against `_ND_TUNING_BASS_4` and retired with
// `expectedMidi: null`. The fix centralizes the sync in
// `_syncChartStateFromHw()` (which pre-resets to a known-good 6-string
// guitar default) and wires `song:loaded`/`arrangement:changed` so
// mid-session switches resync without waiting for the next enable().

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

// Build a detector wired to a synthetic song. The vm `highway` stub
// only ships `getSongInfo: () => ({})`; tests need to override both
// getSongInfo and getStringCount to drive the resolution branches.
function mountDetectorWithSong(core, { arrangement, tuning, capo, stringCount } = {}) {
    core.highway.getSongInfo = () => {
        const info = {};
        if (arrangement !== undefined) info.arrangement = arrangement;
        if (tuning !== undefined)      info.tuning      = tuning;
        if (capo !== undefined)        info.capo        = capo;
        return info;
    };
    if (stringCount !== undefined) {
        core.highway.getStringCount = () => stringCount;
    } else {
        delete core.highway.getStringCount;
    }
    return core.createNoteDetector();
}

test('bass→guitar song:loaded resets arrangement/stringCount/tuning/capo', () => {
    const core = loadDetectionCore();

    // First song: 4-string bass with capo 2.
    const det = mountDetectorWithSong(core, {
        arrangement: 'bass',
        tuning: [0, 0, 0, 0],
        capo: 2,
        stringCount: 4,
    });
    det._bindChartStateEvents();
    det._syncChartStateFromHw();
    let state = det._getChartState();
    assert.equal(state.arrangement, 'bass');
    assert.equal(state.stringCount, 4);
    assert.deepEqual([...state.tuningOffsets], [0, 0, 0, 0]);
    assert.equal(state.capo, 2);

    // Second song: 6-string guitar, no capo. Switch host state and
    // fire song:loaded; the detector must resync end-to-end without
    // carrying any field from the previous song.
    core.highway.getSongInfo = () => ({
        arrangement: 'Lead',
        tuning: [0, 0, 0, 0, 0, 0],
        capo: 0,
    });
    core.highway.getStringCount = () => 6;
    core.slopsmith._fire('song:loaded', { filename: 'guitar-song.archive' });

    state = det._getChartState();
    assert.equal(state.arrangement, 'guitar', 'arrangement must flip off bass');
    assert.equal(state.stringCount, 6, 'string count must flip to 6');
    assert.deepEqual([...state.tuningOffsets], [0, 0, 0, 0, 0, 0]);
    assert.equal(state.capo, 0);
    det.destroy();
});

test('arrangement:changed mid-session resyncs without waiting for enable()', () => {
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {
        arrangement: 'Lead',
        tuning: [0, 0, 0, 0, 0, 0],
        stringCount: 6,
    });
    det._bindChartStateEvents();
    det._syncChartStateFromHw();
    assert.equal(det._getChartState().arrangement, 'guitar');

    // Same song, but user flipped to the bass arrangement.
    core.highway.getSongInfo = () => ({
        arrangement: 'Bass',
        tuning: [0, 0, 0, 0],
    });
    core.highway.getStringCount = () => 4;
    core.slopsmith._fire('arrangement:changed', { arrangement: 'Bass' });

    const state = det._getChartState();
    assert.equal(state.arrangement, 'bass');
    assert.equal(state.stringCount, 4);
    assert.deepEqual([...state.tuningOffsets], [0, 0, 0, 0]);
    det.destroy();
});

test('_bindChartStateEvents is idempotent', () => {
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {});
    det._bindChartStateEvents();
    det._bindChartStateEvents();
    det._bindChartStateEvents();
    assert.equal(core.slopsmith._listenerCount('song:loaded'), 1);
    assert.equal(core.slopsmith._listenerCount('song:ready'), 1);
    assert.equal(core.slopsmith._listenerCount('arrangement:changed'), 1);
    det.destroy();
});

test('destroy() unbinds song:loaded, song:ready and arrangement:changed listeners', () => {
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {});
    det._bindChartStateEvents();
    assert.equal(core.slopsmith._listenerCount('song:loaded'), 1);
    assert.equal(core.slopsmith._listenerCount('song:ready'), 1);
    assert.equal(core.slopsmith._listenerCount('arrangement:changed'), 1);

    det.destroy();
    assert.equal(core.slopsmith._listenerCount('song:loaded'), 0);
    assert.equal(core.slopsmith._listenerCount('song:ready'), 0);
    assert.equal(core.slopsmith._listenerCount('arrangement:changed'), 0);

    // Firing post-destroy must not throw.
    assert.doesNotThrow(() => {
        core.slopsmith._fire('song:loaded', { filename: 'x.archive' });
        core.slopsmith._fire('song:ready', { hasPhraseData: true });
        core.slopsmith._fire('arrangement:changed', { arrangement: 'Lead' });
    });
});

test('no-tuning reset branch — missing info.tuning falls back to 6-string-guitar default', () => {
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {
        arrangement: 'bass',
        tuning: [0, 0, 0, 0],
        capo: 3,
        stringCount: 4,
    });
    det._syncChartStateFromHw();
    assert.equal(det._getChartState().arrangement, 'bass');

    // New song with NO tuning array and NO arrangement, no stringCount.
    // The pre-reset must wipe the bass state back to guitar defaults.
    core.highway.getSongInfo = () => ({});
    delete core.highway.getStringCount;
    det._syncChartStateFromHw();

    const state = det._getChartState();
    assert.equal(state.arrangement, 'guitar');
    assert.equal(state.stringCount, 6);
    assert.deepEqual([...state.tuningOffsets], [0, 0, 0, 0, 0, 0]);
    assert.equal(state.capo, 0);
    det.destroy();
});

test('bass arrangement with no tuning array picks bass-4 default (not guitar-6)', () => {
    // Direct coverage for the second-order regression Copilot flagged:
    // info.arrangement='bass' but info.tuning missing/non-array meant
    // currentStringCount stayed at 6, and _ndStandardMidiFor('bass', 6)
    // returned the 4-entry _ND_TUNING_BASS_4 — reproducing the
    // expectedMidi:null symptom this PR exists to fix, just for the
    // bass case.
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, { arrangement: 'Bass' });
    // No tuning array. No getStringCount on the highway either.
    det._syncChartStateFromHw();
    const state = det._getChartState();
    assert.equal(state.arrangement, 'bass');
    assert.equal(state.stringCount, 4, 'bass arrangement must default to 4 strings, not 6');
    det.destroy();
});

test('host getStringCount wins over per-arrangement default and tuning length', () => {
    const core = loadDetectionCore();
    // 7-string guitar: tuning.length=7, host says 7. Verify host wins
    // (also implicitly checks per-arrangement default of 6 is overridden).
    const det = mountDetectorWithSong(core, {
        arrangement: 'Lead',
        tuning: [0, 0, 0, 0, 0, 0, 0],
        stringCount: 7,
    });
    det._syncChartStateFromHw();
    assert.equal(det._getChartState().stringCount, 7);
    det.destroy();
});

test('older host without getStringCount: 7-string guitar tuning.length wins over per-arrangement default', () => {
    // Codex preflight caught this: when hw.getStringCount is missing,
    // an arrangement-driven default of 6 would clobber a valid 7-entry
    // tuning array. tuning.length must win when it's consistent with
    // the arrangement (4/5 for bass, 6/7/8 for guitar).
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {
        arrangement: 'Lead',
        tuning: [0, 0, 0, 0, 0, 0, 0],
        // no stringCount → no hw.getStringCount on the highway
    });
    det._syncChartStateFromHw();
    assert.equal(det._getChartState().stringCount, 7,
        'tuning.length=7 must win over per-arrangement default of 6');
    det.destroy();
});

test('older host without getStringCount: 5-string bass tuning.length wins over per-arrangement default', () => {
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {
        arrangement: 'Bass',
        tuning: [0, 0, 0, 0, 0],
    });
    det._syncChartStateFromHw();
    assert.equal(det._getChartState().stringCount, 5,
        'tuning.length=5 must win over per-arrangement default of 4');
    det.destroy();
});

test('older host without getStringCount: bass with arrangement XML-padded 6-entry tuning falls back to bass-4', () => {
    // arrangement XML pads bass tunings to six entries. With no host count and
    // no way to disambiguate, tuning.length=6 is NOT consistent with
    // arrangement=bass, so the per-arrangement default (4) must win.
    // Without this guard the bass chart would map against a 6-entry
    // base array — the exact regression the helper exists to fix.
    const core = loadDetectionCore();
    const det = mountDetectorWithSong(core, {
        arrangement: 'Bass',
        tuning: [0, 0, 0, 0, 0, 0],
    });
    det._syncChartStateFromHw();
    assert.equal(det._getChartState().stringCount, 4,
        'bass + tuning.length=6 (arrangement XML pad) must fall back to bass-4');
    det.destroy();
});
