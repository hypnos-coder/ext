"use strict";

importScripts("playback.js", "extraction.js");

const { normalizeSettings, normalizeSource, splitSegments, chooseLocalVoice } = ReaderPlayback;
const SESSION_KEY = "readerPlaybackSession";
const POSITION_KEY = "readerPositions";
const UI_KEY = "readerUiPreferences";
const MENU_ID = "reader-read-selection";
const FROM_HERE_MENU_ID = "reader-read-from-here";
const COMMANDS = new Set(["GET_STATE", "GET_VOICES", "START", "PAUSE", "RESUME", "STOP", "SKIP", "SEEK",
  "SETTINGS", "GET_POSITION", "UI_PREFS", "GET_UI_PREFS", "OPEN_READER", "PREPARE_SOURCE"]);
let source = null;
let settings = normalizeSettings();
let segments = [];
let currentIndex = 0;
let charIndex = 0;
let charLength = 0;
let wordBoundary = false;
let status = "idle";
let error = "";
let sessionId = "";
let recovered = false;
let generation = 0;
let utteranceToken = 0;
let nativePending = false;
let selectedVoice = null;
let keepAliveTimer = null;
let snapshotTimer = null;
let positionTimer = null;
let positions = [];
let uiPreferences = { follow: true };
let wordOffsets = [];
let storageQueue = Promise.resolve();
let offscreenQueue = Promise.resolve();
let offscreenEvent = null;
let latestExtractionRequest = null;

function getState() {
  const segment = segments[currentIndex];
  const totalCharacters = source?.text.length || 0;
  let low = 0;
  let high = wordOffsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (wordOffsets[middle] < charIndex) low = middle + 1;
    else high = middle;
  }
  const secondsPerWord = 60 / (180 * settings.rate);
  return {
    status, source: source ? { ...source } : null, settings: { ...settings },
    uiPreferences: { ...uiPreferences },
    currentIndex: Math.min(currentIndex, Math.max(0, segments.length - 1)),
    totalSegments: segments.length, charIndex, charLength, totalCharacters,
    progress: totalCharacters ? Math.min(1, Math.max(0, charIndex / totalCharacters)) : 0,
    currentText: segment?.text || "", segmentStart: segment?.start ?? charIndex,
    segmentEnd: segment?.end ?? charIndex, wordLength: charLength, wordBoundary,
    totalSeconds: Math.ceil(wordOffsets.length * secondsPerWord),
    remainingSeconds: Math.ceil((wordOffsets.length - low) * secondsPerWord),
    error, sessionId, recovered,
    voice: selectedVoice ? { voiceName: selectedVoice.voiceName, engine: selectedVoice.engine,
      remote: selectedVoice.remote === true, lang: selectedVoice.lang } : null
  };
}

function prepareText() {
  segments = splitSegments(source.text);
  wordOffsets = Array.from(source.text.matchAll(/\S+/gu), (match) => match.index);
}

function positionIdentity(value) {
  // Two independent short hashes keep article text out of durable storage.
  let hashA = 2166136261;
  let hashB = 5381;
  for (let i = 0; i < value.text.length; i += 1) {
    const code = value.text.charCodeAt(i);
    hashA = Math.imul(hashA ^ code, 16777619);
    hashB = Math.imul(hashB, 33) ^ code;
  }
  const url = value.url.split("#")[0];
  const fingerprint = `${value.text.length}:${(hashA >>> 0).toString(16)}:${(hashB >>> 0).toString(16)}`;
  return { url, kind: value.kind, fingerprint, key: JSON.stringify([url, value.kind, fingerprint]) };
}

function checkpointFor(value) {
  if (!hasArticleIdentity(value)) return null;
  const identity = positionIdentity(value);
  const saved = positions.find((entry) => entry.key === identity.key);
  if (!saved || saved.finished || saved.charIndex <= 0 || saved.charIndex >= value.text.length) return null;
  return { charIndex: saved.charIndex, progress: saved.charIndex / value.text.length,
    updatedAt: saved.updatedAt, title: saved.title };
}

function hasArticleIdentity(value) {
  return !!value?.text && !!value.url && ["page", "selection", "pdf"].includes(value.kind);
}

function storePosition(immediate = true) {
  const write = () => {
    positionTimer = null;
    if (!hasArticleIdentity(source) || status === "idle") return;
    const identity = positionIdentity(source);
    // A changed article replaces its older checkpoint, even if its URL is identical.
    positions = positions.filter((entry) => entry.url !== identity.url || entry.kind !== identity.kind);
    positions.unshift({ ...identity, charIndex, title: source.title, updatedAt: Date.now(),
      finished: status === "finished" || charIndex >= source.text.length });
    positions = positions.slice(0, 50);
    const saved = positions.map((entry) => ({ ...entry }));
    storageQueue = storageQueue.catch(() => {}).then(() =>
      chrome.storage.local.set({ [POSITION_KEY]: saved })).catch(() => {});
  };
  if (immediate) {
    if (positionTimer !== null) clearTimeout(positionTimer);
    write();
  } else if (positionTimer === null) positionTimer = setTimeout(write, 2000);
}

function ignoreRejection(result) {
  if (result && typeof result.catch === "function") result.catch(() => {});
}

async function offscreenExists() {
  if (!chrome.offscreen || !chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL("offscreen.html")]
  });
  return contexts.length > 0;
}

function sendOffscreen(type, payload = {}, create = true) {
  // Keep stop/start ordered even when creating a document crosses an await.
  const task = offscreenQueue.catch(() => {}).then(async () => {
    if (!await offscreenExists()) {
      if (!create) return { ok: true, missing: true };
      if (!chrome.offscreen) throw new Error("The speech player is unavailable. Reload Sona in chrome://extensions.");
      await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["AUDIO_PLAYBACK", "DOM_PARSER", "BLOBS"],
        justification: "Play speech and parse PDF/HTML documents locally, including scanned pages." });
    }
    const response = await chrome.runtime.sendMessage({ target: "sona-offscreen", type, ...payload });
    if (response?.error) throw new Error(response.error);
    return response || { ok: true };
  });
  offscreenQueue = task.catch(() => {});
  return task;
}

async function nativeVoices() {
  try {
    const voices = await chrome.tts.getVoices();
    return voices.filter((voice) => voice.voiceName && (!voice.eventTypes || voice.eventTypes.includes("end")))
      .map((voice) => ({ ...voice, engine: "native", remote: voice.remote === true }));
  } catch { return []; }
}

async function availableVoices(native = null) {
  const installed = native || await nativeVoices();
  try {
    const response = await sendOffscreen("GET_VOICES");
    return [...installed, ...(response.voices || [])];
  } catch (failure) {
    if (installed.length) return installed;
    throw new Error(`Could not load Sona's bundled voice. Reload the extension and try again. ${failure.message}`);
  }
}

function sendToSourceTab(state) {
  if (!Number.isInteger(state.source?.tabId)) return;
  const { text: _text, ...publicSource } = state.source;
  try {
    ignoreRejection(chrome.tabs.sendMessage(state.source.tabId,
      { type: "READER_STATE", state: { ...state, source: publicSource } },
      { frameId: state.source.frameId || 0 }));
  } catch (_) { /* A tab may be closed or have no content script. */ }
}

function storeSnapshot(immediate) {
  if (!chrome.storage.session) return;
  const write = () => {
    snapshotTimer = null;
    const snapshot = getState();
    storageQueue = storageQueue.catch(() => {}).then(() =>
      chrome.storage.session.set({ [SESSION_KEY]: snapshot })).catch(() => {});
  };
  if (immediate) {
    if (snapshotTimer !== null) clearTimeout(snapshotTimer);
    write();
  } else if (snapshotTimer === null) snapshotTimer = setTimeout(write, 350);
}

function updateBadge() {
  if (!chrome.action) return;
  const badge = status === "playing" ? "ON" : status === "paused" ? "Ⅱ" : status === "error" ? "!" : "";
  ignoreRejection(chrome.action.setBadgeText({ text: badge }));
  ignoreRejection(chrome.action.setBadgeBackgroundColor({ color: status === "error" ? "#BA3636" : "#6356D9" }));
  ignoreRejection(chrome.action.setTitle({ title: `Sona · ${status}` }));
}

function updateKeepAlive() {
  // API activity resets Chrome 110+'s worker idle timer. Keep the worker alive
  // only while speaking, so long sentences continue after the popup closes.
  if (status === "playing" && keepAliveTimer === null) {
    keepAliveTimer = setInterval(() => {
      ignoreRejection(chrome.runtime.getPlatformInfo());
    }, 20000);
  } else if (status !== "playing" && keepAliveTimer !== null) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function publish(immediate = true) {
  const state = getState();
  try { ignoreRejection(chrome.runtime.sendMessage({ type: "STATE", state })); } catch (_) {}
  sendToSourceTab(state);
  if (immediate) updateBadge();
  updateKeepAlive();
  storeSnapshot(immediate);
  storePosition(immediate);
}

function invalidateSpeech() {
  // stop() can synchronously fire an interrupted event: invalidate first.
  generation += 1;
  utteranceToken += 1;
  nativePending = false;
  offscreenEvent = null;
  chrome.tts.stop();
  ignoreRejection(sendOffscreen("STOP", {}, false));
}

function setFailure(message) {
  status = "error";
  error = message || "Chrome could not read this text. Try another installed voice.";
  charLength = 0;
  wordBoundary = false;
  nativePending = false;
  publish();
}

async function loadVoice() {
  const installed = await nativeVoices();
  const native = chooseLocalVoice(installed, settings.voiceName, globalThis.navigator?.language || "en-US");
  const voices = (!native || (settings.voiceName && !installed.some((voice) => voice.voiceName === settings.voiceName)))
    ? await availableVoices(installed) : installed;
  const language = globalThis.navigator?.language || "en-US";
  selectedVoice = (settings.voiceName && voices.find((voice) => voice.voiceName === settings.voiceName))
    || chooseLocalVoice(voices.filter((voice) => voice.engine === "native"), "", language)
    || chooseLocalVoice(voices.filter((voice) => voice.engine === "web"), "", language)
    || chooseLocalVoice(voices.filter((voice) => voice.engine === "offline"), "", language);
  if (!selectedVoice) {
    throw new Error("The bundled speech voice did not load. Reload Sona in chrome://extensions and try again.");
  }
  if (settings.voiceName && settings.voiceName !== selectedVoice.voiceName) {
    settings.voiceName = "";
    await chrome.storage.local.set({ ...settings });
  }
}

function setPosition(index, position) {
  wordBoundary = false;
  currentIndex = index;
  const segment = segments[index];
  charIndex = segment ? Math.max(segment.start, Math.min(segment.end, position ?? segment.start))
    : (source?.text.length || 0);
  charLength = segment ? Math.max(0, segment.end - charIndex) : 0;
}

function offsetSegment(offset) {
  if (offset >= source.text.length) return segments.length;
  let nearest = 0;
  let distance = Infinity;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (offset >= segment.start && offset < segment.end) return index;
    const candidate = Math.min(Math.abs(offset - segment.start), Math.abs(offset - segment.end));
    if (candidate < distance) { nearest = index; distance = candidate; }
  }
  return nearest;
}

async function seekOffset(offset) {
  if (!source?.text || !segments.length) return;
  const wasPlaying = status === "playing";
  const index = offsetSegment(Math.max(0, offset));
  invalidateSpeech();
  setPosition(index);
  error = "";
  recovered = false;
  if (index === segments.length) {
    status = "finished";
    publish();
  } else if (wasPlaying) speakCurrent();
  else {
    status = "paused";
    charLength = 0;
    publish();
  }
}

function speakCurrent() {
  while (segments[currentIndex] && charIndex >= segments[currentIndex].end) setPosition(currentIndex + 1);
  const segment = segments[currentIndex];
  if (!segment) {
    status = "finished";
    charIndex = source?.text.length || 0;
    charLength = 0;
    nativePending = false;
    publish();
    return;
  }
  const thisGeneration = generation;
  const thisToken = ++utteranceToken;
  const thisIndex = currentIndex;
  const start = charIndex;
  const valid = () => thisGeneration === generation && thisToken === utteranceToken
    && thisIndex === currentIndex;
  status = "playing";
  wordBoundary = false;
  error = "";
  recovered = false;
  nativePending = true;
  publish();
  const options = {
    rate: settings.rate, volume: 1, enqueue: false,
    voiceName: selectedVoice.voiceName,
    ...(selectedVoice.extensionId ? { extensionId: selectedVoice.extensionId } : {}),
    ...(selectedVoice.lang ? { lang: selectedVoice.lang } : {}),
    requiredEventTypes: ["end"],
    onEvent(event) {
      if (!valid()) return;
      wordBoundary = event.type === "word" && Number.isFinite(event.charIndex) && event.charIndex >= 0
        && Number.isFinite(event.length) && event.length > 0;
      if (Number.isFinite(event.charIndex) && event.charIndex >= 0) {
        charIndex = Math.min(segment.end, start + event.charIndex);
        charLength = Number.isFinite(event.length) && event.length > 0
          ? Math.min(event.length, segment.end - charIndex) : Math.max(0, segment.end - charIndex);
      }
      if (event.type === "end") {
        nativePending = false;
        utteranceToken += 1;
        setPosition(thisIndex + 1);
        if (status === "paused") publish();
        else speakCurrent();
      } else if (event.type === "error") {
        utteranceToken += 1;
        setFailure(event.errorMessage);
      } else if (event.type === "interrupted" || event.type === "cancelled") {
        nativePending = false;
        utteranceToken += 1;
        status = "paused";
        charLength = 0;
        publish();
      } else if (event.type === "pause" || event.type === "resume") {
        status = event.type === "pause" ? "paused" : "playing";
        publish();
      } else publish(false);
    }
  };
  if (selectedVoice.engine !== "native") {
    const token = `${sessionId}:${thisToken}`;
    offscreenEvent = { token, onEvent: options.onEvent };
    sendOffscreen("SPEAK", { token, text: source.text.slice(start, segment.end),
      rate: settings.rate, voiceName: selectedVoice.voiceName, engine: selectedVoice.engine })
      .catch((failure) => {
        if (valid()) options.onEvent({ type: "error", errorMessage: failure.message });
      });
    return;
  }
  try {
    const result = chrome.tts.speak(source.text.slice(start, segment.end), options, () => {
      const lastError = chrome.runtime.lastError;
      if (lastError && valid()) {
        utteranceToken += 1;
        setFailure(lastError.message);
      }
    });
    if (result && typeof result.catch === "function") result.catch((failure) => {
      if (valid()) {
        utteranceToken += 1;
        setFailure(failure.message);
      }
    });
  } catch (failure) {
    if (valid()) {
      utteranceToken += 1;
      setFailure(failure.message);
    }
  }
}

async function restore() {
  const [savedSettings, savedSession] = await Promise.all([
    chrome.storage.local.get(["rate", "voiceName", POSITION_KEY, UI_KEY]).catch(() => ({})),
    chrome.storage.session?.get(SESSION_KEY).catch(() => ({})) || Promise.resolve({})
  ]);
  settings = normalizeSettings(savedSettings);
  uiPreferences = { follow: savedSettings[UI_KEY]?.follow !== false };
  positions = Array.isArray(savedSettings[POSITION_KEY]) ? savedSettings[POSITION_KEY]
    .filter((entry) => entry && typeof entry.key === "string" && typeof entry.url === "string"
      && entry.url && ["page", "selection", "pdf"].includes(entry.kind)
      && Number.isFinite(entry.charIndex) && entry.charIndex >= 0)
    .slice(0, 50) : [];
  const snapshot = savedSession[SESSION_KEY];
  if (!snapshot?.source?.text) return;
  source = normalizeSource(snapshot.source);
  if (!source.text) { source = null; return; }
  settings = normalizeSettings(snapshot.settings, settings);
  prepareText();
  sessionId = typeof snapshot.sessionId === "string" ? snapshot.sessionId : "";
  currentIndex = Math.min(segments.length - 1, Math.max(0, Math.trunc(Number(snapshot.currentIndex) || 0)));
  setPosition(currentIndex, Number(snapshot.charIndex) || 0);
  status = ["idle", "playing", "paused", "finished", "error"].includes(snapshot.status)
    ? snapshot.status : "idle";
  error = typeof snapshot.error === "string" ? snapshot.error : "";
  if (status === "playing" || status === "paused") {
    // Native speech can survive worker termination, but its event listener
    // cannot. Resume at the saved word boundary rather than showing false play.
    invalidateSpeech();
    status = "paused";
    error = "";
    recovered = true;
    charLength = 0;
  } else if (status === "finished") {
    currentIndex = segments.length;
    charIndex = source.text.length;
    charLength = 0;
  }
  publish();
}

const ready = restore().catch(() => {});
let commandQueue = ready;

function sourceFromMessage(value, sender) {
  const nextSource = normalizeSource(value);
  if (Number.isInteger(sender?.tab?.id) && !sender.url?.startsWith(chrome.runtime.getURL(""))) {
    nextSource.tabId = sender.tab.id;
    nextSource.frameId = Number.isInteger(sender.frameId) && sender.frameId >= 0 ? sender.frameId : 0;
  }
  return nextSource;
}

async function handleCommand(message, sender) {
  switch (message.type) {
    case "GET_STATE": return { state: getState() };
    case "GET_VOICES": return { voices: await availableVoices() };
    case "GET_POSITION": return { position: checkpointFor(normalizeSource(message.source)) };
    case "GET_UI_PREFS": return { preferences: { ...uiPreferences } };
    case "UI_PREFS": {
      if (typeof message.preferences?.follow === "boolean") uiPreferences.follow = message.preferences.follow;
      await chrome.storage.local.set({ [UI_KEY]: { ...uiPreferences } });
      publish();
      return { state: getState(), preferences: { ...uiPreferences } };
    }
    case "PREPARE_SOURCE": {
      const nextSource = sourceFromMessage(message.source, sender);
      if (!nextSource.text) throw new Error("Choose a page, select some text, or paste text to read.");
      if (source && ["text", "url", "kind", "id", "tabId", "frameId"]
        .every((key) => source[key] === nextSource[key])) return { state: getState() };
      storePosition();
      sendToSourceTab({ ...getState(), status: "idle", charLength: 0, wordBoundary: false });
      invalidateSpeech();
      source = nextSource;
      prepareText();
      setPosition(0);
      charLength = 0;
      status = "idle";
      error = "";
      recovered = false;
      sessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${generation}`;
      publish();
      break;
    }
    case "START": {
      const nextSource = sourceFromMessage(message.source, sender);
      if (!nextSource.text) throw new Error("Choose a page, select some text, or paste text to read.");
      storePosition();
      const savedPosition = message.resume === true ? checkpointFor(nextSource) : null;
      const requestedOffset = Number.isFinite(message.startOffset) ? message.startOffset
        : Number.isFinite(message.source?.startOffset) ? message.source.startOffset : savedPosition?.charIndex || 0;
      if (source?.tabId !== nextSource.tabId) sendToSourceTab({ ...getState(), status: "idle", charLength: 0 });
      invalidateSpeech();
      source = nextSource;
      prepareText();
      settings = normalizeSettings(message.settings, settings);
      sessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${generation}`;
      recovered = false;
      error = "";
      setPosition(offsetSegment(Math.max(0, requestedOffset)));
      await chrome.storage.local.set({ ...settings });
      if (currentIndex === segments.length) {
        status = "finished";
        publish();
        break;
      }
      try { await loadVoice(); }
      catch (failure) { setFailure(failure.message); return { state: getState() }; }
      speakCurrent();
      break;
    }
    case "PAUSE":
      if (status === "playing") {
        status = "paused";
        wordBoundary = false;
        if (selectedVoice?.engine === "native") chrome.tts.pause();
        else {
          const response = await sendOffscreen("PAUSE", {}, false);
          if (response.missing) nativePending = false;
        }
        publish();
      }
      break;
    case "RESUME":
      if (source?.text && status !== "playing") {
        if (status === "finished") setPosition(0);
        if (nativePending && status === "paused") {
          if (selectedVoice?.engine === "native") {
            status = "playing";
            error = "";
            chrome.tts.resume();
            publish();
          } else {
            const response = await sendOffscreen("RESUME", {}, false);
            if (response.missing || response.resumed === false) {
              invalidateSpeech();
              await loadVoice();
              speakCurrent();
            } else {
              status = "playing";
              error = "";
              publish();
            }
          }
        } else {
          try { await loadVoice(); }
          catch (failure) { setFailure(failure.message); return { state: getState() }; }
          speakCurrent();
        }
      }
      break;
    case "STOP":
      // Stopping hides the player and resets its visible progress, while a
      // durable checkpoint keeps the actual place for the next visit.
      storePosition();
      invalidateSpeech();
      status = "idle";
      error = "";
      recovered = false;
      setPosition(0);
      charLength = 0;
      publish();
      break;
    case "SEEK":
      if (!Number.isFinite(message.charIndex)) throw new Error("Choose a valid reading position.");
      await seekOffset(message.charIndex);
      break;
    case "SKIP": {
      if (message.direction !== 1 && message.direction !== -1) throw new Error("Skip direction must be 1 or -1.");
      if (!segments.length) break;
      const wasPlaying = status === "playing";
      const index = Math.max(0, Math.min(segments.length, currentIndex + message.direction));
      invalidateSpeech();
      setPosition(index);
      error = "";
      if (index === segments.length) {
        status = "finished";
        publish();
      } else if (wasPlaying) speakCurrent();
      else {
        status = "paused";
        publish();
      }
      break;
    }
    case "SETTINGS": {
      const next = normalizeSettings(message.settings, settings);
      const changed = next.rate !== settings.rate || next.voiceName !== settings.voiceName;
      settings = next;
      await chrome.storage.local.set({ ...settings });
      if (changed && (status === "playing" || status === "paused")) {
        const wasPlaying = status === "playing";
        try { await loadVoice(); }
        catch (failure) {
          invalidateSpeech();
          setFailure(failure.message);
          return { state: getState() };
        }
        invalidateSpeech();
        if (wasPlaying) speakCurrent();
        else publish();
      } else publish();
      break;
    }
  }
  return { state: getState() };
}

function trustedSender(sender) {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== "string") return false;
  if (sender.url.startsWith(chrome.runtime.getURL(""))) return true;
  return Number.isInteger(sender.tab?.id) && /^(https?:|file:)\/\//u.test(sender.url);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "sona-extractor") return false;
  if (["EXTRACT_TAB", "PDF_EXTRACT", "SCAN_TAB", "CANCEL_EXTRACT"].includes(message?.type)) {
    if (!trustedSender(sender) || !sender.url.startsWith(chrome.runtime.getURL(""))) {
      sendResponse({ error: "Open Sona to extract a document." }); return false;
    }
    const ensure = () => sendOffscreen("GET_VOICES");
    let task;
    if (message.type !== "CANCEL_EXTRACT") latestExtractionRequest = message.requestId;
    else if (latestExtractionRequest === message.requestId) latestExtractionRequest = null;
    if (message.type === "EXTRACT_TAB") task = SonaExtraction.extractTab(message, ensure);
    else if (message.type === "PDF_EXTRACT") task = SonaExtraction.pdf(message, ensure);
    else if (message.type === "SCAN_TAB") task = SonaExtraction.scanTab(message, ensure);
    else task = chrome.runtime.sendMessage({ target: "sona-extractor", type: "CANCEL_EXTRACT", requestId: message.requestId });
    task.then(async (result) => {
      if (result?.source && latestExtractionRequest === message.requestId) {
        try {
          const saved = await chrome.storage.session.get("sonaDraft");
          await chrome.storage.session.set({ sonaDraft: { source: result.source,
            pasteDraft: saved.sonaDraft?.pasteDraft || "", mode: "page" } });
        } catch { /* Storage failure must not discard successfully read text. */ }
      }
      sendResponse(result);
    }, (error) => sendResponse({ error: error.message || "Document extraction failed." }));
    return true;
  }
  if (message?.target === "sona-offscreen") return false;
  if (message?.type === "OFFSCREEN_TTS_EVENT") {
    if (sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("offscreen.html")
      && message.token === offscreenEvent?.token && message.event) {
      offscreenEvent.onEvent(message.event);
    }
    sendResponse({ ok: true });
    return false;
  }
  if (!message || !COMMANDS.has(message.type)) return false;
  if (!trustedSender(sender)) {
    sendResponse({ error: "Only this extension can control the reader." });
    return false;
  }
  if (message.type === "OPEN_READER") {
    // Chrome requires this call to remain inside the initiating user gesture.
    // Queuing it after restore or another speech command loses that gesture.
    try {
      if (!chrome.sidePanel?.open) throw new Error("The reading view requires Chrome 116 or newer.");
      const options = Number.isInteger(message.windowId) && message.windowId >= 0 ? { windowId: message.windowId }
        : Number.isInteger(sender.tab?.id) ? { tabId: sender.tab.id } : null;
      if (!options) throw new Error("Open the reading view from Sona's popup or a webpage.");
      const result = chrome.sidePanel.open(options);
      Promise.resolve(result).then(() => sendResponse({ ok: true }),
        (failure) => sendResponse({ error: failure.message || "Could not open the reading view." }));
      return true;
    } catch (failure) {
      sendResponse({ error: failure.message });
      return false;
    }
  }
  const task = commandQueue.catch(() => {}).then(() => handleCommand(message, sender));
  commandQueue = task.catch(() => {});
  task.then(sendResponse, (failure) => sendResponse({ error: failure.message || "The reader could not complete that action." }));
  return true;
});

chrome.webRequest?.onHeadersReceived.addListener((details) => {
  if (details.responseHeaders?.some((header) => header.name.toLowerCase() === "content-type"
      && /application\/pdf/iu.test(header.value || ""))) SonaExtraction.remember(details.tabId, details.url, details);
}, { urls: ["<all_urls>"] }, ["responseHeaders"]);
chrome.webNavigation?.onBeforeNavigate?.addListener((details) => {
  if (details.frameId === 0) SonaExtraction.forget(details.tabId);
});
chrome.tabs.onRemoved?.addListener((tabId) => SonaExtraction.forget(tabId));

chrome.runtime.onInstalled.addListener(() => {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({ id: MENU_ID, title: "Read selected text aloud", contexts: ["selection"] }, () => {
      void chrome.runtime.lastError;
    });
    chrome.contextMenus.create({ id: FROM_HERE_MENU_ID, title: "Read from here with Sona", contexts: ["page"] }, () => {
      void chrome.runtime.lastError;
    });
  });
});

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (![MENU_ID, FROM_HERE_MENU_ID].includes(info.menuItemId)) return;
  if (info.menuItemId === MENU_ID && !info.selectionText?.trim()) return;
  const task = commandQueue.catch(() => {}).then(async () => {
    const frameId = Number.isInteger(info.frameId) ? info.frameId : 0;
    if (info.menuItemId === FROM_HERE_MENU_ID) {
      if (!Number.isInteger(tab?.id)) throw new Error("Open a webpage to read from here.");
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, files: ["content.js"] });
      const response = await chrome.tabs.sendMessage(tab.id,
        { type: "READ_FROM_HERE", selectionText: info.selectionText || "" }, { frameId });
      if (response?.error) throw new Error(response.error);
      if (!response?.source?.text) throw new Error("This page has no readable text. Select or paste text to read instead.");
      return handleCommand({ type: "START", source: { ...response.source, tabId: tab.id, frameId },
        startOffset: response.source.startOffset }, null);
    }
    let selectionSource = { text: info.selectionText, title: tab?.title || "Selected text",
      url: info.frameUrl || info.pageUrl || tab?.url || "", kind: "selection", tabId: tab?.id, frameId };
    if (Number.isInteger(tab?.id)) {
      try {
        // Invoking the context menu grants activeTab. Read the live selection to
        // obtain the content script's text-node map for highlighting/player UI.
        await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, files: ["content.js"] });
        const result = await chrome.tabs.sendMessage(tab.id, { type: "READ_PAGE" }, { frameId });
        if (result?.source?.kind === "selection" && result.source.text?.trim()) {
          selectionSource = { ...result.source, tabId: tab.id, frameId };
        }
      } catch (_) { /* Restricted pages can still read Chrome's selected text. */ }
    }
    return handleCommand({ type: "START", source: selectionSource }, null);
  });
  commandQueue = task.catch((failure) => setFailure(failure.message));
});

function pageHasTypingFocus() {
  // Inspect shadow roots as well as the document: many editors put their input
  // inside a web component. Reading controls never interrupt typing there.
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return !!element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
    || !!element.closest?.('[contenteditable=""], [contenteditable="true"], [role="textbox"]'));
}

chrome.commands?.onCommand.addListener((command) => {
  const action = command === "toggle-playback" ? "toggle"
    : command === "previous-sentence" ? -1 : command === "next-sentence" ? 1 : null;
  if (action === null) return;
  const task = commandQueue.catch(() => {}).then(async () => {
    if (!source?.text) return;
    try {
      const response = await chrome.runtime.sendMessage({ type: "CHECK_EDITING" });
      if (response === true || response?.editing === true) return;
    } catch (_) { /* No focused extension document needs to claim the shortcut. */ }
    try {
      // Check the active page rather than stealing shortcuts from an editor
      // in another tab while this article is playing in the background.
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (Number.isInteger(activeTab?.id)) {
        const results = await chrome.scripting.executeScript({ target: { tabId: activeTab.id, allFrames: true },
          func: pageHasTypingFocus });
        if (results?.some((result) => result.result === true)) return;
      }
    } catch (_) { /* activeTab permission may have expired; playback still remains controllable. */ }
    return handleCommand(action === "toggle" ? { type: status === "playing" ? "PAUSE" : "RESUME" }
      : { type: "SKIP", direction: action }, null);
  });
  commandQueue = task.catch((failure) => setFailure(failure.message));
});
