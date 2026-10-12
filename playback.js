/* Shared text/voice helpers, loaded by the Chrome worker and Node tests. */
(function (root) {
  "use strict";

  const MAX_TEXT_LENGTH = 100000;
  const MAX_SEGMENT_LENGTH = 1800;
  const DEFAULT_SETTINGS = Object.freeze({ rate: 1, voiceName: "" });

  function normalizeSettings(value = {}, fallback = DEFAULT_SETTINGS) {
    if (!value || typeof value !== "object") value = {};
    const rate = Number(value.rate ?? fallback.rate);
    return {
      rate: Number.isFinite(rate) ? Math.min(3, Math.max(0.5, rate)) : fallback.rate,
      voiceName: typeof value.voiceName === "string"
        ? value.voiceName.trim().slice(0, 300) : (fallback.voiceName || "")
    };
  }

  function normalizeSource(value = {}) {
    if (!value || typeof value !== "object") value = {};
    const text = typeof value.text === "string"
      ? value.text.trim().slice(0, MAX_TEXT_LENGTH).trimEnd() : "";
    return {
      text,
      title: typeof value.title === "string" ? value.title.trim().slice(0, 300) : "Text to read",
      url: typeof value.url === "string" ? value.url.slice(0, 2048) : "",
      kind: typeof value.kind === "string" ? value.kind.slice(0, 32) : "text",
      id: typeof value.id === "string" ? value.id.slice(0, 200) : "",
      truncated: value.truncated === true || (typeof value.text === "string" && value.text.trim().length > MAX_TEXT_LENGTH),
      frameId: Number.isInteger(value.frameId) && value.frameId >= 0 ? value.frameId : 0,
      tabId: Number.isInteger(value.tabId) && value.tabId >= 0 ? value.tabId : null
    };
  }

  function splitSegments(text, maximum = MAX_SEGMENT_LENGTH) {
    if (typeof text !== "string" || !text.trim()) return [];
    const limit = Number.isInteger(maximum) && maximum > 0 ? maximum : MAX_SEGMENT_LENGTH;
    let sentences;
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      sentences = Array.from(new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text),
        ({ segment, index }) => ({ text: segment, start: index }));
    } else {
      sentences = Array.from(text.matchAll(/[^.!?。！？\n]+(?:[.!?。！？]+["'’”\])}]*|\n|$)|[.!?。！？]+/gu),
        (match) => ({ text: match[0], start: match.index }));
    }
    const result = [];
    for (const sentence of sentences) {
      let start = sentence.start;
      const end = sentence.start + sentence.text.length;
      while (start < end) {
        while (start < end && /\s/u.test(text[start])) start += 1;
        if (start >= end) break;
        let split = Math.min(end, start + limit);
        if (split < end) {
          const candidate = text.slice(start, split).search(/\s+\S*$/u);
          if (candidate > limit / 2) split = start + candidate;
          if (split > start && /[\uD800-\uDBFF]/u.test(text[split - 1])
              && /[\uDC00-\uDFFF]/u.test(text[split])) split -= 1;
        }
        let spokenEnd = split;
        while (spokenEnd > start && /\s/u.test(text[spokenEnd - 1])) spokenEnd -= 1;
        if (spokenEnd > start) result.push({ text: text.slice(start, spokenEnd), start, end: spokenEnd });
        start = split > start ? split : start + 1;
      }
    }
    return result;
  }

  function chooseLocalVoice(voices, requested = "", language = "en-US") {
    const local = (Array.isArray(voices) ? voices : []).filter((voice) =>
      voice && voice.remote !== true && voice.voiceName
      && (!Array.isArray(voice.eventTypes) || voice.eventTypes.includes("end")));
    const selected = local.find((voice) => voice.voiceName === requested);
    if (selected) return selected;
    const preferred = language.toLowerCase();
    const score = (voice) => {
      const lang = (voice.lang || "").toLowerCase();
      return (lang === preferred ? 4 : lang.split("-")[0] === preferred.split("-")[0] ? 2 : 0)
        + (!voice.extensionId ? 1 : 0);
    };
    return local.sort((a, b) => score(b) - score(a))[0] || null;
  }

  const api = { MAX_TEXT_LENGTH, MAX_SEGMENT_LENGTH, DEFAULT_SETTINGS,
    normalizeSettings, normalizeSource, splitSegments, chooseLocalVoice };
  root.ReaderPlayback = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
