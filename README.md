# Sona — Read Aloud

A Speechify-style Chrome extension for listening to webpages, selected passages, or pasted text. Built in this workspace with JavaScript and Manifest V3. Includes an offline English voice, so it works even when Chrome has no installed speech voices. No build step, account, API key, or separate voice extension is required.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** at the top right.
3. Click **Load unpacked**.
4. Select this folder: `/home/amen/Downloads/code/ext` — the folder containing `manifest.json`.
5. Open Chrome's extensions menu and pin **Sona — Read Aloud**.

When you change the code, click **Reload** on Sona's card in `chrome://extensions`, then refresh any webpage where its player was already injected. If upgrading from 1.1, this reload loads the new bundled voice and offscreen-player permission. Chrome's [unpacked extension guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) explains the installation flow.

## Listen

- Open an article and click Sona. It extracts the main text while skipping navigation, hidden elements, and other page clutter.
- Select a passage before opening Sona to read only that selection. You can also right-click selected text and choose **Read selected text aloud**.
- Choose **Paste text** to listen to copied text. The text box is editable; editing extracted text turns it into pasted text, so it no longer highlights the original page. Changing the source or editing text stops the current reading; click Play to listen to the new text.
- Choose a voice and adjust speed from **0.5× to 3×**. Changes also apply during playback. **Sona Offline English** works without installing an operating-system voice; its **BUNDLED** label identifies it.
- Click **Play**, **Pause**, **Resume**, or **Stop**. The arrow controls move between sentences; very long sentences are split into shorter passages.
- Close the popup to continue listening. A floating page player controls playback and highlights the current sentence. **Hide reader** hides the panel and highlight while speech continues; the extension icon can still control it.
- Press **Alt+Shift+S** to open Sona. Change the shortcut at `chrome://extensions/shortcuts` if another app uses it.

The progress display uses spoken text offsets. Voices that do not report word boundaries, including the bundled voice, update progress between passages instead. The current sentence is highlighted for all engines. Estimated listening time is approximate.

## Voices and supported pages

Sona first uses local voices exposed by Chrome's `chrome.tts` API. It also checks browser speech synthesis voices and includes **Sona Offline English**, a fully bundled [meSpeak/eSpeak](https://www.masswerk.at/mespeak/) synthesizer. The bundled voice sounds basic and robotic compared with modern neural voices, but it runs entirely on your device and needs no downloads after installation. It supports English; other languages require a suitable installed or browser voice. This extension does not include Speechify's premium cloud voices.

**Linux:** Chrome may expose no native or browser voices. Sona automatically falls back to the bundled voice. If you previously saw “No local speech voice is available,” reload the extension and choose **Sona Offline English**. On Windows, macOS, and ChromeOS, native voices are generally supplied by the operating system. See the [Chrome TTS documentation](https://developer.chrome.com/docs/extensions/reference/api/tts).

If Chrome exposes online voices, they are labeled **Online**. They require an internet connection and send spoken text to their voice provider; Sona selects them only when you choose one explicitly. The popup identifies the selected voice as **DEVICE**, **BUNDLED**, or **ONLINE**.

Chrome's internal pages, the Chrome Web Store, the built-in PDF viewer, some embedded documents, and canvas-based editors cannot expose ordinary page text to this extension. Copy their text into **Paste text**. For local HTML files, enable **Allow access to file URLs** in Sona's extension details. OCR, PDF importing, audio downloads, and premium AI voices are outside this version.

## Data and permissions

The bundled and local voices send no text to a server; their code and English dictionary ship with the extension. There are no analytics calls. Optional online voices use the browser's speech provider. Settings are saved on your device. Reading text, the latest pasted draft, and playback position are stored in Chrome's session storage, which clears when Chrome restarts or the extension reloads. It keeps one playback session at a time; starting another replaces it.

Permissions are limited to `activeTab`, `scripting`, `storage`, `tts`, `contextMenus`, and `offscreen`. The offscreen document plays generated audio after the popup closes. Access to a page is granted when you invoke the extension; it does not request permanent access to all websites. Content extraction is capped at 100,000 characters. Page highlighting uses ranges without rewriting the page's text.

While playing, a periodic extension API call keeps the background worker available to advance between passages. If Chrome suspends the worker or closes the audio document after a long pause, Sona restores the session as paused and resumes from the latest saved text position. For the bundled voice, that means restarting the current passage. It does not resume automatically after a browser restart.

## Development and verification

Loading the extension does **not** require Node or npm. With Node 18+ installed:

```sh
npm run check
npm test
```

`check` validates the manifest, packaged files, CSP basics, and JavaScript syntax. Unit tests exercise sentence splitting, voice filtering, native and offline playback, interruption handling, and worker/audio-document recovery.

The browser smoke test additionally requires Playwright and a Chromium executable:

```sh
npm run test:browser
npm run test:fallback
# Optional overrides for your installed tools:
PLAYWRIGHT_PATH=/path/to/playwright CHROME_PATH=/path/to/chromium npm run test:browser
```

The tests launch isolated temporary profiles and use a temporary extension copy with access limited to its localhost fixture. `test:browser` uses a deterministic Chrome TTS double for native-engine controls. `test:fallback` uses the real bundled synthesizer without speech or audio mocks: it checks nonzero WAV samples, actual playback time, pause/resume, popup closure, page controls, highlighting, completion, and stop. These checks validate generated speech and playback, but cannot assess sound quality through physical speakers. The production extension's permissions and files are unchanged by the tests.

The bundled meSpeak dependency is distributed with its GPLv3 license, upstream readable source, and modification notes in [vendor/mespeak/SOURCES.md](vendor/mespeak/SOURCES.md).
