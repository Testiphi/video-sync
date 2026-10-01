const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const helpers = fs.readFileSync(path.join(__dirname, '..', 'ocr.js'), 'utf8');
const functions = ['ocrParseTimer', 'ocrGrabFrame']
  .map(name => {
    const source = html.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
    assert.ok(source, name + ' must exist');
    return source[0];
  }).join('\n') + '\n' + helpers.match(/function ocrCropGeometry\([^)]*\) \{[\s\S]*?\n\}/)[0];

function harness({ frameAPI = true, initialTime = 0, seek } = {}) {
  let currentTime = initialTime, nextId = 0;
  const events = new Map(), callbacks = new Map(), timers = new Map();
  const draws = [], recognized = [];
  const video = {
    src: 'local-video', duration: 10, readyState: 2,
    videoWidth: 1920, videoHeight: 1080, seeking: false,
    pause() {},
    get currentTime() { return currentTime; },
    set currentTime(value) {
      currentTime = value;
      this.seeking = true;
      if (seek) seek(this, emit, emitFrame);
      else { this.seeking = false; emit('seeked'); emitFrame(value - 0.01); }
    },
    addEventListener(name, fn) {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(fn);
    },
    removeEventListener(name, fn) { events.get(name)?.delete(fn); },
  };
  function emit(name) { for (const fn of [...(events.get(name) || [])]) fn(); }
  function emitFrame(mediaTime) {
    for (const [id, fn] of [...callbacks]) {
      callbacks.delete(id);
      fn(0, { mediaTime });
    }
  }
  if (frameAPI) {
    video.requestVideoFrameCallback = fn => { const id = ++nextId; callbacks.set(id, fn); return id; };
    video.cancelVideoFrameCallback = id => callbacks.delete(id);
  }
  const point = { videoTime: 1, timerValue: '' };
  const preview = {}, button = {}, status = {};
  const state = { loaded: true, roi: { x: 80, y: 8, w: 16, h: 14 }, pts: [point] };
  const context = vm.createContext({
    V: { a: state },
    OCR: { debug: false, worker: { async recognize(canvas) {
      recognized.push(canvas);
      return { data: { text: recognized.length === 1 ? '' : '00:01.050', confidence: 90 } };
    } } },
    document: {
      getElementById(id) {
        return { 'vid-a': video, 'ocr-btn-a': button, 'ocr-status-a': status,
          'cal-preview-img-a-0': preview }[id] || null;
      },
      createElement(type) {
        assert.equal(type, 'canvas');
        return { getContext() { return { drawImage() { draws.push(currentTime); } }; },
          toDataURL() { return 'data:captured-' + draws.length; } };
      },
    },
    setTimeout(fn, ms) {
      const id = ++nextId;
      if (ms === 2000) timers.set(id, fn); else queueMicrotask(fn);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    ocrInit: async () => true,
    drawOneCalPreview() { throw new Error('Successful OCR must reuse its own screenshot'); },
    updateRegression() {}, buildIndex() {},
  });
  vm.runInContext(functions, context);
  return { context, video, point, preview, status, draws, recognized, events, callbacks, timers,
    timeout() { for (const fn of [...timers.values()]) fn(); } };
}

function assertClean(h) {
  assert.equal(h.timers.size, 0);
  assert.equal(h.callbacks.size, 0);
  for (const listeners of h.events.values()) assert.equal(listeners.size, 0);
}

test('frame timestamp is preserved when seeked precedes the frame callback', async () => {
  const h = harness();
  const frame = await h.context.ocrGrabFrame('a', 1);
  assert.equal(frame.videoTime, 0.99);
  assert.equal(frame.timeSource, 'mediaTime');
  assert.deepEqual(h.draws, [1]);
  assertClean(h);
});

test('frame callback before seeked is captured and awaits seek completion', async () => {
  const h = harness({ seek(video, emit, emitFrame) {
    video.seeking = false;
    emitFrame(0.99);
    emit('seeked');
  } });
  assert.equal((await h.context.ocrGrabFrame('a', 1)).videoTime, 0.99);
  assert.deepEqual(h.draws, [1]);
  assertClean(h);
});

test('seek timeout rejects without capturing stale pixels and releases listeners', async () => {
  const h = harness({ seek() {} });
  const promise = h.context.ocrGrabFrame('a', 1);
  h.timeout();
  await assert.rejects(promise, /帧捕获超时/);
  assert.equal(h.draws.length, 0);
  assertClean(h);
});

test('new frame submitted while seeking is saved until seeked clears the flag', async () => {
  const h = harness({ seek(video, emit, emitFrame) {
    emitFrame(0.99);
    video.seeking = false;
    emit('seeked');
  } });
  const frame = await h.context.ocrGrabFrame('a', 1);
  assert.equal(frame.videoTime, 0.99);
  assert.deepEqual(h.draws, [1]);
  assertClean(h);
});

test('missing frame callback after seeked is also a failure', async () => {
  const h = harness({ seek(video, emit) { video.seeking = false; emit('seeked'); } });
  const promise = h.context.ocrGrabFrame('a', 1);
  h.timeout();
  await assert.rejects(promise, /帧捕获超时/);
  assert.equal(h.draws.length, 0);
  assertClean(h);
});

test('unsupported frame API uses the completed seek time', async () => {
  const h = harness({ frameAPI: false });
  const frame = await h.context.ocrGrabFrame('a', 1);
  assert.equal(frame.videoTime, 1);
  assert.equal(frame.timeSource, 'currentTime');
  assertClean(h);
});

test('already paused at the target captures without waiting for a new frame', async () => {
  const h = harness({ initialTime: 1, seek() { throw new Error('Unexpected seek'); } });
  const frame = await h.context.ocrGrabFrame('a', 1);
  assert.equal(frame.videoTime, 1);
  assert.equal(frame.timeSource, 'currentTime');
  assertClean(h);
});

test('a decoding error rejects and releases pending callbacks', async () => {
  const h = harness({ seek(video, emit) { emit('error'); } });
  await assert.rejects(h.context.ocrGrabFrame('a', 1), /视频解码失败/);
  assert.equal(h.draws.length, 0);
  assertClean(h);
});
