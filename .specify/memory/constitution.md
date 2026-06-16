# Note Detection Plugin Constitution

This plugin captures the user's instrument audio in real time, detects
which note is being played, compares it against the chart, and shows
hit / miss feedback with accuracy scoring. Single notes use YIN /
HPS / CREPE; chords use a constraint-based per-string energy check.

## Principles

### 1. Factory Pattern, Per-Instance State

`createNoteDetector(options)` returns an independent detector
instance with its own audio pipeline, scoring, HUD, timers, draw
hook, and DOM subtree. A default singleton (`window.noteDetect`) is
created on load for the standard single-panel case. Splitscreen and
similar plugins instantiate their own detectors.

### 2. Single-Note Path: Pluggable Pitch Detector

YIN is the default. HPS handles bass with a suppressed fundamental.
CREPE/SPICE handles distorted / effected signals via TensorFlow.js
(lazy 20 MB download, falls back to YIN on load failure).

### 3. Chord Path: Per-String Constraint Scorer

For ≥2 simultaneous chart notes the plugin routes to a chord scorer
that asks "is there energy near the frequency I expect on string S
right now?" rather than "what pitch is playing?" — much simpler
question. Each string's expected band is computed from its open
pitch (with capo / tuning offsets) plus a ±10 % headroom; energy
ratio ≥3 % counts the string as ringing. Chord Leniency setting
decides how many strings must ring for a hit.

### 4. Tuning Comes From the Arrangement

Active tuning base (guitar 6/7/8 string, bass 4/5 string) is
selected automatically from the loaded arrangement. The plugin
does not ask the user — wrong-tuning misclassifications would
otherwise be silent.

### 5. Clean vs Diagnostic Hits

A clean hit requires both timing and pitch within the *clean*
thresholds. Attempts inside the outer windows but outside the clean
thresholds produce diagnostic miss labels (`EARLY` / `LATE` /
`SHARP` / `FLAT`) so the user gets coaching, not just "miss". Both
the outer windows (correlate attempt to chart note) and the clean
thresholds (decide hit vs diagnostic miss) are user-tunable.

### 6. Events Are Public API

`window` `CustomEvent`s (`notedetect:hit`, `notedetect:miss`,
`notedetect:session`) and `window.slopsmith` events (`note:hit`,
`note:miss`) are PUBLIC. Other plugins (e.g.
`slopsmith-plugin-practice` Practice Journal) consume them. The
field reference in README is normative; renames or shape changes
break consumers.

### 7. Tests Run Against the Shipping Code

The `test/` suite uses a Node `vm` loader so tests exercise the
actual `screen.js`, not a parallel copy. Detection / mapping / chord
logic changes MUST keep the test suite green and SHOULD add new
tests rather than mock around the change.

## Inherits from Slopsmith Core Constitution

- Single-script plugin (`plugin.json` declares only `script`).
- Idempotent re-eval of `screen.js` on plugin reload.
- Highway hooks: `addDrawHook`, `getTime`, `getSongInfo` (tuning),
  `getNotes` (chart notes).
- `window.slopsmith` event bus when available.
- Plugin loader serves only the file referenced by `plugin.json`.

Where this plugin's principles disagree with the core constitution,
the core wins.
