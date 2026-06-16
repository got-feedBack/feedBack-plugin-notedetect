// Structural tests for the createNoteDetector factory.
//
// The factory is designed so that splitscreen and other multi-panel
// plugins can instantiate independent detectors. These tests don't
// exercise the audio pipeline (the vm sandbox lacks AudioContext /
// getUserMedia) — instead they lock in the public API shape, the
// independence of per-instance state, and the destroy() contract.
// Audio / DOM behavior is validated manually in a real browser; see
// the PR body's test plan.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const { createNoteDetector } = loadDetectionCore();

test('createNoteDetector returns the documented API surface', () => {
    const det = createNoteDetector();
    const expected = ['enable', 'disable', 'destroy', 'isEnabled', 'getStats', 'setChannel', 'injectButton', 'showSummary'];
    for (const name of expected) {
        assert.equal(typeof det[name], 'function', `missing method: ${name}`);
    }
    det.destroy();
});

test('isEnabled() returns false on a freshly-created instance', () => {
    const det = createNoteDetector();
    assert.equal(det.isEnabled(), false);
    det.destroy();
});

test('getStats() returns the documented shape before any detection', () => {
    const det = createNoteDetector();
    const s = det.getStats();
    assert.equal(typeof s.hits, 'number');
    assert.equal(typeof s.misses, 'number');
    assert.equal(typeof s.streak, 'number');
    assert.equal(typeof s.bestStreak, 'number');
    assert.equal(typeof s.accuracy, 'number');
    assert.ok(Array.isArray(s.sectionStats), 'sectionStats should be an array');
    // Fresh instance has zero counters.
    assert.equal(s.hits, 0);
    assert.equal(s.misses, 0);
    assert.equal(s.accuracy, 0);
    det.destroy();
});

test('destroy() is idempotent — calling twice does not throw', () => {
    const det = createNoteDetector();
    det.destroy();
    // Second call must not throw; instance should accept it silently.
    assert.doesNotThrow(() => det.destroy());
});

test('destroy() after disable() is safe even though disable was a no-op', () => {
    const det = createNoteDetector();
    // disable() with the instance never enabled is a no-op — destroy()
    // still has to clean up draw hooks and the registry.
    det.disable();
    assert.doesNotThrow(() => det.destroy());
});

test('destroying one instance does not break a sibling', () => {
    // Can't drive hits through the real audio pipeline from the vm
    // harness (no AudioContext, no getUserMedia), so we can't directly
    // observe per-instance counter divergence — a fuller isolation
    // test lives in the browser smoke-test step. What we CAN assert
    // from here: each instance gets its own API surface and destroy()
    // on one leaves the other's methods callable without throwing.
    // That's the minimum guarantee the factory needs to keep so
    // splitscreen can mount and unmount panels independently.
    const a = createNoteDetector();
    const b = createNoteDetector();

    // Sanity: each call returns a fresh API object (distinct closures).
    assert.notStrictEqual(a, b, 'each factory call should return a distinct API object');

    a.destroy();

    // Sibling instance should still be fully callable after destroy().
    assert.equal(b.isEnabled(), false);
    assert.doesNotThrow(() => b.getStats());
    assert.doesNotThrow(() => b.setChannel(0));
    b.destroy();
});

test('setChannel() does not throw on a disabled instance', () => {
    const det = createNoteDetector();
    // Instance is disabled — setChannel should update the setting but
    // not try to restart audio that was never started. Must not throw.
    assert.doesNotThrow(() => det.setChannel(0));
    assert.doesNotThrow(() => det.setChannel(1));
    assert.doesNotThrow(() => det.setChannel(-1));
    det.destroy();
});

// --- highway.setNoteStateProvider integration (slopsmith#254) ----------
//
// ensureDrawHook() registers our noteStateFor as the highway's note-state
// provider; destroy() clears it. The new core API is last-wins by
// contract, but we made the plugin a "good neighbour": skip registration
// when another plugin already owns the slot, and only clear at destroy
// when we can positively verify the active provider is still ours.
//
// The audio pipeline never runs in the vm harness (no AudioContext /
// getUserMedia), so enable() resolves to false — but ensureDrawHook()
// runs in the synchronous prefix of enableImpl(), *before* the first
// await, so the provider gets installed regardless. We pass a custom
// `highway` stub via opts so each test owns its own provider slot and
// nothing leaks across.

function mkHwStub() {
    const stub = {
        addDrawHook() {},
        removeDrawHook() {},
        getTime: () => 0,
        getAvOffset: () => 0,
        getNotes: () => [],
        getChords: () => [],
        getSections: () => [],
        getSongInfo: () => ({}),
        _provider: null,
        setNoteStateProvider(fn) { this._provider = fn; },
        getNoteStateProvider() { return this._provider; },
    };
    return stub;
}

test('enable() registers noteStateFor as the note-state provider when the slot is empty', async () => {
    const hw = mkHwStub();
    const det = createNoteDetector({ highway: hw });
    // startAudio() rejects in the vm — enable() resolves to false. But
    // ensureDrawHook() ran in the synchronous prefix, so the provider is
    // already installed by the time enable() settles.
    await det.enable().catch(() => {});
    assert.equal(typeof hw._provider, 'function', 'should register a function provider');
    det.destroy();
});

test('enable() does not stomp a pre-existing provider that isn\'t ours', async () => {
    const hw = mkHwStub();
    const incumbent = () => null;
    hw._provider = incumbent;                              // some other plugin got there first
    const det = createNoteDetector({ highway: hw });
    await det.enable().catch(() => {});
    assert.strictEqual(hw._provider, incumbent, 'must leave the incumbent provider in place');
    det.destroy();
    // destroy() must also leave the incumbent untouched (not ours).
    assert.strictEqual(hw._provider, incumbent, 'destroy() must not clear someone else\'s provider');
});

test('destroy() clears the provider only when it\'s still ours', async () => {
    // Case A — slot is still ours: destroy() should clear it.
    {
        const hw = mkHwStub();
        const det = createNoteDetector({ highway: hw });
        await det.enable().catch(() => {});
        assert.equal(typeof hw._provider, 'function');
        det.destroy();
        assert.equal(hw._provider, null, 'destroy() should clear our own provider');
    }
    // Case B — someone took the slot after us: destroy() must NOT clear it.
    {
        const hw = mkHwStub();
        const det = createNoteDetector({ highway: hw });
        await det.enable().catch(() => {});
        assert.equal(typeof hw._provider, 'function');
        const usurper = () => null;
        hw._provider = usurper;                            // simulate another plugin taking over
        det.destroy();
        assert.strictEqual(hw._provider, usurper, 'destroy() must not stomp a provider another plugin installed after us');
    }
});
