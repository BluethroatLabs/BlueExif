/**
 * Metadata inside images embedded in PDFs. A JPEG placed in a PDF is stored
 * verbatim (DCTDecode), EXIF/GPS/XMP/IPTC included; JPEG 2000 (JPXDecode) can
 * carry XMP/EXIF boxes. Document-level stripping never touched them.
 *
 * Contract used by pdf.ts (all operate on a loaded, decrypted pdf-lib document):
 *   embeddedImageGroup(lib, doc, warnings?) → a 'pdf.images' FieldGroup listing images
 *                                          that carry metadata (or null); pushes one
 *                                          summary warning per problem to `warnings`
 *   applyEmbeddedImageEdits(lib, doc, edits) → honour removals of the group's
 *                                          field ids / groupKey('pdf.images')
 *   stripEmbeddedImages(lib, doc, opts) → clean every embedded image, drop page thumbnails
 * Pixel data stays byte-identical. pdf.ts garbage-collects orphaned objects before saving.
 *
 * What is looked at:
 * - Image XObjects anywhere (page resources, forms, patterns, annotation
 *   appearances, soft masks…).
 * - Inline images (BI … ID … EI) in page, form, pattern, Type 3 glyph and
 *   annotation content streams. Their data is delimited the way pdf.js does it;
 *   a cleaned content stream is re-parsed and only kept when every inline image
 *   is found again exactly as written (it is saved as FlateDecode).
 * - Page thumbnails (/Thumb): listed whatever their format. Removing one, or
 *   stripping, drops it: viewers draw their own, and a stale thumbnail can show
 *   the page as it was before an edit or redaction.
 * - OPI links (/OPI on image and form XObjects: original file paths) are listed
 *   and removed.
 * Codecs:
 * - DCTDecode: cleaned by the JPEG handler's strip, so the result matches a
 *   stripped standalone JPEG — JFIF and APP14 Adobe stay (they drive colour
 *   transforms; JFIF loses its thumbnail), ICC only with keepColorProfile, EXIF
 *   (orientation too: PDF viewers ignore it), XMP, IPTC, COM, MPF/trailers,
 *   C2PA, vendor APPn and every APPn/COM segment among the scans go.
 *   Bytes before SOI are skipped like pdf.js does, and dropped when cleaning.
 *   The entropy-coded data is copied untouched.
 * - JPXDecode: JP2 files keep only the boxes needed to decode (signature, ftyp,
 *   rreq, jp2h, jp2c and JPX compositing boxes) and lose 'xml ', 'uuid'
 *   (XMP/EXIF/IPTC/GeoJP2), 'uinf', 'jp2i'…; COM marker segments are removed
 *   from the codestream main header (raw J2K codestreams too). Files that
 *   address their own bytes (fragment tables) get metadata boxes overwritten in
 *   place by 'free' boxes instead.
 * Filters before the codec (Flate, ASCIIHex, ASCII85, LZW, RunLength) are
 * undone like pdf.js does — a zlib stream without its Adler-32 checksum is
 * fine — and the result is stored as one FlateDecode. Decoded sizes are capped:
 * the engine may run on the page itself. Images that cannot be cleaned
 * (predictors, external files, unknown filters…) are listed as not removable.
 * Cleaning an image also removes its own /Metadata XMP stream.
 *
 * Reading only parses headers (JPEG segments up to SOS plus a walk of the
 * scan data already in memory for EOI and APPn/COM among the scans, JP2 boxes,
 * J2K main header); large Flate-wrapped JPEGs are inflated only up to their
 * first scan, so segments among their scans are found (and removed) by
 * cleaning, which always decodes the whole image.
 */

import type { PDFContext, PDFDict, PDFDocument, PDFObject, PDFRawStream, PDFRef } from 'pdf-lib';
import { Inflate, zlibSync } from 'fflate';
import { Reader, Writer, concat, encodeLatin1, equalBytes, latin1, startsWith, toHex, utf8OrLatin1 } from '../core/binary';
import { parseDate, rawField } from '../core/fields';
import { Source, groupKey, type Edits, type Field, type FieldGroup, type GpsValue, type Sensitivity, type StripOptions } from '../core/types';
import { exifGroups, readGps } from '../exif/fields';
import { ASCII, entryText, getEntry, parseTiff, type ExifData, type Ifd } from '../exif/tiff';
import { IRB_IPTC, IRB_IPTC_DIGEST, iptcGroups, parseIptc, parseIrb } from '../iptc/iptc';
import { parseXmp, xmpGroups } from '../xmp/xmp';
import { jfifThumbnail, parseJpeg, stripJpeg } from './jpeg';

type PdfLib = typeof import('pdf-lib');
type Jpeg = ReturnType<typeof parseJpeg>;
type SegKind = Jpeg['segments'][number]['kind'];

const GROUP = 'pdf.images';
const ID_PREFIX = 'pdfimg:';
const INLINE_PREFIX = `${ID_PREFIX}inline:`;

// ---------------------------------------------------------------- finding

type Codec = 'jpeg' | 'jpx' | 'other';

interface Filter {
  name: string;
  parms?: PDFDict;
}

/** An image XObject, a page thumbnail, or a form XObject carrying an OPI link. */
interface Img {
  ref: PDFRef;
  stream: PDFRawStream;
  codec: Codec;
  /** filters applied before the image codec (decoded to reach the image file) */
  pre: Filter[];
  /** DecodeParms of the image codec filter itself */
  parms?: PDFDict;
  thumb: boolean;
  form: boolean;
}

/** Filter abbreviations (inline-image style) seen in the wild. */
const FILTER_ALIAS: Record<string, string> = {
  Fl: 'FlateDecode',
  AHx: 'ASCIIHexDecode',
  A85: 'ASCII85Decode',
  LZW: 'LZWDecode',
  RL: 'RunLengthDecode',
  DCT: 'DCTDecode',
  CCF: 'CCITTFaxDecode',
  JPX: 'JPXDecode',
};

const nameOf = (lib: PdfLib, o: PDFObject | undefined): string | undefined =>
  o instanceof lib.PDFName ? o.decodeText() : undefined;

const refKey = (r: PDFRef) => `${r.objectNumber} ${r.generationNumber}`;
const fieldId = (r: PDFRef) => `${ID_PREFIX}${r.objectNumber}-${r.generationNumber}`;
const inlineId = (r: PDFRef, index: number) => `${INLINE_PREFIX}${r.objectNumber}-${r.generationNumber}:${index}`;

function filtersOf(lib: PdfLib, dict: PDFDict): Filter[] | null {
  const f = dict.lookup(lib.PDFName.of('Filter'));
  const p = dict.lookup(lib.PDFName.of('DecodeParms'));
  const names = f instanceof lib.PDFArray ? f.asArray().map((x) => nameOf(lib, dict.context.lookup(x))) : f ? [nameOf(lib, f)] : [];
  const parms = (i: number): PDFDict | undefined => {
    const v = p instanceof lib.PDFArray ? (i < p.size() ? p.lookup(i) : undefined) : i === 0 ? p : undefined;
    return v instanceof lib.PDFDict ? v : undefined;
  };
  if (names.some((n) => n === undefined)) return null;
  return names.map((n, i) => ({ name: FILTER_ALIAS[n!] ?? n!, parms: parms(i) }));
}

const codecOf = (name: string | undefined): Codec => (name === 'DCTDecode' ? 'jpeg' : name === 'JPXDecode' ? 'jpx' : 'other');

function describe(lib: PdfLib, ref: PDFRef, stream: PDFRawStream, thumb: boolean, form: boolean): Img {
  const filters = form ? [] : filtersOf(lib, stream.dict);
  return {
    ref,
    stream,
    codec: filters ? codecOf(filters.at(-1)?.name) : 'other',
    pre: filters?.slice(0, -1) ?? [],
    parms: filters?.at(-1)?.parms,
    thumb,
    form,
  };
}

/** Every indirect image stream (page thumbnails may omit /Subtype), plus form XObjects with an OPI link. */
function findImages(lib: PdfLib, doc: PDFDocument): Img[] {
  const thumbs = new Set<string>();
  for (const page of pagesOf(doc)) {
    const t = page.node.get(lib.PDFName.of('Thumb'));
    if (t instanceof lib.PDFRef) thumbs.add(refKey(t));
  }
  const out: Img[] = [];
  for (const [ref, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof lib.PDFRawStream)) continue;
    const thumb = thumbs.has(refKey(ref));
    const sub = nameOf(lib, o.dict.lookup(lib.PDFName.of('Subtype')));
    if (thumb || sub === 'Image') out.push(describe(lib, ref, o, thumb, false));
    else if (sub === 'Form' && o.dict.has(lib.PDFName.of('OPI'))) out.push(describe(lib, ref, o, false, true));
  }
  return out;
}

function pagesOf(doc: PDFDocument) {
  try {
    return doc.getPages();
  } catch {
    return [];
  }
}

interface Content {
  ref: PDFRef;
  stream: PDFRawStream;
}

/** Content streams that can hold inline images: page contents, forms, tiling patterns, Type 3 glyphs, annotation appearances. */
function contentStreams(lib: PdfLib, doc: PDFDocument): Content[] {
  const ctx = doc.context;
  const out = new Map<string, Content>();
  /** A stream reference, or an array / dictionary of them (one level, possibly behind a reference). */
  const add = (o: PDFObject | undefined, nested = false): void => {
    if (o instanceof lib.PDFRef) {
      const v = ctx.lookup(o);
      if (v instanceof lib.PDFRawStream) out.set(refKey(o), { ref: o, stream: v });
      else add(v, nested);
    } else if (!nested && o instanceof lib.PDFArray) for (const x of o.asArray()) add(x, true);
    else if (!nested && o instanceof lib.PDFDict) for (const x of o.values()) add(x, true);
  };
  for (const page of pagesOf(doc)) {
    add(page.node.get(lib.PDFName.of('Contents')));
    const annots = page.node.lookup(lib.PDFName.of('Annots'));
    for (const a of annots instanceof lib.PDFArray ? annots.asArray() : []) {
      const annot = ctx.lookup(a);
      const ap = annot instanceof lib.PDFDict ? annot.lookup(lib.PDFName.of('AP')) : undefined;
      if (ap instanceof lib.PDFDict) for (const k of ['N', 'R', 'D']) add(ap.get(lib.PDFName.of(k))); // a stream, or a dict of states
    }
  }
  for (const [ref, o] of ctx.enumerateIndirectObjects()) {
    if (o instanceof lib.PDFRawStream) {
      const type = o.dict.lookup(lib.PDFName.of('PatternType'));
      if (nameOf(lib, o.dict.lookup(lib.PDFName.of('Subtype'))) === 'Form' || (type instanceof lib.PDFNumber && type.asNumber() === 1)) {
        out.set(refKey(ref), { ref, stream: o });
      }
    } else if (o instanceof lib.PDFDict && nameOf(lib, o.lookup(lib.PDFName.of('Subtype'))) === 'Type3') {
      add(o.get(lib.PDFName.of('CharProcs')));
    }
  }
  return [...out.values()];
}

/** Keys not followed when looking for the images a page shows (they lead to other pages or cannot hold images). */
const SKIP_KEYS = new Set(['Parent', 'P', 'Dest', 'A', 'AA', 'IRT', 'B', 'Metadata', 'PieceInfo']);
const TREE_TYPES = new Set(['Page', 'Pages', 'Catalog']);
const WALK_BUDGET = 500_000;
const WALK_DEPTH = 64;

/**
 * 0-based page indices on which each object (image or content stream, by ref
 * key) is used, directly or through forms, patterns, annotation appearances,
 * soft masks… The objects reachable from each indirect object are memoised, so
 * shared resources (fonts, forms) are explored once for the whole document.
 */
function imagePages(lib: PdfLib, doc: PDFDocument, images: Set<string>): Map<string, number[]> {
  const ctx = doc.context;
  const memo = new Map<string, Set<string>>();
  const pending = new Set<string>();
  let budget = WALK_BUDGET;
  const visit = (o: PDFObject | undefined, acc: Set<string>, depth: number): void => {
    if (depth > WALK_DEPTH || budget <= 0) return;
    if (o instanceof lib.PDFRef) {
      const key = refKey(o);
      let found = memo.get(key);
      if (!found) {
        if (pending.has(key)) return; // cycle
        pending.add(key);
        budget--;
        found = new Set(images.has(key) ? [key] : []);
        visit(ctx.lookup(o), found, depth + 1);
        pending.delete(key);
        memo.set(key, found);
      }
      for (const k of found) acc.add(k);
    } else if (o instanceof lib.PDFDict) {
      budget--;
      // other pages (and this one, when reached again through a reference) are not descended into
      if (depth > 0 && TREE_TYPES.has(nameOf(lib, o.get(lib.PDFName.of('Type'))) ?? '')) return;
      for (const [k, v] of o.entries()) if (!SKIP_KEYS.has(k.decodeText())) visit(v, acc, depth + 1);
    } else if (o instanceof lib.PDFArray) {
      budget--;
      for (const v of o.asArray()) visit(v, acc, depth + 1);
    } else if (o instanceof lib.PDFStream) visit(o.dict, acc, depth + 1);
  };
  const out = new Map<string, number[]>();
  pagesOf(doc).forEach((page, index) => {
    const acc = new Set<string>();
    visit(page.node, acc, 0);
    let inherited: PDFDict | undefined;
    try {
      inherited = page.node.Resources(); // inherited from the page tree
    } catch {
      /* not a dictionary */
    }
    visit(inherited, acc, 0);
    for (const key of acc) {
      const list = out.get(key);
      if (list) list.push(index);
      else out.set(key, [index]);
    }
  });
  return out;
}

// --------------------------------------------------------------- decoding

const MiB = 1 << 20;
/** Decoded size limits: the engine may run on the page itself, so a small crafted stream must not exhaust memory or time. */
const MAX_DECODED = 256 * MiB;
const MAX_RATIO = 100;
/** Enough to find any real JPEG header (APPn segments are at most 64 KB each). */
const HEAD_LIMIT = 16 * MiB;
/** A read decodes wrapped images up to this encoded size in full (to see data after the image)… */
const FULL_READ = MiB;
/** …until this many bytes have been decoded for the document. */
const READ_BUDGET = 64 * MiB;
/** Content streams: limit per stream, and per document for a read. */
const CONTENT_LIMIT = 64 * MiB;
const CONTENT_BUDGET = 256 * MiB;
const CHUNK = 1 << 14;

const decodeLimit = (encoded: number) => Math.min(MAX_DECODED, Math.max(16 * MiB, encoded * MAX_RATIO));

type Fail = { fail: 'unsupported'; why: string } | { fail: 'corrupt' | 'too-large' };
interface Decoded {
  bytes: Uint8Array;
  /** false when decoding stopped early (only the start of the data is there) */
  complete: boolean;
}
type Decode = Decoded | Fail;
const failed = (d: Decode): d is Fail => 'fail' in d;

/** Growable output that refuses to pass `limit`. */
class Out {
  private buf = new Uint8Array(1 << 16);
  len = 0;
  constructor(private readonly limit: number) {}
  push(b: Uint8Array): boolean {
    const need = this.len + b.length;
    if (need > this.limit) return false;
    if (need > this.buf.length) {
      const next = new Uint8Array(Math.min(this.limit, Math.max(this.buf.length * 2, need)));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(b, this.len);
    this.len = need;
    return true;
  }
  get bytes(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

function predictor(lib: PdfLib, parms: PDFDict | undefined): number {
  const p = parms?.lookup(lib.PDFName.of('Predictor'));
  return p instanceof lib.PDFNumber ? p.asNumber() : 1;
}

const PDFLIB_FILTERS = new Set(['ASCIIHexDecode', 'ASCII85Decode', 'LZWDecode', 'RunLengthDecode']);

/** Undo one filter, in small steps so `limit` holds; `stop` (given the output so far) ends early. */
function decodeStep(lib: PdfLib, ctx: PDFContext, f: Filter, input: Uint8Array, limit: number, stop?: (b: Uint8Array) => boolean): Decode {
  if (predictor(lib, f.parms) > 1) return { fail: 'unsupported', why: 'a predictor' };
  const out = new Out(limit);
  try {
    if (f.name === 'FlateDecode') {
      // Like pdf.js: check the zlib header, then inflate. The Adler-32 checksum is never needed (writers often omit it).
      const [cmf, flg] = input;
      if (input.length < 2 || (cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0 || flg & 0x20) return { fail: 'corrupt' };
      let over = false;
      const z = new Inflate((chunk) => {
        if (!over && !out.push(chunk)) over = true;
      });
      for (let i = 2; i < input.length; i += CHUNK) {
        const last = i + CHUNK >= input.length;
        z.push(input.subarray(i, i + CHUNK), last);
        if (over) return { fail: 'too-large' };
        if (!last && stop?.(out.bytes)) return { bytes: out.bytes, complete: false };
      }
    } else if (PDFLIB_FILTERS.has(f.name)) {
      const s = lib.decodePDFRawStream(lib.PDFRawStream.of(ctx.obj({ Filter: f.name, DecodeParms: f.parms ?? null }), input));
      for (;;) {
        const b = s.getBytes(CHUNK * 4);
        if (!b.length) break;
        if (!out.push(b instanceof Uint8Array ? b : new Uint8Array(b.buffer, b.byteOffset, b.byteLength))) return { fail: 'too-large' };
        if (stop?.(out.bytes)) return { bytes: out.bytes, complete: false };
      }
    } else return { fail: 'unsupported', why: `/${f.name} compression` };
  } catch {
    return { fail: 'corrupt' };
  }
  return { bytes: out.bytes, complete: true };
}

/** Undo `filters` in order; `stop` watches the last one's growing output. */
function decodeChain(lib: PdfLib, ctx: PDFContext, data: Uint8Array, filters: Filter[], limit: number, stop?: (b: Uint8Array) => boolean): Decode {
  let cur: Decoded = { bytes: data, complete: true };
  for (let i = 0; i < filters.length; i++) {
    const r = decodeStep(lib, ctx, filters[i], cur.bytes, limit, i === filters.length - 1 ? stop : undefined);
    if (failed(r)) return r;
    cur = r;
  }
  return cur;
}

/** Filters BlueExif can write back (inline images keep their filter chain). */
const ENCODABLE = new Set(['FlateDecode', 'ASCIIHexDecode', 'ASCII85Decode']);

function encodeStep(name: string, data: Uint8Array): Uint8Array | null {
  if (name === 'FlateDecode') return zlibSync(data);
  if (name === 'ASCIIHexDecode') return encodeLatin1(`${toHexString(data).replace(/.{1,64}/g, '$&\n')}>`);
  if (name === 'ASCII85Decode') return ascii85(data);
  return null;
}

const toHexString = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function ascii85(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 4) * 5 + 2);
  let o = 0;
  for (let i = 0; i < data.length; i += 4) {
    const n = Math.min(4, data.length - i);
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? data[i + k] : 0);
    if (n === 4 && v === 0) {
      out[o++] = 0x7a; // 'z'
      continue;
    }
    const d = [0, 0, 0, 0, 0];
    for (let k = 4; k >= 0; k--) {
      d[k] = v % 85;
      v = Math.floor(v / 85);
    }
    for (let k = 0; k <= n; k++) out[o++] = d[k] + 33;
  }
  out[o++] = 0x7e;
  out[o++] = 0x3e;
  return out.subarray(0, o);
}

// ------------------------------------------------------------------- JPEG

const XMP_ID = 'http://ns.adobe.com/xap/1.0/\0';
const PS_ID = 'Photoshop 3.0\0';

/** Segment kinds that are metadata (JFIF, Adobe, ICC and the coding segments are not). */
const JPEG_META = new Set<SegKind>(['exif', 'xmp', 'xmpext', 'irb', 'com', 'c2pa', 'ducky', 'app', 'mpf', 'jfxx']);

/** NUL or PDF whitespace (writers may pad streams). */
const isBlank = (x: number) => x === 0 || x === 0x20 || (x >= 0x09 && x <= 0x0d);
const nonBlank = (b: Uint8Array, from: number, to: number) => b.subarray(from, to).some((x) => !isBlank(x));

/**
 * Resumable walk of a JPEG header by segment lengths: finds SOI (bytes before
 * it are skipped, as pdf.js does) and then the first SOS (or EOI). The data may
 * only grow between calls, so a stream is walked once however it arrives.
 */
class HeadScan {
  soi = -1;
  sos = -1;
  private p = 0;

  feed(b: Uint8Array): boolean {
    if (this.sos >= 0) return true;
    let p = this.p;
    if (this.soi < 0) {
      for (;;) {
        p = b.indexOf(0xff, p);
        if (p < 0 || p + 1 >= b.length) {
          this.p = p < 0 ? b.length : p;
          return false;
        }
        if (b[p + 1] === 0xd8) break;
        p++;
      }
      this.soi = p;
      p += 2;
    }
    while (p + 3 < b.length) {
      if (b[p] !== 0xff) {
        const q = b.indexOf(0xff, p);
        p = q < 0 ? b.length : q;
        continue;
      }
      while (b[p + 1] === 0xff) p++; // fill bytes
      if (p + 3 >= b.length) break;
      const m = b[p + 1];
      if (m === 0xda || m === 0xd9) {
        this.sos = p;
        return true;
      }
      if ((m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xd8) p += 2;
      else p += 2 + ((b[p + 2] << 8) | b[p + 3]);
    }
    this.p = p;
    return false;
  }
}

/** Offset just past the first EOI after `from` (walking the scan data as parseJpeg does), or -1. */
function jpegEnd(b: Uint8Array, from: number): number {
  let q = from;
  while (q < b.length - 1) {
    if (b[q] !== 0xff) {
      q = b.indexOf(0xff, q);
      if (q < 0) return -1;
      continue;
    }
    const m = b[q + 1];
    if (m === 0x00 || m === 0xff || (m >= 0xd0 && m <= 0xd7) || m === 0x01) q += m === 0xff ? 1 : 2;
    else if (m === 0xd9) return q + 2;
    else if (q + 4 > b.length) return -1;
    else q += 2 + ((b[q + 2] << 8) | b[q + 3]);
  }
  return -1;
}

interface JpegInfo {
  /** header segments (parsed up to SOS); segments among the scans (`late`) only for complete data */
  jpeg: Jpeg;
  /** offset of SOI: anything before it is junk */
  soi: number;
  /** offset just past the first EOI; -1 when unknown (partial data) or missing */
  end: number;
}

/** Parse the JPEG header without decoding; `complete` = `b` is the whole stream (then data after EOI is located too). */
function jpegInfo(b: Uint8Array, complete: boolean, scan = new HeadScan()): JpegInfo | null {
  if (!scan.feed(b)) return null;
  let jpeg: Jpeg;
  try {
    // Partial data ends right after the SOS marker: only the header is parsed.
    jpeg = parseJpeg(complete ? b.subarray(scan.soi) : b.subarray(scan.soi, scan.sos + 2));
  } catch {
    return null;
  }
  return { jpeg, soi: scan.soi, end: complete ? jpegEnd(b, scan.sos) : -1 };
}

/** The JFIF APP0 payload carries an uncompressed thumbnail (or other data after its 14-byte header). */
function jpegDirty(b: Uint8Array, info: JpegInfo, keepIcc: boolean): boolean {
  return (
    info.jpeg.late.length > 0 ||
    info.jpeg.segments.some((s) => JPEG_META.has(s.kind) || (!keepIcc && s.kind === 'icc') || (s.kind === 'jfif' && jfifThumbnail(s.data))) ||
    nonBlank(b, 0, info.soi) ||
    (info.end >= 0 && nonBlank(b, info.end, b.length))
  );
}

function segmentFacts(jpeg: Jpeg, f: Facts): void {
  const segs = jpeg.segments;
  const has = (k: SegKind) => segs.some((s) => s.kind === k);
  const exif = segs.find((s) => s.kind === 'exif');
  if (exif) exifFacts(exif.data.subarray(6), f);
  const xmp = segs.find((s) => s.kind === 'xmp');
  if (xmp) xmpFacts(xmp.data.subarray(XMP_ID.length), 'XMP', f);
  if (has('xmpext')) f.add('extended XMP', 'content');
  const irb = segs.filter((s) => s.kind === 'irb');
  if (irb.length) {
    try {
      const res = parseIrb(concat(irb.map((s) => s.data.subarray(PS_ID.length))));
      const iptc = res.find((r) => r.id === IRB_IPTC);
      if (iptc) iptcFacts(iptc.data, f);
      if (res.some((r) => r.id !== IRB_IPTC && r.id !== IRB_IPTC_DIGEST)) f.add('Photoshop data', 'software');
    } catch {
      f.add('Photoshop data', 'software');
    }
  }
  if (has('com')) f.add('comment', 'content');
  if (has('c2pa')) f.add('C2PA', 'software');
  if (has('ducky')) f.add('Save for Web data', 'software');
  if (has('jfxx') || segs.some((s) => s.kind === 'jfif' && jfifThumbnail(s.data))) f.add('thumbnail', 'content');
  if (has('app')) f.parts.push('vendor data');
  if (jpeg.late.length) {
    // APPn/COM between or after the scans, where most tools do not look
    const sub = new Facts();
    segmentFacts({ ...jpeg, segments: jpeg.late, late: [] }, sub);
    const parts = [...new Set(sub.parts)];
    f.add(parts.length ? `data among the scans (${parts.join('; ')})` : 'data among the scans', 'content', ...sub.sens);
  }
}

function jpegFacts(b: Uint8Array, info: JpegInfo, f: Facts): void {
  segmentFacts(info.jpeg, f);
  if (nonBlank(b, 0, info.soi)) f.add('data before image', 'content');
  const mpf = info.jpeg.segments.some((s) => s.kind === 'mpf');
  let t = info.end;
  while (t >= 0 && t < b.length && isBlank(b[t])) t++;
  if (t >= 0 && t < b.length) appendedFacts(b.subarray(t), mpf, f);
  else if (mpf) f.add('extra images', 'content');
}

/** Data after EOI: appended JPEGs (MPF images, edited copies…) are read for what they reveal. */
function appendedFacts(t: Uint8Array, mpf: boolean, f: Facts): void {
  const sub = new Facts();
  let p = 0;
  for (let n = 0; n < 8 && t[p] === 0xff && t[p + 1] === 0xd8; n++) {
    const info = jpegInfo(t.subarray(p), true);
    if (!info) break;
    segmentFacts(info.jpeg, sub);
    if (info.end < 0) break;
    p += info.end;
    while (p < t.length && isBlank(t[p])) p++;
  }
  const label = mpf ? 'extra images' : 'data after image';
  const parts = [...new Set(sub.parts)];
  f.add(parts.length ? `${label} (${parts.join('; ')})` : label, 'content', ...sub.sens);
}

/** Cleaned JPEG, 'clean' when there is nothing to remove (or no JPEG to read), 'fail' when it cannot be rewritten. */
async function cleanJpeg(b: Uint8Array, keepIcc: boolean): Promise<Cleaned> {
  const info = jpegInfo(b, true);
  if (!info || !jpegDirty(b, info, keepIcc)) return 'clean';
  try {
    const opts: StripOptions = { keepOrientation: false, keepColorProfile: keepIcc, keepCoverArt: false };
    return new Uint8Array(await (await stripJpeg(Source.fromBytes(b.subarray(info.soi), 'image.jpg'), opts)).arrayBuffer());
  } catch {
    return 'fail';
  }
}

// --------------------------------------------------------------- JPEG 2000

type Cleaned = Uint8Array | 'clean' | 'fail';

/** Top-level JP2 boxes needed to decode (JP2 and JPX compositing). Everything else is dropped. */
const JP2_KEEP = new Set(['jP  ', 'ftyp', 'rreq', 'jp2h', 'jp2c', 'jpch', 'jplh', 'cgrp', 'comp', 'drep', 'copt', 'inst', 'opct', 'creg']);
/** Boxes that address the file by offset: dropping boxes would break them. */
const JP2_OFFSETS = new Set(['ftbl', 'dtbl']);
/** Boxes without metadata that are not needed either: padding and fragment data. */
const JP2_INERT = new Set(['free', 'skip', 'mdat']);
const FREE = encodeLatin1('free');

const UUID_XMP = 'be7acfcb97a942e89c71999491e3afac';
const UUID_EXIF = toHexId('JpgTiffExif->JP2');
const UUID_IPTC = '33c7a4d2b81d4723a0baf1a3e097ad38';
const UUID_GEO = 'b14bf8bd083d4b43a5ae8cd7d5a6ce03';

function toHexId(s: string): string {
  return [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

interface Box {
  type: string;
  start: number;
  /** header size (8, or 16 for 64-bit lengths) */
  head: number;
  end: number;
}

const isJp2 = (b: Uint8Array) => b.length >= 12 && startsWith(b, '\0\0\0\x0cjP  \r\n\x87\n');
const isJ2k = (b: Uint8Array) => b.length >= 4 && b[0] === 0xff && b[1] === 0x4f && b[2] === 0xff && b[3] === 0x51;
const isMetaBox = (x: Box) => !JP2_KEEP.has(x.type) && !JP2_OFFSETS.has(x.type) && !JP2_INERT.has(x.type);

function jp2Boxes(b: Uint8Array): Box[] | null {
  const r = new Reader(b);
  const out: Box[] = [];
  let p = 0;
  while (p + 8 <= b.length) {
    let len = r.u32(p);
    let head = 8;
    if (len === 1) {
      if (p + 16 > b.length) return null;
      len = r.u32(p + 8) * 2 ** 32 + r.u32(p + 12);
      head = 16;
    } else if (len === 0) len = b.length - p;
    if (len < head || p + len > b.length) return null;
    out.push({ type: latin1(b.subarray(p + 4, p + 8)), start: p, head, end: p + len });
    p += len;
  }
  return out;
}

/** COM marker segments in a J2K main header as [start, end) ranges; null when not a codestream. */
function j2kComments(cs: Uint8Array): Array<[number, number]> | null {
  if (!isJ2k(cs)) return null;
  const r = new Reader(cs);
  const out: Array<[number, number]> = [];
  let p = 2;
  while (p + 4 <= cs.length && cs[p] === 0xff) {
    const m = cs[p + 1];
    if (m === 0x90 || m === 0x93) break; // SOT / SOD: end of the main header
    const len = r.u16(p + 2);
    if (len < 2) return null;
    if (m === 0x64) out.push([p, p + 2 + len]);
    p += 2 + len;
  }
  return out;
}

function comText(seg: Uint8Array): string {
  // marker (2) + length (2) + Rcom (2): 1 = Latin-1 text
  return seg[5] === 1 ? latin1(seg.subarray(6)).replace(/\0+$/, '').trim() : '';
}

function codestreamOf(b: Uint8Array, boxes: Box[] | null): Uint8Array | null {
  if (isJ2k(b)) return b;
  const c = boxes?.find((x) => x.type === 'jp2c');
  return c ? b.subarray(c.start + c.head, c.end) : null;
}

function jpxFacts(b: Uint8Array, f: Facts): void {
  const boxes = isJp2(b) ? jp2Boxes(b) : null;
  for (const box of boxes ?? []) {
    if (!isMetaBox(box)) continue;
    const body = b.subarray(box.start + box.head, box.end);
    if (box.type === 'uuid' && body.length >= 16) {
      const id = toHex(body.subarray(0, 16), 16).replace(/ /g, '').toLowerCase();
      const data = body.subarray(16);
      if (id === UUID_XMP) xmpFacts(data, 'XMP', f);
      else if (id === UUID_EXIF) exifFacts(startsWith(data, 'Exif\0\0') ? data.subarray(6) : data, f);
      else if (id === UUID_IPTC) iptcFacts(data, f);
      else if (id === UUID_GEO) f.add('GeoJP2 location', 'location');
      else f.parts.push('UUID data');
    } else if (box.type === 'xml ') {
      const text = utf8OrLatin1(body);
      if (/<x:xmpmeta|<rdf:RDF/.test(text)) xmpFacts(body, 'XMP', f);
      else f.add('XML', /gml:|GMLJP2/i.test(text) ? 'location' : 'content');
    } else if (box.type === 'jp2i') f.add('rights data', 'identity');
    else f.parts.push(`“${box.type.trim()}” box`);
  }
  const cs = codestreamOf(b, boxes);
  const coms = cs ? j2kComments(cs) : null;
  if (cs && coms?.length) {
    const text = coms.map(([s, e]) => comText(cs.subarray(s, e))).filter(Boolean);
    f.add(text.length ? `comment “${text.join('; ').slice(0, 60)}”` : 'comment', 'content');
  }
}

/** The JPX file without metadata boxes / COM segments. */
function cleanJpx(b: Uint8Array): Cleaned {
  const dropComs = (cs: Uint8Array): Uint8Array | null => {
    const coms = j2kComments(cs);
    if (!coms?.length) return null;
    const parts: Uint8Array[] = [];
    let at = 0;
    for (const [s, e] of coms) {
      parts.push(cs.subarray(at, s));
      at = e;
    }
    parts.push(cs.subarray(at));
    return concat(parts);
  };
  if (isJ2k(b)) return dropComs(b) ?? 'clean';
  const boxes = isJp2(b) ? jp2Boxes(b) : null;
  if (!boxes) return 'clean'; // nothing was listed either
  if (boxes.some((x) => JP2_OFFSETS.has(x.type))) return blankJpx(b, boxes);
  const out: Uint8Array[] = [];
  let changed = false;
  for (const box of boxes) {
    if (!JP2_KEEP.has(box.type)) {
      changed = true;
      continue;
    }
    const cs = box.type === 'jp2c' ? dropComs(b.subarray(box.start + box.head, box.end)) : null;
    if (cs) {
      changed = true;
      out.push(boxHeader('jp2c', cs.length), cs);
    } else out.push(b.subarray(box.start, box.end));
  }
  return changed ? concat(out) : 'clean';
}

/**
 * JP2 with fragment tables / data references: offsets into the file must stay
 * valid, so metadata boxes are overwritten in place by 'free' boxes (readers
 * skip them) with a zeroed payload.
 */
function blankJpx(b: Uint8Array, boxes: Box[]): Cleaned {
  const frags = fragments(b, boxes);
  const cs = codestreamOf(b, boxes);
  const stale = (x: Box) => (x.type === 'free' || x.type === 'skip') && nonZero(b, x.start + x.head, x.end);
  const dirty = boxes.filter((x) => isMetaBox(x) || stale(x));
  if (!frags || (cs && j2kComments(cs)?.length)) return 'fail';
  if (dirty.some((x) => frags.some(([s, e]) => s < x.end && e > x.start))) return 'fail';
  if (!dirty.length) return 'clean';
  const out = b.slice();
  for (const x of dirty) {
    out.set(FREE, x.start + 4);
    out.fill(0, x.start + x.head, x.end);
  }
  return out;
}

const nonZero = (b: Uint8Array, from: number, to: number) => b.subarray(from, to).some((x) => x !== 0);

/** Ranges of this file that fragment lists (ftbl → flst) point at; null when a table cannot be read. */
function fragments(b: Uint8Array, boxes: Box[]): Array<[number, number]> | null {
  const r = new Reader(b);
  const out: Array<[number, number]> = [];
  for (const box of boxes) {
    if (box.type !== 'ftbl') continue;
    const base = box.start + box.head;
    const inner = jp2Boxes(b.subarray(base, box.end));
    if (!inner) return null;
    for (const fl of inner.filter((x) => x.type === 'flst')) {
      const p0 = base + fl.start + fl.head;
      if (p0 + 2 > base + fl.end) return null;
      const n = r.u16(p0);
      if (p0 + 2 + n * 14 > base + fl.end) return null;
      for (let i = 0; i < n; i++) {
        const p = p0 + 2 + i * 14;
        const off = r.u32(p) * 2 ** 32 + r.u32(p + 4);
        if (r.u16(p + 12) === 0) out.push([off, off + r.u32(p + 8)]); // DR 0: this file
      }
    }
  }
  return out;
}

function boxHeader(type: string, size: number): Uint8Array {
  const w = new Writer(false, 16);
  if (size + 8 <= 0xffffffff) w.u32(size + 8).ascii(type);
  else w.u32(1).ascii(type).u64(size + 16);
  return w.finish();
}

// ---------------------------------------------------------- inline images

const isWs = (x: number) => x === 0 || x === 9 || x === 10 || x === 12 || x === 13 || x === 32;
/** pdf.js's whitespace (used to trim the byte before EI). */
const isPdfJsWs = (x: number) => x === 0x20 || x === 0x09 || x === 0x0d || x === 0x0a;
const isDelim = (x: number) =>
  x === 0x28 || x === 0x29 || x === 0x3c || x === 0x3e || x === 0x5b || x === 0x5d || x === 0x7b || x === 0x7d || x === 0x2f || x === 0x25;
const isEnd = (c: Uint8Array, p: number) => p >= c.length || isWs(c[p]) || isDelim(c[p]);

/** Inline image dictionary values: names keep their slash, strings and keywords stay source text. */
type Val = number | string | Val[] | Map<string, Val>;

/** Minimal content-stream tokenizer: skips strings, comments and dictionaries correctly. */
class Lexer {
  constructor(
    readonly c: Uint8Array,
    public p = 0,
  ) {}

  /** Next token as [start, end), or null at the end. */
  token(): [number, number] | null {
    const c = this.c;
    for (;;) {
      while (this.p < c.length && isWs(c[this.p])) this.p++;
      if (this.p >= c.length) return null;
      if (c[this.p] !== 0x25) break;
      while (this.p < c.length && c[this.p] !== 0x0a && c[this.p] !== 0x0d) this.p++; // comment
    }
    const s = this.p;
    const x = c[s];
    if (x === 0x28) {
      let depth = 0;
      let p = s;
      for (; p < c.length; p++) {
        if (c[p] === 0x5c) p++;
        else if (c[p] === 0x28) depth++;
        else if (c[p] === 0x29 && --depth === 0) break;
      }
      this.p = Math.min(p + 1, c.length);
    } else if (x === 0x3c && c[s + 1] !== 0x3c) {
      const e = c.indexOf(0x3e, s + 1);
      this.p = e < 0 ? c.length : e + 1;
    } else if ((x === 0x3c || x === 0x3e) && c[s + 1] === x) this.p = s + 2;
    else if (isDelim(x) && x !== 0x2f) this.p = s + 1;
    else {
      let p = s + 1;
      while (p < c.length && !isWs(c[p]) && !isDelim(c[p])) p++;
      this.p = p;
    }
    return [s, this.p];
  }

  text(t: [number, number]): string {
    return latin1(this.c.subarray(t[0], t[1]));
  }

  /** The value starting with token `t` (arrays and dictionaries read to their end); undefined when malformed. */
  value(t: [number, number], depth = 0): Val | undefined {
    const s = this.text(t);
    if (depth > 16) return undefined;
    if (s === '[') {
      const arr: Val[] = [];
      for (let u = this.token(); u; u = this.token()) {
        if (this.text(u) === ']') return arr;
        const v = this.value(u, depth + 1);
        if (v === undefined) return undefined;
        arr.push(v);
      }
      return undefined;
    }
    if (s === '<<') {
      const dict = new Map<string, Val>();
      for (let k = this.token(); k; k = this.token()) {
        const key = this.text(k);
        if (key === '>>') return dict;
        const u = this.token();
        const v = u && key.startsWith('/') ? this.value(u, depth + 1) : undefined;
        if (v === undefined) return undefined;
        dict.set(pdfName(key), v);
      }
      return undefined;
    }
    if (s === ']' || s === '>>' || s === ')' || s === '>' || s === '{' || s === '}') return undefined;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return Number(s);
    return s.startsWith('/') ? `/${pdfName(s)}` : s;
  }
}

/** A name token's text without its slash, #xx escapes decoded. */
const pdfName = (s: string) => s.replace(/^\//, '').replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

interface Inline {
  /** ordinal among the content stream's inline images */
  index: number;
  dict: Map<string, Val>;
  /** filter names (abbreviations expanded); null when unreadable */
  filters: string[] | null;
  /** the image data, [start, end): up to EOI / the EOD marker, or up to the byte before EI */
  start: number;
  end: number;
  /** where parsing resumes (after EI) */
  next: number;
  /** [start, end) of the /L or /Length number (PDF 2.0), when present */
  len?: [number, number];
}

/** Inline images of a content stream, delimited the way pdf.js delimits them. Stops at one that cannot be delimited. */
function inlineImages(c: Uint8Array): Inline[] {
  const lx = new Lexer(c);
  const out: Inline[] = [];
  for (let t = lx.token(); t; t = lx.token()) {
    if (t[1] - t[0] !== 2 || c[t[0]] !== 0x42 || c[t[0] + 1] !== 0x49) continue; // BI
    const img = inlineAt(lx, out.length);
    if (!img) break;
    out.push(img);
    lx.p = img.next;
  }
  return out;
}

function inlineAt(lx: Lexer, index: number): Inline | null {
  const c = lx.c;
  const dict = new Map<string, Val>();
  let len: [number, number] | undefined;
  let idEnd = -1;
  while (idEnd < 0) {
    const k = lx.token();
    if (!k) return null;
    const key = lx.text(k);
    if (key === 'ID') {
      idEnd = k[1];
      break;
    }
    if (!key.startsWith('/')) return null;
    const u = lx.token();
    const v = u ? lx.value(u) : undefined;
    if (!u || v === undefined) return null;
    const name = pdfName(key);
    dict.set(name, v);
    if ((name === 'L' || name === 'Length') && typeof v === 'number') len = u;
  }
  const start = idEnd + (isWs(c[idEnd]) ? 1 : 0);
  const filters = inlineFilters(dict);
  const first = filters?.[0];
  const found = first === 'DCTDecode' ? dctEnd(c, start) : first === 'ASCII85Decode' ? eodEnd(c, start, true) : first === 'ASCIIHexDecode' ? eodEnd(c, start, false) : null;
  const [end, next] = found ?? defaultEnd(c, start) ?? [-1, -1];
  if (end < 0) return null;
  return { index, dict, filters, start, end, next, len };
}

function inlineFilters(dict: Map<string, Val>): string[] | null {
  const f = dict.get('F') ?? dict.get('Filter');
  const list = f === undefined ? [] : Array.isArray(f) ? f : [f];
  if (!list.every((x): x is string => typeof x === 'string' && x.startsWith('/'))) return null;
  return list.map((x) => FILTER_ALIAS[x.slice(1)] ?? x.slice(1));
}

/** Position of the first "EI" at or after `p` (pdf.js's inlineStreamSkipEI), or -1. */
function skipEi(c: Uint8Array, p: number): number {
  for (let q = c.indexOf(0x45, p); q >= 0 && q + 1 < c.length; q = c.indexOf(0x45, q + 1)) if (c[q + 1] === 0x49) return q;
  return -1;
}

/** DCT: scan markers to EOI like pdf.js; the data runs to the whitespace before EI so that trailing junk is cleaned too. */
function dctEnd(c: Uint8Array, start: number): [number, number] | null {
  let p = start;
  let eoi = -1;
  while (p < c.length) {
    const q = c.indexOf(0xff, p);
    if (q < 0 || q + 1 >= c.length) return null;
    const m = c[q + 1];
    if (m === 0xd9) {
      eoi = q + 2;
      break;
    }
    if (m === 0xff) p = q + 1;
    else if ((m >= 0xc0 && m <= 0xcf && m !== 0xc8) || (m >= 0xda && m <= 0xef) || m === 0xfe) {
      if (q + 3 >= c.length) return null;
      const n = (c[q + 2] << 8) | c[q + 3];
      p = n > 2 ? q + 2 + n : q + 2;
    } else p = q + 2;
  }
  if (eoi < 0) return null;
  const ei = skipEi(c, eoi);
  if (ei < 0) return null;
  let end = ei;
  while (end > eoi && isWs(c[end - 1])) end--;
  return [end, ei + 2];
}

/** ASCII85 ('~>') / ASCIIHex ('>') end-of-data marker, then EI. */
function eodEnd(c: Uint8Array, start: number, a85: boolean): [number, number] | null {
  for (let p = start; p < c.length; p++) {
    if (a85 ? c[p] !== 0x7e : c[p] !== 0x3e) continue;
    let q = p + 1;
    if (a85) {
      while (q < c.length && isPdfJsWs(c[q])) q++;
      if (c[q] !== 0x3e) {
        if (q > p + 1 && c[q] === 0x45 && c[q + 1] === 0x49) return [p + 1, q + 2];
        continue;
      }
      q++;
    }
    const ei = skipEi(c, q);
    return ei < 0 ? null : [q, ei + 2];
  }
  return null;
}

/** Content operators: an "EI" is only accepted when a known operator follows (pdf.js checks the same). */
const OPERATORS = new Set(
  "b B b* B* BDC BI BMC BT BX c cm CS cs d d0 d1 Do DP EI EMC ET EX f F f* G g gs h i ID j J K k l m M MP n q Q re RG rg ri s S SC sc SCN scn sh T* Tc Td TD Tf Tj TJ TL Tm Tr Ts Tw Tz v w W W* y ' \"".split(' '),
);

/** Other filters: the first "EI" followed by whitespace and plausible content (pdf.js's findDefaultInlineStreamEnd). */
function defaultEnd(c: Uint8Array, start: number): [number, number] | null {
  for (let e = skipEi(c, start); e >= 0; e = skipEi(c, e + 1)) {
    const after = c[e + 2];
    if (e + 2 < c.length && after !== 0x20 && after !== 0x0a && after !== 0x0d) continue;
    if (!plausibleAfter(c, e + 3)) continue;
    return [isPdfJsWs(c[e - 1]) && e - 1 >= start ? e - 1 : e, e + 2];
  }
  return null;
}

function plausibleAfter(c: Uint8Array, p: number): boolean {
  const ahead = c.subarray(p, p + 10);
  if (!ahead.length) return true;
  for (let i = 0; i < ahead.length; i++) {
    const x = ahead[i];
    if (x === 0 && ahead[i + 1] !== 0) continue;
    if (x !== 0x0a && x !== 0x0d && (x < 0x20 || x > 0x7f)) return false;
  }
  const lx = new Lexer(c.subarray(p, p + 50));
  for (let t = lx.token(); t; t = lx.token()) {
    const s = lx.text(t);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s) || /^[/([<{\]>}]/.test(s) || s === 'true' || s === 'false' || s === 'null') continue;
    return OPERATORS.has(s);
  }
  return false;
}

/** Cheap pre-check for a "BI" token, so most content streams are never tokenised. */
function mayHaveInline(c: Uint8Array): boolean {
  for (let i = c.indexOf(0x42); i >= 0; i = c.indexOf(0x42, i + 1)) {
    if (c[i + 1] === 0x49 && (i === 0 || isWs(c[i - 1]) || isDelim(c[i - 1])) && isEnd(c, i + 2)) return true;
  }
  return false;
}

interface InlineTarget {
  codec: 'jpeg' | 'jpx';
  pre: Filter[];
  /** why it could not be written back, if so */
  stuck?: string;
}

/** Inline JPEG / JPEG 2000 images (the image codec must be the last filter). */
function inlineTarget(lib: PdfLib, ctx: PDFContext, img: Inline): InlineTarget | null {
  const names = img.filters;
  const codec = codecOf(names?.at(-1));
  if (!names || codec === 'other') return null;
  const dp = img.dict.get('DP') ?? img.dict.get('DecodeParms');
  const parms = (v: Val | undefined): PDFDict | undefined => {
    if (!(v instanceof Map)) return undefined;
    const entries = [...v].filter((e): e is [string, number] => typeof e[1] === 'number');
    return ctx.obj(Object.fromEntries(entries));
  };
  const pre = names.slice(0, -1).map((name, i) => ({ name, parms: parms(Array.isArray(dp) ? dp[i] : i === 0 ? dp : undefined) }));
  const odd = pre.find((f) => !ENCODABLE.has(f.name) || predictor(lib, f.parms) > 1);
  return { codec, pre, stuck: odd ? `it is stored with /${odd.name} compression, which BlueExif cannot write back` : undefined };
}

/** The cleaned, re-encoded data of one inline image, or null when it cannot (or need not) change. */
async function cleanInlineData(lib: PdfLib, ctx: PDFContext, region: Uint8Array, t: InlineTarget, keepIcc: boolean): Promise<Uint8Array | null> {
  if (t.stuck) return null;
  const r = decodeChain(lib, ctx, region, t.pre, decodeLimit(region.length));
  if (failed(r)) return null;
  const out = t.codec === 'jpeg' ? await cleanJpeg(r.bytes, keepIcc) : cleanJpx(r.bytes);
  if (!(out instanceof Uint8Array)) return null;
  let data: Uint8Array | null = out;
  for (let i = t.pre.length - 1; i >= 0 && data; i--) data = encodeStep(t.pre[i].name, data);
  return data;
}

/** Decoded content stream, or null when it cannot (or may not) be decoded. */
function contentBytes(lib: PdfLib, ctx: PDFContext, cs: Content, limit: number): Decode | null {
  const filters = filtersOf(lib, cs.stream.dict);
  if (!filters || cs.stream.dict.has(lib.PDFName.of('F'))) return null;
  return decodeChain(lib, ctx, cs.stream.contents, filters, limit);
}

/** Clean the inline images of one content stream (all, or those in `only`). */
async function cleanInline(lib: PdfLib, ctx: PDFContext, cs: Content, keepIcc: boolean, only?: Set<number>): Promise<void> {
  const dec = contentBytes(lib, ctx, cs, CONTENT_LIMIT);
  if (!dec || failed(dec) || !mayHaveInline(dec.bytes)) return;
  const c = dec.bytes;
  const found = inlineImages(c);
  const changes: Array<{ img: Inline; data: Uint8Array }> = [];
  for (const img of found) {
    if (only && !only.has(img.index)) continue;
    const t = inlineTarget(lib, ctx, img);
    const data = t && (await cleanInlineData(lib, ctx, c.subarray(img.start, img.end), t, keepIcc));
    if (data) changes.push({ img, data });
  }
  if (!changes.length) return;
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const { img, data } of changes) {
    if (img.len) {
      const old = Number(latin1(c.subarray(img.len[0], img.len[1])));
      parts.push(c.subarray(at, img.len[0]), encodeLatin1(String(old + data.length - (img.end - img.start))));
      at = img.len[1];
    }
    parts.push(c.subarray(at, img.start), data);
    at = img.end;
  }
  parts.push(c.subarray(at));
  const next = concat(parts);
  // Keep the rewrite only if every inline image is found again exactly as written.
  const again = inlineImages(next);
  const written = new Map(changes.map((x) => [x.img.index, x.data]));
  const same =
    again.length === found.length &&
    again.every((img, i) => equalBytes(next.subarray(img.start, img.end), written.get(i) ?? c.subarray(found[i].start, found[i].end)));
  if (!same) return;
  const dict = cs.stream.dict;
  dict.set(lib.PDFName.of('Filter'), lib.PDFName.of('FlateDecode'));
  dict.delete(lib.PDFName.of('DecodeParms'));
  dict.delete(lib.PDFName.of('DL'));
  ctx.assign(cs.ref, lib.PDFRawStream.of(dict, zlibSync(next)));
}

// ---------------------------------------------------------------- summary

const RANK: Sensitivity[] = ['content', 'software', 'time', 'device', 'identity', 'location'];

/** What an image reveals: display parts and the sensitivities involved. */
class Facts {
  parts: string[] = [];
  sens = new Set<Sensitivity>();
  add(part: string, ...sens: Array<Sensitivity | undefined>): void {
    this.parts.push(part);
    for (const s of sens) if (s) this.sens.add(s);
  }
  addGroups(part: string, groups: FieldGroup[]): void {
    this.add(part, ...groups.flatMap((g) => g.fields.map((x) => x.sensitivity)));
  }
  /** The highest risk revealed: location > identity > device > time > software > content. */
  get sensitivity(): Sensitivity | undefined {
    return [...this.sens].sort((a, b) => RANK.indexOf(b) - RANK.indexOf(a))[0];
  }
}

function asciiTag(ifd: Ifd | null, tag: number): string {
  const e = getEntry(ifd, tag);
  return e?.type === ASCII ? entryText(e).trim() : '';
}

function shortDate(s: string): string {
  const p = parseDate(s);
  if (!p || p.month === undefined || p.day === undefined) return s;
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = p.hour !== undefined ? ` ${pad(p.hour)}:${pad(p.minute ?? 0)}` : '';
  return `${p.year}-${pad(p.month)}-${pad(p.day)}${time}`;
}

function shortGps(g: GpsValue): string {
  return `${Math.abs(g.lat).toFixed(4)}° ${g.lat < 0 ? 'S' : 'N'} ${Math.abs(g.lon).toFixed(4)}° ${g.lon < 0 ? 'W' : 'E'}`;
}

/** "EXIF: Apple iPhone 15 Pro, by Jane Doe, taken 2024-05-01 18:29, GPS 37.8199° N 122.4783° W" */
function exifSummary(d: ExifData): string {
  const make = asciiTag(d.ifd0, 0x010f);
  const model = asciiTag(d.ifd0, 0x0110);
  const camera = make && !model.toLowerCase().startsWith(make.toLowerCase()) ? `${make} ${model}`.trim() : model || make;
  const artist = asciiTag(d.ifd0, 0x013b);
  const taken = asciiTag(d.exif, 0x9003) || asciiTag(d.exif, 0x9004);
  const modified = asciiTag(d.ifd0, 0x0132);
  const gps = readGps(d);
  const bits = [
    camera,
    artist && `by ${artist}`,
    taken ? `taken ${shortDate(taken)}` : modified && `dated ${shortDate(modified)}`,
    gps && `GPS ${shortGps(gps)}`,
  ].filter(Boolean);
  return bits.length ? `EXIF: ${bits.join(', ')}` : 'EXIF';
}

function exifFacts(tiff: Uint8Array, f: Facts): void {
  try {
    const d = parseTiff(tiff);
    f.addGroups(exifSummary(d), exifGroups(d));
  } catch {
    f.parts.push('EXIF');
  }
}

function xmpFacts(bytes: Uint8Array, label: string, f: Facts): void {
  try {
    f.addGroups(label, xmpGroups(parseXmp(utf8OrLatin1(bytes))));
  } catch {
    f.parts.push(label);
  }
}

function iptcFacts(bytes: Uint8Array, f: Facts): void {
  try {
    f.addGroups('IPTC', iptcGroups(parseIptc(bytes)));
  } catch {
    f.parts.push('IPTC');
  }
}

/** The image dictionary's own /Metadata stream. */
function attachedXmp(lib: PdfLib, img: Img, f: Facts): void {
  const s = img.stream.dict.lookup(lib.PDFName.of('Metadata'));
  if (!(s instanceof lib.PDFStream)) return;
  let bytes: Uint8Array;
  try {
    bytes = s instanceof lib.PDFRawStream ? lib.decodePDFRawStream(s).decode() : s.getContents();
  } catch {
    f.parts.push('XMP stream');
    return;
  }
  xmpFacts(bytes, 'XMP stream', f);
}

/** A file specification's path: a string, or a dictionary's /UF, /F, /Unix, /Mac or /DOS. */
function fileText(lib: PdfLib, o: PDFObject | undefined): string {
  const text = (x: PDFObject | undefined) => (x instanceof lib.PDFString || x instanceof lib.PDFHexString ? x.decodeText() : '');
  let s = text(o);
  if (!s && o instanceof lib.PDFDict) {
    for (const k of ['UF', 'F', 'Unix', 'Mac', 'DOS']) if ((s = text(o.lookup(lib.PDFName.of(k))))) break;
  }
  return s.length > 80 ? `…${s.slice(-79)}` : s;
}

/** OPI links (ISO 32000-1 §14.11.7): the path of the original high-resolution file. */
function opiFacts(lib: PdfLib, dict: PDFDict, f: Facts): void {
  const opi = dict.lookup(lib.PDFName.of('OPI'));
  if (!(opi instanceof lib.PDFDict)) return;
  const files = opi
    .values()
    .map((v) => dict.context.lookup(v))
    .map((d) => (d instanceof lib.PDFDict ? fileText(lib, d.lookup(lib.PDFName.of('F'))) : ''))
    .filter(Boolean);
  f.add(files.length ? `OPI link “${files[0]}”` : 'OPI link', 'identity');
}

function pageRanges(pages: number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    if (j - i >= 2) {
      ranges.push(`${pages[i] + 1}–${pages[j] + 1}`);
      i = j + 1;
    } else ranges.push(String(pages[i++] + 1));
  }
  return ranges.length > 6 ? `${ranges.slice(0, 6).join(', ')}, …` : ranges.join(', ');
}

const CODEC_NAME: Record<Codec, string> = { jpeg: 'JPEG', jpx: 'JPEG 2000', other: 'image' };
const CODEC_LABEL: Record<Codec, string> = { jpeg: 'JPEG image', jpx: 'JPEG 2000 image', other: 'Image' };

const DESCRIPTION = 'Metadata stored inside a picture placed in the PDF (camera, location, author…). Removing it leaves the pixels unchanged.';
const THUMB_DESCRIPTION =
  'A small picture of the page saved with the file. It can show content that was later changed or redacted; viewers draw their own thumbnails, so removing it is safe.';

/** One listed picture (or OPI-linked form). */
interface Item {
  id: string;
  /** ref key used to find the pages (the image, or the content stream of an inline image) */
  key: string;
  label: string;
  what: string;
  tag: string;
  f: Facts;
  /** why removal cannot clean it; undefined = it can */
  stuck?: string;
  thumb: boolean;
  order: [number, number];
}

function size(w: Val | PDFObject | undefined, h: Val | PDFObject | undefined, lib: PdfLib): string {
  const n = (v: Val | PDFObject | undefined) => (typeof v === 'number' ? v : v instanceof lib.PDFNumber ? v.asNumber() : undefined);
  const [a, b] = [n(w), n(h)];
  return a && b ? `${a}×${b} ` : '';
}

/** The image file inside an XObject for a read: in full when small, else only up to the end of the JPEG header. */
function readPayload(lib: PdfLib, ctx: PDFContext, img: Img, budget: { left: number }, scan: HeadScan): Decode {
  const data = img.stream.contents;
  if (!img.pre.length) return { bytes: data, complete: true };
  if (img.codec === 'jpx' || (data.length <= FULL_READ && budget.left >= data.length)) {
    const r = decodeChain(lib, ctx, data, img.pre, decodeLimit(data.length));
    if (!failed(r)) budget.left -= r.bytes.length;
    return r;
  }
  return decodeChain(lib, ctx, data, img.pre, HEAD_LIMIT, (b) => scan.feed(b));
}

/** Read an image XObject's metadata; null when there is nothing to list. */
function imageItem(lib: PdfLib, ctx: PDFContext, img: Img, budget: { left: number }): Item | null {
  const f = new Facts();
  const dict = img.stream.dict;
  let stuck: string | undefined;
  const external = dict.lookup(lib.PDFName.of('F'));
  if (img.form) {
    /* only the OPI link */
  } else if (external) {
    const name = fileText(lib, external);
    f.add(name ? `linked file “${name}”` : 'linked file', 'identity');
    stuck = 'its picture is stored in a separate file';
  } else if (img.codec !== 'other') {
    const scan = new HeadScan();
    const r = readPayload(lib, ctx, img, budget, scan);
    if (failed(r)) {
      if (r.fail === 'unsupported') {
        f.parts.push('contents not checked');
        stuck = `it uses ${r.why}, which BlueExif cannot undo`;
      }
    } else if (img.codec === 'jpeg') {
      const info = jpegInfo(r.bytes, r.complete, scan);
      if (info) jpegFacts(r.bytes, info, f);
    } else {
      jpxFacts(r.bytes, f);
      if (f.parts.length && cleanJpx(r.bytes) === 'fail') stuck = 'its JPEG 2000 layout cannot be rewritten safely';
    }
  }
  if (!img.form) attachedXmp(lib, img, f); // a form's own XMP is pdf.ts's "Embedded XMP packets"
  opiFacts(lib, dict, f);
  if (!f.parts.length && !img.thumb) return null;
  if (img.thumb) f.sens.add('content');
  const { objectNumber: n, generationNumber: g } = img.ref;
  return {
    id: fieldId(img.ref),
    key: refKey(img.ref),
    label: img.thumb ? 'Page thumbnail' : img.form ? 'Placed graphic' : CODEC_LABEL[img.codec],
    what: img.form ? '' : `${size(dict.lookup(lib.PDFName.of('Width')), dict.lookup(lib.PDFName.of('Height')), lib)}${CODEC_NAME[img.codec]}`,
    tag: `${img.form ? 'Form' : 'Image'} XObject ${n} ${g} R`,
    f,
    stuck: img.thumb ? undefined : stuck, // a thumbnail is removed outright
    thumb: img.thumb,
    order: [n, -1],
  };
}

/** Inline JPEG / JPEG 2000 images of one decoded content stream that carry metadata. */
function inlineItems(lib: PdfLib, ctx: PDFContext, cs: Content, c: Uint8Array): Item[] {
  const out: Item[] = [];
  for (const img of inlineImages(c)) {
    const t = inlineTarget(lib, ctx, img);
    if (!t) continue;
    const f = new Facts();
    let stuck = t.stuck;
    const region = c.subarray(img.start, img.end);
    const r = decodeChain(lib, ctx, region, t.pre, decodeLimit(region.length));
    if (failed(r)) {
      if (r.fail !== 'unsupported') continue;
      f.parts.push('contents not checked');
      stuck = `it uses ${r.why}, which BlueExif cannot undo`;
    } else if (t.codec === 'jpeg') {
      const info = jpegInfo(r.bytes, true);
      if (info) jpegFacts(r.bytes, info, f);
    } else {
      jpxFacts(r.bytes, f);
      if (f.parts.length && cleanJpx(r.bytes) === 'fail') stuck ??= 'its JPEG 2000 layout cannot be rewritten safely';
    }
    if (!f.parts.length) continue;
    const { objectNumber: n, generationNumber: g } = cs.ref;
    out.push({
      id: inlineId(cs.ref, img.index),
      key: refKey(cs.ref),
      label: `Inline ${CODEC_LABEL[t.codec]}`,
      what: `inline ${size(img.dict.get('W') ?? img.dict.get('Width'), img.dict.get('H') ?? img.dict.get('Height'), lib)}${CODEC_NAME[t.codec]}`,
      tag: `Inline image ${img.index + 1} in content stream ${n} ${g} R`,
      f,
      stuck,
      thumb: false,
      order: [n, img.index],
    });
  }
  return out;
}

function itemField(it: Item, pages: number[] | undefined): Field {
  const where = pages?.length ? `${pages.length > 1 ? 'Pages' : 'Page'} ${pageRanges(pages)}` : '';
  return rawField(it.id, it.label, [where, it.what, ...it.f.parts].filter(Boolean).join(' · '), {
    sensitivity: it.f.sensitivity,
    tag: it.tag,
    description: it.stuck
      ? `BlueExif cannot clean this picture: ${it.stuck}. Its metadata stays in saved copies.`
      : it.thumb
        ? THUMB_DESCRIPTION
        : DESCRIPTION,
    removable: !it.stuck,
  });
}

// ---------------------------------------------------------------- cleaning

/** Remove the metadata of one image; pixel data is carried over byte for byte. */
async function cleanImage(lib: PdfLib, ctx: PDFContext, img: Img, keepIcc: boolean): Promise<void> {
  img.stream.dict.delete(lib.PDFName.of('OPI'));
  if (img.form) return;
  img.stream.dict.delete(lib.PDFName.of('Metadata'));
  if (img.codec === 'other' || img.stream.dict.has(lib.PDFName.of('F'))) return;
  const data = img.stream.contents;
  const r = decodeChain(lib, ctx, data, img.pre, decodeLimit(data.length));
  if (failed(r)) return;
  const out = img.codec === 'jpeg' ? await cleanJpeg(r.bytes, keepIcc) : cleanJpx(r.bytes);
  if (out instanceof Uint8Array) replaceContents(lib, ctx, img, out);
}

/** Store `data` as the image file; earlier filters collapse into one FlateDecode. /Length is rewritten on save. */
function replaceContents(lib: PdfLib, ctx: PDFContext, img: Img, data: Uint8Array): void {
  const dict = img.stream.dict;
  let contents = data;
  if (img.pre.length) {
    contents = zlibSync(data);
    const codec = img.codec === 'jpeg' ? 'DCTDecode' : 'JPXDecode';
    dict.set(lib.PDFName.of('Filter'), ctx.obj(['FlateDecode', codec]));
    if (img.parms) dict.set(lib.PDFName.of('DecodeParms'), ctx.obj([null, img.parms]));
    else dict.delete(lib.PDFName.of('DecodeParms'));
  }
  ctx.assign(img.ref, lib.PDFRawStream.of(dict, contents));
}

/** Drop the page entries that point at this thumbnail. */
function unlinkThumb(lib: PdfLib, doc: PDFDocument, ref: PDFRef): void {
  for (const page of pagesOf(doc)) {
    const t = page.node.get(lib.PDFName.of('Thumb'));
    if (t instanceof lib.PDFRef && refKey(t) === refKey(ref)) page.node.delete(lib.PDFName.of('Thumb'));
  }
}

// -------------------------------------------------------------------- API

/**
 * The 'pdf.images' group, or null. Pushes to `warnings` (pdf.ts's read
 * warnings) when some metadata cannot be removed or some content was too large
 * to check.
 */
export async function embeddedImageGroup(lib: PdfLib, doc: PDFDocument, warnings?: string[]): Promise<FieldGroup | null> {
  const ctx = doc.context;
  const items: Item[] = [];
  const budget = { left: READ_BUDGET };
  for (const img of findImages(lib, doc)) {
    try {
      const it = imageItem(lib, ctx, img, budget);
      if (it) items.push(it);
    } catch {
      /* malformed image dictionary: nothing we could clean either */
    }
  }
  let contentLeft = CONTENT_BUDGET;
  let unchecked = false;
  for (const cs of contentStreams(lib, doc)) {
    try {
      const dec = contentBytes(lib, ctx, cs, Math.min(CONTENT_LIMIT, contentLeft));
      if (!dec || failed(dec)) {
        unchecked ||= dec?.fail === 'too-large';
        continue;
      }
      contentLeft -= dec.bytes.length;
      if (mayHaveInline(dec.bytes)) items.push(...inlineItems(lib, ctx, cs, dec.bytes));
    } catch {
      /* malformed content stream */
    }
  }
  const stuck = items.filter((x) => x.stuck).length;
  if (stuck) warnings?.push(`${stuck} embedded image${stuck > 1 ? 's carry' : ' carries'} metadata BlueExif cannot remove.`);
  if (unchecked) warnings?.push('Some page content is too large to check for inline images.');
  if (!items.length) return null;
  const pages = imagePages(lib, doc, new Set(items.map((x) => x.key)));
  const first = (it: Item) => pages.get(it.key)?.[0] ?? Infinity;
  items.sort((a, b) => first(a) - first(b) || a.order[0] - b.order[0] || a.order[1] - b.order[1]);
  return {
    id: GROUP,
    label: 'Embedded images',
    source: 'PDF',
    fields: items.map((it) => itemField(it, pages.get(it.key))),
    removable: true,
  };
}

export async function applyEmbeddedImageEdits(lib: PdfLib, doc: PDFDocument, edits: Edits): Promise<void> {
  const all = edits.get(groupKey(GROUP))?.op === 'remove';
  const ids = new Set([...edits].filter(([id, e]) => id.startsWith(ID_PREFIX) && e.op === 'remove').map(([id]) => id));
  if (!all && !ids.size) return;
  const ctx = doc.context;
  for (const img of findImages(lib, doc)) {
    if (!all && !ids.has(fieldId(img.ref))) continue;
    await cleanImage(lib, ctx, img, true);
    if (img.thumb) unlinkThumb(lib, doc, img.ref);
  }
  const wanted = new Map<string, Set<number>>();
  for (const id of ids) {
    const m = /^pdfimg:inline:(\d+)-(\d+):(\d+)$/.exec(id);
    if (!m) continue;
    const key = `${m[1]} ${m[2]}`;
    wanted.set(key, (wanted.get(key) ?? new Set()).add(Number(m[3])));
  }
  if (!all && !wanted.size) return;
  for (const cs of contentStreams(lib, doc)) {
    const only = all ? undefined : wanted.get(refKey(cs.ref));
    if (all || only) await cleanInline(lib, ctx, cs, true, only);
  }
}

export async function stripEmbeddedImages(lib: PdfLib, doc: PDFDocument, opts: StripOptions): Promise<void> {
  const ctx = doc.context;
  for (const img of findImages(lib, doc)) await cleanImage(lib, ctx, img, opts.keepColorProfile);
  for (const cs of contentStreams(lib, doc)) await cleanInline(lib, ctx, cs, opts.keepColorProfile);
  for (const page of pagesOf(doc)) page.node.delete(lib.PDFName.of('Thumb'));
}
