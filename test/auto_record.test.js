// Auto-record tests — when enabled, every play is captured for later
// analysis without the user arming anything (the teaching-tool goal).
// Off by default; opt in via setAutoRecord(true). The behaviour:
//   • the default singleton binds a song:loaded listener that auto-arms
//     the upcoming play (rides the existing capture + song:ended save);
//   • non-default instances (splitscreen panels, the vm test detectors)
//     never bind it, so the listener-count contracts elsewhere hold;
//   • a user opt-out (autoRecord=false) and Detect being off both gate it.
//
// These drive the bind via the _bindAutoRecord test hook (production
// binds from enableImpl(), which needs the audio pipeline the vm lacks).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

test('isAutoRecord defaults false; setAutoRecord toggles it', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    assert.equal(det.isAutoRecord(), false);
    det.setAutoRecord(true);
    assert.equal(det.isAutoRecord(), true);
    det.setAutoRecord(false);
    assert.equal(det.isAutoRecord(), false);
    det.destroy();
});

test('default singleton: _bindAutoRecord binds song:loaded exactly once and auto-arms on it', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det.setAutoRecord(true); // opt in (default is off)

    assert.equal(det.getRecordingState().armed, false, 'starts disarmed');
    det._bindAutoRecord();
    assert.equal(core.slopsmith._listenerCount('song:loaded'), 1, 'one song:loaded listener');
    // Idempotent — a second bind must not double-register.
    det._bindAutoRecord();
    assert.equal(core.slopsmith._listenerCount('song:loaded'), 1, 'still one after re-bind');

    core.slopsmith._fire('song:loaded', { filename: 'x.psarc' });
    assert.equal(det.getRecordingState().armed, true, 'auto-armed by song:loaded');
    det.destroy();
});

test('autoRecord off gates the auto-arm', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det.setAutoRecord(false);
    det._bindAutoRecord();
    core.slopsmith._fire('song:loaded', { filename: 'x.psarc' });
    assert.equal(det.getRecordingState().armed, false, 'opt-out keeps it disarmed');
    det.destroy();
});

test('non-default instance never binds auto-record', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector(); // isDefault:false
    det._bindAutoRecord();
    assert.equal(core.slopsmith._listenerCount('song:loaded'), 0, 'no listener bound');
    core.slopsmith._fire('song:loaded', { filename: 'x.psarc' });
    assert.equal(det.getRecordingState().armed, false, 'splitscreen panel does not auto-record');
    det.destroy();
});

test('_bindAutoRecord wires song:loaded, song:pause and song:play; _unbindAutoRecord removes all three', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det._bindAutoRecord();
    assert.equal(core.slopsmith._listenerCount('song:loaded'), 1);
    assert.equal(core.slopsmith._listenerCount('song:pause'), 1);
    assert.equal(core.slopsmith._listenerCount('song:play'), 1);
    det._unbindAutoRecord();
    assert.equal(core.slopsmith._listenerCount('song:loaded'), 0);
    assert.equal(core.slopsmith._listenerCount('song:pause'), 0);
    assert.equal(core.slopsmith._listenerCount('song:play'), 0);
    det.destroy();
});

test('song:play re-arms when nothing is armed (resume after a pause-save)', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det.setAutoRecord(true); // opt in (default is off)
    det._bindAutoRecord();
    // No prior song:loaded — a bare play still arms a fresh take.
    assert.equal(det.getRecordingState().armed, false);
    core.slopsmith._fire('song:play', {});
    assert.equal(det.getRecordingState().armed, true, 'play armed a take');
    assert.equal(det.getRecordingState().songPlaying, true, 'and marked the song playing so frames capture');
    det.destroy();
});

test('a failed auto-save preserves the take — neither song:loaded nor song:play re-arms over it', async () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det.setAutoRecord(true); // opt in (default is off)
    det._bindAutoRecord();

    // Arm a take and give it captured audio (no live audio in the vm, so
    // inject a frame directly).
    core.slopsmith._fire('song:play', {});
    assert.equal(det.getRecordingState().armed, true, 'play armed a take');
    det._injectRecChunkForTest();
    assert.equal(det.getRecordingState().chunks, 1, 'take has captured audio');

    // song:loaded tries to flush the stranded take. saveRecordingNow()
    // fails here (no fetch in the vm), returns null and KEEPS the buffer.
    // The handler must NOT re-arm — armRecording() would wipe the take.
    core.slopsmith._fire('song:loaded', { filename: 'next.psarc' });
    await new Promise((r) => setTimeout(r, 0)); // drain the async handler
    let st = det.getRecordingState();
    assert.equal(st.armed, false, 'not re-armed after a failed save');
    assert.equal(st.chunks, 1, 'failed take preserved for retry');
    assert.ok(st.lastError, 'save failure recorded');

    // A subsequent play must also leave the preserved take intact.
    core.slopsmith._fire('song:play', {});
    st = det.getRecordingState();
    assert.equal(st.armed, false, 'play did not re-arm over the preserved take');
    assert.equal(st.chunks, 1, 'preserved take still intact after play');
    det.destroy();
});

test('a second song:loaded does not re-arm over a disarmed, retained failed take', async () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det.setAutoRecord(true);
    det._bindAutoRecord();

    // Drive the take into the disarmed-but-retained state: arm, capture audio,
    // then a song:loaded whose flush-save fails (no fetch in the vm) — leaves
    // _recArmed false with _recChunks intact.
    core.slopsmith._fire('song:play', {});
    det._injectRecChunkForTest();
    core.slopsmith._fire('song:loaded', { filename: 'a.psarc' });
    await new Promise((r) => setTimeout(r, 0));
    let st = det.getRecordingState();
    assert.equal(st.armed, false, 'disarmed after the failed flush');
    assert.equal(st.chunks, 1, 'take retained');

    // A SUBSEQUENT song:loaded (armed already false) must still not wipe it —
    // without the guard, armRecording() would clear the preserved take.
    core.slopsmith._fire('song:loaded', { filename: 'b.psarc' });
    await new Promise((r) => setTimeout(r, 0));
    st = det.getRecordingState();
    assert.equal(st.armed, false, 'not re-armed over the preserved take');
    assert.equal(st.chunks, 1, 'preserved failed take still intact');
    det.destroy();
});

test('a second song:loaded with nothing captured re-arms without throwing', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    det.setAutoRecord(true); // opt in (default is off)
    det._bindAutoRecord();
    core.slopsmith._fire('song:loaded', { filename: 'a.psarc' });
    assert.equal(det.getRecordingState().armed, true);
    // Song stopped without song:ended, new song loads — the prior empty
    // take is discarded and the new one armed; no two-songs-in-one-WAV.
    core.slopsmith._fire('song:loaded', { filename: 'b.psarc' });
    assert.equal(det.getRecordingState().armed, true, 'still armed for the new song');
    det.destroy();
});
