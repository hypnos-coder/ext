# Sona — Read Aloud

A Speechify-style Chrome extension for listening to webpages, PDFs, selected passages, or pasted text, with automatic reading follow, a movable player, and a persistent reading view. Built in this workspace with JavaScript and Manifest V3. Includes an offline English voice and local English OCR for scanned documents. No build step, account, API key, or separate voice extension is required.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** at the top right.
3. Click **Load unpacked**.
4. Select this folder: `/home/amen/Downloads/code/ext` — the folder containing `manifest.json`.
5. Open Chrome's extensions menu and pin **Sona — Read Aloud**.

When you change the code, click **Reload** on Sona's card in `chrome://extensions`, then refresh your webpage or PDF tab. Version 1.4 adds PDF detection, importing, and local OCR; reloading reads the updated manifest and site access. Chrome's [unpacked extension guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) explains the installation flow.

## Listen

- Open an article and click Sona. Mozilla Readability finds the main text while skipping navigation, hidden elements, and other page clutter. Sona also checks embedded frames and open shadow roots.
- Select a passage before opening Sona to read only that selection. You can also right-click selected text and choose **Read selected text aloud**.
- Choose **Paste text** to listen to copied text. The text box is editable; editing extracted text turns it into pasted text, so it no longer highlights the original page. Changing the source or editing text stops the current reading; click Play to listen to the new text.
- Choose a voice and adjust speed from **0.5× to 3×**. Changes also apply during playback. **Sona Offline English** works without installing an operating-system voice; its **BUNDLED** label identifies it.
- Click **Play**, **Pause**, **Resume**, or **Stop**. The arrow controls move between sentences; very long sentences are split into shorter passages.
- Close the popup to continue listening. A floating page player controls playback and highlights the current sentence. Drag its header to move it. **Minimize reader** collapses it to a small player while keeping highlights; **Expand reader** brings it back. **Hide reader** hides the player and highlight while speech continues; the extension icon can still control it.
- Adjust speed directly on the page player. Drag its progress slider to jump to the containing sentence. Time remaining is an estimate.

## PDFs and scanned pages

- Open a PDF or a page containing a large embedded PDF, then open Sona. **Detect page or PDF** finds the original document and reads its bytes with bundled PDF.js. This works independently of Chrome's PDF viewer text interface.
- The document selector lists detected PDFs, including smaller attachments. Choose one to read it, or choose **Page text** to read the surrounding article. Selected text takes priority during automatic detection.
- Detection checks iframe/embed/object elements, PDF links, viewer URL parameters, and PDF response headers. It also handles extensionless download addresses, page-generated blob/data PDFs, and PDF.js viewers that expose document bytes. When a site requires a page-origin request, Sona retries from the page context.
- Click **Import PDF** to choose a file from your computer. Import works without enabling Chrome's file-URL setting. To open a `file://` PDF or HTML tab directly, enable **Allow access to file URLs** in Sona's extension details.
- Expand **PDF options / scan page** to enter a direct PDF address, choose a page range, or provide a document password. Click **Read PDF** to apply these settings. A password is used for that request and is not saved in the reading draft.
- Image-only pages and pages with sparse text over an image automatically use bundled English OCR. Enable **Use local OCR even if text exists** for a broken or incomplete searchable text layer. Extraction reports progress and can be cancelled.
- **Scan visible page** recognizes the visible area of the active tab, including canvas-based documents. Scroll and scan again for another area; this does not automatically stitch a whole scrolling page.
- Open **Reader** to follow PDF text with sentence highlights, seek, and control playback. PDF text is highlighted in Reader; Chrome's native PDF canvas is not modified. Normal webpage text keeps its existing on-page highlights.

PDF parsing and OCR run on your device. Sona retrieves a web PDF from its original site when necessary; it does not upload documents to an OCR service. The English OCR model and all parser/worker assets ship with the extension. OCR accuracy depends on scan clarity and reading layout; handwritten text, unusual columns, or other languages may need correction. The options let you force OCR, choose a smaller range, or edit the resulting text.

Files are limited to **40 MB**, each extraction to **200 pages**, and extracted text to **100,000 characters**. Select another page range to continue a longer document. Large scanned documents take longer than searchable PDFs. Repeated page headers/footers are removed when detectable, and wrapped hyphenated words are joined.

## Follow, seek, and resume

- **Follow reading** keeps the current sentence visible when it leaves the screen. Scrolling manually suspends following; click **Back to reading** to return. Uncheck Follow reading to turn it off. This preference is shared between the page player and reading view.
- **Read from here:** right-click the paragraph where you want to begin and choose **Read from here**. Sona begins at the containing sentence. Refresh tabs that were open before installing or reloading the extension so its paragraph listener is available.
- Sona remembers the position of the last 50 articles or PDFs. When you reload the same text, the popup and reading view offer **Resume** and **Start over**. Positions also survive Chrome restarts. Changed text or a different PDF page range is treated as a new reading; completed documents do not offer Resume.
- Accurate word highlighting is enabled only for voices that report word boundaries. The bundled English voice highlights sentences and updates progress between passages.

## Reading view

Click **Reader** in the popup, or **Open reading view** on the page player, to open a [Chrome side panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) beside the webpage. It stays available while you read and keeps playback controls visible.

The reading view shows the full extracted text with synchronized highlights. Click a sentence, or focus it and press Enter, to read from there. Adjust text size, switch between light and dark appearance, change voice/speed, seek, and paste your own text. **Load page** imports the currently active page or PDF. The same document selector, file import, PDF options, and visible-page scan are available in Reader.

## Keyboard shortcuts

| Action | Default shortcut |
| --- | --- |
| Open Sona | Alt+Shift+S |
| Pause / resume | Alt+Shift+P |
| Previous sentence | Alt+Shift+Left |
| Next sentence | Alt+Shift+Right |

Playback shortcuts ignore focused text fields and editors on accessible pages and inside Sona. Chrome or your operating system may reserve a suggested key combination. Review or customize bindings at `chrome://extensions/shortcuts`.

The progress display uses spoken text offsets. Voices that do not report word boundaries, including the bundled voice, update progress between passages instead. The current sentence is highlighted for all engines. Estimated listening time is approximate.

## Voices and supported pages

Sona first uses local voices exposed by Chrome's `chrome.tts` API. It also checks browser speech synthesis voices and includes **Sona Offline English**, a fully bundled [meSpeak/eSpeak](https://www.masswerk.at/mespeak/) synthesizer. The bundled voice sounds basic and robotic compared with modern neural voices, but it runs entirely on your device and needs no downloads after installation. It supports English; other languages require a suitable installed or browser voice. This extension does not include Speechify's premium cloud voices.

**Linux:** Chrome may expose no native or browser voices. Sona automatically falls back to the bundled voice. If you previously saw “No local speech voice is available,” reload the extension and choose **Sona Offline English**. On Windows, macOS, and ChromeOS, native voices are generally supplied by the operating system. See the [Chrome TTS documentation](https://developer.chrome.com/docs/extensions/reference/api/tts).

If Chrome exposes online voices, they are labeled **Online**. They require an internet connection and send spoken text to their voice provider; Sona selects them only when you choose one explicitly. The popup identifies the selected voice as **DEVICE**, **BUNDLED**, or **ONLINE**.

Chrome's internal pages and the Chrome Web Store can prevent direct content-script extraction even with site access. For documents with no accessible URL or text interface, use **Import PDF**, a direct PDF address, **Scan visible page** where Chrome allows capture, or **Paste text**. Sona reads the original PDF rather than injecting into Chrome's protected viewer interface. Audio downloads and premium AI voices are outside this version.

## Data and permissions

The bundled voice, PDF parser, and OCR send no document text to a processing server; their code, dictionary, and English OCR model ship with the extension. There are no analytics calls. Optional online voices use the browser's speech provider. Settings and reading appearance are saved on your device. Reading text, the latest extracted document, and the pasted draft stay in Chrome's session storage, which clears when Chrome restarts or the extension reloads. It keeps one playback session at a time; starting another replaces it. Imported file bytes and PDF passwords are not persisted.

Saved article positions persist locally across restarts. They contain the page URL, title, character offset, timestamp, and a text fingerprint; they do not contain the article's text. The history is limited to 50 entries. Pasted text has no durable article checkpoint.

Version 1.4 requests `<all_urls>` site access, along with `activeTab`, `tabs`, `scripting`, `storage`, `tts`, `contextMenus`, `offscreen`, `sidePanel`, `webNavigation`, and `webRequest`. This supports text detection across frames, PDF response detection, authenticated PDF retrieval, and local-file tabs when file access is enabled. The PDF response listener only observes content-type headers; it does not alter requests. The offscreen document parses PDFs, runs OCR, and plays generated audio after the popup closes. The side panel hosts the reading view. Page highlighting uses ranges without rewriting the page's text.

While playing, a periodic extension API call keeps the background worker available to advance between passages. If Chrome suspends the worker or closes the audio document after a long pause, Sona restores the session as paused and resumes from the latest saved text position. For the bundled voice, that means restarting the current passage. It does not resume automatically after a browser restart.

## Development and verification

Loading the extension does **not** require Node or npm. With Node 18+ installed:

```sh
npm run check
npm test
```

`check` validates the manifest, packaged files, CSP basics, and JavaScript syntax. Unit tests exercise sentence splitting, voice filtering, native and offline playback, interruption handling, worker/audio-document recovery, and PDF text layout.

The browser smoke test additionally requires Playwright and a Chromium executable:

```sh
npm run test:browser
npm run test:fallback
npm run test:reader
npm run test:documents
# Optional overrides for your installed tools:
PLAYWRIGHT_PATH=/path/to/playwright CHROME_PATH=/path/to/chromium npm run test:browser
```

The tests launch isolated temporary profiles and local fixture servers. `test:browser` uses a deterministic Chrome TTS double for native-engine controls. `test:fallback` uses the real bundled synthesizer without speech or audio mocks: it checks nonzero WAV samples, actual playback time, pause/resume, popup closure, page controls, highlighting, completion, and stop. `test:reader` covers follow behavior, movable/compact controls, seeking, paragraph targeting, the reading view, typing guards, and saved positions across a browser restart. `test:documents` uses the real bundled PDF parser and OCR engine to check standalone, embedded, extensionless, blob, scanned, mixed, and password-protected PDFs, page ranges, page-origin requests, cancellation, visible-area OCR, framed/shadow-root text, file importing, and offline playback. These checks cannot assess sound quality through physical speakers. Temporary copies and profiles leave the production extension's files unchanged.

The bundled meSpeak dependency is distributed with its GPLv3 license, upstream readable source, and modification notes in [vendor/mespeak/SOURCES.md](vendor/mespeak/SOURCES.md).

The extraction dependencies include their licenses and archive provenance: [Mozilla Readability](vendor/readability/SOURCES.md), [PDF.js](vendor/pdfjs/SOURCES.md), [Tesseract.js](vendor/tesseract/SOURCES.md), [OCR core](vendor/tesseract/core/SOURCES.md), and the [English OCR model](vendor/tesseract/lang/SOURCES.md). Runtime assets are bundled locally; installing the extension does not fetch dependencies.
