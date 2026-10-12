/* Background extraction coordinator. PDF parsing itself runs offscreen. */
(function (root) {
  "use strict";
  const observed = new Map();
  const MAX_BYTES = 40 * 1024 * 1024;
  function isPdfUrl(value) {
    try { const url = new URL(value); return /\.pdf$/iu.test(url.pathname) || /(?:^|[?&])(?:format|type|mime)=(?:pdf|application%2Fpdf)(?:&|$)/iu.test(url.search); }
    catch { return false; }
  }
  function remember(tabId, url, metadata = {}) {
    if (!Number.isInteger(tabId) || tabId < 0 || !/^(https?:|file:)\/\//u.test(url)) return;
    const values = observed.get(tabId) || [];
    observed.set(tabId, [{ url, resourceType: metadata.type, frameId: metadata.frameId }, ...values.filter((value) => value.url !== url)].slice(0, 12));
  }
  function documentsFor(tab, results) {
    const documents = []; const seen = new Set();
    function add(value) {
      if (!value.url || seen.has(value.url)) return;
      seen.add(value.url);
      let title = value.title;
      try { title ||= decodeURIComponent(new URL(value.url).pathname.split("/").pop()); } catch { /* Use generic title. */ }
      documents.push({ ...value, title: title || "PDF document", type: "pdf" });
    }
    if (isPdfUrl(tab.url)) add({ url: tab.url, title: tab.title, embedded: true, score: 2 });
    for (const frame of results) {
      for (const pdf of frame.result?.pdfCandidates || []) add({ ...pdf, frameId: frame.frameId });
      if (frame.result?.isPdf || isPdfUrl(frame.result?.url)) add({ url: frame.result.url, title: frame.result.title, embedded: true, frameId: frame.frameId, score: 1 });
    }
    for (const item of observed.get(tab.id) || []) add({ url: item.url, frameId: item.frameId,
      embedded: ["main_frame", "sub_frame", "object"].includes(item.resourceType),
      score: item.resourceType === "main_frame" ? 2 : .6 });
    return documents.sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  async function bytesFromPage(tabId, candidate) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [candidate.frameId || 0] }, world: "MAIN",
      func: async (url, limit) => {
        let bytes;
        const viewer = window.PDFViewerApplication?.pdfDocument;
        if (viewer && (!url || url === location.href || url.startsWith("blob:"))) bytes = await viewer.getData();
        else {
          const response = await fetch(url, { credentials: "include" });
          if (!response.ok) throw new Error(`PDF request returned HTTP ${response.status}.`);
          if (Number(response.headers.get("content-length")) > limit) throw new Error("PDF exceeds 40 MB.");
          bytes = new Uint8Array(await response.arrayBuffer());
        }
        if (bytes.byteLength > limit) throw new Error("PDF exceeds 40 MB.");
        let binary = "";
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return btoa(binary);
      }, args: [candidate.url, MAX_BYTES]
    });
    return result?.result;
  }
  async function pdf(message, ensure) {
    await ensure();
    const result = await chrome.runtime.sendMessage({ ...message, target: "sona-extractor", type: "PDF_EXTRACT" });
    if (result?.error) throw new Error(result.error);
    return result;
  }
  async function scanTab(message, ensure) {
    const tab = await chrome.tabs.get(message.tabId);
    const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (active?.id !== tab.id) throw new Error("Select the tab you want to scan, then try again.");
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await ensure();
    const result = await chrome.runtime.sendMessage({ target: "sona-extractor", type: "OCR_IMAGE", requestId: message.requestId,
      dataUrl, title: tab.title || "Visible page", url: tab.url, tabId: tab.id });
    if (result?.error) throw new Error(result.error);
    return result;
  }
  async function extractTab(message, ensure) {
    const tab = await chrome.tabs.get(message.tabId);
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => []) || [];
    const results = []; let injectionError;
    // Target frames individually: a restricted PDF viewer must not prevent
    // other readable frames from being collected.
    const targets = frames.length ? frames : [{ frameId: 0, url: tab.url }];
    const settled = await Promise.allSettled(targets.slice(0, 40).map(async (frame) => {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frame.frameId] }, files: ["vendor/readability/Readability.js", "content.js"] });
      const result = await chrome.tabs.sendMessage(tab.id, { type: "READ_PAGE", mode: message.mode }, { frameId: frame.frameId });
      return { frameId: frame.frameId, result };
    }));
    for (const value of settled) {
      if (value.status === "fulfilled") results.push(value.value);
      else injectionError = value.reason;
    }
    const documents = documentsFor(tab, results);
    const selections = results.filter((frame) => frame.result?.source?.kind === "selection" && frame.result.source.text);
    const readable = results.filter((frame) => frame.result?.source?.text);
    readable.sort((a, b) => (b.result.source.text.length * (b.result.quality || 1)) - (a.result.source.text.length * (a.result.quality || 1)));
    const chosen = selections[0] || readable[0];
    const pageResult = chosen ? { source: { ...chosen.result.source, tabId: tab.id, frameId: chosen.frameId }, documents } : null;
    const candidate = message.pdfUrl ? documents.find((pdf) => pdf.url === message.pdfUrl) || { url: message.pdfUrl }
      : documents.find((pdf) => pdf.embedded && (pdf.score >= .2 || !chosen || chosen.result.source.text.length < 300));
    if (message.mode !== "page" && (message.mode === "pdf" || !selections.length) && candidate) {
      const request = { ...message, url: candidate.url, title: candidate.title || tab.title, tabId: tab.id };
      let result;
      if (/^(blob:|data:)/u.test(candidate.url)) request.base64 = await bytesFromPage(tab.id, candidate);
      try { result = await pdf(request, ensure); }
      catch (error) {
        if (request.base64 || /password|smaller than|cancelled/iu.test(error.message)) throw error;
        // An authenticated site may require a same-origin page request.
        try { request.base64 = await bytesFromPage(tab.id, candidate); }
        catch { if (candidate.viewer && pageResult) return pageResult; throw error; }
        try { result = await pdf(request, ensure); }
        catch (fallbackError) {
          // Some PDF.js wrappers keep their document instance private but
          // still expose a perfectly readable DOM text layer.
          if (candidate.viewer && pageResult && /instead of a PDF/iu.test(fallbackError.message)) return pageResult;
          throw fallbackError;
        }
      }
      return { ...result, documents };
    }
    if (pageResult) return pageResult;
    if (!documents.length && /^(https?:|file:)\/\//u.test(tab.url || "") && message.mode !== "page") {
      // Extensionless URLs can still deliver a PDF, even when Chrome's native
      // PDF viewer cannot be inspected by content scripts.
      const response = await fetch(tab.url, { method: "HEAD", credentials: "include" }).catch(() => null);
      if (/application\/pdf/iu.test(response?.headers.get("content-type") || "")) {
        return { ...await pdf({ ...message, url: tab.url, title: tab.title, tabId: tab.id }, ensure),
          documents: [{ url: tab.url, title: tab.title || "PDF document", type: "pdf", embedded: true }] };
      }
    }
    throw new Error(injectionError ? "This browser page cannot expose its text. Import the PDF file or enter its original PDF address in PDF options."
      : "No readable text was found. Choose a detected PDF, import a file, or paste text.");
  }
  const api = { extractTab, pdf, scanTab, remember, forget: (tabId) => observed.delete(tabId), isPdfUrl };
  root.SonaExtraction = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
