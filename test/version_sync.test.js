'use strict';

// plugin.json is the source of truth for the note_detect plugin's
// version — that's the metadata slopsmith's plugin loader reads when
// it advertises the plugin to the rest of the app. But there are two
// other places that need to stay in sync, and contributors won't
// remember them all on every bump:
//
//   1. package.json — npm reads it for `npm version` + publishing
//      tooling; out of sync looks weird in `npm ls` etc.
//   2. screen.js's `_ND_VERSION` constant — stamped into every
//      diagnostic JSON export so the payload can be tied back to
//      the exact build that produced it. If this drifts, diagnostic
//      consumers correlating bug reports to plugin versions get
//      misleading data.
//
// CI failing fast on a drift is far better than discovering it at
// release time. This test does the cheapest possible thing: read all
// three, assert equality, surface a clear message naming both files
// when they don't match.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_DIR = path.resolve(__dirname, '..');

function _readJson(rel) {
    return JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, rel), 'utf8'));
}

test('plugin.json, package.json, and screen.js _ND_VERSION are all in sync', () => {
    const pluginJson = _readJson('plugin.json');
    const packageJson = _readJson('package.json');

    // plugin.json is the canonical source — read first so any mismatch
    // message points at the right field to update.
    const canonical = pluginJson.version;
    assert.ok(canonical, 'plugin.json must declare a version');
    assert.match(canonical, /^\d+\.\d+\.\d+/, 'plugin.json version should be semver');

    assert.strictEqual(
        packageJson.version, canonical,
        `package.json version (${packageJson.version}) does not match plugin.json (${canonical}). ` +
        `plugin.json is the source of truth — update package.json to match.`,
    );

    // Find _ND_VERSION in screen.js. Scoped to the exact declaration
    // line so a stray reference in a comment can't satisfy the test.
    const screen = fs.readFileSync(path.join(PLUGIN_DIR, 'screen.js'), 'utf8');
    const m = screen.match(/^\s*const\s+_ND_VERSION\s*=\s*['"]([^'"]+)['"]/m);
    assert.ok(m, 'screen.js must declare `const _ND_VERSION = "..."`');
    assert.strictEqual(
        m[1], canonical,
        `screen.js _ND_VERSION (${m[1]}) does not match plugin.json (${canonical}). ` +
        `plugin.json is the source of truth — update _ND_VERSION in screen.js to match.`,
    );
});
