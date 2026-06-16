# Detection-core test harness

Node `vm`-based tests for the pure pitch-detection and string/fret-mapping
logic in `screen.js`. Loads the shipped plugin script with DOM/browser stubs
and exercises its function declarations against synthetic signals.

## Run

```
npm test
```

Requires Node 18+ (uses the built-in `node:test` runner; no dependencies).

## What these prove

The plugin today is a 6-string-guitar detector. The tests document concrete
behavior gaps that matter for bass practice:

| Gap | Test file |
|---|---|
| Bass MIDI < 40 returns `{string:-1, fret:-1}` and the hit is silently dropped | `mapping-bass.test.js` |
| `_ndMidiToStringFret` picks the guitar interpretation for bass G2 (MIDI 43), hiding the open-G-string fingering | `mapping-bass.test.js` |
| YIN silently returns `-1` for frequencies below ~80 Hz when handed a 2048-sample buffer (one raw ScriptProcessor frame, no accumulation) | `yin-buffer-sizing.test.js` |
| YIN returns no detection when the fundamental is suppressed (common on small-speaker / compressed bass signals) and some noise is present | `yin-noise-tolerance.test.js` |

Passing tests at the top of each file are intentional regression guards:
we want to catch if a future edit breaks the baselines that currently work.

## Why a `vm`-based loader

`screen.js` is a single browser script (no module exports). Copying the YIN
or mapping functions into a test module would drift. The loader
(`test/_loader.js`) runs the real script against DOM/Navigator stubs, lets
the top-level function declarations attach to the sandbox, and extracts
them. Tests exercise the shipping code.
