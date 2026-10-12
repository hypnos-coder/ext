"use strict";

(() => {
  const offlineVoice = Object.freeze({
    voiceName: "Sona Offline English", lang: "en-US", remote: false,
    engine: "offline", eventTypes: ["start", "end", "error", "pause", "resume", "interrupted"]
  });
  const audio = document.getElementById("speech-audio");
  let current = null;
  let offlineReady = null;

  function emit(request, event) {
    chrome.runtime.sendMessage({ type: "OFFSCREEN_TTS_EVENT", token: request.token, event })
      .catch(() => {});
  }

  function cleanup(request) {
    if (request.audioUrl) {
      audio.onplaying = audio.onended = audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(request.audioUrl);
      request.audioUrl = null;
    }
    if (current === request) current = null;
  }

  function finish(request, event) {
    if (current !== request) return;
    cleanup(request);
    emit(request, event);
  }

  function stop() {
    const request = current;
    if (!request) return;
    // Invalidate the request first: cancel can synchronously deliver stale events.
    current = null;
    if (request.engine === "web") globalThis.speechSynthesis?.cancel();
    cleanup(request);
    emit(request, { type: "interrupted" });
  }

  function loadOfflineVoice() {
    if (!offlineReady) {
      offlineReady = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("The bundled offline voice could not load. Reload Sona in chrome://extensions.")), 10000);
        try {
          meSpeak.loadVoice("en/en-us", (success, detail) => {
            clearTimeout(timeout);
            if (success) resolve();
            else reject(new Error(`The bundled offline voice could not load: ${detail || "invalid voice data"}.`));
          });
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      }).catch((error) => {
        offlineReady = null;
        throw error;
      });
    }
    return offlineReady;
  }

  function synthesize(text, rate) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("The offline voice took too long to generate speech. Try reading a shorter passage.")), 20000);
      try {
        meSpeak.speak(text, { voice: "en/en-us", speed: Math.round(175 * rate), rawdata: true }, (success, id, data) => {
          clearTimeout(timeout);
          if (!success || !data || data.byteLength <= 44) reject(new Error("The bundled offline voice did not generate playable speech."));
          else resolve(data);
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  async function startOffline(request) {
    await loadOfflineVoice();
    if (current !== request) return;
    const wav = await synthesize(request.text, request.rate);
    if (current !== request) return;
    request.audioUrl = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    audio.src = request.audioUrl;
    audio.onplaying = () => {
      if (current !== request || request.paused) return;
      if (!request.started) {
        request.started = true;
        request.reportedPause = false;
        emit(request, { type: "start", charIndex: 0 });
      } else if (request.reportedPause) {
        request.reportedPause = false;
        emit(request, { type: "resume" });
      }
    };
    audio.onended = () => finish(request, { type: "end", charIndex: request.text.length });
    audio.onerror = () => finish(request, { type: "error", errorMessage: "Chrome could not play the generated speech audio." });
    if (!request.paused) await audio.play();
  }

  async function webVoices() {
    const synth = globalThis.speechSynthesis;
    if (!synth) return [];
    const voices = synth.getVoices();
    if (voices.length) return voices;
    await new Promise((resolve) => {
      let timeout;
      const changed = () => {
        if (!synth.getVoices().length) return;
        clearTimeout(timeout);
        synth.removeEventListener("voiceschanged", changed);
        resolve();
      };
      synth.addEventListener("voiceschanged", changed);
      timeout = setTimeout(() => {
        synth.removeEventListener("voiceschanged", changed);
        resolve();
      }, 1000);
      changed();
    });
    return synth.getVoices();
  }

  async function startWeb(request) {
    const voices = await webVoices();
    if (current !== request) return;
    const voice = request.voiceName
      ? voices.find((item) => item.name === request.voiceName || item.voiceURI === request.voiceName)
      : voices.find((item) => item.localService);
    if (!voice) throw new Error("The selected browser voice is unavailable. Select Sona Offline English.");
    const utterance = new SpeechSynthesisUtterance(request.text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = request.rate;
    utterance.onstart = () => {
      if (current !== request) return;
      request.started = true;
      emit(request, { type: "start", charIndex: 0 });
      if (request.paused) speechSynthesis.pause();
    };
    utterance.onend = () => finish(request, { type: "end", charIndex: request.text.length });
    utterance.onerror = (event) => finish(request, { type: "error", errorMessage: `The browser voice failed: ${event.error || "speech synthesis error"}. Select Sona Offline English.` });
    utterance.onboundary = (event) => {
      if (current === request && event.name === "word") {
        emit(request, { type: "word", charIndex: event.charIndex, length: event.charLength });
      }
    };
    utterance.onpause = () => { if (current === request) emit(request, { type: "pause" }); };
    utterance.onresume = () => { if (current === request) emit(request, { type: "resume" }); };
    request.utterance = utterance;
    speechSynthesis.speak(utterance);
  }

  function start(message) {
    if (typeof message.text !== "string" || !message.text.trim() || message.text.length > 8000) {
      throw new Error("Speech requires a nonempty text segment of at most 8000 characters.");
    }
    if (!["string", "number"].includes(typeof message.token)) throw new Error("A playback token is required.");
    const engine = message.engine || (message.voiceName && message.voiceName !== offlineVoice.voiceName ? "web" : "offline");
    if (!["offline", "web"].includes(engine)) throw new Error("Unknown speech engine.");
    stop();
    const value = Number(message.rate);
    const request = {
      token: message.token, text: message.text, voiceName: message.voiceName, engine,
      rate: Number.isFinite(value) ? Math.min(3, Math.max(0.5, value)) : 1,
      paused: false, started: false, reportedPause: false, audioUrl: null
    };
    current = request;
    const task = engine === "offline" ? startOffline(request) : startWeb(request);
    task.catch((error) => finish(request, { type: "error", errorMessage: error.message || String(error) }));
    return { ok: true };
  }

  async function handle(message) {
    switch (message.type || message.command) {
      case "GET_VOICES": {
        const voices = await webVoices();
        return { voices: [...voices.map((voice) => ({
          voiceName: voice.name, id: voice.voiceURI, lang: voice.lang,
          remote: !voice.localService, engine: "web", eventTypes: ["start", "word", "end", "error", "pause", "resume", "interrupted"]
        })), offlineVoice] };
      }
      case "SPEAK": return start(message);
      case "STOP": stop(); return { ok: true };
      case "PAUSE": {
        const request = current;
        if (!request) return { ok: true, missing: true };
        if (request.paused) return { ok: true };
        request.paused = true;
        if (request.engine === "web") speechSynthesis.pause();
        else {
          audio.pause();
          request.reportedPause = true;
          emit(request, { type: "pause" });
        }
        return { ok: true };
      }
      case "RESUME": {
        const request = current;
        if (!request) return { ok: true, resumed: false };
        request.paused = false;
        if (request.engine === "web") speechSynthesis.resume();
        else if (request.audioUrl) {
          try { await audio.play(); }
          catch (error) { finish(request, { type: "error", errorMessage: error.message || String(error) }); }
        }
        return { ok: true, resumed: true };
      }
      default: throw new Error("Unknown offscreen speech command.");
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== "sona-offscreen") return false;
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    if (sender.url && !sender.url.startsWith(chrome.runtime.getURL(""))) return false;
    handle(message).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });
})();
