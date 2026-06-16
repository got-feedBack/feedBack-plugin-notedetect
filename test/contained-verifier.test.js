// Verifies the contained-playback verifier API (setContainedChart /
// pushContainedPlayhead / drainContainedVerdicts / releaseContainedChart).
//
// A non-chart consumer (SlopScale, Chord Sprint) runs its own exercise
// transport and drives the SAME desktop engine NoteVerifier the host song
// uses — but with ITS own chart + playhead, scored against an optional tuning
// ctx, suspending host-song scoring while armed (one engine chart slot). These
// tests pin the contract:
//   1. setContainedChart pushes the consumer's notes (with their ids) and the
//      arrangement's verify params (harmonicSnr/fundamentalRatio/presenceRatio)
//      via audio.setChart, scored under the ctx tuning; returns true.
//   2. While armed, a host song:ready does NOT re-push the host chart (the
//      contained chart owns the engine slot).
//   3. pushContainedPlayhead forwards the consumer's playhead VERBATIM to
//      getNoteVerdicts (no host avOffset/latency math).
//   4. drainContainedVerdicts returns the buffered verdicts, then clears.
//   5. releaseContainedChart restores host-song scoring (re-pushes the host
//      chart).
//   6. On a downlevel addon (no setChart/getNoteVerdicts) setContainedChart
//      returns null and isContainedVerifierAvailable() is false.
//   7. The engine chart slot is shared: a second instance can't arm a
//      contained chart while another instance holds it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

async function flushPendingAsync(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

// Host song chart: one guitar note. So a host re-push is detectable (its notes
// differ from any contained chart we arm).
const HOST_NOTE = { s: 1, f: 2, t: 3.0, sus: 0 };

// Build a sandbox with the desktop bridge + chart-verifier API. `withVerifierApi
// = false` simulates a downlevel addon. Returns helpers to inspect bridge calls.
function containedSandbox({ withVerifierApi = true } = {}) {
    const calls = { setChart: 0, getNoteVerdicts: 0 };
    const setChartPayloads = [];   // every chart handed to setChart
    const getVerdictsArgs = [];     // [songTime, playing] per call
    const verdictQueue = [];        // FIFO of verdict arrays getNoteVerdicts returns
    const intervalCallbacks = [];

    const audio = {
        isAvailable: async () => true,
        isAudioRunning: async () => true,
        startAudio: async () => {},
        getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
        getSampleRate: async () => 48000,
        getPitchDetection: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
        getRawPitch: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
    };
    if (withVerifierApi) {
        audio.setChart = async (chart) => {
            calls.setChart++;
            setChartPayloads.push(chart);
            return true;
        };
        audio.getNoteVerdicts = async (songTime, playing) => {
            calls.getNoteVerdicts++;
            getVerdictsArgs.push([songTime, playing]);
            return verdictQueue.length ? verdictQueue.shift() : [];
        };
    }

    let slopsmithStub = null;
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.navigator.mediaDevices.getUserMedia = () =>
                Promise.reject(new Error('getUserMedia must not run on the bridge path'));
            sandbox.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            sandbox.dispatchEvent = () => true;
            sandbox.highway.getNotes = () => ([{ ...HOST_NOTE }]);
            sandbox.highway.getChords = () => ([]);
            sandbox.highway.getTime = () => 0;
            sandbox.highway.getAvOffset = () => 0;
            sandbox.window.slopsmithDesktop = { isDesktop: true, platform: 'linux', audio };
            slopsmithStub = sandbox.slopsmith;
        },
    });

    return {
        createNoteDetector, calls, setChartPayloads, getVerdictsArgs, verdictQueue,
        fireSlopsmith: (event, detail) => slopsmithStub && slopsmithStub._fire(event, detail),
    };
}

// A small contained exercise chart with caller-chosen stable ids.
const CONTAINED_NOTES = [
    { id: 'ex-0', t: 0.5, s: 0, f: 5, sus: 0 },
    { id: 'ex-1', t: 1.0, s: 1, f: 7, sus: 0 },
];

test('setContainedChart pushes the consumer notes + verify params, returns true', async () => {
    const env = containedSandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    assert.equal(det.isContainedVerifierAvailable(), true,
        'a desktop bridge with the chart-verifier API supports a contained verifier');

    const before = env.calls.setChart;
    const armed = await det.setContainedChart(CONTAINED_NOTES, { arrangement: 'guitar' });
    assert.equal(armed, true, 'arming on a capable bridge returns true');
    assert.equal(env.calls.setChart, before + 1, 'exactly one setChart for the contained chart');

    const pushed = env.setChartPayloads[env.setChartPayloads.length - 1];
    // NB: payloads are built inside the vm sandbox, so their arrays carry the
    // sandbox realm's Array.prototype — assert.deepEqual's strict prototype
    // check would fail on a structurally-equal array. Compare joined strings.
    assert.equal(pushed.notes.map(n => n.id).join(','), 'ex-0,ex-1',
        'the consumer-supplied note ids are pushed verbatim');
    // Guitar verify params (see _ndVerifyParamsFor): snr 3.0, fund 0.20,
    // presence 0.0, pitch 50 cents.
    assert.equal(pushed.harmonicSnr, 3.0);
    assert.equal(pushed.fundamentalRatio, 0.20);
    assert.equal(pushed.presenceRatio, 0.0);
    assert.equal(pushed.pitchCheckCents, 50);
    assert.equal(pushed.arrangement, 'guitar');

    det.destroy();
    await flushPendingAsync();
});

test('setContainedChart honours an openMidis bass ctx (arrangement/strings/params)', async () => {
    const env = containedSandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    // 5-string bass standard, low-B first. The ctx must drive arrangement=bass,
    // stringCount=5, and the bass verify params.
    const armed = await det.setContainedChart(
        [{ id: 'b-0', t: 0.25, s: 0, f: 0 }, { id: 'b-1', t: 0.5, s: 4, f: 3 }],
        { arrangement: 'bass', openMidis: [23, 28, 33, 38, 43] }
    );
    assert.equal(armed, true);

    const pushed = env.setChartPayloads[env.setChartPayloads.length - 1];
    assert.equal(pushed.arrangement, 'bass');
    assert.equal(pushed.stringCount, 5);
    assert.equal(pushed.harmonicSnr, 2.0, 'bass relaxes harmonicSnr');
    assert.equal(pushed.fundamentalRatio, 0.08, 'bass relaxes the fundamental gate');
    assert.equal(pushed.presenceRatio, 0.3, 'bass uses a temporal-persistence floor');
    assert.equal(pushed.pitchCheckCents, 60, 'bass uses a wider cents window');
    // openMidis are standard tuning → zero offsets, capo forced to 0.
    assert.equal(pushed.capo, 0);
    assert.equal(pushed.tuningOffsets.join(','), '0,0,0,0,0');

    det.destroy();
    await flushPendingAsync();
});

test('a host song event does NOT re-push the host chart while a contained chart is armed', async () => {
    const env = containedSandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    await det.setContainedChart(CONTAINED_NOTES, { arrangement: 'guitar' });
    const afterArm = env.calls.setChart;

    // A host song:loaded / song:ready firing mid-exercise must not clobber the
    // contained chart on the engine slot.
    env.fireSlopsmith('song:loaded', {});
    env.fireSlopsmith('song:ready', {});
    await flushPendingAsync();
    assert.equal(env.calls.setChart, afterArm,
        'no host chart re-push happens while the contained chart owns the slot');

    det.destroy();
    await flushPendingAsync();
});

test('pushContainedPlayhead forwards the consumer playhead verbatim; drain returns then clears', async () => {
    const env = containedSandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    await det.setContainedChart(CONTAINED_NOTES, { arrangement: 'guitar' });

    // Queue a verdict for ex-0 and push the consumer's own exercise clock.
    env.verdictQueue.push([
        { id: 'ex-0', detected: true, detectedSongTime: 0.5, centsError: 4, snr: 7 },
        { id: 'not-ours', detected: true, detectedSongTime: 9, centsError: 0, snr: 9 },
    ]);
    await det.pushContainedPlayhead(0.5, true);
    await flushPendingAsync();

    const last = env.getVerdictsArgs[env.getVerdictsArgs.length - 1];
    assert.equal(last[0], 0.5, 'the consumer playhead is pushed verbatim (no avOffset/latency math)');
    assert.equal(last[1], true, 'the playing flag is forwarded');

    const drained = det.drainContainedVerdicts();
    assert.equal(drained.length, 1, 'only verdicts for our chart ids are buffered');
    assert.equal(drained[0].id, 'ex-0');
    assert.equal(drained[0].detected, true);
    assert.equal(drained[0].centsError, 4);

    assert.equal(det.drainContainedVerdicts().length, 0, 'a second drain is empty (buffer cleared)');

    det.destroy();
    await flushPendingAsync();
});

test('releaseContainedChart restores host-song scoring (re-pushes the host chart)', async () => {
    const env = containedSandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    await det.setContainedChart(CONTAINED_NOTES, { arrangement: 'guitar' });
    const afterArm = env.calls.setChart;

    await det.releaseContainedChart();
    await flushPendingAsync();
    assert.equal(env.calls.setChart, afterArm + 1, 'releasing re-pushes the host chart');
    const restored = env.setChartPayloads[env.setChartPayloads.length - 1];
    assert.equal(restored.notes.length, 1, 'the restored push carries the single host note');
    assert.equal(restored.notes.map(n => `${n.s}:${n.f}`).join(','), `${HOST_NOTE.s}:${HOST_NOTE.f}`,
        'the restored push carries the host song chart, not the contained chart');

    det.destroy();
    await flushPendingAsync();
});

test('downlevel addon: setContainedChart returns null and the feature is unavailable', async () => {
    const env = containedSandbox({ withVerifierApi: false });
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    assert.equal(det.isContainedVerifierAvailable(), false,
        'no chart-verifier API → contained verifier unavailable');
    const armed = await det.setContainedChart(CONTAINED_NOTES, { arrangement: 'guitar' });
    assert.equal(armed, null, 'arming on a downlevel addon returns null so the consumer can fall back');

    det.destroy();
    await flushPendingAsync();
});

test('the engine chart slot is shared: a second instance cannot arm while another holds it', async () => {
    const env = containedSandbox();
    const a = env.createNoteDetector({ isDefault: false });
    const b = env.createNoteDetector({ isDefault: false });
    await a.enable();
    await b.enable();
    await flushPendingAsync();

    assert.equal(await a.setContainedChart(CONTAINED_NOTES, { arrangement: 'guitar' }), true,
        'the first instance arms successfully');
    assert.equal(await b.setContainedChart(CONTAINED_NOTES, { arrangement: 'guitar' }), false,
        'the second instance is refused while the first owns the slot');

    // After the first releases, the second can take the slot.
    await a.releaseContainedChart();
    assert.equal(await b.setContainedChart(CONTAINED_NOTES, { arrangement: 'guitar' }), true,
        'the slot is grantable again once released');

    a.destroy();
    b.destroy();
    await flushPendingAsync();
});

test('concurrent arm race: exactly one instance wins the single engine slot', async () => {
    const env = containedSandbox();
    const a = env.createNoteDetector({ isDefault: false });
    const b = env.createNoteDetector({ isDefault: false });
    await a.enable();
    await b.enable();
    await flushPendingAsync();

    // Both arm without awaiting between — the slot is claimed SYNCHRONOUSLY, so
    // the second to run its prefix sees the owner already set and is refused.
    const [ra, rb] = await Promise.all([
        a.setContainedChart(CONTAINED_NOTES, { arrangement: 'guitar' }),
        b.setContainedChart(CONTAINED_NOTES, { arrangement: 'guitar' }),
    ]);
    assert.equal([ra, rb].filter((x) => x === true).length, 1, 'exactly one instance arms');
    assert.equal([ra, rb].filter((x) => x === false).length, 1, 'the other is refused (no double ownership)');

    a.destroy();
    b.destroy();
    await flushPendingAsync();
});

test('notes that sanitize to zero entries return false without arming or suspending host', async () => {
    const env = containedSandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const before = env.calls.setChart;
    // No `id` on any note → every entry is dropped.
    const r = await det.setContainedChart([{ s: 0, f: 5 }, { s: 1, f: 7 }], { arrangement: 'guitar' });
    assert.equal(r, false, 'no well-formed notes → false, so the consumer falls back (not a phantom "armed")');
    assert.equal(env.calls.setChart, before, 'no contained chart was pushed to the engine');

    // The slot was never left half-claimed: a subsequent well-formed arm succeeds.
    assert.equal(await det.setContainedChart(CONTAINED_NOTES, { arrangement: 'guitar' }), true,
        'a subsequent well-formed arm still succeeds');

    det.destroy();
    await flushPendingAsync();
});

test('an empty/null chart reports NOT armed (false) and clears any active chart', async () => {
    const env = containedSandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    assert.equal(await det.setContainedChart([], { arrangement: 'guitar' }), false,
        'an empty array is not an arm → false (consumer falls back, not a phantom active state)');
    assert.equal(await det.setContainedChart(null), false, 'null is not an arm → false');

    // Arm for real, then clear with an empty array → false, and the slot frees.
    assert.equal(await det.setContainedChart(CONTAINED_NOTES, { arrangement: 'guitar' }), true);
    const afterArm = env.calls.setChart;
    assert.equal(await det.setContainedChart([], { arrangement: 'guitar' }), false,
        'clearing an active chart with [] reports not-armed');
    assert.ok(env.calls.setChart > afterArm, 'clearing restored host scoring (a host re-push happened)');

    det.destroy();
    await flushPendingAsync();
});

test('release during an in-flight arm does not resurrect contained mode', async () => {
    const env = containedSandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    // Start the arm (it claims the slot + suspends host synchronously, then
    // awaits setChart), then release before the setChart IPC resolves.
    const armP = det.setContainedChart(CONTAINED_NOTES, { arrangement: 'guitar' });
    const relP = det.releaseContainedChart();
    const [armed] = await Promise.all([armP, relP]);
    await flushPendingAsync();

    assert.equal(armed, false, 'the superseded arm does not report success');
    // Contained mode is not active — a push buffers nothing.
    await det.pushContainedPlayhead(0.5, true);
    await flushPendingAsync();
    assert.equal(det.drainContainedVerdicts().length, 0, 'no verdicts buffered after release-during-arm');

    det.destroy();
    await flushPendingAsync();
});

test('an empty-array clear CANCELS an in-flight arm (the slot is not left armed)', async () => {
    const env = containedSandbox();
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    // Arm (claims slot + suspends synchronously, awaits setChart), then clear
    // with [] before the IPC resolves — the in-flight arm must not win.
    const armP = det.setContainedChart(CONTAINED_NOTES, { arrangement: 'guitar' });
    const clrP = det.setContainedChart([]);
    const [armed, cleared] = await Promise.all([armP, clrP]);
    await flushPendingAsync();

    assert.equal(armed, false, 'the in-flight arm is cancelled (does not report armed)');
    assert.equal(cleared, false, 'the clear reports not-armed');
    // Nothing armed: a push buffers nothing, and a fresh instance can take the slot.
    await det.pushContainedPlayhead(0.5, true);
    await flushPendingAsync();
    assert.equal(det.drainContainedVerdicts().length, 0, 'no verdicts after a clear cancelled the arm');
    assert.equal(await det.setContainedChart(CONTAINED_NOTES, { arrangement: 'guitar' }), true,
        'the slot is free to arm again (it was not left half-claimed)');

    det.destroy();
    await flushPendingAsync();
});
