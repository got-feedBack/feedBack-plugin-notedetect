// Headless proof of the note_detect RECORDING pipeline — no human, no guitar.
//
// Why this exists: capture happens in the browser (getUserMedia -> processor
// -> _recChunks -> POST /recording), so it can't be tested in the vm/node
// suite. Repeatedly asking a human to play a take just to test the PLUMBING
// is the wrong trade — human time is precious. This drives the whole path
// headlessly: Chromium is fed a WAV as its microphone, we enable Detect, arm
// via song:loaded, "play", then pause to trigger the auto-save, and assert a
// WAV actually lands on disk. Detection QUALITY still needs a real take; the
// PIPELINE does not.
//
// Requires Playwright + its Chromium. It is intentionally NOT a plugin
// dependency (keeps the shipped plugin lean). Run via tools/headless-record-test.sh,
// which resolves a Playwright install and generates the fake-mic WAV.
//
// Env:
//   SLOP_URL   slopsmith base URL                       (default http://localhost:8000)
//   FAKE_WAV   16-bit PCM WAV fed as the microphone     (default /tmp/fakemic.wav)
//   REC_DIR    host recordings dir to assert the WAV in (optional; when set, the
//              produced file must exist there AND be newer than test start)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.env.SLOP_URL || 'http://localhost:8000';
const FAKE_WAV = process.env.FAKE_WAV || '/tmp/fakemic.wav';
const REC_DIR = process.env.REC_DIR || '';

(async () => {
  if (!fs.existsSync(FAKE_WAV)) { console.error('fake-mic WAV missing:', FAKE_WAV); process.exit(2); }
  const startMs = Date.now();

  let browser;
  let result;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--use-file-for-fake-audio-capture=' + FAKE_WAV, // loops by default
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    const ctx = await browser.newContext();
    try { await ctx.grantPermissions(['microphone'], { origin: URL }); } catch (_) {}
    const page = await ctx.newPage();
    page.on('console', m => { const t = m.text(); if (/note_detect|record|saveRecording|error/i.test(t)) console.log('  [page]', t); });

    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.noteDetect && window.slopsmith, null, { timeout: 20000 });

    result = await page.evaluate(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const nd = window.noteDetect, sm = window.slopsmith;
      const log = [];
      if (!nd.isEnabled || !nd.isEnabled()) {
        try { await nd.enable(); log.push('enabled detect'); }
        catch (e) { log.push('enable threw: ' + (e && e.message || e)); }
      } else { log.push('detect already enabled'); }
      if (nd.setAutoRecord) { nd.setAutoRecord(true); log.push('auto-record opted in (default is off)'); }
      await sleep(800);
      sm.emit('song:loaded', { filename: 'fakemic.psarc', title: 'headless fakemic' });
      await sleep(100);
      sm.emit('song:play', { time: 0 });
      await sleep(5000);
      const mid = nd.getRecordingState ? nd.getRecordingState() : {};
      log.push('mid-take: ' + JSON.stringify({ armed: mid.armed, songPlaying: mid.songPlaying, samples: mid.samples, durationS: mid.durationS, chunks: mid.chunks }));
      sm.emit('song:pause', { time: 5 });
      let saved = null, err = null;
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        const s = nd.getRecordingState ? nd.getRecordingState() : {};
        if (s.lastSavePath) { saved = s.lastSavePath; break; }
        if (s.lastError) err = s.lastError;
      }
      return { log, saved, err };
    });
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }

  console.log(JSON.stringify(result, null, 2));

  if (!result || !result.saved) { console.error('FAIL: no WAV save path reported'); process.exit(1); }

  // Strong assertion: the file the browser reported actually landed on disk
  // and is newer than the test start (not a stale path from a prior run).
  if (REC_DIR) {
    const full = path.join(REC_DIR, path.basename(result.saved));
    let st;
    try { st = fs.statSync(full); }
    catch (_) { console.error('FAIL: reported WAV not found on disk:', full); process.exit(1); }
    if (st.mtimeMs < startMs) { console.error('FAIL: WAV is older than test start (stale):', full); process.exit(1); }
    console.log('PASS: recording pipeline wrote', full, `(${st.size} bytes)`);
  } else {
    console.log('PASS (path reported):', result.saved, '— set REC_DIR to also assert the file on disk');
  }
  process.exit(0);
})().catch(e => { console.error('DRIVER ERROR:', e); process.exit(2); });
