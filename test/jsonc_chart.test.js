// Tests for tools/jsonc.js — JSONC comment stripping (feedpak-spec §8).
//
// The harness reads --chart as JSON; .jsonc charts must have their // line
// and /* */ block comments stripped before JSON.parse, with comment-like text
// inside JSON string literals preserved. Mirrors the Python helper's tests in
// got-feedback/feedback/tests/test_sloppak_jsonc_load.py.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { stripJsoncComments, parseJsonc, parseJsonChart } = require('../tools/jsonc');

// ── stripJsoncComments ──────────────────────────────────────────────────────

test('stripJsoncComments strips line comments', () => {
    assert.strictEqual(stripJsoncComments('{"a": 1 // c\n}'), '{"a": 1 \n}');
});

test('stripJsoncComments strips block comments', () => {
    assert.strictEqual(stripJsoncComments('{"a": /* x */ 2}'), '{"a":  2}');
});

test('stripJsoncComments strips multiline block comments', () => {
    const text = '{\n  /* multi\n     line */\n  "a": 1\n}';
    assert.strictEqual(stripJsoncComments(text), '{\n  \n  "a": 1\n}');
});

test('stripJsoncComments preserves comment-like text inside strings', () => {
    const text = '{"url": "https://x/y", "note": "// not a comment /* still not */"}';
    // The string contents are untouched — only real comments would be removed.
    assert.strictEqual(stripJsoncComments(text), text);
});

test('stripJsoncComments leaves plain JSON unchanged', () => {
    assert.strictEqual(stripJsoncComments('{"a": 1}'), '{"a": 1}');
});

// ── parseJsonc ──────────────────────────────────────────────────────────────

test('parseJsonc parses with line comment', () => {
    assert.deepStrictEqual(parseJsonc('{"a": 1 // c\n}'), { a: 1 });
});

test('parseJsonc parses with block comment', () => {
    assert.deepStrictEqual(parseJsonc('{"a": /* x */ 2}'), { a: 2 });
});

test('parseJsonc preserves string values that look like comments', () => {
    const out = parseJsonc('{"url": "https://x/y", "n": "// kept /* kept */"}');
    assert.strictEqual(out.url, 'https://x/y');
    assert.strictEqual(out.n, '// kept /* kept */');
});

test('parseJsonc throws on malformed JSON', () => {
    assert.throws(() => parseJsonc('{"a": // broken\n}'), SyntaxError);
});

test('parseJsonc parses plain JSON', () => {
    assert.deepStrictEqual(parseJsonc('{"a": 1}'), { a: 1 });
});

// ── parseJsonChart (path-based, auto-detect .jsonc) ─────────────────────────

function _tmpFile(ext, content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonc-'));
    const file = path.join(dir, `chart${ext}`);
    fs.writeFileSync(file, content, 'utf8');
    return file;
}

test('parseJsonChart reads .jsonc with comments', () => {
    const file = _tmpFile('.jsonc', '// chart\n{"tuning": [0,0,0,0,0,0], "notes": []}');
    assert.deepStrictEqual(parseJsonChart(file), {
        tuning: [0, 0, 0, 0, 0, 0], notes: [],
    });
});

test('parseJsonChart reads plain .json', () => {
    const file = _tmpFile('.json', '{"notes": [{"t": 0.5}]}');
    assert.deepStrictEqual(parseJsonChart(file), { notes: [{ t: 0.5 }] });
});

test('parseJsonChart treats non-.jsonc extensions as plain JSON', () => {
    // A .json file with a // would be invalid plain JSON — confirming the
    // suffix gate (only .jsonc gets the comment stripper).
    const file = _tmpFile('.json', '{"a": 1}');
    assert.deepStrictEqual(parseJsonChart(file), { a: 1 });
});

test('parseJsonChart throws on malformed .jsonc', () => {
    const file = _tmpFile('.jsonc', '{"notes": // broken\n}');
    assert.throws(() => parseJsonChart(file), SyntaxError);
});

test('parseJsonChart reads a realistic arrangement with mixed comments', () => {
    const text = [
        '// lead chart',
        '{',
        '  "name": "Lead",',
        '  "tuning": [0, 0, 0, 0, 0, 0],',
        '  "capo": 0,',
        '  /* TODO: add bends */',
        '  "notes": [{"t": 0.5, "s": 0, "f": 5, "sus": 0}],',
        '  "chords": [],',
        '  "sections": [{"name": "verse // solo", "number": 0, "time": 0.0}]',
        '}',
    ].join('\n');
    const file = _tmpFile('.jsonc', text);
    const out = parseJsonChart(file);
    assert.strictEqual(out.name, 'Lead');
    assert.strictEqual(out.notes.length, 1);
    assert.strictEqual(out.notes[0].f, 5);
    // The // inside the section name string must survive.
    assert.strictEqual(out.sections[0].name, 'verse // solo');
});
