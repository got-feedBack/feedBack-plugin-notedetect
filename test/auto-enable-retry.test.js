// Construct-time auto-enable: immediate + single retry on failure.
//
// A persisted detect-on session auto-enables immediately (no blanket
// startup delay) so it doesn't miss the opening notes. USB interfaces
// (e.g. the Real Tone Cable) can be enumerated-but-not-yet-openable at
// first paint; when the first open fails, the detector retries once after
// a short settle. The first (silent, automatic) attempt suppresses the
// user-facing failure alert so a transient not-ready device doesn't pop a
// dialog on load — the retry runs un-suppressed so a genuinely unusable
// device is still surfaced.
//
// These tests make the *load-time default singleton* the subject: providing
// window.AudioContext flips its `_hasAudio` gate on, so it auto-enables
// during load. AudioContext returns a bare object missing the node-factory
// methods, so startAudio fails just AFTER getUserMedia — enough to exercise
// the failure → retry → alert path without a full Web Audio mock. In its own
// file because enabling the audio path globally would perturb the
// _hasAudio-off assumption the rest of the suite relies on.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

async function flushPendingAsync(turns = 12) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

function notReadable() {
    const e = new Error('Device in use');
    e.name = 'NotReadableError';
    return e;
}

function overconstrained(constraint) {
    const e = new Error(`OverconstrainedError: ${constraint}`);
    e.name = 'OverconstrainedError';
    e.constraint = constraint;
    return e;
}

// Load the plugin with the audio gate on and a getUserMedia that follows
// `gumResults` (one entry per call: an Error rejects, anything else resolves
// as the stream). Records getUserMedia + alert call counts and a deep
// snapshot of each call's audio constraints (openInstrumentStream mutates the
// object in place, so we clone at call time). `savedDeviceId` seeds a
// persisted device selection via localStorage.
function loadWithAudio({ gumResults, savedDeviceId }) {
    const counts = { gum: 0, alert: 0 };
    const constraintsSeen = [];
    let attempt = 0;
    loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            if (savedDeviceId !== undefined) {
                const json = JSON.stringify({ deviceId: savedDeviceId, detectEnabled: true });
                sandbox.localStorage.getItem = () => json;
            }
            // A function => _hasAudio true. Returns a bare object so startAudio
            // throws on `audioCtx.createMediaStreamSource(...)` right after the
            // getUserMedia await resolves.
            sandbox.AudioContext = function () { return {}; };
            sandbox.window.AudioContext = sandbox.AudioContext;
            sandbox.alert = () => { counts.alert++; };
            sandbox.navigator.mediaDevices.getUserMedia = (constraints) => {
                constraintsSeen.push(JSON.parse(JSON.stringify(constraints.audio)));
                const r = gumResults[Math.min(attempt, gumResults.length - 1)];
                attempt++;
                counts.gum++;
                return (r instanceof Error) ? Promise.reject(r) : Promise.resolve(r || { getTracks: () => [] });
            };
        },
    });
    return { counts, constraintsSeen };
}

test('auto-enable: first attempt fails (device not ready) → retries once, no alert on the silent first attempt', async () => {
    // First open rejects (not ready); second open resolves the stream but
    // startAudio still fails on the bare AudioContext — the point is the
    // SECOND getUserMedia happened and the alert was gated correctly.
    const { counts } = loadWithAudio({ gumResults: [notReadable(), { getTracks: () => [] }] });
    await flushPendingAsync();

    assert.equal(counts.gum, 2, 'auto-enable retries exactly once after the first failure');
    assert.equal(counts.alert, 1, 'no alert on the silent first attempt; the retry surfaces the failure');
});

test('auto-enable: a first attempt that fails then a clean stream does not over-retry', async () => {
    // Both attempts reject — confirms the retry is bounded to a single extra
    // try (2 opens total), never an unbounded loop.
    const { counts } = loadWithAudio({ gumResults: [notReadable(), notReadable(), notReadable()] });
    await flushPendingAsync();

    assert.equal(counts.gum, 2, 'exactly one retry — auto-enable never loops past two attempts');
    assert.equal(counts.alert, 1, 'alert is suppressed on the first attempt and shown once on the retry');
});

test('auto-enable: a saved device that fails to match on the silent first attempt is PRESERVED and re-tried, not forgotten', async () => {
    // The startup race: a still-enumerating USB device transiently fails the
    // exact deviceId match. The silent first attempt must NOT forget the saved
    // device (which would switch the user to the default input) — it surfaces
    // the failure so the delayed retry can re-target the real device once it
    // has enumerated. Guards against the auto-enable retry and the
    // OverconstrainedError fallback undercutting each other.
    const { counts, constraintsSeen } = loadWithAudio({
        savedDeviceId: 'cable-123',
        // 1st open: deviceId overconstraint (device not yet enumerated).
        // 2nd open (the delayed retry): the device has appeared — resolves.
        gumResults: [overconstrained('deviceId'), { getTracks: () => [] }],
    });
    await flushPendingAsync();

    assert.equal(counts.gum, 2, 'the silent attempt fails closed (no inner fallback), then the retry runs');
    assert.deepEqual(constraintsSeen[0].deviceId, { exact: 'cable-123' }, 'first attempt targets the saved device');
    assert.deepEqual(constraintsSeen[1].deviceId, { exact: 'cable-123' },
        'the retry STILL targets the saved device — it was preserved through the transient failure, not forgotten');
});
