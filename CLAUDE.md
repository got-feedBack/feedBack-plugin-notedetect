# slopsmith-plugin-notedetect — agent brief

Real-time pitch detection + the game-scoring layer (points, multiplier,
grade, skins, HUD, results screen) for Slopsmith. User-facing docs live in
`README.md`; this file is the working brief for agents, with the consumer
contract other plugins build against.

Everything ships in one browser script (`screen.js`, factory-per-instance —
splitscreen mounts several). `make test` runs the node:test suite through
`test/_loader.js`, a vm harness that executes the real `screen.js` against
DOM stubs. The plugin version lives in THREE places that must stay in sync
(`plugin.json`, `package.json`, `_ND_VERSION` in screen.js — pinned by
`test/version_sync.test.js`), and `assets/plugin.css` is served with
`?v=<version>` as its cache-buster, so **every stylesheet change requires a
version bump**.

## Consuming the scoring layer from another plugin

### The singleton API — `window.noteDetect`

Present once the plugin has loaded (plugins load alphabetically — always
runtime-check `typeof window.noteDetect?.getStats === 'function'`).
Scoring-relevant surface:

- `getStats()` → `{ hits, misses, streak, bestStreak, accuracy /*0–100*/,
  score, multiplier /*1–4*/, maxMultiplier, grade /*'S'..'F'*/,
  sectionStats }`. Resets on every song switch / retry.
- `isEnabled()` — live runtime state; `wantsDetect()` — the user's last
  expressed preference (survives the per-song silent disable).
- `getSkin()` / `setSkin('neon'|'esports'|'metal')` — the scoring-UI skin.
  Also readable directly from `localStorage['slopsmith_notedetect_skin']`
  (cheap for render loops; absent/invalid → treat as `'neon'`).
- `showSummary()` — force the results modal (no XP award on this path).

### Reusing the results card from another plugin

The shareable results card is exposed so other plugins (e.g. Virtuoso) reuse
ONE canonical implementation instead of duplicating it:

- `renderResultsCard(data, opts?)` → `Promise<HTMLCanvasElement|null>` (1200×630).
- `copyResultsCard(data, opts?)` → `Promise<'copied'|'saved'|'copied-text'|'failed'>`
  (image→clipboard → download → text ladder).
- `saveResultsCard(data, opts?)` → `Promise<{ ok, path?, dir?, filename?, fallback? }>`
  — writes a PNG to the user's configured folder (default: their Pictures
  folder) via the plugin's `save-card` route; falls back to a browser download.

`data` (all optional): `eyebrow` (default "SONG COMPLETE"), `hero` (or `title`),
`artist`, `instrument`, `artUrl`, `accuracy`, `score`, `hits`, `misses`,
`bestStreak`, `maxMultiplier`, `fullCombo`, `sections: [{ name, acc }]`,
`extraLabel`/`extraValue`, `stats: [{ label, value, color? }]` (overrides the
default note_detect stat strip — pass this to drive a non-note_detect layout),
`brand` (footer). `opts.overlayEl` supplies the skin palette (defaults to neon
when omitted). Same-origin art keeps the canvas untainted; feature-detect
(`typeof window.noteDetect?.renderResultsCard === 'function'`) and keep a local
fallback so your plugin still runs when note_detect is absent.

### Events

All notedetect events are dispatched **twice in the same task**: first on
`window` (unscoped, back-compat), then as a bubbling CustomEvent from the
per-panel instance root, plus — where noted — on the `window.slopsmith`
bus. Both DOM copies share ONE detail object, so consumers can dedupe by
reference. For per-panel scoping in splitscreen, prefer the element-target
copy and accept it only when its root lives in your panel's container;
defer the window copy a task and drop it if the element copy arrived
(reference implementation: `_fxOnFx` in core `plugins/highway_3d/screen.js`).

| Event | Bus too? | Payload (additive-only contract) |
|---|---|---|
| `notedetect:hit` / `notedetect:miss` | as `note:hit`/`note:miss` | the full judgment (`{ hit, chord, note, notes, noteTime, timingState, timingError, pitchState, pitchError, ... }`) |
| `notedetect:fx` | yes | `{ fxType: 'multiplier', mult, prevMult, streak }` on tier change; `{ fxType: 'milestone', streak, mult }` at 25/50/every 100; `{ fxType: 'streakBreak', lostStreak, prevMult }` after a ≥10 run dies. All carry `{ isDefault, ts }` |
| `notedetect:session` | no | end-of-song summary: `{ title, artist, arrangement, accuracy, hits, misses, bestStreak, score, maxMultiplier, grade, fullCombo, sections, timestamp }` (consumed by the practice journal — never rename/remove keys) |
| `notedetect:skin` | yes | `{ skin }` — re-resolve any cached palette on this |
| `notedetect:verify` | DOM only | timing-free verify hits for `setVerifyTarget` consumers (Step Mode, contained playback) |

### Per-note verdicts for renderers

Renderers consume judgments through core's note-state provider, not events:
`bundle.getNoteState(note, chartTime)` → `null`, or
`{ state: 'hit'|'active'|'miss', alpha, live?, points?, mult?, popKey? }`.

- `points`/`mult`/`popKey` exist on hit/active verdicts from v1.13+ — guard
  with `points !== undefined`, never truthiness (`popKey != null`).
- `popKey` is the dedup key for score pops: chord members all return the
  chord-level judgment's key, so keying your effect on `popKey` gives one
  pop per chord instead of one per gem. Clear your seen-set on backward
  seeks or short practice loops re-trigger nothing.
- Engine-verifier verdicts can land ~0.4 s after the note crosses the
  line — anchor effects on verdict receipt, not chart time.

### Matching the scoring HUD's look

The HUD/results theming is CSS custom properties on the `data-nd-skin`
attribute (stamped on `.nd-instance-root` and `.nd-summary-overlay`) —
see `assets/plugin.css`. A DOM consumer inside an nd root can simply use
`var(--nd-accent)`, `--nd-accent2`, `--nd-hit`, `--nd-miss`,
`--nd-font-display`, etc. A canvas consumer mirrors the palette per skin
(reference: `_FX_PALETTES` in core `plugins/highway_3d/screen.js`) and
refreshes it on `notedetect:skin`. The bundled display fonts (Orbitron /
Rajdhani / Russo One / Black Ops One) are document-loaded by the plugin
stylesheet, so any canvas on the page can use the family names.

### XP

On a natural `song:ended`, notedetect submits the take once to the
minigames profile (`window.slopsmithMinigames.submitRun`,
`game_id: 'song_play'`). Don't award XP again for the same take from
another plugin; for your own game modes use your own `game_id`.

## Internal invariants worth knowing before editing

- `recordJudgment()` is the single site where hits/misses/streak/score
  mutate; the points/multiplier engine and `notedetect:fx` emissions hook
  there. Pure helpers (`_ndMultiplierForStreak`, `_ndIsStreakMilestone`,
  `_ndGradeFor`) are top-level so the vm test loader can reach them.
- HUD class names (`nd-hud-accuracy`, `nd-hud-streak`, `nd-hud-counts`,
  `nd-hud-detected`, `nd-drill*`, `nd-flash-overlay`, `nd-summary-*`) are
  load-bearing — queried by `updateHUD()`/tests; keep them stable.
- The summary's reveal values are captured at BUILD time on the overlay
  (`overlay._ndReveal`) because a deferred (startHidden) summary is shown
  after the next song may have reset the live counters.
- The glow-ring borders are `@property`-animated conic gradients masked to
  an outline; the results panel scrolls, so its ring hangs off the
  `.nd-sum-frame` anchor inside the non-scrolling `.nd-sum-shell`.
- The HUD position is v3-chrome-aware via `body:has(#v3-upnext)` (that
  pill exists only in the v0.3.0 player markup; `#player-hud` exists in
  BOTH UIs and is not a discriminator).
