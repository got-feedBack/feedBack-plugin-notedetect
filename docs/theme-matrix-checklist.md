# Theme-matrix checklist — for any change that touches the scoring UI's look

The scoring UI ships **multiple skins** (`neon` / `esports` / `metal`, read from
`ND_SKINS` in `screen.js`). They are different **design languages**, not
palettes: `neon` = glow + animation + gradients, `esports` = deliberately
glow-less + near-monochrome + square, `metal` = brushed-steel + bevels +
drop-shadows. So a change that's only checked against the default skin can
silently **carve itself into that one skin** — its colours adapt via the
`--nd-*` tokens, but a new visual **device** (a glow ring, a colour gradient)
that another skin neutralizes just *vanishes* there. (That's the bug this gate
exists to prevent — see got-feedback/feedBack#644.)

## Run the gate

```bash
npm i           # once (adds Playwright; uses your system Chrome, no download)
npm run render-skins
```

It renders the results card in **every** skin into one labelled contact sheet
(`tools/.theme-matrix/theme-matrix.png`) and asserts the structural invariant
below, exiting non-zero on failure. Set `FB_CHROME=/path/to/chrome` to point at
a specific browser.

## Definition of done (the few checks that would have caught the incident)

- [ ] **Expressed via tokens, not hardcoded values** — colours come from `--nd-*`
      roles; no literal hexes baked into a feature rule.
- [ ] **Rendered across all skins** — open the contact sheet and confirm the
      change reads correctly in *each* skin (not just the default).
- [ ] **New visual *devices* are per-skin / "off" is legal** — a device (glow,
      ring, gradient, bevel) is gated on a per-skin token so each skin authors
      its own version (or opts out). It must stay **legible/sensible when its
      token resolves to `none`** — never *assume* the device renders.
- [ ] **Reduced-motion + focus parity** — decorative motion is gated by
      `prefers-reduced-motion`; `:focus-visible` is reachable and visible in
      every skin (don't bind focus solely to `accent`, which can ≈ the surface).
- [ ] **Contrast on accent** — text drawn on an accent fill stays legible in
      every skin (the `on-accent` role; watch light accents like esports amber).

## The automated invariant

The gate fails if the hero call-to-action (`.nd-btn-primary`) is **not visually
distinguished** from a secondary `.nd-btn` in some skin — i.e. it carries no
emphasis device at all (no distinct fill, no border, no lit glow-ring). This
catches "the device vanished and the hero now looks like a plain button." The
**contact sheet is the primary check** for everything else (gradients washing
out, contrast, layout) — eyeball it; pixel-snapshot diffing is deliberately
avoided (the animated conic ring + web-font + anti-aliasing make snapshots
flaky).

> The share-image **canvas** card (`renderResultsCard`) is a *second* themed
> surface — it reads the skin's colour tokens via `getComputedStyle` and draws
> skin-neutral solid devices, so it ports across skins, but a big visual change
> there should still be spot-rendered in each skin.
