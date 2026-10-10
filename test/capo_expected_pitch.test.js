// Capo charts: expected pitch follows the Rocksmith fret convention.
//
// A capo chart writes FRETTED notes at their absolute fret (counted from the
// nut) and only fret 0 means "open", which with a capo on sounds at the capo
// fret. A capo-4 E major shape is charted A7 D6 G0 B5: A7 = E3, D6 = G#3,
// G0 (at the capo) = B3, B5 = E4. Adding the capo to every fret expected each
// fretted note 4 semitones sharp (A7 → G#3), so capo charts barely scored.
//
// The desktop engine computes open + capo + fret itself, so the bridge hands
// it capo 0 plus open notes rewritten to the capo fret — the same pitches.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

function loadWithSandbox(before) {
    let sb = null;
    const core = loadDetectionCore({
        sandboxBeforeRun(s) { sb = s; if (before) before(s); },
    });
    return { core, sb };
}

const G6 = [0, 0, 0, 0, 0, 0];

test('capo 4: fretted notes are absolute, fret 0 sounds at the capo', () => {
    const { sb } = loadWithSandbox();
    const m = (s, f) => sb._ndMidiFromStringFret(s, f, 'guitar', 6, G6, 4);
    // E major at capo 4: A7 D6 G0 B5 → E3 G#3 B3 E4.
    assert.equal(m(1, 7), 52, 'A string fret 7 is E3, not G#3');
    assert.equal(m(2, 6), 56, 'D string fret 6 is G#3');
    assert.equal(m(3, 0), 59, 'open G under capo 4 is B3');
    assert.equal(m(4, 5), 64, 'B string fret 5 is E4');
    // Open low E under the capo is G#2.
    assert.equal(m(0, 0), 44);
});

test('no capo: expected pitch is unchanged (open + fret)', () => {
    const { sb } = loadWithSandbox();
    const m = (s, f, capo) => sb._ndMidiFromStringFret(s, f, 'guitar', 6, G6, capo);
    assert.equal(m(0, 0, 0), 40);
    assert.equal(m(1, 7, 0), 52);
    assert.equal(m(5, 12, undefined), 76);
});

test('capo + tuning offset: the offset still applies to the absolute fret', () => {
    const { sb } = loadWithSandbox();
    // Drop D (low string -2), capo 3: low string fret 5 is D2 + 5 = G2.
    assert.equal(sb._ndMidiFromStringFret(0, 5, 'guitar', 6, [-2, 0, 0, 0, 0, 0], 3), 43);
    // Open low string under the capo: D2 + 3 = F2.
    assert.equal(sb._ndMidiFromStringFret(0, 0, 'guitar', 6, [-2, 0, 0, 0, 0, 0], 3), 41);
});

test('capo 4: display fallback reports the fret counted from the nut', () => {
    const { sb } = loadWithSandbox();
    // E3 (52): first match is the low E string. Capo 4 → absolute fret 12,
    // the fret the chart would write for it.
    const r = sb._ndMidiToStringFret(52, 'guitar', 6, G6, 4);
    assert.equal(r.string, 0);
    assert.equal(r.fret, 12);
    // A note sounding at the capo maps to fret 0 (open), as charted.
    const open = sb._ndMidiToStringFret(44, 'guitar', 6, G6, 4);
    assert.equal(open.string, 0);
    assert.equal(open.fret, 0);
    // And the round trip agrees with the expected-pitch mapping.
    assert.equal(sb._ndMidiFromStringFret(r.string, r.fret, 'guitar', 6, G6, 4), 52);
});

test('engine payload: capo 0 plus open notes moved to the capo fret', () => {
    const { sb } = loadWithSandbox();
    const out = sb._ndEngineCapoPayload({
        capo: 4, arrangement: 'guitar', notes: [{ s: 3, f: 0, ho: true }, { s: 1, f: 7 }],
    });
    assert.equal(out.capo, 0);
    assert.deepEqual(out.notes.map(n => ({ s: n.s, f: n.f })), [{ s: 3, f: 4 }, { s: 1, f: 7 }]);
    assert.equal(out.notes[0].ho, true, 'technique flags travel with the rewritten note');
    // No capo → the very same payload object.
    const plain = { capo: 0, notes: [{ s: 0, f: 0 }] };
    assert.equal(sb._ndEngineCapoPayload(plain), plain);
});

async function flush(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

test('desktop engine verifier receives capo 0 and absolute frets for a capo chart', async () => {
    let pushed = null;
    const audio = {
        isAvailable: async () => true,
        isAudioRunning: async () => true,
        startAudio: async () => {},
        getLevels: async () => ({ inputLevel: 0, inputPeak: 0, outputLevel: 0, outputPeak: 0 }),
        getSampleRate: async () => 48000,
        getPitchDetection: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
        setChart: async (chart) => { pushed = chart; return true; },
        getNoteVerdicts: async () => [],
    };
    const intervals = [];
    const { core } = loadWithSandbox((sb) => {
        sb.setInterval = (cb) => { if (typeof cb === 'function') intervals.push(cb); return intervals.length; };
        sb.highway.getSongInfo = () => ({ arrangement: 'Rhythm', tuning: G6, capo: 4 });
        sb.highway.getNotes = () => ([
            { t: 1.0, s: 1, f: 7, sus: 0 },
            { t: 1.0, s: 2, f: 6, sus: 0 },
            { t: 1.0, s: 3, f: 0, sus: 0 },
            { t: 1.0, s: 4, f: 5, sus: 0 },
        ]);
        sb.highway.getChords = () => ([]);
        sb.highway.getTime = () => 0;
        sb.highway.getAvOffset = () => 0;
        sb.window.feedBackDesktop = { isDesktop: true, platform: 'linux', audio };
    });
    const det = core.createNoteDetector({ isDefault: false });
    await det.enable();
    await flush();
    for (const cb of intervals) {
        if (pushed) break;
        // eslint-disable-next-line no-await-in-loop
        await cb();
        // eslint-disable-next-line no-await-in-loop
        await flush();
    }
    assert.ok(pushed, 'the chart should reach the engine');
    assert.equal(pushed.capo, 0, 'the engine must not add the capo on top of absolute frets');
    const frets = Array.from(pushed.notes, n => `${n.s}:${n.f}`).sort();
    assert.deepEqual(frets, ['1:7', '2:6', '3:4', '4:5']);
    det.destroy();
    await flush();
});
