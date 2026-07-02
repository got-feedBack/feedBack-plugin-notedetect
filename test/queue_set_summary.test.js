// End-of-set summary + playlist display toggles (queue "Play All").
// Same shape as queue_advance.test.js: the card's DOM flow can't run in the
// vm's stub document, so the pure helpers are extracted and exercised
// directly, and the wiring contracts that must never regress are pinned at
// the SOURCE level.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');

function extract(name, globals) {
    const m = SRC.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
    assert.ok(m, name + ' found');
    // eslint-disable-next-line no-new-func
    return new Function(
        'localStorage',
        m[0] + '; return ' + name + ';'
    )(globals && globals.localStorage);
}

// ── the set log (pure append-or-restart) ──────────────────────────────────────

test('_ndSetLogAppend: appends in order, restarts on a new set', () => {
    const fn = extract('_ndSetLogAppend');
    const e = (pos, total, acc) => ({ pos, total, accuracy: acc,
        filename: 'f' + pos, title: 't', artist: 'a', hits: 1, misses: 0 });
    let log = [];
    log = fn(log, e(0, 3, 90));
    log = fn(log, e(1, 3, 80));
    assert.equal(log.length, 2);
    // A skipped song (too few notes to card) leaves a gap — still the same set.
    log = fn(log, e(2, 3, 70));
    assert.equal(log.length, 3);
    // A NEW queue starts at position 0 → the log restarts.
    log = fn(log, e(0, 3, 60));
    assert.deepEqual(log.map((x) => x.accuracy), [60]);
    // A different queue length is a different set, whatever the position.
    log = fn(log, e(1, 5, 50));
    assert.deepEqual(log.map((x) => x.accuracy), [50]);
    // A non-advancing position (same song re-carded) restarts too — the log
    // can never double-count.
    log = fn(log, e(2, 5, 40));
    log = fn(log, e(2, 5, 40));
    assert.deepEqual(log.map((x) => x.accuracy), [40]);
    // Junk entries never touch the log.
    assert.equal(fn(log, null), log);
    assert.equal(fn(log, { total: 5 }), log);
});

test('_ndSetLogAverage: empty → 0, rounds the mean', () => {
    const fn = extract('_ndSetLogAverage');
    assert.equal(fn([]), 0);
    assert.equal(fn(null), 0);
    assert.equal(fn([{ accuracy: 90 }, { accuracy: 80 }]), 85);
    assert.equal(fn([{ accuracy: 90 }, { accuracy: 80 }, { accuracy: 76 }]), 82);
    assert.equal(fn([{ accuracy: 100 }, {}]), 50);   // missing accuracy = 0
});

// ── the display toggles (default ON) ──────────────────────────────────────────

test('queue display toggles: default on, "0" = off, junk = on', () => {
    for (const [name, key] of [
        ['_ndQueueShowScores', 'slopsmith_notedetect_queue_show_scores'],
        ['_ndQueueSetSummaryEnabled', 'slopsmith_notedetect_queue_set_summary'],
    ]) {
        const store = {};
        const fn = extract(name, { localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
        } });
        assert.equal(fn(), true, name + ' default');
        store[key] = '0';
        assert.equal(fn(), false, name + ' off');
        store[key] = '1';
        assert.equal(fn(), true, name + ' on');
        store[key] = 'banana';
        assert.equal(fn(), true, name + ' junk = on');
    }
});

// ── wiring contracts (source-level pins) ──────────────────────────────────────

test('the set log records only the NATURAL song end (claimAutoExit)', () => {
    const i = SRC.indexOf('_ndSetLog = _ndSetLogAppend(_ndSetLog,');
    assert.ok(i !== -1, 'append site present');
    // The guard sits just above the append — a manual/forced re-show of the
    // card must never double-count a song.
    const guard = SRC.lastIndexOf('opts && opts.claimAutoExit', i);
    assert.ok(guard !== -1 && i - guard < 400, 'append guarded by claimAutoExit');
});

test('set summary requires: last song + toggle + at least two entries', () => {
    const i = SRC.indexOf('const _ndSetDone =');
    assert.ok(i !== -1);
    const block = SRC.slice(i, i + 250);
    assert.match(block, /!_ndQueueNext/);
    assert.match(block, /_ndQueueSetSummaryEnabled\(\)/);
    assert.match(block, /_ndSetLog\.length >= 2/);
});

test('summary Exit retires the log and clears the queue before dismissing', () => {
    const i = SRC.indexOf('if (exitBtn) exitBtn.onclick = () => {');
    assert.ok(i !== -1, 'summary exit wiring present');
    const block = SRC.slice(i, i + 300);
    const log = block.indexOf('_ndSetLog = []');
    const clear = block.indexOf('_ndQueue.clear()');
    const dismiss = block.indexOf('_ndDismissSummary(true)');
    assert.ok(log !== -1 && clear !== -1 && dismiss !== -1);
    assert.ok(log < dismiss && clear < dismiss,
        'log + queue retired BEFORE the dismiss releases the hold');
});

test('last-song Exit retires the log even without viewing the summary', () => {
    const i = SRC.indexOf('if (_ndSetDone) {\n            const setsumBtn');
    assert.ok(i !== -1, 'set-done wiring present');
    const block = SRC.slice(i, i + 500);
    assert.ok(block.indexOf('_ndSetLog = []') !== -1
        && block.indexOf('_ndSetLog = []') < block.indexOf('_ndDismissSummary(true)'));
});

test('scores-off summary swap happens AFTER the auto-exit hold is claimed', () => {
    const hold = SRC.indexOf('window.slopsmith.holdAutoExit()');
    const swap = SRC.indexOf('if (_ndSetDone && !_ndQueueShowScores()) _ndRenderSetSummary()');
    assert.ok(hold !== -1 && swap !== -1);
    assert.ok(swap > hold,
        'the summary relies on the same deferred return the card claims');
});

test('scoreless mode is a CSS collapse, not a DOM fork (wiring stays intact)', () => {
    assert.match(SRC, /overlay\.classList\.add\('nd-sum-scoreless'\)/);
    const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'plugin.css'), 'utf8');
    assert.match(css, /\.nd-sum-scoreless \.nd-sum-headline/);
    // Exit must stay reachable when the card is collapsed.
    assert.match(css, /\.nd-sum-actions > \.nd-btn:not\(\.nd-summary-close\)/);
});
