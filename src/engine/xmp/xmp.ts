/**
 * XMP packet model: flattens rdf:Description properties into simple values,
 * arrays (Bag/Seq), language alternatives and opaque "complex" structures
 * (kept verbatim). Serializes a clean single-Description packet.
 */

import { asInteger, asList, asText, displayDate, makeField, parseDate, rawField, requireDate, toIso } from '../core/fields';
import type { Edits, Field, FieldGroup, FieldKind, FieldSpec, Sensitivity } from '../core/types';
import { MetadataError } from '../core/types';
import {
  attrNs,
  elements,
  escapeAttr,
  escapeText,
  getAttr,
  is,
  localName,
  nsOf,
  parseXml,
  prefixOf,
  sanitizeXmlChars,
  serializeDetached,
  textContent,
  type XElement,
} from '../core/xml';

export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const XMLNS_X = 'adobe:ns:meta/';

export const NS: Record<string, string> = {
  dc: 'http://purl.org/dc/elements/1.1/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  xmpRights: 'http://ns.adobe.com/xap/1.0/rights/',
  xmpMM: 'http://ns.adobe.com/xap/1.0/mm/',
  photoshop: 'http://ns.adobe.com/photoshop/1.0/',
  tiff: 'http://ns.adobe.com/tiff/1.0/',
  exif: 'http://ns.adobe.com/exif/1.0/',
  exifEX: 'http://cipa.jp/exif/1.0/',
  aux: 'http://ns.adobe.com/exif/1.0/aux/',
  crs: 'http://ns.adobe.com/camera-raw-settings/1.0/',
  Iptc4xmpCore: 'http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/',
  Iptc4xmpExt: 'http://iptc.org/std/Iptc4xmpExt/2008-02-29/',
  plus: 'http://ns.useplus.org/ldf/xmp/1.0/',
  pdf: 'http://ns.adobe.com/pdf/1.3/',
  pdfx: 'http://ns.adobe.com/pdfx/1.3/',
  pdfaid: 'http://www.aiim.org/pdfa/ns/id/',
  pdfuaid: 'http://www.aiim.org/pdfua/ns/id/',
  pdfaExtension: 'http://www.aiim.org/pdfa/ns/extension/',
  xmpDM: 'http://ns.adobe.com/xmp/1.0/DynamicMedia/',
  xmpTPg: 'http://ns.adobe.com/xap/1.0/t/pg/',
  xmpNote: 'http://ns.adobe.com/xmp/note/',
  lr: 'http://ns.adobe.com/lightroom/1.0/',
  GPano: 'http://ns.google.com/photos/1.0/panorama/',
  GCamera: 'http://ns.google.com/photos/1.0/camera/',
  GContainer: 'http://ns.google.com/photos/1.0/container/',
  hdrgm: 'http://ns.adobe.com/hdr-gain-map/1.0/',
  'mwg-rs': 'http://www.metadataworkinggroup.com/schemas/regions/',
  MicrosoftPhoto: 'http://ns.microsoft.com/photo/1.0/',
  digiKam: 'http://www.digikam.org/ns/1.0/',
  cc: 'http://creativecommons.org/ns#',
  dcterms: 'http://purl.org/dc/terms/',
  apple_desktop: 'http://ns.apple.com/namespace/1.0/',
  stEvt: 'http://ns.adobe.com/xap/1.0/sType/ResourceEvent#',
  stRef: 'http://ns.adobe.com/xap/1.0/sType/ResourceRef#',
  c2pa: 'http://c2pa.org/manifest',
};

const NS_TO_PREFIX = new Map(Object.entries(NS).map(([p, u]) => [u, p]));

const NS_LABEL: Record<string, string> = {
  dc: 'Dublin Core',
  xmp: 'XMP basic',
  xmpRights: 'Rights',
  xmpMM: 'Media management',
  photoshop: 'Photoshop',
  tiff: 'TIFF (XMP)',
  exif: 'EXIF (XMP)',
  exifEX: 'EXIF 2.3 (XMP)',
  aux: 'Camera extras',
  crs: 'Camera Raw settings',
  Iptc4xmpCore: 'IPTC Core',
  Iptc4xmpExt: 'IPTC Extension',
  plus: 'PLUS licensing',
  pdf: 'PDF (XMP)',
  pdfx: 'PDF custom',
  pdfaid: 'PDF/A',
  pdfuaid: 'PDF/UA',
  pdfaExtension: 'PDF/A extensions',
  xmpDM: 'Dynamic media',
  lr: 'Lightroom',
  GPano: 'Google panorama',
  GCamera: 'Google camera',
  GContainer: 'Google container',
  hdrgm: 'HDR gain map',
  'mwg-rs': 'Regions (faces)',
  MicrosoftPhoto: 'Microsoft Photo',
  digiKam: 'digiKam',
  xmpTPg: 'Paged text',
  xmpNote: 'XMP note',
  cc: 'Creative Commons',
  dcterms: 'DC Terms',
  c2pa: 'Content Credentials',
};

export type XmpKind = 'simple' | 'bag' | 'seq' | 'alt' | 'complex';

export interface XmpProp {
  ns: string;
  prefix: string;
  name: string;
  kind: XmpKind;
  value?: string;
  items?: string[];
  alt?: Array<{ lang: string; value: string }>;
  /** complex: detached XML of the property element */
  xml?: string;
}

export interface XmpPacket {
  props: XmpProp[];
  toolkit?: string;
}

interface KnownProp {
  label: string;
  kind: XmpKind;
  /** UI kind for simple props */
  ui?: FieldKind;
  sens?: Sensitivity;
  addable?: boolean;
}

const K = (label: string, kind: XmpKind, extra: Partial<KnownProp> = {}): KnownProp => ({ label, kind, ...extra });

/** Keyed by "prefix:name" using the canonical prefixes above. */
export const KNOWN: Record<string, KnownProp> = {
  'dc:title': K('Title', 'alt', { sens: 'content', addable: true }),
  'dc:description': K('Description', 'alt', { ui: 'multiline', sens: 'content', addable: true }),
  'dc:creator': K('Creator', 'seq', { sens: 'identity', addable: true }),
  'dc:rights': K('Rights', 'alt', { sens: 'identity', addable: true }),
  'dc:subject': K('Keywords', 'bag', { sens: 'content', addable: true }),
  'dc:publisher': K('Publisher', 'bag', { sens: 'identity' }),
  'dc:contributor': K('Contributors', 'bag', { sens: 'identity' }),
  'dc:format': K('Format', 'simple'),
  'dc:language': K('Language', 'bag'),
  'dc:date': K('Date', 'seq', { sens: 'time' }),
  'dc:source': K('Source', 'simple', { sens: 'content' }),
  'dc:identifier': K('Identifier', 'simple', { sens: 'content' }),
  'xmp:CreatorTool': K('Creator tool', 'simple', { sens: 'software', addable: true }),
  'xmp:CreateDate': K('Created', 'simple', { ui: 'datetime', sens: 'time', addable: true }),
  'xmp:ModifyDate': K('Modified', 'simple', { ui: 'datetime', sens: 'time', addable: true }),
  'xmp:MetadataDate': K('Metadata date', 'simple', { ui: 'datetime', sens: 'time' }),
  'xmp:Rating': K('Rating', 'simple', { ui: 'integer', addable: true }),
  'xmp:Label': K('Label', 'simple', { addable: true }),
  'xmp:Nickname': K('Nickname', 'simple', { sens: 'content' }),
  'xmp:Identifier': K('Identifier', 'bag'),
  'xmpRights:Marked': K('Rights marked', 'simple'),
  'xmpRights:Owner': K('Rights owner', 'bag', { sens: 'identity' }),
  'xmpRights:UsageTerms': K('Usage terms', 'alt', { ui: 'multiline', addable: true }),
  'xmpRights:WebStatement': K('Copyright URL', 'simple', { addable: true }),
  'xmpMM:DocumentID': K('Document ID', 'simple', { sens: 'software' }),
  'xmpMM:InstanceID': K('Instance ID', 'simple', { sens: 'software' }),
  'xmpMM:OriginalDocumentID': K('Original document ID', 'simple', { sens: 'software' }),
  'xmpMM:History': K('Edit history', 'seq', { sens: 'software' }),
  'xmpMM:DerivedFrom': K('Derived from', 'complex', { sens: 'software' }),
  'xmpMM:Ingredients': K('Ingredients', 'bag', { sens: 'software' }),
  'xmpMM:Pantry': K('Pantry', 'bag', { sens: 'software' }),
  'photoshop:Headline': K('Headline', 'simple', { sens: 'content', addable: true }),
  'photoshop:City': K('City', 'simple', { sens: 'location', addable: true }),
  'photoshop:State': K('State / province', 'simple', { sens: 'location', addable: true }),
  'photoshop:Country': K('Country', 'simple', { sens: 'location', addable: true }),
  'photoshop:Credit': K('Credit', 'simple', { sens: 'identity', addable: true }),
  'photoshop:Source': K('Source', 'simple', { sens: 'identity' }),
  'photoshop:AuthorsPosition': K("Author's position", 'simple', { sens: 'identity' }),
  'photoshop:CaptionWriter': K('Caption writer', 'simple', { sens: 'identity' }),
  'photoshop:Instructions': K('Instructions', 'simple', { sens: 'content' }),
  'photoshop:DateCreated': K('Date created', 'simple', { ui: 'datetime', sens: 'time' }),
  'photoshop:TransmissionReference': K('Transmission reference', 'simple'),
  'photoshop:ColorMode': K('Color mode', 'simple'),
  'photoshop:ICCProfile': K('ICC profile name', 'simple'),
  'photoshop:DocumentAncestors': K('Document ancestors', 'bag', { sens: 'software' }),
  'Iptc4xmpCore:Location': K('Sub-location', 'simple', { sens: 'location' }),
  'Iptc4xmpCore:CountryCode': K('Country code', 'simple', { sens: 'location' }),
  'Iptc4xmpCore:CreatorContactInfo': K('Creator contact info', 'complex', { sens: 'identity' }),
  'Iptc4xmpExt:LocationCreated': K('Location created', 'bag', { sens: 'location' }),
  'Iptc4xmpExt:LocationShown': K('Location shown', 'bag', { sens: 'location' }),
  'Iptc4xmpExt:PersonInImage': K('People in image', 'bag', { sens: 'identity' }),
  'tiff:Make': K('Camera make', 'simple', { sens: 'device' }),
  'tiff:Model': K('Camera model', 'simple', { sens: 'device' }),
  'tiff:Software': K('Software', 'simple', { sens: 'software' }),
  'tiff:Artist': K('Artist', 'simple', { sens: 'identity' }),
  'tiff:DateTime': K('Modified', 'simple', { ui: 'datetime', sens: 'time' }),
  'tiff:Orientation': K('Orientation', 'simple'),
  'exif:DateTimeOriginal': K('Taken', 'simple', { ui: 'datetime', sens: 'time' }),
  'exif:DateTimeDigitized': K('Digitized', 'simple', { ui: 'datetime', sens: 'time' }),
  'exif:GPSLatitude': K('GPS latitude', 'simple', { sens: 'location' }),
  'exif:GPSLongitude': K('GPS longitude', 'simple', { sens: 'location' }),
  'exif:GPSAltitude': K('GPS altitude', 'simple', { sens: 'location' }),
  'exif:GPSAltitudeRef': K('GPS altitude ref', 'simple', { sens: 'location' }),
  'exif:GPSTimeStamp': K('GPS time', 'simple', { sens: 'time' }),
  'exifEX:BodySerialNumber': K('Camera serial number', 'simple', { sens: 'device' }),
  'exifEX:LensModel': K('Lens model', 'simple', { sens: 'device' }),
  'exifEX:LensSerialNumber': K('Lens serial number', 'simple', { sens: 'device' }),
  'exifEX:CameraOwnerName': K('Camera owner', 'simple', { sens: 'identity' }),
  'aux:SerialNumber': K('Camera serial number', 'simple', { sens: 'device' }),
  'aux:LensSerialNumber': K('Lens serial number', 'simple', { sens: 'device' }),
  'aux:Lens': K('Lens', 'simple', { sens: 'device' }),
  'aux:OwnerName': K('Camera owner', 'simple', { sens: 'identity' }),
  'pdf:Producer': K('PDF producer', 'simple', { sens: 'software' }),
  'pdf:Keywords': K('PDF keywords', 'simple', { sens: 'content' }),
  'xmpDM:artist': K('Artist', 'simple', { sens: 'identity' }),
  'xmpDM:album': K('Album', 'simple', { sens: 'content' }),
  'xmpDM:genre': K('Genre', 'simple'),
  'mwg-rs:Regions': K('Face / object regions', 'complex', { sens: 'identity' }),
  'lr:hierarchicalSubject': K('Hierarchical keywords', 'bag', { sens: 'content' }),
  'MicrosoftPhoto:LastKeywordXMP': K('Keywords (Microsoft)', 'bag', { sens: 'content' }),
};

/** Sensitivity heuristics for properties not in KNOWN. */
function guessSensitivity(prefix: string, name: string): Sensitivity | undefined {
  if (/GPS|Latitude|Longitude|Location|City|Country/i.test(name)) return 'location';
  if (/Serial|Make$|Model$|^Lens/i.test(name)) return 'device';
  if (/Date|Time$/i.test(name) && !/Zone/i.test(name)) return 'time';
  if (/Owner|Author|Creator|Artist|Person|Contact|Email|Copyright/i.test(name)) return 'identity';
  if (prefix === 'xmpMM' || prefix === 'crs' || /Software|Tool|History/i.test(name)) return 'software';
  return undefined;
}

// ------------------------------------------------------------------ parse

function extractRoot(xml: string): string {
  const starts = ['<x:xmpmeta', '<x:xapmeta', '<rdf:RDF'];
  for (const s of starts) {
    const i = xml.indexOf(s);
    if (i < 0) continue;
    const close = s === '<rdf:RDF' ? '</rdf:RDF>' : `</${s.slice(1)}>`;
    const j = xml.lastIndexOf(close);
    if (j > i) return xml.slice(i, j + close.length);
  }
  // Fall back to any element containing rdf:RDF.
  const k = xml.indexOf('<');
  return k >= 0 ? xml.slice(k) : xml;
}

function liText(li: XElement): string {
  const r = getAttr(li, 'rdf:resource');
  return r ?? textContent(li);
}

function isSimpleLi(li: XElement): boolean {
  if (elements(li).length) return false;
  if (getAttr(li, 'rdf:parseType')) return false;
  return li.attrs.every((a) => a.name === 'xml:lang' || a.name === 'rdf:resource' || a.name.startsWith('xmlns'));
}

function propFromElement(el: XElement): XmpProp | null {
  const ns = nsOf(el);
  if (!ns || ns === RDF) return null;
  const name = localName(el.name);
  const prefix = NS_TO_PREFIX.get(ns) ?? prefixOf(el.name) ?? 'ns';
  const base = { ns, name, prefix };
  const resource = getAttr(el, 'rdf:resource');
  if (resource !== undefined) return { ...base, kind: 'simple', value: resource };
  const kids = elements(el);
  if (getAttr(el, 'rdf:parseType') === 'Resource' || kids.some((k) => is(k, RDF, 'Description'))) {
    return { ...base, kind: 'complex', xml: serializeDetached(el) };
  }
  // Property attributes other than rdf:/xml:/xmlns make it a struct (shorthand)
  const qualAttrs = el.attrs.filter((a) => !a.name.startsWith('xmlns') && a.name !== 'xml:lang' && attrNs(el, a) !== RDF);
  if (!kids.length) {
    if (qualAttrs.length) return { ...base, kind: 'complex', xml: serializeDetached(el) };
    return { ...base, kind: 'simple', value: textContent(el) };
  }
  if (kids.length === 1) {
    const arr = kids[0];
    const which = is(arr, RDF, 'Bag') ? 'bag' : is(arr, RDF, 'Seq') ? 'seq' : is(arr, RDF, 'Alt') ? 'alt' : null;
    if (which) {
      const lis = elements(arr).filter((li) => is(li, RDF, 'li'));
      if (lis.every(isSimpleLi)) {
        if (which === 'alt') {
          return {
            ...base,
            kind: 'alt',
            alt: lis.map((li) => ({ lang: getAttr(li, 'xml:lang') ?? 'x-default', value: liText(li) })),
          };
        }
        return { ...base, kind: which, items: lis.map(liText) };
      }
    }
  }
  return { ...base, kind: 'complex', xml: serializeDetached(el) };
}

export function parseXmp(xml: string): XmpPacket {
  const doc = parseXml(extractRoot(xml));
  const rdf = is(doc.root, RDF, 'RDF') ? doc.root : findRdf(doc.root);
  if (!rdf) throw new MetadataError('XMP packet has no rdf:RDF element');
  const toolkit = getAttr(doc.root, 'x:xmptk') ?? getAttr(doc.root, 'x:xaptk');
  const props: XmpProp[] = [];
  const keyOf = (p: XmpProp) => `${p.ns}|${p.name}`;
  const index = new Map<string, number>();
  const push = (p: XmpProp | null) => {
    if (!p) return;
    const k = keyOf(p);
    const at = index.get(k);
    if (at !== undefined) props[at] = p;
    else {
      index.set(k, props.length);
      props.push(p);
    }
  };
  for (const desc of elements(rdf)) {
    if (!is(desc, RDF, 'Description')) continue;
    for (const a of desc.attrs) {
      if (a.name.startsWith('xmlns') || a.name.startsWith('xml:')) continue;
      const ns = attrNs(desc, a);
      if (!ns || ns === RDF) continue;
      push({ ns, name: localName(a.name), prefix: NS_TO_PREFIX.get(ns) ?? prefixOf(a.name), kind: 'simple', value: a.value });
    }
    for (const el of elements(desc)) push(propFromElement(el));
  }
  return { props, toolkit };
}

function findRdf(el: XElement): XElement | null {
  for (const c of elements(el)) {
    if (is(c, RDF, 'RDF')) return c;
    const f = findRdf(c);
    if (f) return f;
  }
  return null;
}

// -------------------------------------------------------------- serialize

export interface SerializeOptions {
  /** bytes of whitespace padding before the closing PI (default 2048) */
  padding?: number;
  /** emit the <?xpacket?> wrapper (default true) */
  wrapper?: boolean;
}

export function serializeXmp(p: XmpPacket, opts: SerializeOptions = {}): string {
  const used = new Map<string, string>(); // prefix -> ns
  const prefixFor = (ns: string, wanted: string): string => {
    let pf = NS_TO_PREFIX.get(ns) ?? (wanted || 'ns');
    if (used.has(pf) && used.get(pf) !== ns) {
      let i = 1;
      while (used.has(`${pf}${i}`) && used.get(`${pf}${i}`) !== ns) i++;
      pf = `${pf}${i}`;
    }
    used.set(pf, ns);
    return pf;
  };
  const body: string[] = [];
  const ind = '   ';
  for (const prop of p.props) {
    if (prop.kind === 'complex') {
      // The detached XML declares its own namespaces; ensure the prefix of
      // the element itself does not clash with ours.
      body.push(`${ind}${ind}${prop.xml}`);
      continue;
    }
    const pf = prefixFor(prop.ns, prop.prefix);
    const q = `${pf}:${prop.name}`;
    const t = (s: string) => escapeText(sanitizeXmlChars(s));
    if (prop.kind === 'simple') {
      body.push(`${ind}${ind}<${q}>${t(prop.value ?? '')}</${q}>`);
    } else if (prop.kind === 'alt') {
      const lis = (prop.alt ?? []).map((a) => `${ind}${ind}${ind}${ind}<rdf:li xml:lang="${escapeAttr(a.lang)}">${t(a.value)}</rdf:li>`);
      body.push(`${ind}${ind}<${q}>\n${ind}${ind}${ind}<rdf:Alt>\n${lis.join('\n')}\n${ind}${ind}${ind}</rdf:Alt>\n${ind}${ind}</${q}>`);
    } else {
      const tag = prop.kind === 'bag' ? 'rdf:Bag' : 'rdf:Seq';
      const lis = (prop.items ?? []).map((v) => `${ind}${ind}${ind}${ind}<rdf:li>${t(v)}</rdf:li>`);
      body.push(`${ind}${ind}<${q}>\n${ind}${ind}${ind}<${tag}>\n${lis.join('\n')}\n${ind}${ind}${ind}</${tag}>\n${ind}${ind}</${q}>`);
    }
  }
  const decls = [...used].map(([pf, ns]) => `\n${ind}${ind}${ind}xmlns:${pf}="${escapeAttr(ns)}"`).join('');
  const tk = p.toolkit ? ` x:xmptk="${escapeAttr(p.toolkit)}"` : '';
  const inner =
    `<x:xmpmeta xmlns:x="${XMLNS_X}"${tk}>\n` +
    `${ind}<rdf:RDF xmlns:rdf="${RDF}">\n` +
    `${ind}${ind}<rdf:Description rdf:about=""${decls}>\n` +
    `${body.join('\n')}${body.length ? '\n' : ''}` +
    `${ind}${ind}</rdf:Description>\n` +
    `${ind}</rdf:RDF>\n` +
    `</x:xmpmeta>`;
  if (opts.wrapper === false) return inner;
  const padLen = opts.padding ?? 2048;
  let pad = '';
  for (let i = 0; i < padLen; i += 100) pad += `${' '.repeat(99)}\n`;
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n${inner}\n${pad}<?xpacket end="w"?>`;
}

// ----------------------------------------------------------------- fields

export interface XmpGroupOptions {
  prefix?: string;
  source?: string;
  addable?: boolean;
  /** collapse every namespace into one group (used for small packets) */
  single?: boolean;
}

const fid = (prefix: string, ns: string, name: string) => `${prefix}:${ns}|${name}`;

function parseFid(id: string, prefix: string): { ns: string; name: string } | null {
  if (!id.startsWith(`${prefix}:`)) return null;
  const rest = id.slice(prefix.length + 1);
  const bar = rest.lastIndexOf('|');
  if (bar < 0) return null;
  return { ns: rest.slice(0, bar), name: rest.slice(bar + 1) };
}

function summarizeXml(xml: string): string {
  try {
    const doc = parseXml(xml);
    const parts: string[] = [];
    const walk = (el: XElement) => {
      for (const a of el.attrs) {
        if (a.name.startsWith('xmlns') || a.name.startsWith('rdf:') || a.name.startsWith('xml:')) continue;
        if (a.value.trim()) parts.push(`${localName(a.name)}: ${a.value.trim()}`);
      }
      const kids = elements(el);
      if (!kids.length) {
        const t = textContent(el).trim();
        if (t && el !== doc.root) parts.push(`${localName(el.name)}: ${t}`);
      }
      for (const k of kids) walk(k);
    };
    walk(doc.root);
    const s = parts.join(' · ');
    return s.length > 300 ? `${s.slice(0, 300)}…` : s || '(structure)';
  } catch {
    return '(structure)';
  }
}

function propField(prefix: string, prop: XmpProp): Field {
  const key = `${NS_TO_PREFIX.get(prop.ns) ?? prop.prefix}:${prop.name}`;
  const known = KNOWN[key];
  const label = known?.label ?? prop.name.replace(/([a-z])([A-Z])/g, '$1 $2');
  const sens = known?.sens ?? guessSensitivity(NS_TO_PREFIX.get(prop.ns) ?? prop.prefix, prop.name);
  const id = fid(prefix, prop.ns, prop.name);
  const base: FieldSpec = { id, label, kind: 'text', sensitivity: sens, tag: key };
  switch (prop.kind) {
    case 'simple': {
      const v = prop.value ?? '';
      if (known?.ui === 'datetime') {
        const p = parseDate(v);
        if (p) return makeField({ ...base, kind: 'datetime' }, toIso(p), { display: displayDate(toIso(p)) });
      }
      if (known?.ui === 'integer' && /^-?\d+$/.test(v.trim())) return makeField({ ...base, kind: 'integer' }, +v);
      return makeField({ ...base, kind: known?.ui === 'multiline' || v.length > 80 ? 'multiline' : 'text' }, v);
    }
    case 'alt': {
      const alt = prop.alt ?? [];
      const def = alt.find((a) => a.lang === 'x-default') ?? alt[0];
      const others = alt.filter((a) => a !== def);
      const display = others.length ? `${def?.value ?? ''}  (+${others.length} translation${others.length > 1 ? 's' : ''})` : undefined;
      return makeField({ ...base, kind: known?.ui === 'multiline' ? 'multiline' : 'text' }, def?.value ?? '', { display });
    }
    case 'bag':
    case 'seq':
      return makeField({ ...base, kind: 'list' }, prop.items ?? []);
    default:
      return rawField(id, label, summarizeXml(prop.xml ?? ''), { sensitivity: sens, tag: key });
  }
}

export function xmpGroups(p: XmpPacket, opts: XmpGroupOptions = {}): FieldGroup[] {
  const prefix = opts.prefix ?? 'xmp';
  const source = opts.source ?? 'XMP';
  const byNs = new Map<string, Field[]>();
  for (const prop of p.props) {
    const k = opts.single ? '*' : prop.ns;
    if (!byNs.has(k)) byNs.set(k, []);
    byNs.get(k)!.push(propField(prefix, prop));
  }
  const groups: FieldGroup[] = [];
  const present = new Set(p.props.map((x) => `${x.ns}|${x.name}`));
  const addable: FieldSpec[] = [];
  if (opts.addable) {
    for (const [key, k] of Object.entries(KNOWN)) {
      if (!k.addable) continue;
      const [pf, name] = key.split(':');
      const ns = NS[pf];
      if (present.has(`${ns}|${name}`)) continue;
      const kind: FieldKind = k.kind === 'bag' || k.kind === 'seq' ? 'list' : (k.ui ?? 'text');
      addable.push({ id: fid(prefix, ns, name), label: k.label, kind, sensitivity: k.sens, tag: key });
    }
  }
  const order = (ns: string) => {
    const pf = NS_TO_PREFIX.get(ns);
    const idx = pf ? Object.keys(NS_LABEL).indexOf(pf) : -1;
    return idx < 0 ? 999 : idx;
  };
  const keys = [...byNs.keys()].sort((a, b) => order(a) - order(b));
  if (opts.single || keys.length <= 1) {
    const fields = keys.flatMap((k) => byNs.get(k)!);
    groups.push({ id: prefix, label: 'XMP', source, fields, addable: addable.length ? addable : undefined, removable: true });
    return groups;
  }
  for (const ns of keys) {
    const pf = NS_TO_PREFIX.get(ns);
    const label = pf ? (NS_LABEL[pf] ?? pf) : (p.props.find((x) => x.ns === ns)?.prefix ?? ns);
    groups.push({ id: `${prefix}.${pf ?? ns}`, label, source, fields: byNs.get(ns)! });
  }
  // Attach "add" templates to the Dublin Core group (or the first group).
  const host = groups.find((g) => g.id === `${prefix}.dc`) ?? groups[0];
  if (addable.length) host.addable = addable;
  return groups;
}

/** Returns true if anything changed. */
export function applyXmpEdits(p: XmpPacket, edits: Edits, prefix = 'xmp'): boolean {
  let changed = false;
  for (const [id, edit] of edits) {
    const key = parseFid(id, prefix);
    if (!key) continue;
    const idx = p.props.findIndex((x) => x.ns === key.ns && x.name === key.name);
    if (edit.op === 'remove') {
      if (idx >= 0) {
        p.props.splice(idx, 1);
        changed = true;
      }
      continue;
    }
    const pf = NS_TO_PREFIX.get(key.ns);
    const known = pf ? KNOWN[`${pf}:${key.name}`] : undefined;
    const existing = idx >= 0 ? p.props[idx] : undefined;
    const kind: XmpKind = existing?.kind ?? known?.kind ?? (Array.isArray(edit.value) ? 'bag' : 'simple');
    if (kind === 'complex') throw new MetadataError(`${key.name} is a structure and cannot be edited directly`);
    const prop: XmpProp = { ns: key.ns, name: key.name, prefix: existing?.prefix ?? pf ?? 'ns', kind };
    if (kind === 'simple') {
      if (known?.ui === 'datetime') prop.value = toIso(requireDate(edit.value, known.label));
      else if (known?.ui === 'integer') prop.value = String(asInteger(edit.value, known.label));
      else prop.value = asText(edit.value, key.name);
    } else if (kind === 'alt') {
      const v = asText(edit.value, key.name);
      const alt = existing?.alt ? [...existing.alt] : [];
      const di = alt.findIndex((a) => a.lang === 'x-default');
      if (di >= 0) alt[di] = { lang: 'x-default', value: v };
      else if (alt.length === 1) alt[0] = { lang: alt[0].lang, value: v };
      else alt.unshift({ lang: 'x-default', value: v });
      prop.alt = alt;
    } else {
      prop.items = asList(edit.value);
    }
    if (idx >= 0) p.props[idx] = prop;
    else p.props.push(prop);
    changed = true;
  }
  return changed;
}

/** Convenience: read a simple/alt/first-item value by canonical "prefix:name". */
export function xmpValue(p: XmpPacket, key: string): string | undefined {
  const [pf, name] = key.split(':');
  const prop = p.props.find((x) => x.ns === NS[pf] && x.name === name);
  if (!prop) return undefined;
  if (prop.kind === 'simple') return prop.value;
  if (prop.kind === 'alt') return (prop.alt?.find((a) => a.lang === 'x-default') ?? prop.alt?.[0])?.value;
  if (prop.kind === 'bag' || prop.kind === 'seq') return prop.items?.join('; ');
  return undefined;
}

export function xmpFieldId(key: string, prefix = 'xmp'): string {
  const [pf, name] = key.split(':');
  return fid(prefix, NS[pf], name);
}
