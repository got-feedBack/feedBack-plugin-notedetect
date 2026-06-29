// "Beat your best" delta helper (_ndComputeBestDelta) — pure accuracy-vs-best
// comparison that drives the results-card delta line. Storage I/O is browser
// localStorage and not exercised here; this pins the comparison + guilt-guard
// contract (no new-best on a tie/worse run; negatives are computed but the
// renderer never surfaces them).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

test('first clear (no prior best) → first + newBest, zero delta, bestAcc = this run', () => {
    const core = loadDetectionCore();
    const d = core.computeBestDelta(null, { accuracy: 62 });
    assert.equal(d.first, true);
    assert.equal(d.newBest, true);
    assert.equal(d.accDelta, 0);
    assert.equal(d.bestAcc, 62);
});

test('improvement → new best with a positive delta and the new best accuracy', () => {
    const core = loadDetectionCore();
    const d = core.computeBestDelta({ accuracy: 80 }, { accuracy: 84 });
    assert.equal(d.first, false);
    assert.equal(d.newBest, true);
    assert.equal(d.accDelta, 4);
    assert.equal(d.bestAcc, 84);
});

test('a tie is not a new best and reports the standing best', () => {
    const core = loadDetectionCore();
    const d = core.computeBestDelta({ accuracy: 90 }, { accuracy: 90 });
    assert.equal(d.newBest, false);
    assert.equal(d.accDelta, 0);
    assert.equal(d.bestAcc, 90);
});

test('a worse run is never a new best; bestAcc stays the prior best', () => {
    const core = loadDetectionCore();
    const d = core.computeBestDelta({ accuracy: 88 }, { accuracy: 71 });
    assert.equal(d.newBest, false);
    assert.equal(d.accDelta, -17); // computed, but the renderer suppresses negatives
    assert.equal(d.bestAcc, 88);
});

test('fractional accuracy is rounded before comparing', () => {
    const core = loadDetectionCore();
    const d = core.computeBestDelta({ accuracy: 89.4 }, { accuracy: 89.6 }); // 89 → 90
    assert.equal(d.newBest, true);
    assert.equal(d.accDelta, 1);
});

test('missing/garbage current accuracy coerces to 0 (no throw)', () => {
    const core = loadDetectionCore();
    const d = core.computeBestDelta(null, {});
    assert.equal(d.bestAcc, 0);
    assert.equal(d.first, true);
});
