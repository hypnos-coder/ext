"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const code = fs.readFileSync(path.join(__dirname, "..", "offscreen.js"), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));

function createPlayer({ webVoices, loadFailure, playbackFailure } = {}) {
  let listener;
  let nextUrl = 0;
  let voiceLoads = 0;
  const emitted = [];
  const generated = [];
  const revoked = [];
  const blobs = [];
  const timers = new Map();
  const spoken = [];
  const audio = {
    src: "", playCount: 0, pauseCount: 0,
    async play() {
      this.playCount += 1;
      if (playbackFailure) throw new Error(playbackFailure);
      queueMicrotask(() => this.onplaying?.());
    },
    pause() { this.pauseCount += 1; },
    load() {},
    removeAttribute(name) { if (name === "src") this.src = ""; }
  };
  const synth = webVoices ? {
    getVoices: () => webVoices,
    addEventListener() {}, removeEventListener() {},
    speak(utterance) { spoken.push(utterance); },
    cancel() { spoken.at(-1)?.onerror?.({ error: "canceled" }); },
    pause() { spoken.at(-1)?.onpause?.(); },
    resume() { spoken.at(-1)?.onresume?.(); }
  } : undefined;
  const chrome = { runtime: {
    id: "sona-test", getURL: (file) => `chrome-extension://sona-test/${file}`,
    sendMessage: async (message) => { emitted.push(clone(message)); },
    onMessage: { addListener(value) { listener = value; } }
  } };
  const context = vm.createContext({
    chrome, Blob, console, speechSynthesis: synth,
    SpeechSynthesisUtterance: function(text) { this.text = text; },
    document: { getElementById: () => audio },
    URL: {
      createObjectURL(blob) { blobs.push(blob); return `blob:sona/${++nextUrl}`; },
      revokeObjectURL(url) { revoked.push(url); }
    },
    meSpeak: {
      loadVoice(id, callback) {
        voiceLoads += 1;
        queueMicrotask(() => callback(!loadFailure, loadFailure || id));
      },
      speak(text, options, callback) { generated.push({ text, options, callback }); return generated.length; }
    },
    setTimeout(callback, delay) { const timer = Symbol(); timers.set(timer, { callback, delay }); return timer; },
    clearTimeout(timer) { timers.delete(timer); }
  });
  vm.runInContext(code, context);
  const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL("background.js") };
  return {
    audio, generated, revoked, blobs, emitted, spoken, timers,
    get voiceLoads() { return voiceLoads; },
    send(message, from = sender) {
      return new Promise((resolve) => {
        const accepted = listener({ target: "sona-offscreen", ...message }, from, (value) => resolve(clone(value)));
        if (accepted === false) resolve(undefined);
      });
    },
    async flush() { for (let i = 0; i < 6; i += 1) await Promise.resolve(); },
    async generate(index = generated.length - 1, success = true) {
      assert.ok(generated[index], "Speech should be queued for synthesis");
      generated[index].callback(success, index + 1, success ? new ArrayBuffer(200) : null);
      await this.flush();
    },
    events(token) { return emitted.filter((value) => value.token === token).map((value) => value.event.type); }
  };
}

test("offscreen offers a bundled local voice even without either system speech API", async () => {
  const player = createPlayer();
  const response = await player.send({ type: "GET_VOICES" });
  assert.deepEqual(response.voices.map((voice) => [voice.voiceName, voice.engine, voice.remote]),
    [["Sona Offline English", "offline", false]]);
  assert.equal(player.voiceLoads, 0, "Voice discovery must not block on synthesis initialization");
});

test("offline speech starts only once generated audio begins playing and ends on actual completion", async () => {
  const player = createPlayer();
  assert.deepEqual(await player.send({ type: "SPEAK", text: "Hello world.", rate: 1.5, token: 1 }), { ok: true });
  await player.flush();
  assert.deepEqual(player.events(1), []);
  assert.equal(player.generated[0].options.speed, 263);
  assert.equal(player.generated[0].options.rawdata, true);
  await player.generate();
  assert.deepEqual(player.events(1), ["start"]);
  assert.equal(player.blobs[0].type, "audio/wav");
  assert.match(player.audio.src, /^blob:/);
  player.audio.onended();
  assert.deepEqual(player.events(1), ["start", "end"]);
  assert.equal(player.emitted.at(-1).event.charIndex, "Hello world.".length);
  assert.equal(player.revoked.length, 1);
  assert.equal(player.audio.src, "");
});

test("pause before synthesis completion defers playback until resume", async () => {
  const player = createPlayer();
  await player.send({ type: "SPEAK", text: "Wait for me.", token: "paused" });
  await player.flush();
  await player.send({ type: "PAUSE" });
  await player.generate();
  assert.equal(player.audio.playCount, 0);
  assert.deepEqual(player.events("paused"), ["pause"]);
  await player.send({ type: "RESUME" });
  await player.flush();
  assert.equal(player.audio.playCount, 1);
  assert.deepEqual(player.events("paused"), ["pause", "start"]);
  await player.send({ type: "PAUSE" });
  await player.send({ type: "RESUME" });
  await player.flush();
  assert.deepEqual(player.events("paused"), ["pause", "start", "pause", "resume"]);
});

test("stopping or replacing an utterance suppresses stale synthesis and cleans active audio", async () => {
  const player = createPlayer();
  await player.send({ type: "SPEAK", text: "Old speech.", token: 1 });
  await player.flush();
  await player.send({ type: "SPEAK", text: "New speech.", token: 2 });
  await player.flush();
  await player.generate(0);
  assert.equal(player.blobs.length, 0, "Discard a WAV generated for a canceled utterance");
  await player.generate(1);
  assert.deepEqual(player.events(1), ["interrupted"]);
  assert.deepEqual(player.events(2), ["start"]);
  await player.send({ type: "STOP" });
  assert.deepEqual(player.events(2), ["start", "interrupted"]);
  assert.equal(player.revoked.length, 1);
  assert.equal(player.voiceLoads, 1, "Reuse the loaded local engine");
  assert.deepEqual(await player.send({ type: "RESUME" }), { ok: true, resumed: false });
  assert.deepEqual(await player.send({ type: "PAUSE" }), { ok: true, missing: true });
});

test("engine initialization and playback failures produce visible error events", async () => {
  const missing = createPlayer({ loadFailure: "file error" });
  await missing.send({ type: "SPEAK", text: "Hello.", token: 1 });
  await missing.flush();
  assert.deepEqual(missing.events(1), ["error"]);
  assert.match(missing.emitted[0].event.errorMessage, /offline voice could not load/);
  const blocked = createPlayer({ playbackFailure: "Audio device unavailable" });
  await blocked.send({ type: "SPEAK", text: "Hello.", token: 2 });
  await blocked.flush();
  await blocked.generate();
  assert.deepEqual(blocked.events(2), ["error"]);
  assert.equal(blocked.emitted[0].event.errorMessage, "Audio device unavailable");
  assert.equal(blocked.revoked.length, 1);
});

test("web voices retain remote status and remote speech requires a named selection", async () => {
  const player = createPlayer({ webVoices: [
    { name: "Cloud voice", voiceURI: "cloud", lang: "en-US", localService: false },
    { name: "Device voice", voiceURI: "device", lang: "en-GB", localService: true }
  ] });
  const response = await player.send({ type: "GET_VOICES" });
  assert.equal(response.voices[0].remote, true);
  assert.equal(response.voices[1].remote, false);
  assert.equal(response.voices[2].engine, "offline");
  await player.send({ type: "SPEAK", engine: "web", text: "Local by default.", token: 1 });
  await player.flush();
  assert.equal(player.spoken[0].voice.name, "Device voice");
  await player.send({ type: "SPEAK", engine: "web", voiceName: "Cloud voice", text: "Explicit selection.", token: 2 });
  await player.flush();
  assert.equal(player.spoken[1].voice.name, "Cloud voice");
  player.spoken[0].onerror({ error: "canceled" });
  assert.deepEqual(player.events(1), ["interrupted"]);
  player.spoken[1].onstart();
  player.spoken[1].onboundary({ name: "word", charIndex: 9, charLength: 9 });
  player.spoken[1].onend();
  assert.deepEqual(player.events(2), ["start", "word", "end"]);
});

test("content scripts and other senders cannot command the offscreen player", async () => {
  const player = createPlayer();
  const message = { type: "SPEAK", text: "Should not play.", token: 1 };
  assert.equal(await player.send(message, { id: "other-extension" }), undefined);
  assert.equal(await player.send(message, { id: "sona-test", tab: { id: 1 } }), undefined);
  assert.equal(await player.send(message, { id: "sona-test", url: "https://example.com" }), undefined);
  assert.deepEqual(player.generated, []);
  const malformed = await player.send({ type: "SPEAK", text: "", token: 1 });
  assert.equal(malformed.ok, false);
  assert.equal(player.audio.playCount, 0);
});
