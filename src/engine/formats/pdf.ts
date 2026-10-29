/**
 * PDF: document information dictionary (Info), catalog XMP packet and
 * privacy-relevant extras — attachments and associated files, comment
 * (annotation) authors, JavaScript and automatic actions, links to local
 * files, PieceInfo private application data, per-object XMP packets, the
 * document ID, earlier revisions kept by incremental updates and digital
 * signatures (signer, time, place, certificate, validation data).
 *
 * pdf-lib is imported lazily so it is code-split. Every write re-serialises the
 * whole file: incremental updates are flattened and unreachable objects are
 * garbage-collected, so values from earlier revisions or replaced objects never
 * survive. Mapped Info entries and their XMP counterparts are kept in sync.
 *
 * Embedded files are treated as document content (Factur-X/ZUGFeRD invoices,
 * portfolios…): strip keeps them but drops their timestamps and folder paths;
 * they can be removed explicitly through the "Attachments" field. Form field
 * values, XFA and the visible appearance of signature widgets are content too.
 * Strip removes signature values (they are invalidated by any rewrite anyway),
 * scripts and automatic actions, and cuts local file paths in actions down to
 * the file name; web links and links within the document are kept.
 */

import type { PDFArray, PDFContext, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObject, PDFRef, PDFStream, PDFString } from 'pdf-lib';
import { decodeXmlBytes } from '../core/xml';
import { encodeUtf8, formatBytes, indexOfBytes, latin1, toBlob, toHex, utf16, utf8OrLatin1 } from '../core/binary';
import {
  asList,
  asText,
  displayDate,
  makeField,
  rawField,
  requireDate,
  toIso,
  type DateParts,
} from '../core/fields';
import {
  MetadataError,
  groupKey,
  type DetectContext,
  type Edit,
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
import { NS, applyXmpEdits, parseXmp, serializeXmp, xmpFieldId, xmpGroups, xmpValue, type XmpPacket } from '../xmp/xmp';
import { openPdf } from './pdfcrypt';
import { applyEmbeddedImageEdits, embeddedImageGroup, stripEmbeddedImages } from './pdfimages';

type PdfLib = typeof import('pdf-lib');

let libPromise: Promise<PdfLib> | null = null;
/** pdf-lib, loaded on first use (keeps it out of the main bundle). */
const pdfLib = (): Promise<PdfLib> => (libPromise ??= import('pdf-lib'));

interface Pdf {
  lib: PdfLib;
  doc: PDFDocument;
  ctx: PDFContext;
  bytes: Uint8Array;
  /** the file was password protected (it is decrypted in memory and saved without a password) */
  encrypted: boolean;
  cipher?: string;
  /** opening it needs a password (false when only an owner password restricts it) */
  needsPassword: boolean;
}

const INFO_GROUP = 'pdf.info';
const CUSTOM_NEW = 'pdf-custom:new';

interface InfoDef {
  label: string;
  kind: FieldKind;
  sens?: Sensitivity;
  /** canonical XMP property kept in sync */
  xmp?: string;
}

const INFO: Record<string, InfoDef> = {
  Title: { label: 'Title', kind: 'text', sens: 'content', xmp: 'dc:title' },
  Author: { label: 'Author', kind: 'text', sens: 'identity', xmp: 'dc:creator' },
  Subject: { label: 'Subject', kind: 'multiline', sens: 'content', xmp: 'dc:description' },
  Keywords: { label: 'Keywords', kind: 'text', sens: 'content', xmp: 'pdf:Keywords' },
  Creator: { label: 'Creator (application)', kind: 'text', sens: 'software', xmp: 'xmp:CreatorTool' },
  Producer: { label: 'Producer', kind: 'text', sens: 'software', xmp: 'pdf:Producer' },
  CreationDate: { label: 'Created', kind: 'datetime', sens: 'time', xmp: 'xmp:CreateDate' },
  ModDate: { label: 'Modified', kind: 'datetime', sens: 'time', xmp: 'xmp:ModifyDate' },
  Trapped: { label: 'Trapped', kind: 'enum' },
};

const TRAPPED = ['True', 'False', 'Unknown'];

const MARKUP = new Set([
  'Text', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline',
  'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink', 'FileAttachment', 'Sound', 'Redact', 'Popup',
]);

// ------------------------------------------------------------------ dates

const PDF_DATE_RE =
  /^\s*(?:D\s*:\s*)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:([Zz+-])\s*(?:(\d{1,2})\s*'?\s*(?:(\d{2})\s*'?)?)?)?/;

/** Parse a PDF date string `D:YYYYMMDDHHmmSSOHH'mm'` (every part after the year optional). */
export function parsePdfDate(s: string): DateParts | null {
  const m = PDF_DATE_RE.exec(s);
  if (!m) return null;
  const p: DateParts = { year: +m[1] };
  if (m[2]) p.month = +m[2];
  if (m[3]) p.day = +m[3];
  if (m[4]) {
    p.hour = +m[4];
    p.minute = m[5] ? +m[5] : 0;
  }
  if (m[6]) p.second = +m[6];
  if (m[7] && p.hour !== undefined) {
    const off = +(m[8] ?? 0) * 60 + +(m[9] ?? 0);
    p.tz = m[7] === '-' ? -off : /z/i.test(m[7]) ? 0 : off;
  }
  if (p.month !== undefined && (p.month < 1 || p.month > 12)) return null;
  if (p.day !== undefined && (p.day < 1 || p.day > 31)) return null;
  if (p.hour !== undefined && (p.hour > 23 || p.minute! > 59 || (p.second ?? 0) > 59)) return null;
  return p;
}

/** Format date parts as a PDF date string. */
export function formatPdfDate(p: DateParts): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  let s = `D:${pad(p.year, 4)}`;
  if (p.month === undefined) return s;
  s += pad(p.month);
  if (p.day === undefined) return s;
  s += pad(p.day);
  if (p.hour === undefined) return s;
  s += `${pad(p.hour)}${pad(p.minute ?? 0)}${pad(p.second ?? 0)}`;
  if (p.tz === undefined) return s;
  if (p.tz === 0) return `${s}Z`;
  const a = Math.abs(p.tz);
  return `${s}${p.tz < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}'${pad(a % 60)}'`;
}

// ---------------------------------------------------------------- helpers

function headerOffset(b: Uint8Array): number {
  return indexOfBytes(b.subarray(0, Math.min(b.length, 1024)), '%PDF-');
}

async function loadPdf(src: Source): Promise<Pdf> {
  const bytes = await src.bytes();
  if (headerOffset(bytes) < 0) throw new MetadataError('Not a PDF file');
  const lib = await pdfLib();
  const { doc, encrypted, cipher, needsPassword } = await openPdf(lib, bytes, src.password);
  return { lib, doc, ctx: doc.context, bytes, encrypted, cipher, needsPassword };
}

const nm = (pdf: Pdf, s: string) => pdf.lib.PDFName.of(s);

/** Text of a string / name / number / boolean object (refs resolved). */
function textOf(pdf: Pdf, o: PDFObject | undefined): string | undefined {
  const { lib } = pdf;
  const v = o instanceof lib.PDFRef ? pdf.ctx.lookup(o) : o;
  try {
    if (v instanceof lib.PDFString || v instanceof lib.PDFHexString) return v.decodeText().replace(/\0+$/, '');
    if (v instanceof lib.PDFName) return v.decodeText();
    if (v instanceof lib.PDFNumber) return String(v.asNumber());
    if (v instanceof lib.PDFBool) return v.asBoolean() ? 'true' : 'false';
  } catch {
    return undefined;
  }
  return undefined;
}

/** Literal string for printable ASCII, UTF-16BE hex string otherwise. */
function pdfText(pdf: Pdf, s: string): PDFString | PDFHexString {
  const clean = s.replace(/\0/g, '');
  if (/^[\x20-\x7e]*$/.test(clean)) return pdf.lib.PDFString.of(clean.replace(/[\\()]/g, '\\$&'));
  return pdf.lib.PDFHexString.fromText(clean);
}

function dictOf(pdf: Pdf, o: PDFObject | undefined): PDFDict | undefined {
  const v = o instanceof pdf.lib.PDFRef ? pdf.ctx.lookup(o) : o;
  if (v instanceof pdf.lib.PDFDict) return v;
  if (v instanceof pdf.lib.PDFStream) return v.dict;
  return undefined;
}

function arrayOf(pdf: Pdf, o: PDFObject | undefined): PDFObject[] {
  const v = o instanceof pdf.lib.PDFRef ? pdf.ctx.lookup(o) : o;
  return v instanceof pdf.lib.PDFArray ? v.asArray() : [];
}

function streamBytes(pdf: Pdf, s: PDFStream): Uint8Array {
  if (s instanceof pdf.lib.PDFRawStream) return pdf.lib.decodePDFRawStream(s).decode();
  return s.getContents();
}

function xmlText(b: Uint8Array): string {
  if ((b[0] === 0xfe && b[1] === 0xff) || (b[0] === 0xff && b[1] === 0xfe)) return decodeXmlBytes(b);
  return utf8OrLatin1(b);
}

/** Every indirect object's dictionary (stream dictionaries included). */
function allDicts(pdf: Pdf): Array<[PDFRef, PDFDict]> {
  const out: Array<[PDFRef, PDFDict]> = [];
  for (const [ref, o] of pdf.ctx.enumerateIndirectObjects()) {
    const d = dictOf(pdf, o);
    if (d) out.push([ref, d]);
  }
  return out;
}

/** Every dictionary in the file, in object order: those of indirect objects and the direct ones nested in them. */
function everyDict(pdf: Pdf): PDFDict[] {
  const { lib } = pdf;
  const out: PDFDict[] = [];
  const stack: PDFObject[] = pdf.ctx.enumerateIndirectObjects().map(([, o]) => o).reverse();
  const push = (items: PDFObject[]) => {
    for (let i = items.length - 1; i >= 0; i--) if (!(items[i] instanceof lib.PDFRef)) stack.push(items[i]);
  };
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof lib.PDFStream) stack.push(o.dict);
    else if (o instanceof lib.PDFDict) {
      out.push(o);
      push(o.values());
    } else if (o instanceof lib.PDFArray) push(o.asArray());
  }
  return out;
}

/** `o` as a list: the items of an array, or `o` itself. */
function listOf(pdf: Pdf, o: PDFObject | undefined): PDFObject[] {
  const v = o instanceof pdf.lib.PDFRef ? pdf.ctx.lookup(o) : o;
  if (v instanceof pdf.lib.PDFArray) return v.asArray();
  return v ? [o!] : [];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function pageDicts(pdf: Pdf): PDFDict[] {
  try {
    return pdf.doc.getPages().map((p) => p.node);
  } catch {
    return [];
  }
}

function infoDict(pdf: Pdf): PDFDict | undefined {
  const o = pdf.ctx.lookup(pdf.ctx.trailerInfo.Info);
  return o instanceof pdf.lib.PDFDict ? o : undefined;
}

// ------------------------------------------------------------------- XMP

interface CatalogXmp {
  ref?: PDFRef;
  packet: XmpPacket | null;
  error?: string;
}

function catalogXmp(pdf: Pdf): CatalogXmp {
  const raw = pdf.doc.catalog.get(nm(pdf, 'Metadata'));
  if (!raw) return { packet: null };
  const ref = raw instanceof pdf.lib.PDFRef ? raw : undefined;
  const stream = pdf.ctx.lookup(raw);
  if (!(stream instanceof pdf.lib.PDFStream)) return { ref, packet: null, error: 'The XMP metadata stream is invalid' };
  try {
    return { ref, packet: parseXmp(xmlText(streamBytes(pdf, stream))) };
  } catch (e) {
    return { ref, packet: null, error: `XMP could not be parsed: ${(e as Error).message}` };
  }
}

/** Store `p` as the catalog's (uncompressed, as PDF/A requires) metadata stream. */
function writeCatalogXmp(pdf: Pdf, p: XmpPacket, ref?: PDFRef): void {
  const catalog = pdf.doc.catalog;
  if (!p.props.length) {
    catalog.delete(nm(pdf, 'Metadata'));
    return;
  }
  const stream = pdf.ctx.stream(encodeUtf8(serializeXmp(p)), { Type: 'Metadata', Subtype: 'XML' });
  if (ref) pdf.ctx.assign(ref, stream);
  else catalog.set(nm(pdf, 'Metadata'), pdf.ctx.register(stream));
}

// ---------------------------------------------------------------- extras

interface Attachment {
  name: string;
  size?: number;
  spec?: PDFDict;
}

function walkNameTree(pdf: Pdf, node: PDFDict | undefined, out: Array<[string, PDFObject]>, depth = 0): void {
  if (!node || depth > 32) return;
  const names = arrayOf(pdf, node.get(nm(pdf, 'Names')));
  for (let i = 0; i + 1 < names.length; i += 2) out.push([textOf(pdf, names[i]) ?? '', names[i + 1]]);
  for (const kid of arrayOf(pdf, node.get(nm(pdf, 'Kids')))) walkNameTree(pdf, dictOf(pdf, kid), out, depth + 1);
}

function fileSpecInfo(pdf: Pdf, specObj: PDFObject | undefined, fallback: string): Attachment {
  const spec = dictOf(pdf, specObj);
  if (!spec) return { name: fallback };
  const name = textOf(pdf, spec.get(nm(pdf, 'UF'))) ?? textOf(pdf, spec.get(nm(pdf, 'F'))) ?? fallback;
  const ef = dictOf(pdf, spec.get(nm(pdf, 'EF')));
  const streamObj = ef ? pdf.ctx.lookup(ef.get(nm(pdf, 'UF')) ?? ef.get(nm(pdf, 'F'))) : undefined;
  let size: number | undefined;
  if (streamObj instanceof pdf.lib.PDFStream) {
    const params = dictOf(pdf, streamObj.dict.get(nm(pdf, 'Params')));
    const s = Number(textOf(pdf, params?.get(nm(pdf, 'Size'))));
    size = Number.isFinite(s) && s > 0 ? s : streamObj instanceof pdf.lib.PDFRawStream ? streamObj.contents.length : undefined;
  }
  return { name: name || fallback, size, spec };
}

/** Objects carrying associated files (/AF, PDF 2.0): the catalog, pages, annotations, XObjects, structure elements… */
const afHolders = (pdf: Pdf) => everyDict(pdf).filter((d) => d.has(nm(pdf, 'AF')));

function attachments(pdf: Pdf): Attachment[] {
  const out: Attachment[] = [];
  const seen = new Set<PDFDict>();
  const add = (spec: PDFObject | undefined, fallback: string) => {
    const a = fileSpecInfo(pdf, spec, fallback);
    if (a.spec && seen.has(a.spec)) return;
    if (a.spec) seen.add(a.spec);
    out.push(a);
  };
  const names = dictOf(pdf, pdf.doc.catalog.get(nm(pdf, 'Names')));
  const tree: Array<[string, PDFObject]> = [];
  walkNameTree(pdf, dictOf(pdf, names?.get(nm(pdf, 'EmbeddedFiles'))), tree);
  for (const [key, spec] of tree) add(spec, key || 'attachment');
  for (const a of annotations(pdf)) {
    if (a.subtype === 'FileAttachment') add(a.dict.get(nm(pdf, 'FS')), 'attachment');
  }
  for (const d of afHolders(pdf)) for (const spec of arrayOf(pdf, d.get(nm(pdf, 'AF')))) add(spec, 'associated file');
  return out;
}

interface Annot {
  dict: PDFDict;
  subtype: string;
  page: PDFDict;
}

function annotations(pdf: Pdf): Annot[] {
  const out: Annot[] = [];
  for (const page of pageDicts(pdf)) {
    for (const a of arrayOf(pdf, page.get(nm(pdf, 'Annots')))) {
      const dict = dictOf(pdf, a);
      if (dict) out.push({ dict, page, subtype: textOf(pdf, dict.get(nm(pdf, 'Subtype'))) ?? '' });
    }
  }
  return out;
}

/** Markup annotations (comments) — their /T is the author (for widgets it is a field name). */
const markupAnnots = (pdf: Pdf) => annotations(pdf).filter((a) => MARKUP.has(a.subtype));

function pieceInfoHolders(pdf: Pdf): PDFDict[] {
  return allDicts(pdf)
    .map(([, d]) => d)
    .filter((d) => d.has(nm(pdf, 'PieceInfo')));
}

/** Total size of the streams reachable from `o` (bounded walk). */
function reachableStreamBytes(pdf: Pdf, o: PDFObject | undefined): number {
  let total = 0;
  const seen = new Set<PDFObject>();
  const stack: Array<PDFObject | undefined> = [o];
  while (stack.length && seen.size < 10_000) {
    const cur = stack.pop();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    if (cur instanceof pdf.lib.PDFRef) stack.push(pdf.ctx.lookup(cur));
    else if (cur instanceof pdf.lib.PDFDict) stack.push(...cur.values());
    else if (cur instanceof pdf.lib.PDFArray) stack.push(...cur.asArray());
    else if (cur instanceof pdf.lib.PDFRawStream) {
      total += cur.contents.length;
      stack.push(cur.dict);
    }
  }
  return total;
}

/** Objects other than the catalog that carry their own /Metadata stream. */
function objectXmpHolders(pdf: Pdf): PDFDict[] {
  const catalog = pdf.doc.catalog;
  return allDicts(pdf)
    .map(([, d]) => d)
    .filter((d) => d !== catalog && d.has(nm(pdf, 'Metadata')));
}

function holderKind(pdf: Pdf, d: PDFDict): string {
  const type = textOf(pdf, d.get(nm(pdf, 'Type')));
  const sub = textOf(pdf, d.get(nm(pdf, 'Subtype')));
  if (type === 'Page') return 'page';
  if (sub === 'Image') return 'image';
  if (sub === 'Form') return 'form';
  if (type?.startsWith('Font')) return 'font';
  return (type ?? sub ?? 'object').toLowerCase();
}

function idHex(pdf: Pdf): string | null {
  const first = arrayOf(pdf, pdf.ctx.trailerInfo.ID)[0];
  if (first instanceof pdf.lib.PDFHexString || first instanceof pdf.lib.PDFString) return toHex(first.asBytes(), 32).replace(/ /g, '');
  return null;
}

/** Number of revisions appended after the original file (incremental updates). */
function earlierRevisions(bytes: Uint8Array): number {
  let n = 0;
  for (let i = indexOfBytes(bytes, '%%EOF'); i >= 0; i = indexOfBytes(bytes, '%%EOF', i + 5)) n++;
  const linearized = indexOfBytes(bytes.subarray(0, 2048), '/Linearized') >= 0;
  return Math.max(0, n - 1 - (linearized ? 1 : 0));
}

// ------------------------------------------------------------ signatures

interface Signature {
  /** the signature field, which holds the value as /V */
  field: PDFDict;
  /** the signature dictionary: signer, time, place and the PKCS#7 blob with the certificate */
  value: PDFDict;
  /** the field's partial name */
  name: string;
}

/** Signed signature fields, in field-tree order (then signed widgets the tree does not list). */
function signatures(pdf: Pdf): Signature[] {
  const out: Signature[] = [];
  const seen = new Set<PDFDict>();
  const visit = (o: PDFObject | undefined, inherited: string | undefined, depth: number) => {
    const f = dictOf(pdf, o);
    if (!f || depth > 16 || seen.has(f)) return;
    seen.add(f);
    const type = textOf(pdf, f.get(nm(pdf, 'FT'))) ?? inherited;
    const value = type === 'Sig' ? dictOf(pdf, f.get(nm(pdf, 'V'))) : undefined;
    if (value) out.push({ field: f, value, name: textOf(pdf, f.get(nm(pdf, 'T'))) ?? '' });
    for (const k of arrayOf(pdf, f.get(nm(pdf, 'Kids')))) visit(k, type, depth + 1);
  };
  const form = dictOf(pdf, pdf.doc.catalog.get(nm(pdf, 'AcroForm')));
  for (const f of arrayOf(pdf, form?.get(nm(pdf, 'Fields')))) visit(f, undefined, 0);
  for (const a of annotations(pdf)) {
    if (a.subtype !== 'Widget') continue;
    let top = a.dict;
    for (let i = 0, p = dictOf(pdf, top.get(nm(pdf, 'Parent'))); p && i < 16; i++, p = dictOf(pdf, top.get(nm(pdf, 'Parent')))) top = p;
    visit(top, undefined, 0);
  }
  return out;
}

/** One DER element: its tag and the extent of its contents. */
interface Der {
  tag: number;
  body: number;
  end: number;
}

function der(b: Uint8Array, p: number, end: number): Der | null {
  if (p + 2 > end || (b[p] & 0x1f) === 0x1f) return null;
  let len = b[p + 1];
  let q = p + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (!n || n > 4 || q + n > end) return null; // indefinite (BER) or absurd length
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[q++];
  }
  return q + len <= end ? { tag: b[p], body: q, end: q + len } : null;
}

function derKids(b: Uint8Array, e: Der | undefined): Der[] {
  const out: Der[] = [];
  for (let p = e?.body ?? 0; e && p < e.end; ) {
    const k = der(b, p, e.end);
    if (!k) break;
    out.push(k);
    p = k.end;
  }
  return out;
}

const derHex = (b: Uint8Array, e: Der) => toHex(b.subarray(e.body, e.end), Infinity).replace(/ /g, '');

const OID_SIGNED_DATA = '2a864886f70d010702';
/** commonName, organizationName, emailAddress */
const OID_CN = '550403';
const OID_O = '55040a';
const OID_EMAIL = '2a864886f70d010901';

function derString(b: Uint8Array, e: Der): string {
  const v = b.subarray(e.body, e.end);
  if (e.tag === 0x1e) return utf16(v, false); // BMPString
  return e.tag === 0x0c ? utf8OrLatin1(v) : latin1(v);
}

/** "Common Name <e-mail>, Organization" of an X.501 Name. */
function derName(b: Uint8Array, name: Der): string {
  const got = new Map<string, string>();
  for (const rdn of derKids(b, name)) {
    for (const atv of derKids(b, rdn)) {
      const [type, value] = derKids(b, atv);
      if (type?.tag === 0x06 && value && !got.has(derHex(b, type))) got.set(derHex(b, type), derString(b, value).trim());
    }
  }
  const cn = got.get(OID_CN);
  const email = got.get(OID_EMAIL);
  const org = got.get(OID_O);
  const who = [cn, email && (cn ? `<${email}>` : email)].filter(Boolean).join(' ');
  return [who, org].filter(Boolean).join(', ');
}

/** Serial number and subject of a DER certificate. */
function certificate(b: Uint8Array, cert: Der | null | undefined): { serial: string; subject: string } | null {
  const tbs = derKids(b, cert ?? undefined)[0];
  if (cert?.tag !== 0x30 || tbs?.tag !== 0x30) return null;
  const k = derKids(b, tbs);
  const [serial, , , , subject] = k[0]?.tag === 0xa0 ? k.slice(1) : k;
  if (serial?.tag !== 0x02 || subject?.tag !== 0x30) return null;
  return { serial: derHex(b, serial), subject: derName(b, subject) };
}

/** Subject of the signer's certificate in a PKCS#7 / CMS SignedData blob. */
function signerSubject(b: Uint8Array): string {
  const top = der(b, 0, b.length);
  const [type, content] = derKids(b, top ?? undefined);
  if (type?.tag !== 0x06 || derHex(b, type) !== OID_SIGNED_DATA || content?.tag !== 0xa0) return '';
  const parts = derKids(b, derKids(b, content)[0]);
  const certs = derKids(b, parts.find((e) => e.tag === 0xa0))
    .map((c) => certificate(b, c))
    .filter((c) => c !== null);
  // The signer's certificate is the one its SignerInfo names by issuer and serial number.
  const infos = parts[parts.length - 1];
  const sid = infos?.tag === 0x31 ? derKids(b, derKids(b, infos)[0])[1] : undefined;
  const serial = sid?.tag === 0x30 ? derKids(b, sid)[1] : undefined;
  const hex = serial?.tag === 0x02 ? derHex(b, serial) : undefined;
  return (certs.find((c) => c.serial === hex) ?? certs[0])?.subject ?? '';
}

function stringBytes(pdf: Pdf, o: PDFObject | undefined): Uint8Array | undefined {
  const v = o instanceof pdf.lib.PDFRef ? pdf.ctx.lookup(o) : o;
  return v instanceof pdf.lib.PDFString || v instanceof pdf.lib.PDFHexString ? v.asBytes() : undefined;
}

/** "Signer <mail>, Org — adbe.pkcs7.detached (2.1 KB)" for a signature dictionary. */
function signatureSummary(pdf: Pdf, sig: PDFDict): string {
  const contents = stringBytes(pdf, sig.get(nm(pdf, 'Contents'))) ?? new Uint8Array(0);
  // adbe.x509.rsa_sha1 keeps the certificates in /Cert, the others inside the PKCS#7 blob
  const cert = stringBytes(pdf, listOf(pdf, sig.get(nm(pdf, 'Cert')))[0]);
  let subject = cert ? (certificate(cert, der(cert, 0, cert.length))?.subject ?? '') : '';
  if (!subject) subject = signerSubject(contents);
  const top = der(contents, 0, contents.length);
  let size = top?.end ?? contents.length;
  while (!top && size > 0 && contents[size - 1] === 0) size--; // zero padding of the reserved space
  const sub = textOf(pdf, sig.get(nm(pdf, 'SubFilter'))) ?? textOf(pdf, sig.get(nm(pdf, 'Filter'))) ?? 'signature';
  return [subject, `${sub} (${formatBytes(size)})`].filter(Boolean).join(' — ');
}

const SIG_GROUP = 'pdf.signatures';

const SIG_KEYS: Array<[key: string, label: string, sens: Sensitivity]> = [
  ['Name', 'Signer name', 'identity'],
  ['M', 'Signing time', 'time'],
  ['Location', 'Signing location', 'location'],
  ['Reason', 'Signing reason', 'content'],
  ['ContactInfo', 'Signer contact', 'identity'],
];

function signatureGroup(pdf: Pdf): FieldGroup {
  const fields: Field[] = [];
  const sigs = signatures(pdf);
  sigs.forEach((s, i) => {
    const pre = sigs.length > 1 ? `${s.name || `Signature ${i + 1}`}: ` : '';
    const id = (k: string) => `pdfsig:${i + 1}:${k}`;
    for (const [key, label, sensitivity] of SIG_KEYS) {
      const text = textOf(pdf, s.value.get(nm(pdf, key)))?.trim();
      if (!text) continue;
      const base: FieldSpec = { id: id(key), label: pre + label, kind: 'text', sensitivity, tag: `/${key}` };
      const date = key === 'M' ? parsePdfDate(text) : null;
      if (date) {
        const iso = toIso(date);
        fields.push(makeField({ ...base, kind: 'datetime' }, iso, { editable: false, display: displayDate(iso) }));
      } else fields.push(makeField(base, text, { editable: false }));
    }
    const stamp = textOf(pdf, s.value.get(nm(pdf, 'Type'))) === 'DocTimeStamp';
    fields.push(
      rawField(id('cert'), pre + (stamp ? 'Document timestamp' : 'Signer certificate'), signatureSummary(pdf, s.value), {
        sensitivity: stamp ? 'time' : 'identity',
        tag: '/Contents',
        description: 'The signature value, with the certificate of whoever signed it. Removing it removes the whole signature value; the signature drawn on the page stays.',
      }),
    );
  });
  const catalog = pdf.doc.catalog;
  const dss = dictOf(pdf, catalog.get(nm(pdf, 'DSS')));
  if (dss) {
    const n = (k: string) => arrayOf(pdf, dss.get(nm(pdf, k))).length;
    const parts = [plural(n('Certs'), 'certificate'), plural(n('OCSPs'), 'OCSP response'), plural(n('CRLs'), 'revocation list')].filter((p) => !p.startsWith('0 '));
    fields.push(
      rawField('pdfsig:dss', 'Validation data', parts.join(', ') || 'Empty', {
        sensitivity: 'identity',
        tag: '/DSS',
        description: 'Certificates and revocation data kept for long-term validation of the signatures.',
      }),
    );
  }
  const perms = dictOf(pdf, catalog.get(nm(pdf, 'Perms')));
  if (perms?.keys().length) {
    fields.push(
      rawField('pdfsig:perms', 'Signature permissions', perms.keys().map((k) => k.decodeText()).join(', '), {
        sensitivity: 'software',
        tag: '/Perms',
        description: 'Certification (DocMDP) and usage-rights (UR3) signatures.',
      }),
    );
  }
  return { id: SIG_GROUP, label: 'Digital signatures', source: 'PDF', fields, removable: true };
}

/** Drop the value of one signature field (it stays as an unsigned field with its appearance). */
function removeSignatureValue(pdf: Pdf, s: Signature): void {
  s.field.delete(nm(pdf, 'V'));
  const perms = dictOf(pdf, pdf.doc.catalog.get(nm(pdf, 'Perms')));
  for (const [k, v] of perms?.entries() ?? []) if (dictOf(pdf, v) === s.value) perms!.delete(k);
  if (perms && !perms.keys().length) pdf.doc.catalog.delete(nm(pdf, 'Perms'));
}

/** SigFlags (signatures exist, append only) must not outlive the signatures. */
function tidySigFlags(pdf: Pdf): void {
  if (signatures(pdf).length) return;
  dictOf(pdf, pdf.doc.catalog.get(nm(pdf, 'AcroForm')))?.delete(nm(pdf, 'SigFlags'));
}

function removeSignatures(pdf: Pdf): void {
  for (const s of signatures(pdf)) removeSignatureValue(pdf, s);
  pdf.doc.catalog.delete(nm(pdf, 'Perms'));
  pdf.doc.catalog.delete(nm(pdf, 'DSS'));
  // signature dictionaries still referenced some other way (an unusual field tree) are emptied
  for (const d of everyDict(pdf)) {
    if (!/^(?:Sig|DocTimeStamp)$/.test(textOf(pdf, d.get(nm(pdf, 'Type'))) ?? '')) continue;
    for (const k of d.keys()) if (k.decodeText() !== 'Type') d.delete(k);
  }
  tidySigFlags(pdf);
}

function applySignatureEdits(pdf: Pdf, edits: Edits): void {
  if (edits.get(groupKey(SIG_GROUP))?.op === 'remove') return removeSignatures(pdf);
  const sigs = signatures(pdf);
  let changed = false;
  for (const [id, e] of edits) {
    if (e.op !== 'remove') continue;
    if (id === 'pdfsig:dss') pdf.doc.catalog.delete(nm(pdf, 'DSS'));
    if (id === 'pdfsig:perms') pdf.doc.catalog.delete(nm(pdf, 'Perms'));
    const m = /^pdfsig:(\d+):(\w+)$/.exec(id);
    const s = m ? sigs[+m[1] - 1] : undefined;
    if (!s) continue;
    if (m![2] === 'cert') {
      removeSignatureValue(pdf, s);
      changed = true;
    } else if (SIG_KEYS.some(([k]) => k === m![2])) s.value.delete(nm(pdf, m![2]));
  }
  if (changed) tidySigFlags(pdf);
}

// ------------------------------------------------------- scripts, actions

const ACTION_KEYS = ['OpenAction', 'A'];
/** actions that open another file */
const FILE_ACTIONS = new Set(['Launch', 'GoToR', 'GoToE', 'ImportData']);
const WEB_URL = /^\s*(?:https?|ftps?|mailto):/i;

const isAction = (pdf: Pdf, d: PDFDict | undefined): d is PDFDict => !!d && d.get(nm(pdf, 'S')) instanceof pdf.lib.PDFName;
const isJs = (pdf: Pdf, d: PDFDict) => textOf(pdf, d.get(nm(pdf, 'S'))) === 'JavaScript';

/** Where an action hangs: /OpenAction, /A, or a trigger of an additional-actions (/AA) dictionary. */
interface Slot {
  holder: PDFDict;
  key: PDFName;
  trigger: boolean;
}

function actionSlots(pdf: Pdf): Slot[] {
  const out: Slot[] = [];
  for (const d of everyDict(pdf)) {
    for (const k of ACTION_KEYS) if (isAction(pdf, dictOf(pdf, d.get(nm(pdf, k))))) out.push({ holder: d, key: nm(pdf, k), trigger: false });
    const aa = dictOf(pdf, d.get(nm(pdf, 'AA')));
    for (const [key, v] of aa?.entries() ?? []) if (isAction(pdf, dictOf(pdf, v))) out.push({ holder: aa!, key, trigger: true });
  }
  return out;
}

/** The actions of the chain starting at `o`: the action and its /Next ones. */
function actionChain(pdf: Pdf, o: PDFObject | undefined, out = new Set<PDFDict>(), depth = 0): Set<PDFDict> {
  for (const item of listOf(pdf, o)) {
    const d = dictOf(pdf, item);
    if (!isAction(pdf, d) || out.has(d) || depth > 64) continue;
    out.add(d);
    actionChain(pdf, d.get(nm(pdf, 'Next')), out, depth + 1);
  }
  return out;
}

/** JavaScript of an action: JavaScript actions, and rendition actions with a /JS script. */
function scriptBytes(pdf: Pdf, d: PDFDict): number | null {
  if (!isJs(pdf, d) && !d.has(nm(pdf, 'JS'))) return null;
  const js = pdf.ctx.lookup(d.get(nm(pdf, 'JS')));
  if (js instanceof pdf.lib.PDFRawStream) return js.contents.length;
  return stringBytes(pdf, js)?.length ?? 0;
}

function javascriptNames(pdf: Pdf): Array<[string, PDFObject]> {
  const names = dictOf(pdf, pdf.doc.catalog.get(nm(pdf, 'Names')));
  const tree: Array<[string, PDFObject]> = [];
  walkNameTree(pdf, dictOf(pdf, names?.get(nm(pdf, 'JavaScript'))), tree);
  return tree;
}

/** "2 document scripts (init, util), 1 script action, 3 automatic actions — 1.2 KB of JavaScript", or '' */
function scriptSummary(pdf: Pdf): string {
  const counted = new Set<PDFDict>();
  let size = 0;
  const scripts = (o: PDFObject | undefined) => {
    let n = 0;
    for (const d of actionChain(pdf, o)) {
      const b = scriptBytes(pdf, d);
      if (b === null) continue;
      n++;
      if (!counted.has(d)) size += b;
      counted.add(d);
    }
    return n;
  };
  const names: string[] = [];
  for (const [name, o] of javascriptNames(pdf)) {
    scripts(o);
    names.push(name || 'unnamed');
  }
  let actions = 0;
  let triggers = 0;
  for (const s of actionSlots(pdf)) {
    const n = scripts(s.holder.get(s.key));
    if (s.trigger) triggers++;
    else if (n) actions++;
  }
  const parts: string[] = [];
  if (names.length) parts.push(`${plural(names.length, 'document script')} (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''})`);
  if (actions) parts.push(plural(actions, 'script action'));
  if (triggers) parts.push(plural(triggers, 'automatic action'));
  return parts.join(', ') + (parts.length && size ? ` — ${formatBytes(size)} of JavaScript` : '');
}

/**
 * The chain `o` without its JavaScript actions, in run order (the /Next links
 * of the actions that are kept are rewritten).
 */
function withoutScripts(pdf: Pdf, o: PDFObject | undefined, seen: Set<PDFDict>, depth = 0): PDFObject[] {
  const out: PDFObject[] = [];
  for (const item of listOf(pdf, o)) {
    const d = dictOf(pdf, item);
    if (!isAction(pdf, d) || seen.has(d) || depth > 64) continue;
    seen.add(d);
    const next = withoutScripts(pdf, d.get(nm(pdf, 'Next')), seen, depth + 1);
    if (isJs(pdf, d)) {
      out.push(...next);
      continue;
    }
    d.delete(nm(pdf, 'JS'));
    if (next.length) d.set(nm(pdf, 'Next'), next.length === 1 ? next[0] : pdf.ctx.obj(next));
    else d.delete(nm(pdf, 'Next'));
    out.push(item);
  }
  return out;
}

/** Remove document JavaScript, JavaScript actions and every additional (automatic) action. */
function removeScripts(pdf: Pdf): void {
  const catalog = pdf.doc.catalog;
  const names = dictOf(pdf, catalog.get(nm(pdf, 'Names')));
  if (names) {
    names.delete(nm(pdf, 'JavaScript'));
    if (!names.keys().length) catalog.delete(nm(pdf, 'Names'));
  }
  for (const d of everyDict(pdf)) d.delete(nm(pdf, 'AA'));
  for (const { holder, key } of actionSlots(pdf)) {
    const v = holder.get(key);
    const [head, ...rest] = withoutScripts(pdf, v, new Set());
    if (!head) {
      holder.delete(key);
      continue;
    }
    if (rest.length) {
      // the removed first action had several successors: they now follow the first one kept
      const h = dictOf(pdf, head)!;
      const next = [...listOf(pdf, h.get(nm(pdf, 'Next'))), ...rest];
      h.set(nm(pdf, 'Next'), next.length === 1 ? next[0] : pdf.ctx.obj(next));
    }
    if (head !== v) holder.set(key, head);
  }
  // scripts still referenced some other way lose their code
  for (const d of everyDict(pdf)) if (isJs(pdf, d)) d.delete(nm(pdf, 'JS'));
}

/** `path` without its folders ("file:///Users/alice/a.pdf" → "a.pdf"); null when it names no folder. */
function bareName(path: string): string | null {
  const parts = path
    .replace(/^\s*file:/i, '')
    .split(/[\\/:]/)
    .filter((p) => p && p !== '.' && p !== '..');
  const name = parts.pop();
  return name !== undefined && parts.length ? name : null;
}

interface FilePath {
  holder: PDFDict;
  key: string;
  path: string;
  /** the file name it is cut down to; null to drop the entry (a folder) */
  bare: string | null;
}

const SPEC_PATHS = ['F', 'UF', 'DOS', 'Mac', 'Unix'];

/** Folder paths in a file specification: a string, or a dictionary's /F, /UF, /DOS, /Mac, /Unix. */
function specPaths(pdf: Pdf, holder: PDFDict, key: string, out: FilePath[], nested = false): void {
  const spec = dictOf(pdf, holder.get(nm(pdf, key)));
  if (spec) {
    if (!nested) for (const k of SPEC_PATHS) specPaths(pdf, spec, k, out, true);
    return;
  }
  const path = textOf(pdf, holder.get(nm(pdf, key)));
  const bare = path === undefined || WEB_URL.test(path) ? null : bareName(path);
  if (path && bare !== null) out.push({ holder, key, path, bare });
}

/** Local files opened by Launch, GoToR, GoToE and ImportData actions and file: links. */
function fileLinks(pdf: Pdf): Array<FilePath & { action: string }> {
  const out: Array<FilePath & { action: string }> = [];
  const seen = new Set<PDFDict>();
  for (const s of actionSlots(pdf)) {
    for (const a of actionChain(pdf, s.holder.get(s.key))) {
      if (seen.has(a)) continue;
      seen.add(a);
      const action = textOf(pdf, a.get(nm(pdf, 'S'))) ?? '';
      const found: FilePath[] = [];
      if (action === 'URI' && /^\s*file:/i.test(textOf(pdf, a.get(nm(pdf, 'URI'))) ?? '')) specPaths(pdf, a, 'URI', found);
      if (FILE_ACTIONS.has(action)) specPaths(pdf, a, 'F', found);
      const win = action === 'Launch' ? dictOf(pdf, a.get(nm(pdf, 'Win'))) : undefined;
      if (win) {
        specPaths(pdf, win, 'F', found);
        const dir = textOf(pdf, win.get(nm(pdf, 'D')));
        if (dir && /[^\\/.:\s]/.test(dir)) found.push({ holder: win, key: 'D', path: dir, bare: null });
      }
      out.push(...found.map((f) => ({ ...f, action })));
    }
  }
  return out;
}

/** Cut file paths down to the file name (and drop Launch folders). */
function reducePaths(pdf: Pdf, paths: FilePath[]): void {
  for (const p of paths) {
    if (p.bare === null) p.holder.delete(nm(pdf, p.key));
    else p.holder.set(nm(pdf, p.key), pdfText(pdf, p.bare));
  }
}

// ----------------------------------------------------------------- read

function guessSensitivity(key: string): Sensitivity {
  if (/author|company|manager|owner|user|name|mail|person/i.test(key)) return 'identity';
  if (/date|time/i.test(key)) return 'time';
  if (/producer|creator|tool|app|version|software/i.test(key)) return 'software';
  return 'content';
}

function infoField(pdf: Pdf, key: string, obj: PDFObject): Field {
  const id = `pdf:${key}`;
  const def = INFO[key];
  const base: FieldSpec = {
    id,
    label: def?.label ?? key.replace(/([a-z])([A-Z])/g, '$1 $2'),
    kind: def?.kind ?? 'text',
    sensitivity: def?.sens ?? guessSensitivity(key),
    tag: `/${key}`,
  };
  const v = obj instanceof pdf.lib.PDFRef ? pdf.ctx.lookup(obj) : obj;
  if (v instanceof pdf.lib.PDFArray) {
    const items = v.asArray().map((x) => textOf(pdf, x));
    if (items.every((x): x is string => x !== undefined)) return makeField({ ...base, kind: 'list' }, items);
  }
  const text = textOf(pdf, v);
  if (text === undefined) return rawField(id, base.label, '(structured value)', { sensitivity: base.sensitivity, tag: base.tag });
  if (key === 'Trapped') {
    const t = TRAPPED.find((x) => x.toLowerCase() === text.toLowerCase()) ?? text;
    return makeField({ ...base, options: TRAPPED.map((x) => ({ value: x, label: x })) }, t);
  }
  if (def?.kind === 'datetime' || (!def && /^\s*D:\d{4}/.test(text))) {
    const p = parsePdfDate(text);
    if (p) {
      const iso = toIso(p);
      return makeField({ ...base, kind: 'datetime' }, iso, { display: displayDate(iso) });
    }
    return makeField({ ...base, kind: 'text' }, text);
  }
  return makeField({ ...base, kind: def?.kind ?? (text.length > 80 || text.includes('\n') ? 'multiline' : 'text') }, text);
}

function infoGroup(pdf: Pdf): FieldGroup {
  const info = infoDict(pdf);
  const fields: Field[] = [];
  const present = new Set<string>();
  const entries = info ? info.entries() : [];
  // standard keys first, in canonical order
  const order = (k: string) => {
    const i = Object.keys(INFO).indexOf(k);
    return i < 0 ? 99 : i;
  };
  entries.sort((a, b) => order(a[0].decodeText()) - order(b[0].decodeText()));
  for (const [k, v] of entries) {
    const key = k.decodeText();
    present.add(key);
    fields.push(infoField(pdf, key, v));
  }
  const addable: FieldSpec[] = Object.entries(INFO)
    .filter(([k]) => !present.has(k))
    .map(([k, d]) => ({
      id: `pdf:${k}`,
      label: d.label,
      kind: d.kind,
      sensitivity: d.sens,
      tag: `/${k}`,
      options: k === 'Trapped' ? TRAPPED.map((x) => ({ value: x, label: x })) : undefined,
    }));
  addable.push({
    id: CUSTOM_NEW,
    label: 'Custom property',
    kind: 'text',
    placeholder: 'Name=Value',
    description: 'Adds a custom entry to the document information dictionary.',
  });
  return { id: INFO_GROUP, label: 'Document info', source: 'PDF Info', fields, addable, removable: true };
}

function extrasGroup(pdf: Pdf): FieldGroup {
  const fields: Field[] = [];
  const att = attachments(pdf);
  if (att.length) {
    const list = att.map((a) => (a.size !== undefined ? `${a.name} (${formatBytes(a.size)})` : a.name)).join(', ');
    fields.push(
      rawField('pdfdoc:attachments', att.length > 1 ? `Attachments (${att.length})` : 'Attachment', list, {
        sensitivity: 'content',
        tag: '/EmbeddedFiles, /AF',
        description: 'Files embedded in the PDF, including files associated with pages or annotations. They are document content and are kept by “remove all”; remove them here.',
      }),
    );
  }
  const authors = new Map<string, number>();
  for (const a of markupAnnots(pdf)) {
    const t = textOf(pdf, a.dict.get(nm(pdf, 'T')));
    if (t) authors.set(t, (authors.get(t) ?? 0) + 1);
  }
  if (authors.size) {
    const list = [...authors].map(([n, c]) => `${n} (${c})`).join(', ');
    fields.push(
      rawField('pdfdoc:annotations', 'Comment authors', list, {
        sensitivity: 'identity',
        tag: 'Annotation /T',
        description: 'Names attached to comments, highlights and other annotations.',
      }),
    );
  }
  const scripts = scriptSummary(pdf);
  if (scripts) {
    fields.push(
      rawField('pdfdoc:javascript', 'JavaScript and automatic actions', scripts, {
        sensitivity: 'content',
        tag: '/JavaScript, /AA',
        description: 'Scripts, and actions that run by themselves when the document, a page or a form field is opened or used. They are not needed to display the file.',
      }),
    );
  }
  const links = fileLinks(pdf);
  if (links.length) {
    const list = [...new Set(links.map((l) => `${l.path} (${l.action})`))].join(', ');
    fields.push(
      rawField('pdfdoc:file-links', 'Links to local files', list, {
        sensitivity: 'identity',
        tag: '/Launch, /GoToR /F',
        description: 'Links that open files on a computer or network share. Their folders can reveal user and computer names; removing keeps only the file names.',
      }),
    );
  }
  const pieces = pieceInfoHolders(pdf);
  if (pieces.length) {
    const apps = new Set<string>();
    let size = 0;
    for (const d of pieces) {
      const pi = dictOf(pdf, d.get(nm(pdf, 'PieceInfo')));
      for (const k of pi?.keys() ?? []) apps.add(k.decodeText());
      size += reachableStreamBytes(pdf, d.get(nm(pdf, 'PieceInfo')));
    }
    fields.push(
      rawField('pdfdoc:pieceinfo', 'Private application data', `${[...apps].join(', ') || 'Unknown'} — ${formatBytes(size)} on ${pieces.length} object${pieces.length > 1 ? 's' : ''}`, {
        sensitivity: 'software',
        tag: '/PieceInfo',
        description: 'Editing data saved by the creating application (e.g. a full Illustrator document).',
      }),
    );
  }
  // Images' own XMP is reported (and cleaned) by the "Embedded images" group.
  const xmps = objectXmpHolders(pdf).filter((d) => holderKind(pdf, d) !== 'image');
  if (xmps.length) {
    const kinds = [...new Set(xmps.map((d) => holderKind(pdf, d)))].join(', ');
    fields.push(
      rawField('pdfdoc:object-xmp', 'Embedded XMP packets', `${xmps.length} on ${kinds}`, {
        sensitivity: 'content',
        tag: '/Metadata',
        description: 'XMP metadata attached to pages, fonts or forms.',
      }),
    );
  }
  const id = idHex(pdf);
  if (id) fields.push(rawField('pdfdoc:id', 'Document ID', id, { sensitivity: 'software', tag: 'Trailer /ID' }));
  const revs = earlierRevisions(pdf.bytes);
  if (revs) {
    fields.push(
      rawField('pdfdoc:revisions', 'Earlier revisions', `${revs} incremental update${revs > 1 ? 's' : ''} — older content and metadata may be recoverable`, {
        sensitivity: 'content',
        tag: 'Incremental updates',
        description: 'Saving the file here rewrites it as a single revision.',
      }),
    );
  }
  return { id: 'pdf.other', label: 'Embedded data', source: 'PDF', fields };
}

const PAPER: Array<[string, number, number]> = [
  ['A3', 842, 1191],
  ['A4', 595, 842],
  ['A5', 420, 595],
  ['Letter', 612, 792],
  ['Legal', 612, 1008],
  ['Tabloid', 792, 1224],
];

function pageSize(pdf: Pdf): string | null {
  try {
    const { width, height } = pdf.doc.getPage(0).getSize();
    const w = Math.round(width);
    const h = Math.round(height);
    const paper = PAPER.find(([, a, b]) => (Math.abs(a - w) <= 1 && Math.abs(b - h) <= 1) || (Math.abs(a - h) <= 1 && Math.abs(b - w) <= 1));
    const mm = `${Math.round((width / 72) * 25.4)} × ${Math.round((height / 72) * 25.4)} mm`;
    return `${w} × ${h} pt (${paper ? `${paper[0]}, ` : ''}${mm})`;
  } catch {
    return null;
  }
}

function pdfVersion(pdf: Pdf): string {
  const off = headerOffset(pdf.bytes);
  const m = /%PDF-(\d\.\d)/.exec(latin1(pdf.bytes.subarray(off, off + 16)));
  const header = m?.[1] ?? '?';
  const cat = textOf(pdf, pdf.doc.catalog.get(nm(pdf, 'Version')));
  return cat && /^\d\.\d$/.test(cat) && cat > header ? cat : header;
}

export async function readPdf(src: Source): Promise<Metadata> {
  const pdf = await loadPdf(src);
  const warnings: string[] = [];
  const info: InfoItem[] = [];
  info.push({ label: 'Pages', value: String(pdf.doc.getPageCount()) });
  info.push({ label: 'PDF version', value: pdfVersion(pdf) });
  const size = pageSize(pdf);
  if (size) info.push({ label: 'Page size', value: size });
  const catalog = pdf.doc.catalog;
  const marked = textOf(pdf, dictOf(pdf, catalog.get(nm(pdf, 'MarkInfo')))?.get(nm(pdf, 'Marked')));
  info.push({ label: 'Tagged', value: marked === 'true' ? 'Yes' : 'No' });
  const form = dictOf(pdf, catalog.get(nm(pdf, 'AcroForm')));
  const fieldCount = form ? arrayOf(pdf, form.get(nm(pdf, 'Fields'))).length : 0;
  if (fieldCount) info.push({ label: 'Form fields', value: String(fieldCount) });
  info.push({ label: 'Linearized', value: indexOfBytes(pdf.bytes.subarray(0, 2048), '/Linearized') >= 0 ? 'Yes' : 'No' });
  info.push({ label: 'Encrypted', value: pdf.encrypted ? `Yes${pdf.cipher ? ` (${pdf.cipher})` : ''} — unlocked` : 'No' });
  if (pdf.encrypted && pdf.needsPassword) warnings.push('This PDF is password protected. Copies saved by BlueExif will not have a password.');
  else if (pdf.encrypted) {
    warnings.push('This PDF has an owner password that limits printing, copying or editing. Copies saved by BlueExif will not have these restrictions.');
  }
  const sigs = signatures(pdf).length;
  if (sigs) {
    info.push({ label: 'Digital signatures', value: String(sigs) });
    warnings.push('This PDF is digitally signed. Any change, including removing metadata, invalidates the signature.');
  }

  const groups: FieldGroup[] = [infoGroup(pdf)];
  const xmp = catalogXmp(pdf);
  if (xmp.error) warnings.push(xmp.error);
  if (xmp.packet) {
    const part = xmpValue(xmp.packet, 'pdfaid:part');
    if (part) info.push({ label: 'PDF/A', value: `PDF/A-${part}${(xmpValue(xmp.packet, 'pdfaid:conformance') ?? '').toLowerCase()}` });
  }
  groups.push(...xmpGroups(xmp.packet ?? { props: [] }, { addable: true }));
  const extras = extrasGroup(pdf);
  if (extras.fields.length) groups.push(extras);
  groups.push(signatureGroup(pdf));
  const images = await embeddedImageGroup(pdf.lib, pdf.doc);
  if (images?.fields.length) groups.push(images);

  return {
    format: { id: 'pdf', name: 'PDF document', mime: 'application/pdf', category: 'document' },
    info,
    groups: groups.filter((g) => g.fields.length || g.addable?.length),
    warnings,
    canWrite: true,
    canStrip: true,
  };
}

// --------------------------------------------------------------- writing

/** Convert an Info edit into the edit of its XMP counterpart. */
function infoToXmpEdit(key: string, e: Edit): Edit {
  if (e.op === 'remove') return e;
  if (key === 'Author') return { op: 'set', value: Array.isArray(e.value) ? e.value : asList(e.value) };
  return e;
}

/** Convert an XMP edit into the edit of its Info counterpart. */
function xmpToInfoEdit(key: string, e: Edit): Edit {
  if (e.op === 'remove') return e;
  if (key === 'Author' && Array.isArray(e.value)) return { op: 'set', value: e.value.join('; ') };
  return e;
}

function infoValue(pdf: Pdf, key: string, value: FieldValue, existing: PDFObject | undefined): PDFObject {
  const def = INFO[key];
  const label = def?.label ?? key;
  if (key === 'Trapped') {
    const t = TRAPPED.find((x) => x.toLowerCase() === asText(value, label).trim().toLowerCase());
    if (!t) throw new MetadataError('Trapped must be True, False or Unknown');
    return pdf.lib.PDFName.of(t);
  }
  const cur = existing instanceof pdf.lib.PDFRef ? pdf.ctx.lookup(existing) : existing;
  if (Array.isArray(value) && !def) {
    return pdf.ctx.obj(asList(value).map((s) => pdfText(pdf, s)));
  }
  if (cur instanceof pdf.lib.PDFArray) return pdf.ctx.obj(asList(value).map((s) => pdfText(pdf, s)));
  const isDate = def?.kind === 'datetime' || (!def && /^\s*D:\d{4}/.test(textOf(pdf, cur) ?? ''));
  if (isDate) return pdf.lib.PDFString.of(formatPdfDate(requireDate(value, label)));
  return pdfText(pdf, asText(value, label));
}

function applyInfoEdit(pdf: Pdf, info: PDFDict, key: string, e: Edit): void {
  const k = nm(pdf, key);
  if (e.op === 'remove') info.delete(k);
  else info.set(k, infoValue(pdf, key, e.value, info.get(k)));
}

function parseCustom(v: FieldValue): { key: string; value: string } {
  const s = asText(v, 'Custom property');
  const eq = s.indexOf('=');
  const key = (eq < 0 ? '' : s.slice(0, eq)).trim();
  if (!key) throw new MetadataError('Custom property: use the form Name=Value');
  return { key, value: s.slice(eq + 1).trim() };
}

function removeAttachments(pdf: Pdf): void {
  const catalog = pdf.doc.catalog;
  const names = dictOf(pdf, catalog.get(nm(pdf, 'Names')));
  if (names) {
    names.delete(nm(pdf, 'EmbeddedFiles'));
    if (!names.keys().length) catalog.delete(nm(pdf, 'Names'));
  }
  // associated files of the catalog, pages, annotations, XObjects, structure elements…
  for (const d of afHolders(pdf)) d.delete(nm(pdf, 'AF'));
  catalog.delete(nm(pdf, 'Collection'));
  // File-attachment annotations, and the popups that point back at them.
  const gone = new Set(annotations(pdf).filter((a) => a.subtype === 'FileAttachment').map((a) => a.dict));
  for (const page of pageDicts(pdf)) {
    const annots = pdf.ctx.lookup(page.get(nm(pdf, 'Annots')));
    if (!(annots instanceof pdf.lib.PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const d = dictOf(pdf, annots.get(i));
      const parent = d && dictOf(pdf, d.get(nm(pdf, 'Parent')));
      if (d && (gone.has(d) || (parent && gone.has(parent)))) annots.remove(i);
    }
    if (!annots.size()) page.delete(nm(pdf, 'Annots'));
  }
}

function scrubAnnotations(pdf: Pdf, dates: boolean): void {
  for (const a of markupAnnots(pdf)) {
    a.dict.delete(nm(pdf, 'T'));
    if (dates) {
      a.dict.delete(nm(pdf, 'M'));
      a.dict.delete(nm(pdf, 'CreationDate'));
    }
  }
}

function removePieceInfo(pdf: Pdf): void {
  for (const d of pieceInfoHolders(pdf)) {
    d.delete(nm(pdf, 'PieceInfo'));
    d.delete(nm(pdf, 'LastModified'));
  }
  pdf.doc.catalog.delete(nm(pdf, 'LastModified'));
}

function removeObjectXmp(pdf: Pdf): void {
  for (const d of objectXmpHolders(pdf)) d.delete(nm(pdf, 'Metadata'));
}

/** Drop timestamps and folder paths of embedded files (strip keeps the files themselves). */
function scrubAttachments(pdf: Pdf): void {
  for (const a of attachments(pdf)) {
    if (!a.spec) continue;
    const paths: FilePath[] = [];
    for (const k of SPEC_PATHS) specPaths(pdf, a.spec, k, paths, true);
    reducePaths(pdf, paths);
    const ef = dictOf(pdf, a.spec.get(nm(pdf, 'EF')));
    for (const s of ef?.values() ?? []) {
      const params = dictOf(pdf, dictOf(pdf, s)?.get(nm(pdf, 'Params')));
      params?.delete(nm(pdf, 'CreationDate'));
      params?.delete(nm(pdf, 'ModDate'));
    }
  }
}

function randomId(pdf: Pdf): PDFArray {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const hex = toHex(b, 16).replace(/ /g, '').toUpperCase();
  return pdf.ctx.obj([pdf.lib.PDFHexString.of(hex), pdf.lib.PDFHexString.of(hex)]);
}

/** Delete every object that is not reachable from the trailer (old revisions, replaced objects). */
function collectGarbage(pdf: Pdf): void {
  const { lib, ctx } = pdf;
  const seen = new Set<PDFRef>();
  const stack: PDFObject[] = [];
  const t = ctx.trailerInfo;
  for (const o of [t.Root, t.Info, t.Encrypt, t.ID]) if (o) stack.push(o);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof lib.PDFRef) {
      if (seen.has(o)) continue;
      seen.add(o);
      const v = ctx.lookup(o);
      if (v) stack.push(v);
    } else if (o instanceof lib.PDFDict) stack.push(...o.values());
    else if (o instanceof lib.PDFArray) stack.push(...o.asArray());
    else if (o instanceof lib.PDFStream) stack.push(o.dict);
    else if (o instanceof lib.PDFInvalidObject) {
      // pdf-lib kept this object as raw bytes: keep whatever it references.
      const raw = new Uint8Array(o.sizeInBytes());
      o.copyBytesInto(raw, 0);
      for (const m of latin1(raw).matchAll(/(\d+)\s+(\d+)\s+R\b/g)) stack.push(lib.PDFRef.of(+m[1], +m[2]));
    }
  }
  let max = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref)) ctx.delete(ref);
    else max = Math.max(max, ref.objectNumber);
  }
  ctx.largestObjectNumber = max;
}

async function savePdf(pdf: Pdf): Promise<Blob> {
  collectGarbage(pdf);
  const useObjectStreams = indexOfBytes(pdf.bytes, '/ObjStm') >= 0;
  const out = await pdf.doc.save({ useObjectStreams, addDefaultPage: false, updateFieldAppearances: false });
  return toBlob([out], 'application/pdf');
}

export async function writePdf(src: Source, edits: Edits): Promise<Blob> {
  const pdf = await loadPdf(src);
  const { ctx } = pdf;

  const infoRemoved = edits.get(groupKey(INFO_GROUP))?.op === 'remove';
  const xmpRemoved = edits.get(groupKey('xmp'))?.op === 'remove';
  const infoEdits = new Map<string, Edit>();
  const xmpEdits: Edits = new Map();
  for (const [id, e] of edits) {
    if (id.startsWith('pdf:')) infoEdits.set(id.slice(4), e);
    else if (id.startsWith('xmp:')) xmpEdits.set(id, e);
    else if (id === CUSTOM_NEW && e.op === 'set') {
      const c = parseCustom(e.value);
      infoEdits.set(c.key, { op: 'set', value: c.value });
    }
  }

  // Keep mapped Info entries and XMP properties in sync (Info edits win).
  const xmp = catalogXmp(pdf);
  for (const [key, def] of Object.entries(INFO)) {
    if (!def.xmp) continue;
    const xid = xmpFieldId(def.xmp);
    const ie = infoEdits.get(key);
    const xe = xmpEdits.get(xid);
    if (ie && !xe && xmp.packet && !xmpRemoved) xmpEdits.set(xid, infoToXmpEdit(key, ie));
    else if (xe && !ie && !infoRemoved) infoEdits.set(key, xmpToInfoEdit(key, xe));
  }

  if (infoRemoved) ctx.trailerInfo.Info = undefined;
  else if (infoEdits.size) {
    let info = infoDict(pdf);
    if (!info) {
      info = ctx.obj({});
      ctx.trailerInfo.Info = ctx.register(info);
    }
    for (const [key, e] of infoEdits) applyInfoEdit(pdf, info, key, e);
    if (!info.keys().length) ctx.trailerInfo.Info = undefined;
  }

  if (xmpRemoved) pdf.doc.catalog.delete(nm(pdf, 'Metadata'));
  else if (xmpEdits.size) {
    if (xmp.error) throw new MetadataError(xmp.error);
    const p = xmp.packet ?? { props: [] };
    if (applyXmpEdits(p, xmpEdits)) writeCatalogXmp(pdf, p, xmp.ref);
  }

  const removed = (id: string) => edits.get(id)?.op === 'remove';
  if (removed('pdfdoc:attachments')) removeAttachments(pdf);
  if (removed('pdfdoc:annotations')) scrubAnnotations(pdf, false);
  if (removed('pdfdoc:pieceinfo')) removePieceInfo(pdf);
  if (removed('pdfdoc:object-xmp')) removeObjectXmp(pdf);
  if (removed('pdfdoc:id')) ctx.trailerInfo.ID = undefined;
  if (removed('pdfdoc:javascript')) removeScripts(pdf);
  if (removed('pdfdoc:file-links')) reducePaths(pdf, fileLinks(pdf));
  applySignatureEdits(pdf, edits);
  // 'pdfdoc:revisions' needs no action: every save flattens the file.
  await applyEmbeddedImageEdits(pdf.lib, pdf.doc, edits);

  return savePdf(pdf);
}

export async function stripPdf(src: Source, opts: StripOptions): Promise<Blob> {
  const pdf = await loadPdf(src);
  const { ctx } = pdf;
  ctx.trailerInfo.Info = undefined;
  // Keep only the PDF/A identification so archival conformance claims survive.
  const xmp = catalogXmp(pdf);
  pdf.doc.catalog.delete(nm(pdf, 'Metadata'));
  const keep = xmp.packet?.props.filter((p) => p.ns === NS.pdfaid) ?? [];
  if (keep.length) writeCatalogXmp(pdf, { props: keep });
  removeObjectXmp(pdf);
  removePieceInfo(pdf);
  scrubAnnotations(pdf, true);
  // Signature values carry the signer's certificate; the rewrite invalidates them anyway.
  removeSignatures(pdf);
  removeScripts(pdf);
  reducePaths(pdf, fileLinks(pdf));
  scrubAttachments(pdf);
  await stripEmbeddedImages(pdf.lib, pdf.doc, opts);
  ctx.trailerInfo.ID = randomId(pdf);
  return savePdf(pdf);
}

export const pdfHandler: FormatHandler = {
  id: 'pdf',
  name: 'PDF document',
  category: 'document',
  extensions: ['pdf'],
  mime: 'application/pdf',
  detect(ctx: DetectContext) {
    if (headerOffset(ctx.head) >= 0) return 3;
    return this.extensions.includes(ctx.ext) ? 1 : 0;
  },
  read: readPdf,
  write: writePdf,
  strip: stripPdf,
};
