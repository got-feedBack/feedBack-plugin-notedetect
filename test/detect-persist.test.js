// Detect on/off must persist across song changes.
//
// Repro of the user-reported bug: with Detect ON, switching songs left it OFF
// (users had to re-press it every song). The only re-arm lived in the
// window.playSong wrapper, which fires right after origPlaySong() resolves —
// BEFORE the new chart/highway is ready — so enable() could bail at the
// resolveHw() guard and nothing re-armed once the song actually loaded.
//
// Fix: the default singleton re-arms on `song:loaded` (emitted once the chart
// is ready, on every load path) if the standing preference is ON. These tests
// pin: (1) a silent-disabled, preference-ON singleton re-enables on
// song:loaded; (2) an instance that was never enabled does NOT spuriously
// enable (no surprise mic grab); (3) the listener is gated to the default
// singleton.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

async function flushPendingAsync(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

// A sandbox whose desktop bridge lets enable() actually succeed (no real
// getUserMedia / AudioContext needed) — the same path the engine-verifier
// tests use. Returns the factory + the slopsmith stub (for _fire).
function reArmSandbox() {
    const audio = {
        isAvailable: async () => true,
        isAudioRunning: async () => true,
        startAudio: async () => {},
        getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
        getSampleRate: async () => 48000,
        getPitchDetection: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
        setChart: async () => true,
        getNoteVerdicts: async () => [],
    };
    return loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            // Detection runs on the desktop-bridge path, so getUserMedia must
            // never be needed; reject it to prove that.
            sandbox.navigator.mediaDevices.getUserMedia = () =>
                Promise.reject(new Error('getUserMedia must not run on the engine-verifier path'));
            // Don't actually schedule the detect loop.
            sandbox.setInterval = () => 0;
            sandbox.dispatchEvent = () => true;
            sandbox.highway.getSongInfo = () => ({ arrangement: 'lead', stringCount: 6, tuningOffsets: [0, 0, 0, 0, 0, 0], capo: 0 });
            sandbox.window.feedBackDesktop = { isDesktop: true, platform: 'linux', audio };
        },
    });
}

test('default singleton re-arms Detect on song:loaded after a per-song silent-disable', async () => {
    const env = reArmSandbox();
    const det = env.createNoteDetector({ isDefault: true });

    await det.enable();
    await flushPendingAsync();
    assert.equal(det.isEnabled(), true, 'enable() should turn detection on');
    assert.equal(det.wantsDetect(), true, 'standing preference defaults to ON');

    // The playSong wrapper silent-disables every instance on a song switch.
    det.disable({ silent: true });
    assert.equal(det.isEnabled(), false, 'silent-disable should turn detection off for the switch');

    // New song's chart becomes ready → song:loaded. The singleton must re-arm.
    env.slopsmith._fire('song:loaded', { arrangement: 'lead' });
    await flushPendingAsync();
    assert.equal(det.isEnabled(), true,
        'Detect must re-arm on song:loaded so the toggle persists across songs');

    det.destroy();
    await flushPendingAsync();
});

test('an instance that was never enabled does not auto-enable on song:loaded', async () => {
    // The re-arm listener is bound from enable(), so a detector the user never
    // turned on must not grab the mic when a song loads.
    const env = reArmSandbox();
    const det = env.createNoteDetector({ isDefault: true });

    env.slopsmith._fire('song:loaded', { arrangement: 'lead' });
    await flushPendingAsync();
    assert.equal(det.isEnabled(), false,
        'a never-enabled detector must stay off on song:loaded');

    det.destroy();
    await flushPendingAsync();
});

test('re-arm stops after destroy (listener unbound)', async () => {
    const env = reArmSandbox();
    const det = env.createNoteDetector({ isDefault: true });

    await det.enable();
    await flushPendingAsync();
    det.disable({ silent: true });
    det.destroy();
    await flushPendingAsync();

    // After destroy the song:loaded listener is gone — a late event must not
    // resurrect a destroyed instance.
    env.slopsmith._fire('song:loaded', { arrangement: 'lead' });
    await flushPendingAsync();
    assert.equal(det.isEnabled(), false, 'destroyed instance must not re-arm');
});

test('non-default instance does not re-arm on song:loaded', async () => {
    // Splitscreen panels are opt-in surfaces; only the default singleton
    // reclaims the mic across songs.
    const env = reArmSandbox();
    const det = env.createNoteDetector({ isDefault: false });

    await det.enable();
    await flushPendingAsync();
    det.disable({ silent: true });

    env.slopsmith._fire('song:loaded', { arrangement: 'lead' });
    await flushPendingAsync();
    assert.equal(det.isEnabled(), false,
        'a non-default instance must not auto-re-arm across songs');

    det.destroy();
    await flushPendingAsync();
});
