// Offline matching harness for the desktop ML (Basic Pitch) bridge path.
//
// Replays a fixed detect-stream — the exact detectNotes() frames the JUCE
// engine produced for a known recording — through the REAL screen.js
// matchNotes()/checkMisses() pipeline, then reads det.getStats(). This makes
// matchNotes() tuning a measured number instead of a live-take guess.
//
//   node tools/match-harness.js <detectstream.json> <diagnostic.json>
//
//   detectstream.json : dumped by slopsmith-desktop's mlnd_bench —
//                       { offset, polls: [ { t, notes:[{midi,confidence,
//                       onsetMs,onsetSeq}] } ] }, chart-aligned.
//   diagnostic.json   : a note_detect diagnostic export — its .events[]
//                       supply the chart (single notes only; see below).
//
// Scope: SINGLE notes only. The diagnostic logs one aggregate row per chord
// (no per-string constituents), so chords can't be reconstructed here — the
// chord path goes through the native scoreChord IPC anyway. getChords()
// returns []; the score is directly comparable to the diagnostic's
// summary.singles.accuracy and mlnd_bench's one-onset-one-note prediction.

const fs = require('node:fs');
const path = require('node:path');
const { loadDetectionCore } = require('../test/_loader.js');

function die(msg) { console.error('match-harness: ' + msg); process.exit(1); }

const streamPath = process.argv[2];
const diagPath = process.argv[3];
if (!streamPath || !diagPath) die('usage: match-harness.js <detectstream.json> <diagnostic.json>');

const stream = JSON.parse(fs.readFileSync(streamPath, 'utf8'));
const diag = JSON.parse(fs.readFileSync(diagPath, 'utf8'));
const polls = stream.polls || [];
if (!polls.length) die('detect-stream has no polls');

// ── Build the chart (single notes only) ────────────────────────────────────
const notes = [];
for (const e of diag.events || []) {
    if (e.chord) continue;
    const tf = e.tf || '';
    notes.push({
        t: e.t, s: e.s, f: e.f,
        sus: Number.isFinite(e.sus) ? e.sus : 0,
        ho: tf.includes('h'),
        po: tf.includes('p'),
        b: tf.includes('B'),
    });
}
notes.sort((a, b) => a.t - b.t);

// ── Driver state, mutated by the sandbox stubs below ────────────────────────
let clock = -10;                                  // hw.getTime()
let frame = { notes: [], sampleRate: 48000 };     // audio.detectNotes()
const intervals = [];                             // captured setInterval()s

const asyncFn = (v) => async () => v;
const audioStub = {
    isAvailable: asyncFn(true),
    isAudioRunning: asyncFn(true),
    startAudio: asyncFn(undefined),
    isMlNoteDetection: asyncFn(true),
    getSampleRate: asyncFn(48000),
    getLevels: asyncFn({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
    getPitchDetection: asyncFn({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
    detectNotes: async () => frame,
    scoreChord: asyncFn({ score: 0, hitStrings: 0, totalStrings: 0, isHit: false, results: [] }),
};

const { createNoteDetector } = loadDetectionCore({
    sandboxBeforeRun(sb) {
        sb.setInterval = (fn, delay) => {
            if (typeof fn === 'function') {
                intervals.push({ fn, delay: delay > 0 ? delay : 1000, next: delay > 0 ? delay : 1000 });
            }
            return intervals.length;
        };
        sb.clearInterval = () => {};
        sb.highway.getTime = () => clock;
        sb.highway.getNotes = () => notes;
        sb.highway.getChords = () => [];
        sb.highway.getSections = () => [];
        sb.highway.getSongInfo = () => ({ tuning: [0, 0, 0, 0, 0, 0], capo: 0 });
        sb.highway.getAvOffset = () => 0;
        sb.window.slopsmithDesktop = { isDesktop: true, platform: 'linux', audio: audioStub };
    },
});

// ── Run ─────────────────────────────────────────────────────────────────────
async function fireDue(vt) {
    // Registration order = detect, bridge-level, checkMisses, gc, HUD — so the
    // detect tick (and its matchNotes) always runs before checkMisses retires.
    for (const iv of intervals) {
        while (iv.next <= vt) {
            await iv.fn();
            iv.next += iv.delay;
        }
    }
}

// Drive one full pass. `clockOffset` shifts the playhead vs the (already
// chart-aligned) detect-stream: matchNotes computes `t = clock - latencyOffset`,
// so feeding `clock = poll.t + clockOffset` is equivalent to running with an
// effective latency of `latencyOffset - clockOffset`. Sweeping clockOffset thus
// sweeps the latency calibration without touching screen.js.
async function runOnce(clockOffset) {
    intervals.length = 0;
    const det = createNoteDetector({ isDefault: false });
    // Standard-tuning 6-string guitar, capo 0 — matches the I'm Alive chart.
    det._harness.setContext({ arrangement: 'guitar', stringCount: 6, tuningOffsets: [0, 0, 0, 0, 0, 0], capo: 0 });

    const ok = await det.enable();
    if (ok === false) die('enable() returned false — bridge stubs rejected');
    await new Promise((r) => setImmediate(r));

    let vt = 0;
    for (const poll of polls) {
        clock = poll.t + clockOffset;
        frame = { notes: poll.notes || [], sampleRate: 48000 };
        vt += 50;
        await fireDue(vt);
    }
    // Drain: advance the clock past the last note so checkMisses retires
    // every still-open chart note as a miss.
    for (let k = 0; k < 120; k++) {
        clock += 0.05;
        vt += 50;
        await fireDue(vt);
    }
    return det;
}

// screen.js bumps latencyOffset to _ND_ML_BRIDGE_LATENCY (0.120) on the ML
// bridge path unless the user dialed their own — the harness hits that path
// (isMlNoteDetection stub returns true), so clockOffset 0 == effective 0.120.
const DEFAULT_LATENCY = 0.120;

async function main() {
    // ── Latency sweep ──────────────────────────────────────────────────────
    // The live "I'm Alive" diagnostic showed detections running ~31ms early
    // (median) with latency_offset_s=0.08 — over-compensation. Sweep the
    // effective latency to find the value that maximises hits.
    const sweep = [];
    for (let off = -0.10; off <= 0.121; off += 0.02) {
        const det = await runOnce(off);
        const s = det.getStats();
        sweep.push({ off, latency: DEFAULT_LATENCY - off, acc: s.accuracy, hits: s.hits, misses: s.misses });
    }
    let best = sweep[0];
    for (const r of sweep) if (r.hits > best.hits) best = r;
    console.log('\n=== latency sweep — ML bridge, single notes ===');
    console.log('latency_offset_s   accuracy   hits/total');
    for (const r of sweep) {
        const mark = r === best ? '  <- best' : '';
        console.log(`  ${r.latency.toFixed(3)}            ${String(r.acc).padStart(3)}%      ` +
            `${r.hits}/${r.hits + r.misses}${mark}`);
    }
    console.log(`\nrecommended latency_offset_s: ${best.latency.toFixed(3)}  ` +
        `(current 0.080 -> ${best.acc}%, was ${sweep.find((r) => Math.abs(r.off) < 1e-6).acc}%)`);

    // ── Full diagnostic at the best offset ─────────────────────────────────
    const det = await runOnce(best.off);
    const s = det.getStats();
    const lastT = notes.length ? notes[notes.length - 1].t : 0;

    // ── Miss classification ────────────────────────────────────────────────
    // Reconstruct the onset list the way mlnd_bench does (per-pitch rising
    // onsetSeq, back-dated by onsetMs), then for every chart note the plugin
    // judged a MISS, ask whether a same-pitch onset was actually available
    // within ±100 ms. Misses with an onset = matchNotes left points on the
    // table (recoverable); misses with none = the detector never saw it.
    const lastSeq = new Map();
    const onsets = [];
    for (const p of polls) {
        for (const n of (p.notes || [])) {
            const prev = lastSeq.get(n.midi);
            if (prev === undefined || n.onsetSeq > prev) {
                lastSeq.set(n.midi, n.onsetSeq);
                onsets.push({ t: p.t - (n.onsetMs < 1e6 ? n.onsetMs / 1000 : 0), midi: n.midi });
            }
        }
    }
    const diagEv = det.getDiagnostic ? (det.getDiagnostic().events || []) : [];
    const missEv = diagEv.filter((e) => !e.chord && e.hit === false);
    let recoverable = 0;
    for (const e of missEv) {
        const has = onsets.some((o) => o.midi === e.ex && Math.abs(o.t - e.t) <= 0.10);
        if (has) recoverable++;
    }
    console.log(`\n=== detail @ latency_offset_s=${best.latency.toFixed(3)} — single notes ===`);
    console.log(`stream:    ${polls.length} polls, ${path.basename(streamPath)}`);
    console.log(`chart:     ${notes.length} single notes (last @ ${lastT.toFixed(1)} s)`);
    console.log(`hits:      ${s.hits}`);
    console.log(`misses:    ${s.misses}`);
    console.log(`accuracy:  ${s.accuracy}%   (${s.hits}/${s.hits + s.misses})`);
    console.log(`streak:    best ${s.bestStreak}`);
    console.log(`\nmisses (${missEv.length}):`);
    console.log(`  recoverable (onset existed ±100ms): ${recoverable}  <- matchNotes headroom`);
    console.log(`  no onset (detector never saw it):   ${missEv.length - recoverable}`);
    const baseline = diag.summary && diag.summary.singles;
    if (baseline) {
        console.log(`\nlive diagnostic singles: ${baseline.hits}/${baseline.hits + baseline.misses}` +
            `  (${Math.round(baseline.accuracy * 100)}%)`);
    }
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
