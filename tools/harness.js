#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Headless note_detect harness.
 *
 * Drives the SAME `processFrame` / `matchNotes` / `checkMisses` pipeline
 * the browser uses, off a recorded audio file + an arrangement JSON, and
 * emits a `note_detect.diagnostic.v1` payload identical to what the
 * Settings-page "Download Diagnostic JSON" button produces. The
 * detector's audio path (getUserMedia / AudioContext) isn't available
 * in Node, so we feed Float32 frames in directly via the `_harness`
 * hooks on the createNoteDetector API.
 *
 * From inside this plugin repo:
 *
 *   node tools/harness.js \
 *     --audio  path/to/recording.{wav,ogg,mp3,...} \
 *
 * From the parent slopsmith repo (plugin checked out under plugins/):
 *
 *   node plugins/note_detect/tools/harness.js \
 *     --audio  path/to/recording.{wav,ogg,mp3,...} \
 *     --chart  path/to/arrangements/lead.json     \
 *     --out    result.json                        \
 *     [--method yin|hps]                          \
 *     [--pitch-tolerance 50]                      \
 *     [--pitch-hit-threshold 20]                  \
 *     [--timing-tolerance 0.150]                  \
 *     [--timing-hit-threshold 0.100]              \
 *     [--chord-hit-ratio 0.40]                    \
 *     [--latency 0.080]                           \
 *     [--frame-size 1024]                         \
 *     [--sample-rate 44100]                       \
 *     [--arrangement guitar|bass]                 \
 *     [--string-count 6]                          \
 *     [--av-offset-ms 0]                          \
 *     [--verbose]
 *
 * Decoding uses `ffmpeg` on $PATH (any container's slopsmith-web has it;
 * Windows hosts probably need to install it separately). CREPE is the
 * one detection method not exercised here — its TensorFlow.js model
 * wants WebGL and isn't worth wrestling with for now. YIN + HPS cover
 * the failure modes we're tuning against today.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const { loadDetectionCore } = require('../test/_loader');

// ── WAV (RIFF) reader ──────────────────────────────────────────────
//
// Reads PCM int16 or IEEE float32 WAVs into a mono Float32Array at the
// file's own sample rate, then resamples (linear) if it doesn't match
// the harness's target. Keeps the tool dependency-free for the common
// case — users can produce a WAV from anything (Audacity, ffmpeg, a
// DAW export). For non-WAV input, fall back to ffmpeg on PATH.

function readWavFloat32Mono(file, targetSr) {
    const buf = fs.readFileSync(file);
    if (buf.length < 44 || buf.slice(0, 4).toString('ascii') !== 'RIFF'
        || buf.slice(8, 12).toString('ascii') !== 'WAVE') {
        throw new Error(`not a WAV file (no RIFF/WAVE header): ${file}`);
    }

    // Walk chunks: fmt, data (skip everything else; LIST/INFO/cue/etc.).
    let off = 12;
    let fmt = null, dataOff = -1, dataLen = 0;
    while (off + 8 <= buf.length) {
        const id = buf.slice(off, off + 4).toString('ascii');
        const sz = buf.readUInt32LE(off + 4);
        const next = off + 8 + sz + (sz & 1);  // word-aligned
        if (id === 'fmt ') {
            fmt = {
                formatCode:   buf.readUInt16LE(off + 8),
                channels:     buf.readUInt16LE(off + 10),
                sampleRate:   buf.readUInt32LE(off + 12),
                bitsPerSample: buf.readUInt16LE(off + 22),
            };
        } else if (id === 'data') {
            dataOff = off + 8;
            dataLen = sz;
            break;
        }
        off = next;
    }
    if (!fmt) throw new Error(`WAV ${file}: no "fmt " chunk`);
    if (dataOff < 0) throw new Error(`WAV ${file}: no "data" chunk`);

    const channels = fmt.channels;
    const srcSr = fmt.sampleRate;
    const code = fmt.formatCode;
    const bps = fmt.bitsPerSample;

    // Decode interleaved samples to a flat Float32Array (still in src SR + channels).
    const bytesPerSample = bps >> 3;
    const frameBytes = bytesPerSample * channels;
    const frames = (dataLen / frameBytes) | 0;
    const interleaved = new Float32Array(frames * channels);
    if (code === 3 && bps === 32) {                      // IEEE float32
        for (let i = 0; i < frames * channels; i++) {
            interleaved[i] = buf.readFloatLE(dataOff + i * 4);
        }
    } else if (code === 1 && bps === 16) {               // PCM int16
        for (let i = 0; i < frames * channels; i++) {
            interleaved[i] = buf.readInt16LE(dataOff + i * 2) / 32768;
        }
    } else if (code === 1 && bps === 24) {               // PCM int24
        for (let i = 0; i < frames * channels; i++) {
            const a = buf[dataOff + i * 3];
            const b = buf[dataOff + i * 3 + 1];
            const c = buf[dataOff + i * 3 + 2];
            // little-endian 24-bit signed -> 32-bit signed
            let v = a | (b << 8) | (c << 16);
            if (v & 0x800000) v |= ~0xffffff;
            interleaved[i] = v / 8388608;
        }
    } else {
        throw new Error(`WAV ${file}: unsupported format code=${code} bits=${bps} (need float32 or int16/24 PCM)`);
    }

    // Down-mix to mono (average channels).
    let mono;
    if (channels === 1) {
        mono = interleaved;
    } else {
        mono = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
            let s = 0;
            for (let c = 0; c < channels; c++) s += interleaved[i * channels + c];
            mono[i] = s / channels;
        }
    }

    // Resample (linear) to the harness target SR if the source differs.
    if (srcSr !== targetSr) {
        const ratio = targetSr / srcSr;
        const outLen = Math.floor(frames * ratio);
        const out = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
            const srcPos = i / ratio;
            const i0 = Math.floor(srcPos);
            const i1 = Math.min(i0 + 1, frames - 1);
            const frac = srcPos - i0;
            out[i] = mono[i0] * (1 - frac) + mono[i1] * frac;
        }
        return { samples: out, sourceSampleRate: srcSr };
    }
    return { samples: mono, sourceSampleRate: srcSr };
}

// ── CLI ─────────────────────────────────────────────────────────────
const USAGE = `\
note_detect headless harness

  --audio  <file>       audio file decodable by ffmpeg (required)
  --chart  <file>       arrangement JSON (sloppak wire format, required)
  --out    <file>       output diagnostic JSON path (required)

  --method yin|hps              (default: yin)
  --pitch-tolerance      <c>    cents, outer  (default: 50)
  --pitch-hit-threshold  <c>    cents, clean  (default: 20)
  --timing-tolerance     <s>    seconds, outer (default: 0.150)
  --timing-hit-threshold <s>    seconds, single-note clean (default: 0.100)
  --chord-timing-hit-threshold <s>  seconds, chord clean — chord strums need a wider window than single notes
                                    (default: 0.150 clamped into [timing-hit-threshold, timing-tolerance];
                                     i.e. with --timing-tolerance 0.120 the effective default is 0.120, not 0.150)
  --chord-hit-ratio      <r>    0..1           (default: 0.40)
  --latency              <s>    detector latency comp (default: 0.080)
  --frame-size           <n>    samples per frame (default: 1024)
  --sample-rate          <hz>   decode rate (default: 44100)
  --arrangement guitar|bass     (default: guitar)
  --string-count         <n>    (default: 6)
  --av-offset-ms         <ms>   (default: 0)
  --verbose                     log per-frame progress to stderr
`;

let args;
try {
    args = parseArgs({
        options: {
            audio:                   { type: 'string' },
            chart:                   { type: 'string' },
            out:                     { type: 'string' },
            method:                  { type: 'string', default: 'yin' },
            'pitch-tolerance':       { type: 'string', default: '50' },
            'pitch-hit-threshold':   { type: 'string', default: '20' },
            'timing-tolerance':      { type: 'string', default: '0.150' },
            'timing-hit-threshold':  { type: 'string', default: '0.100' },
            // No CLI default — the runtime default is derived after the
            // timing-tolerance + timing-hit-threshold args are parsed, so
            // a user passing `--timing-tolerance 0.120` doesn't fail
            // validation against a baked-in chord default of 0.150.
            'chord-timing-hit-threshold': { type: 'string' },
            'chord-hit-ratio':       { type: 'string', default: '0.40' },
            'latency':               { type: 'string', default: '0.080' },
            'frame-size':            { type: 'string', default: '1024' },
            'sample-rate':           { type: 'string', default: '44100' },
            'arrangement':           { type: 'string', default: 'guitar' },
            'string-count':          { type: 'string', default: '6' },
            'av-offset-ms':          { type: 'string', default: '0' },
            verbose:                 { type: 'boolean', default: false },
            help:                    { type: 'boolean', default: false },
        },
    }).values;
} catch (e) {
    process.stderr.write('argument error: ' + e.message + '\n\n' + USAGE);
    process.exit(2);
}

if (args.help || !args.audio || !args.chart || !args.out) {
    process.stderr.write(USAGE);
    process.exit(args.help ? 0 : 2);
}

const NUM = (v, k) => {
    const n = Number(v);
    if (!Number.isFinite(n)) {
        process.stderr.write(`bad --${k}: ${v}\n`);
        process.exit(2);
    }
    return n;
};
// Stronger numeric validators. NUM accepts any finite value, but a few
// flags must be positive integers (anything else corrupts frame math
// downstream and silently confuses tuning runs) or live in a known
// range. Validate at CLI parse time so the verbose banner matches the
// actual detector configuration.
const POS_INT = (v, k) => {
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        process.stderr.write(`bad --${k}: ${v} (must be a positive integer)\n`);
        process.exit(2);
    }
    return n;
};
const RATIO_01 = (v, k) => {
    const n = NUM(v, k);
    if (n < 0 || n > 1) {
        process.stderr.write(`bad --${k}: ${v} (must be in [0, 1])\n`);
        process.exit(2);
    }
    return n;
};
// Range validator. Mirrors the in-app clamping in screen.js so harness
// runs reflect what the browser would actually score (the createNoteDetector
// settings loader caps these to the slider ranges; passing a value outside
// would silently get re-clamped on the in-app side and diverge from the
// harness output).
const RANGE = (v, k, min, max) => {
    const n = NUM(v, k);
    if (n < min || n > max) {
        process.stderr.write(`bad --${k}: ${v} (must be in [${min}, ${max}])\n`);
        process.exit(2);
    }
    return n;
};
// Detector hook only honours these two in the headless path; CREPE
// needs WebGL + TensorFlow.js model load and is intentionally not
// wired up here (see the file header). Accepting `crepe` would
// silently fall back to YIN while the verbose banner claimed CREPE
// — misleading any tuning / regression run. Fail fast instead.
const ALLOWED_METHODS = new Set(['yin', 'hps']);
if (!ALLOWED_METHODS.has(args.method)) {
    process.stderr.write(`bad --method: ${args.method} (must be one of: ${[...ALLOWED_METHODS].join(', ')})\n`);
    process.exit(2);
}
const method        = args.method;
const sampleRate    = POS_INT(args['sample-rate'], 'sample-rate');
const frameSize     = POS_INT(args['frame-size'], 'frame-size');
const arrangement   = args.arrangement;
const stringCount   = POS_INT(args['string-count'], 'string-count');
const avOffsetMs    = NUM(args['av-offset-ms'], 'av-offset-ms');
// In-app slider ranges (screen.js createNoteDetector settings loader):
//   pitchTolerance      10..100 cents
//   pitchHitThreshold     5..pitchTolerance cents
//   timingTolerance     0.03..0.3 s
//   timingHitThreshold  0.03..timingTolerance s
//   chordHitRatio       0.25..1.0       (we use 0..1 here to keep
//                                        regression sweeps unconstrained)
// `latencyOffset` isn't slider-clamped today but a negative or wildly
// large value is nonsense for an audio-pipeline delay — gate to [0, 1].
const pitchTolerance    = RANGE(args['pitch-tolerance'], 'pitch-tolerance', 10, 100);
const pitchHitThreshold = RANGE(args['pitch-hit-threshold'], 'pitch-hit-threshold', 5, pitchTolerance);
const timingTolerance    = RANGE(args['timing-tolerance'], 'timing-tolerance', 0.03, 0.3);
const timingHitThreshold = RANGE(args['timing-hit-threshold'], 'timing-hit-threshold', 0.03, timingTolerance);
// Chord threshold is bounded below by the single-note threshold (chord
// scoring should never be stricter than single-note) and above by the
// outer timing tolerance (the candidate window). When the user didn't
// pass --chord-timing-hit-threshold, derive a runtime default from the
// just-parsed timing args: prefer 0.150 (the in-app default), but clamp
// into [timingHitThreshold, timingTolerance] so `--timing-tolerance` /
// `--timing-hit-threshold` sweeps don't fail argument validation on the
// fixed default. Explicit user values still go through the strict
// RANGE() check so a CLI typo like 999 is rejected loudly.
const _CHORD_TIMING_DEFAULT_S = 0.150;
const chordTimingHitThreshold = args['chord-timing-hit-threshold'] !== undefined
    ? RANGE(args['chord-timing-hit-threshold'], 'chord-timing-hit-threshold', timingHitThreshold, timingTolerance)
    : Math.max(timingHitThreshold, Math.min(timingTolerance, _CHORD_TIMING_DEFAULT_S));
const settings = {
    method,
    pitchTolerance,
    pitchHitThreshold,
    timingTolerance,
    timingHitThreshold,
    chordTimingHitThreshold,
    chordHitRatio:      RATIO_01(args['chord-hit-ratio'], 'chord-hit-ratio'),
    latencyOffset:      RANGE(args['latency'], 'latency', 0, 1),
};

// ── Load chart ──────────────────────────────────────────────────────
let chart;
try {
    chart = JSON.parse(fs.readFileSync(args.chart, 'utf8'));
} catch (e) {
    process.stderr.write(`failed to read chart ${args.chart}: ${e.message}\n`);
    process.exit(2);
}
const chartTuning = Array.isArray(chart.tuning) && chart.tuning.length
    ? chart.tuning.slice()
    : new Array(stringCount).fill(0);
const chartCapo = Number.isFinite(chart.capo) ? chart.capo : 0;

// ── Audio decode ───────────────────────────────────────────────────
//
// Try the native WAV reader first (zero dependencies, handles
// int16/int24/float32 mono+stereo at any sample rate, resamples to
// our target). For anything else, fall back to ffmpeg on PATH — same
// failure-mode-friendly error if it isn't installed.

function decodeFloat32Mono(file, targetSr) {
    if (path.extname(file).toLowerCase() === '.wav') {
        const { samples, sourceSampleRate } = readWavFloat32Mono(file, targetSr);
        return Promise.resolve({ samples, decoder: 'native-wav', sourceSampleRate });
    }
    return new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
            '-hide_banner', '-loglevel', 'error',
            '-i', file,
            '-f', 'f32le', '-ac', '1', '-ar', String(targetSr),
            'pipe:1',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        const chunks = [];
        let stderrBuf = '';
        ff.stdout.on('data', (b) => chunks.push(b));
        ff.stderr.on('data', (b) => { stderrBuf += b.toString(); });
        ff.on('error', (e) => {
            if (e.code === 'ENOENT') {
                reject(new Error('ffmpeg not found on PATH (needed for non-WAV input). Either convert to WAV (any DAW / Audacity / `ffmpeg -i x.ogg x.wav`) and re-run, or install ffmpeg.'));
            } else {
                reject(e);
            }
        });
        ff.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`ffmpeg exited ${code}: ${stderrBuf.trim()}`));
                return;
            }
            const buf = Buffer.concat(chunks);
            const n = (buf.byteLength / 4) | 0;
            const samples = new Float32Array(n);
            for (let i = 0; i < n; i++) samples[i] = buf.readFloatLE(i * 4);
            resolve({ samples, decoder: 'ffmpeg', sourceSampleRate: targetSr });
        });
    });
}

// ── Build a chart-aware hw stub ────────────────────────────────────
let currentTimeS = 0;
function makeHwStub() {
    return {
        addDrawHook: () => {},
        removeDrawHook: () => {},
        setNoteStateProvider: () => {},
        getNoteStateProvider: () => null,
        isDefaultRenderer: () => true,
        // Time advances as frames are consumed; updated in main loop.
        getTime: () => currentTimeS,
        getAvOffset: () => avOffsetMs,
        getNotes: () => chart.notes || [],
        getChords: () => chart.chords || [],
        getSections: () => (chart.sections || []).map(s => ({
            name: s.name || '',
            time: Number.isFinite(s.time) ? s.time : (Number.isFinite(s.start_time) ? s.start_time : 0),
        })),
        getSongInfo: () => ({
            title: path.basename(args.audio, path.extname(args.audio)),
            artist: 'note_detect headless harness',
            arrangement,
            tuning: chartTuning,
            capo: chartCapo,
            duration: null,
            format: 'harness',
        }),
        getStringCount: () => stringCount,
    };
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
    if (args.verbose) console.error(`[harness] decoding ${args.audio} at ${sampleRate} Hz mono...`);
    const dec = await decodeFloat32Mono(args.audio, sampleRate);
    const samples = dec.samples;
    // Process every frame including a final partial one — `floor` would
    // drop up to (frameSize − 1) samples off the tail, which on a 44.1
    // kHz / 1024-sample-frame run is ~23 ms that could carry the
    // attack or sustain of the song's final note. The tail frame is
    // zero-padded to frameSize so the detector's autocorrelation
    // doesn't read off the end of the audio buffer.
    const totalFrames = Math.ceil(samples.length / frameSize);
    const totalDuration = samples.length / sampleRate;
    if (args.verbose) {
        console.error(`[harness] decoded ${samples.length} samples (${totalDuration.toFixed(2)} s) via ${dec.decoder}${dec.sourceSampleRate !== sampleRate ? ` (resampled ${dec.sourceSampleRate}→${sampleRate})` : ''} → ${totalFrames} frames × ${frameSize}`);
        console.error(`[harness] chart: ${(chart.notes || []).length} notes, ${(chart.chords || []).length} chords, ${(chart.sections || []).length} sections`);
        console.error(`[harness] method=${method}, pitch-tol=${settings.pitchTolerance}¢, chord-leniency=${settings.chordHitRatio}`);
    }

    // Load screen.js in a vm sandbox with our chart-aware highway.
    const hwStub = makeHwStub();
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sandbox) {
            sandbox.highway = hwStub;
            // Silence the underBuffered + getUserMedia warnings the
            // detector emits — they don't apply in headless mode.
            const origWarn = sandbox.console.warn;
            sandbox.console.warn = (...a) => {
                if (typeof a[0] === 'string' && /undersized buffer|getUserMedia|not available in vm/i.test(a[0])) return;
                origWarn(...a);
            };
        },
    });

    const detector = createNoteDetector({ highway: hwStub });

    // Wire the harness state. Order matters: settings + context first,
    // then enable, then start feeding.
    detector._harness.setSettings(settings);
    detector._harness.setContext({
        arrangement,
        stringCount,
        tuningOffsets: chartTuning,
        capo: chartCapo,
    });
    // Counter reset to be paranoid — loadDetectionCore can sometimes
    // carry tiny amounts of state across construction in the vm.
    detector._resetScoring();
    detector._harness.setEnabled(true);

    // checkMisses runs on a 100 ms interval in production. Drive ticks
    // off the playhead instead of frame counts — `0.1 * sampleRate`
    // isn't always an integer multiple of frameSize (44.1 kHz / 1024
    // → 4 frames per tick ≈ 92.9 ms, which would shift miss-deadline
    // arithmetic vs production). Crossing a 0.1 s boundary fires
    // exactly one tick.
    const TICK_INTERVAL_S = 0.1;
    // Match production: checkMisses fires AFTER its first 100 ms wait
    // (setInterval starts the clock on enable). Starting at 0 would
    // tick at t=0 because `currentTimeS >= nextTickT` is immediately
    // true — schedule the first tick at TICK_INTERVAL_S instead.
    let nextTickT = TICK_INTERVAL_S;

    for (let i = 0; i < totalFrames; i++) {
        const start = i * frameSize;
        // Copy the slice — processFrame may keep references through
        // async detection methods (CREPE), and reusing the typed view
        // across frames would corrupt the in-flight buffer. The final
        // frame is zero-padded to frameSize (since totalFrames uses
        // ceil); Float32Array zeros on construction, so the loop bound
        // is the only thing that needs to clamp at samples.length.
        const frame = new Float32Array(frameSize);
        const stop = Math.min(start + frameSize, samples.length);
        for (let j = 0; start + j < stop; j++) frame[j] = samples[start + j];
        // eslint-disable-next-line no-await-in-loop
        await detector._harness.feedFrame(frame, sampleRate);
        // Advance the playhead to the END of the frame we just fed
        // BEFORE checking tick boundaries. The earlier formulation used
        // the start-of-frame time, which delayed any 0.1 s boundary
        // landing inside the frame by one whole frame — measurably
        // shifting checkMisses retirement vs production setInterval.
        currentTimeS = ((i + 1) * frameSize) / sampleRate;
        // Tick on every 100 ms boundary the playhead has just crossed.
        // A while-loop handles the (unlikely) case where frameSize is
        // larger than TICK_INTERVAL_S worth of samples and the playhead
        // jumps multiple ticks at once.
        while (currentTimeS >= nextTickT) {
            detector._harness.tick();
            nextTickT += TICK_INTERVAL_S;
        }
        if (args.verbose && (i % Math.max(1, Math.round(TICK_INTERVAL_S * 10 * sampleRate / frameSize))) === 0) {
            process.stderr.write(`  ..${currentTimeS.toFixed(1)}s\r`);
        }
    }
    // Final tick — advance time past the last note's miss window so any
    // pending judgments retire.
    currentTimeS = totalDuration + 2.0;
    detector._harness.tick();
    if (args.verbose) process.stderr.write('\n');

    // Build + augment + write the JSON.
    const diag = detector.getDiagnostic();
    diag.harness = {
        version: '1.0.0',
        node_version: process.version,
        audio_file: path.basename(args.audio),
        chart_file: path.basename(args.chart),
        sample_rate: sampleRate,
        frame_size: frameSize,
        total_frames: totalFrames,
        total_duration_s: +totalDuration.toFixed(3),
    };
    fs.writeFileSync(args.out, JSON.stringify(diag, null, 2));

    const acc = Math.round((diag.summary.accuracy || 0) * 100);
    console.error(`[harness] ${args.out}: ${diag.summary.hits}/${diag.summary.total} hits (${acc}%) — breakdown ${JSON.stringify(diag.miss_breakdown)}`);
}

main().catch((e) => {
    console.error('[harness] failed:', e.message || e);
    if (args.verbose && e.stack) console.error(e.stack);
    process.exit(1);
});
