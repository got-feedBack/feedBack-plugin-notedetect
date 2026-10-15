// notedetect:hit / notedetect:miss carry what a stats or scorecard plugin
// needs without patching note_detect: the judgment's key, named techniques,
// per-string verdicts (which strings of a partial chord rang), the latency
// compensation in effect, the detector path, section and score state.
// All additive — the existing judgment fields are unchanged.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadDetectionCore } = require('./_loader');

async function flush(turns = 6) {
    for (let i = 0; i < turns; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    }
}

async function runAll(intervals) {
    for (const cb of intervals) {
        // eslint-disable-next-line no-await-in-loop
        await cb();
        // eslint-disable-next-line no-await-in-loop
        await flush();
    }
}

// JSON round-trip: plain main-realm data (the vm realm's prototypes would
// trip deepStrictEqual), and proves the payload is serialisable.
const plain = (x) => JSON.parse(JSON.stringify(x));

function sandbox({ notes = [], chords = [], audio = {} } = {}) {
    const intervals = [];
    const events = [];
    let hwTime = 0;
    let sb = null;
    const { createNoteDetector } = loadDetectionCore({
        sandboxBeforeRun(s) {
            sb = s;
            s.setInterval = (cb) => { if (typeof cb === 'function') intervals.push(cb); return intervals.length; };
            s.highway.getNotes = () => notes.map((n) => ({ ...n }));
            s.highway.getChords = () => chords.map((c) => ({ ...c, notes: c.notes.map((n) => ({ ...n })) }));
            s.highway.getSections = () => ([{ name: 'verse', time: 0 }]);
            s.highway.getTime = () => hwTime;
            s.highway.getAvOffset = () => 25;
            s.window.dispatchEvent = (ev) => {
                if (ev && (ev.type === 'notedetect:hit' || ev.type === 'notedetect:miss')) {
                    events.push({ type: ev.type, detail: ev.detail });
                }
                return true;
            };
            s.window.feedBackDesktop = {
                isDesktop: true,
                platform: 'linux',
                audio: Object.assign({
                    isAvailable: async () => true,
                    isAudioRunning: async () => true,
                    startAudio: async () => {},
                    getLevels: async () => ({ inputLevel: 0.3, inputPeak: 0.4, outputLevel: 0, outputPeak: 0 }),
                    getSampleRate: async () => 48000,
                    getPitchDetection: async () => ({ midiNote: -1, confidence: 0, frequency: -1, cents: 0, noteName: '' }),
                }, audio),
            };
        },
    });
    return { createNoteDetector, intervals, events, sb: () => sb, setHwTime: (t) => { hwTime = t; } };
}

test('techniques: wire-format chart flags become names', () => {
    const env = sandbox();
    const names = (n) => plain(env.sb()._ndTechniqueNames(n));
    // Core wire format: sl/slu = -1 means "no slide", bn = bend amount.
    assert.deepEqual(names({ s: 0, f: 5, sl: -1, slu: -1, bn: 0, ho: false, pm: false }), []);
    assert.deepEqual(names({ s: 0, f: 5, sl: 7, bn: 1, pm: true }), ['bend', 'slide', 'palmMute']);
    assert.deepEqual(names({ s: 0, f: 0, sl: -1, hm: true, ho: true, vb: true }), ['harmonic', 'hammerOn', 'vibrato']);
    assert.equal(env.sb()._ndTechniqueNames(null), null);
});

test('engine verifier: a partial chord reports which strings rang', async () => {
    let pushed = null;
    const queue = [];
    const CH = [
        { t: 1.0, s: 0, f: 5, sus: 0, sl: -1, bn: 0, pm: true },
        { t: 1.0, s: 1, f: 7, sus: 0, sl: -1, bn: 0, pm: true },
        { t: 1.0, s: 2, f: 7, sus: 0, sl: -1, bn: 0, pm: true },
    ];
    const env = sandbox({
        notes: CH,
        audio: {
            setChart: async (c) => { pushed = c; return true; },
            getNoteVerdicts: async () => (queue.length ? queue.shift() : []),
        },
    });
    const det = env.createNoteDetector({ isDefault: false });
    det.applySettings({ latencyOffset: 0.06, chordHitRatio: 0.5 });
    await det.enable();
    await flush();
    await runAll(env.intervals);
    assert.ok(pushed, 'chart pushed');
    const ids = Array.from(pushed.notes, (n) => n.id);
    env.setHwTime(1.4);
    queue.push(ids.map((id, i) => ({
        id, detected: i < 2, detectedSongTime: 1.01, centsError: i === 0 ? 4.4 : -3, snr: 7.5,
    })));
    await runAll(env.intervals);

    const ev = env.events.find((e) => e.detail && e.detail.chord);
    assert.ok(ev, 'a chord judgment was emitted');
    assert.equal(ev.type, 'notedetect:hit', '2 of 3 strings at 50% leniency is a hit');
    const d = plain(ev.detail);
    assert.equal(d.key, '1.000_chord', 'the chord id');
    assert.equal(d.noteTime, 1.0);
    assert.equal(d.timingError, 10);
    assert.equal(d.timingState, 'OK');
    assert.equal(d.hitStrings, 2);
    assert.equal(d.totalStrings, 3);
    assert.deepEqual(d.strings.map((x) => [x.s, x.f, x.hit, x.centsError]),
        [[0, 5, true, 4], [1, 7, true, -3], [2, 7, false, -3]]);
    assert.equal(d.strings[0].snr, 7.5);
    assert.equal(d.strings[0].detectedAt, 1.01);
    assert.deepEqual(d.techniques, ['palmMute']);
    assert.equal(d.latencyMs, 60);
    assert.equal(d.avOffsetMs, 25);
    assert.equal(d.detector, 'desktop-engine-verifier');
    assert.equal(d.section, 'verse');
    assert.equal(d.counted, true);
    assert.equal(d.isDefault, false);
    assert.ok(d.points > 0, 'points awarded for the hit');
    assert.equal(d.multiplier, 1);
    assert.equal(d.streak, 1);
    assert.equal(d.verdictAt, 1.4, 'the playhead when the verdict landed');
    assert.equal(d.noteEnd, 1.0, 'no sustain: the chord ends where it starts');
    det.destroy();
    await flush();
});

test('engine verifier: a single-note miss carries the raw engine verdict', async () => {
    let pushed = null;
    const queue = [];
    const env = sandbox({
        notes: [{ t: 1.0, s: 3, f: 2, sus: 0, sl: -1, bn: 1 }],
        audio: {
            setChart: async (c) => { pushed = c; return true; },
            getNoteVerdicts: async () => (queue.length ? queue.shift() : []),
        },
    });
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flush();
    await runAll(env.intervals);
    env.setHwTime(1.6);
    // Heard, but too weak / out of tune to verify: the snr and cents tell
    // the two apart.
    queue.push([{ id: pushed.notes[0].id, detected: false, centsError: 38, snr: 1.2 }]);
    await runAll(env.intervals);
    const ev = env.events.find((e) => e.type === 'notedetect:miss');
    assert.ok(ev, 'a miss was emitted');
    const d = plain(ev.detail);
    assert.deepEqual(d.techniques, ['bend']);
    assert.deepEqual(d.strings, [{ s: 3, f: 2, hit: false, centsError: 38, snr: 1.2 }]);
    assert.equal(d.counted, true);
    assert.equal(d.streak, 0);
    det.destroy();
    await flush();
});

test('scoreChord path: a missed chord reports the best frame\'s strings', async () => {
    const env = sandbox({
        chords: [{ t: 1.0, notes: [{ s: 0, f: 3, sl: -1 }, { s: 1, f: 5, sl: -1 }, { s: 2, f: 5, sl: -1 }] }],
        audio: {
            // Only the root rings on every frame: 1 of 3 strings.
            scoreChord: async (ctx) => ({
                score: 1 / 3, hitStrings: 1, totalStrings: 3, isHit: false, voicingHit: false,
                results: ctx.notes.map((n, i) => ({
                    s: n.s, f: n.f, hit: i === 0, bandEnergy: 0.1, centsDiff: i === 0 ? 2 : null,
                    centsError: i === 0 ? 2 : null,
                })),
            }),
        },
    });
    const det = env.createNoteDetector({ isDefault: true });
    det.applySettings({ latencyOffset: 0 });
    await det.enable();
    await flush();
    env.setHwTime(1.0);
    await runAll(env.intervals);
    env.setHwTime(3.0);   // well past the window: checkMisses retires it
    await runAll(env.intervals);
    const ev = env.events.find((e) => e.detail && e.detail.chord);
    assert.ok(ev, 'the chord was retired');
    assert.equal(ev.type, 'notedetect:miss');
    const d = plain(ev.detail);
    assert.equal(d.key, '1.000_chord');
    assert.deepEqual(d.strings.map((x) => [x.s, x.hit, x.centsError]),
        [[0, true, 2], [1, false, null], [2, false, null]]);
    assert.equal(d.latencyMs, 0);
    assert.equal(d.isDefault, true);
    assert.equal(typeof d.detector, 'string');
    det.destroy();
    await flush();
});

test('engine verifier: a sustained chord hit says it landed after the note ended', async () => {
    // The engine judges a sustained chord only once its sustain closes, so
    // the verdict arrives long after a renderer would cull the gem (0.75 s
    // after its start in highway_3d). verdictAt / noteEnd let it notice.
    let pushed = null;
    const queue = [];
    const env = sandbox({
        notes: [
            { t: 1.0, s: 0, f: 5, sus: 1.5, sl: -1, bn: 0 },
            { t: 1.0, s: 1, f: 7, sus: 0.5, sl: -1, bn: 0 },
        ],
        audio: {
            setChart: async (c) => { pushed = c; return true; },
            getNoteVerdicts: async () => (queue.length ? queue.shift() : []),
        },
    });
    const det = env.createNoteDetector({ isDefault: false });
    await det.enable();
    await flush();
    await runAll(env.intervals);
    env.setHwTime(2.7);
    queue.push(Array.from(pushed.notes, (n) => ({ id: n.id, detected: true, detectedSongTime: 1.0, centsError: 0, snr: 9 })));
    await runAll(env.intervals);
    const ev = env.events.find((e) => e.detail && e.detail.chord);
    assert.ok(ev, 'a chord judgment was emitted');
    assert.equal(ev.type, 'notedetect:hit');
    const d = plain(ev.detail);
    assert.equal(d.noteTime, 1.0);
    assert.equal(d.noteEnd, 2.5, 'the longest member sustain');
    assert.equal(d.verdictAt, 2.7);
    det.destroy();
    await flush();
});
