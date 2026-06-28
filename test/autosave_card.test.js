// Auto-save card feature — the client-side filename builder.
//
// Auto-saved cards are named "Artist - Title - YYYY-MM-DD HHMM.png" so a folder
// of cards sorts by song and every take is kept (the server never overwrites an
// auto-saved card; it appends a counter on a clash, and sanitises the name —
// spaces survive). These tests pin the client-side name SHAPE.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

// "<artist> - <title> - 2026-06-28 1432.png" — timestamp trails (song-first).
const FULL_RE = /^3 Doors Down - Away from the Sun - \d{4}-\d{2}-\d{2} \d{4}\.png$/;

test('autoSaveFilename: "Artist - Title - <stamp>.png" with both present (song-first)', () => {
    const core = loadDetectionCore();
    assert.match(core.autoSaveFilename({ artist: '3 Doors Down', title: 'Away from the Sun' }), FULL_RE);
});

test('autoSaveFilename: omits the artist (and the separator) when unknown', () => {
    const core = loadDetectionCore();
    const fn = core.autoSaveFilename({ title: 'Sky Sanctuary Zone' });
    assert.match(fn, /^Sky Sanctuary Zone - \d{4}-\d{2}-\d{2} \d{4}\.png$/);
    assert.doesNotMatch(fn, /undefined/);
});

test('autoSaveFilename: falls back to "Song" when the title is missing/blank', () => {
    const core = loadDetectionCore();
    assert.match(core.autoSaveFilename({}), /^Song - \d{4}-\d{2}-\d{2} \d{4}\.png$/);
    assert.match(core.autoSaveFilename({ title: '   ' }), /^Song - \d{4}-\d{2}-\d{2} \d{4}\.png$/);
});

test('autoSaveFilename: always ends .png and carries a sortable timestamp', () => {
    const core = loadDetectionCore();
    const fn = core.autoSaveFilename({ artist: 'A', title: 'B' });
    assert.ok(fn.endsWith('.png'));
    assert.match(fn, /\d{4}-\d{2}-\d{2} \d{4}/);
});
