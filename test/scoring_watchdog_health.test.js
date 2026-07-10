// Scoring-watchdog health predicate (_ndScoringHealthy) — the enabled/bridge/
// external/mic-callback decision the watchdog tick uses to decide "playing +
// Detect wanted, but is anything actually scoring?". Pinned here because the
// external MIDI path (keys/piano) opens no Web-Audio graph, so its callback is
// permanently stale — _extActive must count as healthy or the watchdog surfaces
// the "input dropped" banner and re-opens the mic every 4s against MIDI scoring
// on every keys/piano song (PR #63). The full tick's DOM/timing lives in the
// browser; this pins the pure branch logic it turns on.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

test('mic path: enabled + fresh audio callback → healthy', () => {
    const { scoringHealthy } = loadDetectionCore();
    // enabled, no bridge, no external, callback fresh
    assert.equal(scoringHealthy(true, false, false, true), true);
});

test('desktop bridge: enabled on bridge → healthy (bridge owns input, no cb)', () => {
    const { scoringHealthy } = loadDetectionCore();
    assert.equal(scoringHealthy(true, true, false, false), true);
});

test('external MIDI active: enabled + _extActive → healthy, no stall (no banner/restart)', () => {
    const { scoringHealthy } = loadDetectionCore();
    // The bug: this returned false because bridge=false and cbFresh=false,
    // tipping the tick into the stall+restartAudio path on every keys song.
    assert.equal(scoringHealthy(true, false, true, false), true);
});

test('genuinely stalled: enabled + playing but bridge/external/cb all dead → not healthy (surfaces stall)', () => {
    const { scoringHealthy } = loadDetectionCore();
    assert.equal(scoringHealthy(true, false, false, false), false);
});

test('detection off is never healthy, whatever the inputs report', () => {
    const { scoringHealthy } = loadDetectionCore();
    assert.equal(scoringHealthy(false, true, true, true), false);
});
