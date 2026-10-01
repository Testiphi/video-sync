// OCR settings and verification stay local to the browser.
function ocrEscape(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ocrGetSettings() {
  const value = (id, fallback) => document.getElementById(id)?.value ?? fallback;
  const bounded = (id, fallback, min, max) => {
    const raw = value(id, fallback);
    const number = String(raw).trim() ? Number(raw) : NaN;
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };
  return {
    format: value('ocr-format', 'minutes'),
    digits: Math.round(bounded('ocr-digits', 3, 0, 3)),
    model: value('ocr-model', 'standard'),
    minConfidence: bounded('ocr-confidence', 80, 0, 100) / 100,
    tolerance: bounded('ocr-tolerance', 50, 5, 1000) / 1000,
    rate: bounded('ocr-rate', 1, 0.05, 16),
  };
}

function ocrTolerance(settings) {
  return Math.max(settings.tolerance, 10 ** -settings.digits * settings.rate);
}

function ocrParseConfigured(text, settings) {
  const t = String(text ?? '').trim().replace(/\s+/g, '').replace(/：/g, ':');
  const fraction = settings.digits ? '\\.\\d{' + settings.digits + '}' : '';
  const minute = new RegExp('^\\d{1,2}:\\d{2}' + fraction + '$');
  const second = new RegExp('^\\d+' + fraction + '$');
  if (settings.format === 'minutes' && !minute.test(t)) return null;
  if (settings.format === 'seconds' && !second.test(t)) return null;
  if (settings.format === 'auto' && !minute.test(t) && !second.test(t)) return null;
  // Integers are safe only when the user explicitly selected whole total seconds.
  if (!settings.digits && settings.format === 'seconds') {
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return ocrParseTimer(t);
}

function ocrCropGeometry(roi, vw, vh) {
  if (![roi.x, roi.y, roi.w, roi.h, vw, vh].every(Number.isFinite) || roi.w <= 0 || roi.h <= 0) {
    throw new Error('计时器选区无效');
  }
  const x = Math.max(0, roi.x / 100 * vw), y = Math.max(0, roi.y / 100 * vh);
  const w = Math.min((roi.x + roi.w) / 100 * vw, vw) - x;
  const h = Math.min((roi.y + roi.h) / 100 * vh, vh) - y;
  if (w < 2 || h < 2) throw new Error('计时器选区过小或超出画面');
  const scale = Math.min(Math.max(1, Math.min(4, 96 / h)), 1280 / w, 512 / h);
  return { x, y, w, h, width: Math.max(2, Math.round(w * scale)), height: Math.max(2, Math.round(h * scale)) };
}

function ocrOtsu(histogram, total) {
  let sum = 0, lowerSum = 0, lowerCount = 0, maxVariance = -1, threshold = 127;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  for (let i = 0; i < 255; i++) {
    lowerCount += histogram[i];
    lowerSum += i * histogram[i];
    const upperCount = total - lowerCount;
    if (!lowerCount || !upperCount) continue;
    const difference = lowerSum / lowerCount - (sum - lowerSum) / upperCount;
    const variance = lowerCount * upperCount * difference * difference;
    if (variance > maxVariance) { maxVariance = variance; threshold = i; }
  }
  return threshold;
}

function ocrImageVariants(canvas) {
  const w = canvas.width, h = canvas.height, padding = 10;
  const pixels = canvas.getContext('2d').getImageData(0, 0, w, h);
  const gray = new Uint8Array(w * h), histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(0.299 * pixels.data[i * 4] + 0.587 * pixels.data[i * 4 + 1] + 0.114 * pixels.data[i * 4 + 2]);
    histogram[gray[i]]++;
  }
  function percentile(fraction) {
    let count = 0;
    for (let i = 0; i < 256; i++) {
      count += histogram[i];
      if (count >= gray.length * fraction) return i;
    }
    return 255;
  }
  const low = percentile(0.02), high = percentile(0.98), threshold = ocrOtsu(histogram, gray.length);
  const variants = [];
  for (const mode of ['original', 'gray', 'binary', 'inverted']) {
    const c = document.createElement('canvas');
    c.width = w + padding * 2; c.height = h + padding * 2;
    const ctx = c.getContext('2d');
    const image = ctx.createImageData(w, h);
    for (let i = 0; i < gray.length; i++) {
      let v = gray[i];
      if (mode === 'gray') v = high > low ? Math.max(0, Math.min(255, Math.round((v - low) * 255 / (high - low)))) : v;
      if (mode === 'binary' || mode === 'inverted') v = v > threshold ? 255 : 0;
      if (mode === 'inverted') v = 255 - v;
      for (let ch = 0; ch < 3; ch++) image.data[i * 4 + ch] = mode === 'original' ? pixels.data[i * 4 + ch] : v;
      image.data[i * 4 + 3] = 255;
    }
    const edge = image.data[0];
    ctx.fillStyle = mode === 'original' ? `rgb(${pixels.data[0]},${pixels.data[1]},${pixels.data[2]})` : `rgb(${edge},${edge},${edge})`;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.putImageData(image, padding, padding);
    variants.push({ name: mode, canvas: c });
  }
  return variants;
}

function ocrSelectCandidates(trials, settings) {
  const groups = new Map();
  for (const trial of trials) {
    if (trial.value == null || trial.confidence < settings.minConfidence) continue;
    const key = trial.value.toFixed(settings.digits);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trial);
  }
  const ranked = [...groups.values()].sort((a, b) => b.length - a.length || b[0].confidence - a[0].confidence);
  const top = ranked[0];
  if (!top) return { accepted: false, value: null, confidence: 0, reason: '格式不符或置信度不足' };
  const selected = { value: top[0].value, confidence: Math.min(...top.map(t => t.confidence)) };
  if (ranked.length > 1) return { ...selected, accepted: false, reason: '不同识别方式给出冲突数值' };
  if (top.length < 2) return { ...selected, accepted: false, reason: '缺少第二种识别方式确认' };
  return { ...selected, accepted: true, reason: '', votes: top.length };
}

async function ocrRecognizeFrame(frame, settings) {
  const started = performance.now(), variants = ocrImageVariants(frame.canvas);
  const trials = [], schedule = [[0, 7], [1, 7], [2, 7], [3, 7], [1, 8], [3, 13]];
  let selected;
  for (const [variant, psm] of schedule) {
    const { data } = await OCR.worker.recognize(variants[variant].canvas, {
      tessedit_pageseg_mode: String(psm), tessedit_char_whitelist: '0123456789.:',
    }, { text: true, blocks: true, hocr: false, tsv: false });
    const text = (data.text || '').trim();
    const scores = [data.confidence, ...(data.words || []).map(word => word.confidence)].map(Number);
    const confidence = scores.every(Number.isFinite) ? Math.max(0, Math.min(100, ...scores)) / 100 : 0;
    trials.push({ text, confidence, value: ocrParseConfigured(text, settings), variant: variants[variant].name, psm });
    selected = ocrSelectCandidates(trials, settings);
    if (selected.accepted) break;
  }
  return { ...selected, trials, videoTime: frame.videoTime, timeSource: frame.timeSource,
    frameDataUrl: frame.canvas.toDataURL(), elapsedMs: performance.now() - started };
}

function ocrSelectTemporal(frames, settings) {
  const valid = frames.filter(f => f.accepted && Number.isFinite(f.videoTime));
  const tolerance = ocrTolerance(settings);
  const groups = valid.map(anchor => valid.filter(frame => {
    const dt = frame.videoTime - anchor.videoTime, dv = frame.value - anchor.value;
    return Math.abs(dt - dv * settings.rate) <= tolerance && (Math.abs(dt) < 0.000001 || dt * dv > 0);
  })).sort((a, b) => b.length - a.length);
  const best = groups[0] || [];
  const unique = [...new Set(best.map(f => f.videoTime.toFixed(6)))];
  if (unique.length < 2 || best.length !== valid.length) {
    const suggestion = [...frames].filter(f => f.value != null).sort((a, b) => b.confidence - a.confidence)[0];
    return { ...(suggestion || {}), accepted: false, reason: '相邻帧不一致、计时器暂停或有效帧不足', frames };
  }
  const target = frames.find(f => f.target)?.videoTime ?? best[0].videoTime;
  const representative = [...best].sort((a, b) => Math.abs(a.videoTime - target) - Math.abs(b.videoTime - target))[0];
  return { ...representative, accepted: true, reason: '', frames };
}

async function ocrReadTimer(label, time, settings) {
  const started = performance.now(), frames = [];
  const duration = V[label].duration || document.getElementById('vid-' + label).duration;
  const span = Math.max(0.12, 10 ** -settings.digits * settings.rate * 1.25, settings.tolerance * 3);
  const times = [...new Set([time, time - span, time + span].map(t => Math.max(0, Math.min(duration - 0.001, t))))];
  for (let i = 0; i < times.length; i++) {
    try {
      const frame = await ocrGrabFrame(label, times[i]);
      if (!frame) throw new Error('帧捕获失败');
      frames.push({ ...await ocrRecognizeFrame(frame, settings), target: i === 0 });
    } catch (error) {
      frames.push({ accepted: false, value: null, confidence: 0, reason: error.message, target: i === 0 });
    }
  }
  return { ...ocrSelectTemporal(frames, settings), elapsedMs: performance.now() - started };
}

function ocrMedian(values) {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function ocrFit(points) {
  const pts = points.filter(p => Number.isFinite(Number(p.timerValue)) && p.timerValue !== '' && Number.isFinite(p.videoTime));
  const slopes = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const delta = Number(pts[j].timerValue) - Number(pts[i].timerValue);
    if (Math.abs(delta) > 0.0001) slopes.push((pts[j].videoTime - pts[i].videoTime) / delta);
  }
  if (!slopes.length) return null;
  const a = ocrMedian(slopes);
  if (!Number.isFinite(a) || a <= 0) return null;
  const b = ocrMedian(pts.map(p => p.videoTime - a * Number(p.timerValue)));
  const residuals = pts.map(p => Math.abs(p.videoTime - a * Number(p.timerValue) - b));
  const mean = pts.reduce((sum, p) => sum + p.videoTime, 0) / pts.length;
  const sst = pts.reduce((sum, p) => sum + (p.videoTime - mean) ** 2, 0);
  const ssr = residuals.reduce((sum, r) => sum + r * r, 0);
  return { a, b, r2: sst ? Math.max(0, 1 - ssr / sst) : 0,
    maxResidual: Math.max(...residuals), medianResidual: ocrMedian(residuals) };
}

function ocrGlobalConsensus(points, settings) {
  const tolerance = ocrTolerance(settings), hypotheses = [];
  const manual = points.filter(p => p.manual);
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const dx = points[j].timerValue - points[i].timerValue;
    if (Math.abs(dx) < 0.0001) continue;
    const a = (points[j].videoTime - points[i].videoTime) / dx;
    if (a <= 0 || Math.abs(a / settings.rate - 1) > 0.2) continue;
    const b = points[i].videoTime - a * points[i].timerValue;
    const inliers = points.filter(p => Math.abs(p.videoTime - a * p.timerValue - b) <= tolerance);
    if (inliers.length < 3 || manual.some(p => !inliers.includes(p))) continue;
    const fit = ocrFit(inliers);
    if (!fit || fit.maxResidual > tolerance) continue;
    hypotheses.push({ inliers, fit });
  }
  hypotheses.sort((a, b) => b.inliers.length - a.inliers.length || a.fit.maxResidual - b.fit.maxResidual);
  if (!hypotheses.length) return [];
  const best = hypotheses[0];
  if (hypotheses.some(h => h.inliers.length === best.inliers.length && h.inliers.some(p => !best.inliers.includes(p)))) return [];
  return best.inliers;
}

function ocrConfirmPoint(label, index) {
  if (OCR.busy) return;
  const point = V[label].pts[index];
  if (point.ocrReview?.value != null) {
    point.timerValue = point.ocrReview.value;
    point.videoTime = point.ocrReview.videoTime;
  }
  if (point.timerValue === '' || !Number.isFinite(Number(point.timerValue))) return;
  point.origin = 'manual';
  point.ocrReview = null;
  renderCalTable(label);
  updateRegression(label);
}

function ocrInvalidateROI(label) {
  delete OCR.reports[label];
  for (const point of V[label].pts) {
    if (point.origin === 'ocr') { point.timerValue = ''; point.origin = null; }
    point.ocr = null;
    point.ocrReview = null;
  }
  renderCalTable(label);
  updateRegression(label);
}

function ocrSetBusy(busy) {
  OCR.busy = busy;
  // Freeze calibration/loading controls while OCR owns the video and worker.
  if (busy) {
    OCR.disabledControls = [...document.querySelectorAll('button,input,select')].map(element => [element, element.disabled]);
    for (const [element] of OCR.disabledControls) element.disabled = true;
    OCR.pausedVideos = [...document.querySelectorAll('video')];
    for (const video of OCR.pausedVideos) video.pause();
    pauseSyncPlayback();
  } else {
    for (const [element, disabled] of OCR.disabledControls || []) element.disabled = disabled;
    OCR.disabledControls = [];
  }
}

async function ocrRunSamples(label) {
  const state = V[label], status = document.getElementById('ocr-status-' + label);
  if (OCR.busy) return;
  if (!state.loaded || !state.roi || !state.pts.length) { alert('请先加载视频、框选计时器并采样'); return; }
  const settings = ocrGetSettings(), started = performance.now(), results = [];
  ocrSetBusy(true);
  try {
    status.textContent = '正在加载识别模型…';
    if (!await ocrInit(settings.model)) throw new Error('识别模型加载失败');
    const points = [...state.pts];
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      if (point.timerValue !== '' && point.timerValue != null && point.origin !== 'ocr') continue;
      status.textContent = `正在检查第 ${i + 1}/${points.length} 个采样点（包含邻近帧）…`;
      const result = await ocrReadTimer(label, point.videoTime, settings);
      results.push({ point, result, requestedTime: point.videoTime });
    }
    const anchors = points.filter(p => p.timerValue !== '' && p.timerValue != null && p.origin !== 'ocr')
      .map(p => ({ point: p, timerValue: Number(p.timerValue), videoTime: p.videoTime, manual: p.origin !== 'ocr' }));
    const candidates = results.filter(r => r.result.accepted).map(r => ({ point: r.point,
      timerValue: r.result.value, videoTime: r.result.videoTime, manual: false }));
    const inliers = ocrGlobalConsensus([...anchors, ...candidates], settings);
    let accepted = 0;
    for (const entry of results) {
      const { point, result } = entry;
      point.ocr = result;
      if (result.frameDataUrl && Number.isFinite(result.videoTime)) point.videoTime = result.videoTime;
      const candidate = candidates.find(c => c.point === point);
      if (result.accepted && inliers.includes(candidate)) {
        point.videoTime = result.videoTime;
        point.timerValue = result.value;
        point.ocrTimeSource = result.timeSource;
        point.origin = 'ocr';
        point.ocrReview = null;
        entry.accepted = true;
        accepted++;
      } else {
        const review = { ...result, reason: result.accepted ? '全局校准不一致或不足三个有效点' : result.reason };
        point.ocrReview = review;
        point.timerValue = '';
        point.origin = null;
        entry.accepted = false;
        entry.reason = review.reason;
      }
    }
    OCR.reports[label] = { type: 'recognition', settings, elapsedMs: performance.now() - started,
      samples: results.map(({ point, ...entry }) => ({ ...entry, originalIndex: points.indexOf(point) })) };
    renderCalTable(label);
    status.textContent = `完成：自动接受 ${accepted} 个，待确认 ${results.length - accepted} 个；请检查预览和校准误差。`;
  } catch (error) {
    status.textContent = '识别失败：' + error.message;
  } finally {
    ocrSetBusy(false);
    updateRegression(label);
  }
}

function ocrBenchmarkMetrics(rows, settings) {
  const valid = rows.filter(r => r.prediction.accepted && r.prediction.value != null);
  const quantum = 10 ** -settings.digits;
  const exact = valid.filter(r => Math.abs(r.prediction.value - r.reference) < quantum / 2);
  const errors = valid.map(r => Math.abs(r.prediction.value - r.reference) * settings.rate);
  return { samples: rows.length, accepted: valid.length, exact: exact.length,
    exactRate: rows.length ? exact.length / rows.length : null,
    wrongAcceptedRate: valid.length ? (valid.length - exact.length) / valid.length : null,
    maxVideoError: errors.length ? Math.max(...errors) : null,
    meanVideoError: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null,
    meanRecognitionMs: rows.length ? rows.reduce((sum, row) => sum + row.prediction.elapsedMs, 0) / rows.length : null };
}

async function ocrCompareModels(label) {
  if (OCR.busy) return;
  const state = V[label], status = document.getElementById('ocr-status-' + label);
  const references = state.pts.filter(p => p.origin === 'manual' && p.timerValue !== '' && Number.isFinite(Number(p.timerValue)));
  if (!state.loaded || !state.roi || !references.length) { alert('请先手动填写或确认至少一个采样点，作为模型比较的真实标注'); return; }
  const settings = ocrGetSettings(), frames = [], profiles = [];
  ocrSetBusy(true);
  try {
    status.textContent = '正在准备同一组标注画面…';
    for (const point of references) {
      // Reuse the exact image the user reviewed when it is available.
      let frame;
      if (point.ocr?.frameDataUrl && point.ocr.videoTime === point.videoTime) {
        const image = new Image();
        image.src = point.ocr.frameDataUrl;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        frame = { canvas, videoTime: point.videoTime, timeSource: point.ocr.timeSource };
      } else frame = await ocrGrabFrame(label, point.videoTime);
      if (!frame) throw new Error('标注帧捕获失败');
      // A reference belongs to its annotated timestamp; never silently label another frame.
      if (Math.abs(frame.videoTime - point.videoTime) > 0.000001) {
        throw new Error('标注时间与实际帧时间不同，请点击预览后重新添加并确认标注');
      }
      frames.push({ frame, reference: Number(point.timerValue) });
    }
    for (const profile of ['standard', 'best']) {
      status.textContent = `正在比较${profile === 'best' ? '精度优先' : '标准'}模型…`;
      const initStart = performance.now();
      if (!await ocrInit(profile)) throw new Error('模型加载失败：' + profile);
      const initMs = performance.now() - initStart, rows = [];
      for (const { frame, reference } of frames) rows.push({ reference, videoTime: frame.videoTime,
        timeSource: frame.timeSource, prediction: await ocrRecognizeFrame(frame, { ...settings, model: profile }) });
      profiles.push({ profile, initMs, metrics: ocrBenchmarkMetrics(rows, settings), rows });
    }
    OCR.reports[label] = { type: 'model-comparison', settings, profiles };
    status.textContent = profiles.map(p => `${p.profile === 'best' ? '精度优先' : '标准'}：${p.metrics.exact}/${p.metrics.samples} 完整值正确，平均 ${Math.round(p.metrics.meanRecognitionMs)}ms`).join('；') + '。可导出详细报告。';
  } catch (error) { status.textContent = '模型比较失败：' + error.message; }
  finally { ocrSetBusy(false); updateRegression(label); }
}

function ocrExportReport(label) {
  const report = OCR.reports[label];
  if (!report) { alert('请先运行识别或模型比较'); return; }
  const data = { version: 1, exportedAt: new Date().toISOString(), video: label,
    ...report, calibration: V[label].pts.map(p => ({ videoTime: p.videoTime, timerValue: p.timerValue,
      origin: p.origin || 'manual', needsReview: !!p.ocrReview })), fit: V[label].reg };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = `framesync-ocr-${label}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

for (const id of ['ocr-format', 'ocr-digits', 'ocr-confidence', 'ocr-tolerance', 'ocr-rate']) {
  document.getElementById(id)?.addEventListener('change', () => {
    if (!OCR.busy) for (const label of ['a', 'b']) updateRegression(label);
  });
}
