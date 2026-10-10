// Bend / slide technique flags must be read off core's WIRE format.
//
// Core's highway (lib/song.py note_to_wire) sends `sl` / `slu` as the
// slide-to fret with -1 meaning "no slide", and the bend amount as `bn`
// (0 = none) — there is no `b` key. note_detect used to read `!!cn.sl` /
// `cn.b`, so every plain note (sl: -1) looked like a slide and got the
// widened pitch window, while real bends were never seen at all.
// _ndHasSlide / _ndHasBend read the wire numbers AND the booleans
// note_detect's own payloads carry (calibration lab, verify targets, the
// engine chart), and every consumer goes through them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');
const { sine } = require('./_signals');

const core = loadDetectionCore();

// A plain note exactly as the highway WebSocket delivers it.
const WIRE_PLAIN = { t: 1.0, s: 1, f: 0, sus: 0, sl: -1, slu: -1, bn: 0, ho: false, po: false, hm: false };

test('hasSlide: wire -1 is "no slide"; a slide-to fret (incl. 0) or unpitched slide is a slide', () => {
    assert.equal(core.hasSlide(WIRE_PLAIN), false);
    assert.equal(core.hasSlide({ ...WIRE_PLAIN, sl: 7 }), true);
    assert.equal(core.hasSlide({ ...WIRE_PLAIN, sl: 0 }), true);
    assert.equal(core.hasSlide({ ...WIRE_PLAIN, slu: 3 }), true);
    assert.equal(core.hasSlide({ s: 1, f: 0 }), false, 'keys omitted → no slide');
    assert.equal(core.hasSlide(null), false);
});

test('hasSlide: note_detect\'s own boolean payloads still read correctly', () => {
    assert.equal(core.hasSlide({ sl: true }), true);
    assert.equal(core.hasSlide({ sl: false }), false);
});

test('hasBend: wire `bn` amount, plus the legacy boolean `b`', () => {
    assert.equal(core.hasBend(WIRE_PLAIN), false);
    assert.equal(core.hasBend({ ...WIRE_PLAIN, bn: 1 }), true);
    assert.equal(core.hasBend({ ...WIRE_PLAIN, bn: 0.5 }), true);
    assert.equal(core.hasBend({ b: true }), true);
    assert.equal(core.hasBend({ b: false }), false);
    assert.equal(core.hasBend(null), false);
});

// ── _ndScoreChord: the widened (100¢) bend/slide pitch window ──────────────

const SR = 48000;
const GUITAR_6 = [0, 0, 0, 0, 0, 0];
// A2 (string 1, open) = 110 Hz; play it 70¢ sharp — outside a 50¢ window,
// inside the 100¢ bend/slide window.
const SHARP_A2 = sine(110 * Math.pow(2, 70 / 1200), SR, 16384 / SR);
const score = (note) => core.scoreChord(SHARP_A2, SR, [note], 'guitar', 6, GUITAR_6, 0, 50, 0.5);

test('scoreChord: a plain wire-format note keeps the normal pitch window', () => {
    const r = score({ ...WIRE_PLAIN });
    assert.equal(r.hitStrings, 0,
        `a 70¢-sharp plain note must miss at 50¢ — sl:-1 is not a slide (centsDiff=${r.results[0].centsDiff})`);
});

test('scoreChord: wire-format slides and bends still get the widened window', () => {
    assert.equal(score({ ...WIRE_PLAIN, sl: 2 }).hitStrings, 1, 'slide (sl: 2)');
    assert.equal(score({ ...WIRE_PLAIN, bn: 1 }).hitStrings, 1, 'bend (bn: 1) — was never detected before');
    assert.equal(score({ s: 1, f: 0, b: true }).hitStrings, 1, 'legacy boolean b');
});

// ── Desktop engine: the chart pushed to the native verifier ────────────────
//
// The engine (feedBack-desktop ChordScorer) coerces `b` / `sl` to bool and
// widens its pitch window on either, so the JS must hand it real booleans.

async function flushPendingAsync(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

test('engine chart: wire-format flags become correct b / sl booleans', async () => {
    const chartNotes = [
        { ...WIRE_PLAIN, t: 1.0 },
        { ...WIRE_PLAIN, t: 2.0, sl: 5 },
        { ...WIRE_PLAIN, t: 3.0, bn: 1 },
    ];
    const chords = [{ t: 4.0, notes: [{ ...WIRE_PLAIN, s: 0, f: 3, t: 4.0 }, { ...WIRE_PLAIN, s: 2, f: 5, t: 4.0, sl: 7 }] }];
    const charts = [];
    const audio = {
        isAvailable: async () => true,
        isAudioRunning: async () => true,
        startAudio: async () => {},
        getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
        getSampleRate: async () => 48000,
        getPitchDetection: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
        setChart: async (chart) => { charts.push(chart); return true; },
        getNoteVerdicts: async () => [],
    };
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(sb) {
            sb.highway.getNotes = () => chartNotes.map((n) => ({ ...n }));
            sb.highway.getChords = () => chords;
            sb.highway.getTime = () => 0;
            sb.highway.getAvOffset = () => 0;
            sb.window.feedBackDesktop = { isDesktop: true, platform: 'linux', audio };
        },
    });
    const det = createNoteDetector({ isDefault: false });
    await det.enable();
    await flushPendingAsync();

    const chart = charts[charts.length - 1];
    assert.ok(chart, 'a chart should have been pushed to the engine');
    const flags = Array.from(chart.notes, (n) => `${n.t}:${n.s}:b=${n.b},sl=${n.sl}`).sort();
    assert.deepEqual(flags, [
        '1:1:b=false,sl=false',
        '2:1:b=false,sl=true',
        '3:1:b=true,sl=false',
        '4:0:b=false,sl=false',
        '4:2:b=false,sl=true',
    ]);

    det.destroy();
    await flushPendingAsync();
});
