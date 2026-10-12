const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pageText, clean, removeRepeatedMargins } = require('../pdf-layout.js');
const { isPdfUrl } = require('../extraction.js');
function item(str, x, y, width = 30, height = 12, eol = false) {
  return { str, transform: [height, 0, 0, height, x, y], width, height, hasEOL: eol };
}
test('PDF text retains words and punctuation without doubling spaces', () => {
  assert.equal(pageText([item('Hello', 20, 700), item('world', 54, 700), item('.', 84, 700, 3, 12, true)]), 'Hello world.');
});
test('PDF paragraphs and line-wrap hyphenation become natural reading text', () => {
  assert.equal(pageText([item('Read a docu-', 20, 700, 60, 12, true), item('ment aloud.', 20, 684, 60, 12, true),
    item('Another paragraph.', 20, 640, 90, 12, true)]), 'Read a document aloud.\n\nAnother paragraph.');
});
test('PDF ligatures and soft hyphens are normalized', () => {
  assert.equal(clean('  oﬃce  ﬁles\u00ad '), 'office files');
});
test('Repeated short page margins are removed without removing body paragraphs', () => {
  const pages = [1, 2, 3].map((number) => ({ number, text: `Annual report\n\nBody paragraph ${number} with unique text.\n\n${number}` }));
  assert.deepEqual(removeRepeatedMargins(pages).map((page) => page.text), pages.map((_, i) => `Body paragraph ${i + 1} with unique text.`));
});
test('PDF URL discovery handles uppercase files and explicit MIME query parameters', () => {
  assert.ok(isPdfUrl('https://example.com/report.PDF?signature=test#page=2'));
  assert.ok(isPdfUrl('https://example.com/download?format=pdf'));
  assert.equal(isPdfUrl('https://example.com/articles'), false);
});
