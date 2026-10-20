// Enough XML for a CalDAV server's answers (what Python's ElementTree did for
// calendar.py): elements with their namespace and local name, attributes,
// text with entities and CDATA resolved. No validation, no DTDs. Malformed
// input throws, as ElementTree's ParseError did.
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export class XmlError extends Error {}

function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/gu, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    if (e in ENT) return ENT[e];
    throw new XmlError(`undefined entity ${m}`);
  });
}

/**
 * @returns {{ns: string, name: string, attrs: object, children: object[], text: string|null}}
 *   `text` is the text before the first child, as ElementTree's .text
 */
export function parseXml(src) {
  let i = 0;
  const stack = [];
  let root = null;
  const nsStack = [{ xml: 'http://www.w3.org/XML/1998/namespace' }];
  const addText = (t) => {
    const top = stack[stack.length - 1];
    if (!top) {
      if (t.trim()) throw new XmlError('text outside the root element');
      return;
    }
    if (top.children.length === 0) top.text = (top.text ?? '') + t;
    else {
      const last = top.children[top.children.length - 1];
      last.tail = (last.tail ?? '') + t;
    }
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { addText(decode(src.slice(i))); break; }
    if (lt > i) addText(decode(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlError('unclosed comment');
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlError('unclosed CDATA');
      addText(src.slice(lt + 9, end));
      i = end + 3;
    } else if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlError('unclosed processing instruction');
      i = end + 2;
    } else if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      if (end < 0) throw new XmlError('unclosed declaration');
      i = end + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      if (end < 0) throw new XmlError('unclosed end tag');
      const qname = src.slice(lt + 2, end).trim();
      const el = stack.pop();
      nsStack.pop();
      if (!el || el.qname !== qname) throw new XmlError(`mismatched tag </${qname}>`);
      delete el.qname;
      i = end + 1;
    } else {
      // a start tag: name, attributes, maybe self-closing
      const m = /^<([^\s/>]+)/u.exec(src.slice(lt, lt + 256));
      if (!m) throw new XmlError('bad start tag');
      let j = lt + m[0].length;
      const raw = {};
      for (;;) {
        while (/\s/u.test(src[j] || '')) j++;
        if (src[j] === '>' || src.startsWith('/>', j)) break;
        const am = /^([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/u.exec(src.slice(j, j + 8192));
        if (!am) throw new XmlError('bad attribute');
        raw[am[1]] = decode(am[3] ?? am[4]);
        j += am[0].length;
      }
      const selfClosing = src.startsWith('/>', j);
      i = j + (selfClosing ? 2 : 1);
      const scope = { ...nsStack[nsStack.length - 1] };
      for (const [k, v] of Object.entries(raw)) {
        if (k === 'xmlns') scope[''] = v;
        else if (k.startsWith('xmlns:')) scope[k.slice(6)] = v;
      }
      const split = (qn, isAttr) => {
        const c = qn.indexOf(':');
        if (c < 0) return { ns: isAttr ? '' : (scope[''] || ''), name: qn };
        const prefix = qn.slice(0, c);
        if (!(prefix in scope)) throw new XmlError(`unbound prefix ${prefix}`);
        return { ns: scope[prefix], name: qn.slice(c + 1) };
      };
      const { ns, name } = split(m[1], false);
      const attrs = {};
      for (const [k, v] of Object.entries(raw)) {
        if (k === 'xmlns' || k.startsWith('xmlns:')) continue;
        const a = split(k, true);
        attrs[a.ns ? `{${a.ns}}${a.name}` : a.name] = v;
      }
      const el = { ns, name, attrs, children: [], text: null, qname: m[1] };
      if (stack.length) stack[stack.length - 1].children.push(el);
      else if (root) throw new XmlError('more than one root element');
      else root = el;
      if (selfClosing) delete el.qname;
      else { stack.push(el); nsStack.push(scope); }
    }
  }
  if (stack.length) throw new XmlError(`unclosed element <${stack[stack.length - 1].qname}>`);
  if (!root) throw new XmlError('no element found');
  return root;
}

/** Direct children in namespace `ns` named `name` (ElementTree's findall). */
export const findAll = (el, ns, name) => (el ? el.children.filter((c) => c.ns === ns && c.name === name) : []);
export const find = (el, ns, name) => findAll(el, ns, name)[0] || null;
/** findtext: the child's text, '' if it has none, `dflt` if there is no child. */
export function findText(el, ns, name, dflt = '') {
  const c = find(el, ns, name);
  return c ? (c.text ?? '') : dflt;
}
/** Every element below (and including) `el` with that name (ElementTree's iter). */
export function* iter(el, ns, name) {
  if (el.ns === ns && el.name === name) yield el;
  for (const c of el.children) yield* iter(c, ns, name);
}
