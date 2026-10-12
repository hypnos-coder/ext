(() => {
  "use strict";

  // executeScript may run every time the popup opens. Keep one listener per tab.
  if (globalThis.__sonaPageReader) return;
  globalThis.__sonaPageReader = true;

  const MAX_TEXT = 100000;
  const HIGHLIGHT_NAME = "sona-current-sentence";
  const EXCLUDED = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "NAV", "HEADER", "FOOTER", "ASIDE",
    "BUTTON", "FORM", "INPUT", "TEXTAREA", "SELECT", "OPTION", "IFRAME",
    "OBJECT", "SVG", "CANVAS", "TEMPLATE"
  ]);
  const BLOCKS = new Set([
    "ADDRESS", "ARTICLE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION",
    "FIGURE", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "MAIN", "OL",
    "P", "PRE", "SECTION", "TABLE", "TD", "TH", "TR", "UL"
  ]);
  const extractions = new Map();
  let newestExtraction = null;
  let currentState = null;
  let currentSession = null;
  let hiddenSession = null;
  let panel = null;
  let highlightStyle = null;
  let highlightedRangeKey = "";

  function excludedElement(element, selected) {
    if (element.hasAttribute("data-sona-reader") || element.hidden
      || element.getAttribute("aria-hidden") === "true") return true;
    if (selected) {
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(element.tagName)) return true;
    } else {
      if (EXCLUDED.has(element.tagName)) return true;
      if (["navigation", "banner", "contentinfo", "complementary", "button", "menu"]
        .includes(element.getAttribute("role"))) return true;
    }
    const style = getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden"
      || style.visibility === "collapse" || style.contentVisibility === "hidden";
  }

  // Each emitted text span remembers its original node and offsets. Paragraph
  // separators are synthetic, so Range endpoints use their nearest real span.
  function createBuilder() {
    const parts = [];
    const segments = [];
    const snapshots = new Map();
    let length = 0;
    let pending = null;
    let truncated = false;
    let linkCharacters = 0;

    function separator(paragraph, node = null, start = 0, end = 0) {
      if (!length) return;
      if (paragraph || pending?.paragraph) {
        pending = { paragraph: true };
      } else if (!pending) {
        pending = { paragraph: false, node, start, end };
      }
    }

    function append(value, node, nodeStart, nodeEnd, inLink) {
      if (!value || truncated) return;
      if (pending) {
        const spacing = pending.paragraph ? "\n\n" : " ";
        const amount = Math.min(spacing.length, MAX_TEXT - length);
        if (amount) {
          parts.push(spacing.slice(0, amount));
          if (pending.node) {
            segments.push({ start: length, end: length + amount, node: pending.node,
              nodeStart: pending.start, nodeEnd: pending.end, collapsed: true });
            snapshots.set(pending.node, pending.node.data);
          }
          length += amount;
        }
        pending = null;
      }
      let amount = Math.min(value.length, MAX_TEXT - length);
      // Do not leave half a Unicode surrogate pair at the truncation boundary.
      if (amount < value.length && amount > 0
        && /[\uD800-\uDBFF]/.test(value[amount - 1])) amount -= 1;
      if (amount) {
        parts.push(value.slice(0, amount));
        if (node) {
          segments.push({ start: length, end: length + amount, node,
            nodeStart, nodeEnd: nodeStart + amount, collapsed: false });
          snapshots.set(node, node.data);
        }
        if (inLink) linkCharacters += amount;
        length += amount;
      }
      if (amount < value.length) truncated = true;
    }

    function text(node, start, end, inLink) {
      const value = node.data.slice(start, end);
      for (const match of value.matchAll(/\s+|\S+/gu)) {
        if (truncated) break;
        const offset = start + match.index;
        if (/^\s/u.test(match[0])) {
          separator(false, node, offset, offset + match[0].length);
        } else {
          append(match[0], node, offset, offset + match[0].length, inLink);
        }
      }
    }

    function finish() {
      const text = parts.join("").trimEnd();
      return { text, segments: segments.filter((span) => span.start < text.length),
        snapshots, truncated, linkCharacters };
    }
    return { separator, text, finish, get truncated() { return truncated; } };
  }

  function extractTree(root, range = null) {
    const builder = createBuilder();
    // A candidate article may itself be visible while its ancestor is hidden.
    // Check the ancestor chain because display:none is not inherited in CSS.
    for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (excludedElement(ancestor, Boolean(range))) return builder.finish();
    }
    function visit(node, inLink = false) {
      if (builder.truncated) return;
      if (range) {
        try { if (!range.intersectsNode(node)) return; } catch { return; }
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const start = range?.startContainer === node ? range.startOffset : 0;
        const end = range?.endContainer === node ? range.endOffset : node.data.length;
        if (end > start) builder.text(node, start, end, inLink);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (excludedElement(node, Boolean(range))) return;
      const block = BLOCKS.has(node.tagName);
      if (block || node.tagName === "BR") builder.separator(true);
      if (node.tagName === "BR") return;
      for (const child of node.childNodes) visit(child, inLink || node.tagName === "A");
      if (block) builder.separator(true);
    }
    visit(root);
    return builder.finish();
  }

  function extractSelection() {
    const active = document.activeElement;
    if ((active?.tagName === "TEXTAREA" || (active?.tagName === "INPUT"
      && ["text", "search", "url", "tel", "email"].includes(active.type)))
      && Number.isInteger(active.selectionStart) && active.selectionEnd > active.selectionStart) {
      const value = active.value.slice(active.selectionStart, active.selectionEnd)
        .replace(/\s+/gu, " ").trim();
      if (value) return { text: value.slice(0, MAX_TEXT), segments: [], snapshots: new Map(),
        truncated: value.length > MAX_TEXT, kind: "selection" };
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return null;
    // Chrome exposes one range for normal user selection. Preserve its original
    // text nodes rather than looking for matching words elsewhere in the page.
    const range = selection.getRangeAt(0).cloneRange();
    const result = extractTree(range.commonAncestorContainer, range);
    return result.text ? { ...result, kind: "selection" } : null;
  }

  function extractPage() {
    let best = null;
    let bestScore = 0;
    const candidates = document.querySelectorAll("article, main, [role='main'], [itemprop='articleBody']");
    // Avoid repeated traversal on pages with hundreds of comment articles.
    for (const candidate of Array.from(candidates).slice(0, 40)) {
      const result = extractTree(candidate);
      const score = result.text.length - result.linkCharacters * 0.65;
      if (result.text.length >= 80 && score > bestScore) {
        best = result;
        bestScore = score;
      }
    }
    return { ...(best || extractTree(document.body || document.documentElement)), kind: "page" };
  }

  function readPage() {
    try {
      const extraction = extractSelection() || extractPage();
      if (!extraction.text) return { error: "This page has no readable text. Select some text or paste it into Sona." };
      const id = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID() : `sona-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const source = { id, text: extraction.text, title: document.title || "Untitled page",
        url: location.href, kind: extraction.kind, truncated: extraction.truncated };
      extractions.set(id, { ...extraction, source });
      newestExtraction = id;
      if (extractions.size > 8) {
        for (const key of extractions.keys()) {
          if (key !== currentState?.source?.id && key !== id) {
            extractions.delete(key);
            break;
          }
        }
      }
      return { source };
    } catch {
      return { error: "Sona could not read this page. Select some text or paste it into the reader." };
    }
  }

  function clearHighlight() {
    try { CSS.highlights?.delete(HIGHLIGHT_NAME); } catch { /* Unsupported browser. */ }
    highlightedRangeKey = "";
  }

  function sourceExtraction(source) {
    if (!source || ["paste", "pasted"].includes(source.kind)) return null;
    if (source.id) return extractions.get(source.id) || null;
    const fallback = extractions.get(newestExtraction);
    return fallback?.source.kind === source.kind && fallback.source.url === source.url
      && fallback.source.title === source.title ? fallback : null;
  }

  function highlightSentence(state) {
    if (!["playing", "paused"].includes(state.status)) return clearHighlight();
    const extraction = sourceExtraction(state.source);
    if (!extraction || !globalThis.CSS?.highlights || typeof Highlight !== "function") return clearHighlight();
    const start = Math.max(0, Number.isFinite(state.segmentStart) ? state.segmentStart : state.charIndex || 0);
    const end = Math.min(extraction.text.length, Number.isFinite(state.segmentEnd)
      ? state.segmentEnd : start + (state.charLength || state.wordLength || 1));
    const rangeKey = `${extraction.source.id}:${start}:${end}`;
    const spans = extraction.segments.filter((span) => span.end > start && span.start < end);
    if (!spans.length || spans.some((span) => !span.node.isConnected
      || span.node.data !== extraction.snapshots.get(span.node))) return clearHighlight();
    if (highlightedRangeKey === rangeKey) return;
    const first = spans[0];
    const last = spans[spans.length - 1];
    function offset(span, position) {
      if (span.collapsed) return position <= span.start ? span.nodeStart : span.nodeEnd;
      return span.nodeStart + Math.max(0, Math.min(span.end - span.start, position - span.start));
    }
    try {
      const range = document.createRange();
      range.setStart(first.node, offset(first, start));
      range.setEnd(last.node, offset(last, end));
      if (!highlightStyle?.isConnected) {
        highlightStyle = document.createElement("style");
        highlightStyle.setAttribute("data-sona-reader", "highlight");
        highlightStyle.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: #e4d9ff; color: inherit; text-decoration: underline; text-decoration-color: #7054de; }`;
        (document.head || document.documentElement).append(highlightStyle);
      }
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
      highlightedRangeKey = rangeKey;
    } catch { clearHighlight(); }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function icon(path) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
    shape.setAttribute("d", path);
    svg.append(shape);
    return svg;
  }

  function control(label, path, action, className = "") {
    const button = element("button", `control ${className}`);
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(icon(path));
    button.addEventListener("click", action);
    return button;
  }

  function sendAction(type, extra = {}) {
    try {
      chrome.runtime.sendMessage({ type, ...extra }, (response) => {
        const error = chrome.runtime.lastError;
        if (error || response?.error) {
          if (panel) panel.status.textContent = response?.error || "Reopen Sona to reconnect the reader.";
        } else if (response?.state) {
          renderState(response.state);
        }
      });
    } catch {
      if (panel) panel.status.textContent = "Reopen Sona to reconnect the reader.";
    }
  }

  function createPanel() {
    const host = element("div");
    host.setAttribute("data-sona-reader", "panel");
    host.style.cssText = "all:initial;position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:calc(100vw - 32px);color-scheme:light;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = element("style");
    style.textContent = `
      :host { color-scheme: light; }
      * { box-sizing: border-box; }
      .reader { width: 316px; max-width: calc(100vw - 32px); padding: 18px; border: 1px solid #e7e0f8; border-radius: 22px; background: #fff; color: #262136; box-shadow: 0 12px 48px #31234526, 0 3px 10px #3123450c; font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      .top { display: flex; align-items: center; gap: 9px; margin-bottom: 13px; }
      .brand { font-size: 14px; font-weight: 750; letter-spacing: -.3px; }
      .waves { display: flex; height: 22px; align-items: center; gap: 3px; color: #7054de; }
      .waves span { width: 3px; height: 10px; border-radius: 3px; background: currentColor; }
      .waves span:nth-child(2) { height: 20px; } .waves span:nth-child(3) { height: 15px; }
      .tag { margin-left: 3px; padding: 3px 7px; border-radius: 6px; background: #f3efff; color: #7054de; font-size: 10px; font-weight: 650; }
      button { font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
      .control { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 35px; height: 35px; border-radius: 11px; border: 0; color: #635b76; background: transparent; transition: background .15s, transform .15s; }
      .control:hover { background: #f3efff; } .control:active { transform: scale(.95); }
      .control:focus-visible { outline: 2px solid #7054de; outline-offset: 3px; }
      .control:disabled { cursor: default; opacity: .35; }
      .close { width: 26px; height: 26px; margin-left: auto; border-radius: 8px; }
      .title { margin: 0; max-height: 40px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 14px; font-weight: 650; line-height: 20px; }
      .status { color: #948aa6; font-size: 11px; margin-top: 5px; overflow-wrap: anywhere; }
      .progress { height: 4px; margin: 16px 0 11px; background: #eee9f7; border-radius: 4px; overflow: hidden; }
      .fill { height: 100%; width: 0%; background: #7054de; border-radius: inherit; transition: width .2s; }
      .bottom { display: flex; align-items: center; justify-content: space-between; }
      .label { color: #948aa6; font-size: 10px; }
      .controls { display: flex; align-items: center; gap: 3px; }
      .primary { width: 39px; height: 39px; color: #fff; background: #7054de; border-radius: 13px; }
      .primary:hover { background: #6045ce; }
      @media (max-width: 400px) { .reader { width: 292px; } }
      @media (prefers-reduced-motion: reduce) { .control, .fill { transition: none; } }
    `;
    const reader = element("section", "reader");
    reader.setAttribute("aria-label", "Sona page reader");
    const top = element("div", "top");
    const waves = element("span", "waves");
    waves.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 3; index += 1) waves.append(element("span"));
    const tag = element("span", "tag", "LISTENING");
    const close = control("Hide reader", "M6 6l12 12M18 6L6 18", () => {
      hiddenSession = currentSession;
      host.hidden = true;
      host.style.display = "none";
      clearHighlight();
    }, "close");
    top.append(waves, element("span", "brand", "Sona"), tag, close);
    const title = element("p", "title");
    const status = element("div", "status");
    status.setAttribute("role", "status");
    const progress = element("div", "progress");
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", "Reading progress");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    const fill = element("div", "fill");
    progress.append(fill);
    const bottom = element("div", "bottom");
    const label = element("span", "label");
    const controls = element("div", "controls");
    const previous = control("Previous sentence", "M7 5v14M18 6l-8 6 8 6V6z", () => sendAction("SKIP", { direction: -1 }));
    const toggle = control("Pause", "M8 6v12M16 6v12", () => sendAction(currentState?.status === "paused" ? "RESUME" : "PAUSE"), "primary");
    const next = control("Next sentence", "M17 5v14M6 6l8 6-8 6V6z", () => sendAction("SKIP", { direction: 1 }));
    const stop = control("Stop reading", "M7 7h10v10H7z", () => sendAction("STOP"));
    controls.append(previous, toggle, next, stop);
    bottom.append(label, controls);
    reader.append(top, title, status, progress, bottom);
    shadow.append(style, reader);
    (document.body || document.documentElement).append(host);
    return { host, title, status, progress, fill, tag, label, previous, toggle, next, stop };
  }

  function renderState(state) {
    if (!state || typeof state.status !== "string") return;
    currentState = state;
    const active = ["playing", "paused", "loading"].includes(state.status);
    const session = state.sessionId || state.source?.id || "current";
    if (state.status !== "idle" && state.status !== "stopped" && session !== currentSession) {
      currentSession = session;
      hiddenSession = null;
    }
    if (state.status === "idle" || state.status === "stopped") {
      clearHighlight();
      if (panel) {
        panel.host.hidden = true;
        panel.host.style.display = "none";
      }
      return;
    }
    if (!panel && !active && state.status !== "error") return;
    if (!panel?.host.isConnected) panel = createPanel();
    const hidden = hiddenSession === session;
    panel.host.hidden = hidden;
    panel.host.style.display = hidden ? "none" : "block";
    const total = state.totalCharacters || sourceExtraction(state.source)?.text.length || 0;
    const percent = state.status === "finished" ? 100
      : Math.max(0, Math.min(100, total ? Math.round(((state.charIndex || 0) / total) * 100) : 0));
    panel.title.textContent = state.source?.title || "Your text";
    panel.label.textContent = state.source?.kind === "selection" ? "Selected text"
      : ["paste", "pasted"].includes(state.source?.kind) ? "Pasted text" : "Page reader";
    const statusText = state.status === "error" ? state.error || "Unable to read this text."
      : state.status === "finished" ? "All done. Thanks for listening."
        : state.status === "paused" ? `Paused · ${percent}% through`
          : state.status === "loading" ? "Getting your voice ready…" : `Reading aloud · ${percent}% through`;
    // Update the live region only when the status or whole percentage changes.
    if (panel.status.textContent !== statusText) panel.status.textContent = statusText;
    panel.tag.textContent = state.status === "paused" ? "PAUSED"
      : state.status === "finished" ? "COMPLETE" : state.status === "error" ? "ERROR" : "LISTENING";
    panel.fill.style.width = `${percent}%`;
    panel.progress.setAttribute("aria-valuenow", String(percent));
    const paused = state.status === "paused";
    const toggleLabel = paused ? "Resume" : "Pause";
    panel.toggle.title = toggleLabel;
    panel.toggle.setAttribute("aria-label", toggleLabel);
    panel.toggle.replaceChildren(icon(paused ? "M8 5l11 7-11 7V5z" : "M8 6v12M16 6v12"));
    for (const button of [panel.previous, panel.toggle, panel.next, panel.stop]) button.disabled = !active;
    if (hidden) clearHighlight(); else highlightSentence(state);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "READ_PAGE") {
      sendResponse(readPage());
      return false;
    }
    if (message?.type === "READER_STATE") {
      renderState(message.state);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
