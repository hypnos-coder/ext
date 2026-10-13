/* PDF text layout helpers shared by the offscreen parser and tests. */
(function (root) {
  "use strict";
  function clean(text) {
    return text.replace(/\u00ad/gu, "").replace(/[\uFB00-\uFB06]/gu, (value) =>
      ({ "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" })[value])
      .replace(/[ \t]+/gu, " ").trim();
  }
  function pageText(items) {
    const words = items.filter((item) => typeof item.str === "string" && item.str.trim()).map((item) => ({
      text: clean(item.str), x: Number(item.transform?.[4]) || 0, y: Number(item.transform?.[5]) || 0,
      width: Number(item.width) || 0, height: Math.max(1, Math.abs(Number(item.height) || Number(item.transform?.[3]) || 12)), eol: item.hasEOL === true
    }));
    if (!words.length) return "";
    const heights = words.map((word) => word.height).sort((a, b) => a - b);
    const typical = heights[Math.floor(heights.length / 2)];
    const lines = [];
    // Preserve the PDF's logical item order (including tagged and RTL text).
    // Split on baseline changes; never globally sort words across columns.
    let line = [];
    for (const word of words) {
      const previous = line[line.length - 1];
      if (previous && (Math.abs(previous.y - word.y) > typical * .55 || word.x < previous.x - typical * 2)) {
        lines.push(line); line = [];
      }
      line.push(word);
      if (word.eol) { lines.push(line); line = []; }
    }
    if (line.length) lines.push(line);
    const rendered = lines.map((row) => {
      let text = "";
      for (let i = 0; i < row.length; i++) {
        const word = row[i];
        const previous = row[i - 1];
        const gap = previous ? word.x - previous.x - previous.width : 0;
        const punctuation = /^[,.;:!?%)\]}]/u.test(word.text);
        const join = previous && gap <= typical * .12 && !/[.!?]$/u.test(previous.text);
        text += `${i && !punctuation && !join ? " " : ""}${word.text}`;
      }
      return { text: clean(text), y: row[0].y, height: Math.max(...row.map((word) => word.height)) };
    });
    let result = "";
    for (let i = 0; i < rendered.length; i++) {
      const line = rendered[i];
      const previous = rendered[i - 1];
      if (previous) {
        const gap = Math.abs(previous.y - line.y);
        if (/-$/u.test(previous.text) && /^[\p{Ll}]/u.test(line.text) && gap < typical * 2.2) result = result.slice(0, -1);
        else result += gap > typical * 1.8 ? "\n\n" : " ";
      }
      result += line.text;
    }
    return clean(result);
  }
  function removeRepeatedMargins(pages) {
    if (pages.length < 3) return pages;
    const counts = new Map();
    const key = (line) => line.replace(/\d+/gu, "#").trim();
    for (const page of pages) {
      const lines = page.text.split(/\n+/u).filter(Boolean);
      const edges = new Set([...lines.slice(0, 1), ...lines.slice(-1)].filter((line) => line.length < 100).map(key));
      for (const edge of edges) counts.set(edge, (counts.get(edge) || 0) + 1);
    }
    const repeated = new Set([...counts].filter(([, count]) => count >= Math.max(3, pages.length * .7)).map(([text]) => text));
    return pages.map((page) => {
      const lines = page.text.split(/\n+/u).filter(Boolean);
      if (lines.length > 1 && repeated.has(key(lines[0]))) lines.shift();
      if (lines.length > 1 && (repeated.has(key(lines.at(-1))) || /^\d+$/u.test(lines.at(-1)))) lines.pop();
      return { ...page, text: lines.join("\n\n") };
    });
  }
  const api = { clean, pageText, removeRepeatedMargins };
  root.SonaPdfLayout = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
