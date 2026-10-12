/* Persistent reading view. Text is inserted as text nodes, never page markup. */
(function () {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const article = $("#article-text");
  const scrollArea = $("#article-scroll");
  const voiceSelect = $("#voice-select");
  const rateSelect = $("#rate-select");
  const progressRange = $("#seek-progress");
  const preferencesKey = "sonaReaderPreferences";
  let source = null;
  let sentences = [];
  let sourceWordCount = 0;
  let sentenceNodes = [];
  let playback = { status: "idle", progress: 0, charIndex: 0 };
  let voices = [];
  let busy = false;
  let ready = false;
  let loadGeneration = 0;
  let currentSentence = -1;
  let currentWord = "";
  let manuallyScrolled = false;
  let draggingProgress = false;
  let savedPosition = null;
  let positionGeneration = 0;
  let preferences = { textSize: 20, dark: false };
  const documentLoader = SonaDocuments.create({ mount: $("#document-tools"), setStatus,
    beforeLoad() { $("#load-page").disabled = true; },
    afterLoad() { $("#load-page").disabled = false; },
    async onSource(nextSource) { await prepareSource(nextSource); $("#paste-section").open = false; }
  });

  function setStatus(message = "", error = false) {
    $("#status").textContent = message;
    $("#status").dataset.error = String(error);
  }

  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (response?.error) throw new Error(response.error);
    return response || {};
  }

  function wordCount(text = "") { return text.trim().split(/\s+/u).filter(Boolean).length; }
  function active() { return ["playing", "paused"].includes(playback.status); }
  function sameSource(first, second) {
    return Boolean(first && second && first.text === second.text && (first.url || "") === (second.url || "")
      && (first.tabId ?? null) === (second.tabId ?? null) && (first.kind || "text") === (second.kind || "text"));
  }
  function currentSettings() { return { rate: Number(rateSelect.value) || 1, voiceName: voiceSelect.value }; }

  function setRate(rate) {
    const normalized = Math.min(3, Math.max(.5, Number(rate) || 1));
    const value = String(normalized);
    if (!Array.from(rateSelect.options).some((option) => option.value === value)) {
      rateSelect.add(new Option(`${normalized}×`, value));
      Array.from(rateSelect.options).sort((first, second) => Number(first.value) - Number(second.value))
        .forEach((option) => rateSelect.append(option));
    }
    rateSelect.value = value;
  }

  function renderAppearance() {
    document.body.classList.toggle("dark", preferences.dark);
    document.documentElement.style.setProperty("--reader-size", `${preferences.textSize}px`);
    $("#text-size").value = String(preferences.textSize);
    $("#theme-toggle").textContent = preferences.dark ? "Light" : "Dark";
    $("#theme-toggle").setAttribute("aria-pressed", String(preferences.dark));
  }

  async function saveAppearance() {
    renderAppearance();
    await chrome.storage.local.set({ [preferencesKey]: preferences });
  }

  function renderSource(nextSource) {
    if (sameSource(source, nextSource)) { source = { ...nextSource }; return; }
    source = nextSource?.text ? ReaderPlayback.normalizeSource(nextSource) : null;
    documentLoader.setSource(source);
    currentSentence = -1;
    currentWord = "";
    manuallyScrolled = false;
    savedPosition = null;
    positionGeneration += 1;
    $("#resume-banner").hidden = true;
    $("#back-to-reading").hidden = true;
    article.replaceChildren();
    sentences = ReaderPlayback.splitSegments(source?.text || "");
    sentenceNodes = [];
    let end = 0;
    const fragment = document.createDocumentFragment();
    for (const [index, sentence] of sentences.entries()) {
      if (sentence.start > end) fragment.append(document.createTextNode(source.text.slice(end, sentence.start)));
      const span = document.createElement("span");
      span.className = "sentence";
      span.dataset.index = String(index);
      span.tabIndex = 0;
      span.setAttribute("role", "button");
      span.setAttribute("aria-label", `Read from: ${sentence.text.slice(0, 120)}`);
      span.title = "Read from this sentence";
      span.textContent = sentence.text;
      sentenceNodes.push(span);
      fragment.append(span);
      end = sentence.end;
    }
    if (source && end < source.text.length) fragment.append(document.createTextNode(source.text.slice(end)));
    article.append(fragment);
    article.hidden = !source;
    $("#empty-state").hidden = Boolean(source);
    $("#article-title").textContent = source?.title || "Your next good read";
    $("#article-title").title = source?.title || "";
    let domain = "";
    try { domain = new URL(source?.url).hostname.replace(/^www\./u, ""); } catch { /* Pasted text has no domain. */ }
    const count = sourceWordCount = wordCount(source?.text);
    $("#article-detail").textContent = source
      ? `${source.kind === "pdf" ? `PDF pages ${source.pdf?.startPage || 1}–${source.pdf?.endPage || source.pdf?.totalPages || ""}${domain ? ` · ${domain}` : ""}` : domain || (source.kind === "selection" ? "Selected text" : "Your text")} · ${count.toLocaleString()} ${count === 1 ? "word" : "words"}${source.truncated ? source.kind === "pdf" ? " · Extraction limited" : " · First 100,000 characters" : ""}`
      : "Listen and follow along at your own pace.";
    scrollArea.scrollTop = 0;
  }

  function sentenceIndex(position) {
    if (!sentences.length) return -1;
    let low = 0;
    let high = sentences.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (sentences[middle].start <= position) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  function renderHighlight() {
    const listening = active() && sameSource(source, playback.source);
    const index = listening ? sentenceIndex(playback.segmentStart ?? playback.charIndex ?? 0) : -1;
    if (index !== currentSentence) {
      if (sentenceNodes[currentSentence]) {
        sentenceNodes[currentSentence].classList.remove("current");
        sentenceNodes[currentSentence].removeAttribute("aria-current");
        sentenceNodes[currentSentence].textContent = sentences[currentSentence].text;
      }
      currentSentence = index;
      currentWord = "";
      if (sentenceNodes[index]) {
        sentenceNodes[index].classList.add("current");
        sentenceNodes[index].setAttribute("aria-current", "true");
      }
    }
    const sentence = sentences[index];
    const span = sentenceNodes[index];
    if (sentence && span) {
      const wordStart = Math.max(0, (Number(playback.charIndex) || 0) - sentence.start);
      const length = Math.min(Number(playback.wordLength) || 0, sentence.text.length - wordStart);
      const wordKey = playback.wordBoundary === true && playback.voice?.engine !== "offline" && length > 0
        ? `${wordStart}:${length}` : "";
      if (wordKey !== currentWord) {
        currentWord = wordKey;
        if (wordKey) {
          const mark = document.createElement("span");
          mark.className = "current-word";
          mark.textContent = sentence.text.slice(wordStart, wordStart + length);
          span.replaceChildren(document.createTextNode(sentence.text.slice(0, wordStart)), mark,
            document.createTextNode(sentence.text.slice(wordStart + length)));
        } else span.textContent = sentence.text;
      }
    }
    followCurrent();
  }

  function outsideReadingArea(node) {
    if (!node) return false;
    const bounds = scrollArea.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    const visibleTop = Math.max(bounds.top, 0) + 18;
    const visibleBottom = bounds.bottom - 26;
    // Long passages remain readable without repeatedly jumping to their top.
    return rect.bottom < visibleTop || rect.top > visibleBottom;
  }

  function currentTrackingNode() {
    const sentence = sentenceNodes[currentSentence];
    return sentence?.querySelector(".current-word") || sentence;
  }

  function scrollToCurrent(behavior = "smooth") {
    const node = currentTrackingNode();
    if (!node) return;
    const area = scrollArea.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    const top = scrollArea.scrollTop + rect.top - area.top - Math.min(area.height * .25, 70);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scrollArea.scrollTo({ top: Math.max(0, top), behavior: reducedMotion ? "auto" : behavior });
  }

  function followCurrent() {
    const node = currentTrackingNode();
    const outside = outsideReadingArea(node);
    if (node && outside && $("#follow-reading").checked && !manuallyScrolled) scrollToCurrent();
    $("#back-to-reading").hidden = !node || (!manuallyScrolled && !outside)
      || (!manuallyScrolled && $("#follow-reading").checked);
  }

  function renderVoiceNote() {
    const voice = voices.find((item) => item.voiceName === voiceSelect.value);
    $("#voice-note").textContent = voice?.remote
      ? "Online voice · text is sent to its speech provider."
      : voice?.engine === "offline" ? "Built-in English voice · works offline."
        : "Local voice · speech stays on your device.";
  }

  function renderControls() {
    const hasText = Boolean(source?.text);
    const listening = active() && sameSource(source, playback.source);
    const playing = listening && playback.status === "playing";
    const paused = listening && playback.status === "paused";
    $("#play-label").textContent = playing ? "Pause" : paused ? "Resume" : "Play";
    $("#play-button").setAttribute("aria-label", playing ? "Pause reading" : paused ? "Resume reading" : "Read text aloud");
    $("#play-icon").innerHTML = playing ? '<path d="M7 5h3v14H7zM14 5h3v14h-3z"/>' : '<path d="m8 5 11 7-11 7V5Z"/>';
    $("#play-button").disabled = busy || !ready || !hasText;
    $("#stop-button").disabled = busy || !listening;
    const index = sentenceIndex(sameSource(source, playback.source) ? playback.charIndex || 0 : 0);
    $("#prev-button").disabled = busy || !hasText || index <= 0;
    $("#next-button").disabled = busy || !hasText || index >= sentences.length - 1;
    progressRange.disabled = busy || !hasText;
    const progress = sameSource(source, playback.source) ? Math.min(1, Math.max(0, playback.progress || 0)) : 0;
    if (!draggingProgress) progressRange.value = String(Math.round(progress * 1000));
    progressRange.setAttribute("aria-valuetext", `${Math.round(progress * 100)} percent read`);
    const seconds = sameSource(source, playback.source) && Number.isFinite(playback.remainingSeconds)
      ? playback.remainingSeconds : (1 - progress) * sourceWordCount / (190 * (Number(rateSelect.value) || 1)) * 60;
    const time = seconds > 0 && seconds < 60 ? "<1 min" : `${Math.ceil(seconds / 60)} min`;
    $("#remaining-time").textContent = `${Math.round(progress * 100)}% · ${time} left`;
    $("#playback-label").textContent = listening
      ? `${paused ? "Paused" : "Listening"} · ${index + 1} / ${sentences.length}`
      : playback.status === "finished" && sameSource(source, playback.source) ? "Finished reading" : "Ready when you are";
    if (listening) $("#resume-banner").hidden = true;
  }

  function renderPlayback(state) {
    if (!state) return;
    const stoppedReading = active() && state.status === "idle";
    playback = state;
    if (active()) positionGeneration += 1;
    if (state.source?.text && !sameSource(source, state.source)) renderSource(state.source);
    if (state.uiPreferences && typeof state.uiPreferences.follow === "boolean") {
      $("#follow-reading").checked = state.uiPreferences.follow;
    }
    if (state.settings) {
      setRate(state.settings.rate);
      if (voices.some((voice) => voice.voiceName === state.settings.voiceName)) voiceSelect.value = state.settings.voiceName;
    }
    renderControls();
    renderHighlight();
    renderVoiceNote();
    if (state.status === "error") setStatus(state.error || "Could not read this text.", true);
    if (stoppedReading && source) showSavedPosition(source).catch((error) => setStatus(error.message, true));
  }

  async function command(message) {
    if (busy) return null;
    busy = true;
    renderControls();
    setStatus();
    try {
      const response = await send(message);
      if (response.state) renderPlayback(response.state);
      return response;
    } catch (error) { setStatus(error.message, true); return null; }
    finally { busy = false; renderControls(); }
  }

  async function showSavedPosition(nextSource) {
    const generation = ++positionGeneration;
    const response = await send({ type: "GET_POSITION", source: nextSource });
    if (generation !== positionGeneration || !sameSource(source, nextSource) || active()
      || playback.status === "finished") return;
    savedPosition = response.position || null;
    const progress = Math.max(0, Math.min(1, Number(savedPosition?.progress) || 0));
    $("#resume-banner").hidden = !savedPosition || savedPosition.charIndex <= 0 || progress >= .99;
    $("#resume-detail").textContent = `Pick up where you left off · ${Math.round(progress * 100)}% read.`;
  }

  async function prepareSource(nextSource) {
    const response = await send({ type: "PREPARE_SOURCE", source: nextSource });
    renderSource(nextSource);
    if (response.state) renderPlayback(response.state);
    renderControls();
    await showSavedPosition(nextSource);
  }

  async function loadPage() {
    const generation = ++loadGeneration;
    $("#load-page").disabled = true;
    setStatus("Finding readable text…");
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active page found. Paste text above to listen.");
      const response = await documentLoader.loadTab(tab.id);
      if (!response) return;
      if (generation !== loadGeneration) return;
      $("#paste-section").open = false;
      if (response.source.kind !== "pdf") setStatus("Click a sentence to read from there.");
    } catch (error) {
      if (generation !== loadGeneration) return;
      const message = /Cannot access|Missing host permission|Cannot read|extensions gallery|chrome:\/\//iu.test(error.message)
        ? "Open Sona from the toolbar on this page, then load it here. Chrome’s protected pages can be read by pasting text."
        : error.message;
      setStatus(message, true);
      if (!source) $("#paste-section").open = true;
    } finally { if (generation === loadGeneration) $("#load-page").disabled = false; }
  }

  async function loadVoices(preferred) {
    const response = await send({ type: "GET_VOICES" });
    const order = (voice) => voice.remote ? 4 : voice.engine === "native" ? 0 : voice.engine === "web" ? 1 : 2;
    voices = (response.voices || []).filter((voice, index, all) =>
      all.findIndex((other) => other.voiceName === voice.voiceName) === index)
      .sort((first, second) => order(first) - order(second) || first.voiceName.localeCompare(second.voiceName));
    voiceSelect.replaceChildren();
    if (!voices.length) {
      voiceSelect.add(new Option("Speech voice unavailable", ""));
      voiceSelect.disabled = true;
      setStatus("The bundled voice did not load. Reload Sona in chrome://extensions and try again.", true);
      return;
    }
    voiceSelect.disabled = false;
    for (const voice of voices) {
      voiceSelect.add(new Option(`${voice.voiceName}${voice.lang ? ` · ${voice.lang}` : ""}${voice.remote ? " · Online" : ""}`, voice.voiceName));
    }
    const local = voices.filter((voice) => !voice.remote);
    const preferredEngine = local[0]?.engine;
    const pool = local.filter((voice) => voice.engine === preferredEngine);
    const language = navigator.language || "en";
    const chosen = voices.find((voice) => voice.voiceName === preferred)
      || pool.find((voice) => voice.lang?.toLowerCase() === language.toLowerCase())
      || pool.find((voice) => voice.lang?.split("-")[0] === language.split("-")[0])
      || pool[0] || voices[0];
    voiceSelect.value = chosen.voiceName;
    renderVoiceNote();
  }

  async function saveSettings() {
    const settings = currentSettings();
    await chrome.storage.local.set(settings);
    await command({ type: "SETTINGS", settings });
  }

  async function readFrom(charIndex, resume = false, preservePause = false) {
    if (!source?.text) return;
    $("#resume-banner").hidden = true;
    manuallyScrolled = false;
    if (sameSource(source, playback.source)
      && (playback.status === "playing" || (playback.status === "paused" && preservePause))) {
      return command({ type: "SEEK", charIndex });
    }
    return command({ type: "START", source, settings: currentSettings(),
      ...(resume ? { resume: true } : { startOffset: charIndex }) });
  }

  $("#play-button").addEventListener("click", () => {
    if (sameSource(source, playback.source) && playback.status === "playing") return command({ type: "PAUSE" });
    if (sameSource(source, playback.source) && playback.status === "paused") return command({ type: "RESUME" });
    if (savedPosition?.charIndex > 0 && savedPosition.progress < .99 && playback.status !== "finished") {
      return readFrom(savedPosition.charIndex, true);
    }
    return readFrom(sameSource(source, playback.source) && playback.status !== "finished" ? playback.charIndex || 0 : 0);
  });
  $("#stop-button").addEventListener("click", () => command({ type: "STOP" }));
  for (const [selector, direction] of [["#prev-button", -1], ["#next-button", 1]]) {
    $(selector).addEventListener("click", () => {
      const index = sentenceIndex(playback.charIndex || 0);
      const next = sentences[Math.min(sentences.length - 1, Math.max(0, index + direction))];
      if (next) readFrom(next.start, false, true);
    });
  }
  $("#load-page").addEventListener("click", loadPage);
  $("#resume-saved").addEventListener("click", () => readFrom(savedPosition?.charIndex || 0, true));
  $("#start-over").addEventListener("click", () => readFrom(0));
  article.addEventListener("click", (event) => {
    const sentence = event.target.closest(".sentence");
    if (sentence && !window.getSelection()?.toString()) readFrom(sentences[Number(sentence.dataset.index)].start);
  });
  article.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    const sentence = event.target.closest(".sentence");
    if (!sentence) return;
    event.preventDefault();
    readFrom(sentences[Number(sentence.dataset.index)].start);
  });
  $("#paste-input").addEventListener("input", () => {
    const count = wordCount($("#paste-input").value);
    $("#paste-count").textContent = `${count.toLocaleString()} ${count === 1 ? "word" : "words"}`;
    $("#read-paste").disabled = !count;
  });
  $("#read-paste").addEventListener("click", async () => {
    if (documentLoader.busy) documentLoader.cancel();
    const text = $("#paste-input").value.trim();
    if (!text || busy) return;
    ++loadGeneration;
    $("#load-page").disabled = false;
    const nextSource = { text, title: "Your text", kind: "paste" };
    renderSource(ReaderPlayback.normalizeSource(nextSource));
    $("#paste-section").open = false;
    await command({ type: "START", source: nextSource, settings: currentSettings() });
  });
  progressRange.addEventListener("pointerdown", () => { draggingProgress = true; });
  progressRange.addEventListener("input", () => {
    draggingProgress = true;
    progressRange.setAttribute("aria-valuetext", `${Math.round(Number(progressRange.value) / 10)} percent read`);
  });
  progressRange.addEventListener("change", () => {
    const position = Number(progressRange.value) / 1000 * (source?.text.length || 0);
    draggingProgress = false;
    const index = sentenceIndex(position);
    if (index >= 0) readFrom(sentences[index].start, false, true);
  });
  progressRange.addEventListener("pointercancel", () => { draggingProgress = false; renderControls(); });
  document.addEventListener("pointerup", () => {
    // A range's change event follows pointerup in some browsers. Give it time
    // to read the chosen value before restoring the current playback value.
    requestAnimationFrame(() => {
      if (draggingProgress) { draggingProgress = false; renderControls(); }
    });
  });
  voiceSelect.addEventListener("change", () => {
    renderVoiceNote();
    saveSettings().catch((error) => setStatus(error.message, true));
  });
  rateSelect.addEventListener("change", () => {
    renderControls();
    saveSettings().catch((error) => setStatus(error.message, true));
  });
  $("#text-size").addEventListener("change", () => {
    preferences.textSize = Number($("#text-size").value);
    saveAppearance().catch((error) => setStatus(error.message, true));
  });
  $("#theme-toggle").addEventListener("click", () => {
    preferences.dark = !preferences.dark;
    saveAppearance().catch((error) => setStatus(error.message, true));
  });
  $("#follow-reading").addEventListener("change", async () => {
    manuallyScrolled = false;
    const follow = $("#follow-reading").checked;
    if (follow) scrollToCurrent();
    followCurrent();
    try {
      const response = await send({ type: "UI_PREFS", preferences: { follow } });
      if (response.state) renderPlayback(response.state);
    } catch (error) { setStatus(error.message, true); }
  });
  function manualScroll() {
    if (currentSentence < 0) return;
    manuallyScrolled = true;
    followCurrent();
  }
  scrollArea.addEventListener("wheel", manualScroll, { passive: true });
  scrollArea.addEventListener("touchmove", manualScroll, { passive: true });
  scrollArea.addEventListener("keydown", (event) => {
    if (["PageDown", "PageUp", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) manualScroll();
  });
  scrollArea.addEventListener("pointerdown", (event) => {
    // Dragging the native scrollbar also counts as choosing another place.
    if (event.offsetX >= scrollArea.clientWidth) manualScroll();
  });
  scrollArea.addEventListener("scroll", () => {
    if (manuallyScrolled || !$("#follow-reading").checked) followCurrent();
  }, { passive: true });
  $("#back-to-reading").addEventListener("click", () => {
    manuallyScrolled = false;
    scrollToCurrent();
    $("#back-to-reading").hidden = true;
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CHECK_EDITING") {
      if (!document.hasFocus()) return false;
      const focused = document.activeElement;
      if (focused?.matches("input, textarea, select") || focused?.isContentEditable) sendResponse({ editing: true });
      return false;
    }
    if (message?.type === "STATE") renderPlayback(message.state);
    return false;
  });
  chrome.tts.onVoicesChanged?.addListener(() => {
    loadVoices(voiceSelect.value).catch((error) => setStatus(error.message, true));
  });

  async function initialize() {
    const [stored, response] = await Promise.all([
      chrome.storage.local.get({ rate: 1, voiceName: "", [preferencesKey]: {} }),
      send({ type: "GET_STATE" })
    ]);
    const saved = stored[preferencesKey] || {};
    preferences = { textSize: [16, 18, 20, 24].includes(Number(saved.textSize)) ? Number(saved.textSize) : 20, dark: saved.dark === true };
    renderAppearance();
    playback = response.state || playback;
    setRate(playback.settings?.rate ?? stored.rate);
    await loadVoices(playback.settings?.voiceName || stored.voiceName);
    ready = true;
    renderPlayback(playback);
    if (playback.source?.text) {
      if (!active()) await showSavedPosition(playback.source);
    } else await loadPage();
    renderControls();
  }
  initialize().catch((error) => {
    ready = true;
    renderControls();
    $("#paste-section").open = !source;
    setStatus(error.message, true);
  });
})();
