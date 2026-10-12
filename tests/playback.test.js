"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const helpers = require("../playback.js");
const root = path.resolve(__dirname, "..");
const clone = (value) => JSON.parse(JSON.stringify(value));

function createWorker({ voices, snapshot, preferences, rejectBroadcast = false,
  pageResponse, restrictedPage = false, offscreenVoices,
  offscreenCreateError = "", offscreenSpeakError = "" } = {}) {
  const listeners = {};
  const event = (name) => ({ addListener(listener) { listeners[name] = listener; } });
  const utterances = [];
  const offscreenUtterances = [];
  const offscreenMessages = [];
  const offscreenDocuments = [];
  const broadcasts = [];
  const tabMessages = [];
  const badges = [];
  const injections = [];
  const timeouts = new Map();
  const intervals = new Map();
  const local = { ...(preferences || {}) };
  const session = snapshot ? { readerPlaybackSession: clone(snapshot) } : {};
  let timerId = 0;
  let active = null;
  let stopCount = 0;
  let pauseCount = 0;
  let resumeCount = 0;
  let platformCalls = 0;
  let nextSpeakError = "";
  let offscreenContextPresent = false;
  let offscreenAudioExpired = false;
  const chrome = {
    runtime: {
      id: "reader-test",
      getURL: (value) => `chrome-extension://reader-test/${value}`,
      getPlatformInfo: async () => { platformCalls += 1; return {}; },
      getContexts: async () => offscreenContextPresent
        ? [{ contextType: "OFFSCREEN_DOCUMENT", documentUrl: chrome.runtime.getURL("offscreen.html") }] : [],
      onMessage: event("message"), onInstalled: event("installed"),
      sendMessage: async (message) => {
        if (message.target === "sona-offscreen") {
          offscreenMessages.push(clone(message));
          if (!offscreenContextPresent) throw new Error("Receiving end does not exist");
          const command = message.type;
          if (command === "GET_VOICES") return { voices: offscreenVoices || [
            { voiceName: "Sona Offline English", lang: "en-US", remote: false, engine: "offline", eventTypes: ["end", "word"] }
          ] };
          if (command === "SPEAK") {
            if (offscreenSpeakError) throw new Error(offscreenSpeakError);
            offscreenUtterances.push(clone(message));
            offscreenAudioExpired = false;
          }
          if (command === "RESUME" && offscreenAudioExpired) return { ok: true, resumed: false };
          if (command === "PAUSE" && offscreenAudioExpired) return { ok: true, missing: true };
          if (command === "STOP") offscreenAudioExpired = true;
          return { ok: true };
        }
        broadcasts.push(clone(message));
        if (rejectBroadcast) throw new Error("No popup is open");
      }
    },
    offscreen: {
      createDocument: async (options) => {
        if (offscreenCreateError) throw new Error(offscreenCreateError);
        offscreenDocuments.push(clone(options));
        offscreenContextPresent = true;
      }
    },
    tabs: { sendMessage: async (tabId, message, options) => {
      tabMessages.push({ tabId, message: clone(message), options: clone(options || {}) });
      return message.type === "READ_PAGE" ? pageResponse : undefined;
    } },
    scripting: { executeScript: async (options) => {
      injections.push(clone(options));
      if (restrictedPage) throw new Error("Cannot access this page");
    } },
    storage: {
      local: { get: async () => clone(local), set: async (value) => { Object.assign(local, clone(value)); } },
      session: { get: async () => clone(session), set: async (value) => { Object.assign(session, clone(value)); } }
    },
    action: {
      setBadgeText: async (value) => { badges.push(value.text); },
      setBadgeBackgroundColor: async () => {}, setTitle: async () => {}
    },
    contextMenus: {
      onClicked: event("menu"), removeAll: (callback) => callback(),
      create: (value, callback) => { listeners.createdMenu = value; callback(); }
    },
    tts: {
      getVoices: async () => voices || [{ voiceName: "Local voice", lang: "en-US", remote: false, eventTypes: ["end", "word"] }],
      speak(text, options, callback) {
        const utterance = { text, options, callback };
        utterances.push(utterance);
        active = utterance;
        if (nextSpeakError) {
          chrome.runtime.lastError = { message: nextSpeakError };
          nextSpeakError = "";
          callback();
          delete chrome.runtime.lastError;
        } else callback();
      },
      stop() {
        stopCount += 1;
        const old = active;
        active = null;
        // A synchronous stop callback reproduces the original race condition.
        old?.options.onEvent({ type: "interrupted" });
      },
      pause() { pauseCount += 1; active?.options.onEvent({ type: "pause" }); },
      resume() { resumeCount += 1; active?.options.onEvent({ type: "resume" }); }
    }
  };
  const context = vm.createContext({
    chrome, Intl, console, crypto: { randomUUID: () => `session-${stopCount}` },
    navigator: { language: "en-US" },
    setTimeout: (callback, delay) => { const id = ++timerId; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (callback, delay) => { const id = ++timerId; intervals.set(id, { callback, delay }); return id; },
    clearInterval: (id) => intervals.delete(id)
  });
  context.importScripts = (file) => vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context);
  const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") };
  return {
    chrome, utterances, broadcasts, tabMessages, injections, intervals, local, session, badges, listeners,
    offscreenUtterances, offscreenMessages, offscreenDocuments,
    get stopCount() { return stopCount; }, get pauseCount() { return pauseCount; },
    get resumeCount() { return resumeCount; }, get platformCalls() { return platformCalls; },
    failNextSpeak(message) { nextSpeakError = message; },
    loseOffscreenContext() { offscreenContextPresent = false; },
    expireOffscreenAudio() { offscreenAudioExpired = true; },
    async emitOffscreen(eventValue, utterance = offscreenUtterances.at(-1), from) {
      assert.ok(utterance, "There must be an offscreen utterance for the event");
      listeners.message({ type: "OFFSCREEN_TTS_EVENT", token: utterance.token, event: eventValue },
        from || { id: chrome.runtime.id, url: chrome.runtime.getURL("offscreen.html") }, () => {});
      await new Promise((resolve) => setImmediate(resolve));
    },
    emit(eventValue, utterance = active) {
      assert.ok(utterance, "There must be an utterance for the event");
      if (["end", "error", "interrupted", "cancelled"].includes(eventValue.type) && utterance === active) active = null;
      utterance.options.onEvent(eventValue);
    },
    async send(message, from = sender) {
      return new Promise((resolve) => {
        const accepted = listeners.message(message, from, (response) => resolve(clone(response)));
        if (accepted === false) resolve(undefined);
      });
    },
    async flush() {
      for (const [id, timer] of timeouts) { timeouts.delete(id); timer.callback(); }
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

const start = (worker, text = "First sentence. Second sentence. Third sentence.", options = {}) =>
  worker.send({ type: "START", source: { text, title: "Article", url: "https://example.com/article", kind: "page", id: "source-1", tabId: 7 }, ...options });

test("sentence chunks preserve offsets and never exceed the utterance limit", () => {
  const text = `  First sentence.\nSecond one? ${"word ".repeat(900)}Done! ${"x".repeat(4500)} 😀 End.`;
  const segments = helpers.splitSegments(text);
  assert.equal(segments[0].text, "First sentence.");
  assert.equal(segments[1].text, "Second one?");
  for (const segment of segments) {
    assert.equal(segment.text, text.slice(segment.start, segment.end));
    assert.ok(segment.text.length <= 1800);
    assert.ok(segment.text.length > 0);
  }
  // Only whitespace may be omitted at sentence and chunk boundaries.
  assert.equal(segments.map((segment) => segment.text).join("").replace(/\s/gu, ""), text.replace(/\s/gu, ""));
  assert.deepEqual(helpers.splitSegments("  \n "), []);
});

test("local voice selection excludes remote voices and voices lacking end events", () => {
  const remote = { voiceName: "Cloud", remote: true, lang: "en-US", eventTypes: ["end"] };
  const broken = { voiceName: "No progress", eventTypes: ["word"] };
  const french = { voiceName: "French", lang: "fr-FR", remote: false };
  const english = { voiceName: "English", lang: "en-US", eventTypes: ["end"] };
  assert.equal(helpers.chooseLocalVoice([remote, broken, french, english], "Cloud"), english);
  assert.equal(helpers.chooseLocalVoice([french, english], "French"), french);
  assert.equal(helpers.chooseLocalVoice([remote, broken]), null);
});

test("input settings and text limits are applied before speech", async () => {
  const worker = createWorker();
  const { state } = await start(worker, `  ${"word ".repeat(25000)}  `, { settings: { rate: 90, voiceName: "" } });
  assert.equal(state.status, "playing");
  assert.ok(state.source.text.length <= 100000);
  assert.equal(state.source.truncated, true);
  assert.equal(state.totalCharacters, state.source.text.length);
  assert.equal(state.settings.rate, 3);
  assert.equal(worker.utterances[0].options.rate, 3);
  const response = await worker.send({ type: "SETTINGS", settings: { rate: -10 } });
  assert.equal(response.state.settings.rate, 0.5);
  assert.equal(worker.local.rate, 0.5);
  assert.equal(helpers.normalizeSettings(null).rate, 1);
  assert.equal(helpers.normalizeSource(null).text, "");
});

test("speech proceeds through sentences without an open popup and broadcasts safe page state", async () => {
  const worker = createWorker({ rejectBroadcast: true });
  await start(worker);
  worker.emit({ type: "word", charIndex: 6, length: 8 });
  let { state } = await worker.send({ type: "GET_STATE" });
  assert.equal(state.charIndex, 6);
  assert.equal(state.charLength, 8);
  assert.equal(state.segmentStart, 0);
  assert.equal(state.segmentEnd, 15);
  assert.equal(state.totalSegments, 3);
  assert.equal(state.progress, 6 / state.source.text.length);
  const page = worker.tabMessages.at(-1);
  assert.equal(page.tabId, 7);
  assert.equal(page.message.type, "READER_STATE");
  assert.equal(page.message.state.source.id, "source-1");
  assert.equal(Object.hasOwn(page.message.state.source, "text"), false);
  worker.emit({ type: "end" });
  assert.equal(worker.utterances[1].text, "Second sentence.");
  worker.emit({ type: "word", charIndex: 7, length: 8 });
  state = (await worker.send({ type: "GET_STATE" })).state;
  assert.equal(state.charIndex, 23);
  assert.equal(state.currentIndex, 1);
  worker.emit({ type: "end" });
  worker.emit({ type: "end" });
  state = (await worker.send({ type: "GET_STATE" })).state;
  assert.equal(state.status, "finished");
  assert.equal(state.progress, 1);
  assert.equal(state.charLength, 0);
  assert.equal(worker.intervals.size, 0);
  await worker.flush();
  assert.equal(worker.session.readerPlaybackSession.status, "finished");
});

test("stop callbacks and delayed events cannot corrupt new sessions", async () => {
  const worker = createWorker();
  const oldState = (await start(worker, "Old reading. Another old sentence.")).state;
  const oldUtterance = worker.utterances[0];
  const nextState = (await start(worker, "New reading. A new sentence.")).state;
  assert.notEqual(nextState.sessionId, oldState.sessionId);
  worker.emit({ type: "end" }, oldUtterance);
  worker.emit({ type: "error", errorMessage: "Stale failure" }, oldUtterance);
  oldUtterance.callback();
  let state = (await worker.send({ type: "GET_STATE" })).state;
  assert.equal(state.status, "playing");
  assert.equal(state.currentIndex, 0);
  assert.equal(state.source.text, "New reading. A new sentence.");
  const current = worker.utterances.at(-1);
  state = (await worker.send({ type: "STOP" })).state;
  assert.equal(state.status, "idle");
  assert.equal(state.progress, 0);
  worker.emit({ type: "end" }, current);
  assert.equal((await worker.send({ type: "GET_STATE" })).state.status, "idle");
});

test("pause resumes native speech and sentence skipping preserves pause", async () => {
  const worker = createWorker();
  await start(worker);
  worker.emit({ type: "word", charIndex: 6, length: 8 });
  assert.equal((await worker.send({ type: "PAUSE" })).state.status, "paused");
  assert.equal(worker.pauseCount, 1);
  assert.equal(worker.intervals.size, 0);
  assert.equal((await worker.send({ type: "RESUME" })).state.status, "playing");
  assert.equal(worker.resumeCount, 1);
  assert.equal(worker.utterances.length, 1);
  await worker.send({ type: "PAUSE" });
  const skipped = (await worker.send({ type: "SKIP", direction: 1 })).state;
  assert.equal(skipped.status, "paused");
  assert.equal(skipped.currentIndex, 1);
  assert.equal(skipped.charIndex, 16);
  assert.equal(worker.utterances.length, 1);
  await worker.send({ type: "RESUME" });
  assert.equal(worker.utterances.at(-1).text, "Second sentence.");
  await worker.send({ type: "SKIP", direction: -1 });
  assert.equal(worker.utterances.at(-1).text, "First sentence.");
});

test("rate changes restart from the current word boundary without accepting stale end events", async () => {
  const worker = createWorker();
  await start(worker);
  const old = worker.utterances[0];
  worker.emit({ type: "word", charIndex: 6, length: 8 });
  await worker.send({ type: "SETTINGS", settings: { rate: 1.75 } });
  assert.equal(worker.utterances[1].text, "sentence.");
  assert.equal(worker.utterances[1].options.rate, 1.75);
  worker.emit({ type: "end" }, old);
  assert.equal(worker.utterances.length, 2);
  worker.emit({ type: "word", charIndex: 2, length: 4 });
  assert.equal((await worker.send({ type: "GET_STATE" })).state.charIndex, 8);
  await worker.send({ type: "PAUSE" });
  await worker.send({ type: "SETTINGS", settings: { rate: 2 } });
  assert.equal(worker.utterances.length, 2);
  await worker.send({ type: "RESUME" });
  assert.equal(worker.utterances.at(-1).text, "ntence.");
  assert.equal(worker.utterances.at(-1).options.rate, 2);
});

test("worker recovery pauses speech and resumes at the saved boundary", async () => {
  const first = createWorker();
  await start(first);
  first.emit({ type: "word", charIndex: 6, length: 8 });
  await first.flush();
  const worker = createWorker({ snapshot: first.session.readerPlaybackSession });
  const { state } = await worker.send({ type: "GET_STATE" });
  assert.equal(state.status, "paused");
  assert.equal(state.recovered, true);
  assert.equal(state.charIndex, 6);
  assert.equal(worker.stopCount, 1);
  assert.equal(worker.utterances.length, 0);
  await worker.send({ type: "RESUME" });
  assert.equal(worker.utterances[0].text, "sentence.");
  assert.equal((await worker.send({ type: "GET_STATE" })).state.recovered, false);
});

test("only active speech keeps the service worker alive", async () => {
  const worker = createWorker();
  await worker.send({ type: "GET_STATE" });
  assert.equal(worker.intervals.size, 0);
  await start(worker);
  assert.equal(worker.intervals.size, 1);
  const timer = [...worker.intervals.values()][0];
  assert.equal(timer.delay, 20000);
  timer.callback();
  assert.equal(worker.platformCalls, 1);
  await worker.send({ type: "STOP" });
  assert.equal(worker.intervals.size, 0);
});

test("unavailable offscreen documents and Chrome API errors produce useful terminal states", async () => {
  const unavailable = createWorker({ voices: [], offscreenCreateError: "Offscreen audio is unavailable" });
  await start(unavailable);
  await unavailable.flush();
  const result = await unavailable.send({ type: "GET_STATE" });
  assert.equal(result.state.status, "error");
  assert.match(result.state.error, /Offscreen audio is unavailable/);
  assert.equal(unavailable.utterances.length, 0);
  assert.equal(unavailable.offscreenUtterances.length, 0);
  assert.equal(unavailable.intervals.size, 0);
  const worker = createWorker();
  worker.failNextSpeak("Voice is unavailable");
  assert.equal((await start(worker)).state.error, "Voice is unavailable");
  assert.equal(worker.intervals.size, 0);
});

test("voice discovery exposes the bundled offline fallback and default speech uses it without native voices", async () => {
  const worker = createWorker({ voices: [{ voiceName: "Network", lang: "en-US", remote: true }] });
  const { voices } = await worker.send({ type: "GET_VOICES" });
  const offline = voices.find((voice) => voice.engine === "offline");
  assert.equal(offline.voiceName, "Sona Offline English");
  assert.equal(offline.remote, false);
  assert.equal(offline.lang, "en-US");
  assert.equal((await start(worker)).state.status, "playing");
  await worker.flush();
  assert.equal(worker.utterances.length, 0);
  assert.equal(worker.offscreenUtterances.length, 1);
  assert.equal(worker.offscreenUtterances[0].voiceName, offline.voiceName);
  assert.equal(worker.offscreenUtterances[0].engine, "offline");
  assert.equal(worker.offscreenUtterances[0].text, "First sentence.");
  assert.equal(worker.offscreenUtterances[0].rate, 1);
  assert.equal(worker.offscreenDocuments.length, 1);
});

test("installed local voices keep priority over the bundled offline fallback", async () => {
  const worker = createWorker();
  await worker.send({ type: "GET_VOICES" });
  await start(worker);
  assert.equal(worker.utterances[0].options.voiceName, "Local voice");
  assert.equal(worker.offscreenUtterances.length, 0);
});

test("browser cloud voices require explicit selection instead of becoming the offline default", async () => {
  const worker = createWorker({ voices: [], offscreenVoices: [
    { voiceName: "Browser cloud English", lang: "en-US", remote: true, engine: "web", eventTypes: ["end", "word"] },
    { voiceName: "Sona Offline English", lang: "en-US", remote: false, engine: "offline", eventTypes: ["end", "word"] }
  ] });
  await start(worker);
  await worker.flush();
  assert.equal(worker.offscreenUtterances[0].voiceName, "Sona Offline English");
  await worker.send({ type: "SETTINGS", settings: { voiceName: "Browser cloud English" } });
  await worker.flush();
  assert.equal(worker.offscreenUtterances.at(-1).voiceName, "Browser cloud English");
  assert.equal(worker.offscreenUtterances.at(-1).engine, "web");
  assert.equal(worker.local.voiceName, "Browser cloud English");
});

test("offscreen word and end events advance reading while stale and untrusted events are ignored", async () => {
  const worker = createWorker({ voices: [] });
  await start(worker);
  await worker.flush();
  const first = worker.offscreenUtterances[0];
  await worker.emitOffscreen({ type: "word", charIndex: 6, length: 8 });
  let state = (await worker.send({ type: "GET_STATE" })).state;
  assert.equal(state.charIndex, 6);
  assert.equal(state.charLength, 8);
  assert.equal(worker.tabMessages.at(-1).message.state.charIndex, 6);
  await worker.emitOffscreen({ type: "end" }, first,
    { id: worker.chrome.runtime.id, url: "https://example.com", tab: { id: 7 } });
  assert.equal(worker.offscreenUtterances.length, 1);
  await worker.emitOffscreen({ type: "end" });
  assert.equal(worker.offscreenUtterances[1].text, "Second sentence.");
  await worker.emitOffscreen({ type: "end" }, first);
  await worker.emitOffscreen({ type: "error", errorMessage: "Stale audio error" }, first);
  state = (await worker.send({ type: "GET_STATE" })).state;
  assert.equal(state.status, "playing");
  assert.equal(state.currentIndex, 1);
  assert.equal(worker.offscreenUtterances.length, 2);
  await worker.emitOffscreen({ type: "end" });
  await worker.emitOffscreen({ type: "end" });
  state = (await worker.send({ type: "GET_STATE" })).state;
  assert.equal(state.status, "finished");
  assert.equal(state.progress, 1);
  assert.equal(worker.intervals.size, 0);
});

test("offline pause, resume, settings and stop control the active audio engine", async () => {
  const worker = createWorker({ voices: [] });
  await start(worker);
  await worker.flush();
  const first = worker.offscreenUtterances[0];
  await worker.emitOffscreen({ type: "word", charIndex: 6, length: 8 });
  assert.equal((await worker.send({ type: "PAUSE" })).state.status, "paused");
  assert.equal(worker.offscreenMessages.at(-1).type, "PAUSE");
  assert.equal(worker.pauseCount, 0);
  assert.equal((await worker.send({ type: "RESUME" })).state.status, "playing");
  assert.equal(worker.offscreenMessages.at(-1).type, "RESUME");
  assert.equal(worker.resumeCount, 0);
  assert.equal(worker.offscreenUtterances.length, 1);
  await worker.send({ type: "SETTINGS", settings: { rate: 1.75 } });
  await worker.flush();
  assert.equal(worker.offscreenUtterances[1].text, "sentence.");
  assert.equal(worker.offscreenUtterances[1].rate, 1.75);
  await worker.emitOffscreen({ type: "end" }, first);
  assert.equal(worker.offscreenUtterances.length, 2);
  const current = worker.offscreenUtterances.at(-1);
  assert.equal((await worker.send({ type: "STOP" })).state.status, "idle");
  await worker.flush();
  assert.equal(worker.offscreenMessages.at(-1).type, "STOP");
  await worker.emitOffscreen({ type: "end" }, current);
  assert.equal((await worker.send({ type: "GET_STATE" })).state.status, "idle");
  assert.equal(worker.intervals.size, 0);
});

test("resuming after the paused offscreen document disappears regenerates from the saved word", async () => {
  const worker = createWorker({ voices: [] });
  await start(worker);
  await worker.flush();
  await worker.emitOffscreen({ type: "word", charIndex: 6, length: 8 });
  await worker.send({ type: "PAUSE" });
  worker.loseOffscreenContext();
  await worker.send({ type: "RESUME" });
  await worker.flush();
  const state = (await worker.send({ type: "GET_STATE" })).state;
  assert.equal(state.status, "playing");
  assert.equal(state.charIndex, 6);
  assert.equal(worker.offscreenDocuments.length, 2);
  assert.equal(worker.offscreenUtterances.at(-1).text, "sentence.");
});

test("an existing offscreen document with expired audio regenerates at the saved word", async () => {
  const worker = createWorker({ voices: [] });
  await start(worker);
  await worker.flush();
  const first = worker.offscreenUtterances[0];
  await worker.emitOffscreen({ type: "word", charIndex: 6, length: 8 });
  await worker.send({ type: "PAUSE" });
  worker.expireOffscreenAudio();
  await worker.send({ type: "RESUME" });
  await worker.flush();
  let state = (await worker.send({ type: "GET_STATE" })).state;
  assert.equal(state.status, "playing");
  assert.equal(state.charIndex, 6);
  assert.equal(worker.offscreenDocuments.length, 1);
  assert.equal(worker.offscreenUtterances.length, 2);
  assert.equal(worker.offscreenUtterances.at(-1).text, "sentence.");
  await worker.emitOffscreen({ type: "end" }, first);
  assert.equal(worker.offscreenUtterances.length, 2);

  // Expiration before pause also clears the pending session instead of
  // reporting a successful resume for audio that no longer exists.
  await worker.emitOffscreen({ type: "word", charIndex: 2, length: 6 });
  worker.expireOffscreenAudio();
  assert.equal((await worker.send({ type: "PAUSE" })).state.status, "paused");
  await worker.send({ type: "RESUME" });
  await worker.flush();
  state = (await worker.send({ type: "GET_STATE" })).state;
  assert.equal(state.status, "playing");
  assert.equal(state.charIndex, 8);
  assert.equal(worker.offscreenDocuments.length, 1);
  assert.equal(worker.offscreenUtterances.length, 3);
  assert.equal(worker.offscreenUtterances.at(-1).text, "ntence.");
});

test("offline playback failures end the session with a useful error", async () => {
  const worker = createWorker({ voices: [], offscreenSpeakError: "Bundled voice could not generate audio" });
  await start(worker);
  await worker.flush();
  const state = (await worker.send({ type: "GET_STATE" })).state;
  assert.equal(state.status, "error");
  assert.match(state.error, /Bundled voice could not generate audio/);
  assert.equal(worker.intervals.size, 0);
});

test("messages reject unrelated senders and bind content sources to their own tab", async () => {
  const worker = createWorker();
  assert.match((await worker.send({ type: "START", source: { text: "Read." } },
    { id: "some-other-extension", url: "https://example.com", tab: { id: 5 } })).error, /Only this extension/);
  assert.equal(worker.utterances.length, 0);
  const response = await start(worker, "Read from content.");
  assert.equal(response.state.source.tabId, 7);
  const from = { id: worker.chrome.runtime.id, url: "https://example.com", tab: { id: 5 } };
  const result = await worker.send({ type: "START", source: { text: "From content.", tabId: 999 } }, from);
  assert.equal(result.state.source.tabId, 5);
  assert.match((await worker.send({ type: "SKIP", direction: 15 })).error, /direction/);
  assert.match((await worker.send({ type: "START", source: null })).error, /Choose a page/);
});

test("selection context menu creates a complete reading session", async () => {
  const worker = createWorker();
  worker.listeners.installed();
  assert.equal(worker.listeners.createdMenu.id, "reader-read-selection");
  worker.listeners.menu({ menuItemId: "reader-read-selection", selectionText: "A selected sentence.", pageUrl: "https://example.com" },
    { id: 4, title: "Selection article" });
  const { state } = await worker.send({ type: "GET_STATE" });
  assert.equal(state.status, "playing");
  assert.equal(state.source.kind, "selection");
  assert.equal(state.source.tabId, 4);
  assert.equal(worker.utterances[0].text, "A selected sentence.");
});

test("switching to pasted text clears the previous article overlay", async () => {
  const worker = createWorker();
  await start(worker);
  const previousCount = worker.tabMessages.length;
  await worker.send({ type: "START", source: { text: "Pasted reading.", kind: "text" } });
  const cleared = worker.tabMessages.slice(previousCount);
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].tabId, 7);
  assert.equal(cleared[0].message.state.status, "idle");
  assert.equal(cleared[0].message.state.charLength, 0);
});

test("an extension page opened in a tab retains the requested article tab", async () => {
  const worker = createWorker();
  const from = { id: worker.chrome.runtime.id, url: worker.chrome.runtime.getURL("popup.html"), tab: { id: 99 } };
  const result = await worker.send({ type: "START", source: { text: "Article.", tabId: 7 } }, from);
  assert.equal(result.state.source.tabId, 7);
});

test("selection context menu injects the floating player and keeps the extraction mapping", async () => {
  const worker = createWorker({ pageResponse: { source: {
    id: "mapped-selection", text: "Normalized selected sentence.", kind: "selection",
    title: "Article title", url: "https://example.com/frame", truncated: false
  } } });
  worker.listeners.menu({ menuItemId: "reader-read-selection", selectionText: "Unnormalized selection", frameId: 2 },
    { id: 4, title: "Selection article" });
  const { state } = await worker.send({ type: "GET_STATE" });
  assert.deepEqual(worker.injections[0], { target: { tabId: 4, frameIds: [2] }, files: ["content.js"] });
  assert.equal(state.source.id, "mapped-selection");
  assert.equal(state.source.text, "Normalized selected sentence.");
  assert.equal(state.source.frameId, 2);
  assert.equal(worker.tabMessages.at(-1).message.type, "READER_STATE");
  assert.equal(worker.tabMessages.at(-1).options.frameId, 2);
});

test("selection context menu still reads restricted-page selections", async () => {
  const worker = createWorker({ restrictedPage: true });
  worker.listeners.menu({ menuItemId: "reader-read-selection", selectionText: "Restricted selected text." },
    { id: 4, title: "A PDF" });
  const { state } = await worker.send({ type: "GET_STATE" });
  assert.equal(state.status, "playing");
  assert.equal(state.source.text, "Restricted selected text.");
});
