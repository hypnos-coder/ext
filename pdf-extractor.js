/* Local PDF.js parsing and Tesseract OCR; loaded in the offscreen document. */
(() => {
  "use strict";
  const MAX_BYTES = 40 * 1024 * 1024;
  const MAX_TEXT = 100000;
  const MAX_PAGES = 200;
  const jobs = new Map();
  const cancelledJobs = new Set();
  let pdfLibrary;
  let ocrQueue = Promise.resolve();
  async function library() {
    if (!pdfLibrary) pdfLibrary = import("./vendor/pdfjs/pdf.min.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");
      return pdfjs;
    });
    return pdfLibrary;
  }
  function progress(job, stage, values = {}) {
    chrome.runtime.sendMessage({ type: "EXTRACTION_PROGRESS", requestId: job.id, stage, ...values }).catch(() => {});
  }
  function check(job) { if (job.cancelled) throw new Error("Reading extraction cancelled."); }
  async function bytesFor(message, job) {
    if (message.base64) {
      if (message.base64.length > MAX_BYTES * 1.4) throw new Error("Choose a PDF smaller than 40 MB.");
      const binary = atob(message.base64);
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    }
    const url = new URL(message.url);
    if (!["https:", "http:", "file:"].includes(url.protocol)) throw new Error("This PDF needs to be imported from its page or from a file.");
    const response = await fetch(url.href, { credentials: "include", signal: job.controller.signal });
    if (!response.ok) throw new Error(`The PDF request returned HTTP ${response.status}.`);
    if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("Choose a PDF smaller than 40 MB.");
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array(await response.arrayBuffer());
    const parts = []; let size = 0;
    while (true) {
      check(job);
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error("Choose a PDF smaller than 40 MB."); }
      parts.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
  }
  async function prepareOcr(job, number = 1) {
    check(job);
    if (!job.ocr) {
        progress(job, "Loading local OCR");
        job.ocr = await Tesseract.createWorker("eng", 1, {
          workerPath: chrome.runtime.getURL("vendor/tesseract/worker.min.js"),
          corePath: chrome.runtime.getURL("vendor/tesseract/core/"),
          langPath: chrome.runtime.getURL("vendor/tesseract/lang/"),
          gzip: false, workerBlobURL: false, cacheMethod: "none",
          logger: (event) => progress(job, event.status === "recognizing text" ? "Recognizing scanned page" : "Loading local OCR",
            { page: job.page || number, progress: event.progress || 0 })
        });
    }
    check(job);
    return job.ocr;
  }
  async function recognize(page, job) {
    const task = ocrQueue.catch(() => {}).then(async () => {
      job.page = page.pageNumber;
      await prepareOcr(job, page.pageNumber);
      check(job);
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(2.5, 2400 / Math.max(original.width, original.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      try {
        progress(job, "Rendering scanned page", { page: page.pageNumber });
        // Display rendering schedules animation frames, which do not run in
        // Chrome's hidden offscreen document. Print rendering is independent.
        await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport, intent: "print" }).promise;
        check(job);
        progress(job, "Recognizing scanned page", { page: page.pageNumber, progress: 0 });
        const { data } = await job.ocr.recognize(canvas, {}, { text: true });
        return data.text.trim();
      } finally { canvas.width = canvas.height = 0; }
    });
    ocrQueue = task.catch(() => {});
    return task;
  }
  async function recognizeImage(message) {
    const job = { id: message.requestId || crypto.randomUUID(), cancelled: cancelledJobs.has(message.requestId), controller: new AbortController(), ocr: null };
    jobs.set(job.id, job);
    const task = ocrQueue.catch(() => {}).then(async () => {
      try {
        if (typeof message.dataUrl !== "string" || !/^data:image\/(png|jpeg);base64,/u.test(message.dataUrl) || message.dataUrl.length > 20 * 1024 * 1024) throw new Error("The captured image could not be read.");
        await prepareOcr(job);
        const { data } = await job.ocr.recognize(message.dataUrl, {}, { text: true });
        check(job);
        const text = data.text.trim().slice(0, MAX_TEXT);
        if (!text) throw new Error("No readable text was recognized in the visible area. Try zooming in and scan again.");
        return { source: { id: job.id, text, title: message.title || "Visible page", url: message.url || "", tabId: message.tabId,
          kind: "page", method: "ocr-screen", truncated: data.text.length > MAX_TEXT } };
      } finally {
        jobs.delete(job.id);
        if (job.ocr) await job.ocr.terminate().catch(() => {});
      }
    });
    ocrQueue = task.catch(() => {});
    return task;
  }
  async function extract(message) {
    const job = { id: message.requestId || crypto.randomUUID(), cancelled: cancelledJobs.has(message.requestId), controller: new AbortController(), ocr: null, task: null };
    jobs.set(job.id, job);
    let pdf;
    try {
      progress(job, "Opening PDF");
      check(job);
      const bytes = await bytesFor(message, job);
      if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("Choose a nonempty PDF smaller than 40 MB.");
      const header = new TextDecoder().decode(bytes.slice(0, 1024));
      if (!header.includes("%PDF-")) throw new Error("The document returned HTML or another file instead of a PDF. Import the PDF file directly if the site requires a download action.");
      const pdfjs = await library();
      check(job);
      job.task = pdfjs.getDocument({ data: bytes, password: message.password || undefined,
        cMapUrl: chrome.runtime.getURL("vendor/pdfjs/cmaps/"), cMapPacked: true,
        standardFontDataUrl: chrome.runtime.getURL("vendor/pdfjs/standard_fonts/"),
        wasmUrl: chrome.runtime.getURL("vendor/pdfjs/wasm/"),
        iccUrl: chrome.runtime.getURL("vendor/pdfjs/iccs/"),
        isEvalSupported: false, useSystemFonts: true });
      pdf = await job.task.promise;
      const start = Math.max(1, Math.min(pdf.numPages, Math.trunc(Number(message.pageStart) || 1)));
      const requestedEnd = Math.max(start, Math.min(pdf.numPages, Math.trunc(Number(message.pageEnd) || pdf.numPages)));
      const end = Math.min(requestedEnd, start + MAX_PAGES - 1);
      const pages = []; let length = 0; let truncated = end < requestedEnd;
      for (let number = start; number <= end; number++) {
        check(job);
        progress(job, "Reading PDF text", { page: number, totalPages: pdf.numPages });
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        let text = SonaPdfLayout.pageText(content.items);
        const useful = (text.match(/[\p{L}\p{N}]/gu) || []).length;
        const suspicious = text.length > 20 && (text.match(/[�\u0000-\u0008]/gu) || []).length > text.length * .1;
        let sparseImagePage = false;
        if (useful >= 12 && useful < 200 && !message.forceOcr) {
          const operators = await page.getOperatorList();
          const imageOperators = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject,
            pdfjs.OPS.paintImageXObjectRepeat, pdfjs.OPS.paintImageMaskXObject]);
          sparseImagePage = operators.fnArray.some((operator) => imageOperators.has(operator));
        }
        let ocr = false;
        if (message.forceOcr || useful < 12 || suspicious || sparseImagePage) {
          const recognized = await recognize(page, job);
          if (recognized && (message.forceOcr || recognized.length > text.length)) { text = recognized; ocr = true; }
        }
        if (text) { pages.push({ number, text, ocr }); length += text.length + 2; }
        page.cleanup();
        if (length >= MAX_TEXT) { truncated = number < requestedEnd || length > MAX_TEXT; break; }
      }
      check(job);
      let text = ""; const offsets = [];
      for (const page of SonaPdfLayout.removeRepeatedMargins(pages)) {
        if (text) text += "\n\n";
        const start = text.length;
        text += page.text;
        offsets.push({ number: page.number, start, end: Math.min(MAX_TEXT, text.length), ocr: page.ocr });
      }
      text = text.slice(0, MAX_TEXT).trim();
      if (!text) throw new Error("No readable text was found, including with local OCR. Try a clearer scan or another PDF.");
      const metadata = await pdf.getMetadata().catch(() => ({}));
      const title = metadata.info?.Title?.trim();
      return { source: { id: job.id, text, kind: "pdf", title: title && !/^(untitled|document)$/iu.test(title) ? title : message.title || "PDF document",
        url: /^(data:|blob:)/u.test(message.url || "") ? `inline-pdf:${message.tabId ?? ""}:${encodeURIComponent(message.title || "document.pdf")}`
          : message.url || `file-upload:${encodeURIComponent(message.title || "document.pdf")}`, tabId: message.tabId ?? null,
        truncated, pdf: { totalPages: pdf.numPages, startPage: start, endPage: offsets.at(-1)?.number || end,
          ocrPages: offsets.filter((page) => page.ocr).length, pages: offsets } } };
    } catch (error) {
      if (error.name === "PasswordException") throw new Error(message.password ? "The PDF password is incorrect. Enter it in PDF options and reload." : "This PDF requires a password. Enter it in PDF options and reload.");
      throw error;
    } finally {
      jobs.delete(job.id);
      if (job.ocr) await job.ocr.terminate().catch(() => {});
      if (job.task) await job.task.destroy().catch(() => {});
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== "sona-extractor" || sender.id !== chrome.runtime.id || sender.tab) return false;
    if (message.type === "CANCEL_EXTRACT") {
      cancelledJobs.add(message.requestId);
      if (cancelledJobs.size > 100) cancelledJobs.delete(cancelledJobs.values().next().value);
      const job = jobs.get(message.requestId);
      if (job) { job.cancelled = true; job.controller.abort(); if (job.ocr) job.ocr.terminate().catch(() => {}); }
      sendResponse({ ok: true }); return false;
    }
    if (!["PDF_EXTRACT", "OCR_IMAGE"].includes(message.type)) return false;
    const task = message.type === "OCR_IMAGE" ? recognizeImage(message) : extract(message);
    task.then(sendResponse, (error) => sendResponse({ error: error?.message || String(error) || "Could not read this document." }));
    return true;
  });
})();
