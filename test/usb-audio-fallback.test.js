// Over-constrained getUserMedia fallback for USB audio interfaces.
//
// Mono-only USB interfaces (e.g. the Rocksmith Real Tone Cable) reject
// `channelCount: 2` with an OverconstrainedError, and a stale saved
// `deviceId` (device unplugged since last session) rejects
// `deviceId: { exact }`. openInstrumentStream() inspects
// `OverconstrainedError.constraint` and drops EXACTLY the constraint the
// browser flagged, retrying until it opens — so a mono cable keeps the
// user's selected device (only stereo is dropped) and only a genuinely
// stale deviceId is forgotten.
//
// These tests drive the real capture path (no desktop bridge) and assert
// on the sequence of getUserMedia constraint objects. enable() proceeds
// past getUserMedia into AudioContext construction, which the vm sandbox
// has no stub for — that throw is swallowed by startAudio()'s own catch
// (alert is a noop in the loader), so the fallback sequence has already
// run by the time enable() settles.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

function overconstrained(constraint) {
    const e = new Error(`OverconstrainedError: ${constraint}`);
    e.name = 'OverconstrainedError';
    e.constraint = constraint;
    return e;
}

// Build a sandbox whose getUserMedia rejects `rejectConstraints` (in order,
// one per call) before resolving with a fake stream. Records a deep snapshot
// of each call's audio constraints — openInstrumentStream mutates the object
// in place, so we must clone at call time.
function sandboxWithGum({ rejectConstraints = [], savedDeviceId } = {}) {
    const calls = [];
    let attempt = 0;
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            if (savedDeviceId !== undefined) {
                const json = JSON.stringify({ deviceId: savedDeviceId, detectEnabled: false });
                sandbox.localStorage.getItem = () => json;
            }
            sandbox.navigator.mediaDevices.getUserMedia = (constraints) => {
                calls.push(JSON.parse(JSON.stringify(constraints.audio)));
                const rej = rejectConstraints[attempt++];
                if (rej) return Promise.reject(rej);
                return Promise.resolve({ getTracks: () => [] });
            };
        },
    });
    return { createNoteDetector, calls };
}

test('usb-audio: mono-only device (channelCount rejected) drops stereo and KEEPS the selected device', async () => {
    const { createNoteDetector, calls } = sandboxWithGum({
        savedDeviceId: 'cable-123',
        rejectConstraints: [overconstrained('channelCount')],
    });
    const det = createNoteDetector({ isDefault: true });
    try { await det.enable(); } catch (_) { /* AudioContext stub absent — fallback already ran */ }

    assert.equal(calls.length, 2, 'retries exactly once after the channelCount rejection');
    assert.equal(calls[0].channelCount, 2, 'first attempt requests stereo');
    assert.deepEqual(calls[0].deviceId, { exact: 'cable-123' }, 'first attempt targets the saved device');
    assert.equal(calls[1].channelCount, undefined, 'retry drops channelCount');
    assert.deepEqual(calls[1].deviceId, { exact: 'cable-123' }, 'retry KEEPS the user\'s selected device');
});

test('usb-audio: stale saved deviceId (deviceId rejected) is forgotten and falls back to default', async () => {
    const { createNoteDetector, calls } = sandboxWithGum({
        savedDeviceId: 'gone-456',
        rejectConstraints: [overconstrained('deviceId')],
    });
    const det = createNoteDetector({ isDefault: true });
    try { await det.enable(); } catch (_) { /* see note above */ }

    assert.equal(calls.length, 2, 'retries exactly once after the deviceId rejection');
    assert.deepEqual(calls[0].deviceId, { exact: 'gone-456' }, 'first attempt targets the stale device');
    assert.equal(calls[1].deviceId, undefined, 'retry forgets the stale device');
    assert.equal(calls[1].channelCount, 2, 'retry still requests stereo (channelCount was fine)');
});

test('usb-audio: stale device on a mono-only default relaxes BOTH constraints in sequence', async () => {
    const { createNoteDetector, calls } = sandboxWithGum({
        savedDeviceId: 'gone-789',
        rejectConstraints: [overconstrained('deviceId'), overconstrained('channelCount')],
    });
    const det = createNoteDetector({ isDefault: true });
    try { await det.enable(); } catch (_) { /* see note above */ }

    assert.equal(calls.length, 3, 'drops deviceId, then channelCount, then succeeds');
    assert.deepEqual(calls[0].deviceId, { exact: 'gone-789' }, 'first attempt targets the stale device');
    assert.equal(calls[0].channelCount, 2, 'first attempt requests stereo');
    assert.equal(calls[1].deviceId, undefined, 'second attempt has dropped the stale device');
    assert.equal(calls[1].channelCount, 2, 'second attempt still requests stereo');
    assert.equal(calls[2].deviceId, undefined, 'final attempt has no device');
    assert.equal(calls[2].channelCount, undefined, 'final attempt has no channelCount');
});

test('usb-audio: an unnamed OverconstrainedError is treated as the mono-only case (drops channelCount, keeps device)', async () => {
    // Some platforms surface OverconstrainedError without populating
    // `constraint`. channelCount is the only constraint we set that can
    // realistically over-constrain, so the unnamed case relaxes it.
    const { createNoteDetector, calls } = sandboxWithGum({
        savedDeviceId: 'cable-123',
        rejectConstraints: [overconstrained(undefined)],
    });
    const det = createNoteDetector({ isDefault: true });
    try { await det.enable(); } catch (_) { /* see note above */ }

    assert.equal(calls.length, 2, 'retries once on the unnamed failure');
    assert.equal(calls[1].channelCount, undefined, 'retry drops channelCount');
    assert.deepEqual(calls[1].deviceId, { exact: 'cable-123' }, 'retry keeps the selected device');
});

test('usb-audio: an unrelated named constraint surfaces immediately without dropping channelCount or the device', async () => {
    // Guard against the earlier behaviour where ANY non-deviceId
    // OverconstrainedError blindly dropped channelCount and could later
    // clear the saved device. A constraint we did not flag (here sampleRate)
    // must rethrow on the first failure, untouched.
    const { createNoteDetector, calls } = sandboxWithGum({
        savedDeviceId: 'cable-123',
        rejectConstraints: [overconstrained('sampleRate')],
    });
    const det = createNoteDetector({ isDefault: true });
    try { await det.enable(); } catch (_) { /* surfaces to startAudio's catch */ }

    assert.equal(calls.length, 1, 'an unrelated constraint is not retried — no blind relaxation');
});

test('usb-audio: a non-OverconstrainedError (e.g. permission denied) is NOT retried', async () => {
    const notAllowed = new Error('Permission denied');
    notAllowed.name = 'NotAllowedError';
    const { createNoteDetector, calls } = sandboxWithGum({
        savedDeviceId: 'cable-123',
        rejectConstraints: [notAllowed],
    });
    const det = createNoteDetector({ isDefault: true });
    try { await det.enable(); } catch (_) { /* permission error bubbles to startAudio's catch */ }

    assert.equal(calls.length, 1, 'permission errors surface immediately without a retry loop');
});
