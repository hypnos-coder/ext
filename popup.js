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
  playButton.disabled = !ready || busy || (!textInput.value.trim() && !isActive());
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
  setMode(["page", "selection"].includes(source.kind) ? "page" : "paste");
  $("#source-label").textContent = source.title || (mode === "paste" ? "Your text, your soundtrack" : "This page");
  $("#source-label").title = $("#source-label").textContent;
  let domain = "";
  try { domain = new URL(source.url).hostname.replace(/^www\./, ""); } catch { /* Pasted content has no URL. */ }
  $("#source-detail").textContent = mode === "paste" ? "Paste or edit anything you’d like to hear" : `${source.kind === "selection" ? "Selected passage" : "Page article"}${domain ? ` · ${domain}` : ""}`;
  updateTextStats();
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
  playback = state;
  const active = isActive();
  const paused = state.status === "paused";
  $("#play-label").textContent = state.status === "playing" ? "Pause" : paused ? "Resume" : state.status === "finished" ? "Play again" : "Play";
  $("#play-icon").innerHTML = state.status === "playing" ? '<path d="M7 5h3v14H7zM14 5h3v14h-3z"/>' : '<path d="m8 5 11 7-11 7V5Z"/>';
  playButton.setAttribute("aria-label", state.status === "playing" ? "Pause reading" : paused ? "Resume reading" : "Read text aloud");
  renderControlAvailability();
  const progress = Math.round(Math.min(1, Math.max(0, state.progress || 0)) * 100);
  $("#progress").value = progress;
  $("#progress-label").textContent = `${progress}%`;
  $("#playback-label").textContent = active ? `${paused ? "Paused" : "Listening"} · passage ${state.currentIndex + 1} of ${state.totalSegments}` : state.status === "finished" ? "All done. Well listened." : "Ready when you are";
  if (state.status === "error") setStatus(state.error || "Could not read this text.", true);
  else if (active) setStatus(paused ? "Take your time. Your place is saved." : "Keep listening after closing this popup.");
  else if (sourceIssue) setStatus(sourceIssue, true);
  else if (source.truncated) setStatus("Showing the first 100,000 characters of this page.");
  else if (!voices.length && ready) setStatus("The bundled voice did not load. Reload Sona in chrome://extensions and try again.", true);
  else setStatus(state.status === "finished" ? "Finished reading." : "Select a passage on the page to read just that part.");
  updateTextStats();
  updateVoiceInfo();
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
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const result = await chrome.tabs.sendMessage(tab.id, { type: "READ_PAGE" });
    if (result?.error) throw new Error(result.error);
    if (!result?.source) throw new Error("No readable text found. Use Paste text instead.");
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
      : `${error.message} You can use Paste text instead.`;
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
  await command({ type: "START", source: { ...source, text: textInput.value }, settings: currentSettings() });
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
  stopForSourceChange();
  source = { text: textInput.value, title: "Your text, your soundtrack", kind: "paste" };
  sourceIssue = "";
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
chrome.runtime.onMessage.addListener((message) => { if (message.type === "STATE") renderPlayback(message.state); });
chrome.tts.onVoicesChanged?.addListener(() => loadVoices().catch((error) => setStatus(error.message, true)));
async function initialize() {
  const [preferences, draft, response] = await Promise.all([
    chrome.storage.local.get({ rate: 1, voiceName: "" }),
    chrome.storage.session.get("sonaDraft"),
    sendMessage({ type: "GET_STATE" })
  ]);
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
