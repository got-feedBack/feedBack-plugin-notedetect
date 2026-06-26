// Position-aware score recompute on backward repositioning.
//
// Tester report (got-feedback): "When playing in a song, if you restart while
// in the song, the score tracker does not reset to 0 notes/%. It keeps whatever
// score it previously had." Clarified scope: ANY backward jump (Restart button
// or a scrub-back) should rebuild the live HUD score so it reflects only the
// notes up to the new playhead.
//
// Core emits `song:seek` { from, to, reason } from its single repositioning
// funnel (_audioSeek); Restart uses reason 'song-restart' to 0 (or loop A).
// notedetect listens and replays its judgment ledger up to the new position.
//
// Each test gets a fresh loader load so the slopsmith stub's listener registry
// and the factory's scoring state don't leak between cases.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

// Judgment shaped enough for recordJudgment's count branch + the ledger. The
// ledger reads `noteTime` (chart-note time) and `chord`; `hit` drives scoring.
function j(hit, t, extra = {}) {
    return { hit, note: { s: 1, f: 0 }, noteTime: t, judgedAt: t, ...extra };
}
// noteResults / ledger key convention: `${t.toFixed(3)}_<s>_<f>`.
function keyAt(t) {
    return `${t.toFixed(3)}_1_0`;
}

async function flushPendingAsync(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

// ── _recomputeScoreToPosition: the rebuild math ───────────────────────────

test('recompute drops judgments at/after the new position and rebuilds counters', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    // hits at t=1,2,3,4 ; miss at t=5
    det._recordJudgment(keyAt(1), j(true, 1));
    det._recordJudgment(keyAt(2), j(true, 2));
    det._recordJudgment(keyAt(3), j(true, 3));
    det._recordJudgment(keyAt(4), j(true, 4));
    det._recordJudgment(keyAt(5), j(false, 5));
    let s = det.getStats();
    assert.equal(s.hits, 4);
    assert.equal(s.misses, 1);

    // Seek back to t=3 → keep notes strictly before 3 (t=1, t=2).
    det._recomputeScoreToPosition(3);
    s = det.getStats();
    assert.equal(s.hits, 2, 'only the two hits before t=3 survive');
    assert.equal(s.misses, 0, 'the t=5 miss is rolled back');
    assert.equal(s.streak, 2);
    assert.equal(s.accuracy, 100);
    assert.equal(s.score, 2 * 50, 'two singles at ×1');
    det.destroy();
});

test('recompute to 0 (Restart from the top) wipes the score to 0 notes / 0%', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    for (let i = 1; i <= 6; i++) det._recordJudgment(keyAt(i), j(i % 2 === 0, i));
    assert.equal(det.getStats().hits + det.getStats().misses, 6);

    det._recomputeScoreToPosition(0);
    const s = det.getStats();
    assert.equal(s.hits, 0);
    assert.equal(s.misses, 0);
    assert.equal(s.score, 0);
    assert.equal(s.streak, 0);
    assert.equal(s.accuracy, 0);
    det.destroy();
});

test('recompute rebuilds streak / multiplier / maxMultiplier consistently', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    // 12 hits (t=1..12) then a miss at t=13.
    for (let i = 1; i <= 12; i++) det._recordJudgment(keyAt(i), j(true, i));
    det._recordJudgment(keyAt(13), j(false, 13));

    // Seek back to t=11 → keep t=1..10 → exactly 10 hits.
    det._recomputeScoreToPosition(11);
    const s = det.getStats();
    assert.equal(s.hits, 10);
    assert.equal(s.misses, 0);
    assert.equal(s.streak, 10);
    assert.equal(s.bestStreak, 10);
    assert.equal(s.multiplier, 2, '10th hit crosses into ×2');
    assert.equal(s.maxMultiplier, 2);
    // 9 hits at ×1 (450) + the 10th at ×2 (100) = 550.
    assert.equal(s.score, 9 * 50 + 100);
    det.destroy();
});

test('recompute re-opens the dropped notes for re-judgment (noteResults pruned)', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._recordJudgment(keyAt(2), j(true, 2));
    det._recordJudgment(keyAt(4), j(true, 4));
    det._recomputeScoreToPosition(3);
    // The t=4 note was dropped, so replaying forward can score it again.
    det._recordJudgment(keyAt(4), j(false, 4));
    const s = det.getStats();
    assert.equal(s.hits, 1, 'the surviving t=2 hit');
    assert.equal(s.misses, 1, 're-judged t=4 counted once, not doubled');
    det.destroy();
});

test('non-finite position is a no-op (defends a malformed seek payload)', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._recordJudgment(keyAt(1), j(true, 1));
    det._recomputeScoreToPosition(NaN);
    det._recomputeScoreToPosition(undefined);
    assert.equal(det.getStats().hits, 1);
    det.destroy();
});

// ── song:seek listener-count contract ─────────────────────────────────────

test('_bindSeekResetEvents binds song:seek exactly once; unbind removes it', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindSeekResetEvents();
    assert.equal(core.slopsmith._listenerCount('song:seek'), 1);
    // Idempotent — calling again must NOT double-bind.
    det._bindSeekResetEvents();
    assert.equal(core.slopsmith._listenerCount('song:seek'), 1);
    det._unbindSeekResetEvents();
    assert.equal(core.slopsmith._listenerCount('song:seek'), 0);
    det.destroy();
});

test('a disabled instance ignores song:seek (no HUD to rebuild)', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindSeekResetEvents();
    det._recordJudgment(keyAt(1), j(true, 1));
    det._recordJudgment(keyAt(2), j(true, 2));
    // enabled is false (never went through enable()), so the handler bails.
    core.slopsmith._fire('song:seek', { from: 5, to: 0, reason: 'song-restart' });
    assert.equal(det.getStats().hits, 2, 'disabled → score untouched');
    det.destroy();
});

// ── Enabled end-to-end: song:seek through enable() ────────────────────────

// Minimal desktop-bridge sandbox so enable() succeeds in the vm (no real
// getUserMedia / AudioContext). Modeled on contained-verifier.test.js.
function enabledSandbox() {
    const intervalCallbacks = [];
    const audio = {
        isAvailable: async () => true,
        isAudioRunning: async () => true,
        startAudio: async () => {},
        getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
        getSampleRate: async () => 48000,
        getPitchDetection: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
        getRawPitch: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
        setChart: async () => true,
        getNoteVerdicts: async () => [],
    };
    let slopsmithStub = null;
    const { createNoteDetector, slopsmith } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.navigator.mediaDevices.getUserMedia = () =>
                Promise.reject(new Error('bridge path: getUserMedia must not run'));
            sandbox.setInterval = (cb) => {
                if (typeof cb === 'function') intervalCallbacks.push(cb);
                return intervalCallbacks.length;
            };
            sandbox.dispatchEvent = () => true;
            sandbox.window.slopsmithDesktop = { isDesktop: true, platform: 'linux', audio };
            slopsmithStub = sandbox.slopsmith;
        },
    });
    return { createNoteDetector, slopsmith: slopsmith || slopsmithStub };
}

test('enabled instance: backward song:seek rebuilds the live score to the position', async () => {
    const env = enabledSandbox();
    const det = env.createNoteDetector();
    await det.enable();
    await flushPendingAsync();

    // enable() ran resetScoring(); record judgments AFTER it so they stick.
    for (let i = 1; i <= 5; i++) det._recordJudgment(keyAt(i), j(true, i));
    assert.equal(det.getStats().hits, 5);

    // Restart-button reposition: from t=5 back to t=2.
    env.slopsmith._fire('song:seek', { from: 5, to: 2, reason: 'song-restart' });
    assert.equal(det.getStats().hits, 1, 'only the t=1 hit survives a seek back to t=2');

    det.destroy();
    await flushPendingAsync();
});

test('enabled instance: a FORWARD song:seek leaves the score intact', async () => {
    const env = enabledSandbox();
    const det = env.createNoteDetector();
    await det.enable();
    await flushPendingAsync();

    for (let i = 1; i <= 3; i++) det._recordJudgment(keyAt(i), j(true, i));
    // Skip ahead — earlier judgments must remain.
    env.slopsmith._fire('song:seek', { from: 3, to: 30, reason: 'seek-by' });
    assert.equal(det.getStats().hits, 3, 'forward seek does not roll back earlier hits');

    det.destroy();
    await flushPendingAsync();
});
