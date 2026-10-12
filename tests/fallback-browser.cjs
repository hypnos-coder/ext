// Real MV3/offscreen integration: no speech APIs, voices, events, or audio are mocked.
// A temporary copy receives access only to the localhost fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sona-offline-browser-'));
let context;
let server;
let cdp;
let offscreenSession;
let nextRequestId = 0;
const errors = [];

function getPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_PATH, 'playwright', 'playwright-core',
    '/home/amen/.cache/ms-playwright-go/1.57.0/package/index.js'].filter(Boolean);
  for (const candidate of candidates) {
    try { return require(candidate); } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Install Playwright or set PLAYWRIGHT_PATH to run browser checks.');
}

async function send(page, message) {
  const response = await page.evaluate((value) => chrome.runtime.sendMessage(value), message);
  if (response?.error) throw new Error(response.error);
  return response;
}

async function waitState(page, predicate, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let state;
  while (Date.now() < deadline) {
    state = (await send(page, { type: 'GET_STATE' })).state;
    if (predicate(state)) return state;
    if (state.status === 'error') throw new Error(`Playback failed: ${state.error}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for playback: ${JSON.stringify(state)}`);
}

// Playwright does not expose hidden offscreen documents as pages. CDP lets us
// inspect their real HTMLAudioElement without altering the playback engine.
async function inspectOffscreen(expression) {
  if (!offscreenSession) {
    cdp = await context.browser().newBrowserCDPSession();
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find((value) => value.url.endsWith('/offscreen.html'));
    assert.ok(target, 'The extension must have created an offscreen document.');
    ({ sessionId: offscreenSession } = await cdp.send('Target.attachToTarget', {
      targetId: target.targetId, flatten: false,
    }));
  }
  const id = ++nextRequestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', listener); reject(new Error('Offscreen inspection timed out.')); }, 10000);
    const listener = (event) => {
      if (event.sessionId !== offscreenSession) return;
      const response = JSON.parse(event.message);
      if (response.id !== id) return;
      clearTimeout(timeout);
      cdp.off('Target.receivedMessageFromTarget', listener);
      if (response.error || response.result?.exceptionDetails) reject(new Error(JSON.stringify(response.error || response.result.exceptionDetails)));
      else resolve(response.result.result.value);
    };
    cdp.on('Target.receivedMessageFromTarget', listener);
    cdp.send('Target.sendMessageToTarget', { sessionId: offscreenSession,
      message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })
    }).catch((error) => { clearTimeout(timeout); cdp.off('Target.receivedMessageFromTarget', listener); reject(error); });
  });
}

async function audioState() {
  return inspectOffscreen(`(() => {
    const element = document.querySelector('audio');
    if (!element) throw new Error('No offscreen audio element found.');
    return { paused: element.paused, ended: element.ended, currentTime: element.currentTime,
      duration: Number.isFinite(element.duration) ? element.duration : null,
      playbackRate: element.playbackRate, readyState: element.readyState, src: element.currentSrc || element.src };
  })()`);
}

async function waitAudio(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let state;
  while (Date.now() < deadline) {
    state = await audioState();
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for real audio: ${JSON.stringify(state)}`);
}

async function waitHighlight(article, expected) {
  await article.waitForFunction((expected) => {
    const ranges = CSS.highlights?.get('sona-current-sentence');
    return (ranges ? [...ranges].map((range) => range.toString()).join('') : '').replace(/\s+/gu, ' ').trim() === expected.replace(/\s+/gu, ' ').trim();
  }, expected);
}

async function run() {
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html lang="en"><title>Offline reading fixture</title><body><article><p>Offline voices work without a system voice. Listening keeps your place after closing the reader.</p></article></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const extension = path.join(scratch, 'extension');
  fs.cpSync(root, extension, { recursive: true,
    filter: (source) => !['.git', '.agents', '.codex', '.aws', 'node_modules', 'tests'].includes(path.relative(root, source).split(path.sep)[0]) });
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [`${origin}/*`];
  fs.writeFileSync(path.join(extension, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const knownChromium = '/home/amen/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  context = await getPlaywright().chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    executablePath: process.env.CHROME_PATH || (fs.existsSync(knownChromium) ? knownChromium : undefined),
    headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(20000);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const nativeVoices = await worker.evaluate(() => chrome.tts.getVoices());
  const article = await context.newPage();
  await article.goto(`${origin}/article.html`);
  const webVoices = await article.evaluate(() => speechSynthesis.getVoices().map((voice) => voice.name));
  console.log(`INFO: actual browser has ${nativeVoices.length} Chrome TTS and ${webVoices.length} Web Speech voices.`);
  const popup = await context.newPage();
  popup.on('pageerror', (error) => errors.push(error.message));
  await popup.setViewportSize({ width: 412, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#voice-select').waitFor();
  const response = await send(popup, { type: 'GET_VOICES' });
  const voice = response.voices.find((value) => value.engine === 'offline');
  assert.ok(voice, 'Bundled offline voice must be available even with no system voices.');
  await popup.waitForFunction((name) => [...document.querySelector('#voice-select').options].some((option) => option.value === name), voice.voiceName);
  await popup.locator('#voice-select').selectOption(voice.voiceName);
  const tabId = await popup.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, `${origin}/article.html`);
  assert.ok(Number.isInteger(tabId));
  await article.bringToFront();
  await popup.locator('#load-page').click();
  await popup.waitForFunction(() => document.querySelector('#text-input').value.startsWith('Offline voices'));
  assert.equal(await popup.locator('#voice-badge').innerText(), 'BUNDLED');
  const artifactDirectory = process.env.SONA_ARTIFACT_DIR || path.join(os.tmpdir(), 'sona-browser-artifacts');
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const popupHeight = await popup.locator('main').evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(popupHeight <= 600, `Bundled voice popup content is ${popupHeight}px tall, exceeding Chrome's 600px limit.`);
  await popup.screenshot({ path: path.join(artifactDirectory, 'fallback-popup.png') });
  await popup.locator('#play-button').click();
  const playing = await waitState(popup, (state) => state.status === 'playing');
  assert.equal(playing.source.tabId, tabId);
  assert.equal(playing.voice.engine, 'offline');
  await waitHighlight(article, playing.source.text.slice(playing.segmentStart, playing.segmentEnd));
  const firstAudio = await waitAudio((audio) => !audio.paused && audio.duration > 0 && audio.currentTime > 0.02);
  assert.ok(firstAudio.src.startsWith('blob:'), 'Playback must use a locally synthesized audio blob.');
  const wave = await inspectOffscreen(`(async () => {
    const buffer = await (await fetch(document.querySelector('audio').currentSrc)).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const samples = new DataView(buffer);
    let energy = 0; let count = 0;
    for (let index = 44; index + 1 < bytes.length; index += 2) { energy += samples.getInt16(index, true) ** 2; count += 1; }
    return { bytes: bytes.length, magic: new TextDecoder().decode(bytes.slice(0, 4)),
      format: new TextDecoder().decode(bytes.slice(8, 12)), rms: Math.sqrt(energy / Math.max(1, count)) };
  })()`);
  assert.ok(wave.bytes > 44);
  assert.equal(wave.magic, 'RIFF');
  assert.equal(wave.format, 'WAVE');
  assert.ok(wave.rms > 0, 'Generated speech must contain nonzero audio samples.');
  console.log(`PASS: bundled voice synthesizes ${wave.bytes} real WAV bytes and plays with default Chrome autoplay policy.`);

  await popup.locator('#play-button').click();
  await waitState(popup, (state) => state.status === 'paused');
  const paused = await waitAudio((audio) => audio.paused);
  await new Promise((resolve) => setTimeout(resolve, 180));
  const stillPaused = await audioState();
  assert.ok(Math.abs(stillPaused.currentTime - paused.currentTime) < 0.05, 'Paused audio time must stay still.');
  await popup.locator('#play-button').click();
  await waitState(popup, (state) => state.status === 'playing');
  await waitAudio((audio) => !audio.paused && audio.currentTime > paused.currentTime + 0.05);
  console.log('PASS: pause stops real audio time; resume advances it again.');

  await popup.close();
  const inspector = await context.newPage();
  await inspector.goto(`chrome-extension://${extensionId}/popup.html`);
  inspector.on('pageerror', (error) => errors.push(error.message));
  // Close every popup while the hidden document and source-page controls remain.
  const current = await waitState(inspector, (state) => state.status === 'playing');
  await inspector.close();
  await article.waitForFunction(() => {
    const host = document.querySelector('[data-sona-reader="panel"]');
    return host && !host.hidden;
  });
  await article.getByRole('button', { name: 'Pause', exact: true }).click();
  await waitAudio((audio) => audio.paused);
  await article.getByRole('button', { name: 'Resume', exact: true }).click();
  await waitAudio((audio) => !audio.paused);
  await waitHighlight(article, 'Listening keeps your place after closing the reader.');
  const completed = await context.newPage();
  await completed.goto(`chrome-extension://${extensionId}/popup.html`);
  await waitState(completed, (state) => state.status === 'finished', 30000);
  await article.waitForFunction(() => !CSS.highlights?.has('sona-current-sentence'));
  assert.ok(current.source.text.length > 0);
  console.log('PASS: audio survives popup close; page pause/resume works; every sentence completes and highlighting clears.');

  await completed.locator('#paste-mode').click();
  await completed.locator('#text-input').fill('Stop this locally generated speech before the sentence finishes.');
  await completed.locator('#play-button').click();
  await waitState(completed, (state) => state.status === 'playing');
  await waitAudio((audio) => !audio.paused && audio.currentTime > 0.02);
  await completed.locator('#stop-button').click();
  await waitState(completed, (state) => state.status === 'idle');
  await waitAudio((audio) => audio.paused);
  assert.deepEqual(errors, [], 'Popup emitted an uncaught error.');
  console.log('PASS: stop ends real bundled audio; no uncaught popup errors.');
  console.log('NOTE: WAV generation and browser playback timing are verified; physical speaker output is not available to automation.');
}

run().catch((error) => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  await cdp?.detach().catch(() => {});
  await context?.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
});
