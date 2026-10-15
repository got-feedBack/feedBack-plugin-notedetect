# Changelog

## [Unreleased] - 1.33.0

Guitar scoring accuracy: notes the player got right no longer score as misses, and stats plugins
get the per-string detail they used to patch `screen.js` for.

### Fixed

- **Capo charts** (#73): fretted notes are read from the nut, the Rocksmith way (a capo-4 E chord
  is `A7 D6 G0 B5`); only fret 0 sounds at the capo. Expected pitch used to add the capo to every
  fret, so capo charts barely scored. Covers the browser detector, the desktop engine (both the
  pushed chart and `scoreChord`: capo 0, open notes moved to the capo fret) and the detected-fret
  display fallback.
- **Fast chord runs** (#75): a ringing chord in a fast run of one shape no longer scores as an
  EARLY miss. The engine verifier stamps a chord with the member detected closest to the chart
  time, and a stamp within one poll of the window edge counts as on time; on the `scoreChord`
  path one early strummed frame no longer locks the chord as a miss.
- **Retuned / transformed charts** (#24): expected pitches follow the host's effective
  `getTuning()` / `getCapo()` / `getCentOffset()` (core chart-transform providers) instead of the
  original song metadata, and resync within a tick when a provider restages mid-song, on every
  detect path including desktop addons without the engine verifier. The desktop engine gets
  whole-semitone offsets with its pitch gate widened by the rounding error (up to 50 cents), so a
  +45-cent record still scores.
- **Technique flags** (#79): bend / slide are read off core's wire format (`sl`/`slu` = -1 means
  no slide, `bn` is the bend amount). Every plain note used to look like a slide and get the
  widened pitch window, and real bends were never seen.
- **Section stats on desktop** (#81): per-section hits / misses are tracked on the engine-verifier
  path (they were always empty there), and each judgment is binned by the section its note sits in.

### Added

- **Richer `notedetect:hit` / `notedetect:miss` payloads** (#77), all additive: `key`, per-string
  `strings` verdicts (`{ s, f, hit, centsError, snr?, detectedAt? }`), named `techniques`,
  `latencyMs`, `avOffsetMs`, `detector`, `section`, `counted`, `points`, `multiplier`, `streak`,
  `isDefault`, and `verdictAt` / `noteEnd` so a renderer can still flash a hit whose verdict landed
  after the gem was culled. See README "Events".
