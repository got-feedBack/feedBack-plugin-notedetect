'use strict';

// JSONC support — JSON with C-style comments (feedpak-spec §8).
//
// Used by tools/harness.js so --chart can point at a .jsonc arrangement
// (JSON with // line and /* */ block comments). The strip regex is
// string-aware: comment-like text inside a JSON string literal is preserved.
// Mirrors the reference implementation in feedpak-spec/tools/validate.py
// and the Python helper in got-feedback/feedback/lib/jsonc.py.
//
// No dependencies — the harness stays dependency-free (package.json has none).

// Match JSON string literals (preserved), // line comments, and /* block */
// comments. A single combined alternation processed by String.replace with a
// callback that keeps strings and replaces comments with the empty string.
const _JSONC_STRIP_RE = /"(?:[^"\\]|\\.)*"|\/\/.*|\/\*[\s\S]*?\*\//g;

function stripJsoncComments(text) {
    return text.replace(_JSONC_STRIP_RE, (m) =>
        m.startsWith('"') ? m : '',
    );
}

function parseJsonc(text) {
    return JSON.parse(stripJsoncComments(text));
}

// Read and parse a JSON/JSONC chart file by path. Files ending in .jsonc are
// stripped of comments; all other files are parsed as plain JSON. UTF-8.
function parseJsonChart(file) {
    const raw = require('node:fs').readFileSync(file, 'utf8');
    if (file.toLowerCase().endsWith('.jsonc')) {
        return parseJsonc(raw);
    }
    return JSON.parse(raw);
}

module.exports = { stripJsoncComments, parseJsonc, parseJsonChart };
