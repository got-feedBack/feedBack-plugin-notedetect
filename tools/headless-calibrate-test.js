// Headless END-TO-END check of A/V auto-calibration — no human.
// Loads the REAL song (so hw.getNotes() has the chart), feeds the user's
// recording in as the microphone, plays, then fires song:ended and reports
// whether calibrate ran and what it picked. Diagnoses the live no-op:
// did the detection log fill? did song:ended trigger? did setAvOffsetMs fire?
//
// Env: SLOP_URL, FAKE_WAV (recording to feed as mic), SONG (psarc filename),
//      ARRANGEMENT (index, default 2 = Bass).
const { chromium } = require('playwright');
const fs = require('fs');

const URL = process.env.SLOP_URL || 'http://localhost:8000';
const FAKE_WAV = process.env.FAKE_WAV || '/tmp/fakemic.wav';
const SONG = process.env.SONG || 'Arctic-Monkeys_Whyd-You-Only-Call-Me-When-Youre-High_v4_DD_m.psarc';
const ARR = parseInt(process.env.ARRANGEMENT || '2', 10);

(async () => {
  if (!fs.existsSync(FAKE_WAV)) { console.error('mic WAV missing:', FAKE_WAV); process.exit(2); }
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--use-file-for-fake-audio-capture=' + FAKE_WAV,
      '--autoplay-policy=no-user-gesture-required',
    ]});
    const ctx = await browser.newContext();
    try { await ctx.grantPermissions(['microphone'], { origin: URL }); } catch (_) {}
    const page = await ctx.newPage();
    page.on('console', m => { const t = m.text(); if (/calibrat|note_detect|A\/V|error/i.test(t)) console.log('  [page]', t); });
    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.noteDetect && window.slopsmith && typeof window.playSong === 'function', null, { timeout: 20000 });

    const out = await page.evaluate(async ({ SONG, ARR }) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const nd = window.noteDetect, sm = window.slopsmith, log = [];
      nd.setAutoCalibrate && nd.setAutoCalibrate(true);
      // Start the real song (populates the highway chart) + the bass arrangement.
      try { await window.playSong(SONG, ARR, { bridge: false }); log.push('playSong called'); }
      catch (e) { log.push('playSong threw: ' + (e && e.message || e)); }
      // Wait for the chart to load over the WS.
      for (let i = 0; i < 40; i++) { await sleep(250); if (window.highway && window.highway.getNotes && (window.highway.getNotes() || []).length) break; }
      if (!nd.isEnabled || !nd.isEnabled()) { try { await nd.enable(); log.push('enabled detect'); } catch (e) { log.push('enable threw: ' + e.message); } }
      // Let detections accumulate; sample the debug state.
      const samples = [];
      for (let i = 0; i < 10; i++) { await sleep(2000); samples.push(nd._calDebug ? nd._calDebug() : null); }
      const beforeAv = (window.highway && window.highway.getAvOffset) ? window.highway.getAvOffset() : null;
      const setterType = typeof window.setAvOffsetMs;
      // Manual calibrate WHILE detection is active (before song:ended teardown).
      const manualBefore = nd._runAutoCalibrate ? nd._runAutoCalibrate() : 'no hook';
      // Fire song:ended → should also trigger calibrate.
      sm.emit('song:ended', { time: 200 });
      await sleep(700);
      const manualAfter = nd._runAutoCalibrate ? nd._runAutoCalibrate() : 'no hook';
      return {
        log, setterType, beforeAv,
        detSamples: samples.map(s => s && s.detections),
        manualBefore, manualAfter,
        afterAv: (window.highway && window.highway.getAvOffset) ? window.highway.getAvOffset() : null,
        lastCalibration: nd.getLastCalibration ? nd.getLastCalibration() : 'no accessor',
        calDebug: nd._calDebug ? nd._calDebug() : null,
      };
    }, { SONG, ARR });
    console.log(JSON.stringify(out, null, 2));
    // Fail loudly instead of false-greening: the page not throwing doesn't
    // mean calibration worked. Require that detections actually accumulated
    // AND a usable offset was produced.
    const failures = [];
    // detSamples holds _calDebug().detections (a count), but tolerate an array
    // shape too so a future _calDebug change can't silently false-fail here.
    const hasDetections = Array.isArray(out.detSamples) && out.detSamples.some(v =>
      Array.isArray(v) ? v.length > 0 : Number(v) > 0
    );
    if (!hasDetections) failures.push('no detections captured');
    const cal = out.lastCalibration;
    if (!(cal && typeof cal === 'object' && Number.isFinite(Number(cal.offsetMs))))
      failures.push('no calibration result produced');
    if (failures.length) {
      console.error('CALIBRATE CHECK FAILED:', failures.join('; '));
      process.exitCode = 1;
    }
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
})().catch(e => { console.error('DRIVER ERROR:', e); process.exit(2); });
