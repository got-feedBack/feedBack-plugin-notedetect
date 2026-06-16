// frameSize is the ScriptProcessor buffer fed to the browser detector — the
// bass-recall knob. It's documented as tunable via window.noteDetect.
// applySettings, so the public setter must accept it (clamped to a valid
// buffer size) and echo it back, not just read it from localStorage on load.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

test('applySettings accepts frameSize and echoes it back', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    const r = det.applySettings({ frameSize: 4096 });
    assert.equal(r.frameSize, 4096, 'returns the applied frameSize');
    det.destroy();
});

test('applySettings clamps an invalid frameSize to the 2048 default', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    // 999 is not a valid ScriptProcessor buffer size → clamps to 2048.
    const r = det.applySettings({ frameSize: 999 });
    assert.equal(r.frameSize, 2048, 'invalid value falls back to the default');
    det.destroy();
});

test('applySettings without frameSize leaves it at the default', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector({ isDefault: true });
    const r = det.applySettings({ pitchTolerance: 40 });
    assert.equal(r.frameSize, 2048, 'untouched default still reported');
    det.destroy();
});
