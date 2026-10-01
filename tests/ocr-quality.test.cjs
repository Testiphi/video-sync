const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const helpers = fs.readFileSync(path.join(__dirname, '..', 'ocr.js'), 'utf8');
const main = ['ocrParseTimer', 'ocrInit', 'autoSample', 'updateRegression', 'updateCalButton', 'buildIndex']
  .map(name => html.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'))[0]).join('\n');
const defaults = { format: 'minutes', digits: 3, model: 'standard', minConfidence: 0.8, tolerance: 0.05, rate: 1 };

function canvas(width = 2, height = 2) {
  const c = { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
  for (let i = 0; i < c.pixels.length; i += 4) {
    c.pixels[i] = c.pixels[i + 1] = c.pixels[i + 2] = i % 8 ? 255 : 0;
    c.pixels[i + 3] = 255;
  }
  c.getContext = () => ({
    getImageData: () => ({ data: c.pixels }),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    fillRect() {},
    putImageData(image) { c.image = image; },
  });
  c.toDataURL = () => 'data:image/png;base64,test';
  return c;
}

function harness() {
  const elements = new Map(), controls = [{ disabled: false }, { disabled: true }];
  for (const id of ['ocr-status-a', 'ocr-status-b', 'cal-meta-a', 'cal-meta-b', 'build-a', 'build-b']) {
    elements.set(id, { style: {}, textContent: '', disabled: false });
  }
  const V = { a: { loaded: true, duration: 100, roi: { x: 80, y: 8, w: 16, h: 14 }, pts: [] },
    b: { loaded: true, duration: 100, pts: [] } };
  let time = 0, renders = 0, initialized = [];
  const OCR = { worker: null, ready: false, profile: null, busy: false, reports: {} };
  const context = vm.createContext({ V, OCR,
    document: {
      getElementById: id => elements.get(id) || null,
      querySelectorAll: query => query === 'video' ? [] : controls,
      createElement: () => canvas(),
    },
    performance: { now: () => ++time },
    renderCalTable() { renders++; }, checkSyncReady() {}, pauseSyncPlayback() {}, drawCalPreviews() {},
    alert(message) { throw new Error('Unexpected alert: ' + message); }, console,
    Tesseract: { async createWorker(language, oem, options, config) {
      initialized.push({ language, oem, options, config });
      return { async setParameters() {}, async terminate() {}, async recognize() {
        return { data: { text: '00:01.000', confidence: 95 } };
      } };
    } },
    Blob, URL, setTimeout, clearTimeout,
  });
  vm.runInContext(helpers + '\n' + main, context);
  return { c: context, V, OCR, elements, controls, initialized, get renders() { return renders; } };
}

test('selected timer format and exact fractional precision prevent silent format changes', () => {
  const { c } = harness();
  assert.equal(c.ocrParseConfigured('01:23.456', defaults), 83.456);
  assert.equal(c.ocrParseConfigured('23.456', defaults), null);
  assert.equal(c.ocrParseConfigured('01:23.45', defaults), null);
  assert.equal(c.ocrParseConfigured('23.456', { ...defaults, format: 'seconds' }), 23.456);
  assert.equal(c.ocrParseConfigured('23', { ...defaults, format: 'seconds', digits: 0 }), 23);
  assert.equal(c.ocrParseConfigured('0123456', { ...defaults, format: 'auto' }), null);
});

test('ROI scaling preserves aspect ratio and bounds oversized or clipped crops', () => {
  const { c } = harness();
  const crop = c.ocrCropGeometry({ x: 10, y: 10, w: 40, h: 10 }, 1000, 1000);
  assert.equal(crop.width / crop.height, 4);
  const clipped = c.ocrCropGeometry({ x: -5, y: 90, w: 10, h: 20 }, 1000, 1000);
  assert.equal(clipped.w, 50);
  assert.equal(clipped.h, 100);
  const large = c.ocrCropGeometry({ x: 0, y: 0, w: 100, h: 100 }, 8000, 4000);
  assert.ok(large.width <= 1280 && large.height <= 512);
  assert.throws(() => c.ocrCropGeometry({ x: 110, y: 0, w: 5, h: 5 }, 1000, 1000));
});

test('preprocessing keeps an original and both threshold polarities with padding', () => {
  const { c } = harness();
  const variants = c.ocrImageVariants(canvas());
  assert.deepEqual(Array.from(variants, v => v.name), ['original', 'gray', 'binary', 'inverted']);
  for (const variant of variants) {
    assert.equal(variant.canvas.width, 22);
    assert.equal(variant.canvas.height, 22);
  }
  assert.equal(variants[2].canvas.image.data[0], 0);
  assert.equal(variants[3].canvas.image.data[0], 255);
  assert.equal(variants[0].canvas.image.data[4], 255);
});

test('confidence alone is insufficient and conflicting candidates are rejected', () => {
  const { c } = harness();
  const one = { value: 83.456, confidence: 0.99 };
  assert.equal(c.ocrSelectCandidates([one], defaults).accepted, false);
  assert.equal(c.ocrSelectCandidates([one, { ...one, confidence: 0.7 }], defaults).accepted, false);
  assert.equal(c.ocrSelectCandidates([one, one], defaults).accepted, true);
  assert.equal(c.ocrSelectCandidates([one, one, { value: 23.456, confidence: 0.9 }], defaults).accepted, false);
});

test('recognition uses two agreeing variants and passes segmentation per job', async () => {
  const { c, OCR } = harness();
  const calls = [];
  OCR.worker = { async recognize(image, options) {
    calls.push(options);
    return { data: { text: '01:23.456', confidence: 95, words: [{ confidence: 90 }] } };
  } };
  const result = await c.ocrRecognizeFrame({ canvas: canvas(), videoTime: 12, timeSource: 'mediaTime' }, defaults);
  assert.equal(result.accepted, true);
  assert.equal(result.value, 83.456);
  assert.equal(result.confidence, 0.9);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.tessedit_pageseg_mode === '7'));
});

test('temporal checks follow elapsed time rather than voting for a repeated timer string', () => {
  const { c } = harness();
  const f = (time, value, extra = {}) => ({ videoTime: time, value, accepted: true, confidence: 0.9, ...extra });
  const result = c.ocrSelectTemporal([f(10, 20, { target: true }), f(9.88, 19.88), f(10.12, 20.12)], defaults);
  assert.equal(result.accepted, true);
  assert.equal(result.videoTime, 10);
  assert.equal(c.ocrSelectTemporal([f(10, 20), f(10.12, 20)], defaults).accepted, false);
  assert.equal(c.ocrSelectTemporal([f(10, 20), f(10.12, 30)], defaults).accepted, false);
  assert.equal(c.ocrSelectTemporal([f(10, 20), f(10, 20)], defaults).accepted, false);
  assert.equal(c.ocrSelectTemporal([f(10, 20), f(10.24, 20.12)], { ...defaults, rate: 2 }).accepted, true);
});

test('neighbor recovery retains the chosen neighbor timestamp and screenshot', () => {
  const { c } = harness();
  const frames = [
    { accepted: false, target: true, videoTime: 10, value: null },
    { accepted: true, videoTime: 9.88, value: 19.88, confidence: 0.9, frameDataUrl: 'neighbor-left' },
    { accepted: true, videoTime: 10.12, value: 20.12, confidence: 0.9, frameDataUrl: 'neighbor-right' },
  ];
  const selected = c.ocrSelectTemporal(frames, defaults);
  assert.equal(selected.accepted, true);
  assert.equal(selected.videoTime, 9.88);
  assert.equal(selected.frameDataUrl, 'neighbor-left');
});

test('global calibration isolates a large OCR error and cannot disregard manual anchors', () => {
  const { c } = harness();
  const points = [1, 2, 3, 4].map(n => ({ timerValue: n, videoTime: n + 2 }));
  points.push({ timerValue: 99, videoTime: 7 });
  assert.equal(c.ocrGlobalConsensus(points, defaults).length, 4);
  points[4].manual = true;
  assert.equal(c.ocrGlobalConsensus(points, defaults).length, 0);
  assert.equal(c.ocrGlobalConsensus(points.slice(0, 2), defaults).length, 0);
});

test('regression rejects stationary, reverse and inconsistent timers', () => {
  const { c, V, elements } = harness();
  assert.equal(c.ocrFit([{ timerValue: 1, videoTime: 1 }, { timerValue: 1, videoTime: 2 }]), null);
  assert.equal(c.ocrFit([{ timerValue: 2, videoTime: 1 }, { timerValue: 1, videoTime: 2 }]), null);
  V.a.pts = [{ timerValue: 1, videoTime: 3 }, { timerValue: 2, videoTime: 4 }, { timerValue: 3, videoTime: 6 }];
  c.updateRegression('a');
  assert.equal(V.a.reg, null);
  assert.equal(elements.get('build-a').disabled, true);
  V.a.pts[2].videoTime = 5;
  c.updateRegression('a');
  assert.equal(V.a.reg.a, 1);
  assert.equal(V.a.reg.maxResidual, 0);
});

test('five samples cover distinct time segments', () => {
  const { c, V } = harness();
  c.autoSample('a');
  assert.equal(V.a.pts.length, 5);
  const bins = V.a.pts.map(p => Math.floor((p.videoTime - 5) / 18));
  assert.deepEqual(Array.from(bins), [0, 1, 2, 3, 4]);
});

test('batch recognition accepts a consistent majority and leaves an outlier for review', async () => {
  const { c, V, OCR, controls } = harness();
  V.a.pts = [3, 4, 5, 6].map(videoTime => ({ videoTime, timerValue: '' }));
  c.ocrReadTimer = async (label, time) => ({ accepted: true, value: time === 6 ? 99 : time - 2,
    videoTime: time + 0.01, confidence: 0.9, timeSource: 'mediaTime', frameDataUrl: 'captured-' + time });
  await c.ocrRunSamples('a');
  assert.equal(V.a.pts[0].videoTime, 3.01);
  assert.equal(V.a.pts[0].timerValue, 1);
  assert.equal(V.a.pts[0].ocr.frameDataUrl, 'captured-3');
  assert.equal(V.a.pts[3].timerValue, '');
  assert.equal(V.a.pts[3].ocrReview.value, 99);
  assert.equal(OCR.reports.a.samples.filter(s => s.accepted).length, 3);
  assert.equal(OCR.busy, false);
  assert.equal(controls[0].disabled, false);
  assert.equal(controls[1].disabled, true);
});

test('re-running OCR clears a previously accepted automatic value when new checks fail', async () => {
  const { c, V } = harness();
  V.a.pts = [{ videoTime: 3, timerValue: 1, origin: 'ocr' }];
  c.ocrReadTimer = async () => ({ accepted: false, value: 9, videoTime: 3, reason: 'conflict' });
  await c.ocrRunSamples('a');
  assert.equal(V.a.pts[0].timerValue, '');
  assert.equal(V.a.pts[0].ocrReview.reason, 'conflict');
});

test('model switching separates traineddata caches and best uses uncompressed files', async () => {
  const { c, initialized } = harness();
  await c.ocrInit('standard');
  await c.ocrInit('best');
  assert.notEqual(initialized[0].options.cachePath, initialized[1].options.cachePath);
  assert.equal(initialized[1].options.gzip, false);
  assert.ok(initialized[1].options.langPath.endsWith('/tessdata_best/main'));
});

test('model comparison reuses identical captured frames and never replaces calibration', async () => {
  const { c, V, OCR } = harness();
  V.a.pts = [{ videoTime: 3, timerValue: 1, origin: 'manual' }];
  const before = JSON.stringify(V.a.pts), calls = [];
  c.ocrGrabFrame = async () => ({ canvas: canvas(), videoTime: 3, timeSource: 'mediaTime' });
  c.ocrRecognizeFrame = async (frame, settings) => {
    calls.push(frame);
    return { accepted: true, value: settings.model === 'best' ? 1 : 2, elapsedMs: 10 };
  };
  await c.ocrCompareModels('a');
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
  assert.equal(JSON.stringify(V.a.pts), before);
  assert.equal(OCR.reports.a.profiles[0].metrics.wrongAcceptedRate, 1);
  assert.equal(OCR.reports.a.profiles[1].metrics.exactRate, 1);
});

test('ROI changes invalidate automatic values and reports while preserving manual labels', () => {
  const { c, V, OCR } = harness();
  V.a.pts = [
    { videoTime: 3, timerValue: 1, origin: 'ocr', ocr: { frameDataUrl: 'old-crop' } },
    { videoTime: 4, timerValue: 2, origin: 'manual' },
  ];
  OCR.reports.a = { type: 'old-report' };
  c.ocrInvalidateROI('a');
  assert.equal(V.a.pts[0].timerValue, '');
  assert.equal(V.a.pts[0].ocr, null);
  assert.equal(V.a.pts[1].timerValue, 2);
  assert.equal(OCR.reports.a, undefined);
  assert.equal(V.a.reg, null);
});
