/* Shared page/PDF loading controls for the popup and reading view. */
(() => {
  "use strict";
  function base64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(binary);
  }
  function create({ mount, onSource, setStatus, beforeLoad = () => {}, afterLoad = () => {} }) {
    const section = document.createElement("section");
    section.className = "document-tools";
    section.innerHTML = '<div class="document-row"><select aria-label="Reading document"><option value="auto">Detect page or PDF</option><option value="page">Page text</option></select><button type="button" class="import-pdf">Import PDF</button><button type="button" class="cancel-extraction" hidden>Cancel</button></div><input class="pdf-file" type="file" accept="application/pdf,.pdf" hidden><details class="pdf-options"><summary>PDF options / scan page</summary><label>PDF address<input class="pdf-url" type="url" placeholder="https://…/document.pdf"></label><div class="pdf-fields"><label>From page<input class="pdf-start" type="number" min="1" placeholder="1"></label><label>To page<input class="pdf-end" type="number" min="1" placeholder="Last"></label></div><label>Password, if needed<input class="pdf-password" type="password" autocomplete="off"></label><label class="ocr-label"><input class="pdf-force-ocr" type="checkbox"> Use local OCR even if text exists</label><div class="pdf-buttons"><button class="reload-document" type="button">Read PDF</button><button class="scan-page" type="button">Scan visible page</button></div><p>PDFs and English OCR are processed on your device.</p></details>';
    mount.append(section);
    const $ = (selector) => section.querySelector(selector);
    const select = $("select");
    let documents = [];
    let tabId;
    let requestId;
    let lastFile = null;
    let busy = false;
    let generation = 0;
    const settings = () => ({ password: $(".pdf-password").value,
      pageStart: Number($(".pdf-start").value) || undefined, pageEnd: Number($(".pdf-end").value) || undefined,
      forceOcr: $(".pdf-force-ocr").checked });
    function renderDocuments(values, source) {
      documents = values || [];
      select.replaceChildren(new Option("Detect page or PDF", "auto"), new Option("Page text", "page"));
      documents.forEach((pdf, index) => select.add(new Option(`PDF · ${pdf.title || "Embedded document"}`, String(index))));
      const index = documents.findIndex((pdf) => pdf.url === source?.url);
      select.value = source?.kind === "pdf" && index >= 0 ? String(index) : source?.kind === "pdf" ? "auto" : "page";
    }
    async function run(message) {
      const token = ++generation;
      if (requestId) chrome.runtime.sendMessage({ type: "CANCEL_EXTRACT", requestId }).catch(() => {});
      requestId = crypto.randomUUID(); busy = true;
      const id = requestId;
      select.disabled = true; $(".cancel-extraction").hidden = false;
      beforeLoad(); setStatus("Detecting readable content…");
      try {
        const response = await chrome.runtime.sendMessage({ ...message, requestId: id });
        if (token !== generation) return;
        if (response?.error) throw new Error(response.error);
        if (!response?.source?.text) throw new Error("No readable content was found.");
        if (response.documents) renderDocuments(response.documents, response.source);
        await onSource(response.source);
        if (response.source.kind === "pdf") {
          const pdf = response.source.pdf;
          setStatus(`PDF pages ${pdf.startPage}–${pdf.endPage} of ${pdf.totalPages}${pdf.ocrPages ? ` · ${pdf.ocrPages} scanned page(s) recognized locally` : ""}. Follow along in Reader.${response.source.truncated ? " Extraction limit reached; choose another page range to continue." : ""}`);
        } else if (response.source.method === "ocr-screen") setStatus("Visible page recognized with local OCR. Scroll and scan again to read another area.");
        else setStatus("Readable content loaded.");
        return response;
      } catch (error) { if (token === generation) setStatus(error.message, true); throw error; }
      finally {
        if (token === generation) {
          busy = false; requestId = null; select.disabled = false; $(".cancel-extraction").hidden = true; afterLoad();
        }
      }
    }
    async function loadTab(id, mode = "auto", pdfUrl) {
      tabId = id;
      lastFile = null;
      return run({ type: "EXTRACT_TAB", tabId, mode, pdfUrl, ...settings() });
    }
    async function currentTab() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No current tab was found.");
      return tab.id;
    }
    const handle = (task) => task.catch(() => {});
    select.addEventListener("change", () => handle((async () => {
      tabId ??= await currentTab();
      const choice = select.value;
      return loadTab(tabId, choice === "page" ? "page" : choice === "auto" ? "auto" : "pdf", documents[Number(choice)]?.url);
    })()));
    $(".import-pdf").addEventListener("click", () => $(".pdf-file").click());
    $(".pdf-file").addEventListener("change", () => handle((async () => {
      const file = $(".pdf-file").files[0];
      if (!file) return;
      if (file.size > 40 * 1024 * 1024) { setStatus("Choose a PDF smaller than 40 MB.", true); return; }
      lastFile = { title: file.name, base64: base64(new Uint8Array(await file.arrayBuffer())) };
      renderDocuments([], null);
      return run({ type: "PDF_EXTRACT", ...lastFile, ...settings() });
    })()));
    $(".reload-document").addEventListener("click", () => handle((async () => {
      const url = $(".pdf-url").value.trim();
      if (url) return run({ type: "PDF_EXTRACT", url, title: "PDF document", tabId, ...settings() });
      if (lastFile) return run({ type: "PDF_EXTRACT", ...lastFile, ...settings() });
      tabId ??= await currentTab();
      const pdf = documents[Number(select.value)] || documents[0];
      if (!pdf) return loadTab(tabId, "auto");
      return loadTab(tabId, "pdf", pdf.url);
    })()));
    $(".scan-page").addEventListener("click", () => handle((async () => {
      tabId = await currentTab();
      return run({ type: "SCAN_TAB", tabId });
    })()));
    function cancel() {
      if (requestId) chrome.runtime.sendMessage({ type: "CANCEL_EXTRACT", requestId }).catch(() => {});
      ++generation; requestId = null; busy = false; select.disabled = false; $(".cancel-extraction").hidden = true;
      afterLoad(); setStatus("Extraction cancelled.");
    }
    $(".cancel-extraction").addEventListener("click", cancel);
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type !== "EXTRACTION_PROGRESS" || message.requestId !== requestId) return;
      const pages = message.page ? ` · page ${message.page}${message.totalPages ? ` of ${message.totalPages}` : ""}` : "";
      const percent = message.stage === "Recognizing scanned page" ? ` · ${Math.round((message.progress || 0) * 100)}%` : "";
      setStatus(`${message.stage}${pages}${percent}…`);
    });
    return { loadTab, cancel, setSource: (source) => {
      if (Number.isInteger(source?.tabId)) tabId = source.tabId;
      if (source?.kind === "pdf" && select.value === "page") select.value = "auto";
    }, get busy() { return busy; } };
  }
  globalThis.SonaDocuments = { create };
})();
