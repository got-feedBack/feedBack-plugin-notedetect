// Tests for the public launchCalibration() entry used by the input_setup
// onboarding wizard (guitar/bass). Thin wrapper over openCalibrationWizard
// that adds instrument context + one-shot done/cancel callbacks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

// A DOM stub rich enough for openCalibrationWizard()/calibrationWizardClose()
// to run without throwing (the default _loader element proxy throws on
// element.remove()).
function richDoc() {
    const mkEl = () => {
        const el = {
            style: {}, dataset: {}, innerHTML: '', textContent: '', onclick: null, disabled: false,
            classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
            addEventListener() {}, removeEventListener() {},
            appendChild() { return el; }, removeChild() {}, remove() {},
            setAttribute() {}, getAttribute() { return null; },
            querySelector() { return mkEl(); }, querySelectorAll() { return []; },
            focus() {}, click() {}, closest() { return null; },
        };
        return el;
    };
    return {
        getElementById() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement() { return mkEl(); },
        head: mkEl(), body: mkEl(),
        addEventListener() {}, removeEventListener() {},
    };
}

function makeDetector() {
    const core = loadDetectionCore({ sandboxBeforeRun: (sb) => { sb.document = richDoc(); } });
    return core.createNoteDetector({ isDefault: false });
}

// Let the (fail-soft) enable() path settle so the wizard has opened.
const settle = () => new Promise((r) => setTimeout(r, 30));

test('launchCalibration is exposed on the detector API', () => {
    const det = makeDetector();
    assert.equal(typeof det.launchCalibration, 'function');
});

test('closing the wizard without applying fires onCancel (not onDone)', async () => {
    const det = makeDetector();
    let cancelled = null;
    let done = false;
    det.launchCalibration({
        instrument: 'guitar',
        onDone: () => { done = true; },
        onCancel: (reason) => { cancelled = reason; },
    });
    await settle();
    det.closeCalibrationWizard();
    assert.equal(done, false, 'onDone must not fire on a cancel');
    assert.equal(cancelled, 'closed', 'onCancel fires with reason "closed"');
});

test('callbacks are one-shot: a second close does not re-fire', async () => {
    const det = makeDetector();
    let cancelCount = 0;
    det.launchCalibration({ instrument: 'bass', onCancel: () => { cancelCount += 1; } });
    await settle();
    det.closeCalibrationWizard();
    det.closeCalibrationWizard();
    assert.equal(cancelCount, 1, 'onCancel fires exactly once across repeated closes');
});

test('launchCalibration accepts no options without throwing', async () => {
    const det = makeDetector();
    assert.doesNotThrow(() => det.launchCalibration());
    await settle();
    det.closeCalibrationWizard();
});
