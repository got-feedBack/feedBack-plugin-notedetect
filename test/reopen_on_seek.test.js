// Unit tests for the backward-seek re-open decision (_ndKeysToReopenOnSeek),
// ported from slopsmith note_detect 1.39.1. On a backward playhead jump (seek
// or drill A-B loop wrap) the already-judged notes at/after the new playhead
// must re-open so the replayed section re-scores instead of keeping its stale
// first-pass verdict. Keys are "<chartTime>_<s>_<f>".
const { test } = require('node:test');
const assert = require('node:assert');
const { loadDetectionCore } = require('./_loader');

const { keysToReopenOnSeek } = loadDetectionCore();
const keys = ['5.000_1_1', '10.000_0_3', '12.500_1_5', '20.000_1_0'];

test('no reopen on forward progress', () => {
    assert.deepStrictEqual([...keysToReopenOnSeek(10.0, 11.0, 0.15, keys)], []);
});

test('no reopen for tiny backward jitter (< 0.25s)', () => {
    assert.deepStrictEqual([...keysToReopenOnSeek(10.0, 9.9, 0.15, keys)], []);
});

test('null lastT (startup / post-reset) reopens nothing', () => {
    assert.deepStrictEqual([...keysToReopenOnSeek(null, 5.0, 0.15, keys)], []);
});

test('a genuine backward seek reopens notes at/after the new playhead', () => {
    const out = [...keysToReopenOnSeek(20.0, 10.0, 0.15, keys)];
    assert.deepStrictEqual(out.sort(), ['10.000_0_3', '12.500_1_5', '20.000_1_0']);
});

test('the timing window lets a note just before the playhead re-open too', () => {
    // floor = 10.0 - 0.15 = 9.85, so 10.000 is included; 5.000 is not.
    const out = [...keysToReopenOnSeek(20.0, 10.0, 0.15, keys)];
    assert.ok(out.includes('10.000_0_3'));
    assert.ok(!out.includes('5.000_1_1'));
});

test('seeking to the start reopens everything', () => {
    const out = [...keysToReopenOnSeek(20.0, 0.0, 0.15, keys)];
    assert.strictEqual(out.length, keys.length);
});
