// MV3 integration for the follow-along player and persistent reading view.
// Native TTS events are deterministic; fallback-browser.cjs covers real audio.
// Only a temporary extension copy receives access to the local article fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sona-reader-browser-'));
const contexts = [];
const errors = [];
let server;
const artifactDirectory = process.env.SONA_ARTIFACT_DIR || path.join(os.tmpdir(), 'sona-browser-artifacts');
const fixture = `<!doctype html><html lang="en"><head><title>A longer listening journey</title>
  <style>body{margin:32px;font:20px/1.8 Georgia}article{max-width:700px}p{min-height:320px;margin:40px 0}input{display:block;margin:30px 0}</style>
  </head><body><input aria-label="Your notes" value="Keep writing here"><article><h1>A longer listening journey</h1>
  ${Array.from({ length: 24 }, (_, index) => `<p id="passage-${index}">Passage ${index + 1} follows the listening journey through this longer article. Each sentence provides a clear place to return to. Thoughtful pauses make the words easier to follow.</p>`).join('\n')}
  </article></body></html>`;

function getPlaywright() {
  for (const candidate of [process.env.PLAYWRIGHT_PATH, 'playwright', 'playwright-core',
    '/home/amen/.cache/ms-playwright-go/1.57.0/package/index.js'].filter(Boolean)) {
    try { return require(candidate); } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Install Playwright or set PLAYWRIGHT_PATH to run browser checks.');
}

async function launch(extensionDirectory, wakeExtensionId = '') {
  const { chromium } = getPlaywright();
  const knownChromium = '/home/amen/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  const context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    executablePath: process.env.CHROME_PATH || (fs.existsSync(knownChromium) ? knownChromium : undefined),
    headless: true,
    viewport: { width: 1180, height: 780 },
    reducedMotion: 'reduce',
    args: ['--no-sandbox', `--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  contexts.push(context);
  context.setDefaultTimeout(10000);
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  if (wakeExtensionId && !context.serviceWorkers().length) {
    // Installed MV3 workers can be lazy after a profile restart. Opening the
    // popup wakes it through its normal GET_STATE request.
    const wakePage = await context.newPage();
    await wakePage.goto(`chrome-extension://${wakeExtensionId}/popup.html`);
  }
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
  return { context, worker, extensionId: new URL(worker.url()).host };
}

async function send(page, message) {
  let timer;
  let response;
  try {
    response = await Promise.race([
      page.evaluate((message) => chrome.runtime.sendMessage(message), message),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`No response to ${message.type}`)), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
  if (response?.error) throw new Error(response.error);
  return response;
}

async function waitState(page, predicate) {
  const deadline = Date.now() + 10000;
  let state;
  while (Date.now() < deadline) {
    state = (await send(page, { type: 'GET_STATE' })).state;
    if (predicate(state)) return state;
    if (state.status === 'error') throw new Error(state.error);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for reader state: ${JSON.stringify(state)}`);
}

async function installTtsDouble(worker) {
  await worker.evaluate(() => {
    const voices = [{ voiceName: 'Sona reader test voice', lang: 'en-US', remote: false,
      eventTypes: ['start', 'word', 'end', 'error', 'pause', 'resume'] }];
    chrome.tts.getVoices = (callback) => callback ? callback(voices) : Promise.resolve(voices);
    globalThis.__readerTtsTest = { current: null, spoken: [] };
    chrome.tts.speak = (text, options, callback) => {
      const current = { text, options };
      __readerTtsTest.current = current;
      __readerTtsTest.spoken.push({ text, rate: options.rate });
      callback?.();
      queueMicrotask(() => current.options.onEvent?.({ type: 'start', charIndex: 0 }));
    };
    chrome.tts.stop = () => { __readerTtsTest.current = null; };
    chrome.tts.pause = () => __readerTtsTest.current?.options.onEvent?.({ type: 'pause' });
    chrome.tts.resume = () => __readerTtsTest.current?.options.onEvent?.({ type: 'resume' });
  });
}

async function openExtensionPage(browser, file, viewport) {
  const page = await browser.context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  if (viewport) await page.setViewportSize(viewport);
  await page.goto(`chrome-extension://${browser.extensionId}/${file}`);
  await page.locator('#play-button:not([disabled])').waitFor();
  return page;
}

async function sourceFor(page, article) {
  await article.bringToFront();
  const tabId = await page.evaluate(async (url) => (await chrome.tabs.query({ active: true, currentWindow: true })).find((tab) => tab.url === url)?.id, article.url());
  assert.ok(Number.isInteger(tabId));
  const result = await page.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, { type: 'READ_PAGE' });
  }, tabId);
  if (result.error) throw new Error(result.error);
  return { ...result.source, tabId };
}

async function waitHighlight(article, source, state) {
  const expected = source.text.slice(state.segmentStart, state.segmentEnd).replace(/\s+/gu, ' ').trim();
  await article.waitForFunction((expected) => {
    const ranges = CSS.highlights?.get('sona-current-sentence');
    return [...(ranges || [])].map((range) => range.toString()).join('').replace(/\s+/gu, ' ').trim() === expected;
  }, expected);
}

async function setRange(locator, value) {
  await locator.evaluate((element, value) => {
    element.value = String(value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function invokeShortcut(worker, command) {
  await worker.evaluate((command) => {
    assertReaderListeners();
    for (const listener of __readerTestHooks.commands) listener(command);
    function assertReaderListeners() {
      if (!__readerTestHooks.commands.length) throw new Error('No Chrome command callback registered.');
    }
  }, command);
}

async function run() {
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const extensionDirectory = path.join(scratch, 'extension');
  fs.cpSync(root, extensionDirectory, {
    recursive: true,
    filter: (source) => !['.git', '.agents', '.codex', '.aws', 'node_modules', 'tests'].includes(path.relative(root, source).split(path.sep)[0]),
  });
  const manifestPath = path.join(extensionDirectory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...(manifest.host_permissions || []), `${origin}/*`];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const backgroundPath = path.join(extensionDirectory, 'background.js');
  const hooks = `globalThis.__readerTestHooks = { commands: [], opens: [] };
    const realCommandListener = chrome.commands.onCommand.addListener.bind(chrome.commands.onCommand);
    chrome.commands.onCommand.addListener = (listener) => { __readerTestHooks.commands.push(listener); realCommandListener(listener); };
    const realSidePanelOpen = chrome.sidePanel.open.bind(chrome.sidePanel);
    chrome.sidePanel.open = (options) => {
      const call = { options, status: 'pending' }; __readerTestHooks.opens.push(call);
      return realSidePanelOpen(options).then((result) => { call.status = 'opened'; return result; }, (error) => { call.status = 'error'; call.error = error.message; throw error; });
    };\n`;
  fs.writeFileSync(backgroundPath, hooks + fs.readFileSync(backgroundPath, 'utf8'));
  let browser = await launch(extensionDirectory);
  await installTtsDouble(browser.worker);
  const registered = await browser.worker.evaluate(() => new Promise((resolve) => chrome.commands.getAll(resolve)));
  for (const command of ['toggle-playback', 'previous-sentence', 'next-sentence']) {
    assert.ok(registered.some((item) => item.name === command), `${command} is not registered in Chrome.`);
    assert.ok(manifest.commands[command].suggested_key.default, `${command} has no suggested shortcut.`);
  }
  assert.equal(manifest.side_panel.default_path, 'reader.html');
  console.log('PASS: native Chrome side panel and all playback shortcuts register in MV3.');

  let article = await browser.context.newPage();
  await article.goto(`${origin}/journey.html`);
  await article.bringToFront();
  // Establish content before popup auto-load to keep current-page semantics clear.
  let popup = await browser.context.newPage();
  await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  await popup.locator('#text-input').waitFor();
  // A popup opened as a test tab changes Chrome's active tab. Restore the
  // article and finish loading through the UI before starting via the harness.
  await article.bringToFront();
  await popup.locator('#load-page').click();
  await popup.waitForFunction(() => document.querySelector('#text-input').value.includes('Passage 24 follows')
    && !document.querySelector('#play-button').disabled);
  let source = await sourceFor(popup, article);
  assert.ok(source.text.includes('Passage 24 follows'));
  await send(popup, { type: 'START', source, settings: { rate: 1, voiceName: 'Sona reader test voice' } });
  let state = await waitState(popup, (state) => state.status === 'playing');
  const panel = article.locator('[data-sona-reader="panel"]');
  await panel.waitFor({ state: 'visible' });
  await waitHighlight(article, source, state);
  const farOffset = source.text.indexOf('Passage 18 follows');
  await send(popup, { type: 'SEEK', charIndex: farOffset });
  state = await waitState(popup, (state) => state.segmentStart === farOffset);
  await waitHighlight(article, source, state);
  await article.waitForFunction(() => scrollY > 2000);
  const rangeVisible = await article.evaluate(() => {
    const rect = [...CSS.highlights.get('sona-current-sentence')][0].getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  });
  assert.equal(rangeVisible, true);
  console.log('PASS: spoken sentence highlights its actual DOM range and automatically scrolls into view.');

  await article.mouse.move(200, 300);
  await article.mouse.wheel(0, -100000);
  await article.waitForFunction(() => scrollY < 100);
  await panel.getByRole('button', { name: 'Back to reading', exact: true }).filter({ visible: true }).waitFor();
  await send(popup, { type: 'SEEK', charIndex: source.text.indexOf('Passage 19 follows') });
  await waitState(popup, (state) => state.segmentStart === source.text.indexOf('Passage 19 follows'));
  assert.ok(await article.evaluate(() => scrollY) < 100, 'Automatic follow overrode a manual scroll.');
  await panel.getByRole('button', { name: 'Back to reading', exact: true }).filter({ visible: true }).click();
  await article.waitForFunction(() => scrollY > 2000);
  console.log('PASS: manual scrolling suspends following; Back to reading restores the spoken passage.');

  await article.bringToFront();
  const previousBounds = await panel.boundingBox();
  const handleBounds = await panel.locator('.top').boundingBox();
  await article.mouse.move(handleBounds.x + 60, handleBounds.y + handleBounds.height / 2);
  await article.mouse.down();
  await article.mouse.move(handleBounds.x - 160, handleBounds.y - 130, { steps: 8 });
  await article.mouse.up();
  const movedBounds = await panel.boundingBox();
  assert.ok(Math.abs(movedBounds.x - previousBounds.x) > 100 && Math.abs(movedBounds.y - previousBounds.y) > 70,
    `Drag did not move the player: ${JSON.stringify({ previousBounds, handleBounds, movedBounds })}`);
  await panel.getByRole('button', { name: 'Minimize reader', exact: true }).click();
  await panel.getByRole('region', { name: 'Sona compact reader' }).waitFor().catch(async () => panel.locator('.compact').waitFor());
  assert.equal(await panel.locator('.reader').isVisible(), false);
  assert.equal(await panel.locator('.compact').isVisible(), true);
  assert.equal((await send(popup, { type: 'GET_STATE' })).state.status, 'playing');
  assert.equal(await article.evaluate(() => CSS.highlights.has('sona-current-sentence')), true);
  await panel.getByRole('button', { name: 'Pause', exact: true }).filter({ visible: true }).click();
  await waitState(popup, (state) => state.status === 'paused');
  await panel.getByRole('button', { name: 'Resume', exact: true }).filter({ visible: true }).click();
  await waitState(popup, (state) => state.status === 'playing');
  await panel.getByRole('button', { name: 'Expand reader', exact: true }).click();
  console.log('PASS: floating player drags, collapses without losing highlights, and compact playback controls work.');

  await panel.getByRole('combobox', { name: 'Reading speed', exact: true }).selectOption('1.75');
  await waitState(popup, (state) => state.settings.rate === 1.75 && state.status === 'playing');
  assert.equal(await browser.worker.evaluate(() => __readerTtsTest.spoken.at(-1).rate), 1.75);
  await panel.getByRole('button', { name: 'Pause', exact: true }).click();
  await waitState(popup, (state) => state.status === 'paused');
  await setRange(panel.getByRole('slider', { name: 'Reading progress', exact: true }), 350);
  state = await waitState(popup, (state) => state.status === 'paused' && state.charIndex < farOffset && state.progress > .3);
  assert.equal(state.charIndex, state.segmentStart);
  assert.ok(state.remainingSeconds > 0);
  await panel.getByRole('button', { name: 'Resume', exact: true }).click();
  await waitState(popup, (state) => state.status === 'playing');
  console.log('PASS: on-screen speed changes reach TTS; progress seeks to a sentence while preserving pause and reporting time remaining.');

  await panel.getByLabel('Follow reading', { exact: true }).uncheck();
  await waitState(popup, (state) => state.uiPreferences.follow === false);
  await article.evaluate(() => scrollTo(0, 0));
  await send(popup, { type: 'SEEK', charIndex: farOffset });
  await waitState(popup, (state) => state.segmentStart === farOffset);
  assert.equal(await article.evaluate(() => scrollY), 0);
  await panel.getByLabel('Follow reading', { exact: true }).check();
  await article.waitForFunction(() => scrollY > 2000);
  console.log('PASS: Follow reading is optional and enabling it returns to the current sentence.');

  await article.bringToFront();
  await article.locator('#passage-7').click({ button: 'right', position: { x: 12, y: 12 } });
  const fromHere = await popup.evaluate(async (tabId) => chrome.tabs.sendMessage(tabId, { type: 'READ_FROM_HERE' }), source.tabId);
  assert.equal(fromHere.source.text, source.text);
  assert.ok(fromHere.source.startOffset >= source.text.indexOf('Passage 8 follows'));
  assert.ok(fromHere.source.startOffset < source.text.indexOf('Passage 9 follows'));
  await article.keyboard.press('Escape');
  await send(popup, { type: 'START', source: { ...fromHere.source, tabId: source.tabId }, startOffset: fromHere.source.startOffset });
  state = await waitState(popup, (state) => state.status === 'playing' && state.segmentStart >= source.text.indexOf('Passage 8 follows'));
  await waitHighlight(article, source, state);
  console.log('PASS: a real paragraph right-click captures Read from here position and retains the complete article for navigation.');

  await article.getByRole('textbox', { name: 'Your notes', exact: true }).click({ button: 'right' });
  const excludedTarget = await popup.evaluate(async (tabId) => chrome.tabs.sendMessage(tabId, { type: 'READ_FROM_HERE' }), source.tabId);
  assert.ok(excludedTarget.error && !excludedTarget.source, 'Excluded input incorrectly read from the beginning of the article.');
  await article.keyboard.press('Escape');
  console.log('PASS: Read from here rejects an excluded input instead of starting unrelated article text.');

  await article.bringToFront();
  await article.evaluate(() => document.querySelector('input').focus());
  const beforeTypingShortcut = (await send(popup, { type: 'GET_STATE' })).state;
  await invokeShortcut(browser.worker, 'next-sentence');
  // GET_STATE shares the service worker queue, so this is a deterministic barrier.
  state = (await send(popup, { type: 'GET_STATE' })).state;
  assert.equal(state.segmentStart, beforeTypingShortcut.segmentStart);
  await article.evaluate(() => document.activeElement.blur());
  await invokeShortcut(browser.worker, 'next-sentence');
  state = await waitState(popup, (state) => state.segmentStart > beforeTypingShortcut.segmentStart);
  await invokeShortcut(browser.worker, 'previous-sentence');
  await waitState(popup, (state) => state.segmentStart === beforeTypingShortcut.segmentStart);
  await invokeShortcut(browser.worker, 'toggle-playback');
  await waitState(popup, (state) => state.status === 'paused');
  await invokeShortcut(browser.worker, 'toggle-playback');
  await waitState(popup, (state) => state.status === 'playing');
  console.log('PASS: registered command callbacks navigate and toggle playback; focused input prevents interruption.');

  // The real open API is wrapped only to record whether Chrome accepts the click.
  await popup.locator('#open-reader').click();
  let opened;
  const openDeadline = Date.now() + 10000;
  do {
    opened = await browser.worker.evaluate(() => __readerTestHooks.opens.at(-1));
    if (opened?.status && opened.status !== 'pending') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < openDeadline);
  assert.equal(opened?.status, 'opened', `Native side panel open failed: ${JSON.stringify(opened)}`);
  assert.equal((await send(popup, { type: 'GET_STATE' })).state.status, 'playing', 'Opening the reading view interrupted playback.');
  const sidePanelContexts = await popup.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }));
  console.log(`PASS: popup click opens native Chrome side panel (${sidePanelContexts.length} SIDE_PANEL context(s) exposed in headless Chromium).`);
  // A separate extension page allows reliable viewport and pointer automation;
  // it uses the exact same reading-view source and APIs as the native side panel.
  const reader = await openExtensionPage(browser, 'reader.html', { width: 390, height: 780 });
  await reader.locator('#article-text .sentence.current').waitFor();
  assert.equal(await reader.locator('#article-text').textContent(), source.text);
  const word = await browser.worker.evaluate(() => {
    const current = __readerTtsTest.current;
    const match = [...current.text.matchAll(/\p{L}+/gu)][1];
    current.options.onEvent({ type: 'word', charIndex: match.index, length: match[0].length });
    return match[0];
  });
  await reader.waitForFunction((word) => document.querySelector('.current-word')?.textContent === word, word);
  await article.waitForFunction((word) => [...(CSS.highlights.get('sona-current-word') || [])].map((range) => range.toString()).join('') === word, word);
  console.log('PASS: clean reading view preserves article text and synchronizes sentence plus supported native word highlights.');

  await reader.locator('#text-size').selectOption('24');
  await reader.locator('#theme-toggle').click();
  await reader.waitForFunction(() => document.body.classList.contains('dark') && getComputedStyle(document.querySelector('#article-text')).fontSize === '24px');
  await reader.locator('#follow-reading').uncheck();
  await panel.getByLabel('Follow reading', { exact: true }).waitFor({ state: 'visible' });
  await article.waitForFunction(() => !document.querySelector('[data-sona-reader="panel"]').shadowRoot.querySelector('input[type="checkbox"]').checked);
  await reader.locator('#follow-reading').check();
  await reader.locator('#rate-select').selectOption('1.25');
  await waitState(popup, (state) => state.settings.rate === 1.25);
  assert.equal(await panel.getByRole('combobox', { name: 'Reading speed', exact: true }).inputValue(), '1.25');
  console.log('PASS: reading-view font/theme controls work; follow and speed stay synchronized with the floating player.');

  await reader.bringToFront();
  await reader.locator('#paste-section > summary').click();
  await reader.locator('#paste-input').click();
  await reader.waitForFunction(() => document.hasFocus() && document.activeElement.id === 'paste-input');
  const beforeReaderTyping = (await send(popup, { type: 'GET_STATE' })).state;
  await invokeShortcut(browser.worker, 'toggle-playback');
  state = (await send(popup, { type: 'GET_STATE' })).state;
  assert.equal(state.status, beforeReaderTyping.status,
    `Focused reader shortcut guard failed: ${JSON.stringify(await reader.evaluate(() => ({ hasFocus: document.hasFocus(), focused: document.activeElement.id })))}`);
  assert.equal(state.segmentStart, beforeReaderTyping.segmentStart);
  await reader.locator('#paste-section > summary').click();
  console.log('PASS: playback keyboard commands also respect typing in the reading view.');

  const targetSentence = reader.locator('.sentence').nth(45);
  const expectedSentence = await targetSentence.textContent();
  await targetSentence.click();
  state = await waitState(popup, (state) => source.text.slice(state.segmentStart, state.segmentEnd) === expectedSentence);
  await waitHighlight(article, source, state);
  const area = reader.locator('#article-scroll');
  await area.hover();
  await reader.mouse.wheel(0, -100000);
  await reader.locator('#back-to-reading').waitFor({ state: 'visible' });
  const manuallyScrolledPosition = await area.evaluate((element) => element.scrollTop);
  await send(popup, { type: 'SEEK', charIndex: source.text.indexOf('Passage 24 follows') });
  await waitState(popup, (state) => state.segmentStart === source.text.indexOf('Passage 24 follows'));
  assert.ok(Math.abs(await area.evaluate((element) => element.scrollTop) - manuallyScrolledPosition) < 2);
  await reader.locator('#back-to-reading').click();
  await reader.waitForFunction(() => document.querySelector('#article-scroll').scrollTop > 1000);
  const layout = await reader.evaluate(() => ({
    height: innerHeight, footerBottom: document.querySelector('.player').getBoundingClientRect().bottom,
    footerTop: document.querySelector('.player').getBoundingClientRect().top,
    articleBottom: document.querySelector('#article-scroll').getBoundingClientRect().bottom,
    width: innerWidth, documentWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(layout.footerBottom <= layout.height + 1 && layout.articleBottom <= layout.footerTop + 1);
  assert.ok(layout.documentWidth <= layout.width, 'Reading view has horizontal overflow.');
  fs.mkdirSync(artifactDirectory, { recursive: true });
  await reader.screenshot({ path: path.join(artifactDirectory, 'reader.png') });
  await article.screenshot({ path: path.join(artifactDirectory, 'player.png') });
  console.log('PASS: clicking a sentence seeks both views; manual reader scrolling and Back to reading work with controls kept visible.');

  await reader.locator('#play-button').click();
  await waitState(popup, (state) => state.status === 'paused');
  await setRange(reader.locator('#seek-progress'), 400);
  state = await waitState(popup, (state) => state.status === 'paused' && state.progress > .35 && state.progress < .45);
  assert.equal(state.charIndex, state.segmentStart);
  await reader.locator('#stop-button').click();
  await waitState(popup, (state) => state.status === 'idle');
  await reader.locator('#resume-banner').waitFor({ state: 'visible' });
  await reader.locator('#paste-section > summary').click();
  const pasted = 'A <script> tag stays ordinary readable text. A second sentence is ready to hear.';
  await reader.locator('#paste-input').fill(pasted);
  await reader.locator('#read-paste').click();
  state = await waitState(popup, (state) => state.status === 'playing' && state.source.kind === 'paste');
  assert.equal(state.source.text, pasted);
  assert.equal(await reader.locator('#article-text').textContent(), pasted);
  assert.equal(await reader.locator('#article-text script').count(), 0);
  await reader.locator('.sentence').nth(1).focus();
  await reader.keyboard.press('Enter');
  await waitState(popup, (state) => state.currentIndex === 1);
  console.log('PASS: reading-view seeking preserves pause; pasted text is safe and sentences are keyboard operable.');

  // Preserve a meaningful article position, then actually restart Chrome.
  await send(popup, { type: 'START', source, startOffset: farOffset });
  await waitState(popup, (state) => state.segmentStart === farOffset && state.status === 'playing');
  await send(popup, { type: 'STOP' });
  const saved = (await send(popup, { type: 'GET_POSITION', source })).position;
  assert.ok(saved?.charIndex === farOffset);
  const extensionId = browser.extensionId;
  await browser.context.close();
  console.log('PASS: saved article checkpoint flushed and first Chrome process closed.');
  browser = await launch(extensionDirectory, extensionId);
  await installTtsDouble(browser.worker);
  console.log('PASS: Chrome restarted with the same profile and MV3 worker reawakened.');
  article = await browser.context.newPage();
  await article.goto(`${origin}/journey.html`);
  await article.bringToFront();
  popup = await browser.context.newPage();
  await popup.setViewportSize({ width: 412, height: 600 });
  await popup.goto(`chrome-extension://${browser.extensionId}/popup.html`);
  await popup.locator('#text-input').waitFor();
  source = await sourceFor(popup, article);
  const restored = (await send(popup, { type: 'GET_POSITION', source })).position;
  assert.equal(restored.charIndex, farOffset);
  assert.equal((await send(popup, { type: 'GET_POSITION', source: { ...source, text: `${source.text} Changed.` } })).position, null);
  await article.bringToFront();
  await popup.locator('#load-page').click();
  await popup.locator('#resume-card').waitFor({ state: 'visible' });
  const popupHeight = await popup.locator('main').evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(popupHeight <= 600, `Resume popup exceeds Chrome's limit at ${popupHeight}px.`);
  await popup.screenshot({ path: path.join(artifactDirectory, 'popup-resume.png') });
  await popup.locator('#resume-reading').click();
  await waitState(popup, (state) => state.status === 'playing' && state.segmentStart === farOffset);
  await send(popup, { type: 'STOP' });
  await popup.locator('#resume-card').waitFor({ state: 'visible' });
  await popup.locator('#restart-reading').click();
  await waitState(popup, (state) => state.status === 'playing' && state.segmentStart === 0);
  console.log(`PASS: article position survives a full Chrome restart; changed text is ignored; Resume and Start over work within a ${popupHeight}px popup.`);

  const reopenedReader = await openExtensionPage(browser, 'reader.html', { width: 390, height: 780 });
  await reopenedReader.waitForFunction(() => document.body.classList.contains('dark') && document.querySelector('#text-size').value === '24');
  assert.equal((await send(popup, { type: 'GET_UI_PREFS' })).preferences.follow, true);
  await send(popup, { type: 'STOP' });
  assert.deepEqual(errors, [], 'Extension view emitted an uncaught browser error.');
  console.log('PASS: reading appearance persists after Chrome restart; no uncaught view errors.');
  console.log('NOTE: headless Chromium does not assign the suggested shortcut keys; registered callbacks are dispatched through a test-only capture to verify navigation and the real typing-focus guard.');
  console.log('NOTE: deterministic native speech events are complemented by test:fallback for actual bundled audio; production permissions and sources are unchanged.');
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  for (const context of contexts) await context.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
});
