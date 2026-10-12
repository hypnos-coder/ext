// Real MV3/browser coverage. Playback uses a TTS double and a local test voice:
// headless Linux often has no speech voices or audio device.
// A temporary extension copy gets localhost-only access because opening a popup
// URL from automation does not grant Chrome's user-gesture activeTab permission.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sona-browser-smoke-'));
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/article.html'));
const contexts = [];
const failures = [];
let server;

function getPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    'playwright-core',
    '/home/amen/.cache/ms-playwright-go/1.57.0/package/index.js',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { return require(candidate); } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Install Playwright or set PLAYWRIGHT_PATH to its module path to run browser checks.');
}

async function launch(extensionDirectory, label) {
  const { chromium } = getPlaywright();
  const knownChromium = '/home/amen/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  const executablePath = process.env.CHROME_PATH
    || (fs.existsSync(knownChromium) ? knownChromium : undefined);
  const context = await chromium.launchPersistentContext(path.join(scratch, label), {
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  contexts.push(context);
  context.setDefaultTimeout(10000);
  const worker = context.serviceWorkers()[0]
    || await context.waitForEvent('serviceworker', { timeout: 10000 });
  assert.match(worker.url(), /^chrome-extension:\/\/[^/]+\/background\.js$/);
  const extensionId = new URL(worker.url()).host;
  return { context, worker, extensionId };
}

function send(extensionPage, message) {
  return extensionPage.evaluate(async (message) => {
    const response = await chrome.runtime.sendMessage(message);
    if (response?.error) throw new Error(response.error);
    return response;
  }, message);
}

async function getState(extensionPage) {
  const response = await send(extensionPage, { type: 'GET_STATE' });
  return response.state;
}

async function waitState(extensionPage, predicate) {
  const deadline = Date.now() + 10000;
  let state;
  while (Date.now() < deadline) {
    state = await getState(extensionPage);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for playback state: ${JSON.stringify(state)}`);
}

async function installTtsDouble(worker) {
  await worker.evaluate(() => {
    chrome.tts.getVoices = (callback) => {
      const voices = [{ voiceName: 'Sona deterministic test voice', lang: 'en-US', remote: false,
        eventTypes: ['start', 'word', 'end', 'error', 'pause', 'resume'] }];
      if (callback) callback(voices);
      else return Promise.resolve(voices);
    };
    globalThis.__readerTtsTest = { current: null, spoken: [], stopped: 0 };
    chrome.tts.speak = (text, options, callback) => {
      const current = { text, options };
      __readerTtsTest.current = current;
      __readerTtsTest.spoken.push({ text, rate: options.rate, voiceName: options.voiceName });
      if (callback) callback();
      queueMicrotask(() => current.options.onEvent?.({ type: 'start', charIndex: 0 }));
    };
    chrome.tts.stop = () => {
      __readerTtsTest.stopped += 1;
      __readerTtsTest.current = null;
    };
    chrome.tts.pause = () => {
      __readerTtsTest.current?.options.onEvent?.({ type: 'pause' });
    };
    chrome.tts.resume = () => {
      __readerTtsTest.current?.options.onEvent?.({ type: 'resume' });
    };
  });
}

async function emitTts(worker, event) {
  return worker.evaluate((event) => {
    if (!__readerTtsTest.current) throw new Error('No utterance is active in the TTS test double.');
    const text = __readerTtsTest.current.text;
    __readerTtsTest.current.options.onEvent?.(event);
    return text;
  }, event);
}

async function loadContent(extensionPage, tabId) {
  return extensionPage.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, { type: 'READ_PAGE' });
  }, tabId);
}

async function highlightText(article) {
  return article.evaluate(() => {
    const highlight = CSS.highlights?.get('sona-current-sentence');
    return highlight ? [...highlight].map((range) => range.toString()).join('') : '';
  });
}

function normalize(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

async function waitHighlight(article, expected) {
  await article.waitForFunction((expected) => {
    const highlight = CSS.highlights?.get('sona-current-sentence');
    const actual = highlight ? [...highlight].map((range) => range.toString()).join('') : '';
    return actual.replace(/\s+/gu, ' ').trim() === expected;
  }, normalize(expected));
}

async function run() {
  // Load the unchanged production manifest and service worker first.
  const production = await launch(root, 'production-profile');
  const manifest = await production.worker.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes('tts'));
  assert.ok(manifest.permissions.includes('offscreen'));
  const voices = await production.worker.evaluate(() => new Promise((resolve) => chrome.tts.getVoices(resolve)));
  console.log(`PASS: unchanged MV3 extension loaded; ${voices.length} actual Chrome TTS voice(s) available.`);
  const productionPopup = await production.context.newPage();
  await productionPopup.goto(`chrome-extension://${production.extensionId}/popup.html`);
  await productionPopup.locator('#text-input').waitFor();
  await productionPopup.locator('#play-button').waitFor();
  assert.ok((await productionPopup.title()).length > 0);
  console.log('PASS: production popup loads in Chromium.');
  await production.context.close();

  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(request.url === '/large.html'
      ? `<!doctype html><html lang="en"><head><title>Long article</title></head><body><article><p>${'a'.repeat(100001)}</p></article></body></html>`
      : fixture);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const testExtension = path.join(scratch, 'extension');
  fs.cpSync(root, testExtension, {
    recursive: true,
    filter: (source) => !['.git', '.agents', '.codex', '.aws', 'node_modules', 'tests'].includes(path.relative(root, source).split(path.sep)[0]),
  });
  const testManifest = JSON.parse(fs.readFileSync(path.join(testExtension, 'manifest.json'), 'utf8'));
  testManifest.host_permissions = [...(testManifest.host_permissions || []), `${origin}/*`];
  fs.writeFileSync(path.join(testExtension, 'manifest.json'), `${JSON.stringify(testManifest, null, 2)}\n`);
  const browser = await launch(testExtension, 'fixture-profile');
  await installTtsDouble(browser.worker);
  const article = await browser.context.newPage();
  await article.goto(`${origin}/article.html`);
  const popup = await browser.context.newPage();
  popup.on('pageerror', (error) => failures.push(error.message));
  await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  await popup.locator('#text-input').waitFor();
  const tabId = await popup.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === url)?.id;
  }, `${origin}/article.html`);
  assert.ok(Number.isInteger(tabId));

  const articleResponse = await loadContent(popup, tabId);
  const source = articleResponse.source;
  assert.ok(source?.id && source.text && source.title);
  assert.equal(source.kind, 'page');
  assert.ok(source.text.includes('The joy of listening'));
  assert.ok(source.text.includes('thoughtful pauses help listeners'));
  assert.ok(source.text.includes('short link and a clear emphasis'));
  for (const unwanted of ['Navigation words', 'Footer words', 'Hidden words', 'Hidden-parent candidate words', 'Accessible-hidden words', 'Display-none words', 'Subscribe button words', 'Input value']) {
    assert.ok(!source.text.includes(unwanted), `Extraction included ${unwanted}`);
  }
  console.log('PASS: chrome.scripting loads content script; readable article excludes hidden text and page chrome.');

  await article.evaluate(() => {
    const input = document.querySelector('input');
    input.focus();
    input.setSelectionRange(0, 'Input value'.length);
  });
  const inputResponse = await loadContent(popup, tabId);
  assert.equal(inputResponse.source.kind, 'selection');
  assert.equal(inputResponse.source.text, 'Input value');
  await article.evaluate(() => document.activeElement.blur());
  console.log('PASS: selected input text overrides article extraction.');

  // Interact with the popup while the readable article remains the active tab.
  await article.bringToFront();
  await popup.locator('#load-page').click();
  await popup.waitForFunction(() => document.querySelector('#text-input').value.includes('The joy of listening'));
  await popup.locator('#play-button').click();
  const firstState = await waitState(popup, (state) => state.status === 'playing');
  assert.equal(firstState.source.kind, 'page');
  assert.equal(firstState.source.tabId, tabId);
  const originalSource = firstState.source;
  await article.locator('[data-sona-reader="panel"]').waitFor({ state: 'visible' });
  await waitHighlight(article, originalSource.text.slice(firstState.segmentStart, firstState.segmentEnd));
  console.log('PASS: popup reads the current article; background playback reaches the floating reader and real DOM highlight.');

  const utterance = await browser.worker.evaluate(() => __readerTtsTest.current.text);
  const word = [...utterance.matchAll(/\p{L}+/gu)][1] || [...utterance.matchAll(/\p{L}+/gu)][0];
  assert.ok(word);
  await emitTts(browser.worker, { type: 'word', charIndex: word.index, length: word[0].length });
  await waitState(popup, (state) => state.charIndex === firstState.segmentStart + word.index);

  await popup.locator('#play-button').click();
  await waitState(popup, (state) => state.status === 'paused');
  await article.getByRole('button', { name: 'Resume', exact: true }).click();
  await waitState(popup, (state) => state.status === 'playing');
  await popup.locator('#next-button').click();
  const nextState = await waitState(popup, (state) => state.segmentStart > firstState.segmentStart);
  await waitHighlight(article, originalSource.text.slice(nextState.segmentStart, nextState.segmentEnd));
  await popup.locator('#prev-button').click();
  await waitState(popup, (state) => state.segmentStart === firstState.segmentStart);
  console.log('PASS: word progress, popup pause, page resume, and sentence navigation cross actual extension messaging.');

  await article.getByRole('button', { name: 'Hide reader', exact: true }).click();
  await article.locator('[data-sona-reader="panel"]').waitFor({ state: 'hidden' });
  assert.equal((await getState(popup)).status, 'playing');
  assert.equal(await highlightText(article), '');
  await popup.locator('#stop-button').click();
  await waitState(popup, (state) => state.status === 'idle');
  console.log('PASS: hiding the reader keeps playback running; stop clears playback and highlighting.');

  // Select across an ordinary text node and an emphasis node to exercise offset
  // mapping that cannot be tested by matching a string in a single node.
  const selectedText = await article.evaluate(() => {
    const paragraph = document.querySelector('#inline-paragraph');
    const firstNode = paragraph.firstChild;
    const lastNode = paragraph.querySelector('em').firstChild;
    const range = document.createRange();
    range.setStart(firstNode, firstNode.data.indexOf('thoughtful'));
    range.setEnd(lastNode, lastNode.data.length);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  assert.equal(selectedText, 'thoughtful pauses help listeners');
  await article.bringToFront();
  await popup.locator('#load-page').click();
  await popup.waitForFunction((text) => document.querySelector('#text-input').value === text, selectedText);
  await popup.locator('#play-button').click();
  const selectionState = await waitState(popup, (state) => state.status === 'playing');
  assert.equal(selectionState.source.kind, 'selection');
  assert.equal(selectionState.source.text, selectedText);
  await waitHighlight(article, selectedText);
  await emitTts(browser.worker, { type: 'end', charIndex: selectedText.length });
  await waitState(popup, (state) => state.status === 'finished');
  await article.waitForFunction(() => !CSS.highlights?.has('sona-current-sentence'));
  console.log('PASS: selected text spanning inline nodes is read and highlighted precisely; completion removes highlight.');

  // Reading another source must not discard the original page's offset map.
  await send(popup, { type: 'START', source: originalSource, settings: { rate: 1.4, voiceName: '' } });
  const restoredState = await waitState(popup, (state) => state.status === 'playing');
  assert.equal(restoredState.source.id, originalSource.id);
  await waitHighlight(article, originalSource.text.slice(restoredState.segmentStart, restoredState.segmentEnd));
  assert.equal(await browser.worker.evaluate(() => __readerTtsTest.spoken.at(-1).rate), 1.4);
  await send(popup, { type: 'STOP' });
  await waitState(popup, (state) => state.status === 'idle');
  console.log('PASS: prior article mapping survives subsequent extraction; chosen speed reaches Chrome TTS.');

  const draftText = 'A personal draft stays here when I reopen the reader. The next sentence is ready to listen.';
  await popup.locator('#text-input').fill(draftText);
  await popup.waitForFunction(async (text) => {
    const { sonaDraft } = await chrome.storage.session.get('sonaDraft');
    return sonaDraft?.mode === 'paste' && sonaDraft.pasteDraft === text && sonaDraft.source.text === text;
  }, draftText);
  await popup.close();
  const reopened = await browser.context.newPage();
  reopened.on('pageerror', (error) => failures.push(error.message));
  await reopened.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  try {
    await reopened.waitForFunction((text) => document.querySelector('#text-input').value === text, draftText);
  } catch (error) {
    console.error('Draft restoration diagnostic:', JSON.stringify(await reopened.evaluate(async () => ({
      text: document.querySelector('#text-input').value,
      status: document.querySelector('#status').textContent,
      stored: await chrome.storage.session.get(null),
    })), null, 2));
    throw error;
  }
  await reopened.locator('#play-button').click();
  const draftState = await waitState(reopened, (state) => state.status === 'playing');
  assert.ok(['paste', 'pasted'].includes(draftState.source.kind));
  assert.equal(draftState.source.text, draftText);
  await send(reopened, { type: 'STOP' });
  console.log('PASS: typed draft persists across popup close/reopen and becomes an independent pasted-text source.');

  const artifactDirectory = process.env.SONA_ARTIFACT_DIR || path.join(os.tmpdir(), 'sona-browser-artifacts');
  fs.mkdirSync(artifactDirectory, { recursive: true });
  await reopened.setViewportSize({ width: 412, height: 600 });
  const popupHeight = await reopened.locator('main').evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(popupHeight <= 600, `Normal popup content is ${popupHeight}px tall, exceeding Chrome's 600px limit.`);
  await reopened.screenshot({ path: path.join(artifactDirectory, 'popup.png') });
  console.log(`PASS: normal popup content fits Chrome's 600px height (${popupHeight}px).`);

  const largePage = await browser.context.newPage();
  await largePage.goto(`${origin}/large.html`);
  const largeTabId = await reopened.evaluate(async (url) => {
    return (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id;
  }, `${origin}/large.html`);
  const largeResponse = await loadContent(reopened, largeTabId);
  assert.equal(largeResponse.source.text.length, 100000);
  assert.equal(largeResponse.source.truncated, true);
  console.log('PASS: very long articles are capped at 100,000 characters with truncation reported.');
  assert.deepEqual(failures, [], 'Popup emitted an uncaught error.');
  console.log('PASS: no uncaught popup errors.');
  console.log('NOTE: native regression scenarios use a deterministic Chrome TTS double; fallback-browser.cjs verifies real bundled voice audio and playback.');
  console.log('NOTE: article checks grant only the local fixture origin in a temporary extension copy; repository manifest permissions are unchanged.');
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  for (const context of contexts) await context.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
});
