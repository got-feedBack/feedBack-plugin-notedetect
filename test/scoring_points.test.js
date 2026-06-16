// Game-scoring layer tests — points / multiplier / grade engine plus the
// notedetect:fx emissions and the minigames XP submission. Drives the
// closure-internal scoring path via the same _recordJudgment test hook the
// drill tests use; no audio pipeline involved.
//
// Each test gets a fresh loader load so factory scoring state and the
// slopsmith stub's listener/emit capture don't leak between cases.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

// Judgment shaped enough for recordJudgment's branches. The scoring layer
// inspects `hit` and `chord`; everything else is incidental.
function judgment(hit, extra = {}) {
    return { hit, note: { s: 1, f: 0 }, noteTime: 0, judgedAt: 0, ...extra };
}

// ── Pure helpers ────────────────────────────────────────────────────────

test('_ndMultiplierForStreak tiers: ×1/×2/×3/×4 at 0/10/25/50', () => {
    const core = loadDetectionCore();
    assert.equal(core.multiplierForStreak(0), 1);
    assert.equal(core.multiplierForStreak(9), 1);
    assert.equal(core.multiplierForStreak(10), 2);
    assert.equal(core.multiplierForStreak(24), 2);
    assert.equal(core.multiplierForStreak(25), 3);
    assert.equal(core.multiplierForStreak(49), 3);
    assert.equal(core.multiplierForStreak(50), 4);
    assert.equal(core.multiplierForStreak(500), 4);
});

test('_ndIsStreakMilestone: 25, 50, then every full hundred', () => {
    const core = loadDetectionCore();
    const yes = [25, 50, 100, 200, 300];
    const no = [0, 1, 10, 24, 26, 49, 51, 75, 99, 101, 150, 250];
    for (const s of yes) assert.equal(core.isStreakMilestone(s), true, `streak ${s}`);
    for (const s of no) assert.equal(core.isStreakMilestone(s), false, `streak ${s}`);
});

test('_ndGradeFor boundaries: S≥96, A≥90, B≥80, C≥70, D≥60, else F', () => {
    const core = loadDetectionCore();
    assert.equal(core.gradeFor(100), 'S');
    assert.equal(core.gradeFor(96), 'S');
    assert.equal(core.gradeFor(95), 'A');
    assert.equal(core.gradeFor(90), 'A');
    assert.equal(core.gradeFor(89), 'B');
    assert.equal(core.gradeFor(80), 'B');
    assert.equal(core.gradeFor(79), 'C');
    assert.equal(core.gradeFor(70), 'C');
    assert.equal(core.gradeFor(69), 'D');
    assert.equal(core.gradeFor(60), 'D');
    assert.equal(core.gradeFor(59), 'F');
    assert.equal(core.gradeFor(0), 'F');
});

// ── Score accumulation through recordJudgment ───────────────────────────

test('singles accrue base 50 × multiplier; tier boundary lands ON the 10th hit', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    // 9 hits at ×1 = 450; the 10th hit raises streak to 10 first, so it
    // scores at ×2 (= 100) — total 550.
    for (let i = 0; i < 10; i++) det._recordJudgment(`k${i}`, judgment(true));
    const s = det.getStats();
    assert.equal(s.hits, 10);
    assert.equal(s.streak, 10);
    assert.equal(s.multiplier, 2);
    assert.equal(s.maxMultiplier, 2);
    assert.equal(s.score, 9 * 50 + 100);
    det.destroy();
});

test('chord judgments accrue base 100', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._recordJudgment('c0', judgment(true, { chord: true }));
    det._recordJudgment('k0', judgment(true));
    const s = det.getStats();
    assert.equal(s.score, 100 + 50);
    det.destroy();
});

test('a miss resets streak and multiplier but keeps score and maxMultiplier', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    for (let i = 0; i < 10; i++) det._recordJudgment(`k${i}`, judgment(true));
    const before = det.getStats().score;
    det._recordJudgment('m0', judgment(false));
    const s = det.getStats();
    assert.equal(s.streak, 0);
    assert.equal(s.multiplier, 1);
    assert.equal(s.maxMultiplier, 2, 'high-water mark survives the break');
    assert.equal(s.score, before, 'misses never subtract points');
    // Next hit scores back at ×1.
    det._recordJudgment('k10', judgment(true));
    assert.equal(det.getStats().score, before + 50);
    det.destroy();
});

test('recordJudgment stamps _ndPoints/_ndMult on the judgment for noteStateFor', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    const j = judgment(true, { chord: true });
    det._recordJudgment('c0', j);
    assert.equal(j._ndPoints, 100);
    assert.equal(j._ndMult, 1);
    det.destroy();
});

test('count:false judgments do not touch score or multiplier', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._recordJudgment('k0', judgment(true), { count: false });
    const s = det.getStats();
    assert.equal(s.score, 0);
    assert.equal(s.hits, 0);
    det.destroy();
});

test('getStats reports accuracy-derived grade', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    for (let i = 0; i < 9; i++) det._recordJudgment(`k${i}`, judgment(true));
    det._recordJudgment('m0', judgment(false));
    assert.equal(det.getStats().accuracy, 90);
    assert.equal(det.getStats().grade, 'A');
    det.destroy();
});

test('_resetScoring zeroes score and multiplier state', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    for (let i = 0; i < 30; i++) det._recordJudgment(`k${i}`, judgment(true));
    assert.ok(det.getStats().score > 0);
    det._resetScoring();
    const s = det.getStats();
    assert.equal(s.score, 0);
    assert.equal(s.multiplier, 1);
    assert.equal(s.maxMultiplier, 1);
    det.destroy();
});

// ── notedetect:fx emissions ─────────────────────────────────────────────

// Capture bus emissions by giving the slopsmith stub an emit() — dispatchFx
// looks it up at call time, so attaching after load works.
function captureFx(core) {
    const fired = [];
    core.slopsmith.emit = (event, detail) => {
        if (event === 'notedetect:fx') fired.push(detail);
    };
    return fired;
}

test('multiplier fx fires exactly on tier boundaries with prev/new tiers', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    const fx = captureFx(core);
    for (let i = 0; i < 25; i++) det._recordJudgment(`k${i}`, judgment(true));
    const mults = fx.filter(e => e.fxType === 'multiplier');
    assert.equal(mults.length, 2, 'one event per tier change (×2 at 10, ×3 at 25)');
    assert.deepEqual(
        mults.map(e => ({ mult: e.mult, prevMult: e.prevMult, streak: e.streak })),
        [{ mult: 2, prevMult: 1, streak: 10 }, { mult: 3, prevMult: 2, streak: 25 }]
    );
    det.destroy();
});

test('milestone fx fires at 25/50/100; streakBreak only after a ≥10 streak', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    const fx = captureFx(core);
    // Short streak break — no streakBreak event.
    for (let i = 0; i < 5; i++) det._recordJudgment(`s${i}`, judgment(true));
    det._recordJudgment('sm', judgment(false));
    assert.equal(fx.filter(e => e.fxType === 'streakBreak').length, 0);
    // Long streak then a break.
    for (let i = 0; i < 50; i++) det._recordJudgment(`k${i}`, judgment(true));
    const milestones = fx.filter(e => e.fxType === 'milestone');
    assert.deepEqual(milestones.map(e => e.streak), [25, 50]);
    det._recordJudgment('m0', judgment(false));
    const breaks = fx.filter(e => e.fxType === 'streakBreak');
    assert.equal(breaks.length, 1);
    assert.equal(breaks[0].lostStreak, 50);
    assert.equal(breaks[0].prevMult, 4);
    det.destroy();
});

test('fx events carry isDefault and a timestamp', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    const fx = captureFx(core);
    for (let i = 0; i < 10; i++) det._recordJudgment(`k${i}`, judgment(true));
    assert.equal(fx.length, 1);
    assert.equal(typeof fx[0].isDefault, 'boolean');
    assert.ok(Number.isFinite(fx[0].ts));
    det.destroy();
});

// ── XP submission ───────────────────────────────────────────────────────

test('_submitSongXp posts score + meta to the minigames SDK', async () => {
    let captured = null;
    const core = loadDetectionCore({
        sandboxBeforeRun: (sandbox) => {
            sandbox.slopsmithMinigames = {
                submitRun: async (payload) => {
                    captured = payload;
                    return { ok: true, xp_gained: 123, profile: { level: 2 } };
                },
            };
        },
    });
    const det = core.createNoteDetector();
    for (let i = 0; i < 9; i++) det._recordJudgment(`k${i}`, judgment(true));
    det._recordJudgment('m0', judgment(false));
    await det._submitSongXp();
    assert.ok(captured, 'submitRun was called');
    assert.equal(captured.game_id, 'song_play');
    assert.equal(captured.score, 9 * 50);
    assert.equal(captured.meta.accuracy, 90);
    assert.equal(captured.meta.grade, 'A');
    assert.equal(captured.meta.hits, 9);
    assert.equal(captured.meta.misses, 1);
    assert.equal(captured.meta.fullCombo, false);
    assert.equal(typeof captured.duration_ms, 'number');
});

test('_submitSongXp is a silent no-op without the minigames SDK', async () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._recordJudgment('k0', judgment(true));
    await assert.doesNotReject(() => det._submitSongXp());
    det.destroy();
});

test('_submitSongXp swallows a rejecting submitRun', async () => {
    const core = loadDetectionCore({
        sandboxBeforeRun: (sandbox) => {
            sandbox.slopsmithMinigames = {
                submitRun: async () => { throw new Error('backend down'); },
            };
        },
    });
    const det = core.createNoteDetector();
    det._recordJudgment('k0', judgment(true));
    await assert.doesNotReject(() => det._submitSongXp());
    det.destroy();
});

test('_submitSongXp is once-per-take idempotent at the function level', async () => {
    let calls = 0;
    const core = loadDetectionCore({
        sandboxBeforeRun: (sandbox) => {
            sandbox.slopsmithMinigames = {
                submitRun: async () => { calls++; return { ok: true, xp_gained: 1, profile: { level: 1 } }; },
            };
        },
    });
    const det = core.createNoteDetector();
    det._recordJudgment('k0', judgment(true));
    await det._submitSongXp();
    await det._submitSongXp();
    assert.equal(calls, 1, 'second call within the same take is a no-op');
    // A new take (resetScoring) re-arms the guard.
    det._resetScoring();
    det._recordJudgment('k1', judgment(true));
    await det._submitSongXp();
    assert.equal(calls, 2);
    det.destroy();
});

test('an ambiguous submitRun failure HOLDS the claim (no double-credit retry)', async () => {
    // A rejection can land after the backend already persisted the award,
    // so a same-take retry could double-credit the profile — the claim
    // stays held on the caught-error path.
    let calls = 0;
    const core = loadDetectionCore({
        sandboxBeforeRun: (sandbox) => {
            sandbox.slopsmithMinigames = {
                submitRun: async () => { calls++; throw new Error('timeout — outcome unknown'); },
            };
        },
    });
    const det = core.createNoteDetector();
    det._recordJudgment('k0', judgment(true));
    await det._submitSongXp();   // rejects ambiguously → claim held
    await det._submitSongXp();   // must NOT re-attempt
    assert.equal(calls, 1);
    det.destroy();
});

test('the deterministic no-SDK path releases the claim', async () => {
    // SDK absent = provably nothing submitted — a later call within the
    // same take (e.g. the SDK finished loading) may still award it.
    let calls = 0;
    let sb = null;
    const core = loadDetectionCore({
        sandboxBeforeRun: (sandbox) => { sb = sandbox; },
    });
    const det = core.createNoteDetector();
    det._recordJudgment('k0', judgment(true));
    await det._submitSongXp();   // no SDK → claim released
    sb.slopsmithMinigames = {
        submitRun: async () => { calls++; return { ok: true, xp_gained: 1, profile: { level: 1 } }; },
    };
    await det._submitSongXp();   // released claim → this one submits
    await det._submitSongXp();   // success → now held
    assert.equal(calls, 1);
    det.destroy();
});
