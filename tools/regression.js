#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Regression-harness driver for note_detect.
 *
 * The headless harness scores ONE (audio, chart, settings) combo per
 * run. Tuning iterations want to know "did my code change improve
 * detection across all my fixtures, or did I just overfit one?" —
 * which is what this driver does. It reads a fixtures file, runs the
 * harness against each entry, optionally diffs against a stored
 * baseline JSON, and reports a pass/fail summary.
 *
 *   node tools/regression.js                         # run all fixtures, print summary
 *   node tools/regression.js --baseline baseline.json  # compare against baseline
 *   node tools/regression.js --update-baseline baseline.json  # write current results back as the new baseline
 *
 * Fixtures live at tools/regression-fixtures.json — a list of
 * { name, audio, chart, args } entries. `audio` paths may be absolute
 * or relative-to-the-plugin-repo, so contributors who keep their
 * reference recordings under `static/note_detect_recordings/` of a
 * sibling slopsmith checkout can point at them via `../../static/...`.
 * Missing audio files are reported but don't crash the run — useful
 * for fixtures lists that bundle local + collaborator-private
 * recordings, where each contributor sees only what they have.
 *
 * The driver exits with code 1 if --baseline was supplied and any
 * fixture's hit count regressed. Useful for pre-PR self-checks; not
 * wired into npm test (yet) because the audio is contributor-private.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const { values: args } = parseArgs({
    options: {
        fixtures: { type: 'string', default: 'tools/regression-fixtures.json' },
        baseline: { type: 'string' },
        'update-baseline': { type: 'string' },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false, short: 'h' },
    },
});

if (args.help) {
    process.stdout.write(`Usage: node tools/regression.js [options]\n\n` +
        `  --fixtures <path>          (default: tools/regression-fixtures.json)\n` +
        `  --baseline <path>          compare results against the JSON at <path>; exit 1 on regression\n` +
        `  --update-baseline <path>   write current results to <path> as the new baseline\n` +
        `  --verbose                  forward --verbose to each harness invocation\n`);
    process.exit(0);
}

const repoRoot = path.resolve(__dirname, '..');
const fixturesPath = path.resolve(repoRoot, args.fixtures);
if (!fs.existsSync(fixturesPath)) {
    process.stderr.write(`[regression] fixtures file not found: ${fixturesPath}\n`);
    process.stderr.write(`             Create one — see tools/regression-fixtures.example.json for shape.\n`);
    process.exit(2);
}
let fixtures;
try {
    fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
} catch (e) {
    process.stderr.write(`[regression] fixtures file is not valid JSON: ${fixturesPath}\n`);
    process.stderr.write(`             ${e.message}\n`);
    process.exit(2);
}
if (!Array.isArray(fixtures) || fixtures.length === 0) {
    process.stderr.write(`[regression] fixtures file has no entries\n`);
    process.exit(2);
}

const harnessJs = path.resolve(__dirname, 'harness.js');
const results = [];

for (const [idx, fx] of fixtures.entries()) {
    // Validate the fixture's shape BEFORE path.resolve, which throws
    // TypeError on a non-string and would crash the whole run for the
    // one malformed entry. Surface a clear error instead so the user
    // can fix that line and re-run.
    const fxName = (typeof fx?.name === 'string' && fx.name) || `<unnamed fixture #${idx}>`;
    if (!fx || typeof fx !== 'object') {
        process.stdout.write(`[skip] ${fxName}  (fixture is not an object)\n`);
        results.push({ name: fxName, status: 'skipped', reason: 'invalid-fixture' });
        continue;
    }
    if (typeof fx.audio !== 'string' || !fx.audio
        || typeof fx.chart !== 'string' || !fx.chart) {
        process.stdout.write(`[skip] ${fxName}  (fixture missing required string field: audio | chart)\n`);
        results.push({ name: fxName, status: 'skipped', reason: 'invalid-fixture' });
        continue;
    }
    if (fx.args !== undefined && !Array.isArray(fx.args)) {
        process.stdout.write(`[skip] ${fxName}  (fixture 'args' must be an array if present)\n`);
        results.push({ name: fxName, status: 'skipped', reason: 'invalid-fixture' });
        continue;
    }
    // Each element must be a string — spawnSync throws TypeError on a
    // non-string in argv and would abort the whole regression run. A
    // contributor writing `"--frame-size", 4096` (number instead of
    // string) in the fixtures JSON is the realistic case.
    if (Array.isArray(fx.args) && !fx.args.every(a => typeof a === 'string')) {
        process.stdout.write(`[skip] ${fxName}  (fixture 'args' must be an array of strings)\n`);
        results.push({ name: fxName, status: 'skipped', reason: 'invalid-fixture' });
        continue;
    }
    const audio = path.resolve(repoRoot, fx.audio);
    const chart = path.resolve(repoRoot, fx.chart);
    if (!fs.existsSync(audio)) {
        process.stdout.write(`[skip] ${fxName}  (audio missing: ${fx.audio})\n`);
        results.push({ name: fxName, status: 'skipped', reason: 'audio-missing' });
        continue;
    }
    if (!fs.existsSync(chart)) {
        process.stdout.write(`[skip] ${fxName}  (chart missing: ${fx.chart})\n`);
        results.push({ name: fxName, status: 'skipped', reason: 'chart-missing' });
        continue;
    }
    const tmpOut = path.join(require('node:os').tmpdir(), `regression_${process.pid}_${results.length}.json`);
    const argv = [harnessJs, '--audio', audio, '--chart', chart, '--out', tmpOut, ...(fx.args || [])];
    if (args.verbose) argv.push('--verbose');
    try {
        const run = spawnSync(process.execPath, argv, { encoding: 'utf8' });
        // spawnSync reports failure two ways: `run.error` is set when
        // the spawn itself failed (bad execPath, EACCES, ENOENT), and
        // `run.status` is non-zero when the child started but exited
        // unhappily. We were only checking the latter — a spawn
        // failure showed up as a misleading "harness exit null".
        if (run.error) {
            process.stdout.write(`[fail] ${fxName}  (spawn failed: ${run.error.message})\n`);
            results.push({ name: fxName, status: 'error', reason: `spawn: ${run.error.message}` });
            continue;
        }
        if (run.status !== 0) {
            process.stdout.write(`[fail] ${fxName}  (harness exit ${run.status})\n`);
            if (args.verbose) process.stderr.write(run.stderr || '');
            results.push({ name: fxName, status: 'error', reason: run.stderr || 'unknown' });
            continue;
        }
        // Try/finally so a malformed harness output (truncated write,
        // un-parseable JSON) doesn't leak the temp file across runs.
        let diag;
        try {
            diag = JSON.parse(fs.readFileSync(tmpOut, 'utf8'));
        } catch (e) {
            process.stdout.write(`[fail] ${fxName}  (could not parse harness output: ${e.message})\n`);
            results.push({ name: fxName, status: 'error', reason: `parse: ${e.message}` });
            continue;
        }
        // Treat a missing/malformed `summary` the same way as a parse
        // failure — schema drift, truncated-but-still-parseable writes,
        // or a future harness build that renames fields would otherwise
        // throw a TypeError mid-loop and abort the entire run.
        const summary = diag && diag.summary;
        if (!summary || !Number.isFinite(summary.hits) || !Number.isFinite(summary.total)) {
            process.stdout.write(`[fail] ${fxName}  (harness output missing summary.hits/total)\n`);
            results.push({ name: fxName, status: 'error', reason: 'invalid-summary' });
            continue;
        }
        const hits = summary.hits;
        const total = summary.total;
        const pure = (diag.miss_breakdown || {}).pure || 0;
        const chord = (diag.miss_breakdown || {}).chordPartial || 0;
        results.push({
            name: fxName, status: 'ok',
            hits, total, accuracy: total > 0 ? hits / total : 0,
            pure, chord,
        });
    } finally {
        // Always clean up the temp file, regardless of how the run
        // exited. Previously the unlink only fired after a successful
        // parse, so parse failures + spawn errors left growing crud
        // in /tmp across runs.
        try { fs.unlinkSync(tmpOut); } catch (_) { /* already gone */ }
    }
}

// Build comparison table. If --baseline was supplied but the file
// doesn't exist, error out — silently degrading to "no baseline, exit 0"
// turns a typo'd path into a clean-looking run that secretly compared
// nothing. Far worse than just shouting at the user.
let baseline = null;
if (args.baseline) {
    const baselinePath = path.resolve(repoRoot, args.baseline);
    if (!fs.existsSync(baselinePath)) {
        process.stderr.write(`[regression] --baseline file not found: ${baselinePath}\n`);
        process.stderr.write(`             (run with --update-baseline first to create one)\n`);
        process.exit(2);
    }
    try {
        baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    } catch (e) {
        process.stderr.write(`[regression] --baseline file is not valid JSON: ${e.message}\n`);
        process.exit(2);
    }
}
const baselineMap = new Map();
if (baseline) {
    // Guard against malformed / older-schema baseline files. Iterating a
    // missing or non-array `results` would throw mid-run and abort the
    // whole regression; surface a clear schema mismatch instead.
    if (!Array.isArray(baseline.results)) {
        process.stderr.write(`[regression] --baseline file has no 'results' array (schema mismatch): ${args.baseline}\n`);
        process.stderr.write(`             expected shape: { schema, generated_at, results: [{name, hits, ...}, ...] }\n`);
        process.exit(2);
    }
    for (const r of baseline.results) {
        if (r && typeof r.name === 'string') baselineMap.set(r.name, r);
    }
}

const colW = { name: 36, hits: 12, pure: 8, chord: 8, delta: 10 };
function pad(s, w) {
    s = String(s);
    return s.length >= w ? s : s + ' '.repeat(w - s.length);
}
process.stdout.write('\n');
process.stdout.write(
    pad('fixture', colW.name) +
    pad('hits/total', colW.hits) +
    pad('pure', colW.pure) +
    pad('chordP', colW.chord) +
    (baseline ? pad('Δhits', colW.delta) : '') +
    '\n');
process.stdout.write('-'.repeat(colW.name + colW.hits + colW.pure + colW.chord + (baseline ? colW.delta : 0)) + '\n');

// Squash multi-line / oversized reasons (e.g. a harness stderr spill)
// to a single line so they don't shred the tabular summary. Full
// stderr is already echoed under --verbose at the call site above.
function _oneLine(s) {
    if (s == null) return 'unknown';
    const flat = String(s).replace(/\s+/g, ' ').trim();
    return flat.length > 120 ? flat.slice(0, 117) + '...' : (flat || 'unknown');
}

let regressed = 0;
let improved = 0;
for (const r of results) {
    if (r.status !== 'ok') {
        process.stdout.write(pad(r.name, colW.name) + '  ' + r.status + ' (' + _oneLine(r.reason) + ')\n');
        continue;
    }
    let deltaCell = '';
    if (baseline) {
        const b = baselineMap.get(r.name);
        if (b && Number.isFinite(b.hits)) {
            const d = r.hits - b.hits;
            if (d > 0) improved++;
            if (d < 0) regressed++;
            deltaCell = pad((d > 0 ? '+' : '') + d + ' (' + b.hits + '→' + r.hits + ')', colW.delta);
        } else {
            deltaCell = pad('new', colW.delta);
        }
    }
    process.stdout.write(
        pad(r.name, colW.name) +
        pad(`${r.hits}/${r.total} (${Math.round(r.accuracy * 100)}%)`, colW.hits) +
        pad(String(r.pure), colW.pure) +
        pad(String(r.chord), colW.chord) +
        deltaCell + '\n');
}

if (args['update-baseline']) {
    const outPath = path.resolve(repoRoot, args['update-baseline']);
    const payload = {
        schema: 'note_detect.regression.v1',
        generated_at: new Date().toISOString(),
        results: results.filter(r => r.status === 'ok'),
    };
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
    process.stdout.write(`\nWrote new baseline → ${outPath}\n`);
}

if (baseline) {
    process.stdout.write(`\nvs baseline: ${improved} improved, ${regressed} regressed\n`);
    if (regressed > 0) process.exit(1);
}
