// Contextual hero CTA helper (_ndPickHeroAction) — picks which results-card
// action gets the primary slot from the shape of the result. Pure; the caller
// resolves the section's loop range and renders. These pin the deliberate-
// practice rule (localized weakness → drill that section; broadly rough →
// replay whole) and the conservative thresholds.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

const S = (name, acc) => ({ name, acc });

test('localized weakness → hero drills the single weak section', () => {
    const core = loadDetectionCore();
    const r = core.pickHeroAction({
        accuracy: 88, canRetry: true,
        sections: [S('Verse', 95), S('Chorus', 92), S('Bridge', 70)],
    });
    assert.equal(r.kind, 'practice-section');
    assert.equal(r.sectionName, 'Bridge');
    assert.match(r.reason, /Bridge/);
});

test('broadly rough → hero stays full Retry with a slow-it-down nudge', () => {
    const core = loadDetectionCore();
    const r = core.pickHeroAction({
        accuracy: 52, canRetry: true,
        sections: [S('Verse', 55), S('Chorus', 49)],
    });
    assert.equal(r.kind, 'retry');
    assert.match(r.reason, /slower/);
});

test('solid run, no clear outlier → plain Retry (no reason clutter)', () => {
    const core = loadDetectionCore();
    const r = core.pickHeroAction({
        accuracy: 90, canRetry: true,
        sections: [S('Verse', 92), S('Chorus', 88), S('Bridge', 89)],
    });
    assert.equal(r.kind, 'retry');
    assert.equal(r.reason, '');
});

test('outlier must be both a clear gap AND below a clean pass', () => {
    const core = loadDetectionCore();
    // gap 90-86 = 4 (< 15) → not localized
    assert.equal(core.pickHeroAction({
        accuracy: 90, canRetry: true, sections: [S('A', 94), S('B', 86)],
    }).kind, 'retry');
    // gap 85-70 = 15 (>= 15), weakest 70 (< 90), overall 85 (>= 80) → drill
    assert.equal(core.pickHeroAction({
        accuracy: 85, canRetry: true, sections: [S('A', 96), S('B', 70)],
    }).kind, 'practice-section');
});

test('a section with no notes (acc null) cannot be the weakest', () => {
    const core = loadDetectionCore();
    const r = core.pickHeroAction({
        accuracy: 88, canRetry: true,
        sections: [S('Verse', 92), S('Skipped', null), S('Bridge', 70)],
    });
    assert.equal(r.kind, 'practice-section');
    assert.equal(r.sectionName, 'Bridge');
});

test('cannot retry → never a section drill (Retry/Exit owns the slot)', () => {
    const core = loadDetectionCore();
    const r = core.pickHeroAction({
        accuracy: 88, canRetry: false,
        sections: [S('Verse', 95), S('Bridge', 60)],
    });
    assert.equal(r.kind, 'retry');
});

test('no sections → Retry', () => {
    const core = loadDetectionCore();
    assert.equal(core.pickHeroAction({ accuracy: 88, canRetry: true, sections: [] }).kind, 'retry');
});
