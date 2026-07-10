// Load screen.js into a Node vm context with minimal DOM/browser stubs
// so pure detection functions can be exercised by tests without a browser.
//
// Rationale: screen.js is shipped as a single browser script (no module exports).
// Copy-pasting its functions into a test module would drift. This loader runs
// the real script against stubs and pulls the named top-level function
// declarations off the sandbox.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.join(__dirname, '..', 'screen.js');

function makeSandbox() {
    const noop = () => {};
    const elementStub = new Proxy({}, {
        get: (_, prop) => {
            if (prop === 'style') return {};
            if (prop === 'classList') return { add: noop, remove: noop, toggle: noop };
            if (prop === 'addEventListener' || prop === 'removeEventListener') return noop;
            if (prop === 'appendChild' || prop === 'removeChild') return noop;
            if (prop === 'querySelector' || prop === 'querySelectorAll') return () => null;
            return '';
        },
        set: () => true,
    });

    const documentStub = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => elementStub,
        head: elementStub,
        body: elementStub,
        addEventListener: noop,
    };

    const localStorageStub = {
        getItem: () => null,
        setItem: noop,
        removeItem: noop,
    };

    const navigatorStub = {
        mediaDevices: {
            getUserMedia: () => Promise.reject(new Error('not available in vm')),
            enumerateDevices: () => Promise.resolve([]),
        },
    };

    const sandbox = {
        document: documentStub,
        localStorage: localStorageStub,
        navigator: navigatorStub,
        location: { protocol: 'http:', host: 'localhost', hostname: 'localhost' },
        console,
        // Stubbed setTimeout: invoke the callback synchronously once
        // and return a dummy handle so the playSong-hook bounded
        // retry runs without scheduling anything in the real event
        // loop (keeps the test process from lingering on pending
        // timers). The `window.playSong` stub below resolves on the
        // first attempt, so one synchronous invocation is enough to
        // install the hook in any test that needs it.
        setTimeout: (callback) => {
            if (typeof callback === 'function') callback();
            return 0;
        },
        clearTimeout: noop,
        setInterval: () => 0,
        clearInterval: noop,
        requestAnimationFrame: () => 0,
        cancelAnimationFrame: noop,
        // alert() is exercised by screen.js's startAudio() catch when
        // permission denial bubbles up — tests that drive the
        // getUserMedia fallback need this to exist or they fail with
        // ReferenceError instead of exercising the production code path.
        alert: noop,
        Float32Array, Int16Array, Uint8Array, Array, Map, Set, Date, Math, JSON, Error,
        Promise, CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
        // Highway API stub — plugin's IIFE at bottom reads window.playSong
        highway: {
            getTime: () => 0,
            getNotes: () => [],
            getChords: () => [],
            getSections: () => [],
            getSongInfo: () => ({}),
            getAvOffset: () => 0,
            addDrawHook: noop,
            removeDrawHook: noop,
        },
    };
    // Slopsmith plugin-API stub — drill-mode tests need to drive
    // `loop:restart`, `song:loaded`, `song:ended` synthetically and
    // toggle `getLoop()` between {null,null} and active bounds. Plain
    // listener registry; no EventTarget overhead.
    // Array (not Set) so duplicate registrations are visible to
    // _listenerCount — Set's natural dedupe would hide an accidental
    // double-bind in production code, defeating the "binds exactly
    // once" tests.
    const _listeners = new Map();
    sandbox.slopsmith = {
        on(event, fn) {
            if (!_listeners.has(event)) _listeners.set(event, []);
            _listeners.get(event).push(fn);
        },
        off(event, fn) {
            const arr = _listeners.get(event);
            if (!arr) return;
            // Remove the FIRST matching listener (matches EventTarget
            // semantics — repeated off() calls peel off one at a time).
            const idx = arr.indexOf(fn);
            if (idx !== -1) arr.splice(idx, 1);
        },
        // Test-time helper: fire all handlers for `event` with a
        // CustomEvent-shaped payload `{ detail }`.
        _fire(event, detail) {
            const arr = _listeners.get(event);
            if (!arr) return;
            // Iterate a copy so handlers that re-bind/unbind don't
            // shift the iteration index.
            for (const fn of arr.slice()) fn({ detail });
        },
        // Test-time helper: return the count of currently-registered
        // listeners for an event so tests can assert subscribe/unbind
        // ordering AND catch accidental double-binds.
        _listenerCount(event) {
            const arr = _listeners.get(event);
            return arr ? arr.length : 0;
        },
        // Mutable loop state — tests poke `_loop` directly. Return
        // the raw value so tests can simulate malformed shapes
        // (`{}`, non-object truthy, etc.) and exercise
        // _drillCurrentLoop's defensive handling.
        _loop: { loopA: null, loopB: null },
        getLoop() {
            return this._loop;
        },
        // Host global autoplay/auto-exit contract (slopsmith core exposes
        // these when the "Autoplay & auto-exit" option ships). Tests flip
        // `_autoplayExit` and inspect `_holdCount` / `_releaseCount` to
        // assert the summary claims and performs the return-to-menu.
        _autoplayExit: false,
        get autoplayExit() { return this._autoplayExit; },
        _holdCount: 0,
        _releaseCount: 0,
        holdAutoExit() {
            this._holdCount++;
            const self = this;
            return function release() { self._releaseCount++; };
        },
    };
    // window must reference the sandbox itself so the plugin's
    // `window.playSong = ...` assignments and reads work. Some tests
    // also look up `window.noteDetect` / `window.createNoteDetector`
    // after load; those land on the sandbox under `window`.
    sandbox.window = sandbox;
    // Minimal playSong stub so _ndInstallPlaySongHook completes on
    // the first try (avoids a bounded retry loop in the harness).
    sandbox.playSong = async () => {};
    return sandbox;
}

function loadDetectionCore({ sandboxBeforeRun } = {}) {
    const src = fs.readFileSync(SCRIPT_PATH, 'utf8');
    const sandbox = makeSandbox();
    // Hook for tests that need to inject globals before the plugin's
    // top-level code runs (e.g. window.feedBackDesktop for the desktop
    // bridge path). The hook receives the sandbox object directly so it
    // can mutate navigator/window etc. without round-tripping through
    // exports.
    if (typeof sandboxBeforeRun === 'function') {
        sandboxBeforeRun(sandbox);
    }
    vm.createContext(sandbox);
    // Script may throw while executing setup code that touches DOM edge cases —
    // function declarations at top level still get hoisted onto the sandbox
    // before any thrown error, so we swallow the throw and grab what we need.
    try {
        vm.runInContext(src, sandbox, { filename: 'screen.js' });
    } catch (err) {
        if (process.env.TEST_DEBUG) console.error('[loader] screen.js threw:', err.message);
    }

    const required = [
        '_ndYinDetect', '_ndHpsDetect', '_ndFreqToMidi',
        '_ndMidiFromStringFret', '_ndMidiToStringFret',
        '_ndResolveDisplayFingering', '_ndNearestOctaveCents',
        '_ndCalibrateOffsetMs',
        '_ndStringBandHz', '_ndBandEnergy',
        '_ndConstraintCheckString', '_ndScoreChord',
        '_ndClassifyTiming', '_ndClassifyPitch', '_ndMakeJudgment',
        '_ndMultiplierForStreak', '_ndIsStreakMilestone', '_ndGradeFor',
        '_ndComputeBestDelta', '_ndPickHeroAction',
        'createNoteDetector',
    ];
    const missing = required.filter(name => typeof sandbox[name] !== 'function');
    if (missing.length) {
        throw new Error(`Could not extract functions from screen.js: ${missing.join(', ')}`);
    }

    // Objects created inside the vm sandbox have the sandbox's Object.prototype,
    // so node:assert's deepEqual sees them as structurally-equal-but-not-reference-equal.
    // Rewrap returned {string, fret} objects as plain main-realm literals.
    const rewrapSf = (fn) => (...args) => {
        const r = fn(...args);
        return { string: r.string, fret: r.fret };
    };
    const rewrapYin = (fn) => (...args) => {
        const r = fn(...args);
        return { freq: r.freq, confidence: r.confidence, underBuffered: r.underBuffered };
    };

    // Test-friendly wrappers for the now-explicit pure mapping helpers.
    // The factory refactor removed module-level fallbacks that defaulted
    // to the default singleton's state; tests don't operate through the
    // factory, so defaults live here in the test harness instead.
    // Defaults: guitar, 6 strings, zero offsets, zero capo.
    const guitarDefaultOffsets6 = [0, 0, 0, 0, 0, 0];
    const bassDefaultOffsets4 = [0, 0, 0, 0];
    const bassDefaultOffsets5 = [0, 0, 0, 0, 0];
    const guitarDefaultOffsets7 = [0, 0, 0, 0, 0, 0, 0];

    function defaultOffsetsFor(arrangement, stringCount) {
        if (arrangement === 'bass') {
            return stringCount === 5 ? bassDefaultOffsets5 : bassDefaultOffsets4;
        }
        return stringCount === 7 ? guitarDefaultOffsets7 : guitarDefaultOffsets6;
    }

    const midiFromStringFretWrapped = (string, fret, arrangement = 'guitar', stringCount) => {
        const sc = stringCount ?? (arrangement === 'bass' ? 4 : 6);
        return sandbox._ndMidiFromStringFret(string, fret, arrangement, sc, defaultOffsetsFor(arrangement, sc), 0);
    };

    const midiToStringFretWrapped = (midi, arrangement = 'guitar', stringCount) => {
        const sc = stringCount ?? (arrangement === 'bass' ? 4 : 6);
        const r = sandbox._ndMidiToStringFret(midi, arrangement, sc, defaultOffsetsFor(arrangement, sc), 0);
        return { string: r.string, fret: r.fret };
    };

    const resolveDisplayFingeringWrapped = (detectedMidi, candidates, arrangement = 'guitar', pitchTolCents = 50, stringCount) => {
        const sc = stringCount ?? (arrangement === 'bass' ? 4 : 6);
        const r = sandbox._ndResolveDisplayFingering(
            detectedMidi, candidates, arrangement, sc, defaultOffsetsFor(arrangement, sc), 0, pitchTolCents
        );
        return { string: r.string, fret: r.fret };
    };

    // Chord-path helpers take all state (arrangement/stringCount/offsets/capo)
    // as explicit arguments and return plain numerics or arrays/objects, so
    // they don't need the sandbox-realm rewrapping the legacy fingering helpers
    // do. Expose the raw functions; tests pass state in directly.
    return {
        yinDetect: rewrapYin(sandbox._ndYinDetect),
        hpsDetect: rewrapYin(sandbox._ndHpsDetect),
        freqToMidi: sandbox._ndFreqToMidi,
        midiFromStringFret: midiFromStringFretWrapped,
        midiToStringFret: midiToStringFretWrapped,
        resolveDisplayFingering: resolveDisplayFingeringWrapped,
        nearestOctaveCents: sandbox._ndNearestOctaveCents,
        stringBandHz: sandbox._ndStringBandHz,
        bandEnergy: sandbox._ndBandEnergy,
        constraintCheckString: sandbox._ndConstraintCheckString,
        classifyTiming: sandbox._ndClassifyTiming,
        classifyPitch: sandbox._ndClassifyPitch,
        makeJudgment: (opts) => {
            const r = sandbox._ndMakeJudgment(opts);
            const toSF = o => (o ? { s: o.s, f: o.f } : o);
            return {
                chartNote: toSF(r.chartNote),
                note: toSF(r.note),
                notes: r.notes ? r.notes.map(toSF) : r.notes,
                chord: r.chord,
                hit: r.hit,
                timingState: r.timingState,
                timingError: r.timingError,
                pitchState: r.pitchState,
                pitchError: r.pitchError,
                detectedFreq: r.detectedFreq,
                expectedFreq: r.expectedFreq,
                detectedAt: r.detectedAt,
                time: r.time,
                noteTime: r.noteTime,
                expectedMidi: r.expectedMidi,
                detectedMidi: r.detectedMidi,
                confidence: r.confidence,
            };
        },
        scoreChord: (...args) => {
            const r = sandbox._ndScoreChord(...args);
            return {
                score: r.score,
                hitStrings: r.hitStrings,
                totalStrings: r.totalStrings,
                isHit: r.isHit,
                // Voicing-reduction credit flag — true whenever ≥2 of
                // the chord's strings rang at their expected pitches
                // (pitch-verified, no bass requirement). Can co-occur
                // with the strict score-ratio hit path; surfaced
                // separately so tests can pin each path independently.
                voicingHit: r.voicingHit,
                results: r.results.map(x => ({
                    s: x.s, f: x.f, hit: x.hit,
                    bandEnergy: x.bandEnergy, centsDiff: x.centsDiff,
                    centsError: x.centsError,
                })),
            };
        },
        calibrateOffsetMs: sandbox._ndCalibrateOffsetMs,
        // Game-scoring pure helpers (points / multiplier / grade layer).
        scoringHealthy: sandbox._ndScoringHealthy,
        multiplierForStreak: sandbox._ndMultiplierForStreak,
        isStreakMilestone: sandbox._ndIsStreakMilestone,
        gradeFor: sandbox._ndGradeFor,
        computeBestDelta: sandbox._ndComputeBestDelta,
        pickHeroAction: sandbox._ndPickHeroAction,
        // Results-card share helpers (pure — image/clipboard paths are
        // browser-only and not exposed).
        instrumentLabel: sandbox._ndInstrumentLabel,
        songArtUrl: sandbox._ndSongArtUrl,
        shareCardText: sandbox._ndShareCardText,
        shareCardFilename: sandbox._ndShareCardFilename,
        autoSaveFilename: sandbox._ndAutoSaveFilename,
        createNoteDetector: sandbox.createNoteDetector,
        // Drill-mode tests: expose the slopsmith stub so tests can
        // drive synthetic `loop:restart` etc. and toggle the loop
        // state that getLoop() returns.
        slopsmith: sandbox.slopsmith,
        // For the rare test that needs to manipulate the highway
        // stub directly (e.g., make hw.getTime return non-zero so
        // drillIterStartT comes out non-null).
        highway: sandbox.highway,
    };
}

module.exports = { loadDetectionCore };
