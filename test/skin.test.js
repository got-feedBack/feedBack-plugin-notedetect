// Scoring-UI skin preference tests — allowlist validation and the bus
// announcement. DOM re-stamping is browser-only (the vm's document stub
// returns no roots); what matters here is that bad values never persist
// and the change event fires for renderer consumers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

test('getSkin defaults to neon when nothing is stored', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    assert.equal(det.getSkin(), 'neon');
    det.destroy();
});

test('getSkin falls back to neon on an unknown stored value', () => {
    const core = loadDetectionCore({
        sandboxBeforeRun: (sandbox) => {
            sandbox.localStorage = {
                getItem: (k) => (k === 'slopsmith_notedetect_skin' ? 'vaporwave' : null),
                setItem: () => {},
                removeItem: () => {},
            };
        },
    });
    const det = core.createNoteDetector();
    assert.equal(det.getSkin(), 'neon');
    det.destroy();
});

test('setSkin accepts only known skins and persists + announces the change', () => {
    const stored = {};
    const emitted = [];
    const core = loadDetectionCore({
        sandboxBeforeRun: (sandbox) => {
            sandbox.localStorage = {
                getItem: (k) => (k in stored ? stored[k] : null),
                setItem: (k, v) => { stored[k] = v; },
                removeItem: (k) => { delete stored[k]; },
            };
        },
    });
    core.slopsmith.emit = (event, detail) => emitted.push([event, detail]);
    const det = core.createNoteDetector();

    assert.equal(det.setSkin('metal'), true);
    assert.equal(stored.slopsmith_notedetect_skin, 'metal');
    assert.equal(det.getSkin(), 'metal');
    // Field-wise compare — the detail object comes from the vm realm, so
    // deepEqual's same-realm prototype check would reject it.
    assert.equal(emitted.at(-1)[0], 'notedetect:skin');
    assert.equal(emitted.at(-1)[1].skin, 'metal');

    assert.equal(det.setSkin('vaporwave'), false, 'unknown skin rejected');
    assert.equal(stored.slopsmith_notedetect_skin, 'metal', 'rejected value not persisted');
    assert.equal(det.getSkin(), 'metal');
    det.destroy();
});

test('setSkin stays coherent with getSkin when persistence throws', () => {
    const core = loadDetectionCore({
        sandboxBeforeRun: (sandbox) => {
            sandbox.localStorage = {
                getItem: () => { throw new Error('storage unavailable'); },
                setItem: () => { throw new Error('storage unavailable'); },
                removeItem: () => {},
            };
        },
    });
    const det = core.createNoteDetector();
    assert.equal(det.getSkin(), 'neon');
    assert.equal(det.setSkin('metal'), true);
    // The runtime mirror keeps the session coherent despite the failed write.
    assert.equal(det.getSkin(), 'metal');
    det.destroy();
});
