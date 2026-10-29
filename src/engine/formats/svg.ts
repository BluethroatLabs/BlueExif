/**
 * SVG and SVGZ: the root <title>/<desc>, <metadata> — RDF in the Inkscape /
 * Creative Commons style (cc:Work typed nodes, cc:Agent wrappers) and embedded
 * XMP packets — and editor data shown as removable raw fields: Inkscape /
 * Sodipodi, Adobe Illustrator (including its private PGF document copy),
 * Sketch and any other non-SVG namespace, file-system paths, layer names
 * (data-name), XML comments and DOCTYPE entity declarations.
 *
 * Links (href, xlink:href, XHTML src): pictures embedded as data: URIs are
 * listed with what they reveal and cleaned by their own format handler
 * (embedded.ts; nested SVG pictures by this one), then stored again as base64
 * with the same media type, so their pixels are unchanged. Links to local or
 * network files (file:, C:\…, \\server\…, /Users/…, /home/…) are listed and
 * cut down to the bare file name.
 *
 * Entities declared in the DOCTYPE internal subset (Illustrator's
 * `&ns_ai;` …) are expanded before parsing, so namespaces resolve and the
 * serializer never double-escapes them. Files that use external, undeclared or
 * markup-bearing entities are read, but writing them is refused because their
 * meaning could not be preserved. SVGZ is (de)compressed with fflate.
 */

import { Gunzip, gzipSync } from 'fflate';
import { base64Decode, base64Encode, encodeUtf8, equalBytes, formatBytes, inflateLimited, latin1, toBlob, utf8OrLatin1 } from '../core/binary';
import { asList, asText, makeField, rawField } from '../core/fields';
import {
  DEFAULT_STRIP_OPTIONS,
  MetadataError,
  Source,
  groupKey,
  type DetectContext,
  type Edit,
  type Edits,
  type Field,
  type FieldGroup,
  type FieldKind,
  type FieldSpec,
  type FormatHandler,
  type InfoItem,
  type Metadata,
  type Sensitivity,
  type StripOptions,
} from '../core/types';
import {
  XMLNS,
  attrNs,
  createElement,
  decodeEntities,
  decodeXmlBytes,
  descendants,
  elements,
  getAttr,
  getAttrNs,
  localName,
  nsOf,
  parseXml,
  prefixOf,
  removeNode,
  serializeDetached,
  serializeXml,
  setAttr,
  setText,
  textContent,
  type XAttr,
  type XDocument,
  type XElement,
  type XNode,
} from '../core/xml';
import { applyXmpEdits, parseXmp, serializeXmp, xmpGroups, type XmpPacket } from '../xmp/xmp';
import { ensurePrefix, isNamed, qname } from './docparts';
import { cleanEmbedded, inspectEmbedded, revealed, type EmbeddedInfo } from './embedded';

const NS = {
  svg: 'http://www.w3.org/2000/svg',
  xlink: 'http://www.w3.org/1999/xlink',
  xhtml: 'http://www.w3.org/1999/xhtml',
  mathml: 'http://www.w3.org/1998/Math/MathML',
  events: 'http://www.w3.org/2001/xml-events',
  xmlnsAttr: 'http://www.w3.org/2000/xmlns/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  cc: 'http://creativecommons.org/ns#',
  ccOld: 'http://web.resource.org/cc/',
  dc: 'http://purl.org/dc/elements/1.1/',
  xmpmeta: 'adobe:ns:meta/',
  inkscape: 'http://www.inkscape.org/namespaces/inkscape',
  sodipodi: 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd',
} as const;

const STANDARD = new Set<string>([NS.svg, NS.xlink, NS.xhtml, NS.mathml, NS.events, NS.xmlnsAttr, XMLNS]);
const STILL_IMAGE = 'http://purl.org/dc/dcmitype/StillImage';

type Family = 'inkscape' | 'illustrator' | 'sketch' | 'other';

const FAMILY_LABEL: Record<Family, string> = {
  inkscape: 'Inkscape / Sodipodi data',
  illustrator: 'Adobe Illustrator data',
  sketch: 'Sketch data',
  other: 'Other editor data',
};

function familyOf(uri: string): Family {
  if (uri === NS.inkscape || uri === NS.sodipodi) return 'inkscape';
  if (uri.startsWith('http://ns.adobe.com/')) return 'illustrator';
  if (uri.startsWith('http://www.bohemiancoding.com/sketch')) return 'sketch';
  return 'other';
}

/** Attributes that store absolute file-system paths. */
const PATH_ATTRS = new Set(['export-filename', 'docbase', 'absref']);

/** href / xlink:href on any element, src on XHTML elements (<img> in a foreignObject). */
function isLink(el: XElement, a: XAttr): boolean {
  const local = localName(a.name);
  if (local === 'href') return !prefixOf(a.name) || attrNs(el, a) === NS.xlink;
  return a.name === 'src' && nsOf(el) === NS.xhtml;
}

/**
 * A link to a local or network file: file: URLs, drive letters, UNC shares and
 * absolute paths into home directories or mounted volumes. They name the user
 * and do not resolve anywhere else; site-relative links (/images/…) are left alone.
 */
const LOCAL_PATH = /^(?:file:|[a-z]:[\\/]|\\\\|~\/|\/(?:Users|home|Volumes|mnt|root|private|net|run\/media|var\/folders)\/)/i;

/** The last path segment of a local link, keeping a fragment (<use href="…/icons.svg#star">). */
function bareName(v: string): string {
  const hash = v.lastIndexOf('#');
  const frag = hash >= 0 && !/[\\/]/.test(v.slice(hash)) ? v.slice(hash) : '';
  const path = frag ? v.slice(0, hash) : v;
  const name = path.split(/[\\/]/).pop() ?? '';
  return /^file:|^[a-z]:$/i.test(name) ? frag : name + frag;
}

// --------------------------------------------------------------- loading

interface Svg {
  doc: XDocument;
  root: XElement;
  gzip: boolean;
  /** why the file cannot be rewritten safely */
  unwritable?: string;
  /** the DOCTYPE carries an internal subset (entity declarations) */
  subset: number;
}

function decodeSvgText(b: Uint8Array): string {
  if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return decodeXmlBytes(b);
  const enc = /^\s*<\?xml[^?]*?encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(latin1(b.subarray(0, 256)))?.[1].toLowerCase();
  if (!enc || enc === 'utf-8' || enc === 'utf8') return utf8OrLatin1(b.subarray(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0));
  try {
    return new TextDecoder(enc).decode(b);
  } catch {
    throw new MetadataError(`Unsupported SVG text encoding “${enc}”`);
  }
}

/** End index (exclusive) of a DOCTYPE starting at `start`, honouring the internal subset and quotes. */
function doctypeEnd(s: string, start: number): number {
  let depth = 0;
  let quote = '';
  for (let j = start + 9; j < s.length; j++) {
    const c = s[j];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '>' && depth <= 0) return j + 1;
  }
  return s.length;
}

const PREDEFINED = new Set(['lt', 'gt', 'amp', 'quot', 'apos']);

/**
 * Expand general entities declared in the DOCTYPE internal subset inside the
 * document body (CDATA sections and comments are left alone).
 */
function expandEntities(src: string): { text: string; subset: number; problem?: string } {
  const dt = /<!DOCTYPE/i.exec(src);
  let head = '';
  let body = src;
  const values = new Map<string, string>();
  const external = new Set<string>();
  let subset = 0;
  if (dt) {
    const end = doctypeEnd(src, dt.index);
    head = src.slice(0, end);
    body = src.slice(end);
    const inner = /\[([\s\S]*)\]/.exec(head.slice(dt.index))?.[1] ?? '';
    const re = /<!ENTITY\s+(%\s+)?([A-Za-z_:][\w.:-]*)\s+(?:"([^"]*)"|'([^']*)'|((?:SYSTEM|PUBLIC)[^>]*))\s*>/g;
    for (const m of inner.matchAll(re)) {
      subset++;
      if (m[1]) continue; // parameter entity
      if (m[5]) external.add(m[2]);
      else values.set(m[2], decodeEntities(m[3] ?? m[4] ?? ''));
    }
    if (inner.trim() && !subset) subset = 1;
  }
  const problems = new Set<string>();
  const expanded = body
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(/&([A-Za-z_:][\w.:-]*);/g, (all, name: string) => {
            if (PREDEFINED.has(name)) return all;
            const v = values.get(name);
            if (v === undefined) {
              problems.add(external.has(name) ? `external entity &${name};` : `undeclared entity &${name};`);
              return all;
            }
            if (/[<&"']/.test(v)) {
              problems.add(`entity &${name}; containing markup`);
              return all;
            }
            return v;
          }),
    )
    .join('');
  const problem = problems.size
    ? `This SVG uses ${[...problems].join(', ')}; it cannot be rewritten without changing its meaning.`
    : undefined;
  return { text: head + expanded, subset, problem };
}

/** Largest decompressed SVGZ document (a small crafted file must not expand into gigabytes). */
const MAX_SVGZ = 256 << 20;

async function loadSvg(src: Source): Promise<Svg> {
  let bytes = await src.bytes();
  let gzip = false;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = inflateLimited(bytes, 'gzip', MAX_SVGZ);
    } catch (e) {
      throw new MetadataError(`This SVGZ file cannot be decompressed: ${(e as Error).message}`);
    }
    gzip = true;
  }
  const prep = expandEntities(decodeSvgText(bytes));
  const doc = parseXml(prep.text);
  if (localName(doc.root.name) !== 'svg') throw new MetadataError('Not an SVG file (root element is not <svg>)');
  return { doc, root: doc.root, gzip, unwritable: prep.problem, subset: prep.subset };
}

function assertWritable(svg: Svg): void {
  if (svg.unwritable) throw new MetadataError(svg.unwritable);
}

// ----------------------------------------------------------- title/desc

/** Root-level <title>/<desc> (in the root's namespace). */
function rootChild(svg: Svg, local: string): XElement | undefined {
  const ns = nsOf(svg.root);
  return elements(svg.root).find((e) => localName(e.name) === local && nsOf(e) === ns);
}

function svgName(svg: Svg, local: string): string {
  const p = prefixOf(svg.root.name);
  return p ? `${p}:${local}` : local;
}

/** Insert at the top of the root (or right after `after`), copying the root's indentation. */
function insertAtTop(svg: Svg, el: XElement, after?: XElement): void {
  const kids = svg.root.children;
  const ws = kids.find((c) => c.type === 'text' && !c.value.trim() && c.value.includes('\n'));
  const idx = after ? kids.indexOf(after) + 1 : 0;
  el.parent = svg.root;
  const indent: XNode[] = ws?.type === 'text' ? [{ type: 'text', value: ws.value }] : [];
  kids.splice(idx, 0, ...indent, el);
}

const TEXT_FIELDS: Array<{ local: 'title' | 'desc'; label: string; kind: FieldKind }> = [
  { local: 'title', label: 'Title', kind: 'text' },
  { local: 'desc', label: 'Description', kind: 'multiline' },
];

function docGroup(svg: Svg): FieldGroup {
  const fields: Field[] = [];
  const addable: FieldSpec[] = [];
  for (const d of TEXT_FIELDS) {
    const spec: FieldSpec = { id: `svg:${d.local}`, label: d.label, kind: d.kind, sensitivity: 'content', tag: `<${d.local}>` };
    const el = rootChild(svg, d.local);
    if (el) fields.push(makeField(spec, textContent(el).trim()));
    else addable.push(spec);
  }
  return { id: 'svg.doc', label: 'Document', source: 'SVG', fields, addable };
}

// -------------------------------------------------------------------- RDF

function metadataElements(svg: Svg): XElement[] {
  const ns = nsOf(svg.root);
  return descendants(svg.root, null, 'metadata').filter((e) => nsOf(e) === ns);
}

function insideXmp(el: XElement): boolean {
  for (let p = el.parent; p; p = p.parent) if (isNamed(p, NS.xmpmeta, 'xmpmeta')) return true;
  return false;
}

/** rdf:RDF blocks that are not part of an XMP packet. */
function rdfBlocks(svg: Svg): XElement[] {
  return metadataElements(svg).flatMap((m) => descendants(m, NS.rdf, 'RDF').filter((r) => !insideXmp(r)));
}

function xmpBlocks(svg: Svg): XElement[] {
  return metadataElements(svg).flatMap((m) => descendants(m, NS.xmpmeta, 'xmpmeta'));
}

const isWork = (e: XElement) => isNamed(e, NS.cc, 'Work') || isNamed(e, NS.ccOld, 'Work');

function workNode(svg: Svg): XElement | undefined {
  for (const rdf of rdfBlocks(svg)) {
    const kids = elements(rdf);
    const w = kids.find(isWork) ?? kids.find((k) => isNamed(k, NS.rdf, 'Description'));
    if (w) return w;
  }
  return undefined;
}

interface RdfDef {
  ns: string;
  local: string;
  label: string;
  kind: FieldKind;
  sens?: Sensitivity;
  /** written as <cc:Agent><dc:title>…</dc:title></cc:Agent> */
  agent?: boolean;
  /** written as rdf:resource */
  resource?: boolean;
}

const RDF_DEFS: RdfDef[] = [
  { ns: NS.dc, local: 'title', label: 'Title', kind: 'text', sens: 'content' },
  { ns: NS.dc, local: 'creator', label: 'Creator', kind: 'text', sens: 'identity', agent: true },
  { ns: NS.dc, local: 'rights', label: 'Rights', kind: 'text', sens: 'identity', agent: true },
  { ns: NS.dc, local: 'publisher', label: 'Publisher', kind: 'text', sens: 'identity', agent: true },
  { ns: NS.dc, local: 'contributor', label: 'Contributor', kind: 'text', sens: 'identity', agent: true },
  { ns: NS.dc, local: 'date', label: 'Date', kind: 'text', sens: 'time' },
  { ns: NS.dc, local: 'description', label: 'Description', kind: 'multiline', sens: 'content' },
  { ns: NS.dc, local: 'subject', label: 'Keywords', kind: 'list', sens: 'content' },
  { ns: NS.dc, local: 'language', label: 'Language', kind: 'text' },
  { ns: NS.dc, local: 'identifier', label: 'Identifier', kind: 'text', sens: 'content' },
  { ns: NS.dc, local: 'source', label: 'Source', kind: 'text', sens: 'content' },
  { ns: NS.dc, local: 'relation', label: 'Relation', kind: 'text', sens: 'content' },
  { ns: NS.dc, local: 'coverage', label: 'Coverage', kind: 'text', sens: 'location' },
  { ns: NS.cc, local: 'license', label: 'License', kind: 'text', resource: true },
];

/** Inkscape's boilerplate, not shown. */
const HIDDEN_RDF = new Set([`${NS.dc}|format`, `${NS.dc}|type`]);

const rdfId = (ns: string, local: string) => `svg:rdf:${ns}|${local}`;

function rdfDef(el: XElement): RdfDef | undefined {
  const ns = nsOf(el) === NS.ccOld ? NS.cc : nsOf(el);
  return RDF_DEFS.find((d) => d.ns === ns && d.local === localName(el.name));
}

type RdfValue = { kind: 'text' | 'resource' | 'agent' | 'alt'; value: string } | { kind: 'list'; value: string[] } | { kind: 'raw'; value: string };

function rdfValue(el: XElement): RdfValue {
  const res = getAttrNs(el, NS.rdf, 'resource');
  if (res !== undefined) return { kind: 'resource', value: res };
  const kids = elements(el);
  if (!kids.length) return { kind: 'text', value: textContent(el).trim() };
  if (kids.length === 1) {
    const k = kids[0];
    if (isNamed(k, NS.rdf, 'Bag') || isNamed(k, NS.rdf, 'Seq')) return { kind: 'list', value: elements(k).map((li) => textContent(li).trim()) };
    if (isNamed(k, NS.rdf, 'Alt')) {
      const lis = elements(k);
      const li = lis.find((x) => getAttr(x, 'xml:lang') === 'x-default') ?? lis[0];
      return { kind: 'alt', value: li ? textContent(li).trim() : '' };
    }
    const title = elements(k).find((t) => isNamed(t, NS.dc, 'title'));
    if (title) return { kind: 'agent', value: textContent(title).trim() };
  }
  return { kind: 'raw', value: textContent(el).replace(/\s+/g, ' ').trim() };
}

function rdfGroup(svg: Svg): FieldGroup {
  const work = workNode(svg);
  const fields: Field[] = [];
  const present = new Set<string>();
  for (const el of work ? elements(work) : []) {
    const ns = nsOf(el) ?? '';
    const key = `${ns}|${localName(el.name)}`;
    if (HIDDEN_RDF.has(key) || present.has(key)) continue;
    present.add(key);
    const def = rdfDef(el);
    const id = rdfId(def?.ns ?? ns, localName(el.name));
    const label = def?.label ?? localName(el.name);
    const v = rdfValue(el);
    const spec: FieldSpec = { id, label, kind: def?.kind ?? 'text', sensitivity: def?.sens, tag: el.name };
    if (v.kind === 'list') fields.push(makeField({ ...spec, kind: 'list' }, v.value));
    else if (v.kind === 'raw') fields.push(rawField(id, label, v.value || '(structure)', { sensitivity: def?.sens, tag: el.name }));
    else fields.push(makeField({ ...spec, kind: spec.kind === 'list' ? 'text' : spec.kind }, v.value));
  }
  // Other typed nodes (cc:License …) as one raw field.
  const others = rdfBlocks(svg).flatMap((r) => elements(r).filter((n) => n !== work));
  if (others.length) {
    const parts = others.map((n) => {
      const terms = elements(n).map((c) => `${localName(c.name)} ${(getAttrNs(c, NS.rdf, 'resource') ?? textContent(c)).split(/[#/]/).pop()}`);
      return `${localName(n.name)}${terms.length ? `: ${terms.join(', ')}` : ''}`;
    });
    fields.push(rawField('svg:rdf:other', 'Other RDF statements', parts.join('; '), { sensitivity: 'content', tag: 'rdf:RDF' }));
  }
  const addable = RDF_DEFS.filter((d) => !present.has(`${d.ns}|${d.local}`)).map(
    (d): FieldSpec => ({ id: rdfId(d.ns, d.local), label: d.label, kind: d.kind, sensitivity: d.sens, tag: `${d.ns === NS.cc ? 'cc' : 'dc'}:${d.local}` }),
  );
  return { id: 'svg.rdf', label: 'Metadata (RDF)', source: 'SVG metadata', fields, addable, removable: true };
}

/** Find or create metadata > rdf:RDF > cc:Work (Inkscape layout). */
function ensureWork(svg: Svg): XElement {
  const existing = workNode(svg);
  if (existing) return existing;
  let meta = metadataElements(svg).find((m) => !xmpBlocks(svg).some((x) => x.parent === m));
  if (!meta) {
    meta = createElement(svgName(svg, 'metadata'));
    const anchor = rootChild(svg, 'desc') ?? rootChild(svg, 'title');
    insertAtTop(svg, meta, anchor);
  }
  const rdf = createElement('rdf:RDF', { 'xmlns:rdf': NS.rdf, 'xmlns:cc': NS.cc, 'xmlns:dc': NS.dc });
  rdf.parent = meta;
  meta.children.push(rdf);
  const rdfP = ensurePrefix(svg.root, rdf, NS.rdf, 'rdf');
  const work = createElement(qname(svg.root, rdf, NS.cc, 'cc', 'Work'), { [`${rdfP}:about`]: '' });
  work.parent = rdf;
  rdf.children.push(work);
  const fmt = createElement(qname(svg.root, work, NS.dc, 'dc', 'format'), {}, 'image/svg+xml');
  const type = createElement(qname(svg.root, work, NS.dc, 'dc', 'type'), { [`${rdfP}:resource`]: STILL_IMAGE });
  for (const c of [fmt, type]) {
    c.parent = work;
    work.children.push(c);
  }
  return work;
}

function applyRdfEdit(svg: Svg, ns: string, local: string, value: Edit): void {
  const work = value.op === 'set' ? ensureWork(svg) : workNode(svg);
  if (!work) return;
  const el = elements(work).find((c) => localName(c.name) === local && (nsOf(c) === ns || (ns === NS.cc && nsOf(c) === NS.ccOld)));
  if (value.op === 'remove') {
    if (el) removeNode(el);
    return;
  }
  const def = RDF_DEFS.find((d) => d.ns === ns && d.local === local);
  const label = def?.label ?? local;
  const cur = el ? rdfValue(el) : null;
  const rdfP = (scope: XElement) => ensurePrefix(svg.root, scope, NS.rdf, 'rdf');
  let prop = el;
  if (!prop) {
    prop = createElement(qname(svg.root, work, ns, ns === NS.cc ? 'cc' : 'dc', local));
    prop.parent = work;
    work.children.push(prop);
  }
  const kind = cur?.kind ?? (def?.resource ? 'resource' : def?.agent ? 'agent' : def?.kind === 'list' ? 'list' : 'text');
  if (kind === 'raw') throw new MetadataError(`${label} is a structure and cannot be edited directly`);
  if (kind === 'resource') {
    setAttr(prop, `${rdfP(prop)}:resource`, asText(value.value, label).trim());
    prop.children = [];
  } else if (kind === 'list') {
    const bagName = qname(svg.root, prop, NS.rdf, 'rdf', 'Bag');
    const bag = elements(prop)[0] ?? createElement(bagName);
    bag.parent = prop;
    prop.children = [bag];
    bag.children = [];
    for (const v of asList(value.value)) {
      const li = createElement(`${rdfP(prop)}:li`, {}, v);
      li.parent = bag;
      bag.children.push(li);
    }
  } else if (kind === 'agent') {
    const agent = elements(prop)[0] ?? createElement(qname(svg.root, prop, NS.cc, 'cc', 'Agent'));
    agent.parent = prop;
    prop.children = [agent];
    let title = elements(agent).find((t) => isNamed(t, NS.dc, 'title'));
    if (!title) {
      title = createElement(qname(svg.root, agent, NS.dc, 'dc', 'title'));
      title.parent = agent;
      agent.children.push(title);
    }
    setText(title, asText(value.value, label));
  } else if (kind === 'alt') {
    const alt = elements(prop)[0];
    const lis = alt ? elements(alt) : [];
    const li = lis.find((x) => getAttr(x, 'xml:lang') === 'x-default') ?? lis[0];
    if (li) setText(li, asText(value.value, label));
  } else setText(prop, asText(value.value, label));
}

// -------------------------------------------------------------------- XMP

function xmpPacket(svg: Svg): { el?: XElement; packet: XmpPacket | null; error?: string } {
  const el = xmpBlocks(svg)[0];
  if (!el) return { packet: null };
  try {
    return { el, packet: parseXmp(serializeDetached(el)) };
  } catch (e) {
    return { el, packet: null, error: `XMP could not be parsed: ${(e as Error).message}` };
  }
}

function replaceXmp(el: XElement, p: XmpPacket): void {
  const parent = el.parent!;
  if (!p.props.length) {
    removeNode(el);
    return;
  }
  const fresh = parseXml(serializeXmp(p, { wrapper: false })).root;
  fresh.parent = parent;
  parent.children[parent.children.indexOf(el)] = fresh;
}

// ----------------------------------------------------------- editor data

interface Cruft {
  families: Map<Family, { elements: XElement[]; attrs: Array<[XElement, XAttr]>; prefixes: Set<string> }>;
  paths: Array<[XElement, XAttr]>;
  /** links to local or network files */
  links: Array<[XElement, XAttr]>;
  /** data: URIs in links, in document order */
  pictures: Array<[XElement, XAttr]>;
  names: Array<[XElement, XAttr]>;
  comments: number;
  firstComment?: string;
  aiWrappers: XElement[];
  pgfBytes: number;
}

function scanCruft(svg: Svg): Cruft {
  const c: Cruft = { families: new Map(), paths: [], links: [], pictures: [], names: [], comments: 0, aiWrappers: [], pgfBytes: 0 };
  const svgNs = nsOf(svg.root);
  const fam = (f: Family) => {
    let x = c.families.get(f);
    if (!x) c.families.set(f, (x = { elements: [], attrs: [], prefixes: new Set() }));
    return x;
  };
  const comment = (v: string) => {
    c.comments++;
    c.firstComment ??= v.replace(/\s+/g, ' ').trim();
  };
  for (const n of svg.doc.nodes) if (n.type === 'comment') comment(n.value);
  const walk = (el: XElement) => {
    const ns = nsOf(el);
    if (localName(el.name) === 'metadata' && ns === svgNs) return;
    if (svgNs === NS.svg && ns !== null && !STANDARD.has(ns)) {
      const f = fam(familyOf(ns));
      f.elements.push(el);
      f.prefixes.add(prefixOf(el.name) || ns);
      if (familyOf(ns) === 'illustrator' && localName(el.name) === 'pgf') c.pgfBytes += textContent(el).trim().length;
      return;
    }
    if (localName(el.name) === 'foreignObject' && (getAttr(el, 'requiredExtensions') ?? '').startsWith('http://ns.adobe.com/')) c.aiWrappers.push(el);
    for (const a of el.attrs) {
      if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
      if (a.name === 'data-name') c.names.push([el, a]);
      if (isLink(el, a)) {
        const v = a.value.trim();
        if (/^data:/i.test(v)) c.pictures.push([el, a]);
        else if (LOCAL_PATH.test(v)) c.links.push([el, a]);
      }
      if (!prefixOf(a.name)) continue;
      const ans = attrNs(el, a);
      if (!ans || STANDARD.has(ans)) continue;
      const f = fam(familyOf(ans));
      f.attrs.push([el, a]);
      f.prefixes.add(prefixOf(a.name));
      if ((ans === NS.inkscape || ans === NS.sodipodi) && PATH_ATTRS.has(localName(a.name))) c.paths.push([el, a]);
    }
    for (const ch of el.children) {
      if (ch.type === 'comment') comment(ch.value);
      else if (ch.type === 'element') walk(ch);
    }
  };
  walk(svg.root);
  return c;
}

function editorGroup(svg: Svg, c: Cruft): FieldGroup {
  const fields: Field[] = [];
  for (const [f, data] of c.families) {
    const bits: string[] = [];
    if (f === 'inkscape') {
      const version = getAttrNs(svg.root, NS.inkscape, 'version');
      const docname = getAttrNs(svg.root, NS.sodipodi, 'docname');
      if (version) bits.push(`Inkscape ${version}`);
      if (docname) bits.push(`file “${docname}”`);
    }
    if (data.elements.length) bits.push(`${data.elements.length} element${data.elements.length > 1 ? 's' : ''}`);
    if (data.attrs.length) bits.push(`${data.attrs.length} attribute${data.attrs.length > 1 ? 's' : ''}`);
    if (f === 'illustrator' && c.pgfBytes) bits.push(`private document copy (${formatBytes(c.pgfBytes)})`);
    if (f === 'other') bits.push(`namespaces ${[...data.prefixes].join(', ')}`);
    fields.push(
      rawField(`svg:editor:${f}`, FAMILY_LABEL[f], bits.join(', '), {
        sensitivity: f === 'illustrator' && c.pgfBytes ? 'content' : 'software',
        tag: [...data.prefixes].map((p) => `${p}:`).join(' '),
        description: 'Editor-specific markup that browsers ignore; removing it does not change how the image looks.',
      }),
    );
  }
  const paths = [...c.paths, ...c.links];
  if (paths.length) {
    fields.push(
      rawField('svg:paths', 'File paths', [...new Set(paths.map(([, a]) => a.value.trim()))].join('; '), {
        sensitivity: 'identity',
        tag: paths.map(([, a]) => a.name).filter((v, i, all) => all.indexOf(v) === i).join(', '),
        description: c.links.length
          ? 'Absolute paths saved by the editor or in links to local files; they often contain the user name. Removing them keeps only the file names in links.'
          : 'Absolute paths saved by the editor; they often contain the user name.',
      }),
    );
  }
  if (c.names.length) {
    const names = [...new Set(c.names.map(([, a]) => a.value))];
    fields.push(rawField('svg:names', 'Layer names', names.length > 8 ? `${names.slice(0, 8).join(', ')}, …` : names.join(', '), { sensitivity: 'content', tag: 'data-name' }));
  }
  if (c.comments) {
    const first = c.firstComment && c.firstComment.length > 120 ? `${c.firstComment.slice(0, 120)}…` : c.firstComment;
    fields.push(rawField('svg:comments', c.comments > 1 ? `XML comments (${c.comments})` : 'XML comment', first || '(empty)', { sensitivity: 'software', tag: '<!-- -->' }));
  }
  if (svg.subset) {
    fields.push(rawField('svg:doctype', 'DOCTYPE declarations', `${svg.subset} entity declaration${svg.subset > 1 ? 's' : ''}`, { sensitivity: 'software', tag: '<!DOCTYPE [ … ]>' }));
  }
  return { id: 'svg.editor', label: 'Editor data', source: 'SVG', fields };
}

function removeFamily(c: Cruft, f: Family): void {
  const data = c.families.get(f);
  if (!data) return;
  for (const el of data.elements) removeNode(el);
  for (const [el, a] of data.attrs) el.attrs = el.attrs.filter((x) => x !== a);
  if (f === 'illustrator') {
    for (const w of c.aiWrappers) if (!elements(w).length) removeNode(w);
  }
}

function removeAttrs(list: Array<[XElement, XAttr]>): void {
  for (const [el, a] of list) el.attrs = el.attrs.filter((x) => x !== a);
}

/** Cut links to local files down to the file name (dropping the link when nothing is left). */
function reduceLinks(list: Array<[XElement, XAttr]>): void {
  for (const [el, a] of list) {
    const name = bareName(a.value.trim());
    if (name) a.value = name;
    else el.attrs = el.attrs.filter((x) => x !== a);
  }
}

function removeComments(svg: Svg): void {
  svg.doc.nodes = svg.doc.nodes.filter((n) => n.type !== 'comment');
  const walk = (el: XElement) => {
    el.children = el.children.filter((ch) => ch.type !== 'comment');
    for (const ch of el.children) if (ch.type === 'element') walk(ch);
  };
  walk(svg.root);
}

function removeSubset(svg: Svg): void {
  svg.doc.nodes = svg.doc.nodes.filter((n) => n.type !== 'doctype');
}

/** Drop xmlns:p declarations whose prefix is no longer used anywhere. */
function pruneNamespaces(svg: Svg): void {
  const used = new Set<string>();
  const collect = (el: XElement) => {
    used.add(prefixOf(el.name));
    for (const a of el.attrs) if (!a.name.startsWith('xmlns')) used.add(prefixOf(a.name));
    for (const ch of el.children) if (ch.type === 'element') collect(ch);
  };
  collect(svg.root);
  const prune = (el: XElement) => {
    el.attrs = el.attrs.filter((a) => !a.name.startsWith('xmlns:') || used.has(a.name.slice(6)));
    for (const ch of el.children) if (ch.type === 'element') prune(ch);
  };
  prune(svg.root);
}

/** Remove <metadata> elements left without element content. */
function dropEmptyMetadata(svg: Svg): void {
  for (const m of metadataElements(svg)) if (!elements(m).length) removeNode(m);
}

// --------------------------------------------------------------- pictures

/** A data: URI picture, decoded as browsers do (percent-decoding, then forgiving base64). */
interface Picture {
  /** text before the comma, e.g. "data:image/jpeg;base64" */
  head: string;
  base64: boolean;
  mime: string;
  bytes: Uint8Array;
  /** URL fragment after the data */
  fragment: string;
}

const isHex = (c: number) => (c >= 0x30 && c <= 0x39) || ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x66);

function percentDecode(s: string): Uint8Array {
  const b = encodeUtf8(s);
  if (!b.includes(0x25)) return b;
  const out = new Uint8Array(b.length);
  let o = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x25 && i + 2 < b.length && isHex(b[i + 1]) && isHex(b[i + 2])) {
      out[o++] = parseInt(latin1(b.subarray(i + 1, i + 3)), 16);
      i += 2;
    } else out[o++] = b[i];
  }
  return out.subarray(0, o);
}

function decodePicture(uri: string): Picture | null {
  const s = uri.trim();
  const comma = s.indexOf(',');
  if (!/^data:/i.test(s) || comma < 0) return null;
  const head = s.slice(0, comma);
  const hash = s.indexOf('#', comma);
  const body = percentDecode(s.slice(comma + 1, hash < 0 ? s.length : hash));
  const params = head.slice(5).split(';').map((x) => x.trim());
  const base64 = params.length > 1 && params[params.length - 1].toLowerCase() === 'base64';
  const pic = { head, base64, mime: (params[0] || 'text/plain').toLowerCase(), bytes: body, fragment: hash < 0 ? '' : s.slice(hash) };
  if (!base64) return pic;
  try {
    return { ...pic, bytes: base64Decode(latin1(body)) };
  } catch {
    return null; // not valid base64: browsers do not load it either
  }
}

function encodePicture(p: Picture, bytes: Uint8Array): string {
  return `${p.head}${p.base64 ? '' : ';base64'},${base64Encode(bytes)}${p.fragment}`;
}

/** A file name for the picture's handler (its format is recognised by content). */
const pictureName = (p: Picture) => `embedded.${(p.mime.split('/')[1] ?? '').replace(/^x-/, '').replace(/[^a-z0-9].*$/, '') || 'bin'}`;

const isSvgPicture = (b: Uint8Array) => (b[0] === 0x1f && b[1] === 0x8b ? sniffGzippedSvg(b.subarray(0, 65536)) : sniffSvg(b.subarray(0, 65536))) >= 2;

/** SVG pictures inside SVG pictures… are followed this deep. */
const MAX_NESTING = 4;

/**
 * What a picture reveals; null when nothing (or it is not a picture BlueExif
 * reads). Throws when an SVG picture cannot be read or would not be cleaned.
 */
async function inspectPicture(p: Picture, depth: number): Promise<EmbeddedInfo | null> {
  if (!isSvgPicture(p.bytes)) return inspectEmbedded(p.bytes, pictureName(p));
  if (depth >= MAX_NESTING) throw new MetadataError('it is nested too deeply');
  const m = await readSvgAt(Source.fromBytes(p.bytes, 'embedded.svg'), depth + 1);
  if (!m.canStrip) throw new MetadataError(m.warnings[0] ?? 'it cannot be rewritten');
  if (m.groups.some((g) => g.id === 'svg.images' && g.fields.some((f) => !f.removable))) throw new MetadataError('a picture inside it cannot be checked');
  return revealed(m.format.name, m.groups.flatMap((g) => g.fields.map((f) => f.sensitivity)));
}

/** The picture without its metadata, or null when there is nothing to change. Throws when it cannot be cleaned. */
async function cleanPicture(p: Picture, opts: StripOptions, depth: number): Promise<Uint8Array | null> {
  if (!isSvgPicture(p.bytes)) return cleanEmbedded(p.bytes, pictureName(p), opts);
  if (depth >= MAX_NESTING) throw new MetadataError('it is nested too deeply');
  const out = new Uint8Array(await (await stripSvgAt(Source.fromBytes(p.bytes, 'embedded.svg'), opts, depth + 1)).arrayBuffer());
  return equalBytes(out, p.bytes) ? null : out;
}

/** e.g. `<image id="photo">` */
function elementLabel(el: XElement): string {
  const id = getAttr(el, 'id');
  return `<${el.name}${id ? ` id="${id.length > 40 ? `${id.slice(0, 40)}…` : id}"` : ''}>`;
}

const PICTURE_DESCRIPTION = 'Metadata stored inside a picture embedded in the SVG (camera, location, author…). Removing it leaves the pixels unchanged.';

async function picturesGroup(c: Cruft, depth: number, warnings: string[]): Promise<FieldGroup | null> {
  const fields: Field[] = [];
  let stuck = 0;
  for (const [i, [el, a]] of c.pictures.entries()) {
    const p = decodePicture(a.value);
    if (!p) continue;
    const id = `svg:image:${i}`;
    try {
      const info = await inspectPicture(p, depth);
      if (!info) continue;
      const [what, ...parts] = info.summary.split(' · ');
      fields.push(
        rawField(id, what, [elementLabel(el), ...parts, formatBytes(p.bytes.length)].join(' · '), {
          sensitivity: info.sensitivity,
          tag: a.name,
          description: PICTURE_DESCRIPTION,
        }),
      );
    } catch (e) {
      stuck++;
      fields.push(
        rawField(id, 'SVG image', [elementLabel(el), formatBytes(p.bytes.length)].join(' · '), {
          sensitivity: 'content',
          tag: a.name,
          description: `BlueExif cannot clean this picture: ${(e as Error).message.replace(/\.$/, '')}. Its metadata stays in saved copies.`,
          removable: false,
        }),
      );
    }
  }
  if (stuck) warnings.push(`${stuck} embedded picture${stuck > 1 ? 's' : ''} cannot be cleaned; stripping this file will fail.`);
  return fields.length ? { id: 'svg.images', label: 'Embedded images', source: 'SVG', fields, removable: true } : null;
}

const attached = (svg: Svg, el: XElement) => {
  let e: XElement | null = el;
  while (e && e !== svg.root) e = e.parent;
  return e === svg.root;
};

/** Clean the pictures at `indexes` (all when omitted) in place; a picture that cannot be cleaned fails the whole operation. */
async function cleanPictures(svg: Svg, c: Cruft, opts: StripOptions, depth: number, indexes?: Set<number>): Promise<void> {
  for (const [i, [el, a]] of c.pictures.entries()) {
    if ((indexes && !indexes.has(i)) || !attached(svg, el)) continue;
    const p = decodePicture(a.value);
    if (!p) continue;
    let out: Uint8Array | null;
    try {
      out = await cleanPicture(p, opts, depth);
    } catch (e) {
      throw new MetadataError(`The picture embedded in ${elementLabel(el)} (${p.mime}) cannot be cleaned: ${(e as Error).message}`);
    }
    if (out) a.value = encodePicture(p, out);
  }
}

// ------------------------------------------------------------------ API

function svgInfo(svg: Svg): InfoItem[] {
  const info: InfoItem[] = [];
  const w = getAttr(svg.root, 'width');
  const h = getAttr(svg.root, 'height');
  const vb = getAttr(svg.root, 'viewBox');
  if (w || h) info.push({ label: 'Dimensions', value: `${w ?? 'auto'} × ${h ?? 'auto'}` });
  if (vb) info.push({ label: 'View box', value: vb });
  const version = getAttr(svg.root, 'version');
  if (version) info.push({ label: 'SVG version', value: version });
  let count = 0;
  const walk = (el: XElement) => {
    count++;
    for (const ch of el.children) if (ch.type === 'element') walk(ch);
  };
  walk(svg.root);
  info.push({ label: 'Elements', value: String(count) });
  if (svg.gzip) info.push({ label: 'Compression', value: 'gzip (SVGZ)' });
  return info;
}

export function readSvg(src: Source): Promise<Metadata> {
  return readSvgAt(src, 0);
}

/** `depth`: how deep this SVG is nested as a picture inside other SVGs. */
async function readSvgAt(src: Source, depth: number): Promise<Metadata> {
  const svg = await loadSvg(src);
  const warnings: string[] = [];
  if (svg.unwritable) warnings.push(svg.unwritable);
  const groups: FieldGroup[] = [docGroup(svg)];
  groups.push(rdfGroup(svg));
  const xmp = xmpPacket(svg);
  if (xmp.error) warnings.push(xmp.error);
  if (xmp.packet) groups.push(...xmpGroups(xmp.packet, { addable: true }));
  const cruft = scanCruft(svg);
  const pictures = await picturesGroup(cruft, depth, warnings);
  if (pictures) groups.push(pictures);
  groups.push(editorGroup(svg, cruft));
  return {
    format: { id: 'svg', name: svg.gzip ? 'SVGZ image' : 'SVG image', mime: 'image/svg+xml', category: 'image' },
    info: svgInfo(svg),
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: !svg.unwritable,
    canStrip: !svg.unwritable,
  };
}

function serialize(svg: Svg): Blob {
  for (const n of svg.doc.nodes) {
    if (n.type === 'pi' && n.target === 'xml') n.value = n.value.replace(/encoding\s*=\s*(["'])[^"']*\1/, 'encoding="UTF-8"');
  }
  let bytes = encodeUtf8(serializeXml(svg.doc));
  if (svg.gzip) bytes = gzipSync(bytes, { level: 9, mtime: 0 });
  return toBlob([bytes], 'image/svg+xml');
}

export async function writeSvg(src: Source, edits: Edits): Promise<Blob> {
  const svg = await loadSvg(src);
  assertWritable(svg);
  const cruft = scanCruft(svg);

  for (const d of TEXT_FIELDS) {
    const e = edits.get(`svg:${d.local}`);
    if (!e) continue;
    const el = rootChild(svg, d.local);
    if (e.op === 'remove') {
      if (el) removeNode(el);
    } else if (el) setText(el, asText(e.value, d.label));
    else {
      const created = createElement(svgName(svg, d.local), {}, asText(e.value, d.label));
      insertAtTop(svg, created, d.local === 'desc' ? rootChild(svg, 'title') : undefined);
    }
  }

  if (edits.get(groupKey('svg.rdf'))?.op === 'remove') for (const r of rdfBlocks(svg)) removeNode(r);
  for (const [id, e] of edits) {
    if (id === 'svg:rdf:other') {
      if (e.op === 'remove') {
        const work = workNode(svg);
        for (const r of rdfBlocks(svg)) for (const n of elements(r)) if (n !== work) removeNode(n);
      }
      continue;
    }
    if (!id.startsWith('svg:rdf:')) continue;
    const rest = id.slice('svg:rdf:'.length);
    const bar = rest.lastIndexOf('|');
    if (bar > 0) applyRdfEdit(svg, rest.slice(0, bar), rest.slice(bar + 1), e);
  }

  const xmpRemoved = edits.get(groupKey('xmp'))?.op === 'remove';
  if (xmpRemoved) for (const x of xmpBlocks(svg)) removeNode(x);
  else if ([...edits.keys()].some((k) => k.startsWith('xmp:'))) {
    const xmp = xmpPacket(svg);
    if (xmp.error) throw new MetadataError(xmp.error);
    if (!xmp.el || !xmp.packet) throw new MetadataError('This SVG has no XMP packet; use the RDF metadata fields instead');
    if (applyXmpEdits(xmp.packet, edits)) replaceXmp(xmp.el, xmp.packet);
  }

  const removed = (id: string) => edits.get(id)?.op === 'remove';
  const families = (['inkscape', 'illustrator', 'sketch', 'other'] as Family[]).filter((f) => removed(`svg:editor:${f}`));
  for (const f of families) removeFamily(cruft, f);
  if (removed('svg:paths')) {
    removeAttrs(cruft.paths);
    reduceLinks(cruft.links);
  }
  const pictures = removed(groupKey('svg.images')) ? undefined : new Set(cruft.pictures.map((_, i) => i).filter((i) => removed(`svg:image:${i}`)));
  if (!pictures || pictures.size) await cleanPictures(svg, cruft, DEFAULT_STRIP_OPTIONS, 0, pictures);
  if (removed('svg:names')) removeAttrs(cruft.names);
  if (removed('svg:comments')) removeComments(svg);
  if (removed('svg:doctype')) removeSubset(svg);
  dropEmptyMetadata(svg);
  if (families.length) pruneNamespaces(svg);
  // ExifTool (and some XMP readers) only accept RDF in SVG after an XML declaration.
  if (metadataElements(svg).length && !svg.doc.nodes.some((n) => n.type === 'pi' && n.target === 'xml')) {
    svg.doc.nodes.unshift({ type: 'pi', target: 'xml', value: 'version="1.0" encoding="UTF-8"' });
  }
  return serialize(svg);
}

export function stripSvg(src: Source, opts: StripOptions): Promise<Blob> {
  return stripSvgAt(src, opts, 0);
}

async function stripSvgAt(src: Source, opts: StripOptions, depth: number): Promise<Blob> {
  const svg = await loadSvg(src);
  assertWritable(svg);
  const cruft = scanCruft(svg);
  for (const m of metadataElements(svg)) removeNode(m);
  for (const d of TEXT_FIELDS) {
    const el = rootChild(svg, d.local);
    if (el) removeNode(el);
  }
  for (const f of cruft.families.keys()) removeFamily(cruft, f);
  for (const w of cruft.aiWrappers) if (!elements(w).length) removeNode(w);
  removeAttrs(cruft.names);
  reduceLinks(cruft.links);
  removeComments(svg);
  if (svg.subset) removeSubset(svg);
  pruneNamespaces(svg);
  await cleanPictures(svg, cruft, opts, depth);
  return serialize(svg);
}

/** Does the document's first element (after the prolog) look like <svg>? */
function sniffSvg(head: Uint8Array): number {
  let s = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff) ? decodeXmlBytes(head) : latin1(head);
  s = s.replace(/^﻿|^\xEF\xBB\xBF/, '');
  /** Index just past `close`, searching from `from`; -1 when it is not in the head. */
  const after = (close: string, from: number) => {
    const j = s.indexOf(close, from);
    return j < 0 ? -1 : j + close.length;
  };
  let i = 0;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    let next: number;
    if (s.startsWith('<?', i)) next = after('?>', i + 2);
    else if (s.startsWith('<!--', i)) next = after('-->', i + 4);
    else if (/^<!DOCTYPE/i.test(s.slice(i, i + 9))) next = doctypeEnd(s, i);
    else break;
    // Unterminated in the sniffed head: the root element is out of sight.
    if (next < 0) return 0;
    i = next;
  }
  if (!/^<(?:[A-Za-z_][\w.-]*:)?svg[\s>/]/.test(s.slice(i, i + 64))) return 0;
  return s.includes(NS.svg) ? 3 : 2;
}

/** Peek into gzip data (possibly truncated to the detect window) for an SVG root. */
function sniffGzippedSvg(head: Uint8Array): number {
  let out = new Uint8Array(0);
  try {
    const gz = new Gunzip((chunk) => {
      if (out.length < 4096) {
        const next = new Uint8Array(out.length + chunk.length);
        next.set(out);
        next.set(chunk, out.length);
        out = next;
      }
    });
    gz.push(head, false);
  } catch {
    /* truncated or corrupt stream: use what was inflated so far */
  }
  return out.length ? (sniffSvg(out) ? 3 : 0) : 0;
}

export const svgHandler: FormatHandler = {
  id: 'svg',
  name: 'SVG image',
  category: 'image',
  extensions: ['svg', 'svgz'],
  mime: 'image/svg+xml',
  detect(ctx: DetectContext) {
    if (ctx.head[0] === 0x1f && ctx.head[1] === 0x8b) {
      if (ctx.ext === 'svgz' || ctx.name.endsWith('.svg.gz')) return 3;
      return sniffGzippedSvg(ctx.head);
    }
    const s = sniffSvg(ctx.head);
    if (s) return s;
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readSvg,
  write: writeSvg,
  strip: stripSvg,
};
