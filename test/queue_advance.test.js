// Queue-aware Up-Next strip on the results card (playlist "Play All").
// The card's DOM flow can't run in the vm's stub document, so these pin the
// two things that must never regress at the SOURCE level — the advance path
// bypassing the host's close wrapper, and Exit abandoning the queue — plus
// the extracted delay-setting helper's behaviour.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');

test('advance path drops the auto-exit hold and calls playQueue.advance()', () => {
    // The block must exist…
    const i = SRC.indexOf('const _ndQueueAdvance = () => {');
    assert.ok(i !== -1, 'queue-advance handler present');
    const block = SRC.slice(i, SRC.indexOf('};', i));
    // …drop the hold WITHOUT calling release() (release navigates home)…
    assert.match(block, /_ndAutoExitRelease = null/);
    assert.doesNotMatch(block, /release\(\)/);
    // …remove the card BEFORE advancing so it can't linger over the next song…
    assert.ok(block.indexOf('overlay.remove()') < block.indexOf('.advance()'),
        'card removed before the queue advances');
});

test('Exit Song clears the queue before dismissing (a real exit)', () => {
    const i = SRC.indexOf('if (closeBtn) closeBtn.onclick = () => {');
    assert.ok(i !== -1, 'queue-mode Exit rewiring present');
    const block = SRC.slice(i, i + 400);
    assert.ok(block.indexOf('_ndQueue.clear()') !== -1, 'queue abandoned on Exit');
    assert.ok(block.indexOf('_ndQueue.clear()') < block.indexOf('_ndDismissSummary(true)'),
        'cleared BEFORE the dismiss releases the hold — the host wrapper must find nothing to advance to');
});

test('countdown stops when another path already closed the card', () => {
    const i = SRC.indexOf('_ndAdvanceTimer = setInterval(');
    assert.ok(i !== -1, 'countdown interval present');
    const block = SRC.slice(i, i + 500);
    assert.match(block, /overlay\.isConnected/);
});

test('strip renders only when the queue has a next track (feature-detected)', () => {
    assert.match(SRC, /typeof _ndQueue\.peekNext === 'function'/);
    assert.match(SRC, /_ndQueueNext \? `/);
});

test('advance is idempotent — guarded by overlay.isConnected (no double-advance)', () => {
    const i = SRC.indexOf('const _ndQueueAdvance = () => {');
    assert.ok(i !== -1, 'queue-advance handler present');
    const block = SRC.slice(i, SRC.indexOf('};', i));
    // The very first statement must bail when the card is already gone, so a
    // double-click on Play now, or a delay-0 setTimeout firing after a close,
    // can never call playQueue.advance() twice / after the card left.
    assert.match(block, /if\s*\(!overlay\.isConnected\)\s*return;/,
        'advance must no-op once the card is disconnected');
    assert.ok(block.indexOf('!overlay.isConnected') < block.indexOf('.advance()'),
        'the guard must precede the advance');
});

test('a card built hidden defers the countdown until it is revealed', () => {
    // startHidden must NOT start the countdown at build time — the queue could
    // otherwise advance before the user ever sees the score.
    assert.match(SRC, /if\s*\(opts && opts\.startHidden\)\s*\{\s*overlay\._ndStartUpNext = _ndStartUpNext;\s*\}/,
        'hidden card stores the countdown starter instead of running it');
    assert.match(SRC, /else\s*\{\s*_ndStartUpNext\(\);\s*\}/,
        'a visible card starts the countdown immediately');
    // …and the reveal path fires the stored starter.
    const rd = SRC.slice(SRC.indexOf('function _runDeferredSummary'));
    assert.match(rd, /overlay\._ndStartUpNext/,
        '_runDeferredSummary must start the deferred countdown on reveal');
});

test('async label lookup preserves path separators (nested filenames resolve)', () => {
    // Whole-string encodeURIComponent would turn "/" into %2F and miss nested
    // paths — encode per segment instead.
    assert.match(SRC, /\.split\('\/'\)\.map\(encodeURIComponent\)\.join\('\/'\)/,
        'next-song URL must encode path segments, not the slashes');
    assert.doesNotMatch(SRC, /fetch\('\/api\/song\/' \+ encodeURIComponent\(_ndQueueNext\.filename\)\)/,
        'the whole-filename encode must be gone');
});

test('filename-derived label strips .feedpak as well as legacy .sloppak', () => {
    const m = SRC.match(/const _ndQueueNextLabel = _ndQueueNext[\s\S]*?: '';/);
    assert.ok(m, 'label expression found');
    assert.match(m[0], /\.replace\(\/\\\.\(feedpak\|sloppak\)\$\/i, ''\)/,
        'both current .feedpak and legacy .sloppak extensions are stripped');
});

test('_ndQueueDelaySeconds: default 10, manual value, 0 allowed, junk rejected', () => {
    const m = SRC.match(/function _ndQueueDelaySeconds\(\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'helper found');
    const store = {};
    const localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
    };
    // eslint-disable-next-line no-new-func
    const fn = new Function('localStorage', m[0] + '; return _ndQueueDelaySeconds;')(localStorage);
    assert.equal(fn(), 10);                              // unset → default
    store.slopsmith_notedetect_queue_delay = '25';
    assert.equal(fn(), 25);                              // manual value
    store.slopsmith_notedetect_queue_delay = '0';
    assert.equal(fn(), 0);                               // 0 = instant advance
    store.slopsmith_notedetect_queue_delay = '-5';
    assert.equal(fn(), 10);                              // junk → default
    store.slopsmith_notedetect_queue_delay = 'soon';
    assert.equal(fn(), 10);
});
