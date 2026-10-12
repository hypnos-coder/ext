/* Text stays in session storage; preferences stay on this device. */
const $ = (selector) => document.querySelector(selector);
const textInput = $("#text-input");
const voiceSelect = $("#voice-select");
const rateRange = $("#rate-range");
const playButton = $("#play-button");
let source = { text: "", title: "Your text", kind: "paste" };
let pageSource = null;
let pasteDraft = "";
let mode = "page";
let playback = { status: "idle", progress: 0 };
let voices = [];
let ready = false;
let busy = false;
let sourceIssue = "";
let loadGeneration = 0;
let savedPosition = null;
let positionGeneration = 0;
let currentWindowId;
let seeking = false;
const documentLoader = SonaDocuments.create({ mount: $("#document-tools"), setStatus,
  beforeLoad() { sourceIssue = ""; stopForSourceChange(); $("#load-page").disabled = true; updateTextStats(); },
  afterLoad() { $("#load-page").disabled = false; updateTextStats(); },
  async onSource(nextSource) {
    const prepared = await sendMessage({ type: "PREPARE_SOURCE", source: nextSource });
    pageSource = { ...(prepared.state?.source || nextSource) };
    renderSource(pageSource);
    renderPlayback(prepared.state || playback);
    await saveDraft();
  }
});

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}
function setStatus(message, error = false) {
  $("#status").textContent = message;
  $("#status").dataset.error = String(error);
}
function wordCount(text) { return text.trim().split(/\s+/u).filter(Boolean).length; }
function isActive() { return ["playing", "paused"].includes(playback.status); }
function updateTextStats() {
  const count = wordCount(textInput.value);
  $("#character-count").textContent = `${count.toLocaleString()} ${count === 1 ? "word" : "words"}`;
  const seconds = Math.max(1, Math.round(count / (190 * Number(rateRange.value)) * 60));
  $("#reading-time").textContent = count ? (seconds < 60 ? `~${seconds} sec of listening` : `~${Math.ceil(seconds / 60)} min of listening`) : "Add some text to begin";
  playButton.disabled = !ready || busy || documentLoader.busy || (!textInput.value.trim() && !isActive());
}
function setMode(nextMode) {
  mode = nextMode;
  for (const id of ["page", "paste"]) {
    $(`#${id}-mode`).classList.toggle("active", mode === id);
    $(`#${id}-mode`).setAttribute("aria-pressed", String(mode === id));
  }
  $("#load-page").hidden = mode !== "page";
}
function renderSource(nextSource) {
  source = { ...nextSource };
  textInput.value = source.text || "";
  setMode(["page", "selection", "pdf"].includes(source.kind) ? "page" : "paste");
  documentLoader.setSource(source);
  $("#source-label").textContent = source.title || (mode === "paste" ? "Your text, your soundtrack" : "This page");
  $("#source-label").title = $("#source-label").textContent;
  let domain = "";
  try { domain = new URL(source.url).hostname.replace(/^www\./, ""); } catch { /* Pasted content has no URL. */ }
  $("#source-detail").textContent = mode === "paste" ? "Paste or edit anything you’d like to hear" : `${source.kind === "pdf" ? `PDF · ${source.pdf?.totalPages || ""} pages` : source.kind === "selection" ? "Selected passage" : "Page article"}${domain ? ` · ${domain}` : ""}`;
  updateTextStats();
  refreshSavedPosition();
}
function renderResumeOffer() {
  const show = Boolean(savedPosition && !isActive() && ["page", "selection", "pdf"].includes(source.kind));
  $("#resume-card").hidden = !show;
  $(".reading-card").dataset.resume = String(show);
  $("#resume-position").textContent = `Your place is saved · ${Math.round((savedPosition?.progress || 0) * 100)}%`;
}
async function refreshSavedPosition() {
  const generation = ++positionGeneration;
  savedPosition = null;
  renderResumeOffer();
  if (!source.text || !source.url || !["page", "selection", "pdf"].includes(source.kind)) return;
  try {
    const response = await sendMessage({ type: "GET_POSITION", source: { ...source, text: textInput.value } });
    if (generation !== positionGeneration) return;
    savedPosition = response.position;
    renderResumeOffer();
    if (!isActive() && savedPosition) $("#play-label").textContent = "Resume article";
  } catch (error) { setStatus(error.message, true); }
}
async function saveDraft() {
  if (mode === "paste") pasteDraft = textInput.value;
  await chrome.storage.session.set({ sonaDraft: { source: { ...source, text: textInput.value }, pasteDraft, mode } });
}
function queueDraft() {
  // Invoke the storage API before the popup closes; a debounce can lose edits.
  saveDraft().catch((error) => setStatus(error.message, true));
}
function stopForSourceChange() {
  if (playback.status === "idle") return;
  sendMessage({ type: "STOP" }).then((result) => renderPlayback(result.state))
    .catch((error) => setStatus(error.message, true));
}
function renderControlAvailability() {
  const active = isActive();
  $("#stop-button").disabled = busy || !active;
  $("#prev-button").disabled = busy || !active || playback.currentIndex === 0;
  $("#next-button").disabled = busy || !active || playback.currentIndex >= playback.totalSegments - 1;
}
function renderPlayback(state) {
  if (!state) return;
  const wasActive = isActive();
  playback = state;
  const active = isActive();
  const paused = state.status === "paused";
  $("#play-label").textContent = state.status === "playing" ? "Pause" : paused ? "Resume" : savedPosition ? "Resume article" : state.status === "finished" ? "Play again" : "Play";
  $("#play-icon").innerHTML = state.status === "playing" ? '<path d="M7 5h3v14H7zM14 5h3v14h-3z"/>' : '<path d="m8 5 11 7-11 7V5Z"/>';
  playButton.setAttribute("aria-label", state.status === "playing" ? "Pause reading" : paused ? "Resume reading" : "Read text aloud");
  renderControlAvailability();
  const progress = Math.round(Math.min(1, Math.max(0, state.progress || 0)) * 100);
  if (!seeking) $("#progress").value = Math.round(progress * 10);
  $("#progress").disabled = busy || !state.source?.text || state.source.text !== textInput.value;
  $("#progress-label").textContent = `${progress}%`;
  const remaining = Math.max(0, Math.ceil(state.remainingSeconds || 0));
  const timeLeft = remaining < 60 ? `${remaining}s left` : `${Math.ceil(remaining / 60)}m left`;
  $("#playback-label").textContent = active ? `${paused ? "Paused" : "Listening"} · ${timeLeft} · ${state.currentIndex + 1}/${state.totalSegments}` : state.status === "finished" ? "All done. Well listened." : "Ready when you are";
  if (document.activeElement !== rateRange && Number.isFinite(state.settings?.rate)) {
    rateRange.value = String(state.settings.rate);
    $("#rate-value").textContent = `${Number(rateRange.value).toFixed(1)}×`;
  }
  const currentVoiceName = state.settings?.voiceName || (active ? state.voice?.voiceName : "");
  if (currentVoiceName && document.activeElement !== voiceSelect && voices.some((voice) => voice.voiceName === currentVoiceName)) voiceSelect.value = currentVoiceName;
  if (state.status === "error") setStatus(state.error || "Could not read this text.", true);
  else if (active) setStatus(paused ? "Take your time. Your place is saved." : "Keep listening after closing this popup.");
  else if (sourceIssue) setStatus(sourceIssue, true);
  else if (source.truncated) setStatus(source.kind === "pdf" ? "PDF extraction limit reached. Choose another page range in PDF options to continue." : "Showing the first 100,000 characters of this page.");
  else if (source.kind === "pdf") setStatus("PDF text extracted locally. Open Reader to follow the highlighted sentences.");
  else if (!voices.length && ready) setStatus("The bundled voice did not load. Reload Sona in chrome://extensions and try again.", true);
  else setStatus(state.status === "finished" ? "Finished reading." : "Select a passage on the page to read just that part.");
  updateTextStats();
  updateVoiceInfo();
  renderResumeOffer();
  if (wasActive && !active && state.status === "idle") refreshSavedPosition();
}
async function loadPage() {
  stopForSourceChange();
  const generation = ++loadGeneration;
  $("#load-page").disabled = true;
  $("#source-label").textContent = "Finding your page…";
  sourceIssue = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active page found. Use Paste text instead.");
    const result = await documentLoader.loadTab(tab.id);
    if (!result) return;
    if (generation !== loadGeneration) return;
    pageSource = { ...result.source, tabId: tab.id };
    renderSource(pageSource);
    if (!pageSource.text.trim()) sourceIssue = "This page has no readable text. Try selecting a passage or pasting text.";
    await saveDraft();
  } catch (error) {
    if (generation !== loadGeneration) return;
    pageSource = null;
    sourceIssue = /Cannot access|Missing host permission|Cannot read|extensions gallery|chrome:\/\//i.test(error.message)
      ? "Chrome protects this page from extensions. Switch to Paste text to listen."
      : error.message;
    renderSource({ text: "", title: "Paste text to get started", kind: "page" });
    $("#source-detail").textContent = "This page is unavailable to the reader";
  } finally {
    if (generation === loadGeneration) {
      $("#load-page").disabled = false;
      renderPlayback(playback);
    }
  }
}
function voiceDescription(voice) {
  let language = voice.lang;
  try { language = new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(voice.lang); } catch { /* Use the code if unsupported. */ }
  return `${voice.voiceName}${language ? ` · ${language}` : ""}${voice.remote ? " · Online" : ""}`;
}
function updateVoiceInfo() {
  const voice = voices.find((item) => item.voiceName === voiceSelect.value);
  $("#voice-badge").textContent = voice?.remote ? "ONLINE" : voice?.engine === "offline" ? "BUNDLED" : "DEVICE";
  $("#voice-note").textContent = voice?.remote ? "Online voice · text is sent to its speech provider."
    : voice?.engine === "offline" ? "Built-in English voice · works offline."
      : "Local voices. No account. Just listen.";
}
async function loadVoices(preferredVoice = voiceSelect.value) {
  const response = await sendMessage({ type: "GET_VOICES" });
  const available = response.voices || [];
  const order = (voice) => voice.remote ? 4 : voice.engine === "native" ? 0 : voice.engine === "web" ? 1 : 2;
  voices = available.sort((a, b) => order(a) - order(b) || a.voiceName.localeCompare(b.voiceName));
  voices = voices.filter((voice, index) => voices.findIndex((item) => item.voiceName === voice.voiceName) === index);
  voiceSelect.replaceChildren();
  if (!voices.length) {
    voiceSelect.add(new Option("Speech voice unavailable", ""));
    voiceSelect.disabled = true;
  } else {
    voiceSelect.disabled = false;
    for (const voice of voices) voiceSelect.add(new Option(voiceDescription(voice), voice.voiceName));
    const language = navigator.language || "en";
    const local = voices.filter((voice) => !voice.remote);
    const preferredEngine = local.some((voice) => voice.engine === "native") ? "native"
      : local.some((voice) => voice.engine === "web") ? "web" : "offline";
    const pool = local.filter((voice) => voice.engine === preferredEngine);
    const preferred = voices.find((voice) => voice.voiceName === preferredVoice)
      || pool.find((voice) => voice.lang?.toLowerCase() === language.toLowerCase())
      || pool.find((voice) => voice.lang?.split("-")[0] === language.split("-")[0])
      || pool[0]
      || voices[0];
    voiceSelect.value = preferred.voiceName;
  }
  renderPlayback(playback);
}
function currentSettings() { return { voiceName: voiceSelect.value, rate: Number(rateRange.value) }; }
async function saveSettings() {
  const settings = currentSettings();
  await chrome.storage.local.set(settings);
  renderPlayback((await sendMessage({ type: "SETTINGS", settings })).state);
}
async function command(message) {
  if (busy) return;
  busy = true;
  renderPlayback(playback);
  try { renderPlayback((await sendMessage(message)).state); }
  catch (error) { setStatus(error.message, true); }
  finally { busy = false; updateTextStats(); renderControlAvailability(); }
}
playButton.addEventListener("click", async () => {
  if (playback.status === "playing") return command({ type: "PAUSE" });
  if (playback.status === "paused") return command({ type: "RESUME" });
  sourceIssue = "";
  await saveDraft().catch(() => {});
  await command({ type: "START", source: { ...source, text: textInput.value }, settings: currentSettings(), resume: Boolean(savedPosition) });
});
$("#resume-reading").addEventListener("click", () => command({ type: "START", source: { ...source, text: textInput.value }, settings: currentSettings(), resume: true }));
$("#restart-reading").addEventListener("click", () => command({ type: "START", source: { ...source, text: textInput.value }, settings: currentSettings(), startOffset: 0 }));
$("#progress").addEventListener("input", () => { seeking = true; });
$("#progress").addEventListener("change", async () => {
  const charIndex = Math.round(Number($("#progress").value) / 1000 * (playback.totalCharacters || 0));
  seeking = false;
  await command({ type: "SEEK", charIndex });
});
$("#open-reader").addEventListener("click", async () => {
  // Send open during the click, before awaiting, to retain Chrome's user gesture.
  const showingCurrentReading = isActive() && playback.source?.text === textInput.value;
  const prepare = textInput.value.trim() && !showingCurrentReading
    ? sendMessage({ type: "PREPARE_SOURCE", source: { ...source, text: textInput.value } }) : Promise.resolve();
  const open = sendMessage({ type: "OPEN_READER", windowId: currentWindowId });
  try { await Promise.all([prepare, open]); }
  catch (error) { setStatus(error.message, true); }
});
$("#stop-button").addEventListener("click", () => command({ type: "STOP" }));
$("#prev-button").addEventListener("click", () => command({ type: "SKIP", direction: -1 }));
$("#next-button").addEventListener("click", () => command({ type: "SKIP", direction: 1 }));
$("#load-page").addEventListener("click", loadPage);
$("#page-mode").addEventListener("click", async () => {
  stopForSourceChange();
  pasteDraft = mode === "paste" ? textInput.value : pasteDraft;
  if (pageSource) { renderSource(pageSource); sourceIssue = ""; renderPlayback(playback); await saveDraft().catch((error) => setStatus(error.message, true)); }
  else await loadPage();
});
$("#paste-mode").addEventListener("click", () => {
  if (documentLoader.busy) documentLoader.cancel();
  stopForSourceChange();
  ++loadGeneration;
  $("#load-page").disabled = false;
  sourceIssue = "";
  renderSource({ text: pasteDraft, title: "Your text, your soundtrack", kind: "paste" });
  renderPlayback(playback);
  queueDraft();
  textInput.focus();
});
textInput.addEventListener("input", () => {
  if (documentLoader.busy) documentLoader.cancel();
  stopForSourceChange();
  source = { text: textInput.value, title: "Your text, your soundtrack", kind: "paste" };
  sourceIssue = "";
  savedPosition = null;
  ++positionGeneration;
  renderResumeOffer();
  setMode("paste");
  $("#source-label").textContent = source.title;
  $("#source-detail").textContent = "Paste or edit anything you’d like to hear";
  updateTextStats();
  queueDraft();
});
rateRange.addEventListener("input", () => {
  $("#rate-value").textContent = `${Number(rateRange.value).toFixed(1)}×`;
  updateTextStats();
});
rateRange.addEventListener("change", () => saveSettings().catch((error) => setStatus(error.message, true)));
voiceSelect.addEventListener("change", () => {
  updateVoiceInfo();
  saveSettings().catch((error) => setStatus(error.message, true));
});
$("#help-button").addEventListener("click", () => {
  const open = $("#help-panel").hidden;
  $("#help-panel").hidden = !open;
  $("#help-button").setAttribute("aria-expanded", String(open));
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "CHECK_EDITING") {
    if (document.hasFocus()) {
      const element = document.activeElement;
      if (element && (element.matches("input, textarea, select") || element.isContentEditable)) sendResponse({ editing: true });
    }
    return false;
  }
  if (message.type !== "STATE") return;
  if (["playing", "paused"].includes(message.state?.status) && message.state.source?.text) {
    if (message.state.source.text === textInput.value) {
      // A fresh extraction has a new DOM map even when its article text is equal.
      source = { ...message.state.source };
      if (["page", "selection", "pdf"].includes(source.kind)) pageSource = { ...source };
    } else if (message.state.sessionId !== playback.sessionId) renderSource(message.state.source);
  }
  renderPlayback(message.state);
});
chrome.tts.onVoicesChanged?.addListener(() => loadVoices().catch((error) => setStatus(error.message, true)));
async function initialize() {
  const [preferences, draft, response, currentWindow] = await Promise.all([
    chrome.storage.local.get({ rate: 1, voiceName: "" }),
    chrome.storage.session.get("sonaDraft"),
    sendMessage({ type: "GET_STATE" }),
    chrome.windows.getCurrent()
  ]);
  currentWindowId = currentWindow.id;
  $("#open-reader").disabled = false;
  const state = response.state;
  playback = state || playback;
  const saved = draft.sonaDraft;
  pasteDraft = saved?.pasteDraft || "";
  const rate = Number(isActive() ? state.settings?.rate : preferences.rate);
  rateRange.value = String(Number.isFinite(rate) ? Math.max(.5, Math.min(3, rate)) : 1);
  $("#rate-value").textContent = `${Number(rateRange.value).toFixed(1)}×`;
  await loadVoices(isActive() ? state.settings?.voiceName : preferences.voiceName);
  ready = true;
  if (state?.source?.text && ["playing", "paused"].includes(state.status)) {
    renderSource(state.source);
    if (mode === "page") pageSource = { ...state.source };
    else pasteDraft = state.source.text;
  } else if (saved?.source?.kind === "pdf") {
    renderSource(saved.source);
    pageSource = { ...saved.source };
  } else if (saved?.mode === "paste") {
    renderSource({ ...saved.source, text: pasteDraft || saved.source.text || "" });
  } else if (state?.source?.text && ["error", "finished"].includes(state.status)) {
    renderSource(state.source);
    if (mode === "page") pageSource = { ...state.source };
  } else await loadPage();
  renderPlayback(playback);
}
initialize().catch((error) => {
  ready = true;
  setMode("paste");
  renderSource({ text: "", title: "Paste text to get started", kind: "paste" });
  setStatus(error.message, true);
});
