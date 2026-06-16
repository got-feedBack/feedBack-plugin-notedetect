# Slopsmith Note Detection Plugin

Real-time pitch detection and scoring for [Slopsmith](https://github.com/byrongamatos/slopsmith) — works on **guitar** (6/7/8-string) and **bass** (4/5-string) arrangements. The active tuning base is selected automatically from the loaded arrangement. Captures audio from your browser's audio input, detects the pitch being played, compares it against the notes on the highway, and shows hit/miss feedback with accuracy scoring. Single notes use YIN/HPS/CREPE pitch detection; chords use a constraint-based per-string energy check that scores how many of a chord's strings are actually ringing.

## Install

```bash
cd plugins
git clone https://github.com/byrongamatos/slopsmith-plugin-notedetect.git note_detect
# restart Slopsmith
```

## How It Works

1. Click **Detect** in the player controls during a song
2. Browser requests microphone/line-in access
3. Audio input is analyzed in real-time for pitch (YIN or CREPE)
4. Detected pitch is compared against expected notes within a timing window
5. The note's **gem lights up brightly** on the highway when you hit it cleanly — and a sustained note keeps glowing for as long as you keep playing it on-pitch; a miss is flagged on the note too
6. Running accuracy and streak shown in the HUD

> **How step 5 renders depends on the active highway renderer.** The plugin publishes a per-note judgment via Slopsmith core's `highway.setNoteStateProvider` hook (slopsmith#254 — honored by the bundled 2D and 3D highways; other renderers can read the same data from the core renderer `bundle`'s `getNoteState(note, chartTime)` method). On the **default 2D highway** the plugin *also* draws its own canvas overlay — the slide-down red ✕ miss markers below the now-line, the EARLY/LATE/SHARP/FLAT diagnostic labels, and the cyan "currently detected" indicator. On a **custom renderer** (e.g. the 3D highway) that canvas overlay is suppressed — the renderer owns the per-note feedback there (the 3D highway shows hit/active glow and a red miss outline + the diagnostic labels itself). The HUD (accuracy/streak), the end-of-song summary, and the optional screen-edge flash are DOM, not canvas, so they show under any renderer. On an **older core** without the hook, the plugin falls back to the 2D-canvas green hit ring / red miss marker overlay near the note regardless of renderer.

## Audio Input Channel Selection

Many guitar multi-effects pedals with USB audio (e.g. Valeton GP-5, Line 6 HX Stomp, Boss GT-1000) send two channels over USB:

| Channel | Signal | Best for |
|---------|--------|----------|
| **Left (Ch 1)** | Dry / DI | Pitch detection (recommended) |
| **Right (Ch 2)** | Wet / FX | Listening |
| **Mono (mix)** | Both mixed | Single-channel interfaces |

**For best pitch detection accuracy, select the dry/DI channel (usually Left / Ch 1).** The clean signal without amp simulation, distortion, or modulation effects gives the pitch detector a much cleaner fundamental frequency to track.

To configure: click the gear icon next to the Detect button, then choose your audio input device and channel.

## Settings

Click the gear icon when detection is active to access:

- **Audio Input Device** — select which interface to capture from
- **Input Channel** — Left (Ch 1), Right (Ch 2), or Mono (mix)
- **Input Level** — VU meter showing signal level on the selected channel
- **Detection Method** — YIN (default), HPS (bass with weak fundamental), or CREPE/SPICE (TensorFlow.js, ~20MB model download, better with effects). See the [Pitch Detection Methods](#pitch-detection-methods) section below for guidance.
- **Timing Tolerance** — outer timing window used to correlate an attempt to a chart note
- **Pitch Tolerance** — outer pitch window used to correlate an attempt to a chart note
- **Clean Timing / Clean Pitch** — stricter thresholds for a clean hit; attempts inside the outer window but outside these thresholds become EARLY/LATE/SHARP/FLAT diagnostic misses
- **Timing/Pitch Labels** — toggles for diagnostic miss labels on the highway
- **Screen-edge flash on hit/miss** — the full-screen green/red border pulse. **Off by default** since the highway now lights up the note itself on a hit (slopsmith#254); tick it for the old peripheral cue
- **Miss Marker Duration** — how long failed-note markers remain visible below the now-line
- **Input Gain** — amplify weak signals
- **Chord Leniency** — fraction of a chord's strings that must ring for the chord to count as a hit (default 60%, range 25–100%)

On the **Settings → Note Detection** page (not the gear popover):

- **Auto-record every play** — off by default. Turn it on to capture each play with detection enabled to a WAV in `static/note_detect_recordings/` (auto-saved on song-end or pause) so you can replay it through the headless harness or analyse it later — no manual arming.
- **Auto-calibrate A/V offset** — on by default. After each play, the detections are swept for the audio/video offset that matches the most chart notes, and that offset is applied automatically — compensating the detector's real-time processing latency so you never hand-set the A/V slider. One play is usually enough to converge.

Advanced (persisted setting, no dedicated control yet — set via `window.noteDetect.applySettings` / localStorage):

- **`frameSize`** — the audio-callback buffer fed to the detector, in samples (default **2048**). 1024 (~21 ms) is too short to resolve a low-bass fundamental (a low-E period is ~24 ms), so the detector silently drops most bass notes; 2048 (~43 ms) roughly triples bass recall for an imperceptible latency cost. Lower toward 1024 for guitar-only minimum input latency.

All settings are persisted in localStorage across sessions.

## Scoring

- Accuracy percentage displayed in the highway HUD (top right)
- Streak counter (consecutive hits) and best streak
- Per-section accuracy breakdown shown when detection is stopped

## Drill mode

Set an A-B loop in Slopsmith and notedetect automatically tracks each loop iteration as a separate "drill" attempt. The HUD shows your most recent iterations with per-iteration accuracy so you can see whether you're improving as you repeat the same passage.

- Activates whenever Slopsmith has both loop bounds set as finite numbers (`window.slopsmith.getLoop()` returns `loopA` and `loopB` that both pass `Number.isFinite`). Null, undefined, or missing fields keep drill inactive.
- Snapshots iteration stats on every `loop:restart` event (Slopsmith emits this at every wrap)
- Per-iteration counters are independent of the global session score — your overall accuracy stays correct
- Iteration history clears on song change or when the loop bounds change to a different passage
- Iterations with zero judgments don't appear (idle wraps don't pollute the scoreboard)
- The most recent 5 iterations are shown in the HUD; up to 50 are kept in memory

Read the live drill state from another plugin via `noteDetector.getDrillStats()`:

```js
{
    active: true,                              // loop currently set
    current: { hits, misses, streak, bestStreak, accuracy, startT },
    iterations: [{ idx, hits, misses, accuracy, bestStreak, durationSec, ts }, ...]
}
```

Requires Slopsmith with the plugin-API series merged. Used APIs: `loop:restart` (snapshot trigger), `song:loaded` + `song:ended` (clear history), `getLoop()` (activation gate). Landed in Slopsmith PRs #198 / #200 / #201.

## Events

Other plugins can listen for these `window`-scoped `CustomEvent`s:

| Event | When | `detail` payload |
|---|---|---|
| `notedetect:hit` | A chart note is classified as a clean hit | Full judgment object (includes legacy fields: `{ note, time, noteTime, expectedMidi, detectedMidi, confidence }`) |
| `notedetect:miss` | A chart note's timing window expires **or** a matched-but-not-clean attempt is classified | Full judgment object (see field reference below) |
| `notedetect:session` | End of song | aggregate stats for the full run (see [Practice Journal plugin](https://github.com/byrongamatos/slopsmith-plugin-practice) for a consumer) |

When Slopsmith's event bus is available, the plugin also emits
`window.slopsmith` events:

| Event | When | Payload |
|---|---|---|
| `note:hit` | A chart note is classified as a clean hit | Full judgment object |
| `note:miss` | A chart note is missed or matched with timing/pitch diagnostics | Full judgment object |

Field reference for the per-note events:

| Field | Meaning | Present for |
|---|---|---|
| `note` | `{ s, f }` — the chart string / fret of the chart note | all events |
| `time` | Classification time in seconds — the plugin's view of "now" when it made the decision (derived from `highway.getTime()` plus the A/V-sync offset, minus the detector's latency compensation) | all events |
| `noteTime` | Chart time in seconds — when the note is scheduled on the chart | all events |
| `expectedMidi` | MIDI number the chart note should produce given the arrangement's tuning | all events |
| `detectedMidi` | MIDI number the pitch detector actually heard | clean hits and matched diagnostic misses; `null` for pure misses (window expired with no pitch detected) |
| `confidence` | Detector's confidence score, 0–1 | clean hits and matched diagnostic misses; `0` for pure misses |
| `hit` | `true` only when timing and pitch are both clean | all events (`false` for misses) |
| `timingState` / `pitchState` | Independent diagnostic axes: `OK`, `EARLY`, `LATE`, `SHARP`, or `FLAT` | clean hits and matched diagnostic misses; `null` for pure misses |
| `timingError` / `pitchError` | Signed timing error in milliseconds and signed pitch error in cents; `pitchError` is octave-folded to the nearest octave (so it is not necessarily equal to `(detectedMidi - expectedMidi) * 100`) | clean hits and matched diagnostic misses; `null` for pure misses |

Example — log every hit:

```js
window.addEventListener('notedetect:hit', (e) => {
    const { note, time, confidence } = e.detail;
    console.log(`hit ${note.s}/${note.f} at t=${time.toFixed(2)}s (conf ${confidence.toFixed(2)})`);
});
```

## Pitch Detection Methods

YIN is the default and handles most rigs well. The other methods are opt-in for specific failure modes:

| Method | Best for | Caveat |
|---|---|---|
| **YIN** | clean signals (default) | octave-up errors on suppressed fundamentals |
| **HPS** | bass with weak fundamental | can miss on strong subharmonic stacks |
| **CREPE / SPICE** | distorted / effected signals | 20 MB model download, WebGL required for speed |
| **Chord constraint** | chords (auto-routed for ≥2 simultaneous chart notes) | per-string energy band check, not full polyphonic transcription |

### Desktop: detect in-plugin on native audio

On the Slopsmith **desktop** app the native JUCE engine owns the audio device and, by default, the engine's own detector produces the pitch/note verdicts the plugin consumes — so the **Detection Method** selector above has no effect there. Enable **Detect in-plugin (native audio)** in the gear ⚙ settings to instead run note_detect's own YIN/HPS/CREPE on the engine-captured guitar signal (pulled via the engine's `getRawAudioFrame` API), which is what lets you pick HPS or CREPE on desktop. Chords are still verified by the engine's harmonic-comb chord scorer. Because the audio comes from the native engine (not the browser's `getUserMedia`), this also sidesteps Electron's broken multichannel-USB capture on some interfaces (slopsmith#818). The toggle only appears on a desktop build whose engine exposes the raw-frame API, and takes effect the next time Detect is switched on.

### Chord detection

When two or more chart notes share a timestamp the plugin routes through a constraint-based scorer instead of the single-note pitch detectors. For each note in the chord it computes the expected frequency band for that string (open pitch to fret 24, with ±10% headroom for capo, tuning offsets, and bends), measures how much of the audio frame's spectral energy falls inside that band, and counts the string as ringing if the band has ≥3% of total energy. The chord scores `hits / total`; the **Chord Leniency** setting decides how high that ratio needs to be for the chord to register as a hit.

Per-note technique flags from the chart adjust the per-string thresholds: hammer-ons / pull-offs lower the energy threshold (no fresh pick attack); bends and slides widen the pitch tolerance (pitch is in motion); harmonics skip the pitch refinement and use energy-only.

### YIN (default)

Lightweight time-domain autocorrelation (implemented as the cumulative-mean-normalized difference function from de Cheveigné & Kawahara, 2002). Works instantly with no model download. Best for clean or lightly distorted signals with a strong fundamental.

**Known failure mode:** when the fundamental is rolled off — amp-sim DIs, small-speaker playback, heavily compressed tones — YIN can lock onto the 2nd harmonic and report the pitch an octave too high. If your bass rig sounds right but detection reads an octave up, try HPS.

### HPS (Harmonic Product Spectrum)

Frequency-domain detector aimed at signals with a suppressed fundamental. Fourier-transforms the audio buffer, then evaluates, for each candidate frequency bin `k`, the sum of log-magnitudes at `k`, `2k`, and `3k`. A real pitch reinforces its own harmonics; a spurious bin doesn't. Peaks that turn out to be subharmonics of a louder higher bin get flipped by a small post-check.

**When to prefer HPS:** bass (4- or 5-string) where YIN reports octave-up on your rig. Typical scenarios — amp-sim DIs, direct-to-interface bass with roll-off below 60 Hz, heavily compressed tones.

**Known failure mode:** signals with strong subharmonic structure (rare on stringed instruments) can fool HPS. If that happens on a rig you care about, fall back to YIN or CREPE and file an issue with a recording.

No extra dependencies — the FFT is an inline radix-2 Cooley-Tukey, ~80 lines of vanilla JS, and keeps the plugin's zero-deps posture.

### CREPE / SPICE

TensorFlow.js neural network model (~20MB, loaded lazily on first use). More robust with heavily distorted or effected signals. Uses WebGL acceleration when available. If the model fails to load (network / WebGL), YIN is used as a transparent runtime fallback.

### ML note detection (Slopsmith Desktop only)

On **Slopsmith Desktop**, when the native audio engine has the Spotify **Basic Pitch** model loaded, detection is upgraded transparently — no setting to flip. The plugin's desktop bridge consumes the engine's polyphonic transcription:

- **Single notes** — when the engine exposes `audio.detectNotes`, each fresh per-pitch onset from the ML detector is matched to the nearest chart note; otherwise the dominant pitch comes from `audio.getPitchDetection` (ML-backed when a model is loaded, else YIN).
- **Chords** — judged by the native `audio.scoreChord` IPC, gated on a fresh chord-pitch onset. When the ML model is loaded the engine's scorer checks each chart note's expected pitch against the model's active pitch set — genuine polyphonic transcription, where a **wrong** note is simply absent from the set rather than false-positiving on a neighbour's energy-band bleed; without the model it uses the constraint-based per-string scorer.

This path is fully feature-detected and fail-soft: a desktop build without `detectNotes` still scores single notes via `getPitchDetection`; one without the `scoreChord` IPC skips chord scoring; and a build without the ML model falls back to YIN/`ChordScorer`. The browser build is unaffected and keeps the JS YIN/HPS/CREPE + constraint path. See `slopsmith-desktop/src/audio/MlNoteDetector.*`.

## Requirements

- Browser with `getUserMedia` support (all modern browsers)
- Audio input device (built-in mic, USB audio interface, or USB multi-effects pedal)
- Slopsmith core with `highway.getSongInfo()` tuning data (v1.x+)

## Develop locally

The repo ships a `Makefile` + compose overlay that mounts this plugin into a
running Slopsmith container via `SLOPSMITH_PLUGINS_DIR` (upstream
`slopsmith@b65a08c`). You edit `screen.js` here; the browser reload picks
it up.

Prereqs: a Slopsmith checkout (`../slopsmith` by default) and Docker
Compose v2.

### Two workflows

| What you're doing | Where | How |
|---|---|---|
| Running Slopsmith without touching this plugin | `~/src/slopsmith` | `DLC_PATH=... docker compose up -d` |
| **Developing this plugin** (live-mounted into Slopsmith) | This repo | `make dev` |

`make dev` is not a competing launcher — it uses `slopsmith/docker-compose.yml`
plus `docker-compose.slopsmith.yml` (the overlay in this repo) to add the
bind mount and the `SLOPSMITH_PLUGINS_DIR` env var. Edits to `screen.js`
here are live on the next browser reload.

### One-time setup

Copy `.env.example` to `.env` and fill in your paths:

```bash
cp .env.example .env
# then edit — typical entries:
#   SLOPSMITH_PORT=8088
#   DLC_PATH=/home/you/slopsmith-dlc
```

`.env` is gitignored. The Makefile auto-loads it and exports each variable
to Docker Compose; Compose also reads the file directly for `${…}`
substitutions in the overlay.

### Daily use

```bash
make help              # list targets
make test              # run the node:test suite (no deps)
make dev               # start slopsmith with this plugin mounted
make logs              # tail the container
make verify-mount      # confirm the plugin is visible inside
make down              # stop slopsmith
```

`make dev` launches Slopsmith at `http://localhost:$SLOPSMITH_PORT` with this
plugin mounted read-only at `/opt/user-plugins/note_detect`. The built-in
`plugins/` directory still loads as usual; this plugin's `plugin.json.id` wins
on the duplicate-id check so a previously-installed copy is safely shadowed.

### Why not clone into `slopsmith/plugins/` directly?

You can (the README's "Install" section describes that). The overlay approach
is better for development because:

- Your edits live in a git-tracked repo separate from the Slopsmith tree
- No manual sync or symlinks
- Swap branches without touching Slopsmith's working tree
- `make down` cleans up; no leftovers in `slopsmith/plugins/`

## Tests

    npm test

Runs a Node `vm`-based harness (Node 18+, no dependencies) that loads the shipped
`screen.js` against DOM stubs and exercises its real pitch-detection and mapping
functions with synthetic signals. Tests cover YIN and HPS detection at
guitar/bass frequencies, the arrangement-aware string/fret mapping, the
chart-context-aware display fingering resolver, the constraint-based chord
detector (per-string frequency bands, energy ratios, technique-flag threshold
adjustments), and noise-tolerance regression guards.

See `test/README.md` for the full rationale. Adding tests when changing
detection or mapping logic is encouraged — the `vm` loader means tests
exercise the actual shipping code, not a parallel copy.

## Headless harness

    node tools/harness.js \
        --audio  recording.wav \
        --chart  path/to/arrangements/lead.json \
        --out    result.json [--verbose]

Runs the **same** `processFrame` / `matchNotes` / `checkMisses` pipeline the
browser uses, off a recorded audio file + an arrangement JSON, and writes a
diagnostic JSON identical to the Settings-page "Download Diagnostic JSON"
export (plus a small `harness` block stamping the audio file, frame size,
total frames, etc.). Detector knobs are CLI flags
(`--method yin|hps`, `--pitch-tolerance`, `--chord-hit-ratio`, …).

Used for offline tuning + regression testing: change a parameter, re-run,
diff two JSONs. No browser, no microphone, no human. Pairs naturally with
[the Note Detect Benchmark sloppak](https://github.com/byrongamatos/slopsmith/tree/main/docs/benchmarks/note_detect_v1)
— record yourself once playing the benchmark cleanly, then sweep settings
against that single recording.

Reads WAVs (int16 / int24 / float32; any sample rate; any channel count —
mixed down to mono and resampled) natively. For other formats (ogg, mp3,
flac, …) it shells out to `ffmpeg` on `$PATH`. Drives detection via the
detector's `_harness` test-only hooks. CREPE isn't supported in the
harness (its TF.js backend wants WebGL) — YIN + HPS + the chord scorer
cover what we'd tune against.

## License

MIT
