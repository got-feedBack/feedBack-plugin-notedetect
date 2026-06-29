/*
 * Theme-matrix render gate — renders the results card in EVERY scoring skin
 * into one labeled contact sheet, and runs a structural "the hero stays
 * distinguished" invariant per skin. This is the guard for the class of bug
 * where a feature is built/eyeballed against the default skin only and its
 * visual DEVICE silently vanishes on another skin (a glow-less / monochrome
 * one). See docs/theme-matrix-checklist.md and got-feedback/feedBack#644.
 *
 * Skins are read from screen.js at runtime (ND_SKINS) so the matrix can't go
 * stale when a skin is added. Uses the system Chrome by default (no browser
 * download): `npm i` then `npm run render-skins`. Override the browser with
 * FB_CHROME=/path/to/chrome. Output: tools/.theme-matrix/theme-matrix.png
 * (gitignored) + a PASS/FAIL summary; exits non-zero if a hero loses its
 * emphasis device in any skin.
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const CSS = path.join(ROOT, 'assets', 'plugin.css');
const OUT_DIR = path.join(ROOT, 'tools', '.theme-matrix');

// Read the skin list from the plugin so this can never drift from reality.
function readSkins() {
    const src = fs.readFileSync(path.join(ROOT, 'screen.js'), 'utf8');
    const m = /const\s+ND_SKINS\s*=\s*\[([^\]]+)\]/.exec(src);
    if (!m) throw new Error('Could not find ND_SKINS in screen.js');
    return m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
}

// One representative results card (exercises the hero CTA emphasis, the accent
// accuracy number, the best-delta line, sections, and the secondary buttons).
function cardHtml(skin) {
    return `
    <section class="cell">
      <div class="cell-label">data-nd-skin = "${skin}"</div>
      <div class="nd-summary-overlay matrix-overlay" data-nd-skin="${skin}">
        <div class="nd-sum-shell"><div class="nd-sum-panel">
          <div class="nd-sum-header">Song Complete</div>
          <div class="nd-sum-headline">
            <div class="nd-sum-acc"><span class="nd-sum-acc-n">88</span>%<div class="nd-sum-label">Accuracy</div></div>
            <div class="nd-sum-score"><span class="nd-sum-score-n">4120</span><div class="nd-sum-label">Score</div></div>
          </div>
          <div class="nd-sum-best nd-sum-best--up">★ New best · +4% accuracy</div>
          <div class="nd-sum-sections">
            <div class="nd-sum-subhead">Per Section</div>
            <div class="nd-sum-bar-row"><span class="nd-sum-bar-label">Verse</span><div class="nd-sum-bar-track"><div class="nd-sum-bar-fill nd-bar-good" style="--nd-bar-w:95%"></div></div><span class="nd-sum-bar-val">95%</span></div>
            <div class="nd-sum-bar-row"><span class="nd-sum-bar-label">Bridge</span><div class="nd-sum-bar-track"><div class="nd-sum-bar-fill nd-bar-mid" style="--nd-bar-w:70%"></div></div><span class="nd-sum-bar-val">70%</span></div>
          </div>
          <div class="nd-sum-share">
            <button type="button" class="nd-summary-copy nd-btn">Copy card</button>
            <button type="button" class="nd-summary-save nd-btn">⤓ Save</button>
          </div>
          <div class="nd-sum-hero-reason">Your accuracy's strong — Bridge is the last rough patch.</div>
          <div class="nd-sum-actions">
            <button type="button" class="nd-summary-hero-practice nd-btn nd-btn-primary">Practice: Bridge</button>
            <button type="button" class="nd-summary-retry nd-btn">Retry Song</button>
            <button type="button" class="nd-summary-close nd-btn">Exit Song</button>
          </div>
        </div><div class="nd-sum-frame"></div></div>
      </div>
    </section>`;
}

function pageHtml(skins) {
    return `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="${pathToFileURL(CSS).href}">
    <style>
      html,body{margin:0;background:#05070f;font-family:system-ui,sans-serif}
      .grid{display:flex;flex-wrap:wrap;gap:8px;padding:16px}
      .cell{flex:1 1 520px;min-width:520px}
      .cell-label{color:#9fb3c8;font:600 12px/1.6 ui-monospace,monospace;letter-spacing:.08em;margin:0 0 6px 4px}
      .matrix-overlay{position:static !important;backdrop-filter:none !important;display:block}
    </style></head><body>
    <div class="grid">${skins.map(cardHtml).join('')}</div>
    </body></html>`;
}

// Per-skin invariant: the hero (.nd-btn-primary) must stay visually
// distinguished from a secondary .nd-btn — i.e. it carries SOME emphasis device
// (a fill, a solid border, or a lit glow-ring). Catches "the device vanished on
// this skin and the hero now looks like a plain button."
const INVARIANT = () => {
    const out = [];
    for (const ov of document.querySelectorAll('.matrix-overlay')) {
        const skin = ov.getAttribute('data-nd-skin');
        const hero = ov.querySelector('.nd-btn-primary');
        const sec = ov.querySelector('.nd-btn:not(.nd-btn-primary)');
        if (!hero || !sec) { out.push({ skin, ok: false, why: 'missing hero/secondary' }); continue; }
        const ch = getComputedStyle(hero), cs = getComputedStyle(sec);
        const ringOpacity = parseFloat(getComputedStyle(hero, '::after').opacity || '0') || 0;
        const filled = ch.backgroundImage !== 'none' && ch.backgroundImage !== cs.backgroundImage;
        const bordered = ch.borderColor !== cs.borderColor;
        const ringed = ringOpacity > 0.01;
        const ok = filled || bordered || ringed;
        out.push({ skin, ok, devices: { filled, bordered, ringed } });
    }
    return out;
};

const browser = await chromium.launch(
    process.env.FB_CHROME ? { executablePath: process.env.FB_CHROME } : { channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
const skins = readSkins();
const tmp = path.join(os.tmpdir(), `nd-theme-matrix-${Date.now()}.html`);
fs.writeFileSync(tmp, pageHtml(skins));
await page.goto(pathToFileURL(tmp).href);
await page.waitForTimeout(400); // fonts + conic rings settle

const results = await page.evaluate(INVARIANT);
fs.mkdirSync(OUT_DIR, { recursive: true });
const shot = path.join(OUT_DIR, 'theme-matrix.png');
await page.screenshot({ path: shot, fullPage: true });
await browser.close();
try { fs.unlinkSync(tmp); } catch {}

console.log(`Theme matrix — ${skins.length} skin(s): ${skins.join(', ')}`);
let failed = 0;
for (const r of results) {
    const tag = r.ok ? 'PASS' : 'FAIL';
    const dev = r.devices ? ` (fill:${r.devices.filled} border:${r.devices.bordered} ring:${r.devices.ringed})` : ` (${r.why})`;
    console.log(`  [${tag}] ${r.skin} — hero distinguished${dev}`);
    if (!r.ok) failed++;
}
console.log(`Contact sheet: ${shot}`);
if (failed) {
    console.error(`\nFAIL: ${failed} skin(s) lost the hero emphasis device. Review the contact sheet.`);
    process.exit(1);
}
console.log('\nPASS: the hero stays distinguished in every skin. (Eyeball the contact sheet for the rest — see docs/theme-matrix-checklist.md.)');
