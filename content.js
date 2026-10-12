(() => {
  "use strict";

  // executeScript may run every time the popup opens. Keep one listener per tab.
  if (globalThis.__sonaPageReader) return;
  globalThis.__sonaPageReader = true;

  const MAX_TEXT = 100000;
  const HIGHLIGHT_NAME = "sona-current-sentence";
  const WORD_HIGHLIGHT_NAME = "sona-current-word";
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
  let highlightedRange = null;
  let followReading = true;
  let followingPaused = false;
  let programmaticScrollUntil = 0;
  let collapsed = false;
  let panelPosition = null;
  let contextTarget = null;
  let contextCaret = null;

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
      if (node.tagName === "SLOT" && node.assignedNodes?.().length) {
        for (const child of node.assignedNodes({ flatten: true })) visit(child, inLink);
      } else if (node.shadowRoot) {
        for (const child of node.shadowRoot.childNodes) visit(child, inLink);
      } else {
        for (const child of node.childNodes) visit(child, inLink || node.tagName === "A");
      }
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
    const article = readableArticle();
    if (article?.text.length >= 120) return { ...article, kind: "page", method: "article" };
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

  function readableArticle() {
    if (typeof Readability !== "function" || !document.body || document.body.childElementCount > 20000) return null;
    try {
      const clone = document.cloneNode(true);
      const live = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const copied = clone.createTreeWalker(clone.body, NodeFilter.SHOW_TEXT);
      const originals = []; const copies = [];
      while (live.nextNode()) originals.push(live.currentNode);
      while (copied.nextNode()) copies.push(copied.currentNode);
      if (originals.length > 30000 || originals.length !== copies.length) return null;
      const textNodes = new Map();
      for (let i = 0; i < originals.length; i++) {
        const original = originals[i]; const copy = copies[i];
        let excluded = false;
        for (let parent = original.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
          if (excludedElement(parent, false)) { excluded = true; break; }
        }
        if (excluded) { copy.remove(); continue; }
        if (!copy.data.trim()) continue;
        const span = clone.createElement("span");
        span.dataset.sonaText = String(i);
        copy.replaceWith(span); span.append(copy);
        textNodes.set(String(i), original);
      }
      const article = new Readability(clone, { charThreshold: 120, keepClasses: true, maxElemsToParse: 60000 }).parse();
      if (!article?.content) return null;
      const template = document.createElement("template");
      template.innerHTML = article.content;
      const builder = createBuilder(); const used = new Set();
      function visit(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const original = textNodes.get(node.dataset.sonaText);
        if (original) {
          if (!used.has(original)) { builder.text(original, 0, original.data.length, Boolean(original.parentElement?.closest("a"))); used.add(original); }
          return;
        }
        const block = BLOCKS.has(node.tagName);
        if (block || node.tagName === "BR") builder.separator(true);
        for (const child of node.children) visit(child);
        if (block) builder.separator(true);
      }
      for (const child of template.content.children) visit(child);
      const result = builder.finish();
      if (result.text.length < (article.textContent?.trim().length || 0) * .65) return null;
      return result;
    } catch { return null; }
  }

  function pdfCandidates() {
    const result = []; const seen = new Set();
    const add = (value, element, embedded, title) => {
      if (!value) return;
      try {
        let url = new URL(value, document.baseURI);
        for (const name of ["file", "url", "src", "pdf", "document"]) {
          const nested = url.searchParams.get(name);
          if (nested && name === "file" && /pdf|viewer/iu.test(url.pathname)) { url = new URL(nested, document.baseURI); break; }
          if (nested && (/\.pdf(?:$|[?#])/iu.test(nested) || /^(blob:|data:application\/pdf)/iu.test(nested))) { url = new URL(nested, document.baseURI); break; }
        }
        if (!["http:", "https:", "file:", "blob:", "data:"].includes(url.protocol) || seen.has(url.href)) return;
        if (!embedded && !/\.pdf(?:$|[?#])/iu.test(url.href) && !/application\/pdf/iu.test(element?.type || "")) return;
        if (embedded && !/\.pdf(?:$|[?#])/iu.test(url.href) && !/^(blob:|data:application\/pdf)/iu.test(url.href)
          && !/application\/pdf/iu.test(element?.type || "") && !/pdf|document-viewer|file-viewer/iu.test(element?.src || element?.data || "")) return;
        const rect = element?.getBoundingClientRect();
        const score = embedded && rect ? Math.min(1, Math.max(0, Math.min(rect.right, innerWidth) - Math.max(0, rect.left))
          * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(0, rect.top)) / Math.max(1, innerWidth * innerHeight)) : 0;
        seen.add(url.href); result.push({ url: url.href, embedded, score, title: title?.trim().slice(0, 160) || "" });
      } catch { /* Not a document URL. */ }
    };
    const roots = [document];
    for (let i = 0; i < roots.length && i < 100; i++) {
      for (const node of roots[i].querySelectorAll("*")) if (node.shadowRoot) roots.push(node.shadowRoot);
    }
    for (const element of roots.flatMap((root) => Array.from(root.querySelectorAll("iframe[src], embed[src], object[data]")))) {
      add(element.src || element.data, element, true, element.title || element.getAttribute("aria-label"));
    }
    for (const link of roots.flatMap((root) => Array.from(root.querySelectorAll("a[href]")))) add(link.href, link, false, link.textContent);
    const app = document.querySelector("#viewerContainer .textLayer, .pdfViewer .textLayer");
    if (app) {
      const url = new URL(location.href);
      const address = url.searchParams.get("file") || url.searchParams.get("url");
      if (address) add(address, app, true, document.title);
      // A PDF.js viewer may already hold bytes loaded through an API rather
      // than expose a downloadable URL. The coordinator can use getData().
      else if (!seen.has(url.href)) result.push({ url: url.href, embedded: true, score: 1, viewer: true, title: document.title });
    }
    return result.slice(0, 30);
  }

  function saveExtraction(extraction, startOffset = null) {
    const id = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID() : `sona-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const source = { id, text: extraction.text, title: document.title || "Untitled page",
      url: location.href, kind: extraction.kind, truncated: extraction.truncated, method: extraction.method || "dom",
      ...(Number.isInteger(startOffset) ? { startOffset } : {}) };
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
    return { source, pdfCandidates: pdfCandidates(), quality: extraction.method === "article" ? 1.2 : 1,
      isPdf: document.contentType === "application/pdf", url: location.href, title: document.title };
  }

  function readPage(mode = "auto") {
    try {
      const extraction = ["page", "pdf"].includes(mode) ? extractPage() : extractSelection() || extractPage();
      if (!extraction.text) return { error: "This page has no readable text. Select some text or choose a detected PDF.", pdfCandidates: pdfCandidates(),
        isPdf: document.contentType === "application/pdf", url: location.href, title: document.title };
      return saveExtraction(extraction);
    } catch {
      return { error: "Sona could not read this page. Select some text or paste it into the reader." };
    }
  }

  function readFromHere(selectionText = "") {
    try {
      if (!contextTarget?.isConnected) {
        const selection = extractSelection();
        if (selection?.text && selectionText) return saveExtraction(selection, 0);
        return { error: "Open Sona on this page once, then right-click the paragraph again." };
      }
      // Keep the full article and its DOM map, so previous/next and seeking can
      // travel in both directions from the paragraph the user selected.
      let extraction = extractPage();
      const target = contextTarget.nodeType === Node.ELEMENT_NODE
        ? contextTarget : contextTarget.parentElement;
      const block = target?.closest("p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, td, figcaption") || target;
      let spans = extraction.segments.filter((span) => block?.contains(span.node));
      if (!spans.length) {
        extraction = { ...extractTree(document.body || document.documentElement), kind: "page" };
        spans = extraction.segments.filter((span) => block?.contains(span.node));
      }
      let startOffset = spans[0]?.start;
      if (contextCaret?.startContainer?.nodeType === Node.TEXT_NODE) {
        const caretSpan = extraction.segments.find((span) => span.node === contextCaret.startContainer
          && span.nodeStart <= contextCaret.startOffset && span.nodeEnd >= contextCaret.startOffset);
        if (caretSpan) startOffset = caretSpan.start + (caretSpan.collapsed ? 0
          : Math.min(caretSpan.end - caretSpan.start, contextCaret.startOffset - caretSpan.nodeStart));
      }
      if (!Number.isInteger(startOffset) && selectionText) {
        const selection = extractSelection();
        if (selection?.text) return saveExtraction(selection, 0);
      }
      if (!extraction.text) return { error: "This part of the page has no readable text." };
      if (!Number.isInteger(startOffset)) return { error: "This part of the page is outside the readable article. Select a passage to read it aloud." };
      return saveExtraction(extraction, startOffset);
    } catch {
      return { error: "Sona could not locate this paragraph. Select a passage to read it aloud." };
    }
  }

  function clearHighlight() {
    try {
      CSS.highlights?.delete(HIGHLIGHT_NAME);
      CSS.highlights?.delete(WORD_HIGHLIGHT_NAME);
    } catch { /* Unsupported browser. */ }
    highlightedRangeKey = "";
    highlightedRange = null;
  }

  function highlightWord(state, extraction) {
    try {
      CSS.highlights.delete(WORD_HIGHLIGHT_NAME);
      // The bundled synthesizer has no reliable word timings. Only render a
      // word when the active engine explicitly reports a word boundary.
      if (state.wordBoundary !== true || !Number.isFinite(state.wordLength) || state.wordLength <= 0) return;
      const start = state.charIndex;
      const end = Math.min(extraction.text.length, start + state.wordLength);
      const spans = extraction.segments.filter((span) => span.end > start && span.start < end);
      if (!spans.length || spans.some((span) => !span.node.isConnected
        || span.node.data !== extraction.snapshots.get(span.node))) return;
      const first = spans[0];
      const last = spans[spans.length - 1];
      const range = document.createRange();
      range.setStart(first.node, first.collapsed ? first.nodeStart
        : first.nodeStart + Math.max(0, start - first.start));
      range.setEnd(last.node, last.collapsed ? last.nodeEnd
        : last.nodeStart + Math.min(last.end - last.start, end - last.start));
      const highlight = new Highlight(range);
      highlight.priority = 1;
      CSS.highlights.set(WORD_HIGHLIGHT_NAME, highlight);
    } catch { /* The page may have replaced its text nodes. */ }
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
    highlightWord(state, extraction);
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
        highlightStyle.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: #e4d9ff; color: inherit; text-decoration: underline; text-decoration-color: #7054de; } ::highlight(${WORD_HIGHLIGHT_NAME}) { background-color: #bca7ff; color: inherit; }`;
        (document.head || document.documentElement).append(highlightStyle);
      }
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
      highlightedRangeKey = rangeKey;
      highlightedRange = range;
      followCurrentSentence();
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

  function updateFollowControls() {
    if (!panel) return;
    panel.follow.checked = followReading;
    panel.back.hidden = !followReading || !followingPaused;
    panel.compactBack.hidden = !followReading || !followingPaused;
  }

  function followCurrentSentence(force = false) {
    if (!highlightedRange || !followReading || followingPaused
      || (!force && currentState?.status !== "playing")) return;
    const rects = Array.from(highlightedRange.getClientRects());
    let target = highlightedRange.getBoundingClientRect();
    if (!target.height || !target.width) return;
    const height = window.innerHeight;
    const margin = Math.min(80, height / 5);
    // A very long sentence may cover more than one screen; follow its first
    // line rather than continually moving a sentence the user can already see.
    if (target.height > height - margin * 2 && rects.length) target = rects[0];
    let ancestor = highlightedRange.startContainer.parentElement;
    const scrollable = [];
    while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
      const style = getComputedStyle(ancestor);
      if (ancestor.scrollHeight > ancestor.clientHeight && /auto|scroll/.test(style.overflowY)) scrollable.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    for (const container of scrollable) {
      const bounds = container.getBoundingClientRect();
      const safe = Math.min(32, container.clientHeight / 5);
      if (target.top < bounds.top + safe || target.bottom > bounds.bottom - safe) {
        programmaticScrollUntil = performance.now() + 600;
        container.scrollBy({ top: target.top + target.height / 2 - bounds.top - bounds.height / 2,
          behavior: "instant" });
        target = highlightedRange.getBoundingClientRect();
        if (target.height > height - margin * 2 && rects.length) target = highlightedRange.getClientRects()[0] || target;
      }
    }
    if (target.top < margin || target.bottom > height - margin) {
      programmaticScrollUntil = performance.now() + 600;
      window.scrollBy({ top: target.top + target.height / 2 - height / 2, behavior: "instant" });
    }
  }

  function suspendFollowing(event) {
    if (!followReading || !["playing", "paused"].includes(currentState?.status)
      || event?.composedPath().some((node) => node === panel?.host)) return;
    followingPaused = true;
    updateFollowControls();
  }

  function resumeFollowing() {
    followingPaused = false;
    updateFollowControls();
    followCurrentSentence(true);
  }

  function clampPanel() {
    if (!panel || !panelPosition || panel.host.hidden) return;
    const rect = panel.host.getBoundingClientRect();
    const margin = 8;
    panelPosition.x = Math.max(margin, Math.min(panelPosition.x, window.innerWidth - rect.width - margin));
    panelPosition.y = Math.max(margin, Math.min(panelPosition.y, window.innerHeight - rect.height - margin));
    panel.host.style.left = `${panelPosition.x}px`;
    panel.host.style.top = `${panelPosition.y}px`;
    panel.host.style.right = "auto";
    panel.host.style.bottom = "auto";
  }

  function enableDragging(handle, host) {
    let drag = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button, input, select, a")) return;
      const rect = host.getBoundingClientRect();
      drag = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY,
        left: rect.left, top: rect.top };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointer !== event.pointerId) return;
      panelPosition = { x: drag.left + event.clientX - drag.startX,
        y: drag.top + event.clientY - drag.startY };
      clampPanel();
    });
    const finish = () => { drag = null; };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
  }

  function setCollapsed(value) {
    collapsed = value;
    if (!panel) return;
    panel.reader.hidden = collapsed;
    panel.compact.hidden = !collapsed;
    clampPanel();
    (collapsed ? panel.expand : panel.minimize).focus();
  }

  function durationLabel(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    if (seconds < 60) return "Less than a minute left";
    const minutes = Math.ceil(seconds / 60);
    return minutes < 60 ? `About ${minutes} min left`
      : `About ${Math.floor(minutes / 60)} hr ${minutes % 60} min left`;
  }

  function createPanel() {
    const host = element("div");
    host.setAttribute("data-sona-reader", "panel");
    host.style.cssText = "all:initial;position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:calc(100vw - 16px);color-scheme:light;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = element("style");
    style.textContent = `
      :host { color-scheme: light; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .reader { width: 316px; max-width: calc(100vw - 32px); padding: 18px; border: 1px solid #e7e0f8; border-radius: 22px; background: #fff; color: #262136; box-shadow: 0 12px 48px #31234526, 0 3px 10px #3123450c; font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      .reader { max-height: calc(100vh - 16px); overflow-y: auto; }
      .top { display: flex; align-items: center; gap: 9px; margin-bottom: 13px; cursor: grab; touch-action: none; user-select: none; }
      .top:active, .compact:active { cursor: grabbing; }
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
      .close { width: 26px; height: 26px; border-radius: 8px; }
      .minimize { margin-left: auto; }
      .title { margin: 0; max-height: 40px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 14px; font-weight: 650; line-height: 20px; }
      .status { color: #948aa6; font-size: 11px; margin-top: 5px; overflow-wrap: anywhere; }
      .progress { display: block; width: 100%; height: 18px; margin: 13px 0 0; accent-color: #7054de; cursor: pointer; }
      .progress:focus-visible, select:focus-visible, .back:focus-visible, input:focus-visible { outline: 2px solid #7054de; outline-offset: 3px; }
      .time { color: #948aa6; font-size: 10px; min-height: 14px; margin: 0 0 10px; }
      .bottom { display: flex; align-items: center; justify-content: space-between; }
      .label { color: #948aa6; font-size: 10px; }
      .controls { display: flex; align-items: center; gap: 3px; }
      .primary { width: 39px; height: 39px; color: #fff; background: #7054de; border-radius: 13px; }
      .primary:hover { background: #6045ce; }
      .options { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 12px; border-top: 1px solid #f0ecf7; padding-top: 12px; }
      .follow-label { display: flex; align-items: center; gap: 6px; font-size: 11px; cursor: pointer; }
      .follow-label input { width: 14px; height: 14px; margin: 0; accent-color: #7054de; }
      select { border: 1px solid #e7e0f8; background: #faf8ff; border-radius: 7px; padding: 5px; color: #635b76; font: inherit; font-size: 11px; cursor: pointer; }
      .back { width: 100%; border: 0; border-radius: 9px; background: #f3efff; color: #7054de; font-size: 12px; padding: 8px; margin-top: 10px; }
      .compact { display: flex; align-items: center; gap: 7px; width: max-content; max-width: calc(100vw - 16px); padding: 7px 9px 7px 14px; border: 1px solid #e7e0f8; border-radius: 40px; background: #fff; color: #262136; box-shadow: 0 6px 30px #31234526; font: 12px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; cursor: grab; touch-action: none; user-select: none; }
      .compact .control { width: 31px; height: 31px; border-radius: 50%; }
      .compact .brand { font-size: 13px; }
      .compact-percent { color: #948aa6; font-size: 10px; }
      @media (max-width: 400px) { .reader { width: 292px; } }
      @media (prefers-reduced-motion: reduce) { .control { transition: none; } }
    `;
    const reader = element("section", "reader");
    reader.setAttribute("aria-label", "Sona page reader");
    const top = element("div", "top");
    const waves = element("span", "waves");
    waves.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 3; index += 1) waves.append(element("span"));
    const tag = element("span", "tag", "LISTENING");
    const minimize = control("Minimize reader", "M5 12h14", () => setCollapsed(true), "close minimize");
    const close = control("Hide reader", "M6 6l12 12M18 6L6 18", () => {
      hiddenSession = currentSession;
      host.hidden = true;
      host.style.display = "none";
      clearHighlight();
    }, "close");
    top.title = "Drag to move the reader";
    top.append(waves, element("span", "brand", "Sona"), tag, minimize, close);
    const title = element("p", "title");
    const status = element("div", "status");
    status.setAttribute("role", "status");
    const progress = element("input", "progress");
    progress.type = "range";
    progress.min = "0";
    progress.max = "1000";
    progress.step = "1";
    progress.value = "0";
    progress.setAttribute("aria-label", "Reading progress");
    progress.title = "Jump to a sentence";
    let seeking = false;
    progress.addEventListener("input", () => {
      seeking = true;
      progress.setAttribute("aria-valuetext", `${Math.round(Number(progress.value) / 10)} percent`);
    });
    progress.addEventListener("change", () => {
      seeking = false;
      const total = currentState?.totalCharacters || sourceExtraction(currentState?.source)?.text.length || 0;
      if (total) sendAction("SEEK", { charIndex: Math.round(Number(progress.value) / 1000 * total) });
    });
    const time = element("p", "time");
    const bottom = element("div", "bottom");
    const label = element("span", "label");
    const controls = element("div", "controls");
    const previous = control("Previous sentence", "M7 5v14M18 6l-8 6 8 6V6z", () => sendAction("SKIP", { direction: -1 }));
    const toggle = control("Pause", "M8 6v12M16 6v12", () => sendAction(currentState?.status === "paused" ? "RESUME" : "PAUSE"), "primary");
    const next = control("Next sentence", "M17 5v14M6 6l8 6-8 6V6z", () => sendAction("SKIP", { direction: 1 }));
    const stop = control("Stop reading", "M7 7h10v10H7z", () => sendAction("STOP"));
    controls.append(previous, toggle, next, stop);
    bottom.append(label, controls);
    const options = element("div", "options");
    const followLabel = element("label", "follow-label");
    const follow = element("input");
    follow.type = "checkbox";
    follow.checked = followReading;
    follow.addEventListener("change", () => {
      followReading = follow.checked;
      followingPaused = false;
      updateFollowControls();
      sendAction("UI_PREFS", { preferences: { follow: followReading } });
      if (followReading) followCurrentSentence(true);
    });
    followLabel.append(follow, element("span", "", "Follow reading"));
    const speed = element("select");
    speed.setAttribute("aria-label", "Reading speed");
    for (const rate of [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
      const option = element("option", "", `${rate}×`);
      option.value = String(rate);
      speed.append(option);
    }
    speed.addEventListener("change", () => sendAction("SETTINGS", { settings: { rate: Number(speed.value) } }));
    const openReader = control("Open reading view", "M4 4h16v16H4zM14 4v16", () => sendAction("OPEN_READER"));
    options.append(followLabel, speed, openReader);
    const back = element("button", "back", "Back to reading");
    back.type = "button";
    back.hidden = true;
    back.addEventListener("click", resumeFollowing);
    reader.append(top, title, status, progress, time, bottom, options, back);
    const compact = element("section", "compact");
    compact.setAttribute("aria-label", "Sona compact reader");
    compact.title = "Drag to move the reader";
    compact.hidden = !collapsed;
    reader.hidden = collapsed;
    const compactPercent = element("span", "compact-percent", "0%");
    const compactToggle = control("Pause", "M8 6v12M16 6v12", () => sendAction(currentState?.status === "paused" ? "RESUME" : "PAUSE"), "primary");
    const compactBack = control("Back to reading", "M12 19V5M6 11l6-6 6 6", resumeFollowing);
    compactBack.hidden = true;
    const expand = control("Expand reader", "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5", () => setCollapsed(false));
    compact.append(element("span", "brand", "Sona"), compactPercent, compactToggle, compactBack, expand);
    shadow.append(style, reader, compact);
    (document.body || document.documentElement).append(host);
    enableDragging(top, host);
    enableDragging(compact, host);
    return { host, reader, compact, title, status, progress, time, tag, label, previous, toggle, next, stop,
      minimize, expand, compactPercent, compactToggle, compactBack, back, follow, speed,
      get seeking() { return seeking; } };
  }

  function renderState(state) {
    if (!state || typeof state.status !== "string") return;
    currentState = state;
    const active = ["playing", "paused", "loading"].includes(state.status);
    const session = state.sessionId || state.source?.id || "current";
    if (state.status !== "idle" && state.status !== "stopped" && session !== currentSession) {
      currentSession = session;
      hiddenSession = null;
      followingPaused = false;
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
    const followChanged = typeof state.uiPreferences?.follow === "boolean"
      && followReading !== state.uiPreferences.follow;
    if (followChanged) {
      followReading = state.uiPreferences.follow;
      followingPaused = false;
    }
    updateFollowControls();
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
    if (!panel.seeking) panel.progress.value = String(Math.round(percent * 10));
    panel.progress.setAttribute("aria-valuetext", `${percent} percent; seeking jumps to a sentence`);
    panel.progress.disabled = !total || state.status === "loading" || state.status === "error";
    panel.time.textContent = state.status === "finished" ? "Finished"
      : durationLabel(state.remainingSeconds);
    panel.compactPercent.textContent = `${percent}%`;
    const rate = Number(state.settings?.rate) || 1;
    if (!Array.from(panel.speed.options).some((option) => Number(option.value) === rate)) {
      const option = element("option", "", `${rate}×`);
      option.value = String(rate);
      panel.speed.append(option);
    }
    panel.speed.value = String(rate);
    const paused = state.status === "paused";
    const toggleLabel = paused ? "Resume" : "Pause";
    for (const button of [panel.toggle, panel.compactToggle]) {
      button.title = toggleLabel;
      button.setAttribute("aria-label", toggleLabel);
      button.replaceChildren(icon(paused ? "M8 5l11 7-11 7V5z" : "M8 6v12M16 6v12"));
    }
    for (const button of [panel.previous, panel.toggle, panel.compactToggle, panel.next, panel.stop]) button.disabled = !active;
    if (hidden) clearHighlight(); else highlightSentence(state);
    if (followChanged && followReading && !hidden) followCurrentSentence(true);
    clampPanel();
  }

  document.addEventListener("contextmenu", (event) => {
    if (event.composedPath().some((node) => node === panel?.host)) return;
    contextTarget = event.target;
    contextCaret = null;
    try {
      contextCaret = document.caretRangeFromPoint?.(event.clientX, event.clientY) || null;
    } catch { /* Read from the paragraph if caret lookup is unavailable. */ }
  }, true);

  document.addEventListener("wheel", suspendFollowing, { capture: true, passive: true });
  document.addEventListener("touchmove", suspendFollowing, { capture: true, passive: true });
  document.addEventListener("keydown", (event) => {
    const editable = event.composedPath().some((node) => node instanceof Element
      && (node.matches("input, textarea, select") || node.isContentEditable));
    if (!editable && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) suspendFollowing(event);
  }, true);
  document.addEventListener("scroll", (event) => {
    if (performance.now() >= programmaticScrollUntil) suspendFollowing(event);
  }, { capture: true, passive: true });
  window.addEventListener("resize", clampPanel);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "READ_PAGE") {
      sendResponse(readPage(message.mode));
      return false;
    }
    if (message?.type === "READ_FROM_HERE") {
      sendResponse(readFromHere(message.selectionText || ""));
      return false;
    }
    if (message?.type === "READER_STATE") {
      renderState(message.state);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  try {
    chrome.runtime.sendMessage({ type: "GET_UI_PREFS" }, (response) => {
      if (chrome.runtime.lastError) return;
      if (typeof response?.preferences?.follow === "boolean") {
        followReading = response.preferences.follow;
        updateFollowControls();
      }
    });
  } catch { /* A reload invalidates old content-script contexts. */ }
})();
