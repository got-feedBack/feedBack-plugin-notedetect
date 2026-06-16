// Drill-mode tests — exercise the slopsmith loop:restart wiring in
// notedetect against a stub slopsmith bus. Uses the existing vm
// loader; doesn't touch the audio pipeline (factory.test.js already
// covers the audio-less API shape).
//
// Each test gets a fresh loader load so the slopsmith listener
// registry, factory state, and drill iteration array don't leak
// between cases.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

// Convenience: build a judgment object shaped enough to pass
// recordJudgment's branches. The drill counters only inspect
// `judgment.hit`; everything else is incidental.
function judgment(hit) {
    return { hit, note: { s: 1, f: 0 }, noteTime: 0, judgedAt: 0 };
}

test('_bindDrillEvents() binds loop:restart, song:loaded, song:ended exactly once', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    // Bind directly via the test hook; enable() requires the audio
    // pipeline (unavailable in vm) but the bind itself is pure.
    det._bindDrillEvents();
    assert.equal(core.slopsmith._listenerCount('loop:restart'), 1);
    assert.equal(core.slopsmith._listenerCount('song:loaded'), 1);
    assert.equal(core.slopsmith._listenerCount('song:ended'), 1);
    // Idempotent — calling again must NOT double-bind.
    det._bindDrillEvents();
    assert.equal(core.slopsmith._listenerCount('loop:restart'), 1);
    det.destroy();
});

test('loop:restart snapshots the just-finished iteration into drillIterations', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    // Activate drill via getLoop() returning real bounds, then sync.
    core.slopsmith._loop = { loopA: 10, loopB: 20 };
    det._drillSyncFromLoopState();

    // 8 hits + 2 misses for iteration 1.
    for (let i = 0; i < 8; i++) det._recordJudgment(`k${i}`, judgment(true));
    for (let i = 0; i < 2; i++) det._recordJudgment(`m${i}`, judgment(false));

    // Wrap to start iteration 2.
    core.slopsmith._fire('loop:restart', { loopA: 10, loopB: 20, time: 10 });

    const stats = det.getDrillStats();
    assert.equal(stats.iterations.length, 1);
    assert.equal(stats.iterations[0].hits, 8);
    assert.equal(stats.iterations[0].misses, 2);
    assert.equal(stats.iterations[0].accuracy, 80);
    // durationSec is derived from the cached bounds (loopB - loopA),
    // not from the event payload — the event's `time` is loopA (the
    // new iteration's start), so using it would always give 0.
    assert.equal(stats.iterations[0].durationSec, 10, 'durationSec = loopB - loopA');
    // Live counters reset for the new iteration.
    assert.equal(stats.current.hits, 0);
    assert.equal(stats.current.misses, 0);
    det.destroy();
});

test('loop:restart with zero judgments does not push an empty entry', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    core.slopsmith._loop = { loopA: 5, loopB: 15 };
    det._drillSyncFromLoopState();

    // Wrap immediately without any judgments — idle iteration.
    core.slopsmith._fire('loop:restart', { loopA: 5, loopB: 15, time: 5 });
    core.slopsmith._fire('loop:restart', { loopA: 5, loopB: 15, time: 5 });

    const stats = det.getDrillStats();
    assert.equal(stats.iterations.length, 0, 'empty iterations must not be pushed');
    det.destroy();
});

test('drill counters are gated on slopsmith.getLoop() — no loop = no per-iter mutation', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    // No active loop.
    core.slopsmith._loop = { loopA: null, loopB: null };
    det._drillSyncFromLoopState();
    assert.equal(det.getDrillStats().active, false);

    det._recordJudgment('a', judgment(true));
    det._recordJudgment('b', judgment(false));

    // Session counters advance, but drill counters do NOT.
    assert.equal(det.getStats().hits, 1);
    assert.equal(det.getStats().misses, 1);
    assert.equal(det.getDrillStats().current.hits, 0);
    assert.equal(det.getDrillStats().current.misses, 0);
    det.destroy();
});

test('song:loaded clears the iteration history (new song = new passage)', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    core.slopsmith._loop = { loopA: 10, loopB: 20 };
    det._drillSyncFromLoopState();

    // Build up two iterations.
    for (let i = 0; i < 5; i++) det._recordJudgment(`a${i}`, judgment(true));
    core.slopsmith._fire('loop:restart', { loopA: 10, loopB: 20, time: 10 });
    for (let i = 0; i < 3; i++) det._recordJudgment(`b${i}`, judgment(false));
    core.slopsmith._fire('loop:restart', { loopA: 10, loopB: 20, time: 10 });

    assert.equal(det.getDrillStats().iterations.length, 2);
    assert.equal(det.getDrillStats().active, true);

    // New song fires song:loaded. Slopsmith clears the loop bounds
    // as part of song teardown (the loop is per-song); we model that
    // here so getDrillStats()'s inline sync sees the actual host
    // state rather than re-activating from stale bounds.
    core.slopsmith._loop = { loopA: null, loopB: null };
    core.slopsmith._fire('song:loaded', { filename: 'next-song.psarc' });
    assert.equal(det.getDrillStats().iterations.length, 0, 'song change must clear drill history');
    assert.equal(det.getDrillStats().active, false, 'active flag must clear on song change');
    det.destroy();
});

test('destroy() unbinds slopsmith listeners — later loop:restart is a no-op', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    core.slopsmith._loop = { loopA: 10, loopB: 20 };
    det._drillSyncFromLoopState();
    for (let i = 0; i < 3; i++) det._recordJudgment(`a${i}`, judgment(true));

    det.destroy();
    assert.equal(core.slopsmith._listenerCount('loop:restart'), 0);
    assert.equal(core.slopsmith._listenerCount('song:loaded'), 0);
    assert.equal(core.slopsmith._listenerCount('song:ended'), 0);

    // Firing after destroy must not throw and must not affect anything.
    assert.doesNotThrow(() => {
        core.slopsmith._fire('loop:restart', { loopA: 10, loopB: 20, time: 10 });
    });
});

test('clearing then re-setting the SAME loop preserves iteration history', () => {
    // Re-opening the exact same loop bounds (same A and same B) is
    // logically the same passage — history should remain comparable
    // and iteration numbering should continue.
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    core.slopsmith._loop = { loopA: 10, loopB: 20 };
    det._drillSyncFromLoopState();
    for (let i = 0; i < 5; i++) det._recordJudgment(`a${i}`, judgment(true));
    core.slopsmith._fire('loop:restart', { loopA: 10, loopB: 20, time: 10 });
    assert.equal(det.getDrillStats().iterations.length, 1);

    // Clear the loop, then re-set to the SAME bounds.
    core.slopsmith._loop = { loopA: null, loopB: null };
    det._drillSyncFromLoopState();
    core.slopsmith._loop = { loopA: 10, loopB: 20 };
    det._drillSyncFromLoopState();

    // History preserved (same passage); idx continues monotonically.
    assert.equal(det.getDrillStats().iterations.length, 1, 'same-bounds re-activation must keep history');
    for (let i = 0; i < 3; i++) det._recordJudgment(`b${i}`, judgment(true));
    core.slopsmith._fire('loop:restart', { loopA: 10, loopB: 20, time: 10 });
    const stats = det.getDrillStats();
    assert.equal(stats.iterations.length, 2);
    assert.equal(stats.iterations[1].idx, 2, 'idx continues past clear+resame');
    det.destroy();
});

test('clearing then re-setting a DIFFERENT loop clears history', () => {
    // Re-opening with different bounds is a new passage — old
    // iterations don't compare.
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    core.slopsmith._loop = { loopA: 10, loopB: 20 };
    det._drillSyncFromLoopState();
    for (let i = 0; i < 5; i++) det._recordJudgment(`a${i}`, judgment(true));
    core.slopsmith._fire('loop:restart', { loopA: 10, loopB: 20, time: 10 });
    assert.equal(det.getDrillStats().iterations.length, 1);

    // Clear, then set DIFFERENT bounds.
    core.slopsmith._loop = { loopA: null, loopB: null };
    det._drillSyncFromLoopState();
    core.slopsmith._loop = { loopA: 30, loopB: 50 };
    det._drillSyncFromLoopState();

    assert.equal(det.getDrillStats().iterations.length, 0, 'different-bounds re-activation must clear history');
    det.destroy();
});

test('iteration idx stays monotonic past the 50-iter truncation cap', () => {
    // Regression: idx used to be drillIterations.length + 1, which
    // collapsed to a constant once the array hit DRILL_MAX_ITERATIONS
    // and started splicing from the front. Ensure successive idx
    // values keep rising even after truncation kicks in.
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    core.slopsmith._loop = { loopA: 0, loopB: 1 };
    det._drillSyncFromLoopState();

    // Push 60 iterations (cap is 50). Each iteration: 1 hit, then wrap.
    for (let i = 0; i < 60; i++) {
        det._recordJudgment(`k${i}`, judgment(true));
        core.slopsmith._fire('loop:restart', { loopA: 0, loopB: 1, time: 0 });
    }
    const stats = det.getDrillStats();
    assert.equal(stats.iterations.length, 50, 'history must cap at DRILL_MAX_ITERATIONS');
    // First retained iteration is the 11th pushed (oldest 10 truncated).
    assert.equal(stats.iterations[0].idx, 11, 'oldest retained idx after truncation');
    // Last retained iteration is the 60th pushed.
    assert.equal(stats.iterations[stats.iterations.length - 1].idx, 60, 'newest idx must reflect monotonic counter');
    det.destroy();
});

test('malformed slopsmith.getLoop() shape does NOT activate drill', () => {
    // Defensive: if slopsmith.getLoop returns a malformed shape
    // (empty object, undefined fields, truthy non-object, or
    // non-numeric values), drill must stay inactive — otherwise
    // per-iter counters would mutate against bogus bounds.
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    core.slopsmith._loop = {};
    det._drillSyncFromLoopState();
    assert.equal(det.getDrillStats().active, false, '{} bounds must not activate drill');

    core.slopsmith._loop = { loopA: undefined, loopB: undefined };
    det._drillSyncFromLoopState();
    assert.equal(det.getDrillStats().active, false, 'undefined bounds must not activate drill');

    core.slopsmith._loop = { loopA: 'not a number', loopB: 1 };
    det._drillSyncFromLoopState();
    assert.equal(det.getDrillStats().active, false, 'non-numeric bounds must not activate drill');

    // Truthy non-object values — _drillCurrentLoop must reject these
    // so destructuring doesn't produce undefined fields downstream.
    core.slopsmith._loop = true;
    det._drillSyncFromLoopState();
    assert.equal(det.getDrillStats().active, false, '`true` from getLoop must not activate drill');

    core.slopsmith._loop = 42;
    det._drillSyncFromLoopState();
    assert.equal(det.getDrillStats().active, false, 'number from getLoop must not activate drill');

    core.slopsmith._loop = 'string';
    det._drillSyncFromLoopState();
    assert.equal(det.getDrillStats().active, false, 'string from getLoop must not activate drill');

    // Only valid finite numbers activate.
    core.slopsmith._loop = { loopA: 5, loopB: 10 };
    det._drillSyncFromLoopState();
    assert.equal(det.getDrillStats().active, true, 'finite numeric bounds activate drill');
    det.destroy();
});

test('mid-drill loop bounds change clears stale iteration history', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();

    // Drill on bounds A = (10, 20).
    core.slopsmith._loop = { loopA: 10, loopB: 20 };
    det._drillSyncFromLoopState();
    for (let i = 0; i < 5; i++) det._recordJudgment(`x${i}`, judgment(true));
    core.slopsmith._fire('loop:restart', { loopA: 10, loopB: 20, time: 10 });
    assert.equal(det.getDrillStats().iterations.length, 1);

    // User picks a different saved loop — bounds change.
    core.slopsmith._loop = { loopA: 30, loopB: 45 };
    det._drillSyncFromLoopState();

    // Iterations cleared because we're now on a different passage.
    assert.equal(det.getDrillStats().iterations.length, 0);
    assert.equal(det.getDrillStats().active, true);
    det.destroy();
});
