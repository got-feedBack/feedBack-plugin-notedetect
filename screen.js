// Note Detection plugin
//
// Factory pattern — `createNoteDetector(options)` returns an independent
// detector instance with its own audio pipeline, scoring, HUD, timers,
// draw hook, and DOM subtree. A default singleton (`window.noteDetect`)
// is created on load for the standard single-panel case; additional
// instances can be constructed via `window.createNoteDetector(...)` by
// plugins like splitscreen that need per-panel detection.
//
// Originally proposed by topkoa in PR #2 on this repo; this takeover
// re-applies the factory design on top of 5-string-bass (#14),
// per-note hit/miss events (#12), CI (#13), and HPS (#15) which all
// landed after his branch diverged. Co-Authored-By: topkoa.
//
// ── What this revision adds and why ───────────────────────────────────────
//
// BACKGROUND: WHY CHORD DETECTION NEEDED A DIFFERENT APPROACH
//
// YIN, HPS, and CREPE are all monophonic pitch detectors — they return one
// frequency from the full mixed signal. That works well for single notes, but
// a guitar chord produces 2–6 simultaneous fundamentals plus their harmonics
// all overlapping in the spectrum. The detectors lock onto whichever string
// is loudest (usually the lowest) and score the whole chord against that one
// pitch, silently missing every other note. This revision adds a parallel
// detection path for chords that avoids the problem entirely.
//
// The core insight (from a design brief accompanying this change): instead of
// asking "what pitch is playing?" — which is hard for chords — ask "is there
// energy near the frequency I *expect* on string S right now?" That is a much
// simpler question. Because the arrangement XML already tells us exactly which
// string plays which fret at every moment, we can compute the expected
// frequency per string and check for it independently in that string's
// frequency band. This turns one hard polyphonic detection problem into N easy
// monophonic band-energy checks, one per string.
//
// The existing YIN/HPS/CREPE path is left completely intact for single notes,
// where it already works well. The constraint path is additive: it activates
// only when the chart has ≥2 simultaneous notes in the timing window.
//
// ── CHANGE 1: 8-string guitar tuning ─────────────────────────────────────
//
// _ND_TUNING_GUITAR_8 added: [30, 35, 40, 45, 50, 55, 59, 64]
// That is F#1 B1 E2 A2 D3 G3 B3 E4 — standard Ibanez/Schecter 8-string
// tuning, a perfect fourth below the 7-string low B.
//
// _ndStandardMidiFor() now branches on stringCount === 8 before the existing
// 7-string check. Every downstream function — MIDI mapping, display labels,
// and the new constraint band calculator — derives from this table, so no
// other callsites required changes.
//
// ── CHANGE 2: Dynamic string-count sizing (prerequisite for changes 1 & 3) ─
//
// Previously, `tuningOffsets` was initialised as a hardcoded 6-element array
// and never resized. Every call that passed `tuningOffsets.length` as the
// stringCount argument to mapping helpers was therefore always passing 6,
// regardless of what instrument was actually loaded. This silently produced
// wrong frequency bands for 5-string bass, 7-string guitar, and would have
// been completely broken for 8-string guitar.
//
// Fix: a new `currentStringCount` variable is set at enable() time from
// `hw.getSongInfo().tuning.length` — the authoritative source. All three
// call sites that were passing `tuningOffsets.length` into mapping helpers
// now use `currentStringCount` instead. This was a prerequisite for both
// 8-string support and for the constraint checker computing correct frequency
// bands on non-6-string instruments.
//
// ── CHANGE 3: Constraint-based chord detection ────────────────────────────
//
// Three new module-level functions (after _ndHpsDetect, before _ndLoadCrepe):
//
//   _ndStringBandHz(stringIdx, arrangement, stringCount, offsets, capo)
//     Returns [loHz, hiHz] for a given string covering frets 0–24, with ±10%
//     headroom for tuning offsets, capo, and bent notes. Derived from the
//     tuning tables rather than hardcoded, so all instrument types are covered.
//
//   _ndBandEnergy(magnitudes, binHz, loHz, hiHz)
//     Measures the fraction of total spectrum energy (0..1) that falls in a
//     frequency band, operating on the magnitude spectrum from _ndFftMagnitude.
//     NOTE: reuses the module-level FFT scratch buffers (_ndFftInterleavedScratch,
//     _ndFftMagnitudesScratch). This is safe because the FFT is synchronous and
//     JS is single-threaded — see the existing comment on those buffers. If this
//     code is ever moved to an AudioWorklet or Web Worker, per-call scratch
//     buffers would be needed instead.
//
//   _ndConstraintCheckString(buffer, sampleRate, stringIdx, fret, ...)
//     The core per-string check. Calls _ndFftMagnitude once (which reuses the
//     scratch), measures band energy for this string's frequency range, and
//     optionally verifies that the dominant bin in the band is within
//     pitchCheckCents of the expected frequency. Returns { hit, bandEnergy,
//     centsDiff }. energyThreshold and pitchCheckCents are caller-adjustable
//     to support technique-specific loosening (see change 4).
//
//   _ndScoreChord(buffer, sampleRate, chordNotes, ..., minHitRatio)
//     Runs _ndConstraintCheckString for each note in a chord group, applies
//     per-technique threshold adjustments (see change 4), and returns
//     { score, hitStrings, totalStrings, results, isHit } where isHit is
//     true if score >= minHitRatio.
//
// ROUTING IN matchNotes():
//   Candidate notes (from the chart's timing window) are now bucketed by
//   timestamp. A bucket with 1 note goes through the existing MIDI comparison
//   against the YIN/HPS/CREPE result, unchanged. A bucket with ≥2 notes runs
//   polyphonic chord scoring. The browser path calls _ndScoreChord on the
//   accumulated `pendingBuffer` (same audio just analysed for pitch). The
//   slopsmith-desktop bridge path dispatches the chord context over the
//   `audio:scoreChord` IPC, where the native JUCE ChordScorer reads from
//   the engine's own input ring — no audio buffer crosses IPC. Both paths
//   return the same { score, hitStrings, totalStrings, isHit, results[] }
//   shape. Each string's individual result is stored in noteResults so the
//   draw overlay can colour fret gems per-note. The chord hit/miss is
//   counted as a single judgment and fires a notedetect:hit event with
//   { chord: true, hitStrings, totalStrings, score } instead of the usual
//   { note, expectedMidi }.
//
// ── CHANGE 4: Technique-aware thresholds ─────────────────────────────────
//
// The arrangement XML includes technique flags on individual notes. _ndScoreChord
// reads these from the chord note objects and adjusts thresholds before calling
// _ndConstraintCheckString:
//
//   ho / po (hammer-on / pull-off)
//     No fresh pick attack, so string energy will be lower than a picked note.
//     energyThreshold is halved from 0.03 to 0.015.
//
//   b / sl (bend / slide)
//     Pitch is moving continuously during the note. pitchCheckCents is widened
//     to at least 100 cents (a semitone) so a note mid-bend still registers.
//
//   hm (harmonic)
//     The fundamental is suppressed; the audible pitch is at 2x or 1.5x the
//     fret frequency. Pitch checking against the fundamental is unreliable, so
//     pitchCheckCents is set to 0 (energy-only check). A proper harmonic
//     frequency check (checking at 2x/1.5x) is a known TODO — see the comment
//     inside _ndScoreChord.
//
// ── CHANGE 5: chordHitRatio setting ──────────────────────────────────────
//
// The fraction of a chord's strings that must register energy to count as a
// hit. Default 0.6 (60% — e.g. 4 of 6 strings for a full barre chord). Lower
// values suit beginners or players using lighter touches on inner strings;
// higher values enforce stricter accuracy.
//
// Exposed in the settings panel as "Chord Leniency" (slider: 25–100%).
// Persisted in localStorage under the existing _ND_STORAGE_KEY alongside all
// other settings. Loaded and clamped to [0.25, 1] on construction so a stale
// persisted value can't put scoring in a state the slider can't represent.
//
// ── CHANGE 6: HUD chord display ──────────────────────────────────────────
//
// The cyan detected-note line in the HUD (`.nd-hud-detected`) previously only
// showed output when a confident single-note detection existed. It now also
// shows the most recent chord constraint result when no single note is detected,
// e.g. "chord 4/6 (66%)". This gives the player real-time visibility into
// whether the constraint scorer is seeing their strings ring, which is useful
// for diagnosing audio input issues and tuning the Chord Leniency setting.
// lastChordScore / lastChordHit / lastChordTotal are reset with the rest of
// scoring state in resetScoring().

// ── Module-level shared state ──────────────────────────────────────────────

// Shared state anchored on `window` so multiple evaluations of this
// file (HMR, accidental double <script> load) all see the same
// registry and model-load state. A bare module-scoped Set would let
// the second evaluation register its detectors into a fresh set
// while the first evaluation's live playSong wrapper iterates the
// old set — breaking song-switch disable/reset on any detector
// created by the second eval.
//
// `_ndShared` is initialised once; subsequent evaluations reuse the
// existing object. All mutable shared state (CREPE model, loading
// flag, instance registry, playSong-hook retry counter) lives on it
// so reassignments land on the canonical object, not on a fresh
// module-scope copy.
const _ndShared = (window.__ndShared = window.__ndShared || {
    model: null,          // CREPE/SPICE model (single ~20 MB load)
    modelLoading: false,
    instances: new Set(), // live detector APIs — iterated by playSong hook
    playSongRetries: 0,   // bounded-retry counter for _ndInstallPlaySongHook
    // Most-recent filename passed to playSong(). hw.getSongInfo() doesn't
    // expose a `filename` field (per the WS song_info contract), but
    // playSong's first arg IS the custom song filename — capture it in the
    // wrapper so the training-bundle manifest can populate the custom song
    // File Name field that getSongInfo can't supply on its own.
    currentFilename: null,
    // Token of the detector instance that currently owns an engine chart slot
    // for a contained-playback verifier (setContainedChart), plus the engine
    // SOURCE that slot belongs to. The engine has one chart slot PER source; a
    // contained chart and the host-song chart contend for the same slot, and so
    // do two detector instances bound to the SAME source (split-screen). These
    // cross-instance fields let setContainedChart refuse a second arm on that
    // source, AND let every instance on that source skip its own host-chart
    // pushes/drains while another instance holds the contained slot — so a
    // non-owning instance can't overwrite the contained chart. Instances bound
    // to a DIFFERENT source use a different slot and are unaffected.
    // Map of engine sourceId (null = default source 0) -> the detector instance
    // that owns the contained chart slot on THAT source. Keyed per source because
    // each source has its own engine chart slot — two instances on the same
    // source contend (only one may hold the contained slot), but instances on
    // different sources don't. setContainedChart refuses a second arm on a source
    // already owned, and every instance on a source skips its own host-chart
    // pushes/drains while another instance owns that source's contained slot.
    containedSlotOwners: new Map(),
    // Snapshot for "Return to Previous Song" after a Detection Health
    // diagnostic playthrough — one slot, screen.js only.
    diagnosticReturn: {
        active: false,
        previousFilename: null,
        previousArrangementIndex: null,
        previousTitle: null,
        previousArtist: null,
        launchedTrackId: null,
        diagnosticFilename: null,
    },
});
// HMR / prior evaluations may lack diagnosticReturn on the reused object.
if (!_ndShared.diagnosticReturn) {
    _ndShared.diagnosticReturn = {
        active: false,
        previousFilename: null,
        previousArrangementIndex: null,
        previousTitle: null,
        previousArtist: null,
        launchedTrackId: null,
        diagnosticFilename: null,
    };
}
// Local aliases — kept for readability of the rest of the file, but
// they're the same objects as `window.__ndShared.*`.
const _ndInstances = _ndShared.instances;

const _ND_DIAGNOSTIC_FILENAME_MARKERS = [
    'slopsmith-diagnostic-basic-guitar.sloppak',
];

function _ndFilenameLooksDiagnostic(fn) {
    const lower = String(fn || '').toLowerCase();
    if (!lower) return false;
    return _ND_DIAGNOSTIC_FILENAME_MARKERS.some((m) => lower.includes(m));
}

// Escape untrusted text before interpolating into an innerHTML string.
// Used for values that can carry markup metacharacters (e.g. engine/device
// error messages surfaced in the calibration wizard).
function _ndEscapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function _ndClearDiagnosticReturnState() {
    const r = _ndShared.diagnosticReturn;
    if (!r) return;
    r.active = false;
    r.previousFilename = null;
    r.previousArrangementIndex = null;
    r.previousTitle = null;
    r.previousArtist = null;
    r.launchedTrackId = null;
    r.diagnosticFilename = null;
}

// (The playSong wrapper's idempotency guard lives on the wrapper
// function object itself — see `_ndInstallPlaySongHook()` below —
// so it persists across HMR / double-<script>-load where a
// module-level flag would be reset.)

const _ND_STORAGE_KEY = 'slopsmith_notedetect';

// How long the construct-time auto-enable waits before its single retry
// when the first attempt fails (e.g. a USB interface that's enumerated but
// not yet openable at first paint). Long enough for a slow device to settle,
// short enough not to strand a persisted-on session.
const _ND_AUTO_ENABLE_RETRY_MS = 1500;

// Plugin semver — keep in sync with package.json / plugin.json. Stamped
// into every diagnostic export so a JSON blob can be tied back to the
// exact build that produced it. The script tag has no `import`/`fetch`
// hook to read package.json at load time, so this is the single
// hand-maintained constant the diagnostic path keys off of.
const _ND_VERSION = '1.15.3';

// Audio processing constants
const _ND_MIN_YIN_SAMPLES = 4096;  // enough for low E at 48kHz (need tau=585, halfLen=2048)
// ScriptProcessor buffer size. The YIN analysis buffer is a separate
// _ND_MIN_YIN_SAMPLES (4096) that accumulates across callbacks, so
// shrinking the audio-callback granularity here doesn't reduce
// detection resolution — it only halves the input-side buffering
// latency (1024/48000 ≈ 21 ms vs 2048/48000 ≈ 43 ms). Matches the
// headless harness's default --frame-size.
const _ND_FRAME_SIZE = 1024;       // ScriptProcessor buffer size (hard fallback)
// Valid ScriptProcessor buffer sizes; the persisted `frameSize` setting is
// clamped to this set on load. EMPIRICAL CORRECTION to the note above: the
// callback chunk size DOES affect bass recall — harness on a real take gives
// 1024→27%, 2048→77%, 4096→68%. The 4096-sample accumulation does NOT fully
// compensate for a too-short callback granularity on low fundamentals, so the
// per-instance default is 2048, not _ND_FRAME_SIZE.
const _ND_VALID_FRAME_SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384];
function _ndClampFrameSize(v) {
    v = Number(v);
    return _ND_VALID_FRAME_SIZES.includes(v) ? v : 2048;
}

// Pitch window the DSP band-energy scorer uses to VERIFY a single note
// (confirm the expected pitch is what is ringing, vs. a neighbouring
// fret ~100 cents away). Deliberately decoupled from the user's
// pitch_tolerance_cents — that setting governs the strict hit/miss
// pitch CALL in makeMatchedJudgment, which is far tighter than what a
// coarse FFT peak can verify. 50 cents = a quarter-tone, enough to
// disambiguate adjacent frets without rejecting real-world intonation.
const _ND_VERIFY_PITCH_CENTS = 50;
// Bass widens the pitch-verify window: a low-string fundamental (B0 ≈ 31 Hz)
// spans barely one FFT bin (~157 cents/bin), so even the engine's
// harmonic-blended pitch estimate is coarser than guitar's. 60 cents still
// disambiguates adjacent bass frets (a semitone is 100 cents) without
// rejecting real intonation on a note the low bins resolve loosely.
const _ND_VERIFY_PITCH_CENTS_BASS = 60;

// Minimum harmonic-to-floor ratio for the desktop engine's harmonic-comb
// verifier (scoreChord harmonicVerify mode) to count a single note as
// present. Tunable here — it rides through the IPC, so calibration does
// not need a native rebuild.
const _ND_VERIFY_HARMONIC_SNR = 3.0;
// Bass lowers the harmonic-to-floor ratio. A bass DI puts less of its energy
// into the upper partials the comb sums (the fundamental is strong but the
// harmonic stack is shorter than a guitar's), so the guitar SNR gate of 3.0
// under-counts genuine low notes — measured against a real bass DI calibration
// take, dropping to 2.0 raised picked-note recall ~81%→86% with no loss on
// fingerstyle and no real-world precision cost (the verifier only ever scores
// the *charted* note, and silence is still rejected by the separate floor/
// average-bin denominator, not this ratio). Rides the IPC — no native rebuild.
const _ND_VERIFY_HARMONIC_SNR_BASS = 2.0;

// Fundamental-presence gate for the harmonic-comb verifier (scoreChord
// `fundamentalRatio`): a note is rejected when its f0 peak is weaker than
// ratio × its strongest partial — the specificity guard against octave-up
// impostors. Guitar's DI fundamental is healthy, so 0.20 is safe. A bass DI
// fundamental is routinely WEAKER than the 2nd harmonic (amp-sim DIs,
// compression, roll-off below ~60 Hz — see _ndHpsDetect), so the guitar gate
// false-rejects real bass notes; bass uses a low ratio that still rejects a
// true octave impostor (which has ~no energy at f0) but passes a weak-but-
// present fundamental. Rides the IPC — no native rebuild to recalibrate.
const _ND_VERIFY_FUNDAMENTAL_RATIO = 0.20;
const _ND_VERIFY_FUNDAMENTAL_RATIO_BASS = 0.08;

// Temporal-persistence floor for the engine NoteVerifier (setChart
// `presenceRatio`): a chart note counts as hit only when the comb confirms its
// pitch in at least this FRACTION of the frames scored in its window, instead
// of the legacy "ever present" (any single frame). Measured against real
// wrong-position bass DI takes: a correctly-fretted note rings present through
// ~70-100% of its frames, while a note played 2 frets off only flickers present
// on a handful of stray frames (its harmonics don't align with the comb), so a
// 0.3 floor cuts wrong-position false-accepts ~70-95% with no loss on the
// correct take. Guitar keeps 0 (legacy ever-present, byte-identical) — guitar
// was never reported to false-accept and a floor risks dropping fast/staccato
// passages. Rides the IPC — no native rebuild to recalibrate.
const _ND_VERIFY_PRESENCE_RATIO = 0.0;
const _ND_VERIFY_PRESENCE_RATIO_BASS = 0.3;

// Fraction of a verify target's strings that must ring for notedetect:verify
// to fire. Deliberately FIXED and independent of the user-facing gameplay
// `chordHitRatio` slider: a verify consumer (Step Mode) needs stable,
// predictable chord acceptance, not one that drifts with a scoring preference.
// 0.5 keeps it forgiving (single notes are 1/1 = always pass) without letting
// a 2-of-5 partial voicing count as the chord.
const _ND_VERIFY_MIN_HIT_RATIO = 0.5;

// Per-arrangement harmonic-comb verify parameters. `harmonicSnr` and
// `fundamentalRatio` feed both the setChart payload and the scoreChord
// harmonic-verify call. This helper's `pitchCheckCents` feeds only the
// scoreChord call; setChart's own `pitchCheckCents` field is populated from
// the user's Pitch-tolerance slider instead, not from this helper.
function _ndVerifyParamsFor(arrangement) {
    const bass = arrangement === 'bass';
    return {
        pitchCheckCents: bass ? _ND_VERIFY_PITCH_CENTS_BASS : _ND_VERIFY_PITCH_CENTS,
        harmonicSnr: bass ? _ND_VERIFY_HARMONIC_SNR_BASS : _ND_VERIFY_HARMONIC_SNR,
        fundamentalRatio: bass ? _ND_VERIFY_FUNDAMENTAL_RATIO_BASS : _ND_VERIFY_FUNDAMENTAL_RATIO,
        presenceRatio: bass ? _ND_VERIFY_PRESENCE_RATIO_BASS : _ND_VERIFY_PRESENCE_RATIO,
    };
}

// Tuning tables — standard-tuning MIDI base per (arrangement, stringCount).
//
// Bass ascends in perfect fourths end-to-end; guitar is fourths except
// the major third between G3→B3 (the standard irregularity). Low B on
// 5-string bass and 7-string guitar both add a perfect fourth below
// the standard low-E string. 8-string guitar adds a further low F#1
// below that (a perfect fourth below B1), matching the most common
// Ibanez/Schecter 8-string standard tuning.
const _ND_TUNING_BASS_4 = [28, 33, 38, 43];                   // E1 A1 D2 G2
const _ND_TUNING_BASS_5 = [23, 28, 33, 38, 43];               // B0 E1 A1 D2 G2
const _ND_TUNING_BASS_6 = [23, 28, 33, 38, 43, 48];           // B0 E1 A1 D2 G2 C3
const _ND_TUNING_GUITAR_6 = [40, 45, 50, 55, 59, 64];         // E2 A2 D3 G3 B3 E4
const _ND_TUNING_GUITAR_7 = [35, 40, 45, 50, 55, 59, 64];     // B1 E2 A2 D3 G3 B3 E4
const _ND_TUNING_GUITAR_8 = [30, 35, 40, 45, 50, 55, 59, 64]; // F#1 B1 E2 A2 D3 G3 B3 E4

// Calibration-wizard instrument presets (standalone, no song to read tuning
// from). Each maps to an arrangement + stringCount that _ndStandardMidiFor
// turns into the per-string open-note tuning above.
const _CAL_WIZARD_INSTRUMENT_CONFIGS = [
    { id: 'bass-4',   label: '4-string bass',          arrangement: 'bass',   stringCount: 4 },
    { id: 'bass-5',   label: '5-string bass',          arrangement: 'bass',   stringCount: 5 },
    { id: 'bass-6',   label: '6-string bass',          arrangement: 'bass',   stringCount: 6 },
    { id: 'guitar-6', label: '6-string guitar',        arrangement: 'guitar', stringCount: 6 },
    { id: 'guitar-7', label: '7-string guitar',        arrangement: 'guitar', stringCount: 7 },
    { id: 'guitar-8', label: '8-string guitar',        arrangement: 'guitar', stringCount: 8 },
];

function _ndArrangementKindFromName(name) {
    return /bass/i.test(String(name || '')) ? 'bass' : 'guitar';
}

function _ndStandardMidiFor(arrangement, stringCount) {
    if (arrangement === 'bass') {
        if (stringCount === 6) return _ND_TUNING_BASS_6;
        return stringCount === 5 ? _ND_TUNING_BASS_5 : _ND_TUNING_BASS_4;
    }
    if (stringCount === 8) return _ND_TUNING_GUITAR_8;
    if (stringCount === 7) return _ND_TUNING_GUITAR_7;
    return _ND_TUNING_GUITAR_6;
}

// Stable fingerprint of the tuning context a verify target is scored under.
// A (string, fret) only maps to a pitch under a specific arrangement + string
// count + per-string offsets + capo, so a target is meaningless once that
// context changes. Used to bind a verify target to its context and drop it on
// mismatch. Pure — takes the context explicitly so the host-chart binding and
// a caller-supplied override (setVerifyTarget's ctx) share one definition.
function _ndVerifySigFor(arrangement, stringCount, offsets, capo) {
    return arrangement + '|' + stringCount + '|'
        + offsets.slice(0, stringCount).join(',') + '|' + capo;
}

// Sanitize a caller-supplied verify context (setVerifyTarget's 2nd arg) into a
// coherent { arrangement, stringCount, offsets, capo }, or null when no usable
// context object was passed (→ score against the host song's live tuning, the
// back-compat Step Mode behavior). Lets a non-chart consumer (contained
// playback: SlopScale, Chord Sprint) verify against the player's real
// instrument instead of whatever song the host highway happens to have loaded.
//
// The per-string tuning may be given two ways (checked in this order):
//   • `openMidis`: ABSOLUTE open-string MIDI per string (e.g. [40,45,50,55,59,
//     64] for standard guitar) — what a non-chart consumer naturally holds.
//     Converted here to standard-tuning offsets. These are the REAL sounding
//     open pitches (any capo is already baked in), so the openMidis path
//     forces capo 0 — applying ctx.capo on top would transpose twice.
//   • `tuning` / `offsets`: per-string semitone OFFSETS from standard tuning
//     (the chart convention, matching the instance's tuningOffsets). `offsets`
//     is also accepted so getVerifyContext() output round-trips back in. This
//     path honors ctx.capo.
// Either array is read BY STRING INDEX — a non-finite entry maps to 0 in place,
// never reindexed, so one bad string can't shift the others' pitch mapping.
//
// `arrangement` is optional: when omitted and absolute openMidis were given,
// it's inferred as whichever of bass/guitar the pitches sit closest to (so a
// 5-string bass isn't mis-scored — and mis-parameterized — as a guitar);
// otherwise it defaults to guitar.
function _ndSanitizeVerifyCtx(ctx) {
    if (!ctx || typeof ctx !== 'object') return null;
    const rawOpen = Array.isArray(ctx.openMidis) ? ctx.openMidis : null;
    const rawOff = Array.isArray(ctx.tuning) ? ctx.tuning
        : (Array.isArray(ctx.offsets) ? ctx.offsets : null);
    // String count: explicit wins; else the source array length; else (no
    // array) the arrangement default.
    const srcLen = (rawOpen && rawOpen.length) || (rawOff && rawOff.length) || 0;
    const explicitArr = (ctx.arrangement != null)
        ? _ndArrangementKindFromName(ctx.arrangement) : null;
    let stringCount = Number.isInteger(ctx.stringCount) && ctx.stringCount > 0
        ? ctx.stringCount
        : (srcLen || ((explicitArr || 'guitar') === 'bass' ? 4 : 6));
    stringCount = Math.max(1, Math.min(8, stringCount));
    // Arrangement: explicit wins; else infer from absolute pitches; else guitar.
    const arrangement = explicitArr
        || (rawOpen ? _ndInferArrangementFromOpenMidis(rawOpen, stringCount) : 'guitar');
    // Clamp to the arrangement's supported tuning-table range so the scorer's
    // standard base always covers every string — _ndStandardMidiFor only models
    // bass 4/5 and guitar 6/7/8, and a higher count would index an undefined
    // base (NaN pitch, never verifies). 6-string bass is out of scope here.
    stringCount = Math.min(stringCount, arrangement === 'bass' ? 5 : 8);
    const offsets = [];
    let capo;
    if (rawOpen) {
        // Absolute open MIDI → offsets from this arrangement's standard tuning.
        const base = _ndStandardMidiFor(arrangement, stringCount);
        for (let s = 0; s < stringCount; s++) {
            const m = rawOpen[s];
            offsets.push(Number.isFinite(m) && Number.isFinite(base[s])
                ? Math.round(m - base[s]) : 0);
        }
        // openMidis already encode the real (capoed) open pitches.
        capo = 0;
    } else {
        // Offsets convention. Read by string index, non-finite → 0.
        for (let s = 0; s < stringCount; s++) {
            const v = rawOff ? rawOff[s] : 0;
            offsets.push(Number.isFinite(v) ? Math.trunc(v) : 0);
        }
        capo = Number.isInteger(ctx.capo) && ctx.capo >= 0 ? ctx.capo : 0;
    }
    return { arrangement, stringCount, offsets, capo };
}

// Pick the arrangement (bass/guitar) whose standard tuning a set of absolute
// open-string MIDI values sits closest to — used to infer arrangement when a
// caller supplies openMidis without naming one. A non-finite/out-of-range
// string contributes a fixed penalty so partial data still resolves sanely.
function _ndInferArrangementFromOpenMidis(openMidis, stringCount) {
    const totalDistance = (arrangement) => {
        const base = _ndStandardMidiFor(arrangement, stringCount);
        let sum = 0;
        for (let s = 0; s < stringCount; s++) {
            const m = openMidis[s];
            sum += (Number.isFinite(m) && Number.isFinite(base[s])) ? Math.abs(m - base[s]) : 12;
        }
        return sum;
    };
    return totalDistance('bass') < totalDistance('guitar') ? 'bass' : 'guitar';
}

// ── Pure mapping helpers ───────────────────────────────────────────────────
// All take state (arrangement, stringCount, offsets, capo) as explicit args
// so they remain safe to call across multiple instances with different
// tunings. No module-level mutable fallbacks — the factory closure passes
// its own state in.

function _ndFreqToMidi(freq) {
    return 12 * Math.log2(freq / 440) + 69;
}

// MIDI → scientific pitch name (e.g. 40 → "E2"). Rounds to the nearest
// semitone. Used by the HUD so the "detected note" label is correct
// regardless of arrangement, tuning offsets, or capo — the previous
// implementation hardcoded `['E2','A2','D3','G3','B3','E4']` indexed
// by string, which mislabelled every bass / 7-string / retuned note.
const _ND_PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function _ndMidiToName(midi) {
    const rounded = Math.round(midi);
    const pc = ((rounded % 12) + 12) % 12;
    const octave = Math.floor(rounded / 12) - 1;
    return _ND_PITCH_NAMES[pc] + octave;
}

function _ndMidiFromStringFret(string, fret, arrangement, stringCount, offsets, capo) {
    const base = _ndStandardMidiFor(arrangement, stringCount);
    const offset = offsets && offsets[string] !== undefined ? offsets[string] : 0;
    return base[string] + offset + (capo || 0) + fret;
}

function _ndClassifyTiming(timingErrorMs, timingThresholdMs, lateGraceMs) {
    if (!Number.isFinite(timingErrorMs)) return null;
    const grace = Number.isFinite(lateGraceMs) && lateGraceMs > 0 ? lateGraceMs : 0;
    // Asymmetric for sus-marked notes (caller passes grace > 0): the
    // EARLY side stays strict — playing before the note is always
    // wrong — but late detection within the sustain envelope is still
    // a hit, because the note is *audibly* the right one. Without this,
    // a player who plucks a few hundred ms after the chart time on a
    // half-note (which YIN may take ~100 ms to confidently lock) gets
    // a LATE miss even though they're hearing themselves play the
    // correct note over the strike-line ring.
    if (timingErrorMs < 0) {
        return Math.abs(timingErrorMs) <= timingThresholdMs ? 'OK' : 'EARLY';
    }
    return timingErrorMs <= timingThresholdMs + grace ? 'OK' : 'LATE';
}

function _ndClassifyPitch(pitchErrorCents, pitchThresholdCents) {
    if (!Number.isFinite(pitchErrorCents)) return null;
    return Math.abs(pitchErrorCents) <= pitchThresholdCents
        ? 'OK'
        : (pitchErrorCents > 0 ? 'SHARP' : 'FLAT');
}

// ── Game-scoring layer: points / multiplier / grade ─────────────────────
// Pure helpers shared by the live HUD, the end-of-song summary, and the
// highway FX contract. Kept top-level (not in the factory closure) so the
// vm test loader can exercise them directly.

// Base point values per clean hit, before the streak multiplier.
const ND_BASE_SINGLE = 50;
const ND_BASE_CHORD  = 100;

// Streak-tier multiplier: ×1 → ×2 at 10, ×3 at 25, ×4 at 50.
function _ndMultiplierForStreak(streak) {
    return streak >= 50 ? 4 : streak >= 25 ? 3 : streak >= 10 ? 2 : 1;
}

// Streak counts that warrant a celebration burst on the highway: the two
// upper tier boundaries, then every full hundred.
function _ndIsStreakMilestone(streak) {
    return streak === 25 || streak === 50 || (streak >= 100 && streak % 100 === 0);
}

// Scoring-UI skin. One global preference shared by every instance (and read
// by the highway renderer for its FX palette), stored under a standalone
// key so non-notedetect consumers don't have to parse the settings blob.
const ND_SKINS = ['neon', 'esports', 'metal'];
const ND_SKIN_STORAGE_KEY = 'slopsmith_notedetect_skin';

// Runtime mirror of the skin preference. Keeps getSkin()/setSkin()
// coherent for the session when localStorage is unavailable (private
// mode, quota): readable storage wins, the mirror is the fallback — so a
// setSkin() whose persist failed still themes consistently until reload.
let _ndSkinRuntime = 'neon';

function _ndLoadSkin() {
    try {
        const v = localStorage.getItem(ND_SKIN_STORAGE_KEY);
        if (ND_SKINS.indexOf(v) !== -1) {
            _ndSkinRuntime = v;
            return v;
        }
    } catch (e) { /* storage unavailable — fall through to the mirror */ }
    return _ndSkinRuntime;
}

// Minimal HTML escaper for chart-sourced strings (section names) that get
// interpolated into summary innerHTML.
function _ndEscapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// Letter grade from accuracy percentage (0–100). Full combo is a separate
// badge (misses === 0), not a grade change.
function _ndGradeFor(accuracy) {
    return accuracy >= 96 ? 'S'
        : accuracy >= 90 ? 'A'
        : accuracy >= 80 ? 'B'
        : accuracy >= 70 ? 'C'
        : accuracy >= 60 ? 'D'
        : 'F';
}

function _ndMakeJudgment(opts) {
    const o = opts || {};
    const matched = !!o.matched;
    const timingError = matched && Number.isFinite(o.judgedAt) && Number.isFinite(o.noteTime)
        ? Math.round((o.judgedAt - o.noteTime) * 1000)
        : null;
    const pitchError = matched && Number.isFinite(o.pitchError)
        ? Math.round(o.pitchError)
        : null;
    const timingThresholdMs = Number.isFinite(o.timingThresholdMs) ? o.timingThresholdMs : 100;
    const pitchThresholdCents = Number.isFinite(o.pitchThresholdCents) ? o.pitchThresholdCents : 20;
    // Derive late-side grace from the chart note's sustain. Capped at
    // 1 s so a 4-second held note doesn't accept detections nearly 4
    // seconds late as "on time" — at some point the player has clearly
    // missed the strike and is just holding the previous note's ring.
    //
    // For chord judgments, the caller passes an explicit `lateGraceMs`
    // computed from the MAX sus across chord constituents (matching
    // matchNotes' candidate-inclusion + checkMisses' retire-extension
    // grace). Without that override, this falls back to the chart
    // note's own sus, which for chords is just the first constituent
    // (`liveNotes[0]`) — and a chord whose lead has a shorter sus than
    // its longest constituent would get classified LATE here even
    // though it was still inside the chord's matching window.
    const chartNote = o.chartNote || o.note || null;
    const susSec = chartNote && Number.isFinite(chartNote.sus) ? chartNote.sus : 0;
    const lateGraceMs = Number.isFinite(o.lateGraceMs)
        ? Math.max(0, o.lateGraceMs)
        : (susSec > 0 ? Math.min(susSec * 1000, 1000) : 0);
    const timingState = matched ? _ndClassifyTiming(timingError, timingThresholdMs, lateGraceMs) : null;
    const pitchState = matched ? _ndClassifyPitch(pitchError, pitchThresholdCents) : null;
    // pitchState === null means pitch was not measured (e.g. energy-only chord
    // check or harmonic flag).  Treat unmeasured pitch as non-blocking so a
    // chord that passes the scorer is not incorrectly counted as a miss.
    //
    // For CHORDS specifically: the chord scorer (_ndScoreChord) already
    // ran per-string pitch + energy checks before this judgment was
    // constructed. matchNotes only takes the chord-hit path when the
    // scorer returned isHit (score ≥ chordHitRatio). If we *also* gate
    // the overall hit on the monophonic pitchState computed from a
    // SINGLE string's pitchError (the first one with a finite cents
    // measurement), we throw away clean chord hits whenever the lead
    // string happens to be a bit sharp/flat — even when every string
    // rang and the chord scorer said yes. Trust the chord scorer's
    // verdict here. For single notes the original timing+pitch rule
    // still applies.
    const isChord = !!o.chord;
    const hit = isChord
        ? (matched && timingState === 'OK')
        : (timingState === 'OK' && (pitchState === 'OK' || pitchState === null));
    return {
        chartNote: o.chartNote || o.note || null,
        note: o.note || null,
        notes: o.notes || null,
        chord: !!o.chord,
        hit,
        timingState,
        timingError,
        pitchState,
        pitchError,
        detectedFreq: Number.isFinite(o.detectedFreq) ? o.detectedFreq : null,
        expectedFreq: Number.isFinite(o.expectedFreq) ? o.expectedFreq : null,
        detectedAt: matched && Number.isFinite(o.judgedAt) ? o.judgedAt : null,
        time: Number.isFinite(o.judgedAt) ? o.judgedAt : null,
        noteTime: Number.isFinite(o.noteTime) ? o.noteTime : null,
        expectedMidi: Number.isFinite(o.expectedMidi) ? o.expectedMidi : null,
        detectedMidi: Number.isFinite(o.detectedMidi) ? o.detectedMidi : null,
        confidence: Number.isFinite(o.confidence) ? o.confidence : 0,
        hitStrings: Number.isFinite(o.hitStrings) ? o.hitStrings : undefined,
        totalStrings: Number.isFinite(o.totalStrings) ? o.totalStrings : undefined,
        score: Number.isFinite(o.score) ? o.score : undefined,
        monophonicDetected: o.monophonicDetected,
    };
}

function _ndMidiToStringFret(midiNote, arrangement, stringCount, offsets, capo) {
    // Pure geometric fallback: walk strings 0..N and return the first position
    // that matches the pitch. Used when there is no chart context available
    // (player noodling between chart notes). When a chart note is in play,
    // _ndResolveDisplayFingering picks the chart's (s, f) instead — see the
    // research notes in mapping-bass.test.js.
    const base = _ndStandardMidiFor(arrangement, stringCount);
    let bestDist = Infinity;
    let bestString = -1;
    let bestFret = -1;
    for (let s = 0; s < base.length; s++) {
        const offset = offsets && offsets[s] !== undefined ? offsets[s] : 0;
        const openMidi = base[s] + offset + (capo || 0);
        const fret = Math.round(midiNote - openMidi);
        if (fret < 0 || fret > 24) continue;
        const dist = Math.abs(midiNote - (openMidi + fret));
        if (dist < bestDist) {
            bestDist = dist;
            bestString = s;
            bestFret = fret;
        }
    }
    return { string: bestString, fret: bestFret };
}

function _ndFoldOctaveCents(cents) {
    if (!Number.isFinite(cents)) return Infinity;
    return cents - (Math.round(cents / 1200) * 1200);
}

function _ndNearestOctaveCents(detectedMidi, expectedMidi) {
    if (!Number.isFinite(detectedMidi) || !Number.isFinite(expectedMidi)) return Infinity;
    return _ndFoldOctaveCents((detectedMidi - expectedMidi) * 100);
}

// Chart-context-aware fingering resolver. If any candidate chart note's
// expected pitch is within the pitch tolerance of the detected MIDI (allowing
// whole-octave detector mistakes), return that note's (string, fret) — the
// player is hitting the charted fingering. Otherwise fall back to the
// geometric first-match on the arrangement's tuning. This mirrors what
// score-follower apps (e.g. the chart) do: trust the chart for display when
// the player is on-pitch, only guess when they aren't.
function _ndResolveDisplayFingering(detectedMidi, candidateNotes, arrangement, stringCount, offsets, capo, pitchToleranceCents) {
    if (candidateNotes && candidateNotes.length > 0) {
        for (const cn of candidateNotes) {
            const expected = _ndMidiFromStringFret(cn.s, cn.f, arrangement, stringCount, offsets, capo);
            if (Math.abs(_ndNearestOctaveCents(detectedMidi, expected)) <= pitchToleranceCents) {
                return { string: cn.s, fret: cn.f, displayMidi: expected };
            }
        }
    }
    const fallback = _ndMidiToStringFret(detectedMidi, arrangement, stringCount, offsets, capo);
    return { string: fallback.string, fret: fallback.fret, displayMidi: detectedMidi };
}

// ── Pitch Detection: YIN ───────────────────────────────────────────────────
// Lightweight monophonic pitch detector — works instantly, no model to load.

// Lowest frequency we claim to detect. Below this and YIN's autocorrelation
// window needs to be longer than the input — at 48 kHz a 30 Hz period is
// ~1600 samples, so halfLen must exceed that, i.e. buffer must exceed ~3200.
const _ND_MIN_DETECTABLE_HZ = 30;

function _ndYinDetect(buffer, sampleRate, minFreqHz = _ND_MIN_DETECTABLE_HZ) {
    const threshold = 0.15;
    const halfLen = Math.floor(buffer.length / 2);
    const yinBuffer = new Float32Array(halfLen);

    // Surface "too-small buffer" as a distinct state from "no note detected"
    // so callers (and tests) can tell the two apart. Without this, a broken
    // accumulation path silently drops every bass note.
    const minHalfLenForFreq = Math.ceil(sampleRate / minFreqHz);
    const underBuffered = halfLen < minHalfLenForFreq;

    // Difference function
    let runningSum = 0;
    yinBuffer[0] = 1;
    for (let tau = 1; tau < halfLen; tau++) {
        let sum = 0;
        for (let i = 0; i < halfLen; i++) {
            const delta = buffer[i] - buffer[i + tau];
            sum += delta * delta;
        }
        yinBuffer[tau] = sum;
        runningSum += sum;
        yinBuffer[tau] *= tau / runningSum; // cumulative mean normalized
    }

    // Absolute threshold
    let tau = 2;
    while (tau < halfLen) {
        if (yinBuffer[tau] < threshold) {
            while (tau + 1 < halfLen && yinBuffer[tau + 1] < yinBuffer[tau]) tau++;
            break;
        }
        tau++;
    }
    if (tau === halfLen) return { freq: -1, confidence: 0, underBuffered };

    // Parabolic interpolation
    const s0 = tau > 0 ? yinBuffer[tau - 1] : yinBuffer[tau];
    const s1 = yinBuffer[tau];
    const s2 = tau + 1 < halfLen ? yinBuffer[tau + 1] : yinBuffer[tau];
    const betterTau = tau + (s0 - s2) / (2 * (s0 - 2 * s1 + s2));

    const freq = sampleRate / betterTau;
    const confidence = 1 - yinBuffer[tau];
    return { freq, confidence: Math.max(0, confidence), underBuffered };
}

// ── Pitch Detection: Shared FFT helper ─────────────────────────────────────
// Real-valued FFT via Cooley-Tukey radix-2, in-place on interleaved
// complex arrays. Currently used by HPS; factored out as a helper so
// future frequency-domain detectors (e.g. cepstrum) can reuse it.
// ~80 lines of dependency-free JS to preserve notedetect's zero-deps
// principle.

// Next power-of-two ≥ n. FFT sizes must be powers of two; the input
// buffer is zero-padded up to this length before transforming.
function _ndNextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

// Minimum samples to accumulate before a single-note detection frame. Guitar
// keeps the proven _ND_MIN_YIN_SAMPLES (4096). Bass must span ~2 periods of
// the lowest detectable fundamental (_ND_MIN_DETECTABLE_HZ, B0 ≈ 31 Hz) for
// YIN/HPS to lock it — at 96 kHz that exceeds 4096, so a fixed buffer drops
// low bass silently (the "undersized buffer" warning). Size from the device
// rate so the floor holds at 44.1, 48, 96, 192 kHz.
function _ndMinAnalysisSamples(arrangement, sampleRate) {
    if (arrangement !== 'bass' || !(sampleRate > 0)) return _ND_MIN_YIN_SAMPLES;
    // Exact two-period floor — do NOT round up to a power of two. YIN's
    // difference loop is O(n²) in buffer length, so an overshoot (e.g. 192 kHz:
    // 12800 → 16384) adds real CPU for no benefit; _ndFftMagnitude already
    // zero-pads its own input to a pow2 ≥ resolutionFloor, so the HPS/FFT path
    // is unaffected by a non-pow2 accumulation length.
    const need = Math.ceil(2 * sampleRate / _ND_MIN_DETECTABLE_HZ);
    return Math.max(_ND_MIN_YIN_SAMPLES, need);
}

// ── A/V auto-calibration ──────────────────────────────────────────────
// The harness objective made concrete in-app. Given offset-free detections
// (`{ bt, m }`: bt = hw.getTime() − latencyOffset, m = detected MIDI) logged
// across a play, and the chart notes, sweep candidate A/V offsets and return
// the one (ms) that matches the MOST chart notes within the hit window — then
// refine by the mean residual so matched detections sit centered in their
// windows. Maximizing matched-notes (recall) is robust even from a bad start,
// unlike shifting by the median timing error of whatever hits you already have
// (which collapses when the offset is far off). Pure + exported for tests;
// returns null when there isn't enough evidence to decide.
function _ndCalibrateOffsetMs(detections, chartNotes, geom, hitWindowS, pitchTolCents, opts) {
    opts = opts || {};
    const loMs = (opts.loMs != null) ? opts.loMs : -250;
    const hiMs = (opts.hiMs != null) ? opts.hiMs : 250;
    const stepMs = opts.stepMs || 10;
    const minMatched = (opts.minMatched != null) ? opts.minMatched : 12;
    if (!Array.isArray(detections) || !Array.isArray(chartNotes)) return null;
    if (detections.length < minMatched || chartNotes.length < minMatched) return null;
    // Expected MIDI + time per single chart note (skip chord-only / unfingered).
    const exp = [];
    for (const n of chartNotes) {
        const t = (n.time != null) ? n.time : n.t;
        if (t == null || n.s == null || n.f == null) continue;
        const em = _ndMidiFromStringFret(n.s, n.f, geom.arrangement, geom.stringCount, geom.offsets, geom.capo);
        if (Number.isFinite(em)) exp.push({ t, em });
    }
    if (exp.length < minMatched) return null;
    const dets = detections.slice().sort((a, b) => a.bt - b.bt);
    let best = null;
    for (let ms = loMs; ms <= hiMs; ms += stepMs) {
        const off = ms / 1000;
        let matched = 0, residSum = 0;
        for (const note of exp) {
            for (let i = 0; i < dets.length; i++) {
                const dt = dets[i].bt + off - note.t;
                if (dt < -hitWindowS) continue;
                if (dt > hitWindowS) break;            // dets sorted by bt → past the window
                if (Math.abs(_ndNearestOctaveCents(dets[i].m, note.em)) <= pitchTolCents) {
                    matched++; residSum += dt; break;
                }
            }
        }
        if (!best || matched > best.matched) best = { ms, matched, resid: matched ? residSum / matched : 0 };
    }
    if (!best || best.matched < minMatched) return null;
    // Refine: shift so matched detections center in their windows (sub-grid).
    const refinedMs = Math.round(best.ms - best.resid * 1000);
    return { offsetMs: Math.max(-1000, Math.min(1000, refinedMs)), matched: best.matched, total: exp.length };
}

// In-place radix-2 Cooley-Tukey on interleaved {re, im} pairs.
// `data` has length 2*N (N real/imag pairs). `direction` is +1 for
// forward (standard DFT sign: exp(-i·2π·k·n/N)) and -1 for inverse. No
// normalization here; callers divide by N themselves when they want
// the inverse to be an average.
function _ndFftInPlace(data, direction) {
    const nPairs = data.length >> 1;
    // Bit-reversal permutation — puts inputs in the order the butterfly
    // stages expect.
    for (let i = 1, j = 0; i < nPairs; i++) {
        let bit = nPairs >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            const ir = 2 * i, jr = 2 * j;
            let tmp = data[ir];     data[ir] = data[jr];     data[jr] = tmp;
            tmp = data[ir + 1]; data[ir + 1] = data[jr + 1]; data[jr + 1] = tmp;
        }
    }
    // Butterfly stages. Negate the angle for direction=+1 so the
    // twiddle exp(i·angle) carries the standard forward-DFT negative
    // sign; direction=-1 yields the positive sign for inverse use.
    for (let len = 2; len <= nPairs; len <<= 1) {
        const halfLen = len >> 1;
        const angle = -direction * 2 * Math.PI / len;
        const wRe = Math.cos(angle);
        const wIm = Math.sin(angle);
        for (let i = 0; i < nPairs; i += len) {
            let twRe = 1, twIm = 0;
            for (let k = 0; k < halfLen; k++) {
                const evenIdx = 2 * (i + k);
                const oddIdx = 2 * (i + k + halfLen);
                const oRe = data[oddIdx] * twRe - data[oddIdx + 1] * twIm;
                const oIm = data[oddIdx] * twIm + data[oddIdx + 1] * twRe;
                data[oddIdx]     = data[evenIdx]     - oRe;
                data[oddIdx + 1] = data[evenIdx + 1] - oIm;
                data[evenIdx]     = data[evenIdx]     + oRe;
                data[evenIdx + 1] = data[evenIdx + 1] + oIm;
                const nextTwRe = twRe * wRe - twIm * wIm;
                twIm = twRe * wIm + twIm * wRe;
                twRe = nextTwRe;
            }
        }
    }
}

// Hann window + zero-pad + forward FFT → magnitude spectrum.
// Returns `{ magnitudes, binHz, fftSize }` so callers can map bin → Hz
// directly. Magnitude length is fftSize/2 + 1 (Nyquist-inclusive).
//
// Reuses scratch buffers across calls — at ~20 fps a per-frame pair of
// Float32Array allocations (32 kB interleaved + 32 kB magnitudes at
// 48 kHz / 16384 fftSize) becomes real GC pressure. We re-allocate
// only when fftSize changes. These module-level scratch buffers are
// shared by every detector instance, which is safe only because
// FFT work here is fully synchronous and JS runs on one thread — the
// scratch is written and read to completion before any other instance
// (or any async continuation) can enter. Each factory instance has
// its own `processingFrame` in-flight guard that serializes its own
// calls; concurrent calls from *different* instances never interleave
// inside `_ndFftMagnitude` because there are no awaits inside it.
// An async/parallel future (Web Workers, AudioWorklet with real
// re-entrancy) would need per-instance or per-call scratch instead.
let _ndFftInterleavedScratch = null;
let _ndFftMagnitudesScratch = null;
let _ndFftScratchSize = 0;

// HPS scratch — reallocated only when highBin changes. Same GC-pressure
// rationale as the FFT buffers above.
let _ndHpsScratch = null;
let _ndHpsScratchSize = 0;

function _ndFftMagnitude(buffer, sampleRate) {
    // Target ~3 Hz bin width regardless of device sample rate. A fixed
    // floor (e.g. 16384) would degrade to ~5.86 Hz/bin at 96 kHz and
    // reintroduce the low-B binning problem (30.87 Hz ≈ bin 5.27 with
    // ~90 cents of drift even after parabolic interpolation). Deriving
    // the floor from sampleRate keeps the fundamental resolvable on
    // 5-string bass across any rate a modern audio interface serves.
    const TARGET_BIN_HZ = 3;
    const resolutionFloor = _ndNextPow2(Math.ceil(sampleRate / TARGET_BIN_HZ));
    const fftSize = Math.max(_ndNextPow2(buffer.length), resolutionFloor);
    const halfBins = (fftSize >> 1) + 1;

    if (_ndFftScratchSize !== fftSize) {
        _ndFftInterleavedScratch = new Float32Array(2 * fftSize);
        _ndFftMagnitudesScratch = new Float32Array(halfBins);
        _ndFftScratchSize = fftSize;
    }
    const interleaved = _ndFftInterleavedScratch;
    const magnitudes = _ndFftMagnitudesScratch;
    // Zero the scratch — windowed buffer fills only the first 2*buffer.length
    // slots, but the FFT reads the whole array.
    interleaved.fill(0);

    // Hann-window the real part, leave imag as zero. Windowing reduces
    // spectral leakage from a finite-length buffer.
    for (let i = 0; i < buffer.length; i++) {
        const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (buffer.length - 1)));
        interleaved[2 * i] = buffer[i] * w;
    }
    _ndFftInPlace(interleaved, 1);
    for (let k = 0; k < halfBins; k++) {
        const re = interleaved[2 * k];
        const im = interleaved[2 * k + 1];
        magnitudes[k] = Math.sqrt(re * re + im * im);
    }
    return { magnitudes, binHz: sampleRate / fftSize, fftSize };
}

// Parabolic interpolation over a 3-sample peak — returns a sub-sample
// offset `delta` in [-1, 1] that refines the peak location. Clamps to
// ±1 so a near-zero denom can't produce a runaway offset that lands the
// corrected peak in a neighboring bin.
function _ndParabolicOffset(yPrev, yPeak, yNext) {
    const denom = yPrev - 2 * yPeak + yNext;
    if (Math.abs(denom) < 1e-12) return 0;
    const delta = 0.5 * (yPrev - yNext) / denom;
    if (delta > 1) return 1;
    if (delta < -1) return -1;
    return delta;
}

// ── Pitch Detection: HPS (Harmonic Product Spectrum) ───────────────────────
// Frequency-domain detector designed for bass signals with a suppressed
// fundamental — amp-sim DIs, small-speaker playback, heavily compressed
// tones all commonly roll off below ~60 Hz. YIN's time-domain
// autocorrelation locks onto the 2nd harmonic in that case and reports
// the pitch one octave high; HPS multiplies together downsampled copies
// of the magnitude spectrum so the bins at the fundamental reinforce
// even when that fundamental is weak.
function _ndHpsDetect(buffer, sampleRate, minFreqHz = _ND_MIN_DETECTABLE_HZ) {
    const halfLen = Math.floor(buffer.length / 2);
    const minHalfLenForFreq = Math.ceil(sampleRate / minFreqHz);
    const underBuffered = halfLen < minHalfLenForFreq;
    if (underBuffered) return { freq: -1, confidence: 0, underBuffered };

    const { magnitudes, binHz } = _ndFftMagnitude(buffer, sampleRate);
    const nBins = magnitudes.length;
    const harmonics = 3;
    const maxFreqHz = 2000;
    const lowBin = Math.max(1, Math.floor(minFreqHz / binHz));
    const highBin = Math.min(Math.floor((nBins - 1) / harmonics),
                             Math.floor(maxFreqHz / binHz));
    if (highBin <= lowBin) return { freq: -1, confidence: 0, underBuffered: false };

    let maxMag = 0;
    for (let k = 0; k < nBins; k++) if (magnitudes[k] > maxMag) maxMag = magnitudes[k];
    const floor = maxMag * 1e-3; // -60 dB relative to peak

    if (_ndHpsScratchSize <= highBin) {
        _ndHpsScratch = new Float32Array(highBin + 1);
        _ndHpsScratchSize = highBin + 1;
    }
    const hps = _ndHpsScratch;
    let peakBin = lowBin;
    let peakVal = -Infinity;
    let sum = 0;
    for (let k = lowBin; k <= highBin; k++) {
        let logSum = 0;
        for (let h = 1; h <= harmonics; h++) {
            logSum += Math.log(Math.max(magnitudes[k * h], floor));
        }
        hps[k] = logSum;
        sum += logSum;
        if (logSum > peakVal) { peakVal = logSum; peakBin = k; }
    }
    if (!isFinite(peakVal)) return { freq: -1, confidence: 0, underBuffered: false };

    // Subharmonic correction — the classic HPS failure mode is picking
    // k = k_true / 2 on near-pure sines. A real fundamental has both
    // 2nd AND 3rd harmonics with comparable magnitude; a subharmonic
    // error doesn't — spec[3*peakBin] is pure leakage, tiny next to
    // spec[2*peakBin].
    if (peakBin * 3 < nBins) {
        const m1 = magnitudes[peakBin];
        const m2 = magnitudes[peakBin * 2];
        const m3 = magnitudes[peakBin * 3];
        const dominantSecond = m2 > 2 * m1;
        const weakThird = m3 < 0.1 * m2;
        if (dominantSecond && weakThird && peakBin * 2 <= highBin) {
            peakBin *= 2;
            peakVal = hps[peakBin];
        }
    }

    const delta = (peakBin > lowBin && peakBin < highBin)
        ? _ndParabolicOffset(hps[peakBin - 1], hps[peakBin], hps[peakBin + 1])
        : 0;
    const freq = (peakBin + delta) * binHz;

    const mean = sum / (highBin - lowBin + 1);
    const spread = peakVal - mean;
    const confidence = Math.min(1, Math.max(0, spread / (harmonics * Math.log(10))));

    return { freq, confidence, underBuffered: false };
}

// ── Constraint-Based Per-String Band Analysis ──────────────────────────────
//
// This is the core of the brief's proposal: instead of asking "what pitch is
// playing?" (hard for chords), ask "is there energy near frequency F on string
// S right now?" — a much simpler question that standard FFT can answer reliably.
//
// Used exclusively for chord scoring. Single notes continue to use YIN/HPS/CREPE
// via processFrame unchanged; the two paths are additive, not competing.

// Frequency bounds for each string covering frets 0–24 at standard tuning,
// with ±10% headroom for non-standard tunings, capo, and tuning offsets.
// Computed dynamically from MIDI tuning tables rather than hardcoded so
// 5-string bass, 7-string and 8-string guitar all derive correct ranges
// automatically.
//
// Returns [loHz, hiHz] for the given string/arrangement/stringCount/offsets/capo.
function _ndStringBandHz(stringIdx, arrangement, stringCount, offsets, capo) {
    const openMidi = _ndMidiFromStringFret(stringIdx, 0, arrangement, stringCount, offsets, capo);
    const fret24Midi = openMidi + 24;
    // MIDI → Hz: 440 * 2^((midi-69)/12)
    const loHz = 440 * Math.pow(2, (openMidi - 69) / 12) * 0.90; // -10% margin
    const hiHz = 440 * Math.pow(2, (fret24Midi - 69) / 12) * 1.10; // +10% margin
    return [loHz, hiHz];
}

// Measure the energy fraction in a frequency band [loHz, hiHz] relative to
// total spectrum energy, using the magnitude spectrum already computed by
// _ndFftMagnitude. Returns a value in [0, 1].
//
// Reuses the existing FFT scratch buffers — this is a read-only pass over
// magnitudes that were produced by _ndFftMagnitude in the same synchronous
// call chain, so no re-entrancy or buffer corruption risk.
function _ndBandEnergy(magnitudes, binHz, loHz, hiHz, totalEnergy = null) {
    const nBins = magnitudes.length;
    const loBin = Math.max(0, Math.floor(loHz / binHz));
    const hiBin = Math.min(nBins - 1, Math.ceil(hiHz / binHz));
    // hiBin === loBin (a band that covers exactly one FFT bin) is still a
    // valid case — include the bin's energy. Only bail when the band is
    // empty (hi strictly below lo, e.g. hi clamped below 0).
    if (hiBin < loBin) return 0;

    let bandEnergy = 0;
    for (let k = loBin; k <= hiBin; k++) {
        bandEnergy += magnitudes[k] * magnitudes[k];
    }

    // Caller can pre-compute total energy once per frame and pass it in
    // — saves N full-spectrum scans during chord scoring (one per
    // string). When omitted (e.g. single-string callers), compute here.
    if (totalEnergy === null) {
        totalEnergy = 0;
        for (let k = 0; k < nBins; k++) {
            totalEnergy += magnitudes[k] * magnitudes[k];
        }
    }
    if (totalEnergy < 1e-12) return 0;
    return bandEnergy / totalEnergy;
}

// Sum of squared magnitudes across the full spectrum. Pulled out so
// `_ndScoreChord` can compute it once per FFT frame and reuse it across
// every per-string `_ndBandEnergy` call.
function _ndTotalEnergy(magnitudes) {
    let total = 0;
    for (let k = 0; k < magnitudes.length; k++) {
        total += magnitudes[k] * magnitudes[k];
    }
    return total;
}

// Check whether a specific string+fret is audible in the current audio frame.
//
// Returns { hit: bool, bandEnergy: float, centsDiff: float|null, centsError: float|null }
//   centsDiff  — absolute pitch deviation in cents (null when pitch check is skipped)
//   centsError — signed pitch deviation in cents, positive = sharp (present only when
//                pitchCheckCents > 0 and band energy passes threshold; null otherwise)
//
// energyThreshold  — minimum band energy fraction to count as "string is
//                    ringing" (default 0.03, i.e. at least 3% of total
//                    spectrum energy). Lower this for hammer-ons and pull-offs
//                    where the pick attack is absent.
// pitchCheckCents  — if > 0, also verify the dominant frequency in the band
//                    is within this many cents of the expected pitch. Pass 0
//                    to skip the pitch check and use energy-only (faster,
//                    adequate for most chord hits on clean signals).
function _ndConstraintCheckString(
    buffer, sampleRate,
    stringIdx, fret, arrangement, stringCount, offsets, capo,
    pitchCheckCents = 0,
    energyThreshold = 0.03,
    precomputedSpectrum = null,
    precomputedTotalEnergy = null
) {
    // Optional precomputed spectrum + total energy let _ndScoreChord run
    // one FFT and one full-spectrum sum for the whole chord and reuse
    // both across per-string checks. The scratch buffer returned by
    // _ndFftMagnitude is module-level, so callers must keep this
    // synchronous and not interleave other FFT-using detectors.
    const { magnitudes, binHz } = precomputedSpectrum || _ndFftMagnitude(buffer, sampleRate);
    const [loHz, hiHz] = _ndStringBandHz(stringIdx, arrangement, stringCount, offsets, capo);

    const bandEnergy = _ndBandEnergy(magnitudes, binHz, loHz, hiHz, precomputedTotalEnergy);
    if (bandEnergy < energyThreshold) {
        return { hit: false, bandEnergy, centsDiff: null, centsError: null };
    }

    if (pitchCheckCents <= 0) {
        return { hit: true, bandEnergy, centsDiff: null, centsError: null };
    }

    // Find dominant bin in the band and refine with parabolic interpolation.
    const nBins = magnitudes.length;
    const loBin = Math.max(0, Math.floor(loHz / binHz));
    const hiBin = Math.min(nBins - 1, Math.ceil(hiHz / binHz));
    let peakBin = loBin;
    let peakVal = -Infinity;
    for (let k = loBin; k <= hiBin; k++) {
        if (magnitudes[k] > peakVal) { peakVal = magnitudes[k]; peakBin = k; }
    }
    const delta = (peakBin > loBin && peakBin < hiBin)
        ? _ndParabolicOffset(magnitudes[peakBin - 1], magnitudes[peakBin], magnitudes[peakBin + 1])
        : 0;
    const detectedHz = (peakBin + delta) * binHz;

    const expectedMidi = _ndMidiFromStringFret(stringIdx, fret, arrangement, stringCount, offsets, capo);
    const expectedHz = 440 * Math.pow(2, (expectedMidi - 69) / 12);
    const rawCentsError = 1200 * Math.log2(detectedHz / expectedHz);
    const centsError = _ndFoldOctaveCents(rawCentsError);
    const centsDiff = Math.abs(centsError);

    return { hit: centsDiff <= pitchCheckCents, bandEnergy, centsDiff, centsError };
}

// Score a chord by checking each of its constituent notes against their
// respective string frequency bands. Returns { score, hitStrings, totalStrings }.
//
// score = hitStrings / totalStrings (0..1)
// minHitRatio — fraction of strings that must ring for the chord to count as a hit.
//
// Each `chordNotes` entry may carry abbreviated technique flags from the chart
// note data (`cn.ho`, `cn.po`, `cn.b`, `cn.sl`, `cn.hm`), used to adjust
// per-string thresholds:
//   - ho/po (hammer-on / pull-off): lower energyThreshold (no fresh pick attack)
//   - b/sl (bend / slide): widen pitchCheckCents (pitch is in motion)
//   - hm (harmonic): energy-only check (pitch check at fundamental is unreliable)
//     — a future pass could check at 2x / 1.5x fundamental for stricter NYI
//     classification.
function _ndScoreChord(buffer, sampleRate, chordNotes, arrangement, stringCount, offsets, capo, pitchCheckCents, minHitRatio = 0.6) {
    let hitStrings = 0;
    const results = [];

    // Run one FFT for the whole chord and reuse the magnitude spectrum
    // across every per-string check. Without this a 6-string chord ran
    // 6 FFTs per detection tick — measurable CPU on slower devices.
    // Pre-compute total energy too — it's per-frame, not per-string,
    // and was the inner loop's dominant cost on a single 4096-point
    // spectrum.
    const spectrum = _ndFftMagnitude(buffer, sampleRate);
    const totalEnergy = _ndTotalEnergy(spectrum.magnitudes);

    for (const cn of chordNotes) {
        // Per-technique threshold adjustments (brief §"Handling Techniques")
        let energyThreshold = 0.03;
        let cents = pitchCheckCents;

        if (cn.ho || cn.po) {
            // Hammer-on / pull-off: no pick attack, energy will be lower
            energyThreshold = 0.015;
        }
        if (cn.b || cn.sl) {
            // Bend / slide: pitch is moving, widen the pitch window
            cents = Math.max(cents, 100);
        }
        if (cn.hm) {
            // Harmonic: energy-only check (pitch check at fundamental is unreliable)
            cents = 0;
        }

        const check = _ndConstraintCheckString(
            buffer, sampleRate,
            cn.s, cn.f, arrangement, stringCount, offsets, capo,
            cents, energyThreshold, spectrum, totalEnergy
        );
        results.push({ s: cn.s, f: cn.f, ...check });
        if (check.hit) hitStrings++;
    }

    const totalStrings = chordNotes.length;
    const score = totalStrings > 0 ? hitStrings / totalStrings : 0;

    // ── Voicing-reduction credit ─────────────────────────────────────
    // The strict score-ratio path counts "how much of the chart's full
    // voicing rang". For a chart that says "E major, all 6 strings", a
    // player who plays the same chord as a 2-string power voicing
    // (E + B = root + fifth on strings 0 and 1) scores 2/6 = 0.33 and
    // misses at the default cr=0.40. That's musically wrong for huge
    // categories of real playing — punk / pop-rock / country rhythm
    // guitar IS root + fifth voicings on full-chord charts. Real-song
    // data (American Jesus, Bad Religion rhythm, 1033 chord events)
    // showed ~50% of misses landing in exactly this 1-2-of-N regime,
    // while having clean timing and ringing the root every time.
    //
    // Add a parallel hit path: the chord ALSO counts as a hit if at
    // least 2 of the chord's strings rang at their expected pitches
    // (pitch-verified, not energy-only). This rewards reduced
    // voicings without rewarding random-string noise:
    //   • Single string alone → still a miss
    //   • Any ≥2 pitch-verified chord strings (in any combination) → hit
    //   • Full voicing → hit via ratio (the original path)
    //
    // Strict players who want "all strings must ring" can dial cr up
    // to 1.0. The pitch-verified gate (vs. raw energy) keeps incidental
    // noise from tripping the rescue path.
    //
    // Surface `voicingHit` separately from `isHit` so analytics /
    // diagnostics can see WHY a chord was credited.
    // Voicing-reduction = "at least 2 of the chord's strings rang at
    // their correct expected pitches". This is the bar for "the player
    // played a reduced voicing of this chord", as distinct from "random
    // string noise" — which fails to match any chord string's expected
    // pitch and so doesn't contribute to the count.
    //
    // An earlier formulation required the chart's LOWEST string (the
    // bass note) to be one of the rung strings, reasoning that a real
    // chord must include its root. Real-song data caught the issue:
    // players often strum the middle/high strings of a chord shape
    // without sounding the lowest note (string skipping, fast strumming,
    // open-chord shapes where the bass is muted by hand position). Those
    // are valid 2-note interpretations of the chord too. The pitch-
    // verified gate is the real protection against energy-only false
    // positives — once 2 chord strings are confirmed at their correct
    // pitches, it doesn't matter which 2 they are.
    let voicingHit = false;
    if (results.length >= 2) {
        let pitchVerifiedHits = 0;
        for (const r of results) {
            // `hit && finite centsDiff` means the per-string check ran
            // a real pitch comparison and accepted. Energy-only "hit"s
            // (centsDiff null, from the pitchCheckCents <= 0 path used
            // by harmonics) intentionally don't count here — see the
            // "energy-only mode gates off voicing-reduction" test.
            if (r.hit && Number.isFinite(r.centsDiff)) pitchVerifiedHits++;
            if (pitchVerifiedHits >= 2) break;
        }
        if (pitchVerifiedHits >= 2) voicingHit = true;
    }

    // `isHit` reflects ONLY the strict ratio path — that's what
    // matchNotes uses to decide whether to commit a hit on the
    // current frame. The `voicingHit` flag is informational: it
    // means "if matchNotes never finds a strict-ratio frame for
    // this chord, checkMisses should rescue it as a hit at retire
    // time instead of recording a miss." This deferred-commit
    // approach lets strict-ratio frames (which tend to have better
    // timing because they fire later in the chord's audio decay)
    // win out, and voicing-reduction only kicks in as a fallback —
    // avoiding the timing-eager-commit regression where a sub-
    // threshold early frame locked in a hit with bad timing.
    const isHit = score >= minHitRatio;
    return { score, hitStrings, totalStrings, results, isHit, voicingHit };
}
// ── Pitch Detection: CREPE (shared model) ──────────────────────────────────

async function _ndLoadCrepe() {
    if (_ndShared.model || _ndShared.modelLoading) return;
    _ndShared.modelLoading = true;
    // Refresh every instance's button so any detector on 'crepe' shows
    // "loading model..." while the ~20 MB download is in flight.
    // Without this, the UI stays idle for the multi-second download
    // window and users get no feedback.
    for (const inst of _ndInstances) inst._updateButton();

    try {
        if (!window.tf) {
            await _ndLoadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js');
        }
        _ndShared.model = await tf.loadGraphModel(
            'https://tfhub.dev/google/tfjs-model/spice/2/default/1',
            { fromTFHub: true }
        );
        console.log('CREPE/SPICE model loaded');
    } catch (e1) {
        console.warn('SPICE TFHub load failed, trying CREPE backup:', e1);
        try {
            _ndShared.model = await tf.loadLayersModel(
                'https://cdn.jsdelivr.net/gh/nicksherron/crepe-js@master/model/model.json'
            );
            console.log('CREPE model loaded (fallback)');
        } catch (e2) {
            console.warn('All model loads failed, using YIN for this session:', e2);
            _ndShared.model = null;
        }
    }
    _ndShared.modelLoading = false;
    // Update every instance's button — any of them might be on crepe.
    for (const inst of _ndInstances) inst._updateButton();
}

function _ndLoadScript(src) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

async function _ndCrepeDetect(buffer) {
    if (!_ndShared.model) return { freq: -1, confidence: 0 };
    try {
        const input = tf.tensor(buffer, [1, buffer.length]);
        let outputs;
        if (_ndShared.model.execute) {
            outputs = _ndShared.model.execute(input);
        } else {
            outputs = _ndShared.model.predict(input);
        }

        let freq = -1, confidence = 0;
        if (Array.isArray(outputs)) {
            const pitchData = await outputs[0].data();
            const uncData = outputs.length > 1 ? await outputs[1].data() : null;
            const raw = pitchData[0];
            if (raw > 0 && raw < 1) {
                freq = Math.pow(2, 5.661 * raw + 4.0);
            } else if (raw > 20) {
                freq = raw;
            }
            confidence = uncData ? Math.max(0, 1 - uncData[0]) : 0.8;
            outputs.forEach(t => t.dispose());
        } else {
            const pitchData = await outputs.data();
            const raw = pitchData[0];
            if (raw > 0 && raw < 1) {
                freq = Math.pow(2, 5.661 * raw + 4.0);
            } else if (raw > 20) {
                freq = raw;
            }
            confidence = pitchData.length > 1 ? Math.max(0, 1 - pitchData[1]) : 0.8;
            outputs.dispose();
        }
        input.dispose();

        if (freq < 20 || freq > 5000) return { freq: -1, confidence: 0 };
        return { freq, confidence };
    } catch (e) {
        return { freq: -1, confidence: 0 };
    }
}

// ── Factory: createNoteDetector ────────────────────────────────────────────
//
// Returns an independent detector instance. Each instance owns its
// own audio pipeline, scoring, HUD, timers, and DOM subtree. Shared
// resources (CREPE model, tuning tables, FFT scratch) stay at module
// scope to avoid duplication.
//
// Audio lifecycle — important for multi-instance use:
//   - If `audioStream` and `audioCtx` are passed in `options`, this
//     instance is a BORROWER. disable() disconnects its own nodes
//     but does NOT stop the stream or close the context; the parent
//     owns those.
//   - If neither is passed, the instance OWNS an AudioContext and
//     MediaStream that it creates on enable() and tears down on
//     disable(). The default singleton operates this way.
//   - No reference counting — shared lifecycle is the parent's
//     responsibility.
//
// Options:
//   highway      — highway instance (default: window.highway)
//   container    — DOM parent for the instance's HUD/panels
//                  (default: document.getElementById('player'))
//   channel      — -1 (mono mix, default), 0 (left), 1 (right)
//   audioStream  — optional shared MediaStream (borrowing mode)
//   audioCtx     — optional shared AudioContext (borrowing mode)
//   isDefault    — true for the singleton; only the default instance
//                  persists settings changes to localStorage
//
// Returns an API object with:
//   enable()         — async; start audio + detection
//   disable()        — stop audio + detection + show summary
//   destroy()        — disable() + remove DOM + unregister instance
//   isEnabled()      — current toggle state
//   getStats()       — {hits, misses, streak, bestStreak, accuracy, sectionStats}
//   setChannel(idx)  — -1=mono, 0=left, 1=right (restarts audio if enabled)
//   injectButton(bar)— insert detect + gear buttons into a control bar
//   showSummary()    — force-show the end-of-song summary modal

// Encode an Array<Float32Array> of mono samples (any chunk size) as a
// 16-bit PCM mono RIFF/WAVE blob. Used by the in-app reference-recording
// capture so the headless harness can read back exactly the audio the
// detector saw. Soft-clips to int16 range; no dithering — fine for the
// detector's downstream analysis but don't ship this as a master.
function _ndEncodeWavPcm16(chunks, sampleRate) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const buf = new ArrayBuffer(44 + total * 2);
    const v = new DataView(buf);
    let off = 0;
    const w4  = (s) => { for (let i = 0; i < 4; i++) v.setUint8(off++, s.charCodeAt(i)); };
    const w16 = (n) => { v.setUint16(off, n, true); off += 2; };
    const w32 = (n) => { v.setUint32(off, n, true); off += 4; };
    w4('RIFF');  w32(36 + total * 2);  w4('WAVE');
    w4('fmt ');  w32(16);
    w16(1);                                          // PCM
    w16(1);                                          // mono
    w32(sampleRate);
    w32(sampleRate * 2);                             // byte rate
    w16(2);                                          // block align
    w16(16);                                         // bits per sample
    w4('data');  w32(total * 2);
    for (const c of chunks) {
        for (let i = 0; i < c.length; i++) {
            let s = c[i];
            if (s > 1)  s =  1;
            else if (s < -1) s = -1;
            v.setInt16(off, (s * 32767) | 0, true);
            off += 2;
        }
    }
    return buf;
}

function createNoteDetector(options = {}) {
    const opts = options || {};
    // Highway is resolved lazily. A caller can pass `highway` in
    // options for explicit binding (splitscreen per-panel use);
    // otherwise we fall back to `window.highway`, re-checking on
    // every access so late initialization (plugin loads before
    // slopsmith-core defines highway) is picked up automatically.
    let hw = opts.highway || window.highway || null;
    function resolveHw() {
        if (hw) return hw;
        hw = opts.highway || window.highway || null;
        return hw;
    }
    const isDefault = !!opts.isDefault;

    // Audio ownership: if caller passed stream/ctx in, they own the
    // lifecycle. We flag the "borrower" vs "owner" state here and
    // consult it in stopAudio().
    const externalStream = opts.audioStream || null;
    const externalAudioCtx = opts.audioCtx || null;
    // Track ownership of each resource independently — a caller can
    // pass just a stream (we create the context) or just a context
    // (we open getUserMedia for the stream). Basing teardown on
    // `!externalStream` alone would leak a context in the former case.
    const ownsStream = !externalStream;
    const ownsAudioCtx = !externalAudioCtx;

    // ── Per-instance state ────────────────────────────────────────────
    let enabled = false;
    // User preference for whether detection should be running. Default
    // is true (Detect on out of the box) — overridden by localStorage
    // when the user has explicitly toggled. Distinct from `enabled`
    // because the audio pipeline can't be claimed during construction
    // (highway may not be ready, mic permissions may not be cached),
    // so this is the *intent* and `enabled` is the *current run state*.
    // The plugin auto-calls enable() on next tick if this is true.
    let detectPreference = true;
    // Set only around the construct-time auto-enable's first (silent,
    // automatic) attempt — the one with a delayed retry still in hand. In that
    // window the open should be non-committal: startAudio() suppresses its
    // user-facing failure alert (a transient not-ready device shouldn't pop a
    // dialog on load) AND openInstrumentStream() preserves a saved deviceId
    // that fails to match (it may just be mid-enumeration) instead of forgetting
    // it. The retry and every user-initiated enable run with this false, so
    // genuine failures surface and a genuinely stale device is forgotten.
    let autoEnableTrial = false;
    // Session generation — incremented on every disable(). A frame
    // that captures the value at the start of processing and re-checks
    // after an `await _ndCrepeDetect(...)` can drop its result rather
    // than apply stale hits to a disabled (or re-enabled) session.
    let sessionGen = 0;
    let audioCtx = null;
    let stream = null;
    // Full audio-node chain — stored so stopAudio can disconnect
    // every node, not just the ScriptProcessor. Matters particularly
    // in borrower mode (external audioCtx): without tearing these
    // down the caller's context graph grows by N nodes per
    // enable/disable cycle.
    let sourceNode = null;
    let gainNode = null;
    let splitterNode = null;
    let mergerNode = null;
    let worklet = null;
    let levelAnalyser = null;

    // Settings — seed from localStorage defaults (shared with singleton),
    // then override from options where provided. Only the default
    // singleton writes back to localStorage; non-default instances keep
    // mutations local.
    let detectionMethod = 'yin';
    // Whether the user explicitly picked a detection method (settings or the
    // dropdown). When false, a bass arrangement auto-uses HPS — see
    // _ndEffectiveDetectionMethod — since YIN locks onto the 2nd harmonic of a
    // weak-fundamental bass note and reports an octave high.
    let detectionMethodUserSet = false;
    // Opt-in: on the desktop bridge, run note_detect's own pitch detector on
    // engine-captured PCM (getRawAudioFrame) rather than the engine's
    // verdicts. Default off — the engine verdict/verifier path stays the
    // out-of-box behaviour. See `usingNativeFrames`.
    let nativeDetection = false;
    let timingTolerance = 0.150;
    let pitchTolerance = 50;
    let timingHitThreshold = 0.100;
    // Chord-specific timing-OK window. Wider than the single-note
    // threshold because a chord strum spans 5–10 ms across strings and
    // the per-string FFT analysis window itself smears chord-strike
    // timing by another 50–100 ms — so the inherent jitter on a chord
    // event is closer to ±150 ms than the single-note ±100 ms. Fast
    // punk / pop-rock rhythm players also anticipate the beat by 80–
    // 120 ms (issue #38 — "Bad Habit", "American Jesus"), and the strict
    // 100 ms window cuts off most of that bias even when the chord was
    // scored as a strict-ratio hit. Default 150 ms; clamped >=
    // timingHitThreshold at load so chord scoring is never stricter
    // than single notes.
    let chordTimingHitThreshold = 0.150;
    let pitchHitThreshold = 20;
    let showTimingErrors = true;
    let showPitchErrors = true;
    // slopsmith#254 — the full-screen green/red edge flash on hit/miss.
    // Off by default now that the highway renderer lights the note gem
    // itself (and sizzles it); users who want the peripheral cue back can
    // re-enable it in the gear popover.
    let edgeFlashEnabled = false;
    // Tuning mode — opt-in switch for everything the detector exposes
    // for development / tuning / benchmarking (the Reference Recording
    // panel, the Diagnostic JSON export / Reset, the miss-category
    // breakdown on the end-of-song summary). Off by default — these
    // surfaces are noise for normal play. Gated by a single checkbox
    // in the gear popover. Persisted in localStorage alongside the
    // other settings.
    let tuningMode = false;
    // Auto-record every play (default singleton only) so each take is
    // captured for later analysis — the teaching-tool goal — without the
    // user arming anything. Off by default — opt in via Settings. The manual Arm /
    // Arm-(training) dev surfaces stay behind tuningMode and override
    // this (we only auto-arm when nothing is already armed for training).
    let autoRecord = false;
    // Detection frame size — the ScriptProcessor buffer fed to the
    // detector each callback. 1024 (~21 ms @48k) is too short to resolve a
    // low-bass fundamental (low-E period ~24 ms), so the detector silently
    // drops most bass notes; 2048 (~43 ms) nearly triples bass recall
    // (harness-measured 27%→77% on a real take) for an imperceptible
    // latency cost. Persisted + tunable so downstream bass-accuracy work is
    // configuration, not a code fork. Clamped to a valid ScriptProcessor
    // buffer size on load.
    let frameSize = 2048;
    // Auto-calibrate the A/V offset from each play: log offset-free detections,
    // then on song-end sweep for the offset that maximizes matched notes (the
    // harness objective) and apply it via window.setAvOffsetMs — so the user
    // never hand-sets the latency number. Persisted/tunable like the others.
    let autoCalibrate = true;
    let missMarkerDuration = 2.0;
    let hitGlowDuration = 0.5;
    let inputGain = 1.0;
    let selectedDeviceId = '';
    let selectedChannel = 'mono';
    // Detector pipeline latency compensation. 0.080 is the historical
    // default; the right value is heavily audio-chain-dependent (USB
    // interfaces, ScriptProcessor buffering, OS audio path all vary).
    // Users typically dial this via the gear-popover slider; the A/V
    // auto-calibrate panel suggests a value derived from their own
    // recently-detected note timings. We tried bumping the default to
    // match one heavy-user's empirical value, but it over-corrected
    // for users with shorter chains (caused their on-time playing to
    // register as "early" misses). Keeping the conservative default
    // and pointing users at the calibrate workflow is the right
    // trade-off.
    let latencyOffset = 0.080;
    // Fraction of a chord's strings that must register energy for the
    // chord to count as a hit (0.0–1.0). Was 0.6 historically, but
    // harness measurements against real-guitar recordings showed
    // chord scoring near 0/16 at that gate even for clean
    // playing. Dropping to 0.40 lets typical open/power-chord
    // voicings score multi-string hits without rewarding single-
    // string strums. Users who want stricter scoring can raise via
    // the slider.
    let chordHitRatio = 0.40;
    // Minimum YIN/HPS/CREPE confidence to accept a detection. Below
    // this, the per-frame result is discarded and the note retires
    // as a "pure" miss. Previously hardcoded to 0.30 at every gate
    // (6 sites in this file: two YIN/HPS result gates, three
    // detectedMidi-on-confidence gates, and the desktop-bridge pitch
    // detection gate); real-rig diagnostics on a healthy
    // signal showed ~47% of frames falling below that floor on CREPE
    // — most of the "pure" miss bucket. Default lowered to 0.20 +
    // exposed as a UI slider (gear popover) so users with quieter
    // / noisier signals can tune. Range 0.05–0.50 clamped on load.
    let detectionConfidenceMin = 0.20;

    try {
        const raw = localStorage.getItem(_ND_STORAGE_KEY);
        if (raw) {
            const s = JSON.parse(raw);
            if (s.deviceId !== undefined) selectedDeviceId = s.deviceId;
            // Allowlist channel — a manually-edited or future-version
            // storage value would otherwise fall through `startAudio`'s
            // `selectedChannel === 'left' ? 0 : 1` check and silently
            // default to the right channel. Same defensive shape as
            // the method allowlist below.
            if (['mono', 'left', 'right'].includes(s.channel)) selectedChannel = s.channel;
            const storedMethod = (typeof s.method === 'string'
                && ['yin', 'hps', 'crepe'].includes(s.method)) ? s.method : null;
            if (storedMethod) detectionMethod = storedMethod;
            // A persisted `method` alone is NOT a manual override: saveSettings()
            // always writes the current method, including the untouched default
            // 'yin'. Treat it as user-set only when the explicit flag is stored,
            // or a VALIDATED non-default method was stored — otherwise a returning
            // user who only changed an unrelated setting (or has a corrupted
            // method value) would lose bass auto-HPS.
            detectionMethodUserSet = !!s.methodUserSet || (storedMethod !== null && storedMethod !== 'yin');
            // Clamp tolerances to the UI slider ranges (30–300ms, 10–100c)
            // before deriving hit thresholds so a stale or manually-edited
            // stored value can't produce an invalid range input or a hit
            // threshold that exceeds the tolerance ceiling.
            if (s.timingTolerance !== undefined) timingTolerance = Math.max(0.03, Math.min(0.3, s.timingTolerance));
            if (s.pitchTolerance !== undefined) pitchTolerance = Math.max(10, Math.min(100, s.pitchTolerance));
            if (s.timingHitThreshold !== undefined) timingHitThreshold = Math.max(0.03, Math.min(timingTolerance, s.timingHitThreshold));
            // Chord threshold clamp: at least the single-note strict threshold
            // (chords shouldn't be stricter than single notes), at most the
            // outer timing tolerance (we're widening within the existing
            // candidate window, not pushing past it).
            if (s.chordTimingHitThreshold !== undefined) chordTimingHitThreshold = Math.max(timingHitThreshold, Math.min(timingTolerance, s.chordTimingHitThreshold));
            if (s.pitchHitThreshold !== undefined) pitchHitThreshold = Math.max(5, Math.min(pitchTolerance, s.pitchHitThreshold));
            if (s.showTimingErrors !== undefined) showTimingErrors = !!s.showTimingErrors;
            if (s.showPitchErrors !== undefined) showPitchErrors = !!s.showPitchErrors;
            if (s.edgeFlash !== undefined) edgeFlashEnabled = !!s.edgeFlash;
            if (s.tuningMode !== undefined) tuningMode = !!s.tuningMode;
            if (s.autoRecord !== undefined) autoRecord = !!s.autoRecord;
            if (s.frameSize !== undefined) frameSize = _ndClampFrameSize(s.frameSize);
            if (s.autoCalibrate !== undefined) autoCalibrate = !!s.autoCalibrate;
            if (s.nativeDetection !== undefined) nativeDetection = !!s.nativeDetection;
            // Persisted on/off preference. Absence keeps the default
            // (true), so fresh installs get Detect on out of the box.
            if (s.detectEnabled !== undefined) detectPreference = !!s.detectEnabled;
            if (s.missMarkerDuration !== undefined) missMarkerDuration = Math.max(0.5, Math.min(5, s.missMarkerDuration));
            if (s.hitGlowDuration !== undefined) hitGlowDuration = Math.max(0.1, Math.min(2, s.hitGlowDuration));
            if (Number.isFinite(s.inputGain)) inputGain = Math.max(0.1, Math.min(5, s.inputGain));
            if (s.latencyOffset !== undefined) latencyOffset = s.latencyOffset;
            // Clamp to the slider's range so a stale persisted value
            // (older build, manual edit) can't put scoring in a state the
            // UI can't represent.
            if (s.chordHitRatio !== undefined) chordHitRatio = Math.max(0.25, Math.min(1, s.chordHitRatio));
            // Detection confidence floor — clamp to a sensible range.
            // Below 0.05, even pure noise becomes a "detection"; above
            // 0.50, even confident YIN/CREPE frames get rejected on
            // typical guitar signals.
            if (s.detectionConfidenceMin !== undefined) {
                detectionConfidenceMin = Math.max(0.05, Math.min(0.50, s.detectionConfidenceMin));
            }
        }
    } catch (e) { /* localStorage unavailable */ }
    // Chord window invariant — single-note strict can't exceed chord
    // (a stored chord value smaller than the loaded strict threshold
    // would invert the relationship); and chord can't exceed the outer
    // tolerance (we're widening within the candidate window, not past
    // it). The latter trips when a user has a stored timingTolerance
    // below the chord default and no chordTimingHitThreshold yet.
    if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
    if (chordTimingHitThreshold > timingTolerance)    chordTimingHitThreshold = timingTolerance;

    // Engine input channel index for the DESKTOP source path (-1 = mono mix of the
    // first pair, else 0-based). Source of truth for addSource/setSourceInputChannel
    // and supports channels beyond L/R (a multi-channel interface, or a PipeWire
    // combine of two interfaces). `selectedChannel` (the string above) stays what
    // the 2-channel browser splitter uses; the two are kept in sync for the values
    // the splitter can represent (-1/0/1).
    let _ndChannelIndex = selectedChannel === 'left' ? 0
        : selectedChannel === 'right' ? 1 : -1;

    // Phase 2: which engine input DEVICE this instance's source captures from.
    // 0 = primary input device (the only one on the single-device path); 1..N =
    // an ADDITIONAL device the host (splitscreen) bound via bindInputDevice, so
    // two separate interfaces each feed their own panel. Fixed at addSource time
    // (a source's device can't change live — re-add to move it). Desktop-only.
    let _ndDeviceKey = 0;
    if (typeof opts.deviceKey === 'number' && Number.isInteger(opts.deviceKey) && opts.deviceKey >= 0)
        _ndDeviceKey = opts.deviceKey;

    // Phase 2: user-dialed capture-latency correction (milliseconds) for a source
    // on an EXTRA input device — the residual offset between that device's path and
    // the primary's, which can't be auto-measured reliably on JACK/PipeWire. The
    // host (splitscreen) exposes a per-panel control that calls setVerifierOffset().
    // Positive = scoring playhead later; negative = earlier. Applied to the bound
    // source's engine verifier. No effect on the primary / browser path.
    let _ndVerifierOffsetMs = 0;
    if (typeof opts.verifierOffsetMs === 'number' && Number.isFinite(opts.verifierOffsetMs))
        _ndVerifierOffsetMs = opts.verifierOffsetMs;
    function _ndApplyVerifierOffset() {
        const a = _ndBridgeAudio();
        // Apply ONLY to a source WE allocated (_ndOwnsSource). Never source 0 (the
        // shared legacy/default path), and never a borrowed opts.sourceId the detector
        // doesn't own — mutating a shared/reused source would leak this panel's latency
        // correction onto another consumer and skew its scoring.
        if (_ndOwnsSource && sourceId != null && sourceId !== 0
            && a && typeof a.setSourceVerifierOffset === 'function') {
            try { a.setSourceVerifierOffset(sourceId, _ndVerifierOffsetMs / 1000); } catch (_) { /* best-effort */ }
        }
    }

    // opts.channel overrides the persisted channel for this instance (used by
    // splitscreen to bind each panel to a distinct input channel). Accepts -1/0/1
    // (mono/left/right). Channel >= 2 (multi-channel selection) is DEFERRED — see
    // setChannel() — so clamp it to mono rather than store an index the capture path
    // may not honor (which would also export stale selectedChannel metadata).
    if (typeof opts.channel === 'number' && Number.isInteger(opts.channel) && opts.channel >= -1) {
        if (opts.channel >= 2) {
            console.warn(`[note_detect] opts.channel ${opts.channel} (multi-channel selection) is not yet supported; using mono.`);
            _ndChannelIndex = -1;
            selectedChannel = 'mono';
        } else {
            _ndChannelIndex = opts.channel;
            if (opts.channel === 0) selectedChannel = 'left';
            else if (opts.channel === 1) selectedChannel = 'right';
            else selectedChannel = 'mono';  // -1
        }
    }

    // Audio metering
    let inputLevel = 0;
    let inputPeak = 0;
    let peakDecay = 0;

    // Calibration Wizard v2 — system setup only (safe settings; no scoring thresholds)
    let _calWizardEl = null;
    let _calWizardTick = null;
    let _calWizardState = null;
    // One-shot callbacks for the public launchCalibration() entry (input_setup
    // onboarding). Set after the wizard opens; cleared on close.
    let _calWizardOnDone = null;
    let _calWizardOnCancel = null;
    // Instrument forced by launchCalibration({instrument}) for the standalone
    // (no-song) onboarding flow. _syncChartStateFromHw resets currentArrangement
    // to 'guitar' on every resolve when no chart is loaded, which would clobber a
    // bass calibration; honor this override while no real song tuning exists.
    let _calWizardForceArrangement = null;
    const _CAL_WIZARD_NOTE_CHECK_DEFS = [
        { id: 'lowE', string: 0, fallbackLabel: 'Low E', fallbackMidi: 40 },
        { id: 'openA', string: 1, fallbackLabel: 'Open A', fallbackMidi: 45 },
    ];
    const _CAL_WIZARD_STEPS = [
        { id: 'welcome', title: 'Welcome' },
        { id: 'audio', title: 'Audio Input' },
        { id: 'tuner', title: 'Tuner' },
        { id: 'noise', title: 'Noise Floor' },
        { id: 'signal', title: 'Signal Level' },
        { id: 'notes', title: 'Note Detection' },
        { id: 'timing', title: 'Timing / Latency' },
        { id: 'review', title: 'Review' },
        { id: 'apply', title: 'Apply' },
    ];

    // Renderer-side silence gate. CREPE on this engine emits high-
    // confidence stuck-pitch output on silence (interference / induced
    // signal even with the guitar muted); the engine's verifier accepts
    // it, and bent / slide / harmonic notes' 600¢ pitch leniency widens
    // the window so far that those phantom pitches pass as hits — giving
    // ~50% false-hit rate with no input. The fix is to track recent
    // input levels and, when a verdict arrives, force its `detected` to
    // false if no real signal existed around the note's chart time.
    const _ndLevelSamples = [];
    const _ND_LEVEL_HISTORY_S = 6;
    const _ND_LEVEL_WIN_HALF = 0.2;  // ±200 ms around chartTime
    const _ND_SILENCE_THRESHOLD = 0.02;  // ~2% of full scale

    // Scoring
    let hits = 0;
    let misses = 0;
    let streak = 0;
    let bestStreak = 0;
    // Game points (base × streak multiplier per clean hit) and the
    // multiplier tier itself — see the top-level _ndMultiplierForStreak /
    // ND_BASE_* helpers. maxMultiplier is the session high-water mark for
    // the end-of-song summary.
    let score = 0;
    let multiplier = 1;
    let maxMultiplier = 1;
    let sectionStats = [];   // [{name, hits, misses}]
    let currentSection = null;
    const noteResults = new Map(); // key -> judgment object

    // Position-aware score ledger. One compact entry per COUNTED judgment,
    // keyed by the SAME key as noteResults (so the two prune in lockstep) but
    // never garbage-collected — noteResults is pruned for memory (see the gc
    // interval), so it can't be replayed to rebuild the score after a big
    // seek-back. This ledger is the source of truth for _recomputeScoreToPosition,
    // which fires when the player repositions BACKWARD in the song (Restart
    // button, scrub-back) so the HUD reflects only the notes up to the new
    // playhead instead of keeping the stale cumulative total. Entry shape:
    // { t: chart-note time (s), hit: bool, chord: bool }. Cleared in resetScoring().
    const _scoreLedger = new Map();
    // song:seek subscription (per-instance, bound from enable(), torn down in
    // destroy() — survives the per-song silent-disable like the reArm/endOfSong
    // listeners). See _onSongSeekReposition / _seekResetBindEvents.
    let seekResetSubscribed = false;
    let seekResetOnSeekFn = null;

    // ── Miss-category diagnostic (#254 follow-up) ─────────────────────
    // Counts WHY a judgment missed so a session report can isolate the
    // dominant failure mode — pure misses → mic/audio chain; chord-partial
    // → leniency too tight; timing → window too narrow; pitch → tolerance
    // too narrow. Each miss falls into exactly one primary bin (chord
    // events into chordPartial regardless of axis); per-string + signed-
    // error arrays let us see which strings the player is losing on and
    // whether they trend sharp/flat or early/late. Reset alongside
    // hits/misses in resetScoring(); refs stay stable across reset.
    const _diagBreakdown = {
        pure: 0,           // miss, no pitch detected within the timing window
        chordPartial: 0,   // chord event below the chord-leniency threshold
        early: 0,
        late: 0,
        sharp: 0,
        flat: 0,
    };

    // Read-only verifier rejection log (last N chart-verify failures).
    const _ND_VERIFIER_REJECT_MAX = 20;
    const _ndVerifierRejects = [];
    const _ndRejectDedup = new Set();   // note/chord keys already logged this session
    const _ndVerifyFailSnap = new Map(); // noteKey -> last scoreChord !hit snapshot (legacy path)
    const _ND_REJECT_REASON_LABEL = {
        NO_VERDICT: 'engine no verdict',
        SILENCE_GATE: 'silence gate',
        STRING_VERIFY_FAIL: 'string verify fail',
        CHORD_RATIO_FAIL: 'chord ratio fail',
        TIMING_FAIL: 'timing fail',
        PITCH_FAIL: 'pitch fail',
        RETIRE_NO_MATCH: 'retire no match',
        UNKNOWN: 'unknown',
    };
    const _diagSingles = { hits: 0, misses: 0 };
    const _diagChords  = { hits: 0, misses: 0 };
    // Per-string. 8 covers 4/5/6/7/8-string arrangements without resizing.
    const _diagPerString = Array.from({ length: 8 }, () => ({ hits: 0, misses: 0 }));
    // Signed errors for matched judgments (excludes pure misses where no
    // measurement exists). Capped to keep memory bounded across long
    // sessions; percentiles in the summary run on the raw array.
    const _DIAG_ERROR_CAP = 2000;
    const _diagTimingErrors = [];   // milliseconds, sign = positive late / negative early — all matched judgments
    // Hit-only timing samples. The all-matched array above includes
    // judgments where the matcher snapped to a *neighbouring* chart note
    // (closest-by-time wins, even if the user's actual playing skew is
    // big), so its median is pinned by the matching window instead of
    // tracking real audio↔chart drift. Restricting to actual hits gives
    // a signal that responds linearly to A/V offset, which is what the
    // auto-calibrate button keys off of.
    const _diagTimingErrorsHits = [];
    // A/V auto-calibration: offset-free detections logged across a play
    // ({ bt: hw.getTime()-latencyOffset, m: detectedMidi }); swept on song-end.
    let _calDetections = [];
    const _CAL_MAX = 8000;          // ~ caps memory on a long take
    let _calDoneThisPlay = false;   // calibrate at most once per play
    // True between a song:pause and the next song:play, so song:play can tell
    // a resume (keep the take's detections) from a fresh start (reset them).
    // Without this, a replay or a stop-without-song:ended would sweep stale
    // detections from the previous play.
    let _calPaused = false;
    let _lastAvCalibration = null;  // { offsetMs, matched, total } for the UI
    const _diagPitchErrors  = [];   // cents,        sign = positive sharp / negative flat
    // Per-judgment event capture for the downloadable JSON. Capped at a
    // size that keeps the JSON small enough to share via copy-paste.
    const _DIAG_EVENT_CAP = 2000;
    const _diagEvents = [];

    // Live-streaming state. When tuning mode is on, every judgment is
    // also POSTed to /api/plugins/note_detect/live-judgment so an
    // off-device reader (the host iterating against this code) can
    // watch a session unfold in real time. The session id changes on
    // every `song:play` so each take produces its own JSONL file; the
    // value is used directly as a filename slug server-side, so it
    // sticks to filesystem-safe characters. Off (null) until the first
    // song:play fires with tuning mode on.
    let _liveSessionId = null;
    // Last minted session id, kept after song:ended (unlike
    // _liveSessionId which _liveOnEnded clears) so the training-bundle
    // upload can still locate the take's live_<id>.jsonl detect-stream.
    let _liveLastSessionId = null;
    function _buildSessionHeader() {
        // Snapshot the user's live settings + song context at song:play
        // time. Lands as the first JSONL line of the session file so
        // any offline reader (host-side regression runner, future
        // default-suggestion tooling, a maintainer looking at a shared
        // session) knows what knobs produced the judgments below.
        // Keep field names consistent with the `settings` block in the
        // diagnostic export — same vocabulary across the two formats.
        const info = (hw && hw.getSongInfo) ? hw.getSongInfo() : {};
        const avOffsetMs = (hw && hw.getAvOffset) ? hw.getAvOffset() : 0;
        return {
            type: 'session_start',
            schema: 'note_detect.live.session_start.v1',
            ts: new Date().toISOString(),
            plugin_version: _ND_VERSION,
            song: {
                title: info.title || null,
                artist: info.artist || null,
                arrangement: info.arrangement || null,
                arrangement_index: (info.arrangement_index != null) ? info.arrangement_index : null,
                tuning: info.tuning || null,
                capo: info.capo != null ? info.capo : 0,
                duration: info.duration != null ? info.duration : null,
            },
            settings: {
                method: detectionMethod,
                timing_tolerance_s: timingTolerance,
                timing_hit_threshold_s: timingHitThreshold,
                chord_timing_hit_threshold_s: chordTimingHitThreshold,
                pitch_tolerance_cents: pitchTolerance,
                pitch_hit_threshold_cents: pitchHitThreshold,
                chord_hit_ratio: chordHitRatio,
                detection_confidence_min: detectionConfidenceMin,
                latency_offset_s: latencyOffset,
                input_gain: inputGain,
                channel: selectedChannel,
                av_offset_ms: avOffsetMs,
            },
        };
    }
    function _streamLiveJudgment(eventObj) {
        // Fire-and-forget — the network round-trip MUST NOT block the
        // detection hot path. We don't await it here: any failure
        // (server down, file capped, etc.) is silently swallowed so the
        // in-memory diagnostic stays the source of truth and detection
        // keeps running. The promise IS tracked in _livePending, though,
        // so _flushLiveJudgments() can drain it before a training bundle
        // is zipped server-side (otherwise the last judgments / the
        // session header could miss the JSONL).
        try {
            const p = fetch(
                '/api/plugins/note_detect/live-judgment?session='
                    + encodeURIComponent(_liveSessionId),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(eventObj),
                    keepalive: true,   // survives page nav / song-end teardown
                },
            ).catch(() => {});
            _livePending.add(p);
            p.finally(() => _livePending.delete(p));
        } catch (e) { /* swallow — see comment above */ }
    }

    // In-flight /live-judgment POSTs. Drained by _flushLiveJudgments()
    // before a training bundle is requested.
    const _livePending = new Set();
    async function _flushLiveJudgments() {
        // Snapshot: only the POSTs already issued belong to the take
        // that just ended.
        try { await Promise.allSettled([..._livePending]); } catch (_) {}
    }

    // ── Reference-recording capture (#254 follow-up) ──────────────────
    // Captures the SAME Float32 audio frames the detector is running its
    // analysis on, while a song is playing, so the headless harness has
    // a known-aligned WAV to feed it — no DAW / Audacity needed. Auto-
    // starts on song:play once armed, auto-saves on song:ended. The WAV
    // lands under `static/note_detect_recordings/` via the routes.py POST
    // endpoint; that dir is bind-mounted in the dev container so the
    // harness on the host can read it back without a copy step.
    let _recArmed = false;            // user clicked Arm; waiting for / actively recording
    let _recArmedForTraining = false; // set alongside _recArmed when the user clicked Arm (training);
                                      // triggers the post-save POST to /training-bundle that
                                      // zips WAV+JSONL+manifest and uploads to pCloud
    let _recSongPlaying = false;      // tracks song:play / song:pause / song:ended
    let _recChunks = [];              // Array<Float32Array>; concatenated only on save
    let _recSampleRate = 44100;       // captured from audioCtx when the first frame lands
    let _recLastSavePath = null;      // host-visible relative path of the most recent save
    let _recLastSaveError = null;     // surfaced in the UI when a save fails
    let _recSaveInFlight = false;     // de-dupe rapid saves
    let _recCappedAt = null;          // seconds into the take where the client-side cap kicked in (null = no cap hit)
    let _recTotalSamples = 0;         // running sum of _recChunks lengths — avoids O(n²) reduce on the detection hot path
    // Training-upload tracking — surfaced in the gear popover so the
    // user knows whether the bundle made it to the curated dataset.
    let _recTrainingUploadInFlight = false;
    let _recTrainingUploadResult = null; // { ok, bundle_filename, pcloud_result } | { ok:false, error, local_bundle }
    // When a training take is armed, the consent modal opens on
    // song:ended — the same event that fires the score summary. Defer
    // the summary so the two modals don't stack; _runDeferredSummary()
    // shows it once the consent flow closes.
    let _summaryDeferred = false;
    // When the host's global "Autoplay & auto-exit" option is on, a natural
    // song end would otherwise bounce the user back to the menu after a short
    // grace timer — clobbering this results panel. On song end we claim that
    // exit via window.slopsmith.holdAutoExit() and stash the returned release
    // here; dismissing the summary calls it to perform the deferred return
    // (or drops it, without navigating, when leaving via another path). Null
    // when the option is off / unavailable, so the legacy "close just hides
    // the panel, stay on the player" behaviour is preserved.
    let _ndAutoExitRelease = null;
    // One XP submission per take: set when _endOfSongOnEnded successfully
    // hands the session score to the minigames profile, cleared by
    // resetScoring() (which the playSong wrapper runs on every song switch
    // / retry). Guards against a duplicate award if song:ended ever fires
    // twice for one take.
    let _xpSubmittedTake = false;
    // Parallel getUserMedia capture for training takes when the desktop
    // bridge is active. The bridge intentionally does NOT open a JS-side
    // audio chain (the native JUCE engine owns the device), so the
    // existing _recChunks push site inside processFrame() never runs
    // and the WAV would always be empty. This capture is orthogonal:
    // its own MediaStream / AudioContext / ScriptProcessor solely to
    // copy Float32 frames into _recChunks. Closed on disarm / discard /
    // save-completion / destroy. Null when not in use.
    let _trainingCapture = null;
    // slopsmith#254 — per-sustained-hit-note "still being held on-pitch"
    // grace timestamps: key -> performance.now() ms before which the
    // sustain still counts as actively held. Smooths the gap between
    // ~30 fps pitch frames and 60 fps highway render so the lit-gem glow
    // doesn't flicker. Pruned alongside noteResults; cleared on reset.
    const _susActiveUntil = new Map();

    // Drill mode (slopsmith plugin-API: loop:restart event from #198).
    // Activates whenever slopsmith has an A-B loop set; each loop wrap
    // snapshots the just-finished iteration's per-iteration scoring
    // into drillIterations so the user sees iteration-by-iteration
    // accuracy on a repeated passage. Per-iteration counters live
    // alongside (not in place of) the global session counters above —
    // session totals stay correct even while drilling.
    let drillEnabled = false;       // mirrors slopsmith.getLoop() having both bounds
    let drillIterations = [];       // captured snapshots, oldest first
    let drillIterStartT = null;     // chartTime at the current iteration's start (loopA)
    let drillIterHits = 0;
    let drillIterMisses = 0;
    let drillIterStreak = 0;
    let drillIterBestStreak = 0;
    let drillSubscribed = false;    // gate the slopsmith.on / .off pair
    // Bound handler refs so destroy() can call slopsmith.off with
    // identity that matches the original .on registration.
    let drillOnLoopRestartFn = null;
    let drillOnSongChangedFn = null;
    // End-of-song summary subscription. Bound from enableImpl() so the
    // drill-mode listener count test (which calls _bindDrillEvents()
    // directly without going through enable) keeps seeing exactly the
    // drill listener it expects. The handler runs only when `enabled`
    // is still true at song:ended, gated to the default singleton so a
    // splitscreen with N detecting panels doesn't pop N modals.
    let endOfSongSubscribed = false;
    let endOfSongOnEndedFn = null;
    // song:loaded re-arm subscription (default singleton). Bound from
    // enableImpl() — i.e. once the user has turned Detect on at least once —
    // and survives the per-song silent-disable just like endOfSong/drill, so
    // it can flip Detect back on for the next song. See _reArmOnSongLoaded.
    let reArmSubscribed = false;
    let reArmOnLoadedFn = null;
    // Bounds at iteration start; if slopsmith.getLoop() returns
    // different bounds mid-drill (user picked another saved loop or
    // edited A/B) we clear iterations because they're no longer
    // comparing the same passage.
    let drillActiveLoopA = null;
    let drillActiveLoopB = null;
    // Monotonic counter for iteration `idx` — survives the
    // splice-from-front truncation. Using `drillIterations.length + 1`
    // would reuse `#51` indefinitely once truncation started.
    let drillNextIdx = 1;
    const DRILL_MAX_ITERATIONS = 50;  // bound the array so a long drill session doesn't grow without limit
    // Render uses innerHTML which parses HTML — avoid re-parsing on
    // every 33 ms HUD tick when nothing changed. Set by any mutation
    // of drill state (iteration push, live counter tick, activation
    // change); _drillRender clears it after redrawing.
    let drillDirty = true;

    // Detection state
    let detectedMidi = -1;
    let detectedConfidence = 0;
    let detectedString = -1;
    let detectedFret = -1;
    let detectedDisplayMidi = -1;
    let underBufferWarned = false;
    // Timing-free verify target (see _runVerifyTarget / setVerifyTarget). An
    // array of {s, f, ...technique flags} or null. When set, every frame
    // scores it against the live audio and emits notedetect:verify on a hit.
    let _verifyTarget = null;
    // Optional caller-supplied tuning context for the verify target
    // ({ arrangement, stringCount, offsets, capo }), or null to score against
    // the host song's live tuning. Lets a non-chart consumer (contained
    // playback) verify against the player's real instrument rather than the
    // loaded chart — see _ndSanitizeVerifyCtx.
    let _verifyTargetCtx = null;
    // Strong fingerprint of the tuning context captured when the target was
    // registered. A (string, fret) only maps to a pitch under a specific
    // arrangement + tuning + capo, so a target is meaningless once that
    // context changes. We bind the target to this fingerprint and drop it on
    // mismatch, so a song/arrangement switch can never emit notedetect:verify
    // for the wrong context (independent of whether the consumer remembers to
    // clear it). When _verifyTargetCtx is set the fingerprint comes from the
    // override, so a host song-switch underneath does NOT drop the target.
    let _verifyTargetSig = null;
    // The tuning context the verify target is scored under: the caller's
    // override when one was supplied, else the host song's live state.
    function _ndVerifyActiveCtx() {
        if (_verifyTargetCtx) return _verifyTargetCtx;
        return {
            arrangement: currentArrangement,
            stringCount: currentStringCount,
            offsets: tuningOffsets,
            capo,
        };
    }
    function _ndVerifyActiveSig() {
        const c = _ndVerifyActiveCtx();
        return _ndVerifySigFor(c.arrangement, c.stringCount, c.offsets, c.capo);
    }
    // Last chord constraint result — shown in HUD when no single note is detected.
    // Reset on song change via resetScoring(). `lastChordTime` is the
    // chart timestamp of the chord that produced these readings; the HUD
    // uses it to age the display out so a stale chord readout doesn't
    // linger past the chord's timing window during silence/noise.
    let lastChordScore = null;
    let lastChordHit = 0;
    let lastChordTotal = 0;
    // Per-chord-key cache of the most recent _ndScoreChord result so
    // checkMisses() can attach hs/tt/sc to a chord miss judgment. Keyed
    // by the same `<time>_chord` string the rest of the chord plumbing
    // uses. Cleared on resetScoring (song change / detect toggle) so a
    // stale per-chord result from one take can't leak into a later one.
    const _chordLastResult = new Map();
    let lastChordTime = -Infinity;

    // Tuning — per-instance so panels can be on different songs.
    // tuningOffsets is resized to match the actual string count on enable();
    // the initial 6-element array is a safe default for 6-string guitar
    // and is overwritten from hw.getSongInfo() before any detection runs.
    let currentArrangement = 'guitar';
    let tuningOffsets = [0, 0, 0, 0, 0, 0];
    let capo = 0;
    let currentStringCount = 6; // kept in sync with tuningOffsets.length

    // Audio buffers
    let accumBuffer = new Float32Array(0);
    let pendingBuffer = null;
    let processingFrame = false;

    // Timers
    let detectInterval = null;
    let levelRaf = null;
    // Cached VU-meter element refs for drawSettingsVU(). The level-meter
    // loop (startLevelMeter rAF + startBridgeLevelMeter 20Hz) runs always-on
    // while detection is active, but the .nd-vu-bar only exists while the
    // settings panel is open. A per-frame document.querySelector here showed
    // up as ~2.5% main-thread CPU during 3D-highway playback. Cache the refs
    // (per instance — splitscreen has multiple detectors) and only re-resolve
    // when the cached node is missing/disconnected. `_vuPanelAbsent` latches
    // a confirmed-closed panel so we don't query 60×/sec while it's closed.
    let _vuPanelEl = null;   // this instance's own settings panel (splitscreen-safe)
    let _vuBarEl = null;
    let _vuPeakEl = null;
    let _vuPanelAbsent = false;
    let bridgeLevelTimer = null;  // setInterval for the desktop-bridge level meter
    // Capability latch: true once we confirm the bridge engine has no
    // getLevels, so the sustain glow can fall back to a fixed alpha. Distinct
    // from `!bridgeLevelTimer` (which is also true mid-startup/after teardown);
    // defaults false so we level-gate until the capability is actually known.
    let bridgeLevelsUnavailable = false;
    let hudInterval = null;
    let missCheckInterval = null;
    let gcInterval = null;
    let flashTimeouts = [];

    // Set to true when startAudio() routed through the slopsmith-desktop
    // (Electron) audio bridge instead of opening its own getUserMedia
    // stream. Used by the bridge poll/level-meter timers to bail out
    // after their `await` resolves on a since-disabled instance — the
    // existing Web-Audio teardown in stopAudio() is null-checked, so it
    // doesn't need its own branch on this flag.
    let usingDesktopBridge = false;
    // Opt-in (gear toggle, `nativeDetection`) sub-mode of the desktop
    // bridge: pull the engine's post-gate PCM via getRawAudioFrame and run
    // note_detect's OWN YIN/HPS/CREPE on it, instead of consuming the
    // engine's pitch verdicts. usingDesktopBridge stays true, so chords
    // still score through the engine's harmonic-comb ChordScorer
    // (scoreChord) and levels/source-binding are unchanged — only the
    // per-frame monophonic detection moves in-plugin. Reset in stopAudio().
    let usingNativeFrames = false;
    // Cached engine sample rate for the bridge path. There's no
    // audioCtx on this branch so any code that needs a sampleRate
    // reads it from here instead. Note that chord scoring on the
    // bridge does NOT consult this value — audio.scoreChord runs
    // inside the engine and reads the rate natively. The cache is
    // kept around for the monophonic detection helpers and any
    // future bridge-side consumer that still needs the renderer
    // view of the rate. Browser path uses audioCtx.sampleRate
    // directly. The engine rate is fixed for a session; if the user
    // changes audio device the detector restarts via the
    // restartAudio chain and refreshes this value.
    let bridgeSampleRate = 48000;
    // Cached `window.slopsmithDesktop` reference captured at
    // startAudio() when the bridge path is active, so matchNotes()'s
    // chord branch can dispatch `audio.scoreChord(ctx)` without
    // re-resolving from window on every tick. Cleared by stopAudio().
    let bridgeDesktop = null;

    // ── Multi-input engine source binding (desktop bridge only) ───────────
    // Each detector instance can score its OWN engine input source so several
    // detectors (split-screen panels / a 4-input interface) run independently.
    // `sourceId` selects which engine source the bridge calls target:
    //   null  → the legacy default source 0, via the un-suffixed bridge methods
    //           (setChart / scoreChord / getNoteVerdicts / getRawPitch …). The
    //           default singleton and any instance that doesn't opt in stay here,
    //           so the single-player path is byte-identical.
    //   >= 0  → a dedicated source, via the *Source* bridge methods.
    // A caller may pass an explicit `opts.sourceId` (caller owns its lifecycle),
    // or `opts.ownSource: true` to have this instance allocate one on enable
    // (addSource) and free it on destroy (removeSource).
    let sourceId = (typeof opts.sourceId === 'number' && opts.sourceId >= 0)
        ? opts.sourceId : null;
    const _ndWantOwnSource = sourceId == null && !isDefault && opts.ownSource === true;
    let _ndOwnsSource = false;  // true once WE allocated sourceId (free on destroy)
    // Owned sources we unbound but couldn't free yet (removeSource missing/threw
    // — only reachable on a hypothetical mid-session addon downgrade). A list, so
    // a second orphan can't overwrite an earlier one; every entry is retried on the
    // next ready enable and on destroy, so an owned source can never leak silently.
    const _ndOrphanSourceIds = [];

    // Bridge-method routing: pick the *Source* variant when this instance is
    // bound to a dedicated source, else the legacy (source-0) method. Each
    // returns the native promise (or a resolved null when unavailable), and the
    // *Available helpers gate the bridge path the same way the inline typeof
    // checks used to. `a` is bridgeDesktop.audio.
    function _ndBridgeAudio() { return (bridgeDesktop && bridgeDesktop.audio) || null; }
    // True only when the addon exposes the FULL source-indexed scoring API this
    // instance routes to once bound. Binding a source without these would silently
    // break scoring on a downlevel/partial addon — so we never bind unless ready.
    function _ndDesktopSourceApiReady(a) {
        return !!a
            && typeof a.scoreSourceChord === 'function'
            && typeof a.setSourceChart === 'function'
            && typeof a.getSourceNoteVerdicts === 'function'
            && typeof a.getSourcePitchDetection === 'function';
    }
    function _ndBridgeScoreAvailable() {
        const a = _ndBridgeAudio(); if (!a) return false;
        return sourceId != null
            ? typeof a.scoreSourceChord === 'function'
            : typeof a.scoreChord === 'function';
    }
    function _ndBridgeScoreChord(ctx) {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null && typeof a.scoreSourceChord === 'function')
            return a.scoreSourceChord(sourceId, ctx);
        if (sourceId == null && typeof a.scoreChord === 'function')
            return a.scoreChord(ctx);
        return Promise.resolve(null);
    }
    function _ndBridgeVerifierAvailable() {
        const a = _ndBridgeAudio(); if (!a) return false;
        return sourceId != null
            ? (typeof a.setSourceChart === 'function' && typeof a.getSourceNoteVerdicts === 'function')
            : (typeof a.setChart === 'function' && typeof a.getNoteVerdicts === 'function');
    }
    function _ndBridgeSetChart(chart) {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null && typeof a.setSourceChart === 'function')
            return a.setSourceChart(sourceId, chart);
        if (sourceId == null && typeof a.setChart === 'function')
            return a.setChart(chart);
        return Promise.resolve(null);
    }
    function _ndBridgeGetVerdicts(songTime, playing) {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null && typeof a.getSourceNoteVerdicts === 'function')
            return a.getSourceNoteVerdicts(sourceId, songTime, playing);
        if (sourceId == null && typeof a.getNoteVerdicts === 'function')
            return a.getNoteVerdicts(songTime, playing);
        return Promise.resolve(null);
    }
    // Post-gate raw YIN (sustain glow): prefer getRawPitch; fall back to the
    // active-pitch query on an addon that predates it (same as the legacy path).
    function _ndBridgeRawPitch() {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null) {
            if (typeof a.getSourceRawPitch === 'function') return a.getSourceRawPitch(sourceId);
            if (typeof a.getSourcePitchDetection === 'function') return a.getSourcePitchDetection(sourceId);
            return Promise.resolve(null);
        }
        if (typeof a.getRawPitch === 'function') return a.getRawPitch();
        if (typeof a.getPitchDetection === 'function') return a.getPitchDetection();
        return Promise.resolve(null);
    }
    // Pull a frame of post-gate mono PCM from the engine for the
    // native-frame detection mode. Routes to the source-indexed pull for a
    // bound (multi-input) source, else the default-source pull. Returns a
    // Float32Array (up to `numSamples`, zero-padded on a cold ring) or null
    // when the addon predates the API (caller then can't enter the mode).
    function _ndBridgeRawAudioFrame(numSamples) {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null) {
            if (typeof a.getSourceRawAudioFrame === 'function') return a.getSourceRawAudioFrame(sourceId, numSamples);
            return Promise.resolve(null);
        }
        if (typeof a.getRawAudioFrame === 'function') return a.getRawAudioFrame(numSamples);
        return Promise.resolve(null);
    }
    // Whether the engine exposes the raw-audio-frame pull this instance
    // would use (source-indexed when bound, default otherwise). Gates entry
    // into native-frame detection — a downlevel addon keeps the verdict path.
    function _ndBridgeRawFramesAvailable() {
        const a = _ndBridgeAudio(); if (!a) return false;
        if (sourceId != null) return typeof a.getSourceRawAudioFrame === 'function';
        return typeof a.getRawAudioFrame === 'function';
    }
    // Active (ML-or-YIN) detection for the monophonic scoring branch.
    function _ndBridgePitch() {
        const a = _ndBridgeAudio(); if (!a) return Promise.resolve(null);
        if (sourceId != null && typeof a.getSourcePitchDetection === 'function')
            return a.getSourcePitchDetection(sourceId);
        if (sourceId == null && typeof a.getPitchDetection === 'function')
            return a.getPitchDetection();
        return Promise.resolve(null);
    }
    // Free an engine source we allocated. Re-resolves window.slopsmithDesktop
    // because stopAudio() clears bridgeDesktop before destroy() runs.
    // Best-effort removeSource(id). Re-resolves window.slopsmithDesktop because
    // stopAudio() clears bridgeDesktop. Returns true iff the source was freed
    // (or there was nothing to free).
    function _ndTryFreeSource(id) {
        if (id == null) return true;
        const d = (typeof window !== 'undefined') ? window.slopsmithDesktop : null;
        const a = d && d.audio;
        if (!a || typeof a.removeSource !== 'function') return false;
        try {
            const r = a.removeSource(id);
            // removeSource is async IPC on the desktop bridge — the call is
            // dispatched (the engine removes the source) regardless of the result,
            // so we count it as freed; swallow any rejection so a transient failure
            // can't surface as an unhandled promise rejection.
            if (r && typeof r.then === 'function') r.then(undefined, () => {});
            return true;
        } catch (_) { return false; }
    }
    // Retry freeing every previously-orphaned source (see _ndOrphanSourceIds);
    // keep the ones that still can't be freed.
    function _ndFlushOrphanSources() {
        for (let i = _ndOrphanSourceIds.length - 1; i >= 0; i--) {
            if (_ndTryFreeSource(_ndOrphanSourceIds[i])) _ndOrphanSourceIds.splice(i, 1);
        }
    }
    // Free the source we own (called from destroy). Also retries any orphans from
    // an earlier downgrade — at destroy the addon is usually ready again, so those
    // get reclaimed. If the current source can't be freed (removeSource missing —
    // a downlevel addon), the engine reclaims it on its own teardown; the orphan
    // list can't help on a dead instance (no later enable), so we don't pretend to.
    function _ndReleaseOwnedSource() {
        _ndFlushOrphanSources();
        if (_ndOwnsSource && sourceId != null) _ndTryFreeSource(sourceId);
        _ndOwnsSource = false;
        sourceId = null;
    }

    // ── Onboarding-selected input source (audio-input capability domain) ───────
    // The PHYSICAL input device + input channel are chosen ONCE in the onboarding
    // Input Setup wizard (input_setup → audio-input 'select-source'). Opening the
    // domain's CURRENTLY-selected source runs the audio_engine provider's
    // source.open, which calls setDevice()+startAudio() on the native engine for
    // THAT device (ASIO included). We open it before BOTH live detection and
    // calibration so whatever device + input the user picks in the wizard is what
    // note detection uses — and re-opening picks up a selection that changed
    // since enable. The channel is applied on top by the engine's saved device
    // settings (set during the wizard's calibration) + our setSourceInputChannel.
    // Degrades to a no-op (returns false) on a host without the capability
    // runtime / domain — the caller's legacy startAudio is the fallback. Distinct
    // requester ids keep the detect-lifetime ref and the transient calibration
    // ref independent (the domain ref-counts per requester).
    const ND_AUDIO_REQUESTER = 'note_detect';
    const ND_AUDIO_CAL_REQUESTER = 'note_detect:calibration';
    async function _ndOpenSelectedInputSource(requesterId, purpose) {
        const caps = (typeof window !== 'undefined') && window.slopsmith && window.slopsmith.capabilities;
        if (!caps || typeof caps.command !== 'function') return false;
        try {
            const res = await caps.command('audio-input', 'open-source', {
                requester: requesterId,
                // No requiredChannelShape: open the source at its native shape
                // (the compat check then always passes — mono or stereo device).
                // Note detection picks its own input channel via the engine's
                // setSourceInputChannel, independent of the session channel shape.
                payload: { purpose: purpose || 'note-detection' },
            });
            return !!(res && (res.outcome === 'handled' || res.status === 'open'));
        } catch (_) { return false; }
    }
    async function _ndCloseSelectedInputSource(requesterId) {
        const caps = (typeof window !== 'undefined') && window.slopsmith && window.slopsmith.capabilities;
        if (!caps || typeof caps.command !== 'function') return;
        try { await caps.command('audio-input', 'close-source', { requester: requesterId, payload: {} }); }
        catch (_) { /* best-effort */ }
    }
    // True when the desktop engine exposes the continuous chart-verifier
    // API (audio.setChart / audio.getNoteVerdicts) AND a chart has been
    // pushed for the current song. When set, the desktop detect loop drains
    // engine-finalized verdicts instead of running the per-tick matchNotes()
    // scoreChord IPC — the engine scores the chart on its own background
    // thread, so a starved renderer event loop no longer drops note runs.
    // false on a downlevel addon (pre-NoteVerifier build), where the old
    // matchNotes path stays in force unchanged.
    let _ndUsingEngineVerifier = false;
    // Chart-note lookup for the verifier path: noteKey -> the chart note
    // object ({ s, f, t, sus, ho... }), so a drained verdict can be mapped
    // back to its note for the judgment pipeline. Rebuilt on each chart push.
    let _ndVerifierChartById = new Map();
    // Chord grouping for the verifier path. The engine scores every chord
    // constituent as an independent note; these maps let the drain step
    // regroup the per-constituent verdicts into one chord judgment with
    // N-of-M leniency (chordHitRatio), matching the legacy chord path.
    //   _ndVerifierChords     : chordKey -> { t, memberIds[], memberNotes[], maxSus }
    //   _ndVerifierChordKeyOf : constituent noteKey -> chordKey
    //   _ndPendingChords      : chordKey -> Map(noteKey -> verdict) still arriving
    let _ndVerifierChords = new Map();
    let _ndVerifierChordKeyOf = new Map();
    let _ndPendingChords = new Map();
    // Signature of the chart last pushed to the engine (note/chord counts +
    // arrangement). The chart loads asynchronously — `hw.getNotes()` is empty
    // for a moment after `song:loaded` — so the detect loop re-pushes whenever
    // the live signature diverges from this, covering late chart load and
    // mid-session arrangement switches.
    let _ndVerifierChartSig = '';
    // Last playhead pushed to the engine, in corrected song time. Lets
    // _ndDrainEngineVerdicts spot a backward jump (drill A-B loop wrap or a
    // manual seek-back) and clear the dedup entries the engine is re-opening.
    let _ndLastPushedPlayhead = 0;

    // ── Contained-playback verifier (setContainedChart / pushContainedPlayhead
    //    / drainContainedVerdicts / releaseContainedChart) ────────────────────
    // A non-chart consumer (SlopScale, Chord Sprint) runs its OWN exercise
    // transport — its own generated chart, scored against the player's real
    // tuning, independent of the host song's playhead. It can't ride the host
    // setChart slot (that's owned for the host song; overwriting it would
    // clobber host scoring), so this is an ADDITIVE path that drives the SAME
    // engine NoteVerifier with the plugin's chart + the plugin's playhead,
    // SUSPENDING host-song scoring while armed (one engine chart slot).
    //
    // Unlike the host path, verdicts are NOT run through recordJudgment / the
    // HUD / notedetect:* events — they are buffered RAW and the consumer drains
    // them and owns judgment. This keeps the contained path a thin verdict pipe
    // that can't pollute the host detector's stats/diagnostics.
    let _ndContainedActive = false;
    // Generation token, bumped on every release/disable (and a fresh arm). An
    // async setContainedChart / pushContainedPlayhead captures it before its
    // await and bails on resume if it changed — so a release/disable/newer-arm
    // that ran during the IPC can't resurrect contained mode or write stale
    // state (the single engine slot stays consistent with the latest intent).
    let _ndContainedGen = 0;
    // Cap the raw verdict buffer so a consumer that stalls drainContainedVerdicts()
    // can't grow it without bound — keep the most recent, drop the oldest.
    const _ND_CONTAINED_BUF_MAX = 512;
    // verdict.id -> the caller's note object, so the caller can map a drained
    // verdict back to its exercise note. The caller supplies the ids.
    let _ndContainedById = new Map();
    // Sanitized tuning ctx (_ndSanitizeVerifyCtx output) the contained chart is
    // scored under, or null when it tracks the host song's live tuning.
    let _ndContainedCtx = null;
    // Raw engine verdicts awaiting drainContainedVerdicts().
    let _ndContainedVerdictBuf = [];
    // Last playhead the caller pushed (for backward-jump dedup of the buffer).
    let _ndContainedLastPlayhead = 0;
    // True while a contained chart is armed: the host detect loop must not
    // re-push or drain the host chart, and a host song:loaded must not clobber
    // the engine slot. Cleared on release, which re-pushes the host chart (so
    // _ndUsingEngineVerifier is re-derived — no saved copy needed).
    let _ndHostChartSuspended = false;
    // Whether the desktop engine's polyphonic ML detector (Basic Pitch) is
    // actually active this session — queried once at bridge startup via
    // `audio.isMlNoteDetection()`. false on a downlevel addon or when the ML
    // model failed to load (the engine then runs the YIN fallback). Stamped
    // into the diagnostic export so a session can be tied to its detector.
    let bridgeMlActive = false;
    // Detector identity captured DURING detection (not read at diagnostic-
    // export time, when usingDesktopBridge has already been reset by a Detect
    // toggle — that mislabelled bridge sessions as web). Set each tick by
    // whichever path actually ran.
    let _diagDetector = null;
    // Onset-event state for the desktop ML bridge — used to gate CHORD timing.
    // Each detectNotes note carries a per-pitch `onsetSeq` counter; when it
    // increases, that pitch was struck anew. A chord commits a hit only on a
    // poll where one of its pitches has a fresh onset, so the chord's pitches
    // ringing on through the riff don't drag the match early.
    //   bridgeOnsetSeqSeen — last consumed onsetSeq per MIDI pitch
    //   bridgeNewOnsets    — onsets first seen on the current poll:
    //                        midi -> { ageMs, conf }
    //   bridgeOnsetPrimed  — false until the first poll has recorded a seq
    //                        baseline (so pre-existing onsets aren't replayed)
    let bridgeOnsetSeqSeen = new Map();
    let bridgeNewOnsets = new Map();
    let bridgeOnsetPrimed = false;

    // Visual-feedback tracking
    let lastHitCount = 0;
    let lastMissCount = 0;
    // HUD animation state: eased score readout + last-seen multiplier tier /
    // streak so the 33 ms tick can fire pop/shake/flash classes exactly on
    // transitions instead of every frame.
    let displayScore = 0;
    let lastMultTier = 1;
    let lastStreakVal = 0;

    // DOM refs
    const container = opts.container || document.getElementById('player');
    const instanceRoot = document.createElement('div');
    instanceRoot.className = 'nd-instance-root';
    instanceRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    // Skin attribute drives every nd-* component's CSS custom properties
    // (assets/plugin.css). Stamped per instance — splitscreen panels stay
    // independent of <body>-level state.
    try { instanceRoot.setAttribute('data-nd-skin', _ndLoadSkin()); } catch (e) {}
    let detectBtn = null;
    let gearBtn = null;

    // Draw hook — registered once per instance; removed in destroy().
    // The hook itself early-returns when !enabled, so the cost is
    // minimal for a disabled instance. Stored so removeDrawHook() can
    // find the same reference. If `hw` isn't resolved at construction
    // time (plugin loaded before highway), ensureDrawHook retries on
    // first enable.
    const drawHookFn = (ctx, W, H) => drawOverlay(ctx, W, H);
    let drawHookRegistered = false;
    function ensureDrawHook() {
        if (drawHookRegistered) return;
        const h = resolveHw();
        if (h && h.addDrawHook) {
            h.addDrawHook(drawHookFn);
            drawHookRegistered = true;
        }
        // slopsmith#254 — publish per-note judgments so the active
        // renderer lights up the gem itself (and keeps a held sustain
        // glowing) instead of us drawing an overlay ring near it. The
        // provider returns null while disabled, so registering it once
        // and leaving it across enable/disable cycles is harmless; it's
        // only cleared in destroy(). Per-instance hw (splitscreen panels
        // each have their own createHighway()), so no cross-panel clash.
        // The core API is last-wins; we still avoid stomping a provider
        // some other plugin registered first (we'd be re-registering our
        // own `noteStateFor` across a disable→enable, which is a no-op).
        if (h && h.setNoteStateProvider) {
            const existing = (typeof h.getNoteStateProvider === 'function') ? h.getNoteStateProvider() : null;
            if (existing == null || existing === noteStateFor) h.setNoteStateProvider(noteStateFor);
        }
    }

    // ── Settings persistence (only the default singleton writes) ──────
    function saveSettings() {
        if (!isDefault) return;
        try {
            localStorage.setItem(_ND_STORAGE_KEY, JSON.stringify({
                deviceId: selectedDeviceId,
                channel: selectedChannel,
                method: detectionMethod,
                // Explicit override flag so the loader can tell a deliberate
                // method choice from the always-persisted default (see load).
                methodUserSet: detectionMethodUserSet,
                nativeDetection,
                timingTolerance,
                pitchTolerance,
                timingHitThreshold,
                chordTimingHitThreshold,
                pitchHitThreshold,
                showTimingErrors,
                showPitchErrors,
                edgeFlash: edgeFlashEnabled,
                tuningMode,
                autoRecord,
                frameSize,
                autoCalibrate,
                detectEnabled: detectPreference,
                missMarkerDuration,
                hitGlowDuration,
                inputGain,
                latencyOffset,
                chordHitRatio,
                detectionConfidenceMin,
            }));
        } catch (e) { /* unavailable */ }
    }

    // Open an instrument capture stream, relaxing over-constrained inputs.
    // Two device classes break a strict getUserMedia on macOS in particular:
    //   - mono-only USB interfaces (e.g. the chart Real Tone Cable)
    //     reject `channelCount: 2`;
    //   - a stale saved `deviceId` (device unplugged since last session)
    //     rejects `deviceId: { exact }`.
    // OverconstrainedError.constraint names the offending constraint, so we
    // drop exactly that one and retry rather than guessing — dropping the
    // device when the real problem is the channel count would needlessly
    // discard the user's chosen interface, and dropping channelCount for an
    // unrelated constraint would mask the real failure. We therefore only
    // relax the *named* constraint (the supported browsers — Chrome/Edge —
    // always populate `e.constraint`); an unnamed failure is treated as the
    // documented mono-only-device case since channelCount is the only other
    // constraint we set that can over-constrain. Anything else rethrows. The
    // loop relaxes one constraint per failure and is guaranteed to terminate
    // (each branch deletes a still-present key or rethrows). Mutates
    // `constraints` in place.
    //
    // `allowDeviceFallback` gates the *destructive* part of the deviceId
    // path. A device that's still enumerating at startup (the exact race the
    // auto-enable retry addresses) also fails the `deviceId: { exact }` match
    // transiently — so forgetting the saved device on the first such failure
    // would permanently switch a Real-Tone-Cable user back to the default
    // input on a cold load. The construct-time auto-enable therefore passes
    // `false` on its silent first attempt: a deviceId overconstraint is
    // surfaced (not forgotten), letting the delayed retry try the real device
    // again. User-initiated enables and the retry pass `true`, where a deviceId
    // failure does mean a genuinely stale device → forget it and fall back.
    async function openInstrumentStream(constraints, { allowDeviceFallback = true } = {}) {
        for (;;) {
            try {
                return await navigator.mediaDevices.getUserMedia(constraints);
            } catch (e) {
                if (e.name !== 'OverconstrainedError') throw e;
                if (e.constraint === 'deviceId' && constraints.audio.deviceId) {
                    if (!allowDeviceFallback) {
                        // Silent auto-enable attempt — the device may just be
                        // mid-enumeration. Don't forget it or fall back; surface
                        // the failure so the caller's delayed retry can re-try
                        // the real device.
                        throw e;
                    }
                    // Saved device is gone — forget it so future opens default.
                    selectedDeviceId = '';
                    saveSettings();
                    delete constraints.audio.deviceId;
                } else if ((e.constraint === 'channelCount' || !e.constraint)
                           && constraints.audio.channelCount !== undefined) {
                    // Mono-only device (e.g. Real Tone Cable): drop stereo and
                    // keep the user's selected device.
                    delete constraints.audio.channelCount;
                } else {
                    // A constraint we can't safely relax without discarding the
                    // user's intent (or an already-relaxed one) — surface it.
                    throw e;
                }
            }
        }
    }

    // ── Audio pipeline ────────────────────────────────────────────────
    async function startAudio() {
        try {
            // Desktop (Electron) bridge path. When the slopsmith-desktop
            // shell is hosting us, the native JUCE engine already owns
            // the audio device — see src/main/audio-bridge.ts in
            // slopsmith-desktop. Drive monophonic detection from its
            // `audio:getPitchDetection` IPC and polyphonic chord
            // scoring from its `audio:scoreChord` IPC (native
            // ChordScorer + lock-free input ring), instead of opening
            // a parallel getUserMedia/Web-Audio chain. That parallel
            // path fails on Linux Electron builds (Chromium denies
            // `media` for the localhost-served renderer with no
            // permission handler set) and duplicates work the engine
            // is already doing every frame.
            //
            // The bridge feature-detects each IPC method separately,
            // so an older slopsmith-desktop without scoreChord still
            // gets the monophonic path; chord scoring is skipped
            // (the chord branch in matchNotes() short-circuits when
            // the IPC is missing, same as the pre-bridge browser
            // path's no-buffer guard).
            //
            // Borrower mode (caller supplied a stream or AudioContext)
            // skips this branch — those callers own the lifecycle and
            // expect a real Web-Audio graph, e.g. for tap-tempo or
            // visualisation taps.
            const desktop = (typeof window !== 'undefined') ? window.slopsmithDesktop : null;
            const canUseDesktopBridge = !externalStream && !externalAudioCtx
                && desktop && desktop.isDesktop
                && desktop.audio
                && typeof desktop.audio.getPitchDetection === 'function'
                && typeof desktop.audio.isAvailable === 'function';
            if (canUseDesktopBridge) {
                let bridgeReady = false;
                try {
                    bridgeReady = await desktop.audio.isAvailable();
                } catch (_) { /* treat as unavailable */ }
                if (bridgeReady) {
                    // Tie live detection to the onboarding Input Setup wizard's
                    // selected input: open the audio-input domain's selected
                    // source, which configures + starts the native engine on that
                    // device (ASIO included) before we read pitch. No-op without
                    // the domain — the legacy startAudio below is the fallback.
                    await _ndOpenSelectedInputSource(ND_AUDIO_REQUESTER, 'note-detection');
                    // Start the engine if the Audio Plugins panel hasn't
                    // already done so — without it getPitchDetection
                    // returns sentinel values (frequency: -1) forever.
                    // (When open-source above handled it, the engine is already
                    // running on the selected device, so this is a no-op.)
                    try {
                        const running = typeof desktop.audio.isAudioRunning === 'function'
                            ? await desktop.audio.isAudioRunning()
                            : false;
                        if (!running && typeof desktop.audio.startAudio === 'function') {
                            await desktop.audio.startAudio();
                        }
                    } catch (_) { /* engine surfaces its own errors */ }

                    usingDesktopBridge = true;
                    bridgeDesktop = desktop;
                    accumBuffer = new Float32Array(0);

                    // Bind a dedicated engine input source when this instance opted
                    // in (multi-input / split-screen) — but ONLY when the addon
                    // exposes the FULL source-indexed scoring API. A partial/
                    // downlevel addon (e.g. addSource without scoreSourceChord)
                    // must NOT leave us bound to a source we can't score, which
                    // would silently stop scoring. In that case we stay on source 0
                    // (legacy methods). Allocate once and keep it across disable/
                    // enable (freed only on destroy); the default singleton + un-
                    // opted instances stay on source 0 — byte-identical.
                    if (_ndDesktopSourceApiReady(desktop.audio)) {
                        // A ready addon can also reclaim any earlier orphans.
                        _ndFlushOrphanSources();
                        // Re-bind a caller-managed sourceId that an earlier degraded
                        // enable cleared (opts.sourceId is the source of truth).
                        if (sourceId == null && !_ndOwnsSource
                            && typeof opts.sourceId === 'number' && opts.sourceId >= 0) {
                            sourceId = opts.sourceId;
                        }
                        if (_ndWantOwnSource && sourceId == null
                            && typeof desktop.audio.addSource === 'function') {
                            try {
                                const id = await desktop.audio.addSource(_ndChannelIndex, _ndDeviceKey);
                                if (typeof id === 'number' && id >= 0) {
                                    sourceId = id;
                                    _ndOwnsSource = true;
                                }
                            } catch (_) { /* stay on source 0 */ }
                        }
                        // Keep the bound source's input channel in sync with the
                        // current selection. A fresh addSource already bound it, but a
                        // REUSED owned source — OR a caller-managed opts.sourceId — may
                        // have had its channel changed (via setChannel) while detect was
                        // disabled, so re-route on every enable for any non-default
                        // source this detector drives (matches setChannel's sourceId!==0
                        // contract). Never source 0 (the shared default).
                        if (sourceId != null && sourceId !== 0
                            && typeof desktop.audio.setSourceInputChannel === 'function') {
                            try {
                                desktop.audio.setSourceInputChannel(sourceId, _ndChannelIndex);
                            } catch (_) { /* best-effort */ }
                        }
                        // Apply the user-dialed capture-latency correction to the
                        // bound source (no-op at 0 / for source 0).
                        if (sourceId != null) _ndApplyVerifierOffset();
                    } else if (sourceId != null) {
                        // This addon can't score per source (downlevel, or — in
                        // theory — downgraded since a prior enable bound us). Don't
                        // stay bound to a source we can't route to: best-effort free
                        // an owned source (remembering it as an orphan if that fails)
                        // and fall back to the legacy source-0 path, so
                        // `sourceId != null` always implies the routed *Source*
                        // methods exist.
                        if (!_ndOwnsSource) {
                            console.warn('[note_detect] desktop addon lacks the source-indexed '
                                + 'scoring API; ignoring opts.sourceId and using the default input');
                        } else if (!_ndTryFreeSource(sourceId)) {
                            _ndOrphanSourceIds.push(sourceId);
                        }
                        sourceId = null;
                        _ndOwnsSource = false;
                    }

                    // Record whether the engine's polyphonic ML detector
                    // (Basic Pitch) is actually active — stamped into the
                    // diagnostic export so a session is unambiguously tied to
                    // ML vs the YIN fallback. typeof-guarded for downlevel
                    // addons that predate the query.
                    bridgeMlActive = false;
                    if (typeof desktop.audio.isMlNoteDetection === 'function') {
                        try {
                            bridgeMlActive = (await desktop.audio.isMlNoteDetection()) === true;
                        } catch (_) { /* leave false */ }
                    }
                    console.log(`[note_detect] desktop bridge active — ML detection: ${bridgeMlActive ? 'ON' : 'OFF (YIN fallback)'}`);

                    // Cache the engine sample rate for any consumer
                    // that needs the bridge-side rate (the chord
                    // branch in matchNotes() doesn't — it dispatches
                    // through audio:scoreChord which reads the rate
                    // inside the engine). Reset to the 48000 default
                    // first so a transient throw or stale cached
                    // rate from a previous session can't leak in
                    // after a device-change-driven restart.
                    bridgeSampleRate = 48000;
                    if (typeof desktop.audio.getSampleRate === 'function') {
                        try {
                            const sr = await desktop.audio.getSampleRate();
                            if (Number.isFinite(sr) && sr > 0) bridgeSampleRate = sr;
                        } catch (_) { /* keep the 48000 default */ }
                    }

                    // Whether this desktop build exposes the raw polyphonic
                    // transcription API. Captured once — the addon's method
                    // set is fixed for the session.
                    const hasDetectNotes = typeof desktop.audio.detectNotes === 'function';

                    // Native-frame detection (gear opt-in): run note_detect's
                    // own detector on engine-captured PCM instead of the
                    // engine's verdicts. Requires the raw-audio-frame pull.
                    // Captured per-session like hasDetectNotes — the gate is
                    // re-evaluated on the next enable/restart, so flipping the
                    // toggle takes effect after restartAudio().
                    usingNativeFrames = nativeDetection && _ndBridgeRawFramesAvailable();
                    if (usingNativeFrames) {
                        console.log('[note_detect] native-frame detection active — local '
                            + `${detectionMethod || 'yin'} on engine audio; chords via engine scoreChord`);
                    }

                    detectInterval = setInterval(async () => {
                        if (!enabled || processingFrame) return;
                        processingFrame = true;
                        const gen = sessionGen;
                        try {
                            // A contained-playback verifier (setContainedChart)
                            // has taken over the single engine chart slot with
                            // its own chart + playhead. Host-song scoring is
                            // suspended; the consumer drives the engine from its
                            // own tick via pushContainedPlayhead — this loop
                            // must do nothing that touches the chart slot or
                            // re-pushes the host chart over the contained one.
                            // _ndHostChartSuspended covers THIS instance when it
                            // owns the slot; _ndOtherOwnsOurSlot() covers a
                            // sibling instance on the same engine source.
                            if (_ndHostChartSuspended || _ndOtherOwnsOurSlot()) return;
                            // Native-frame detection (gear opt-in): pull the
                            // engine's post-gate mono PCM and run note_detect's
                            // OWN YIN/HPS/CREPE on it via the SAME processFrame
                            // → matchNotes pipeline the browser path uses. On
                            // the bridge, matchNotes routes chords to the
                            // engine's harmonic-comb ChordScorer (scoreChord),
                            // so this is "own monophonic detector + engine
                            // chord verifier" on engine-captured audio. The
                            // engine-verifier path is suppressed in this mode
                            // (_ndPushChartToBridge bails on usingNativeFrames),
                            // so _ndUsingEngineVerifier is always false here.
                            if (usingNativeFrames) {
                                const want = _ndMinAnalysisSamples(currentArrangement, bridgeSampleRate);
                                let frame = null;
                                try { frame = await _ndBridgeRawAudioFrame(want); }
                                catch (_) { frame = null; }
                                if (!enabled || gen !== sessionGen) return;
                                // processFrame derives its sample rate from
                                // bridgeSampleRate when there's no audioCtx
                                // (the bridge case), so the engine rate flows
                                // through to YIN/HPS/FFT math unchanged.
                                //
                                // processFrame runs the selected YIN/HPS/CREPE on
                                // the engine PCM, sets detectedMidi/detectedConfidence
                                // for the live HUD/pitch-display, then calls
                                // matchNotes(buffer). matchNotes routes single-note
                                // and chord VERIFICATION through _ndBridgeScoreChord
                                // (harmonic-comb engine) because usingDesktopBridge
                                // is still true — this is intentional: the engine's
                                // spectral verifier is more reliable for hit/miss than
                                // a raw frequency estimate, and the feature goal is
                                // "chosen detector for live HUD + engine verifier for
                                // final scoring" (matching how getPitchDetection +
                                // scoreChord work on the normal bridge path). It is NOT
                                // a replacement verification backend.
                                if (frame && frame.length >= want) await processFrame(frame);
                                return;
                            }
                            // Engine-verifier path: the engine scores the
                            // pushed chart on its own background thread, so
                            // this loop just drains finalized verdicts and
                            // feeds them through the judgment pipeline. No
                            // detectNotes / matchNotes work runs here — that
                            // is exactly the per-tick load this change moves
                            // off the renderer event loop.
                            if (_ndUsingEngineVerifier) {
                                // The chart loads asynchronously after
                                // song:loaded (and can switch mid-session);
                                // re-push whenever the live chart diverges
                                // from what the engine currently holds.
                                if (_ndChartSignature() !== _ndVerifierChartSig) {
                                    await _ndPushChartToBridge();
                                    if (!enabled || gen !== sessionGen) return;
                                }
                                await _ndDrainEngineVerdicts();
                                if (!enabled || gen !== sessionGen) return;
                                // Live monophonic pitch for provisional on-strike
                                // gem feedback (see noteStateFor). The engine's
                                // final verdict only lands after a note's sustain
                                // window closes — often after the highway culls the
                                // gem — so polling the live detector here lets a
                                // struck note light immediately. One extra IPC per
                                // tick alongside the verdict drain.
                                //
                                // Use getRawPitch, NOT getPitchDetection: it reads
                                // the POST-noise-gate signal and returns midiNote
                                // -1 the moment the string stops ringing (gate
                                // closes), so the 'active' glow extinguishes when
                                // the player mutes. getPitchDetection holds the
                                // note through its decay, which kept muted sustains
                                // lit. Fall back to getPitchDetection only if the
                                // addon predates getRawPitch.
                                try {
                                    // Routes to getSourceRawPitch for a bound
                                    // source, else the legacy getRawPitch (with the
                                    // same getPitchDetection downlevel fallback).
                                    const lp = await _ndBridgeRawPitch();
                                    if (!enabled || gen !== sessionGen) return;
                                    if (lp && typeof lp.midiNote === 'number' && lp.midiNote >= 0
                                        && typeof lp.confidence === 'number'
                                        // Strict `>` to match _sustainStillHeld's
                                        // gate — a confidence landing exactly on
                                        // the threshold must not store a pitch the
                                        // hold logic would then ignore (flicker).
                                        && lp.confidence > detectionConfidenceMin) {
                                        detectedMidi = lp.midiNote;
                                        detectedConfidence = lp.confidence;
                                        // This branch returns before matchNotes(),
                                        // so log the calibration detection here or
                                        // auto-calibrate would never see a sample
                                        // under the engine verifier (dets stays 0).
                                        _calLogDetection();
                                    } else {
                                        detectedMidi = -1;
                                        detectedConfidence = 0;
                                    }
                                } catch (_) {
                                    // Clear on failure, don't keep-last: the sustain
                                    // glow is driven from detectedMidi, and
                                    // _sustainStillHeld refreshes its grace window
                                    // every render. Holding a stale pitch across
                                    // repeated IPC failures would keep a muted note
                                    // glowing indefinitely. Clearing still lets
                                    // NOTE_SUS_GRACE_MS bridge a one-off hiccup, then
                                    // expire if the failures persist.
                                    detectedMidi = -1;
                                    detectedConfidence = 0;
                                }
                                _diagDetector = {
                                    desktop_bridge: true,
                                    ml: bridgeMlActive,
                                    path: 'desktop-engine-verifier',
                                };
                                // The engine-verifier path returns before
                                // matchNotes(), so run the timing-free verify
                                // target here too (else notedetect:verify never
                                // fires under the engine verifier). Done LAST so
                                // the playhead-dependent drain/live-pitch above
                                // run against this frame's playhead, not a
                                // post-IPC-shifted one. Bridge path → scoreChord
                                // IPC; the null buffer is unused there.
                                if (_verifyTarget) await _runVerifyTarget(null);
                                return;
                            }
                            // Onset-event detection. detectNotes carries a
                            // per-pitch onsetSeq counter; a higher value than
                            // we last consumed means that pitch was struck
                            // anew. Consuming each onset once makes the
                            // single-note path edge-triggered (fires at the
                            // attack) instead of matching a pitch for its
                            // whole ring. The matched judgment is timestamped
                            // at the current playhead — not back-dated by the
                            // onset age, which is not a reliable per-onset
                            // duration. Chords are scored separately via the
                            // scoreChord IPC, gated on a fresh chord-pitch
                            // onset in bridgeNewOnsets.
                            let detection = null;
                            if (hasDetectNotes) {
                                try { detection = await desktop.audio.detectNotes(); }
                                catch (_) { detection = null; }
                                if (!enabled || gen !== sessionGen) return;
                            }

                            if (detection && Array.isArray(detection.notes)) {
                                bridgeNewOnsets.clear();
                                for (const n of detection.notes) {
                                    if (!n || typeof n.midi !== 'number'
                                        || typeof n.onsetSeq !== 'number') continue;
                                    const prev = bridgeOnsetSeqSeen.get(n.midi);
                                    if (prev !== undefined && n.onsetSeq <= prev) continue;
                                    bridgeOnsetSeqSeen.set(n.midi, n.onsetSeq);
                                    // The first poll only primes the seq
                                    // baseline — pre-existing onsets from
                                    // before enable must not replay as a burst.
                                    if (bridgeOnsetPrimed
                                        && typeof n.confidence === 'number'
                                        && n.confidence >= detectionConfidenceMin) {
                                        bridgeNewOnsets.set(n.midi, {
                                            ageMs: Number.isFinite(n.onsetMs) ? n.onsetMs : 0,
                                            conf: n.confidence,
                                        });
                                    }
                                }
                                bridgeOnsetPrimed = true;

                                // Single-note pick = highest-confidence active
                                // note (level-triggered). Edge-triggering the
                                // single-note path on the onset posteriorgram
                                // alone proved too sparse for fast guitar and
                                // dropped notes; the onset events above are
                                // used only to gate chord timing.
                                let best = null;
                                for (const n of detection.notes) {
                                    if (n && typeof n.midi === 'number'
                                        && (best === null || n.confidence > best.confidence)) {
                                        best = n;
                                    }
                                }
                                if (best && best.confidence >= detectionConfidenceMin) {
                                    detectedMidi = best.midi;
                                    detectedConfidence = best.confidence;
                                } else {
                                    detectedMidi = -1;
                                    detectedConfidence = 0;
                                    detectedString = -1;
                                    detectedFret = -1;
                                }
                            } else {
                                bridgeNewOnsets.clear();
                                const p = await _ndBridgePitch();
                                if (!enabled || gen !== sessionGen) return;
                                if (p && typeof p.midiNote === 'number' && p.midiNote >= 0
                                    && typeof p.confidence === 'number' && p.confidence >= detectionConfidenceMin) {
                                    detectedMidi = p.midiNote;
                                    detectedConfidence = p.confidence;
                                } else {
                                    detectedMidi = -1;
                                    detectedConfidence = 0;
                                    detectedString = -1;
                                    detectedFret = -1;
                                }
                            }
                            // Stamp the detector identity from the path that
                            // actually ran this tick (read back by the
                            // diagnostic export).
                            _diagDetector = {
                                desktop_bridge: true,
                                ml: bridgeMlActive,
                                path: bridgeMlActive ? 'desktop-ml-basicpitch' : 'desktop-yin',
                            };
                            // The chord branch in matchNotes() dispatches the
                            // audio:scoreChord IPC — no raw audio buffer is
                            // threaded here, the engine reads its own input
                            // ring. Pass null; the single-note path is gated
                            // on detectedMidi >= 0 and skips itself regardless,
                            // and checkMisses() is independent.
                            await matchNotes(null);
                        } catch (e) {
                            console.warn('[note_detect] bridge poll failed:', e && e.message ? e.message : e);
                        } finally {
                            processingFrame = false;
                        }
                    }, 50);

                    startBridgeLevelMeter(desktop);
                    populateDevices();
                    return true;
                }
                // bridge present but engine unavailable — fall through
                // to the getUserMedia path so the user sees a concrete
                // error (and can troubleshoot the engine separately)
                // rather than silent failure.
            }

            // Acquire the stream — use the supplied one or open
            // getUserMedia for our own.
            if (externalStream) {
                stream = externalStream;
            } else {
                const constraints = {
                    audio: {
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false,
                        channelCount: 2,
                    }
                };
                if (selectedDeviceId) {
                    constraints.audio.deviceId = { exact: selectedDeviceId };
                }

                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    const isHttp = location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
                    const msg = isHttp
                        ? 'Microphone access requires HTTPS. You are accessing Slopsmith over HTTP from a non-localhost address. Either:\n\n1. Use a reverse proxy with HTTPS (recommended)\n2. Access via localhost\n3. Add a self-signed certificate to the server'
                        : 'Microphone access is not available in this browser. Use Chrome or Edge.';
                    throw new Error(msg);
                }
                // On the silent first auto-enable attempt, don't let a
                // transiently-unmatched (still-enumerating) saved device be
                // forgotten — the delayed retry re-tries the real device.
                stream = await openInstrumentStream(constraints, {
                    allowDeviceFallback: !autoEnableTrial,
                });
            }

            // Acquire the context independently — a caller can supply
            // just one of {stream, context} and we create the other.
            // `latencyHint: 'interactive'` asks the browser for the
            // lowest-latency input/output config the platform supports —
            // Chromium otherwise picks platform-defaults that can add
            // 10-30 ms of buffer for no reason. Real-time pitch-detect
            // is exactly the case the hint exists for. Falls back
            // gracefully if a host hands us an externalAudioCtx that's
            // already constructed.
            audioCtx = externalAudioCtx || new (window.AudioContext || window.webkitAudioContext)({
                latencyHint: 'interactive',
            });

            sourceNode = audioCtx.createMediaStreamSource(stream);
            const streamChannels = sourceNode.channelCount;

            gainNode = audioCtx.createGain();
            gainNode.gain.value = inputGain;

            if (streamChannels >= 2 && selectedChannel !== 'mono') {
                splitterNode = audioCtx.createChannelSplitter(2);
                sourceNode.connect(splitterNode);
                mergerNode = audioCtx.createChannelMerger(1);
                const chIdx = selectedChannel === 'left' ? 0 : 1;
                splitterNode.connect(mergerNode, chIdx, 0);
                mergerNode.connect(gainNode);
            } else {
                sourceNode.connect(gainNode);
            }

            levelAnalyser = audioCtx.createAnalyser();
            levelAnalyser.fftSize = 512;
            levelAnalyser.smoothingTimeConstant = 0.8;
            gainNode.connect(levelAnalyser);

            const processor = audioCtx.createScriptProcessor(frameSize, 1, 1);
            worklet = processor;
            accumBuffer = new Float32Array(0);
            pendingBuffer = null;

            processor.onaudioprocess = (e) => {
                if (!enabled) return;
                const input = e.inputBuffer.getChannelData(0);
                const prev = accumBuffer;
                const combined = new Float32Array(prev.length + input.length);
                combined.set(prev);
                combined.set(input, prev.length);
                // Bass needs a longer window to resolve its low fundamental;
                // size the analysis frame from the arrangement + device rate.
                const minSamples = _ndMinAnalysisSamples(currentArrangement, audioCtx.sampleRate);
                if (combined.length >= minSamples) {
                    const start = combined.length - minSamples;
                    pendingBuffer = combined.slice(start, start + minSamples);
                    accumBuffer = new Float32Array(0);
                } else {
                    accumBuffer = combined;
                }
            };

            // Detection runs on a timer, not in the audio callback. The
            // in-flight guard matters when CREPE inference takes longer
            // than the 50 ms tick — without it, multiple processFrame
            // promises can be alive at once and resolve out of order,
            // letting a stale detection overwrite a newer one.
            detectInterval = setInterval(() => {
                if (processingFrame || !pendingBuffer) return;
                const buf = pendingBuffer;
                pendingBuffer = null;
                processingFrame = true;
                processFrame(buf).finally(() => { processingFrame = false; });
            }, 50);

            gainNode.connect(processor);
            processor.connect(audioCtx.destination);

            startLevelMeter();
            populateDevices();

            return true;
        } catch (e) {
            console.error('Note detect: mic access denied or failed:', e);
            // Suppress the user-facing alert if the instance is no
            // longer enabled — the enable/restart was superseded by a
            // concurrent disable (e.g. song switch while the mic
            // permission prompt was open). Surfacing an error the
            // user never asked to see in that case is just noise.
            // The console.error still goes to devtools for
            // diagnostics. autoEnableTrial silences the automatic
            // first auto-enable attempt (a transient not-ready USB device
            // shouldn't pop a dialog on load — the retry surfaces it).
            if (enabled && !autoEnableTrial) {
                alert('Note Detection: Could not access audio input.\n\n' + e.message);
            }
            // Partial-init cleanup — if we got as far as acquiring the
            // stream or creating any AudioNodes before the throw, we
            // own the teardown. stopAudio is null-safe for every
            // resource and respects ownsStream / ownsAudioCtx, so it
            // handles partial state regardless of where we failed.
            stopAudio();
            return false;
        }
    }

    function stopAudio() {
        stopLevelMeter();
        stopBridgeLevelMeter();
        if (detectInterval) { clearInterval(detectInterval); detectInterval = null; }
        pendingBuffer = null;
        // Bridge path doesn't own the JUCE engine — leave audio
        // running for the Audio Plugins panel / other features. Drop
        // the cached preload reference and the flag so a subsequent
        // enable re-resolves window.slopsmithDesktop fresh.
        usingDesktopBridge = false;
        usingNativeFrames = false;
        bridgeDesktop = null;
        // Drop the engine-verifier state — a subsequent enable re-pushes a
        // fresh chart via _ndPushChartToBridge(). Any chart still held by the
        // engine is harmless: nothing drains its verdicts once the flag is off.
        _ndUsingEngineVerifier = false;
        _ndVerifierChartById = new Map();
        _ndVerifierChords = new Map();
        _ndVerifierChordKeyOf = new Map();
        _ndPendingChords = new Map();
        _ndLastPushedPlayhead = 0;
        bridgeMlActive = false;
        bridgeOnsetSeqSeen = new Map();
        bridgeNewOnsets = new Map();
        bridgeOnsetPrimed = false;
        // Disconnect the full node chain in reverse-connect order.
        // Critical in borrower mode (external audioCtx): we leave the
        // caller's context open, and any node we don't disconnect
        // stays live in its graph across enable/disable cycles.
        if (worklet) {
            worklet.onaudioprocess = null;
            try { worklet.disconnect(); } catch (e) { /* already disconnected */ }
            worklet = null;
        }
        if (levelAnalyser) {
            try { levelAnalyser.disconnect(); } catch (e) {}
            levelAnalyser = null;
        }
        if (gainNode) {
            try { gainNode.disconnect(); } catch (e) {}
            gainNode = null;
        }
        if (mergerNode) {
            try { mergerNode.disconnect(); } catch (e) {}
            mergerNode = null;
        }
        if (splitterNode) {
            try { splitterNode.disconnect(); } catch (e) {}
            splitterNode = null;
        }
        if (sourceNode) {
            try { sourceNode.disconnect(); } catch (e) {}
            sourceNode = null;
        }
        // Tear down each resource only if we own it. Ownership is
        // tracked per-resource (see ownsStream / ownsAudioCtx at the
        // top of the factory) so a caller can pass just a stream or
        // just a context without leaking the other.
        if (stream && ownsStream) {
            stream.getTracks().forEach(t => t.stop());
        }
        stream = null;
        if (audioCtx && ownsAudioCtx) {
            try { audioCtx.close(); } catch (e) { /* may already be closed */ }
        }
        audioCtx = null;
        inputLevel = 0;
        inputPeak = 0;
        accumBuffer = new Float32Array(0);
    }

    // Per-instance promise chain that serializes ALL audio-lifecycle
    // operations that await startAudio — both restartAudio and the
    // startAudio call from enable. A generation-only check isn't
    // enough on its own because startAudio() writes to shared
    // instance vars (stream, audioCtx, sourceNode, gainNode, ...)
    // BEFORE the post-await gen check fires. If two operations
    // overlap on getUserMedia, the second's resolved write clobbers
    // the first's refs, and the first's gen-check stopAudio then
    // disconnects the SECOND one's graph. Chaining start/stop onto a
    // single promise prevents overlap entirely.
    let audioOpChain = Promise.resolve();
    function queueAudioOp(fn) {
        const queued = audioOpChain.then(fn);
        // .catch on the chain itself so one rejected op doesn't
        // poison every subsequent call. The caller still sees the
        // unswallowed promise.
        audioOpChain = queued.catch(() => {});
        return queued;
    }

    function restartAudio() {
        return queueAudioOp(async () => {
            sessionGen++;
            const gen = sessionGen;
            stopAudio();
            if (!enabled) return;
            const ok = await startAudio();
            // Treat a restart failure (e.g. mic permission revoked,
            // device unplugged, selected deviceId no longer exists)
            // as a hard disable. Without this, the instance would
            // stay `enabled=true` with HUD + miss-check intervals
            // still running, racking up misses against no audio and
            // showing the Detect button as active. Only fire the
            // disable if we're still the winning operation —
            // otherwise a newer restart or a concurrent disable
            // already owns the teardown.
            if (!ok) {
                if (gen === sessionGen && enabled) {
                    disable({ silent: true });
                }
                return;
            }
            // Even within the chain, disable() can still bump
            // sessionGen and set !enabled between our stop/start
            // and our return. Tear down what startAudio just
            // acquired in that case.
            if (gen !== sessionGen || !enabled) {
                stopAudio();
            }
        });
    }

    // ── Level meter ───────────────────────────────────────────────────

    // Desktop-bridge equivalent of startLevelMeter(). The engine already
    // computes RMS + peak on the audio thread; here we just poll those
    // and drive the same DOM bar the Web-Audio path drives. Polled on
    // setInterval rather than rAF so the IPC round-trip doesn't pin
    // requestAnimationFrame to the IPC cadence when the renderer
    // throttles in the background.
    function startBridgeLevelMeter(desktop) {
        stopBridgeLevelMeter();
        // Bail before installing the timer if the engine doesn't expose
        // getLevels — otherwise we'd run a no-op poll forever, leak the
        // interval, and never surface the missing capability.
        if (!desktop || !desktop.audio) {
            // Bridge/audio not ready yet — a timing state, NOT a capability
            // verdict. Don't latch unavailable here, or a pre-init call would
            // wrongly force fixed full glow; leave the latch for a confirmed
            // missing getLevels below.
            return;
        }
        if (typeof desktop.audio.getLevels !== 'function') {
            bridgeLevelsUnavailable = true;
            return;
        }
        bridgeLevelsUnavailable = false;
        // In-flight guard — if an IPC `getLevels()` round-trip takes
        // longer than the 50 ms timer, queueing further calls would
        // build up a backlog and process stale readings out-of-order.
        // Same pattern as the pitch poll's `processingFrame` guard.
        let levelsInFlight = false;
        bridgeLevelTimer = setInterval(async () => {
            if (!enabled || !usingDesktopBridge || levelsInFlight) return;
            levelsInFlight = true;
            try {
                // A BOUND source (multi-input panel) must gate on ITS OWN device's
                // level — not the global/primary level. Otherwise the silence gate
                // (which can force a detected note to a miss when its level window
                // looks silent) reads the primary device, which is silent while the
                // user plays a DIFFERENT bound interface, and force-fails every hit.
                let levels;
                if (sourceId != null && sourceId !== 0) {
                    // A NON-DEFAULT (owned / extra-device) source must gate on ITS OWN
                    // meter. If the addon is too old to expose getSourceLevels, do NOT
                    // fall back to the global getLevels() — that reads the primary
                    // device, which is silent while the user plays this interface, so
                    // the silence gate would force EVERY note on it to a miss. Skip the
                    // poll instead (the gate then has no data and never force-fails).
                    if (typeof desktop.audio.getSourceLevels !== 'function') {
                        // Older addon: can't read THIS source's level. Latch
                        // unavailable so the sustain-glow fixed-fallback engages (and
                        // we don't gate on the wrong meter). DROP any level history from
                        // a prior metered session so the silence gate sees "no data"
                        // rather than force-failing on the previous source's levels.
                        bridgeLevelsUnavailable = true;
                        _ndLevelSamples.length = 0;
                        return;
                    }
                    levels = await desktop.audio.getSourceLevels(sourceId);
                } else {
                    levels = await desktop.audio.getLevels();
                }
                // Re-check after the await: disable()/destroy() can fire
                // between the IPC round-trip and the resolve, and the
                // bridge timer doesn't track sessionGen the way the
                // pitch poller does. Without this we'd race-write
                // inputLevel/inputPeak and touch the DOM on a torn-down
                // instance.
                if (!enabled || !usingDesktopBridge) return;
                if (!levels) return;
                // Engine reports peaks in 0..1 already; the Web-Audio
                // branch scales RMS by 5 for headroom. Use the engine's
                // value directly — overdriving the bar is a worse UX
                // than a slightly conservative reading.
                // Nullish-coalesce so a legitimate `0` reading (silence)
                // isn't replaced by the fallback — `0 || x` falls through to
                // x, which would inflate the bar during quiet moments.
                const rawLevel = Number.isFinite(levels.inputLevel) ? levels.inputLevel : 0;
                inputLevel = Math.min(1, Math.max(0, rawLevel));
                // Record (songT, level) for the silence gate in the engine
                // verdict drain. The buffer assumes songT advances
                // monotonically; on a backward jump (seek, drill loop
                // restart) we'd otherwise keep stale post-jump high-time
                // samples that the shift()-prune never removes, mixing two
                // timelines into the same window and forcing false misses.
                // Clear the buffer on any backward jump.
                if (hw && typeof hw.getTime === 'function') {
                    const avO = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
                    const songT = hw.getTime() + avO;
                    const last = _ndLevelSamples.length
                        ? _ndLevelSamples[_ndLevelSamples.length - 1].songT
                        : -Infinity;
                    if (songT < last - 0.05) {
                        // Time went backward (seek / drill wrap). Reset.
                        _ndLevelSamples.length = 0;
                    }
                    _ndLevelSamples.push({ songT, level: inputLevel });
                    const cutoff = songT - _ND_LEVEL_HISTORY_S;
                    while (_ndLevelSamples.length > 0 && _ndLevelSamples[0].songT < cutoff) {
                        _ndLevelSamples.shift();
                    }
                    // Pause-safe cap: songT-only pruning relies on songT
                    // advancing, but if playback is paused (or stuck in a
                    // menu) while this 50 ms timer keeps firing, every new
                    // sample has the same songT and the time-based prune
                    // never fires. Enforce a hard sample-count cap as a
                    // safety net so the buffer can't grow unbounded across
                    // a paused session. 6 s of 50 ms polls → 120 samples,
                    // so 240 (2× headroom) is plenty for active playback
                    // and still bounded during pauses.
                    while (_ndLevelSamples.length > 240) {
                        _ndLevelSamples.shift();
                    }
                }
                const rawPeak = Number.isFinite(levels.inputPeak) ? levels.inputPeak : inputLevel;
                const peak = Math.min(1, Math.max(0, rawPeak));
                if (peak > inputPeak) {
                    inputPeak = peak;
                    peakDecay = 30;
                } else if (peakDecay > 0) {
                    peakDecay--;
                } else {
                    inputPeak *= 0.95;
                }
                drawSettingsVU();
            } catch (_) { /* one bad poll shouldn't stop the meter */ }
            finally { levelsInFlight = false; }
        }, 50);
    }

    function stopBridgeLevelMeter() {
        if (bridgeLevelTimer) {
            clearInterval(bridgeLevelTimer);
            bridgeLevelTimer = null;
        }
    }

    function startLevelMeter() {
        stopLevelMeter();
        // Cache the analyser read buffer across rAF ticks. At 60 fps
        // with fftSize=512 this was allocating ~120 kB/s per enabled
        // instance; reusing a single Float32Array (re-allocating only
        // if fftSize changes) keeps the meter out of the GC path.
        let levelBuf = null;
        let levelBufSize = 0;
        const tick = () => {
            if (!levelAnalyser) return;
            const fftSize = levelAnalyser.fftSize;
            if (!levelBuf || levelBufSize !== fftSize) {
                levelBuf = new Float32Array(fftSize);
                levelBufSize = fftSize;
            }
            levelAnalyser.getFloatTimeDomainData(levelBuf);
            let sum = 0;
            for (let i = 0; i < levelBuf.length; i++) sum += levelBuf[i] * levelBuf[i];
            const rms = Math.sqrt(sum / levelBuf.length);
            inputLevel = Math.min(1, rms * 5);
            if (inputLevel > inputPeak) {
                inputPeak = inputLevel;
                peakDecay = 30;
            } else if (peakDecay > 0) {
                peakDecay--;
            } else {
                inputPeak *= 0.95;
            }
            drawSettingsVU();
            levelRaf = requestAnimationFrame(tick);
        };
        levelRaf = requestAnimationFrame(tick);
    }

    function stopLevelMeter() {
        if (levelRaf) {
            cancelAnimationFrame(levelRaf);
            levelRaf = null;
        }
    }

    // Cache the VU-meter element refs for the currently-open settings panel.
    // Called when the panel is (re)built in showSettings(); clears the
    // "panel absent" latch so drawSettingsVU() resumes updating. Pass a
    // panel element to resolve within it, or null to clear the cache on
    // teardown.
    function _vuSetPanel(panel) {
        if (panel) {
            _vuPanelEl = panel;
            _vuBarEl = panel.querySelector('.nd-vu-bar');
            _vuPeakEl = panel.querySelector('.nd-vu-peak');
            _vuPanelAbsent = !_vuBarEl;
        } else {
            _vuPanelEl = null;
            _vuBarEl = null;
            _vuPeakEl = null;
            _vuPanelAbsent = true;
        }
    }

    function drawSettingsVU() {
        let bar = _vuBarEl;
        // Re-resolve only when the cached node is gone (panel rebuilt by
        // another instance, or refs not yet cached). Once we confirm the
        // panel is absent we latch _vuPanelAbsent so the always-on level
        // loop doesn't querySelector every frame while it's closed.
        if (!bar || !bar.isConnected) {
            if (_vuPanelAbsent) return;
            // Resolve ONLY against this instance's own panel ref — never a
            // global document.querySelector, which in splitscreen could bind
            // this detector to another instance's panel and drive the wrong
            // VU meter (CodeRabbit). If our panel is gone, clear and return.
            const panel = _vuPanelEl && _vuPanelEl.isConnected ? _vuPanelEl : null;
            if (!panel) { _vuSetPanel(null); return; }
            _vuSetPanel(panel);
            bar = _vuBarEl;
            if (!bar) return;
        }
        const peak = _vuPeakEl && _vuPeakEl.isConnected ? _vuPeakEl : null;
        const pct = Math.round(inputLevel * 100);
        bar.style.width = pct + '%';
        bar.className = pct > 85 ? 'nd-vu-bar h-full rounded transition-all duration-75 bg-red-500'
            : pct > 60 ? 'nd-vu-bar h-full rounded transition-all duration-75 bg-yellow-500'
            : 'nd-vu-bar h-full rounded transition-all duration-75 bg-green-500';
        if (peak) {
            const peakPct = Math.round(inputPeak * 100);
            peak.style.left = Math.min(peakPct, 100) + '%';
        }
    }

    // ── Frame processing ──────────────────────────────────────────────
    async function processFrame(buffer) {
        let result;
        let detectorUsed;
        // Capture the session generation at frame start. disable()
        // increments sessionGen, so any frame that was already running
        // past an `await` sees a changed generation and bails rather
        // than apply stale hits / fire stale events. Without this
        // guard a CREPE inference in flight during song switch would
        // score against the old session's chart.
        const gen = sessionGen;
        // On the desktop bridge there is no audioCtx; use the engine
        // sample rate cached at startAudio() time instead. Browser
        // path keeps reading audioCtx.sampleRate.
        const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
        const activeMethod = _ndEffectiveDetectionMethod();
        switch (activeMethod) {
            case 'crepe':
                if (_ndShared.model) {
                    result = await _ndCrepeDetect(buffer);
                    detectorUsed = 'crepe';
                    if (result.freq <= 0 || result.confidence < detectionConfidenceMin) {
                        result = _ndYinDetect(buffer, sr);
                        detectorUsed = 'yin';
                    }
                    break;
                }
                result = _ndYinDetect(buffer, sr);
                detectorUsed = 'yin';
                break;
            case 'hps':
                result = _ndHpsDetect(buffer, sr);
                detectorUsed = 'hps';
                break;
            case 'yin':
            default:
                result = _ndYinDetect(buffer, sr);
                detectorUsed = 'yin';
        }

        // If the instance was disabled (or re-enabled into a new
        // session) while CREPE was awaiting, drop this result on the
        // floor — don't touch detection state or fire events.
        if (!enabled || gen !== sessionGen) return;

        if (result.freq <= 0 || result.confidence < detectionConfidenceMin) {
            if (result.underBuffered && !underBufferWarned) {
                console.warn(`[note_detect] ${detectorUsed} received an undersized buffer — low-frequency (bass) notes will drop silently. Check the frame accumulation path.`);
                underBufferWarned = true;
            }
            detectedMidi = -1;
            detectedConfidence = 0;
            detectedString = -1;
            detectedFret = -1;
            detectedDisplayMidi = -1;
            // Fall through to matchNotes — the chord path doesn't need a
            // single confident pitch (it scores per-string energy bands),
            // and chord audio is the case where YIN/HPS most often
            // returns low confidence. Single-note matching inside
            // matchNotes() is gated on detectedMidi >= 0, so it skips
            // itself; only chord groups get evaluated here.
        } else {
            detectedMidi = _ndFreqToMidi(result.freq);
            detectedConfidence = result.confidence;
        }

        // Stamp the detector identity for the diagnostic. Use `detectorUsed`
        // (the detector that actually ran this frame), so an auto-HPS bass
        // frame reports as hps AND a crepe→yin low-confidence/missing-model
        // fallback reports the real yin, not the requested crepe. The same
        // JS-DSP detector runs for both the browser path and the desktop
        // native-frame mode; only the audio SOURCE differs, so distinguish
        // them in the path tag (and flag desktop_bridge in native-frame mode).
        _diagDetector = usingNativeFrames
            ? { desktop_bridge: true, ml: false, path: 'desktop-native-' + (detectorUsed || activeMethod) }
            : { desktop_bridge: false, ml: false, path: 'web-' + (detectorUsed || activeMethod) };

        // Pass the current frame's buffer through to matchNotes so the
        // chord scorer can run on the same audio that was just analysed
        // for pitch. The shared `pendingBuffer` is cleared by the timer
        // (see detectInterval) before processFrame is called, so reading
        // it later from matchNotes would either skip (null) or pick up a
        // newer buffer captured mid-processing.
        await matchNotes(buffer);

        // Reference-recording capture: tap the same audio the detector
        // just analysed. Gated on (a) the user having armed a take and
        // (b) the song actually playing — we don't want to fill the
        // buffer with silence from someone leaving Detect running on
        // the home screen.
        if (_recArmed && _recSongPlaying) {
            _recSampleRate = audioCtx ? audioCtx.sampleRate : (bridgeSampleRate || _recSampleRate);
            // Client-side cap mirrors the routes.py 32 MB ceiling so a
            // runaway arm (user walks away with Detect still capturing)
            // can't balloon the page's heap before the server-side cap
            // rejects the upload. 32 MB / 4 bytes per Float32 ≈ 8M
            // samples ≈ 190 s at 44.1 kHz (~3.2 min) — well past a
            // single benchmark take. When we hit it, the buffer stays
            // at the cap and `_recCappedAt` is set so the save path
            // can surface a "truncated" note on the resulting WAV.
            //
            // Track the running sample count in `_recTotalSamples`
            // rather than `_recChunks.reduce(...)` per frame. The
            // reduce was O(n) per frame and O(n²) over a take — a
            // measurable hit on the detection hot path on long
            // recordings.
            const maxSamples = Math.floor((32 * 1024 * 1024) / 4);
            if (_recTotalSamples >= maxSamples) {
                if (!_recCappedAt) _recCappedAt = _recTotalSamples / (_recSampleRate || 44100);
                // Silently drop further frames — the cap is the upper bound
                // and we'd rather keep the first N minutes than truncate the
                // tail of a long take.
            } else {
                // slice() because the analyser may overwrite the buffer the
                // next time processFrame fires.
                const copy = buffer.slice();
                _recChunks.push(copy);
                _recTotalSamples += copy.length;
            }
        }
    }

    // ── Note matching ─────────────────────────────────────────────────
    function noteKey(note, time) {
        return `${time.toFixed(3)}_${note.s}_${note.f}`;
    }

    // ── Renderer note-state provider (slopsmith#254) ──────────────────
    // How long (s) a missed note's gem stays red-washed on the highway.
    // Short on purpose — the slide-down miss marker (drawOverlay) carries
    // the longer-lived feedback; the gem wash is just an instant cue.
    const NOTE_MISS_GEM_TTL = 0.6;
    // Grace (ms) after an on-pitch detection during which a sustained
    // note still counts as actively held — smooths render-vs-pitch frame
    // rate mismatch (see _susActiveUntil).
    const NOTE_SUS_GRACE_MS = 250;

    // Provisional on-strike feedback (slopsmith#254 follow-up). On the desktop
    // engine-verifier path the authoritative verdict for a note only lands after
    // its sustain window elapses (~sus + 0.1 s), which is usually AFTER the
    // highway has culled the gem — so a struck *sustained* note would otherwise
    // never light. While a note has no verdict yet, if it's at/near the strike
    // line and the live monophonic detector currently hears its pitch, glow it
    // now; the engine verdict reconciles HUD totals later. Lead/tail tolerances
    // bracket the note's [chartTime, chartTime+sus] window in the visual clock.
    const NOTE_LIVE_LEAD = 0.12;
    const NOTE_LIVE_TAIL = 0.12;

    // Sustain glow brightness follows the live input level: a held note lights
    // only while the string is ringing above NOTE_GLOW_LEVEL_THRESHOLD, and its
    // alpha scales with level up to NOTE_GLOW_REF_LEVEL (full glow). Below the
    // threshold the string is treated as silenced and the gem stops glowing, so
    // the glow fades naturally as the note decays and drops when muted. All
    // three are tunable to taste.
    const NOTE_GLOW_LEVEL_THRESHOLD = 0.015; // input level (0..1) = "still ringing" (just above the ~0.008 noise floor)
    const NOTE_GLOW_REF_LEVEL       = 0.25; // level mapped to full glow
    const NOTE_GLOW_MIN_ALPHA       = 0.30; // floor so a quiet-but-ringing note stays visible

    // Live-level → sustain-glow alpha. Returns 0 when the string isn't ringing
    // above the threshold (the caller then leaves the gem un-lit).
    function _ndSustainGlowAlpha() {
        // Fixed-glow fallback for bridge builds whose engine lacks getLevels:
        // startBridgeLevelMeter() bails (latching bridgeLevelsUnavailable), so
        // inputLevel never moves off 0 and a level-gated glow would never light
        // at all. Preserve the pre-level-metering behaviour (full glow) so
        // sustained notes still show as active on those builds. Keyed on the
        // capability latch — not `!bridgeLevelTimer`, which is also true during
        // startup/teardown and would wrongly force full glow then.
        if (usingDesktopBridge && bridgeLevelsUnavailable) return 1;
        if (!(inputLevel > NOTE_GLOW_LEVEL_THRESHOLD)) return 0;
        const span = NOTE_GLOW_REF_LEVEL - NOTE_GLOW_LEVEL_THRESHOLD;
        const a = span > 0 ? (inputLevel - NOTE_GLOW_LEVEL_THRESHOLD) / span : 1;
        return Math.max(NOTE_GLOW_MIN_ALPHA, Math.min(1, a));
    }

    // Registered via highway.setNoteStateProvider(). The active renderer
    // calls this per visible chart note / chord-note. Returns null (render
    // normally), or { state, alpha } where state ∈ {'active','hit','miss'}:
    //   'active' — sustained note still ringing AND currently on-pitch (full glow)
    //   'hit'    — recently struck cleanly (glow fading over hitGlowDuration)
    //   'miss'   — recently judged a miss (brief red wash)
    // `note` is the chart note object; for chord notes `chartTime` is the
    // chord's time (matches how noteResults keys chord notes). Must stay
    // cheap: called per note per renderer per frame.
    function noteStateFor(note, chartTime) {
        if (!enabled || !note || !Number.isFinite(chartTime)) return null;
        const key = noteKey(note, chartTime);
        const j = noteResults.get(key);
        if (!j) {
            // No verdict yet — provisional live glow so a struck note (esp. a
            // long sustain whose engine verdict lands after the gem is culled)
            // lights immediately. Only while the note straddles the strike line
            // AND the live detector hears its pitch (see NOTE_LIVE_LEAD above).
            const songTLive = ((hw && hw.getTime) ? hw.getTime() : 0)
                + ((hw && hw.getAvOffset) ? hw.getAvOffset() / 1000 : 0);
            const susLive = +note.sus || 0;
            if (songTLive >= chartTime - NOTE_LIVE_LEAD
                && songTLive <= chartTime + susLive + NOTE_LIVE_TAIL
                && _sustainStillHeld(key, note)) {
                const a = _ndSustainGlowAlpha();
                if (a > 0) return { state: 'active', alpha: a, live: true };
            }
            return null;  // not judged / not ringing above threshold — render normally
        }

        // Renderer clock for the visual age / TTL math — `getTime() +
        // avOffset` is the same basis `drawOverlay()` uses for its slide-
        // down miss markers and matches when the user *sees* the note
        // cross the strike line. The `-latencyOffset` correction is for
        // *audio* timing (correlating mic input to chart notes in
        // matchNotes/checkMisses); applying it here would start the
        // post-hit fade ~latencyOffset (default 80 ms) before the gem
        // visually arrived, shortening the visible glow window.
        const songT = ((hw && hw.getTime) ? hw.getTime() : 0)
            + ((hw && hw.getAvOffset) ? hw.getAvOffset() / 1000 : 0);

        // Anchor the post-strike glow / miss-wash age on when the verdict
        // landed (_ndDisplayFrom, stamped in recordJudgment), not the note's
        // chart time. An engine verdict arrives ~0.4 s after the note
        // crosses the line; measuring the fade from chart time would leave
        // only a sliver of the window — or none — by the time the gem can
        // actually be tinted. clamp to chartTime so a verdict that somehow
        // predates the note can't start the fade early.
        const dispAnchor = Number.isFinite(j._ndDisplayFrom)
            ? Math.max(chartTime, j._ndDisplayFrom) : chartTime;

        if (j.hit) {
            // Score-pop channel for the renderer: per-note points stamped by
            // recordJudgment. Chord MEMBER judgments carry no points of their
            // own — the chord-level judgment (keyed `<t>_chord`) owns the
            // value — so fall back to it and hand back ITS key as popKey,
            // letting the renderer dedupe to one pop per chord instead of
            // one per gem. Singles use their own key.
            let points = j._ndPoints, mult = j._ndMult, popKey = key;
            if (points === undefined) {
                const chordKey = `${chartTime.toFixed(3)}_chord`;
                const cj = noteResults.get(chordKey);
                if (cj && cj.hit && cj._ndPoints !== undefined) {
                    points = cj._ndPoints;
                    mult = cj._ndMult;
                    popKey = chordKey;
                }
            }
            const sus = +note.sus || 0;
            // Sustained note still inside its ring window AND still audibly
            // ringing on-pitch → hold it lit, brightness tracking the live
            // input level. Below the level threshold, fall through to the
            // post-strike hit fade (the note has decayed / been muted).
            if (sus > 0.05 && songT < chartTime + sus + 0.05 && _sustainStillHeld(key, note)) {
                const a = _ndSustainGlowAlpha();
                if (a > 0) return { state: 'active', alpha: a, live: true, points, mult, popKey };
            }
            // Otherwise: brief post-strike glow that fades out over
            // hitGlowDuration (measured from when the verdict landed).
            const age = songT - dispAnchor;
            if (age < 0) return { state: 'hit', alpha: 1, points, mult, popKey };  // struck a hair early
            const glowDur = Math.max(0.1, hitGlowDuration);
            if (age >= glowDur) return null;
            return { state: 'hit', alpha: 1 - age / glowDur, points, mult, popKey };
        }
        // Missed (timing window expired, or matched-but-not-clean).
        const age = songT - dispAnchor;
        if (age < 0 || age >= NOTE_MISS_GEM_TTL) return null;
        return { state: 'miss', alpha: 1 - age / NOTE_MISS_GEM_TTL };
    }

    // Is the live monophonic detection on target for `note`? Maintains a
    // short grace window in _susActiveUntil so a held note doesn't flicker
    // between audio frames. Chord notes don't get a per-frame polyphonic
    // re-score today — for a sustained chord this returns false once the
    // monophonic detector loses the pitch, so the chord falls through to
    // the post-strike glow fade in noteStateFor.
    // TODO(slopsmith#254 follow-up): re-run the constraint chord scorer
    // per audio frame for sustained-and-hit chords so held chords glow
    // the same way held single notes do.
    function _sustainStillHeld(key, note) {
        const nowMs = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
        if (detectedMidi >= 0 && detectedConfidence > detectionConfidenceMin) {
            const expectedMidi = _ndMidiFromStringFret(
                note.s, note.f, currentArrangement, currentStringCount, tuningOffsets, capo
            );
            if (Number.isFinite(expectedMidi)
                && Math.abs(_ndNearestOctaveCents(detectedMidi, expectedMidi)) <= pitchTolerance) {
                _susActiveUntil.set(key, nowMs + NOTE_SUS_GRACE_MS);
                return true;
            }
        }
        const until = _susActiveUntil.get(key);
        return Number.isFinite(until) && until > nowMs;
    }

    function bsearch(arr, target) {
        let lo = 0, hi = arr.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (arr[mid].t < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    function dispatchInstanceEvent(type, detail) {
        // Global dispatch preserves back-compat (practice journal and
        // other consumers listen on `window`). Per-instance dispatch
        // on `instanceRoot` lets splitscreen and other multi-panel
        // consumers attach listeners scoped to a single detector.
        const init = { detail, bubbles: true };
        try { window.dispatchEvent(new CustomEvent(type, init)); } catch (e) {}
        try { instanceRoot.dispatchEvent(new CustomEvent(type, init)); } catch (e) {}
    }

    function emitSlopsmithJudgment(judgment) {
        if (!window.slopsmith || typeof window.slopsmith.emit !== 'function') return;
        try {
            window.slopsmith.emit(judgment.hit ? 'note:hit' : 'note:miss', judgment);
        } catch (e) {}
    }

    function dispatchJudgment(judgment) {
        dispatchInstanceEvent(judgment.hit ? 'notedetect:hit' : 'notedetect:miss', judgment);
        emitSlopsmithJudgment(judgment);
    }

    // Session-level FX broadcast for renderers (multiplier tier changes,
    // streak milestones, streak breaks). Fires both as a bubbling DOM
    // CustomEvent (dispatchInstanceEvent — lets splitscreen renderers scope
    // to their own panel via the event path) and on the slopsmith bus for
    // bus-only consumers. Fields per fxType:
    //   multiplier  — { mult, prevMult, streak }
    //   milestone   — { streak, mult }
    //   streakBreak — { lostStreak, prevMult }
    // All events also carry { isDefault, ts }. Additive-only contract: new
    // fxTypes/fields may appear, existing ones never change meaning.
    function dispatchFx(detail) {
        detail.isDefault = isDefault;
        detail.ts = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
        dispatchInstanceEvent('notedetect:fx', detail);
        if (window.slopsmith && typeof window.slopsmith.emit === 'function') {
            try { window.slopsmith.emit('notedetect:fx', detail); } catch (e) {}
        }
    }

    // The `extra.chord ? chordTimingHitThreshold : timingHitThreshold`
    // selector below is the chord-vs-single-note threshold split for
    // issue #38. _ndMakeJudgment is threshold-agnostic — it honours
    // whatever `timingThresholdMs` we pass — so the entire chord-window
    // policy lives at THIS call site (and its sibling `makeMissJudgment`
    // below). End-to-end coverage of the selector lives in
    // tools/regression-fixtures.json (Bad Habit): if this ternary ever
    // inverts or drops chord-judgment widening, the fixture score
    // collapses by ~10pp on a fixed input. Unit-level coverage of
    // _ndMakeJudgment's threshold handling itself is in
    // test/judgment.test.js.
    function makeMatchedJudgment(cn, noteTime, t, expectedMidi, detectedMidiForJudgment, confidence, extra = {}) {
        const hasExplicitPitchError = Object.prototype.hasOwnProperty.call(extra, 'pitchError');
        const pitchError = hasExplicitPitchError
            ? extra.pitchError
            : (Number.isFinite(detectedMidiForJudgment) ? (detectedMidiForJudgment - expectedMidi) * 100 : null);
        const expectedFreq = 440 * Math.pow(2, (expectedMidi - 69) / 12);
        const detectedFreq = Number.isFinite(detectedMidiForJudgment)
            ? 440 * Math.pow(2, (detectedMidiForJudgment - 69) / 12)
            : null;
        return _ndMakeJudgment({
            matched: true,
            note: extra.note || { s: cn.s, f: cn.f },
            notes: extra.notes || null,
            chord: !!extra.chord,
            chartNote: extra.chartNote || cn,
            noteTime,
            judgedAt: t,
            expectedMidi,
            detectedMidi: detectedMidiForJudgment,
            confidence,
            pitchError,
            expectedFreq,
            detectedFreq,
            timingThresholdMs: (extra.chord ? chordTimingHitThreshold : timingHitThreshold) * 1000,
            // A bend / slide / harmonic note's pitch is intentionally not at
            // the chart pitch — the caller passes a widened threshold so the
            // hit is not gated on a moving target.
            pitchThresholdCents: Number.isFinite(extra.pitchThresholdCents)
                ? extra.pitchThresholdCents : pitchHitThreshold,
            hitStrings: extra.hitStrings,
            totalStrings: extra.totalStrings,
            score: extra.score,
            monophonicDetected: extra.monophonicDetected,
            lateGraceMs: extra.lateGraceMs,
        });
    }

    function makeMissJudgment(cn, noteTime, t, expectedMidi, extra = {}) {
        return _ndMakeJudgment({
            matched: false,
            note: extra.note || { s: cn.s, f: cn.f },
            notes: extra.notes || null,
            chord: !!extra.chord,
            chartNote: extra.chartNote || cn,
            noteTime,
            judgedAt: t,
            expectedMidi,
            timingThresholdMs: (extra.chord ? chordTimingHitThreshold : timingHitThreshold) * 1000,
            pitchThresholdCents: pitchHitThreshold,
            hitStrings: extra.hitStrings,
            totalStrings: extra.totalStrings,
            score: extra.score,
            lateGraceMs: extra.lateGraceMs,
        });
    }

    // Update per-string diagnostic counters for a chord constituent
    // judgment WITHOUT updating any other diagnostic counter. Chord
    // constituent judgments are stashed straight into noteResults
    // (bypassing recordJudgment) because totals/event-log are
    // already accounted for at the chord-level entry — but the
    // per-string panel still needs to see each string's outcome,
    // otherwise it overrepresents whatever string happens to be
    // `liveNotes[0]` and is blind to the rest.
    function _recordPerStringForChord(judgment) {
        const n = judgment.chartNote || judgment.note;
        if (n && Number.isInteger(n.s) && n.s >= 0 && n.s < _diagPerString.length) {
            const slot = _diagPerString[n.s];
            if (judgment.hit) slot.hits++; else slot.misses++;
        }
    }

    // Bin one judgment into the diagnostic counters. Called from inside
    // recordJudgment under the same `count` gate so this never double-
    // counts (chord events fire one chord-level judgment plus per-string
    // ones; only the chord-level passes count=true). One miss → exactly
    // one primary-cause bin (chord events into chordPartial regardless
    // of axis; non-chord misses chosen as pure → timing → pitch in that
    // priority, so a single bar height adds up to total misses).
    //
    // NOTE: per-string counters here only see the chord-level chartNote
    // (lead constituent). Chord constituents go through
    // _recordPerStringForChord at their stash sites so per-string
    // stats reflect each string's actual outcome.
    function _recordDiagnostic(judgment) {
        const isChord = !!judgment.chord;
        if (judgment.hit) {
            (isChord ? _diagChords : _diagSingles).hits++;
        } else {
            (isChord ? _diagChords : _diagSingles).misses++;
            if (isChord) {
                _diagBreakdown.chordPartial++;
            } else if (judgment.detectedMidi == null) {
                _diagBreakdown.pure++;
            } else if (judgment.timingState === 'EARLY') {
                _diagBreakdown.early++;
            } else if (judgment.timingState === 'LATE') {
                _diagBreakdown.late++;
            } else if (judgment.pitchState === 'SHARP') {
                _diagBreakdown.sharp++;
            } else if (judgment.pitchState === 'FLAT') {
                _diagBreakdown.flat++;
            } else {
                // Defensive fallback — keep totals balanced if a future
                // judgment shape doesn't trip any axis (shouldn't happen
                // today). Land it in pure so the bin sums still match.
                _diagBreakdown.pure++;
            }
        }
        // Per-string counters: only update for non-chord judgments here.
        // For chord-level judgments, judgment.chartNote is the chord's
        // lead constituent (`liveNotes[0]`), which doesn't represent any
        // single string's outcome — counting it here would overrepresent
        // whichever string happened to be the lead and miss the other
        // constituents. Per-string credit for chord constituents flows
        // through _recordPerStringForChord at the constituent stash sites.
        if (!isChord) {
            const n = judgment.chartNote || judgment.note;
            if (n && Number.isInteger(n.s) && n.s >= 0 && n.s < _diagPerString.length) {
                const slot = _diagPerString[n.s];
                if (judgment.hit) slot.hits++; else slot.misses++;
            }
        }
        if (Number.isFinite(judgment.timingError) && _diagTimingErrors.length < _DIAG_ERROR_CAP) {
            _diagTimingErrors.push(judgment.timingError);
            if (judgment.hit && _diagTimingErrorsHits.length < _DIAG_ERROR_CAP) {
                _diagTimingErrorsHits.push(judgment.timingError);
            }
        }
        if (Number.isFinite(judgment.pitchError) && _diagPitchErrors.length < _DIAG_ERROR_CAP) {
            _diagPitchErrors.push(judgment.pitchError);
        }
        // Build the event object once; push to in-memory log (capped)
        // AND stream to the backend live-judgment endpoint when tuning
        // mode is on. The streaming path is fire-and-forget — failures
        // are swallowed since they shouldn't disrupt detection or
        // bookkeeping.
        const nn = judgment.chartNote || judgment.note || {};
        const eventObj = {
            t:   Number.isFinite(judgment.noteTime) ? +judgment.noteTime.toFixed(3) : null,
            at:  Number.isFinite(judgment.time)     ? +judgment.time.toFixed(3)     : null,
            s:   Number.isInteger(nn.s) ? nn.s : null,
            f:   Number.isInteger(nn.f) ? nn.f : null,
            sus: Number.isFinite(nn.sus) ? +(+nn.sus).toFixed(3) : 0,
            hit:   !!judgment.hit,
            chord: !!judgment.chord,
            ts:  judgment.timingState || null,
            ps:  judgment.pitchState  || null,
            te:  Number.isFinite(judgment.timingError) ? judgment.timingError : null,
            pe:  Number.isFinite(judgment.pitchError)  ? judgment.pitchError  : null,
            ex:  Number.isFinite(judgment.expectedMidi) ? judgment.expectedMidi : null,
            dx:  Number.isFinite(judgment.detectedMidi) ? judgment.detectedMidi : null,
            cnf: Number.isFinite(judgment.confidence) ? +judgment.confidence.toFixed(3) : 0,
            hs:  Number.isFinite(judgment.hitStrings)   ? judgment.hitStrings   : undefined,
            tt:  Number.isFinite(judgment.totalStrings) ? judgment.totalStrings : undefined,
            sc:  Number.isFinite(judgment.score) ? +judgment.score.toFixed(3) : undefined,
            tf:  _diagTechFlags(nn),
        };
        if (_diagEvents.length < _DIAG_EVENT_CAP) {
            _diagEvents.push(eventObj);
        }
        if ((tuningMode || _recArmedForTraining) && _liveSessionId) {
            _streamLiveJudgment(eventObj);
        }
    }

    function _diagTechFlags(n) {
        if (!n) return null;
        const flags = [];
        if (n.bn)               flags.push('B');    // bend
        if (n.sl != null && n.sl >= 0) flags.push('S');    // slide
        if (n.hm || n.hp)       flags.push('H');    // harmonic / pinch
        if (n.ho)               flags.push('h');    // hammer-on
        if (n.po)               flags.push('p');    // pull-off
        if (n.tp)               flags.push('t');    // tap
        if (n.pm)               flags.push('PM');   // palm mute
        if (n.mt)               flags.push('M');    // muted
        if (n.tr)               flags.push('TR');   // tremolo
        if (n.ac)               flags.push('A');    // accent
        if ((+n.sus || 0) > 0)  flags.push('SUS');
        return flags.length ? flags.join(',') : null;
    }

    function _diagPercentile(arr, p) {
        if (!arr || !arr.length) return null;
        const sorted = arr.slice().sort((a, b) => a - b);
        return _diagPercentileFromSorted(sorted, p);
    }
    // Same nearest-rank math as _diagPercentile but takes an already-
    // sorted array. Used by the bulk helper below to avoid sorting the
    // same array three times when computing p10/median/p90 for one
    // distribution.
    function _diagPercentileFromSorted(sorted, p) {
        if (!sorted || !sorted.length) return null;
        const rank = (p / 100) * (sorted.length - 1);
        const idx = Math.max(0, Math.min(sorted.length - 1, Math.round(rank)));
        return sorted[idx];
    }
    // Sort once, compute count + p10/median/p90 once. _buildDiagnosticPayload
    // calls this three times per export (timing, timing-hits, pitch); the
    // previous code did three .slice().sort() per call there → 9 sorts per
    // payload. The Settings-page A/V auto-calibrate panel polls every 1.5 s
    // while open, so this hit was real.
    function _diagDistribution(arr) {
        if (!arr || !arr.length) return { count: 0, p10: null, median: null, p90: null };
        const sorted = arr.slice().sort((a, b) => a - b);
        return {
            count: sorted.length,
            p10:    _diagPercentileFromSorted(sorted, 10),
            median: _diagPercentileFromSorted(sorted, 50),
            p90:    _diagPercentileFromSorted(sorted, 90),
        };
    }

    function _diagResetCounters() {
        for (const k of Object.keys(_diagBreakdown)) _diagBreakdown[k] = 0;
        _diagSingles.hits = 0; _diagSingles.misses = 0;
        _diagChords.hits  = 0; _diagChords.misses  = 0;
        for (const slot of _diagPerString) { slot.hits = 0; slot.misses = 0; }
        _diagTimingErrors.length = 0;
        _diagTimingErrorsHits.length = 0;
        _diagPitchErrors.length  = 0;
        _diagEvents.length       = 0;
    }

    function recordJudgment(key, judgment, { count = true, emit = true } = {}) {
        // slopsmith#254 — stamp the song-time at which this verdict became
        // known. noteStateFor() measures the highway gem's hit/miss display
        // window from here, not from the note's chart time: the engine
        // verifier reports verdicts ~0.4 s after the note crosses the line,
        // so anchoring on chart time would burn most of the glow window
        // before the verdict even exists. Browser-path judgments are
        // recorded near chart time, so this is effectively a no-op there.
        if (judgment && !Number.isFinite(judgment._ndDisplayFrom)) {
            judgment._ndDisplayFrom = ((hw && hw.getTime) ? hw.getTime() : 0)
                + ((hw && hw.getAvOffset) ? hw.getAvOffset() / 1000 : 0);
        }
        noteResults.set(key, judgment);
        if (count) {
            if (judgment && !judgment.hit) {
                _ndLogVerifierRejectFromJudgmentIfNew(key, judgment);
            }
            _recordDiagnostic(judgment);
            // No per-judgment sync — the host getLoop() poll would land
            // on the scoring hot path. Instead we sync at enable()
            // (closes the post-enable gap) and rely on updateHUD's
            // 33 ms tick for ongoing tracking. Mid-drill bounds changes
            // lag by at most one frame, which the user can't perceive.
            if (judgment.hit) {
                hits++;
                streak++;
                if (streak > bestStreak) bestStreak = streak;
                const prevMult = multiplier;
                multiplier = _ndMultiplierForStreak(streak);
                if (multiplier > maxMultiplier) maxMultiplier = multiplier;
                const pts = (judgment.chord ? ND_BASE_CHORD : ND_BASE_SINGLE) * multiplier;
                score += pts;
                // Stash the per-note value on the judgment so noteStateFor()
                // can hand the highway renderer the score-pop amount without
                // a second lookup. Underscore-prefixed: internal annotation,
                // not part of the judgment's public shape.
                judgment._ndPoints = pts;
                judgment._ndMult = multiplier;
                if (multiplier !== prevMult) {
                    dispatchFx({ fxType: 'multiplier', mult: multiplier, prevMult, streak });
                }
                if (_ndIsStreakMilestone(streak)) {
                    dispatchFx({ fxType: 'milestone', streak, mult: multiplier });
                }
                updateSectionStat('hit');
            } else {
                const lostStreak = streak;
                misses++;
                streak = 0;
                // Only celebrate-the-loss when there was a multiplier going —
                // a miss at ×1 with a short streak isn't a "break" moment.
                if (lostStreak >= 10) {
                    dispatchFx({ fxType: 'streakBreak', lostStreak, prevMult: multiplier });
                }
                multiplier = 1;
                updateSectionStat('miss');
            }
            // Mirror to drill counters. Independent state — global
            // session score is unaffected by iteration boundaries.
            if (drillEnabled) {
                if (judgment.hit) {
                    drillIterHits++;
                    drillIterStreak++;
                    if (drillIterStreak > drillIterBestStreak) drillIterBestStreak = drillIterStreak;
                } else {
                    drillIterMisses++;
                    drillIterStreak = 0;
                }
                drillDirty = true;
            }
            // Record this counted judgment in the position-aware ledger so a
            // backward reposition can rebuild the score (see _scoreLedger /
            // _recomputeScoreToPosition). Use the chart-note time — noteTime is
            // populated on every chart-path judgment and the external/contained
            // paths pass it explicitly; chartNote.t is the fallback. A judgment
            // with no derivable time (shouldn't happen) is simply not ledgered,
            // so it can't be rolled back — better than poisoning the ledger with
            // NaN and dropping a survivor on every recompute.
            const _ledgerT = Number.isFinite(judgment && judgment.noteTime)
                ? judgment.noteTime
                : (judgment && judgment.chartNote && Number.isFinite(judgment.chartNote.t))
                    ? judgment.chartNote.t
                    : NaN;
            if (Number.isFinite(_ledgerT)) {
                _scoreLedger.set(key, { t: _ledgerT, hit: !!judgment.hit, chord: !!judgment.chord });
            }
        }
        if (emit) dispatchJudgment(judgment);
    }

    // Timing-free, chart-aware verify hook. When a consumer (e.g. Step Mode,
    // which freezes the playhead ON a note) has registered a target via
    // setVerifyTarget(), score that note set against the live audio EVERY
    // frame, regardless of the playhead, and emit notedetect:verify on a hit.
    // This is the same harmonic-comb verifier the chart path uses
    // (_ndScoreChord / scoreChord IPC) but WITHOUT the playhead-relative
    // timing gate that makes notedetect:hit unusable on a frozen playhead
    // (#468 / #630). Runs only while a target is set, so it costs nothing in
    // normal play.
    async function _runVerifyTarget(frameBuffer) {
        const target = _verifyTarget;
        if (!target || !target.length) return;
        // The target only makes sense on the chart it was registered for —
        // drop it outright if the arrangement/tuning/capo changed, so a stale
        // target can never score (or emit verify) against a different chart.
        if (_verifyTargetSig !== _ndVerifyActiveSig()) {
            _verifyTarget = null;
            _verifyTargetSig = null;
            _verifyTargetCtx = null;
            return;
        }
        // Tuning context the target is scored under: the caller's override
        // when one was registered (contained playback verifying against the
        // player's real instrument), else the host song's live state.
        const ctx = _ndVerifyActiveCtx();
        // Same arrangement-aware harmonic-comb verify window the single-note
        // path uses. Passing the user's tight pitch_tolerance_cents straight
        // into the DSP scorer rejects ~90% of correctly-played notes (a
        // spectral peak is far coarser than a ±10-cent gate), so use the
        // deliberately-generous verify window instead.
        const verifyParams = _ndVerifyParamsFor(ctx.arrangement);
        let result;
        if (usingDesktopBridge) {
            if (!_ndBridgeScoreAvailable()) return;
            const gen = sessionGen;
            try {
                result = await _ndBridgeScoreChord({
                    arrangement: ctx.arrangement,
                    stringCount: ctx.stringCount,
                    offsets: ctx.offsets.slice(0, ctx.stringCount),
                    capo: ctx.capo,
                    pitchCheckCents: verifyParams.pitchCheckCents,
                    minHitRatio: _ND_VERIFY_MIN_HIT_RATIO,
                    bypassMl: true,               // force the DSP scorer, not the ML path
                    harmonicVerify: true,         // harmonic-comb check, not band-energy/total
                    harmonicSnr: verifyParams.harmonicSnr,
                    fundamentalRatio: verifyParams.fundamentalRatio,
                    notes: target,
                });
            } catch (e) { return; }
            if (!enabled || gen !== sessionGen) return;
            // The IPC round-trip yields; if the consumer cleared/replaced the
            // target, or its tuning context changed during it, this result is
            // for a stale note — drop it so we don't fire verify for the
            // wrong step.
            if (_verifyTarget !== target || _verifyTargetSig !== _ndVerifyActiveSig()) return;
        } else {
            if (!frameBuffer) return;
            const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
            result = _ndScoreChord(
                frameBuffer, sr, target,
                ctx.arrangement, ctx.stringCount, ctx.offsets, ctx.capo,
                verifyParams.pitchCheckCents, _ND_VERIFY_MIN_HIT_RATIO
            );
        }
        if (result && result.isHit) {
            dispatchInstanceEvent('notedetect:verify', {
                isHit: true,
                score: result.score,
                hitStrings: result.hitStrings,
                totalStrings: result.totalStrings,
                notes: target.map(n => ({ s: n.s, f: n.f })),
            });
        }
    }

    async function matchNotes(frameBuffer) {
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const t = hw.getTime() + avOffsetSec - latencyOffset;
        // A/V auto-calibration tap (browser + desktop-yin/ml paths). The
        // engine-verifier path returns before matchNotes(), so it taps
        // _calLogDetection() directly — see the poll loop.
        _calLogDetection();
        // Don't bail on detectedMidi < 0 here — chord scoring uses the
        // raw audio buffer and doesn't need a confident monophonic pitch.
        // The single-note path below is gated on detectedMidi >= 0 and
        // skips itself when detection wasn't confident.

        const notes = hw.getNotes();
        const chords = hw.getChords();

        // Timing-free verify target. Run it AFTER snapshotting t / notes /
        // chords above so the awaited scoreChord IPC (bridge path) can't shift
        // the chart-scoring playhead by a frame. It's a yield point, so a
        // notedetect:verify listener may disable detection or switch songs
        // synchronously — re-validate the session before we score the chart
        // below, or we'd book stale-session judgments against the old chart.
        if (_verifyTarget) {
            const vgen = sessionGen;
            const vtarget = _verifyTarget;
            const vsig = _ndChartSignature();
            await _runVerifyTarget(frameBuffer);
            // Abort the chart-scoring below if anything a notedetect:verify
            // listener could touch synchronously changed during the dispatch:
            // the session (sessionGen), the chart (signature — a song/
            // arrangement switch doesn't bump sessionGen), or the verify
            // target itself (a listener calling setVerifyTarget). Otherwise
            // we'd score the pre-await t/notes/chords snapshot under changed
            // state and could book a stale judgment for the previous step.
            if (!enabled || vgen !== sessionGen
                || _verifyTarget !== vtarget || _ndChartSignature() !== vsig) return;
        }

        const tolerance = timingTolerance;
        const centsTolerance = pitchTolerance;

        const candidateNotes = [];

        // For sus-marked chart notes, allow late detection — the note is
        // still audibly ringing past its nominal `t + tolerance`, and
        // YIN may need ~80–100 ms of accumulated buffer to confidently
        // lock on (longer for low E). Without this, players who pluck
        // slightly late on a half- or whole-note get no judgment recorded
        // at all (pure miss) instead of a hit-while-ringing. Cap the
        // grace at MAX_SUS_LATE_GRACE so a 4-second sustain doesn't
        // accept detections seconds after the strike.
        const MAX_SUS_LATE_GRACE = 1.0;  // seconds
        if (notes && notes.length > 0) {
            // Bsearch from `t - tolerance - MAX_SUS_LATE_GRACE` so the
            // scan picks up sus-marked notes whose nominal window has
            // already closed but whose sustain envelope hasn't. The
            // per-note filter below ensures non-sus notes still age out
            // at the strict ±tolerance boundary.
            const start = bsearch(notes, t - tolerance - MAX_SUS_LATE_GRACE);
            for (let i = start; i < notes.length; i++) {
                const n = notes[i];
                if (n.t > t + tolerance) break;
                if (n.mt) continue;
                // Non-sus notes use the strict past edge; sus notes get
                // a grace bounded by both the chart's declared sustain
                // and the global cap.
                const susSec = Number.isFinite(n.sus) && n.sus > 0 ? n.sus : 0;
                const lateGrace = susSec > 0 ? Math.min(susSec, MAX_SUS_LATE_GRACE) : 0;
                if (n.t < t - tolerance - lateGrace) continue;
                // Spread the chart note so technique flags (ho/po/b/sl/hm)
                // travel with the candidate. _ndScoreChord reads these to
                // adjust per-string thresholds, so dropping them here would
                // make hammer-on/bend/harmonic adjustments dead code in
                // actual gameplay.
                candidateNotes.push({ ...n });
            }
        }
        if (chords && chords.length > 0) {
            // Chord candidate window extends past the strict upper edge
            // the same way single notes do: a chord that says "ring for
            // 1.5 s" is still audibly the right chord 800 ms after the
            // chart strike, and a player strumming late should still be
            // matched against it. The chord scorer (_ndScoreChord) does
            // its own per-string pitch + energy check on whatever audio
            // buffer is current, so an extended candidate window just
            // gives matchNotes more frames in which to attempt scoring
            // — it doesn't loosen the per-string check itself.
            //
            // Take the max sus across chord constituents so a chord with
            // mixed sustains doesn't drop out the moment its shortest
            // string would have decayed.
            const start = bsearch(chords, t - tolerance - MAX_SUS_LATE_GRACE);
            for (let i = start; i < chords.length; i++) {
                const c = chords[i];
                if (c.t > t + tolerance) break;
                let chordSus = 0;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    if (Number.isFinite(cn.sus) && cn.sus > chordSus) chordSus = cn.sus;
                }
                const lateGrace = chordSus > 0 ? Math.min(chordSus, MAX_SUS_LATE_GRACE) : 0;
                if (c.t < t - tolerance - lateGrace) continue;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    // Chord constituent notes don't carry their own time —
                    // the chord's `c.t` is the timestamp.
                    candidateNotes.push({ ...cn, t: c.t });
                }
            }
        }

        // Display fingering is only meaningful when we have a confident
        // monophonic pitch to map back to a (string, fret). With no pitch
        // (chord-heavy frames) leave the HUD's last detected position
        // alone — the per-string chord HUD takes over from there.
        if (detectedMidi >= 0) {
            const disp = _ndResolveDisplayFingering(
                detectedMidi, candidateNotes, currentArrangement,
                currentStringCount, tuningOffsets, capo, centsTolerance
            );
            detectedString = disp.string;
            detectedFret = disp.fret;
            detectedDisplayMidi = Number.isFinite(disp.displayMidi) ? disp.displayMidi : detectedMidi;
        }

        // ── Single-note path (existing YIN/HPS/CREPE result) ──────────
        // Group candidate notes by chord time so we can route chord events
        // to the constraint scorer and single notes to the MIDI comparator.
        // A chord is any group of ≥2 simultaneous candidates sharing a time.
        const byTime = new Map();
        for (const cn of candidateNotes) {
            const tk = cn.t.toFixed(3);
            if (!byTime.has(tk)) byTime.set(tk, []);
            byTime.get(tk).push(cn);
        }

        // ── Single notes: one batched DSP band-energy score per tick ──────
        // A single note is a 1-string chord. Scoring each one with its own
        // scoreChord IPC fires one round-trip per note per detect tick — on
        // a dense lead that floods the renderer event loop and visibly
        // stutters the highway. scoreChord already returns a per-note
        // results[] array, so the whole pending set is verified in ONE call
        // (one FFT). bypassMl forces the DSP spectral check over the
        // onset-driven ML path, which silently drops fast notes. The
        // open-domain detector still drives the live HUD readout.
        const _ndSingleNotes = [];   // cn objects, 1:1 with the batch results
        for (const [, group] of byTime) {
            if (group.length !== 1) continue;
            const cn = group[0];
            if (noteResults.has(noteKey(cn, cn.t))) continue;
            _ndSingleNotes.push(cn);
        }
        const _ndSingleResult = new Map();   // cn -> per-note band-energy result
        if (_ndSingleNotes.length > 0) {
            // Compute the arrangement-aware verify params once per tick — both
            // the desktop-bridge scoreChord call and the browser fallback below
            // read from this, instead of re-allocating the object per field.
            const verifyParams = _ndVerifyParamsFor(currentArrangement);
            let batch = null;
            if (usingDesktopBridge) {
                if (_ndBridgeScoreAvailable()) {
                    const ctx = {
                        arrangement: currentArrangement,
                        stringCount: currentStringCount,
                        offsets: tuningOffsets.slice(0, currentStringCount),
                        capo,
                        // Verification window, deliberately generous. This
                        // only confirms the chart note is the pitch ringing
                        // (and rejects a neighbouring fret, ~100 cents away).
                        // The strict hit/miss pitch call belongs to
                        // makeMatchedJudgment below, from the measured
                        // centsError. Passing the user's tight
                        // pitch_tolerance_cents straight into the DSP scorer
                        // made it reject ~90% of correctly-played notes — a
                        // spectral peak is far coarser than a ±10-cent gate.
                        // Bass relaxes the pitch window + fundamental-presence
                        // gate (see _ndVerifyParamsFor) — its DI fundamental is
                        // weak and its low bins resolve pitch coarsely.
                        pitchCheckCents: verifyParams.pitchCheckCents,
                        minHitRatio: chordHitRatio,   // unused — per-note results read directly
                        bypassMl: true,               // force the DSP scorer, not the ML path
                        harmonicVerify: true,         // harmonic-comb check, not band-energy/total
                        harmonicSnr: verifyParams.harmonicSnr,
                        fundamentalRatio: verifyParams.fundamentalRatio,
                        notes: _ndSingleNotes.map(cn => ({
                            s: cn.s, f: cn.f,
                            ho: !!cn.ho, po: !!cn.po,
                            b: !!cn.b, sl: !!cn.sl, hm: !!cn.hm,
                        })),
                    };
                    const gen = sessionGen;
                    try {
                        batch = await _ndBridgeScoreChord(ctx);
                    } catch (e) {
                        console.warn('[note_detect] scoreChord IPC failed:', e && e.message ? e.message : e);
                        batch = null;
                    }
                    // Re-validate after the IPC await (mirrors the chord path).
                    if (!enabled || gen !== sessionGen) return;
                }
            } else if (frameBuffer) {
                // Browser: _ndScoreChord is already a DSP band-energy check.
                const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
                batch = _ndScoreChord(
                    frameBuffer, sr,
                    _ndSingleNotes, currentArrangement, currentStringCount,
                    // Same arrangement-aware pitch window as the desktop-bridge
                    // path above, so bass gets the wider 60c gate in the browser
                    // fallback too (otherwise the fallback undercuts the bass
                    // improvement on low strings whose bins resolve coarsely).
                    tuningOffsets, capo,
                    verifyParams.pitchCheckCents,
                    chordHitRatio
                );
            }
            // results[] is aligned 1:1 with the notes[] array we sent.
            if (batch && Array.isArray(batch.results)) {
                for (let i = 0; i < _ndSingleNotes.length && i < batch.results.length; i++) {
                    _ndSingleResult.set(_ndSingleNotes[i], batch.results[i]);
                }
            }
        }

        for (const [, group] of byTime) {
            if (group.length === 1) {
                // ── Single-note path: DSP band-energy verification ──────────
                // Per-note result comes from the single batched score above —
                // a 1-string-chord spectral check at the expected fundamental,
                // not an open-domain pitch estimate or an ML onset.
                const cn = group[0];
                const key = noteKey(cn, cn.t);
                if (noteResults.has(key)) continue;

                const r = _ndSingleResult.get(cn);
                // Not verified on this frame (harmonic comb below the SNR
                // threshold, or off-pitch) — leave the note for a later
                // frame or for checkMisses() to retire.
                if (!r || !r.hit) {
                    try {
                        const expectedMidiSnap = _ndMidiFromStringFret(
                            cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                        );
                        _ndVerifyFailSnap.set(key, {
                            noteTime: cn.t,
                            string: cn.s,
                            fret: cn.f,
                            expectedMidi: expectedMidiSnap,
                            pitchErrorCents: Number.isFinite(r && r.centsError) ? r.centsError : null,
                        });
                    } catch (_) { /* read-only */ }
                    continue;
                }

                // Energy + pitch verified. Build the judgment at the current
                // playhead, but COMMIT only when the timing is clean. An
                // isHit frame can land well before the chart time when the
                // note's string is still ringing from an earlier strike;
                // committing then would lock in an EARLY miss. Defer until a
                // frame lands inside the clean window — checkMisses() retires
                // the note if none ever does.
                const pitchError = Number.isFinite(r.centsError) ? r.centsError : null;
                const expectedMidi = _ndMidiFromStringFret(
                    cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );
                const detectedMidiForJudgment = Number.isFinite(pitchError)
                    ? expectedMidi + pitchError / 100
                    : null;
                const judgment = makeMatchedJudgment(
                    cn, cn.t, t, expectedMidi, detectedMidiForJudgment, detectedConfidence,
                    { pitchError }
                );
                if (judgment.hit) {
                    recordJudgment(key, judgment);
                } else {
                    const teReason = judgment.timingState === 'EARLY' || judgment.timingState === 'LATE'
                        ? 'TIMING_FAIL'
                        : (judgment.pitchState === 'SHARP' || judgment.pitchState === 'FLAT'
                            ? 'PITCH_FAIL'
                            : 'UNKNOWN');
                    _ndLogVerifierRejectOnce(key, {
                        reason: teReason,
                        noteTime: cn.t,
                        string: cn.s,
                        fret: cn.f,
                        expectedMidi,
                        detectedMidi: detectedMidiForJudgment,
                        confidence: detectedConfidence,
                        timingErrorMs: judgment.timingError,
                        pitchErrorCents: judgment.pitchError,
                    });
                }
            } else {
                // ── Chord path: constraint-based per-string band analysis ──
                // Chord-level resolved key. checkMisses() honours this so a
                // failed chord becomes one miss event (not one per string).
                const chordKey = `${group[0].t.toFixed(3)}_chord`;
                if (noteResults.has(chordKey)) continue;

                // Two paths:
                //  - Browser: call _ndScoreChord against the FFT
                //    frame the ScriptProcessor just delivered.
                //  - Desktop bridge: dispatch audio:scoreChord IPC —
                //    the native ChordScorer reads from the engine's
                //    own input ring, so no audio buffer crosses IPC.
                //    Older slopsmith-desktop builds without the IPC
                //    skip the chord-scoring step entirely (same as
                //    the previous frameless guard).
                let chordResult;
                if (usingDesktopBridge) {
                    // Dispatch the scoreChord IPC. The native scorer is
                    // ML-backed when a model is loaded (judging each chart
                    // note against the ML detector's active pitch set), else
                    // the constraint scorer — and it times chords correctly,
                    // which a renderer-side detectNotes scorer did not.
                    if (!_ndBridgeScoreAvailable()) {
                        continue;
                    }
                    const ctx = {
                        arrangement: currentArrangement,
                        stringCount: currentStringCount,
                        offsets: tuningOffsets.slice(0, currentStringCount),
                        capo,
                        pitchCheckCents: centsTolerance,
                        minHitRatio: chordHitRatio,
                        notes: group.map(cn => ({
                            s: cn.s, f: cn.f,
                            ho: !!cn.ho, po: !!cn.po,
                            b: !!cn.b, sl: !!cn.sl, hm: !!cn.hm,
                        })),
                    };
                    const gen = sessionGen;
                    try {
                        chordResult = await _ndBridgeScoreChord(ctx);
                    } catch (e) {
                        console.warn('[note_detect] scoreChord IPC failed:', e && e.message ? e.message : e);
                        continue;
                    }
                    if (!chordResult) continue; // downlevel addon returned null
                    // Re-validate after the await. The IPC round-trip
                    // yields the event loop, so checkMisses() can fire
                    // on its own interval and record a miss for this
                    // chordKey while we're waiting on the scorer.
                    // (checkMisses always books the <t>_chord key
                    // first and short-circuits per-string for chord
                    // groups, so only the chord-level key needs
                    // checking here.) Without this guard a late-
                    // arriving hit would double-count against a miss
                    // already booked for the same chord timing.
                    // Bail out of the whole matchNotes() pass — not
                    // just this group — when the instance was disabled
                    // or session-bumped mid-await (settings change /
                    // device restart), so we don't fire more
                    // scoreChord IPCs for subsequent groups against
                    // an invalid session. Per-chord doublebook just
                    // skips this group; later groups are still valid.
                    if (!enabled || gen !== sessionGen) return;
                    if (noteResults.has(chordKey)) continue;
                } else if (!usingDesktopBridge) {
                    // Browser path needs the just-analysed buffer.
                    // Skip if no audio buffer was passed in (e.g.
                    // instance restart while a stale processFrame is
                    // unwinding).
                    if (!frameBuffer) continue;
                    const sr = audioCtx ? audioCtx.sampleRate : bridgeSampleRate;
                    chordResult = _ndScoreChord(
                        frameBuffer, sr,
                        group, currentArrangement, currentStringCount,
                        tuningOffsets, capo,
                        centsTolerance,   // pitch check per string
                        chordHitRatio     // min fraction of strings required
                    );
                }

                // Update HUD chord display (latest reading, hit-or-miss)
                lastChordScore = chordResult.score;
                lastChordHit = chordResult.hitStrings;
                lastChordTotal = chordResult.totalStrings;
                lastChordTime = group[0].t;

                const lead = group[0];
                const expectedMidi = _ndMidiFromStringFret(
                    lead.s, lead.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );
                // Chord-level late-grace must come from the MAX sus
                // across constituents — not just `lead.sus` — so that
                // _ndMakeJudgment's timing classification matches the
                // candidate-inclusion and retire-extension grace logic
                // in matchNotes/checkMisses. Capped at MAX_SUS_LATE_GRACE
                // (mirrors matchNotes; see the constant below).
                let chordSusForGrace = 0;
                for (const cn of group) {
                    if (Number.isFinite(cn.sus) && cn.sus > chordSusForGrace) chordSusForGrace = cn.sus;
                }
                const chordLateGraceMs = chordSusForGrace > 0
                    ? Math.min(chordSusForGrace * 1000, 1000)
                    : 0;
                // Derive pitch error from the first string that actually has a
                // finite centsError measurement. Fall back to the monophonic
                // detector if available; leave null if no pitch data exists
                // (e.g. energy-only checks or lead string failed the pitch check).
                const firstFiniteCentsError = chordResult.results
                    ?.find(r => Number.isFinite(r?.centsError))?.centsError;
                const chordPitchError = firstFiniteCentsError !== undefined
                    ? firstFiniteCentsError
                    : (detectedMidi >= 0 ? _ndFoldOctaveCents((detectedMidi - expectedMidi) * 100) : null);
                const chordDetectedMidi = detectedMidi >= 0
                    ? detectedMidi
                    : (Number.isFinite(chordPitchError)
                        ? expectedMidi + chordPitchError / 100
                        : null);
                // Onset gate (desktop ML bridge): a chord only commits a hit
                // on a poll where one of its pitches was actually struck — a
                // fresh onset in bridgeNewOnsets. Otherwise the chord's
                // pitches ringing on through the surrounding riff drag the
                // match progressively earlier. chordFreshOnsetAge is the
                // freshest such onset (ms), used to back-date the judgment.
                let chordFreshOnsetAge = null;
                if (bridgeOnsetPrimed && bridgeNewOnsets.size > 0) {
                    for (const cn of group) {
                        const m = _ndMidiFromStringFret(
                            cn.s, cn.f, currentArrangement, currentStringCount,
                            tuningOffsets, capo
                        );
                        const o = bridgeNewOnsets.get(m);
                        if (o && (chordFreshOnsetAge === null || o.ageMs < chordFreshOnsetAge)) {
                            chordFreshOnsetAge = o.ageMs;
                        }
                    }
                }
                const tChord = (chordFreshOnsetAge != null)
                    ? hw.getTime() + avOffsetSec - (chordFreshOnsetAge / 1000)
                    : t;

                const chordJudgment = makeMatchedJudgment(
                    lead, lead.t, tChord, expectedMidi,
                    chordDetectedMidi,
                    detectedConfidence,
                    {
                        notes: group.map(cn => ({ s: cn.s, f: cn.f })),
                        chord: true,
                        hitStrings: chordResult.hitStrings,
                        totalStrings: chordResult.totalStrings,
                        score: chordResult.score,
                        pitchError: chordPitchError,
                        monophonicDetected: detectedMidi >= 0,
                        lateGraceMs: chordLateGraceMs,
                    }
                );

                // Commit a chord hit only when it scored AND (on the ML
                // bridge) a chord pitch was freshly struck this poll. An
                // isHit frame with no fresh onset is just the chord's pitches
                // still ringing — cache its diagnostics and wait for the
                // strum poll (or checkMisses' voicing rescue).
                if (!chordResult.isHit
                    || (bridgeOnsetPrimed && chordFreshOnsetAge == null)) {
                    // Stash the chordResult before bailing so that when
                    // checkMisses() retires this chord as a miss, the
                    // miss judgment can carry the scorer's per-string
                    // diagnostic data (hitStrings / totalStrings / score).
                    // Without this we were blind on missed chords — the
                    // live JSONL + diagnostic event log just showed
                    // hs/tt/sc=undefined, which made "the scorer saw 2 of
                    // 5 strings — was that just the user's playing, or is
                    // the energy threshold too strict?" impossible to
                    // answer from data alone. The map is keyed by chord
                    // key and the snapshot lands the BEST-SCORE frame
                    // seen during the chord's match window (see the
                    // `useNewSnapshot` predicate below) — gives the
                    // reader "best the scorer got at any point in the
                    // window" rather than an arbitrary final frame which
                    // may be tail-end decay.
                    // Cache for checkMisses to consume on retire.
                    //
                    // Two pieces tracked separately:
                    //
                    //   • voicingHit — STICKY. Once ANY frame in this
                    //     chord's window registered as voicing-eligible
                    //     (≥2 chord strings rang at their expected
                    //     pitches), remember it forever for this chord.
                    //     A subsequent frame where some of those strings
                    //     momentarily failed pitch (decay below threshold
                    //     while the rest still rang, audio bleed shifted
                    //     things, etc.) MUST NOT retroactively cancel a
                    //     previously-eligible voicing. Earlier logic
                    //     here had a "higher score wins" rule that
                    //     accidentally demoted voicingHit:true frames
                    //     when a later !voicingHit but slightly higher
                    //     score frame arrived — which on real-song
                    //     data wiped out the rescue path entirely.
                    //
                    //   • score / hitStrings / totalStrings — best
                    //     frame's diagnostic snapshot, regardless of
                    //     voicingHit. Used by the live JSONL and the
                    //     event log so a reader can see "best the
                    //     scorer got" on this chord.
                    const prev = _chordLastResult.get(chordKey);
                    const voicingEver = !!((prev && prev.voicingHit) || chordResult.voicingHit);
                    const useNewSnapshot = !prev || chordResult.score > (prev.score || 0);
                    // Capture the frame time of the FIRST voicing-eligible
                    // frame for this chord. checkMisses uses this as the
                    // judgment's `judgedAt` so the resulting timingError
                    // reflects when voicing was actually satisfied — not
                    // the retire-tick time (which is by definition past
                    // the chord's match window and would classify the
                    // rescued judgment as LATE, defeating the rescue).
                    const voicingT = (prev && prev.voicingT)
                        ? prev.voicingT
                        : (chordResult.voicingHit ? t : null);
                    _chordLastResult.set(chordKey, {
                        score:        useNewSnapshot ? chordResult.score        : prev.score,
                        hitStrings:   useNewSnapshot ? chordResult.hitStrings   : prev.hitStrings,
                        totalStrings: useNewSnapshot ? chordResult.totalStrings : prev.totalStrings,
                        voicingHit:   voicingEver,
                        voicingT,
                    });
                    // Do not lock in a miss while the chord is still within
                    // its timing window. Chords can enter candidateNotes as
                    // early as (chordTime - timingTolerance), so an early
                    // non-hit frame may still be followed by a valid strum on
                    // a later frame. Let checkMisses() finalize the miss only
                    // after the window has fully elapsed.
                    continue;
                }

                // Chord cleared. Mark the chord-level key 'hit' so the
                // miss aggregator in checkMisses() treats it as a single
                // resolved unit and skips per-string miss accounting.
                // Per-string keys still record each string's actual
                // outcome from `chordResult.results` so the draw overlay
                // can colour gems individually (green / red per fret) on
                // lenient chord hits where some strings rang and some
                // didn't.
                recordJudgment(chordKey, chordJudgment, { count: true, emit: true });
                // Hit path doesn't need any cached miss-diagnostic for
                // this chord — drop the entry so the map only holds
                // truly-pending chords. Without this, the cache could
                // grow over a session as chords flicker through the
                // "scored low, then scored above threshold" pattern.
                _chordLastResult.delete(chordKey);
                // Build an (s,f)-keyed lookup so we don't rely on
                // `chordResult.results[i]` being positionally aligned
                // with `group[i]`. The browser `_ndScoreChord`
                // preserves that ordering by construction, and the
                // native ChordScorer does too — but treating the
                // result as a positional-only array makes
                // per-string gem colouring silently wrong if any
                // future IPC implementation reorders entries. The
                // lookup is O(N) per chord (N ≤ 8), so the
                // defensiveness is essentially free.
                const stringResByKey = new Map();
                if (Array.isArray(chordResult.results)) {
                    for (const r of chordResult.results) {
                        if (r && typeof r.s === 'number' && typeof r.f === 'number') {
                            stringResByKey.set(`${r.s}_${r.f}`, r);
                        }
                    }
                }
                for (let i = 0; i < group.length; i++) {
                    const cn = group[i];
                    const key = noteKey(cn, cn.t);
                    if (noteResults.has(key)) continue;
                    if (!chordJudgment.hit) {
                        // Chord passed energy/ratio threshold but missed the clean-hit
                        // threshold. Use makeMissJudgment so each per-string entry is
                        // internally consistent (no post-mutation of hit after _ndMakeJudgment
                        // has already computed it from timingState/pitchState).
                        const stringExpectedMidi = _ndMidiFromStringFret(
                            cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                        );
                        // Per-string constituent stays as a single-note
                        // judgment (no chord:true flag): _ndMakeJudgment
                        // treats `chord: true` as timing-only for the
                        // hit calc, which would flip per-string SHARP /
                        // FLAT pitch misses into spurious hits. The
                        // chord-level judgment (which owns the wider
                        // timing window) is already recorded separately
                        // above — this entry only feeds per-string
                        // diagnostics, where pitch correctness matters.
                        const stringMiss = makeMissJudgment(cn, cn.t, t, stringExpectedMidi);
                        noteResults.set(key, stringMiss);
                        _recordPerStringForChord(stringMiss);
                        continue;
                    }
                    const stringRes = stringResByKey.get(`${cn.s}_${cn.f}`);
                    const stringHit = stringRes && stringRes.hit;
                    const stringExpectedMidi = _ndMidiFromStringFret(
                        cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                    );
                    const stringJudgment = stringHit
                        ? makeMatchedJudgment(
                            cn, cn.t, t, stringExpectedMidi,
                            Number.isFinite(stringRes?.centsError)
                                ? stringExpectedMidi + stringRes.centsError / 100
                                : null,
                            detectedConfidence,
                            { pitchError: Number.isFinite(stringRes?.centsError) ? stringRes.centsError : null }
                        )
                        : makeMissJudgment(cn, cn.t, t, stringExpectedMidi);
                    noteResults.set(key, stringJudgment);
                    _recordPerStringForChord(stringJudgment);
                }
            }
        }
    }

    function checkMisses() {
        if (!enabled) return;
        // On the engine-verifier path the engine finalizes misses itself
        // (detected:false verdicts, drained by _ndDrainEngineVerdicts), so
        // this renderer-side retire scan is superseded. The browser path —
        // and any desktop session on a downlevel addon — still relies on it.
        if (_ndUsingEngineVerifier) return;
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const t = hw.getTime() + avOffsetSec - latencyOffset;
        const tolerance = timingTolerance;
        const missDeadline = t - tolerance * 2;
        // Mirror matchNotes' sus-late-grace policy. Without this, a sus
        // note whose match window matchNotes is willing to extend gets
        // retired here as a miss before that extended window has even
        // closed — matchNotes never gets a chance to record the late
        // hit. Cap matches matchNotes (kept loosely in sync via the
        // same constant pattern so both paths shift together).
        const MAX_SUS_LATE_GRACE = 1.0;
        const notes = hw.getNotes();
        const chords = hw.getChords();

        // Pass the full chart-note object (not just {s, f}) so the miss
        // judgment carries `sus` and technique flags through to the
        // diagnostic event log. Stripping to {s, f} here made every pure
        // miss look like a staccato note (sus=0) regardless of whether
        // the chart said it was sustained, which corrupts any
        // sus-conditioned analysis downstream.
        const checkNote = (chartNote, noteTime) => {
            const susSec = Number.isFinite(chartNote.sus) && chartNote.sus > 0 ? chartNote.sus : 0;
            const lateGrace = susSec > 0 ? Math.min(susSec, MAX_SUS_LATE_GRACE) : 0;
            // Effective retire threshold: a sus note isn't retired
            // until its sustain envelope has clearly elapsed, giving
            // matchNotes the same grace period to lock on.
            if (noteTime > missDeadline - lateGrace) return;
            const key = noteKey(chartNote, noteTime);
            if (!noteResults.has(key)) {
                const expectedMidi = _ndMidiFromStringFret(
                    chartNote.s, chartNote.f, currentArrangement, currentStringCount, tuningOffsets, capo
                );
                const snap = _ndVerifyFailSnap.get(key);
                _ndLogVerifierRejectOnce(key, {
                    reason: snap ? 'STRING_VERIFY_FAIL' : 'RETIRE_NO_MATCH',
                    noteTime,
                    string: chartNote.s,
                    fret: chartNote.f,
                    expectedMidi,
                    pitchErrorCents: snap && Number.isFinite(snap.pitchErrorCents)
                        ? snap.pitchErrorCents
                        : null,
                });
                _ndVerifyFailSnap.delete(key);
                recordJudgment(
                    key,
                    makeMissJudgment(chartNote, noteTime, t, expectedMidi)
                );
            }
        };

        // Look back far enough that sus-marked notes whose grace just
        // expired are still visited by this scan. Without this, the
        // bsearch start moves forward each tick and overruns notes that
        // were intentionally held past their normal retire window — they
        // never get retired at all. The `+ 1` is the existing lookback
        // slack; `MAX_SUS_LATE_GRACE` is the per-note extension we added.
        const scanStartT = missDeadline - 1 - MAX_SUS_LATE_GRACE;
        if (notes && notes.length > 0) {
            const start = bsearch(notes, scanStartT);
            for (let i = start; i < notes.length; i++) {
                const n = notes[i];
                if (n.t > missDeadline) break;
                if (n.mt) continue;
                checkNote(n, n.t);
            }
        }
        if (chords && chords.length > 0) {
            const start = bsearch(chords, scanStartT);
            for (let i = start; i < chords.length; i++) {
                const c = chords[i];
                if (c.t > missDeadline) break;
                const liveNotes = (c.notes || []).filter(cn => !cn.mt);
                if (liveNotes.length === 0) continue;
                if (liveNotes.length === 1) {
                    // Degenerate "chord" of one — treat as a single note.
                    checkNote(liveNotes[0], c.t);
                    continue;
                }
                // Mirror the matchNotes-side chord candidate grace: a
                // chord with sus-marked constituents isn't retired until
                // its sustain envelope has clearly elapsed, so a late
                // strummer gets the same window to score that a single-
                // note late-detect-gets-credited late-player gets. Take
                // the max sus across constituents.
                let chordSus = 0;
                for (const cn of liveNotes) {
                    if (Number.isFinite(cn.sus) && cn.sus > chordSus) chordSus = cn.sus;
                }
                const chordLateGrace = chordSus > 0 ? Math.min(chordSus, MAX_SUS_LATE_GRACE) : 0;
                // Mirror the seconds-vs-milliseconds split: _ndMakeJudgment
                // wants late-grace in ms, but the retire-window comparisons
                // above use seconds.
                const chordLateGraceMs = chordLateGrace * 1000;
                if (c.t > missDeadline - chordLateGrace) continue;
                // Multi-note chord: judge as a single unit. matchNotes()
                // stores a judgment object at `<t>_chord` when the chord
                // cleared the ratio threshold; if that key is present, the
                // chord is already resolved and we leave the per-string keys alone.
                const chordKey = `${c.t.toFixed(3)}_chord`;
                if (noteResults.has(chordKey)) continue;
                const expectedMidi = _ndMidiFromStringFret(
                    liveNotes[0].s, liveNotes[0].f,
                    currentArrangement, currentStringCount, tuningOffsets, capo
                );
                // Pull the latest chord-scorer result (if any) so the
                // miss judgment carries hs/tt/sc. matchNotes stashes
                // this on every non-hit frame; the most recent stash
                // is "what the scorer last saw on this chord". If the
                // chord scorer never fired in window (no audio buffer,
                // monophonic detection failure path, etc.) the cache
                // is empty and we fall back to undefined-as-before.
                const cachedChord = _chordLastResult.get(chordKey);
                // Voicing-reduction rescue: if matchNotes never found a
                // strict-ratio frame but the chord was voicing-eligible
                // at some point (≥2 chord strings rang at their expected
                // pitches), record this retire as a HIT instead of a miss.
                // This is the "punk-rock power-chord interpretation of a
                // full-chord chart" path — see _ndScoreChord for the
                // detailed rationale and the trade-off vs eager-commit
                // in matchNotes (which we explicitly avoid to keep
                // strict-ratio frames' timing winning when they exist).
                const voicingRescue = !!(cachedChord && cachedChord.voicingHit);
                // Pass the cached voicing-eligible frame time as the
                // judgment's `judgedAt`, not the current retire-tick
                // time. The retire tick fires AFTER the chord window
                // has closed by 2 × timingTolerance + lateGrace, so
                // using `t` here would produce a timingError of
                // hundreds of milliseconds, the timingState would be
                // LATE, and the chord-branch hit calc
                // (`matched && timingState === 'OK'`) would flip the
                // rescue back to a miss — defeating the entire path.
                // The cached voicingT is the actual moment voicing
                // was first satisfied, which is by definition inside
                // the chord's match window.
                const judgedAtForRescue = (voicingRescue && Number.isFinite(cachedChord.voicingT))
                    ? cachedChord.voicingT
                    : t;
                const chordJudgment = voicingRescue
                    ? makeMatchedJudgment(
                        liveNotes[0], c.t, judgedAtForRescue, expectedMidi,
                        null,    // no monophonic detection at retire time
                        0,       // no pitch confidence to claim
                        {
                            chord: true,
                            notes: liveNotes.map(cn => ({ s: cn.s, f: cn.f })),
                            hitStrings:   cachedChord.hitStrings,
                            totalStrings: cachedChord.totalStrings,
                            score:        cachedChord.score,
                            // No pitch error to report — voicing-reduction is
                            // an aggregate per-string verdict, not a monophonic
                            // pitch measurement. The pitchState ends up null,
                            // and _ndMakeJudgment's chord-branch hit calc
                            // (`matched && timingState === 'OK'`) lets it
                            // through.
                            pitchError: null,
                            lateGraceMs: chordLateGraceMs,
                        },
                    )
                    : makeMissJudgment(liveNotes[0], c.t, t, expectedMidi, {
                        notes: liveNotes.map(cn => ({ s: cn.s, f: cn.f })),
                        chord: true,
                        hitStrings:   cachedChord ? cachedChord.hitStrings   : undefined,
                        totalStrings: cachedChord ? cachedChord.totalStrings : undefined,
                        score:        cachedChord ? cachedChord.score        : undefined,
                        lateGraceMs: chordLateGraceMs,
                    });
                if (!voicingRescue) {
                    _ndLogVerifierRejectOnce(chordKey, {
                        reason: cachedChord ? 'CHORD_RATIO_FAIL' : 'RETIRE_NO_MATCH',
                        noteTime: c.t,
                        chord: true,
                        expectedMidi,
                        hitStrings: cachedChord ? cachedChord.hitStrings : null,
                        totalStrings: cachedChord ? cachedChord.totalStrings : null,
                        chordScore: cachedChord ? cachedChord.score : null,
                    });
                }
                recordJudgment(chordKey, chordJudgment);
                // Free the cache entry — we've consumed it, no further
                // matchNotes frames will fire for this chord (it just
                // got finalized as a miss or voicing-rescue hit).
                _chordLastResult.delete(chordKey);
                for (const cn of liveNotes) {
                    const key = noteKey({ s: cn.s, f: cn.f }, c.t);
                    if (noteResults.has(key)) continue;
                    const stringMiss = makeMissJudgment(cn, c.t, t, _ndMidiFromStringFret(
                        cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                    ));
                    noteResults.set(key, stringMiss);
                    // Bin per-string only when the chord retired as a
                    // miss. On voicing-rescue (chord-level hit) no
                    // per-string outcomes were measured — we'd be
                    // forcing miss-by-default fallbacks into the
                    // per-string panel and overstating misses on
                    // strings that may have rung fine.
                    if (!voicingRescue) _recordPerStringForChord(stringMiss);
                }
            }
        }

        const sections = hw.getSections ? hw.getSections() : null;
        if (sections) {
            let current = null;
            for (const sec of sections) {
                if (sec.time <= t) current = sec.name;
                else break;
            }
            if (current && current !== currentSection) {
                currentSection = current;
                if (!sectionStats.find(s => s.name === current)) {
                    sectionStats.push({ name: current, hits: 0, misses: 0 });
                }
            }
        }
    }

    function updateSectionStat(type) {
        if (!currentSection) return;
        let sec = sectionStats.find(s => s.name === currentSection);
        if (!sec) {
            sec = { name: currentSection, hits: 0, misses: 0 };
            sectionStats.push(sec);
        }
        if (type === 'hit') sec.hits++;
        else sec.misses++;
    }

    // ── Verifier reject diagnostics (read-only) ───────────────────────
    function _ndVerifierPathLabel() {
        if (_ndUsingEngineVerifier) return 'desktop-engine-verifier';
        if (_diagDetector && _diagDetector.path) return String(_diagDetector.path);
        if (usingDesktopBridge) return 'desktop-yin';
        return 'web-' + (detectionMethod || 'yin');
    }

    // Level telemetry around a chart note's strike (visual clock ±200 ms).
    function _ndStrikeLevelContext(noteTimeAudio) {
        const levelAtLogPct = Math.round((inputLevel || 0) * 100);
        if (!Number.isFinite(noteTimeAudio)) {
            return {
                levelAtLogPct,
                strikePeakPct: Math.round((inputPeak || 0) * 100),
                strikeSamplesInWindow: null,
                silenceWouldTrigger: false,
            };
        }
        const cnCenterVisualT = noteTimeAudio + latencyOffset;
        let peakL = 0;
        let inWindow = 0;
        for (let i = _ndLevelSamples.length - 1; i >= 0; i--) {
            const s = _ndLevelSamples[i];
            if (!s || !Number.isFinite(s.songT)) continue;
            if (s.songT > cnCenterVisualT + _ND_LEVEL_WIN_HALF) continue;
            if (s.songT < cnCenterVisualT - _ND_LEVEL_WIN_HALF) break;
            inWindow++;
            if (s.level > peakL) peakL = s.level;
        }
        return {
            levelAtLogPct,
            strikePeakPct: inWindow > 0 ? Math.round(peakL * 100) : null,
            strikeSamplesInWindow: inWindow,
            silenceWouldTrigger: inWindow > 0 && peakL < _ND_SILENCE_THRESHOLD,
        };
    }

    function _ndSnapshotEngineVerdict(v) {
        if (!v || typeof v !== 'object') return null;
        try {
            const snap = {};
            for (const k of Object.keys(v)) {
                const val = v[k];
                if (val === undefined || typeof val === 'function') continue;
                if (typeof val === 'number' && Number.isFinite(val)) snap[k] = val;
                else if (typeof val === 'boolean') snap[k] = val;
                else if (typeof val === 'string') snap[k] = val;
            }
            return Object.keys(snap).length ? snap : null;
        } catch (_) {
            return null;
        }
    }

    function _ndOpenDomainPitchFields() {
        let detected = null;
        let conf = null;
        try {
            if (detectedMidi >= 0 && detectedConfidence > detectionConfidenceMin) {
                detected = Number.isFinite(detectedDisplayMidi) ? detectedDisplayMidi : detectedMidi;
                conf = detectedConfidence;
            }
        } catch (_) { /* read-only */ }
        return { detectedMidi: detected, confidence: conf };
    }

    function _ndPushVerifierReject(entry) {
        try {
            const row = entry && typeof entry === 'object' ? entry : {};
            _ndVerifierRejects.push(row);
            while (_ndVerifierRejects.length > _ND_VERIFIER_REJECT_MAX) {
                _ndVerifierRejects.shift();
            }
        } catch (_) { /* never throw */ }
    }

    function _ndLogVerifierRejectOnce(dedupKey, partial) {
        try {
            if (!partial || typeof partial !== 'object') return;
            if (dedupKey && _ndRejectDedup.has(dedupKey)) return;
            const strikeCtx = Number.isFinite(partial.noteTime)
                ? _ndStrikeLevelContext(partial.noteTime)
                : _ndStrikeLevelContext(null);
            const levels = {
                levelPct: strikeCtx.levelAtLogPct,
                peakPct: strikeCtx.strikePeakPct,
            };
            const skipOpenPitch = !!partial.skipOpenDomainPitchFallback
                || partial.reason === 'NO_VERDICT'
                || partial.reason === 'SILENCE_GATE';
            const open = skipOpenPitch ? { detectedMidi: null, confidence: null } : _ndOpenDomainPitchFields();
            const row = {
                at: Date.now(),
                path: partial.path || _ndVerifierPathLabel(),
                reason: partial.reason || 'UNKNOWN',
                noteTime: Number.isFinite(partial.noteTime) ? partial.noteTime : null,
                string: Number.isInteger(partial.string) ? partial.string : null,
                fret: Number.isInteger(partial.fret) ? partial.fret : null,
                chord: !!partial.chord,
                expectedMidi: Number.isFinite(partial.expectedMidi) ? partial.expectedMidi : null,
                detectedMidi: Number.isFinite(partial.detectedMidi)
                    ? partial.detectedMidi
                    : open.detectedMidi,
                confidence: Number.isFinite(partial.confidence)
                    ? partial.confidence
                    : open.confidence,
                hitStrings: Number.isFinite(partial.hitStrings) ? partial.hitStrings : null,
                totalStrings: Number.isFinite(partial.totalStrings) ? partial.totalStrings : null,
                chordScore: Number.isFinite(partial.chordScore) ? partial.chordScore : null,
                timingErrorMs: Number.isFinite(partial.timingErrorMs) ? partial.timingErrorMs : null,
                pitchErrorCents: Number.isFinite(partial.pitchErrorCents) ? partial.pitchErrorCents : null,
                inputLevelPct: Number.isFinite(partial.inputLevelPct)
                    ? partial.inputLevelPct
                    : levels.levelPct,
                inputPeakPct: Number.isFinite(partial.inputPeakPct)
                    ? partial.inputPeakPct
                    : levels.peakPct,
                // Enriched engine-verifier context (read-only telemetry).
                verifierId: typeof partial.verifierId === 'string' ? partial.verifierId : null,
                playheadAudio: Number.isFinite(partial.playheadAudio) ? partial.playheadAudio : null,
                engineDetected: typeof partial.engineDetected === 'boolean' ? partial.engineDetected : null,
                engineDetectedRaw: typeof partial.engineDetectedRaw === 'boolean'
                    ? partial.engineDetectedRaw
                    : null,
                detectedSongTime: Number.isFinite(partial.detectedSongTime)
                    ? partial.detectedSongTime
                    : null,
                silenceGateApplied: !!partial.silenceGateApplied,
                strikePeakPct: Number.isFinite(partial.strikePeakPct)
                    ? partial.strikePeakPct
                    : levels.peakPct,
                strikeSamplesInWindow: Number.isFinite(partial.strikeSamplesInWindow)
                    ? partial.strikeSamplesInWindow
                    : strikeCtx.strikeSamplesInWindow,
                inputLevelAtLogPct: Number.isFinite(partial.inputLevelAtLogPct)
                    ? partial.inputLevelAtLogPct
                    : levels.levelPct,
                rendererPitchPolled: partial.rendererPitchPolled !== undefined
                    ? !!partial.rendererPitchPolled
                    : !_ndUsingEngineVerifier,
                engineVerdict: partial.engineVerdict && typeof partial.engineVerdict === 'object'
                    ? { ...partial.engineVerdict }
                    : null,
            };
            _ndPushVerifierReject(row);
            if (dedupKey) _ndRejectDedup.add(dedupKey);
        } catch (_) { /* never throw */ }
    }

    function _ndRejectReasonFromJudgment(judgment) {
        if (!judgment) return 'UNKNOWN';
        if (judgment.chord) return 'CHORD_RATIO_FAIL';
        if (judgment.timingState === 'EARLY' || judgment.timingState === 'LATE') return 'TIMING_FAIL';
        if (judgment.pitchState === 'SHARP' || judgment.pitchState === 'FLAT') return 'PITCH_FAIL';
        if (judgment.detectedMidi == null) return 'RETIRE_NO_MATCH';
        return 'UNKNOWN';
    }

    function _ndLogVerifierRejectFromJudgmentIfNew(key, judgment) {
        try {
            if (!key || _ndRejectDedup.has(key)) return;
            const cn = judgment.chartNote || judgment.note || {};
            _ndLogVerifierRejectOnce(key, {
                reason: _ndRejectReasonFromJudgment(judgment),
                noteTime: Number.isFinite(judgment.noteTime) ? judgment.noteTime : null,
                string: Number.isInteger(cn.s) ? cn.s : null,
                fret: Number.isInteger(cn.f) ? cn.f : null,
                chord: !!judgment.chord,
                expectedMidi: Number.isFinite(judgment.expectedMidi) ? judgment.expectedMidi : null,
                detectedMidi: Number.isFinite(judgment.detectedMidi) ? judgment.detectedMidi : null,
                confidence: Number.isFinite(judgment.confidence) ? judgment.confidence : null,
                hitStrings: Number.isFinite(judgment.hitStrings) ? judgment.hitStrings : null,
                totalStrings: Number.isFinite(judgment.totalStrings) ? judgment.totalStrings : null,
                chordScore: Number.isFinite(judgment.score) ? judgment.score : null,
                timingErrorMs: Number.isFinite(judgment.timingError) ? judgment.timingError : null,
                pitchErrorCents: Number.isFinite(judgment.pitchError) ? judgment.pitchError : null,
            });
        } catch (_) { /* never throw */ }
    }

    function getVerifierRejects() {
        try {
            return _ndVerifierRejects.map((e) => ({ ...e }));
        } catch (_) {
            return [];
        }
    }

    // ── Detection Health (read-only gear popover) ─────────────────────
    function _ndFormatMs(n) {
        if (n == null || !Number.isFinite(n)) return '—';
        const r = Math.round(n);
        return (r >= 0 ? '+' + r : String(r)) + ' ms';
    }

    function _ndFormatPercent(ratio) {
        if (ratio == null || !Number.isFinite(ratio)) return '—';
        return Math.round(ratio * 100) + '%';
    }

    // ── Musician-facing display helpers (copy only — no detection changes) ──
    function _ndMusicianRejectHint(reason) {
        const hints = {
            NO_VERDICT: 'No detection at note time',
            SILENCE_GATE: 'Input too quiet when the note struck',
            STRING_VERIFY_FAIL: 'Something was heard but did not verify',
            CHORD_RATIO_FAIL: 'Not enough strings heard for the chord',
            TIMING_FAIL: 'Played outside the timing window',
            PITCH_FAIL: 'Pitch was outside the allowed window',
            RETIRE_NO_MATCH: 'No match before the note ended',
            UNKNOWN: 'Could not verify this note',
        };
        return hints[reason] || hints.UNKNOWN;
    }

    function _ndFormatMusicianRejectLine(r) {
        if (!r || typeof r !== 'object') return '—';
        const parts = [_ndMusicianRejectHint(r.reason)];
        if (Number.isFinite(r.hitStrings) && Number.isFinite(r.totalStrings)) {
            parts.push(`${r.hitStrings} of ${r.totalStrings} strings heard`);
        } else if (Number.isInteger(r.string) && Number.isInteger(r.fret)) {
            parts.push(`string ${r.string + 1}, fret ${r.fret}`);
        }
        const strikePeak = Number.isFinite(r.strikePeakPct)
            ? r.strikePeakPct
            : (Number.isFinite(r.inputPeakPct) ? r.inputPeakPct : null);
        if (Number.isFinite(strikePeak)) {
            parts.push(`signal at strike ${strikePeak}%`);
        }
        if (Number.isFinite(r.timingErrorMs)) {
            const te = Math.round(r.timingErrorMs);
            parts.push(te >= 0 ? `${te} ms late` : `${Math.abs(te)} ms early`);
        }
        return parts.join(' · ');
    }

    function _ndHealthHearingForPanel() {
        const line = _ndHealthDetectedLine();
        if (line !== '—') return line;
        if (!enabled) {
            return 'Nothing yet — turn Detect on, then play a note or chord';
        }
        return 'Nothing yet — play a note or chord (stays blank when input is quiet)';
    }

    function _calWizardNoiseStatusDisplay(status) {
        if (status === 'good') return 'Good — quiet room (under 5%)';
        if (status === 'elevated') return 'Elevated — some background noise (5–15%)';
        if (status === 'too_noisy') return 'Too noisy — over 15%; lower gain or quiet the room';
        return status || '—';
    }

    function _calWizardSignalStatusDisplay(status) {
        if (status === 'good') return 'Good — strong enough for detection';
        if (status === 'too_low') return 'Too low — play louder or raise input gain';
        if (status === 'too_hot') return 'Too hot — risk of clipping; lower input gain';
        return status || '—';
    }

    function _calLabDominantFailLabel(fail) {
        if (fail === 'SNR') return 'signal clarity';
        if (fail === 'FUND') return 'main note';
        if (fail === 'PITCH') return 'tuning match';
        return fail || '—';
    }

    function _calLabGateChipsHtml(tick) {
        if (!tick || typeof tick !== 'object') return '';
        const chip = (label, ok) => {
            const cls = ok ? 'text-green-300/90' : 'text-amber-200/90';
            const mark = ok ? '✓' : '✗';
            return `<span class="${cls}">${label}${mark}</span>`;
        };
        const snrOk = !!tick.passedSnr || (tick.gatePassCount >= 1 && !(tick.failedGateMask & 1));
        const fundOk = !!tick.passedFundamental || (tick.gatePassCount >= 2 && !(tick.failedGateMask & 2));
        const pitchOk = !!tick.passedPitch || tick.gatePassCount === 3;
        if (tick.passedSnr === undefined && tick.gatePassCount != null) {
            return `<span class="text-[9px] font-mono flex gap-1.5">`
                + chip('Clarity', (tick.failedGateMask & 1) === 0 && tick.gatePassCount >= 1)
                + chip('Main note', (tick.failedGateMask & 2) === 0 && tick.gatePassCount >= 2)
                + chip('Tuning', tick.gatePassCount === 3)
                + '</span>';
        }
        return `<span class="text-[9px] font-mono flex gap-1.5">`
            + chip('Clarity', snrOk) + chip('Main note', fundOk) + chip('Tuning', pitchOk)
            + '</span>';
    }

    function _ndDominantMissReason(breakdown, totalMisses) {
        if (!breakdown || !totalMisses || totalMisses <= 0) return null;
        const labels = {
            pure: 'no note heard',
            chordPartial: 'partial chord',
            early: 'played too early',
            late: 'played too late',
            sharp: 'pitch too sharp',
            flat: 'pitch too flat',
        };
        let bestKey = null;
        let bestVal = 0;
        for (const k of Object.keys(labels)) {
            const v = breakdown[k] || 0;
            if (v > bestVal) { bestVal = v; bestKey = k; }
        }
        if (!bestKey || bestVal === 0) return null;
        return { key: bestKey, label: labels[bestKey], count: bestVal };
    }

    function _ndDetectionHealthHint(d, totalJudgments) {
        if (inputLevel > 0.85) {
            return 'Signal is hot — reduce input gain.';
        }
        if (!totalJudgments || totalJudgments < 5) {
            return 'Not enough hits yet — play a few notes to collect data.';
        }
        const misses = (d && d.summary) ? (d.summary.misses || 0) : 0;
        const bk = (d && d.miss_breakdown) ? d.miss_breakdown : {};
        const teHits = (d && d.timing_error_ms_hits) ? d.timing_error_ms_hits : {};
        const median = teHits.median;
        const dom = _ndDominantMissReason(bk, misses);
        if (dom) {
            if (dom.key === 'late' || (Number.isFinite(median) && median > 25)) {
                return 'Mostly late hits — timing offset may need calibration.';
            }
            if (dom.key === 'early' || (Number.isFinite(median) && median < -25)) {
                return 'Mostly early hits — timing offset may need calibration.';
            }
            if (dom.key === 'pure') {
                return 'Many pure misses — check input channel, gain, or detector confidence.';
            }
            if (dom.key === 'chordPartial') {
                return 'Many chord partials — chord detection may be hearing only part of the chord.';
            }
            if (dom.key === 'sharp' || dom.key === 'flat') {
                return 'Many pitch misses — check tuning, capo, or pitch tolerance.';
            }
        }
        if (Number.isFinite(median) && Math.abs(median) >= 20) {
            return 'Timing median is off — try the Calibration Wizard timing step or adjust chart sync (A/V offset) in main Settings.';
        }
        return null;
    }

    function _ndHealthDetectedLine() {
        if (detectedString >= 0 && detectedConfidence > detectionConfidenceMin) {
            const displayMidi = Number.isFinite(detectedDisplayMidi) ? detectedDisplayMidi : detectedMidi;
            const name = Number.isFinite(displayMidi) ? _ndMidiToName(displayMidi) : '—';
            const confPct = Math.round(detectedConfidence * 100);
            return `${name} · string ${detectedString} fret ${detectedFret} · ${confPct}% conf`;
        }
        const currentHw = resolveHw();
        if (lastChordScore !== null && currentHw && typeof currentHw.getTime === 'function') {
            const songTime = currentHw.getTime() - latencyOffset
                + (currentHw.getAvOffset ? currentHw.getAvOffset() / 1000 : 0);
            if (songTime - lastChordTime <= 1.5) {
                const pct = Math.round(lastChordScore * 100);
                return `Chord ${lastChordHit}/${lastChordTotal} strings (${pct}%)`;
            }
        }
        return '—';
    }

    function _ndHealthInputChannelLabel() {
        if (selectedChannel === 'left') return 'Left (Ch 1)';
        if (selectedChannel === 'right') return 'Right (Ch 2)';
        return 'Mono';
    }

    function _ndHealthDetectorPathLabel() {
        if (usingDesktopBridge) return 'Desktop audio engine';
        if (_diagDetector && _diagDetector.path) return String(_diagDetector.path);
        return 'Browser microphone';
    }

    function renderDetectionHealth(panel) {
        if (!panel) return;
        const set = (sel, text) => {
            const el = panel.querySelector(sel);
            if (el) el.textContent = text;
        };
        let d;
        try {
            d = _buildDiagnosticPayload();
        } catch (e) {
            d = null;
        }
        const summary = (d && d.summary) ? d.summary : {};
        const total = summary.total || 0;
        const hitsN = summary.hits || 0;
        const missesN = summary.misses || 0;
        const methodLabel = detectionMethod === 'crepe' && _ndShared.modelLoading
            ? `${detectionMethod} (loading…)`
            : (detectionMethod || '—');
        const sr = audioCtx && audioCtx.sampleRate
            ? Math.round(audioCtx.sampleRate)
            : (bridgeSampleRate ? Math.round(bridgeSampleRate) : null);
        const avMs = (resolveHw() && resolveHw().getAvOffset)
            ? resolveHw().getAvOffset()
            : null;
        const teHits = (d && d.timing_error_ms_hits) ? d.timing_error_ms_hits : {};
        const dom = _ndDominantMissReason((d && d.miss_breakdown) ? d.miss_breakdown : {}, missesN);
        const levelPct = Math.round((inputLevel || 0) * 100);
        let levelNote = `${levelPct}%`;
        if (inputLevel > 0.85) levelNote += ' (hot)';
        else if (inputLevel < 0.02) levelNote += ' (quiet)';

        set('.nd-health-status',
            enabled
                ? `● Running · ${methodLabel} · ${_ndHealthDetectorPathLabel()}`
                : '○ Detect is off');
        set('.nd-health-input',
            `Input: ${_ndHealthInputChannelLabel()}`
            + (sr ? ` · ${sr} Hz` : '')
            + (selectedDeviceId ? '' : ' · default device'));
        set('.nd-health-hearing', `Now hearing: ${_ndHealthHearingForPanel()}`);
        set('.nd-health-session',
            total > 0
                ? `This song: ${hitsN} hits · ${missesN} misses · ${_ndFormatPercent(summary.accuracy)}`
                : 'This song: Not enough data yet');
        set('.nd-health-top-miss',
            dom
                ? `Most common miss: ${dom.label} (${dom.count})`
                : (missesN > 0 ? 'Most common miss: —' : 'Most common miss: none yet'));
        const timingMed = teHits.median;
        set('.nd-health-align',
            `Sync: chart/video offset ${_ndFormatMs(avMs)} · detection delay ${Math.round(latencyOffset * 1000)} ms`
            + (Number.isFinite(timingMed)
                ? ` · your hits average ${_ndFormatMs(timingMed)} vs chart`
                : ' · your hits: not enough data yet'));
        set('.nd-health-level', `Input level: ${levelNote}`);
        let rejectLines = '—';
        try {
            const recent = _ndVerifierRejects.slice(-3).reverse();
            if (recent.length > 0) {
                rejectLines = recent.map(_ndFormatMusicianRejectLine).join('\n');
            }
        } catch (_) { /* read-only */ }
        set('.nd-health-rejects', rejectLines);
        const hint = _ndDetectionHealthHint(d, total);
        set('.nd-health-hint', hint ? `Tip: ${hint}` : 'Tip: —');
    }

    // ── Calibration Wizard v2 (system setup — safe settings only) ─────
    function calibrationFormatLevel(levelPct, peakPct) {
        const l = Number.isFinite(levelPct) ? Math.round(levelPct) : 0;
        const p = Number.isFinite(peakPct) ? Math.round(peakPct) : l;
        let s = `${l}%`;
        if (p > l) s += ` (peak ${p}%)`;
        if (l > 85) s += ' — hot';
        else if (l < 2) s += ' — quiet';
        return s;
    }

    const _CAL_WIZARD_CHANNEL_PROBE_MS = 3000;
    const _CAL_WIZARD_CHANNEL_PROBE_INTERVAL_MS = 100;
    const _CAL_WIZARD_CHANNEL_PROBE_SETTLE_MS = 250;
    const _CAL_WIZARD_CHANNEL_PROBE_MIN_PEAK = 0.05;
    const _CAL_WIZARD_CHANNEL_PROBE_MONO_TIE_RATIO = 0.10;
    const _CAL_WIZARD_INPUT_CHANNEL_OPTIONS = [
        { ch: -1, label: 'Default / Mono Mix' },
        { ch: 0, label: 'Input 1 / Ch 1' },
        { ch: 1, label: 'Input 2 / Ch 2' },
    ];
    const _CAL_WIZARD_TIMED_PLAYALONG_SEC = 30;
    const _CAL_WIZARD_PLAY_ALONG_WAIT_MS = 60000;
    const _CAL_WIZARD_PLAY_ALONG_WAIT_POLL_MS = 250;
    const _CAL_WIZARD_PLAYHEAD_ADVANCE_MIN_SEC = 0.02;
    const _CAL_WIZARD_PLAYHEAD_ADVANCE_MIN_GAP_MS = 150;
    const _CAL_WIZARD_PAUSE_RETRY_DELAYS_MS = [0, 150, 500, 1200, 2500, 4000];
    let _calWizardPauseRetryTimers = [];

    function _calWizardDefaultAllStringsState() {
        return {
            running: false,
            index: 0,
            ids: [],
            complete: false,
            failedId: null,
            detailsOpen: false,
            message: null,
        };
    }

    function _calWizardClearPauseRetries() {
        _calWizardPauseRetryTimers.forEach((id) => clearTimeout(id));
        _calWizardPauseRetryTimers = [];
    }

    function _calWizardNewState() {
        return {
            step: 0,
            startedAt: Date.now(),
            tunerMinimized: false,
            noise: null,
            signal: null,
            notes: {},
            allStrings: _calWizardDefaultAllStringsState(),
            // Standalone instrument preset chosen in the note-detection step
            // (4/5/6-string bass, 6/7/8-string guitar); null = auto from song.
            selectedInstrumentConfig: null,
            timing: null,
            recommended: { inputGain: null, latencyOffset: null, reasons: {} },
            applyChecked: { inputGain: true, latencyOffset: true },
            applied: null,
            complete: null,
            playAlong: null,
            timingCaptureNote: null,
            autoCapture: null,
            channelProbeRunning: false,
            channelProbeResult: null,
            channelProbeError: null,
            channelProbeAbort: null,
        };
    }

    function _calWizardStopAutoCapture() {
        const wiz = _calWizardState;
        if (!wiz) return;
        if (wiz.autoCapture) {
            const ac = wiz.autoCapture;
            if (ac.timerId) clearTimeout(ac.timerId);
            if (ac.intervalId) clearInterval(ac.intervalId);
            wiz.autoCapture = null;
        }
        if (wiz.channelProbeAbort) {
            wiz.channelProbeAbort = null;
            wiz.channelProbeRunning = false;
        }
    }

    function _calWizardNoiseStatus(avgPct) {
        if (!Number.isFinite(avgPct)) return 'unknown';
        if (avgPct < 5) return 'good';
        if (avgPct < 15) return 'elevated';
        return 'too_noisy';
    }

    function _calWizardSignalStatus(avgPct, peakPct, noiseAvg) {
        if (!Number.isFinite(avgPct)) return 'unknown';
        const floor = Number.isFinite(noiseAvg) ? noiseAvg + 6 : 8;
        if (avgPct < floor) return 'too_low';
        if ((peakPct || avgPct) > 85) return 'too_hot';
        return 'good';
    }

    function _calWizardRecommendInputGain(signalStatus, currentGain, signalAvg) {
        const g = Number.isFinite(currentGain) ? currentGain : 1;
        if (signalStatus === 'too_low' && g < 5) {
            const target = Math.min(5, Math.max(1.1, g * 1.2));
            if (target > g + 0.04) {
                return {
                    value: +target.toFixed(2),
                    reason: `Signal averaged ${Math.round(signalAvg || 0)}% — a modest gain boost may help note detection.`,
                };
            }
        }
        if (signalStatus === 'too_hot' && g > 1) {
            const target = Math.max(1, g * 0.85);
            if (target < g - 0.04) {
                return {
                    value: +target.toFixed(2),
                    reason: 'Signal is hot — lowering input gain reduces clipping risk.',
                };
            }
        }
        return null;
    }

    function _calWizardRecommendLatency(medianMs, currentLatencyS) {
        if (!Number.isFinite(medianMs) || Math.abs(medianMs) < 8) return null;
        const cur = Number.isFinite(currentLatencyS) ? currentLatencyS : 0.08;
        const delta = (medianMs / 1000) * 0.5;
        const target = Math.max(0, Math.min(0.25, cur + delta));
        if (Math.abs(target - cur) < 0.005) return null;
        const dir = medianMs > 0 ? 'late' : 'early';
        return {
            value: +target.toFixed(3),
            reason: `Hit timing median is ${_ndFormatMs(medianMs)} (${dir}) — adjusting audio latency offset may align notes with the chart.`,
        };
    }

    function _calWizardBuildSafeRecommendations(wiz, snap) {
        const rec = { inputGain: null, latencyOffset: null, reasons: {} };
        if (wiz && wiz.signal) {
            const g = _calWizardRecommendInputGain(
                wiz.signal.status, inputGain, wiz.signal.avgPct);
            if (g) {
                rec.inputGain = g.value;
                rec.reasons.inputGain = g.reason;
            }
        }
        const med = wiz && wiz.timing && Number.isFinite(wiz.timing.medianMs)
            ? wiz.timing.medianMs
            : (snap && snap.timingMedianMs);
        const lat = _calWizardRecommendLatency(med, latencyOffset);
        if (lat) {
            rec.latencyOffset = lat.value;
            rec.reasons.latencyOffset = lat.reason;
        }
        wiz.recommended = rec;
        return rec;
    }

    function _calWizardSetAutoStatus(html) {
        const el = _calWizardEl && _calWizardEl.querySelector('.nd-cal-auto-status');
        if (el) el.innerHTML = html;
    }

    function _calWizardSetChannelProbeStatus(html) {
        const el = _calWizardEl && _calWizardEl.querySelector('.nd-cal-channel-probe-status');
        if (el) el.innerHTML = html;
    }

    function _calWizardSetTunerOpenStatus(message, tone) {
        const el = _calWizardEl && _calWizardEl.querySelector('.nd-cal-tuner-open-status');
        if (!el) return;
        if (!message) {
            el.innerHTML = '';
            return;
        }
        const cls = tone === 'warn' ? 'text-amber-200/90' : 'text-gray-400';
        el.innerHTML = `<span class="${cls}">${message}</span>`;
    }

    function _calWizardIsTunerUiVisible() {
        const el = document.getElementById('tuner-plugin-ui');
        if (!el || el.classList.contains('hidden')) return false;
        const cs = window.getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
    }

    async function _calWizardWaitForTunerUiVisible(maxMs) {
        const deadline = Date.now() + maxMs;
        while (Date.now() < deadline) {
            if (_calWizardIsTunerUiVisible()) return true;
            await _calWizardSleep(100);
        }
        return _calWizardIsTunerUiVisible();
    }

    async function _calWizardOpenTunerFromWizard() {
        if (!window.tuner || typeof window.tuner.enable !== 'function') {
            _calWizardSetTunerOpenStatus(
                'Tuner plugin is not loaded. Enable the Tuner plugin, then try again.', 'warn');
            return;
        }
        _calWizardSetTunerOpenStatus('Opening tuner…', 'neutral');
        try {
            await window.tuner.enable();
        } catch (e) {
            console.warn('[note_detect] tuner enable:', e);
            _calWizardSetTunerOpenStatus(
                'Tuner did not open. Check microphone permission or open the Tuner from the bottom toolbar.', 'warn');
            return;
        }
        const visible = await _calWizardWaitForTunerUiVisible(4000);
        if (visible) {
            _calWizardSetTunerOpenStatus('', 'neutral');
            _calWizardSetTunerMinimized(true);
            return;
        }
        _calWizardSetTunerOpenStatus(
            'Tuner did not open. Check microphone permission or open the Tuner from the bottom toolbar.', 'warn');
    }

    function _calWizardFinishLevelSample(wiz, kind, samples) {
        if (!samples.length) {
            _calWizardSetAutoStatus('<span class="text-amber-200/90">No samples — turn Detect on and retry.</span>');
            return;
        }
        let sum = 0;
        let maxPeak = 0;
        for (const s of samples) {
            sum += s.level;
            if (s.peak > maxPeak) maxPeak = s.peak;
        }
        const avg = Math.round(sum / samples.length);
        const peak = maxPeak;
        if (kind === 'noise') {
            wiz.noise = {
                avgPct: avg,
                peakPct: peak,
                status: _calWizardNoiseStatus(avg),
                captured: true,
                at: Date.now(),
            };
            const label = _calWizardNoiseStatusDisplay(wiz.noise.status);
            _calWizardSetAutoStatus(
                `<span class="text-green-300/90">Captured:</span> avg ${avg}% · peak ${peak}% · <span class="font-semibold">${label}</span>`);
        } else if (kind === 'signal') {
            const noiseAvg = wiz.noise && wiz.noise.avgPct;
            wiz.signal = {
                avgPct: avg,
                peakPct: peak,
                status: _calWizardSignalStatus(avg, peak, noiseAvg),
                captured: true,
                at: Date.now(),
            };
            const label = _calWizardSignalStatusDisplay(wiz.signal.status);
            let extra = '';
            const gRec = _calWizardRecommendInputGain(wiz.signal.status, inputGain, avg);
            if (gRec) extra = `<div class="text-gray-400 mt-1">Suggested input gain: ${gRec.value}x</div>`;
            _calWizardSetAutoStatus(
                `<span class="text-green-300/90">Captured:</span> avg ${avg}% · peak ${peak}% · <span class="font-semibold">${label}</span>${extra}`);
            _calWizardBuildSafeRecommendations(wiz, getCalibrationSnapshot());
        }
        renderCalibrationWizard();
    }

    function _calWizardRunLevelSampler(wiz, kind, durationMs, onDone) {
        _calWizardStopAutoCapture();
        const samples = [];
        const started = Date.now();
        wiz.autoCapture = { kind, phase: 'listening', samples, started };
        const tick = () => {
            const snap = getCalibrationSnapshot();
            samples.push({ level: snap.inputLevelPct, peak: snap.inputPeakPct, t: Date.now() });
            const elapsed = Date.now() - started;
            _calWizardSetAutoStatus(
                `<span class="text-cyan-300/90">Listening…</span> ${Math.round(elapsed / 1000)}s / ${Math.round(durationMs / 1000)}s · `
                + calibrationFormatLevel(snap.inputLevelPct, snap.inputPeakPct));
            if (elapsed >= durationMs) {
                _calWizardStopAutoCapture();
                onDone(samples);
            }
        };
        tick();
        wiz.autoCapture.intervalId = setInterval(tick, 120);
        wiz.autoCapture.timerId = setTimeout(() => {
            _calWizardStopAutoCapture();
            onDone(samples);
        }, durationMs + 200);
    }

    function _calWizardBeginCountdownThen(kind, countdownSec, afterCountdown) {
        const wiz = _calWizardState;
        if (!wiz) return;
        _calWizardStopAutoCapture();
        let left = countdownSec;
        wiz.autoCapture = { kind, phase: 'countdown', left };
        const tick = () => {
            if (!_calWizardState || _calWizardState !== wiz) return;
            // Keep the live counter on autoCapture so the per-string row cells
            // (rendered by _calWizardRefreshLive) can show the same countdown
            // inline, next to the Check button the user just pressed.
            if (wiz.autoCapture) wiz.autoCapture.left = left;
            _calWizardSetAutoStatus(`<span class="text-cyan-300/90">Get ready…</span> <span class="text-2xl font-bold text-white">${left}</span>`);
            if (left <= 0) {
                _calWizardStopAutoCapture();
                afterCountdown();
                return;
            }
            left--;
            wiz.autoCapture.timerId = setTimeout(tick, 1000);
        };
        tick();
    }

    function _calWizardStartNoiseCapture() {
        const wiz = _calWizardState;
        if (!wiz) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calWizardSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            return;
        }
        _calWizardBeginCountdownThen('noise', 3, () => {
            _calWizardSetAutoStatus('<span class="text-cyan-300/90">Listening…</span> Mute all strings.');
            _calWizardRunLevelSampler(wiz, 'noise', 1600, (samples) => {
                _calWizardFinishLevelSample(wiz, 'noise', samples);
            });
        });
    }

    function _calWizardStartSignalCapture() {
        const wiz = _calWizardState;
        if (!wiz) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calWizardSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            return;
        }
        const noiseFloor = (wiz.noise && wiz.noise.avgPct) || 3;
        const trigger = noiseFloor + 8;
        _calWizardBeginCountdownThen('signal', 3, () => {
            _calWizardStopAutoCapture();
            const samples = [];
            const started = Date.now();
            const maxWait = 12000;
            wiz.autoCapture = { kind: 'signal', phase: 'wait_signal', samples, started };
            const tick = () => {
                const s = getCalibrationSnapshot();
                const lvl = s.inputLevelPct;
                const elapsed = Date.now() - started;
                if (lvl >= trigger && wiz.autoCapture.phase === 'wait_signal') {
                    wiz.autoCapture.phase = 'listening';
                    wiz.autoCapture.signalStarted = Date.now();
                    _calWizardSetAutoStatus('<span class="text-cyan-300/90">Signal detected — listening…</span> Play open low E.');
                }
                if (wiz.autoCapture.phase === 'listening') {
                    samples.push({ level: lvl, peak: s.inputPeakPct, t: Date.now() });
                    const listenFor = Date.now() - (wiz.autoCapture.signalStarted || started);
                    _calWizardSetAutoStatus(
                        `<span class="text-cyan-300/90">Listening…</span> ${Math.round(listenFor / 1000)}s · `
                        + calibrationFormatLevel(lvl, s.inputPeakPct));
                    if (listenFor >= 1600) {
                        _calWizardStopAutoCapture();
                        _calWizardFinishLevelSample(wiz, 'signal', samples);
                        return;
                    }
                } else {
                    _calWizardSetAutoStatus(
                        `<span class="text-cyan-300/90">Waiting for signal…</span> Play open low E (need ≥${trigger}%). `
                        + calibrationFormatLevel(lvl, s.inputPeakPct));
                    if (elapsed >= maxWait) {
                        _calWizardStopAutoCapture();
                        _calWizardSetAutoStatus('<span class="text-amber-200/90">Timeout — no signal detected. Retry when ready.</span>');
                    }
                }
            };
            tick();
            wiz.autoCapture.intervalId = setInterval(tick, 120);
        });
    }

    function _calWizardResolveNoteCheckContext() {
        try { _syncChartStateFromHw(); } catch (_) { /* read-only refresh */ }
        const hw = resolveHw();
        let info = null;
        try { info = (hw && hw.getSongInfo) ? hw.getSongInfo() : null; } catch (_) {}
        const hasTuning = !!(info && Array.isArray(info.tuning) && info.tuning.length > 0);
        // No real song tuning (onboarding standalone). Priority for what to
        // calibrate: (1) the user's explicit instrument-config dropdown, then
        // (2) the launchCalibration() arrangement override, else (3) the
        // guitar default. _syncChartStateFromHw just reset currentArrangement
        // to 'guitar', so without these overrides a bass/extended-range player
        // would silently calibrate a 6-string guitar.
        const cfgId = _calWizardState && _calWizardState.selectedInstrumentConfig;
        const cfg = (!hasTuning && cfgId)
            ? _CAL_WIZARD_INSTRUMENT_CONFIGS.find((c) => c.id === cfgId)
            : null;
        const forced = !hasTuning && !cfg && _calWizardForceArrangement;
        let arrangement;
        let stringCount;
        if (cfg) {
            arrangement = cfg.arrangement;
            stringCount = cfg.stringCount;
        } else {
            arrangement = forced
                ? _calWizardForceArrangement
                : (currentArrangement || 'guitar');
            // When forcing a standalone arrangement with no host chart,
            // _syncChartStateFromHw left currentStringCount at the guitar
            // default (6); pick the arrangement's own default so a bass
            // calibration shows 4 strings, not 6 (two of them blank).
            stringCount = (Number.isFinite(currentStringCount) && currentStringCount > 0)
                ? currentStringCount : 6;
            if (forced && _calWizardForceArrangement === 'bass') stringCount = 4;
        }
        const offsets = Array.isArray(tuningOffsets) ? tuningOffsets : [0, 0, 0, 0, 0, 0];
        // `preset` is the standalone instrument the user picked (or null). When
        // set we know the real open-string notes even with no song loaded, so
        // labels should show them instead of the generic Low E / Open A.
        return { hasTuning, arrangement, stringCount, offsets, preset: cfg || null };
    }

    function _calWizardOpenStringMidi(stringIndex, ctx) {
        const { hasTuning, arrangement, stringCount, offsets } = ctx;
        let expectedMidi = null;
        if (hasTuning) {
            try {
                const computed = _ndMidiFromStringFret(
                    stringIndex, 0, arrangement, stringCount, offsets, 0);
                if (Number.isFinite(computed)) expectedMidi = computed;
            } catch (_) { /* fall through to fallback */ }
        }
        if (!Number.isFinite(expectedMidi)) {
            try {
                const base = _ndStandardMidiFor(arrangement, stringCount);
                if (base && base[stringIndex] !== undefined) expectedMidi = base[stringIndex];
            } catch (_) { /* ignore */ }
        }
        return expectedMidi;
    }

    function _calWizardOpenStringDisplayNum(stringIndex, stringCount) {
        return stringCount - stringIndex;
    }

    function _calWizardOpenStringLabel(stringIndex, stringCount, expectedNote, hasTuning) {
        const n = _calWizardOpenStringDisplayNum(stringIndex, stringCount);
        const note = expectedNote || '—';
        if (stringIndex === 0) {
            return hasTuning
                ? `String ${n} — low string (${note})`
                : `String ${n} — low string`;
        }
        if (stringIndex === stringCount - 1) {
            return hasTuning
                ? `String ${n} — high string (${note})`
                : `String ${n} — high string`;
        }
        return hasTuning ? `String ${n} (${note})` : `String ${n}`;
    }

    function _calWizardResolveNoteChecks(opts) {
        const mode = (opts && opts.mode === 'all') ? 'all' : 'quick';
        const ctx = _calWizardResolveNoteCheckContext();
        const { hasTuning, stringCount } = ctx;
        // Always name the target note so the player knows exactly what to play
        // (tester feedback: the generic "Low E / Open A" tests were unclear).
        // We always resolve a concrete expectedMidi below — from the song tuning,
        // a chosen standalone preset, or the standard-tuning fallback — so the
        // label can always show it. An extended-range player who hasn't loaded a
        // song still sees the standard-tuning note and can pick a preset to refine.
        const showNote = true;
        if (mode === 'all') {
            const specs = [];
            for (let s = 0; s < stringCount; s++) {
                const expectedMidi = _calWizardOpenStringMidi(s, ctx);
                if (!Number.isFinite(expectedMidi)) continue;
                const expectedNote = _ndMidiToName(expectedMidi);
                specs.push({
                    id: 'openS' + s,
                    label: _calWizardOpenStringLabel(s, stringCount, expectedNote, showNote),
                    expectedMidi,
                    expectedNote,
                    string: s,
                    displayString: _calWizardOpenStringDisplayNum(s, stringCount),
                });
            }
            return specs;
        }
        const specs = [];
        for (const def of _CAL_WIZARD_NOTE_CHECK_DEFS) {
            if (def.string >= stringCount) continue;
            let expectedMidi = _calWizardOpenStringMidi(def.string, ctx);
            if (!Number.isFinite(expectedMidi)) expectedMidi = def.fallbackMidi;
            const expectedNote = _ndMidiToName(expectedMidi);
            const label = def.string === 0
                ? (showNote ? `Open low string (${expectedNote})` : def.fallbackLabel)
                : (showNote ? `Open 2nd string (${expectedNote})` : def.fallbackLabel);
            specs.push({
                id: def.id,
                label,
                expectedMidi,
                expectedNote,
                string: def.string,
            });
        }
        if (!specs.length) {
            return _CAL_WIZARD_NOTE_CHECK_DEFS.map((def) => ({
                id: def.id,
                label: def.fallbackLabel,
                expectedMidi: def.fallbackMidi,
                expectedNote: _ndMidiToName(def.fallbackMidi),
                string: def.string,
            }));
        }
        return specs;
    }

    function _calWizardFindNoteCheckSpec(noteId) {
        if (!noteId) return null;
        const quick = _calWizardResolveNoteChecks({ mode: 'quick' });
        const hit = quick.find((n) => n.id === noteId);
        if (hit) return hit;
        const all = _calWizardResolveNoteChecks({ mode: 'all' });
        return all.find((n) => n.id === noteId) || null;
    }

    // The open strings shown (and run) in the advanced panel: every open string
    // EXCEPT the ones the quick Open low / Open 2nd checks above already cover.
    // Shared by the render and the Run-All sweep so the run only ever targets
    // strings that have a visible row (with its own inline countdown/result).
    function _calWizardResolveAdvancedStringChecks() {
        const quickStrings = new Set(_calWizardResolveNoteChecks({ mode: 'quick' }).map((s) => s.string));
        return _calWizardResolveNoteChecks({ mode: 'all' }).filter((s) => !quickStrings.has(s.string));
    }

    // Result-cell colour + text for one open-string check, shared by the static
    // render and the live per-row refresh so a row reads the same either way.
    function _calWizardNoteResultParts(spec) {
        const wiz = _calWizardState;
        const r = wiz && wiz.notes ? wiz.notes[spec.id] : null;
        if (r && r.ok) {
            return { cls: 'text-green-300/90', txt: `OK — heard ${r.heardNote} (${r.confidencePct}%)` };
        }
        if (r) {
            return { cls: 'text-amber-200/90', txt: `Failed — expected ${r.expectedNote || spec.expectedNote}` };
        }
        return { cls: 'text-gray-500', txt: `Expected ${spec.expectedNote}` };
    }

    // The open-string check (if any) currently counting down or listening, so
    // its inline row cell shows live status instead of the stored result. The
    // countdown autoCapture encodes the note id in `kind` ("note_<id>"); the
    // listening autoCapture carries it on `noteId`.
    function _calWizardActiveNoteCapture() {
        const ac = _calWizardState && _calWizardState.autoCapture;
        if (!ac) return null;
        if (ac.phase === 'countdown' && typeof ac.kind === 'string' && ac.kind.startsWith('note_')) {
            return { id: ac.kind.slice(5), phase: 'countdown', left: Number.isFinite(ac.left) ? ac.left : '' };
        }
        if (ac.kind === 'note' && ac.noteId) {
            return { id: ac.noteId, phase: 'listening' };
        }
        return null;
    }

    // Wizard-only raw pitch readout — bypasses chart-aware detectedDisplayMidi.
    function _calWizardRawPitchFields() {
        const confOk = detectedConfidence > detectionConfidenceMin;
        const rawMidi = (detectedMidi >= 0 && confOk) ? detectedMidi : null;
        const rawNote = Number.isFinite(rawMidi) ? _ndMidiToName(rawMidi) : '—';
        let displayNote = null;
        if (detectedString >= 0 && confOk) {
            const dm = Number.isFinite(detectedDisplayMidi) ? detectedDisplayMidi : detectedMidi;
            if (Number.isFinite(dm)) displayNote = _ndMidiToName(dm);
        }
        return {
            rawMidi,
            rawNote,
            displayNote,
            confidencePct: confOk ? Math.round(detectedConfidence * 100) : null,
            channel: _ndHealthInputChannelLabel(),
        };
    }

    function _calWizardMidiNearTarget(detectedMidi, targetMidi, centsTol) {
        if (!Number.isFinite(detectedMidi) || !Number.isFinite(targetMidi)) return false;
        return Math.abs(_ndNearestOctaveCents(detectedMidi, targetMidi)) <= centsTol;
    }

    function _calWizardStopAllStringsRun(reason, opts) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.allStrings) return;
        const seq = wiz.allStrings;
        const wasRunning = seq.running;
        seq.running = false;
        if (opts && opts.clearMessage) seq.message = null;
        if (reason === 'restart') {
            seq.complete = false;
            seq.failedId = null;
        }
        if (wasRunning && wiz.autoCapture && wiz.autoCapture.kind === 'note') {
            const nid = wiz.autoCapture.noteId;
            if (nid && seq.ids && seq.ids.includes(nid)) {
                _calWizardStopAutoCapture();
            }
        }
    }

    function _calWizardStartAllStringsRun() {
        const wiz = _calWizardState;
        if (!wiz) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calWizardSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            return;
        }
        _calWizardStopAllStringsRun('restart', { clearMessage: true });
        // Sweep only the advanced rows (the two lowest strings are covered by
        // the quick Open low / Open 2nd checks) so every run target has a
        // visible row to show its countdown/result.
        const specs = _calWizardResolveAdvancedStringChecks();
        if (!specs.length) return;
        for (const key of Object.keys(wiz.notes)) {
            if (key.startsWith('openS')) delete wiz.notes[key];
        }
        const ids = specs.map((s) => s.id);
        const first = specs[0];
        wiz.allStrings = {
            running: true,
            index: 0,
            ids,
            complete: false,
            failedId: null,
            detailsOpen: true,
            message: first ? `Play ${first.label}` : null,
        };
        renderCalibrationWizard();
        _calWizardStartNoteCapture(ids[0]);
    }

    function _calWizardAdvanceAllStringsRun(noteId, ok) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.allStrings || !wiz.allStrings.running) return false;
        const seq = wiz.allStrings;
        const expectedId = seq.ids[seq.index];
        if (noteId !== expectedId) return true;
        seq.detailsOpen = true;
        if (!ok) {
            seq.running = false;
            seq.failedId = noteId;
            const spec = _calWizardFindNoteCheckSpec(noteId);
            const label = spec ? spec.label : noteId;
            seq.message = `${label} did not pass — retry the run or check manually.`;
            renderCalibrationWizard();
            return true;
        }
        seq.index += 1;
        if (seq.index >= seq.ids.length) {
            seq.running = false;
            seq.complete = true;
            seq.message = 'Remaining strings passed.';
            _calWizardSetAutoStatus('<span class="text-green-300/90">Remaining strings passed.</span>');
            renderCalibrationWizard();
            return true;
        }
        const nextId = seq.ids[seq.index];
        const nextSpec = _calWizardFindNoteCheckSpec(nextId);
        seq.message = nextSpec ? `Play ${nextSpec.label}` : `Play string ${seq.index + 1}`;
        renderCalibrationWizard();
        _calWizardStartNoteCapture(nextId);
        return true;
    }

    function _calWizardStartNoteCapture(noteId) {
        const wiz = _calWizardState;
        if (!wiz) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calWizardSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            if (wiz.allStrings && wiz.allStrings.running) {
                _calWizardStopAllStringsRun('detect-off');
            }
            return;
        }
        _calWizardBeginCountdownThen('note_' + noteId, 2, () => {
            const spec = _calWizardFindNoteCheckSpec(noteId);
            if (!spec) return;
            _calWizardStopAutoCapture();
            const stable = [];
            const started = Date.now();
            const maxWait = 14000;
            wiz.autoCapture = { kind: 'note', noteId, stable, started };
            const tick = () => {
                const s = getCalibrationSnapshot();
                const heardMidi = _calWizardRawPitchFields().rawMidi;
                if (_calWizardMidiNearTarget(heardMidi, spec.expectedMidi, 100)) {
                    stable.push({ midi: heardMidi, conf: detectedConfidence, t: Date.now() });
                } else {
                    stable.length = 0;
                }
                const elapsed = Date.now() - started;
                if (stable.length >= 4) {
                    const last = stable[stable.length - 1];
                    wiz.notes[noteId] = {
                        ok: true,
                        label: spec.label,
                        expectedNote: spec.expectedNote,
                        expectedMidi: spec.expectedMidi,
                        heardNote: _ndMidiToName(last.midi),
                        confidencePct: Math.round(last.conf * 100),
                        at: Date.now(),
                    };
                    _calWizardStopAutoCapture();
                    _calWizardSetAutoStatus(
                        `<span class="text-green-300/90">${spec.label} OK</span> — `
                        + `expected ${spec.expectedNote}, heard ${wiz.notes[noteId].heardNote} `
                        + `(${wiz.notes[noteId].confidencePct}% conf)`);
                    if (!_calWizardAdvanceAllStringsRun(noteId, true)) {
                        renderCalibrationWizard();
                    }
                    return;
                }
                _calWizardSetAutoStatus(
                    `<span class="text-cyan-300/90">Listening for ${spec.label}…</span> `
                    + (s.heardConfidencePct != null
                        ? `Expected: ${spec.expectedNote} · Heard: ${s.rawHeardNote ?? s.heardNote} · ${s.heardConfidencePct}%`
                        : `Expected: ${spec.expectedNote} · Channel: ${s.channel || '—'} · Live: `
                        + calibrationFormatLevel(s.inputLevelPct, s.inputPeakPct)));
                if (elapsed >= maxWait) {
                    _calWizardStopAutoCapture();
                    wiz.notes[noteId] = {
                        ok: false,
                        label: spec.label,
                        expectedNote: spec.expectedNote,
                        expectedMidi: spec.expectedMidi,
                        at: Date.now(),
                    };
                    _calWizardSetAutoStatus(
                        `<span class="text-amber-200/90">${spec.label}: no stable note detected. `
                        + `Expected ${spec.expectedNote}. Retry.</span>`);
                    if (!_calWizardAdvanceAllStringsRun(noteId, false)) {
                        renderCalibrationWizard();
                    }
                }
            };
            tick();
            wiz.autoCapture.intervalId = setInterval(tick, 150);
        });
    }

    function _calWizardCaptureTimingSnapshot() {
        const wiz = _calWizardState;
        if (!wiz) return;
        let d = null;
        try { d = getCalibrationSnapshot().diagnostic; } catch (_) {}
        const dist = d && d.timing_error_ms_hits ? d.timing_error_ms_hits : {};
        const med = dist.median;
        const count = dist.count || 0;
        wiz.timing = {
            medianMs: Number.isFinite(med) ? med : null,
            sampleCount: count,
            captured: true,
            at: Date.now(),
        };
        _calWizardBuildSafeRecommendations(wiz, getCalibrationSnapshot());
        renderCalibrationWizard();
    }

    // Hides the wizard card and passes clicks through — reused for tuner step and
    // timing play-along (not tuner-specific despite the name).
    function _calWizardSetTunerMinimized(minimized) {
        const wiz = _calWizardState;
        if (!_calWizardEl || !wiz) return;
        wiz.tunerMinimized = !!minimized;
        const card = _calWizardEl.querySelector('.nd-cal-wizard-card');
        const ret = _calWizardEl.querySelector('.nd-cal-return-wizard');
        if (minimized) {
            _calWizardEl.style.background = 'transparent';
            _calWizardEl.style.pointerEvents = 'none';
            if (card) card.style.visibility = 'hidden';
            if (ret) ret.style.display = 'block';
        } else {
            _calWizardEl.style.background = 'rgba(0,0,0,0.65)';
            _calWizardEl.style.pointerEvents = 'auto';
            if (card) card.style.visibility = 'visible';
            if (ret) ret.style.display = 'none';
            _calWizardUpdateReturnButtonTimer(null);
        }
    }

    function _calWizardMinimizeForPlayback() {
        _calWizardSetTunerMinimized(true);
    }

    function _calWizardUpdateReturnButtonTimer(secLeft) {
        if (!_calWizardEl) return;
        const primary = _calWizardEl.querySelector('.nd-cal-return-primary');
        const secondary = _calWizardEl.querySelector('.nd-cal-return-secondary');
        if (!primary || !secondary) return;
        if (secLeft === 'waiting') {
            primary.textContent = 'Press Play to start timing';
            secondary.textContent = `The ${_CAL_WIZARD_TIMED_PLAYALONG_SEC}s timer starts when playback begins`;
        } else if (Number.isFinite(secLeft) && secLeft >= 0) {
            primary.textContent = `Timing test: ${secLeft}s left`;
            secondary.textContent = 'Keep playing — setup will return automatically';
        } else {
            primary.textContent = 'Return to Calibration Wizard';
            secondary.textContent = 'Tap here to continue setup';
        }
    }

    function _calWizardTeardownPlayAlongWait(pa) {
        if (!pa) return;
        if (pa.waitTimeoutId) {
            clearTimeout(pa.waitTimeoutId);
            pa.waitTimeoutId = null;
        }
        if (pa.waitPollId) {
            clearInterval(pa.waitPollId);
            pa.waitPollId = null;
        }
        if (pa.onPlayHandler && window.slopsmith && typeof window.slopsmith.off === 'function') {
            try { window.slopsmith.off('song:play', pa.onPlayHandler); } catch (_) {}
            pa.onPlayHandler = null;
        }
    }

    function _calWizardIsPlaybackActive() {
        try {
            if (window.slopsmith && window.slopsmith.isPlaying) return true;
        } catch (_) { /* host may be unavailable */ }
        return false;
    }

    function _calWizardPlayheadAdvancing(pa) {
        const hw = resolveHw();
        if (!hw || typeof hw.getTime !== 'function' || !pa) return false;
        const t = hw.getTime();
        if (!Number.isFinite(pa._phLast)) {
            pa._phLast = t;
            pa._phLastAt = Date.now();
            return false;
        }
        const gapMs = Date.now() - pa._phLastAt;
        if (gapMs < _CAL_WIZARD_PLAYHEAD_ADVANCE_MIN_GAP_MS) return false;
        const advancing = t > pa._phLast + _CAL_WIZARD_PLAYHEAD_ADVANCE_MIN_SEC;
        pa._phLast = t;
        pa._phLastAt = Date.now();
        return advancing;
    }

    function _calWizardBeginTimedPlayAlongCountdown() {
        const wiz = _calWizardState;
        if (!wiz || !wiz.playAlong || wiz.playAlong.phase !== 'waiting') return;
        const pa = wiz.playAlong;
        _calWizardTeardownPlayAlongWait(pa);
        pa.phase = 'running';
        pa.endsAt = Date.now() + pa.durationMs;
        const tickCountdown = () => {
            if (!_calWizardState || !_calWizardState.playAlong) return;
            const active = _calWizardState.playAlong;
            if (active.phase !== 'running' || !Number.isFinite(active.endsAt)) return;
            const left = Math.ceil((active.endsAt - Date.now()) / 1000);
            if (left <= 0) {
                _calWizardFinishTimedPlayAlong(false);
                return;
            }
            _calWizardUpdateReturnButtonTimer(left);
        };
        tickCountdown();
        pa.intervalId = setInterval(tickCountdown, 1000);
        pa.timerId = setTimeout(() => _calWizardFinishTimedPlayAlong(false), pa.durationMs + 50);
    }

    function _calWizardPollPlayAlongWait() {
        const wiz = _calWizardState;
        if (!wiz || !wiz.playAlong || wiz.playAlong.phase !== 'waiting') return;
        const pa = wiz.playAlong;
        if (pa.playbackSeen || _calWizardIsPlaybackActive() || _calWizardPlayheadAdvancing(pa)) {
            _calWizardBeginTimedPlayAlongCountdown();
        }
    }

    function _calWizardCancelTimedPlayAlongWaiting(message) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.playAlong) return;
        _calWizardStopTimedPlayAlong('cancel-wait');
        _calWizardSetTunerMinimized(false);
        wiz.timingCaptureNote = message;
        renderCalibrationWizard();
        _calWizardRefreshLive();
    }

    function _calWizardStopTimedPlayAlong(reason) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.playAlong) return false;
        const pa = wiz.playAlong;
        _calWizardTeardownPlayAlongWait(pa);
        if (pa.timerId) {
            clearTimeout(pa.timerId);
            pa.timerId = null;
        }
        if (pa.intervalId) {
            clearInterval(pa.intervalId);
            pa.intervalId = null;
        }
        wiz.playAlong = null;
        _calWizardUpdateReturnButtonTimer(null);
        return true;
    }

    function _calWizardDispatchPlaybackPause(reason) {
        const caps = window.slopsmith && window.slopsmith.capabilities;
        if (!caps || typeof caps.dispatch !== 'function') {
            return Promise.resolve({ attempted: false, handled: false });
        }
        try {
            const result = caps.dispatch({
                capability: 'playback',
                command: 'pause',
                requester: 'slopsmith-plugin-notedetect',
                args: { requesterId: 'cal-wizard-timed-playalong', reason: reason || 'timed-playalong-complete' },
            });
            const parse = (r) => ({
                attempted: true,
                handled: !!(r && (r.outcome === 'handled' || r.status === 'paused')),
                result: r,
            });
            if (result && typeof result.then === 'function') {
                return result.then(parse).catch((e) => {
                    console.warn('[note_detect] cal-wizard timed playalong pause:', e);
                    return { attempted: true, handled: false, error: e };
                });
            }
            return Promise.resolve(parse(result));
        } catch (e) {
            console.warn('[note_detect] cal-wizard timed playalong pause:', e);
            return Promise.resolve({ attempted: false, handled: false, error: e });
        }
    }

    function _calWizardAppendTimingCaptureNote(fragment) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.timingCaptureNote || !fragment) return;
        if (!wiz.timingCaptureNote.includes(fragment)) {
            wiz.timingCaptureNote += ` ${fragment}`;
            renderCalibrationWizard();
        }
    }

    function _calWizardMaybePauseAfterTimedPlayAlong(pa) {
        if (!pa || pa.wasPlayingAtArm !== false) return;
        if (!_calWizardIsPlaybackActive()) return;
        _calWizardClearPauseRetries();
        const delays = _CAL_WIZARD_PAUSE_RETRY_DELAYS_MS;
        delays.forEach((delayMs, idx) => {
            const isLast = idx === delays.length - 1;
            const timerId = setTimeout(() => {
                _calWizardPauseRetryTimers = _calWizardPauseRetryTimers.filter((id) => id !== timerId);
                if (!_calWizardState) return;
                if (!_calWizardIsPlaybackActive()) {
                    _calWizardAppendTimingCaptureNote('Playback paused.');
                    return;
                }
                const reason = idx === 0
                    ? 'cal-wizard-timed-playalong-complete'
                    : 'cal-wizard-timed-playalong-retry';
                _calWizardDispatchPlaybackPause(reason).then(() => {
                    if (!_calWizardState) return;
                    if (!_calWizardIsPlaybackActive()) {
                        _calWizardAppendTimingCaptureNote('Playback paused.');
                    } else if (isLast) {
                        _calWizardAppendTimingCaptureNote(
                            'Playback may still be running — pause when ready.');
                    }
                });
            }, delayMs);
            _calWizardPauseRetryTimers.push(timerId);
        });
    }

    function _calWizardFinishTimedPlayAlong(partial) {
        const wiz = _calWizardState;
        if (!wiz || !wiz.playAlong) return;
        if (wiz.playAlong.phase === 'waiting') {
            _calWizardCancelTimedPlayAlongWaiting('Timed play-along cancelled — returned before playback started.');
            return;
        }
        const stashedPlayAlong = { wasPlayingAtArm: wiz.playAlong.wasPlayingAtArm };
        _calWizardStopTimedPlayAlong('finish');
        _calWizardSetTunerMinimized(false);
        wiz.timingCaptureNote = partial
            ? 'Partial window captured — returned early.'
            : `Timed play-along captured (${_CAL_WIZARD_TIMED_PLAYALONG_SEC}s window).`;
        _calWizardCaptureTimingSnapshot();
        if (!partial) _calWizardMaybePauseAfterTimedPlayAlong(stashedPlayAlong);
    }

    function _calWizardStartTimedPlayAlong(durationSec) {
        const wiz = _calWizardState;
        if (!wiz) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            wiz.timingCaptureNote = 'Turn Detect on first.';
            renderCalibrationWizard();
            return;
        }
        _calWizardStopTimedPlayAlong('restart');
        try { _resetCalibrationSamples(); } catch (e) {
            console.warn('[note_detect] resetCalibrationSamples:', e);
        }
        wiz.timing = null;
        wiz.timingCaptureNote = null;
        const sec = Number.isFinite(durationSec) && durationSec > 0
            ? durationSec : _CAL_WIZARD_TIMED_PLAYALONG_SEC;
        const durationMs = sec * 1000;
        const wasPlayingAtArm = _calWizardIsPlaybackActive();
        wiz.playAlong = {
            phase: 'waiting',
            durationSec: sec,
            durationMs,
            waitStartedAt: Date.now(),
            waitTimeoutId: null,
            waitPollId: null,
            onPlayHandler: null,
            playbackSeen: false,
            wasPlayingAtArm,
            endsAt: null,
            timerId: null,
            intervalId: null,
        };
        _calWizardMinimizeForPlayback();
        _calWizardUpdateReturnButtonTimer('waiting');
        const pa = wiz.playAlong;
        if (_calWizardIsPlaybackActive()) {
            _calWizardBeginTimedPlayAlongCountdown();
            return;
        }
        pa.onPlayHandler = () => {
            const w = _calWizardState;
            if (!w || !w.playAlong || w.playAlong.phase !== 'waiting') return;
            w.playAlong.playbackSeen = true;
            _calWizardPollPlayAlongWait();
        };
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            try { window.slopsmith.on('song:play', pa.onPlayHandler); } catch (_) {}
        }
        pa.waitPollId = setInterval(_calWizardPollPlayAlongWait, _CAL_WIZARD_PLAY_ALONG_WAIT_POLL_MS);
        pa.waitTimeoutId = setTimeout(() => {
            const w = _calWizardState;
            if (!w || !w.playAlong || w.playAlong.phase !== 'waiting') return;
            _calWizardCancelTimedPlayAlongWaiting('Timed play-along cancelled — playback did not start.');
        }, _CAL_WIZARD_PLAY_ALONG_WAIT_MS);
    }

    function _calWizardFmtGain(v) {
        return Number.isFinite(v) ? `${(+v).toFixed(2)}x` : '—';
    }

    function _calWizardFmtLatencyMs(v) {
        return Number.isFinite(v) ? `${Math.round(v * 1000)} ms` : '—';
    }

    function _calWizardCompletionHtml(wiz) {
        const applied = wiz.applied;
        const appliedParts = [];
        if (applied && applied.inputGain != null) {
            appliedParts.push(`Input gain ${_calWizardFmtGain(applied.inputGain)}`);
        }
        if (applied && applied.latencyOffset != null) {
            appliedParts.push(`Detection delay ${_calWizardFmtLatencyMs(applied.latencyOffset)}`);
        }
        if (wiz.complete === 'applied') {
            const detailLine = appliedParts.length
                ? appliedParts.join(' · ')
                : 'Checked settings were applied.';
            return `
                <div class="text-center py-3 mb-4 rounded-xl bg-dark-800/90 border border-green-900/40">
                    <p class="text-xl font-bold text-white mb-2">Calibration applied</p>
                    <p class="text-sm text-gray-200 mb-1">You're done. These settings are now active.</p>
                    <p class="text-xs text-gray-400">${detailLine}</p>
                </div>
                <button type="button" class="nd-cal-done w-full py-3 bg-accent hover:bg-accent-light rounded-xl text-base font-bold text-white mb-3 shadow-lg">Done — Close Wizard</button>
                <button type="button" class="nd-cal-run-lab w-full py-2.5 bg-dark-600 hover:bg-dark-500 border border-purple-900/50 rounded-lg text-sm text-gray-300">Run Technique Assessment</button>`;
        }
        return `
            <div class="text-center py-3 mb-4 rounded-xl bg-dark-800/90 border border-gray-600">
                <p class="text-xl font-bold text-white mb-2">Calibration finished</p>
                <p class="text-sm text-gray-200">No recommended settings were applied.</p>
            </div>
            <button type="button" class="nd-cal-done w-full py-3 bg-accent hover:bg-accent-light rounded-xl text-base font-bold text-white mb-3 shadow-lg">Done — Close Wizard</button>
            <button type="button" class="nd-cal-run-lab w-full py-2.5 bg-dark-600 hover:bg-dark-500 border border-purple-900/50 rounded-lg text-sm text-gray-300">Run Technique Assessment</button>`;
    }

    function _calWizardReleaseTuner() {
        try {
            if (window.tuner && typeof window.tuner.disable === 'function') {
                window.tuner.disable();
            }
        } catch (e) {
            console.warn('[note_detect] cal wizard tuner release:', e);
        }
        if (_calWizardState) _calWizardSetTunerMinimized(false);
        if (enabled) {
            try { restartAudio(); } catch (e) {
                console.warn('[note_detect] cal wizard restartAudio after tuner release:', e);
            }
        }
    }

    function _calWizardApplySafeSettings(wiz) {
        const applied = {};
        const rec = wiz.recommended || {};
        if (wiz.applyChecked.inputGain && Number.isFinite(rec.inputGain)) {
            inputGain = Math.max(0.1, Math.min(5, rec.inputGain));
            if (gainNode) gainNode.gain.value = inputGain;
            applied.inputGain = inputGain;
        }
        if (wiz.applyChecked.latencyOffset && Number.isFinite(rec.latencyOffset)) {
            latencyOffset = Math.max(0, Math.min(0.25, rec.latencyOffset));
            applied.latencyOffset = latencyOffset;
        }
        saveSettings();
        wiz.applied = applied;
        return applied;
    }

    // Public entry: open the Calibration Wizard for a given instrument and get a
    // one-shot completion/cancel callback. Used by the input_setup onboarding
    // wizard (guitar/bass). Thin wrapper over openCalibrationWizard: sets the
    // instrument context, ensures Detect is on (the measurement steps need live
    // input), and reports the outcome. Callbacks are assigned AFTER
    // openCalibrationWizard so its internal pre-close cannot wipe them.
    function launchCalibration(opts) {
        opts = opts || {};
        const onDone = typeof opts.onDone === 'function' ? opts.onDone : null;
        const onCancel = typeof opts.onCancel === 'function' ? opts.onCancel : null;
        const forcedInstrument = (opts.instrument === 'guitar' || opts.instrument === 'bass')
            ? opts.instrument : null;
        if (forcedInstrument) currentArrangement = forcedInstrument;
        const start = () => {
            try {
                openCalibrationWizard();
            } catch (e) {
                if (onCancel) { try { onCancel('error'); } catch (_) { /* isolate */ } }
                return;
            }
            // Open AFTER openCalibrationWizard() — its first act is a pre-close
            // (calibrationWizardClose) that would otherwise drop a ref opened
            // here. Calibration must measure level / channel / latency on the
            // device the user just picked in the wizard's audio-source step, so
            // open the audio-input domain's selected source (ASIO included) — a
            // selection made since enable() is the one being calibrated.
            _ndOpenSelectedInputSource(ND_AUDIO_CAL_REQUESTER, 'calibration');
            _calWizardOnDone = onDone;
            _calWizardOnCancel = onCancel;
            // Set the arrangement override AFTER openCalibrationWizard so its
            // internal pre-close (calibrationWizardClose) can't wipe it — same
            // reason the callbacks above are assigned here. Survives
            // _syncChartStateFromHw's reset-to-guitar on every note-check resolve
            // while no real song chart is loaded (onboarding standalone).
            _calWizardForceArrangement = forcedInstrument;
        };
        // Measurement steps (noise/signal/notes) need Detect ON. Enable first;
        // fail-soft — open the wizard regardless so the caller is never stranded.
        if (!enabled) {
            let p = null;
            try { p = enable(); } catch (_) { p = null; }
            if (p && typeof p.then === 'function') p.then(start, start); else start();
        } else {
            start();
        }
    }

    function _calWizardDeviceLabel() {
        if (!selectedDeviceId) return 'Default system input';
        return `Device ${selectedDeviceId.slice(0, 12)}…`;
    }

    function _calWizardEngineChannelLabel(ch) {
        const opt = _CAL_WIZARD_INPUT_CHANNEL_OPTIONS.find((o) => o.ch === ch);
        return opt ? opt.label : `Channel ${ch}`;
    }

    function _calWizardEngineChannelDisplayLabel(ch) {
        if (ch === 0) return 'Left (Ch 1)';
        if (ch === 1) return 'Right (Ch 2)';
        return 'Default / Mono Mix';
    }

    function _calWizardPluginChannelFromEngine(ch) {
        if (ch === 0) return 'left';
        if (ch === 1) return 'right';
        return 'mono';
    }

    function _calWizardSleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function _calWizardWizardAudioApi() {
        if (usingDesktopBridge && bridgeDesktop && bridgeDesktop.audio) return bridgeDesktop.audio;
        const desktop = (typeof window !== 'undefined') ? window.slopsmithDesktop : null;
        return (desktop && desktop.audio) ? desktop.audio : null;
    }

    async function _calWizardSampleEngineLevels(durationMs, intervalMs) {
        const audio = _calWizardWizardAudioApi();
        if (!audio || typeof audio.getLevels !== 'function') {
            return { maxLevel: 0, avgLevel: 0, maxPeak: 0 };
        }
        let maxLevel = 0;
        let maxPeak = 0;
        let levelSum = 0;
        let levelCount = 0;
        const t0 = Date.now();
        while (Date.now() - t0 < durationMs) {
            try {
                const lv = await audio.getLevels();
                if (lv) {
                    const level = Number.isFinite(lv.inputLevel) ? lv.inputLevel : 0;
                    const peak = Number.isFinite(lv.inputPeak) ? lv.inputPeak : 0;
                    maxLevel = Math.max(maxLevel, level);
                    maxPeak = Math.max(maxPeak, peak);
                    levelSum += level;
                    levelCount++;
                }
            } catch (_) { /* read-only */ }
            await _calWizardSleep(intervalMs);
        }
        const avgLevel = levelCount > 0 ? levelSum / levelCount : 0;
        return { maxLevel, avgLevel, maxPeak };
    }

    function _calWizardChannelProbeTrialShortLabel(t) {
        if (!t) return '?';
        if (t.ch === -1) return 'Mono';
        if (t.ch === 0) return 'Ch 1';
        if (t.ch === 1) return 'Ch 2';
        return t.label || '?';
    }

    function _calWizardChannelProbeProgressLabel(ch) {
        if (ch === -1) return 'Mono Mix';
        if (ch === 0) return 'Ch 1';
        if (ch === 1) return 'Ch 2';
        return 'Channel';
    }

    function _calWizardChannelProbeTrialsSummary(trials) {
        if (!trials || !trials.length) return '';
        return trials.map((t) => `${_calWizardChannelProbeTrialShortLabel(t)} ${Math.round((t.maxLevel || 0) * 100)}%`).join(', ');
    }

    function _calWizardLevelsClose(a, b, ratio) {
        const hi = Math.max(a, b);
        if (hi <= 0) return true;
        return Math.abs(a - b) / hi <= ratio;
    }

    function _calWizardTrialByCh(trials, ch) {
        return trials.find((t) => t.ch === ch) || null;
    }

    function _calWizardPickChannelProbeWinner(trials) {
        if (!trials || !trials.length) return null;
        let best = trials[0];
        for (let i = 1; i < trials.length; i++) {
            const t = trials[i];
            if (t.maxLevel > best.maxLevel
                || (t.maxLevel === best.maxLevel && t.avgLevel > best.avgLevel)) {
                best = t;
            }
        }
        const mono = trials.find((t) => t.ch === -1);
        if (!mono || best.ch !== -1) return best;
        let bestSingle = null;
        for (const t of trials) {
            if (t.ch !== 0 && t.ch !== 1) continue;
            if (!bestSingle || t.maxLevel > bestSingle.maxLevel
                || (t.maxLevel === bestSingle.maxLevel && t.avgLevel > bestSingle.avgLevel)) {
                bestSingle = t;
            }
        }
        if (!bestSingle) return best;
        const hi = Math.max(mono.maxLevel, bestSingle.maxLevel);
        if (hi > 0 && Math.abs(mono.maxLevel - bestSingle.maxLevel) / hi <= _CAL_WIZARD_CHANNEL_PROBE_MONO_TIE_RATIO) {
            return bestSingle;
        }
        return best;
    }

    function _calWizardAnalyzeChannelProbeTrials(trials) {
        const ratio = _CAL_WIZARD_CHANNEL_PROBE_MONO_TIE_RATIO;
        const ch1 = _calWizardTrialByCh(trials, 0);
        const ch2 = _calWizardTrialByCh(trials, 1);
        const best = _calWizardPickChannelProbeWinner(trials);
        const ch1ch2Close = !!(ch1 && ch2
            && _calWizardLevelsClose(ch1.maxLevel, ch2.maxLevel, ratio));
        const ch1usable = !!(ch1 && ch1.maxLevel >= _CAL_WIZARD_CHANNEL_PROBE_MIN_PEAK);
        const ch2usable = !!(ch2 && ch2.maxLevel >= _CAL_WIZARD_CHANNEL_PROBE_MIN_PEAK);
        const ambiguousCh12 = ch1ch2Close && ch1usable && ch2usable;
        let suggested = ch2;
        let alternate = ch1;
        if (ch1 && ch2) {
            if (ch2.maxLevel > ch1.maxLevel) {
                suggested = ch2;
                alternate = ch1;
            } else if (ch1.maxLevel > ch2.maxLevel) {
                suggested = ch1;
                alternate = ch2;
            } else if (ch2.avgLevel > ch1.avgLevel) {
                suggested = ch2;
                alternate = ch1;
            } else if (ch1.avgLevel > ch2.avgLevel) {
                suggested = ch1;
                alternate = ch2;
            } else {
                // Exact tie — default suggestion to Ch 2 (Spark LIVE guitar path).
                suggested = ch2;
                alternate = ch1;
            }
        }
        return {
            best,
            ch1,
            ch2,
            ch1ch2Close,
            ambiguousCh12,
            suggested,
            alternate,
        };
    }

    async function _calWizardApplyEngineInputChannel(ch) {
        const audio = _calWizardWizardAudioApi();
        if (!audio || typeof audio.setInputChannel !== 'function') return false;
        await audio.setInputChannel(ch);
        if (typeof audio.loadDeviceSettings === 'function'
            && typeof audio.saveDeviceSettings === 'function') {
            try {
                const cur = await audio.loadDeviceSettings();
                const base = (cur && typeof cur === 'object') ? cur : {};
                await audio.saveDeviceSettings({
                    ...base,
                    inputChannel: String(ch),
                    savedAt: Date.now(),
                });
            } catch (e) {
                console.warn('[note_detect] cal wizard saveDeviceSettings:', e);
            }
        }
        selectedChannel = _calWizardPluginChannelFromEngine(ch);
        saveSettings();
        return true;
    }

    function _calWizardFormatChannelProbeResult(result) {
        const summary = (result && result.trials) ? _calWizardChannelProbeTrialsSummary(result.trials) : '';
        if (!result || result.ok === false) {
            return `<span class="text-amber-200/90">No strong input detected.</span> Check guitar volume, cable, Spark USB routing, input gain, or try another device.${summary ? `<div class="text-gray-500 mt-1">${summary}</div>` : ''}`;
        }
        if (result.ok === 'ambiguous') {
            const sug = Number.isFinite(result.suggestedCh)
                ? _calWizardEngineChannelDisplayLabel(result.suggestedCh)
                : '—';
            const alt = Number.isFinite(result.alternateCh)
                ? _calWizardEngineChannelDisplayLabel(result.alternateCh)
                : '—';
            return `<span class="text-amber-200/90">Ch 1 and Ch 2 are very close.</span> Suggested: ${sug}, but ${alt} is also usable. Choose the channel that matches your setup.${summary ? `<div class="text-gray-500 mt-1">${summary}</div>` : ''}`;
        }
        const levelPct = Math.round((result.bestLevel || 0) * 100);
        const peakPct = Math.round((result.bestPeak || 0) * 100);
        const disp = Number.isFinite(result.bestCh)
            ? _calWizardEngineChannelDisplayLabel(result.bestCh)
            : (result.bestLabel || '—');
        const peakNote = peakPct > levelPct ? ` (peak ${peakPct}%)` : '';
        return `<span class="text-green-300/90">Best channel: ${disp}, level ${levelPct}%${peakNote}</span>${summary ? `<div class="text-gray-500 mt-1">${summary}</div>` : ''}`;
    }

    async function _calWizardApplyChannelProbeUserPick(ch) {
        const wiz = _calWizardState;
        if (!wiz || !Number.isFinite(ch)) return;
        const applied = await _calWizardApplyEngineInputChannel(ch);
        if (!applied) return;
        const trial = wiz.channelProbeResult && wiz.channelProbeResult.trials
            ? _calWizardTrialByCh(wiz.channelProbeResult.trials, ch)
            : null;
        wiz.channelProbeResult = {
            ok: true,
            userPicked: true,
            bestCh: ch,
            bestLabel: trial ? trial.label : _calWizardEngineChannelLabel(ch),
            bestLevel: trial ? trial.maxLevel : 0,
            bestPeak: trial ? trial.maxPeak : 0,
            trials: wiz.channelProbeResult.trials,
        };
        renderCalibrationWizard();
        _calWizardRefreshLive();
    }

    async function _calWizardAutoDetectInputChannel() {
        const wiz = _calWizardState;
        if (!wiz) return;
        if (wiz.channelProbeRunning) {
            _calWizardSetChannelProbeStatus(
                '<span class="text-amber-200/90">Detection already in progress...</span>');
            return;
        }
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            wiz.channelProbeError = 'Turn Detect on first.';
            renderCalibrationWizard();
            return;
        }
        const audio = _calWizardWizardAudioApi();
        if (!usingDesktopBridge || !audio
            || typeof audio.setInputChannel !== 'function'
            || typeof audio.getLevels !== 'function') {
            wiz.channelProbeError = 'Auto-detect needs the desktop audio engine.';
            renderCalibrationWizard();
            return;
        }
        wiz.channelProbeRunning = true;
        wiz.channelProbeError = null;
        wiz.channelProbeResult = null;
        const token = {};
        wiz.channelProbeAbort = token;
        renderCalibrationWizard();
        const trials = [];
        const probeSteps = _CAL_WIZARD_INPUT_CHANNEL_OPTIONS;
        try {
            for (let i = 0; i < probeSteps.length; i++) {
                const opt = probeSteps[i];
                if (wiz.channelProbeAbort !== token) return;
                const progLabel = _calWizardChannelProbeProgressLabel(opt.ch);
                _calWizardSetChannelProbeStatus(
                    `<span class="text-cyan-300/90">Strum hard…</span> Testing <strong>${progLabel} (${i + 1} of ${probeSteps.length})</strong>…`);
                await audio.setInputChannel(opt.ch);
                if (typeof audio.resetPeaks === 'function') await audio.resetPeaks();
                await _calWizardSleep(_CAL_WIZARD_CHANNEL_PROBE_SETTLE_MS);
                const { maxLevel, avgLevel, maxPeak } = await _calWizardSampleEngineLevels(
                    _CAL_WIZARD_CHANNEL_PROBE_MS,
                    _CAL_WIZARD_CHANNEL_PROBE_INTERVAL_MS,
                );
                if (wiz.channelProbeAbort !== token) return;
                trials.push({ ch: opt.ch, label: opt.label, maxLevel, avgLevel, maxPeak });
            }
            const analysis = _calWizardAnalyzeChannelProbeTrials(trials);
            const { best, ambiguousCh12, suggested, alternate } = analysis;
            const ok = best && best.maxLevel >= _CAL_WIZARD_CHANNEL_PROBE_MIN_PEAK;
            if (!ok) {
                wiz.channelProbeResult = {
                    ok: false,
                    trials,
                    bestLevel: best ? best.maxLevel : 0,
                    bestPeak: best ? best.maxPeak : 0,
                };
            } else if (ambiguousCh12) {
                wiz.channelProbeResult = {
                    ok: 'ambiguous',
                    ambiguousCh12: true,
                    suggestedCh: suggested ? suggested.ch : null,
                    alternateCh: alternate ? alternate.ch : null,
                    trials,
                };
            } else {
                await _calWizardApplyEngineInputChannel(best.ch);
                wiz.channelProbeResult = {
                    ok: true,
                    clearWinner: true,
                    bestCh: best.ch,
                    bestLabel: best.label,
                    bestLevel: best.maxLevel,
                    bestPeak: best.maxPeak,
                    trials,
                };
            }
        } catch (e) {
            wiz.channelProbeError = (e && e.message) ? e.message : String(e);
        } finally {
            if (wiz.channelProbeAbort === token) wiz.channelProbeAbort = null;
            wiz.channelProbeRunning = false;
            renderCalibrationWizard();
            _calWizardRefreshLive();
        }
    }

    function getCalibrationSnapshot() {
        let d = null;
        try { d = _buildDiagnosticPayload(); } catch (_) { /* read-only */ }
        const hw = resolveHw();
        let avMs = null;
        try { avMs = hw && hw.getAvOffset ? hw.getAvOffset() : null; } catch (_) {}
        const teHits = (d && d.timing_error_ms_hits) ? d.timing_error_ms_hits : {};
        const total = hits + misses;
        const pitch = _calWizardRawPitchFields();
        const heardNote = pitch.rawNote;
        const heardConfPct = pitch.confidencePct;
        let hearingLine = '—';
        try { hearingLine = _ndHealthDetectedLine(); } catch (_) {}
        const sr = audioCtx && audioCtx.sampleRate
            ? Math.round(audioCtx.sampleRate)
            : (bridgeSampleRate ? Math.round(bridgeSampleRate) : null);
        return {
            enabled: !!enabled,
            inputLevelPct: Math.round((inputLevel || 0) * 100),
            inputPeakPct: Math.round((inputPeak || 0) * 100),
            hearingLine,
            heardNote,
            heardConfidencePct: heardConfPct,
            rawHeardNote: pitch.rawNote,
            displayHeardNote: pitch.displayNote,
            rawMidi: pitch.rawMidi,
            channel: pitch.channel,
            source: _ndHealthDetectorPathLabel(),
            sampleRateHz: sr,
            avOffsetMs: avMs,
            latencyOffsetMs: Math.round(latencyOffset * 1000),
            timingMedianMs: teHits.median,
            diagnostic: d,
            stats: {
                hits,
                misses,
                total,
                accuracy: total > 0 ? Math.round((hits / total) * 100) : null,
            },
            method: detectionMethod,
        };
    }

    function calibrationWizardClose() {
        // Capture launchCalibration() callback context before teardown nulls it.
        const _calHadWizard = !!_calWizardEl;
        const _calAppliedResult = (_calWizardState && _calWizardState.applied) || null;
        _calWizardStopAllStringsRun('close');
        _calWizardClearPauseRetries();
        _calWizardStopAutoCapture();
        _calWizardStopTimedPlayAlong('close');
        _calWizardReleaseTuner();
        if (_calWizardTick) {
            clearInterval(_calWizardTick);
            _calWizardTick = null;
        }
        if (_calWizardEl) {
            _calWizardEl.remove();
            _calWizardEl = null;
        }
        _calWizardState = null;
        _calWizardForceArrangement = null;
        // Fire the one-shot launchCalibration() callbacks: applied settings →
        // done, otherwise → cancel. Only when a wizard was actually open (so the
        // open-time pre-close is a no-op).
        if (_calHadWizard) {
            // Release the transient calibration input-source ref — ONLY on a real
            // close (a wizard was open). Guarding on _calHadWizard is essential:
            // openCalibrationWizard() calls this as a pre-close BEFORE the new
            // wizard's source is opened, and an unguarded close there would wipe
            // the fresh calibration ref. Live detection (if still enabled) keeps
            // its own ND_AUDIO_REQUESTER ref, so the device stays open for play.
            _ndCloseSelectedInputSource(ND_AUDIO_CAL_REQUESTER);
            const onDone = _calWizardOnDone;
            const onCancel = _calWizardOnCancel;
            _calWizardOnDone = null;
            _calWizardOnCancel = null;
            if (_calAppliedResult && typeof onDone === 'function') { try { onDone(_calAppliedResult); } catch (_) { /* isolate */ } }
            else if (typeof onCancel === 'function') { try { onCancel('closed'); } catch (_) { /* isolate */ } }
        }
    }

    function _calWizardDetectBanner(snap) {
        if (snap && snap.enabled) return '';
        return '<p class="nd-cal-detect-warn text-amber-200/90 text-xs mb-2">Turn Detect on first for live input and timing checks.</p>';
    }

    function _calWizardRefreshLive() {
        if (!_calWizardEl || !_calWizardState) return;
        const snap = getCalibrationSnapshot();
        const wiz = _calWizardState;
        const live = _calWizardEl.querySelector('.nd-cal-live-level');
        if (live) live.textContent = 'Live: ' + calibrationFormatLevel(snap.inputLevelPct, snap.inputPeakPct);
        const heard = _calWizardEl.querySelector('.nd-cal-heard');
        if (heard) {
            if (wiz.step === 5) {
                heard.textContent = snap.heardConfidencePct != null
                    ? `Now hearing: ${snap.rawHeardNote ?? snap.heardNote} · ${snap.heardConfidencePct}% confidence`
                    : `Now hearing: nothing yet — play a note · Channel: ${snap.channel || '—'} · Live: `
                    + calibrationFormatLevel(snap.inputLevelPct, snap.inputPeakPct);
            } else {
                heard.textContent = snap.heardConfidencePct != null
                    ? `Now hearing: ${snap.heardNote} · ${snap.heardConfidencePct}% confidence`
                    : `Now hearing: ${snap.hearingLine === '—' ? 'nothing yet — play a note' : snap.hearingLine}`;
            }
        }
        const debugEl = _calWizardEl.querySelector('.nd-cal-pitch-debug');
        if (debugEl) {
            if (wiz.step === 5) {
                let expectNote = '—';
                if (wiz.autoCapture && wiz.autoCapture.kind === 'note' && wiz.autoCapture.noteId) {
                    const active = _calWizardFindNoteCheckSpec(wiz.autoCapture.noteId);
                    if (active) expectNote = active.expectedNote;
                }
                if (expectNote === '—') {
                    const noteSpecs = _calWizardResolveNoteChecks({ mode: 'quick' });
                    const primary = noteSpecs[0];
                    if (primary) expectNote = primary.expectedNote;
                }
                if (snap.heardConfidencePct != null) {
                    let line = `Expected: ${expectNote} · Heard: ${snap.rawHeardNote ?? '—'}`;
                    if (snap.displayHeardNote && snap.displayHeardNote !== snap.rawHeardNote) {
                        line += ` · Display: ${snap.displayHeardNote}`;
                        const now = Date.now();
                        if (!wiz._lastPitchDbg || now - wiz._lastPitchDbg > 2000) {
                            console.debug('[cal-wizard] pitch', {
                                expected: expectNote,
                                raw: snap.rawHeardNote,
                                display: snap.displayHeardNote,
                                conf: snap.heardConfidencePct,
                                channel: snap.channel,
                            });
                            wiz._lastPitchDbg = now;
                        }
                    }
                    line += ` · Conf: ${snap.heardConfidencePct}% · Channel: ${snap.channel || '—'}`;
                    debugEl.textContent = line;
                    debugEl.classList.remove('hidden');
                } else {
                    debugEl.textContent = `Expected: ${expectNote} · Channel: ${snap.channel || '—'} · Live: `
                        + calibrationFormatLevel(snap.inputLevelPct, snap.inputPeakPct);
                    debugEl.classList.remove('hidden');
                }
            } else {
                debugEl.textContent = '';
                debugEl.classList.add('hidden');
            }
        }
        if (wiz.step === 5) {
            const rowCells = _calWizardEl.querySelectorAll('.nd-cal-all-row-result');
            if (rowCells.length) {
                const active = _calWizardActiveNoteCapture();
                const byId = {};
                _calWizardResolveNoteChecks({ mode: 'all' }).forEach((s) => { byId[s.id] = s; });
                rowCells.forEach((cell) => {
                    const id = cell.getAttribute('data-note-result');
                    if (active && active.id === id) {
                        cell.className = 'nd-cal-all-row-result text-cyan-300/90 text-[10px] text-right shrink-0';
                        cell.innerHTML = active.phase === 'countdown'
                            ? `Get ready… <strong class="text-white">${active.left}</strong>`
                            : 'Listening…';
                        return;
                    }
                    const spec = byId[id];
                    if (!spec) return;
                    const res = _calWizardNoteResultParts(spec);
                    cell.className = `nd-cal-all-row-result ${res.cls} text-[10px] text-right shrink-0`;
                    cell.textContent = res.txt;
                });
            }
        }
        const medEl = _calWizardEl.querySelector('.nd-cal-timing-median');
        if (medEl) {
            const t = wiz.timing;
            const m = t && Number.isFinite(t.medianMs) ? t.medianMs : snap.timingMedianMs;
            const n = t && t.sampleCount ? t.sampleCount : 0;
            medEl.textContent = Number.isFinite(m)
                ? `Your average timing vs chart: ${_ndFormatMs(m)} · ${n} hit samples`
                : `Your average timing vs chart: not enough hits yet (${n} samples)`;
        }
    }

    function _calWizardReviewChanges(wiz) {
        const rec = wiz.recommended || {};
        const changes = [];
        const consider = (key, label, curVal, recVal, fmt, reason) => {
            if (!Number.isFinite(recVal)) return;
            if (Number.isFinite(curVal) && Math.abs(recVal - curVal) < 0.004) return;
            changes.push({ key, label, curVal, recVal, fmt, reason: reason || '' });
        };
        consider('inputGain', 'Input gain', inputGain, rec.inputGain,
            _calWizardFmtGain, rec.reasons && rec.reasons.inputGain);
        consider('latencyOffset', 'Detection delay', latencyOffset, rec.latencyOffset,
            _calWizardFmtLatencyMs, rec.reasons && rec.reasons.latencyOffset);
        return changes;
    }

    function _calWizardReviewSummaryHtml(wiz, opts = {}) {
        const showCheckboxes = opts.showCheckboxes !== false;
        const onlyChecked = !!opts.onlyChecked;
        const changes = _calWizardReviewChanges(wiz);
        const visible = onlyChecked
            ? changes.filter((c) => wiz.applyChecked[c.key] !== false)
            : changes;
        if (!visible.length) {
            if (onlyChecked && changes.length) {
                return '<p class="text-sm text-gray-300 mb-3">No settings are selected to apply. Go back to Review to check items, or finish without applying.</p>';
            }
            return '<p class="text-sm text-gray-300 mb-3">No safe setting changes recommended — you can finish without applying.</p>';
        }
        const cards = visible.map((c) => {
            const checked = wiz.applyChecked[c.key] !== false ? 'checked' : '';
            const chk = showCheckboxes
                ? `<input type="checkbox" class="nd-cal-apply-chk accent-green-400 mt-0.5 shrink-0" data-key="${c.key}" ${checked}>`
                : '';
            return `<div class="flex items-start gap-3 p-3 rounded-lg bg-dark-800/90 border border-gray-600">
                ${chk}
                <div class="min-w-0 flex-1">
                    <div class="text-sm font-medium text-gray-100">${c.label}</div>
                    <div class="text-sm text-gray-300 mt-1">${c.fmt(c.curVal)} → <span class="text-green-300 font-mono font-medium">${c.fmt(c.recVal)}</span></div>
                </div>
            </div>`;
        }).join('');
        return `<div class="space-y-2 mb-3">${cards}</div>`;
    }

    function _calWizardReviewDetailsHtml(wiz) {
        const changes = _calWizardReviewChanges(wiz);
        if (!changes.length) return '';
        const rows = changes.map((c) => {
            const checked = wiz.applyChecked[c.key] !== false ? 'checked' : '';
            return `<tr class="border-b border-gray-700/50">
                <td class="py-1.5 pr-2 text-gray-300">${c.label}</td>
                <td class="py-1.5 text-gray-400 font-mono">${c.fmt(c.curVal)}</td>
                <td class="py-1.5 text-green-300/90 font-mono">${c.fmt(c.recVal)}</td>
                <td class="py-1.5 text-xs text-gray-400">${c.reason}</td>
                <td class="py-1.5"><input type="checkbox" class="nd-cal-apply-chk accent-green-400" data-key="${c.key}" ${checked}></td></tr>`;
        }).join('');
        return `<details class="mb-3">
            <summary class="text-sm text-gray-400 cursor-pointer hover:text-gray-200 py-1 select-none">Show technical details</summary>
            <table class="w-full text-xs mt-2"><thead><tr class="text-gray-500 text-left">
                <th class="py-1 pr-1">Setting</th><th class="pr-1">Current</th><th class="pr-1">Recommended</th><th class="pr-1">Reason</th><th>Apply</th>
            </tr></thead><tbody>${rows}</tbody></table>
        </details>`;
    }

    function renderCalibrationWizard() {
        if (!_calWizardEl || !_calWizardState) return;
        const body = _calWizardEl.querySelector('.nd-cal-body');
        const title = _calWizardEl.querySelector('.nd-cal-title');
        const backBtn = _calWizardEl.querySelector('.nd-cal-back');
        const nextBtn = _calWizardEl.querySelector('.nd-cal-next');
        if (!body || !title) return;
        const step = _calWizardState.step;
        const snap = getCalibrationSnapshot();
        const wiz = _calWizardState;
        const meta = _CAL_WIZARD_STEPS[step] || { title: 'Step' };
        title.textContent = `Calibration Wizard — ${meta.title}`;
        if (backBtn) backBtn.style.visibility = step > 0 && step < 8 ? 'visible' : 'hidden';
        if (nextBtn) {
            if (step >= 8) {
                nextBtn.style.display = 'none';
            } else {
                nextBtn.style.display = '';
                nextBtn.textContent = step === 7 ? 'Continue to Apply' : 'Next';
            }
        }
        if (step === 7) _calWizardBuildSafeRecommendations(wiz, snap);

        let html = '';
        if (step === 0) {
            html = `
                <p class="text-gray-300 text-xs mb-2"><strong class="text-gray-200">Calibration Wizard</strong> sets up your audio input, levels, and timing.</p>
                <p class="text-gray-300 text-xs mb-2"><strong class="text-gray-200">Technique Assessment</strong> (separate tool) checks how well specific playing techniques verify — bends, harmonics, palm mutes, and more.</p>
                <p class="text-gray-400 text-[10px] mb-2">This wizard may recommend <strong>input gain</strong> and <strong>detection delay (latency offset)</strong> only. It does not change scoring strictness, pitch windows, or detection thresholds.</p>
                <p class="text-gray-400 text-[10px]">Tip: turn <strong>Detect</strong> on before starting step 1.</p>`;
        } else if (step === 1) {
            const engineOk = snap.enabled && (usingDesktopBridge || audioCtx);
            const probeBusy = wiz.channelProbeRunning;
            const probeAmbiguous = wiz.channelProbeResult && wiz.channelProbeResult.ok === 'ambiguous';
            const probePickHtml = probeAmbiguous
                ? `<div class="flex flex-col gap-1 mt-2">
                    <button type="button" class="nd-cal-pick-channel w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200" data-ch="0">Ch 1 — Dry / Clean</button>
                    <button type="button" class="nd-cal-pick-channel w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200" data-ch="1">Ch 2 — Wet / FX</button>
                   </div>`
                : '';
            const probeResultBoxClass = 'nd-cal-channel-probe-result text-[11px] mt-2 p-2 rounded-lg border border-gray-600 bg-dark-800/90';
            const probeResultHtml = wiz.channelProbeResult
                ? `<div class="${probeResultBoxClass}">${_calWizardFormatChannelProbeResult(wiz.channelProbeResult)}${probePickHtml}</div>`
                : (wiz.channelProbeError
                    ? `<div class="${probeResultBoxClass} text-amber-200/90">${_ndEscapeHtml(wiz.channelProbeError)}</div>`
                    : '');
            html = `
                ${_calWizardDetectBanner(snap)}
                <p class="text-gray-300 text-xs mb-2">Confirm which input channel Slopsmith is listening to. Strum while auto-detect runs.</p>
                <div class="text-[11px] text-gray-300 font-mono space-y-1 mb-2">
                    <div>Device: ${_calWizardDeviceLabel()}</div>
                    <div>Channel: ${snap.channel || '—'}</div>
                    <div>Detector: ${snap.source || '—'}</div>
                    <div>Engine: ${engineOk ? 'Running' : 'Not ready — enable Detect'}</div>
                </div>
                <div class="nd-cal-live-level text-cyan-300/90 text-xs font-mono mb-2">Live: —</div>
                <button type="button" class="nd-cal-auto-channel w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-2${probeBusy ? ' opacity-60 cursor-not-allowed' : ''}"${probeBusy ? ' disabled' : ''}>${probeBusy ? 'Detecting...' : 'Auto-detect Channel'}</button>
                <div class="nd-cal-channel-probe-status text-[11px] text-gray-400 mb-2 min-h-[1.5rem]">${probeBusy
                    ? '<span class="text-cyan-300/90">Testing Mono Mix (1 of 3)…</span>'
                    : 'Tests Mono Mix, Ch 1 (dry), and Ch 2 (wet) on the desktop audio engine.'}</div>
                ${probeResultHtml}
                <p class="text-[10px] text-gray-500 mb-1"><strong class="text-gray-400">Desktop:</strong> this step sets the native audio engine channel (saved automatically when a winner is found).</p>
                <p class="text-[10px] text-gray-500">The <strong>Input Channel</strong> dropdown below only applies to browser microphone fallback — not desktop audio.</p>
                <p class="text-[10px] text-amber-200/80">If stuck: check USB cable, interface gain, turn Detect on, and strum loudly during the test.</p>`;
        } else if (step === 2) {
            html = `
                <p class="text-gray-300 text-xs mb-2">Tune your guitar using the bottom <strong class="text-gray-200">Tuner</strong> panel.</p>
                <p class="text-[10px] text-gray-500 mb-2">The tuner opens automatically and hides this wizard. Tap <strong>Return to Calibration Wizard</strong> when done — or use <strong>Open Tuner</strong> below to reopen it.</p>
                <p class="text-[10px] text-amber-200/80">If notes miss often later: retune here before continuing.</p>
                <button type="button" class="nd-cal-open-tuner w-full mb-2 py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200">Open Tuner</button>
                <div class="nd-cal-tuner-open-status text-[11px] mb-2 min-h-[1.5rem]"></div>
                <button type="button" class="nd-cal-tuned w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white">I'm Tuned — Continue</button>`;
        } else if (step === 3) {
            const nDone = wiz.noise && wiz.noise.captured;
            html = `
                ${_calWizardDetectBanner(snap)}
                <p class="text-gray-300 text-xs mb-2">Mute all strings and rest your hands on the strings. The wizard listens automatically after a short countdown.</p>
                <div class="nd-cal-live-level text-cyan-300/90 text-xs font-mono mb-2">Live: —</div>
                <div class="nd-cal-auto-status text-[11px] text-gray-400 mb-2 h-[2.75rem] overflow-y-auto">${nDone
                    ? `Captured: avg ${wiz.noise.avgPct}% · peak ${wiz.noise.peakPct}% · ${_calWizardNoiseStatusDisplay(wiz.noise.status)}`
                    : 'Ready to measure room noise.'}</div>
                <button type="button" class="nd-cal-start-noise w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-1">${nDone ? 'Retry Noise Capture' : 'Start Noise Capture'}</button>
                <p class="text-[10px] text-gray-500">If <strong>Too noisy</strong>: lower input gain, move away from amps/fans, or try the dry (Ch 1) input.</p>`;
        } else if (step === 4) {
            const sDone = wiz.signal && wiz.signal.captured;
            html = `
                ${_calWizardDetectBanner(snap)}
                <p class="text-gray-300 text-xs mb-2">Play your <strong class="text-gray-200">open low E</strong> at normal playing volume when prompted. Listening starts after the countdown.</p>
                <div class="nd-cal-live-level text-cyan-300/90 text-xs font-mono mb-2">Live: —</div>
                <div class="nd-cal-auto-status text-[11px] text-gray-400 mb-2 h-[2.75rem] overflow-y-auto">${sDone
                    ? `Captured: avg ${wiz.signal.avgPct}% · peak ${wiz.signal.peakPct}% · ${_calWizardSignalStatusDisplay(wiz.signal.status)}`
                    : 'Ready to measure your playing level.'}</div>
                <button type="button" class="nd-cal-start-signal w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-1">${sDone ? 'Retry Signal Capture' : 'Start Signal Capture'}</button>
                <p class="text-[10px] text-gray-500">If <strong>Too low</strong>: raise interface gain or play closer to the mic/DI. If <strong>Too hot</strong>: lower gain to avoid clipping.</p>`;
        } else if (step === 5) {
            const noteSpecs = _calWizardResolveNoteChecks({ mode: 'quick' });
            // Standalone (no song): let the player pick their instrument so the
            // open-string targets cover 5/6-string bass and 7/8-string guitar.
            const _calCtx = _calWizardResolveNoteCheckContext();
            const _instrOpts = _CAL_WIZARD_INSTRUMENT_CONFIGS.map((c) =>
                `<option value="${c.id}"${wiz.selectedInstrumentConfig === c.id ? ' selected' : ''}>${c.label}</option>`
            ).join('');
            const instrumentPickerHtml = _calCtx.hasTuning ? '' : `
                <div class="nd-cal-instrument-picker mb-2 p-2 bg-dark-700 rounded-lg border border-gray-700">
                    <label class="block text-[11px] text-gray-300 mb-1">Your instrument <span class="text-gray-500">(no song loaded)</span></label>
                    <select class="nd-cal-instrument-config w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200">
                        <option value="">— Auto (6-string guitar) —</option>
                        ${_instrOpts}
                    </select>
                    <p class="text-[9px] text-gray-500 mt-1">Pick a 4/5/6-string bass or 6/7/8-string guitar so the open-string targets match your instrument.</p>
                </div>`;
            const allStr = wiz.allStrings || _calWizardDefaultAllStringsState();
            const allRunning = !!allStr.running;
            const detailsOpen = !!(allStr.detailsOpen || allStr.running || allStr.complete || allStr.failedId);
            const noteRowHtml = (spec, compact) => {
                const res = _calWizardNoteResultParts(spec);
                const labelCls = compact ? 'text-[10px]' : 'text-xs';
                return `<div class="flex justify-between py-1 border-b border-gray-700/50 gap-2">
                    <span class="text-gray-300 ${labelCls}">${spec.label}</span>
                    <span class="${res.cls} text-[10px] text-right shrink-0">${res.txt}</span></div>`;
            };
            const noteRows = noteSpecs.map((spec) => noteRowHtml(spec, false)).join('');
            const noteButtons = noteSpecs.map((spec) =>
                `<button type="button" class="nd-cal-check-note w-full py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-200 mb-1" data-note="${spec.id}">Check ${spec.label}</button>`
            ).join('');
            const allBtnDisabled = allRunning ? ' disabled' : '';
            const allBtnDisabledCls = allRunning ? ' opacity-50 cursor-not-allowed' : '';
            // Per-string manual checks: skip the strings the quick Open low / Open
            // 2nd checks above already cover — they were redundant (tester
            // feedback). Each remaining string is one compact row: Check button +
            // label + an inline result/countdown cell so the status is never
            // scrolled off the bottom (kept live by _calWizardRefreshLive). Run-All
            // sweeps this same set, so every run target has a visible row.
            const advancedSpecs = _calWizardResolveAdvancedStringChecks();
            const active = _calWizardActiveNoteCapture();
            const allRows = advancedSpecs.map((spec) => {
                let res;
                if (active && active.id === spec.id) {
                    res = active.phase === 'countdown'
                        ? { cls: 'text-cyan-300/90', txt: `Get ready… ${active.left}` }
                        : { cls: 'text-cyan-300/90', txt: 'Listening…' };
                } else {
                    res = _calWizardNoteResultParts(spec);
                }
                return `<div class="flex items-center gap-2 py-1 border-b border-gray-700/50">
                    <button type="button" class="nd-cal-check-note-all shrink-0 px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded text-[10px] text-gray-200${allBtnDisabledCls}" data-note="${spec.id}"${allBtnDisabled}>Check</button>
                    <span class="text-gray-300 text-[10px] flex-1 min-w-0">${spec.label}</span>
                    <span class="nd-cal-all-row-result ${res.cls} text-[10px] text-right shrink-0" data-note-result="${spec.id}">${res.txt}</span>
                </div>`;
            }).join('');
            let seqStatusHtml = '';
            if (allStr.message) {
                const seqCls = allStr.complete
                    ? 'text-green-300/90'
                    : allStr.failedId
                        ? 'text-amber-200/90'
                        : 'text-cyan-300/90';
                seqStatusHtml = `<p class="text-[10px] ${seqCls} mb-2">${allStr.message}</p>`;
            }
            const runBtnLabel = allRunning ? 'Checking…' : 'Check All Remaining Strings';
            const runBtnDisabled = allRunning ? ' disabled' : '';
            const runBtnCls = allRunning ? ' opacity-60 cursor-not-allowed' : '';
            html = `
                ${_calWizardDetectBanner(snap)}
                <p class="text-gray-300 text-xs mb-2">Quick check that Slopsmith hears open strings. This is simpler than Technique Assessment — just confirms basic detection works.</p>
                <p class="text-[10px] text-gray-500 mb-2">Targets match the current song tuning. Use the same tone and pitch-shift path you will play the song with.</p>
                <p class="text-[10px] text-gray-500 mb-2">Load a song first for song tuning in the tuner.</p>
                ${instrumentPickerHtml}
                <div class="nd-cal-heard text-cyan-300/90 text-[10px] font-mono mb-2 h-[2rem] overflow-y-auto">Now hearing: —</div>
                <div class="nd-cal-pitch-debug text-[9px] text-gray-500 font-mono mb-1 hidden"></div>
                <div class="nd-cal-auto-status text-[11px] text-gray-400 mb-2 h-[2.75rem] overflow-y-auto">—</div>
                <div class="mb-2">${noteRows}</div>
                ${noteButtons}
                <details class="nd-cal-all-strings mt-3 mb-2"${detailsOpen ? ' open' : ''}>
                    <summary class="text-sm text-gray-400 cursor-pointer hover:text-gray-200 py-1 select-none">Check remaining strings (advanced)</summary>
                    <p class="text-[10px] text-gray-500 mt-2 mb-2">Optional — verify the remaining open strings against song tuning. The two lowest are covered by the Open low / Open 2nd checks above. Not required to continue.</p>
                    <button type="button" class="nd-cal-run-all-strings w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-2${runBtnCls}"${runBtnDisabled}>${runBtnLabel}</button>
                    ${seqStatusHtml}
                    <div class="mb-2">${allRows}</div>
                </details>
                <p class="text-[10px] text-gray-500">If a check fails: retune, confirm the right input channel, raise gain slightly, and try the other channel (dry vs wet).</p>`;
        } else if (step === 6) {
            const t = wiz.timing;
            const liveMed = snap.timingMedianMs;
            const liveN = (snap.diagnostic && snap.diagnostic.timing_error_ms_hits)
                ? snap.diagnostic.timing_error_ms_hits.count : 0;
            const playAlongBusy = !!(wiz.playAlong);
            html = `
                ${_calWizardDetectBanner(snap)}
                <p class="text-gray-300 text-xs mb-2"><strong class="text-gray-200">Play part of a song</strong> with Detect on so hits are scored. Tap <strong>Minimize Wizard — Play Song</strong> to reach the song highway (then <strong>Return to Calibration Wizard</strong> to come back), or <strong>Start Timed Play-Along Test</strong> for a clean ${_CAL_WIZARD_TIMED_PLAYALONG_SEC}s sample window.</p>
                <p class="text-[10px] text-gray-500 mb-2">Use the speed you normally practice. This measures input vs chart alignment, not tempo.</p>
                <div class="nd-cal-timing-median text-gray-300 text-xs mb-2">Your average timing vs chart: —</div>
                <p class="text-[10px] text-gray-500 mb-2">Live session: ${Number.isFinite(liveMed) ? _ndFormatMs(liveMed) + ' average' : 'not enough hits yet'} · ${liveN} hit samples</p>
                <p class="text-[10px] text-gray-500 mb-2"><strong class="text-gray-400">Chart/video offset</strong> (main Settings) moves notes on screen. <strong class="text-gray-400">Detection delay</strong> (latency offset) moves when your playing is judged — this step helps tune detection delay.</p>
                <p class="text-[10px] text-amber-200/80">Mostly late? Detection delay may need increasing. Mostly early? Try lowering it.</p>
                ${wiz.timingCaptureNote ? `<p class="text-[10px] text-cyan-300/90 mb-2">${wiz.timingCaptureNote}</p>` : ''}
                <button type="button" class="nd-cal-start-playalong w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-2${playAlongBusy ? ' opacity-60 cursor-not-allowed' : ''}"${playAlongBusy ? ' disabled' : ''}>Start Timed Play-Along Test (${_CAL_WIZARD_TIMED_PLAYALONG_SEC}s)</button>
                <button type="button" class="nd-cal-minimize-play w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2">Minimize Wizard — Play Song</button>
                <button type="button" class="nd-cal-reset-timing w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2">Reset Timing Samples</button>
                <button type="button" class="nd-cal-capture-timing w-full py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-1">Capture Timing Snapshot</button>
                ${t && t.captured ? `<p class="text-[10px] text-green-300/90">Stored: ${_ndFormatMs(t.medianMs)} · ${t.sampleCount} samples</p>` : ''}`;
        } else if (step === 7) {
            html = `
                <p class="text-sm text-gray-200 mb-3">Review safe recommendations. Uncheck anything you do not want applied.</p>
                ${_calWizardReviewSummaryHtml(wiz, { showCheckboxes: true })}
                ${_calWizardReviewDetailsHtml(wiz)}
                <p class="text-xs text-gray-500 mt-2"><strong class="text-gray-400">Never changed by this wizard:</strong> pitch tolerance, timing tolerance, chord leniency, clean timing/pitch thresholds, harmonic SNR, note verifier / scoring thresholds</p>`;
        } else if (step === 8) {
            if (wiz.complete) {
                html = _calWizardCompletionHtml(wiz);
            } else {
                html = `
                <p class="text-base font-medium text-gray-100 mb-3">Ready to apply recommended calibration settings.</p>
                ${_calWizardReviewSummaryHtml(wiz, { showCheckboxes: false, onlyChecked: true })}
                <p class="text-sm text-gray-400 mb-4">Apply updates input gain and/or detection delay only. Scoring strictness and detection thresholds are not changed.</p>
                <button type="button" class="nd-cal-apply-safe w-full py-3 bg-accent hover:bg-accent-light rounded-xl text-sm font-bold text-white mb-3 shadow-lg">Apply Recommended Settings</button>
                <button type="button" class="nd-cal-finish-no-apply w-full py-2.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-sm text-gray-300">Finish Without Applying</button>`;
            }
        }
        body.innerHTML = html;

        const openTuner = body.querySelector('.nd-cal-open-tuner');
        if (openTuner) {
            openTuner.onclick = () => { _calWizardOpenTunerFromWizard(); };
        }
        const tunedBtn = body.querySelector('.nd-cal-tuned');
        if (tunedBtn) {
            tunedBtn.onclick = () => {
                _calWizardReleaseTuner();
                calibrationWizardNext();
            };
        }

        const startNoise = body.querySelector('.nd-cal-start-noise');
        if (startNoise) startNoise.onclick = () => _calWizardStartNoiseCapture();

        const startSignal = body.querySelector('.nd-cal-start-signal');
        if (startSignal) startSignal.onclick = () => _calWizardStartSignalCapture();

        const autoChannel = body.querySelector('.nd-cal-auto-channel');
        if (autoChannel) {
            autoChannel.onclick = () => {
                if (_calWizardState && _calWizardState.channelProbeRunning) {
                    _calWizardSetChannelProbeStatus(
                        '<span class="text-amber-200/90">Detection already in progress...</span>');
                    return;
                }
                _calWizardAutoDetectInputChannel();
            };
        }

        body.querySelectorAll('.nd-cal-pick-channel').forEach((btn) => {
            btn.onclick = () => {
                const ch = parseInt(btn.getAttribute('data-ch'), 10);
                if (Number.isFinite(ch)) _calWizardApplyChannelProbeUserPick(ch);
            };
        });

        body.querySelectorAll('.nd-cal-check-note').forEach((btn) => {
            btn.onclick = () => {
                const id = btn.getAttribute('data-note');
                if (id) _calWizardStartNoteCapture(id);
            };
        });

        body.querySelectorAll('.nd-cal-check-note-all').forEach((btn) => {
            btn.onclick = () => {
                if (_calWizardState && _calWizardState.allStrings && _calWizardState.allStrings.running) return;
                const id = btn.getAttribute('data-note');
                if (id) _calWizardStartNoteCapture(id);
            };
        });

        const runAllStrings = body.querySelector('.nd-cal-run-all-strings');
        if (runAllStrings) {
            runAllStrings.onclick = () => {
                if (_calWizardState && _calWizardState.allStrings && _calWizardState.allStrings.running) return;
                _calWizardStartAllStringsRun();
            };
        }

        const instrSelect = body.querySelector('.nd-cal-instrument-config');
        if (instrSelect) {
            instrSelect.onchange = () => {
                if (_calWizardState) {
                    // Stop any in-flight all-strings run / countdown / auto-capture
                    // first — otherwise it can land a result for the OLD instrument
                    // into the freshly reset state after the switch.
                    _calWizardStopAllStringsRun('switch');
                    _calWizardStopAutoCapture();
                    _calWizardState.selectedInstrumentConfig = instrSelect.value || null;
                    // Expected open-string notes change with the instrument, so
                    // drop stale per-string + quick-check results.
                    _calWizardState.allStrings = _calWizardDefaultAllStringsState();
                    _calWizardState.notes = {};
                }
                renderCalibrationWizard();
            };
        }

        const resetTiming = body.querySelector('.nd-cal-reset-timing');
        if (resetTiming) {
            resetTiming.onclick = () => {
                _calWizardStopTimedPlayAlong('reset');
                try { _resetCalibrationSamples(); } catch (e) { console.warn('[note_detect] resetCalibrationSamples:', e); }
                wiz.timing = null;
                wiz.timingCaptureNote = null;
                _calWizardRefreshLive();
                renderCalibrationWizard();
            };
        }
        const capTiming = body.querySelector('.nd-cal-capture-timing');
        if (capTiming) {
            capTiming.onclick = () => {
                wiz.timingCaptureNote = null;
                _calWizardCaptureTimingSnapshot();
            };
        }

        const startPlayAlong = body.querySelector('.nd-cal-start-playalong');
        if (startPlayAlong) {
            startPlayAlong.onclick = () => _calWizardStartTimedPlayAlong(_CAL_WIZARD_TIMED_PLAYALONG_SEC);
        }

        const minimizePlay = body.querySelector('.nd-cal-minimize-play');
        if (minimizePlay) {
            minimizePlay.onclick = () => {
                _calWizardStopTimedPlayAlong('manual-minimize');
                _calWizardMinimizeForPlayback();
            };
        }

        body.querySelectorAll('.nd-cal-apply-chk').forEach((chk) => {
            chk.onchange = () => {
                const key = chk.getAttribute('data-key');
                if (key) wiz.applyChecked[key] = chk.checked;
            };
        });

        const applyBtn = body.querySelector('.nd-cal-apply-safe');
        if (applyBtn) {
            applyBtn.onclick = () => {
                _calWizardApplySafeSettings(wiz);
                wiz.complete = 'applied';
                renderCalibrationWizard();
            };
        }
        const finishNo = body.querySelector('.nd-cal-finish-no-apply');
        if (finishNo) {
            finishNo.onclick = () => {
                wiz.complete = 'finished';
                wiz.applied = null;
                renderCalibrationWizard();
            };
        }

        const doneBtn = body.querySelector('.nd-cal-done');
        if (doneBtn) doneBtn.onclick = () => calibrationWizardClose();

        const runLabBtn = body.querySelector('.nd-cal-run-lab');
        if (runLabBtn) {
            runLabBtn.onclick = () => {
                calibrationWizardClose();
                try { openInstrumentCalibrationLab(); } catch (e) {
                    console.warn('[note_detect] openInstrumentCalibrationLab:', e);
                }
            };
        }

        if (step >= 1 && step <= 6) _calWizardRefreshLive();

        // One-shot, per-step-entry reveal of the surface that lives *behind*
        // this modal (tester feedback: clicking the Tuner panel did nothing
        // because the wizard overlay covers it). On entering the Tuner step,
        // open the tuner (it minimizes the wizard). The guard is set BEFORE
        // firing so the re-render this triggers can't recurse, and a step that
        // didn't change (e.g. returning from the tuner) never re-fires.
        //
        // The Timing step does NOT auto-minimize: a later tester reported the
        // step "does not load" because the card vanished the instant they
        // reached it. The step keeps explicit "Minimize Wizard — Play Song" and
        // "Start Timed Play-Along Test" buttons (both minimize on click) so the
        // highway is still reachable on demand.
        const enteredStep = wiz._autoEnterStep !== step;
        wiz._autoEnterStep = step;
        if (enteredStep && !wiz.complete && !wiz.tunerMinimized) {
            if (step === 2) {
                _calWizardOpenTunerFromWizard();
            }
        }
    }

    function calibrationWizardNext() {
        if (!_calWizardState) return;
        _calWizardStopAllStringsRun('next');
        _calWizardStopAutoCapture();
        if (_calWizardState.step === 2) {
            _calWizardReleaseTuner();
        } else if (_calWizardState.tunerMinimized) {
            _calWizardSetTunerMinimized(false);
        }
        if (_calWizardState.step >= 8) return;
        _calWizardState.step++;
        renderCalibrationWizard();
    }

    function calibrationWizardBack() {
        if (!_calWizardState || _calWizardState.step <= 0) return;
        _calWizardStopAllStringsRun('back');
        _calWizardStopAutoCapture();
        if (_calWizardState.tunerMinimized) _calWizardSetTunerMinimized(false);
        _calWizardState.step--;
        renderCalibrationWizard();
    }

    function openCalibrationWizard() {
        calibrationWizardClose();
        _calWizardState = _calWizardNewState();
        const overlay = document.createElement('div');
        overlay.className = 'nd-cal-wizard';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.65);pointer-events:auto;';
        overlay.innerHTML = `
            <button type="button" class="nd-cal-return-wizard bg-accent hover:bg-accent-light text-white shadow-2xl border-2 border-white/25" style="display:none;pointer-events:auto;position:fixed;left:50%;transform:translateX(-50%);bottom:120px;z-index:301;padding:16px 32px;border-radius:16px;max-width:calc(100vw - 2rem);text-align:center;cursor:pointer;">
                <span class="nd-cal-return-primary block text-sm font-bold leading-tight">Return to Calibration Wizard</span>
                <span class="nd-cal-return-secondary block text-[11px] font-normal opacity-90 mt-1">Tap here to continue setup</span>
            </button>
            <div class="nd-cal-wizard-card bg-dark-700 border border-gray-600 rounded-2xl shadow-2xl text-sm" style="width:24rem;max-width:calc(100vw - 2rem);max-height:calc(100vh - 3rem);display:flex;flex-direction:column;">
                <div class="flex justify-between items-center px-4 py-3 border-b border-gray-700">
                    <span class="nd-cal-title text-gray-200 font-semibold text-xs">Calibration Wizard</span>
                    <button type="button" class="nd-cal-close text-gray-500 hover:text-white text-lg leading-none" title="Close">&times;</button>
                </div>
                <div class="nd-cal-body px-4 py-3 overflow-y-auto flex-1 text-xs"></div>
                <div class="flex gap-2 px-4 py-3 border-t border-gray-700">
                    <button type="button" class="nd-cal-back flex-1 py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300">Back</button>
                    <button type="button" class="nd-cal-next flex-1 py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white">Next</button>
                </div>
            </div>`;
        overlay.onclick = (e) => { if (e.target === overlay) calibrationWizardClose(); };
        overlay.querySelector('.nd-cal-close').onclick = () => calibrationWizardClose();
        overlay.querySelector('.nd-cal-back').onclick = () => calibrationWizardBack();
        overlay.querySelector('.nd-cal-next').onclick = () => calibrationWizardNext();
        const ret = overlay.querySelector('.nd-cal-return-wizard');
        if (ret) {
            ret.onclick = () => {
                if (_calWizardState && _calWizardState.playAlong) {
                    if (_calWizardState.playAlong.phase === 'waiting') {
                        _calWizardCancelTimedPlayAlongWaiting(
                            'Timed play-along cancelled — returned before playback started.');
                        return;
                    }
                    _calWizardFinishTimedPlayAlong(true);
                    return;
                }
                _calWizardSetTunerMinimized(false);
                _calWizardRefreshLive();
            };
        }
        document.body.appendChild(overlay);
        _calWizardEl = overlay;
        renderCalibrationWizard();
        _calWizardTick = setInterval(() => {
            if (!_calWizardEl || !_calWizardEl.isConnected) {
                calibrationWizardClose();
                return;
            }
            if (_calWizardState && !_calWizardState.tunerMinimized
                && _calWizardState.step >= 1 && _calWizardState.step <= 6) {
                _calWizardRefreshLive();
            }
        }, 200);
    }

    // ── Technique Assessment (Phase 1 — diagnostic only; was Instrument Calibration Lab) ──
    // Read-only guided probes via scoreChord harmonicVerify. Does NOT
    // change thresholds, scoring, latency, or apply settings.
    let _calLabEl = null;
    let _calLabTick = null;
    let _calLabState = null;
    let _calLabLastReport = null;

    const _CAL_LAB_FAIL = { SNR: 1, FUND: 2, PITCH: 4 };
    const _CAL_LAB_SCHEMA = 'note_detect.calibration_report.v1';
    const _CAL_LAB_MIN_CAPTURES = 3;
    const _CAL_LAB_POWER_CHORD_NOTES = [
        { s: 0, f: 0, role: 'root' },
        { s: 1, f: 2, role: 'fifth' },
    ];
    const _CAL_LAB_ADVANCED_ONLY_STEP_IDS = new Set([
        'picked', 'hammerOn', 'pullOff', 'palmMute',
        'naturalHarmonic', 'pinchHarmonic', 'halfBend', 'wholeBend', 'sustain',
    ]);
    const _CAL_LAB_BASIC_OPEN_ROWS = [
        { s: 0, f: 0, prompt: 'Play the thickest string open', btn: 'Capture thickest string' },
        { s: 1, f: 0, prompt: 'Play the next string open', btn: 'Capture next string' },
    ];
    const _CAL_LAB_BASIC_FRET_ROWS = [
        { s: 0, f: 5, prompt: 'Play the thickest string at the 5th fret', btn: 'Capture thickest string, 5th fret' },
    ];
    const _CAL_LAB_AUTO_NOISE_MS = 1800;
    const _CAL_LAB_AUTO_SIGNAL_MS = 2000;
    const _CAL_LAB_AUTO_PROBE_LISTEN_MS = 7000;
    const _CAL_LAB_AUTO_PROBE_INTERVAL_MS = 600;
    const _CAL_LAB_AUTO_PWR_LISTEN_MS = 8000;
    const _CAL_LAB_AUTO_PWR_INTERVAL_MS = 700;

    function _calLabDefaultAutoRun() {
        return {
            active: false,
            phase: 'idle',
            stepId: null,
            subIndex: 0,
            status: null,
            timerId: null,
            intervalId: null,
            inFlight: false,
            capturesThisRun: 0,
            startedAt: 0,
            listenEndsAt: 0,
            sessionId: 0,
        };
    }

    function _calLabEnsureAutoRun(st) {
        if (!st.autoRun) st.autoRun = _calLabDefaultAutoRun();
        return st.autoRun;
    }

    function _calLabStopAutoCapture(reason) {
        const st = _calLabState;
        if (!st) return;
        const ar = st.autoRun;
        if (!ar) return;
        if (ar.timerId != null) {
            clearTimeout(ar.timerId);
            ar.timerId = null;
        }
        if (ar.intervalId != null) {
            clearInterval(ar.intervalId);
            ar.intervalId = null;
        }
        ar.inFlight = false;
        if (ar.phase === 'countdown' || ar.phase === 'listening') {
            ar.phase = 'idle';
        }
        ar.active = false;
        if (reason) ar.status = reason;
    }

    function _calLabSetAutoStatus(html) {
        if (!_calLabEl) return;
        const el = _calLabEl.querySelector('.nd-cal-lab-auto-status');
        if (el) el.innerHTML = html;
    }

    function _calLabIsAutoBusy(st) {
        const ar = st && st.autoRun;
        return !!(ar && ar.active && (ar.phase === 'countdown' || ar.phase === 'listening'));
    }

    function _calLabBeginCountdownThen(seconds, label, callback) {
        const st = _calLabState;
        if (!st) return;
        const ar = _calLabEnsureAutoRun(st);
        if (ar.timerId != null) clearTimeout(ar.timerId);
        ar.active = true;
        ar.phase = 'countdown';
        let left = seconds;
        const tick = () => {
            if (!_calLabState || _calLabState !== st || !ar.active) return;
            const n = left > 0 ? String(left) : 'Go!';
            _calLabSetAutoStatus(
                `<p class="text-gray-200 text-sm mb-1">${label}</p>`
                + `<p class="text-2xl font-bold text-white text-center py-2">${n}</p>`);
            if (left <= 0) {
                ar.timerId = null;
                ar.phase = 'listening';
                callback();
                return;
            }
            left -= 1;
            ar.timerId = setTimeout(tick, 1000);
        };
        tick();
    }

    function _calLabAvgLevelSamples(samples) {
        if (!samples || !samples.length) return { avg: null, peak: null };
        let sum = 0;
        let maxPeak = 0;
        for (const s of samples) {
            sum += s.level;
            if (s.peak > maxPeak) maxPeak = s.peak;
        }
        return { avg: Math.round(sum / samples.length), peak: maxPeak };
    }

    function _calLabRunLevelSampler(durationMs, onDone) {
        const st = _calLabState;
        if (!st) return;
        const ar = _calLabEnsureAutoRun(st);
        const sessionId = ar.sessionId;
        const samples = [];
        const started = Date.now();
        ar.startedAt = started;
        ar.listenEndsAt = started + durationMs;
        if (ar.intervalId != null) clearInterval(ar.intervalId);
        if (ar.timerId != null) clearTimeout(ar.timerId);
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            if (ar.intervalId != null) {
                clearInterval(ar.intervalId);
                ar.intervalId = null;
            }
            if (ar.timerId != null) {
                clearTimeout(ar.timerId);
                ar.timerId = null;
            }
            ar.inFlight = false;
            onDone(samples, sessionId);
        };
        const tick = () => {
            if (!_calLabState || _calLabState !== st || ar.sessionId !== sessionId || !ar.active) return;
            const snap = getCalibrationSnapshot();
            samples.push({ level: snap.inputLevelPct, peak: snap.inputPeakPct, t: Date.now() });
            const elapsed = Date.now() - started;
            _calLabSetAutoStatus(
                `<span class="text-cyan-300/90">Listening…</span> ${Math.round(elapsed / 1000)}s · `
                + calibrationFormatLevel(snap.inputLevelPct, snap.inputPeakPct));
            if (elapsed >= durationMs) finish();
        };
        tick();
        ar.intervalId = setInterval(tick, 120);
        ar.timerId = setTimeout(finish, durationMs + 250);
    }

    function _calLabProbeCountForStep(st, opts) {
        const { store, noteDef, technique, multiNotes } = opts;
        if (multiNotes) {
            return ((st.techniqueCaptures && st.techniqueCaptures[technique]) || []).length;
        }
        const caps = (st[store] && st[store][noteDef.s]) || [];
        return caps.length;
    }

    function _calLabStoreProbeCapture(st, opts, cap) {
        if (!cap || !cap.ok) return false;
        const { store, noteDef, technique, multiNotes } = opts;
        if (multiNotes) {
            if (!st.techniqueCaptures) st.techniqueCaptures = {};
            if (!st.techniqueCaptures[technique]) st.techniqueCaptures[technique] = [];
            st.techniqueCaptures[technique].push(cap);
            return true;
        }
        if (!st[store]) st[store] = {};
        if (!st[store][noteDef.s]) st[store][noteDef.s] = [];
        st[store][noteDef.s].push(cap);
        return true;
    }

    function _calLabRunProbeListenWindow(opts) {
        const st = _calLabState;
        if (!st) return;
        const ar = _calLabEnsureAutoRun(st);
        const sessionId = ar.sessionId;
        const listenMs = opts.listenMs || _CAL_LAB_AUTO_PROBE_LISTEN_MS;
        const intervalMs = opts.intervalMs || _CAL_LAB_AUTO_PROBE_INTERVAL_MS;
        const minCaptures = opts.minCaptures || _CAL_LAB_MIN_CAPTURES;
        ar.phase = 'listening';
        ar.active = true;
        ar.startedAt = Date.now();
        ar.listenEndsAt = ar.startedAt + listenMs;
        ar.capturesThisRun = 0;

        let ended = false;
        const endWindow = (reason) => {
            if (ended) return;
            ended = true;
            if (ar.intervalId != null) {
                clearInterval(ar.intervalId);
                ar.intervalId = null;
            }
            if (ar.timerId != null) {
                clearTimeout(ar.timerId);
                ar.timerId = null;
            }
            ar.inFlight = false;
            ar.active = false;
            ar.phase = reason === 'stop' ? 'idle' : 'done';
            if (opts.onComplete) opts.onComplete(reason);
        };

        const tryCapture = async () => {
            if (!_calLabState || _calLabState !== st || ar.sessionId !== sessionId || !ar.active) return;
            if (ar.inFlight || Date.now() >= ar.listenEndsAt) return;
            ar.inFlight = true;
            let cap;
            try {
                if (opts.multiNotes) {
                    cap = await _calLabCaptureMulti(opts.multiNotes, opts.technique);
                } else {
                    cap = await _calLabCaptureProbe(opts.noteDef, opts.technique || opts.store);
                }
            } catch (_) {
                cap = null;
            }
            ar.inFlight = false;
            if (!_calLabState || _calLabState !== st || ar.sessionId !== sessionId) return;
            if (_calLabStoreProbeCapture(st, opts, cap)) {
                ar.capturesThisRun = _calLabProbeCountForStep(st, opts);
            }
            const count = _calLabProbeCountForStep(st, opts);
            const shortLabel = opts.shortLabel || opts.label || 'check';
            _calLabSetAutoStatus(
                `<span class="text-cyan-300/90">${shortLabel}</span> — ${count} of ${minCaptures} captures`);
            if (opts.onProgress) opts.onProgress(count);
            if (count >= minCaptures) endWindow('enough');
        };

        const tick = () => {
            if (!_calLabState || _calLabState !== st || ar.sessionId !== sessionId || !ar.active) return;
            if (Date.now() >= ar.listenEndsAt) {
                endWindow('timeout');
                return;
            }
            tryCapture();
        };

        const count = _calLabProbeCountForStep(st, opts);
        _calLabSetAutoStatus(
            `<span class="text-cyan-300/90">${opts.shortLabel || opts.label}</span> — ${count} of ${minCaptures} captures`);
        tick();
        ar.intervalId = setInterval(tick, intervalMs);
        ar.timerId = setTimeout(() => endWindow('timeout'), listenMs + 300);
    }

    function _calLabBasicAutoControlsHtml(stepKey, startLabel, busy, showRetry) {
        const hideStart = busy ? 'hidden' : '';
        const hideStop = busy ? '' : 'hidden';
        const hideRetry = showRetry && !busy ? '' : 'hidden';
        return `<div class="nd-cal-lab-auto-controls flex flex-col gap-2 mb-2">
            <button type="button" class="nd-cal-lab-auto-start ${hideStart} w-full py-2.5 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white" data-auto-step="${stepKey}">${startLabel}</button>
            <button type="button" class="nd-cal-lab-auto-retry ${hideRetry} w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200" data-auto-step="${stepKey}">Retry</button>
            <button type="button" class="nd-cal-lab-auto-stop ${hideStop} w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-amber-200/90" data-auto-step="${stepKey}">Stop</button>
        </div>`;
    }

    function _calLabUpdateBasicAutoButtons() {
        if (!_calLabEl || !_calLabState) return;
        const busy = _calLabIsAutoBusy(_calLabState);
        const start = _calLabEl.querySelector('.nd-cal-lab-auto-start');
        const retry = _calLabEl.querySelector('.nd-cal-lab-auto-retry');
        const stop = _calLabEl.querySelector('.nd-cal-lab-auto-stop');
        if (start) start.classList.toggle('hidden', busy);
        if (stop) stop.classList.toggle('hidden', !busy);
        if (retry) {
            const done = _calLabState.autoRun && _calLabState.autoRun.phase === 'done';
            retry.classList.toggle('hidden', busy || !done);
        }
        const nextBtn = _calLabEl.querySelector('.nd-cal-lab-next');
        if (nextBtn) nextBtn.disabled = busy;
    }

    function _calLabClearBasicOpenCaptures(st) {
        st.openCaptures = {};
    }

    function _calLabClearBasicFretCaptures(st) {
        st.fretCaptures = {};
    }

    function _calLabClearBasicPowerCaptures(st) {
        if (!st.techniqueCaptures) st.techniqueCaptures = {};
        st.techniqueCaptures.powerChord = [];
    }

    function _calLabStartNoiseAuto() {
        const st = _calLabState;
        if (!st) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calLabSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            return;
        }
        _calLabStopAutoCapture('restart');
        const ar = _calLabEnsureAutoRun(st);
        ar.stepId = 'noise';
        ar.sessionId = Date.now();
        ar.active = true;
        _calLabBeginCountdownThen(3, 'Get ready: mute all strings', () => {
            _calLabSetAutoStatus('<span class="text-cyan-300/90">Listening for room noise…</span>');
            _calLabRunLevelSampler(_CAL_LAB_AUTO_NOISE_MS, (samples, sessionId) => {
                if (!_calLabState || _calLabState.autoRun.sessionId !== sessionId) return;
                const { avg, peak } = _calLabAvgLevelSamples(samples);
                if (!Number.isFinite(avg)) {
                    st.autoRun.phase = 'error';
                    st.autoRun.active = false;
                    _calLabSetAutoStatus('<span class="text-amber-200/90">No samples — turn Detect on and retry.</span>');
                    _calLabUpdateBasicAutoButtons();
                    return;
                }
                st.noiseLevelPct = avg;
                st.noisePeakPct = peak;
                st.autoRun.phase = 'done';
                st.autoRun.active = false;
                const resultEl = _calLabEl && _calLabEl.querySelector('.nd-cal-lab-auto-result');
                if (resultEl) {
                    resultEl.textContent = calibrationFormatLevel(st.noiseLevelPct, st.noisePeakPct);
                }
                _calLabSetAutoStatus(
                    `<span class="text-green-300/90">Noise check complete:</span> `
                    + calibrationFormatLevel(st.noiseLevelPct, st.noisePeakPct));
                _calLabUpdateBasicAutoButtons();
            });
        });
        _calLabUpdateBasicAutoButtons();
    }

    function _calLabStartSignalAuto() {
        const st = _calLabState;
        if (!st) return;
        const snap = getCalibrationSnapshot();
        if (!snap.enabled) {
            _calLabSetAutoStatus('<span class="text-amber-200/90">Turn Detect on first.</span>');
            return;
        }
        _calLabStopAutoCapture('restart');
        const ar = _calLabEnsureAutoRun(st);
        ar.stepId = 'signal';
        ar.sessionId = Date.now();
        ar.active = true;
        _calLabBeginCountdownThen(3, 'Get ready: play the thickest string loudly', () => {
            _calLabSetAutoStatus('<span class="text-cyan-300/90">Listening for playing level…</span>');
            _calLabRunLevelSampler(_CAL_LAB_AUTO_SIGNAL_MS, (samples, sessionId) => {
                if (!_calLabState || _calLabState.autoRun.sessionId !== sessionId) return;
                const { avg, peak } = _calLabAvgLevelSamples(samples);
                if (!Number.isFinite(avg)) {
                    st.autoRun.phase = 'error';
                    st.autoRun.active = false;
                    _calLabSetAutoStatus('<span class="text-amber-200/90">No samples — turn Detect on and retry.</span>');
                    _calLabUpdateBasicAutoButtons();
                    return;
                }
                st.signalLevelPct = avg;
                st.signalPeakPct = peak;
                st.autoRun.phase = 'done';
                st.autoRun.active = false;
                const resultEl = _calLabEl && _calLabEl.querySelector('.nd-cal-lab-auto-result');
                if (resultEl) {
                    resultEl.textContent = calibrationFormatLevel(st.signalLevelPct, st.signalPeakPct);
                }
                _calLabSetAutoStatus(
                    `<span class="text-green-300/90">Signal check complete:</span> `
                    + calibrationFormatLevel(st.signalLevelPct, st.signalPeakPct));
                _calLabUpdateBasicAutoButtons();
            });
        });
        _calLabUpdateBasicAutoButtons();
    }

    function _calLabRunOpenSubPrompt() {
        const st = _calLabState;
        if (!st) return;
        const ar = _calLabEnsureAutoRun(st);
        const rows = _CAL_LAB_BASIC_OPEN_ROWS;
        if (ar.subIndex >= rows.length) {
            ar.phase = 'done';
            ar.active = false;
            _calLabSetAutoStatus('<span class="text-green-300/90">Open-string check complete.</span>');
            _calLabUpdateBasicAutoButtons();
            renderCalibrationLab();
            return;
        }
        const row = rows[ar.subIndex];
        const shortLabel = ar.subIndex === 0 ? 'Checking thickest string open' : 'Checking next string open';
        _calLabBeginCountdownThen(3, `Get ready: ${row.prompt}`, () => {
            _calLabRunProbeListenWindow({
                store: 'openCaptures',
                noteDef: { s: row.s, f: row.f },
                technique: 'openCaptures',
                label: row.prompt,
                shortLabel,
                listenMs: _CAL_LAB_AUTO_PROBE_LISTEN_MS,
                intervalMs: _CAL_LAB_AUTO_PROBE_INTERVAL_MS,
                minCaptures: _CAL_LAB_MIN_CAPTURES,
                onComplete: () => {
                    if (!_calLabState) return;
                    ar.subIndex += 1;
                    if (ar.subIndex < rows.length) {
                        _calLabRunOpenSubPrompt();
                    } else {
                        ar.phase = 'done';
                        ar.active = false;
                        _calLabSetAutoStatus('<span class="text-green-300/90">Open-string check complete.</span>');
                        _calLabUpdateBasicAutoButtons();
                        renderCalibrationLab();
                    }
                },
            });
        });
    }

    function _calLabStartOpenAuto(clearFirst) {
        const st = _calLabState;
        if (!st) return;
        if (!_calLabCanProbe()) {
            _calLabSetAutoStatus('<span class="text-amber-200/90">Turn Detect on (desktop) first.</span>');
            return;
        }
        _calLabStopAutoCapture('restart');
        if (clearFirst) _calLabClearBasicOpenCaptures(st);
        const ar = _calLabEnsureAutoRun(st);
        ar.stepId = 'open';
        ar.sessionId = Date.now();
        ar.subIndex = 0;
        ar.active = true;
        _calLabRunOpenSubPrompt();
        _calLabUpdateBasicAutoButtons();
    }

    function _calLabStartFretAuto(clearFirst) {
        const st = _calLabState;
        if (!st) return;
        if (!_calLabCanProbe()) {
            _calLabSetAutoStatus('<span class="text-amber-200/90">Turn Detect on (desktop) first.</span>');
            return;
        }
        _calLabStopAutoCapture('restart');
        if (clearFirst) _calLabClearBasicFretCaptures(st);
        const row = _CAL_LAB_BASIC_FRET_ROWS[0];
        const ar = _calLabEnsureAutoRun(st);
        ar.stepId = 'fret5';
        ar.sessionId = Date.now();
        ar.subIndex = 0;
        ar.active = true;
        _calLabBeginCountdownThen(3, `Get ready: ${row.prompt}`, () => {
            _calLabRunProbeListenWindow({
                store: 'fretCaptures',
                noteDef: { s: row.s, f: row.f },
                technique: 'fretCaptures',
                label: row.prompt,
                shortLabel: 'Checking thickest string, 5th fret',
                listenMs: _CAL_LAB_AUTO_PROBE_LISTEN_MS,
                intervalMs: _CAL_LAB_AUTO_PROBE_INTERVAL_MS,
                minCaptures: _CAL_LAB_MIN_CAPTURES,
                onComplete: () => {
                    if (!_calLabState) return;
                    ar.phase = 'done';
                    ar.active = false;
                    _calLabSetAutoStatus('<span class="text-green-300/90">Fretted-note check complete.</span>');
                    _calLabUpdateBasicAutoButtons();
                    renderCalibrationLab();
                },
            });
        });
        _calLabUpdateBasicAutoButtons();
    }

    // Resolve the concrete power chord the technique check asks for, so the
    // instruction can name the notes (tester feedback: couldn't tell it wanted
    // an E5). Power chord = thickest string open (root) + next string 2nd fret
    // (fifth). Reuses the wizard's tuning-aware resolver; falls back to the
    // standard-tuning E5 if no tuning/preset context is available.
    function _calLabPowerChordTargetLabel() {
        // Pure — resolve the two probe notes ({s0,f0} root + {s1,f2} fifth) under
        // the SAME live tuning the Lab scores against (currentArrangement /
        // currentStringCount / tuningOffsets / capo), so the named chord always
        // matches what's actually tested (standard guitar → E5; honors a loaded
        // song's tuning/capo). The "<root>5" chord name is only asserted when the
        // two notes really are a perfect fifth (7 semitones); exotic tunings
        // where the fixed s0f0+s1f2 shape isn't a fifth just name the two notes.
        // Falls back to standard-tuning E5 on any error.
        let root = 'E2', fifth = 'B2', chord = 'E5';
        try {
            if (currentStringCount >= 2) {
                const rootMidi = _ndMidiFromStringFret(0, 0, currentArrangement, currentStringCount, tuningOffsets, capo);
                const fifthMidi = _ndMidiFromStringFret(1, 2, currentArrangement, currentStringCount, tuningOffsets, capo);
                if (Number.isFinite(rootMidi) && Number.isFinite(fifthMidi)) {
                    root = _ndMidiToName(rootMidi);
                    fifth = _ndMidiToName(fifthMidi);
                    const interval = (((fifthMidi - rootMidi) % 12) + 12) % 12;
                    chord = interval === 7 ? String(root).replace(/-?\d+$/, '') + '5' : null;
                }
            }
        } catch (_) { /* keep standard-tuning fallback */ }
        const lead = chord ? `the ${chord} power chord` : 'the power chord';
        const leadHtml = chord
            ? `the <strong class="text-gray-100">${chord}</strong> power chord`
            : 'the power chord';
        return { chord, root, fifth, lead, leadHtml };
    }

    function _calLabStartPowerChordAuto(clearFirst) {
        const st = _calLabState;
        if (!st) return;
        if (!_calLabCanProbe()) {
            _calLabSetAutoStatus('<span class="text-amber-200/90">Turn Detect on (desktop) first.</span>');
            return;
        }
        _calLabStopAutoCapture('restart');
        if (clearFirst) _calLabClearBasicPowerCaptures(st);
        const ar = _calLabEnsureAutoRun(st);
        ar.stepId = 'powerChord';
        ar.sessionId = Date.now();
        ar.active = true;
        const pwr = _calLabPowerChordTargetLabel();
        _calLabBeginCountdownThen(3, `Get ready: play ${pwr.lead} (${pwr.root} open + next string 2nd fret = ${pwr.fifth})`, () => {
            _calLabRunProbeListenWindow({
                multiNotes: [{ s: 0, f: 0 }, { s: 1, f: 2 }],
                technique: 'powerChord',
                label: `Play ${pwr.lead}: ${pwr.root} open + ${pwr.fifth} (next string, 2nd fret)`,
                shortLabel: 'Power chord check',
                listenMs: _CAL_LAB_AUTO_PWR_LISTEN_MS,
                intervalMs: _CAL_LAB_AUTO_PWR_INTERVAL_MS,
                minCaptures: _CAL_LAB_MIN_CAPTURES,
                onProgress: () => {
                    const diagEl = _calLabEl && _calLabEl.querySelector('.nd-cal-lab-pwr-diag-live');
                    if (diagEl) diagEl.textContent = _calLabPowerChordSimpleDiagnosis(st);
                },
                onComplete: () => {
                    if (!_calLabState) return;
                    ar.phase = 'done';
                    ar.active = false;
                    _calLabSetAutoStatus(
                        `<span class="text-green-300/90">Power chord check complete.</span> `
                        + _calLabPowerChordSimpleDiagnosis(st));
                    _calLabUpdateBasicAutoButtons();
                    renderCalibrationLab();
                },
            });
        });
        _calLabUpdateBasicAutoButtons();
    }

    function _calLabRetryBasicAuto(stepKey) {
        if (stepKey === 'noise') _calLabStartNoiseAuto();
        else if (stepKey === 'signal') _calLabStartSignalAuto();
        else if (stepKey === 'open') _calLabStartOpenAuto(true);
        else if (stepKey === 'fret5') _calLabStartFretAuto(true);
        else if (stepKey === 'powerChord') _calLabStartPowerChordAuto(true);
    }

    function _calLabEffectivePitchTol(chartPitch, flags) {
        let cents = chartPitch;
        if (flags && (flags.b || flags.sl)) cents = Math.max(cents, 100);
        if (flags && flags.hm) cents = 0;
        return cents;
    }

    function _calLabTickFromResult(r, flags) {
        const harmonicSnr = _ND_VERIFY_HARMONIC_SNR;
        const snr = Number.isFinite(r && r.bandEnergy) ? r.bandEnergy : 0;
        const pitchTol = _calLabEffectivePitchTol(pitchTolerance, flags || {});
        const passedSnr = snr >= harmonicSnr;
        const passedFund = !!(r && r.fundamentalPresent);
        const absCents = (r && Number.isFinite(r.centsError)) ? Math.abs(r.centsError) : null;
        const passedPitch = pitchTol <= 0
            || (absCents != null && absCents <= pitchTol);
        const gatePassCount = (passedSnr ? 1 : 0) + (passedFund ? 1 : 0) + (passedPitch ? 1 : 0);
        let failedMask = 0;
        if (!passedSnr) failedMask |= _CAL_LAB_FAIL.SNR;
        if (!passedFund) failedMask |= _CAL_LAB_FAIL.FUND;
        if (!passedPitch) failedMask |= _CAL_LAB_FAIL.PITCH;
        const snrRatio = harmonicSnr > 0 ? snr / harmonicSnr : snr;
        return {
            snr,
            snrRatio,
            harmonicSnrUsed: harmonicSnr,
            fundamentalRatio: Number.isFinite(r && r.fundamentalRatio) ? r.fundamentalRatio : null,
            centsError: Number.isFinite(r && r.centsError) ? r.centsError : null,
            absCentsError: absCents,
            passedSnr,
            passedFundamental: passedFund,
            passedPitch,
            gatePassCount,
            failedGateMask: failedMask,
            hit: !!(r && r.hit),
        };
    }

    function _calLabMedian(arr) {
        if (!arr.length) return null;
        const s = [...arr].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    function _calLabAvg(arr) {
        return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    }

    function _calLabPowerChordDisplayString(stringIndex) {
        return currentStringCount - stringIndex;
    }

    function _calLabPowerChordNoteMeta(stringIndex, fret) {
        const def = _CAL_LAB_POWER_CHORD_NOTES.find((n) => n.s === stringIndex && n.f === fret);
        const disp = _calLabPowerChordDisplayString(stringIndex);
        let label;
        if (def && def.role === 'root') label = 'thickest string (root)';
        else if (def && def.role === 'fifth') label = 'next string (fifth)';
        else label = `String ${disp}`;
        let expectedNote = '—';
        try {
            const midi = _ndMidiFromStringFret(
                stringIndex, fret, currentArrangement, currentStringCount, tuningOffsets, capo);
            if (Number.isFinite(midi)) expectedNote = _ndMidiToName(midi);
        } catch (_) { /* read-only */ }
        return {
            label,
            role: def ? def.role : null,
            expectedNote,
            string: stringIndex,
            fret,
        };
    }

    function _calLabPowerChordNotePass(noteTick) {
        return !!(noteTick && (noteTick.hit || noteTick.gatePassCount === 3));
    }

    function _calLabPowerChordHeardNote(noteTick) {
        if (!noteTick || !Number.isFinite(noteTick.centsError)) return '—';
        try {
            const expectedMidi = _ndMidiFromStringFret(
                noteTick.string, noteTick.fret, currentArrangement, currentStringCount, tuningOffsets, capo);
            if (!Number.isFinite(expectedMidi)) return '—';
            return _ndMidiToName(expectedMidi + noteTick.centsError / 100);
        } catch (_) {
            return '—';
        }
    }

    function _calLabPowerChordNoteRowHtml(noteTick) {
        if (!noteTick) return '';
        const meta = _calLabPowerChordNoteMeta(noteTick.string, noteTick.fret);
        const clarity = Number.isFinite(noteTick.snrRatio) ? noteTick.snrRatio.toFixed(2) : '—';
        const heard = _calLabPowerChordHeardNote(noteTick);
        const chips = _calLabGateChipsHtml(noteTick);
        const passCls = _calLabPowerChordNotePass(noteTick)
            ? 'text-green-300/90' : 'text-amber-200/90';
        return `<div class="py-1 border-b border-gray-700/40">
            <div class="flex justify-between gap-2 text-[10px]">
                <span class="text-gray-300">${meta.label}</span>
                <span class="${passCls} shrink-0">${_calLabPowerChordNotePass(noteTick) ? 'pass' : 'fail'}</span>
            </div>
            <div class="text-[9px] text-gray-500">Expected ${meta.expectedNote} · heard ${heard} · clarity ${clarity}</div>
            ${chips ? `<div class="mt-0.5">${chips}</div>` : ''}
        </div>`;
    }

    function _calLabPowerChordCaptureBlockHtml(cap, index) {
        if (!cap || !cap.ok || !Array.isArray(cap.notes)) {
            return `<div class="text-[10px] text-amber-200/90 py-1">Capture ${index + 1}: probe failed</div>`;
        }
        const rows = cap.notes.map((n) => _calLabPowerChordNoteRowHtml(n)).join('');
        const batch = cap.batchHit
            ? '<span class="text-green-300/90">batch hit</span>'
            : '<span class="text-amber-200/90">batch miss</span>';
        return `<div class="mb-2 p-2 bg-dark-800/50 rounded border border-gray-700/40">
            <div class="text-[10px] text-gray-400 mb-1">Capture ${index + 1} · ${batch}</div>
            ${rows}
        </div>`;
    }

    function _calLabSummarizePowerChordRole(caps, role) {
        const def = _CAL_LAB_POWER_CHORD_NOTES.find((n) => n.role === role);
        if (!def) {
            return { role, n: 0, passRate: null, dominantFailure: null, failCounts: { SNR: 0, FUND: 0, PITCH: 0 } };
        }
        let passes = 0;
        let total = 0;
        const failCounts = { SNR: 0, FUND: 0, PITCH: 0 };
        for (const cap of caps) {
            if (!cap || !cap.ok || !Array.isArray(cap.notes)) continue;
            const note = cap.notes.find((n) => n.string === def.s && n.fret === def.f);
            if (!note) continue;
            total++;
            if (_calLabPowerChordNotePass(note)) passes++;
            if (note.failedGateMask & _CAL_LAB_FAIL.SNR) failCounts.SNR++;
            if (note.failedGateMask & _CAL_LAB_FAIL.FUND) failCounts.FUND++;
            if (note.failedGateMask & _CAL_LAB_FAIL.PITCH) failCounts.PITCH++;
        }
        let dominantFailure = null;
        let maxF = 0;
        for (const [k, v] of Object.entries(failCounts)) {
            if (v > maxF) { maxF = v; dominantFailure = k; }
        }
        return {
            role,
            string: def.s,
            fret: def.f,
            label: _calLabPowerChordNoteMeta(def.s, def.f).label,
            expectedNote: _calLabPowerChordNoteMeta(def.s, def.f).expectedNote,
            n: total,
            passRate: total > 0 ? passes / total : null,
            dominantFailure,
            failCounts,
        };
    }

    function _calLabSummarizePowerChordCaptures(caps) {
        const list = caps || [];
        const root = _calLabSummarizePowerChordRole(list, 'root');
        const fifth = _calLabSummarizePowerChordRole(list, 'fifth');
        const aggregate = _calLabSummarizeCaptures(list);
        return {
            ...aggregate,
            root,
            fifth,
            likelyCause: _calLabPowerChordLikelyCause({ root, fifth }),
        };
    }

    function _calLabPowerChordLikelyCause(ps) {
        if (!ps || !ps.root || !ps.fifth) return null;
        const rootRate = ps.root.passRate;
        const fifthRate = ps.fifth.passRate;
        if (rootRate == null && fifthRate == null) return null;
        const rootOk = rootRate != null && rootRate >= 0.5;
        const fifthOk = fifthRate != null && fifthRate >= 0.5;
        if (rootOk && !fifthOk) {
            if (ps.fifth.dominantFailure === 'FUND') {
                return 'Root verifies, fifth fails fundamental: distorted tone may be hiding the fifth\'s fundamental.';
            }
            if (ps.fifth.dominantFailure === 'PITCH') {
                return 'Root verifies, fifth fails pitch: tuning or pitch-shift path may not match the song.';
            }
            return 'Root verifies, fifth fails: likely masking, wet distortion, or chord voicing issue.';
        }
        if (!rootOk && fifthOk) {
            return 'Fifth verifies, root fails: low-string clarity or fundamental may be weak — check gain, palm muting, or low-string coupling.';
        }
        if (!rootOk && !fifthOk) {
            if (ps.root.dominantFailure === 'SNR' && ps.fifth.dominantFailure === 'SNR') {
                return 'Both strings fail clarity: signal may be too noisy/wet or wrong channel.';
            }
            if (ps.root.dominantFailure === 'FUND' || ps.fifth.dominantFailure === 'FUND') {
                return 'Fundamental fails: distorted tone may be hiding the fundamental.';
            }
            if (ps.root.dominantFailure === 'PITCH' || ps.fifth.dominantFailure === 'PITCH') {
                return 'Pitch fails: tuning or pitch-shift path may not match the song.';
            }
            return 'Both strings struggle to verify: check input channel, gain, and tone path.';
        }
        if (rootOk && fifthOk) {
            return 'Root and fifth both verify in probes — gameplay chord misses may be timing, chart voicing, or a different detector path.';
        }
        return null;
    }

    function _calLabPowerChordSimpleDiagnosis(st) {
        const caps = (st.techniqueCaptures && st.techniqueCaptures.powerChord) || [];
        const sum = _calLabSummarizePowerChordCaptures(caps);
        if (!sum.n) return 'No captures yet — press Capture while playing both strings.';
        const rootOk = sum.root.passRate != null && sum.root.passRate >= 0.5;
        const fifthOk = sum.fifth.passRate != null && sum.fifth.passRate >= 0.5;
        if (rootOk && fifthOk) {
            return 'Power chord: root and fifth both heard in probes.';
        }
        if (rootOk && !fifthOk) {
            return 'Power chord: root heard, fifth not heard. Try the dry/clean channel to compare.';
        }
        if (!rootOk && fifthOk) {
            return 'Power chord: fifth heard, root not heard. Check gain and low-string clarity.';
        }
        if (sum.root.dominantFailure === 'SNR' && sum.fifth.dominantFailure === 'SNR') {
            return 'Both strings failed signal clarity. Your signal may be too quiet, noisy, or on the wrong channel.';
        }
        if (sum.root.dominantFailure === 'FUND' || sum.fifth.dominantFailure === 'FUND') {
            return 'The main note is missing. Distortion may be hiding it.';
        }
        if (sum.likelyCause) return sum.likelyCause;
        return 'Power chord root/fifth check did not pass. Try the dry/clean channel to compare.';
    }

    function _calLabFormatPowerChordSum(st) {
        const caps = (st.techniqueCaptures && st.techniqueCaptures.powerChord) || [];
        const sum = _calLabSummarizePowerChordCaptures(caps);
        if (!sum.n) return 'No captures yet — press Capture while playing.';
        const rootPct = sum.root.passRate != null ? Math.round(sum.root.passRate * 100) : '—';
        const fifthPct = sum.fifth.passRate != null ? Math.round(sum.fifth.passRate * 100) : '—';
        const rootWeak = _calLabDominantFailLabel(sum.root.dominantFailure);
        const fifthWeak = _calLabDominantFailLabel(sum.fifth.dominantFailure);
        let line = `${sum.n} captures · root pass ${rootPct}% · fifth pass ${fifthPct}%`
            + ` · root weakest: ${rootWeak} · fifth weakest: ${fifthWeak}`;
        if (sum.likelyCause) line += ` · ${sum.likelyCause}`;
        return line;
    }

    function _calLabMusicianStringRowLabel(s, fret, stringName) {
        if (s === 0 && fret === 0) return 'thickest string, open';
        if (s === 1 && fret === 0) return 'next string, open';
        if (s === 0 && fret === 5) return 'thickest string, 5th fret';
        const fretTxt = fret === 0 ? 'open' : `fret ${fret}`;
        return `${stringName || 'string'} · ${fretTxt}`;
    }

    function _calLabBuildSimpleReportBullets(rep) {
        const bullets = [];
        bullets.push('This report did not change gameplay settings.');
        const hw = rep.hardware || {};
        if (Number.isFinite(hw.noise_level_pct) && hw.noise_level_pct >= 5) {
            bullets.push('Your signal is quiet or noisy — check room noise and input gain.');
        }
        if (Number.isFinite(hw.signal_level_pct) && hw.signal_level_pct < 5) {
            bullets.push('Your playing level looks low — try playing louder or raising input gain.');
        }
        let fundFails = 0;
        for (const t of (rep.per_technique || [])) {
            if (!t.summary || !t.summary.failCounts) continue;
            fundFails += t.summary.failCounts.FUND || 0;
        }
        for (const ps of (rep.per_string || [])) {
            if (ps.open && ps.open.summary && ps.open.summary.failCounts) {
                fundFails += ps.open.summary.failCounts.FUND || 0;
            }
            if (ps.fret5 && ps.fret5.summary && ps.fret5.summary.failCounts) {
                fundFails += ps.fret5.summary.failCounts.FUND || 0;
            }
        }
        if (fundFails >= 2) {
            bullets.push('The main note is missing on several tests. Distortion may be hiding it.');
        }
        const pwr = rep.power_chord_diagnostics;
        if (pwr && pwr.root && pwr.fifth) {
            const rootOk = pwr.root.passRate != null && pwr.root.passRate >= 0.5;
            const fifthOk = pwr.fifth.passRate != null && pwr.fifth.passRate >= 0.5;
            if (!rootOk || !fifthOk) {
                bullets.push('Power chord root/fifth check did not fully pass.');
            }
            if (pwr.likely_cause) {
                bullets.push(pwr.likely_cause);
            }
            if (!rootOk || !fifthOk) {
                bullets.push('Try the dry/clean channel to compare against a wet tone.');
            }
        }
        if (bullets.length === 1) {
            bullets.push('No major issues detected from your captures — review details if something still feels off.');
        }
        return bullets;
    }

    function _calLabBuildPowerChordReportSummary(caps) {
        const sum = _calLabSummarizePowerChordCaptures(caps || []);
        const snap = getCalibrationSnapshot();
        let detectorPath = null;
        try {
            if (_diagDetector && _diagDetector.path) detectorPath = _diagDetector.path;
            else if (_ndUsingEngineVerifier) detectorPath = 'desktop-engine-verifier';
        } catch (_) { /* read-only */ }
        return {
            root: sum.root,
            fifth: sum.fifth,
            likely_cause: sum.likelyCause,
            input_channel: snap.channel || selectedChannel,
            detector_path: detectorPath,
            aggregate: {
                n: sum.n,
                hitRate: sum.hitRate,
                medianSnrRatio: sum.medianSnrRatio,
                dominantFailure: sum.dominantFailure,
            },
        };
    }

    function _calLabCanProbe() {
        return !!(enabled && usingDesktopBridge && _ndBridgeScoreAvailable());
    }

    async function _calLabRunScoreProbe(notes) {
        if (!_calLabCanProbe()) return null;
        const ctx = {
            arrangement: currentArrangement,
            stringCount: currentStringCount,
            offsets: tuningOffsets.slice(0, currentStringCount),
            capo,
            pitchCheckCents: pitchTolerance,
            minHitRatio: chordHitRatio,
            bypassMl: true,
            harmonicVerify: true,
            harmonicSnr: _ND_VERIFY_HARMONIC_SNR,
            notes: notes.map((n) => ({
                s: n.s,
                f: n.f,
                ho: !!n.ho,
                po: !!n.po,
                b: !!n.b,
                sl: !!n.sl,
                hm: !!n.hm,
            })),
        };
        try {
            return await _ndBridgeScoreChord(ctx);
        } catch (e) {
            console.warn('[note_detect] cal lab scoreChord:', e);
            return null;
        }
    }

    async function _calLabCaptureProbe(noteDef, technique) {
        const batch = await _calLabRunScoreProbe([noteDef]);
        if (!batch || !Array.isArray(batch.results) || !batch.results.length) {
            return { ok: false, error: 'probe_failed' };
        }
        const r = batch.results[0];
        const flags = {
            ho: !!noteDef.ho, po: !!noteDef.po,
            b: !!noteDef.b, sl: !!noteDef.sl, hm: !!noteDef.hm,
        };
        const tick = _calLabTickFromResult(r, flags);
        return {
            ok: true,
            at: Date.now(),
            technique: technique || null,
            string: noteDef.s,
            fret: noteDef.f,
            flags,
            ...tick,
        };
    }

    async function _calLabCaptureMulti(notes, technique) {
        const batch = await _calLabRunScoreProbe(notes);
        if (!batch || !Array.isArray(batch.results)) return { ok: false, error: 'probe_failed' };
        const perNote = batch.results.map((r, i) => {
            const nd = notes[i] || { s: r.s, f: r.f };
            const flags = {
                ho: !!nd.ho, po: !!nd.po,
                b: !!nd.b, sl: !!nd.sl, hm: !!nd.hm,
            };
            return { string: nd.s, fret: nd.f, ..._calLabTickFromResult(r, flags) };
        });
        return {
            ok: true,
            at: Date.now(),
            technique: technique || null,
            notes: perNote,
            batchHit: !!batch.isHit,
        };
    }

    // Per-note ticks from a capture — supports single-note probes and multi-note
    // power-chord captures (metrics live under notes[]).
    function _calLabCaptureTicks(capture) {
        if (capture && Array.isArray(capture.notes) && capture.notes.length) {
            return capture.notes.map((n) => ({
                snrRatio: n.snrRatio,
                gatePassCount: n.gatePassCount,
                failedGateMask: n.failedGateMask,
                hit: n.hit,
            }));
        }
        return [{
            snrRatio: capture && capture.snrRatio,
            gatePassCount: capture && capture.gatePassCount,
            failedGateMask: capture && capture.failedGateMask,
            hit: capture && capture.hit,
        }];
    }

    function _calLabCaptureHit(capture) {
        if (capture && Array.isArray(capture.notes) && capture.notes.length) {
            if (capture.batchHit) return true;
            return capture.notes.every((n) => n.hit || n.gatePassCount === 3);
        }
        return !!(capture && (capture.hit || capture.gatePassCount === 3));
    }

    function _calLabSummarizeTicks(ticks, captureCount, hitRate) {
        const ratios = ticks.map((t) => t.snrRatio).filter(Number.isFinite);
        const gates = ticks.map((t) => t.gatePassCount).filter(Number.isFinite);
        const masks = ticks.map((t) => t.failedGateMask | 0);
        const failCounts = { SNR: 0, FUND: 0, PITCH: 0 };
        for (const m of masks) {
            if (m & _CAL_LAB_FAIL.SNR) failCounts.SNR++;
            if (m & _CAL_LAB_FAIL.FUND) failCounts.FUND++;
            if (m & _CAL_LAB_FAIL.PITCH) failCounts.PITCH++;
        }
        let dominantFailure = null;
        let maxF = 0;
        for (const [k, v] of Object.entries(failCounts)) {
            if (v > maxF) { maxF = v; dominantFailure = k; }
        }
        return {
            n: captureCount,
            avgSnrRatio: _calLabAvg(ratios),
            medianSnrRatio: _calLabMedian(ratios),
            bestSnrRatio: ratios.length ? Math.max(...ratios) : null,
            minSnrRatio: ratios.length ? Math.min(...ratios) : null,
            avgGatePassCount: _calLabAvg(gates),
            hitRate,
            dominantFailure,
            failCounts,
        };
    }

    function _calLabSummarizeCaptures(captures) {
        const caps = captures || [];
        const ticks = caps.flatMap((c) => _calLabCaptureTicks(c));
        const hitRate = caps.length
            ? caps.filter((c) => _calLabCaptureHit(c)).length / caps.length
            : null;
        return _calLabSummarizeTicks(ticks, caps.length, hitRate);
    }

    function _calLabSummarizeSustainSeries(series) {
        const samples = series || [];
        const ticks = samples.map((s) => ({
            snrRatio: s.snrRatio,
            gatePassCount: s.gatePassCount,
            failedGateMask: s.failedGateMask,
        }));
        const hitRate = samples.length
            ? samples.filter((s) => s.gatePassCount === 3).length / samples.length
            : null;
        return _calLabSummarizeTicks(ticks, samples.length, hitRate);
    }

    function _calLabBuildRecommendations(report) {
        const rec = [];
        const thr = report.settings && report.settings.harmonic_snr_used;
        for (const t of (report.per_technique || [])) {
            if (!t.summary || !t.summary.n) continue;
            const med = t.summary.medianSnrRatio;
            const dom = t.summary.dominantFailure;
            if (Number.isFinite(med) && thr && med < 0.9 && dom === 'SNR') {
                rec.push(`${t.label}: SNR frequently weak (median ratio ${med.toFixed(2)} vs threshold ${thr}).`);
            } else if (Number.isFinite(med) && thr && med < 1.0 && dom === 'SNR') {
                rec.push(`${t.label}: SNR often below threshold (median ratio ${med.toFixed(2)}).`);
            }
            if (dom === 'FUND' && (t.summary.failCounts.FUND || 0) >= 2) {
                rec.push(`${t.label}: fundamental gate failures common on best-frame probes.`);
            }
            if (dom === 'PITCH' && (t.summary.failCounts.PITCH || 0) >= 2) {
                rec.push(`${t.label}: pitch gate failures observed (may include bend travel).`);
            }
        }
        for (const s of (report.per_string || [])) {
            if (!s.open || !s.open.summary || !s.open.summary.n) continue;
            const med = s.open.summary.medianSnrRatio;
            if (Number.isFinite(med) && med < 0.85) {
                rec.push(`String ${s.string} open: weak SNR (median ratio ${med.toFixed(2)}).`);
            }
        }
        if (report.hardware && Number.isFinite(report.hardware.noise_level_pct)
            && report.hardware.noise_level_pct >= 5) {
            rec.push('Noise floor looks elevated — check room noise or input gain.');
        }
        if (report.hardware && Number.isFinite(report.hardware.signal_level_pct)
            && report.hardware.signal_level_pct < 5) {
            rec.push('Signal level looks low — increase interface gain or play louder.');
        }
        const halfCaps = ((report.per_technique || []).find((t) => t.id === 'halfBend') || {}).captures || [];
        const wholeCaps = ((report.per_technique || []).find((t) => t.id === 'wholeBend') || {}).captures || [];
        if (halfCaps.length || wholeCaps.length) {
            rec.push('Half bends and whole bends currently use the same native bend probe; compare results as labeled technique captures, not distinct detector modes.');
        }
        const pwrDiag = report.power_chord_diagnostics;
        if (pwrDiag && pwrDiag.root && pwrDiag.root.n >= 2 && pwrDiag.likely_cause) {
            rec.push(`Power chords: ${pwrDiag.likely_cause}`);
        }
        if (!rec.length) rec.push('No strong patterns detected — collect more captures or review per-step summaries.');
        return rec;
    }

    function _calLabBuildReport() {
        const snap = getCalibrationSnapshot();
        const st = _calLabState || {};
        const perString = [];
        for (let si = 0; si < currentStringCount; si++) {
            const openCaps = (st.openCaptures && st.openCaptures[si]) || [];
            const fretCaps = (st.fretCaptures && st.fretCaptures[si]) || [];
            perString.push({
                string: si,
                open: { captures: openCaps, summary: _calLabSummarizeCaptures(openCaps) },
                fret5: { captures: fretCaps, summary: _calLabSummarizeCaptures(fretCaps) },
            });
        }
        const techniqueKeys = [
            ['picked', 'Picked notes'],
            ['hammerOn', 'Hammer-ons'],
            ['pullOff', 'Pull-offs'],
            ['powerChord', 'Power chords'],
            ['palmMute', 'Palm mutes'],
            ['naturalHarmonic', 'Natural harmonics'],
            ['pinchHarmonic', 'Pinch harmonics'],
            ['halfBend', 'Half bends'],
            ['wholeBend', 'Whole bends'],
            ['sustain', 'Sustain / decay'],
        ];
        const perTechnique = techniqueKeys.map(([key, label]) => {
            const caps = (st.techniqueCaptures && st.techniqueCaptures[key]) || [];
            let summary;
            if (key === 'sustain' && (st.sustainSeries || []).length) {
                summary = _calLabSummarizeSustainSeries(st.sustainSeries);
            } else if (key === 'powerChord') {
                summary = _calLabSummarizePowerChordCaptures(caps);
            } else {
                summary = _calLabSummarizeCaptures(caps);
            }
            const entry = { id: key, label, captures: caps, summary };
            if (key === 'powerChord') {
                entry.per_string_summary = _calLabBuildPowerChordReportSummary(caps);
            }
            return entry;
        });
        const powerChordCaps = (st.techniqueCaptures && st.techniqueCaptures.powerChord) || [];
        const report = {
            schema: _CAL_LAB_SCHEMA,
            timestamp: new Date().toISOString(),
            plugin_version: _ND_VERSION,
            assessment_mode: st.mode || null,
            calibration_notes: [
                'Half bends and whole bends use the same native bend probe (G string fret 7, bend flag); labels distinguish technique captures only.',
            ],
            settings: {
                harmonic_snr_used: _ND_VERIFY_HARMONIC_SNR,
                pitch_tolerance_cents: pitchTolerance,
                pitch_check_cents_verify: _ND_VERIFY_PITCH_CENTS,
                timing_tolerance_s: timingTolerance,
                latency_offset_s: latencyOffset,
                input_gain: inputGain,
                method: detectionMethod,
            },
            hardware: {
                noise_level_pct: st.noiseLevelPct,
                noise_peak_pct: st.noisePeakPct,
                signal_level_pct: st.signalLevelPct,
                signal_peak_pct: st.signalPeakPct,
                sample_rate_hz: snap.sampleRateHz,
                channel: snap.channel,
                source: snap.source,
                av_offset_ms: snap.avOffsetMs,
            },
            per_string: perString,
            per_technique: perTechnique,
            sustain_series: (st.sustainSeries || []),
            power_chord_diagnostics: _calLabBuildPowerChordReportSummary(powerChordCaps),
        };
        report.recommendations = _calLabBuildRecommendations(report);
        report.simple_summary = _calLabBuildSimpleReportBullets(report);
        _calLabLastReport = report;
        return report;
    }

    function _calLabDownloadReport() {
        try {
            const payload = _calLabBuildReport();
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const ts = payload.timestamp.replace(/[:.]/g, '-').slice(0, 19);
            const a = document.createElement('a');
            a.href = url;
            a.download = `note_detect_calibration_${ts}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 500);
            return true;
        } catch (e) {
            console.warn('[note_detect] calibration report download:', e);
            return false;
        }
    }

    function calibrationLabClose() {
        _calLabStopAutoCapture('close');
        if (_calLabTick) {
            clearInterval(_calLabTick);
            _calLabTick = null;
        }
        if (_calLabEl) {
            _calLabEl.remove();
            _calLabEl = null;
        }
        _calLabState = null;
    }

    function _calLabAllStepMeta() {
        return [
            { id: 'intro', title: 'Get Started' },
            { id: 'noise', title: 'Noise Floor' },
            { id: 'signal', title: 'Signal Level' },
            { id: 'open', title: 'Open Strings' },
            { id: 'fret5', title: 'Fretted Note' },
            { id: 'picked', title: 'Picked Notes' },
            { id: 'hammerOn', title: 'Hammer-ons' },
            { id: 'pullOff', title: 'Pull-offs' },
            { id: 'powerChord', title: 'Power Chords' },
            { id: 'palmMute', title: 'Palm Mutes' },
            { id: 'naturalHarmonic', title: 'Natural Harmonics' },
            { id: 'pinchHarmonic', title: 'Pinch Harmonics' },
            { id: 'halfBend', title: 'Half Bends' },
            { id: 'wholeBend', title: 'Whole Bends' },
            { id: 'sustain', title: 'Sustain / Decay' },
            { id: 'report', title: 'Report' },
        ];
    }

    function _calLabActiveSteps(mode) {
        if (!mode) return [{ id: 'intro', title: 'Get Started' }];
        return _calLabAllStepMeta().filter((s) => {
            if (s.id === 'intro') return false;
            if (mode === 'basic') return !_CAL_LAB_ADVANCED_ONLY_STEP_IDS.has(s.id);
            return true;
        });
    }

    function _calLabStringCaptureRowHtml(st, store, s, f, label, opts) {
        const caps = (st[store] && st[store][s]) || [];
        const sum = _calLabSummarizeCaptures(caps);
        const lastCap = caps.length ? caps[caps.length - 1] : null;
        const chips = _calLabGateChipsHtml(lastCap);
        const techDetail = opts && opts.showTech
            ? `<span class="text-[9px] text-gray-600"> (s${s} f${f})</span>` : '';
        const countNote = (opts && opts.showCount)
            ? ` · ${caps.length}/${_CAL_LAB_MIN_CAPTURES} checks` : '';
        const status = caps.length
            ? (lastCap && (lastCap.hit || lastCap.gatePassCount === 3)
                ? '<span class="text-green-300/90 text-[10px]">heard</span>'
                : '<span class="text-amber-200/90 text-[10px]">not verified</span>')
            : '';
        return `<div class="flex flex-col gap-0.5 py-2 border-b border-gray-700/50">
            <p class="text-gray-300 text-xs mb-1">${label}${techDetail}</p>
            <div class="flex items-center justify-between gap-2">
                <span class="text-gray-400 text-[10px]">${countNote.trim() || 'Ready'} ${status}</span>
                <button type="button" class="nd-cal-lab-cap-str px-2 py-1 rounded text-[10px] bg-dark-600 hover:bg-dark-500 text-gray-200" data-store="${store}" data-s="${s}" data-f="${f}">${opts && opts.btnLabel ? opts.btnLabel : 'Capture'}</button>
            </div>${chips ? `<div class="mt-0.5">${chips}</div>` : ''}</div>`;
    }

    function _calLabStringLabels() {
        const labels = ['E', 'A', 'D', 'G', 'B', 'e', 'B7', 'F#'];
        const out = [];
        for (let i = 0; i < currentStringCount; i++) {
            out.push({ s: i, label: labels[i] || ('S' + i) });
        }
        return out;
    }

    function _calLabRefreshLive() {
        if (!_calLabEl || !_calLabState) return;
        const snap = getCalibrationSnapshot();
        const live = _calLabEl.querySelector('.nd-cal-lab-live');
        if (live) {
            live.textContent = 'Live: ' + calibrationFormatLevel(snap.inputLevelPct, snap.inputPeakPct)
                + (_calLabCanProbe() ? ' · ready to capture' : ' · turn Detect on (desktop) to capture');
        }
    }

    function renderCalibrationLab() {
        if (!_calLabEl || !_calLabState) return;
        const body = _calLabEl.querySelector('.nd-cal-lab-body');
        const title = _calLabEl.querySelector('.nd-cal-lab-title');
        const backBtn = _calLabEl.querySelector('.nd-cal-lab-back');
        const nextBtn = _calLabEl.querySelector('.nd-cal-lab-next');
        if (!body || !title) return;
        const st = _calLabState;
        const steps = _calLabActiveSteps(st.mode);
        const step = st.step;
        const stepDef = steps[step];
        const stepId = stepDef ? stepDef.id : 'intro';
        if (st._lastRenderStepId !== stepId || st._lastRenderMode !== st.mode) {
            _calLabStopAutoCapture('step-change');
            st._lastRenderStepId = stepId;
            st._lastRenderMode = st.mode;
        }
        const modeLabel = st.mode === 'basic' ? 'Basic' : (st.mode === 'advanced' ? 'Advanced' : '');
        title.textContent = modeLabel
            ? `Technique Assessment — ${modeLabel} · ${stepDef ? stepDef.title : 'Step'}`
            : `Technique Assessment — ${stepDef ? stepDef.title : 'Get Started'}`;
        if (backBtn) backBtn.style.visibility = (st.mode && step > 0) ? 'visible' : 'hidden';
        if (nextBtn) {
            if (!st.mode) {
                nextBtn.style.visibility = 'hidden';
                nextBtn.disabled = false;
            } else {
                nextBtn.style.visibility = 'visible';
                nextBtn.textContent = step >= steps.length - 1 ? 'Done' : 'Next';
                nextBtn.disabled = _calLabIsAutoBusy(st);
            }
        }

        let html = `<div class="nd-cal-lab-live text-cyan-300/90 text-[10px] font-mono mb-2">Live: —</div>`;
        if (!_calLabCanProbe() && st.mode && stepId !== 'report') {
            html += '<p class="text-amber-200/90 text-[10px] mb-2">Turn Detect on (desktop) to run listening checks.</p>';
        }

        if (stepId === 'intro') {
            html += `<p class="text-gray-300 text-xs mb-3"><strong class="text-gray-200">Calibration Wizard</strong> sets up your input. <strong class="text-gray-200">Technique Assessment</strong> checks how well Slopsmith hears your playing.</p>
                <p class="text-gray-300 text-xs mb-3">Each check looks at <strong class="text-gray-200">signal clarity</strong>, whether the <strong class="text-gray-200">main note</strong> is present, and <strong class="text-gray-200">tuning match</strong>. Read-only — nothing here changes gameplay settings.</p>
                <button type="button" class="nd-cal-lab-start-basic w-full py-2.5 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white mb-2">Start Basic Assessment</button>
                <p class="text-[10px] text-gray-500 mb-3">Checks input level, open strings, one fretted note, and one power chord. Best first step.</p>
                <button type="button" class="nd-cal-lab-start-advanced w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2">Advanced Assessment</button>
                <p class="text-[10px] text-gray-500">Detailed probes: hammer-ons, pull-offs, palm mutes, harmonics, bends, and sustain.</p>`;
        } else if (stepId === 'noise') {
            if (st.mode === 'basic') {
                const busy = _calLabIsAutoBusy(st);
                const done = st.autoRun && st.autoRun.phase === 'done' && st.autoRun.stepId === 'noise';
                const noiseResult = Number.isFinite(st.noiseLevelPct)
                    ? calibrationFormatLevel(st.noiseLevelPct, st.noisePeakPct) : '—';
                html += `<p class="text-gray-300 text-sm mb-2">Mute all strings. We will listen to room noise.</p>
                    ${_calLabBasicAutoControlsHtml('noise', 'Start noise check', busy, done)}
                    <div class="nd-cal-lab-auto-status text-[11px] text-gray-300 mb-2 min-h-[2.5rem]"></div>
                    <div class="nd-cal-lab-auto-result text-[11px] text-gray-400 mb-2">${noiseResult}</div>
                    <details class="mb-2"><summary class="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300 py-1">Manual capture options</summary>
                        <button type="button" class="nd-cal-lab-cap-noise w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2 mt-1">Capture room noise (manual)</button>
                    </details>`;
            } else {
                html += `<p class="text-gray-300 text-xs mb-2">Mute all strings and rest your hands on the strings.</p>
                    <button type="button" class="nd-cal-lab-cap-noise w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2">Capture room noise</button>
                    <div class="nd-cal-lab-cap-noise-txt text-[11px] text-gray-400">—</div>`;
            }
        } else if (stepId === 'signal') {
            if (st.mode === 'basic') {
                const busy = _calLabIsAutoBusy(st);
                const done = st.autoRun && st.autoRun.phase === 'done' && st.autoRun.stepId === 'signal';
                const sigResult = Number.isFinite(st.signalLevelPct)
                    ? calibrationFormatLevel(st.signalLevelPct, st.signalPeakPct) : '—';
                html += `<p class="text-gray-300 text-sm mb-2">Play the thickest string loudly.</p>
                    ${_calLabBasicAutoControlsHtml('signal', 'Start signal check', busy, done)}
                    <div class="nd-cal-lab-auto-status text-[11px] text-gray-300 mb-2 min-h-[2.5rem]"></div>
                    <div class="nd-cal-lab-auto-result text-[11px] text-gray-400 mb-2">${sigResult}</div>
                    <details class="mb-2"><summary class="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300 py-1">Manual capture options</summary>
                        <button type="button" class="nd-cal-lab-cap-signal w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2 mt-1">Capture playing level (manual)</button>
                    </details>`;
            } else {
                html += `<p class="text-gray-300 text-xs mb-2">Play the thickest string open at normal volume.</p>
                    <button type="button" class="nd-cal-lab-cap-signal w-full py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-200 mb-2">Capture playing level</button>
                    <div class="nd-cal-lab-cap-signal-txt text-[11px] text-gray-400">—</div>`;
            }
        } else if (stepId === 'open' || stepId === 'fret5') {
            const fret = stepId === 'open' ? 0 : 5;
            const store = stepId === 'open' ? 'openCaptures' : 'fretCaptures';
            if (st.mode === 'basic') {
                const rows = stepId === 'open' ? _CAL_LAB_BASIC_OPEN_ROWS : _CAL_LAB_BASIC_FRET_ROWS;
                const busy = _calLabIsAutoBusy(st);
                const autoKey = stepId === 'open' ? 'open' : 'fret5';
                const done = st.autoRun && st.autoRun.phase === 'done' && st.autoRun.stepId === autoKey;
                const startLabel = stepId === 'open' ? 'Start open-string check' : 'Start fretted-note check';
                const instruct = stepId === 'open'
                    ? 'We will check the thickest string open, then the next string open.'
                    : 'Play the thickest string at the 5th fret when prompted.';
                let summaryHtml = '';
                for (const row of rows) {
                    const caps = (st[store] && st[store][row.s]) || [];
                    const lastCap = caps.length ? caps[caps.length - 1] : null;
                    const chips = _calLabGateChipsHtml(lastCap);
                    const heard = caps.length
                        ? (lastCap && (lastCap.hit || lastCap.gatePassCount === 3)
                            ? '<span class="text-green-300/90">heard</span>'
                            : '<span class="text-amber-200/90">not verified</span>')
                        : '<span class="text-gray-500">not checked</span>';
                    summaryHtml += `<div class="py-1 border-b border-gray-700/40 text-[10px]">
                        <span class="text-gray-300">${row.prompt}</span> · ${caps.length} captures · ${heard}
                        ${chips ? `<div class="mt-0.5">${chips}</div>` : ''}</div>`;
                }
                html += `<p class="text-gray-300 text-sm mb-2">${instruct}</p>
                    ${_calLabBasicAutoControlsHtml(autoKey, startLabel, busy, done)}
                    <div class="nd-cal-lab-auto-status text-[11px] text-gray-300 mb-2 min-h-[2.5rem]"></div>
                    <div class="nd-cal-lab-auto-summary text-[10px] text-gray-400 mb-2">${summaryHtml}</div>
                    <details class="mb-2"><summary class="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300 py-1">Manual capture options</summary>
                        <div class="mt-1">`;
                for (const row of rows) {
                    html += _calLabStringCaptureRowHtml(st, store, row.s, row.f, row.prompt, {
                        btnLabel: row.btn,
                    });
                }
                html += `</div></details>`;
            } else {
                html += `<p class="text-gray-300 text-xs mb-2">Play each string ${fret === 0 ? 'open' : `at fret ${fret}`}. Capture while the note rings.</p>`;
                for (const { s, label } of _calLabStringLabels()) {
                    const musician = _calLabMusicianStringRowLabel(s, fret, label);
                    html += _calLabStringCaptureRowHtml(st, store, s, fret, musician, {
                        showTech: true,
                        showCount: true,
                        btnLabel: `Capture ${musician}`,
                    });
                }
            }
        } else if (stepId === 'picked') {
            html += `<p class="text-gray-300 text-xs mb-2">Pick single notes (e.g. 12th fret). Capture while playing.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="picked" data-s="0" data-f="12">Capture picked sample (low E @ 12)</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'picked')}</div>`;
        } else if (stepId === 'hammerOn') {
            html += `<p class="text-gray-300 text-xs mb-2">Hammer onto fret 5 on A string (from fret 3). Capture during hammer.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="hammerOn" data-s="1" data-f="5" data-ho="1">Capture hammer-on</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'hammerOn')}</div>`;
        } else if (stepId === 'pullOff') {
            html += `<p class="text-gray-300 text-xs mb-2">Pull-off from fret 5 to 3 on A string. Capture during pull-off.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="pullOff" data-s="1" data-f="3" data-po="1">Capture pull-off</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'pullOff')}</div>`;
        } else if (stepId === 'powerChord') {
            const pwrCaps = (st.techniqueCaptures && st.techniqueCaptures.powerChord) || [];
            const pwrCaptureBlocks = pwrCaps.length
                ? pwrCaps.map((cap, i) => _calLabPowerChordCaptureBlockHtml(cap, i)).join('')
                : '';
            const simpleDiag = _calLabPowerChordSimpleDiagnosis(st);
            const pwrTarget = _calLabPowerChordTargetLabel();
            if (st.mode === 'basic') {
                const busy = _calLabIsAutoBusy(st);
                const done = st.autoRun && st.autoRun.phase === 'done' && st.autoRun.stepId === 'powerChord';
                html += `<p class="text-gray-300 text-sm mb-2">Play ${pwrTarget.leadHtml} — thickest string open (<strong class="text-gray-100">${pwrTarget.root}</strong>) + next string, 2nd fret (<strong class="text-gray-100">${pwrTarget.fifth}</strong>).</p>
                    <p class="text-[10px] text-gray-500 mb-2">Try the dry/clean channel if available to compare against a wet tone.</p>
                    ${_calLabBasicAutoControlsHtml('powerChord', 'Start power-chord check', busy, done)}
                    <div class="nd-cal-lab-auto-status text-[11px] text-gray-300 mb-2 min-h-[2.5rem]"></div>
                    <p class="nd-cal-lab-pwr-diag-live text-[11px] text-gray-200 mb-2">${simpleDiag}</p>
                    ${pwrCaptureBlocks ? `<details class="mb-2"><summary class="text-[10px] text-gray-400 cursor-pointer hover:text-gray-200 py-1">Technical capture details</summary>
                        <div class="nd-cal-lab-tech-sum text-[10px] text-gray-500 mt-1 mb-2">${_calLabFormatPowerChordSum(st)}</div>
                        <div class="nd-cal-lab-pwr-captures">${pwrCaptureBlocks}</div></details>` : ''}
                    <details class="mb-2"><summary class="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300 py-1">Manual capture options</summary>
                        <button type="button" class="nd-cal-lab-cap-pwr w-full py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-200 mb-2 mt-1">Capture power chord (manual)</button>
                    </details>`;
            } else {
                html += `<p class="text-gray-300 text-xs mb-2">Play ${pwrTarget.leadHtml} — thickest string open (<strong class="text-gray-100">${pwrTarget.root}</strong>) + next string at the 2nd fret (<strong class="text-gray-100">${pwrTarget.fifth}</strong>). Capture while both ring.</p>
                    <p class="text-[10px] text-gray-500 mb-2">Power chords are tested per string. If the root passes but the fifth fails, the issue is usually masking, distortion, or channel choice — not your timing.</p>
                    <p class="text-[10px] text-gray-500 mb-2">Try the dry/clean channel if available to compare against a wet Spark tone.</p>
                    <button type="button" class="nd-cal-lab-cap-pwr w-full py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-200 mb-2">Capture power chord</button>
                    <p class="text-[11px] text-gray-200 mb-2">${simpleDiag}</p>
                    ${pwrCaptureBlocks ? `<details class="mb-2"><summary class="text-[10px] text-gray-400 cursor-pointer hover:text-gray-200 py-1">Technical capture details</summary>
                        <div class="nd-cal-lab-tech-sum text-[10px] text-gray-500 mt-1 mb-2">${_calLabFormatPowerChordSum(st)}</div>
                        <div class="nd-cal-lab-pwr-captures">${pwrCaptureBlocks}</div></details>` : ''}`;
            }
        } else if (stepId === 'palmMute') {
            html += `<p class="text-gray-300 text-xs mb-2">Palm-muted chugs on low E.</p>
                <p class="text-[10px] text-amber-200/80 mb-2">Note: charts do not flag palm mutes yet — this probe uses a picked-note context. Results show how muted playing verifies, not chart palm-mute scoring.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="palmMute" data-s="0" data-f="0">Capture palm mute</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'palmMute')}</div>`;
        } else if (stepId === 'naturalHarmonic') {
            html += `<p class="text-gray-300 text-xs mb-2">Natural harmonic at 12th fret low E. Capture lightly.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="naturalHarmonic" data-s="0" data-f="12" data-hm="1">Capture natural harmonic</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'naturalHarmonic')}</div>`;
        } else if (stepId === 'pinchHarmonic') {
            html += `<p class="text-gray-300 text-xs mb-2">Pinch harmonic on any string.</p>
                <p class="text-[10px] text-amber-200/80 mb-2">Note: charts do not flag pinch harmonics yet — this probe uses picked-note context.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="pinchHarmonic" data-s="2" data-f="7">Capture pinch harmonic</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'pinchHarmonic')}</div>`;
        } else if (stepId === 'halfBend') {
            html += `<p class="text-gray-300 text-xs mb-2">Half bend at 7th fret G string. Capture mid-bend and release.</p>
                <p class="text-[10px] text-amber-200/80 mb-2">Half and whole bends use the same detector probe — labels distinguish your technique, not separate detector modes.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="halfBend" data-s="3" data-f="7" data-b="1">Capture half bend</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'halfBend')}</div>`;
        } else if (stepId === 'wholeBend') {
            html += `<p class="text-gray-300 text-xs mb-2">Whole-step bend at 7th fret G string.</p>
                <p class="text-[10px] text-amber-200/80 mb-2">Same probe as half bends — compare results as labeled captures, not distinct modes.</p>
                <button type="button" class="nd-cal-lab-cap-tech w-full py-2 bg-dark-600 rounded text-xs mb-2" data-tech="wholeBend" data-s="3" data-f="7" data-b="1">Capture whole bend</button>
                <div class="nd-cal-lab-tech-sum text-[11px] text-gray-400">${_calLabFormatTechSum(st, 'wholeBend')}</div>`;
        } else if (stepId === 'sustain') {
            html += `<p class="text-gray-300 text-xs mb-2">Hold a note (open low E). Record polls SNR over ~1.5 s.</p>
                <button type="button" class="nd-cal-lab-cap-sustain w-full py-2 bg-accent hover:bg-accent-light rounded text-xs font-semibold text-white mb-2">Record sustain</button>
                <div class="nd-cal-lab-sustain-txt text-[11px] text-gray-400">${(st.sustainSeries || []).length} samples</div>`;
        } else if (stepId === 'report') {
            const rep = _calLabBuildReport();
            const simpleBullets = _calLabBuildSimpleReportBullets(rep);
            const simpleHtml = simpleBullets.map((t) => `<li class="text-gray-200">${t}</li>`).join('');
            const recHtml = (rep.recommendations || []).map((t) => `<li class="text-amber-200/90">${t}</li>`).join('');
            html += `<p class="text-gray-300 text-xs mb-2">Your Technique Assessment results. This did not change gameplay settings.</p>
                <ul class="text-[11px] list-disc pl-4 mb-3 space-y-1">${simpleHtml}</ul>
                <button type="button" class="nd-cal-lab-dl w-full py-2 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-200 mb-2">Download full report (JSON)</button>
                <details class="mb-2"><summary class="text-[10px] text-gray-400 cursor-pointer hover:text-gray-200 py-1">Technical details</summary>
                    <ul class="text-[10px] list-disc pl-4 mb-2 space-y-0.5 mt-2">${recHtml || '<li class="text-gray-500">No extra technical notes.</li>'}</ul>
                    <pre class="text-[9px] text-gray-500 max-h-32 overflow-auto whitespace-pre-wrap">${_calLabReportPreview(rep)}</pre>
                </details>`;
        }

        body.innerHTML = html;
        _calLabWireHandlers();
        _calLabRefreshLive();
    }

    function _calLabFormatTechSum(st, key) {
        if (key === 'powerChord') return _calLabFormatPowerChordSum(st);
        let sum;
        let lastCap = null;
        if (key === 'sustain' && (st.sustainSeries || []).length) {
            sum = _calLabSummarizeSustainSeries(st.sustainSeries);
            const s = st.sustainSeries[st.sustainSeries.length - 1];
            if (s) lastCap = { gatePassCount: s.gatePassCount, failedGateMask: s.failedGateMask };
        } else {
            const caps = (st.techniqueCaptures && st.techniqueCaptures[key]) || [];
            sum = _calLabSummarizeCaptures(caps);
            lastCap = caps.length ? caps[caps.length - 1] : null;
        }
        if (!sum.n) return 'No captures yet — press Capture while playing.';
        const unit = key === 'sustain' ? 'samples' : 'captures';
        const weak = _calLabDominantFailLabel(sum.dominantFailure);
        const chips = _calLabGateChipsHtml(lastCap);
        return `${sum.n} ${unit} · weakest area: ${weak}${chips ? ' · ' : ''}${chips}`;
    }

    function _calLabReportPreview(rep) {
        try {
            const lines = [];
            for (const t of (rep.per_technique || [])) {
                if (!t.summary || !t.summary.n) continue;
                if (t.id === 'powerChord' && t.summary.root && t.summary.fifth) {
                    const rootPct = t.summary.root.passRate != null
                        ? Math.round(t.summary.root.passRate * 100) : '—';
                    const fifthPct = t.summary.fifth.passRate != null
                        ? Math.round(t.summary.fifth.passRate * 100) : '—';
                    let line = `${t.label}: ${t.summary.n} captures · root ${rootPct}% · fifth ${fifthPct}%`;
                    if (t.summary.likelyCause) line += ` · ${t.summary.likelyCause}`;
                    lines.push(line);
                    continue;
                }
                const med = Number.isFinite(t.summary.medianSnrRatio)
                    ? t.summary.medianSnrRatio.toFixed(2) : '—';
                lines.push(`${t.label}: ${t.summary.n} captures · clarity ${med} · weakest: ${_calLabDominantFailLabel(t.summary.dominantFailure)}`);
            }
            return lines.slice(0, 12).join('\n') || '(empty)';
        } catch (_) { return ''; }
    }

    function _calLabWireHandlers() {
        if (!_calLabEl || !_calLabState) return;
        const st = _calLabState;
        const body = _calLabEl.querySelector('.nd-cal-lab-body');
        if (!body) return;

        const startBasic = body.querySelector('.nd-cal-lab-start-basic');
        if (startBasic) {
            startBasic.onclick = () => {
                _calLabStopAutoCapture('mode');
                st.mode = 'basic';
                st.step = 0;
                renderCalibrationLab();
            };
        }
        const startAdvanced = body.querySelector('.nd-cal-lab-start-advanced');
        if (startAdvanced) {
            startAdvanced.onclick = () => {
                _calLabStopAutoCapture('mode');
                st.mode = 'advanced';
                st.step = 0;
                renderCalibrationLab();
            };
        }

        body.querySelectorAll('.nd-cal-lab-auto-start').forEach((btn) => {
            btn.onclick = () => {
                const key = btn.getAttribute('data-auto-step');
                if (key === 'noise') _calLabStartNoiseAuto();
                else if (key === 'signal') _calLabStartSignalAuto();
                else if (key === 'open') _calLabStartOpenAuto(false);
                else if (key === 'fret5') _calLabStartFretAuto(false);
                else if (key === 'powerChord') _calLabStartPowerChordAuto(false);
            };
        });
        body.querySelectorAll('.nd-cal-lab-auto-retry').forEach((btn) => {
            btn.onclick = () => {
                const key = btn.getAttribute('data-auto-step');
                _calLabRetryBasicAuto(key);
            };
        });
        body.querySelectorAll('.nd-cal-lab-auto-stop').forEach((btn) => {
            btn.onclick = () => {
                _calLabStopAutoCapture('user');
                _calLabSetAutoStatus('<span class="text-gray-400">Stopped.</span>');
                _calLabUpdateBasicAutoButtons();
            };
        });

        const capNoise = body.querySelector('.nd-cal-lab-cap-noise');
        if (capNoise) {
            capNoise.onclick = () => {
                _calLabStopAutoCapture('manual');
                const s = getCalibrationSnapshot();
                st.noiseLevelPct = s.inputLevelPct;
                st.noisePeakPct = s.inputPeakPct;
                const el = body.querySelector('.nd-cal-lab-cap-noise-txt');
                if (el) el.textContent = calibrationFormatLevel(st.noiseLevelPct, st.noisePeakPct);
                const autoEl = body.querySelector('.nd-cal-lab-auto-result');
                if (autoEl) {
                    autoEl.textContent = calibrationFormatLevel(st.noiseLevelPct, st.noisePeakPct);
                }
                if (st.autoRun) {
                    st.autoRun.phase = 'done';
                    st.autoRun.stepId = 'noise';
                }
                renderCalibrationLab();
            };
        }
        const capSignal = body.querySelector('.nd-cal-lab-cap-signal');
        if (capSignal) {
            capSignal.onclick = () => {
                _calLabStopAutoCapture('manual');
                const s = getCalibrationSnapshot();
                st.signalLevelPct = s.inputLevelPct;
                st.signalPeakPct = s.inputPeakPct;
                const el = body.querySelector('.nd-cal-lab-cap-signal-txt');
                if (el) el.textContent = calibrationFormatLevel(st.signalLevelPct, st.signalPeakPct);
                const autoEl = body.querySelector('.nd-cal-lab-auto-result');
                if (autoEl) {
                    autoEl.textContent = calibrationFormatLevel(st.signalLevelPct, st.signalPeakPct);
                }
                if (st.autoRun) {
                    st.autoRun.phase = 'done';
                    st.autoRun.stepId = 'signal';
                }
                renderCalibrationLab();
            };
        }

        body.querySelectorAll('.nd-cal-lab-cap-str').forEach((btn) => {
            btn.onclick = async () => {
                _calLabStopAutoCapture('manual');
                const store = btn.getAttribute('data-store');
                const s = parseInt(btn.getAttribute('data-s'), 10);
                const f = parseInt(btn.getAttribute('data-f'), 10);
                if (!store || !Number.isInteger(s)) return;
                btn.disabled = true;
                const cap = await _calLabCaptureProbe({ s, f }, store);
                btn.disabled = false;
                if (!_calLabState || _calLabState !== st) return;
                if (cap.ok) {
                    if (!st[store]) st[store] = {};
                    if (!st[store][s]) st[store][s] = [];
                    st[store][s].push(cap);
                }
                renderCalibrationLab();
            };
        });

        body.querySelectorAll('.nd-cal-lab-cap-tech').forEach((btn) => {
            btn.onclick = async () => {
                _calLabStopAutoCapture('manual');
                const tech = btn.getAttribute('data-tech');
                const s = parseInt(btn.getAttribute('data-s'), 10);
                const f = parseInt(btn.getAttribute('data-f'), 10);
                const note = { s, f };
                if (btn.getAttribute('data-ho')) note.ho = true;
                if (btn.getAttribute('data-po')) note.po = true;
                if (btn.getAttribute('data-b')) note.b = true;
                if (btn.getAttribute('data-hm')) note.hm = true;
                btn.disabled = true;
                const cap = await _calLabCaptureProbe(note, tech);
                btn.disabled = false;
                if (cap.ok) {
                    if (!st.techniqueCaptures) st.techniqueCaptures = {};
                    if (!st.techniqueCaptures[tech]) st.techniqueCaptures[tech] = [];
                    st.techniqueCaptures[tech].push(cap);
                }
                renderCalibrationLab();
            };
        });

        const capPwr = body.querySelector('.nd-cal-lab-cap-pwr');
        if (capPwr) {
            capPwr.onclick = async () => {
                _calLabStopAutoCapture('manual');
                capPwr.disabled = true;
                const cap = await _calLabCaptureMulti([{ s: 0, f: 0 }, { s: 1, f: 2 }], 'powerChord');
                capPwr.disabled = false;
                if (!_calLabState || _calLabState !== st) return;
                if (cap.ok) {
                    if (!st.techniqueCaptures) st.techniqueCaptures = {};
                    if (!st.techniqueCaptures.powerChord) st.techniqueCaptures.powerChord = [];
                    st.techniqueCaptures.powerChord.push(cap);
                }
                renderCalibrationLab();
            };
        }

        const capSus = body.querySelector('.nd-cal-lab-cap-sustain');
        if (capSus) {
            capSus.onclick = async () => {
                capSus.disabled = true;
                if (!st.sustainSeries) st.sustainSeries = [];
                const note = { s: 0, f: 0 };
                for (let i = 0; i < 10; i++) {
                    const cap = await _calLabCaptureProbe(note, 'sustain');
                    if (cap.ok) {
                        st.sustainSeries.push({
                            tMs: i * 150,
                            snrRatio: cap.snrRatio,
                            gatePassCount: cap.gatePassCount,
                            failedGateMask: cap.failedGateMask,
                        });
                    }
                    await new Promise((r) => setTimeout(r, 150));
                }
                capSus.disabled = false;
                renderCalibrationLab();
            };
        }

        const dl = body.querySelector('.nd-cal-lab-dl');
        if (dl) dl.onclick = () => _calLabDownloadReport();
    }

    function calibrationLabNext() {
        if (!_calLabState || !_calLabState.mode) return;
        if (_calLabIsAutoBusy(_calLabState)) return;
        _calLabStopAutoCapture('next');
        const steps = _calLabActiveSteps(_calLabState.mode);
        if (_calLabState.step >= steps.length - 1) {
            calibrationLabClose();
            return;
        }
        _calLabState.step++;
        renderCalibrationLab();
    }

    function calibrationLabBack() {
        if (!_calLabState || !_calLabState.mode || _calLabState.step <= 0) return;
        if (_calLabIsAutoBusy(_calLabState)) return;
        _calLabStopAutoCapture('back');
        _calLabState.step--;
        renderCalibrationLab();
    }

    function openInstrumentCalibrationLab() {
        calibrationLabClose();
        _calLabState = {
            mode: null,
            step: 0,
            noiseLevelPct: null,
            noisePeakPct: null,
            signalLevelPct: null,
            signalPeakPct: null,
            openCaptures: {},
            fretCaptures: {},
            techniqueCaptures: {},
            sustainSeries: [],
            autoRun: _calLabDefaultAutoRun(),
        };
        const overlay = document.createElement('div');
        overlay.className = 'nd-cal-lab';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:301;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.65);pointer-events:auto;';
        overlay.innerHTML = `
            <div class="bg-dark-700 border border-gray-600 rounded-2xl shadow-2xl text-sm" style="width:24rem;max-width:calc(100vw - 2rem);max-height:calc(100vh - 3rem);display:flex;flex-direction:column;">
                <div class="flex justify-between items-center px-4 py-3 border-b border-gray-700">
                    <span class="nd-cal-lab-title text-gray-200 font-semibold text-xs">Technique Assessment</span>
                    <button type="button" class="nd-cal-lab-close text-gray-500 hover:text-white text-lg leading-none">&times;</button>
                </div>
                <div class="nd-cal-lab-body px-4 py-3 overflow-y-auto flex-1 text-xs"></div>
                <div class="flex gap-2 px-4 py-3 border-t border-gray-700">
                    <button type="button" class="nd-cal-lab-back flex-1 py-2 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300">Back</button>
                    <button type="button" class="nd-cal-lab-next flex-1 py-2 bg-accent hover:bg-accent-light rounded-lg text-xs font-semibold text-white">Next</button>
                </div>
            </div>`;
        overlay.onclick = (e) => { if (e.target === overlay) calibrationLabClose(); };
        overlay.querySelector('.nd-cal-lab-close').onclick = () => calibrationLabClose();
        overlay.querySelector('.nd-cal-lab-back').onclick = () => calibrationLabBack();
        overlay.querySelector('.nd-cal-lab-next').onclick = () => calibrationLabNext();
        document.body.appendChild(overlay);
        _calLabEl = overlay;
        renderCalibrationLab();
        _calLabTick = setInterval(() => {
            if (!_calLabEl || !_calLabEl.isConnected) {
                calibrationLabClose();
                return;
            }
            _calLabRefreshLive();
        }, 200);
    }

    function getCalibrationReport() {
        try {
            return _calLabLastReport || (_calLabState ? _calLabBuildReport() : null);
        } catch (_) {
            return null;
        }
    }

    // slopsmith#502 — scrollable gear popover steals horizontal drags from
    // range sliders. Lock panel scroll while a slider is active; UI-only.
    function _ndWireSettingsRangeScrollLock(panel) {
        if (!panel || panel._ndRangeScrollLock) return;
        panel._ndRangeScrollLock = true;

        const release = () => {
            panel.style.overflowY = 'auto';
            panel.classList.remove('nd-settings-panel--slider-drag');
        };

        for (const el of panel.querySelectorAll('input[type=range]')) {
            el.style.touchAction = 'none';
            el.style.userSelect = 'none';

            el.addEventListener('pointerdown', (e) => {
                panel.style.overflowY = 'hidden';
                panel.classList.add('nd-settings-panel--slider-drag');
                try { el.setPointerCapture(e.pointerId); } catch (_) { /* host */ }
            });

            el.addEventListener('pointerup', release);
            el.addEventListener('pointercancel', release);
            el.addEventListener('lostpointercapture', release);
        }
    }

    // ── Settings panel ────────────────────────────────────────────────
    function showSettings() {
        attachInstanceRoot();

        let panel = document.querySelector('.nd-settings-panel');
        if (panel) {
            if (panel._ndHealthTick) {
                clearInterval(panel._ndHealthTick);
                panel._ndHealthTick = null;
            }
            _vuSetPanel(null);
            if (panel.isConnected) {
                panel.remove();
                return;
            }
            panel.remove();
        }

        panel = document.createElement('div');
        // Position/size via inline styles — several Tailwind utilities used
        // here (top-16, right-4, w-80, z-[150]) are not in the built
        // slopsmith CSS bundle, so class-only styling left the panel
        // unboxed and its labels flowed over the highway. Mount on
        // document.body so fixed placement is relative to the viewport.
        panel.className = 'nd-settings-panel bg-dark-700 border border-gray-600 rounded-xl p-4 shadow-2xl text-sm';
        panel.style.pointerEvents = 'auto';
        panel.style.position = 'fixed';
        panel.style.top = '4rem';
        panel.style.right = '1rem';
        panel.style.zIndex = '250';
        panel.style.width = '20rem';
        panel.style.maxWidth = 'calc(100vw - 2rem)';
        panel.style.maxHeight = 'calc(100vh - 5rem)';
        panel.style.overflowY = 'auto';
        // The native-frame detection toggle only does something on a desktop
        // build whose engine exposes the raw-audio-frame pull this instance
        // would use — hide it entirely in the browser / on a downlevel addon
        // so it can't read as a dead switch.
        //
        // This check must be session-independent (the settings panel can open
        // while Detect is off, when bridgeDesktop is null and
        // _ndBridgeRawFramesAvailable() always returns false). Probe
        // window.slopsmithDesktop directly and accept either getRawAudioFrame
        // (default / unbound source) or getSourceRawAudioFrame (source-bound /
        // splitscreen / multi-input), so the toggle is shown for any capable
        // desktop build regardless of audio session state.
        //
        // Edge case: a source-bound instance on an addon that has
        // getRawAudioFrame but not getSourceRawAudioFrame would see the toggle
        // even though it cannot enter native-frame mode (startAudio() requires
        // getSourceRawAudioFrame for bound sources). This is accepted: in
        // practice, source binding requires a newer addon that has BOTH APIs,
        // so the scenario never arises in field builds. The alternative —
        // hiding the toggle for all unbound instances on such an addon — is
        // a worse trade-off.
        const _ndCanNativeFrames = (function () {
            const d = (typeof window !== 'undefined') ? window.slopsmithDesktop : null;
            const a = d && d.isDesktop && d.audio;
            if (!a) return false;
            return typeof a.getRawAudioFrame === 'function'
                || typeof a.getSourceRawAudioFrame === 'function';
        })();
        panel.innerHTML = `
            <div class="flex justify-between items-center mb-3">
                <span class="text-gray-200 font-semibold">Note Detection Settings</span>
                <button class="nd-settings-close text-gray-500 hover:text-white">&times;</button>
            </div>

            <div class="nd-health-block bg-dark-600/40 border border-gray-700 rounded-lg p-3 mb-3 text-[11px] text-gray-300 leading-snug">
                <div class="text-gray-200 text-xs font-semibold uppercase tracking-wider mb-2">Detection Health</div>
                <div class="nd-health-status text-gray-400 mb-1">—</div>
                <div class="nd-health-input text-gray-400 mb-1">—</div>
                <div class="nd-health-hearing text-cyan-300/90 mb-1 font-mono text-[10px]">—</div>
                <div class="nd-health-session text-gray-300 mb-1">—</div>
                <div class="nd-health-top-miss text-gray-400 mb-1">—</div>
                <div class="nd-health-align text-gray-400 mb-1">—</div>
                <div class="nd-health-level text-gray-400 mb-1">—</div>
                <div class="text-gray-200 text-[10px] font-semibold uppercase tracking-wider mt-2 mb-1">Recent notes that did not verify</div>
                <div class="nd-health-rejects text-gray-400 text-[10px] whitespace-pre-line leading-snug mb-1">—</div>
                <div class="nd-health-hint text-amber-200/90 mt-2 pt-2 border-t border-gray-700/80">—</div>
                <div class="text-[10px] text-gray-500 mt-1 leading-tight">Read-only health stats. Use the diagnostic track for playthrough assessment, Calibration Wizard for setup, and Advanced Signal Check for deeper signal detail.</div>
                <div class="text-[10px] text-gray-500 mt-2 mb-1 leading-tight">Play a short built-in track to check timing, open strings, fretted notes, and power chords on the highway.</div>
                <button type="button" class="nd-diag-launch-basic w-full py-2 bg-dark-600 hover:bg-dark-500 border border-cyan-900/50 rounded-lg text-xs text-gray-200 transition">
                    Run Basic Guitar Diagnostic
                </button>
                <div class="nd-health-diag-launch-status text-[10px] text-cyan-200/90 mt-1 mb-2 leading-snug"></div>
                <div class="text-[10px] text-gray-500 mb-1 leading-tight">Set up audio input, levels, and timing before you play.</div>
                <button type="button" class="nd-cal-wizard-open w-full py-2 bg-dark-600 hover:bg-dark-500 border border-gray-700 rounded-lg text-xs text-gray-200 transition">
                    Run Calibration Wizard
                </button>
                <div class="text-[10px] text-gray-500 mt-2 mb-1 leading-tight">Optional deeper troubleshooting for root/fifth, SNR, tuning, and signal-clarity details after a diagnostic track.</div>
                <button type="button" class="nd-cal-lab-open w-full py-2 bg-dark-600 hover:bg-dark-500 border border-purple-900/50 rounded-lg text-xs text-gray-200 transition">
                    Advanced Signal Check
                </button>
            </div>

            ${tuningMode ? `
            <div class="nd-rec-block bg-dark-600/40 border border-gray-700 rounded-lg p-3 mb-3">
                <div class="flex justify-between items-center mb-2">
                    <span class="text-gray-200 text-xs font-semibold uppercase tracking-wider">Reference Recording</span>
                    <span class="nd-rec-state text-[10px] uppercase tracking-wider text-gray-500">idle</span>
                </div>
                <div class="nd-rec-info text-[11px] text-gray-400 leading-snug mb-2">Click Arm, then press Play on the song.</div>
                <div class="flex gap-1.5">
                    <button class="nd-rec-arm flex-1 bg-accent hover:bg-accent-light disabled:bg-dark-600 disabled:cursor-not-allowed disabled:text-gray-600 px-2 py-1.5 rounded text-xs font-semibold text-white transition">
                        Arm
                    </button>
                    <button class="nd-rec-arm-training flex-1 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:cursor-not-allowed disabled:text-gray-600 px-2 py-1.5 rounded text-xs font-semibold text-white transition" title="Capture this take and upload it to the curated training dataset (WAV + detect-stream + manifest, zipped, sent to pCloud)">
                        Arm (training)
                    </button>
                    <button class="nd-rec-save px-3 py-1.5 bg-dark-500 hover:bg-dark-400 rounded text-xs text-gray-300 transition disabled:opacity-40 disabled:cursor-not-allowed" title="Save what's captured so far">
                        Save
                    </button>
                    <button class="nd-rec-discard px-3 py-1.5 bg-dark-500 hover:bg-dark-400 rounded text-xs text-gray-300 transition disabled:opacity-40 disabled:cursor-not-allowed" title="Throw out the in-flight buffer">
                        Discard
                    </button>
                </div>
                <div class="nd-rec-saved text-[10px] text-gray-500 mt-2 break-all"></div>
                <div class="nd-rec-upload text-[10px] mt-1 break-all"></div>
            </div>
            ` : ''}

            <label class="block text-gray-400 text-xs mb-1">Audio Input Device</label>
            <select class="nd-device-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2">
                <option value="">Default</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Input Channel</label>
            <select class="nd-channel-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-2">
                <option value="mono" ${selectedChannel === 'mono' ? 'selected' : ''}>Mono (mix both channels)</option>
                <option value="left" ${selectedChannel === 'left' ? 'selected' : ''}>Left (Ch 1) — typically dry/DI</option>
                <option value="right" ${selectedChannel === 'right' ? 'selected' : ''}>Right (Ch 2) — typically wet/FX</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Input Level</label>
            <div class="relative h-3 bg-dark-600 rounded overflow-hidden mb-1">
                <div class="nd-vu-bar h-full rounded transition-all duration-75 bg-green-500" style="width:0%"></div>
                <div class="nd-vu-peak absolute top-0 w-0.5 h-full bg-white/70" style="left:0%"></div>
            </div>
            <div class="flex justify-between text-[9px] text-gray-600 mb-3">
                <span>-inf</span><span>-18dB</span><span>-6dB</span><span>0dB</span>
            </div>

            <label class="block text-gray-400 text-xs mb-1">Detection Method</label>
            <select class="nd-method-select w-full bg-dark-600 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 mb-3">
                <option value="yin" ${detectionMethod === 'yin' ? 'selected' : ''}>YIN (lightweight, clean signals)</option>
                <option value="hps" ${detectionMethod === 'hps' ? 'selected' : ''}>HPS (bass with weak fundamental, no model)</option>
                <option value="crepe" ${detectionMethod === 'crepe' ? 'selected' : ''}>CREPE/SPICE (robust, ~20MB model)</option>
            </select>

            <label class="block text-gray-400 text-xs mb-1">Audio Latency Offset: <span class="nd-latency-val">${Math.round(latencyOffset * 1000)}</span>ms</label>
            <input type="range" min="0" max="250" value="${Math.round(latencyOffset * 1000)}"
                   class="nd-latency-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Compensates for USB/audio interface delay. Increase if notes register late.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Timing Tolerance: <span class="nd-timing-val">${Math.round(timingTolerance * 1000)}</span>ms</label>
            <input type="range" min="30" max="300" value="${Math.round(timingTolerance * 1000)}"
                   class="nd-timing-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-2 leading-tight">
                Outer match window. Detections outside this range are ignored.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Pitch Tolerance: <span class="nd-pitch-val">${pitchTolerance}</span> cents</label>
            <input type="range" min="10" max="100" value="${pitchTolerance}"
                   class="nd-pitch-slider w-full accent-green-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Outer pitch match window. Wider values correlate more attempts.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Clean Timing: <span class="nd-timing-hit-val">${Math.round(timingHitThreshold * 1000)}</span>ms</label>
            <input type="range" min="30" max="${Math.round(timingTolerance * 1000)}" value="${Math.round(timingHitThreshold * 1000)}"
                   class="nd-timing-hit-slider w-full accent-blue-400 mb-2">

            <label class="block text-gray-400 text-xs mb-1">Chord Timing Window: <span class="nd-chord-timing-val">${Math.round(chordTimingHitThreshold * 1000)}</span>ms</label>
            <input type="range" min="${Math.round(timingHitThreshold * 1000)}" max="${Math.round(timingTolerance * 1000)}" value="${Math.round(chordTimingHitThreshold * 1000)}"
                   class="nd-chord-timing-slider w-full accent-blue-400 mb-1">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Chord strums have more inherent timing jitter than single notes (multi-string strike spread + analysis-window smearing). Fast power-chord punk also anticipates the beat. Wider than Clean Timing; pinned >= it.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Clean Pitch: <span class="nd-pitch-hit-val">${pitchHitThreshold}</span> cents</label>
            <input type="range" min="5" max="${pitchTolerance}" value="${pitchHitThreshold}"
                   class="nd-pitch-hit-slider w-full accent-blue-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Detection Confidence: <span class="nd-conf-val">${Math.round(detectionConfidenceMin * 100)}</span>%</label>
            <input type="range" min="5" max="50" value="${Math.round(detectionConfidenceMin * 100)}"
                   class="nd-conf-slider w-full accent-purple-400 mb-2">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Minimum confidence to accept a YIN/HPS/CREPE frame. Lower this if too many notes register as "pure miss" with no detection — at the cost of more false positives on quiet/noisy signals.
            </div>

            ${_ndCanNativeFrames ? `
            <label class="flex items-center gap-2 text-gray-400 text-xs mb-1">
                <input type="checkbox" class="nd-native-detect accent-purple-400" ${nativeDetection ? 'checked' : ''}>
                Detect in-plugin (native audio)
            </label>
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Desktop only. Runs note_detect's own ${'YIN/HPS/CREPE'} on the engine-captured guitar signal (instead of the engine's built-in detector), while chords are still verified by the engine's harmonic-comb scorer. Use this to pick HPS/CREPE on desktop. Takes effect immediately if Detect is currently on; otherwise on the next Detect toggle.
            </div>` : ''}

            <label class="flex items-center gap-2 text-gray-400 text-xs mb-2">
                <input type="checkbox" class="nd-show-timing accent-green-400" ${showTimingErrors ? 'checked' : ''}>
                Show early/late labels
            </label>
            <label class="flex items-center gap-2 text-gray-400 text-xs mb-2">
                <input type="checkbox" class="nd-show-pitch accent-green-400" ${showPitchErrors ? 'checked' : ''}>
                Show sharp/flat labels
            </label>
            <label class="flex items-center gap-2 text-gray-400 text-xs mb-1">
                <input type="checkbox" class="nd-edge-flash accent-green-400" ${edgeFlashEnabled ? 'checked' : ''}>
                Screen-edge flash on hit/miss
            </label>
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Off by default — the highway now lights up the note itself on a hit. Turn on for the old full-screen green/red edge flash.
            </div>

            <label class="block text-gray-400 text-xs mb-1">Miss Marker Duration: <span class="nd-miss-duration-val">${missMarkerDuration.toFixed(1)}</span>s</label>
            <input type="range" min="5" max="50" value="${Math.round(missMarkerDuration * 10)}"
                   class="nd-miss-duration-slider w-full accent-red-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Input Gain: <span class="nd-gain-val">${inputGain.toFixed(1)}</span>x</label>
            <input type="range" min="1" max="50" value="${Math.round(inputGain * 10)}"
                   class="nd-gain-slider w-full accent-green-400 mb-3">

            <label class="block text-gray-400 text-xs mb-1">Chord Leniency: <span class="nd-chord-ratio-val">${Math.round(chordHitRatio * 100)}</span>% of strings</label>
            <input type="range" min="25" max="100" value="${Math.round(chordHitRatio * 100)}"
                   class="nd-chord-ratio-slider w-full accent-green-400 mb-1">
            <div class="text-[10px] text-gray-600 mb-3 leading-tight">
                Chord detection uses per-string band analysis. This sets how many strings must ring to count as a hit (e.g. 60% = 4 of 6). Lower for beginners or dense voicings.
            </div>

            <div class="text-[10px] text-gray-600 mt-1 leading-tight">
                Tip: For multi-effects pedals with USB audio (e.g. Valeton GP-5), select <b>Left (Ch 1)</b> for the dry/DI signal — it gives the most accurate pitch detection.
                See the <b>Pitch Detection Methods</b> section of the plugin README for guidance on choosing between YIN, HPS, and CREPE.
            </div>
        `;

        document.body.appendChild(panel);
        // Cache the VU-meter refs for the always-on level loop so
        // drawSettingsVU() stops querying the DOM every frame.
        _vuSetPanel(panel);

        // Wire up controls
        panel.querySelector('.nd-settings-close').onclick = () => {
            if (panel._ndHealthTick) {
                clearInterval(panel._ndHealthTick);
                panel._ndHealthTick = null;
            }
            _vuSetPanel(null);
            panel.remove();
        };

        const calWizardBtn = panel.querySelector('.nd-cal-wizard-open');
        if (calWizardBtn) {
            calWizardBtn.onclick = () => openCalibrationWizard();
        }
        const calLabBtn = panel.querySelector('.nd-cal-lab-open');
        if (calLabBtn) {
            calLabBtn.onclick = () => openInstrumentCalibrationLab();
        }
        const diagLaunchBtn = panel.querySelector('.nd-diag-launch-basic');
        if (diagLaunchBtn) {
            diagLaunchBtn.onclick = () => _ndLaunchDiagnosticTrack('basic-guitar-6', panel);
        }

        try {
            renderDetectionHealth(panel);
        } catch (e) {
            console.warn('[note_detect] Detection Health render failed:',
                e && e.message ? e.message : e);
        }
        panel._ndHealthTick = setInterval(() => {
            if (!panel.isConnected) {
                clearInterval(panel._ndHealthTick);
                panel._ndHealthTick = null;
                return;
            }
            try {
                renderDetectionHealth(panel);
            } catch (e) {
                console.warn('[note_detect] Detection Health render failed:',
                    e && e.message ? e.message : e);
            }
        }, 400);

        // Reference-recording controls — present only when tuningMode is
        // on (the .nd-rec-block element is conditional in the template
        // above). Status updates on a self-cancelling 1s interval so the
        // duration tick + "Saved to ..." path appear in real time while
        // the popover is open.
        const recBlock = panel.querySelector('.nd-rec-block');
        if (recBlock) {
            const armBtn  = recBlock.querySelector('.nd-rec-arm');
            const armTrnBtn = recBlock.querySelector('.nd-rec-arm-training');
            const saveBtn = recBlock.querySelector('.nd-rec-save');
            const discBtn = recBlock.querySelector('.nd-rec-discard');
            const stateEl = recBlock.querySelector('.nd-rec-state');
            const infoEl  = recBlock.querySelector('.nd-rec-info');
            const savedEl = recBlock.querySelector('.nd-rec-saved');
            const uploadEl = recBlock.querySelector('.nd-rec-upload');
            // Declared up-front (vs. `const` after setInterval below) so
            // the bail-out branch in renderRec can call clearInterval
            // even if it fires on the very first synchronous call before
            // the interval has been installed — e.g., when instanceRoot
            // isn't attached to document.body in some host/test context.
            // Without this, the early bail-out would hit the temporal
            // dead zone and ReferenceError-out instead of cleaning up.
            let tick = null;

            function renderRec() {
                if (!document.body.contains(panel)) { if (tick != null) clearInterval(tick); return; }
                const r = getRecordingState();
                const hasBuffer = r.samples > 0;
                const trainTag = r.armedForTraining ? ' (training)' : '';
                let label, info;
                if (r.saveInFlight) { label = 'saving…'; info = 'Encoding + uploading the WAV…'; }
                else if (r.trainingUploadInFlight) { label = 'uploading…'; info = 'Bundling WAV + detect-stream + manifest and shipping to pCloud…'; }
                else if (r.lastError) { label = 'error'; info = 'Last attempt failed: ' + r.lastError; }
                else if (r.armed && r.songPlaying) { label = 'recording' + trainTag; info = `Capturing… ${r.durationS.toFixed(1)} s (${r.samples} samples @ ${r.sampleRate} Hz). Auto-saves on song end${r.armedForTraining ? ' and uploads to the training dataset' : ''}.`; }
                else if (r.armed && !r.detectEnabled) { label = 'armed (Detect off)' + trainTag; info = 'Armed, but Detect isn\'t on — no audio is flowing.'; }
                else if (r.armed) { label = 'armed' + trainTag; info = 'Armed. Press Play to start capturing.'; }
                else if (hasBuffer) { label = 'paused'; info = `${r.durationS.toFixed(1)} s captured; Save to keep it or Discard to throw it out.`; }
                else if (r.lastSavePath) { label = 'idle'; info = 'Ready. Click Arm for the next take.'; }
                else { label = 'idle'; info = 'Click Arm, then press Play.'; }
                if (stateEl) stateEl.textContent = label;
                if (infoEl)  {
                    infoEl.textContent = info;
                    infoEl.className = 'nd-rec-info text-[11px] leading-snug mb-2 ' + (r.lastError ? 'text-red-400' : 'text-gray-400');
                }
                // Build the "<label> <code>filename</code>" line with
                // textContent, never innerHTML — the path / bundle name
                // can contain server-side filesystem strings (the retry
                // endpoint accepts any training_*.zip), so interpolating
                // them into innerHTML would be an injection surface.
                const _setCodeLine = (el, label, codeText) => {
                    el.textContent = label;
                    const c = document.createElement('code');
                    c.className = 'text-gray-300';
                    c.textContent = codeText;
                    el.appendChild(c);
                };
                if (savedEl) {
                    if (r.lastSavePath && !r.armed && !r.lastError) {
                        _setCodeLine(savedEl, 'Saved: ', r.lastSavePath);
                    } else {
                        savedEl.textContent = '';
                    }
                }
                if (uploadEl) {
                    const tr = r.trainingUploadResult;
                    if (tr && tr.ok) {
                        uploadEl.className = 'nd-rec-upload text-[10px] text-green-400 mt-1 break-all';
                        _setCodeLine(uploadEl, 'Uploaded to training dataset: ', tr.bundle_filename || '(unknown)');
                    } else if (tr && !tr.ok) {
                        uploadEl.className = 'nd-rec-upload text-[10px] text-red-400 mt-1 break-all';
                        uploadEl.textContent = 'Upload failed: ' + (tr.error || 'unknown error') + (tr.local_bundle ? ' (bundle retained at ' + tr.local_bundle + ')' : '');
                    } else {
                        uploadEl.textContent = '';
                    }
                }
                // Disable the alternate arm path while one is active or
                // an upload is in flight — switching modes mid-take would
                // leave _recArmedForTraining ambiguous.
                if (armBtn)  { armBtn.textContent = (r.armed && !r.armedForTraining) ? 'Disarm' : 'Arm'; armBtn.disabled = r.saveInFlight || r.trainingUploadInFlight || (r.armed && r.armedForTraining); }
                if (armTrnBtn) { armTrnBtn.textContent = (r.armed && r.armedForTraining) ? 'Disarm' : 'Arm (training)'; armTrnBtn.disabled = r.saveInFlight || r.trainingUploadInFlight || (r.armed && !r.armedForTraining); }
                // Save is disabled during a training arm — a training
                // take auto-saves + uploads on song:ended; a manual
                // mid-take save would only orphan _recArmedForTraining /
                // the live stream / the parallel capture.
                if (saveBtn) saveBtn.disabled = !hasBuffer || r.saveInFlight || r.trainingUploadInFlight || r.armedForTraining;
                if (discBtn) discBtn.disabled = !(r.armed || hasBuffer) || r.saveInFlight || r.trainingUploadInFlight;
            }
            if (armBtn) armBtn.onclick = () => {
                const r = getRecordingState();
                if (r.armed && !r.armedForTraining) disarmRecording();
                else if (!r.armed) armRecording();
                renderRec();
            };
            if (armTrnBtn) armTrnBtn.onclick = async () => {
                const r = getRecordingState();
                if (r.armed && r.armedForTraining) {
                    disarmRecording();
                } else if (!r.armed) {
                    // armRecordingForTraining awaits getUserMedia when
                    // the desktop bridge is active. Surface a permission /
                    // device failure through _recLastSaveError (rendered
                    // below) rather than as an uncaught promise rejection.
                    try { await armRecordingForTraining(); } catch (_) { /* lastSaveError set inside */ }
                }
                renderRec();
            };
            if (saveBtn) saveBtn.onclick = async () => {
                await saveRecordingNow();
                renderRec();
            };
            if (discBtn) discBtn.onclick = () => { discardRecording(); renderRec(); };
            renderRec();
            tick = setInterval(renderRec, 1000);
        }
        panel.querySelector('.nd-device-select').onchange = (e) => onDeviceChange(e.target.value);
        panel.querySelector('.nd-channel-select').onchange = (e) => onChannelChange(e.target.value);
        panel.querySelector('.nd-method-select').onchange = (e) => setMethod(e.target.value);
        panel.querySelector('.nd-latency-slider').oninput = (e) => {
            latencyOffset = e.target.value / 1000;
            panel.querySelector('.nd-latency-val').textContent = e.target.value;
            saveSettings();
        };
        panel.querySelector('.nd-timing-slider').oninput = (e) => {
            timingTolerance = e.target.value / 1000;
            timingHitThreshold = Math.min(timingHitThreshold, timingTolerance);
            chordTimingHitThreshold = Math.min(chordTimingHitThreshold, timingTolerance);
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            panel.querySelector('.nd-timing-val').textContent = e.target.value;
            const hitSlider = panel.querySelector('.nd-timing-hit-slider');
            if (hitSlider) {
                hitSlider.max = e.target.value;
                hitSlider.value = Math.round(timingHitThreshold * 1000);
                panel.querySelector('.nd-timing-hit-val').textContent = hitSlider.value;
            }
            const chordSlider = panel.querySelector('.nd-chord-timing-slider');
            if (chordSlider) {
                chordSlider.max = e.target.value;
                chordSlider.min = Math.round(timingHitThreshold * 1000);
                chordSlider.value = Math.round(chordTimingHitThreshold * 1000);
                panel.querySelector('.nd-chord-timing-val').textContent = chordSlider.value;
            }
            saveSettings();
        };
        panel.querySelector('.nd-pitch-slider').oninput = (e) => {
            pitchTolerance = +e.target.value;
            pitchHitThreshold = Math.min(pitchHitThreshold, pitchTolerance);
            panel.querySelector('.nd-pitch-val').textContent = e.target.value;
            const hitSlider = panel.querySelector('.nd-pitch-hit-slider');
            if (hitSlider) {
                hitSlider.max = e.target.value;
                hitSlider.value = pitchHitThreshold;
                panel.querySelector('.nd-pitch-hit-val').textContent = hitSlider.value;
            }
            saveSettings();
        };
        panel.querySelector('.nd-timing-hit-slider').oninput = (e) => {
            timingHitThreshold = e.target.value / 1000;
            panel.querySelector('.nd-timing-hit-val').textContent = e.target.value;
            // Keep the chord-timing slider's lower bound + value in sync —
            // chord threshold can never be stricter than single-note.
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            const chordSlider = panel.querySelector('.nd-chord-timing-slider');
            if (chordSlider) {
                chordSlider.min = e.target.value;
                chordSlider.value = Math.round(chordTimingHitThreshold * 1000);
                panel.querySelector('.nd-chord-timing-val').textContent = chordSlider.value;
            }
            saveSettings();
        };
        panel.querySelector('.nd-chord-timing-slider').oninput = (e) => {
            chordTimingHitThreshold = e.target.value / 1000;
            // Enforce the invariant on direct edits too — slider min should
            // already prevent inversion, but a stale DOM state during fast
            // drag can momentarily produce values below the current
            // single-note threshold. Clamp here to be safe.
            const clamped = chordTimingHitThreshold < timingHitThreshold;
            if (clamped) chordTimingHitThreshold = timingHitThreshold;
            // When we clamped up, the variable + persisted setting have
            // moved past the slider's current `value` — sync the slider's
            // value back to the clamped position so the thumb doesn't
            // sit below the actual setting.
            if (clamped) e.target.value = Math.round(chordTimingHitThreshold * 1000);
            panel.querySelector('.nd-chord-timing-val').textContent = Math.round(chordTimingHitThreshold * 1000);
            saveSettings();
        };
        panel.querySelector('.nd-pitch-hit-slider').oninput = (e) => {
            pitchHitThreshold = +e.target.value;
            panel.querySelector('.nd-pitch-hit-val').textContent = e.target.value;
            saveSettings();
        };
        panel.querySelector('.nd-conf-slider').oninput = (e) => {
            // Slider is in percent (5-50); state is the 0.05-0.50 fraction.
            detectionConfidenceMin = (+e.target.value) / 100;
            panel.querySelector('.nd-conf-val').textContent = e.target.value;
            saveSettings();
        };
        // Native-frame detection toggle — only present on a capable desktop
        // build (see _ndCanNativeFrames), so null-guard the lookup. The mode is
        // captured per-session in startAudio(), so restart the audio path if
        // Detect is currently on for the change to take effect immediately.
        const nativeDetectEl = panel.querySelector('.nd-native-detect');
        if (nativeDetectEl) {
            nativeDetectEl.onchange = (e) => {
                nativeDetection = !!e.target.checked;
                saveSettings();
                if (enabled) restartAudio();
            };
        }
        panel.querySelector('.nd-show-timing').onchange = (e) => {
            showTimingErrors = !!e.target.checked;
            saveSettings();
        };
        panel.querySelector('.nd-show-pitch').onchange = (e) => {
            showPitchErrors = !!e.target.checked;
            saveSettings();
        };
        panel.querySelector('.nd-edge-flash').onchange = (e) => {
            edgeFlashEnabled = !!e.target.checked;
            if (!edgeFlashEnabled) {
                // Clear any flash that's mid-fade so it doesn't linger.
                const fe = instanceRoot.querySelector('.nd-flash-overlay');
                if (fe) fe.style.borderColor = 'transparent';
            }
            saveSettings();
        };
        panel.querySelector('.nd-miss-duration-slider').oninput = (e) => {
            missMarkerDuration = e.target.value / 10;
            panel.querySelector('.nd-miss-duration-val').textContent = missMarkerDuration.toFixed(1);
            saveSettings();
        };
        panel.querySelector('.nd-gain-slider').oninput = (e) => {
            inputGain = e.target.value / 10;
            panel.querySelector('.nd-gain-val').textContent = inputGain.toFixed(1);
            saveSettings();
        };
        panel.querySelector('.nd-chord-ratio-slider').oninput = (e) => {
            chordHitRatio = e.target.value / 100;
            panel.querySelector('.nd-chord-ratio-val').textContent = e.target.value;
            saveSettings();
        };

        _ndWireSettingsRangeScrollLock(panel);
        populateDevices();
    }

    function onDeviceChange(deviceId) {
        selectedDeviceId = deviceId;
        saveSettings();
        restartAudio();
    }

    function onChannelChange(channel) {
        // Route through setChannel() so a bound engine source (desktop multi-input)
        // is RE-TARGETED to the new channel, not just the browser splitter. Updating
        // only selectedChannel here left _ndChannelIndex — which all desktop source
        // routing uses — stale, so the bound source kept its old channel. The built-in
        // dropdown offers left/right/mono only, which map to indices 0/1/-1.
        const idx = channel === 'left' ? 0 : channel === 'right' ? 1 : -1;
        setChannel(idx);  // updates _ndChannelIndex + selectedChannel, retargets the source, saves, restarts
    }

    async function populateDevices() {
        const sel = document.querySelector('.nd-settings-panel .nd-device-select');
        if (!sel) return;
        // When note detection actually captures through the native engine, the
        // input device + channel are chosen once in the onboarding Input Setup
        // wizard (audio-input domain) — a browser device list here would be
        // misleading (it only enumerates WASAPI inputs, never ASIO, and is
        // ignored on the native path), so show the managed state instead.
        // Gate on the engine being AVAILABLE, not merely "on desktop": if the
        // native addon failed to load, note detection falls back to getUserMedia
        // and the user still needs the browser device list to pick an input.
        const caps = (typeof window !== 'undefined') && window.slopsmith && window.slopsmith.capabilities;
        const desktop = (typeof window !== 'undefined') ? window.slopsmithDesktop : null;
        let nativeManaged = false;
        if (desktop && desktop.isDesktop && desktop.audio
            && caps && typeof caps.command === 'function'
            && typeof desktop.audio.isAvailable === 'function') {
            try { nativeManaged = !!(await desktop.audio.isAvailable()); }
            catch (_) { nativeManaged = false; }
        }
        if (nativeManaged) {
            sel.innerHTML = '<option value="">Set in Input Setup</option>';
            sel.disabled = true;
            sel.title = 'Your input device and input are chosen in the Input Setup wizard.';
            return;
        }
        sel.disabled = false;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            sel.innerHTML = '<option value="">Default</option>';
            for (const d of devices) {
                if (d.kind !== 'audioinput') continue;
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Input ${d.deviceId.slice(0, 8)}`;
                if (d.deviceId === selectedDeviceId) opt.selected = true;
                sel.appendChild(opt);
            }
        } catch (e) { /* permission not yet granted */ }
    }

    function setMethod(method) {
        detectionMethod = method;
        detectionMethodUserSet = true;  // explicit choice — disable bass auto-HPS
        saveSettings();
        if (method === 'crepe') _ndLoadCrepe();
    }

    // The detection method actually used per frame (web path). A bass
    // arrangement auto-uses HPS when the user has not explicitly chosen a
    // method and is still on the YIN default: YIN's time-domain autocorrelation
    // latches onto the 2nd harmonic of a weak-fundamental bass note and reports
    // an octave high, while HPS reinforces the true fundamental.
    function _ndEffectiveDetectionMethod() {
        if (currentArrangement === 'bass' && !detectionMethodUserSet && detectionMethod === 'yin')
            return 'hps';
        return detectionMethod;
    }

    // Accepts only the documented channel indices (-1 mono, 0 left,
    // 1 right). Returns `false` and leaves the channel unchanged for
    // anything else so upstream bugs (stringified input, out-of-range
    // index) surface instead of silently coercing to mono.
    function setChannel(idx) {
        if (!Number.isInteger(idx) || idx < -1) {
            console.warn(`[note_detect] setChannel: invalid channel ${idx}; expected an integer >= -1 (-1 = mono mix, else 0-based input channel).`);
            return false;
        }
        // Multichannel channel selection (index >= 2) is DEFERRED. It is only valid on
        // the desktop engine-SOURCE path, but at any given moment this detector may
        // instead run the browser getUserMedia splitter (borrowing mode, or a desktop
        // build where the native bridge is unavailable), which captures only channels
        // 0/1 — accepting >=2 there silently captures the wrong input and exports stale
        // metadata. The validated multi-device flow binds ONE device per panel and uses
        // mono/left/right; selecting channel 3+ of a single multi-channel interface
        // needs runtime, capture-mode-aware gating (a follow-up). Reject for now so the
        // two channel representations (_ndChannelIndex + selectedChannel) never diverge.
        if (idx >= 2) {
            console.warn(`[note_detect] setChannel: channel ${idx} (multi-channel selection) is not yet supported; use a separate input device per panel.`);
            return false;
        }
        _ndChannelIndex = idx;
        // selectedChannel (serialized into session/diagnostic metadata) stays in sync —
        // only -1/0/1 are reachable now, so it never goes stale.
        if (idx === -1) selectedChannel = 'mono';
        else if (idx === 0) selectedChannel = 'left';
        else selectedChannel = 'right';  // idx === 1
        saveSettings();
        // Retarget the bound engine source's input channel directly — restartAudio()
        // below only rebuilds the browser getUserMedia graph, not the live engine
        // binding. Applies to THIS detector's source whether we allocated it
        // (_ndOwnsSource) or it was caller-assigned (opts.sourceId): the channel is
        // what this detector listens to, so it must follow. (Only the per-panel verifier
        // OFFSET stays owned-only, since that tweak shouldn't leak onto a shared source.)
        // Never source 0 (the shared default). No-op on the browser path.
        if (sourceId != null && sourceId !== 0) {
            const a = bridgeDesktop && bridgeDesktop.audio;
            if (a && typeof a.setSourceInputChannel === 'function') {
                try { a.setSourceInputChannel(sourceId, _ndChannelIndex); } catch (_) { /* best-effort */ }
            }
        }
        restartAudio();
        return true;
    }

    // Set the per-source capture-latency correction (milliseconds) and apply it
    // live to the bound engine source. The host (splitscreen) calls this from a
    // per-panel control so the user can dial in an extra device's timing.
    function setVerifierOffset(ms) {
        if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
        _ndVerifierOffsetMs = ms;
        _ndApplyVerifierOffset();
    }
    function getVerifierOffset() { return _ndVerifierOffsetMs; }

    // ── HUD ───────────────────────────────────────────────────────────
    function createHUD() {
        if (instanceRoot.querySelector('.nd-hud')) return;
        // Re-stamp the skin on (re)create — another instance (or the
        // settings screen) may have switched it while this HUD was down.
        try { instanceRoot.setAttribute('data-nd-skin', _ndLoadSkin()); } catch (e) {}
        const hud = document.createElement('div');
        // All layout/typography lives in assets/plugin.css, themed by the
        // instanceRoot's data-nd-skin attribute. Class names queried by
        // updateHUD()/_drillRender() are load-bearing — keep them stable.
        hud.className = 'nd-hud';
        hud.innerHTML = `
            <div class="nd-hud-score">0</div>
            <div class="nd-hud-mainrow">
                <span class="nd-hud-accuracy"></span>
                <span class="nd-hud-mult" data-tier="1">×1</span>
            </div>
            <div class="nd-hud-streak"></div>
            <div class="nd-hud-counts"></div>
            <div class="nd-hud-detected"></div>
            <div class="nd-drill hidden">
                <div class="nd-drill-header"></div>
                <div class="nd-drill-list"></div>
            </div>
        `;
        instanceRoot.appendChild(hud);
    }

    function removeHUD() {
        const hud = instanceRoot.querySelector('.nd-hud');
        if (hud) hud.remove();
        const flash = instanceRoot.querySelector('.nd-flash-overlay');
        if (flash) flash.remove();
    }

    function createFlashOverlay() {
        if (instanceRoot.querySelector('.nd-flash-overlay')) return;
        const flash = document.createElement('div');
        flash.className = 'nd-flash-overlay';
        flash.style.cssText = 'position:absolute;inset:0;z-index:20;pointer-events:none;border:4px solid transparent;transition:border-color 0.05s;';
        instanceRoot.appendChild(flash);
    }

    function startHUD() {
        createHUD();
        createFlashOverlay();
        lastHitCount = 0;
        lastMissCount = 0;
        // Sync animation state to the live counters so a mid-song re-enable
        // doesn't replay a count-up / multiplier pop for ground it already
        // covered. The badge DOM must be seeded too — createHUD's template
        // hard-codes ×1, and updateHUD only rewrites it on tier CHANGES, so
        // syncing lastMultTier alone would leave a recreated HUD stuck at
        // ×1 while a >1 multiplier is live.
        displayScore = score;
        lastMultTier = multiplier;
        lastStreakVal = streak;
        const multEl = instanceRoot.querySelector('.nd-hud-mult');
        if (multEl) {
            multEl.setAttribute('data-tier', String(multiplier));
            multEl.textContent = '×' + multiplier;
        }
        if (hudInterval) clearInterval(hudInterval);
        hudInterval = setInterval(updateHUD, 33);
    }

    function stopHUD() {
        if (hudInterval) { clearInterval(hudInterval); hudInterval = null; }
        removeHUD();
    }

    function updateHUD() {
        if (!enabled) return;

        // Bridge slopsmith's loop state into our drill flag once per
        // tick. Cheap (one getLoop read); avoids a separate poll.
        _drillSyncFromLoopState();
        _drillRender();

        const total = hits + misses;
        const accEl = instanceRoot.querySelector('.nd-hud-accuracy');
        const streakEl = instanceRoot.querySelector('.nd-hud-streak');
        const countsEl = instanceRoot.querySelector('.nd-hud-counts');
        const detectedEl = instanceRoot.querySelector('.nd-hud-detected');
        const flashEl = instanceRoot.querySelector('.nd-flash-overlay');
        const scoreEl = instanceRoot.querySelector('.nd-hud-score');
        const multEl = instanceRoot.querySelector('.nd-hud-mult');

        if (scoreEl) {
            // Eased count-up toward the live score; snap instantly downward
            // (a reset/new song should not "count down" from the old total).
            if (score < displayScore) displayScore = score;
            const diff = score - displayScore;
            displayScore = diff < 1 ? score : displayScore + diff * 0.25;
            scoreEl.textContent = String(Math.round(displayScore));
        }

        if (multEl && multiplier !== lastMultTier) {
            multEl.setAttribute('data-tier', String(multiplier));
            multEl.textContent = '×' + multiplier;
            if (multiplier > lastMultTier) {
                // Remove + reflow + re-add so consecutive tier-ups retrigger
                // the one-shot keyframe.
                multEl.classList.remove('nd-pop');
                void multEl.offsetWidth;
                multEl.classList.add('nd-pop');
            }
            lastMultTier = multiplier;
        }

        if (accEl && total > 0) {
            const accuracy = Math.round((hits / total) * 100);
            const color = accuracy >= 90 ? '#00ff88' : accuracy >= 70 ? '#ffcc00' : '#ff4444';
            accEl.textContent = accuracy + '%';
            accEl.style.color = color;
        } else if (accEl) {
            accEl.textContent = '';
        }

        if (streakEl) {
            let text = streak > 0 ? `${streak} streak` : '';
            if (bestStreak > 0) text += `  best: ${bestStreak}`;
            streakEl.textContent = text;
            if (streak === 0 && lastStreakVal >= 10) {
                // A multiplier-worthy streak just broke — shake the panel.
                const hudEl = instanceRoot.querySelector('.nd-hud');
                if (hudEl) {
                    hudEl.classList.remove('nd-shake');
                    void hudEl.offsetWidth;
                    hudEl.classList.add('nd-shake');
                }
            } else if (streak > lastStreakVal && _ndIsStreakMilestone(streak)) {
                streakEl.classList.remove('nd-flash');
                void streakEl.offsetWidth;
                streakEl.classList.add('nd-flash');
            }
            lastStreakVal = streak;
        }

        if (countsEl && total > 0) {
            countsEl.textContent = `${hits} / ${total}`;
        } else if (countsEl) {
            // Clear on zero-total so a reset/new-song enable doesn't
            // show the previous session's `X / Y` until the first
            // judgment lands. Mirrors the accuracy label's else-branch.
            countsEl.textContent = '';
        }

        if (detectedEl) {
            if (detectedString >= 0 && detectedConfidence > detectionConfidenceMin) {
                // Use the chart-corrected display MIDI when available;
                // otherwise use the raw detected MIDI. Bass, 7-string guitar,
                // non-standard tuning, and capo all still route through the
                // same MIDI-name formatter instead of string-index lookups.
                const displayMidi = Number.isFinite(detectedDisplayMidi) ? detectedDisplayMidi : detectedMidi;
                detectedEl.textContent = `${_ndMidiToName(displayMidi)} · s${detectedString} f${detectedFret}`;
            } else if (lastChordScore !== null) {
                // No confident single-note detected this frame, but we
                // have a recent chord score from the constraint path —
                // show it for a short TTL after the chord's chart time
                // so the readout doesn't linger forever through silence
                // / noise between notes.
                const songTime = (hw.getTime ? hw.getTime() : 0) - latencyOffset
                    + (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
                const CHORD_HUD_TTL_SEC = 1.5;
                if (songTime - lastChordTime <= CHORD_HUD_TTL_SEC) {
                    const pct = Math.round(lastChordScore * 100);
                    detectedEl.textContent = `chord ${lastChordHit}/${lastChordTotal} (${pct}%)`;
                } else {
                    detectedEl.textContent = '';
                }
            } else {
                detectedEl.textContent = '';
            }
        }

        if (flashEl) {
            // Track pending flash timeouts so destroy()/disable() can
            // clear them. Each timeout self-splices from the list on
            // fire so the array doesn't grow unbounded across a long
            // session (~60 min of play at ~20 hits/min was previously
            // accumulating ~1200 stale entries before disable ran).
            const spawnFlash = (color) => {
                // slopsmith#254 — off by default now that the highway
                // renderer lights the note itself; opt back in via the
                // "Screen-edge flash on hit/miss" toggle.
                if (!edgeFlashEnabled) return;
                flashEl.style.borderColor = color;
                const tid = setTimeout(() => {
                    if (flashEl) flashEl.style.borderColor = 'transparent';
                    const idx = flashTimeouts.indexOf(tid);
                    if (idx !== -1) flashTimeouts.splice(idx, 1);
                }, 80);
                flashTimeouts.push(tid);
            };
            if (hits > lastHitCount) {
                spawnFlash('rgba(0, 255, 136, 0.6)');
            } else if (misses > lastMissCount) {
                spawnFlash('rgba(255, 50, 68, 0.4)');
            }
            lastHitCount = hits;
            lastMissCount = misses;
        }
    }

    // ── Draw hook overlay on the highway canvas ───────────────────────
    function drawOverlay(ctx, W, H) {
        if (!enabled) return;
        if (!hw.project || !hw.fretX) return;
        // This overlay positions everything with the 2D highway's
        // projection (hw.project / hw.fretX). A custom renderer (3D
        // highway, piano, …) draws its own scene with different
        // geometry — and fires our draw hook on its 2D overlay layer —
        // so these markers would land in meaningless places (the stray
        // red miss X's complaint, slopsmith#254). Bail when a non-default
        // renderer is active; that renderer owns the per-note feedback
        // (the 3D highway lights the note mesh on hit/active and red-
        // outlines + labels misses, via the bundle.getNoteState path).
        // Our HUD / screen-flash are DOM, not canvas, so they're
        // unaffected. Older cores without isDefaultRenderer → assume 2D.
        if (hw.isDefaultRenderer && !hw.isDefaultRenderer()) return;

        const t = hw.getTime();
        const renderT = t + (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const notes = hw.getNotes();
        const chords = hw.getChords();

        const drawTextReadable = (text, x, y) => {
            if (hw.fillTextUnmirrored) hw.fillTextUnmirrored(text, x, y);
            else ctx.fillText(text, x, y);
        };

        const nowPoint = hw.project(0);

        const drawIndicator = (s, f, noteTime, judgment) => {
            const tOff = noteTime - renderT;
            if (!nowPoint) return;

            const age = Math.max(0, renderT - noteTime);
            let scale = nowPoint.scale || 1;
            let x;
            let y;
            if (judgment.hit || tOff >= -0.05) {
                const p = hw.project(tOff);
                if (!p) return;
                scale = p.scale || scale;
                x = hw.fretX(f, scale, W);
                y = p.y * H;
            } else {
                const nowY = nowPoint.y * H;
                const pastArea = Math.max(40, H - nowY - 18);
                const progress = Math.min(1, age / Math.max(0.1, missMarkerDuration));
                x = hw.fretX(f, scale, W);
                y = nowY + Math.min(pastArea, 28 + progress * pastArea);
            }

            if (judgment.hit) {
                // slopsmith#254 — when *our* provider is the one driving
                // the gem lighting, the green overlay ring is redundant;
                // skip it. But if the core supports the hook yet some
                // other plugin owns the provider (we declined to stomp it
                // in ensureDrawHook), the gem isn't lit by us — fall
                // through to the ring so there's still on-highway hit
                // feedback. Older cores (no getter) also keep the ring.
                if (hw && hw.getNoteStateProvider && hw.getNoteStateProvider() === noteStateFor) return;
                const fade = Math.max(0, 1 - age / Math.max(0.1, hitGlowDuration)) * scale;
                if (fade <= 0) return;
                ctx.save();
                ctx.globalAlpha = fade * 0.7;
                ctx.globalCompositeOperation = 'lighter';
                ctx.shadowColor = '#00ff88';
                ctx.shadowBlur = 20 * scale;
                ctx.strokeStyle = '#00ff88';
                ctx.lineWidth = 3 * scale;
                ctx.beginPath();
                ctx.arc(x, y, 14 * scale, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            } else {
                const fade = Math.max(0, 1 - age / Math.max(0.1, missMarkerDuration)) * scale;
                if (fade <= 0) return;
                ctx.save();
                ctx.globalAlpha = fade * 0.85;
                ctx.shadowColor = '#ff3344';
                ctx.shadowBlur = 12 * scale;
                ctx.strokeStyle = '#ff3344';
                ctx.lineWidth = 2.5 * scale;
                const sz = 8 * scale;
                ctx.beginPath();
                ctx.moveTo(x - sz, y - sz);
                ctx.lineTo(x + sz, y + sz);
                ctx.moveTo(x + sz, y - sz);
                ctx.lineTo(x - sz, y + sz);
                ctx.stroke();

                const pulse = Math.max(0, 1 - age / 0.2);
                if (pulse > 0) {
                    const nowY = nowPoint.y * H;
                    ctx.globalAlpha = pulse * 0.5;
                    ctx.strokeStyle = '#ff3344';
                    ctx.lineWidth = 5 * scale;
                    ctx.beginPath();
                    ctx.moveTo(Math.max(0, x - 18 * scale), nowY + 4);
                    ctx.lineTo(Math.min(W, x + 18 * scale), nowY + 4);
                    ctx.stroke();
                }

                const labels = [];
                if (showTimingErrors && judgment.timingState && judgment.timingState !== 'OK') {
                    labels.push({
                        color: '#ffb347',
                        text: `${judgment.timingState === 'EARLY' ? '↑' : '↓'} ${judgment.timingError > 0 ? '+' : ''}${judgment.timingError}ms`,
                    });
                }
                if (showPitchErrors && judgment.pitchState && judgment.pitchState !== 'OK') {
                    labels.push({
                        color: '#66c7ff',
                        text: `${judgment.pitchState === 'SHARP' ? '♯' : '♭'} ${judgment.pitchError > 0 ? '+' : ''}${judgment.pitchError}¢`,
                    });
                }
                if (labels.length > 0) {
                    ctx.font = `bold ${Math.max(10, 11 * scale)}px sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    for (let i = 0; i < labels.length; i++) {
                        const yy = y + (i - (labels.length - 1) / 2) * 16 * scale - 18 * scale;
                        ctx.lineWidth = 3;
                        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
                        ctx.strokeText(labels[i].text, x, yy);
                        ctx.fillStyle = labels[i].color;
                        drawTextReadable(labels[i].text, x, yy);
                    }
                }
                ctx.restore();
            }
        };

        if (notes) {
            for (const n of notes) {
                if (n.t < renderT - missMarkerDuration - 0.2) continue;
                if (n.t > renderT + 3) break;
                if (n.mt) continue;
                const key = noteKey(n, n.t);
                const result = noteResults.get(key);
                if (result) drawIndicator(n.s, n.f, n.t, result);
            }
        }
        if (chords) {
            for (const c of chords) {
                if (c.t < renderT - missMarkerDuration - 0.2) continue;
                if (c.t > renderT + 3) break;
                for (const cn of (c.notes || [])) {
                    if (cn.mt) continue;
                    const key = noteKey(cn, c.t);
                    const result = noteResults.get(key);
                    if (result) drawIndicator(cn.s, cn.f, c.t, result);
                }
            }
        }

        if (detectedString >= 0 && detectedConfidence > detectionConfidenceMin) {
            if (nowPoint) {
                const x = hw.fretX(detectedFret, nowPoint.scale, W);
                const y = nowPoint.y * H;
                ctx.save();
                ctx.globalAlpha = Math.min(1, detectedConfidence);
                ctx.fillStyle = '#44ddff';
                ctx.shadowColor = '#44ddff';
                ctx.shadowBlur = 12;
                ctx.beginPath();
                ctx.arc(x, y, 6, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#000';
                ctx.font = 'bold 7px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(detectedFret, x, y);
                ctx.restore();
            }
        }
    }

    // ── Button injection ──────────────────────────────────────────────
    // Attach instanceRoot into the DOM. Called from `injectButton()`
    // and from `enable()` so programmatic `createNoteDetector({container}).enable()`
    // usage (no button injection) still gets HUD/settings/summary
    // rendered. Idempotent — re-attaching an already-appended element
    // is a no-op via the `contains()` guard.
    function attachInstanceRoot() {
        const target = container || document.getElementById('player');
        if (target && !target.contains(instanceRoot)) {
            target.appendChild(instanceRoot);
        }
    }

    function injectButton(bar) {
        const controls = bar || document.getElementById('player-controls');
        if (!controls) return;
        // Idempotency: skip if our button is still live in the DOM. We check
        // isConnected, NOT controls.contains(detectBtn): in v3 the host's
        // rehome shim MOVES our button out of #player-controls into the
        // Plugins rail slot (preserving identity + listeners), so a
        // membership check against `controls` misses the rehomed button and
        // injects a fresh duplicate on every song switch (the playSong
        // wrapper re-calls injectButton each song). isConnected is true in
        // both the in-bar (v2) and rehomed-to-slot (v3) cases, and false only
        // when a recreated controls row genuinely orphaned the old button —
        // which is exactly when we DO want to re-inject.
        if (detectBtn && detectBtn.isConnected) return;

        const closeBtn = controls.querySelector(':scope > button:last-of-type');

        detectBtn = document.createElement('button');
        detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
        detectBtn.textContent = 'Detect';
        detectBtn.title = 'Toggle real-time note detection & scoring';
        detectBtn.onclick = toggle;
        if (closeBtn && closeBtn.parentNode === controls) controls.insertBefore(detectBtn, closeBtn);
        else controls.appendChild(detectBtn);

        gearBtn = document.createElement('button');
        gearBtn.className = 'nd-gear-btn px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition hidden';
        gearBtn.textContent = '\u2699';
        gearBtn.title = 'Note detection settings';
        gearBtn.onclick = showSettings;
        if (closeBtn && closeBtn.parentNode === controls) controls.insertBefore(gearBtn, closeBtn);
        else controls.appendChild(gearBtn);

        attachInstanceRoot();
        // Sync button class/text with current state. If the instance
        // was already enabled (or CREPE is mid-load) when the button is
        // injected, the default 'Detect' text would be out of date.
        updateButton();
    }

    function updateButton() {
        if (!detectBtn) return;
        const loading = detectionMethod === 'crepe' && _ndShared.modelLoading;
        if (loading) {
            detectBtn.textContent = 'Detect (loading model...)';
            detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-dark-600 rounded-lg text-xs text-gray-400 transition';
        } else if (enabled) {
            detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
            detectBtn.textContent = 'Detect \u2713';
        } else {
            detectBtn.className = 'nd-detect-btn px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
            detectBtn.textContent = 'Detect';
        }
        if (gearBtn) gearBtn.classList.toggle('hidden', !enabled);
    }

    // ── Reset / enable / disable / destroy ────────────────────────────
    function resetScoring() {
        hits = 0;
        misses = 0;
        streak = 0;
        bestStreak = 0;
        score = 0;
        multiplier = 1;
        maxMultiplier = 1;
        _xpSubmittedTake = false;
        // A new song supersedes any auto-exit claimed for the previous song's
        // summary. We only drop our reference — no host cleanup is needed:
        // the host cancels its own auto-exit on playSong and generation-guards
        // the release handle, so a stale releaser (e.g. fired by dismissing a
        // lingering old panel) is an inert no-op and can't navigate the new
        // song. (The current song's hold is set after this, in
        // _endOfSongOnEnded.)
        _ndAutoExitRelease = null;
        noteResults.clear();
        _scoreLedger.clear();
        _susActiveUntil.clear();
        _chordLastResult.clear();
        _ndVerifierRejects.length = 0;
        _ndRejectDedup.clear();
        _ndVerifyFailSnap.clear();
        _diagResetCounters();
        sectionStats = [];
        currentSection = null;
        detectedMidi = -1;
        detectedConfidence = 0;
        detectedString = -1;
        detectedFret = -1;
        detectedDisplayMidi = -1;
        lastChordScore = null;
        lastChordHit = 0;
        lastChordTotal = 0;
        lastChordTime = -Infinity;
    }

    // Narrower reset used by the A/V auto-calibrate Apply button.
    // Calling resetScoring() there blew away the user's hit/miss
    // counters + streak + section history + event log — surprising
    // for what's framed as a calibration tweak. This clears ONLY the
    // timing-error samples that feed the next calibration suggestion,
    // so the next median reflects the new offset but everything else
    // the user can see on Settings (accuracy, breakdown, per-section)
    // stays intact.
    function _resetCalibrationSamples() {
        _diagTimingErrors.length = 0;
        _diagTimingErrorsHits.length = 0;
    }

    // ── Position-aware score recompute (got-feedback tester report) ────────
    // When the player repositions BACKWARD in the song — the Restart button
    // (restartCurrentSong → _audioSeek 'song-restart') or a manual scrub-back —
    // the live HUD score must reflect only the part of the song up to the new
    // playhead, not keep the stale cumulative total. (Restart to 0 → 0 notes /
    // 0%.) Rebuild it from the ledger:
    //   1. Drop every judgment at/after chart time `t` from the ledger AND the
    //      display/dedup maps, so replaying forward re-judges those notes (the
    //      noteResults.has() guards would otherwise skip them) and they re-count
    //      cleanly instead of double-counting on top of the rolled-back total.
    //   2. Replay the survivors (notes strictly before `t`) in chart-time order
    //      through the SAME streak/multiplier/points rules recordJudgment uses,
    //      so streak, bestStreak, multiplier, maxMultiplier and score are all
    //      consistent with "as if you'd only played up to here".
    // updateHUD()'s 33 ms tick picks up the rebuilt counters; no explicit
    // repaint needed. sectionStats are intentionally left untouched — they feed
    // the end-of-song summary, not the live HUD, and the ledger doesn't carry
    // section membership (a known limitation, same as drill-mode cumulation).
    function _recomputeScoreToPosition(t) {
        if (!Number.isFinite(t)) return;
        for (const [key, e] of _scoreLedger) {
            if (e.t >= t) {
                _scoreLedger.delete(key);
                noteResults.delete(key);
                _susActiveUntil.delete(key);
                _chordLastResult.delete(key);
            }
        }
        const survivors = Array.from(_scoreLedger.values()).sort((a, b) => a.t - b.t);
        hits = 0;
        misses = 0;
        streak = 0;
        bestStreak = 0;
        score = 0;
        multiplier = 1;
        maxMultiplier = 1;
        for (const e of survivors) {
            if (e.hit) {
                hits++;
                streak++;
                if (streak > bestStreak) bestStreak = streak;
                multiplier = _ndMultiplierForStreak(streak);
                if (multiplier > maxMultiplier) maxMultiplier = multiplier;
                score += (e.chord ? ND_BASE_CHORD : ND_BASE_SINGLE) * multiplier;
            } else {
                misses++;
                streak = 0;
                multiplier = 1;
            }
        }
    }

    // song:seek handler. Core emits song:seek from its single repositioning
    // funnel (_audioSeek) with { from, to, reason }. A BACKWARD jump on an
    // actively-scoring instance rebuilds the score to the new position.
    function _onSongSeekReposition(e) {
        // Only an enabled instance has a live HUD worth rebuilding. (Bound
        // across the per-song silent-disable, so guard here.)
        if (!enabled) return;
        const d = (e && e.detail) || {};
        const to = Number(d.to);
        if (!Number.isFinite(to)) return;
        // Drill mode keeps its own per-iteration accounting and the global
        // score is intentionally cumulative across loop wraps — never recompute
        // there. The loop-wrap reason is the drill reposition; skip it too as a
        // belt-and-suspenders guard alongside drillEnabled.
        if (drillEnabled || d.reason === 'loop-wrap') return;
        // Only a backward reposition updates the score; a forward seek leaves
        // earlier judgments intact (the player simply skipped ahead). When the
        // origin is unknown, treat it as a reposition worth recomputing.
        const from = Number(d.from);
        const movedBack = Number.isFinite(from) ? (to < from - 0.05) : true;
        if (!movedBack) return;
        _recomputeScoreToPosition(to);
    }

    function _seekResetBindEvents() {
        if (seekResetSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        const fn = _onSongSeekReposition;
        try {
            window.slopsmith.on('song:seek', fn);
        } catch (e) {
            return;
        }
        seekResetOnSeekFn = fn;
        seekResetSubscribed = true;
    }

    function _seekResetUnbindEvents() {
        if (!seekResetSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function' && seekResetOnSeekFn) {
            try { window.slopsmith.off('song:seek', seekResetOnSeekFn); } catch (e) {}
        }
        seekResetSubscribed = false;
        seekResetOnSeekFn = null;
    }

    // ── Drill mode (slopsmith loop:restart) ───────────────────────────
    function _drillCurrentLoop() {
        const fallback = { loopA: null, loopB: null };
        if (!window.slopsmith || typeof window.slopsmith.getLoop !== 'function') {
            return fallback;
        }
        // Guard the host call — a misbehaving slopsmith bus shouldn't
        // take down updateHUD / recordJudgment scoring with it.
        let result;
        try {
            result = window.slopsmith.getLoop();
        } catch (e) {
            return fallback;
        }
        // Require an actual object so destructuring `{ loopA, loopB }`
        // gets meaningful values. A truthy non-object (e.g. `true`,
        // `''`, `42`) would destructure to undefined and let
        // _drillSyncFromLoopState read a malformed shape — better to
        // return the inactive fallback so drill stays off.
        if (!result || typeof result !== 'object') return fallback;
        return result;
    }

    function _drillResetIteration(startT) {
        drillIterHits = 0;
        drillIterMisses = 0;
        drillIterStreak = 0;
        drillIterBestStreak = 0;
        // Reject NaN / Infinity — typeof===number is true for both and
        // they'd leak through into getDrillStats().current.startT and
        // poison any downstream arithmetic.
        drillIterStartT = Number.isFinite(startT) ? startT : null;
    }

    function _drillSnapshotIteration() {
        const total = drillIterHits + drillIterMisses;
        // Skip zero-judgment iterations so an idle loop wrap doesn't
        // pollute the scoreboard with empty rows.
        if (total === 0) return;
        const accuracy = Math.round((drillIterHits / total) * 100);
        // Iteration duration = loopB - loopA (the loop's length).
        // The wrap event's `detail.time` is loopA (the new
        // iteration's start), not the just-finished iteration's
        // endpoint — so we can't derive duration from event timing.
        // Using the cached active bounds is correct: the iteration
        // we're snapshotting played from loopA through loopB.
        const durationSec = (Number.isFinite(drillActiveLoopA) && Number.isFinite(drillActiveLoopB))
            ? Math.max(0, drillActiveLoopB - drillActiveLoopA)
            : null;
        drillIterations.push({
            idx: drillNextIdx++,
            hits: drillIterHits,
            misses: drillIterMisses,
            accuracy,
            bestStreak: drillIterBestStreak,
            durationSec,
            ts: Date.now(),
        });
        // Bound the array to the most recent N — long sessions
        // shouldn't grow memory unboundedly.
        if (drillIterations.length > DRILL_MAX_ITERATIONS) {
            drillIterations.splice(0, drillIterations.length - DRILL_MAX_ITERATIONS);
        }
        drillDirty = true;
    }

    function _drillOnLoopRestart(e) {
        const rawTime = (e && e.detail) ? e.detail.time : undefined;
        const wrapTime = Number.isFinite(rawTime) ? rawTime : null;
        // Snapshot the iteration that just ended (duration is derived
        // from the cached loop bounds, not the event payload — the
        // event's `time` is loopA, the new iteration's start).
        _drillSnapshotIteration();
        // Re-anchor at the new iteration's start (= loopA).
        _drillResetIteration(wrapTime);
    }

    function _drillOnSongChanged() {
        // New song = different passage; stale iterations don't apply.
        // Also drop drillEnabled so getDrillStats() doesn't report
        // active=true between this event and the next HUD sync (which
        // may not happen at all if detection is disabled).
        drillIterations = [];
        _drillResetIteration(null);
        drillActiveLoopA = null;
        drillActiveLoopB = null;
        drillNextIdx = 1;
        drillEnabled = false;
        drillDirty = true;
    }

    function _drillBindEvents() {
        if (drillSubscribed) return;
        // Require both .on and .off so we never bind handlers we
        // can't tear down later — a host with on-only would leak
        // listeners across destroy() / re-mount.
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        // Register all three first; only set drillSubscribed after the
        // .on calls succeed. If any throws mid-registration we tear
        // down what landed so a retry on the next call is clean.
        const onLoopRestart = _drillOnLoopRestart;
        const onSongChanged = _drillOnSongChanged;
        try {
            window.slopsmith.on('loop:restart', onLoopRestart);
            window.slopsmith.on('song:loaded', onSongChanged);
            window.slopsmith.on('song:ended', onSongChanged);
        } catch (e) {
            // Partial registration — unwind so we don't leak handlers.
            if (typeof window.slopsmith.off === 'function') {
                try { window.slopsmith.off('loop:restart', onLoopRestart); } catch (_) {}
                try { window.slopsmith.off('song:loaded', onSongChanged); } catch (_) {}
                try { window.slopsmith.off('song:ended', onSongChanged); } catch (_) {}
            }
            return;
        }
        drillOnLoopRestartFn = onLoopRestart;
        drillOnSongChangedFn = onSongChanged;
        drillSubscribed = true;
    }

    // ── Chart state sync ─────────────────────────────────────────────
    //
    // `currentArrangement` / `currentStringCount` / `tuningOffsets` /
    // `capo` are read on every match/miss frame to map (string, fret)
    // → MIDI. They live in the factory closure and used to be set ONLY
    // inside enable(), inline, with conditional assignments — each
    // field only updated if the corresponding `info.*` was present.
    //
    // That left a stale-state hole: if a previous song (e.g. a bass
    // arrangement) had set currentArrangement='bass', and a new song
    // loaded with `info.arrangement` briefly falsy / null at enable
    // time, the `if (info && info.arrangement)` line wouldn't fire
    // and the bass arrangement carried over into a guitar chart. The
    // smoking-gun symptom in real-session diagnostics: strings 4-5 of
    // a 6-string guitar chart show 0/N hits with `expectedMidi: null`
    // (because the 4-string bass MIDI base array has no entries at
    // [4] / [5]), and strings 0-3 score wildly off-pitch because
    // they're being compared against bass-octave MIDI values.
    //
    // Fixes here:
    //   1) Reset to a known-good 6-string-guitar default BEFORE
    //      reading info, so a partial / missing payload can't leave
    //      stale fields in place.
    //   2) Wire `song:loaded` + `arrangement:changed` listeners so
    //      mid-session song or arrangement switches re-sync state
    //      instead of waiting for the next enable() (which may never
    //      come if Detect was left on).
    function _syncChartStateFromHw() {
        currentArrangement = 'guitar';
        currentStringCount = 6;
        tuningOffsets = [0, 0, 0, 0, 0, 0];
        capo = 0;
        const info = (hw && hw.getSongInfo) ? hw.getSongInfo() : null;
        if (!info) return;
        if (info.arrangement) currentArrangement = _ndArrangementKindFromName(info.arrangement);
        if (Array.isArray(info.tuning)) tuningOffsets = info.tuning;
        if (Number.isFinite(info.capo)) capo = info.capo;

        // String-count resolution, in precedence order:
        //   1. hw.getStringCount() — host's authoritative count. Asked
        //      independently of info.tuning because the host may know
        //      the count even when no tuning array shipped, and because
        //      arrangement XML pads bass tunings to six entries so tuning.length
        //      alone can't distinguish bass-4 from a real 6-string.
        //   2. tuning.length when it's consistent with the arrangement
        //      — bass-4/5 or guitar-6/7/8. This preserves the older-host
        //      path for 7/8-string guitars and 5-string basses, while
        //      rejecting the arrangement XML bass-padded-to-6 shape (which
        //      falls through to (3) below for the correct bass-4).
        //   3. Per-arrangement default — 4 for bass, 6 for guitar.
        //      Closes the regression a bass chart hit when it had no
        //      tuning array AND no host count: currentStringCount used
        //      to stay at 6, then _ndStandardMidiFor('bass', 6) returned
        //      the 4-entry _ND_TUNING_BASS_4 and strings 4/5 retired
        //      with expectedMidi: null.
        //   4. tuning.length — last-resort fallback when no arrangement
        //      is known.
        const hostStringCount = (hw && hw.getStringCount) ? hw.getStringCount() : undefined;
        if (Number.isFinite(hostStringCount)) {
            currentStringCount = hostStringCount;
        } else if (info.arrangement) {
            const tuneLen = Array.isArray(info.tuning) ? info.tuning.length : null;
            const consistent = currentArrangement === 'bass'
                ? (tuneLen === 4 || tuneLen === 5)
                : (tuneLen === 6 || tuneLen === 7 || tuneLen === 8);
            if (consistent) {
                currentStringCount = tuneLen;
            } else {
                currentStringCount = currentArrangement === 'bass' ? 4 : 6;
            }
        } else if (Array.isArray(info.tuning)) {
            currentStringCount = info.tuning.length;
        }
    }

    // ── Engine-side chart verification (desktop bridge) ───────────────────
    // Build the song's note chart from the host and push it to the desktop
    // engine, which scores it continuously on a background thread. Replaces
    // the renderer's per-tick scoreChord IPC loop. Called once per
    // arrangement load (and on song:loaded / arrangement:changed). When the
    // addon predates the NoteVerifier API the function leaves
    // `_ndUsingEngineVerifier` false and the caller keeps the old matchNotes
    // path. Safe to call when the bridge isn't active — it just no-ops.
    // Cheap signature of the currently-loaded chart — raw note/chord counts
    // plus the active arrangement. Changes exactly when the chart the engine
    // should be scoring changes (late load, song change, arrangement switch).
    function _ndChartSignature() {
        if (!hw || typeof hw.getNotes !== 'function') return '';
        const notes = hw.getNotes() || [];
        const n = notes.length;
        let c = 0;
        for (const ch of (hw.getChords() || [])) c += ((ch && ch.notes) || []).length;
        // Cheap content discriminator: first + last note onset time. Two
        // different songs with the same note/chord counts and arrangement
        // would otherwise hash identically, leaving a stale chart on the
        // engine if a song:loaded handler ever misfired.
        const firstT = n > 0 && Number.isFinite(notes[0].t) ? notes[0].t : 0;
        const lastT = n > 0 && Number.isFinite(notes[n - 1].t) ? notes[n - 1].t : 0;
        // timingTolerance / pitchTolerance are part of the signature so moving
        // a tolerance slider re-pushes the chart and the engine picks the new
        // value up live — without this the popup sliders are inert on the
        // engine-verifier path until the next song/arrangement change.
        return n + ':' + c + ':' + currentArrangement + ':' + currentStringCount
            + ':' + capo + ':' + timingTolerance + ':' + pitchTolerance
            + ':' + firstT + ':' + lastT;
    }

    async function _ndPushChartToBridge() {
        // A contained-playback verifier owns the engine chart slot. A host
        // event (song:loaded, enable, the per-tick re-push) must NOT push the
        // host chart over the contained one, nor wipe the host verifier state
        // we restore on release — so bail before touching anything. The
        // restore path (_ndRestoreHostChart) clears the flag first, so its own
        // re-push proceeds normally. Also bail when a SIBLING instance owns the
        // contained slot on our source (it isn't suspended on our flag).
        if (_ndHostChartSuspended || _ndOtherOwnsOurSlot()) return;
        _ndUsingEngineVerifier = false;
        _ndVerifierChartById = new Map();
        _ndVerifierChords = new Map();
        _ndVerifierChordKeyOf = new Map();
        _ndPendingChords = new Map();
        _ndVerifierChartSig = '';
        _ndLastPushedPlayhead = 0;
        // Native-frame mode runs the local matchNotes pipeline (with engine
        // scoreChord for chords), so the continuous engine chart-verifier is
        // intentionally OFF — leave _ndUsingEngineVerifier false and don't
        // push a chart for it.
        if (!usingDesktopBridge || usingNativeFrames || !bridgeDesktop || !bridgeDesktop.audio) return;
        if (!_ndBridgeVerifierAvailable()) {
            // Downlevel addon (or, for a bound source, no source-indexed verifier
            // API) — fall back to the legacy matchNotes path.
            return;
        }
        if (!hw || typeof hw.getNotes !== 'function' || typeof hw.getChords !== 'function') return;

        const notes = [];
        const byId = new Map();
        // Chord grouping, built alongside `notes` — see _ndVerifierChords.
        const chordGroups = new Map();
        const chordKeyById = new Map();
        // Single notes. `mt` (muted) notes are skipped — the legacy
        // matchNotes path skips them too (`if (n.mt) continue`).
        const single = hw.getNotes() || [];
        for (const n of single) {
            if (!n || n.mt) continue;
            const id = noteKey(n, n.t);
            if (byId.has(id)) continue;
            const entry = {
                id,
                t: n.t,
                s: n.s,
                f: n.f,
                sus: Number.isFinite(n.sus) ? n.sus : 0,
                ho: !!n.ho, po: !!n.po, b: !!n.b, sl: !!n.sl, hm: !!n.hm,
            };
            notes.push(entry);
            byId.set(id, { ...n });
        }
        // Chord constituents from hw.getChords() — pushed as plain notes;
        // chord grouping happens by timestamp below.
        const chords = hw.getChords() || [];
        for (const c of chords) {
            for (const cn of (c.notes || [])) {
                if (!cn || cn.mt) continue;
                const id = noteKey(cn, c.t);
                if (byId.has(id)) continue;
                const entry = {
                    id,
                    t: c.t,
                    s: cn.s,
                    f: cn.f,
                    sus: Number.isFinite(cn.sus) ? cn.sus : 0,
                    ho: !!cn.ho, po: !!cn.po, b: !!cn.b, sl: !!cn.sl, hm: !!cn.hm,
                };
                notes.push(entry);
                byId.set(id, { ...cn, t: c.t });
            }
        }
        // Chord grouping by shared onset time. A power chord / double-stop is
        // 2+ notes at the same chart time — and in many arrangements (the
        // "I'm Alive" Lead included) those arrive through hw.getNotes(), not
        // hw.getChords(). Grouping the flattened note list by timestamp catches
        // chords regardless of which host array delivered them.
        const byTime = new Map();
        for (const e of notes) {
            const tk = e.t.toFixed(3);
            if (!byTime.has(tk)) byTime.set(tk, []);
            byTime.get(tk).push(e);
        }
        for (const [tk, grp] of byTime) {
            if (grp.length < 2) continue;
            const chordKey = tk + '_chord';
            let maxSus = 0;
            for (const e of grp) if ((e.sus || 0) > maxSus) maxSus = e.sus || 0;
            chordGroups.set(chordKey, {
                t: grp[0].t,
                memberIds: grp.map(e => e.id),
                memberNotes: grp.map(e => ({ s: e.s, f: e.f })),
                maxSus,
            });
            for (const e of grp) chordKeyById.set(e.id, chordKey);
        }

        try {
            const verifyParams = _ndVerifyParamsFor(currentArrangement);
            const ok = await _ndBridgeSetChart({
                arrangement: currentArrangement,
                stringCount: currentStringCount,
                tuningOffsets: tuningOffsets.slice(0, currentStringCount),
                capo,
                // The engine's harmonic-comb uses pitchCheckCents as its
                // presence gate — feed the user's Pitch tolerance slider so
                // it is honoured, rather than a fixed constant.
                pitchCheckCents: pitchTolerance,
                harmonicSnr: verifyParams.harmonicSnr,
                // Relax the fundamental-presence gate for bass — its DI
                // fundamental is legitimately weak (see _ndVerifyParamsFor).
                fundamentalRatio: verifyParams.fundamentalRatio,
                // Temporal-persistence floor — bass rejects wrong-position notes
                // that only flicker present on a few frames (see
                // _ndVerifyParamsFor). 0 on guitar keeps the legacy any-frame rule.
                presenceRatio: verifyParams.presenceRatio,
                timingTolerance,
                notes,
            });
            // setChart resolves null on a downlevel addon — keep the legacy
            // path in that case.
            if (ok === null || ok === false) return;
            _ndVerifierChartById = byId;
            _ndVerifierChords = chordGroups;
            _ndVerifierChordKeyOf = chordKeyById;
            _ndPendingChords = new Map();
            _ndVerifierChartSig = _ndChartSignature();
            _ndUsingEngineVerifier = true;
            console.log(`[note_detect] engine chart verifier active — ${notes.length} notes pushed`
                + ` (${chordGroups.size} chords)`);
        } catch (e) {
            console.warn('[note_detect] setChart failed, falling back to matchNotes:',
                e && e.message ? e.message : e);
        }
    }

    // Drain the verdicts the engine's NoteVerifier has finalized and feed
    // each through the SAME judgment pipeline the legacy path uses, so HUD /
    // notedetect:* events / live-judgment JSONL all fire unchanged.
    async function _ndDrainEngineVerdicts() {
        if (!_ndUsingEngineVerifier || !bridgeDesktop || !bridgeDesktop.audio) return;

        // The engine scores against a playhead the renderer pushes: its own
        // JUCE backing transport is frozen for HTML5-routed (sloppak) songs.
        // Push the same corrected clock the legacy matchNotes() path judges
        // against — hw.getTime() + avOffset - latencyOffset.
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const playheadAudio = (hw.getTime ? hw.getTime() : 0) + avOffsetSec - latencyOffset;
        const playing = !!(window.slopsmith && window.slopsmith.isPlaying);

        // A backward jump (drill A-B loop wrap or a manual seek-back): the
        // engine re-opens notes at/after the new position, so drop our dedup
        // entries for those same notes. Otherwise the re-scored verdicts are
        // skipped by the `noteResults.has(key)` guard below and a drilled
        // passage scores only on its first iteration. 0.25 s matches the
        // engine's own backward-jump threshold.
        if (playheadAudio < _ndLastPushedPlayhead - 0.25) {
            for (const [id, cn] of _ndVerifierChartById) {
                if (cn && Number.isFinite(cn.t) && cn.t >= playheadAudio) {
                    noteResults.delete(id);
                    _susActiveUntil.delete(id);
                }
            }
            // Re-opened chords: drop the chord judgment + any half-collected
            // verdicts so the next pass can re-grade the whole chord.
            for (const [ckey, grp] of _ndVerifierChords) {
                if (grp && Number.isFinite(grp.t) && grp.t >= playheadAudio) {
                    noteResults.delete(ckey);
                    _ndPendingChords.delete(ckey);
                }
            }
        }
        _ndLastPushedPlayhead = playheadAudio;

        let verdicts = null;
        try {
            verdicts = await _ndBridgeGetVerdicts(playheadAudio, playing);
        } catch (e) {
            console.warn('[note_detect] getNoteVerdicts failed:', e && e.message ? e.message : e);
            return;
        }
        if (!Array.isArray(verdicts) || verdicts.length === 0) return;

        for (const v of verdicts) {
            if (!v || typeof v.id !== 'string') continue;
            const cn = _ndVerifierChartById.get(v.id);
            if (!cn) continue;

            // Silence gate — see _ndLevelSamples. If the input was below
            // the silence threshold across the entire ±200 ms window
            // around this note's chart time, the engine's "detected:true"
            // is almost certainly a CREPE-on-silence phantom-pitch false
            // positive. Force a miss so the HUD reflects "nothing was
            // played" instead of the engine's optimistic verdict.
            //
            // Skip the gate entirely if the window contained no level
            // samples — e.g. startup, level-meter hiccup, or right after a
            // backward-seek reset cleared the buffer. Treating "no
            // telemetry" as "silent" would force false misses on legitimate
            // detections in those transient states.
            const engineDetectedRaw = !!v.detected;
            const strikeCtx = _ndStrikeLevelContext(cn.t);
            if (v.detected && _ndLevelSamples.length > 0) {
                // _ndLevelSamples are timestamped in the visual clock
                // (hw.getTime() + avOffset), but `cn.t` (and everywhere
                // else in this file that compares times against chart
                // notes) is audio-aligned — see the
                // `hw.getTime() + avOffset - latencyOffset` formula the
                // detection pipeline uses to align audio to chart. So
                // visual time = audio/chart time + latencyOffset. To
                // find level samples that match this note's chart time,
                // center the search at `cn.t + latencyOffset` in visual
                // time; otherwise the configured user latency (up to
                // 250 ms) would push the real peak outside the
                // ±_ND_LEVEL_WIN_HALF window and trip false misses.
                if (strikeCtx.silenceWouldTrigger) {
                    const expectedMidiSg = _ndMidiFromStringFret(
                        cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
                    );
                    _ndLogVerifierRejectOnce('silence:' + v.id, {
                        reason: 'SILENCE_GATE',
                        path: 'desktop-engine-verifier',
                        skipOpenDomainPitchFallback: true,
                        verifierId: v.id,
                        playheadAudio,
                        noteTime: cn.t,
                        string: cn.s,
                        fret: cn.f,
                        expectedMidi: expectedMidiSg,
                        engineDetectedRaw,
                        engineDetected: false,
                        silenceGateApplied: true,
                        strikePeakPct: strikeCtx.strikePeakPct,
                        strikeSamplesInWindow: strikeCtx.strikeSamplesInWindow,
                        inputLevelAtLogPct: strikeCtx.levelAtLogPct,
                        inputPeakPct: strikeCtx.strikePeakPct,
                        rendererPitchPolled: false,
                        detectedSongTime: Number.isFinite(v.detectedSongTime)
                            ? v.detectedSongTime
                            : null,
                        pitchErrorCents: Number.isFinite(v.centsError) ? v.centsError : null,
                        engineVerdict: _ndSnapshotEngineVerdict(v),
                    });
                    v.detected = false;
                }
            }

            // Chord constituent — buffer the verdict until every member of
            // the chord has reported, then judge the whole chord at once
            // with N-of-M leniency (see _ndFinalizeChordVerdict).
            const chordKey = _ndVerifierChordKeyOf.get(v.id);
            if (chordKey) {
                if (noteResults.has(chordKey)) continue;  // chord already judged
                let pc = _ndPendingChords.get(chordKey);
                if (!pc) { pc = new Map(); _ndPendingChords.set(chordKey, pc); }
                pc.set(v.id, v);
                const grp = _ndVerifierChords.get(chordKey);
                if (grp && pc.size >= grp.memberIds.length) {
                    _ndFinalizeChordVerdict(chordKey, grp, pc);
                    _ndPendingChords.delete(chordKey);
                }
                continue;
            }

            // Lone single note.
            const key = v.id;
            if (noteResults.has(key)) continue;

            const expectedMidi = _ndMidiFromStringFret(
                cn.s, cn.f, currentArrangement, currentStringCount, tuningOffsets, capo
            );
            if (v.detected) {
                // detectedSongTime is the playhead the renderer pushed, which
                // is already avOffset/latency-corrected — use it directly. (It
                // was previously the engine's own backing clock and needed the
                // correction here; re-applying it now would double-correct.)
                const judgedAt = v.detectedSongTime;
                const pitchError = Number.isFinite(v.centsError) ? v.centsError : null;
                const detectedMidiForJudgment = Number.isFinite(pitchError)
                    ? expectedMidi + pitchError / 100
                    : null;
                // A bend / slide / harmonic note's pitch deliberately leaves
                // the chart pitch; widen the pitch gate so the hit rides on
                // presence + timing, not a moving target.
                const lenientPitch = !!(cn.b || cn.sl || cn.hm);
                const judgment = makeMatchedJudgment(
                    cn, cn.t, judgedAt, expectedMidi, detectedMidiForJudgment, 1,
                    { pitchError, pitchThresholdCents: lenientPitch ? 600 : undefined }
                );
                if (!judgment.hit) {
                    const teReason = judgment.timingState === 'EARLY' || judgment.timingState === 'LATE'
                        ? 'TIMING_FAIL'
                        : (judgment.pitchState === 'SHARP' || judgment.pitchState === 'FLAT'
                            ? 'PITCH_FAIL'
                            : 'UNKNOWN');
                    _ndLogVerifierRejectOnce(key, {
                        reason: teReason,
                        path: 'desktop-engine-verifier',
                        verifierId: v.id,
                        playheadAudio,
                        noteTime: cn.t,
                        string: cn.s,
                        fret: cn.f,
                        expectedMidi,
                        detectedMidi: detectedMidiForJudgment,
                        confidence: 1,
                        engineDetectedRaw,
                        engineDetected: true,
                        silenceGateApplied: false,
                        detectedSongTime: judgedAt,
                        strikePeakPct: strikeCtx.strikePeakPct,
                        strikeSamplesInWindow: strikeCtx.strikeSamplesInWindow,
                        inputLevelAtLogPct: strikeCtx.levelAtLogPct,
                        rendererPitchPolled: false,
                        timingErrorMs: judgment.timingError,
                        pitchErrorCents: judgment.pitchError,
                        engineVerdict: _ndSnapshotEngineVerdict(v),
                    });
                }
                recordJudgment(key, judgment);
            } else {
                // Engine finalized the note as a miss — its timing window
                // has fully passed. Mirror the legacy checkMisses() retire.
                const t = (hw.getTime ? hw.getTime() : 0) + avOffsetSec - latencyOffset;
                if (!_ndRejectDedup.has('silence:' + key)) {
                    let timingErrorMs = null;
                    if (Number.isFinite(v.timingErrorMs)) timingErrorMs = v.timingErrorMs;
                    else if (Number.isFinite(v.timingError)) timingErrorMs = v.timingError;
                    else if (Number.isFinite(v.detectedSongTime) && Number.isFinite(cn.t)) {
                        timingErrorMs = Math.round((v.detectedSongTime - cn.t) * 1000);
                    }
                    _ndLogVerifierRejectOnce(key, {
                        reason: 'NO_VERDICT',
                        path: 'desktop-engine-verifier',
                        skipOpenDomainPitchFallback: true,
                        verifierId: v.id,
                        playheadAudio,
                        noteTime: cn.t,
                        string: cn.s,
                        fret: cn.f,
                        expectedMidi,
                        engineDetectedRaw,
                        engineDetected: false,
                        silenceGateApplied: false,
                        detectedSongTime: Number.isFinite(v.detectedSongTime)
                            ? v.detectedSongTime
                            : null,
                        strikePeakPct: strikeCtx.strikePeakPct,
                        strikeSamplesInWindow: strikeCtx.strikeSamplesInWindow,
                        inputLevelAtLogPct: strikeCtx.levelAtLogPct,
                        rendererPitchPolled: false,
                        timingErrorMs,
                        pitchErrorCents: Number.isFinite(v.centsError) ? v.centsError : null,
                        engineVerdict: _ndSnapshotEngineVerdict(v),
                    });
                }
                recordJudgment(key, makeMissJudgment(cn, cn.t, t, expectedMidi));
            }
        }

        // Flush stuck chords. A chord is normally judged once every
        // constituent reports a verdict; if the engine ever drops one, the
        // chord would sit in _ndPendingChords forever (checkMisses is
        // short-circuited on this path). Once a pending chord's window has
        // long passed, finalize it with whatever verdicts did arrive —
        // _ndFinalizeChordVerdict handles a partial set (missing members
        // simply don't count toward hitStrings).
        for (const [ckey, pc] of _ndPendingChords) {
            const grp = _ndVerifierChords.get(ckey);
            if (!grp) { _ndPendingChords.delete(ckey); continue; }
            if (playheadAudio > grp.t + (grp.maxSus || 0) + timingTolerance + 1.0) {
                _ndFinalizeChordVerdict(ckey, grp, pc);
                _ndPendingChords.delete(ckey);
            }
        }
    }

    // Judge a whole chord from its constituents' engine verdicts. A chord is
    // a hit when at least chordHitRatio of its strings verified (N-of-M
    // leniency) — power-chord constituents share harmonics, so demanding
    // every string would reject chords that clearly rang. Emits one chord
    // judgment (chord:true), mirroring the legacy chord path.
    function _ndFinalizeChordVerdict(chordKey, grp, verdictMap) {
        if (noteResults.has(chordKey)) return;
        let hitStrings = 0;
        let detectedTime = null;   // onset-derived time from a struck string
        let bestCents = null;
        for (const id of grp.memberIds) {
            const v = verdictMap.get(id);
            if (v && v.detected) {
                hitStrings++;
                if (detectedTime === null) detectedTime = v.detectedSongTime;
                if (bestCents === null && Number.isFinite(v.centsError)) bestCents = v.centsError;
            }
        }
        const totalStrings = grp.memberIds.length;
        const score = totalStrings > 0 ? hitStrings / totalStrings : 0;
        const lead = _ndVerifierChartById.get(grp.memberIds[0]) || { s: 0, f: 0 };
        const expectedMidi = _ndMidiFromStringFret(
            lead.s, lead.f, currentArrangement, currentStringCount, tuningOffsets, capo
        );
        const lateGraceMs = Math.min((grp.maxSus || 0) * 1000, 1000);

        const chordIsHit = score >= chordHitRatio && detectedTime !== null;
        if (chordIsHit) {
            const detMidi = Number.isFinite(bestCents) ? expectedMidi + bestCents / 100 : null;
            recordJudgment(chordKey, makeMatchedJudgment(
                lead, grp.t, detectedTime, expectedMidi, detMidi, 1,
                { chord: true, notes: grp.memberNotes, hitStrings, totalStrings,
                  score, pitchError: bestCents, lateGraceMs }
            ));
        } else {
            // Match the legacy chord-miss path: judgedAt is the current
            // corrected playhead (matchChords' `t`, not the chord's chart
            // time), and lateGraceMs is included so a chord with a long
            // sustain stays open to a late grab — both fields needed for
            // _ndMakeJudgment's timing classification to give the same
            // result as the legacy browser/desktop chord-miss path.
            const avOffsetSecMiss = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
            const missJudgedAt = (hw.getTime ? hw.getTime() : 0) + avOffsetSecMiss - latencyOffset;
            _ndLogVerifierRejectOnce(chordKey, {
                reason: 'CHORD_RATIO_FAIL',
                noteTime: grp.t,
                chord: true,
                expectedMidi,
                hitStrings,
                totalStrings,
                chordScore: score,
            });
            recordJudgment(chordKey, makeMissJudgment(
                lead, grp.t, missJudgedAt, expectedMidi,
                { chord: true, notes: grp.memberNotes, hitStrings, totalStrings, score, lateGraceMs }
            ));
        }

        // Stash a per-constituent judgment for every chord string, keyed by
        // its own noteKey (== its engine id). The chord-level judgment above
        // owns the HUD totals / event log; these per-string entries exist
        // purely so the highway's note-state provider (slopsmith#254) can
        // tint each chord gem and the chord frame. Without them the engine
        // path stored only `chordKey`, which the highway never queries —
        // hence the missing chord hit/miss feedback.
        //
        // Every constituent carries the *chord-level* verdict, not its own
        // string's detection: a chord is judged as a unit under N-of-M
        // leniency — power-chord strings share harmonics, so not every
        // string verifies individually even on a clean strum. Tinting each
        // gem and the chord frame with the unit verdict keeps them
        // consistent: the frame goes green when the chord scored a hit,
        // instead of red because one harmonically-masked string failed to
        // verify on its own. (Stashed straight into noteResults +
        // _recordPerStringForChord, bypassing recordJudgment so the chord
        // isn't double-counted in HUD totals.)
        const avOffsetSec = (hw.getAvOffset ? hw.getAvOffset() / 1000 : 0);
        const nowSongT = (hw.getTime ? hw.getTime() : 0) + avOffsetSec;
        const missAt = nowSongT - latencyOffset;
        for (const id of grp.memberIds) {
            if (noteResults.has(id)) continue;
            const mcn = _ndVerifierChartById.get(id);
            if (!mcn) continue;
            const mExpectedMidi = _ndMidiFromStringFret(
                mcn.s, mcn.f, currentArrangement, currentStringCount, tuningOffsets, capo
            );
            // The noteResults entry is stamped with the chord-level verdict
            // (so the highway tints every chord gem and the chord frame
            // consistently — power-chord strings share harmonics and aren't
            // each independently verifiable under N-of-M leniency). But the
            // per-string diagnostic counter (_diagPerString via
            // _recordPerStringForChord) needs the *individual* constituent
            // outcome to stay accurate — otherwise a 4-string chord scored
            // hit via N-of-M would credit all four strings as hits even
            // when only two were actually detected, inflating per-string
            // accuracy.
            const constituentDetected = !!(verdictMap.get(id) || {}).detected;
            let mJudgment;
            if (chordIsHit) {
                // Pass `chord: true` so _ndMakeJudgment routes through the
                // chord-judgment branch and the per-constituent `hit`
                // tracks the chord-level verdict (timing-only). Without
                // it, `hit` gets gated by per-string pitchState/
                // pitchHitThreshold and can become false even when
                // chordIsHit is true — e.g. a chord scored a hit via
                // N-of-M leniency but bestCents (lifted from one
                // constituent) sits outside the 28¢ pitch threshold.
                // That false-`hit` would then make noteStateFor return
                // 'miss' for the constituent, undoing the whole point of
                // stamping it with the chord verdict.
                const lenientPitch = !!(mcn.b || mcn.sl || mcn.hm);
                const mDetMidi = Number.isFinite(bestCents)
                    ? mExpectedMidi + bestCents / 100 : null;
                mJudgment = makeMatchedJudgment(
                    mcn, mcn.t, detectedTime, mExpectedMidi, mDetMidi, 1,
                    { chord: true, pitchError: bestCents,
                      pitchThresholdCents: lenientPitch ? 600 : undefined,
                      lateGraceMs }
                );
            } else {
                mJudgment = makeMissJudgment(mcn, mcn.t, missAt, mExpectedMidi,
                    { chord: true, lateGraceMs });
            }
            // Verdict landed now — anchor the highway gem's display window
            // here (see recordJudgment / noteStateFor).
            mJudgment._ndDisplayFrom = nowSongT;
            noteResults.set(id, mJudgment);
            // Per-string diagnostic uses the individual outcome rather than
            // the unit chord verdict. Built as a minimal shape — only `hit`
            // and `chartNote` are read by _recordPerStringForChord.
            _recordPerStringForChord({ hit: constituentDetected, chartNote: mcn });
        }
    }

    // ── Contained-playback verifier implementation ───────────────────────────
    // True when this build can run a contained verifier: the desktop bridge
    // exposes the continuous chart-verifier API. Browser / downlevel addon →
    // false, and setContainedChart returns null so the consumer falls back.
    function _ndContainedVerifierAvailable() {
        return usingDesktopBridge && _ndBridgeVerifierAvailable();
    }

    // True when ANOTHER detector instance owns the contained slot on the SAME
    // engine source this instance pushes to — so we must NOT touch that shared
    // slot (re-push our host chart, drain host verdicts) or we'd overwrite its
    // contained chart. _ndHostChartSuspended only covers the OWNING instance;
    // this covers the others on that source. A different source = a different
    // slot = no contention.
    function _ndOtherOwnsOurSlot() {
        const owner = _ndShared.containedSlotOwners.get(sourceId);
        return !!owner && owner !== api;
    }

    // Park host-song scoring while a contained chart owns the engine slot.
    // Flips the suspend gate BEFORE any await in the caller, so an interleaving
    // detect tick already sees it.
    function _ndSuspendHostChart() {
        if (_ndHostChartSuspended) return;
        _ndHostChartSuspended = true;
        // Park the flag so a straggler tick that slipped past the suspend gate
        // can't drain host verdicts against the contained chart.
        _ndUsingEngineVerifier = false;
    }

    // Restore host-song scoring after a contained chart is released. Forces a
    // fresh host chart push (the engine slot still holds the contained chart),
    // re-arming _ndUsingEngineVerifier on a live host song.
    async function _ndRestoreHostChart() {
        if (!_ndHostChartSuspended) return;
        _ndHostChartSuspended = false;
        // If a sibling instance grabbed the contained slot on our source in the
        // meantime, don't re-push our host chart over its contained chart.
        if (_ndOtherOwnsOurSlot()) return;
        // Force a re-push: the signature guard in the detect loop compares
        // against _ndVerifierChartSig, which _ndPushChartToBridge resets, so a
        // direct call here re-pushes the host chart over the contained one.
        try {
            await _ndPushChartToBridge();
        } catch (e) {
            console.warn('[note_detect] host chart restore failed:', e && e.message ? e.message : e);
        }
    }

    // Arm a contained-playback chart: take the engine slot, suspend host
    // scoring, and push the caller's notes (scored against an optional tuning
    // ctx — see _ndSanitizeVerifyCtx). Returns true on success, false when
    // another instance already owns the slot, null on browser/downlevel.
    async function _ndSetContainedChart(notes, ctx) {
        if (!_ndContainedVerifierAvailable()) return null;
        if (!Array.isArray(notes) || notes.length === 0) {
            // Empty/null → treat as a clear, and report NOT ARMED (false). The
            // return value is uniformly "is a contained chart now armed?", so a
            // caller that armed with an empty set falls back rather than believing
            // contained mode is live with nothing on the slot. Release whenever
            // THIS instance holds contained state in ANY form — active, or merely
            // claimed/suspended with a setChart IPC still in flight — so the clear
            // also CANCELS an in-flight arm (release bumps _ndContainedGen, which
            // makes that arm's resume bail). Checking _ndContainedActive alone
            // would miss the in-flight window (active is false until success).
            if (_ndContainedActive || _ndHostChartSuspended || _ndShared.containedSlotOwners.get(sourceId) === api) {
                await _ndReleaseContainedChart();
            }
            return false;
        }
        // One chart slot PER engine source. Refuse if a DIFFERENT instance holds
        // the slot on OUR source (our own re-arm is fine; a different source is a
        // different slot, so it doesn't contend).
        if (_ndOtherOwnsOurSlot()) {
            return false;
        }

        const vctx = _ndSanitizeVerifyCtx(ctx);   // null → host live tuning
        const arrangement = vctx ? vctx.arrangement : currentArrangement;
        const stringCount = vctx ? vctx.stringCount : currentStringCount;
        const offsets = vctx ? vctx.offsets.slice(0, stringCount)
            : tuningOffsets.slice(0, currentStringCount);
        const containedCapo = vctx ? vctx.capo : capo;

        // Sanitize the caller's notes into engine entries. The caller supplies
        // a stable `id` per note so a drained verdict maps back to its exercise
        // note; without one we can't return a usable verdict, so skip it.
        const entries = [];
        const byId = new Map();
        for (const n of (notes || [])) {
            if (!n || typeof n.id !== 'string' || !n.id) continue;
            if (!Number.isInteger(n.s) || n.s < 0 || n.s >= stringCount) continue;
            if (!Number.isInteger(n.f) || n.f < 0) continue;
            if (byId.has(n.id)) continue;
            const entry = {
                id: n.id,
                t: Number.isFinite(n.t) ? n.t : 0,
                s: n.s,
                f: n.f,
                sus: Number.isFinite(n.sus) ? n.sus : 0,
                ho: !!n.ho, po: !!n.po, b: !!n.b, sl: !!n.sl, hm: !!n.hm,
            };
            entries.push(entry);
            byId.set(n.id, { ...n });
        }
        // Nothing well-formed to push — DON'T claim the slot or suspend host
        // scoring (else the caller believes it's armed while the host keeps
        // running). Return false so the consumer falls back.
        if (entries.length === 0) return false;

        // Claim the single engine slot SYNCHRONOUSLY — before any await — so a
        // concurrent arm on another instance is refused (it sees the owner set),
        // and stamp a generation so a release/disable/newer-arm during the
        // setChart IPC invalidates this continuation.
        const myGen = ++_ndContainedGen;
        _ndShared.containedSlotOwners.set(sourceId, api);   // claim the slot on our source
        // Re-arm safety: mark NOT-active until the new chart is confirmed. On a
        // re-arm by the same instance the previous chart was still active, and a
        // pushContainedPlayhead during the new setChart IPC would otherwise drain
        // the OLD chart (the engine slot/byId map don't update until the await
        // resolves). Cleared here, set true only on success below.
        _ndContainedActive = false;
        _ndContainedVerdictBuf = [];
        // Suspend host scoring BEFORE the setChart await so an interleaving
        // host detect tick already sees the gate.
        _ndSuspendHostChart();

        const verifyParams = _ndVerifyParamsFor(arrangement);
        let ok = null;
        try {
            ok = await _ndBridgeSetChart({
                arrangement,
                stringCount,
                tuningOffsets: offsets,
                capo: containedCapo,
                // A contained consumer has no host Pitch-tolerance slider —
                // use the arrangement's verify cents (guitar 50 / bass 60).
                pitchCheckCents: arrangement === 'bass'
                    ? _ND_VERIFY_PITCH_CENTS_BASS : _ND_VERIFY_PITCH_CENTS,
                harmonicSnr: verifyParams.harmonicSnr,
                fundamentalRatio: verifyParams.fundamentalRatio,
                presenceRatio: verifyParams.presenceRatio,
                timingTolerance,
                notes: entries,
            });
        } catch (e) {
            console.warn('[note_detect] setContainedChart failed:', e && e.message ? e.message : e);
            ok = null;
        }
        // Superseded while the setChart IPC was in flight (a release/disable, or
        // a newer arm)? Don't resurrect contained mode. If a release ran, OUR
        // chart may have landed on the engine slot AFTER its host re-push — so
        // force the host chart back, but ONLY when our slot is now unowned: if a
        // newer arm (ours) or another instance owns it, leave it to them (don't
        // clobber). A different-source owner doesn't own OUR slot, so we still
        // restore.
        //
        // Note on two arms racing the SAME source within one IPC round-trip: the
        // newer owner is whoever called setChart last, and `audio:setChart` rides
        // a single ordered ipcRenderer.invoke channel, so the newer arm's chart
        // lands last on the slot. We rely on that ordering rather than a per-source
        // IPC lock — and in practice the only contained consumer is the default
        // singleton (one source), so two same-source arms don't occur.
        if (myGen !== _ndContainedGen) {
            const slotOwnedHere = !!_ndShared.containedSlotOwners.get(sourceId);
            if (!slotOwnedHere && !_ndHostChartSuspended) {
                try { _ndVerifierChartSig = ''; await _ndPushChartToBridge(); } catch (_) {}
            }
            return false;
        }
        if (ok === null || ok === false) {
            // Push failed (downlevel / error) — release the slot claim and undo
            // the suspend so host scoring resumes cleanly.
            if (_ndShared.containedSlotOwners.get(sourceId) === api) _ndShared.containedSlotOwners.delete(sourceId);
            await _ndRestoreHostChart();
            return ok;
        }
        _ndContainedActive = true;
        _ndContainedById = byId;
        _ndContainedCtx = vctx;
        _ndContainedVerdictBuf = [];
        _ndContainedLastPlayhead = 0;
        // (slot ownership was claimed synchronously above)
        console.log(`[note_detect] contained verifier active — ${entries.length} notes`
            + ` (${arrangement}, ${stringCount} strings)`);
        return true;
    }

    // Drive the engine clock with the consumer's OWN playhead and stash the
    // finalized verdicts for drainContainedVerdicts(). `t` is the consumer's
    // already-corrected exercise time — pushed verbatim (no host avOffset /
    // latency math; the consumer owns its clock).
    async function _ndPushContainedPlayhead(t, playing) {
        // Only the slot owner drives the engine, and only while armed — a stale
        // instance (lost the owner race, or released) must not advance/drain the
        // shared verifier against another consumer's chart.
        if (!_ndContainedActive || _ndShared.containedSlotOwners.get(sourceId) !== api) return;
        const myGen = _ndContainedGen;
        const songTime = Number.isFinite(t) ? t : 0;
        // Backward jump (drill loop / restart): drop buffered verdicts for
        // notes at/after the new position so they can be re-collected.
        if (songTime < _ndContainedLastPlayhead - 0.25 && _ndContainedVerdictBuf.length) {
            _ndContainedVerdictBuf = _ndContainedVerdictBuf.filter(v => {
                const cn = v && _ndContainedById.get(v.id);
                return !(cn && Number.isFinite(cn.t) && cn.t >= songTime);
            });
        }
        _ndContainedLastPlayhead = songTime;
        let verdicts = null;
        try {
            verdicts = await _ndBridgeGetVerdicts(songTime, !!playing);
        } catch (e) {
            console.warn('[note_detect] contained getNoteVerdicts failed:',
                e && e.message ? e.message : e);
            return;
        }
        // Released / disabled / re-armed while the getNoteVerdicts IPC was in
        // flight — drop this result rather than buffer it against stale state.
        if (myGen !== _ndContainedGen || !_ndContainedActive) return;
        if (Array.isArray(verdicts) && verdicts.length) {
            for (const v of verdicts) {
                if (v && typeof v.id === 'string' && _ndContainedById.has(v.id)) {
                    _ndContainedVerdictBuf.push(v);
                }
            }
            // Bound the buffer (a stalled/forgetful consumer): keep the most
            // recent, drop the oldest.
            if (_ndContainedVerdictBuf.length > _ND_CONTAINED_BUF_MAX) {
                _ndContainedVerdictBuf.splice(0, _ndContainedVerdictBuf.length - _ND_CONTAINED_BUF_MAX);
            }
        }
    }

    // Return + clear the buffered raw engine verdicts. The consumer owns
    // judgment; we do NOT run these through recordJudgment / the HUD.
    function _ndDrainContainedVerdicts() {
        if (!_ndContainedVerdictBuf.length) return [];
        const out = _ndContainedVerdictBuf;
        _ndContainedVerdictBuf = [];
        return out;
    }

    // Disarm the contained chart and restore host-song scoring.
    async function _ndReleaseContainedChart() {
        if (!_ndContainedActive && !_ndHostChartSuspended) return;
        _ndContainedGen++;   // invalidate any in-flight arm/push so it can't resurrect contained mode
        _ndContainedActive = false;
        _ndContainedById = new Map();
        _ndContainedCtx = null;
        _ndContainedVerdictBuf = [];
        _ndContainedLastPlayhead = 0;
        if (_ndShared.containedSlotOwners.get(sourceId) === api) _ndShared.containedSlotOwners.delete(sourceId);
        await _ndRestoreHostChart();
    }

    let _chartStateSubscribed = false;
    let _chartStateOnChange = null;
    function _chartStateBindEvents() {
        if (_chartStateSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        // On a song / arrangement change, refresh the chart context and —
        // on the desktop bridge — re-push the new note chart to the engine
        // verifier. _ndPushChartToBridge() no-ops on the browser path.
        const onChange = () => {
            _syncChartStateFromHw();
            // Swallow rejections — a chart-build failure (e.g. hw.getNotes()
            // throwing) inside a slopsmith host event callback must not
            // surface as an unhandled rejection in the host's dispatch.
            Promise.resolve(_ndPushChartToBridge()).catch(() => {});
        };
        try {
            // song:loaded fires early (with metadata) — chart contents
            // (notes / chords / beats) stream in afterwards over the WS.
            // song:ready fires once the chart has fully arrived, which is
            // the actually-correct moment to push to the engine. We
            // subscribe to both: song:loaded keeps the legacy path that
            // also resets chart-derived state, and song:ready guarantees
            // a re-push once hw.getNotes()/getChords() returns the full
            // chart instead of an empty / partial early snapshot.
            window.slopsmith.on('song:loaded',          onChange);
            window.slopsmith.on('song:ready',           onChange);
            window.slopsmith.on('arrangement:changed',  onChange);
        } catch (e) {
            if (typeof window.slopsmith.off === 'function') {
                try { window.slopsmith.off('song:loaded',         onChange); } catch (_) {}
                try { window.slopsmith.off('song:ready',          onChange); } catch (_) {}
                try { window.slopsmith.off('arrangement:changed', onChange); } catch (_) {}
            }
            return;
        }
        _chartStateOnChange = onChange;
        _chartStateSubscribed = true;
    }
    function _chartStateUnbindEvents() {
        if (!_chartStateSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function' && _chartStateOnChange) {
            try { window.slopsmith.off('song:loaded',         _chartStateOnChange); } catch (_) {}
            try { window.slopsmith.off('song:ready',          _chartStateOnChange); } catch (_) {}
            try { window.slopsmith.off('arrangement:changed', _chartStateOnChange); } catch (_) {}
        }
        _chartStateOnChange = null;
        _chartStateSubscribed = false;
    }

    function _drillUnbindEvents() {
        if (!drillSubscribed) return;
        // destroy() calls this on teardown — a misbehaving host
        // throwing from .off() would otherwise crash destroy and
        // leave the instance partially torn down. Guard each call
        // independently so one bad listener doesn't block the rest.
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (drillOnLoopRestartFn) {
                try { window.slopsmith.off('loop:restart', drillOnLoopRestartFn); } catch (e) {}
            }
            if (drillOnSongChangedFn) {
                try { window.slopsmith.off('song:loaded', drillOnSongChangedFn); } catch (e) {}
                try { window.slopsmith.off('song:ended', drillOnSongChangedFn); } catch (e) {}
            }
        }
        drillSubscribed = false;
        drillOnLoopRestartFn = null;
        drillOnSongChangedFn = null;
    }

    // End-of-song summary. Fire showSummary() when the audio reaches
    // its natural end with detection still on. The playSong wrapper
    // silent-disables on song-switch so this only runs for genuine
    // end-of-track 'ended' events (the wrapper's silent disable
    // happens via stopAudio() which doesn't emit song:ended). Default
    // singleton only — splitscreen panels each have their own
    // instance and a per-panel modal would be visually noisy.
    //
    // After surfacing the summary we silent-disable: detection has
    // nothing to listen to with the song stopped, and leaving it on
    // would mean a follow-up manual Detect-toggle-off pops a second
    // summary (showSummary publishes notedetect:session, so a duplicate
    // also doubles the journal event). The user re-enables for the
    // next track the same way they already do today — the playSong
    // wrapper silent-disables on song-switch regardless.
    function _endOfSongOnEnded() {
        if (!isDefault) return;
        if (!enabled) return;
        // showSummary() has its own `total < 5` guard, so a song that
        // ended before the user played anything meaningful is silently
        // skipped. When a training take is armed, _recOnEnded opens the
        // consent modal on this same event — so BUILD the summary now
        // (capturing this song's stats into the overlay DOM) but start
        // it hidden, and reveal it once the consent flow closes. Build-
        // now matters: a new song's playSong hook resets hits/misses, so
        // a deferred *re-render* would describe the wrong song.
        try {
            // claimAutoExit: this is the natural song-end summary, so it owns
            // the host's post-song return (see showSummary / _ndDismissSummary).
            const built = showSummary({ startHidden: _recArmedForTraining, claimAutoExit: true });
            // Only mark deferred when an overlay was actually built and
            // hidden — a <5-judgment take builds nothing, so there'd be
            // nothing for _runDeferredSummary() to reveal.
            if (_recArmedForTraining && built) _summaryDeferred = true;
            // Award XP for the take through the minigames profile. Natural
            // song end only — the disable()-triggered summary and manual
            // api.showSummary() calls deliberately don't award (they can
            // fire repeatedly for one take). Gated on `built` so the same
            // <5-judgment takes that skip the summary also skip XP.
            // Idempotency lives inside _submitSongXp().
            if (built) _submitSongXp();
        } catch (e) {
            console.warn('[note_detect] end-of-song summary failed:', e && e.message ? e.message : e);
        }
        try { disable({ silent: true }); } catch (e) {}
    }

    // Submit the finished take to the minigames XP/profile backend via its
    // frontend SDK. minigames is an optional plugin — when it's absent (or
    // the request fails) this is a silent no-op: XP is a bonus layered on
    // top of the summary, never something that can break it. On success,
    // fill the summary's XP row (.nd-sum-xp) if the overlay carries one.
    // Once-per-take guard lives HERE (not just at the call site) so any
    // other caller of the exposed hook can't double-award a take;
    // resetScoring() re-arms it on every song switch / retry.
    async function _submitSongXp() {
        if (_xpSubmittedTake) return;
        // Claim the take up-front (dedupes a concurrent duplicate
        // song:ended while the request is in flight). The claim is
        // RELEASED only on the deterministic no-op below (SDK absent —
        // provably nothing was submitted) and HELD on a caught rejection:
        // an error from submitRun is ambiguous (a timeout can land after
        // the backend already persisted the award), and double-crediting
        // the profile is worse than occasionally losing one transient
        // take. resetScoring() re-arms per take as always.
        _xpSubmittedTake = true;
        const mg = window.slopsmithMinigames;
        if (!mg || typeof mg.submitRun !== 'function') {
            _xpSubmittedTake = false;
            return;
        }
        const currentHw = resolveHw();
        const info = currentHw && currentHw.getSongInfo ? currentHw.getSongInfo() : null;
        const total = hits + misses;
        const accuracy = total > 0 ? Math.round((hits / total) * 100) : 0;
        try {
            const res = await mg.submitRun({
                game_id: 'song_play',
                score,
                duration_ms: (info && Number.isFinite(info.duration))
                    ? Math.round(info.duration * 1000) : 0,
                meta: {
                    title: info && info.title || '',
                    artist: info && info.artist || '',
                    arrangement: info && info.arrangement || '',
                    accuracy,
                    hits,
                    misses,
                    bestStreak,
                    maxMultiplier,
                    grade: _ndGradeFor(accuracy),
                    fullCombo: misses === 0,
                },
            });
            _fillSummaryXpRow(res);
        } catch (e) {
            // Swallow — offline backend, killed request, profile-save race:
            // none of these should surface as a summary failure. The claim
            // stays held (see above): the failure is ambiguous and a retry
            // could double-credit the profile.
        }
    }

    // Surface the XP award on the open summary overlay. The redesigned
    // results screen ships a styled .nd-sum-xp slot; when the overlay
    // predates it (this scoring engine can land ahead of the visual
    // redesign), append a minimal row to the panel so the award is still
    // visible. No overlay at all (closed already) → quietly do nothing.
    function _fillSummaryXpRow(res) {
        if (!res || !res.ok) return;
        const overlay = instanceRoot.querySelector('.nd-summary-overlay');
        if (!overlay) return;
        let row = overlay.querySelector('.nd-sum-xp');
        if (!row) {
            const panel = overlay.firstElementChild;
            if (!panel) return;
            row = document.createElement('div');
            row.className = 'nd-sum-xp text-center text-sm text-green-400 mt-2';
            panel.appendChild(row);
        }
        // Progression (core spec 010): the earned currency is Decibels (dB);
        // the XP-derived level is gone from the UI (Mastery Rank replaced it),
        // so the old "· Level N" suffix is dropped rather than relabeled.
        row.textContent = `+${res.xp_gained} dB`;
        row.classList.remove('hidden');
    }

    // Reveal a summary overlay that was built hidden because a training
    // consent modal was occupying the screen. Idempotent — clears the
    // flag so it runs at most once per deferral.
    function _runDeferredSummary() {
        if (!_summaryDeferred) return;
        _summaryDeferred = false;
        if (!isDefault) return;
        const overlay = instanceRoot.querySelector('.nd-summary-overlay');
        if (overlay) {
            overlay.style.display = '';
            // Play the reveal sequence now that the overlay is actually
            // visible, using the stats captured at build time (the live
            // counters may already belong to the next song).
            _animateSummary(overlay, overlay._ndReveal);
        }
    }

    function _endOfSongBindEvents() {
        if (endOfSongSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        const fn = _endOfSongOnEnded;
        try {
            window.slopsmith.on('song:ended', fn);
        } catch (e) {
            return;
        }
        endOfSongOnEndedFn = fn;
        endOfSongSubscribed = true;
    }

    function _endOfSongUnbindEvents() {
        if (!endOfSongSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function' && endOfSongOnEndedFn) {
            try { window.slopsmith.off('song:ended', endOfSongOnEndedFn); } catch (e) {}
        }
        endOfSongSubscribed = false;
        endOfSongOnEndedFn = null;
    }

    // Re-arm Detect across song changes. The playSong wrapper silent-disables
    // every instance on a song switch and tries to re-enable the singleton, but
    // it does so right after origPlaySong() resolves — BEFORE the new song's
    // chart/highway is ready — so enable() can bail at the resolveHw() guard and
    // leave Detect off (users then had to re-press it every song). song:loaded
    // fires once the chart IS ready (highway.js emits it after the WS load), on
    // every load path (modern or legacy window.playSong), so it's the reliable
    // moment to honour the standing preference. Default singleton only; no-op if
    // the user turned Detect off (wantsDetect false) or it's already on.
    function _reArmOnSongLoaded() {
        if (!isDefault) return;
        // While split mode owns detection (its panels score per-input), the main-
        // player singleton must stay off — otherwise it re-arms here on every song
        // load and renders a second HUD on top of P1. Splitscreen sets this flag.
        if (typeof window !== 'undefined' && window.__ndSuppressDefault) return;
        if (enabled) return;
        if (!detectPreference) return;
        enable().catch((e) => {
            console.warn('[note_detect] auto re-arm on song:loaded failed:',
                e && e.message ? e.message : e);
        });
    }

    function _reArmBindEvents() {
        if (reArmSubscribed) return;
        if (!isDefault) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        const fn = _reArmOnSongLoaded;
        try {
            window.slopsmith.on('song:loaded', fn);
        } catch (e) {
            return;
        }
        reArmOnLoadedFn = fn;
        reArmSubscribed = true;
    }

    function _reArmUnbindEvents() {
        if (!reArmSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function' && reArmOnLoadedFn) {
            try { window.slopsmith.off('song:loaded', reArmOnLoadedFn); } catch (e) {}
        }
        reArmSubscribed = false;
        reArmOnLoadedFn = null;
    }

    // Render the drill HUD panel — current iteration header (live
    // counter + accuracy) plus the last 5 completed iterations with
    // best/worst highlighting. Hides itself entirely when drill is
    // neither active nor has history. UI only; no state mutation.
    // Gated on drillDirty so we don't re-parse innerHTML on every
    // 33 ms HUD tick when nothing changed.
    function _drillRender() {
        if (!drillDirty) return;
        drillDirty = false;
        const panel = instanceRoot.querySelector('.nd-drill');
        if (!panel) return;
        // Hide entirely when neither active nor populated — keeps the
        // HUD compact in non-drill use.
        const hasHistory = drillIterations.length > 0;
        if (!drillEnabled && !hasHistory) {
            panel.classList.add('hidden');
            return;
        }
        panel.classList.remove('hidden');
        const headerEl = panel.querySelector('.nd-drill-header');
        const listEl = panel.querySelector('.nd-drill-list');
        if (headerEl) {
            if (drillEnabled) {
                const liveTotal = drillIterHits + drillIterMisses;
                const liveAcc = liveTotal > 0 ? Math.round((drillIterHits / liveTotal) * 100) : null;
                // Use the monotonic counter, NOT iterations.length + 1
                // — the array splices from the front at the truncation
                // cap, so `length + 1` would freeze at #51 forever.
                const num = drillNextIdx;
                headerEl.textContent = liveAcc !== null
                    ? `Drill #${num}: ${drillIterHits}/${liveTotal} (${liveAcc}%)`
                    : `Drill #${num}`;
            } else {
                // Drill stopped (loop cleared), but history is still
                // visible — label it so the user knows.
                headerEl.textContent = `Drill (last loop)`;
            }
        }
        if (listEl) {
            if (!hasHistory) {
                listEl.textContent = '';
            } else {
                // Show the last 5 iterations, oldest -> newest. Find
                // best/worst within the visible window for highlighting.
                const recent = drillIterations.slice(-5);
                let best = recent[0], worst = recent[0];
                for (const it of recent) {
                    if (it.accuracy > best.accuracy) best = it;
                    if (it.accuracy < worst.accuracy) worst = it;
                }
                const parts = recent.map((it) => {
                    const tag = it === best && recent.length > 1
                        ? ' <span style="color:#00ff88">★</span>'
                        : it === worst && recent.length > 1
                            ? ' <span style="color:#ff4444">·</span>'
                            : '';
                    return `#${it.idx} ${it.hits}/${it.hits + it.misses} ${it.accuracy}%${tag}`;
                });
                listEl.innerHTML = parts.join('<br>');
            }
        }
    }

    // Bridge slopsmith loop state into our drillEnabled flag and
    // detect mid-drill loop bounds changes (user picked a different
    // saved loop). Called from updateHUD every 33 ms and from
    // enable() once at activation. Cheap — one getLoop read + a
    // boolean compare.
    function _drillSyncFromLoopState() {
        const { loopA, loopB } = _drillCurrentLoop();
        // Require finite numbers, not just non-null. A malformed return
        // (e.g. {}, undefined fields) would otherwise activate drill
        // mode and start mutating per-iteration counters against bogus
        // bounds.
        const nowEnabled = Number.isFinite(loopA) && Number.isFinite(loopB);
        if (nowEnabled && !drillEnabled) {
            // Drill just (re)started. Treat re-activation after a
            // previously-cleared loop the same way as a mid-drill
            // bounds change: if the new bounds DIFFER from the last
            // active bounds (drillActiveLoopA/B kept across the
            // deactivation), the iteration history is from a
            // different passage and must be cleared. If they match
            // exactly, the user just reopened the same loop and the
            // history is comparable.
            const sameBounds = (loopA === drillActiveLoopA && loopB === drillActiveLoopB);
            if (!sameBounds) {
                drillIterations = [];
                drillNextIdx = 1;
            }
            drillActiveLoopA = loopA;
            drillActiveLoopB = loopB;
            // Anchor at loopA (the iteration's true start) rather
            // than hw.getTime(): the user might enable detection
            // mid-iteration, but the iteration we're starting to
            // track conceptually begins at A.
            _drillResetIteration(loopA);
            drillDirty = true;
        } else if (nowEnabled && drillEnabled) {
            // Loop bounds changed mid-drill — different passage.
            // Clear history so the iteration list isn't comparing
            // apples to oranges.
            if (loopA !== drillActiveLoopA || loopB !== drillActiveLoopB) {
                drillIterations = [];
                drillNextIdx = 1;
                drillActiveLoopA = loopA;
                drillActiveLoopB = loopB;
                _drillResetIteration(loopA);
                drillDirty = true;
            }
        } else if (!nowEnabled && drillEnabled) {
            // Loop cleared. Keep the iteration history visible for
            // the user to review; just stop counting.
            _drillResetIteration(null);
            drillDirty = true;
        }
        drillEnabled = nowEnabled;
    }

    // Tracks an in-flight enable() promise. A second enable() call
    // while the first is still awaiting startAudio returns the
    // SAME promise rather than short-circuiting on the already-set
    // `enabled` flag — otherwise the second caller would see
    // `return true` while audio isn't actually started yet, and if
    // startAudio ultimately failed, the first call's cleanup would
    // flip `enabled` back to false after the second had already
    // reported success.
    /* ── External detection source — note-detection domain consumer (spec 009) ─
     * When a non-audio provider (e.g. the MIDI keys highway) has an open
     * detection binding, notedetect scores from its reported verdicts instead
     * of the mic, driving the SAME HUD + graded/currency summary. Scoring math
     * is untouched: external hit/miss verdicts feed recordJudgment() exactly
     * like the audio path (emit:true so the core stats-recorder/progression
     * award fires too). The source's own /api/stats POST is suppressed so this
     * doesn't double-count. */
    let _extActive = false;
    let _extOnHit = null, _extOnMiss = null, _extWatchOpen = null, _extWatchClose = null;
    let _extPending = [];   // verdicts seen before external mode fully armed (flushed on activate)

    function _extScan() {
        const nd = window.slopsmith && window.slopsmith.noteDetection;
        if (!nd || nd.version !== 1 || typeof nd.snapshot !== 'function') return null;
        let snap; try { snap = nd.snapshot(); } catch (_) { return null; }
        if (!snap || !Array.isArray(snap.providers) || !Array.isArray(snap.bindings)) return null;
        // Find a non-audio provider that has an open binding. Check bound first
        // so that an earlier unbound provider doesn't shadow a later bound one
        // — if multiple non-audio providers exist, only the bound one matters.
        const boundIds = new Set(snap.bindings.filter(b => b && b.providerId).map(b => b.providerId));
        const ext = snap.providers.find(p => p && p.kind && p.kind !== 'audio' && p.kind !== 'engine' && boundIds.has(p.id));
        return ext || null;
    }

    // Keys/piano (notation) arrangements are scored by an external MIDI provider,
    // never the mic — notedetect's audio detection is fretted-instrument-only.
    function _ndIsExternalScoredArrangement() {
        try {
            const info = (resolveHw() && hw.getSongInfo) ? hw.getSongInfo() : null;
            const name = info && info.arrangement;
            return !!(name && /\b(keys|piano|keyboard|synth)\b/i.test(String(name)));
        } catch (_) { return false; }
    }

    function _extFeed(detail, hit) {
        const p = (detail && detail.payload) || {};
        const midi = Number(p.midi);
        if (!_extActive) {
            // A verdict arriving during the async enter-external window (after we
            // subscribe, before scoring/HUD are armed) would otherwise be lost —
            // these are the first notes. Buffer them; _enableExternal flushes
            // them in once it's armed (post-reset).
            // Guard on detectPreference: if the user has Detect off, stale verdicts
            // must not accumulate in _extPending and then contaminate the next
            // scoring session when Detect is re-enabled.
            if (detectPreference && _extScan() && _extPending.length < 128) _extPending.push({ hit, midi });
            return;
        }
        const t = (resolveHw() && hw.getTime) ? hw.getTime() : 0;
        const key = 'ext:' + (Number.isFinite(midi) ? midi : 'x') + ':' + Number(t).toFixed(3) + ':' + (hit ? 'h' : 'm');
        try {
            // noteTime = the playhead at which this external verdict landed, so
            // the position-aware ledger can roll it back on a seek-before-t.
            recordJudgment(key, { hit: !!hit, detectedMidi: hit && Number.isFinite(midi) ? midi : null, noteTime: t, _external: true },
                { count: true, emit: true });
        } catch (_) {}
    }

    function _extSubscribe() {
        if (_extOnHit) return;
        _extOnHit  = (detail) => _extFeed(detail, true);
        _extOnMiss = (detail) => _extFeed(detail, false);
        try {
            window.slopsmith.on('note-detection:hit', _extOnHit);
            window.slopsmith.on('note-detection:miss', _extOnMiss);
        } catch (_) {}
    }
    function _extUnsubscribe() {
        try {
            if (_extOnHit)  window.slopsmith.off('note-detection:hit', _extOnHit);
            if (_extOnMiss) window.slopsmith.off('note-detection:miss', _extOnMiss);
        } catch (_) {}
        _extOnHit = _extOnMiss = null;
    }

    // enableImpl() has already set enabled=true and run the event bindings.
    function _enableExternal() {
        _extActive = true;
        attachInstanceRoot();
        updateButton();
        startHUD();
        _extSubscribe();
        // Flush verdicts buffered during the arming window (the first notes).
        if (_extPending.length) {
            const pend = _extPending; _extPending = [];
            for (const v of pend) _extFeed({ payload: { midi: v.midi } }, v.hit);
        }
        return true;
    }

    function _extBindWatch() {
        if (_extWatchOpen || !isDefault) return;
        _extWatchOpen = () => {
            if (_extActive || !detectPreference || !_ndIsExternalScoredArrangement() || !_extScan()) return;
            if (enabled) { try { stopAudio(); } catch (_) {} }
            enabled = false;
            enable().catch(() => {});
        };
        _extWatchClose = () => {
            if (!_extActive || _extScan()) return;
            _extActive = false;
            _extPending = [];
            // Do NOT unsubscribe here — the persistent hit/miss subscription must
            // survive provider-disconnect so verdicts arriving during the next async
            // arm window (between binding-opened and _enableExternal completing) are
            // buffered by _extFeed rather than silently dropped.  _extUnsubscribe()
            // is reserved for full watcher teardown (disable / destroy).
            stopHUD();
            enabled = false;
            updateButton();
        };
        try {
            window.slopsmith.on('note-detection:binding-opened', _extWatchOpen);
            window.slopsmith.on('note-detection:provider-registered', _extWatchOpen);
            window.slopsmith.on('note-detection:binding-closed', _extWatchClose);
            window.slopsmith.on('note-detection:provider-unregistered', _extWatchClose);
        } catch (_) {}
        // Subscribe to verdicts now (persistent) so ones arriving during the
        // async enter-external window are buffered, not lost — _extFeed buffers
        // until _extActive, then _enableExternal flushes them.
        _extSubscribe();
    }

    let enableInFlight = null;
    function enable() {
        if (enableInFlight) return enableInFlight;
        if (enabled) return Promise.resolve(true);
        enableInFlight = (async () => {
            try {
                return await enableImpl();
            } finally {
                enableInFlight = null;
            }
        })();
        return enableInFlight;
    }

    async function enableImpl() {
        // Resolve the highway lazily — supports plugin load orders
        // where highway isn't defined at factory construction. If
        // it's still missing, there's nothing to hook into, so bail
        // cleanly rather than throw from `hw.getSongInfo()` below.
        if (!resolveHw()) {
            console.warn('[note_detect] enable() called but `highway` is not available yet — plugin may have loaded before slopsmith core.');
            return false;
        }
        ensureDrawHook();
        // Subscribe to slopsmith loop / song events for drill mode.
        // Idempotent — _drillBindEvents bails when already subscribed,
        // so re-enabling after a disable doesn't double-bind. Listeners
        // survive disable() (so re-enable resumes the same drill state)
        // and only get torn down by destroy().
        _drillBindEvents();
        // Subscribe to song:ended so a finished song with detection on
        // surfaces the end-of-song summary modal. Idempotent and
        // self-gated (handler bails when not enabled / not default).
        _endOfSongBindEvents();
        // Bind the song:loaded re-arm so Detect survives song switches. Like
        // the endOfSong/drill bindings it persists across the per-song silent-
        // disable and is only torn down by destroy(); idempotent + default-only.
        _reArmBindEvents();
        // Bind song:seek so a backward reposition (Restart button / scrub-back)
        // rebuilds the live score to the new playhead instead of keeping the
        // stale total. Same persist-across-silent-disable lifecycle; handler
        // self-gates on `enabled`. NOT default-only — each split panel rebuilds
        // its own HUD.
        _seekResetBindEvents();
        // Sync drill state once at enable so a user enabling detection
        // while a loop is already active starts counting iterations
        // from the very next judgment, not after the first HUD tick.
        _drillSyncFromLoopState();
        enabled = true;
        // Make sure the instanceRoot is in the DOM before HUD/summary
        // rendering kicks in — `createNoteDetector({container}).enable()`
        // without a prior `injectButton()` call would otherwise render
        // to a detached subtree.
        attachInstanceRoot();
        updateButton();

        _syncChartStateFromHw();
        _chartStateBindEvents();

        resetScoring();

        // External detection source (MIDI keys highway): score from the
        // note-detection domain instead of the mic — same graded HUD + summary.
        if (_ndIsExternalScoredArrangement() && _extScan()) return _enableExternal();
        // Keys/piano arrangement with no provider yet: never start the mic —
        // idle until an external provider's binding registers (the bind watcher
        // then promotes us into external mode).
        if (_ndIsExternalScoredArrangement()) {
            enabled = false;
            updateButton();
            return false;
        }

        // Queue the audio acquisition through the shared chain so
        // enable cannot overlap with a concurrent restartAudio
        // (settings slider) or another enable. Without this,
        // startAudio from enable and startAudio from a settings-
        // triggered restart could both race to write `stream` /
        // `audioCtx` / node refs.
        const result = await queueAudioOp(async () => {
            // Early bail before startAudio: disable()/destroy() may
            // have run after enable() queued this op but before it
            // got its turn on the chain. Calling startAudio in that
            // case would prompt for mic permission and create nodes
            // purely to tear them down on the next line.
            if (!enabled) return { ok: false, superseded: true };
            // New session — bump the generation counter and snapshot
            // it so we can detect a disable() that fires while
            // startAudio is still awaited.
            sessionGen++;
            const gen = sessionGen;
            const ok = await startAudio();
            if (gen !== sessionGen || !enabled) {
                // Superseded by disable() during the await. Tear down
                // the audio that just came up.
                if (ok) stopAudio();
                return { ok: false, superseded: true };
            }
            return { ok, superseded: false };
        });

        if (result.superseded) {
            // disable() ran during the await and already set
            // enabled=false / updated the button. Just report the
            // aborted enable back to the caller.
            return false;
        }
        if (!result.ok) {
            enabled = false;
            updateButton();
            return false;
        }

        missCheckInterval = setInterval(checkMisses, 100);
        startHUD();

        // Desktop bridge: push the current song's note chart to the engine
        // so its NoteVerifier thread scores it continuously. No-ops on the
        // browser path and on a downlevel addon (where the legacy matchNotes
        // loop stays in force). startAudio() has already established
        // usingDesktopBridge / bridgeDesktop by this point.
        await _ndPushChartToBridge();

        // Phase 2 warm-up grace: a source on an ADDITIONAL input device starts
        // COLD — its interface only began streaming when the user bound it
        // (seconds ago), so the stream + detection settle over the first couple
        // seconds. The PRIMARY device has been streaming since launch, so it's
        // already warm and accurate from the first note. Without this, the extra
        // device's cold-start would be scored as misses that permanently drag the
        // cumulative accuracy ("missed the start, never catches up"). Wipe that
        // one cold-start window so the displayed score reflects steady state.
        // Guarded by sessionGen so a disable/re-enable cancels a pending reset. Gate
        // on actually OWNING a non-default source — not just the requested deviceKey —
        // so that if the extra-device bind failed and we fell back to source 0 (a
        // primary input that's already warm), we DON'T wipe the first valid seconds of
        // that fallback's hits and make the degraded path look broken.
        if (_ndDeviceKey > 0 && _ndOwnsSource && sourceId != null && sourceId !== 0) {
            const warmGen = sessionGen;
            setTimeout(() => {
                if (enabled && warmGen === sessionGen) resetScoring();
            }, 2500);
        }

        // Per-instance GC of noteResults — previously a module-level
        // setInterval; moving it into the closure lets each instance
        // prune its own Map.
        gcInterval = setInterval(() => {
            if (!enabled || noteResults.size < 500) return;
            const t = hw.getTime();
            for (const [key] of noteResults) {
                const noteTime = parseFloat(key.split('_')[0]);
                if (noteTime < t - 5) { noteResults.delete(key); _susActiveUntil.delete(key); }
            }
        }, 5000);

        if (detectionMethod === 'crepe') _ndLoadCrepe();

        // Auto-record every play (default singleton only; no-op otherwise).
        // Bound only here, on the fully-enabled path after audio is up, and
        // unbound in disable() — so the song listeners never linger or arm
        // a take while Detect is off (a plain disable() doesn't flip
        // detectPreference, so a stale listener could otherwise fire). The
        // vm tests can't enable(), so they never register it, keeping the
        // listener-count contracts intact.
        _bindAutoRecord();
        // A/V auto-calibrate (default singleton only; no-op otherwise) — same
        // enable-time lifecycle as auto-record.
        _calBindEvents();
        return true;
    }

    // `disableOptions.silent: true` suppresses the end-of-song summary
    // modal. The playSong hook uses this when a new song loads so the
    // user doesn't see a summary pop every song switch; the original
    // pre-factory behaviour was to silently reset here. Parameter is
    // named distinctly from the factory's outer `opts` to avoid the
    // lexical shadow.
    function disable(disableOptions) {
        if (!enabled) return;
        enabled = false;
        // A contained-playback chart can't outlive detection. Clear the engine
        // slot ownership and un-suspend host scoring synchronously so the next
        // enable() starts clean — the async host re-push is pointless here
        // (stopAudio() below clears the bridge, so it would no-op anyway).
        if (_ndContainedActive || _ndHostChartSuspended) {
            _ndContainedGen++;   // invalidate any in-flight arm/push so it can't resurrect after disable
            _ndContainedActive = false;
            _ndContainedById = new Map();
            _ndContainedCtx = null;
            _ndContainedVerdictBuf = [];
            _ndContainedLastPlayhead = 0;
            _ndHostChartSuspended = false;
            if (_ndShared.containedSlotOwners.get(sourceId) === api) _ndShared.containedSlotOwners.delete(sourceId);
        }
        // Invalidate any CREPE inference currently awaited in
        // processFrame — it captured the previous sessionGen and will
        // bail on mismatch rather than apply post-disable detections.
        sessionGen++;
        stopAudio();
        // Release our audio-input requester ref (the engine + device stay up for
        // any other consumer; the domain ref-counts). Best-effort, fire-and-forget.
        _ndCloseSelectedInputSource(ND_AUDIO_REQUESTER);
        stopHUD();
        // Always clear external state on disable: _extWatchClose no longer
        // unsubscribes (to avoid dropping first-note verdicts on reconnect),
        // so disable() is responsible for the full subscription teardown.
        // _extSubscribe() re-runs when the next enable() reaches _enableExternal.
        _extActive = false; _extUnsubscribe();
        // Auto-record is the one enable-bound listener we drop on disable()
        // (not only on destroy): its handler arms/saves takes, so it must
        // not stay live while Detect is off. Re-enable rebinds it.
        _unbindAutoRecord();
        // NOTE: deliberately do NOT unbind auto-calibrate here. The host
        // disable()s detection at song-end (sometimes BEFORE the plugin's
        // song:ended handler runs), so unbinding on disable would drop the
        // calibrate trigger. Self-gated + once-per-play; torn down in destroy().
        if (missCheckInterval) { clearInterval(missCheckInterval); missCheckInterval = null; }
        if (gcInterval) { clearInterval(gcInterval); gcInterval = null; }
        for (const tid of flashTimeouts) clearTimeout(tid);
        flashTimeouts = [];

        if (!disableOptions || !disableOptions.silent) showSummary();

        const panel = document.querySelector('.nd-settings-panel');
        if (panel) {
            if (panel._ndHealthTick) {
                clearInterval(panel._ndHealthTick);
                panel._ndHealthTick = null;
            }
            panel.remove();
        }
        _vuSetPanel(null);
        calibrationWizardClose();
        calibrationLabClose();

        updateButton();
    }

    function destroy() {
        // Silent disable on teardown: calling plain disable() would
        // fire showSummary() (publishing `notedetect:session` and
        // building the summary overlay) for any instance with ≥5
        // judgments, but then we immediately remove `instanceRoot`
        // so the overlay flashes and vanishes. Unexpected for
        // callers like splitscreen that unmount a panel without
        // meaning to end-of-song the session.
        disable({ silent: true });
        // Free the engine input source we allocated for this instance (if any).
        // disable()→stopAudio() already cleared bridgeDesktop, so this re-resolves
        // window.slopsmithDesktop. No-op for the default singleton / source 0.
        _ndReleaseOwnedSource();
        calibrationWizardClose();
        calibrationLabClose();
        // Unbind slopsmith drill listeners so multiple createNoteDetector()
        // instances (splitscreen) don't accumulate handlers across mount/
        // unmount cycles. disable() leaves them alone (resumes drill state
        // on re-enable); destroy is the right teardown point.
        _drillUnbindEvents();
        _endOfSongUnbindEvents();
        _reArmUnbindEvents();
        _seekResetUnbindEvents();
        _chartStateUnbindEvents();
        _recUnbindEvents();
        _unbindAutoRecord();
        _calUnbindEvents();
        _liveUnbindEvents();
        // Discard any unsaved recording state — destroying the instance
        // shouldn't write a half-captured WAV (or fire off an upload).
        _recArmed = false;
        _recArmedForTraining = false;
        _recChunks = [];
        _recTotalSamples = 0;
        _recTrainingUploadResult = null;
        _stopParallelTrainingCapture();
        // Remove draw hook (may not exist on older highway versions;
        // swallow the error rather than crash on teardown).
        try { if (hw && hw.removeDrawHook) hw.removeDrawHook(drawHookFn); } catch (e) {}
        // Clear our note-state provider — but only when we can positively
        // verify it's still ours (don't stomp a provider some other plugin
        // registered later, and don't clear blindly if the core lacks the
        // getter to confirm ownership).
        try {
            if (hw && hw.setNoteStateProvider
                && typeof hw.getNoteStateProvider === 'function'
                && hw.getNoteStateProvider() === noteStateFor) {
                hw.setNoteStateProvider(null);
            }
        } catch (e) {}
        if (detectBtn) { detectBtn.remove(); detectBtn = null; }
        if (gearBtn) { gearBtn.remove(); gearBtn = null; }
        if (instanceRoot.parentNode) instanceRoot.remove();
        _ndInstances.delete(api);
    }

    async function toggle() {
        if (enabled) {
            disable();
            detectPreference = false;
            saveSettings();
        } else {
            await enable();
            detectPreference = true;
            saveSettings();
        }
    }

    // Builds a self-contained snapshot of the current session — counters,
    // miss-category breakdown, per-string hit rate, signed error
    // percentiles, the song/arrangement/tuning, the detector settings,
    // and a capped per-judgment event log. Schema is versioned so future
    // tooling can dispatch. `benchmark_hint` carries the song's title/
    // artist/arrangement triple verbatim so reports against the official
    // benchmark sloppak can be filtered without needing a strict match.
    function _buildDiagnosticPayload() {
        const currentHw = resolveHw();
        const info = (currentHw && currentHw.getSongInfo) ? currentHw.getSongInfo() : {};
        const total = hits + misses;
        const sumAcc = total > 0 ? +(hits / total).toFixed(3) : 0;
        const sAcc = (_diagSingles.hits + _diagSingles.misses) > 0
            ? +(_diagSingles.hits / (_diagSingles.hits + _diagSingles.misses)).toFixed(3) : 0;
        const cAcc = (_diagChords.hits + _diagChords.misses) > 0
            ? +(_diagChords.hits / (_diagChords.hits + _diagChords.misses)).toFixed(3) : 0;
        return {
            schema: 'note_detect.diagnostic.v1',
            timestamp: new Date().toISOString(),
            plugin_version: _ND_VERSION,
            // Which detector actually produced this session — captured by the
            // detection tick itself (see _diagDetector), so it stays correct
            // even when the diagnostic is exported after Detect is toggled
            // off. null only if detection never ran this session.
            detector: _diagDetector || {
                desktop_bridge: false, ml: false, path: 'none',
            },
            benchmark_hint: {
                title: info.title || null,
                artist: info.artist || null,
                arrangement: info.arrangement || null,
                arrangement_index: (info.arrangement_index != null) ? info.arrangement_index : null,
            },
            song: {
                tuning: info.tuning || null,
                capo: (info.capo != null) ? info.capo : 0,
                duration: (info.duration != null) ? info.duration : null,
                format: info.format || null,
            },
            settings: {
                method: detectionMethod,
                timing_tolerance_s: timingTolerance,
                timing_hit_threshold_s: timingHitThreshold,
                chord_timing_hit_threshold_s: chordTimingHitThreshold,
                pitch_tolerance_cents: pitchTolerance,
                pitch_hit_threshold_cents: pitchHitThreshold,
                chord_hit_ratio: chordHitRatio,
                detection_confidence_min: detectionConfidenceMin,
                latency_offset_s: latencyOffset,
                input_gain: inputGain,
                channel: selectedChannel,
            },
            summary: {
                hits, misses, total,
                accuracy: sumAcc,
                best_streak: bestStreak,
                singles: { hits: _diagSingles.hits, misses: _diagSingles.misses, accuracy: sAcc },
                chords:  { hits: _diagChords.hits,  misses: _diagChords.misses,  accuracy: cAcc },
            },
            miss_breakdown: { ..._diagBreakdown },
            per_string: _diagPerString.map((slot, s) => ({
                s,
                hits: slot.hits,
                misses: slot.misses,
                total: slot.hits + slot.misses,
                accuracy: (slot.hits + slot.misses) > 0
                    ? +(slot.hits / (slot.hits + slot.misses)).toFixed(3) : null,
            })),
            timing_error_ms: _diagDistribution(_diagTimingErrors),
            // Hit-only timing distribution — the responsive signal for
            // A/V auto-calibration. See _diagTimingErrorsHits comment.
            timing_error_ms_hits: _diagDistribution(_diagTimingErrorsHits),
            pitch_error_cents:    _diagDistribution(_diagPitchErrors),
            sections: sectionStats.map(s => ({
                name: s.name,
                hits: s.hits,
                misses: s.misses,
                accuracy: (s.hits + s.misses) > 0
                    ? +(s.hits / (s.hits + s.misses)).toFixed(3) : 0,
            })),
            events: _diagEvents,
        };
    }

    function _downloadDiagnostic() {
        try {
            const payload = _buildDiagnosticPayload();
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const slug = (payload.benchmark_hint.title || 'song')
                .replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
            const ts = payload.timestamp.replace(/[:.]/g, '-').slice(0, 19);
            const a = document.createElement('a');
            a.href = url;
            a.download = `note_detect_diag_${slug}_${ts}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 500);
            return true;
        } catch (e) {
            console.warn('[note_detect] diagnostic download failed:', e);
            return false;
        }
    }

    // ── Reference-recording capture ───────────────────────────────────
    // Arms the next song-play to record the detector's input audio. On
    // song:ended, auto-saves a WAV to `static/note_detect_recordings/`
    // via the plugin's POST endpoint — that dir is bind-mounted in the
    // dev container, so the headless harness on the host can read the
    // same file back without a copy step. Detect must be enabled for
    // audio to actually flow; armed-without-Detect is a no-op.
    function armRecording() {
        _recArmed = true;
        _recArmedForTraining = false;
        _recChunks = [];
        _recTotalSamples = 0;
        _recLastSaveError = null;
        _recCappedAt = null;
        _recTrainingUploadResult = null;
        // Bind song-event listeners lazily so an idle plugin instance
        // doesn't sit on the slopsmith bus. Unbind in disarm / save /
        // destroy. Idempotent.
        _recBindEvents();
    }
    async function _startParallelTrainingCapture() {
        if (_trainingCapture) return;
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
            throw new Error('getUserMedia is not available in this context');
        }
        const constraints = { audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            // Request stereo so the channel-select below can pick the
            // user's instrument channel — same as the main capture path.
            channelCount: 2,
        }};
        if (selectedDeviceId) {
            constraints.audio.deviceId = { exact: selectedDeviceId };
        }
        let stream;
        try {
            // Share the main capture path's over-constrained fallback so a
            // mono-only interface (Real Tone Cable) or stale saved device
            // can still arm a parallel training take.
            stream = await openInstrumentStream(constraints);
        } catch (e) {
            throw new Error('mic permission denied or device unavailable: ' + (e && e.message || e));
        }
        // The getUserMedia await above can take seconds (permission
        // prompt, device open). If the take was disarmed or the song
        // ended meanwhile, bail and release the mic now — otherwise we'd
        // attach a live capture graph to a cancelled take and leave the
        // device open until some later teardown.
        if (!_recArmed || !_recArmedForTraining) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
            return;
        }
        // Build the context + graph inside a try: getUserMedia already
        // handed us a live stream, so if any node creation throws we
        // must stop that stream (and close a half-built context) here —
        // _trainingCapture isn't assigned yet, so _stopParallelTraining-
        // Capture() couldn't otherwise reach the open mic.
        let ctx = null;
        try {
            ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
            const source = ctx.createMediaStreamSource(stream);
            // ScriptProcessor is deprecated but matches the rest of the
            // plugin's audio paths (AudioWorklet would need a separate
            // worklet file shipped with the plugin). Power-of-two buffer
            // size in {256, 512, 1024, 2048, 4096, 8192, 16384}; 4096 is a
            // ~93ms cadence at 44.1kHz, plenty for capture (we're not doing
            // any latency-sensitive analysis in this path — that's the
            // engine's job).
            const processor = ctx.createScriptProcessor(4096, 1, 1);
            // Push to the same _recChunks as the legacy processFrame path
            // so saveRecordingNow() doesn't need to know which capture path
            // produced the buffer. Gating mirrors the legacy push at
            // line 2316: only push while armed AND the song is playing,
            // so we don't fill the buffer with silence pre-Play.
            processor.onaudioprocess = (e) => {
                if (!_recArmed || !_recSongPlaying) return;
                const input = e.inputBuffer.getChannelData(0);
                const maxSamples = Math.floor((32 * 1024 * 1024) / 4);
                if (_recTotalSamples >= maxSamples) {
                    if (!_recCappedAt) _recCappedAt = _recTotalSamples / (ctx.sampleRate || 44100);
                    return;
                }
                _recSampleRate = ctx.sampleRate || _recSampleRate;
                // slice() — the underlying buffer is reused next callback.
                const copy = input.slice();
                _recChunks.push(copy);
                _recTotalSamples += copy.length;
            };
            // Mirror the main capture graph (see ~line 1942): channel-select
            // + input gain ahead of the processor, so the training WAV is
            // the SAME signal the detector judged and matches the `channel`
            // / `input_gain` recorded in the manifest. Reading channel 0 of
            // the raw source instead would upload the wrong channel for a
            // right-channel-DI user and skip the user's input gain.
            const gain = ctx.createGain();
            gain.gain.value = inputGain;
            let splitter = null, merger = null;
            if (source.channelCount >= 2 && selectedChannel !== 'mono') {
                splitter = ctx.createChannelSplitter(2);
                merger = ctx.createChannelMerger(1);
                const chIdx = selectedChannel === 'left' ? 0 : 1;
                source.connect(splitter);
                splitter.connect(merger, chIdx, 0);
                merger.connect(gain);
            } else {
                source.connect(gain);
            }
            gain.connect(processor);
            // A ScriptProcessor only fires its onaudioprocess callback if
            // it's connected to the destination graph. Route through a
            // muted GainNode so the captured audio doesn't loop back to
            // speakers (would be a feedback hazard with the JUCE engine
            // also driving output).
            const mute = ctx.createGain();
            mute.gain.value = 0;
            processor.connect(mute);
            mute.connect(ctx.destination);
            _trainingCapture = { stream, ctx, source, splitter, merger, gain, processor, mute };
        } catch (e) {
            try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
            try { if (ctx) ctx.close(); } catch (_) {}
            throw new Error('training capture graph setup failed: ' + (e && e.message || e));
        }
    }
    function _stopParallelTrainingCapture() {
        if (!_trainingCapture) return;
        const cap = _trainingCapture;
        _trainingCapture = null;
        try { cap.source.disconnect(); } catch (_) {}
        try { if (cap.splitter) cap.splitter.disconnect(); } catch (_) {}
        try { if (cap.merger) cap.merger.disconnect(); } catch (_) {}
        try { if (cap.gain) cap.gain.disconnect(); } catch (_) {}
        try { cap.processor.disconnect(); } catch (_) {}
        try { cap.mute.disconnect(); } catch (_) {}
        try { cap.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        try { cap.ctx.close(); } catch (_) {}
    }
    async function armRecordingForTraining() {
        // Same capture-buffer state reset as armRecording, plus a flag
        // that triggers the bundle-and-upload step on song:ended. Also
        // force-binds the live-judgment stream regardless of tuningMode
        // (the training bundle needs both the WAV and the JSONL).
        _recArmed = true;
        _recArmedForTraining = true;
        _recChunks = [];
        _recTotalSamples = 0;
        _recLastSaveError = null;
        _recCappedAt = null;
        _recTrainingUploadResult = null;
        // Clear the carried-over session id so _recOnEnded's
        // `_liveSessionId || _liveLastSessionId` fallback can only ever
        // resolve to a session minted DURING this take — never a stale
        // one from a previous take. If this take mints no session at
        // all, the bundle simply ships without a JSONL (soft-skip).
        _liveLastSessionId = null;
        _recBindEvents();
        _liveBindEvents();
        // If the user armed AFTER pressing Play, song:play has already
        // fired and won't fire again: _recSongPlaying never flipped true
        // (so the capture gate at processFrame / _startParallelTraining-
        // Capture would stay idle) and _liveOnPlay never minted a live
        // session (so the JSONL take would carry no session_start
        // header). Detect *active playback* here and replay both effects.
        // A nonzero playhead alone is not enough — a paused or seeked
        // song also has one — so sample the renderer clock twice: only
        // real playback advances it. A genuinely paused song is left
        // alone; its song:play will drive both effects when it resumes.
        const _t1 = (hw && hw.getTime) ? hw.getTime() : 0;
        await new Promise((r) => setTimeout(r, 150));
        // The await above is a yield point — if the user disarmed during
        // it, bail rather than minting a session / flipping capture
        // state for a take that no longer exists.
        if (!_recArmed || !_recArmedForTraining) return;
        const _t2 = (hw && hw.getTime) ? hw.getTime() : 0;
        if (_t2 > _t1 + 0.02) {
            _recSongPlaying = true;
            // Mint a FRESH session unconditionally — even if tuning mode
            // already had one running. That older session started at
            // song:play and holds pre-arm judgments; reusing it would
            // misalign the detect-stream with a WAV that starts at arm
            // time. A fresh session begins here, aligned with the take.
            _startLiveSession();
        }
        // When the desktop bridge is active, the JS-side processFrame()
        // never runs (native engine owns the device), so its
        // _recChunks.push() at line ~2316 never fires and the WAV
        // would always be empty. Open a parallel getUserMedia chain
        // dedicated to capture — orthogonal to whatever the bridge is
        // doing for detection. In non-bridge mode the legacy
        // processFrame path is already pushing, so a parallel capture
        // would double-push; skip it.
        if (usingDesktopBridge) {
            try {
                await _startParallelTrainingCapture();
            } catch (e) {
                // Roll back the arm so the user isn't left thinking a
                // take is being recorded when it isn't.
                _recArmed = false;
                _recArmedForTraining = false;
                _recLastSaveError = String(e && e.message || e);
                _recUnbindEvents();
                if (!tuningMode) _liveUnbindEvents();
                console.warn('[note_detect] arm-for-training getUserMedia failed:', e);
                throw e;
            }
        }
    }
    function disarmRecording() {
        // Soft stop: turn capture off but keep the buffer so the user
        // can still Save (or Discard) what they captured. Clearing the
        // buffer here would silently throw away the user's take, which
        // is what they were complaining about. Use discardRecording()
        // when you actually want to wipe.
        _recArmed = false;
        _recArmedForTraining = false;
        _recUnbindEvents();
        // Drop the live stream subscription too, unless tuningMode is
        // independently keeping it on. Mirrors the gate in setTuningMode.
        if (!tuningMode) _liveUnbindEvents();
        // Release the mic. If the user disarmed mid-take the captured
        // buffer is retained for a manual Save.
        _stopParallelTrainingCapture();
    }
    function discardRecording() {
        _recArmed = false;
        _recArmedForTraining = false;
        _recChunks = [];
        _recTotalSamples = 0;
        _recLastSaveError = null;
        _recCappedAt = null;
        _recTrainingUploadResult = null;
        _recUnbindEvents();
        if (!tuningMode) _liveUnbindEvents();
        _stopParallelTrainingCapture();
    }
    async function saveRecordingNow() {
        if (_recSaveInFlight) return null;
        if (_recChunks.length === 0) {
            _recLastSaveError = 'no audio captured (Detect off, or song never played)';
            return null;
        }
        // Snapshot the buffer (alias, not copy) and disarm so any
        // song:ended fired mid-upload doesn't re-enter this path. We
        // intentionally DO NOT clear _recChunks here — if the POST
        // fails the user keeps their take and can retry via the Save
        // button. Earlier behaviour cleared synchronously, which meant
        // a network error or 413 from the server-side cap silently
        // destroyed a recorded session with no way to recover.
        const chunks = _recChunks;
        const sr = _recSampleRate;
        _recArmed = false;
        _recSaveInFlight = true;
        try {
            const wav = _ndEncodeWavPcm16(chunks, sr);
            const info = (hw && hw.getSongInfo) ? hw.getSongInfo() : {};
            const slug = ((info.title || 'recording') + '')
                .replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) || 'recording';
            const resp = await fetch(
                '/api/plugins/note_detect/recording?slug=' + encodeURIComponent(slug),
                { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav }
            );
            if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
            const data = await resp.json();
            _recLastSavePath = data && data.relative_path || null;
            _recLastSaveError = null;
            // SUCCESS — only NOW clear the buffer, so a failed upload
            // doesn't lose the user's audio. _recCappedAt also resets
            // since the take that was capped has shipped.
            _recChunks = [];
            _recTotalSamples = 0;
            _recCappedAt = null;
            return data;
        } catch (e) {
            _recLastSaveError = String(e && e.message || e);
            console.warn('[note_detect] saveRecording failed:', e);
            // Buffer intentionally left in _recChunks so the user can
            // retry via the Save button after fixing the underlying
            // issue (server restart, larger cap, etc.).
            return null;
        } finally {
            _recSaveInFlight = false;
            // Done with this take — release the song-event listeners.
            _recUnbindEvents();
        }
    }
    function getRecordingState() {
        // Use the cached running total instead of reducing the array —
        // the UI's auto-refresh poll calls this every 1500 ms, and on a
        // long take the reduce was O(n) per call. The cache is
        // maintained in lockstep with `_recChunks` (incremented on
        // push, zeroed on arm/discard/successful-save/destroy).
        const samples = _recTotalSamples;
        return {
            armed:        _recArmed,
            armedForTraining: _recArmedForTraining,
            songPlaying:  _recSongPlaying,
            chunks:       _recChunks.length,
            samples,
            sampleRate:   _recSampleRate,
            durationS:    samples / Math.max(1, _recSampleRate),
            saveInFlight: _recSaveInFlight,
            lastSavePath: _recLastSavePath,
            lastError:    _recLastSaveError,
            // null = no cap hit; otherwise the second-mark where the client-
            // side 32 MB cap kicked in. UI can surface "your take was
            // truncated at X s".
            cappedAtS:    _recCappedAt,
            // Recording requires the audio pipeline to be live — surface
            // it here so the UI can prompt the user to enable Detect.
            detectEnabled: enabled,
            // Training-bundle upload status. inFlight while the bundle
            // POST is round-tripping; result is the last server response
            // ({ok:true, bundle_filename, pcloud_result, ...} or
            // {ok:false, error, local_bundle, ...}). Null between
            // takes — the UI shows nothing in that state.
            trainingUploadInFlight: _recTrainingUploadInFlight,
            trainingUploadResult:   _recTrainingUploadResult,
        };
    }
    // Contributor + per-instrument prefs persisted in localStorage so
    // the upload dialog auto-fills on subsequent takes. Song-specific
    // fields (title, custom song filename, tuning) always come from songInfo,
    // so they're NOT persisted — last song's title would be wrong for
    // the next.
    const _TRAINING_PREFS_KEY = 'nd_training_prefs_v1';
    function _loadTrainingPrefs() {
        try {
            const raw = localStorage.getItem(_TRAINING_PREFS_KEY);
            if (!raw) return { name: '', discord: '', instrument: '', notes: '' };
            const p = JSON.parse(raw) || {};
            return {
                name:       typeof p.name       === 'string' ? p.name       : '',
                discord:    typeof p.discord    === 'string' ? p.discord    : '',
                instrument: typeof p.instrument === 'string' ? p.instrument : '',
                notes:      typeof p.notes      === 'string' ? p.notes      : '',
            };
        } catch (_) {
            return { name: '', discord: '', instrument: '', notes: '' };
        }
    }
    function _saveTrainingPrefs(prefs) {
        try {
            localStorage.setItem(_TRAINING_PREFS_KEY, JSON.stringify({
                name:       prefs.name       || '',
                discord:    prefs.discord    || '',
                instrument: prefs.instrument || '',
                notes:      prefs.notes      || '',
            }));
        } catch (_) { /* ignore quota / privacy mode */ }
    }
    // Modal that gates the upload — surfaces auto-detected song fields
    // for review/edit, captures contributor metadata, and requires an
    // explicit consent checkbox before enabling Upload. Stays open
    // during the upload itself so the user sees an inline progress +
    // success / failure status instead of guessing whether the bundle
    // made it. The `doUpload(formData) → Promise<result>` callback is
    // invoked on submit; the modal flips into "uploading" mode while
    // the promise is pending and then shows a result panel with a
    // Close button. Resolves with the final result (or null on cancel)
    // once the user dismisses the modal. Single-shot: no second
    // instance can mount concurrently.
    let _trainingModalActive = false;
    // doUpload(formData) bundles + uploads a fresh take; doRetry(localBundle)
    // re-uploads an already-bundled zip (shown as a Retry button when the
    // first upload fails). doRetry is optional — omit it to disable retry.
    function _showTrainingConsentModal(prefill, doUpload, doRetry) {
        if (_trainingModalActive) return Promise.resolve(null);
        _trainingModalActive = true;
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'nd-train-modal fixed inset-0 z-[99999] flex items-center justify-center bg-black/70 p-4 overflow-y-auto';
            // Dialog semantics so screen readers announce the modal and
            // treat background content as inert. aria-labelledby points
            // at the <h3> title id set below.
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-labelledby', 'nd-tr-title');
            // Restore focus to whatever was focused before the modal
            // opened, once it closes.
            const _prevFocus = document.activeElement;
            // Plain-text inputs only — no HTML interpolation of user-
            // controllable strings to avoid an XSS surface from
            // chart-provided song info or localStorage tampering.
            modal.innerHTML = `
                <div class="bg-dark-700 border border-gray-600 rounded-lg max-w-md w-full p-5 shadow-2xl my-4">
                    <h3 id="nd-tr-title" class="nd-tr-title text-base font-semibold text-gray-100 mb-1">Submit Training Take</h3>
                    <p class="nd-tr-intro text-[11px] text-gray-400 mb-4 leading-snug">
                        Review the details below, then check the consent box to upload your take
                        (audio + detection events + this form) to the training dataset. All fields
                        marked optional can be left blank.
                    </p>

                    <div class="nd-tr-form">
                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Song Name</label>
                        <input class="nd-tr-song w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">custom song File Name</label>
                        <input class="nd-tr-custom-song w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Instrument</label>
                        <select class="nd-tr-instr w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">
                            <option value="guitar">Guitar</option>
                            <option value="bass">Bass</option>
                        </select>

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Tuning</label>
                        <input class="nd-tr-tuning w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Your Name <span class="text-gray-500 normal-case">(optional)</span></label>
                        <input class="nd-tr-name w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Discord Handle <span class="text-gray-500 normal-case">(optional)</span></label>
                        <input class="nd-tr-discord w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3">

                        <label class="block text-[10px] text-gray-400 uppercase tracking-wider mb-1">Extra Notes <span class="text-gray-500 normal-case">(optional)</span></label>
                        <textarea class="nd-tr-notes w-full bg-dark-600 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-3" rows="3"></textarea>

                        <label class="flex items-start gap-2 mb-4 cursor-pointer">
                            <input type="checkbox" class="nd-tr-consent mt-0.5">
                            <span class="text-xs text-gray-300 leading-snug">
                                I give permission for this recording to be used for training purposes
                                of the note detection system.
                            </span>
                        </label>
                    </div>

                    <!-- Status line: hidden until the user clicks Upload.
                         Tailwind classes get swapped between info/ok/err
                         palettes by the submit handler below. -->
                    <div class="nd-tr-status hidden text-xs leading-snug mb-4 px-3 py-2 rounded border"></div>

                    <div class="flex gap-2">
                        <button class="nd-tr-cancel flex-1 px-3 py-2 bg-dark-500 hover:bg-dark-400 rounded text-xs text-gray-300">Cancel</button>
                        <button class="nd-tr-retry flex-1 px-3 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:text-gray-600 disabled:cursor-not-allowed rounded text-xs font-semibold text-white" style="display:none">Retry upload</button>
                        <button class="nd-tr-submit flex-1 px-3 py-2 bg-purple-600 hover:bg-purple-500 disabled:bg-dark-600 disabled:text-gray-600 disabled:cursor-not-allowed rounded text-xs font-semibold text-white" disabled>Upload</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            const $ = (sel) => modal.querySelector(sel);
            // Set values via .value rather than innerHTML so user-
            // controllable strings can't break out into HTML.
            $('.nd-tr-song').value    = prefill.songName || '';
            $('.nd-tr-custom-song').value    = prefill.cdlcFilename || '';
            $('.nd-tr-instr').value   = (prefill.instrument === 'bass') ? 'bass' : 'guitar';
            $('.nd-tr-tuning').value  = prefill.tuning || '';
            $('.nd-tr-name').value    = prefill.name || '';
            $('.nd-tr-discord').value = prefill.discord || '';
            $('.nd-tr-notes').value   = prefill.notes || '';
            // Move focus into the dialog so keyboard / screen-reader
            // users land inside it rather than on background content.
            try { $('.nd-tr-song').focus(); } catch (_) {}

            const submitBtn  = $('.nd-tr-submit');
            const retryBtn   = $('.nd-tr-retry');
            const cancelBtn  = $('.nd-tr-cancel');
            const consentCb  = $('.nd-tr-consent');
            const statusEl   = $('.nd-tr-status');
            const formEl     = $('.nd-tr-form');
            consentCb.addEventListener('change', () => { submitBtn.disabled = !consentCb.checked; });

            let finalResult = null;
            // Promise of the upload currently in flight (doUpload or
            // doRetry), or null. Closing the modal removes it from view
            // immediately, but the modal Promise MUST NOT resolve until
            // this settles — _uploadTrainingBundle's finally (disarm +
            // live-stream unbind) runs on that resolution, and running
            // it mid-upload stops judgment streaming and lets the take
            // be re-armed while its request is still going.
            let _activeUpload = null;
            const cleanup = () => {
                modal.remove();
                _trainingModalActive = false;
                // Return focus to wherever it was before the modal opened.
                try { if (_prevFocus && _prevFocus.focus) _prevFocus.focus(); } catch (_) {}
                if (_activeUpload) {
                    _activeUpload.finally(() => resolve(finalResult));
                } else {
                    resolve(finalResult);
                }
            };
            const setStatus = (kind, text) => {
                statusEl.classList.remove('hidden');
                statusEl.className = 'nd-tr-status text-xs leading-snug mb-4 px-3 py-2 rounded border ' + ({
                    info: 'bg-blue-900/30 border-blue-700/50 text-blue-200',
                    ok:   'bg-green-900/30 border-green-700/50 text-green-200',
                    err:  'bg-red-900/30 border-red-700/50 text-red-200',
                }[kind] || '');
                statusEl.textContent = text;
            };

            // Render an upload outcome (from the initial Upload or a
            // Retry) into the modal. Success collapses the actions
            // behind a green Close; failure shows a red Close and — when
            // the server retained a local bundle and a retry path was
            // supplied — a Retry button so the user can re-ship without
            // recording the song again.
            const applyResult = (result) => {
                finalResult = result;
                _recTrainingUploadResult = result;
                if (result && result.ok) {
                    setStatus('ok', '✓ Uploaded to the training dataset: ' + (result.bundle_filename || '(file)') + '. Thanks for contributing!');
                    submitBtn.style.display = 'none';
                    retryBtn.style.display = 'none';
                    cancelBtn.textContent = 'Close';
                    cancelBtn.className = 'flex-1 px-3 py-2 bg-green-700 hover:bg-green-600 rounded text-xs font-semibold text-white';
                } else {
                    const errMsg = (result && result.error) ? result.error : 'unknown error';
                    const canRetry = !!(doRetry && result && result.local_bundle);
                    const retained = (result && result.local_bundle)
                        ? ('\nThe local bundle was retained at ' + result.local_bundle
                           + (canRetry ? ' — use Retry below.' : ' — you can retry from there.'))
                        : '';
                    setStatus('err', '✗ Upload failed: ' + errMsg + retained);
                    submitBtn.style.display = 'none';
                    cancelBtn.textContent = 'Close';
                    cancelBtn.className = 'flex-1 px-3 py-2 bg-red-700 hover:bg-red-600 rounded text-xs font-semibold text-white';
                    if (canRetry) {
                        retryBtn.style.display = '';
                        retryBtn.disabled = false;
                        retryBtn._localBundle = result.local_bundle;
                    }
                }
            };

            // Close resolves with whatever the last attempt produced —
            // null before any upload (a genuine cancel), or the success/
            // failure result afterwards so the caller records it.
            cancelBtn.onclick = () => { cleanup(); };
            retryBtn.onclick = async () => {
                const localBundle = retryBtn._localBundle;
                if (!localBundle || !doRetry) return;
                retryBtn.disabled = true;
                retryBtn.textContent = 'Retrying…';
                setStatus('info', 'Re-uploading the saved bundle to pCloud — no re-recording needed. Don’t close Slopsmith yet.');
                let result = null;
                const p = doRetry(localBundle);
                _activeUpload = p;
                try {
                    result = await p;
                } catch (e) {
                    result = { ok: false, error: String(e && e.message || e), local_bundle: localBundle };
                } finally {
                    if (_activeUpload === p) _activeUpload = null;
                }
                retryBtn.textContent = 'Retry upload';
                applyResult(result);
            };
            submitBtn.onclick = async () => {
                if (!consentCb.checked) return; // belt-and-braces
                const formData = {
                    songName:     $('.nd-tr-song').value.trim(),
                    cdlcFilename: $('.nd-tr-custom-song').value.trim(),
                    instrument:   $('.nd-tr-instr').value,
                    tuning:       $('.nd-tr-tuning').value.trim(),
                    name:         $('.nd-tr-name').value.trim(),
                    discord:      $('.nd-tr-discord').value.trim(),
                    notes:        $('.nd-tr-notes').value.trim(),
                    consent:      true,
                };
                // Lock the form, swap into uploading mode. The form stays
                // visually present (faded) so the user can still see
                // their entries while the network round-trip is in
                // flight; cancelling at this point doesn't abort the
                // upload but does dismiss the modal.
                formEl.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = true; });
                formEl.classList.add('opacity-50', 'pointer-events-none');
                submitBtn.disabled = true;
                submitBtn.textContent = 'Uploading…';
                cancelBtn.textContent = 'Hide';
                setStatus('info', 'Bundling the WAV, detect-stream, and manifest, then shipping to pCloud. Don’t close Slopsmith yet — this can take a few seconds on a slow uplink.');

                let result = null;
                const p = doUpload(formData);
                _activeUpload = p;
                try {
                    result = await p;
                } catch (e) {
                    result = { ok: false, error: String(e && e.message || e) };
                } finally {
                    if (_activeUpload === p) _activeUpload = null;
                }
                applyResult(result);
            };
            // Esc closes the modal. While uploading, Esc still works (the
            // upload promise resolves into _recTrainingUploadResult, so
            // the result is preserved even if the user dismisses).
            modal.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') { e.stopPropagation(); cleanup(); }
            });
        });
    }
    async function _uploadTrainingBundle(savedData, sessionId, songInfoSnapshot, chartSnapshot, audioStats, cdlcFilenameSnapshot) {
        // audioStats pins sample-rate / sample-count / cap at song:ended
        // because saveRecordingNow() zeroes the live counters before this
        // runs. Fall back to the (now-reset) live values defensively.
        audioStats = audioStats || {
            sampleRate: _recSampleRate, totalSamples: _recTotalSamples, cappedAtS: _recCappedAt,
        };
        if (_recTrainingUploadInFlight) return null;
        // Owned by this function: set once here, cleared in the finally
        // on every exit path. _showTrainingConsentModal won't resolve
        // until any in-flight upload settles, so the finally is reached
        // only after the real upload work is done.
        _recTrainingUploadInFlight = true;
        try {
            // Recover the slug from the server-returned filename. The
            // /recording endpoint stamps `note_detect_<slug>_<ts>_<ms>_<suf>.wav`,
            // so parsing once here is cheaper and more robust than
            // mirroring saveRecordingNow's slug derivation (which depends
            // on hw.getSongInfo() being identical at this later moment).
            const filename = (savedData && savedData.filename) || '';
            const m = /^note_detect_(.+?)_\d{8}_\d{6}_\d{3}_[0-9a-f]+\.wav$/.exec(filename);
            if (!m) {
                _recTrainingUploadResult = {
                    ok: false,
                    error: 'could not parse slug from saved filename: ' + filename,
                };
                return null;
            }
            const slug = m[1];

            // Prefer the snapshot pinned at song:ended (the caller in
            // _recOnEnded captures it synchronously). Fall back to a
            // fresh read for any other caller / a direct API invocation
            // where no snapshot was provided.
            const info = songInfoSnapshot
                || ((hw && hw.getSongInfo) ? hw.getSongInfo() : {});
            // custom song filename: prefer the value pinned at song:ended by
            // the caller (cdlcFilenameSnapshot) — _ndShared.currentFilename
            // is a process-global another splitscreen panel can overwrite
            // before this async upload runs. The direct reads are only a
            // fallback for callers that pinned nothing.
            const cdlcFilename = cdlcFilenameSnapshot
                || info.filename || _ndShared.currentFilename || '';
            const tuningArr = Array.isArray(info.tuning) ? info.tuning.slice() : null;
            // Guess instrument from the arrangement label — covers
            // "Bass", "Lead", "Rhythm", "Combo", etc. The user can
            // override in the modal if the guess is wrong.
            const arrLower = String(info.arrangement || '').toLowerCase();
            const guessedInstrument = arrLower.includes('bass') ? 'bass' : 'guitar';
            const persisted = _loadTrainingPrefs();

            // The modal stays open during the network round-trip so the
            // user sees an inline progress + result panel. doUpload is
            // invoked once the consent box is checked and Upload is
            // clicked; it returns the parsed server response (or an
            // {ok:false, error, local_bundle} object on failure) which
            // the modal renders into its status line.
            const result = await _showTrainingConsentModal({
                songName:     info.title || '',
                cdlcFilename: cdlcFilename,
                tuning:       tuningArr ? tuningArr.join(', ') : '',
                // Persisted instrument wins over the arrangement guess
                // only if the user has actually set one before — that
                // way a fresh user gets the helpful guess, but a known
                // bassist isn't re-confronted with "Guitar" every time.
                instrument:   persisted.instrument || guessedInstrument,
                name:         persisted.name,
                discord:      persisted.discord,
                notes:        persisted.notes,
            }, async (formData) => {
                // Persist the contributor-level fields for next time.
                // Song fields are intentionally excluded — next song
                // will repopulate them from songInfo.
                _saveTrainingPrefs({
                    name:       formData.name,
                    discord:    formData.discord,
                    instrument: formData.instrument,
                    notes:      formData.notes,
                });

                _recTrainingUploadResult = null;

                const manifest = {
                    // schema, created_at, and resolved audio/detect_stream
                    // refs are filled server-side. Everything below is
                    // the client's contribution.
                    plugin: { id: 'note_detect' },
                    song: {
                        filename:    formData.cdlcFilename || cdlcFilename || null,
                        title:       formData.songName || info.title || null,
                        artist:      info.artist || null,
                        arrangement: info.arrangement || null,
                        arrangement_index: (info.arrangement_index != null) ? info.arrangement_index : null,
                        tuning:       tuningArr,                                // original machine-readable
                        tuning_label: formData.tuning || null,                  // user-editable string
                        instrument:   formData.instrument || guessedInstrument, // 'guitar' | 'bass'
                        capo:         (info.capo != null) ? info.capo : null,
                        format:       info.format || null,
                        duration_s:   (info.duration != null) ? info.duration : null,
                    },
                    settings: {
                        detection_method:        detectionMethod,
                        av_offset_ms:            Math.round(latencyOffset * 1000),
                        timing_tolerance_ms:     Math.round(timingTolerance * 1000),
                        timing_hit_threshold_ms: Math.round(timingHitThreshold * 1000),
                        pitch_tolerance_cents:   pitchTolerance,
                    },
                    audio: {
                        // Pinned at song:ended — saveRecordingNow() has
                        // since reset the live _rec* counters to 0.
                        sample_rate: audioStats.sampleRate,
                        channels:    1,
                        bit_depth:   16,
                        duration_s:  audioStats.totalSamples / Math.max(1, audioStats.sampleRate),
                        capped_at_s: audioStats.cappedAtS,
                    },
                    client: {
                        user_agent: navigator.userAgent,
                        platform:   navigator.platform || null,
                        timestamp_local: new Date().toISOString(),
                    },
                    contributor: {
                        name:    formData.name    || null,
                        discord: formData.discord || null,
                        consent: true,
                        consent_text: 'I give permission for this recording to be used for training purposes of the note detection system.',
                        consent_at:   new Date().toISOString(),
                    },
                    notes: formData.notes || null,
                };

                // Read the user-configurable upload URL from the
                // settings.html field's localStorage key. Empty / missing
                // leaves it null so the server falls back to its own
                // hardcoded default. Mirrors the storage key + semantics
                // in settings.html.
                let uploadUrl = null;
                try { uploadUrl = localStorage.getItem('nd_training_upload_url') || null; } catch (_) {}

                // Drain any in-flight /live-judgment POSTs first — the
                // server zips whatever live_<id>.jsonl is on disk when
                // /training-bundle runs, so unflushed judgments (or the
                // session header) would be missing from the bundle.
                await _flushLiveJudgments();

                try {
                    const resp = await fetch('/api/plugins/note_detect/training-bundle', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({
                            slug,
                            // Exact WAV filename from the /recording save —
                            // lets the server bundle THIS take's WAV rather
                            // than glob the newest for the slug (wrong WAV
                            // under concurrent same-slug takes).
                            wav_filename: filename || null,
                            // Null (not 'default') when this take minted no
                            // live session — the server soft-skips the JSONL
                            // instead of attaching a stale live_default.jsonl.
                            session: sessionId || null,
                            manifest,
                            // Ground-truth note chart (hw.getNotes/getChords
                            // pinned at song:ended) — the server writes it
                            // into the bundle as arrangement.json. null when
                            // the host exposed no chart.
                            arrangement: chartSnapshot || null,
                            upload_url: uploadUrl,
                        }),
                    });
                    let data = null;
                    try { data = await resp.json(); } catch (_) { /* leave null; surfaced below */ }
                    if (!resp.ok) {
                        const errStr = (data && (data.detail || data.error)) || resp.statusText;
                        const out = { ok: false, error: `HTTP ${resp.status}: ${errStr}`, local_bundle: data && data.local_bundle || null };
                        _recTrainingUploadResult = out;
                        return out;
                    }
                    _recTrainingUploadResult = data;
                    return data;
                } catch (e) {
                    const out = { ok: false, error: String(e && e.message || e) };
                    _recTrainingUploadResult = out;
                    console.warn('[note_detect] training-bundle upload failed:', e);
                    return out;
                }
            }, async (localBundle) => {
                // Retry path: re-upload the zip already on disk (no
                // re-bundling). The server confines `local_bundle` to
                // the recordings directory, so passing the path back is
                // safe. Honours the same per-user upload-URL override.
                let uploadUrl = null;
                try { uploadUrl = localStorage.getItem('nd_training_upload_url') || null; } catch (_) {}
                try {
                    const resp = await fetch('/api/plugins/note_detect/training-bundle/retry', {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({ local_bundle: localBundle, upload_url: uploadUrl }),
                    });
                    let data = null;
                    try { data = await resp.json(); } catch (_) { /* leave null; surfaced below */ }
                    if (!resp.ok) {
                        const errStr = (data && (data.detail || data.error)) || resp.statusText;
                        const out = { ok: false, error: `HTTP ${resp.status}: ${errStr}`, local_bundle: (data && data.local_bundle) || localBundle };
                        _recTrainingUploadResult = out;
                        return out;
                    }
                    _recTrainingUploadResult = data;
                    return data;
                } catch (e) {
                    const out = { ok: false, error: String(e && e.message || e), local_bundle: localBundle };
                    _recTrainingUploadResult = out;
                    console.warn('[note_detect] training-bundle retry failed:', e);
                    return out;
                }
            });
            if (!result) {
                // User cancelled before submitting — no upload attempted.
                _recTrainingUploadResult = {
                    ok: false,
                    error: 'cancelled — bundle not uploaded',
                    local_bundle: null,
                };
            }
            return _recTrainingUploadResult;
        } catch (e) {
            _recTrainingUploadResult = { ok: false, error: String(e && e.message || e) };
            console.warn('[note_detect] training-bundle flow failed:', e);
            return null;
        } finally {
            // Clear the in-flight flag on EVERY exit path — including
            // the early returns above (e.g. slug-parse failure) that
            // never opened the modal. Safe to clear here because
            // _showTrainingConsentModal defers its resolution until any
            // in-flight upload settles (see _activeUpload), so this
            // finally never runs mid-upload.
            //
            // Training-arm teardown (_recArmedForTraining / live-stream
            // unbind) is NOT done here — _recOnEnded's own finally owns
            // it, so the teardown also runs when a failed WAV save means
            // this function was never called.
            _recTrainingUploadInFlight = false;
        }
    }

    // Wire song-play / song-end events on the slopsmith bus so an armed
    // recording auto-arms on Play and auto-saves on song-end. Mirrors
    // the drill-mode binding pattern: bind once at construct, tear down
    // in destroy(). The handlers are no-ops while `_recArmed` is false.
    let _recOnPlay = null, _recOnPause = null, _recOnEnded = null;
    let _recSubscribed = false;
    function _recBindEvents() {
        if (_recSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        _recOnPlay  = () => { _recSongPlaying = true; };
        _recOnPause = () => { _recSongPlaying = false; };
        _recOnEnded = () => {
            _recSongPlaying = false;
            if (_recArmed && _recChunks.length > 0) {
                // Capture training intent + session id + songInfo
                // SYNCHRONOUSLY. _liveOnEnded (registered separately)
                // nulls _liveSessionId on the same event, and by the
                // time the async save+upload chain runs the user may
                // have navigated back to the library — at which point
                // hw.getSongInfo() returns {} and the upload modal
                // would show empty Song Name / custom song filename / Tuning.
                // Pin all of it here.
                const shouldUpload = _recArmedForTraining;
                // _liveSessionId may already be null here: _liveOnEnded
                // (bound by tuning mode, often BEFORE _recBindEvents ran)
                // clears it on this same song:ended. _liveLastSessionId
                // survives song:ended, so it's the reliable handle for
                // locating this take's live_<id>.jsonl detect-stream.
                const sessionAtEnd = _liveSessionId || _liveLastSessionId;
                const songInfoAtEnd = (hw && hw.getSongInfo) ? hw.getSongInfo() : {};
                // Pin the custom song filename HERE too. _ndShared.currentFilename
                // is a process-global the playSong wrapper overwrites, so
                // a splitscreen panel starting another song before this
                // take's async upload runs would otherwise leak the wrong
                // filename into this manifest. songInfo wins; the global
                // is only the fallback, and must be read now, not later.
                const cdlcFilenameAtEnd =
                    (songInfoAtEnd && songInfoAtEnd.filename)
                    || _ndShared.currentFilename || '';
                // Pin the ground-truth note chart too — the arrangement
                // the highway rendered. hw.getNotes()/getChords() return
                // {} once the user navigates away, same as getSongInfo().
                const chartAtEnd = {
                    notes:  (hw && hw.getNotes)  ? hw.getNotes()  : null,
                    chords: (hw && hw.getChords) ? hw.getChords() : null,
                };
                // Pin the audio counters too — saveRecordingNow() resets
                // _recTotalSamples / _recCappedAt once the WAV POST
                // succeeds, and that runs before _uploadTrainingBundle
                // builds the manifest, so reading them later yields
                // duration_s 0 and a lost cap marker.
                const audioStatsAtEnd = {
                    sampleRate:    _recSampleRate,
                    totalSamples:  _recTotalSamples,
                    cappedAtS:     _recCappedAt,
                };
                // Fire-and-forget — the UI polls getRecordingState() so
                // it'll surface the lastSavePath / lastError when it lands.
                saveRecordingNow().then((data) => {
                    // Save has the bytes; release the mic now even if
                    // an upload is still pending (which uses the bytes
                    // already in _recChunks / on disk).
                    _stopParallelTrainingCapture();
                    if (data && shouldUpload) {
                        return _uploadTrainingBundle(data, sessionAtEnd, songInfoAtEnd, chartAtEnd, audioStatsAtEnd, cdlcFilenameAtEnd);
                    }
                }).catch(() => { _stopParallelTrainingCapture(); }).finally(() => {
                    // The training take is over — drop ALL arm state
                    // HERE, on every path. saveRecordingNow() unbinds the
                    // song listeners in its own finally regardless of
                    // success, so leaving _recArmed true on a failed save
                    // would strand the UI "armed" with no song:play/ended
                    // handlers. A failed WAV save also skips
                    // _uploadTrainingBundle entirely, so relying on its
                    // finally would leave training mode stuck on.
                    _recArmed = false;
                    _recArmedForTraining = false;
                    if (!tuningMode) _liveUnbindEvents();
                    // Surface the score summary that _endOfSongOnEnded
                    // deferred — now that the consent modal (if any) has
                    // closed. No-op when nothing was deferred.
                    _runDeferredSummary();
                });
            } else if (_recArmed) {
                // Armed but never captured anything (Detect was off, or
                // song:play never fired). Disarm + release the bus
                // listeners so the next song doesn't start an unintended
                // recording and we don't keep flipping _recSongPlaying.
                _recArmed = false;
                _recArmedForTraining = false;
                _recLastSaveError = 'no audio captured before song:ended';
                _recUnbindEvents();
                // Also drop the training-only live-stream subscription
                // armRecordingForTraining() force-bound — otherwise, with
                // tuning mode off, later songs keep minting/posting live
                // sessions for a take that no longer exists.
                if (!tuningMode) _liveUnbindEvents();
                _stopParallelTrainingCapture();
                // No upload modal will open — release any deferred
                // summary immediately.
                _runDeferredSummary();
            }
        };
        try {
            window.slopsmith.on('song:play',  _recOnPlay);
            window.slopsmith.on('song:pause', _recOnPause);
            window.slopsmith.on('song:ended', _recOnEnded);
        } catch (e) {
            // Partial registration — unwind to avoid leaking handlers.
            try { window.slopsmith.off('song:play',  _recOnPlay); }  catch (_) {}
            try { window.slopsmith.off('song:pause', _recOnPause); } catch (_) {}
            try { window.slopsmith.off('song:ended', _recOnEnded); } catch (_) {}
            _recOnPlay = _recOnPause = _recOnEnded = null;
            return;
        }
        _recSubscribed = true;
    }
    function _recUnbindEvents() {
        if (!_recSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_recOnPlay)  { try { window.slopsmith.off('song:play',  _recOnPlay); }  catch (e) {} }
            if (_recOnPause) { try { window.slopsmith.off('song:pause', _recOnPause); } catch (e) {} }
            if (_recOnEnded) { try { window.slopsmith.off('song:ended', _recOnEnded); } catch (e) {} }
        }
        _recOnPlay = _recOnPause = _recOnEnded = null;
        _recSubscribed = false;
    }

    // ── Auto-record every play ────────────────────────────────────────
    // Capture every play for later analysis (the teaching-tool goal),
    // not just deliberate dev/tuning takes. On song:loaded, arm the
    // upcoming play so it rides the existing capture + song:ended
    // auto-save path — no manual Arm. Gated to:
    //   • the default singleton (isDefault) — so split-screen panels
    //     don't each save their own WAV, and the test instances
    //     (always isDefault:false) never bind an extra song:ended
    //     listener that would break the listener-count assertions;
    //   • `autoRecord` being on (user opt-out) and `detectPreference`
    //     (Detect on — capture taps the detector's input graph, so an
    //     armed-without-Detect take captures nothing).
    // A song stopped mid-play doesn't emit song:ended (stopAudio), so a
    // prior take can still be armed when the next song loads. Flush it
    // first — save if it caught audio, else discard — so two songs never
    // bleed into one WAV. saveRecordingNow() encodes the WAV
    // synchronously before its await and only unbinds in its finally, so
    // we must await it before re-arming or the new take loses its
    // listeners. A deliberate training take (_recArmedForTraining) is
    // left untouched.
    let _autoRecOnLoaded = null, _autoRecOnPause = null, _autoRecOnPlay = null;
    // Minimum captured seconds before a pause auto-saves — so a brief
    // pause mid-song (tweaking a setting, then resuming) doesn't spew a
    // string of tiny fragment WAVs.
    const _AUTO_REC_MIN_PAUSE_SAVE_S = 3;
    function _bindAutoRecord() {
        if (!isDefault || _autoRecOnLoaded) return;
        if (!window.slopsmith || typeof window.slopsmith.on !== 'function') return;
        // New song loaded → flush any take stranded by a stop (no
        // song:ended) so two songs don't bleed into one WAV, then arm
        // the upcoming play.
        _autoRecOnLoaded = async () => {
            if (!autoRecord || !detectPreference) return;
            if (_recArmedForTraining) return;
            // A prior pause/end save that FAILED disarms but keeps _recChunks
            // (retained for a manual retry). With nothing armed we'd otherwise
            // fall through to armRecording(), which wipes that preserved take
            // and its error — bail and leave it intact for the retry.
            if (!_recArmed && _recChunks.length > 0) return;
            if (_recArmed) {
                if (_recChunks.length > 0) {
                    // saveRecordingNow() returns null and KEEPS _recChunks
                    // on upload failure so the take can be retried via the
                    // Save button. armRecording() below clears _recChunks /
                    // _recLastSaveError, so a failed save here would silently
                    // destroy the stranded take — bail and leave it intact.
                    const saved = await saveRecordingNow().catch(() => null);
                    if (!saved && _recChunks.length > 0) return;
                } else {
                    discardRecording();
                }
            }
            armRecording();
        };
        // Pause = "done with this take" for the short-take workflow
        // (play a bit, stop, harness it). Save it — saveRecordingNow()
        // disarms; the next song:play re-arms a fresh take. Gated on a
        // minimum length so a resume-after-a-blip doesn't spam fragments.
        _autoRecOnPause = () => {
            if (!autoRecord || _recArmedForTraining || !_recArmed) return;
            const secs = _recTotalSamples / Math.max(1, _recSampleRate);
            if (_recChunks.length > 0 && secs >= _AUTO_REC_MIN_PAUSE_SAVE_S) {
                saveRecordingNow().catch(() => {});
            }
        };
        // Re-arm on play when nothing's armed — covers resume after a
        // pause-save, and a play not preceded by a fresh song:loaded.
        // armRecording() binds its own _recOnPlay AFTER this play event
        // already fired, so set _recSongPlaying here or the first frames
        // of the resumed take wouldn't be captured.
        _autoRecOnPlay = () => {
            // _recChunks.length > 0 with nothing armed means a save failed and
            // the take is preserved for retry; don't re-arm over it (armRecording
            // would wipe the buffer and the error).
            if (!autoRecord || !detectPreference || _recArmedForTraining || _recArmed || _recChunks.length > 0) return;
            armRecording();
            _recSongPlaying = true;
        };
        try {
            window.slopsmith.on('song:loaded', _autoRecOnLoaded);
            window.slopsmith.on('song:pause',  _autoRecOnPause);
            window.slopsmith.on('song:play',   _autoRecOnPlay);
        } catch (_) { _unbindAutoRecord(); }
    }
    function _unbindAutoRecord() {
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_autoRecOnLoaded) { try { window.slopsmith.off('song:loaded', _autoRecOnLoaded); } catch (_) {} }
            if (_autoRecOnPause)  { try { window.slopsmith.off('song:pause',  _autoRecOnPause); } catch (_) {} }
            if (_autoRecOnPlay)   { try { window.slopsmith.off('song:play',   _autoRecOnPlay); } catch (_) {} }
        }
        _autoRecOnLoaded = _autoRecOnPause = _autoRecOnPlay = null;
    }

    // ── A/V auto-calibrate lifecycle ──────────────────────────────────
    // On song-end, sweep the play's offset-free detections for the av-offset
    // that maximizes matched notes and apply it. At most once per play; the
    // detection log + the once-guard reset on song:loaded AND on a fresh
    // song:play (so a replay or a stop-without-song:ended re-calibrates rather
    // than reusing the prior take), while a resume after song:pause keeps the
    // take. Bound from enableImpl() / unbound in disable()+destroy(), so the
    // audio-less vm tests never register these listeners (listener contracts).
    // Returns a short reason string (for the test/debug hook); the listeners
    // ignore it. The success path sets _lastAvCalibration + applies the offset.
    // Log one offset-free detection ({ bt: hw.getTime()-latencyOffset, m })
    // for the post-play sweep. Gated on the setting + the default singleton
    // (split panels / disabled-setting users don't accumulate) and a confident
    // pitch. Shared by matchNotes() and the engine-verifier poll, which returns
    // before matchNotes() and so must tap this directly.
    function _calLogDetection() {
        if (autoCalibrate && isDefault && detectedMidi >= 0 && _calDetections.length < _CAL_MAX) {
            _calDetections.push({ bt: hw.getTime() - latencyOffset, m: detectedMidi });
        }
    }
    function _ndRunAutoCalibrate() {
        if (!autoCalibrate) return 'autoCalibrate off';
        if (!isDefault) return 'not default';
        // The cal listeners deliberately survive disable() (the host disables
        // detection at song-end, sometimes before song:ended fires), so guard
        // against a USER-initiated Detect-off here: detectPreference stays true
        // across a host disable() but flips false when the user turns Detect
        // off. Without this a late song:ended could move the global A/V offset
        // from a half-finished take after the user switched detection off.
        if (!detectPreference) return 'detect off (user)';
        if (_calDoneThisPlay) return 'already done this play';
        if (typeof window.setAvOffsetMs !== 'function') return 'no window.setAvOffsetMs';
        const notes = (hw && hw.getNotes) ? hw.getNotes() : null;
        if (!notes || !notes.length) return 'no notes';
        const geom = { arrangement: currentArrangement, stringCount: currentStringCount, offsets: tuningOffsets, capo };
        const r = _ndCalibrateOffsetMs(_calDetections, notes, geom, timingHitThreshold, pitchTolerance, {});
        if (!r) return `sweep null (dets=${_calDetections.length}, notes=${notes.length}, arr=${currentArrangement}/${currentStringCount}, win=${timingHitThreshold}, tol=${pitchTolerance})`;
        _calDoneThisPlay = true;
        _lastAvCalibration = r;
        try {
            window.setAvOffsetMs(r.offsetMs);
            console.log(`[note_detect] A/V auto-calibrated to ${r.offsetMs} ms (${r.matched}/${r.total} notes matched)`);
            // Dispatch on the normal detector event path (window + instanceRoot),
            // matching notedetect:verify/notedetect:session, so consumers that
            // don't listen on the slopsmith bus still receive it.
            dispatchInstanceEvent('notedetect:calibrated', { offsetMs: r.offsetMs, matched: r.matched, total: r.total });
            if (window.slopsmith && typeof window.slopsmith.emit === 'function') {
                window.slopsmith.emit('notedetect:calibrated', { offsetMs: r.offsetMs, matched: r.matched, total: r.total });
            }
        } catch (e) { return 'setAvOffsetMs threw: ' + (e && e.message || e); }
        return 'OK ' + JSON.stringify(r);
    }
    let _calOnLoaded = null, _calOnEnded = null, _calOnPause = null, _calOnPlay = null, _calSubscribed = false;
    function _calBindEvents() {
        if (!isDefault || _calSubscribed) return;
        if (!window.slopsmith || typeof window.slopsmith.on !== 'function') return;
        // New song → clean slate (incl. the UI's last-result display).
        _calOnLoaded = () => {
            _calDetections = []; _calDoneThisPlay = false; _lastAvCalibration = null; _calPaused = false;
        };
        // song:play is either a fresh take or a resume after a pause. On a fresh
        // start, reset the take so a replay — or a stop that emitted no
        // song:ended — doesn't sweep the previous play's detections, and so the
        // once-per-play guard re-opens for the new take. On a resume, keep them.
        _calOnPlay = () => {
            if (_calPaused) { _calPaused = false; return; }   // resume — keep the take
            _calDetections = []; _calDoneThisPlay = false;
        };
        // Pause is resumable: just remember we're paused. Do NOT calibrate here —
        // a mid-song pause would lock in a partial-take offset and the
        // once-per-play guard would then suppress the real song:ended sweep
        // after the user resumes.
        _calOnPause = () => { _calPaused = true; };
        // Clean end of the take → sweep once. Clear _calPaused so a replay reads
        // as a fresh start (resets) rather than a resume.
        _calOnEnded = () => { _ndRunAutoCalibrate(); _calPaused = false; };
        try {
            window.slopsmith.on('song:loaded', _calOnLoaded);
            window.slopsmith.on('song:play',   _calOnPlay);
            window.slopsmith.on('song:ended',  _calOnEnded);
            window.slopsmith.on('song:pause',  _calOnPause);
            _calSubscribed = true;
        } catch (_) { _calUnbindEvents(); }
    }
    function _calUnbindEvents() {
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_calOnLoaded) { try { window.slopsmith.off('song:loaded', _calOnLoaded); } catch (_) {} }
            if (_calOnPlay)   { try { window.slopsmith.off('song:play',   _calOnPlay); } catch (_) {} }
            if (_calOnEnded)  { try { window.slopsmith.off('song:ended',  _calOnEnded); } catch (_) {} }
            if (_calOnPause)  { try { window.slopsmith.off('song:pause',  _calOnPause); } catch (_) {} }
        }
        _calOnLoaded = _calOnPlay = _calOnEnded = _calOnPause = null;
        _calSubscribed = false;
    }

    // Live-streaming event bindings — only active while tuning mode is
    // on. Mints a fresh session id on song:play so every take produces
    // its own `live_<id>.jsonl` file server-side; clears it on song:end
    // so judgments fired after a song ends don't trickle into a stale
    // file. Independent of recording arm state — the user gets live
    // streaming even without arming a WAV capture.
    let _liveOnPlay = null, _liveOnEnded = null;
    let _liveSubscribed = false;

    // Mint a fresh live session id and stream the session-header record
    // as line 1 of the JSONL. Normally driven by song:play, but also
    // called from armRecordingForTraining() when the user arms AFTER
    // pressing Play — in that case song:play has already fired and won't
    // fire again, so without this the take would carry no header.
    function _startLiveSession() {
        // Match the recording route's filename convention so live
        // JSONL and recorded WAV pair up cleanly under
        // static/note_detect_recordings/.
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts = now.getFullYear()
            + pad(now.getMonth() + 1) + pad(now.getDate()) + '_'
            + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
        // Short random suffix avoids collisions when two panels
        // emit a song:play in the same second (splitscreen).
        const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
        _liveSessionId = `${ts}_${rand}`;
        // Mirror into a handle that is NOT cleared on song:ended, so the
        // training-bundle upload can still locate this take's JSONL even
        // though _liveOnEnded nulls _liveSessionId.
        _liveLastSessionId = _liveSessionId;
        // Stream a session-header record as line 1 of the JSONL so
        // an offline reader knows under which settings the
        // subsequent judgments were produced. Important for two
        // reasons: (1) any analysis that infers "what cr was the
        // user on?" from judgment data alone is fragile, (2) we
        // want to mine these for sensible-default suggestions
        // across users without each contributor having to attach
        // their settings every time. Distinct shape (type:
        // "session_start") so consumers can split header from
        // judgments. Includes song / arrangement context too —
        // useful for bucketing v1/v2/bass benchmark runs.
        _streamLiveJudgment(_buildSessionHeader());
    }

    function _liveBindEvents() {
        if (_liveSubscribed) return;
        if (!window.slopsmith
            || typeof window.slopsmith.on !== 'function'
            || typeof window.slopsmith.off !== 'function') return;
        _liveOnPlay = () => { _startLiveSession(); };
        _liveOnEnded = () => {
            _liveSessionId = null;
        };
        try {
            window.slopsmith.on('song:play',  _liveOnPlay);
            window.slopsmith.on('song:ended', _liveOnEnded);
        } catch (e) {
            try { window.slopsmith.off('song:play',  _liveOnPlay); }  catch (_) {}
            try { window.slopsmith.off('song:ended', _liveOnEnded); } catch (_) {}
            _liveOnPlay = _liveOnEnded = null;
            return;
        }
        _liveSubscribed = true;
    }
    function _liveUnbindEvents() {
        if (!_liveSubscribed) return;
        if (window.slopsmith && typeof window.slopsmith.off === 'function') {
            if (_liveOnPlay)  { try { window.slopsmith.off('song:play',  _liveOnPlay); }  catch (e) {} }
            if (_liveOnEnded) { try { window.slopsmith.off('song:ended', _liveOnEnded); } catch (e) {} }
        }
        _liveOnPlay = _liveOnEnded = null;
        _liveSubscribed = false;
        _liveSessionId = null;
    }

    // ── Diagnostic track catalog — post-play report (read-only) ───────
    // Catalog + report profiles let multiple diagnostic sloppaks share one
    // detection/report path. Does NOT change scoring, thresholds, or settings.
    const _DIAGNOSTIC_TRACK_CATALOG = [
        {
            id: 'basic-guitar-6',
            title: 'Slopsmith Diagnostic — Basic Guitar',
            artist: 'Slopsmith',
            arrangement: 'Diagnostic Guitar',
            filenameIncludes: 'slopsmith-diagnostic-basic-guitar.sloppak',
            dlcRelativePath: 'diagnostics-builtin/slopsmith-diagnostic-basic-guitar.sloppak',
            instrument: 'guitar',
            stringCount: 6,
            reportProfile: 'basic-guitar-v1',
            description: 'Checks timing, open strings, fretted notes, and power chords.',
        },
    ];

    function _ndSetDiagnosticLaunchStatus(panel, message) {
        if (!panel) return;
        const el = panel.querySelector('.nd-health-diag-launch-status');
        if (el) el.textContent = message || '';
    }

    function _ndSetDiagnosticLaunchStatusAny(message) {
        const el = document.querySelector('.nd-health-diag-launch-status');
        if (el) el.textContent = message || '';
    }

    function _ndWaitForSongReadyEvent(timeoutMs) {
        const ms = timeoutMs != null ? timeoutMs : 15000;
        return new Promise((resolve) => {
            if (!window.slopsmith || typeof window.slopsmith.on !== 'function') {
                resolve(false);
                return;
            }
            let settled = false;
            const finish = (ok) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { window.slopsmith.off('song:ready', onReady); } catch (_) {}
                resolve(ok);
            };
            const onReady = () => finish(true);
            const timer = setTimeout(() => finish(false), ms);
            try {
                window.slopsmith.on('song:ready', onReady);
            } catch (_) {
                finish(false);
            }
        });
    }

    function _ndCaptureDiagnosticReturnBeforeLaunch(track) {
        _ndClearDiagnosticReturnState();
        const prevFn = String(_ndShared.currentFilename || '').trim();
        if (!prevFn) return;
        if (_getDiagnosticTrackForSession()) return;
        const diagFn = String(track.dlcRelativePath || '').trim();
        if (!diagFn) return;
        const prevLower = prevFn.toLowerCase();
        if (prevLower === diagFn.toLowerCase()) return;
        if (track.filenameIncludes
            && prevLower.includes(String(track.filenameIncludes).toLowerCase())) {
            return;
        }
        const hw = resolveHw();
        let info = {};
        try {
            info = (hw && hw.getSongInfo) ? (hw.getSongInfo() || {}) : {};
        } catch (_) { /* read-only snapshot */ }
        const arrIdx = info.arrangement_index;
        _ndShared.diagnosticReturn.active = true;
        _ndShared.diagnosticReturn.previousFilename = prevFn;
        _ndShared.diagnosticReturn.previousArrangementIndex = Number.isFinite(arrIdx)
            ? arrIdx
            : null;
        _ndShared.diagnosticReturn.previousTitle = info.title || null;
        _ndShared.diagnosticReturn.previousArtist = info.artist || null;
        _ndShared.diagnosticReturn.launchedTrackId = track.id;
        _ndShared.diagnosticReturn.diagnosticFilename = diagFn;
    }

    async function _ndReturnToPreviousSongAfterDiagnostic() {
        const r = _ndShared.diagnosticReturn;
        if (!r || !r.active || !r.previousFilename) {
            return false;
        }
        if (typeof window.playSong !== 'function') {
            _ndSetDiagnosticLaunchStatusAny(
                'Could not return to the previous song. Load it from your library.',
            );
            _ndClearDiagnosticReturnState();
            return false;
        }

        const prevFn = r.previousFilename;
        const arrIdx = r.previousArrangementIndex;
        const readyPromise = _ndWaitForSongReadyEvent();

        try {
            const loadPromise = window.playSong(
                encodeURIComponent(prevFn),
                Number.isFinite(arrIdx) ? arrIdx : undefined,
                { bridge: false },
            );
            if (loadPromise && typeof loadPromise.then === 'function') {
                await loadPromise;
            }
        } catch (e) {
            console.warn('[note_detect] return to previous song failed:', e);
            _ndSetDiagnosticLaunchStatusAny(
                'Could not return to the previous song. Load it from your library.',
            );
            _ndClearDiagnosticReturnState();
            return false;
        }

        const ready = await readyPromise;
        const prevTitle = r.previousTitle;
        _ndClearDiagnosticReturnState();
        if (ready) {
            const label = prevTitle
                ? `Returned to ${prevTitle}. Press Play when ready.`
                : 'Returned to previous song. Press Play when ready.';
            _ndSetDiagnosticLaunchStatusAny(label);
            return true;
        }

        _ndSetDiagnosticLaunchStatusAny(
            'Could not return to the previous song. Load it from your library.',
        );
        return false;
    }

    async function _ndLaunchDiagnosticTrack(trackId, panel) {
        const track = _DIAGNOSTIC_TRACK_CATALOG.find((t) => t.id === trackId);
        if (!track || !track.dlcRelativePath) {
            _ndSetDiagnosticLaunchStatus(
                panel,
                'Diagnostic track is not configured.',
            );
            return;
        }
        if (typeof window.playSong !== 'function') {
            _ndSetDiagnosticLaunchStatus(
                panel,
                'Diagnostic track could not be loaded. Restart Slopsmith or rescan your library.',
            );
            return;
        }

        _ndCaptureDiagnosticReturnBeforeLaunch(track);

        _ndSetDiagnosticLaunchStatus(panel, 'Loading diagnostic track…');

        const readyPromise = _ndWaitForSongReadyEvent();

        try {
            const loadPromise = window.playSong(
                encodeURIComponent(track.dlcRelativePath),
                undefined,
                { bridge: false },
            );
            if (loadPromise && typeof loadPromise.then === 'function') {
                await loadPromise;
            }
        } catch (e) {
            console.warn('[note_detect] diagnostic launch failed:', e);
            _ndSetDiagnosticLaunchStatus(
                panel,
                'Diagnostic track could not be loaded. Restart Slopsmith or rescan your library.',
            );
            return;
        }

        const ready = await readyPromise;
        if (ready) {
            _ndSetDiagnosticLaunchStatus(
                panel,
                'Loaded Basic Guitar Diagnostic. Press Play or Spacebar to begin.',
            );
            return;
        }

        _ndSetDiagnosticLaunchStatus(
            panel,
            'Diagnostic track is not available yet. Restart Slopsmith or rescan the library. If it still does not appear, the built-in diagnostic pack may not be installed.',
        );
    }

    const _DIAGNOSTIC_REPORT_PROFILES = {
        'basic-guitar-v1': {
            matchTolS: 0.075,
            powerChordCategoryId: 'powerChords',
            expectedChordStrings: 2,
            displayOrder: ['openLow', 'openNext', 'fretted', 'powerChords', 'repeatCheck'],
            singleHitMissCategories: ['openLow', 'openNext', 'fretted'],
            events: [
                { t: 4,  category: 'openLow',      label: 'Open low string',  chord: false, s: 0, f: 0 },
                { t: 8,  category: 'openNext',     label: 'Open next string', chord: false, s: 1, f: 0 },
                { t: 12, category: 'fretted',      label: 'Fretted note',     chord: false, s: 0, f: 5 },
                { t: 16, category: 'powerChords',  label: 'Power chord',      chord: true },
                { t: 20, category: 'powerChords',  label: 'Power chord',      chord: true },
                { t: 24, category: 'powerChords',  label: 'Power chord',      chord: true },
                { t: 28, category: 'powerChords',  label: 'Power chord',      chord: true },
                { t: 32, category: 'repeatCheck',  label: 'Repeat open low',  chord: false, s: 0, f: 0 },
                { t: 36, category: 'repeatCheck',  label: 'Repeat fretted',   chord: false, s: 0, f: 5 },
                { t: 40, category: 'repeatCheck',  label: 'Repeat power chord', chord: true },
                { t: 44, category: 'repeatCheck',  label: 'Repeat power chord', chord: true },
                { t: 48, category: 'repeatCheck',  label: 'Repeat power chord', chord: true },
            ],
            categories: {
                openLow:     { label: 'Open low string' },
                openNext:    { label: 'Open next string' },
                fretted:     { label: 'Fretted note' },
                powerChords: { label: 'Power chords' },
                repeatCheck: { label: 'Repeat check' },
            },
        },
    };

    function _getDiagnosticTrackForSession() {
        const fn = (_ndShared.currentFilename || '').toLowerCase();
        const currentHw = resolveHw();
        const info = (currentHw && currentHw.getSongInfo) ? currentHw.getSongInfo() : {};
        for (const track of _DIAGNOSTIC_TRACK_CATALOG) {
            if (track.filenameIncludes
                && fn.includes(String(track.filenameIncludes).toLowerCase())) {
                return track;
            }
        }
        for (const track of _DIAGNOSTIC_TRACK_CATALOG) {
            if (info.title === track.title
                && info.artist === track.artist
                && info.arrangement === track.arrangement) {
                return track;
            }
        }
        return null;
    }

    function _diagMatchProfileEvent(events, spec, matchTolS) {
        for (const ev of events) {
            if (!ev || !Number.isFinite(ev.t)) continue;
            if (Math.abs(ev.t - spec.t) > matchTolS) continue;
            if (!!ev.chord !== !!spec.chord) continue;
            if (!spec.chord) {
                if (ev.s !== spec.s || ev.f !== spec.f) continue;
            }
            return ev;
        }
        return null;
    }

    function _buildDiagnosticPlayReportFromProfile(profile, reportProfileId) {
        const events = _diagEvents.slice();
        const chartEvents = profile.events || [];
        const matchTolS = profile.matchTolS != null ? profile.matchTolS : 0.075;
        let matchedCount = 0;
        for (const spec of chartEvents) {
            if (_diagMatchProfileEvent(events, spec, matchTolS)) matchedCount++;
        }
        if (matchedCount === 0) return null;

        const playTotal = hits + misses;
        const overall = {
            hits,
            misses,
            accuracy: playTotal > 0 ? Math.round((hits / playTotal) * 100) : 0,
            bestStreak,
        };

        const categoryMeta = profile.categories || {};
        const categories = {};
        let hasPartialPowerChords = false;
        const powerChordCategoryId = profile.powerChordCategoryId || 'powerChords';
        const expectedChordStrings = profile.expectedChordStrings != null
            ? profile.expectedChordStrings
            : 2;

        for (const catId of Object.keys(categoryMeta)) {
            const specs = chartEvents.filter((s) => s.category === catId);
            let attempts = 0;
            let catHits = 0;
            let catMisses = 0;
            const timingErrors = [];
            const chordAttempts = [];

            for (const spec of specs) {
                const ev = _diagMatchProfileEvent(events, spec, matchTolS);
                if (!ev) continue;
                attempts++;
                if (ev.hit) catHits++; else catMisses++;
                if (Number.isFinite(ev.te)) timingErrors.push(ev.te);
                if (spec.chord) {
                    const hs = Number.isFinite(ev.hs) ? ev.hs : null;
                    const tt = Number.isFinite(ev.tt) ? ev.tt : expectedChordStrings;
                    chordAttempts.push({ t: ev.t, hit: !!ev.hit, hs, tt });
                    if (hs != null && hs < tt) hasPartialPowerChords = true;
                }
            }

            if (attempts === 0) continue;

            const cat = {
                id: catId,
                label: categoryMeta[catId].label,
                attempts,
                hits: catHits,
                misses: catMisses,
                accuracy: Math.round((catHits / attempts) * 100),
                timingMedianMs: timingErrors.length
                    ? _diagPercentile(timingErrors, 50)
                    : null,
            };

            if (catId === powerChordCategoryId && chordAttempts.length) {
                const heard = chordAttempts.filter((c) => c.hs != null);
                const avgHeard = heard.length
                    ? heard.reduce((sum, c) => sum + c.hs, 0) / heard.length
                    : null;
                cat.chordHits = catHits;
                cat.chordMisses = catMisses;
                cat.avgStringsHeard = avgHeard;
                cat.expectedStrings = expectedChordStrings;
                cat.perAttempt = chordAttempts.map((c) => {
                    const heardTxt = c.hs != null
                        ? `heard ${c.hs} of ${c.tt} strings`
                        : 'strings heard unknown';
                    return { t: c.t, hit: c.hit, heardTxt };
                });
            }

            categories[catId] = cat;
        }

        if (!Object.keys(categories).length) return null;

        return {
            reportProfile: reportProfileId,
            overall,
            categories,
            matchedCount,
            hasPartialPowerChords,
            sections: sectionStats.map((s) => ({
                name: s.name,
                hits: s.hits,
                misses: s.misses,
                accuracy: (s.hits + s.misses) > 0
                    ? Math.round((s.hits / (s.hits + s.misses)) * 100)
                    : 0,
            })),
        };
    }

    function _buildDiagnosticPlayReport(track) {
        if (!track || !track.reportProfile) return null;
        const profile = _DIAGNOSTIC_REPORT_PROFILES[track.reportProfile];
        if (!profile) return null;
        if (track.reportProfile === 'basic-guitar-v1') {
            return _buildDiagnosticPlayReportFromProfile(profile, track.reportProfile);
        }
        return null;
    }

    function _diagPlayReportHitMissHtml(hit) {
        return hit
            ? '<span class="text-green-400">Hit</span>'
            : '<span class="text-red-400">Miss</span>';
    }

    function _renderDiagnosticPlayHtml(report, reportProfileId) {
        if (!report || !report.categories) return '';
        if (reportProfileId === 'basic-guitar-v1') {
            return _renderDiagnosticBasicGuitarPlayHtml(report);
        }
        return '';
    }

    function _renderDiagnosticBasicGuitarPlayHtml(report) {
        const profile = _DIAGNOSTIC_REPORT_PROFILES['basic-guitar-v1'];
        if (!report || !report.categories || !profile) return '';
        const cats = report.categories;
        let rows = '';

        for (const id of (profile.singleHitMissCategories || [])) {
            const c = cats[id];
            if (!c || !c.attempts) continue;
            rows += `<div class="flex justify-between gap-2 mb-1">`
                + `<span class="text-gray-300">${c.label}</span>`
                + _diagPlayReportHitMissHtml(c.hits > 0)
                + `</div>`;
        }

        const pwr = cats[profile.powerChordCategoryId || 'powerChords'];
        if (pwr && pwr.attempts) {
            let pwrDetail = '';
            if (pwr.avgStringsHeard != null) {
                pwrDetail += `<div class="text-[10px] text-gray-500">`
                    + `${pwr.chordHits}/${pwr.attempts} hit`
                    + ` · avg heard ${pwr.avgStringsHeard.toFixed(1)} of ${pwr.expectedStrings} strings`
                    + `</div>`;
            } else {
                pwrDetail += `<div class="text-[10px] text-gray-500">${pwr.hits}/${pwr.attempts} hit</div>`;
            }
            const partialLines = (pwr.perAttempt || [])
                .filter((a) => a.heardTxt && (!a.hit || a.heardTxt.indexOf('heard 2 of 2') === -1))
                .map((a) => {
                    const prefix = Number.isFinite(a.t) ? `${a.t}s: ` : '';
                    return `${prefix}${a.heardTxt}`;
                });
            if (partialLines.length) {
                pwrDetail += `<div class="text-[10px] text-gray-500 mt-0.5">`
                    + partialLines.join('<br>')
                    + `</div>`;
            }
            rows += `<div class="mb-1">`
                + `<div class="flex justify-between gap-2">`
                + `<span class="text-gray-300">${pwr.label}</span>`
                + `<span class="text-gray-400">${pwr.hits}/${pwr.attempts} hit</span>`
                + `</div>${pwrDetail}</div>`;
        }

        const rep = cats.repeatCheck;
        if (rep && rep.attempts) {
            rows += `<div class="flex justify-between gap-2 mb-1">`
                + `<span class="text-gray-300">${rep.label}</span>`
                + `<span class="text-gray-400">${rep.hits}/${rep.attempts} hit</span>`
                + `</div>`;
        }

        if (!rows) return '';

        let notes = '<p class="text-[10px] text-gray-500 mt-2">'
            + 'This diagnostic report did not change gameplay settings.'
            + '</p>';
        if (report.hasPartialPowerChords) {
            notes += '<p class="text-[10px] text-gray-500 mt-1">'
                + 'Power chords were partly heard. Try a cleaner/drier channel or run '
                + 'Technique Assessment for root/fifth detail.'
                + '</p>';
        }

        return `<div class="mt-3 text-xs border-t border-gray-600 pt-3">`
            + `<div class="text-gray-200 text-xs font-semibold mb-2">Diagnostic Results</div>`
            + rows
            + notes
            + `</div>`;
    }

    // Returns true if a summary overlay was created, false if it bailed
    // (fewer than 5 judgments) — callers deferring the summary use this
    // to know whether there is actually an overlay to reveal later.
    function showSummary(opts) {
        const total = hits + misses;
        if (total < 5) return false;

        const existing = instanceRoot.querySelector('.nd-summary-overlay');
        if (existing) { existing.remove(); _ndAutoExitRelease = null; }

        const accuracy = Math.round((hits / total) * 100);
        const grade = _ndGradeFor(accuracy);
        const fullCombo = misses === 0;

        let sectionHtml = '';
        if (sectionStats.length > 0) {
            sectionHtml = '<div class="nd-sum-sections"><div class="nd-sum-subhead">Per Section</div>';
            for (const sec of sectionStats) {
                const secTotal = sec.hits + sec.misses;
                const secAcc = secTotal > 0 ? Math.round((sec.hits / secTotal) * 100) : 0;
                const cls = secAcc >= 90 ? 'nd-bar-good' : secAcc >= 70 ? 'nd-bar-mid' : 'nd-bar-bad';
                sectionHtml += `
                    <div class="nd-sum-bar-row">
                        <span class="nd-sum-bar-label">${_ndEscapeHtml(sec.name)}</span>
                        <div class="nd-sum-bar-track"><div class="nd-sum-bar-fill ${cls}" style="--nd-bar-w:${secAcc}%"></div></div>
                        <span class="nd-sum-bar-val">${secAcc}%</span>
                    </div>
                `;
            }
            sectionHtml += '</div>';
        }

        // Miss-category breakdown (#254 follow-up) — bars sum to total misses
        // so the dominant failure mode is visible at a glance. Tuning mode
        // only — normal play sees just the score/grade headline +
        // per-section bars.
        let breakdownHtml = '';
        if (tuningMode && misses > 0) {
            const labels = {
                pure:         ['Pure (no pitch)',    'nd-bar-dim'],
                chordPartial: ['Chord — partial',    'nd-bar-alt'],
                early:        ['Timing — early',     'nd-bar-mid'],
                late:         ['Timing — late',      'nd-bar-mid'],
                sharp:        ['Pitch — sharp',      'nd-bar-cool'],
                flat:         ['Pitch — flat',       'nd-bar-cool'],
            };
            breakdownHtml = '<div class="nd-sum-sections"><div class="nd-sum-subhead">Miss Breakdown</div>';
            for (const k of Object.keys(labels)) {
                const v = _diagBreakdown[k] || 0;
                if (v === 0) continue;
                const pct = Math.round((v / misses) * 100);
                breakdownHtml += `
                    <div class="nd-sum-bar-row">
                        <span class="nd-sum-bar-label">${labels[k][0]}</span>
                        <div class="nd-sum-bar-track"><div class="nd-sum-bar-fill ${labels[k][1]}" style="--nd-bar-w:${pct}%"></div></div>
                        <span class="nd-sum-bar-val">${v} (${pct}%)</span>
                    </div>
                `;
            }
            const timingMed = _diagPercentile(_diagTimingErrors, 50);
            const pitchMed  = _diagPercentile(_diagPitchErrors, 50);
            if (timingMed != null || pitchMed != null) {
                breakdownHtml += '<div class="nd-sum-note">';
                if (timingMed != null) {
                    const tp10 = _diagPercentile(_diagTimingErrors, 10);
                    const tp90 = _diagPercentile(_diagTimingErrors, 90);
                    breakdownHtml += `Timing err (ms): median ${timingMed}, p10..p90 [${tp10}..${tp90}]<br>`;
                }
                if (pitchMed != null) {
                    const pp10 = _diagPercentile(_diagPitchErrors, 10);
                    const pp90 = _diagPercentile(_diagPitchErrors, 90);
                    breakdownHtml += `Pitch err (¢): median ${pitchMed}, p10..p90 [${pp10}..${pp90}]`;
                }
                breakdownHtml += '</div>';
            }
            breakdownHtml += '</div>';
        }

        let diagnosticPlayHtml = '';
        const diagnosticTrack = _getDiagnosticTrackForSession();
        const diagnosticReport = diagnosticTrack
            ? _buildDiagnosticPlayReport(diagnosticTrack)
            : null;
        if (diagnosticReport) {
            diagnosticPlayHtml = _renderDiagnosticPlayHtml(
                diagnosticReport,
                diagnosticTrack.reportProfile,
            );
        }

        const returnSnap = _ndShared.diagnosticReturn;
        const showReturnPrevBtn = !!(diagnosticReport
            && returnSnap
            && returnSnap.active
            && returnSnap.previousFilename);

        const overlay = document.createElement('div');
        overlay.className = 'nd-summary-overlay';
        // Skin attribute mirrors the instance root's so the overlay (a
        // separate top-level nd root in the CSS) themes identically.
        try { overlay.setAttribute('data-nd-skin', _ndLoadSkin()); } catch (e) {}
        overlay.style.pointerEvents = 'auto';
        // Single dismiss path: remove the panel and, when we claimed the
        // host's auto-exit on song end, perform the deferred return to the
        // menu (navigateHome). Paths that navigate elsewhere themselves
        // (Return to Previous Song) pass navigateHome=false to drop the hold
        // without double-navigating. With the option off, _ndAutoExitRelease
        // is null → this is just the legacy "hide the panel" behaviour.
        const _ndDismissSummary = (navigateHome) => {
            overlay.remove();
            const release = _ndAutoExitRelease;
            _ndAutoExitRelease = null;
            if (release && navigateHome) { try { release(); } catch (e) {} }
        };
        overlay.onclick = (e) => { if (e.target === overlay) _ndDismissSummary(true); };
        // .nd-sum-shell wraps the (scrollable) panel so the hand-drawn frame
        // overlay (.nd-sum-frame) can sit absolutely over the panel's edges
        // without scrolling with the content.
        overlay.innerHTML = `
            <div class="nd-sum-shell">
            <div class="nd-sum-panel">
                <div class="nd-sum-header">Song Complete</div>
                <div class="nd-sum-grade-wrap">
                    <canvas class="nd-sum-confetti"></canvas>
                    <div class="nd-sum-grade" data-grade="${grade}">${grade}</div>
                    ${fullCombo ? '<div class="nd-sum-fc">Full Combo</div>' : ''}
                </div>
                <div class="nd-sum-headline">
                    <div class="nd-sum-acc"><span class="nd-sum-acc-n">0</span>%<div class="nd-sum-label">Accuracy</div></div>
                    <div class="nd-sum-score"><span class="nd-sum-score-n">0</span><div class="nd-sum-label">Score</div></div>
                </div>
                <div class="nd-sum-stats">
                    <div class="nd-sum-stat" style="--row-i:0"><span class="nd-sum-stat-label">Hits</span><span class="nd-sum-stat-val nd-val-good">${hits}</span></div>
                    <div class="nd-sum-stat" style="--row-i:1"><span class="nd-sum-stat-label">Misses</span><span class="nd-sum-stat-val nd-val-bad">${misses}</span></div>
                    <div class="nd-sum-stat" style="--row-i:2"><span class="nd-sum-stat-label">Best Streak</span><span class="nd-sum-stat-val nd-val-accent">${bestStreak}</span></div>
                    <div class="nd-sum-stat" style="--row-i:3"><span class="nd-sum-stat-label">Max Multiplier</span><span class="nd-sum-stat-val nd-val-accent">×${maxMultiplier}</span></div>
                </div>
                <div class="nd-sum-xp hidden"></div>
                ${breakdownHtml}
                ${sectionHtml}
                ${diagnosticPlayHtml}
                <div class="nd-sum-actions">
                    ${showReturnPrevBtn ? `
                    <button type="button" class="nd-summary-return-prev nd-btn">
                        Return to Previous Song
                    </button>` : ''}
                    ${tuningMode ? `
                    <button class="nd-summary-download nd-btn nd-btn-primary">
                        Download Diagnostic JSON
                    </button>` : ''}
                    <button class="nd-summary-close nd-btn">
                        Close
                    </button>
                </div>
            </div>
            <div class="nd-sum-frame"></div>
            </div>
        `;
        const closeBtn = overlay.querySelector('.nd-summary-close');
        if (closeBtn) closeBtn.onclick = () => _ndDismissSummary(true);
        const returnPrevBtn = overlay.querySelector('.nd-summary-return-prev');
        if (returnPrevBtn) {
            returnPrevBtn.onclick = () => {
                // This button does its own navigation, so don't let the
                // auto-exit releaser fire on success. But keep it as a
                // fallback: if returning to the previous song fails (resolves
                // false or throws) the host timer was already cancelled by our
                // hold, so without this the user is stranded on the ended song
                // — release it to fall back to the menu.
                const release = _ndAutoExitRelease;
                _ndAutoExitRelease = null;
                overlay.remove();
                const _fallback = () => { if (release) { try { release(); } catch (e) {} } };
                _ndReturnToPreviousSongAfterDiagnostic().then((ok) => {
                    if (!ok) _fallback();
                }).catch((e) => {
                    console.warn('[note_detect] return to previous song failed:',
                        e && e.message ? e.message : e);
                    _fallback();
                });
            };
        }
        const dlBtn = overlay.querySelector('.nd-summary-download');
        if (dlBtn) dlBtn.onclick = () => _downloadDiagnostic();
        // Capture the reveal-animation targets at BUILD time: a deferred
        // (startHidden) summary is revealed after a new song's playSong hook
        // may have reset the live counters, so _runDeferredSummary() must
        // not re-read them.
        overlay._ndReveal = { accuracy, score, grade };
        // startHidden: built now (so the stats are this song's) but kept
        // out of view until _runDeferredSummary() reveals it — used when
        // a training consent modal is taking the screen on song:ended.
        if (opts && opts.startHidden) overlay.style.display = 'none';
        instanceRoot.appendChild(overlay);
        if (!(opts && opts.startHidden)) _animateSummary(overlay, overlay._ndReveal);

        // Host global autoplay/auto-exit handoff: only the natural song-end
        // summary (claimAutoExit) claims the host's deferred return — so it
        // fires when the user dismisses this panel (_ndDismissSummary) rather
        // than after the host's short grace timer would otherwise bounce them
        // to the menu mid-results. autoplayExit / holdAutoExit are absent on
        // older cores → legacy behaviour. Manual + disable()-triggered
        // summaries pass no claimAutoExit and never hold.
        if (opts && opts.claimAutoExit && window.slopsmith
            && window.slopsmith.autoplayExit
            && typeof window.slopsmith.holdAutoExit === 'function') {
            try { _ndAutoExitRelease = window.slopsmith.holdAutoExit(); } catch (e) {}
        }

        publishToJournal(accuracy);
        return true;
    }

    // Reveal sequence for the results panel: adds .nd-revealed (which fires
    // the CSS-side staggered row/bar/grade animations) and runs a single rAF
    // count-up for the accuracy % and score headline. Under reduced motion
    // (or without rAF) the final values land immediately and the CSS side is
    // neutralized by the stylesheet's reduced-motion block.
    function _animateSummary(overlay, vals) {
        if (!overlay || !vals) return;
        const accEl = overlay.querySelector('.nd-sum-acc-n');
        const scoreEl = overlay.querySelector('.nd-sum-score-n');
        const setFinal = () => {
            if (accEl) accEl.textContent = String(vals.accuracy);
            if (scoreEl) scoreEl.textContent = String(vals.score);
        };
        let reduced = false;
        try {
            reduced = !!(window.matchMedia
                && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        } catch (e) {}
        const reveal = () => { try { overlay.classList.add('nd-revealed'); } catch (e) {} };
        if (reduced || typeof requestAnimationFrame !== 'function') {
            reveal();
            setFinal();
            return;
        }
        // Double-rAF so the panel has a laid-out first frame before the
        // staggered animations start (single rAF can coalesce with the
        // append and skip the from-state).
        requestAnimationFrame(() => requestAnimationFrame(reveal));
        const DUR_MS = 1400;
        let start = null;
        const tick = (now) => {
            if (overlay.isConnected === false) return;   // closed mid-count
            if (start === null) start = now;
            const t = Math.min(1, (now - start) / DUR_MS);
            const ease = 1 - Math.pow(1 - t, 3);
            if (accEl) accEl.textContent = String(Math.round(vals.accuracy * ease));
            if (scoreEl) scoreEl.textContent = String(Math.round(vals.score * ease));
            if (t < 1) {
                requestAnimationFrame(tick);
            } else {
                setFinal();
                if (vals.grade === 'S' || vals.grade === 'A') _runConfetti(overlay);
            }
        };
        requestAnimationFrame(tick);
    }

    // One-shot confetti burst over the grade stamp for S/A results. Pure
    // canvas-2D, ~70 particles, self-terminating (~1.5 s), no listeners or
    // timers left behind; bails under reduced motion or when the canvas is
    // unavailable (vm tests, ancient browsers).
    function _runConfetti(overlay) {
        try {
            if (window.matchMedia
                && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        } catch (e) {}
        const canvas = overlay.querySelector('.nd-sum-confetti');
        if (!canvas || typeof canvas.getContext !== 'function') return;
        const wrap = canvas.parentElement;
        const W = canvas.width = (wrap && wrap.clientWidth) || 360;
        const H = canvas.height = (wrap && wrap.clientHeight) || 130;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        // Particle colors follow the active skin's accents.
        let colors = ['#00f0ff', '#ff2ec4', '#00ff88', '#ffffff'];
        try {
            const cs = getComputedStyle(overlay);
            const a = cs.getPropertyValue('--nd-accent').trim();
            const b = cs.getPropertyValue('--nd-accent2').trim();
            const h = cs.getPropertyValue('--nd-hit').trim();
            if (a) colors = [a, b || a, h || a, '#ffffff'];
        } catch (e) {}
        const parts = [];
        for (let i = 0; i < 70; i++) {
            parts.push({
                x: W / 2 + (Math.random() - 0.5) * W * 0.35,
                y: H * 0.6,
                vx: (Math.random() - 0.5) * 4.2,
                vy: -(1.8 + Math.random() * 3.4),
                rot: Math.random() * Math.PI,
                vr: (Math.random() - 0.5) * 0.3,
                size: 2.5 + Math.random() * 3.5,
                color: colors[i % colors.length],
            });
        }
        const LIFE_MS = 1500;
        let t0 = null;
        const frame = (now) => {
            if (overlay.isConnected === false) return;
            if (t0 === null) t0 = now;
            const t = now - t0;
            ctx.clearRect(0, 0, W, H);
            if (t >= LIFE_MS) return;
            const fade = 1 - t / LIFE_MS;
            for (const p of parts) {
                p.x += p.vx;
                p.y += p.vy;
                p.vy += 0.10;
                p.rot += p.vr;
                ctx.save();
                ctx.globalAlpha = fade;
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rot);
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
                ctx.restore();
            }
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }

    function publishToJournal(accuracy) {
        // Use resolveHw() so showSummary() can be called on an
        // instance whose highway wasn't available at construction
        // but has since been defined. `hw` is a `let`, so a direct
        // deref would throw in the pre-resolution case.
        const currentHw = resolveHw();
        const info = currentHw && currentHw.getSongInfo ? currentHw.getSongInfo() : null;
        if (!info) return;
        dispatchInstanceEvent('notedetect:session', {
            title: info.title,
            artist: info.artist,
            arrangement: info.arrangement,
            accuracy,
            hits,
            misses,
            bestStreak,
            // Game-scoring additions (additive only — the practice journal
            // and other consumers ignore unknown keys).
            score,
            maxMultiplier,
            grade: _ndGradeFor(accuracy),
            fullCombo: misses === 0,
            sections: sectionStats.map(s => ({
                name: s.name,
                accuracy: (s.hits + s.misses) > 0 ? Math.round(s.hits / (s.hits + s.misses) * 100) : 0,
            })),
            timestamp: new Date().toISOString(),
        });
    }

    // ── Public API ────────────────────────────────────────────────────
    const api = {
        enable,
        disable,
        destroy,
        isEnabled: () => enabled,
        // Register (or clear, with null) a note set to verify against the live
        // audio every frame, independent of the chart playhead. Emits
        // notedetect:verify { isHit, score, ... } on a hit. Lets a frozen-
        // playhead consumer (Step Mode) ask "is the expected note ringing
        // now?" using the chart-aware verifier without the timing gate that
        // makes notedetect:hit unsuitable there (#468 / #630). `notes` is an
        // array of { s, f, ho?, po?, b?, sl?, hm? }.
        //
        // Optional `ctx` overrides the tuning the target is scored under. Give
        // the per-string tuning as either `openMidis` (absolute open-string
        // MIDI) or `tuning`/`offsets` (semitone offsets from standard), plus
        // optional `arrangement` / `capo` / `stringCount` — see
        // _ndSanitizeVerifyCtx. Pass it so a non-chart consumer (contained
        // playback — SlopScale, Chord Sprint) scores against the player's real
        // instrument instead of the host's loaded song; the target then
        // survives host song-switches and is only dropped when the ctx itself
        // changes. Omit ctx (or pass null) to keep the chart-coupled behavior
        // (Step Mode).
        setVerifyTarget: (notes, ctx) => {
            if (!Array.isArray(notes)) {
                _verifyTarget = null; _verifyTargetSig = null; _verifyTargetCtx = null;
                return;
            }
            // Filter to well-formed positions and store a private copy so a
            // caller mutating its array can't later break the gate's
            // "null or non-empty sanitized array" invariant.
            const clean = notes
                .filter(n => n
                    && Number.isInteger(n.s) && n.s >= 0
                    && Number.isInteger(n.f) && n.f >= 0)
                .map(n => ({
                    s: n.s, f: n.f,
                    ho: !!n.ho, po: !!n.po, b: !!n.b, sl: !!n.sl, hm: !!n.hm,
                }));
            let cleanNotes = clean.length ? clean : null;
            // A ctx only makes sense alongside a live target.
            const vctx = cleanNotes ? _ndSanitizeVerifyCtx(ctx) : null;
            if (cleanNotes && vctx) {
                // Drop notes referencing strings the override's tuning can't
                // represent (e.g. an out-of-table 6-string-bass string left
                // over after the ctx clamp), so the target never carries a
                // string that maps to a NaN pitch and silently never verifies.
                cleanNotes = cleanNotes.filter(n => n.s < vctx.stringCount);
                if (!cleanNotes.length) cleanNotes = null;
            }
            _verifyTarget = cleanNotes;
            _verifyTargetCtx = cleanNotes ? vctx : null;
            // Bind the target to the context it was registered under (the
            // override when supplied, else the host chart).
            _verifyTargetSig = cleanNotes ? _ndVerifyActiveSig() : null;
        },
        getVerifyTarget: () => (_verifyTarget ? _verifyTarget.map(n => ({ ...n })) : null),
        // The caller-supplied tuning context the current verify target is
        // scored under, or null when it tracks the host song's live tuning.
        getVerifyContext: () => (_verifyTargetCtx
            ? { arrangement: _verifyTargetCtx.arrangement, stringCount: _verifyTargetCtx.stringCount,
                offsets: _verifyTargetCtx.offsets.slice(), capo: _verifyTargetCtx.capo }
            : null),

        // ── Contained-playback verifier ─────────────────────────────────────
        // A non-chart consumer (SlopScale, Chord Sprint) running its own
        // exercise transport drives the SAME engine harmonic-comb NoteVerifier
        // the host song uses — its OWN chart + playhead — for timing-aware,
        // engine-gated (silence / onset / persistence) per-note verdicts,
        // instead of the timing-free setVerifyTarget. Host-song scoring is
        // suspended while a contained chart is armed (one engine chart slot).
        //
        // Usage (per the consumer's own RAF tick):
        //   if (await api.setContainedChart(notes, ctx)) { … }      // arm once (async)
        //   await api.pushContainedPlayhead(exerciseTime, playing); // each tick (async)
        //   for (const v of api.drainContainedVerdicts()) { … }     // each tick (sync)
        //   await api.releaseContainedChart();                      // on stop (async)
        // `notes`: [{ id, t, s, f, sus?, ho?, po?, b?, sl?, hm? }] — `id` is a
        // caller-chosen stable key echoed back on each verdict. `ctx`: optional
        // tuning override (see setVerifyTarget / _ndSanitizeVerifyCtx).
        // Returns true (armed), false (NOT armed — another instance owns the
        // slot, or empty/no well-formed notes), or null (browser / downlevel
        // addon — no engine). On anything but true the consumer should fall back.
        setContainedChart: (notes, ctx) => _ndSetContainedChart(notes, ctx),
        // Drive the engine clock with the consumer's exercise playhead and
        // buffer the verdicts the engine finalizes. `t` is pushed verbatim.
        pushContainedPlayhead: (t, playing) => _ndPushContainedPlayhead(t, playing),
        // Return + clear the buffered raw verdicts { id, detected,
        // detectedSongTime, centsError, snr }. The consumer owns judgment.
        drainContainedVerdicts: () => _ndDrainContainedVerdicts(),
        // Disarm the contained chart and restore host-song scoring.
        releaseContainedChart: () => _ndReleaseContainedChart(),
        // True when this build can run a contained verifier (desktop bridge
        // with the chart-verifier API). False on browser / downlevel.
        isContainedVerifierAvailable: () => _ndContainedVerifierAvailable(),

        getStats: () => {
            const accuracy = (hits + misses) > 0 ? Math.round(hits / (hits + misses) * 100) : 0;
            return {
                hits, misses, streak, bestStreak,
                accuracy,
                score, multiplier, maxMultiplier,
                grade: _ndGradeFor(accuracy),
                sectionStats: sectionStats.map(s => ({ name: s.name, hits: s.hits, misses: s.misses })),
            };
        },
        // The user's most-recently-expressed preference: did they last
        // click Detect to turn it ON? Distinct from isEnabled(), which
        // is the live runtime state and goes false on every song-switch
        // (the playSong wrapper silent-disables to clear stale stats).
        // The wrapper itself reads this to decide whether to auto-
        // re-enable for the next song.
        wantsDetect: () => !!detectPreference,
        // Drill-mode read-only state. `current` reflects the
        // in-progress iteration (zeroed when no drill is active).
        // `iterations` is a snapshot copy of completed iterations so
        // callers can't mutate the internal array.
        getDrillStats: () => {
            // Sync inline so callers always see current loop state
            // even when detection is disabled (when updateHUD isn't
            // ticking) — otherwise `active` and `current.startT`
            // could lag behind a loop clear / bounds change until
            // the next enable() or HUD tick.
            _drillSyncFromLoopState();
            const liveTotal = drillIterHits + drillIterMisses;
            return {
                active: drillEnabled,
                current: {
                    hits: drillIterHits,
                    misses: drillIterMisses,
                    streak: drillIterStreak,
                    bestStreak: drillIterBestStreak,
                    accuracy: liveTotal > 0 ? Math.round((drillIterHits / liveTotal) * 100) : 0,
                    startT: drillIterStartT,
                },
                iterations: drillIterations.map((it) => ({ ...it })),
            };
        },
        setChannel,
        setVerifierOffset,
        getVerifierOffset,
        injectButton,
        showSummary,
        // Diagnostic export (#254 follow-up). `downloadDiagnostic()`
        // triggers a browser file save of the current session's
        // breakdown + capped event log; `getDiagnostic()` returns the
        // same payload for in-page display / programmatic use. Schema
        // is `note_detect.diagnostic.v1`. `resetDiagnostic()` zeroes
        // all the counters mid-session (without touching audio /
        // enabled / button state) so you can navigate to a specific
        // section, reset, and capture *only* that section's events.
        downloadDiagnostic: _downloadDiagnostic,
        getDiagnostic: _buildDiagnosticPayload,
        resetDiagnostic: resetScoring,
        getCalibrationSnapshot,
        getVerifierRejects,
        openCalibrationWizard,
        launchCalibration,
        closeCalibrationWizard: calibrationWizardClose,
        openInstrumentCalibrationLab,
        closeInstrumentCalibrationLab: calibrationLabClose,
        getCalibrationReport,
        downloadCalibrationReport: _calLabDownloadReport,
        // Public setter for the Auto-tune-from-session panel — applies
        // a partial settings object with the same clamps the storage
        // loader uses, then persists via saveSettings(). Each field is
        // optional; unknown / non-finite values are ignored so callers
        // can pass only the rows they want to apply. Returns the
        // post-clamp object so the caller can update the UI without a
        // separate get round-trip.
        applySettings: (partial) => {
            partial = partial || {};
            // Restart the audio graph at the end if a structural setting (one
            // baked into the ScriptProcessor at startAudio) changed while live.
            let restartNeeded = false;
            if (typeof partial.method === 'string' && ['yin', 'hps', 'crepe'].includes(partial.method)) {
                detectionMethod = partial.method;
                detectionMethodUserSet = true;  // explicit choice — disable bass auto-HPS
            }
            if (partial.frameSize !== undefined) {
                // The README documents tuning this via applySettings; the
                // ScriptProcessor buffer is fixed at startAudio, so a change
                // while detection is live only takes effect after a restart.
                const nextFrameSize = _ndClampFrameSize(partial.frameSize);
                if (nextFrameSize !== frameSize) {
                    frameSize = nextFrameSize;
                    restartNeeded = enabled;
                }
            }
            if (Number.isFinite(partial.timingTolerance)) {
                timingTolerance = Math.max(0.03, Math.min(0.3, partial.timingTolerance));
            }
            if (Number.isFinite(partial.pitchTolerance)) {
                pitchTolerance = Math.max(10, Math.min(100, partial.pitchTolerance));
            }
            if (Number.isFinite(partial.timingHitThreshold)) {
                timingHitThreshold = Math.max(0.03, Math.min(timingTolerance, partial.timingHitThreshold));
            }
            if (Number.isFinite(partial.chordTimingHitThreshold)) {
                chordTimingHitThreshold = Math.max(timingHitThreshold, Math.min(timingTolerance, partial.chordTimingHitThreshold));
            }
            // Maintain the chord >= single-note invariant after either side moved.
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            if (Number.isFinite(partial.pitchHitThreshold)) {
                pitchHitThreshold = Math.max(5, Math.min(pitchTolerance, partial.pitchHitThreshold));
            }
            if (Number.isFinite(partial.chordHitRatio)) {
                chordHitRatio = Math.max(0.25, Math.min(1, partial.chordHitRatio));
            }
            if (Number.isFinite(partial.detectionConfidenceMin)) {
                detectionConfidenceMin = Math.max(0.05, Math.min(0.50, partial.detectionConfidenceMin));
            }
            if (Number.isFinite(partial.latencyOffset)) {
                // Clamp to the same range as the gear-popover slider
                // (0–0.250 s). The storage loader doesn't clamp this
                // field on read, but the writer should — letting a
                // caller (auto-tune, DevTools experiment, stale code)
                // park latency at 5 s would render the matching
                // window unreachable until the user manually drags
                // the slider back into range.
                latencyOffset = Math.max(0, Math.min(0.25, partial.latencyOffset));
            }
            // Re-enforce timing-threshold invariants at the END of the
            // setter. A partial that lowers `timingTolerance` alone (and
            // doesn't supply new hit thresholds) would otherwise leave
            // `timingHitThreshold` and/or `chordTimingHitThreshold`
            // above the new tolerance ceiling — a state the UI sliders
            // can't represent and that drifts judgment classification
            // until the user touches another knob. Same pattern as the
            // storage-load invariant at the top of createNoteDetector.
            if (timingHitThreshold > timingTolerance) timingHitThreshold = timingTolerance;
            if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
            if (chordTimingHitThreshold > timingTolerance)    chordTimingHitThreshold = timingTolerance;
            saveSettings();
            // Recreate the ScriptProcessor with the new buffer size. Done after
            // saveSettings() so the persisted value is correct even if the
            // restart races; fire-and-forget, matching the other call sites.
            if (restartNeeded) restartAudio();
            return {
                method: detectionMethod,
                frameSize,
                timingTolerance,
                pitchTolerance,
                timingHitThreshold,
                chordTimingHitThreshold,
                pitchHitThreshold,
                chordHitRatio,
                detectionConfidenceMin,
                latencyOffset,
            };
        },
        // Narrower reset for A/V calibrate — clears only the timing
        // samples that feed the next calibration suggestion, leaving
        // hits/misses/streak/sectionStats/eventLog intact. Use this
        // instead of `resetDiagnostic` when the goal is "stop using
        // stale samples from before my offset change", not "start a
        // brand-new session".
        resetCalibrationSamples: _resetCalibrationSamples,
        // Tuning-mode gate. Off by default; flipped on/off from the
        // Settings page (the developer surfaces it gates live there too,
        // so the toggle and the panels it reveals are in one place).
        // Other UI — the summary modal's breakdown / Download button —
        // polls this to decide whether to render the dev-only surfaces.
        isTuningMode: () => tuningMode,
        setTuningMode: (v) => {
            const next = !!v;
            if (next === tuningMode) return;
            tuningMode = next;
            // If the user disables tuning mid-recording, drop the
            // in-flight buffer + disarm — the UI for it is about to
            // disappear and we don't want a half-captured WAV trailing.
            if (!tuningMode && (_recArmed || _recChunks.length > 0)) {
                discardRecording();
            }
            // Live JSONL streaming binds/unbinds with tuning mode so
            // non-tuning users don't pollute the slopsmith event bus.
            // The drill-mode tests assert exactly one song:ended
            // listener after their own bind — adding an always-on
            // live-stream listener would break that contract.
            if (tuningMode) _liveBindEvents(); else _liveUnbindEvents();
            saveSettings();
        },
        // Auto-record-every-play opt-out. The song:loaded listener reads
        // `autoRecord` at fire time, so flipping the flag is enough — no
        // rebind. An in-progress auto-take is left to finish/save on its
        // own song:ended.
        isAutoRecord: () => autoRecord,
        setAutoRecord: (v) => {
            const next = !!v;
            if (next === autoRecord) return;
            autoRecord = next;
            saveSettings();
        },
        // Scoring-UI skin (neon | esports | metal). Global preference: one
        // localStorage key shared by all instances; setSkin live-restamps
        // every open notedetect root (splitscreen panels, summary overlay)
        // and announces the change on the bus so the highway renderer can
        // refresh its FX palette.
        getSkin: () => _ndLoadSkin(),
        setSkin: (skin) => {
            if (ND_SKINS.indexOf(skin) === -1) return false;
            // Mirror first — persistence below is best-effort (see
            // _ndSkinRuntime), the session state must not depend on it.
            _ndSkinRuntime = skin;
            try { localStorage.setItem(ND_SKIN_STORAGE_KEY, skin); } catch (e) {}
            try {
                document.querySelectorAll('.nd-instance-root, .nd-summary-overlay')
                    .forEach(el => el.setAttribute('data-nd-skin', skin));
            } catch (e) {}
            if (window.slopsmith && typeof window.slopsmith.emit === 'function') {
                try { window.slopsmith.emit('notedetect:skin', { skin }); } catch (e) {}
            }
            return true;
        },
        // A/V auto-calibrate opt-out + last result for the Settings UI.
        isAutoCalibrate: () => autoCalibrate,
        setAutoCalibrate: (v) => {
            const next = !!v;
            if (next === autoCalibrate) return;
            autoCalibrate = next;
            saveSettings();
        },
        getLastCalibration: () => _lastAvCalibration,
        // Debug hooks: detection-log state + a manual calibrate trigger, so a
        // headless run can see whether the log fills and why calibrate no-ops.
        _calDebug: () => ({ detections: _calDetections.length, subscribed: _calSubscribed, autoCalibrate, isDefault, notes: (hw && hw.getNotes) ? (hw.getNotes() || []).length : -1 }),
        _calDetectionsDump: () => _calDetections.slice(),
        _runAutoCalibrate: () => _ndRunAutoCalibrate(),
        // Lifecycle-test hooks: inspect/seed the calibration take without the
        // audio pipeline, so the song:play/pause/loaded reset+resume rules are
        // assertable. Production never calls these.
        _calState: () => ({ detections: _calDetections.length, done: _calDoneThisPlay, paused: _calPaused }),
        _calSeedForTest: (n = 5) => { for (let i = 0; i < n; i++) _calDetections.push({ bt: i, m: 40 }); },
        _bindCalEvents: _calBindEvents,
        _unbindCalEvents: _calUnbindEvents,
        // Test hook: run the offset sweep on a supplied detection log + notes
        // without the audio pipeline. Production calls _ndRunAutoCalibrate().
        _calibrateOffsetMs: (dets, notes, geom, winS, tolC, opts) =>
            _ndCalibrateOffsetMs(dets, notes, geom, winS, tolC, opts),
        // Reference-recording capture for the headless harness. Arms
        // the next song-play to capture the detector's input audio,
        // auto-saves on song:ended. POSTs the WAV to the plugin's
        // routes.py endpoint, which writes it under
        // static/note_detect_recordings/ — bind-mounted in the dev
        // container, so the harness on the host can read it back
        // without any copy step. See `getRecordingState()` for status
        // / lastSavePath / lastError fields the UI polls.
        armRecording,
        armRecordingForTraining,
        disarmRecording,
        discardRecording,
        saveRecordingNow,
        getRecordingState,
        // Diagnostic accessor — surfaces the AudioContext's own
        // latency self-report. Both fields describe the *output/render*
        // side of the graph, not the microphone-capture path:
        //   - `baseLatency` is the processing latency the AudioContext
        //     incurs while rendering audio (typically a render quantum
        //     or two of buffering on the output side). It is NOT a
        //     measured input-capture delay and does NOT include the
        //     ScriptProcessor frame buffering on top of it.
        //   - `outputLatency` is the total downstream latency from the
        //     destination node to actually-audible — also output-side.
        // For input-chain latency you have to combine these with the
        // ScriptProcessor frame size and the OS capture buffer (which
        // the browser does not expose). What this accessor IS good for:
        // verifying that the `latencyHint: 'interactive'` opt-in
        // produced a smaller `baseLatency` than the platform default
        // (a useful proxy for "the browser took the hint"). Returns
        // null when audio hasn't been started yet (enable() not yet
        // called or running in the desktop-bridge path that doesn't
        // own an AudioContext).
        getAudioLatencyInfo: () => {
            if (!audioCtx) return null;
            return {
                baseLatency:   Number.isFinite(audioCtx.baseLatency)   ? audioCtx.baseLatency   : null,
                outputLatency: Number.isFinite(audioCtx.outputLatency) ? audioCtx.outputLatency : null,
                sampleRate:    audioCtx.sampleRate,
                frameSize:     frameSize,
                // Effective single-note analysis window: bass widens this from
                // the YIN floor to span ~2 periods of the lowest detectable
                // fundamental at the device rate (see _ndMinAnalysisSamples), so
                // report the real value, not the fixed floor.
                yinBufferSize: _ndMinAnalysisSamples(currentArrangement, audioCtx.sampleRate),
                state:         audioCtx.state,
            };
        },
        // Internal — clear hits / misses / streak / noteResults /
        // sectionStats / detection state back to zeros. Used by the
        // playSong hook so both ENABLED and DISABLED instances drop
        // stale stats on a song switch — matches the pre-factory
        // behaviour where the module-level `_ndResetScoring()` ran on
        // every playSong regardless of whether detection was on.
        // Safe to call at any time (doesn't touch audio/UI/timers,
        // just data). Prefixed with `_` to mark it as non-public.
        _resetScoring: resetScoring,
        // Internal — updateButton is called by _ndLoadCrepe() when the
        // shared model finishes loading to refresh every instance's
        // button text. Prefixed with `_` to mark it as non-public.
        _updateButton: updateButton,
        // Internal — drill-mode test hooks. The audio pipeline
        // (getUserMedia, AudioContext) is unavailable in the vm test
        // sandbox, so tests need a way to bind listeners + inject
        // judgments + drive the loop-state poll without going through
        // enable(). Prefixed with `_` to mark them as non-public.
        _bindDrillEvents: _drillBindEvents,
        _unbindDrillEvents: _drillUnbindEvents,
        _drillSyncFromLoopState: _drillSyncFromLoopState,
        _recordJudgment: recordJudgment,
        // Position-aware score-recompute test hooks. _recomputeScoreToPosition
        // drives the rebuild directly; _bind/_unbindSeekResetEvents let tests
        // pin the song:seek listener-count contract without going through
        // enable()'s audio pipeline. Production binds from enable(), unbinds
        // from destroy().
        _recomputeScoreToPosition: _recomputeScoreToPosition,
        _bindSeekResetEvents: _seekResetBindEvents,
        _unbindSeekResetEvents: _seekResetUnbindEvents,
        // End-of-song summary hooks. Exposed alongside the drill hooks
        // so tests can pin the song:ended listener-count contract
        // (drill alone = 1; drill + end-of-song = 2) without going
        // through enable(). Production code never calls these — they
        // bind from enableImpl() and unbind from destroy().
        _bindEndOfSongEvents: _endOfSongBindEvents,
        _unbindEndOfSongEvents: _endOfSongUnbindEvents,
        // XP-submission test hook — the natural path runs from
        // _endOfSongOnEnded, which tests can't reach without enable()'s
        // audio pipeline. Production code never calls this directly.
        _submitSongXp: _submitSongXp,
        // Chart-state sync test hooks — same rationale as the drill
        // hooks. _getChartState lets tests assert the closure-private
        // currentArrangement/currentStringCount/tuningOffsets/capo
        // fields after a synthetic song:loaded.
        _bindChartStateEvents: _chartStateBindEvents,
        _unbindChartStateEvents: _chartStateUnbindEvents,
        _syncChartStateFromHw: _syncChartStateFromHw,
        // Auto-record test hooks — same rationale. Production binds from
        // enableImpl() / unbinds from destroy(); tests drive them without
        // the audio pipeline to assert the song:loaded auto-arm.
        _bindAutoRecord: _bindAutoRecord,
        _unbindAutoRecord: _unbindAutoRecord,
        // The capture callback that pushes into _recChunks needs a live
        // AudioContext the vm lacks, so tests can't get a non-empty buffer
        // the normal way. Inject one frame so the failed-save-preservation
        // path is testable (saveRecordingNow returns null + keeps the buffer;
        // the auto handlers must not re-arm over it). Production never calls this.
        _injectRecChunkForTest: (n = 128) => {
            const frame = new Float32Array(n);
            _recChunks.push(frame);
            _recTotalSamples += frame.length;
        },
        _getChartState: () => ({
            arrangement: currentArrangement,
            stringCount: currentStringCount,
            tuningOffsets: tuningOffsets.slice(),
            capo,
        }),

        // Internal — headless-harness hooks. Lets a Node CLI tool
        // (plugins/note_detect/tools/harness.js) drive the exact same
        // processFrame / matchNotes / checkMisses pipeline the browser
        // uses, without going through getUserMedia / AudioContext.
        // Required because the matching + judgment logic is closure-
        // internal and 300+ lines of nuance we don't want to
        // reimplement out-of-process. Each entry is a no-arg / small-
        // arg method; the harness composes them. Production code
        // never touches `_harness`.
        _harness: {
            feedFrame: async (buffer, sampleRate) => {
                if (Number.isFinite(sampleRate)) bridgeSampleRate = sampleRate;
                await processFrame(buffer);
            },
            tick: () => { checkMisses(); },
            setEnabled: (v) => { enabled = !!v; },
            setContext: (ctx) => {
                ctx = ctx || {};
                if (typeof ctx.arrangement === 'string') currentArrangement = ctx.arrangement;
                if (Number.isFinite(ctx.stringCount))   currentStringCount = ctx.stringCount;
                if (Array.isArray(ctx.tuningOffsets))   tuningOffsets = ctx.tuningOffsets.slice();
                if (Number.isFinite(ctx.capo))          capo = ctx.capo;
            },
            setSettings: (s) => {
                s = s || {};
                // _harness is a Node-only entrypoint and CREPE's
                // TensorFlow.js model isn't wired in this path (see the
                // file header on tools/harness.js). Accepting 'crepe'
                // here would let a programmatic caller drive a value
                // that the harness CLI explicitly rejects — and the
                // detector would silently fall back to YIN at runtime.
                // Keep the internal API aligned with the CLI's whitelist.
                if (typeof s.method === 'string' && ['yin', 'hps'].includes(s.method)) {
                    detectionMethod = s.method;
                    detectionMethodUserSet = true;  // explicit choice — disable bass auto-HPS
                }
                if (Number.isFinite(s.pitchTolerance))      pitchTolerance      = s.pitchTolerance;
                if (Number.isFinite(s.pitchHitThreshold))   pitchHitThreshold   = s.pitchHitThreshold;
                if (Number.isFinite(s.timingTolerance))     timingTolerance     = s.timingTolerance;
                if (Number.isFinite(s.timingHitThreshold))  timingHitThreshold  = s.timingHitThreshold;
                if (Number.isFinite(s.chordTimingHitThreshold)) {
                    // Clamp here too — _harness is a Node-only entrypoint
                    // (harness.js + regression.js drive scoring through it)
                    // and a regression sweep can legitimately pass a chord
                    // threshold outside [timingHitThreshold, timingTolerance]
                    // (e.g. when sweeping timing alone without re-clamping
                    // the chord value). Clamp instead of accepting blindly
                    // so headless scoring matches in-app behavior.
                    chordTimingHitThreshold = Math.max(timingHitThreshold, Math.min(timingTolerance, s.chordTimingHitThreshold));
                }
                if (Number.isFinite(s.chordHitRatio))       chordHitRatio       = s.chordHitRatio;
                if (Number.isFinite(s.latencyOffset))       latencyOffset       = s.latencyOffset;
                if (Number.isFinite(s.inputGain))           inputGain           = s.inputGain;
                // Re-enforce timing-threshold invariants at the END of the
                // setter. A harness caller can legitimately update only
                // `timingHitThreshold` or `timingTolerance` between scoring
                // runs; without this re-clamp the chord threshold can
                // become stricter than single-note OR exceed the outer
                // tolerance, both of which diverge from in-app behavior.
                if (timingHitThreshold > timingTolerance) timingHitThreshold = timingTolerance;
                if (chordTimingHitThreshold < timingHitThreshold) chordTimingHitThreshold = timingHitThreshold;
                if (chordTimingHitThreshold > timingTolerance)    chordTimingHitThreshold = timingTolerance;
            },
        },
    };

    // Register the draw hook once per instance. The hook early-returns
    // on !enabled so disabled instances cost essentially nothing.
    // If highway isn't ready at construction time, ensureDrawHook()
    // (called from enable()) re-tries after resolving `hw` lazily.
    ensureDrawHook();

    // Recording listeners are NOT bound at construct — drill tests assert
    // a clean per-instance listener count, and we shouldn't be on the
    // slopsmith event bus when no recording is armed anyway. We bind
    // on armRecording(), unbind on disarm / save / destroy.

    // Live-stream listeners follow the same rule but key off tuning
    // mode: if the user already has tuning mode on from localStorage,
    // bind so song:play mints a session id without requiring a
    // setTuningMode toggle. setTuningMode handles the dynamic case.
    if (tuningMode) _liveBindEvents();

    // Auto-enable detection on construct when the persisted preference
    // says so. Default singletons only — splitscreen panels mount /
    // unmount on demand and shouldn't claim the audio device the
    // moment they're constructed. Deferred to next tick so plugin
    // construction returns first; enableImpl() bails cleanly if the
    // highway isn't resolvable yet (it'll keep showing the off-state
    // button until the user clicks).
    //
    // Gated on `window.AudioContext` (or the webkit-prefixed alias) so
    // the vm test sandbox — which stubs the highway but has no audio
    // — doesn't trigger a phantom enable() that binds drill listeners
    // before the test gets to make its assertions.
    const _hasAudio = typeof window !== 'undefined'
        && (typeof window.AudioContext === 'function'
            || typeof window.webkitAudioContext === 'function');
    // Watch for an external detection source (MIDI keys highway) so notedetect
    // renders its HUD/summary from domain verdicts — even with no mic.
    _extBindWatch();

    if (isDefault && detectPreference && _hasAudio) {
        // Auto-enable immediately so a persisted-on session starts detecting
        // the instant the page is ready — a blanket startup delay would miss
        // the opening notes for every user just to accommodate one slow
        // device class. USB interfaces (e.g. the Real Tone Cable) can be
        // enumerated-but-not-yet-openable at first paint, which fails the
        // stream open; in that case retry once after a short settle. The
        // first (silent, automatic) attempt suppresses the failure alert so
        // a transient not-ready device doesn't pop a dialog on load; the
        // retry runs un-suppressed so a genuinely unusable device is still
        // surfaced.
        const autoEnableAttempt = (retriesLeft) => {
            // Re-check BOTH enabled and detectPreference each attempt. A fast
            // user click could have already enabled us (`enabled`), and
            // another surface (settings sync, headless toggle) could have
            // flipped detectPreference to false during the wait — honouring a
            // stale-by-now preference would enable against the user's wishes.
            if (typeof window !== 'undefined' && window.__ndSuppressDefault) return;
            if (enabled || !detectPreference) return;
            // Only the first attempt (one with a retry still in hand) is a
            // silent, non-committal trial — quiet alerts and a preserved device.
            autoEnableTrial = retriesLeft > 0;
            enable().then((ok) => {
                autoEnableTrial = false;
                // enable() resolves false on a failed/again-not-ready open
                // (and on a late highway, which a retry also helps). Retry
                // once if the preference is still live and we're still off.
                if (!ok && retriesLeft > 0 && !enabled && detectPreference) {
                    setTimeout(() => autoEnableAttempt(retriesLeft - 1), _ND_AUTO_ENABLE_RETRY_MS);
                }
            }).catch((e) => {
                autoEnableTrial = false;
                console.warn('[note_detect] auto-enable failed:', e && e.message ? e.message : e);
            });
        };
        setTimeout(() => autoEnableAttempt(1), 0);
    }

    _ndInstances.add(api);
    return api;
}

// ── playSong wrapper (idempotent) ──────────────────────────────────────────
// On a new song, disable every live instance so scoring doesn't carry over,
// then let the original playSong load the chart, then re-inject the default
// singleton's button.
//
// The idempotency guard lives on the wrapper function itself
// (`wrapper._ndWrapped = true`) rather than on a module-level flag.
// Module scope resets on every evaluation, so HMR or a double
// <script> load would see a false module flag, wrap the already-
// wrapped `window.playSong`, and produce a nested wrapper that
// disables instances twice per song switch. Marking the function
// itself persists across re-evaluations because `window.playSong`
// keeps the reference.
const _ND_PLAY_SONG_MAX_RETRIES = 20;
function _ndInstallPlaySongHook() {
    const origPlaySong = window.playSong;
    if (typeof origPlaySong !== 'function') {
        // playSong may not exist yet. Common on HMR or unusual load
        // orders where the plugin runs before slopsmith's app.js
        // defines it. Retry a bounded number of times on the next
        // task — cap prevents an infinite loop in host environments
        // that never define playSong (e.g. the node:test vm harness).
        // Retry counter lives on `_ndShared` so a second evaluation
        // doesn't get a fresh 20-attempt budget on top of the first.
        if (_ndShared.playSongRetries++ < _ND_PLAY_SONG_MAX_RETRIES) {
            setTimeout(_ndInstallPlaySongHook, 50);
        }
        return;
    }
    // If this file was evaluated before, `window.playSong` already
    // points at our wrapper. Bail rather than wrap it again.
    if (origPlaySong._ndWrapped) return;
    const wrapper = async function (...args) {
        // Pin the custom song filename — args[0] is the playSong filename
        // arg; the WS song_info payload that hw.getSongInfo() returns
        // doesn't carry this field, so this is our only reliable
        // signal for the training-bundle manifest's custom song File Name.
        // Decode URI-encoded forms like 'sloppak%2Fbadramer.sloppak'.
        if (typeof args[0] === 'string') {
            let f = args[0];
            try { f = decodeURIComponent(f); } catch (_) { /* leave raw */ }
            _ndShared.currentFilename = f;
            const ret = _ndShared.diagnosticReturn;
            if (ret && ret.active && f) {
                const pf = ret.previousFilename;
                const isRestoreTarget = pf && f === pf;
                if (!isRestoreTarget && !_ndFilenameLooksDiagnostic(f)) {
                    _ndClearDiagnosticReturnState();
                }
            }
        }
        // For each live instance: silent-disable if currently enabled
        // (stop audio + timers without popping a summary modal), then
        // reset scoring unconditionally. Enabled-only disable misses
        // the case of a DISABLED instance that still holds stale
        // stats from the previous song — getStats() / showSummary()
        // on that instance would report yesterday's numbers until
        // the user clicked Detect again. Pre-factory code had a
        // single module-level `_ndResetScoring()` that always ran
        // here; the explicit `resetScoring()` on every instance
        // preserves that behaviour.
        for (const inst of _ndInstances) {
            if (inst.isEnabled()) inst.disable({ silent: true });
            if (typeof inst._resetScoring === 'function') inst._resetScoring();
        }
        const ret = await origPlaySong.apply(this, args);
        // Re-inject the default singleton's Detect button in case the
        // loader recreated the player-controls row. Tuning/capo/
        // arrangement are re-read later inside enable() from
        // hw.getSongInfo(); no need to refresh them eagerly here.
        if (window.noteDetect) {
            window.noteDetect.injectButton();
        }
        // Honour the user's standing preference: if they had Detect
        // turned on, keep it on across song switches. Without this,
        // every song requires another button press because the loop
        // above silent-disables the instance. The end-of-song summary
        // path also silent-disables, so this is the single re-arm
        // point that covers both "user picked next song" and "song
        // finished, user picked next" flows. Default singleton only
        // — splitscreen panels are opt-in surfaces the user mounts
        // per session, and reclaiming the mic for every panel on
        // every song change would be surprising. There's no public
        // isDefault() accessor; the singleton is the one anchored on
        // window.noteDetect.
        const def = window.noteDetect;
        if (def
            // Respect split mode's suppression of the default singleton — otherwise a
            // song switch re-arms the main detector on top of panel 1 (the same flag
            // honored by the song:loaded re-arm + construct auto-enable).
            && !(typeof window !== 'undefined' && window.__ndSuppressDefault)
            && typeof def.wantsDetect === 'function' && def.wantsDetect()
            && !def.isEnabled()) {
            // Fire-and-forget — enable() awaits getUserMedia which we
            // don't want to block playSong on. If the user denied mic
            // permission previously the failure surfaces through the
            // button text the same way it does for a manual click.
            def.enable().catch((e) => {
                console.warn('[note_detect] auto-re-enable on playSong failed:',
                    e && e.message ? e.message : e);
            });
        }
        return ret;
    };
    wrapper._ndWrapped = true;
    window.playSong = wrapper;
}

// ── Singleton + bootstrap ──────────────────────────────────────────────────
// Reuse an existing default instance if the file has been evaluated
// before (HMR, accidental double <script> load). Without this, each
// evaluation would call `createNoteDetector({isDefault:true})` afresh
// — and since `_ndShared.instances` is anchored on window, the old
// default would still be in the registry, producing duplicate Detect
// buttons and per-instance DOM on every reload. Pair this with the
// playSong-wrapper idempotency guard already in place; both together
// keep double-load end-to-end idempotent.
const _ndExistingDefault = (window.noteDetect && typeof window.noteDetect.injectButton === 'function')
    ? window.noteDetect
    : null;
const _ndDefaultInstance = _ndExistingDefault || createNoteDetector({ isDefault: true });
window.noteDetect = _ndDefaultInstance;
window.createNoteDetector = createNoteDetector;

// A host that mounts its own per-panel detectors (e.g. split-screen) calls this to
// SUPPRESS the default singleton while it owns detection — without it the singleton's
// construct auto-enable / song:loaded re-arm / playSong re-arm would render a second
// HUD + mic capture on top of the host's first panel. The internal guards read
// window.__ndSuppressDefault; centralizing the assignment behind this setter keeps the
// whole mechanism owned by, and complete within, this plugin.
window.createNoteDetector.setDefaultSuppressed = function (suppressed) {
    if (typeof window === 'undefined') return;
    window.__ndSuppressDefault = !!suppressed;
    // Flipping the guard only blocks FUTURE auto-enables/re-arms. If the singleton is
    // already running when the host takes over, tear that session down now too —
    // otherwise its live HUD + mic capture is exactly the duplicate state this is meant
    // to prevent. (The host captures wantsDetect()/isEnabled() first if it needs to
    // restore the singleton later.)
    if (suppressed) {
        const def = window.noteDetect;
        if (def && typeof def.isEnabled === 'function' && def.isEnabled()
            && typeof def.disable === 'function') {
            // SILENT — the host is only taking over detection, not ending a song. A
            // plain disable() would pop the end-of-song summary modal + emit
            // notedetect:session once the singleton has a few judgments.
            try { def.disable({ silent: true }); } catch (_) { /* best-effort */ }
        }
    }
};

_ndInstallPlaySongHook();
// Only inject on first evaluation — re-injecting on a subsequent load
// would duplicate the button, since the old one is still in the DOM.
if (!_ndExistingDefault) _ndDefaultInstance.injectButton();
