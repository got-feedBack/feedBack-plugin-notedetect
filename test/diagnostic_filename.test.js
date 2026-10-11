// The built-in calibration pack was renamed in core from
// slopsmith-diagnostic-basic-guitar.sloppak to feedBack-diagnostic-… (core
// #900). Both names must still be recognised as the diagnostic track, with the
// case-insensitive match the library's filenames need.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadDetectionCore } = require('./_loader');

const { filenameLooksDiagnostic, trackMatchesFilename } = loadDetectionCore();

test('current core name (feedBack-…) is a diagnostic track', () => {
    assert.strictEqual(
        filenameLooksDiagnostic('diagnostics-builtin/feedBack-diagnostic-basic-guitar.sloppak'), true);
});

test('legacy name (slopsmith-…) is still a diagnostic track', () => {
    assert.strictEqual(
        filenameLooksDiagnostic('diagnostics-builtin/slopsmith-diagnostic-basic-guitar.sloppak'), true);
});

test('ordinary songs are not diagnostic tracks', () => {
    assert.strictEqual(filenameLooksDiagnostic('Uriah Heep - Shadows Of Grief.feedpak'), false);
    assert.strictEqual(filenameLooksDiagnostic(''), false);
    assert.strictEqual(filenameLooksDiagnostic(null), false);
    // Look-alikes are not the diagnostic pack (same rule as the catalog match).
    assert.strictEqual(filenameLooksDiagnostic('my-feedBack-diagnostic-basic-guitar.sloppak'), false);
    assert.strictEqual(filenameLooksDiagnostic('feedBack-diagnostic-basic-guitar.sloppak.bak'), false);
});

test('the launcher points at the pack core seeds today', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
    assert.match(src,
        /dlcRelativePath: 'diagnostics-builtin\/feedBack-diagnostic-basic-guitar\.sloppak'/);
});

test('the catalog matches only the two real pack names, not any similar suffix', () => {
    const track = { filenameIncludes: ['feedback-diagnostic-basic-guitar.sloppak',
        'slopsmith-diagnostic-basic-guitar.sloppak'] };
    assert.strictEqual(trackMatchesFilename(track,
        'diagnostics-builtin/feedback-diagnostic-basic-guitar.sloppak'), true);
    assert.strictEqual(trackMatchesFilename(track,
        'diagnostics-builtin/slopsmith-diagnostic-basic-guitar.sloppak'), true);
    assert.strictEqual(trackMatchesFilename(track, 'my-own-diagnostic-basic-guitar.sloppak'), false);
    assert.strictEqual(trackMatchesFilename(track, 'my-feedback-diagnostic-basic-guitar.sloppak'), false);
    assert.strictEqual(trackMatchesFilename(track, 'feedback-diagnostic-basic-guitar.sloppak'), true);
    assert.strictEqual(trackMatchesFilename(track, 'sub\\dir\\slopsmith-diagnostic-basic-guitar.sloppak'), true);
    assert.strictEqual(trackMatchesFilename(track, ''), false);
    assert.strictEqual(trackMatchesFilename({ filenameIncludes: 'x.sloppak' }, 'a/x.sloppak'), true);
});

test('the catalog entry reuses the two filename markers', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
    assert.match(src, /filenameIncludes: _ND_DIAGNOSTIC_FILENAME_MARKERS,/);
});
