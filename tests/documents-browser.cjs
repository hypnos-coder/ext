// Real bundled PDF.js and OCR integration. No parser or OCR mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sona-documents-'));
const fixture = path.join(__dirname, 'fixtures');
const pdf = fs.readFileSync(path.join(fixture, 'document.pdf'));
const scan = fs.readFileSync(path.join(fixture, 'scanned.pdf'));
const encrypted = fs.readFileSync(path.join(fixture, 'encrypted.pdf'));
const mixed = fs.readFileSync(path.join(fixture, 'mixed.pdf'));
let context; const servers = []; const errors = [];
function playwright() {
  for (const location of [process.env.PLAYWRIGHT_PATH, 'playwright', '/home/amen/.cache/ms-playwright-go/1.57.0/package/index.js'].filter(Boolean)) {
    try { return require(location); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  throw new Error('Install Playwright or set PLAYWRIGHT_PATH.');
}
async function server(handler) {
  const value = http.createServer(handler); servers.push(value);
  await new Promise((resolve) => value.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${value.address().port}`;
}
async function send(page, value) {
  return page.evaluate((value) => Promise.race([chrome.runtime.sendMessage(value), new Promise((_, reject) => setTimeout(() => reject(new Error('Document request timed out.')), 150000))]), value);
}
async function extract(page, tabId, options = {}) {
  const result = await send(page, { type: 'EXTRACT_TAB', tabId, requestId: `test-${Date.now()}-${Math.random()}`, ...options });
  if (result.error) throw new Error(result.error);
  return result;
}
async function tabIdFor(page, target) {
  return page.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, target.url());
}
async function run() {
  const documentOrigin = await server((request, response) => {
    response.setHeader('Content-Type', 'application/pdf');
    response.end(request.url.startsWith('/scanned') ? scan : request.url.startsWith('/mixed') ? mixed : request.url.startsWith('/encrypted') ? encrypted : pdf);
  });
  const articleText = 'This thoughtful article explains how clear paragraphs and meaningful reading order help people follow a document. '.repeat(8);
  const origin = await server((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url.startsWith('/slow.pdf')) {
      response.setHeader('Content-Type', 'application/pdf');
      response.write(pdf.subarray(0, 40));
      const timeout = setTimeout(() => response.end(pdf.subarray(40)), 10000);
      request.on('close', () => clearTimeout(timeout));
      return;
    }
    if (request.url.startsWith('/auth.pdf')) {
      if (!request.headers.referer?.includes('/auth-page')) { response.statusCode = 403; response.end('A page request is required.'); return; }
      response.setHeader('Content-Type', 'application/pdf'); response.end(pdf); return;
    }
    if (request.url.startsWith('/auth-page')) { response.end('<title>Authenticated document</title><iframe src="/auth.pdf" style="width:95vw;height:85vh"></iframe>'); return; }
    if (request.url.startsWith('/screen')) { response.end('<title>Canvas document</title><canvas width="1000" height="500"></canvas><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="white";c.fillRect(0,0,1000,500);c.fillStyle="black";c.font="32px Arial";c.fillText("Visible canvas text can be read with local OCR.",35,80);</script>'); return; }
    if (request.url.startsWith('/embed')) response.end(`<title>Embedded report</title><p>A report is embedded below.</p><iframe title="Report PDF" src="${documentOrigin}/document.pdf" style="width:95vw;height:85vh"></iframe>`);
    else if (request.url.startsWith('/extensionless')) response.end(`<title>Embedded download</title><iframe src="${documentOrigin}/download?id=42" style="width:95vw;height:85vh"></iframe>`);
    else if (request.url.startsWith('/blob')) response.end(`<title>Blob PDF</title><script>fetch('${origin}/bytes').then(r=>r.arrayBuffer()).then(bytes=>{const e=document.createElement('embed');e.type='application/pdf';e.src=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));e.style='width:95vw;height:85vh';document.body.append(e);});</script>`);
    else if (request.url.startsWith('/bytes')) { response.setHeader('Content-Type', 'application/pdf'); response.end(pdf); }
    else if (request.url.startsWith('/viewer-dom')) response.end(`<title>Private PDF viewer</title><div class="pdfViewer"><div class="textLayer">${articleText}</div></div>`);
    else if (request.url.startsWith('/viewer')) response.end(`<title>API PDF viewer</title><div class="pdfViewer"><div class="textLayer">${articleText}</div></div><script>window.PDFViewerApplication={pdfDocument:{getData:async()=>Uint8Array.from(atob('${pdf.toString('base64')}'),c=>c.charCodeAt(0))}};</script>`);
    else if (request.url.startsWith('/frame')) response.end(`<title>Frame wrapper</title><p>Small wrapper.</p><iframe src="${origin}/article" style="width:95vw;height:85vh"></iframe>`);
    else if (request.url.startsWith('/shadow')) response.end(`<title>Shadow article</title><sona-story></sona-story><script>document.querySelector('sona-story').attachShadow({mode:'open'}).innerHTML='<article><h1>Shadow content</h1><p>${articleText}</p></article>';</script>`);
    else response.end(`<title>A clean editorial story</title><nav>${'Navigation links. '.repeat(80)}</nav><div class="story"><h1>Reading order matters</h1><p>${articleText}</p><p>Second paragraph contains a clear ending to the actual story.</p></div><div class="sidebar">${'<a href="/advert">Nonsemantic sidebar junk.</a> '.repeat(60)}</div><aside>${'Sidebar junk. '.repeat(100)}</aside><footer>Footer junk.</footer>`);
  });
  const { chromium } = playwright();
  const executable = process.env.CHROME_PATH || '/home/amen/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
  context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), { executablePath: executable, headless: true,
    viewport: { width: 1100, height: 800 }, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', `--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  context.setDefaultTimeout(15000);
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 412, height: 600 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(() => [...document.querySelector('#voice-select').options].some((option) => option.value === 'Sona Offline English'));
  assert.equal((await worker.evaluate(() => chrome.runtime.getManifest())).version, '1.4.0');
  const direct = await context.newPage();
  await direct.goto(`${documentOrigin}/document.pdf`);
  const directId = await tabIdFor(popup, direct);
  const parsed = await extract(popup, directId);
  assert.equal(parsed.source.kind, 'pdf');
  assert.equal(parsed.source.pdf.totalPages, 3);
  for (const number of [1, 2, 3]) assert.ok(parsed.source.text.includes(`This is page ${number}`));
  console.log('PASS: Chrome native PDF tab is read with the real bundled PDF parser.');
  const range = await extract(popup, directId, { pageStart: 2, pageEnd: 2 });
  assert.ok(range.source.text.includes('This is page 2'));
  assert.ok(!range.source.text.includes('This is page 1'));
  assert.equal(range.source.pdf.startPage, 2);
  assert.equal(range.source.pdf.endPage, 2);
  console.log('PASS: explicit PDF page ranges extract only the requested pages.');
  const embedded = await context.newPage();
  await embedded.goto(`${origin}/embed`);
  const embeddedResult = await extract(popup, await tabIdFor(popup, embedded));
  assert.equal(embeddedResult.source.kind, 'pdf');
  assert.ok(embeddedResult.source.text.includes('This is page 3'));
  assert.ok(embeddedResult.documents.some((document) => document.url === `${documentOrigin}/document.pdf`));
  console.log('PASS: embedded cross-origin iframe PDF is detected and parsed automatically.');
  await embedded.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('p'));
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  const selected = await extract(popup, await tabIdFor(popup, embedded));
  assert.equal(selected.source.kind, 'selection');
  assert.equal(selected.source.text, 'A report is embedded below.');
  const chosenPdf = await extract(popup, await tabIdFor(popup, embedded), { mode: 'pdf', pdfUrl: `${documentOrigin}/document.pdf` });
  assert.equal(chosenPdf.source.kind, 'pdf');
  console.log('PASS: automatic detection honors selected text, while an explicit PDF choice loads the document.');
  await embedded.goto(`${origin}/article`);
  const navigated = await extract(popup, await tabIdFor(popup, embedded));
  assert.equal(navigated.source.kind, 'page');
  assert.ok(navigated.source.text.includes(articleText.trim()));
  assert.ok(!navigated.documents.some((document) => document.url === `${documentOrigin}/document.pdf`));
  console.log('PASS: navigating away from a PDF clears earlier document detection.');
  const extensionless = await context.newPage();
  await extensionless.goto(`${origin}/extensionless`);
  await extensionless.waitForTimeout(200);
  const noExtension = await extract(popup, await tabIdFor(popup, extensionless));
  assert.equal(noExtension.source.kind, 'pdf');
  assert.ok(noExtension.source.text.includes('This is page 1'));
  console.log('PASS: MIME detection finds embedded PDF downloads without a .pdf filename.');
  const blob = await context.newPage();
  await blob.goto(`${origin}/blob`);
  await blob.locator('embed').waitFor();
  const blobResult = await extract(popup, await tabIdFor(popup, blob));
  assert.equal(blobResult.source.kind, 'pdf');
  assert.ok(blobResult.source.text.includes('This is page 2'));
  console.log('PASS: in-page blob PDFs are acquired from the page context and parsed locally.');
  const viewer = await context.newPage(); await viewer.goto(`${origin}/viewer`);
  const viewerResult = await extract(popup, await tabIdFor(popup, viewer));
  assert.equal(viewerResult.source.kind, 'pdf');
  assert.ok(viewerResult.source.text.includes('This is page 3'));
  console.log('PASS: PDF.js-style viewers can supply document bytes without a public PDF address.');
  const privateViewer = await context.newPage(); await privateViewer.goto(`${origin}/viewer-dom`);
  const privateViewerResult = await extract(popup, await tabIdFor(popup, privateViewer));
  assert.ok(privateViewerResult.source.text.includes(articleText.trim()));
  console.log('PASS: private document viewers fall back to their readable text layer when bytes are unavailable.');
  const scanned = await context.newPage();
  await scanned.goto(`${documentOrigin}/scanned.pdf`);
  const scannedResult = await extract(popup, await tabIdFor(popup, scanned));
  assert.equal(scannedResult.source.kind, 'pdf');
  assert.equal(scannedResult.source.pdf.ocrPages, 1);
  assert.match(scannedResult.source.text, /Scanned PDF pages can be read locally/iu);
  assert.match(scannedResult.source.text, /English OCR works/iu);
  console.log('PASS: image-only PDF pages are rendered and recognized with real offline English OCR.');
  const hybrid = await send(popup, { type: 'PDF_EXTRACT', url: `${documentOrigin}/mixed.pdf`, requestId: 'mixed-scan' });
  assert.match(hybrid.source.text, /Scanned PDF pages can be read locally/iu);
  assert.equal(hybrid.source.pdf.ocrPages, 1);
  const forced = await send(popup, { type: 'PDF_EXTRACT', url: `${documentOrigin}/document.pdf`, pageStart: 2, pageEnd: 2, forceOcr: true, requestId: 'forced-ocr' });
  assert.match(forced.source.text, /This is page 2/iu);
  assert.equal(forced.source.pdf.ocrPages, 1);
  console.log('PASS: mixed text/image PDFs recognize scanned bodies, and forced OCR can replace a bad text layer.');
  const missingPassword = await send(popup, { type: 'PDF_EXTRACT', url: `${documentOrigin}/encrypted.pdf`, requestId: 'missing-password' });
  assert.match(missingPassword.error, /password/iu);
  const wrongPassword = await send(popup, { type: 'PDF_EXTRACT', url: `${documentOrigin}/encrypted.pdf`, password: 'wrong', requestId: 'wrong-password' });
  assert.match(wrongPassword.error, /incorrect/iu);
  const unlocked = await send(popup, { type: 'PDF_EXTRACT', url: `${documentOrigin}/encrypted.pdf`, password: 'sona-test', requestId: 'correct-password' });
  assert.ok(unlocked.source.text.includes('This is page 3'));
  console.log('PASS: password-protected PDFs prompt clearly and parse after the correct password is supplied.');
  const auth = await context.newPage(); await auth.goto(`${origin}/auth-page`);
  const authenticated = await extract(popup, await tabIdFor(popup, auth));
  assert.ok(authenticated.source.text.includes('This is page 3'));
  console.log('PASS: PDFs requiring page-origin requests use the authenticated page fetch fallback.');
  const pending = send(popup, { type: 'PDF_EXTRACT', url: `${origin}/slow.pdf`, requestId: 'cancel-slow' });
  await popup.waitForTimeout(200);
  await send(popup, { type: 'CANCEL_EXTRACT', requestId: 'cancel-slow' });
  const cancelled = await pending;
  assert.match(cancelled.error, /abort|cancel/iu);
  console.log('PASS: cancelling PDF extraction aborts an unfinished download.');
  const screen = await context.newPage(); await screen.goto(`${origin}/screen`); await screen.bringToFront();
  const recognizedScreen = await send(popup, { type: 'SCAN_TAB', tabId: await tabIdFor(popup, screen), requestId: 'visible-ocr' });
  assert.match(recognizedScreen.source.text, /Visible canvas text can be read/iu);
  assert.equal(recognizedScreen.source.method, 'ocr-screen');
  console.log('PASS: visible canvas-only pages can be read using a real local OCR screenshot.');
  const frame = await context.newPage();
  await frame.goto(`${origin}/frame`);
  const frameResult = await extract(popup, await tabIdFor(popup, frame), { mode: 'page' });
  assert.ok(frameResult.source.frameId > 0);
  assert.ok(frameResult.source.text.includes(articleText.trim()));
  assert.ok(!frameResult.source.text.includes('Sidebar junk'));
  assert.ok(!frameResult.source.text.includes('Navigation links'));
  assert.ok(!frameResult.source.text.includes('Nonsemantic sidebar junk'));
  assert.equal(frameResult.source.method, 'article');
  console.log('PASS: frame-aware article extraction selects meaningful text and excludes navigation/sidebar clutter.');
  const shadow = await context.newPage();
  await shadow.goto(`${origin}/shadow`);
  const shadowResult = await extract(popup, await tabIdFor(popup, shadow), { mode: 'page' });
  assert.ok(shadowResult.source.text.includes('Shadow content'));
  assert.ok(shadowResult.source.text.includes(articleText.trim()));
  console.log('PASS: open shadow-root documents retain their readable text.');
  await popup.locator('.pdf-file').setInputFiles(path.join(fixture, 'document.pdf'));
  await popup.waitForFunction(() => document.querySelector('#text-input').value.includes('This is page 3'));
  assert.ok(await popup.locator('#source-detail').textContent().then((text) => text.includes('PDF')));
  const height = await popup.locator('main').evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(height <= 600, `PDF popup exceeds 600px: ${height}`);
  await popup.locator('#play-button').click();
  await popup.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'GET_STATE' })).state.status === 'playing');
  const state = (await send(popup, { type: 'GET_STATE' })).state;
  assert.equal(state.source.kind, 'pdf');
  assert.equal(state.voice.engine, 'offline');
  await send(popup, { type: 'STOP' });
  console.log('PASS: importing a local PDF updates the real popup and feeds the existing offline speech engine.');
  const reader = await context.newPage();
  await reader.setViewportSize({ width: 390, height: 900 });
  await reader.goto(`chrome-extension://${id}/reader.html`);
  await reader.waitForFunction(() => document.querySelector('#article-text').textContent.includes('This is page 3'));
  const out = process.env.SONA_ARTIFACT_DIR || '/tmp/sona-browser-artifacts'; fs.mkdirSync(out, { recursive: true });
  await reader.screenshot({ path: path.join(out, 'pdf-reader.png') });
  await popup.screenshot({ path: path.join(out, 'pdf-popup.png') });
  assert.deepEqual(errors, [], 'An extension page emitted an uncaught error.');
  console.log('PASS: full PDF text is available in Reader; no uncaught extension UI errors.');
  console.log('NOTE: parsing, rendering, and OCR use bundled assets; no content is sent to an extraction service.');
}
run().catch((error) => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (context) await context.close().catch(() => {});
  for (const value of servers) await new Promise((resolve) => value.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
});
