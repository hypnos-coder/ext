"use strict";

importScripts("playback.js");

const { normalizeSettings, normalizeSource, splitSegments, chooseLocalVoice } = ReaderPlayback;
const SESSION_KEY = "readerPlaybackSession";
const MENU_ID = "reader-read-selection";
const COMMANDS = new Set(["GET_STATE", "GET_VOICES", "START", "PAUSE", "RESUME", "STOP", "SKIP", "SETTINGS"]);
let source = null;
let settings = normalizeSettings();
let segments = [];
let currentIndex = 0;
let charIndex = 0;
let charLength = 0;
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
let storageQueue = Promise.resolve();
let offscreenQueue = Promise.resolve();
let offscreenEvent = null;

function getState() {
  const segment = segments[currentIndex];
  const totalCharacters = source?.text.length || 0;
  return {
    status, source: source ? { ...source } : null, settings: { ...settings },
    currentIndex: Math.min(currentIndex, Math.max(0, segments.length - 1)),
    totalSegments: segments.length, charIndex, charLength, totalCharacters,
    progress: totalCharacters ? Math.min(1, Math.max(0, charIndex / totalCharacters)) : 0,
    currentText: segment?.text || "", segmentStart: segment?.start ?? charIndex,
    segmentEnd: segment?.end ?? charIndex, wordLength: charLength,
    error, sessionId, recovered,
    voice: selectedVoice ? { voiceName: selectedVoice.voiceName, engine: selectedVoice.engine,
      remote: selectedVoice.remote === true, lang: selectedVoice.lang } : null
  };
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
      await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["AUDIO_PLAYBACK"],
        justification: "Play locally synthesized speech while the extension popup is closed." });
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
  currentIndex = index;
  const segment = segments[index];
  charIndex = segment ? Math.max(segment.start, Math.min(segment.end, position ?? segment.start))
    : (source?.text.length || 0);
  charLength = segment ? Math.max(0, segment.end - charIndex) : 0;
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
    chrome.storage.local.get(["rate", "voiceName"]).catch(() => ({})),
    chrome.storage.session?.get(SESSION_KEY).catch(() => ({})) || Promise.resolve({})
  ]);
  settings = normalizeSettings(savedSettings);
  const snapshot = savedSession[SESSION_KEY];
  if (!snapshot?.source?.text) return;
  source = normalizeSource(snapshot.source);
  if (!source.text) { source = null; return; }
  settings = normalizeSettings(snapshot.settings, settings);
  segments = splitSegments(source.text);
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

async function handleCommand(message, sender) {
  switch (message.type) {
    case "GET_STATE": return { state: getState() };
    case "GET_VOICES": return { voices: await availableVoices() };
    case "START": {
      const nextSource = normalizeSource(message.source);
      if (Number.isInteger(sender?.tab?.id) && !sender.url?.startsWith(chrome.runtime.getURL(""))) {
        nextSource.tabId = sender.tab.id;
        nextSource.frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
      }
      if (!nextSource.text) throw new Error("Choose a page, select some text, or paste text to read.");
      if (source?.tabId !== nextSource.tabId) sendToSourceTab({ ...getState(), status: "idle", charLength: 0 });
      invalidateSpeech();
      source = nextSource;
      segments = splitSegments(source.text);
      settings = normalizeSettings(message.settings, settings);
      sessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${generation}`;
      recovered = false;
      error = "";
      setPosition(0);
      await chrome.storage.local.set({ ...settings });
      try { await loadVoice(); }
      catch (failure) { setFailure(failure.message); return { state: getState() }; }
      speakCurrent();
      break;
    }
    case "PAUSE":
      if (status === "playing") {
        status = "paused";
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
      invalidateSpeech();
      status = "idle";
      error = "";
      recovered = false;
      setPosition(0);
      charLength = 0;
      publish();
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
  const task = commandQueue.catch(() => {}).then(() => handleCommand(message, sender));
  commandQueue = task.catch(() => {});
  task.then(sendResponse, (failure) => sendResponse({ error: failure.message || "The reader could not complete that action." }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({ id: MENU_ID, title: "Read selected text aloud", contexts: ["selection"] }, () => {
      void chrome.runtime.lastError;
    });
  });
});

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText?.trim()) return;
  const task = commandQueue.catch(() => {}).then(async () => {
    const frameId = Number.isInteger(info.frameId) ? info.frameId : 0;
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
