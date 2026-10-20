// A to-do's title with its inline Markdown shown, as Obsidian shows the same
// task line: **bold**, *italic*, ==highlight==, ~~strike~~, `code` and
// [links](…) (bare links too). The title stays plain text in the file and
// while it is being edited; this is only how a row reads it.
//
// Everything is escaped first and only these few tags are made, so a title
// can never put markup of its own into the page.

const esc = (s) => s.replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SAFE_URL = /^(https?:\/\/|mailto:|obsidian:\/\/)/iu;

/** Inline Markdown → a little HTML: strong, em, mark, s, code, a. */
export function inlineMarkdown(text) {
  if (!text) return '';
  const codes = [];
  // code first: nothing inside it is read as Markdown
  let s = text.replace(/`([^`\n]+)`/gu, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  const links = [];
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, (m, label, url) => (SAFE_URL.test(url)
    ? `\u0001${links.push([label, url]) - 1}\u0001` : m));
  s = esc(s);
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+[^\s<.,;:!?)])/gu, (_, pre, url) => `${pre}<a href="${url}" class="tlink">${url}</a>`);
  s = s.replace(/\*\*(?=\S)([^*]*?\S)\*\*/gu, '<strong>$1</strong>')
    .replace(/__(?=\S)([^_]*?\S)__/gu, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?![*\w])/gu, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/gu, '$1<em>$2</em>')
    .replace(/==(?=\S)([^=]*?\S)==/gu, '<mark>$1</mark>')
    .replace(/~~(?=\S)([^~]*?\S)~~/gu, '<s>$1</s>');
  s = s.replace(/\u0001(\d+)\u0001/gu, (_, i) => {
    const [label, url] = links[+i];
    return `<a href="${esc(url)}" class="tlink">${inlineMarkdown(label)}</a>`;
  });
  return s.replace(/\u0000(\d+)\u0000/gu, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

/** The title as text alone, for where no markup can go (aria, window titles). */
export function plainTitle(text) {
  const div = typeof document !== 'undefined' ? document.createElement('div') : null;
  if (!div) return text;
  div.innerHTML = inlineMarkdown(text);
  return div.textContent;
}
