// Optional integration check: requires Playwright and installed Chrome.
// Runs actual browser decoding, Canvas preprocessing, and both OCR language models.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');

const server = http.createServer((request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8');
    response.end(data);
  });
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    page.on('requestfailed', request => console.error('Request failed: ' + request.url() + ' ' + request.failure()?.errorText));
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => typeof Tesseract !== 'undefined', null, { timeout: 5000 });
    assert.equal(await page.locator('#ocr-model').count(), 1);
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const finished = new Promise(resolve => { recorder.onstop = resolve; });
      const start = performance.now();
      function draw() {
        const elapsed = (performance.now() - start) / 1000;
        ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#fff'; ctx.font = '32px monospace';
        ctx.fillText('00:' + (elapsed + 10).toFixed(3).padStart(6, '0'), 380, 56);
      }
      draw(); recorder.start();
      while (performance.now() - start < 6000) {
        draw();
        await new Promise(requestAnimationFrame);
      }
      recorder.stop(); await finished;
      for (const track of stream.getTracks()) track.stop();
      const blob = new Blob(chunks, { type: 'video/webm' });
      loadFileFromBlob('a', new File([blob], 'synthetic-timer.webm', { type: 'video/webm' }));
    });
    await page.waitForFunction(() => V.a.loaded && V.a.duration > 5);
    await page.evaluate(() => {
      V.a.roi = { x: 58, y: 5, w: 41, h: 15 };
      showCalSection(); autoSample('a');
    });
    console.log('Synthetic video loaded; running OCR');
    await page.evaluate(() => ocrAllSamples('a'));
    const result = await page.evaluate(() => ({
      status: document.getElementById('ocr-status-a').textContent,
      accepted: V.a.pts.filter(p => p.origin === 'ocr').length,
      fit: V.a.reg,
      samples: OCR.reports.a?.samples.map(s => ({ accepted: s.accepted, reason: s.reason,
        value: s.result.value, time: s.result.videoTime,
        frames: s.result.frames?.map(f => ({ value: f.value, time: f.videoTime, reason: f.reason, trials: f.trials })) })),
    }));
    console.log(JSON.stringify({ ...result, samples: result.samples.map(s => ({
      accepted: s.accepted, reason: s.reason, value: s.value, time: s.time,
    })) }, null, 2));
    if (result.accepted < 3) console.log('Failure details: ' + JSON.stringify(result.samples));
    assert.ok(result.accepted >= 3, 'Synthetic timer must yield at least three verified calibration points');
    assert.ok(result.fit?.maxResidual <= 0.05, 'Calibration must meet configured tolerance');
    await page.evaluate(() => {
      const index = V.a.pts.findIndex(p => p.origin === 'ocr');
      ocrConfirmPoint('a', index);
    });
    await page.evaluate(() => ocrCompareModels('a'));
    const comparison = await page.evaluate(() => OCR.reports.a);
    assert.equal(comparison.type, 'model-comparison');
    assert.equal(comparison.profiles.length, 2);
    console.log('Model comparison: ' + JSON.stringify(comparison.profiles.map(p => ({ profile: p.profile, metrics: p.metrics }))));
    const downloadPromise = page.waitForEvent('download');
    await page.evaluate(() => ocrExportReport('a'));
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'framesync-ocr-a.json');
    const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(exported.profiles.length, 2);
    assert.equal(exported.calibration.length, 5);
    assert.deepEqual(errors, []);
    console.log('Browser smoke OK');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
