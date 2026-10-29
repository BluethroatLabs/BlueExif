/**
 * EPUB 2 and 3: the package document's <metadata> — Dublin Core elements with
 * EPUB 2 opf:role/opf:file-as attributes or EPUB 3 refinements, generic and
 * calibre <meta> entries — plus the cover image (read-only), the NCX
 * docAuthor, vendor files (Apple Books iTunesMetadata.plist, calibre
 * bookmarks) and the pictures of the manifest, cover included (docmedia.ts).
 * An Adobe DRM licence (META-INF/rights.xml) names the buyer's account but is
 * needed for the book to open: it is shown, never removed.
 *
 * The package's unique identifier, the first title, a language and (EPUB 3)
 * dcterms:modified are required: they are editable but never removed; strip
 * resets dcterms:modified to a neutral value. `mimetype` stays the first,
 * STORED entry.
 */

import { asList, asText, describeImage, displayDate, imageValue, makeField, parseDate, partsToDate, rawField, requireDate, toIso } from '../core/fields';
import {
  MetadataError,
  groupKey,
  type DetectContext,
  type Edits,
  type Field,
  type FieldGroup,
  type FieldKind,
  type FieldSpec,
  type FormatHandler,
  type InfoItem,
  type Metadata,
  type Sensitivity,
  type Source,
  type StripOptions,
} from '../core/types';
import { createElement, descendants, elements, getAttr, getAttrNs, localName, removeNode, setText, textContent, type XDocument, type XElement } from '../core/xml';
import { ZipArchive, rewriteZip } from '../core/zip';
import { applyMediaEdits, cleanMedia, mediaGroup, type MediaSpec } from './docmedia';
import { XmlParts, ZIP_EPOCH, dirOf, firstStoredEntry, isNamed, qname, resolvePart } from './docparts';

const NS = {
  opf: 'http://www.idpf.org/2007/opf',
  dc: 'http://purl.org/dc/elements/1.1/',
  container: 'urn:oasis:names:tc:opendocument:xmlns:container',
  ncx: 'http://www.daisy.org/z3986/2005/ncx/',
} as const;

const NEUTRAL_MODIFIED = '2000-01-01T00:00:00Z';
const VENDOR_FILES = ['iTunesMetadata.plist', 'iTunesMetadata-original.plist', 'META-INF/calibre_bookmarks.txt'];
const RIGHTS = 'META-INF/rights.xml';
const MEDIA: MediaSpec = { group: 'epub.media', prefix: 'epub:media:', source: 'EPUB' };

interface DcDef {
  local: string;
  label: string;
  kind: FieldKind;
  sens?: Sensitivity;
  /** one list field for all occurrences */
  list?: boolean;
  /** kept by strip */
  keep?: boolean;
}

const DC: DcDef[] = [
  { local: 'title', label: 'Title', kind: 'text', sens: 'content', keep: true },
  { local: 'creator', label: 'Authors', kind: 'list', sens: 'identity', list: true },
  { local: 'contributor', label: 'Contributors', kind: 'list', sens: 'identity', list: true },
  { local: 'publisher', label: 'Publisher', kind: 'text', sens: 'identity' },
  { local: 'date', label: 'Publication date', kind: 'datetime', sens: 'time' },
  { local: 'description', label: 'Description', kind: 'multiline', sens: 'content' },
  { local: 'subject', label: 'Subjects', kind: 'list', sens: 'content', list: true },
  { local: 'language', label: 'Language', kind: 'list', list: true, keep: true },
  { local: 'rights', label: 'Rights', kind: 'text', sens: 'identity' },
  { local: 'source', label: 'Source', kind: 'text', sens: 'content' },
  { local: 'coverage', label: 'Coverage', kind: 'text', sens: 'location' },
  { local: 'relation', label: 'Relation', kind: 'text', sens: 'content' },
  { local: 'type', label: 'Type', kind: 'text' },
  { local: 'format', label: 'Format', kind: 'text' },
];

/** EPUB 3 meta properties that drive rendering / accessibility — never shown as removable, kept by strip. */
const KEEP_PROPERTY = /^(rendition|media|schema|a11y|ibooks):|^dcterms:modified$/;

// ----------------------------------------------------------------- package

interface Epub {
  zip: ZipArchive;
  parts: XmlParts;
  opfPath: string;
  opf: XDocument;
  metadata: XElement;
  version: string;
  uniqueId: string | undefined;
}

async function openEpub(src: Source): Promise<Epub> {
  const zip = await ZipArchive.open(src);
  const mimetype = zip.has('mimetype') ? (await zip.readText('mimetype')).trim() : '';
  if (mimetype !== 'application/epub+zip') throw new MetadataError('Not an EPUB file (mimetype entry missing)');
  const parts = new XmlParts(zip);
  const container = await parts.get('META-INF/container.xml');
  if (!container) throw new MetadataError('Not an EPUB file (META-INF/container.xml is missing)');
  const rootfiles = descendants(container.root, null, 'rootfile');
  const rootfile = rootfiles.find((r) => getAttr(r, 'media-type') === 'application/oebps-package+xml') ?? rootfiles[0];
  const opfPath = rootfile ? resolvePart('', getAttr(rootfile, 'full-path') ?? '') : '';
  if (!opfPath || !parts.has(opfPath)) throw new MetadataError('The EPUB package document (OPF) is missing');
  const encryption = await parts.tryGet('META-INF/encryption.xml');
  if (encryption && descendants(encryption.root, null, 'CipherReference').some((c) => resolvePart('', getAttr(c, 'URI') ?? '') === opfPath)) {
    throw new MetadataError('This EPUB is DRM-protected; its metadata cannot be read.');
  }
  const opf = await parts.require(opfPath);
  const metadata = elements(opf.root).find((e) => localName(e.name) === 'metadata');
  if (!metadata) throw new MetadataError('The EPUB package document has no <metadata> element');
  return {
    zip,
    parts,
    opfPath,
    opf,
    metadata,
    version: getAttr(opf.root, 'version') ?? '2.0',
    uniqueId: getAttr(opf.root, 'unique-identifier'),
  };
}

const isEpub3 = (e: Epub) => parseFloat(e.version) >= 3;

/** Children of <metadata> (and of legacy OEBPS 1.2 dc-metadata / x-metadata wrappers). */
function metaChildren(e: Epub): XElement[] {
  return elements(e.metadata).flatMap((c) => (/^(dc|x)-metadata$/.test(localName(c.name)) ? elements(c) : [c]));
}

const dcElements = (e: Epub, local: string) => metaChildren(e).filter((c) => isNamed(c, NS.dc, local));
const metaElements = (e: Epub) => metaChildren(e).filter((c) => localName(c.name) === 'meta');

/** EPUB 3 refinements of the element with `id`. */
function refinesOf(e: Epub, el: XElement): XElement[] {
  const id = getAttr(el, 'id');
  if (!id) return [];
  return metaElements(e).filter((m) => getAttr(m, 'refines') === `#${id}`);
}

function refinement(e: Epub, el: XElement, property: string): string | undefined {
  const m = refinesOf(e, el).find((x) => getAttr(x, 'property') === property);
  return m ? textContent(m).trim() : undefined;
}

/** Remove an element together with the metas refining it. */
function removeWithRefines(e: Epub, el: XElement): void {
  for (const r of refinesOf(e, el)) removeNode(r);
  removeNode(el);
}

/** Insert `el` after `anchor`, copying the whitespace that precedes the anchor. */
function insertAfter(anchor: XElement, el: XElement): void {
  const p = anchor.parent!;
  const i = p.children.indexOf(anchor);
  const prev = p.children[i - 1];
  const ws = prev?.type === 'text' && !prev.value.trim() ? prev.value : null;
  el.parent = p;
  p.children.splice(i + 1, 0, ...(ws ? [{ type: 'text' as const, value: ws }, el] : [el]));
}

/** Change an element's text; sort keys and transliterations of the old value are dropped. */
function setDcText(e: Epub, el: XElement, text: string): void {
  if (textContent(el).trim() === text) return;
  setText(el, text);
  el.attrs = el.attrs.filter((a) => !(localName(a.name) === 'file-as' && a.name.includes(':')));
  for (const r of refinesOf(e, el)) {
    if (/^(file-as|alternate-script)$/.test(getAttr(r, 'property') ?? '')) removeNode(r);
  }
}

function newDcElement(e: Epub, local: string, text: string): XElement {
  const el = createElement(qname(e.opf.root, e.metadata, NS.dc, 'dc', local), {}, text);
  const same = dcElements(e, local);
  const anyDc = metaChildren(e).filter((c) => isNamed(c, NS.dc, localName(c.name)) && c.parent === e.metadata);
  const anchor = same[same.length - 1] ?? anyDc[anyDc.length - 1];
  if (anchor) insertAfter(anchor, el);
  else {
    el.parent = e.metadata;
    e.metadata.children.unshift(el);
  }
  return el;
}

function manifestItems(e: Epub): XElement[] {
  const manifest = elements(e.opf.root).find((c) => localName(c.name) === 'manifest');
  return manifest ? elements(manifest).filter((c) => localName(c.name) === 'item') : [];
}

const itemPath = (e: Epub, item: XElement) => resolvePart(dirOf(e.opfPath), getAttr(item, 'href') ?? '');

function coverPath(e: Epub): string | undefined {
  const items = manifestItems(e);
  let item = items.find((i) => (getAttr(i, 'properties') ?? '').split(/\s+/).includes('cover-image'));
  if (!item) {
    const pointer = metaElements(e).find((m) => getAttr(m, 'name') === 'cover');
    const id = pointer ? getAttr(pointer, 'content') : undefined;
    item = items.find((i) => getAttr(i, 'id') === id && (getAttr(i, 'media-type') ?? '').startsWith('image/'));
  }
  return item ? itemPath(e, item) : undefined;
}

/** Resources encrypted by DRM (font obfuscation is listed there too). */
async function encryptedPaths(e: Epub): Promise<Set<string>> {
  const doc = await e.parts.tryGet('META-INF/encryption.xml');
  return new Set(doc ? descendants(doc.root, null, 'CipherReference').map((c) => resolvePart('', getAttr(c, 'URI') ?? '')) : []);
}

/** Pictures of the manifest (cover included); encrypted ones cannot be read and are returned apart. */
async function mediaPaths(e: Epub): Promise<{ paths: string[]; encrypted: string[] }> {
  const locked = await encryptedPaths(e);
  const images = manifestItems(e)
    .filter((i) => /^image\//i.test(getAttr(i, 'media-type') ?? ''))
    .map((i) => itemPath(e, i));
  return { paths: images.filter((p) => !locked.has(p)), encrypted: images.filter((p) => locked.has(p) && e.parts.has(p)) };
}

function ncxPath(e: Epub): string | undefined {
  const item = manifestItems(e).find((i) => getAttr(i, 'media-type') === 'application/x-dtbncx+xml');
  return item ? itemPath(e, item) : undefined;
}

// ------------------------------------------------------------------- read

function identifierLabel(e: Epub, el: XElement): string {
  if (getAttr(el, 'id') && getAttr(el, 'id') === e.uniqueId) return 'Identifier (unique)';
  const scheme = getAttrNs(el, NS.opf, 'scheme') ?? refinement(e, el, 'identifier-type');
  const text = textContent(el).trim().toLowerCase();
  if (scheme) return `Identifier (${scheme})`;
  if (text.startsWith('urn:isbn:')) return 'Identifier (ISBN)';
  if (text.startsWith('urn:uuid:')) return 'Identifier (UUID)';
  return 'Identifier';
}

function personDisplay(e: Epub, els: XElement[]): string | undefined {
  let extra = false;
  const parts = els.map((el) => {
    const name = textContent(el).trim();
    const role = getAttrNs(el, NS.opf, 'role') ?? refinement(e, el, 'role');
    const fileAs = getAttrNs(el, NS.opf, 'file-as') ?? refinement(e, el, 'file-as');
    const bits = [role, fileAs ? `file as “${fileAs}”` : undefined].filter(Boolean);
    if (bits.length) extra = true;
    return bits.length ? `${name} (${bits.join(', ')})` : name;
  });
  return extra ? parts.join('; ') : undefined;
}

function metaSensitivity(key: string): Sensitivity {
  if (/timestamp|date|modified/i.test(key)) return 'time';
  if (/author|creator|user|link_map|owner/i.test(key)) return 'identity';
  if (/generator|calibre|sigil|version/i.test(key)) return 'software';
  return 'content';
}

function dcGroup(e: Epub): FieldGroup {
  const fields: Field[] = [];
  const addable: FieldSpec[] = [];
  for (const def of DC) {
    const els = dcElements(e, def.local);
    const id = `epub:dc:${def.local}`;
    const spec: FieldSpec = { id, label: def.label, kind: def.kind, sensitivity: def.sens, tag: `dc:${def.local}` };
    if (!els.length) {
      if (def.local !== 'title' && def.local !== 'language') addable.push(spec);
      continue;
    }
    const required = def.local === 'title' || def.local === 'language';
    if (def.list) {
      const values = els.map((x) => textContent(x).trim());
      fields.push(makeField(spec, values, { display: def.local === 'creator' || def.local === 'contributor' ? personDisplay(e, els) : undefined, removable: !required }));
      continue;
    }
    els.forEach((el, i) => {
      const text = textContent(el).trim();
      const s = i ? { ...spec, id: `${id}:${i}`, label: `${def.label} ${i + 1}` } : spec;
      const removable = !(required && i === 0);
      if (def.kind === 'datetime') {
        const p = parseDate(text);
        fields.push(p ? makeField(s, toIso(p), { display: displayDate(toIso(p)), removable }) : makeField({ ...s, kind: 'text' }, text, { removable }));
      } else fields.push(makeField(s, text, { removable }));
    });
  }
  dcElements(e, 'identifier').forEach((el, i) => {
    const unique = !!getAttr(el, 'id') && getAttr(el, 'id') === e.uniqueId;
    fields.push(
      makeField({ id: `epub:dc:identifier:${i}`, label: identifierLabel(e, el), kind: 'text', sensitivity: unique ? undefined : 'content', tag: 'dc:identifier' }, textContent(el).trim(), {
        removable: !unique,
      }),
    );
  });
  // dcterms:modified (EPUB 3, required there)
  const modified = metaElements(e).find((m) => getAttr(m, 'property') === 'dcterms:modified' && !getAttr(m, 'refines'));
  const modSpec: FieldSpec = { id: 'epub:meta:dcterms:modified', label: 'Modified', kind: 'datetime', sensitivity: 'time', tag: 'dcterms:modified' };
  if (modified) {
    const p = parseDate(textContent(modified).trim());
    fields.push(p ? makeField(modSpec, toIso(p), { display: displayDate(toIso(p)), removable: !isEpub3(e) }) : makeField({ ...modSpec, kind: 'text' }, textContent(modified), { removable: !isEpub3(e) }));
  } else if (isEpub3(e)) addable.push(modSpec);
  return { id: 'epub.dc', label: 'Book metadata', source: `EPUB ${isEpub3(e) ? '3' : '2'} OPF`, fields, addable, removable: true };
}

/** Removable <meta> entries (generic and vendor), keyed by position. */
function otherMetas(e: Epub): Array<{ id: string; key: string; value: string; el: XElement }> {
  const out: Array<{ id: string; key: string; value: string; el: XElement }> = [];
  metaElements(e).forEach((m, i) => {
    if (getAttr(m, 'refines')) return;
    const name = getAttr(m, 'name');
    const property = getAttr(m, 'property');
    if (name === 'cover') return;
    if (property && KEEP_PROPERTY.test(property)) return;
    const key = property ?? name ?? '';
    const value = property ? textContent(m).trim() : (getAttr(m, 'content') ?? '');
    out.push({ id: `epub:meta:${i}`, key, value, el: m });
  });
  return out;
}

function plistDisplay(text: string): string {
  const id = /<key>\s*(?:AppleID|appleId)\s*<\/key>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
  const date = /<key>\s*purchaseDate\s*<\/key>\s*<(?:string|date)>([^<]*)</.exec(text)?.[1];
  return [id ? `Apple ID ${id}` : 'Purchase information', date ? `purchased ${date}` : ''].filter(Boolean).join(', ');
}

async function otherGroup(e: Epub): Promise<FieldGroup> {
  const fields: Field[] = [];
  for (const m of otherMetas(e)) {
    fields.push(rawField(m.id, m.key, m.value.length > 160 ? `${m.value.slice(0, 160)}…` : m.value || '(empty)', { sensitivity: metaSensitivity(m.key), tag: 'meta' }));
  }
  const cover = coverPath(e);
  if (cover && e.parts.has(cover)) {
    const img = imageValue(await e.zip.read(e.parts.entry(cover)!));
    fields.push(makeField({ id: 'epub:cover', label: 'Cover image', kind: 'image', tag: cover }, img, { editable: false, removable: false, display: describeImage(img) }));
  }
  const ncx = ncxPath(e);
  const ncxDoc = ncx ? await e.parts.tryGet(ncx) : null;
  const authors = ncxDoc ? descendants(ncxDoc.root, NS.ncx, 'docAuthor').map((a) => textContent(a).trim()) : [];
  if (authors.length) {
    fields.push(rawField('epub:ncx:docAuthor', 'Author (table of contents)', authors.join('; '), { sensitivity: 'identity', tag: 'NCX docAuthor' }));
  }
  const rights = e.parts.has(RIGHTS) ? await e.parts.tryGet(RIGHTS) : null;
  if (rights || e.parts.has(RIGHTS)) {
    const user = rights ? descendants(rights.root, null, 'user').map((u) => textContent(u).trim()).find(Boolean) : undefined;
    const operator = rights ? descendants(rights.root, null, 'operatorURL').map((u) => textContent(u).trim()).find(Boolean) : undefined;
    fields.push(
      rawField('epub:drm:rights', 'DRM licence', [user ? `Adobe DRM licence for account ${user}` : 'Adobe DRM licence', operator ? `issued by ${operator}` : ''].filter(Boolean).join(', '), {
        sensitivity: 'identity',
        tag: RIGHTS,
        description: 'Ties the book to the buyer’s account. A protected book cannot be opened without it, so BlueExif keeps it.',
        removable: false,
      }),
    );
  }
  for (const f of VENDOR_FILES) {
    if (!e.parts.has(f)) continue;
    const text = new TextDecoder().decode(await e.zip.read(e.parts.entry(f)!));
    if (f.startsWith('iTunes')) {
      fields.push(rawField(`epub:file:${f}`, 'Apple Books purchase data', plistDisplay(text), { sensitivity: 'identity', tag: f, description: 'Added by Apple Books / iTunes; can name the buyer’s account.' }));
    } else {
      fields.push(rawField(`epub:file:${f}`, 'calibre reading position', `${text.length} bytes`, { sensitivity: 'content', tag: f }));
    }
  }
  return { id: 'epub.other', label: 'Other metadata', source: 'EPUB', fields };
}

export async function readEpub(src: Source): Promise<Metadata> {
  const e = await openEpub(src);
  const info: InfoItem[] = [{ label: 'EPUB version', value: e.version }];
  const spine = elements(e.opf.root).find((c) => localName(c.name) === 'spine');
  if (spine) info.push({ label: 'Spine items', value: String(elements(spine).length) });
  info.push({ label: 'Package document', value: e.opfPath });
  if (e.parts.has('META-INF/encryption.xml')) info.push({ label: 'Encrypted resources', value: 'Yes (fonts or DRM)' });
  const layout = metaElements(e).find((m) => getAttr(m, 'property') === 'rendition:layout');
  if (layout) info.push({ label: 'Layout', value: textContent(layout).trim() });
  const groups = [dcGroup(e), await otherGroup(e)];
  const warnings: string[] = [];
  const { paths, encrypted } = await mediaPaths(e);
  const media = await mediaGroup(e.parts, paths, MEDIA, warnings);
  if (media) groups.push(media);
  if (encrypted.length) warnings.push(`${encrypted.length} picture${encrypted.length > 1 ? 's are' : ' is'} encrypted (DRM) and could not be checked for metadata.`);
  return {
    format: { id: 'epub', name: 'EPUB e-book', mime: 'application/epub+zip', category: 'document' },
    info,
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: true,
    canStrip: true,
  };
}

// ------------------------------------------------------------------ write

function dcValue(def: DcDef, v: Parameters<typeof asText>[0]): string {
  if (def.kind === 'datetime') {
    const p = requireDate(v, def.label);
    return toIso(p);
  }
  return asText(v, def.label);
}

/** EPUB 3 dcterms:modified must be CCYY-MM-DDThh:mm:ssZ. */
function modifiedValue(v: Parameters<typeof asText>[0]): string {
  const p = requireDate(v, 'Modified');
  return partsToDate({ ...p, hour: p.hour ?? 0, minute: p.minute ?? 0, second: p.second ?? 0 })
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
}

function setModified(e: Epub, value: string): void {
  let m = metaElements(e).find((x) => getAttr(x, 'property') === 'dcterms:modified' && !getAttr(x, 'refines'));
  if (!m) {
    m = createElement(qname(e.opf.root, e.metadata, NS.opf, 'opf', 'meta'), { property: 'dcterms:modified' });
    const last = metaChildren(e).filter((c) => c.parent === e.metadata).pop();
    if (last) insertAfter(last, m);
    else {
      m.parent = e.metadata;
      e.metadata.children.push(m);
    }
  }
  setText(m, value);
}

/** `els` are the def's elements as read, so indexes match the field ids whatever was removed since. */
function applyDcEdit(e: Epub, def: DcDef, els: XElement[], index: number | null, op: 'set' | 'remove', value: Parameters<typeof asText>[0]): void {
  const required = def.local === 'title' || def.local === 'language';
  if (def.list) {
    const live = els.filter((x) => x.parent);
    if (op === 'remove') {
      if (required) throw new MetadataError(`${def.label} is required by EPUB and cannot be removed`);
      for (const el of live) removeWithRefines(e, el);
      return;
    }
    const values = asList(value);
    if (required && !values.length) throw new MetadataError(`${def.label} is required by EPUB`);
    values.forEach((v, i) => {
      if (live[i]) setDcText(e, live[i], v);
      else live.push(newDcElement(e, def.local, v));
    });
    for (const el of live.slice(values.length)) removeWithRefines(e, el);
    return;
  }
  const i = index ?? 0;
  const el = els[i];
  if (op === 'remove') {
    if (required && i === 0) throw new MetadataError(`${def.label} is required by EPUB and cannot be removed`);
    if (el) removeWithRefines(e, el);
    return;
  }
  const text = dcValue(def, value);
  if (el?.parent) setDcText(e, el, text);
  else newDcElement(e, def.local, text);
}

async function removeNcxAuthors(e: Epub, generator: boolean): Promise<void> {
  const ncx = ncxPath(e);
  const doc = ncx ? await e.parts.tryGet(ncx) : null;
  if (!doc || !ncx) return;
  let changed = false;
  for (const a of descendants(doc.root, NS.ncx, 'docAuthor')) {
    removeNode(a);
    changed = true;
  }
  if (generator) {
    for (const m of descendants(doc.root, NS.ncx, 'meta')) {
      if (getAttr(m, 'name') === 'dtb:generator') {
        removeNode(m);
        changed = true;
      }
    }
  }
  if (changed) e.parts.touch(ncx);
}

async function save(e: Epub, normalize: boolean): Promise<Blob> {
  e.parts.touch(e.opfPath);
  const blob = await rewriteZip(e.zip, { ...e.parts.finish(), normalizeTime: normalize ? ZIP_EPOCH : undefined, keepComment: !normalize });
  return new Blob([blob], { type: 'application/epub+zip' });
}

/** Remove every non-required descriptive element (used by strip and group removal). */
function clearDc(e: Epub): void {
  for (const def of DC) if (!def.keep) for (const el of dcElements(e, def.local)) removeWithRefines(e, el);
  for (const el of dcElements(e, 'identifier')) {
    if (!(getAttr(el, 'id') && getAttr(el, 'id') === e.uniqueId)) removeWithRefines(e, el);
  }
}

export async function writeEpub(src: Source, edits: Edits): Promise<Blob> {
  const e = await openEpub(src);
  // Field ids are positions in these lists: resolve them before anything is removed.
  const metas = otherMetas(e);
  const identifiers = dcElements(e, 'identifier');
  const dc = new Map(DC.map((d) => [d.local, dcElements(e, d.local)]));
  if (edits.get(groupKey('epub.dc'))?.op === 'remove') clearDc(e);
  for (const [id, edit] of edits) {
    const value = edit.op === 'set' ? edit.value : null;
    let m: RegExpExecArray | null;
    if (id === 'epub:meta:dcterms:modified') {
      if (edit.op === 'remove') {
        if (isEpub3(e)) throw new MetadataError('Modified date is required by EPUB 3 and cannot be removed');
        metaElements(e).filter((x) => getAttr(x, 'property') === 'dcterms:modified').forEach(removeNode);
      } else setModified(e, modifiedValue(value));
    } else if ((m = /^epub:dc:identifier:(\d+)$/.exec(id))) {
      const el = identifiers[+m[1]];
      if (!el) continue;
      const unique = !!getAttr(el, 'id') && getAttr(el, 'id') === e.uniqueId;
      if (edit.op === 'remove') {
        if (unique) throw new MetadataError('The unique identifier is required by EPUB and cannot be removed');
        removeWithRefines(e, el);
      } else {
        const text = asText(value, 'Identifier').trim();
        if (unique && !text) throw new MetadataError('The unique identifier cannot be empty');
        setText(el, text);
      }
    } else if ((m = /^epub:dc:([a-z]+)(?::(\d+))?$/.exec(id))) {
      const def = DC.find((d) => d.local === m![1]);
      if (def) applyDcEdit(e, def, dc.get(def.local)!, m[2] ? +m[2] : null, edit.op, value);
    } else if (/^epub:meta:\d+$/.test(id) && edit.op === 'remove') {
      const meta = metas.find((x) => x.id === id);
      if (meta) removeWithRefines(e, meta.el);
    } else if (id === 'epub:ncx:docAuthor' && edit.op === 'remove') await removeNcxAuthors(e, false);
    else if (id.startsWith('epub:file:') && edit.op === 'remove') e.parts.remove(id.slice('epub:file:'.length));
  }
  await applyMediaEdits(e.parts, (await mediaPaths(e)).paths, MEDIA, edits);
  return save(e, false);
}

/** Drop package@prefix vocabulary mappings (e.g. "calibre: …") no longer used by any property. */
function pruneVocabularyPrefixes(e: Epub): void {
  const attr = e.opf.root.attrs.find((a) => a.name === 'prefix');
  if (!attr) return;
  const used = new Set<string>();
  const walk = (el: XElement) => {
    for (const a of el.attrs) {
      if (a === attr || a.name.startsWith('xmlns')) continue;
      for (const tok of a.value.split(/\s+/)) {
        const m = /^([A-Za-z_][\w.-]*):/.exec(tok);
        if (m) used.add(m[1]);
      }
    }
    for (const c of elements(el)) walk(c);
  };
  walk(e.opf.root);
  const pairs = [...attr.value.matchAll(/([A-Za-z_][\w.-]*):\s+(\S+)/g)].filter((m) => used.has(m[1]));
  if (pairs.length) attr.value = pairs.map((m) => `${m[1]}: ${m[2]}`).join(' ');
  else e.opf.root.attrs = e.opf.root.attrs.filter((a) => a !== attr);
}

export async function stripEpub(src: Source, opts: StripOptions): Promise<Blob> {
  const e = await openEpub(src);
  clearDc(e);
  for (const m of otherMetas(e)) removeWithRefines(e, m.el);
  for (const l of metaChildren(e).filter((c) => localName(c.name) === 'link')) removeNode(l);
  // refinements of removed elements (dangling) go too
  const ids = new Set(metaChildren(e).map((c) => getAttr(c, 'id')).filter(Boolean));
  for (const m of metaElements(e)) {
    const r = getAttr(m, 'refines');
    if (r && !ids.has(r.slice(1))) removeNode(m);
  }
  pruneVocabularyPrefixes(e);
  if (isEpub3(e)) setModified(e, NEUTRAL_MODIFIED);
  else metaElements(e).filter((x) => getAttr(x, 'property') === 'dcterms:modified').forEach(removeNode);
  await removeNcxAuthors(e, true);
  for (const f of VENDOR_FILES) e.parts.remove(f);
  await cleanMedia(e.parts, (await mediaPaths(e)).paths, opts);
  return save(e, true);
}

export const epubHandler: FormatHandler = {
  id: 'epub',
  name: 'EPUB e-book',
  category: 'document',
  extensions: ['epub'],
  mime: 'application/epub+zip',
  detect(ctx: DetectContext) {
    const first = firstStoredEntry(ctx.head);
    if (first?.name === 'mimetype' && first.data === 'application/epub+zip') return 3;
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readEpub,
  write: writeEpub,
  strip: stripEpub,
};
