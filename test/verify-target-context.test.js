// setVerifyTarget(notes, ctx) — caller-supplied tuning context.
//
// The timing-free verifier (#59) scores a registered note set against the live
// audio every frame and binds it to the *host song's* arrangement/tuning/capo.
// That is correct for a chart-coupled consumer (Step Mode) but wrong for a
// contained-playback consumer (SlopScale, Chord Sprint) that runs its own
// transport and computes targets from the player's REAL instrument tuning, not
// whatever song the host highway happens to have loaded.
//
// The optional `ctx` arg decouples the target from the host chart. These tests
// pin:
//   1. The ctx (arrangement / stringCount / per-string offsets / capo) is the
//      tuning actually handed to the scorer (scoreChord IPC), not the host's.
//   2. A ctx target SURVIVES a host song-switch (its fingerprint comes from the
//      override, so changing the loaded song doesn't drop it).
//   3. WITHOUT a ctx the legacy chart-coupled behavior is unchanged — a host
//      song-switch whose tuning differs drops the target (Step Mode semantics).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

async function flushPendingAsync(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

// Desktop-bridge sandbox with NO chart chords/notes, so the ONLY thing that
// can call scoreChord is _runVerifyTarget for a registered verify target.
// `songInfo` seeds the initial chart-state sync (and can be swapped before a
// song:loaded fire to simulate a host song-switch).
function verifyCtxSandbox() {
    const calls = { scoreChord: 0, getPitchDetection: 0, getUserMedia: 0 };
    const scoreChordRequests = [];
    const intervalCallbacks = [];
    let songInfo = {};   // guitar standard (empty → 6-string guitar default)

    const core = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.navigator.mediaDevices.getUserMedia = () => {
                calls.getUserMedia++;
                return Promise.reject(new Error('getUserMedia must not run on the bridge path'));
            };
            sandbox.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            sandbox.highway.getNotes = () => [];
            sandbox.highway.getChords = () => [];
            sandbox.highway.getSongInfo = () => songInfo;
            sandbox.window.slopsmithDesktop = {
                isDesktop: true,
                platform: 'linux',
                audio: {
                    isAvailable: async () => true,
                    isAudioRunning: async () => true,
                    startAudio: async () => {},
                    getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
                    getSampleRate: async () => 48000,
                    getPitchDetection: async () => {
                        calls.getPitchDetection++;
                        return { midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' };
                    },
                    scoreChord: async (ctx) => {
                        calls.scoreChord++;
                        scoreChordRequests.push(ctx);
                        return {
                            score: 0, hitStrings: 0, totalStrings: ctx.notes.length,
                            isHit: false,
                            results: ctx.notes.map(n => ({ s: n.s, f: n.f, hit: false })),
                        };
                    },
                },
            };
        },
    });

    return {
        core,
        calls,
        scoreChordRequests,
        intervalCallbacks,
        setSongInfo: (info) => { songInfo = info; },
    };
}

// Find the detect tick by behaviour (the interval that polls getPitchDetection),
// the same robust probe the desktop-bridge tests use.
async function findDetectTick(env) {
    for (const cb of env.intervalCallbacks) {
        const before = env.calls.getPitchDetection;
        // eslint-disable-next-line no-await-in-loop
        await cb();
        // eslint-disable-next-line no-await-in-loop
        await flushPendingAsync();
        if (env.calls.getPitchDetection > before) return cb;
    }
    return null;
}

test('setVerifyTarget ctx: scoreChord is called with the caller tuning, not the host song', async () => {
    const env = verifyCtxSandbox();
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const detectTick = await findDetectTick(env);
    assert.equal(typeof detectTick, 'function', 'a detect tick should be registered');
    assert.equal(env.calls.getUserMedia, 0, 'bridge path — no getUserMedia');

    // Player on a drop-tuned 5-string bass with capo 2 — nothing like the host
    // song (which synced to the 6-string guitar default).
    const ctx = { arrangement: 'bass', tuning: [-2, 0, 0, 0, 0], capo: 2, stringCount: 5 };
    det.setVerifyTarget([{ s: 1, f: 3 }], ctx);

    // Read-back getter reflects the sanitized override. Compare field-wise:
    // the returned object lives in the vm realm, so deepStrictEqual would
    // reject it on prototype identity (see _loader.js note).
    const readBack = det.getVerifyContext();
    assert.equal(readBack.arrangement, 'bass', 'getVerifyContext arrangement');
    assert.equal(readBack.stringCount, 5, 'getVerifyContext stringCount');
    assert.equal(readBack.capo, 2, 'getVerifyContext capo');
    assert.deepEqual([...readBack.offsets], [-2, 0, 0, 0, 0], 'getVerifyContext offsets');

    const before = env.scoreChordRequests.length;
    await detectTick();
    await flushPendingAsync();
    assert.ok(env.scoreChordRequests.length > before,
        'a registered verify target should drive a scoreChord call');

    const req = env.scoreChordRequests[env.scoreChordRequests.length - 1];
    assert.equal(req.arrangement, 'bass', 'scoreChord arrangement must come from the ctx');
    assert.equal(req.stringCount, 5, 'scoreChord stringCount must come from the ctx');
    assert.equal(req.capo, 2, 'scoreChord capo must come from the ctx');
    assert.deepEqual([...req.offsets], [-2, 0, 0, 0, 0], 'scoreChord offsets must come from the ctx');
    assert.ok(req.harmonicVerify === true && req.bypassMl === true,
        'still the harmonic-comb DSP verify path');

    det.destroy();
    await flushPendingAsync();
});

test('setVerifyTarget ctx: the target survives a host song-switch', async () => {
    const env = verifyCtxSandbox();
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const detectTick = await findDetectTick(env);
    assert.equal(typeof detectTick, 'function');

    det.setVerifyTarget([{ s: 1, f: 3 }], { arrangement: 'bass', tuning: [0, 0, 0, 0, 0], capo: 0, stringCount: 5 });
    assert.notEqual(det.getVerifyTarget(), null, 'target set');

    // Host loads a completely different (guitar) song mid-session.
    env.setSongInfo({ arrangement: 'Lead', tuning: [0, 0, 0, 0, 0, 0], capo: 0 });
    env.core.slopsmith._fire('song:loaded', { filename: 'some-guitar-song.psarc' });
    await flushPendingAsync();

    const before = env.scoreChordRequests.length;
    await detectTick();
    await flushPendingAsync();

    assert.notEqual(det.getVerifyTarget(), null,
        'a ctx-bound target must NOT be dropped when the host song changes');
    assert.ok(env.scoreChordRequests.length > before, 'and it keeps scoring');
    const req = env.scoreChordRequests[env.scoreChordRequests.length - 1];
    assert.equal(req.arrangement, 'bass', 'still scored against the ctx tuning, not the new host song');
    assert.equal(req.stringCount, 5);

    det.destroy();
    await flushPendingAsync();
});

test('setVerifyTarget ctx: openMidis are converted to standard-tuning offsets', async () => {
    const env = verifyCtxSandbox();
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    const detectTick = await findDetectTick(env);
    assert.equal(typeof detectTick, 'function');

    // Eb-standard 6-string guitar as ABSOLUTE open MIDI (standard minus 1).
    // Standard base is [40,45,50,55,59,64] → every offset should be -1.
    det.setVerifyTarget([{ s: 0, f: 5 }],
        { arrangement: 'guitar', openMidis: [39, 44, 49, 54, 58, 63] });

    const rb = det.getVerifyContext();
    assert.equal(rb.stringCount, 6, 'stringCount inferred from openMidis length');
    assert.deepEqual([...rb.offsets], [-1, -1, -1, -1, -1, -1],
        'openMidis converted to per-string offsets from standard tuning');

    await detectTick();
    await flushPendingAsync();
    const req = env.scoreChordRequests[env.scoreChordRequests.length - 1];
    assert.deepEqual([...req.offsets], [-1, -1, -1, -1, -1, -1],
        'scoreChord receives the converted offsets');

    det.destroy();
    await flushPendingAsync();
});

test('setVerifyTarget ctx: arrangement is inferred from openMidis when omitted', async () => {
    // Regression guard (Codex): 5-string bass openMidis must NOT be scored as a
    // guitar just because arrangement defaulted to guitar.
    const env = verifyCtxSandbox();
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    await findDetectTick(env);

    // 5-string bass standard, no arrangement given. Closest standard base is
    // BASS_5 → offsets all 0, arrangement 'bass'.
    det.setVerifyTarget([{ s: 1, f: 3 }], { openMidis: [23, 28, 33, 38, 43] });
    const rb = det.getVerifyContext();
    assert.equal(rb.arrangement, 'bass', 'low 5-string openMidis infer bass, not guitar');
    assert.equal(rb.stringCount, 5);
    assert.deepEqual([...rb.offsets], [0, 0, 0, 0, 0],
        'bass-5 openMidis map to zero offsets (not the -17 a guitar base would give)');

    det.destroy();
    await flushPendingAsync();
});

test('setVerifyTarget ctx: openMidis path ignores capo (no double transpose)', async () => {
    // Regression guard (Codex): openMidis already encode the real (capoed) open
    // pitches, so ctx.capo must not be applied a second time downstream.
    const env = verifyCtxSandbox();
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    await findDetectTick(env);

    det.setVerifyTarget([{ s: 0, f: 0 }],
        { arrangement: 'guitar', openMidis: [42, 47, 52, 57, 61, 66], capo: 2 });
    const rb = det.getVerifyContext();
    // openMidis are standard + 2; offsets capture the +2, capo forced to 0.
    assert.deepEqual([...rb.offsets], [2, 2, 2, 2, 2, 2], 'tuning captured in offsets');
    assert.equal(rb.capo, 0, 'capo forced to 0 on the openMidis path (no double transpose)');

    det.destroy();
    await flushPendingAsync();
});

test('setVerifyTarget ctx: stringCount is clamped to the arrangement table range', async () => {
    // Regression guard (Codex): an unsupported (arrangement, stringCount) pair
    // must not leave higher strings on an undefined base (NaN, never verifies).
    const env = verifyCtxSandbox();
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    await findDetectTick(env);

    // 6-string bass is out of table scope → clamp to the supported bass-5.
    det.setVerifyTarget([{ s: 1, f: 3 }],
        { arrangement: 'bass', openMidis: [23, 28, 33, 38, 43, 47] });
    const rb = det.getVerifyContext();
    assert.equal(rb.arrangement, 'bass');
    assert.equal(rb.stringCount, 5, 'bass clamped to 5 strings (table max)');
    assert.equal(rb.offsets.length, 5, 'offsets never exceed the standard-base length');
    assert.ok(rb.offsets.every(Number.isFinite), 'no NaN offset from an out-of-range string');

    det.destroy();
    await flushPendingAsync();
});

test('setVerifyTarget ctx: target notes beyond the clamped string count are dropped', async () => {
    // Regression guard (Codex): a {s:5} note must not survive against a ctx
    // clamped to 5 strings (indices 0-4) and map to a NaN pitch.
    const env = verifyCtxSandbox();
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    await findDetectTick(env);

    det.setVerifyTarget([{ s: 1, f: 3 }, { s: 5, f: 0 }],
        { arrangement: 'bass', openMidis: [23, 28, 33, 38, 43, 47] });
    const tgt = det.getVerifyTarget();
    assert.equal(tgt.length, 1, 'the out-of-range s=5 note is dropped');
    assert.equal(tgt[0].s, 1, 'the in-range note is kept');

    // And a target made up ENTIRELY of out-of-range notes clears to null.
    det.setVerifyTarget([{ s: 7, f: 0 }],
        { arrangement: 'bass', openMidis: [23, 28, 33, 38, 43] });
    assert.equal(det.getVerifyTarget(), null, 'all-out-of-range target clears to null');
    assert.equal(det.getVerifyContext(), null, 'and its context clears too');

    det.destroy();
    await flushPendingAsync();
});

test('setVerifyTarget ctx: getVerifyContext() output round-trips back in', async () => {
    // Regression guard (Codex): getVerifyContext returns {offsets}, so the
    // sanitizer must read `offsets`, else re-registering with the getter's
    // output silently drops the retune.
    const env = verifyCtxSandbox();
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    await findDetectTick(env);

    det.setVerifyTarget([{ s: 1, f: 3 }],
        { arrangement: 'bass', tuning: [-2, 0, 0, 0, 0], capo: 2, stringCount: 5 });
    const ctx1 = det.getVerifyContext();

    // Feed the getter's output straight back — the canonical round-trip.
    det.setVerifyTarget(det.getVerifyTarget(), ctx1);
    const ctx2 = det.getVerifyContext();

    assert.equal(ctx2.arrangement, 'bass');
    assert.equal(ctx2.stringCount, 5);
    assert.equal(ctx2.capo, 2);
    assert.deepEqual([...ctx2.offsets], [-2, 0, 0, 0, 0],
        'offsets must survive a getVerifyContext → setVerifyTarget round-trip');

    det.destroy();
    await flushPendingAsync();
});

test('setVerifyTarget ctx: a non-finite tuning entry maps to 0 in place (no reindex)', async () => {
    // Regression guard (Codex): a filter() would shift later strings onto
    // earlier indices. Position must be preserved: only the bad string zeroes.
    const env = verifyCtxSandbox();
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    await findDetectTick(env);

    det.setVerifyTarget([{ s: 0, f: 0 }],
        { arrangement: 'guitar', tuning: [0, NaN, -2, 0, 0, 0], stringCount: 6 });
    const rb = det.getVerifyContext();
    assert.deepEqual([...rb.offsets], [0, 0, -2, 0, 0, 0],
        'bad entry zeroes in place; the -2 stays on string 2, not shifted to string 1');

    det.destroy();
    await flushPendingAsync();
});

test('setVerifyTarget transition: ctx1 -> ctx2 re-scores against the new ctx', async () => {
    const env = verifyCtxSandbox();
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    const detectTick = await findDetectTick(env);

    det.setVerifyTarget([{ s: 1, f: 3 }], { arrangement: 'bass', tuning: [0, 0, 0, 0], stringCount: 4 });
    assert.notEqual(det.getVerifyTarget(), null, 'target set with ctx1');

    det.setVerifyTarget([{ s: 2, f: 5 }], { arrangement: 'bass', tuning: [-2, -2, -2, -2], stringCount: 4 });
    assert.deepEqual([...det.getVerifyContext().offsets], [-2, -2, -2, -2], 'new ctx applied');

    await detectTick();
    await flushPendingAsync();
    const req = env.scoreChordRequests[env.scoreChordRequests.length - 1];
    assert.deepEqual([...req.offsets], [-2, -2, -2, -2], 'scoreChord uses ctx2, not ctx1');

    det.destroy();
    await flushPendingAsync();
});

test('setVerifyTarget transition: ctx -> no-ctx clears the override (back to chart-coupled)', async () => {
    const env = verifyCtxSandbox();
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    await findDetectTick(env);

    det.setVerifyTarget([{ s: 1, f: 3 }], { arrangement: 'bass', tuning: [-2, 0, 0, 0], stringCount: 4 });
    assert.notEqual(det.getVerifyContext(), null, 'ctx override active');

    det.setVerifyTarget([{ s: 0, f: 5 }]);   // no ctx → host-coupled
    assert.equal(det.getVerifyContext(), null, 'override cleared');
    assert.notEqual(det.getVerifyTarget(), null, 'the new (host-coupled) target is set');

    det.destroy();
    await flushPendingAsync();
});

test('setVerifyTarget transition: no-ctx -> ctx adopts the override', async () => {
    const env = verifyCtxSandbox();
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();
    const detectTick = await findDetectTick(env);

    det.setVerifyTarget([{ s: 0, f: 5 }]);   // host-coupled first
    assert.equal(det.getVerifyContext(), null, 'starts host-coupled');

    det.setVerifyTarget([{ s: 1, f: 3 }], { arrangement: 'bass', openMidis: [23, 28, 33, 38, 43] });
    const rb = det.getVerifyContext();
    assert.equal(rb.arrangement, 'bass', 'override adopted');
    assert.equal(rb.stringCount, 5);

    await detectTick();
    await flushPendingAsync();
    const req = env.scoreChordRequests[env.scoreChordRequests.length - 1];
    assert.equal(req.arrangement, 'bass', 'scoreChord now uses the override');
    assert.equal(req.stringCount, 5);

    det.destroy();
    await flushPendingAsync();
});

test('setVerifyTarget without ctx: legacy chart-coupling is preserved (dropped on song-switch)', async () => {
    const env = verifyCtxSandbox();
    const det = env.core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const detectTick = await findDetectTick(env);
    assert.equal(typeof detectTick, 'function');

    // No ctx → bound to the host chart (guitar default), Step Mode behavior.
    det.setVerifyTarget([{ s: 0, f: 3 }]);
    assert.equal(det.getVerifyContext(), null, 'no override context when ctx omitted');
    assert.notEqual(det.getVerifyTarget(), null, 'target set');

    // Host switches to a bass song whose tuning differs from the bound sig.
    env.setSongInfo({ arrangement: 'Bass', tuning: [0, 0, 0, 0], capo: 0 });
    env.core.slopsmith._fire('song:loaded', { filename: 'some-bass-song.psarc' });
    await flushPendingAsync();

    await detectTick();
    await flushPendingAsync();

    assert.equal(det.getVerifyTarget(), null,
        'a non-ctx target must be dropped when the host chart tuning changes (no stale verify)');

    det.destroy();
    await flushPendingAsync();
});
