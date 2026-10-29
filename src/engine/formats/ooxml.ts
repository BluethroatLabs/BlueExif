/**
 * Office Open XML packages (docx/xlsx/pptx and their macro-enabled, template
 * and slide-show variants): core properties, extended (app) properties,
 * custom properties and the package thumbnail, all located through the package
 * relationships rather than fixed paths.
 *
 * Hidden personal information — comment and tracked-change authors (Word,
 * Excel, PowerPoint, Visio), Word editing-session ids (rsid), document
 * variables and attached-template paths, the workbook's original folder
 * (x15ac:absPath), document-server (SharePoint) properties in customXml,
 * printer settings and links to local or network file paths — is shown as raw
 * fields; removing them anonymises authors to "Author" the way Office's
 * Document Inspector does, deletes the parts and reduces linked paths to bare
 * file names. Pictures (media parts) are listed and cleaned through
 * docmedia.ts. Only changed parts are re-encoded, every other ZIP entry is
 * copied raw. Binary workbooks (.xlsb) keep sheets and comments in binary
 * parts, which are not scanned.
 */

import { formatBytes, trimNul, utf16 } from '../core/binary';
import {
  asInteger,
  asNumber,
  asText,
  displayDate,
  imageValue,
  makeField,
  parseDate,
  partsToDate,
  rawField,
  requireDate,
  toIso,
  describeImage,
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
  attrNs,
  createElement,
  descendants,
  elements,
  getAttr,
  localName,
  nsOf,
  prefixOf,
  removeNode,
  setAttr,
  setText,
  textContent,
  appendChild,
  type XElement,
} from '../core/xml';
import { ZipArchive, isZip, rewriteZip } from '../core/zip';
import { applyMediaEdits, cleanMedia, mediaGroup, type MediaSpec } from './docmedia';
import { XmlParts, ZIP_EPOCH, dirOf, ensurePrefix, headHasEntry, newXmlDoc, qname, resolvePart } from './docparts';

const NS = {
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  cp: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  dcmitype: 'http://purl.org/dc/dcmitype/',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  app: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
  custom: 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties',
  vt: 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  w15: 'http://schemas.microsoft.com/office/word/2012/wordml',
  w16cex: 'http://schemas.microsoft.com/office/word/2018/wordml/cex',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  tc: 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments',
  x15ac: 'http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  p188: 'http://schemas.microsoft.com/office/powerpoint/2018/8/main',
  v: 'http://schemas.microsoft.com/office/visio/2012/main',
} as const;

/** Relationship types (transitional + strict spellings). */
const REL = {
  core: [
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/metadata/core-properties',
  ],
  app: [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
    'http://purl.oclc.org/ooxml/officeDocument/relationships/extendedProperties',
  ],
  custom: [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties',
    'http://purl.oclc.org/ooxml/officeDocument/relationships/customProperties',
  ],
  thumbnail: ['http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail'],
  office: [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
    'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
  ],
  template: [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate',
    'http://purl.oclc.org/ooxml/officeDocument/relationships/attachedTemplate',
  ],
  customXml: [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml',
    'http://purl.oclc.org/ooxml/officeDocument/relationships/customXml',
  ],
};

const CT = {
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  custom: 'application/vnd.openxmlformats-officedocument.custom-properties+xml',
};

const CUSTOM_FMTID = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}';
const CUSTOM_NEW = 'ooxml:custom-new';
const ANON = 'Author';
/** Replaces required comment dates (Visio) when authors are anonymised. */
const NEUTRAL_DATE = '1970-01-01T00:00:00';

const BINARY_WORKBOOK = 'application/vnd.ms-excel.sheet.binary.macroEnabled.12';

interface Variant {
  re: RegExp;
  name: string;
  mime: string;
}

const VARIANTS: Variant[] = [
  { re: /wordprocessingml\.document\.main/, name: 'Word document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  { re: /wordprocessingml\.template\.main/, name: 'Word template', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template' },
  { re: /ms-word\.document\.macroEnabled/i, name: 'Word macro-enabled document', mime: 'application/vnd.ms-word.document.macroEnabled.12' },
  { re: /ms-word\.template\.macroEnabled/i, name: 'Word macro-enabled template', mime: 'application/vnd.ms-word.template.macroEnabled.12' },
  { re: /spreadsheetml\.sheet\.main/, name: 'Excel workbook', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { re: /spreadsheetml\.template\.main/, name: 'Excel template', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template' },
  { re: /ms-excel\.sheet\.macroEnabled/i, name: 'Excel macro-enabled workbook', mime: 'application/vnd.ms-excel.sheet.macroEnabled.12' },
  { re: /ms-excel\.template\.macroEnabled/i, name: 'Excel macro-enabled template', mime: 'application/vnd.ms-excel.template.macroEnabled.12' },
  { re: /ms-excel\.sheet\.binary/i, name: 'Excel binary workbook', mime: BINARY_WORKBOOK },
  { re: /presentationml\.presentation\.main/, name: 'PowerPoint presentation', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  { re: /presentationml\.template\.main/, name: 'PowerPoint template', mime: 'application/vnd.openxmlformats-officedocument.presentationml.template' },
  { re: /presentationml\.slideshow\.main/, name: 'PowerPoint slide show', mime: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow' },
  { re: /ms-powerpoint\.presentation\.macroEnabled/i, name: 'PowerPoint macro-enabled presentation', mime: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12' },
  { re: /ms-powerpoint\.slideshow\.macroEnabled/i, name: 'PowerPoint macro-enabled slide show', mime: 'application/vnd.ms-powerpoint.slideshow.macroEnabled.12' },
  { re: /ms-powerpoint\.template\.macroEnabled/i, name: 'PowerPoint macro-enabled template', mime: 'application/vnd.ms-powerpoint.template.macroEnabled.12' },
  { re: /visio/i, name: 'Visio drawing', mime: 'application/vnd.ms-visio.drawing' },
];

const EXTENSIONS = ['docx', 'docm', 'dotx', 'dotm', 'xlsx', 'xlsm', 'xltx', 'xltm', 'xlsb', 'pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm', 'vsdx'];

// ------------------------------------------------------------------ package

interface Rel {
  id: string;
  type: string;
  /** resolved part name (external targets as written) */
  target: string;
  external: boolean;
  el: XElement;
}

function relsPathOf(owner: string): string {
  if (!owner) return '_rels/.rels';
  return `${dirOf(owner)}_rels/${owner.slice(dirOf(owner).length)}.rels`;
}

const RELS_PART = /(^|\/)_rels\/[^/]*\.rels$/;

/** The part a relationships part belongs to ('' = package). */
function ownerOfRels(path: string): string {
  return path === '_rels/.rels' ? '' : path.replace(/_rels\/([^/]*)\.rels$/, '$1');
}

/**
 * Drop references to relationship `id` from an owner part (e.g. a worksheet's
 * <pageSetup r:id>): the attribute goes, and the element too when nothing else
 * is left in it.
 */
function unlinkRelId(el: XElement, id: string): boolean {
  let changed = false;
  const before = el.attrs.length;
  el.attrs = el.attrs.filter((a) => !(attrNs(el, a) === NS.r && a.value === id));
  if (el.attrs.length !== before) {
    changed = true;
    if (!el.attrs.some((a) => !a.name.startsWith('xmlns')) && !elements(el).length && el.parent) {
      removeNode(el);
      return true;
    }
  }
  for (const c of elements(el)) if (unlinkRelId(c, id)) changed = true;
  return changed;
}

class Package {
  constructor(
    readonly zip: ZipArchive,
    readonly parts: XmlParts,
  ) {}

  async rels(owner: string): Promise<Rel[]> {
    const doc = await this.parts.tryGet(relsPathOf(owner));
    if (!doc) return [];
    return elements(doc.root)
      .filter((e) => localName(e.name) === 'Relationship')
      .map((el) => {
        const external = getAttr(el, 'TargetMode') === 'External';
        const raw = getAttr(el, 'Target') ?? '';
        return {
          id: getAttr(el, 'Id') ?? '',
          type: getAttr(el, 'Type') ?? '',
          target: external ? raw : resolvePart(dirOf(owner), raw),
          external,
          el,
        };
      });
  }

  /** Resolved part targeted by the first relationship of one of `types`. */
  async relTarget(owner: string, types: string[]): Promise<string | undefined> {
    const r = (await this.rels(owner)).find((x) => types.includes(x.type) && !x.external);
    return r ? (this.parts.entry(r.target) ?? r.target) : undefined;
  }

  async contentTypes(): Promise<XElement> {
    return (await this.parts.require('[Content_Types].xml')).root;
  }

  async contentType(part: string): Promise<string | undefined> {
    const types = await this.contentTypes();
    const lower = `/${part}`.toLowerCase();
    const o = elements(types).find((e) => localName(e.name) === 'Override' && (getAttr(e, 'PartName') ?? '').toLowerCase() === lower);
    if (o) return getAttr(o, 'ContentType');
    const ext = part.slice(part.lastIndexOf('.') + 1).toLowerCase();
    const d = elements(types).find((e) => localName(e.name) === 'Default' && (getAttr(e, 'Extension') ?? '').toLowerCase() === ext);
    return d ? getAttr(d, 'ContentType') : undefined;
  }

  async setOverride(part: string, type: string): Promise<void> {
    const types = await this.contentTypes();
    const lower = `/${part}`.toLowerCase();
    const o = elements(types).find((e) => localName(e.name) === 'Override' && (getAttr(e, 'PartName') ?? '').toLowerCase() === lower);
    if (o) setAttr(o, 'ContentType', type);
    else appendChild(types, createElement(prefixed(types, 'Override'), { PartName: `/${part}`, ContentType: type }));
    this.parts.touch('[Content_Types].xml');
  }

  /** Add a relationship from `owner` ('' = package) to `part`; returns its id. */
  async addRel(owner: string, type: string, part: string): Promise<string> {
    const path = relsPathOf(owner);
    let doc = await this.parts.get(path);
    if (!doc) {
      doc = newXmlDoc(createElement('Relationships', { xmlns: NS.rels }), true);
      this.parts.put(path, doc);
    }
    const used = new Set(elements(doc.root).map((e) => getAttr(e, 'Id')));
    let n = used.size + 1;
    while (used.has(`rId${n}`)) n++;
    const base = dirOf(owner);
    const target = part.startsWith(base) ? part.slice(base.length) : `/${part}`;
    appendChild(doc.root, createElement(prefixed(doc.root, 'Relationship'), { Id: `rId${n}`, Type: type, Target: target }));
    this.parts.touch(path);
    return `rId${n}`;
  }

  /** Existing relationships parts with their owners. */
  relsParts(): Array<{ path: string; owner: string }> {
    return this.zip.entries.filter((e) => RELS_PART.test(e.name) && this.parts.has(e.name)).map((e) => ({ path: e.name, owner: ownerOfRels(e.name) }));
  }

  /**
   * Delete a part with its own relationships, content-type override and every
   * relationship pointing at it. With `unlink`, references to those
   * relationships in the owner parts go too (for explicitly referenced parts).
   */
  async removePart(part: string, unlink = false): Promise<void> {
    const name = this.parts.entry(part) ?? part;
    this.parts.remove(name);
    this.parts.remove(relsPathOf(name));
    const types = await this.contentTypes();
    const lower = `/${name}`.toLowerCase();
    for (const o of elements(types)) {
      if (localName(o.name) === 'Override' && (getAttr(o, 'PartName') ?? '').toLowerCase() === lower) {
        removeNode(o);
        this.parts.touch('[Content_Types].xml');
      }
    }
    for (const { path, owner } of this.relsParts()) {
      for (const r of await this.rels(owner)) {
        if (r.external || r.target.toLowerCase() !== name.toLowerCase()) continue;
        removeNode(r.el);
        this.parts.touch(path);
        const doc = unlink && owner ? await this.parts.tryGet(owner) : null;
        if (doc && unlinkRelId(doc.root, r.id)) this.parts.touch(owner);
      }
    }
  }

  /** Drop the Default content type of `ext` when no remaining part relies on it. */
  async pruneDefault(ext: string): Promise<void> {
    const types = await this.contentTypes();
    const overridden = new Set(
      elements(types)
        .filter((e) => localName(e.name) === 'Override')
        .map((e) => (getAttr(e, 'PartName') ?? '').toLowerCase()),
    );
    const suffix = `.${ext.toLowerCase()}`;
    const used = this.zip.entries.some((e) => this.parts.has(e.name) && e.name.toLowerCase().endsWith(suffix) && !overridden.has(`/${e.name}`.toLowerCase()));
    if (used) return;
    for (const d of elements(types)) {
      if (localName(d.name) === 'Default' && (getAttr(d, 'Extension') ?? '').toLowerCase() === ext.toLowerCase()) {
        removeNode(d);
        this.parts.touch('[Content_Types].xml');
      }
    }
  }
}

/** Element name in the same (default or prefixed) namespace as `parent`. */
function prefixed(parent: XElement, local: string): string {
  const p = prefixOf(parent.name);
  return p ? `${p}:${local}` : local;
}

interface Ooxml {
  pkg: Package;
  variant: Variant | null;
  main?: string;
  core?: string;
  app?: string;
  custom?: string;
  thumbnail?: string;
}

async function openOoxml(src: Source): Promise<Ooxml> {
  const head = await src.read(0, 8);
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    throw new MetadataError(
      'This Office file is password protected (or in the old binary format). Remove the password in Office first, then try again.',
    );
  }
  const zip = await ZipArchive.open(src);
  const parts = new XmlParts(zip);
  if (!parts.has('[Content_Types].xml')) throw new MetadataError('Not an Office Open XML document ([Content_Types].xml is missing)');
  const pkg = new Package(zip, parts);
  const main = await pkg.relTarget('', REL.office);
  const type = main ? await pkg.contentType(main) : undefined;
  return {
    pkg,
    main,
    variant: (type && VARIANTS.find((v) => v.re.test(type))) || null,
    core: await pkg.relTarget('', REL.core),
    app: await pkg.relTarget('', REL.app),
    custom: await pkg.relTarget('', REL.custom),
    thumbnail: await pkg.relTarget('', REL.thumbnail),
  };
}

// ----------------------------------------------------------------- core

interface PropDef {
  prefix: 'dc' | 'cp' | 'dcterms';
  local: string;
  label: string;
  kind: FieldKind;
  sens?: Sensitivity;
  /** dcterms dates carry xsi:type="dcterms:W3CDTF" */
  w3cdtf?: boolean;
}

const CORE: PropDef[] = [
  { prefix: 'dc', local: 'title', label: 'Title', kind: 'text', sens: 'content' },
  { prefix: 'dc', local: 'subject', label: 'Subject', kind: 'text', sens: 'content' },
  { prefix: 'dc', local: 'creator', label: 'Author', kind: 'text', sens: 'identity' },
  { prefix: 'cp', local: 'keywords', label: 'Keywords', kind: 'text', sens: 'content' },
  { prefix: 'dc', local: 'description', label: 'Comments', kind: 'multiline', sens: 'content' },
  { prefix: 'cp', local: 'lastModifiedBy', label: 'Last modified by', kind: 'text', sens: 'identity' },
  { prefix: 'cp', local: 'revision', label: 'Revision', kind: 'text', sens: 'software' },
  { prefix: 'dcterms', local: 'created', label: 'Created', kind: 'datetime', sens: 'time', w3cdtf: true },
  { prefix: 'dcterms', local: 'modified', label: 'Modified', kind: 'datetime', sens: 'time', w3cdtf: true },
  { prefix: 'cp', local: 'lastPrinted', label: 'Last printed', kind: 'datetime', sens: 'time' },
  { prefix: 'cp', local: 'category', label: 'Category', kind: 'text', sens: 'content' },
  { prefix: 'cp', local: 'contentStatus', label: 'Status', kind: 'text', sens: 'content' },
  { prefix: 'cp', local: 'contentType', label: 'Content type', kind: 'text' },
  { prefix: 'dc', local: 'language', label: 'Language', kind: 'text' },
  { prefix: 'cp', local: 'version', label: 'Version', kind: 'text', sens: 'software' },
  { prefix: 'dc', local: 'identifier', label: 'Identifier', kind: 'text', sens: 'content' },
];

const coreId = (prefix: string, local: string) => `ooxml:core:${prefix}:${local}`;

const CANON: Record<string, 'dc' | 'cp' | 'dcterms'> = { [NS.dc]: 'dc', [NS.cp]: 'cp', [NS.dcterms]: 'dcterms' };

function canonPrefix(el: XElement): string {
  return CANON[nsOf(el) ?? ''] ?? (prefixOf(el.name) || 'ns');
}

/** W3CDTF in UTC as written by Office ("2024-05-01T10:00:00Z"). */
function w3cdtf(v: FieldValue, label: string): string {
  const p = requireDate(v, label);
  return partsToDate({ ...p, hour: p.hour ?? 0, minute: p.minute ?? 0, second: p.second ?? 0 })
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
}

function dateField(spec: FieldSpec, text: string): Field {
  const p = parseDate(text.trim());
  if (!p) return makeField({ ...spec, kind: 'text' }, text);
  const iso = toIso(p);
  return makeField({ ...spec, kind: 'datetime' }, iso, { display: displayDate(iso) });
}

function coreGroup(root: XElement | null): FieldGroup {
  const fields: Field[] = [];
  const present = new Set<string>();
  const kids = root ? elements(root) : [];
  const order = (el: XElement) => {
    const i = CORE.findIndex((d) => d.prefix === canonPrefix(el) && d.local === localName(el.name));
    return i < 0 ? 99 : i;
  };
  for (const el of [...kids].sort((a, b) => order(a) - order(b))) {
    const prefix = canonPrefix(el);
    const local = localName(el.name);
    const id = coreId(prefix, local);
    if (present.has(id)) continue;
    present.add(id);
    const def = CORE.find((d) => d.prefix === prefix && d.local === local);
    const spec: FieldSpec = { id, label: def?.label ?? local, kind: def?.kind ?? 'text', sensitivity: def?.sens, tag: `${prefix}:${local}` };
    const text = textContent(el);
    fields.push(spec.kind === 'datetime' ? dateField(spec, text) : makeField(spec, text));
  }
  const addable = CORE.filter((d) => !present.has(coreId(d.prefix, d.local))).map(
    (d): FieldSpec => ({ id: coreId(d.prefix, d.local), label: d.label, kind: d.kind, sensitivity: d.sens, tag: `${d.prefix}:${d.local}` }),
  );
  return { id: 'ooxml.core', label: 'Document properties', source: 'OOXML core', fields, addable, removable: true };
}

async function coreRoot(o: Ooxml, create: boolean): Promise<XElement | null> {
  if (o.core) return (await o.pkg.parts.get(o.core))?.root ?? null;
  if (!create) return null;
  const root = createElement('cp:coreProperties', {
    'xmlns:cp': NS.cp,
    'xmlns:dc': NS.dc,
    'xmlns:dcterms': NS.dcterms,
    'xmlns:dcmitype': NS.dcmitype,
    'xmlns:xsi': NS.xsi,
  });
  o.core = 'docProps/core.xml';
  o.pkg.parts.put(o.core, newXmlDoc(root, true));
  await o.pkg.setOverride(o.core, CT.core);
  await o.pkg.addRel('', REL.core[0], o.core);
  return root;
}

async function applyCoreEdits(o: Ooxml, edits: Edits): Promise<void> {
  const mine = [...edits].filter(([k]) => k.startsWith('ooxml:core:'));
  const clear = edits.get(groupKey('ooxml.core'))?.op === 'remove';
  if (!mine.length && !clear) return;
  const root = await coreRoot(o, mine.some(([, e]) => e.op === 'set'));
  if (!root) return;
  if (clear) root.children = [];
  for (const [id, e] of mine) {
    const [prefix, local] = id.slice('ooxml:core:'.length).split(':');
    const def = CORE.find((d) => d.prefix === prefix && d.local === local);
    const ns = Object.entries(CANON).find(([, p]) => p === prefix)?.[0];
    let el = elements(root).find((c) => canonPrefix(c) === prefix && localName(c.name) === local);
    if (e.op === 'remove') {
      if (el) removeNode(el);
      continue;
    }
    if (!ns) continue;
    const label = def?.label ?? local;
    const value = def?.kind === 'datetime' ? w3cdtf(e.value, label) : asText(e.value, label);
    if (!el) {
      el = createElement(qname(root, root, ns, prefix, local));
      appendChild(root, el);
    }
    if (def?.w3cdtf) {
      const xsi = ensurePrefix(root, el, NS.xsi, 'xsi');
      const dct = ensurePrefix(root, el, NS.dcterms, 'dcterms');
      setAttr(el, `${xsi}:type`, `${dct}:W3CDTF`);
    }
    setText(el, value);
  }
  o.pkg.parts.touch(o.core!);
}

// ------------------------------------------------------------------ app

interface AppDef {
  local: string;
  label: string;
  kind: FieldKind;
  sens: Sensitivity;
  addable?: boolean;
}

const APP: AppDef[] = [
  { local: 'Application', label: 'Application', kind: 'text', sens: 'software' },
  { local: 'AppVersion', label: 'Application version', kind: 'text', sens: 'software' },
  { local: 'Company', label: 'Company', kind: 'text', sens: 'identity', addable: true },
  { local: 'Manager', label: 'Manager', kind: 'text', sens: 'identity', addable: true },
  { local: 'Template', label: 'Template', kind: 'text', sens: 'software' },
  { local: 'TotalTime', label: 'Total editing time (min)', kind: 'integer', sens: 'software' },
  { local: 'HyperlinkBase', label: 'Hyperlink base', kind: 'text', sens: 'content', addable: true },
];

const STATS: Record<string, string> = {
  Pages: 'Pages',
  Words: 'Words',
  Characters: 'Characters',
  CharactersWithSpaces: 'Characters (with spaces)',
  Lines: 'Lines',
  Paragraphs: 'Paragraphs',
  Slides: 'Slides',
  Notes: 'Notes',
  HiddenSlides: 'Hidden slides',
  MMClips: 'Media clips',
  PresentationFormat: 'Presentation format',
};

const SECURITY: Record<string, string> = {
  '1': 'Password protected',
  '2': 'Read-only recommended',
  '4': 'Read-only enforced',
  '8': 'Locked for annotations',
};

function appGroup(root: XElement | null, info: InfoItem[]): FieldGroup {
  const fields: Field[] = [];
  const present = new Set<string>();
  let links: Field | undefined;
  for (const el of root ? elements(root) : []) {
    const local = localName(el.name);
    const def = APP.find((d) => d.local === local);
    const text = textContent(el).trim();
    if (local === 'HLinks') {
      // vector of variants: hash, ids, target, anchor per hyperlink
      const targets = [...new Set(descendants(el, NS.vt, 'lpwstr').map((t) => textContent(t).trim()).filter(Boolean))];
      links = rawField('ooxml:app:HLinks', 'Hyperlink list', targets.length ? listDisplay(targets) : '(empty)', {
        sensitivity: targets.some(isLocalPath) ? 'identity' : 'content',
        tag: 'HLinks',
        description: 'A copy of the document’s hyperlink targets kept for older Office versions.',
      });
    } else if (def) {
      present.add(local);
      const spec: FieldSpec = { id: `ooxml:app:${local}`, label: def.label, kind: def.kind, sensitivity: def.sens, tag: local };
      fields.push(def.kind === 'integer' && /^\d+$/.test(text) ? makeField(spec, +text) : makeField({ ...spec, kind: 'text' }, text));
    } else if (STATS[local] && text) info.push({ label: STATS[local], value: text });
    else if (local === 'DocSecurity' && SECURITY[text]) info.push({ label: 'Protection', value: SECURITY[text] });
    else if (local === 'TitlesOfParts') {
      const names = elements(el).flatMap((v) => elements(v)).map((x) => textContent(x));
      if (names.length) info.push({ label: 'Titles of parts', value: names.length > 12 ? `${names.slice(0, 12).join(', ')}, …` : names.join(', ') });
    }
  }
  const order = (f: Field) => APP.findIndex((d) => `ooxml:app:${d.local}` === f.id);
  fields.sort((a, b) => order(a) - order(b));
  if (links) fields.push(links);
  const addable = APP.filter((d) => d.addable && !present.has(d.local)).map(
    (d): FieldSpec => ({ id: `ooxml:app:${d.local}`, label: d.label, kind: d.kind, sensitivity: d.sens, tag: d.local }),
  );
  return { id: 'ooxml.app', label: 'Application properties', source: 'OOXML app', fields, addable, removable: true };
}

/** Removed by strip and group removal: the personal properties plus the hyperlink list. */
const APP_PERSONAL = new Set([...APP.map((d) => d.local), 'HLinks']);

function scrubApp(root: XElement): boolean {
  let changed = false;
  for (const el of elements(root)) {
    if (APP_PERSONAL.has(localName(el.name))) {
      removeNode(el);
      changed = true;
    }
  }
  return changed;
}

async function appRoot(o: Ooxml, create: boolean): Promise<XElement | null> {
  if (o.app) return (await o.pkg.parts.get(o.app))?.root ?? null;
  if (!create) return null;
  const root = createElement('Properties', { xmlns: NS.app, 'xmlns:vt': NS.vt });
  o.app = 'docProps/app.xml';
  o.pkg.parts.put(o.app, newXmlDoc(root, true));
  await o.pkg.setOverride(o.app, CT.app);
  await o.pkg.addRel('', REL.app[0], o.app);
  return root;
}

async function applyAppEdits(o: Ooxml, edits: Edits): Promise<void> {
  const mine = [...edits].filter(([k]) => k.startsWith('ooxml:app:'));
  const clear = edits.get(groupKey('ooxml.app'))?.op === 'remove';
  if (!mine.length && !clear) return;
  const root = await appRoot(o, mine.some(([, e]) => e.op === 'set'));
  if (!root || !o.app) return;
  if (clear) scrubApp(root);
  for (const [id, e] of mine) {
    const local = id.slice('ooxml:app:'.length);
    const def = APP.find((d) => d.local === local);
    let el = elements(root).find((c) => localName(c.name) === local);
    if (e.op === 'remove') {
      if (el) removeNode(el);
      continue;
    }
    if (!def) continue;
    const value = def.kind === 'integer' ? String(asInteger(e.value, def.label)) : asText(e.value, def.label);
    if (!el) {
      el = createElement(prefixed(root, local));
      appendChild(root, el);
    }
    setText(el, value);
  }
  o.pkg.parts.touch(o.app);
}

// --------------------------------------------------------------- custom

const INT_TYPES = new Set(['i1', 'i2', 'i4', 'i8', 'int', 'ui1', 'ui2', 'ui4', 'ui8', 'uint']);
const NUM_TYPES = new Set(['r4', 'r8', 'decimal']);
const TEXT_TYPES = new Set(['lpwstr', 'lpstr', 'bstr', 'cy']);

function customSensitivity(name: string): Sensitivity {
  if (/author|owner|client|customer|company|manager|name|user|mail|person|phone/i.test(name)) return 'identity';
  if (/date|time|due/i.test(name)) return 'time';
  return 'content';
}

function customProps(root: XElement): Array<{ name: string; el: XElement; vt: XElement | undefined }> {
  return elements(root)
    .filter((e) => localName(e.name) === 'property')
    .map((el) => ({ name: getAttr(el, 'name') ?? '', el, vt: elements(el)[0] }));
}

function customGroup(root: XElement | null): FieldGroup {
  const fields: Field[] = [];
  for (const { name, vt } of root ? customProps(root) : []) {
    const id = `ooxml:custom:${name}`;
    const type = vt ? localName(vt.name) : '';
    const text = vt ? textContent(vt) : '';
    const spec: FieldSpec = { id, label: name, kind: 'text', sensitivity: customSensitivity(name), tag: `custom (${type || '?'})` };
    if (TEXT_TYPES.has(type)) fields.push(makeField({ ...spec, kind: text.length > 80 ? 'multiline' : 'text' }, text));
    else if (INT_TYPES.has(type) && /^-?\d+$/.test(text.trim())) fields.push(makeField({ ...spec, kind: 'integer' }, +text));
    else if (NUM_TYPES.has(type) && Number.isFinite(Number(text))) fields.push(makeField({ ...spec, kind: 'number' }, Number(text)));
    else if (type === 'bool') {
      const v = /^(1|true)$/i.test(text.trim()) ? 'true' : 'false';
      fields.push(makeField({ ...spec, kind: 'enum', options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] }, v));
    } else if (type === 'filetime' || type === 'date') fields.push(dateField({ ...spec, kind: 'datetime' }, text));
    else fields.push(rawField(id, name, text.trim() || `(${type || 'empty'})`, { sensitivity: spec.sensitivity, tag: spec.tag }));
  }
  const addable: FieldSpec[] = [
    {
      id: CUSTOM_NEW,
      label: 'Custom property',
      kind: 'text',
      placeholder: 'Name=Value',
      description: 'Adds a text custom property (File › Properties › Custom in Office).',
    },
  ];
  return { id: 'ooxml.custom', label: 'Custom properties', source: 'OOXML custom', fields, addable, removable: true };
}

function customValue(type: string, v: FieldValue, label: string): string {
  if (INT_TYPES.has(type)) return String(asInteger(v, label));
  if (NUM_TYPES.has(type)) return String(asNumber(v, label));
  if (type === 'bool') {
    const t = asText(v, label).trim().toLowerCase();
    if (/^(1|true|yes)$/.test(t)) return 'true';
    if (/^(0|false|no)$/.test(t)) return 'false';
    throw new MetadataError(`${label}: expected true or false`);
  }
  if (type === 'filetime' || type === 'date') return w3cdtf(v, label);
  return asText(v, label);
}

async function applyCustomEdits(o: Ooxml, edits: Edits): Promise<void> {
  const mine = [...edits].filter(([k]) => k.startsWith('ooxml:custom:') || k === CUSTOM_NEW);
  if (edits.get(groupKey('ooxml.custom'))?.op === 'remove') {
    if (o.custom) await o.pkg.removePart(o.custom);
    o.custom = undefined;
    return;
  }
  if (!mine.length) return;
  let root = o.custom ? (await o.pkg.parts.get(o.custom))?.root : undefined;
  if (!root) {
    if (!mine.some(([, e]) => e.op === 'set')) return;
    root = createElement('Properties', { xmlns: NS.custom, 'xmlns:vt': NS.vt });
    o.custom = 'docProps/custom.xml';
    o.pkg.parts.put(o.custom, newXmlDoc(root, true));
    await o.pkg.setOverride(o.custom, CT.custom);
    await o.pkg.addRel('', REL.custom[0], o.custom);
  }
  const props = () => customProps(root!);
  for (const [id, e] of mine) {
    let name: string;
    let value: FieldValue;
    if (id === CUSTOM_NEW) {
      if (e.op !== 'set') continue;
      const s = asText(e.value, 'Custom property');
      const eq = s.indexOf('=');
      name = (eq < 0 ? '' : s.slice(0, eq)).trim();
      if (!name) throw new MetadataError('Custom property: use the form Name=Value');
      value = s.slice(eq + 1).trim();
    } else {
      name = id.slice('ooxml:custom:'.length);
      value = e.op === 'set' ? e.value : null;
    }
    const cur = props().find((p) => p.name === name);
    if (e.op === 'remove') {
      if (cur) removeNode(cur.el);
      continue;
    }
    if (cur?.vt) {
      setText(cur.vt, customValue(localName(cur.vt.name), value, name));
      continue;
    }
    const pid = Math.max(1, ...props().map((p) => Number(getAttr(p.el, 'pid')) || 0)) + 1;
    const prop = createElement(prefixed(root, 'property'), { fmtid: CUSTOM_FMTID, pid: String(pid), name });
    const vtName = qname(root, root, NS.vt, 'vt', typeof value === 'number' ? (Number.isInteger(value) ? 'i4' : 'r8') : 'lpwstr');
    appendChild(prop, createElement(vtName, {}, typeof value === 'number' ? String(value) : asText(value, name)));
    if (cur) removeNode(cur.el);
    appendChild(root, prop);
  }
  if (!props().length) {
    await o.pkg.removePart(o.custom!);
    o.custom = undefined;
  } else o.pkg.parts.touch(o.custom!);
}

// --------------------------------------------------------------- hidden

type HiddenKind = 'authors' | 'rsid' | 'template' | 'abspath' | 'docvars';
const ALL_HIDDEN: HiddenKind[] = ['authors', 'rsid', 'template', 'abspath', 'docvars'];

interface HiddenScan {
  authors: Map<string, number>;
  comments: number;
  revisions: number;
  rsids: Set<string>;
  docIds: number;
  docVars: string[];
  template?: string;
  abspath?: string;
}

/** Parts that can hold comment authors, revision marks, rsids, document variables or file paths. */
const HIDDEN_PARTS =
  /^(word\/(glossary\/)?[^/]+\.xml|xl\/(workbook\.xml|comments[^/]*\.xml|threadedComments\/[^/]+\.xml|persons\/[^/]+\.xml)|ppt\/(commentAuthors\.xml|authors\.xml|comments\/[^/]+\.xml)|visio\/comments\.xml)$/i;

/**
 * Excel notes repeat their author as a leading "Name:" run of the note text;
 * it becomes "Author:" like the author list. Names come from <authors> before
 * walkHidden rewrites them.
 */
function anonNoteRuns(comments: XElement): boolean {
  const list = elements(comments).find((e) => nsOf(e) === NS.s && localName(e.name) === 'authors');
  const names = (list ? elements(list).map((a) => textContent(a)) : []).filter((n) => n && n !== ANON).sort((a, b) => b.length - a.length);
  if (!names.length) return false;
  let changed = false;
  for (const c of descendants(comments, NS.s, 'comment')) {
    const text = elements(c).find((e) => localName(e.name) === 'text');
    const first = text ? elements(text)[0] : undefined;
    const t = first && localName(first.name) === 'r' ? elements(first).find((e) => localName(e.name) === 't') : first;
    if (!t || localName(t.name) !== 't') continue;
    const s = textContent(t);
    const name = names.find((n) => s.startsWith(`${n}:`));
    if (name) {
      setText(t, `${ANON}:${s.slice(name.length + 1)}`);
      changed = true;
    }
  }
  return changed;
}

const W_DATED = new Set(['comment', 'ins', 'del', 'moveFrom', 'moveTo', 'rPrChange', 'pPrChange', 'sectPrChange', 'tblPrChange', 'trPrChange', 'tcPrChange', 'tblGridChange', 'numberingChange', 'cellIns', 'cellDel', 'cellMerge', 'customXmlInsRangeStart', 'customXmlDelRangeStart', 'customXmlMoveFromRangeStart', 'customXmlMoveToRangeStart', 'moveFromRangeStart', 'moveToRangeStart']);

function walkHidden(el: XElement, scan: HiddenScan, apply: Set<HiddenKind>, drop: XElement[]): boolean {
  let changed = false;
  const ns = nsOf(el);
  const local = localName(el.name);
  const seen = (name: string) => {
    if (name) scan.authors.set(name, (scan.authors.get(name) ?? 0) + 1);
  };
  const anon = apply.has('authors');
  /** Decide per attribute; returns false to drop it. */
  const keep = (ans: string | null, al: string, a: { value: string }): boolean => {
    if (ans === NS.w && al === 'author') {
      seen(a.value);
      if (local === 'comment') scan.comments++;
      else scan.revisions++;
      if (anon && a.value !== ANON) {
        a.value = ANON;
        changed = true;
      }
      return true;
    }
    if (ans === NS.w && (al === 'initials' || al === 'date') && ns === NS.w && W_DATED.has(local)) return !anon;
    if (ans === NS.w && al.startsWith('rsid')) {
      scan.rsids.add(a.value);
      return !apply.has('rsid');
    }
    if (ans === NS.w15 && al === 'author') {
      seen(a.value);
      if (anon && a.value !== ANON) {
        a.value = ANON;
        changed = true;
      }
      return true;
    }
    if (ans === NS.w16cex && al === 'dateUtc') return !anon;
    return true;
  };
  const before = el.attrs.length;
  el.attrs = el.attrs.filter((a) => a.name.startsWith('xmlns') || keep(attrNs(el, a), localName(a.name), a));
  if (el.attrs.length !== before) changed = true;

  if (ns === NS.w && local === 'rsids') {
    for (const c of elements(el)) scan.rsids.add(getAttr(c, 'w:val') ?? textContent(c));
    if (apply.has('rsid')) drop.push(el);
  } else if ((ns === NS.w14 || ns === NS.w15) && local === 'docId') {
    scan.docIds++;
    if (apply.has('rsid')) drop.push(el);
  } else if (ns === NS.w15 && local === 'presenceInfo') {
    if (anon) drop.push(el);
  } else if (ns === NS.w && local === 'attachedTemplate') {
    if (apply.has('template')) drop.push(el);
  } else if (ns === NS.w && local === 'docVars') {
    for (const v of elements(el)) scan.docVars.push(getAttr(v, 'w:name') ?? '');
    if (apply.has('docvars')) drop.push(el);
  } else if (ns === NS.s && local === 'comments') {
    if (anon && anonNoteRuns(el)) changed = true;
  } else if (ns === NS.s && local === 'author' && el.parent && localName(el.parent.name) === 'authors') {
    seen(textContent(el));
    if (anon && textContent(el) !== ANON) {
      setText(el, ANON);
      changed = true;
    }
  } else if (ns === NS.s && local === 'comment') scan.comments++;
  else if (ns === NS.s && local === 'fileSharing') {
    const u = getAttr(el, 'userName');
    if (u !== undefined) {
      seen(u);
      if (anon) {
        el.attrs = el.attrs.filter((a) => a.name !== 'userName');
        changed = true;
      }
    }
  } else if (ns === NS.tc && local === 'person') {
    seen(getAttr(el, 'displayName') ?? '');
    if (anon) {
      el.attrs = el.attrs.filter((a) => a.name !== 'userId' && a.name !== 'providerId');
      setAttr(el, 'displayName', ANON);
      changed = true;
    }
  } else if (ns === NS.tc && local === 'threadedComment') {
    scan.comments++;
    if (anon && getAttr(el, 'dT') !== undefined) {
      el.attrs = el.attrs.filter((a) => a.name !== 'dT');
      changed = true;
    }
  } else if (ns === NS.x15ac && local === 'absPath') {
    scan.abspath = getAttr(el, 'url');
    if (apply.has('abspath')) {
      // drop the whole mc:AlternateContent wrapper when this is all it holds
      const choice = el.parent;
      const alt = choice?.parent;
      const only = (e: XElement | null | undefined) => !!e && elements(e).length === 1;
      drop.push(only(choice) && alt && nsOf(alt) === NS.mc && only(alt) ? alt : el);
    }
  } else if (ns === NS.p && local === 'cmAuthor') {
    seen(getAttr(el, 'name') ?? '');
    if (anon) {
      setAttr(el, 'name', ANON);
      setAttr(el, 'initials', 'A');
      changed = true;
    }
  } else if (ns === NS.p && local === 'cm') {
    scan.comments++;
    if (anon && getAttr(el, 'dt') !== undefined) {
      el.attrs = el.attrs.filter((a) => a.name !== 'dt');
      changed = true;
    }
  } else if (ns === NS.p188 && local === 'author') {
    seen(getAttr(el, 'name') ?? '');
    if (anon) {
      setAttr(el, 'name', ANON);
      setAttr(el, 'initials', 'A');
      setAttr(el, 'userId', ANON);
      setAttr(el, 'providerId', 'None');
      changed = true;
    }
  } else if (ns === NS.v && local === 'AuthorEntry') {
    seen(getAttr(el, 'Name') ?? '');
    if (anon) {
      setAttr(el, 'Name', ANON);
      setAttr(el, 'Initials', 'A');
      el.attrs = el.attrs.filter((a) => a.name !== 'ResolutionID');
      changed = true;
    }
  } else if (ns === NS.v && local === 'CommentEntry') {
    scan.comments++;
    if (anon && (getAttr(el, 'Date') ?? NEUTRAL_DATE) !== NEUTRAL_DATE) {
      setAttr(el, 'Date', NEUTRAL_DATE);
      changed = true;
    }
    if (anon && getAttr(el, 'EditDate') !== undefined) {
      el.attrs = el.attrs.filter((a) => a.name !== 'EditDate');
      changed = true;
    }
  }
  for (const c of el.children) if (c.type === 'element' && walkHidden(c, scan, apply, drop)) changed = true;
  return changed;
}

async function processHidden(o: Ooxml, apply: Set<HiddenKind>): Promise<HiddenScan> {
  const scan: HiddenScan = { authors: new Map(), comments: 0, revisions: 0, rsids: new Set(), docIds: 0, docVars: [] };
  const { pkg } = o;
  for (const e of pkg.zip.entries) {
    if (!HIDDEN_PARTS.test(e.name) || !pkg.parts.has(e.name)) continue;
    const doc = await pkg.parts.tryGet(e.name);
    if (!doc) continue;
    const drop: XElement[] = [];
    let changed = walkHidden(doc.root, scan, apply, drop);
    for (const d of drop) removeNode(d);
    if (drop.length) changed = true;
    if (changed) pkg.parts.touch(e.name);
  }
  // Word's attached template lives in the settings part's relationships.
  for (const e of pkg.zip.entries) {
    if (!/^word\/settings\.xml$/i.test(e.name)) continue;
    for (const r of await pkg.rels(e.name)) {
      if (!REL.template.includes(r.type)) continue;
      scan.template = r.target;
      if (apply.has('template')) {
        removeNode(r.el);
        pkg.parts.touch(relsPathOf(e.name));
      }
    }
  }
  return scan;
}

function hiddenGroup(scan: HiddenScan, extra: Field[]): FieldGroup {
  const fields: Field[] = [];
  if (scan.authors.size) {
    const parts: string[] = [];
    if (scan.comments) parts.push(`${scan.comments} comment${scan.comments > 1 ? 's' : ''}`);
    if (scan.revisions) parts.push(`${scan.revisions} tracked change${scan.revisions > 1 ? 's' : ''}`);
    fields.push(
      rawField('ooxml:hidden:authors', 'Comment & revision authors', `${[...scan.authors.keys()].join(', ')}${parts.length ? ` — ${parts.join(', ')}` : ''}`, {
        sensitivity: 'identity',
        tag: 'w:author / authors / cmAuthor',
        description: 'Names (and account ids) stored with comments and tracked changes. Removing renames them to “Author”.',
      }),
    );
  }
  if (scan.rsids.size || scan.docIds) {
    fields.push(
      rawField('ooxml:hidden:rsid', 'Editing session IDs', `${scan.rsids.size} revision session id${scan.rsids.size === 1 ? '' : 's'}${scan.docIds ? ' + document id' : ''}`, {
        sensitivity: 'software',
        tag: 'w:rsid',
        description: 'Random ids Word adds per editing session; they can link documents edited on the same computer.',
      }),
    );
  }
  if (scan.template) {
    fields.push(rawField('ooxml:hidden:template', 'Attached template', scan.template, { sensitivity: 'identity', tag: 'w:attachedTemplate', description: 'The template path often contains the user name.' }));
  }
  if (scan.abspath) {
    fields.push(rawField('ooxml:hidden:abspath', 'Original file location', scan.abspath, { sensitivity: 'identity', tag: 'x15ac:absPath', description: 'The folder the workbook was last saved in.' }));
  }
  if (scan.docVars.length) {
    const n = scan.docVars.length;
    fields.push(
      rawField('ooxml:hidden:docvars', 'Document variables', `${n} variable${n > 1 ? 's' : ''}: ${listDisplay(scan.docVars)}`, {
        sensitivity: 'content',
        tag: 'w:docVars',
        description: 'Named values stored by macros, templates or document-management systems (client numbers, user names…).',
      }),
    );
  }
  fields.push(...extra);
  return { id: 'ooxml.hidden', label: 'Hidden personal information', source: 'OOXML', fields };
}

/** "a, b, c, +2 more" */
function listDisplay(items: string[], max = 4): string {
  return items.length > max ? `${items.slice(0, max).join(', ')}, +${items.length - max} more` : items.join(', ');
}

// ----------------------------------------------------- document server

/** Root namespaces of customXml items written by SharePoint and other document-management servers. */
const SERVER_NS: Record<string, string> = {
  'http://schemas.microsoft.com/office/2006/metadata/properties': 'document-management properties',
  'http://schemas.microsoft.com/office/2006/metadata/contentType': 'content type',
  'http://schemas.microsoft.com/office/2006/metadata/longProperties': 'long properties',
  'http://schemas.microsoft.com/office/2006/metadata/customXsn': 'form template',
  'http://schemas.microsoft.com/sharepoint/v3/contenttype/forms': 'content-type forms',
  'http://schemas.microsoft.com/sharepoint/events': 'event receivers',
};

interface ServerItem {
  part: string;
  /** its itemProps parts */
  props: string[];
  what: string;
  text: string;
}

/** customXml items holding server properties; other custom XML (bibliography, content-control data) is left alone. */
async function serverItems(o: Ooxml): Promise<ServerItem[]> {
  const { pkg } = o;
  const candidates = new Set(pkg.zip.entries.map((e) => e.name).filter((n) => /^customXml\/[^/]+\.xml$/i.test(n)));
  for (const { owner } of pkg.relsParts()) {
    for (const r of await pkg.rels(owner)) if (!r.external && REL.customXml.includes(r.type)) candidates.add(pkg.parts.entry(r.target) ?? r.target);
  }
  const out: ServerItem[] = [];
  for (const part of candidates) {
    const doc = pkg.parts.has(part) ? await pkg.parts.tryGet(part) : null;
    const what = doc ? SERVER_NS[nsOf(doc.root) ?? ''] : undefined;
    if (!doc || !what) continue;
    const props = (await pkg.rels(part)).filter((r) => !r.external).map((r) => r.target);
    out.push({ part, props, what, text: leafTexts(doc.root).join(' ') });
  }
  return out;
}

/** Values of the leaf elements (properties are one element each). */
function leafTexts(el: XElement, out: string[] = []): string[] {
  const kids = elements(el);
  if (!kids.length) {
    const t = textContent(el).replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  }
  for (const c of kids) leafTexts(c, out);
  return out;
}

function serverField(items: ServerItem[]): Field | null {
  if (!items.length) return null;
  const display = items.map((i) => (i.text ? `${i.what} (${i.text.length > 80 ? `${i.text.slice(0, 80)}…` : i.text})` : i.what)).join(', ');
  return rawField('ooxml:hidden:server', 'Document server properties', display, {
    sensitivity: 'identity',
    tag: 'customXml',
    description: 'Properties a SharePoint or document-management server attached: owners, account ids, content type, server addresses.',
  });
}

async function removeServerItems(o: Ooxml, items: ServerItem[]): Promise<void> {
  for (const i of items) {
    for (const p of i.props) await o.pkg.removePart(p);
    await o.pkg.removePart(i.part);
  }
}

// ----------------------------------------------------- printer settings

const PRINTER_PART = /(^|\/)printerSettings\/[^/]+\.bin$/i;

async function printerParts(o: Ooxml): Promise<string[]> {
  const out: string[] = [];
  for (const e of o.pkg.zip.entries) {
    if (!o.pkg.parts.has(e.name)) continue;
    if (PRINTER_PART.test(e.name) || /\.printerSettings$/.test((await o.pkg.contentType(e.name)) ?? '')) out.push(e.name);
  }
  return out;
}

/** dmDeviceName of a Windows DEVMODE (the first 32 UTF-16 characters). */
function printerName(bin: Uint8Array): string | null {
  if (bin.length < 64) return null;
  const name = trimNul(utf16(bin.subarray(0, 64), true)).trim();
  return name.length > 1 && /^[^\0-\x1f\ufffd]+$/.test(name) ? name : null;
}

async function printerField(o: Ooxml, parts: string[]): Promise<Field | null> {
  if (!parts.length) return null;
  const names = new Set<string>();
  for (const p of parts) {
    try {
      const name = printerName(await o.pkg.zip.read(p));
      if (name) names.add(name);
    } catch {
      /* unreadable: still listed (and removed) */
    }
  }
  const display = names.size ? [...names].join(', ') : `${parts.length} printer settings part${parts.length > 1 ? 's' : ''}`;
  return rawField('ooxml:hidden:printer', 'Printer', display, { sensitivity: 'device', tag: 'printerSettings', description: 'The printer last used, with its driver settings.' });
}

async function removePrinterParts(o: Ooxml, parts: string[]): Promise<void> {
  const exts = new Set<string>();
  for (const p of parts) {
    exts.add(p.slice(p.lastIndexOf('.') + 1));
    await o.pkg.removePart(p, true);
  }
  for (const ext of exts) await o.pkg.pruneDefault(ext);
}

// ---------------------------------------------------------- local links

/**
 * A target naming a file by an absolute disk or network path (file:///…, C:\…,
 * \\server\…, /Users/…). Relative links are left alone: they only work beside
 * the document and name no outside folder.
 */
function isLocalPath(target: string): boolean {
  return /^file:/i.test(target) || /^[a-z]:[\\/]/i.test(target) || /^[\\/]/.test(target);
}

/** "file:///C:/Users/jane/Budget.xlsx#Sheet1" -> "Budget.xlsx#Sheet1" */
function bareName(target: string): string {
  const hash = target.indexOf('#');
  const fragment = hash < 0 ? '' : target.slice(hash);
  let path = hash < 0 ? target : target.slice(0, hash);
  const q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  path = path.replace(/[\\/]+$/, '');
  return `${path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) || '.'}${fragment}`;
}

/** External relationships that point into folders (the attached template is handled on its own). */
async function localLinks(o: Ooxml): Promise<Array<{ path: string; rel: Rel }>> {
  const out: Array<{ path: string; rel: Rel }> = [];
  for (const { path, owner } of o.pkg.relsParts()) {
    for (const rel of await o.pkg.rels(owner)) {
      if (rel.external && !REL.template.includes(rel.type) && isLocalPath(rel.target) && bareName(rel.target) !== rel.target) out.push({ path, rel });
    }
  }
  return out;
}

function linksField(links: Array<{ rel: Rel }>): Field | null {
  if (!links.length) return null;
  const targets = [...new Set(links.map((l) => l.rel.target))];
  return rawField('ooxml:hidden:links', 'Linked file paths', listDisplay(targets, 3), {
    sensitivity: 'identity',
    tag: 'TargetMode="External"',
    description: 'Links to files on a disk or network share; the folders often contain user or server names. Removing keeps only the file names.',
  });
}

function reduceLinks(o: Ooxml, links: Array<{ path: string; rel: Rel }>): void {
  for (const { path, rel } of links) {
    setAttr(rel.el, 'Target', bareName(rel.target));
    o.pkg.parts.touch(path);
  }
}

// --------------------------------------------------------------- media

const MEDIA: MediaSpec = { group: 'ooxml.media', prefix: 'ooxml:media:', source: 'OOXML' };

const PICTURE_EXT = /\.(jpe?g|jfif|png|gif|tiff?|webp|hei[cf]|avif)$/i;

/**
 * Picture parts: an image content type, or a picture extension in a media
 * folder (audio and video there are not read). The package thumbnail is listed
 * on its own.
 */
async function mediaParts(o: Ooxml): Promise<string[]> {
  const out: string[] = [];
  const thumb = o.thumbnail?.toLowerCase();
  for (const e of o.pkg.zip.entries) {
    if (e.name.endsWith('/') || e.name.toLowerCase() === thumb || !o.pkg.parts.has(e.name)) continue;
    if ((/(^|\/)media\//i.test(e.name) && PICTURE_EXT.test(e.name)) || /^image\//i.test((await o.pkg.contentType(e.name)) ?? '')) out.push(e.name);
  }
  return out;
}

// ---------------------------------------------------------------- other

/** docProps parts other than core/app/custom/thumbnail (e.g. Apple's docProps/meta.xml). */
function extraPropParts(o: Ooxml): string[] {
  const known = new Set([o.core, o.app, o.custom, o.thumbnail].filter(Boolean).map((s) => s!.toLowerCase()));
  return o.pkg.zip.entries.map((e) => e.name).filter((n) => /^docProps\/[^/]+$/i.test(n) && !known.has(n.toLowerCase()) && o.pkg.parts.has(n));
}

async function otherGroup(o: Ooxml): Promise<FieldGroup> {
  const fields: Field[] = [];
  if (o.thumbnail && o.pkg.parts.has(o.thumbnail)) {
    const data = await o.pkg.zip.read(o.pkg.parts.entry(o.thumbnail)!);
    const img = imageValue(data);
    fields.push(
      makeField({ id: 'ooxml:thumbnail', label: 'Thumbnail', kind: 'image', sensitivity: 'content', tag: o.thumbnail }, img, {
        editable: false,
        display: describeImage(img),
      }),
    );
  }
  for (const name of extraPropParts(o)) {
    const doc = await o.pkg.parts.tryGet(name);
    const text = doc ? textContent(doc.root).replace(/\s+/g, ' ').trim() : '';
    const size = o.pkg.zip.get(name)?.size ?? 0;
    fields.push(
      rawField(`ooxml:part:${name}`, `Extra property part (${name.slice(name.lastIndexOf('/') + 1)})`, text ? text.slice(0, 120) : formatBytes(size), {
        sensitivity: 'software',
        tag: name,
      }),
    );
  }
  return { id: 'ooxml.other', label: 'Embedded data', source: 'OOXML', fields };
}

// ----------------------------------------------------------------- API

export async function readOoxml(src: Source): Promise<Metadata> {
  const o = await openOoxml(src);
  const warnings: string[] = [];
  const info: InfoItem[] = [];
  if (o.variant) info.push({ label: 'Format', value: o.variant.name });
  else warnings.push('Unknown Office document type; only package properties are shown.');

  const load = async (part?: string) => {
    if (!part) return null;
    try {
      return (await o.pkg.parts.get(part))?.root ?? null;
    } catch (e) {
      warnings.push(`${part} could not be parsed: ${(e as Error).message}`);
      return null;
    }
  };
  const groups: FieldGroup[] = [coreGroup(await load(o.core)), appGroup(await load(o.app), info), customGroup(await load(o.custom))];
  const extra = [serverField(await serverItems(o)), await printerField(o, await printerParts(o)), linksField(await localLinks(o))];
  groups.push(hiddenGroup(await processHidden(o, new Set()), extra.filter((f): f is Field => !!f)));
  groups.push(await otherGroup(o));
  const media = await mediaGroup(o.pkg.parts, await mediaParts(o), MEDIA, warnings);
  if (media) groups.push(media);
  if (o.variant?.mime === BINARY_WORKBOOK || /\.bin$/i.test(o.main ?? '')) {
    warnings.push('Binary workbooks (.xlsb) keep sheets, comments and names in binary parts BlueExif cannot read: comment authors and other personal information in them are not shown or removed.');
  }
  if (o.pkg.zip.entries.some((e) => /vbaProject\.bin$/i.test(e.name))) info.push({ label: 'Macros', value: 'VBA project present' });
  if (o.pkg.zip.entries.some((e) => /^_xmlsignatures\//i.test(e.name))) {
    info.push({ label: 'Digital signature', value: 'Yes' });
    warnings.push('This document is digitally signed. Any change invalidates the signature.');
  }
  info.push({ label: 'Package parts', value: String(o.pkg.zip.entries.length) });

  return {
    format: { id: 'ooxml', name: o.variant?.name ?? 'Office document', mime: o.variant?.mime ?? 'application/zip', category: 'document' },
    info,
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: true,
    canStrip: true,
  };
}

async function save(o: Ooxml, normalize: boolean): Promise<Blob> {
  const blob = await rewriteZip(o.pkg.zip, {
    ...o.pkg.parts.finish(),
    normalizeTime: normalize ? ZIP_EPOCH : undefined,
    keepComment: !normalize,
  });
  return new Blob([blob], { type: o.variant?.mime ?? 'application/zip' });
}

export async function writeOoxml(src: Source, edits: Edits): Promise<Blob> {
  const o = await openOoxml(src);
  await applyCoreEdits(o, edits);
  await applyAppEdits(o, edits);
  await applyCustomEdits(o, edits);
  const removed = (id: string) => edits.get(id)?.op === 'remove';
  if (removed('ooxml:thumbnail') && o.thumbnail) await o.pkg.removePart(o.thumbnail);
  for (const name of extraPropParts(o)) if (removed(`ooxml:part:${name}`)) await o.pkg.removePart(name);
  const hidden = new Set(ALL_HIDDEN.filter((k) => removed(`ooxml:hidden:${k}`)));
  if (hidden.size) await processHidden(o, hidden);
  if (removed('ooxml:hidden:server')) await removeServerItems(o, await serverItems(o));
  if (removed('ooxml:hidden:printer')) await removePrinterParts(o, await printerParts(o));
  if (removed('ooxml:hidden:links')) reduceLinks(o, await localLinks(o));
  await applyMediaEdits(o.pkg.parts, await mediaParts(o), MEDIA, edits);
  return save(o, false);
}

export async function stripOoxml(src: Source, opts: StripOptions): Promise<Blob> {
  const o = await openOoxml(src);
  if (o.core) {
    const doc = await o.pkg.parts.tryGet(o.core);
    if (doc) {
      doc.root.children = [];
      o.pkg.parts.touch(o.core);
    }
  }
  if (o.app) {
    const doc = await o.pkg.parts.tryGet(o.app);
    if (doc && scrubApp(doc.root)) o.pkg.parts.touch(o.app);
  }
  if (o.custom) await o.pkg.removePart(o.custom);
  if (o.thumbnail) await o.pkg.removePart(o.thumbnail);
  for (const name of extraPropParts(o)) await o.pkg.removePart(name);
  await processHidden(o, new Set(ALL_HIDDEN));
  await removeServerItems(o, await serverItems(o));
  await removePrinterParts(o, await printerParts(o));
  reduceLinks(o, await localLinks(o));
  await cleanMedia(o.pkg.parts, await mediaParts(o), opts);
  return save(o, true);
}

export const ooxmlHandler: FormatHandler = {
  id: 'ooxml',
  name: 'Office document',
  category: 'document',
  extensions: EXTENSIONS,
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  detect(ctx: DetectContext) {
    const ext = this.extensions.includes(ctx.ext);
    if (isZip(ctx.head) && headHasEntry(ctx.head, '[Content_Types].xml')) return 3;
    if (isZip(ctx.head) && ext) return 2;
    // Encrypted OOXML is an OLE compound file; claim it by extension so read() can explain.
    return ext ? 1 : 0;
  },
  read: readOoxml,
  write: writeOoxml,
  strip: stripOoxml,
};
