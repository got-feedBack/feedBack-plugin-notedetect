// No per-song results popup inside a gig.
//
// Reported from a live career gig: the first song of the set ended and the
// end-of-song summary overlay popped up. It is wrong there twice over.
//
//  1. A gig is a SET. The career plugin already shows ONE card at the end of it,
//     scoring every song played. A per-song card interrupts the set.
//  2. Worse, the overlay claimAutoExit's — it takes ownership of the host's
//     post-song return. So the play queue would NOT advance to the next song
//     until the player dismissed the popup. The set stalled after every song.
//
// The summary is suppressed for gig songs, but the take is still credited: the
// XP submission keeps the exact gate a built summary would have applied.
//
// screen.js is one large closure with no seam to import, so these are
// source-shape guards (the same approach the repo's other structural tests use).
// What they lock down is ORDERING and NARROWNESS, which is where this can
// silently regress.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');

function extractBlock(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const openBrace = src.indexOf('{', start);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

test('the gig check runs BEFORE the summary is built', () => {
    const fn = extractBlock(SRC, 'function _endOfSongOnEnded()');
    const gigIdx = fn.search(/_inGigSet\s*\(\s*\)/);
    const summaryIdx = fn.search(/showSummary\s*\(/);
    assert.ok(gigIdx !== -1, '_endOfSongOnEnded must consult _inGigSet()');
    assert.ok(summaryIdx !== -1, 'showSummary call not found');
    assert.ok(gigIdx < summaryIdx,
        'the gig bail must come before showSummary — build it and claimAutoExit ' +
        'stalls the host queue, which is the bug');
    assert.match(fn, /_inGigSet\s*\(\s*\)\s*\)\s*\{[\s\S]{0,600}?\breturn;/,
        'the gig path must RETURN out of the handler, not fall through');
});

test('a gig song still earns its XP and still tears the detector down', () => {
    const fn = extractBlock(SRC, 'function _endOfSongOnEnded()');
    const gigBlock = fn.slice(fn.search(/if\s*\(\s*_inGigSet\s*\(\s*\)\s*\)/));
    assert.match(gigBlock, /_submitSongXp\s*\(\s*\)/,
        "suppressing the overlay must not silently drop the take's XP");
    assert.match(gigBlock, /_summaryWorthy\s*\(\s*\)/,
        'XP must use the SAME gate a built summary would have applied');
    assert.match(gigBlock, /disable\s*\(\s*\{\s*silent:\s*true\s*\}\s*\)/,
        'the detector must still be torn down between songs of the set');
});

test('_inGigSet is narrow: only the gig queue, and only while it is live', () => {
    const fn = extractBlock(SRC, 'function _inGigSet()');
    assert.match(fn, /===\s*'gig'/,
        "must key on the 'gig' queue source — a playlist or album keeps its per-song summary");
    assert.match(fn, /\.active\s*\(\s*\)/,
        "a cleared or stale queue must not suppress an unrelated song's summary");
    assert.match(fn, /catch[\s\S]{0,40}return false/,
        'a throwing host must fall back to SHOWING the summary — fail visible, not silent');
});

test('showSummary and the gig path share one judgment threshold', () => {
    // Drift here would mean a take earns XP with no summary, or the reverse.
    assert.match(SRC, /const\s+_SUMMARY_MIN_JUDGMENTS\s*=\s*\d+/, 'threshold must be named');
    const show = extractBlock(SRC, 'function showSummary(opts)');
    assert.match(show, /_summaryWorthy\s*\(\s*\)/,
        'showSummary must use the shared gate, not a second inline `total < 5`');
});
