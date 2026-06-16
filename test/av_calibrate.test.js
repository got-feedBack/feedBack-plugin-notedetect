// A/V auto-calibration tests — the offset sweep that picks the av-offset
// maximizing matched notes (the harness objective, in-app). Pure function,
// so we feed synthetic offset-free detections with a known true offset and
// assert it's recovered, plus robustness to off-pitch noise and thin data.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

// Standard 4-string bass: string 1 (A1) fret 5 -> MIDI 38 (D2) — matches the
// real Gasoline / Why'd-You-Only-Call data (s=1 f=5 -> expected 38).
function bassGeom() { return { arrangement: 'bass', stringCount: 4, offsets: [0, 0, 0, 0], capo: 0 }; }

test('recovers a known +60 ms A/V offset from offset-free detections', () => {
    const core = loadDetectionCore();
    const trueMs = 60, off = trueMs / 1000;
    const notes = [], dets = [];
    for (let i = 0; i < 40; i++) {
        const t = 1 + i * 0.4;
        notes.push({ t, s: 1, f: 5 });
        dets.push({ bt: t - off, m: 38 });   // judged_t = bt + off === t at the true offset
    }
    const r = core.calibrateOffsetMs(dets, notes, bassGeom(), 0.1, 60, { stepMs: 5 });
    assert.ok(r, 'returns a result');
    assert.equal(r.matched, 40, 'matches every note at the right offset');
    assert.ok(Math.abs(r.offsetMs - trueMs) <= 5, `offsetMs ${r.offsetMs} ≈ ${trueMs}`);
});

test('recovers a negative offset and ignores off-pitch detections', () => {
    const core = loadDetectionCore();
    const trueMs = -80, off = trueMs / 1000;
    const notes = [], dets = [];
    for (let i = 0; i < 30; i++) {
        const t = 1 + i * 0.5;
        notes.push({ t, s: 1, f: 5 });
        dets.push({ bt: t - off, m: 38 });        // correct
        dets.push({ bt: t - off, m: 41 });        // +300c (not an octave) — must NOT match
    }
    const r = core.calibrateOffsetMs(dets, notes, bassGeom(), 0.1, 60, { stepMs: 5 });
    assert.ok(r);
    assert.equal(r.matched, 30, 'off-pitch detections do not inflate the match count');
    assert.ok(Math.abs(r.offsetMs - trueMs) <= 5, `offsetMs ${r.offsetMs} ≈ ${trueMs}`);
});

test('prefers the offset with more matches over a wrong-but-tempting one', () => {
    const core = loadDetectionCore();
    const notes = [], dets = [];
    // True offset 0: a detection at each note's time.
    for (let i = 0; i < 50; i++) { const t = 1 + i * 0.3; notes.push({ t, s: 1, f: 5 }); dets.push({ bt: t, m: 38 }); }
    // A decoy cluster shifted +150 ms that would match a handful if it won.
    for (let i = 0; i < 8; i++) { dets.push({ bt: 1 + i * 0.3 - 0.150, m: 38 }); }
    const r = core.calibrateOffsetMs(dets, notes, bassGeom(), 0.1, 60, { stepMs: 10 });
    assert.ok(r);
    assert.ok(Math.abs(r.offsetMs) <= 10, `picked the high-recall offset, got ${r.offsetMs}`);
});

test('returns null without enough evidence', () => {
    const core = loadDetectionCore();
    const r = core.calibrateOffsetMs([{ bt: 1, m: 38 }], [{ t: 1, s: 1, f: 5 }], bassGeom(), 0.1, 60, {});
    assert.equal(r, null);
});

// ── Lifecycle (reset / resume / once-per-play) ────────────────────────
// The sweep above is pure; these cover the song-event wiring that feeds it:
// a fresh play must reset the take (so a replay / stop-without-song:ended
// re-calibrates), a resume after pause must KEEP it, and pause must not run
// calibration (which would lock in a partial-take offset).

test('lifecycle: fresh play resets the take; resume after pause keeps it', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det._bindCalEvents();
    det._calSeedForTest(5);
    assert.equal(det._calState().detections, 5);
    // pause → play is a RESUME: the take is preserved.
    core.slopsmith._fire('song:pause', {});
    assert.equal(det._calState().paused, true);
    core.slopsmith._fire('song:play', {});
    assert.equal(det._calState().paused, false);
    assert.equal(det._calState().detections, 5, 'resume keeps the take');
    // a play NOT preceded by a pause is a FRESH start: the take is reset.
    core.slopsmith._fire('song:play', {});
    assert.equal(det._calState().detections, 0, 'fresh play resets the take');
    det.destroy();
});

test('lifecycle: pause does not calibrate or mark the take done', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det._bindCalEvents();
    det._calSeedForTest(5);
    core.slopsmith._fire('song:pause', {});
    const st = det._calState();
    assert.equal(st.done, false, 'pause must not mark the take calibrated');
    assert.equal(st.detections, 5, 'pause must not drop the take');
    assert.equal(st.paused, true);
    det.destroy();
});

test('lifecycle: song:loaded clears the take and the paused flag', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det._bindCalEvents();
    det._calSeedForTest(5);
    core.slopsmith._fire('song:pause', {});
    core.slopsmith._fire('song:loaded', { filename: 'x.archive' });
    const st = det._calState();
    assert.equal(st.detections, 0);
    assert.equal(st.done, false);
    assert.equal(st.paused, false);
    det.destroy();
});

test('lifecycle: binds loaded/play/ended/pause once; unbind removes all', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det._bindCalEvents();
    for (const ev of ['song:loaded', 'song:play', 'song:ended', 'song:pause'])
        assert.equal(core.slopsmith._listenerCount(ev), 1, ev);
    det._bindCalEvents(); // idempotent
    assert.equal(core.slopsmith._listenerCount('song:play'), 1, 'still one after re-bind');
    det._unbindCalEvents();
    for (const ev of ['song:loaded', 'song:play', 'song:ended', 'song:pause'])
        assert.equal(core.slopsmith._listenerCount(ev), 0, ev);
    det.destroy();
});

test('lifecycle: non-default instance never binds calibrate listeners', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector(); // isDefault:false
    det._bindCalEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 0, 'splitscreen panel does not calibrate');
    det.destroy();
});
