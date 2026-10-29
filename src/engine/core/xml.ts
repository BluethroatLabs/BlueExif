/**
 * Minimal, dependency-free XML DOM with namespace resolution and a faithful
 * serializer. Good enough for XMP packets, OOXML/ODF/EPUB metadata parts and
 * SVG — not a validating parser.
 */

import { MetadataError } from './types';

export interface XAttr {
  /** qualified name as written, e.g. "rdf:about" */
  name: string;
  value: string;
}

export interface XElement {
  type: 'element';
  /** qualified name as written, e.g. "dc:title" */
  name: string;
  attrs: XAttr[];
  children: XNode[];
  parent: XElement | null;
}

export interface XText {
  type: 'text';
  value: string;
}
export interface XCData {
  type: 'cdata';
  value: string;
}
export interface XComment {
  type: 'comment';
  value: string;
}
export interface XPI {
  type: 'pi';
  target: string;
  value: string;
}
export interface XDoctype {
  type: 'doctype';
  value: string;
}

export type XNode = XElement | XText | XCData | XComment | XPI | XDoctype;

export interface XDocument {
  /** Top-level nodes: declaration PI, comments, doctype and the root element */
  nodes: XNode[];
  root: XElement;
}

const NAME_START = /[A-Za-z_:À-￿]/;

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    switch (e) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
    }
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return '';
    }
  });
}

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;')
    .replace(/\t/g, '&#x9;');
}

/** Remove characters that are illegal in XML 1.0. */
export function sanitizeXmlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

/**
 * Deepest element nesting accepted. Real documents stay far below it; the tree
 * walkers here and in the handlers recurse, so a crafted file nested thousands
 * of levels deep must be refused before it overflows the stack.
 */
export const MAX_XML_DEPTH = 512;

/** Nesting beyond MAX_XML_DEPTH: unlike other parse errors, never skipped as a merely malformed part. */
export class XmlDepthError extends MetadataError {}

export function parseXml(src: string): XDocument {
  let i = 0;
  const n = src.length;
  if (src.charCodeAt(0) === 0xfeff) i = 1;
  const top: XNode[] = [];
  const stack: XElement[] = [];
  let root: XElement | null = null;

  const fail = (msg: string): never => {
    throw new MetadataError(`XML parse error at ${i}: ${msg}`);
  };

  const push = (node: XNode) => {
    if (stack.length) {
      const parent = stack[stack.length - 1];
      if (node.type === 'element') node.parent = parent;
      parent.children.push(node);
    } else if (node.type === 'text') {
      if (node.value.trim()) fail('text outside root element');
    } else {
      top.push(node);
    }
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      push({ type: 'text', value: decodeEntities(src.slice(i)) });
      break;
    }
    if (lt > i) push({ type: 'text', value: decodeEntities(src.slice(i, lt)) });
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end < 0) fail('unterminated comment');
      push({ type: 'comment', value: src.slice(i + 4, end) });
      i = end + 3;
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      if (end < 0) fail('unterminated CDATA');
      push({ type: 'cdata', value: src.slice(i + 9, end) });
      i = end + 3;
    } else if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      if (end < 0) fail('unterminated processing instruction');
      const body = src.slice(i + 2, end);
      const sp = body.search(/\s/);
      push({ type: 'pi', target: sp < 0 ? body : body.slice(0, sp), value: sp < 0 ? '' : body.slice(sp + 1) });
      i = end + 2;
    } else if (src.startsWith('<!DOCTYPE', i) || src.startsWith('<!doctype', i)) {
      // Skip to the matching '>' taking an internal subset into account.
      let j = i + 9;
      let depth = 0;
      for (; j < n; j++) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      push({ type: 'doctype', value: src.slice(i + 9, j).trim() });
      i = j + 1;
    } else if (src[i + 1] === '/') {
      const end = src.indexOf('>', i);
      if (end < 0) fail('unterminated end tag');
      const name = src.slice(i + 2, end).trim();
      const el = stack.pop();
      if (!el) fail(`unexpected </${name}>`);
      if (el!.name !== name) fail(`mismatched </${name}>, expected </${el!.name}>`);
      i = end + 1;
    } else {
      // start tag
      let j = i + 1;
      if (!NAME_START.test(src[j] ?? '')) fail('invalid tag name');
      while (j < n && !/[\s/>]/.test(src[j])) j++;
      const name = src.slice(i + 1, j);
      const el: XElement = { type: 'element', name, attrs: [], children: [], parent: null };
      if (!stack.length) {
        if (root) fail('multiple root elements');
        root = el;
      }
      // attributes
      for (;;) {
        while (j < n && /\s/.test(src[j])) j++;
        if (j >= n) fail('unterminated start tag');
        if (src[j] === '>') {
          j++;
          push(el);
          if (stack.length >= MAX_XML_DEPTH) throw new XmlDepthError(`The XML is nested more than ${MAX_XML_DEPTH} levels deep, which this app cannot process`);
          stack.push(el);
          break;
        }
        if (src[j] === '/' && src[j + 1] === '>') {
          j += 2;
          push(el);
          break;
        }
        const an = j;
        while (j < n && !/[\s=/>]/.test(src[j])) j++;
        if (j === an) fail('invalid character in start tag'); // e.g. a stray "/": no progress otherwise
        const aname = src.slice(an, j);
        while (j < n && /\s/.test(src[j])) j++;
        if (src[j] !== '=') {
          // attribute without value (HTML-ish); treat as empty
          el.attrs.push({ name: aname, value: '' });
          continue;
        }
        j++;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q !== '"' && q !== "'") fail('attribute value must be quoted');
        const end = src.indexOf(q, j + 1);
        if (end < 0) fail('unterminated attribute value');
        // XML 1.0 §3.3.3 attribute-value normalization: literal tab/CR/LF are spaces
        // (character references such as &#xA; still yield real newlines).
        el.attrs.push({ name: aname, value: decodeEntities(src.slice(j + 1, end).replace(/\r\n?|[\n\t]/g, ' ')) });
        j = end + 1;
      }
      i = j;
    }
  }
  if (stack.length) fail(`unclosed <${stack[stack.length - 1].name}>`);
  if (!root) fail('no root element');
  return { nodes: top, root: root! };
}

// -------------------------------------------------------------- namespaces

export const XMLNS = 'http://www.w3.org/XML/1998/namespace';

export function prefixOf(qname: string): string {
  const c = qname.indexOf(':');
  return c < 0 ? '' : qname.slice(0, c);
}

export function localName(qname: string): string {
  const c = qname.indexOf(':');
  return c < 0 ? qname : qname.slice(c + 1);
}

/** Resolve a prefix ('' = default namespace) in the scope of `el`. */
export function lookupNs(el: XElement | null, prefix: string): string | null {
  if (prefix === 'xml') return XMLNS;
  const key = prefix ? `xmlns:${prefix}` : 'xmlns';
  for (let e = el; e; e = e.parent) {
    for (const a of e.attrs) if (a.name === key) return a.value;
  }
  return null;
}

/** Find a prefix bound to `uri` in scope of `el`. */
export function lookupPrefix(el: XElement | null, uri: string): string | null {
  for (let e = el; e; e = e.parent) {
    for (const a of e.attrs) {
      if (a.value === uri) {
        if (a.name === 'xmlns') return '';
        if (a.name.startsWith('xmlns:')) return a.name.slice(6);
      }
    }
  }
  return null;
}

export function nsOf(el: XElement): string | null {
  return lookupNs(el, prefixOf(el.name));
}

/** Namespace of an attribute (unprefixed attributes have no namespace). */
export function attrNs(el: XElement, a: XAttr): string | null {
  const p = prefixOf(a.name);
  if (!p) return null;
  if (p === 'xmlns') return 'http://www.w3.org/2000/xmlns/';
  return lookupNs(el, p);
}

export function is(el: XNode | null | undefined, ns: string | null, local: string): el is XElement {
  return !!el && el.type === 'element' && localName(el.name) === local && (ns === null || nsOf(el) === ns);
}

export function elements(el: XElement): XElement[] {
  return el.children.filter((c): c is XElement => c.type === 'element');
}

export function child(el: XElement, ns: string | null, local: string): XElement | undefined {
  return el.children.find((c): c is XElement => is(c, ns, local));
}

export function childrenOf(el: XElement, ns: string | null, local: string): XElement[] {
  return el.children.filter((c): c is XElement => is(c, ns, local));
}

/** Depth-first search for all matching descendants. */
export function descendants(el: XElement, ns: string | null, local: string, out: XElement[] = []): XElement[] {
  for (const c of el.children) {
    if (c.type !== 'element') continue;
    if (is(c, ns, local)) out.push(c);
    descendants(c, ns, local, out);
  }
  return out;
}

export function textContent(node: XNode): string {
  if (node.type === 'text' || node.type === 'cdata') return node.value;
  if (node.type !== 'element') return '';
  let s = '';
  for (const c of node.children) s += textContent(c);
  return s;
}

export function setText(el: XElement, text: string): void {
  el.children = text ? [{ type: 'text', value: sanitizeXmlChars(text) }] : [];
}

export function getAttr(el: XElement, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

/** Get an attribute by namespace + local name. */
export function getAttrNs(el: XElement, ns: string | null, local: string): string | undefined {
  for (const a of el.attrs) {
    if (localName(a.name) !== local) continue;
    if (ns === null ? !prefixOf(a.name) : attrNs(el, a) === ns) return a.value;
  }
  return undefined;
}

export function setAttr(el: XElement, name: string, value: string): void {
  const a = el.attrs.find((x) => x.name === name);
  if (a) a.value = sanitizeXmlChars(value);
  else el.attrs.push({ name, value: sanitizeXmlChars(value) });
}

export function removeAttr(el: XElement, name: string): void {
  el.attrs = el.attrs.filter((a) => a.name !== name);
}

export function createElement(name: string, attrs: Record<string, string> = {}, text?: string): XElement {
  const el: XElement = {
    type: 'element',
    name,
    attrs: Object.entries(attrs).map(([k, v]) => ({ name: k, value: v })),
    children: [],
    parent: null,
  };
  if (text !== undefined) setText(el, text);
  return el;
}

export function appendChild(parent: XElement, node: XNode): void {
  if (node.type === 'element') node.parent = parent;
  parent.children.push(node);
}

export function removeNode(node: XElement): void {
  const p = node.parent;
  if (!p) return;
  const idx = p.children.indexOf(node);
  if (idx >= 0) p.children.splice(idx, 1);
  // Drop whitespace-only text that preceded the node to keep output tidy.
  const prev = p.children[idx - 1];
  if (idx > 0 && prev?.type === 'text' && !prev.value.trim()) p.children.splice(idx - 1, 1);
  node.parent = null;
}

/**
 * Insert `node` into `parent`, copying the indentation used by existing
 * children when the parent is pretty-printed.
 */
export function appendIndented(parent: XElement, node: XElement): void {
  const kids = parent.children;
  const ws = kids.find((c): c is XText => c.type === 'text' && /^\s*\n\s*$/.test(c.value));
  node.parent = parent;
  if (!ws) {
    kids.push(node);
    return;
  }
  const last = kids[kids.length - 1];
  if (last?.type === 'text' && !last.value.trim()) {
    // "...<prev/>\n  </parent>" -> "...<prev/>\n  <node/>\n</parent>"
    kids.splice(kids.length - 1, 0, { type: 'text', value: ws.value }, node);
    // ensure the closing whitespace keeps the parent indentation
  } else {
    kids.push({ type: 'text', value: ws.value }, node);
  }
}

// ------------------------------------------------------------ serialization

export function serializeNode(node: XNode): string {
  switch (node.type) {
    case 'text':
      return escapeText(node.value);
    case 'cdata':
      return `<![CDATA[${node.value}]]>`;
    case 'comment':
      return `<!--${node.value}-->`;
    case 'pi':
      return `<?${node.target}${node.value ? ` ${node.value}` : ''}?>`;
    case 'doctype':
      return `<!DOCTYPE ${node.value}>`;
    case 'element': {
      let s = `<${node.name}`;
      for (const a of node.attrs) s += ` ${a.name}="${escapeAttr(a.value)}"`;
      if (!node.children.length) return `${s}/>`;
      s += '>';
      for (const c of node.children) s += serializeNode(c);
      return `${s}</${node.name}>`;
    }
  }
}

export function serializeXml(doc: XDocument): string {
  let s = '';
  for (const node of doc.nodes) {
    s += serializeNode(node);
    if (node.type !== 'element' || node !== doc.nodes[doc.nodes.length - 1]) {
      if (node.type === 'pi' || node.type === 'doctype' || node.type === 'comment') s += '\n';
    }
  }
  return s;
}

/**
 * Serialize an element out of context, re-declaring every namespace prefix it
 * uses that is declared on an ancestor (so the snippet stays well-formed).
 */
export function serializeDetached(el: XElement): string {
  const needed = new Map<string, string>();
  const collect = (e: XElement) => {
    const add = (p: string) => {
      if (p === 'xml' || p === 'xmlns' || needed.has(p)) return;
      const uri = lookupNs(e, p);
      if (uri !== null) needed.set(p, uri);
    };
    add(prefixOf(e.name));
    for (const a of e.attrs) {
      const p = prefixOf(a.name);
      if (p && p !== 'xmlns') add(p);
    }
    for (const c of e.children) if (c.type === 'element') collect(c);
  };
  collect(el);
  const clone: XElement = { ...el, attrs: [...el.attrs] };
  for (const [p, uri] of needed) {
    const key = p ? `xmlns:${p}` : 'xmlns';
    if (!clone.attrs.some((a) => a.name === key)) clone.attrs.push({ name: key, value: uri });
  }
  return serializeNode(clone);
}

/** Decode an XML byte stream honouring a UTF-16 BOM. */
export function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return new TextDecoder('utf-8').decode(bytes);
}
