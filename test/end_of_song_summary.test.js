// End-of-song summary tests — exercise the song:ended listener that
// pops the post-song summary modal when audio finishes naturally with
// detection still on.
//
// The full audio + DOM pipeline isn't available in the vm sandbox, so
// these tests drive the subscription/handler directly via the same
// `_bind*` / `_unbind*` test hooks the drill tests use. Each test gets
// a fresh loader load so the slopsmith listener registry doesn't leak.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

test('_bindEndOfSongEvents() adds a song:ended listener on top of drill\'s', () => {
    // Contract: drill alone registers exactly one song:ended listener
    // (covered by drill_mode.test.js). Adding the end-of-song summary
    // subscription brings the count to two; the test pins that so a
    // future refactor doesn't silently collapse them onto a single
    // handler (the drill handler clears iteration state and is wrong
    // to use for surfacing the modal).
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 1, 'drill alone');
    det._bindEndOfSongEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 2, 'drill + end-of-song');
    // Idempotent — calling again must not double-bind.
    det._bindEndOfSongEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 2, 'second bind is a no-op');
    det.destroy();
});

test('_unbindEndOfSongEvents() removes only the end-of-song listener', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    det._bindEndOfSongEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 2);
    det._unbindEndOfSongEvents();
    // Drill listener survives — destroy() is the only thing that
    // tears that down.
    assert.equal(core.slopsmith._listenerCount('song:ended'), 1, 'drill listener survives');
    // Idempotent.
    det._unbindEndOfSongEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 1, 'second unbind is a no-op');
    det.destroy();
});

test('destroy() unbinds both drill and end-of-song listeners', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindDrillEvents();
    det._bindEndOfSongEvents();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 2);
    det.destroy();
    assert.equal(core.slopsmith._listenerCount('song:ended'), 0);
});

test('song:ended on a disabled instance does not throw', () => {
    // Detection disabled = no in-flight session. The handler is
    // expected to bail early on `if (!enabled) return;` rather than
    // try to render a summary against zeroed counters. Tests against
    // a regression where the guard was removed and showSummary tried
    // to DOM-write into the (stubbed) sandbox elements, which throws.
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    det._bindEndOfSongEvents();
    // isEnabled() defaults to false in the vm — confirms the
    // precondition rather than depending on it implicitly.
    assert.equal(det.isEnabled(), false);
    assert.doesNotThrow(() => {
        core.slopsmith._fire('song:ended', {});
    });
    det.destroy();
});

// ── Results-screen rewrite (game-grade summary) ─────────────────────────
// The rewritten showSummary is defensive about absent DOM (vm stubs), so
// the build path itself plus the notedetect:session payload are now
// assertable headlessly. Visual reveal/confetti are browser-only.

function _judgment(hit, extra = {}) {
    return { hit, note: { s: 1, f: 0 }, noteTime: 0, judgedAt: 0, ...extra };
}

test('showSummary returns false under 5 judgments, true at 5+', () => {
    const core = loadDetectionCore();
    const det = core.createNoteDetector();
    for (let i = 0; i < 4; i++) det._recordJudgment(`k${i}`, _judgment(true));
    assert.equal(det.showSummary(), false);
    det._recordJudgment('k4', _judgment(true));
    assert.equal(det.showSummary(), true);
    det.destroy();
});

// ── Host autoplay/auto-exit handoff ─────────────────────────────────────
// When the host's global "Autoplay & auto-exit" option is on, the natural
// song-end summary claims the host's deferred return (holdAutoExit) so the
// panel isn't yanked away by the grace timer. Manual / option-off summaries
// must NOT claim it. (The dismiss→release step is browser-only — the vm's
// querySelector returns null, so the close handlers aren't wired here.)

function _seedJudgments(det, n) {
    for (let i = 0; i < n; i++) det._recordJudgment(`k${i}`, _judgment(true));
}

test('natural song-end summary claims the host auto-exit when the option is on', () => {
    const core = loadDetectionCore();
    core.slopsmith._autoplayExit = true;
    const det = core.createNoteDetector();
    _seedJudgments(det, 5);
    assert.equal(det.showSummary({ claimAutoExit: true }), true);
    assert.equal(core.slopsmith._holdCount, 1, 'held exactly once');
    det.destroy();
});

test('summary does not claim auto-exit when the option is off', () => {
    const core = loadDetectionCore();
    core.slopsmith._autoplayExit = false;
    const det = core.createNoteDetector();
    _seedJudgments(det, 5);
    assert.equal(det.showSummary({ claimAutoExit: true }), true);
    assert.equal(core.slopsmith._holdCount, 0, 'no hold when option off');
    det.destroy();
});

test('manual showSummary (no claimAutoExit) never claims auto-exit', () => {
    const core = loadDetectionCore();
    core.slopsmith._autoplayExit = true;
    const det = core.createNoteDetector();
    _seedJudgments(det, 5);
    assert.equal(det.showSummary(), true); // manual/api path — no opts
    assert.equal(core.slopsmith._holdCount, 0, 'manual summary leaves auto-exit alone');
    det.destroy();
});

test('a bailed (<5 judgments) summary claims nothing', () => {
    const core = loadDetectionCore();
    core.slopsmith._autoplayExit = true;
    const det = core.createNoteDetector();
    _seedJudgments(det, 4);
    assert.equal(det.showSummary({ claimAutoExit: true }), false);
    assert.equal(core.slopsmith._holdCount, 0, 'no overlay built → no hold');
    det.destroy();
});

test('notedetect:session carries the game-scoring additions', () => {
    const events = [];
    const core = loadDetectionCore({
        sandboxBeforeRun: (sandbox) => {
            // dispatchInstanceEvent tries window.dispatchEvent first; give the
            // sandbox one so the session payload is observable.
            sandbox.dispatchEvent = (ev) => events.push(ev);
        },
    });
    const det = core.createNoteDetector();
    for (let i = 0; i < 9; i++) det._recordJudgment(`k${i}`, _judgment(true));
    det._recordJudgment('m0', _judgment(false));
    assert.equal(det.showSummary(), true);
    const session = events.find(e => e.type === 'notedetect:session');
    assert.ok(session, 'session event published');
    const d = session.detail;
    assert.equal(d.accuracy, 90);
    assert.equal(d.score, 9 * 50);
    assert.equal(d.grade, 'A');
    assert.equal(d.fullCombo, false);
    assert.equal(d.maxMultiplier, 1);
    // Pre-existing fields survive untouched.
    assert.equal(d.hits, 9);
    assert.equal(d.misses, 1);
    assert.equal(d.bestStreak, 9);
    det.destroy();
});

test('a clean take publishes fullCombo: true', () => {
    const events = [];
    const core = loadDetectionCore({
        sandboxBeforeRun: (sandbox) => { sandbox.dispatchEvent = (ev) => events.push(ev); },
    });
    const det = core.createNoteDetector();
    for (let i = 0; i < 12; i++) det._recordJudgment(`k${i}`, _judgment(true));
    assert.equal(det.showSummary(), true);
    const session = events.find(e => e.type === 'notedetect:session');
    assert.ok(session);
    assert.equal(session.detail.fullCombo, true);
    assert.equal(session.detail.maxMultiplier, 2);
    det.destroy();
});

// ── Results-card share helpers (Copy card / Save) ────────────────────────

test('_ndInstrumentLabel title-cases the arrangement and tolerates empties', () => {
    const core = loadDetectionCore();
    assert.equal(core.instrumentLabel('rhythm'), 'Rhythm');
    assert.equal(core.instrumentLabel('Bass'), 'Bass');
    assert.equal(core.instrumentLabel('  lead  '), 'Lead');
    assert.equal(core.instrumentLabel(''), '');
    assert.equal(core.instrumentLabel(null), '');
    assert.equal(core.instrumentLabel(undefined), '');
});

test('_ndShareCardText carries title, instrument, accuracy, score (no grade)', () => {
    const core = loadDetectionCore();
    const txt = core.shareCardText({
        title: 'Sample Song', instrument: 'Lead',
        accuracy: 92, score: 3700, fullCombo: false,
    });
    assert.match(txt, /fee\[dB\]ack — Sample Song \(Lead\)/);
    assert.match(txt, /92%/);
    assert.match(txt, /3700 pts/);
    // The letter grade was removed from the card (charrette 2026-06-27).
    assert.doesNotMatch(txt, /Grade/);
    assert.doesNotMatch(txt, /Full Combo/);
});

test('_ndShareCardText appends Full Combo only on a clean run', () => {
    const core = loadDetectionCore();
    const txt = core.shareCardText({
        title: 'Clean One', grade: 'S', accuracy: 100, score: 750, fullCombo: true,
    });
    assert.match(txt, /Full Combo/);
    // No instrument → no parenthetical.
    assert.doesNotMatch(txt, /\(/);
});

test('_ndShareCardFilename slugs the title and falls back when empty', () => {
    const core = loadDetectionCore();
    assert.equal(core.shareCardFilename({ title: 'Hello, World!' }), 'feedback-hello-world.png');
    assert.equal(core.shareCardFilename({ title: '' }), 'feedback-score-card.png');
    assert.equal(core.shareCardFilename({}), 'feedback-score-card.png');
});

test('_ndSongArtUrl builds a same-origin art URL, preserving DLC path slashes', () => {
    const core = loadDetectionCore();
    assert.equal(core.songArtUrl('Bon-Iver_Beth-Rest.sloppak'),
        '/api/song/Bon-Iver_Beth-Rest.sloppak/art');
    // Nested DLC path: slashes stay as path separators, segments are encoded.
    assert.equal(core.songArtUrl('diagnostics-builtin/basic guitar.sloppak'),
        '/api/song/diagnostics-builtin/basic%20guitar.sloppak/art');
    assert.equal(core.songArtUrl(''), '');
    assert.equal(core.songArtUrl(null), '');
});
