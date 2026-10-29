/**
 * OpenDocument packages (odt/ods/odp/odg/odf/odc/odm and templates): meta.xml
 * properties and user-defined properties, the package thumbnail, printer
 * settings, editing-session ids and annotation / tracked-change authors, the
 * version history (VersionList.xml + full earlier copies under Versions/),
 * meta.xml of embedded objects ("Object N/") and pictures (docmedia.ts).
 *
 * `mimetype` stays the first, STORED entry (rewriteZip keeps entry order and
 * copies untouched entries raw); META-INF/manifest.xml is kept in sync when
 * parts are added or removed.
 */

import { formatBytes } from '../core/binary';
import {
  asInteger,
  asList,
  asNumber,
  asText,
  describeImage,
  displayDate,
  imageValue,
  makeField,
  parseDate,
  rawField,
  requireDate,
  toIso,
} from '../core/fields';
import {
  MetadataError,
  groupKey,
  type DetectContext,
  type Edits,
  type Field,
  type FieldGroup,
  type FieldKind,
  type FieldSpec,
  type FieldValue,
  type FormatHandler,
  type InfoItem,
  type Metadata,
  type Sensitivity,
  type Source,
  type StripOptions,
} from '../core/types';
import {
  appendChild,
  appendIndented,
  attrNs,
  createElement,
  descendants,
  elements,
  getAttrNs,
  is,
  localName,
  nsOf,
  removeNode,
  setText,
  textContent,
  type XElement,
} from '../core/xml';
import { ZipArchive, rewriteZip } from '../core/zip';
import { applyMediaEdits, cleanMedia, mediaGroup, type MediaSpec } from './docmedia';
import { XmlParts, ZIP_EPOCH, ensurePrefix, firstStoredEntry, isNamed, newXmlDoc, nsElement, qname } from './docparts';

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  dc: 'http://purl.org/dc/elements/1.1/',
  xlink: 'http://www.w3.org/1999/xlink',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
  config: 'urn:oasis:names:tc:opendocument:xmlns:config:1.0',
  officeooo: 'http://openoffice.org/2009/office',
  loext: 'urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0',
  vl: 'http://openoffice.org/2001/versions-list',
} as const;

const TYPES: Record<string, string> = {
  text: 'OpenDocument text',
  'text-template': 'OpenDocument text template',
  'text-master': 'OpenDocument master document',
  'text-master-template': 'OpenDocument master document template',
  spreadsheet: 'OpenDocument spreadsheet',
  'spreadsheet-template': 'OpenDocument spreadsheet template',
  presentation: 'OpenDocument presentation',
  'presentation-template': 'OpenDocument presentation template',
  graphics: 'OpenDocument drawing',
  'graphics-template': 'OpenDocument drawing template',
  formula: 'OpenDocument formula',
  'formula-template': 'OpenDocument formula template',
  chart: 'OpenDocument chart',
  'chart-template': 'OpenDocument chart template',
  image: 'OpenDocument image',
};

const MIME_PREFIX = 'application/vnd.oasis.opendocument.';
const META_PART = 'meta.xml';
const THUMB = 'Thumbnails/thumbnail.png';
const USER_NEW = 'odf:user-new';
const SIGNATURES = ['META-INF/documentsignatures.xml', 'META-INF/macrosignatures.xml'];
const NEUTRAL_DATE = '1970-01-01T00:00:00';
const VERSION_LIST = 'VersionList.xml';
const MEDIA: MediaSpec = { group: 'odf.media', prefix: 'odf:media:', source: 'ODF' };

interface MetaDef {
  prefix: 'meta' | 'dc';
  local: string;
  label: string;
  kind: FieldKind;
  sens?: Sensitivity;
  addable?: boolean;
}

const META: MetaDef[] = [
  { prefix: 'dc', local: 'title', label: 'Title', kind: 'text', sens: 'content', addable: true },
  { prefix: 'dc', local: 'subject', label: 'Subject', kind: 'text', sens: 'content', addable: true },
  { prefix: 'dc', local: 'description', label: 'Description', kind: 'multiline', sens: 'content', addable: true },
  { prefix: 'meta', local: 'keyword', label: 'Keywords', kind: 'list', sens: 'content', addable: true },
  { prefix: 'meta', local: 'initial-creator', label: 'Author', kind: 'text', sens: 'identity', addable: true },
  { prefix: 'dc', local: 'creator', label: 'Last modified by', kind: 'text', sens: 'identity', addable: true },
  { prefix: 'meta', local: 'printed-by', label: 'Printed by', kind: 'text', sens: 'identity' },
  { prefix: 'meta', local: 'creation-date', label: 'Created', kind: 'datetime', sens: 'time', addable: true },
  { prefix: 'dc', local: 'date', label: 'Modified', kind: 'datetime', sens: 'time', addable: true },
  { prefix: 'meta', local: 'print-date', label: 'Last printed', kind: 'datetime', sens: 'time' },
  { prefix: 'dc', local: 'language', label: 'Language', kind: 'text', addable: true },
  { prefix: 'meta', local: 'generator', label: 'Generator', kind: 'text', sens: 'software' },
  { prefix: 'meta', local: 'editing-cycles', label: 'Revision', kind: 'integer', sens: 'software' },
  { prefix: 'meta', local: 'editing-duration', label: 'Total editing time', kind: 'text', sens: 'software' },
];

const metaId = (prefix: string, local: string) => `odf:${prefix}:${local}`;
const nsFor = (prefix: 'meta' | 'dc') => (prefix === 'meta' ? NS.meta : NS.dc);
const defOf = (el: XElement) =>
  META.find((d) => localName(el.name) === d.local && nsOf(el) === nsFor(d.prefix));

const DURATION_RE = /^-?P(?=\d|T\d)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** "PT1H2M3S" -> "1 h 2 min 3 s" */
function displayDuration(s: string): string | undefined {
  const m = DURATION_RE.exec(s.trim());
  if (!m) return undefined;
  const parts: string[] = [];
  const days = +(m[1] ?? 0) * 365 + +(m[2] ?? 0) * 30 + +(m[3] ?? 0);
  if (days) parts.push(`${days} d`);
  if (m[4]) parts.push(`${+m[4]} h`);
  if (m[5]) parts.push(`${+m[5]} min`);
  if (m[6]) parts.push(`${Math.round(+m[6])} s`);
  return parts.join(' ') || '0 s';
}

// ----------------------------------------------------------------- package

interface Odf {
  zip: ZipArchive;
  parts: XmlParts;
  mimetype: string;
}

async function openOdf(src: Source): Promise<Odf> {
  const zip = await ZipArchive.open(src);
  const mimetype = zip.has('mimetype') ? (await zip.readText('mimetype')).trim() : '';
  if (!mimetype.startsWith(MIME_PREFIX)) throw new MetadataError('Not an OpenDocument file (mimetype entry missing)');
  const parts = new XmlParts(zip);
  const manifest = await parts.tryGet('META-INF/manifest.xml');
  if (manifest && descendants(manifest.root, NS.manifest, 'encryption-data').length) {
    throw new MetadataError('This document is password protected. Remove the password in your office app first, then try again.');
  }
  return { zip, parts, mimetype };
}

async function manifestRemove(o: Odf, paths: string[]): Promise<void> {
  const doc = await o.parts.tryGet('META-INF/manifest.xml');
  if (!doc) return;
  let changed = false;
  for (const e of elements(doc.root)) {
    const p = getAttrNs(e, NS.manifest, 'full-path');
    if (p && paths.includes(p)) {
      removeNode(e);
      changed = true;
    }
  }
  if (changed) o.parts.touch('META-INF/manifest.xml');
}

async function manifestAdd(o: Odf, path: string, type: string): Promise<void> {
  const doc = await o.parts.tryGet('META-INF/manifest.xml');
  if (!doc || elements(doc.root).some((e) => getAttrNs(e, NS.manifest, 'full-path') === path)) return;
  const entry = nsElement(doc.root, doc.root, NS.manifest, 'manifest', 'file-entry');
  const p = ensurePrefix(doc.root, doc.root, NS.manifest, 'manifest');
  entry.attrs.push({ name: `${p}:full-path`, value: path }, { name: `${p}:media-type`, value: type });
  appendIndented(doc.root, entry);
  o.parts.touch('META-INF/manifest.xml');
}

async function removeEntry(o: Odf, path: string, manifestPaths: string[] = [path]): Promise<void> {
  o.parts.remove(path);
  await manifestRemove(o, manifestPaths);
}

/** The office:meta element (created with meta.xml when `create`). */
async function metaElement(o: Odf, create: boolean): Promise<XElement | null> {
  const doc = await o.parts.get(META_PART);
  if (doc) {
    const meta = elements(doc.root).find((e) => is(e, NS.office, 'meta'));
    if (meta) return meta;
    if (!create) return null;
    const el = nsElement(doc.root, doc.root, NS.office, 'office', 'meta');
    appendChild(doc.root, el);
    return el;
  }
  if (!create) return null;
  const root = createElement('office:document-meta', {
    'xmlns:office': NS.office,
    'xmlns:meta': NS.meta,
    'xmlns:dc': NS.dc,
    'xmlns:xlink': NS.xlink,
    'office:version': '1.2',
  });
  const meta = createElement('office:meta');
  appendChild(root, meta);
  o.parts.put(META_PART, newXmlDoc(root));
  await manifestAdd(o, META_PART, 'text/xml');
  return meta;
}

// -------------------------------------------------------------------- meta

function metaGroup(meta: XElement | null, info: InfoItem[]): { main: FieldGroup; user: FieldGroup; extra: Field[] } {
  const fields: Field[] = [];
  const userFields: Field[] = [];
  const extra: Field[] = [];
  const present = new Set<string>();
  const kids = meta ? elements(meta) : [];
  for (const def of META) {
    const els = kids.filter((e) => defOf(e) === def);
    if (!els.length) continue;
    const id = metaId(def.prefix, def.local);
    present.add(id);
    const spec: FieldSpec = { id, label: def.label, kind: def.kind, sensitivity: def.sens, tag: `${def.prefix}:${def.local}` };
    const text = textContent(els[0]).trim();
    if (def.kind === 'list') fields.push(makeField(spec, els.map((e) => textContent(e).trim()).filter(Boolean)));
    else if (def.kind === 'datetime') {
      const p = parseDate(text);
      fields.push(p ? makeField(spec, toIso(p), { display: displayDate(toIso(p)) }) : makeField({ ...spec, kind: 'text' }, text));
    } else if (def.kind === 'integer' && /^\d+$/.test(text)) fields.push(makeField(spec, +text));
    else if (def.local === 'editing-duration') fields.push(makeField(spec, text, { display: displayDuration(text) }));
    else fields.push(makeField({ ...spec, kind: def.kind === 'integer' ? 'text' : def.kind }, text));
  }
  for (const el of kids) {
    if (isNamed(el, NS.meta, 'template')) {
      const title = getAttrNs(el, NS.xlink, 'title');
      const href = getAttrNs(el, NS.xlink, 'href') ?? '';
      extra.push(
        rawField('odf:meta:template', 'Template', title ? `${title} — ${href}` : href, {
          sensitivity: 'identity',
          tag: 'meta:template',
          description: 'The template the document was created from; local paths often contain the user name.',
        }),
      );
    } else if (isNamed(el, NS.meta, 'user-defined')) {
      userFields.push(userField(el));
    } else if (isNamed(el, NS.meta, 'document-statistic')) {
      for (const a of el.attrs) {
        if (attrNs(el, a) !== NS.meta) continue;
        const label = localName(a.name).replace(/-count$/, '').replace(/-/g, ' ');
        info.push({ label: `${label[0].toUpperCase()}${label.slice(1)}s`, value: a.value });
      }
    }
  }
  const addable = META.filter((d) => d.addable && !present.has(metaId(d.prefix, d.local))).map(
    (d): FieldSpec => ({ id: metaId(d.prefix, d.local), label: d.label, kind: d.kind, sensitivity: d.sens, tag: `${d.prefix}:${d.local}` }),
  );
  return {
    main: { id: 'odf.meta', label: 'Document properties', source: 'ODF meta', fields, addable, removable: true },
    user: {
      id: 'odf.user',
      label: 'Custom properties',
      source: 'ODF meta',
      fields: userFields,
      removable: true,
      addable: [
        {
          id: USER_NEW,
          label: 'Custom property',
          kind: 'text',
          placeholder: 'Name=Value',
          description: 'Adds a text property (File › Properties › Custom Properties).',
        },
      ],
    },
    extra,
  };
}

function userSensitivity(name: string): Sensitivity {
  if (/author|owner|client|customer|company|manager|name|user|mail|person|phone/i.test(name)) return 'identity';
  if (/date|time|due/i.test(name)) return 'time';
  return 'content';
}

function userField(el: XElement): Field {
  const name = getAttrNs(el, NS.meta, 'name') ?? '';
  const type = getAttrNs(el, NS.meta, 'value-type') ?? 'string';
  const text = textContent(el);
  const spec: FieldSpec = { id: `odf:user:${name}`, label: name, kind: 'text', sensitivity: userSensitivity(name), tag: `meta:user-defined (${type})` };
  if ((type === 'float' || type === 'percentage') && Number.isFinite(Number(text))) return makeField({ ...spec, kind: 'number' }, Number(text));
  if (type === 'boolean') {
    return makeField({ ...spec, kind: 'enum', options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] }, text.trim() === 'true' ? 'true' : 'false');
  }
  if (type === 'date') {
    const p = parseDate(text.trim());
    if (p) return makeField({ ...spec, kind: 'datetime' }, toIso(p), { display: displayDate(toIso(p)) });
  }
  if (type === 'time') return makeField(spec, text, { display: displayDuration(text) });
  return makeField(spec, text);
}

function userValue(type: string, v: FieldValue, label: string): string {
  if (type === 'float' || type === 'percentage') return String(asNumber(v, label));
  if (type === 'boolean') {
    const t = asText(v, label).trim().toLowerCase();
    if (/^(1|true|yes)$/.test(t)) return 'true';
    if (/^(0|false|no)$/.test(t)) return 'false';
    throw new MetadataError(`${label}: expected true or false`);
  }
  if (type === 'date') return toIso(requireDate(v, label));
  if (type === 'time') {
    const s = asText(v, label).trim();
    if (!DURATION_RE.test(s)) throw new MetadataError(`${label}: use an ISO 8601 duration such as PT1H30M`);
    return s;
  }
  return asText(v, label);
}

/** Insert a new meta child before meta:document-statistic / user-defined entries (schema order is free, this keeps it tidy). */
function insertMeta(meta: XElement, el: XElement): void {
  const anchor = elements(meta).find((e) => is(e, NS.meta, 'user-defined') || is(e, NS.meta, 'document-statistic'));
  el.parent = meta;
  if (anchor) meta.children.splice(meta.children.indexOf(anchor), 0, el);
  else appendChild(meta, el);
}

async function applyMetaEdits(o: Odf, edits: Edits): Promise<void> {
  const mine = [...edits].filter(([k]) => /^odf:(meta|dc):/.test(k) || k.startsWith('odf:user:') || k === USER_NEW);
  const clearMain = edits.get(groupKey('odf.meta'))?.op === 'remove';
  const clearUser = edits.get(groupKey('odf.user'))?.op === 'remove';
  if (!mine.length && !clearMain && !clearUser) return;
  const meta = await metaElement(o, mine.some(([, e]) => e.op === 'set'));
  if (!meta) return;
  const root = (await o.parts.get(META_PART))!.root;
  if (clearMain) for (const el of elements(meta)) if (defOf(el) || is(el, NS.meta, 'template')) removeNode(el);
  if (clearUser) for (const el of elements(meta)) if (is(el, NS.meta, 'user-defined')) removeNode(el);

  for (const [id, e] of mine) {
    if (id === 'odf:meta:template') {
      if (e.op === 'remove') for (const el of elements(meta)) if (is(el, NS.meta, 'template')) removeNode(el);
      continue;
    }
    if (id.startsWith('odf:user:') || id === USER_NEW) {
      let name: string;
      let value: FieldValue = null;
      if (id === USER_NEW) {
        if (e.op !== 'set') continue;
        const s = asText(e.value, 'Custom property');
        const eq = s.indexOf('=');
        name = (eq < 0 ? '' : s.slice(0, eq)).trim();
        if (!name) throw new MetadataError('Custom property: use the form Name=Value');
        value = s.slice(eq + 1).trim();
      } else {
        name = id.slice('odf:user:'.length);
        if (e.op === 'set') value = e.value;
      }
      const cur = elements(meta).find((el) => is(el, NS.meta, 'user-defined') && getAttrNs(el, NS.meta, 'name') === name);
      if (e.op === 'remove') {
        if (cur) removeNode(cur);
        continue;
      }
      if (cur) {
        setText(cur, userValue(getAttrNs(cur, NS.meta, 'value-type') ?? 'string', value, name));
        continue;
      }
      const el = nsElement(root, meta, NS.meta, 'meta', 'user-defined');
      const p = ensurePrefix(root, meta, NS.meta, 'meta');
      el.attrs.push({ name: `${p}:name`, value: name });
      if (typeof value === 'number') el.attrs.push({ name: `${p}:value-type`, value: 'float' });
      setText(el, typeof value === 'number' ? String(value) : asText(value, name));
      const stat = elements(meta).find((x) => is(x, NS.meta, 'document-statistic'));
      el.parent = meta;
      if (stat) meta.children.splice(meta.children.indexOf(stat), 0, el);
      else appendChild(meta, el);
      continue;
    }
    const [prefix, local] = id.slice(4).split(':') as ['meta' | 'dc', string];
    const def = META.find((d) => d.prefix === prefix && d.local === local);
    if (!def) continue;
    const existing = elements(meta).filter((el) => defOf(el) === def);
    if (e.op === 'remove') {
      for (const el of existing) removeNode(el);
      continue;
    }
    let values: string[];
    if (def.kind === 'list') values = asList(e.value);
    else if (def.kind === 'datetime') values = [toIso(requireDate(e.value, def.label))];
    else if (def.kind === 'integer') values = [String(asInteger(e.value, def.label))];
    else if (def.local === 'editing-duration') {
      const s = asText(e.value, def.label).trim();
      if (!DURATION_RE.test(s)) throw new MetadataError(`${def.label}: use an ISO 8601 duration such as PT1H30M`);
      values = [s];
    } else values = [asText(e.value, def.label)];
    // Reuse existing elements in place, add/remove the difference.
    values.forEach((v, i) => {
      let el = existing[i];
      if (!el) {
        el = createElement(qname(root, meta, nsFor(def.prefix), def.prefix, def.local));
        const after = existing[existing.length - 1];
        if (after && after.parent === meta) {
          el.parent = meta;
          meta.children.splice(meta.children.indexOf(after) + 1 + i - existing.length, 0, el);
        } else insertMeta(meta, el);
      }
      setText(el, v);
    });
    for (const el of existing.slice(values.length)) removeNode(el);
  }
  o.parts.touch(META_PART);
}

// --------------------------------------------------------------- hidden

interface HiddenScan {
  authors: Map<string, number>;
  annotations: number;
  changes: number;
  rsids: number;
  printer?: string;
}

type HiddenKind = 'authors' | 'rsid' | 'printer';

const CONTENT_PARTS = ['content.xml', 'styles.xml'];

function walkAuthors(el: XElement, scan: HiddenScan, apply: Set<HiddenKind>): boolean {
  let changed = false;
  const annotation = is(el, NS.office, 'annotation');
  const change = is(el, NS.office, 'change-info');
  if (annotation || change) {
    if (annotation) scan.annotations++;
    else scan.changes++;
    for (const c of elements(el)) {
      if (is(c, NS.dc, 'creator')) {
        const name = textContent(c).trim();
        if (name) scan.authors.set(name, (scan.authors.get(name) ?? 0) + 1);
      }
      if (!apply.has('authors')) continue;
      const initials = is(c, NS.meta, 'creator-initials') || is(c, NS.loext, 'sender-initials');
      if (is(c, NS.dc, 'creator') || initials || (annotation && is(c, NS.dc, 'date'))) {
        removeNode(c);
        changed = true;
      } else if (change && is(c, NS.dc, 'date') && textContent(c) !== NEUTRAL_DATE) {
        setText(c, NEUTRAL_DATE);
        changed = true;
      }
    }
  }
  const before = el.attrs.length;
  el.attrs = el.attrs.filter((a) => {
    if (attrNs(el, a) !== NS.officeooo || !/rsid$/.test(localName(a.name))) return true;
    scan.rsids++;
    return !apply.has('rsid');
  });
  if (el.attrs.length !== before) changed = true;
  for (const c of el.children) if (c.type === 'element' && walkAuthors(c, scan, apply)) changed = true;
  return changed;
}

async function processHidden(o: Odf, apply: Set<HiddenKind>): Promise<HiddenScan> {
  const scan: HiddenScan = { authors: new Map(), annotations: 0, changes: 0, rsids: 0 };
  for (const part of CONTENT_PARTS) {
    const doc = await o.parts.tryGet(part);
    if (doc && walkAuthors(doc.root, scan, apply)) o.parts.touch(part);
  }
  const settings = await o.parts.tryGet('settings.xml');
  if (settings) {
    let changed = false;
    for (const item of descendants(settings.root, NS.config, 'config-item')) {
      const name = getAttrNs(item, NS.config, 'name');
      if (name === 'PrinterName' || name === 'PrinterSetup') {
        if (name === 'PrinterName' && textContent(item).trim()) scan.printer = textContent(item).trim();
        else scan.printer ??= textContent(item).trim() ? 'printer setup data' : undefined;
        if (apply.has('printer')) {
          removeNode(item);
          changed = true;
        }
      } else if (name === 'Rsid' || name === 'RsidRoot') {
        scan.rsids++;
        if (apply.has('rsid')) {
          removeNode(item);
          changed = true;
        }
      }
    }
    if (changed) o.parts.touch('settings.xml');
  }
  return scan;
}

function hiddenFields(scan: HiddenScan): Field[] {
  const fields: Field[] = [];
  if (scan.authors.size) {
    const counts: string[] = [];
    if (scan.annotations) counts.push(`${scan.annotations} comment${scan.annotations > 1 ? 's' : ''}`);
    if (scan.changes) counts.push(`${scan.changes} tracked change${scan.changes > 1 ? 's' : ''}`);
    fields.push(
      rawField('odf:hidden:authors', 'Comment & revision authors', `${[...scan.authors.keys()].join(', ')} — ${counts.join(', ')}`, {
        sensitivity: 'identity',
        tag: 'office:annotation / office:change-info',
        description: 'Names and dates stored with comments and tracked changes. Removing deletes the names and dates.',
      }),
    );
  }
  if (scan.rsids) {
    fields.push(
      rawField('odf:hidden:rsid', 'Editing session IDs', `${scan.rsids} rsid value${scan.rsids > 1 ? 's' : ''}`, {
        sensitivity: 'software',
        tag: 'officeooo:rsid',
        description: 'Random ids LibreOffice adds per editing session.',
      }),
    );
  }
  if (scan.printer) {
    fields.push(rawField('odf:hidden:printer', 'Printer', scan.printer, { sensitivity: 'device', tag: 'settings.xml PrinterName', description: 'The printer last used, with its driver settings.' }));
  }
  return fields;
}

// ------------------------------------------------ versions and objects

/** Kept by strip: statistics and reload / link behaviour, which drive display. */
const keptMeta = (el: XElement) => is(el, NS.meta, 'document-statistic') || is(el, NS.meta, 'auto-reload') || is(el, NS.meta, 'hyperlink-behaviour');

function scrubMeta(meta: XElement): boolean {
  let changed = false;
  for (const el of elements(meta)) {
    if (keptMeta(el)) continue;
    removeNode(el);
    changed = true;
  }
  return changed;
}

/** The version history: VersionList.xml and the full earlier copies stored under Versions/. */
function versionEntries(o: Odf): string[] {
  return o.zip.entries.map((e) => e.name).filter((n) => (n === VERSION_LIST || n.startsWith('Versions/')) && o.parts.has(n));
}

const dateText = (s: string) => {
  const p = parseDate(s.trim());
  return p ? displayDate(toIso(p)) : s.trim();
};

async function versionsField(o: Odf): Promise<Field | null> {
  const entries = versionEntries(o);
  const list = entries.includes(VERSION_LIST) ? await o.parts.tryGet(VERSION_LIST) : null;
  const versions = list ? descendants(list.root, NS.vl, 'version-entry') : [];
  const copies = entries.filter((n) => n.startsWith('Versions/') && !n.endsWith('/'));
  if (!versions.length && !copies.length) return null;
  const creators = new Set<string>();
  const comments: string[] = [];
  const dates: string[] = [];
  for (const v of versions) {
    const who = (getAttrNs(v, NS.vl, 'creator') ?? getAttrNs(v, NS.dc, 'creator'))?.trim();
    if (who) creators.add(who);
    const comment = getAttrNs(v, NS.vl, 'comment')?.trim();
    if (comment) comments.push(comment);
    const date = getAttrNs(v, NS.dc, 'date');
    if (date) dates.push(date);
  }
  const n = Math.max(versions.length, copies.length);
  const size = copies.reduce((sum, c) => sum + (o.zip.get(c)?.size ?? 0), 0);
  const bits = [`${n} earlier version${n > 1 ? 's' : ''}${copies.length ? ` (${formatBytes(size)})` : ''}`];
  if (creators.size) bits.push(`saved by ${[...creators].join(', ')}`);
  if (dates.length) {
    dates.sort();
    bits.push(dates.length > 1 ? `${dateText(dates[0])} – ${dateText(dates[dates.length - 1])}` : dateText(dates[0]));
  }
  if (comments.length) bits.push(comments.map((c) => `“${c}”`).join(', '));
  return rawField('odf:versions', 'Version history', bits.join(' · '), {
    sensitivity: creators.size ? 'identity' : 'content',
    tag: 'VersionList.xml, Versions/',
    description: 'Earlier versions saved inside the file (File › Versions): complete copies of the document, each with who saved it and when.',
  });
}

async function removeVersions(o: Odf): Promise<void> {
  const entries = versionEntries(o);
  for (const n of entries) o.parts.remove(n);
  await manifestRemove(o, [...entries, 'Versions/']);
}

/** meta.xml parts of embedded objects (charts, formulas…: "Object 1/meta.xml"). */
function objectMetaParts(o: Odf): string[] {
  return o.zip.entries.map((e) => e.name).filter((n) => /\/meta\.xml$/.test(n) && !n.startsWith('Versions/') && o.parts.has(n));
}

async function objectMetas(o: Odf): Promise<Array<{ part: string; meta: XElement }>> {
  const out: Array<{ part: string; meta: XElement }> = [];
  for (const part of objectMetaParts(o)) {
    const doc = await o.parts.tryGet(part);
    const meta = doc ? elements(doc.root).find((e) => is(e, NS.office, 'meta')) : undefined;
    if (meta) out.push({ part, meta });
  }
  return out;
}

/** Highest risk first. */
const RANK: Sensitivity[] = ['location', 'identity', 'device', 'time', 'software', 'content'];

function objectMetaField(objects: Array<{ part: string; meta: XElement }>): Field | null {
  const lines: string[] = [];
  let worst = RANK.length - 1;
  for (const { part, meta } of objects) {
    const labels = new Set<string>();
    for (const el of elements(meta)) {
      if (keptMeta(el)) continue;
      const def = defOf(el);
      const user = isNamed(el, NS.meta, 'user-defined');
      const template = isNamed(el, NS.meta, 'template');
      labels.add(def?.label ?? (user ? 'Custom properties' : template ? 'Template' : localName(el.name)));
      const sens = def?.sens ?? (user ? userSensitivity(getAttrNs(el, NS.meta, 'name') ?? '') : template ? 'identity' : 'content');
      worst = Math.min(worst, RANK.indexOf(sens));
    }
    if (labels.size) lines.push(`${part.slice(0, -'/meta.xml'.length)}: ${[...labels].join(', ')}`);
  }
  if (!lines.length) return null;
  return rawField('odf:objects:meta', 'Embedded object properties', lines.join(' · '), {
    sensitivity: RANK[worst],
    tag: 'Object N/meta.xml',
    description: 'Properties stored with charts, formulas and other embedded objects (author, dates, generator).',
  });
}

/** Clean every embedded object's meta.xml like the main one; unreadable ones are dropped (they are optional). */
async function stripObjectMetas(o: Odf): Promise<void> {
  for (const part of objectMetaParts(o)) {
    const doc = await o.parts.tryGet(part);
    if (!doc) {
      await removeEntry(o, part);
      continue;
    }
    const meta = elements(doc.root).find((e) => is(e, NS.office, 'meta'));
    if (meta && scrubMeta(meta)) o.parts.touch(part);
  }
}

/** Pictures: manifest entries of an image type and anything in a Pictures folder (the thumbnail is listed on its own). */
async function mediaPaths(o: Odf): Promise<string[]> {
  const out = new Set<string>();
  const manifest = await o.parts.tryGet('META-INF/manifest.xml');
  for (const e of manifest ? elements(manifest.root) : []) {
    const path = getAttrNs(e, NS.manifest, 'full-path');
    if (path && /^image\//i.test(getAttrNs(e, NS.manifest, 'media-type') ?? '')) out.add(path);
  }
  for (const e of o.zip.entries) if (/(^|\/)Pictures\/[^/]/.test(e.name)) out.add(e.name);
  out.delete(THUMB);
  return [...out];
}

// ------------------------------------------------------------------- API

export async function readOdf(src: Source): Promise<Metadata> {
  const o = await openOdf(src);
  const warnings: string[] = [];
  const kind = o.mimetype.slice(MIME_PREFIX.length);
  const name = TYPES[kind] ?? 'OpenDocument file';
  const info: InfoItem[] = [{ label: 'Format', value: name }];
  let meta: XElement | null = null;
  try {
    meta = await metaElement(o, false);
  } catch (e) {
    warnings.push(`meta.xml could not be parsed: ${(e as Error).message}`);
  }
  const version = meta?.parent ? getAttrNs(meta.parent, NS.office, 'version') : undefined;
  if (version) info.push({ label: 'ODF version', value: version });
  const { main, user, extra } = metaGroup(meta, info);
  const groups: FieldGroup[] = [main, user];

  const other: Field[] = [...extra];
  if (o.parts.has(THUMB)) {
    const img = imageValue(await o.zip.read(o.parts.entry(THUMB)!));
    other.push(makeField({ id: 'odf:thumbnail', label: 'Thumbnail', kind: 'image', sensitivity: 'content', tag: THUMB }, img, { editable: false, display: describeImage(img) }));
  }
  other.push(...hiddenFields(await processHidden(o, new Set())));
  const versions = await versionsField(o);
  if (versions) other.push(versions);
  const objects = objectMetaField(await objectMetas(o));
  if (objects) other.push(objects);
  const signed = SIGNATURES.filter((s) => o.parts.has(s));
  if (signed.length) {
    other.push(rawField('odf:signature', 'Digital signature', 'Signer certificate (invalidated by any change)', { sensitivity: 'identity', tag: signed.join(', ') }));
    warnings.push('This document is digitally signed. Any change invalidates the signature.');
  }
  if (other.length) groups.push({ id: 'odf.other', label: 'Embedded data', source: 'ODF', fields: other });
  const media = await mediaGroup(o.parts, await mediaPaths(o), MEDIA, warnings);
  if (media) groups.push(media);

  return {
    format: { id: 'odf', name, mime: o.mimetype, category: 'document' },
    info,
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: true,
    canStrip: true,
  };
}

async function save(o: Odf, normalize: boolean): Promise<Blob> {
  const blob = await rewriteZip(o.zip, { ...o.parts.finish(), normalizeTime: normalize ? ZIP_EPOCH : undefined, keepComment: !normalize });
  return new Blob([blob], { type: o.mimetype });
}

export async function writeOdf(src: Source, edits: Edits): Promise<Blob> {
  const o = await openOdf(src);
  await applyMetaEdits(o, edits);
  const removed = (id: string) => edits.get(id)?.op === 'remove';
  if (removed('odf:thumbnail')) await removeEntry(o, THUMB, [THUMB, 'Thumbnails/']);
  if (removed('odf:signature')) for (const s of SIGNATURES) await removeEntry(o, s);
  const hidden = new Set((['authors', 'rsid', 'printer'] as HiddenKind[]).filter((k) => removed(`odf:hidden:${k}`)));
  if (hidden.size) await processHidden(o, hidden);
  if (removed('odf:versions')) await removeVersions(o);
  if (removed('odf:objects:meta')) for (const { part, meta } of await objectMetas(o)) if (scrubMeta(meta)) o.parts.touch(part);
  await applyMediaEdits(o.parts, await mediaPaths(o), MEDIA, edits);
  return save(o, false);
}

export async function stripOdf(src: Source, opts: StripOptions): Promise<Blob> {
  const o = await openOdf(src);
  let meta: XElement | null = null;
  try {
    meta = await metaElement(o, false);
  } catch {
    // unparsable meta.xml: replace it with an empty one
    o.parts.remove(META_PART);
    await manifestRemove(o, [META_PART]);
    meta = await metaElement(o, true);
  }
  if (meta) {
    scrubMeta(meta);
    o.parts.touch(META_PART);
  }
  if (o.parts.has(THUMB)) await removeEntry(o, THUMB, [THUMB, 'Thumbnails/']);
  for (const s of SIGNATURES) if (o.parts.has(s)) await removeEntry(o, s);
  await processHidden(o, new Set(['authors', 'rsid', 'printer']));
  await removeVersions(o);
  await stripObjectMetas(o);
  await cleanMedia(o.parts, await mediaPaths(o), opts);
  return save(o, true);
}

export const odfHandler: FormatHandler = {
  id: 'odf',
  name: 'OpenDocument file',
  category: 'document',
  extensions: ['odt', 'ott', 'odm', 'oth', 'ods', 'ots', 'odp', 'otp', 'odg', 'otg', 'odf', 'odc', 'odi'],
  mime: 'application/vnd.oasis.opendocument.text',
  detect(ctx: DetectContext) {
    const first = firstStoredEntry(ctx.head);
    if (first?.name === 'mimetype' && first.data.startsWith(MIME_PREFIX)) return 3;
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readOdf,
  write: writeOdf,
  strip: stripOdf,
};
