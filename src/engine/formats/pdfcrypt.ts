/**
 * Opening PDFs, including password-protected ones (Standard Security Handler).
 *
 * Contract used by pdf.ts:
 *   openPdf(lib, bytes, password?) resolves to a pdf-lib document whose objects
 *   are all decrypted and whose trailer no longer references /Encrypt, so that
 *   saving it produces an unencrypted file. `encrypted` reports whether the
 *   input was encrypted and `cipher` names the scheme (e.g. "AES-256").
 *   `needsPassword` is false for files that open with the empty user password
 *   (restricted only by an owner password: printing, copying, editing limits).
 *   Throws MetadataError with code 'password-required' when a password is
 *   needed and none was given, 'wrong-password' when the given one does not
 *   open the file, and a plain MetadataError for unsupported handlers.
 *
 * Supported: V1/V2 (R2/R3, RC4 40–128-bit), V4/R4 crypt filters (/V2 RC4,
 * /AESV2, /Identity) and V5 (R5/R6, /AESV3), per ISO 32000-2 §7.6. The empty
 * user password is always tried, so files restricted only by an owner
 * (permissions) password open without a prompt; either password is accepted.
 *
 * pdf-lib cannot read encrypted object streams (it inflates the ciphertext), so
 * files are parsed with pdf-lib's own PDFParser whose per-object hook keeps
 * /ObjStm streams raw. This works the same for xref tables, xref streams and
 * incremental updates, because pdf-lib reads objects in file order rather than
 * through the xref. Unencrypted files take the same path: it also skips the
 * rows of xref streams, which pdf-lib would otherwise loop over for as long as
 * a crafted /Size or /Index says (16M refs and seconds of a frozen page, then
 * an error). After authentication the object streams are
 * decrypted and expanded with the "later definition wins" order pdf-lib uses
 * for incremental updates; then every string and stream of every top-level
 * object is decrypted. Not decrypted, as the spec requires: the /Encrypt
 * dictionary, the trailer /ID, cross-reference streams, objects inside object
 * streams, /Metadata streams when /EncryptMetadata is false (or when a writer
 * left them in the clear anyway), /Identity crypt-filter streams and signature
 * /Contents.
 *
 * Crypto is self-contained (MD5, RC4, SHA-256/384/512, AES) rather than
 * WebCrypto: WebCrypto has no MD5 or RC4, cannot do unpadded AES-CBC (R6 hash,
 * /UE, /OE) or tolerate the bad padding found in real files, is async per call
 * (one call per string) and is missing entirely outside secure contexts.
 */

import type { PDFArray, PDFContext, PDFDict, PDFDocument, PDFObject, PDFRawStream, PDFRef } from 'pdf-lib';
import { MetadataError } from '../core/types';
import { concat, encodeUtf8, equalBytes, latin1 } from '../core/binary';

type PdfLib = typeof import('pdf-lib');

export interface OpenedPdf {
  doc: PDFDocument;
  encrypted: boolean;
  cipher?: string;
  /** a password is needed to open the file (false when only an owner password restricts it) */
  needsPassword: boolean;
}

export async function openPdf(lib: PdfLib, bytes: Uint8Array, password?: string): Promise<OpenedPdf> {
  try {
    return await open(lib, bytes, password);
  } catch (e) {
    // Damaged or crafted input must reach the UI as a MetadataError, never as an "unexpected error".
    throw unreadable(e);
  }
}

const unreadable = (e: unknown) =>
  e instanceof MetadataError ? e : new MetadataError(`This PDF could not be read: ${e instanceof Error ? e.message : String(e)}`);

// ================================================================= parsing

/** pdf-lib PDFParser internals (private in its typings) used to defer object streams. */
interface ParserInternals {
  readonly bytes: { offset(): number };
  readonly context: PDFContext;
  parseIndirectObjectHeader(): PDFRef;
  skipWhitespaceAndComments(): void;
  parseObject(): PDFObject;
  matchKeyword(keyword: number[]): boolean;
  parseIndirectObject(): Promise<PDFRef>;
  tryToParseInvalidIndirectObject(): PDFRef;
  maybeRecoverRoot(): void;
}

type DocumentCtor = new (context: PDFContext, ignoreEncryption: boolean, updateMetadata: boolean) => PDFDocument;

const ENDOBJ = [...'endobj'].map((c) => c.charCodeAt(0));

interface ObjStm {
  ref: PDFRef;
  stream: PDFRawStream;
  /** position of its definition in file order */
  seq: number;
}

/** A stream with an indirect /Length, kept with what is needed to re-cut its data. */
interface IndirectLength {
  ref: PDFRef;
  stream: PDFRawStream;
  /** offset just past its "endstream" keyword */
  end: number;
  objStm?: ObjStm;
}

interface Parsed {
  ctx: PDFContext;
  /** file-order position of each object's current definition, and whether it came from an object stream */
  order: Map<PDFRef, { seq: number; packed: boolean }>;
  objStms: ObjStm[];
  lengths: IndirectLength[];
  recoverRoot: () => void;
}

/**
 * Parse every top-level object like PDFDocument.load does, but keep object
 * streams raw (they are expanded by expandObjectStreams after decryption) and
 * take only the trailer keys from xref streams.
 */
async function parse(lib: PdfLib, bytes: Uint8Array): Promise<Parsed> {
  const parser = lib.PDFParser.forBytesWithOptions(bytes, lib.ParseSpeeds.Slow, false, false);
  const p = parser as unknown as ParserInternals;
  const recover = p.maybeRecoverRoot;
  const invalid = p.tryToParseInvalidIndirectObject;
  const needed = ['parseIndirectObjectHeader', 'skipWhitespaceAndComments', 'parseObject', 'matchKeyword'] as const;
  if (typeof recover !== 'function' || typeof invalid !== 'function' || needed.some((m) => typeof p[m] !== 'function')) {
    throw new MetadataError('This build cannot read PDFs (unexpected pdf-lib version).');
  }
  const ctx = p.context;
  const order: Parsed['order'] = new Map();
  const objStms: ObjStm[] = [];
  const lengths: IndirectLength[] = [];
  const Type = lib.PDFName.of('Type');
  let seq = 0;

  p.maybeRecoverRoot = () => {}; // deferred until object streams are expanded
  p.parseIndirectObject = async () => {
    const ref = p.parseIndirectObjectHeader();
    p.skipWhitespaceAndComments();
    const object = p.parseObject();
    const end = p.bytes.offset();
    p.skipWhitespaceAndComments();
    p.matchKeyword(ENDOBJ);
    seq++;
    if (object instanceof lib.PDFRawStream) {
      const type = object.dict.lookup(Type);
      const indirect = object.dict.get(lib.PDFName.of('Length')) instanceof lib.PDFRef;
      if (type === lib.PDFName.of('XRef')) {
        // Only its trailer keys matter, since objects are read in file order. Its rows are
        // never parsed: pdf-lib would loop over a crafted /Size or /Index without bound.
        const t = ctx.trailerInfo;
        const get = (k: string) => object.dict.get(lib.PDFName.of(k));
        ctx.trailerInfo = { Root: get('Root') ?? t.Root, Encrypt: get('Encrypt') ?? t.Encrypt, Info: get('Info') ?? t.Info, ID: get('ID') ?? t.ID };
        return ref;
      }
      if (type === lib.PDFName.of('ObjStm')) {
        const os = { ref, stream: object, seq };
        objStms.push(os);
        if (indirect) lengths.push({ ref, stream: object, end, objStm: os });
        return ref;
      }
      if (indirect) lengths.push({ ref, stream: object, end });
    }
    ctx.assign(ref, object);
    order.set(ref, { seq, packed: false });
    return ref;
  };
  // Objects pdf-lib keeps as raw bytes still count for "later definition wins".
  p.tryToParseInvalidIndirectObject = () => {
    const ref = invalid.call(parser);
    order.set(ref, { seq: ++seq, packed: false });
    return ref;
  };
  try {
    await parser.parseDocument();
  } catch (e) {
    throw unreadable(e);
  }
  return { ctx, order, objStms, lengths, recoverRoot: () => recover.call(parser) };
}

/**
 * pdf-lib finds the end of a stream with an indirect /Length by searching for
 * "endstream" and drops a trailing CR/LF of the data, which is fatal for
 * ciphertext. Re-cut such streams to their real /Length once it resolves.
 */
function fixLengths(lib: PdfLib, bytes: Uint8Array, parsed: Parsed, objStms: boolean): void {
  const { ctx } = parsed;
  for (const { ref, stream, end, objStm } of parsed.lengths) {
    if (!objStm !== !objStms) continue;
    const len = ctx.lookup(stream.dict.get(lib.PDFName.of('Length')));
    if (!(len instanceof lib.PDFNumber)) continue;
    const fixed = exactStreamData(bytes, end, stream.contents.length, len.asNumber());
    if (!fixed) continue;
    const s = lib.PDFRawStream.of(stream.dict, fixed);
    if (objStm) objStm.stream = s;
    else if (ctx.lookup(ref) === stream) ctx.assign(ref, s);
  }
}

/**
 * Stream data of exactly `length` bytes, located from the offset just past the
 * "endstream" keyword pdf-lib matched and the size of the data it kept.
 */
function exactStreamData(bytes: Uint8Array, after: number, kept: number, length: number): Uint8Array | null {
  const kw = after - 9; // "endstream"
  const eol = bytes[kw - 2] === 0x0d && bytes[kw - 1] === 0x0a ? 2 : bytes[kw - 1] === 0x0d || bytes[kw - 1] === 0x0a ? 1 : 0;
  const start = kw - eol - kept;
  if (start < 0 || length === kept || length < 0 || start + length > kw) return null;
  for (let i = start + length; i < kw; i++) if (!isWhite(bytes[i])) return null;
  return bytes.slice(start, start + length);
}

const isWhite = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;

/** Parse the (decrypted) object streams into the context, honouring definition order. */
function expandObjectStreams(lib: PdfLib, parsed: Parsed): void {
  const { ctx, order } = parsed;
  for (const os of parsed.objStms) {
    let data: Uint8Array;
    let first: number;
    let n: number;
    try {
      data = lib.decodePDFRawStream(os.stream).decode();
      first = os.stream.dict.lookup(lib.PDFName.of('First'), lib.PDFNumber).asNumber();
      n = os.stream.dict.lookup(lib.PDFName.of('N'), lib.PDFNumber).asNumber();
    } catch {
      continue; // damaged object stream: its objects stay missing, as with pdf-lib
    }
    const header = (latin1(data.subarray(0, first)).match(/\d+/g) ?? []).map(Number);
    for (let i = 0; i < n && 2 * i + 1 < header.length; i++) {
      const ref = lib.PDFRef.of(header[2 * i], 0);
      if ((order.get(ref)?.seq ?? 0) > os.seq) continue; // redefined later in the file
      try {
        const obj = lib.PDFObjectParser.forBytes(data.subarray(first + header[2 * i + 1]), ctx).parseObject();
        ctx.assign(ref, obj);
        order.set(ref, { seq: os.seq, packed: true });
      } catch {
        // skip an unparsable member
      }
    }
  }
}

async function open(lib: PdfLib, bytes: Uint8Array, password?: string): Promise<OpenedPdf> {
  const parsed = await parse(lib, bytes);
  const { ctx } = parsed;
  const encRaw = ctx.trailerInfo.Encrypt;
  const encDict = encRaw ? ctx.lookup(encRaw) : undefined;
  if (encRaw && !(encDict instanceof lib.PDFDict)) throw new MetadataError('This PDF is encrypted but its encryption dictionary is missing.');
  const sec = encDict instanceof lib.PDFDict ? authenticate(readEncryption(lib, encDict, trailerId(lib, ctx)), password) : undefined;
  const dec = sec && new Decryptor(lib, sec);

  // Object streams first: lengths of other streams may live inside them.
  fixLengths(lib, bytes, parsed, true);
  if (dec) for (const os of parsed.objStms) os.stream = dec.stream(os.ref, os.stream);
  const topLevel = [...parsed.order.keys()];
  expandObjectStreams(lib, parsed);
  fixLengths(lib, bytes, parsed, false);

  if (dec) {
    // Everything defined at top level, except the /Encrypt dictionary and the /ID
    // (objects that came out of object streams were never encrypted).
    const skip = new Set<PDFObject | undefined>([encRaw, ctx.trailerInfo.ID]);
    for (const ref of topLevel) {
      if (skip.has(ref) || parsed.order.get(ref)?.packed) continue;
      const obj = ctx.lookup(ref);
      if (!obj) continue;
      const out = dec.object(ref, obj);
      if (out !== obj) ctx.assign(ref, out);
    }
    ctx.trailerInfo.Encrypt = undefined;
    if (encRaw instanceof lib.PDFRef) ctx.delete(encRaw);
  }
  parsed.recoverRoot();
  if (ctx.lookup(lib.PDFRef.of(0))) ctx.delete(lib.PDFRef.of(0));
  if (!(ctx.lookup(ctx.trailerInfo.Root) instanceof lib.PDFDict)) throw new MetadataError('This PDF could not be read: it has no document catalog.');
  // Same construction as PDFDocument.load, over the context built above.
  const doc = new (lib.PDFDocument as unknown as DocumentCtor)(ctx, false, false);
  return { doc, encrypted: !!dec, cipher: sec?.cipher, needsPassword: !!sec?.needsPassword };
}

// ============================================================ PDF strings

/** Bytes of a literal string's raw source (pdf-lib keeps escapes unprocessed). */
function literalBytes(raw: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c !== 0x5c) {
      out.push(c & 0xff); // raw bytes kept verbatim (binary ciphertext often has bare CRs)
      continue;
    }
    const n = raw.charCodeAt(++i);
    if (n >= 0x30 && n <= 0x37) {
      let v = n - 0x30;
      for (let k = 0; k < 2; k++) {
        const d = raw.charCodeAt(i + 1);
        if (!(d >= 0x30 && d <= 0x37)) break;
        v = v * 8 + d - 0x30;
        i++;
      }
      out.push(v & 0xff);
    } else if (n === 0x0d) {
      if (raw.charCodeAt(i + 1) === 0x0a) i++; // line continuation
    } else if (n !== 0x0a && !Number.isNaN(n)) {
      const esc: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
      out.push(esc[n] ?? n);
    }
  }
  return Uint8Array.from(out);
}

function hexBytes(raw: string): Uint8Array {
  let h = raw.replace(/[^0-9a-fA-F]/g, '');
  if (h.length & 1) h += '0';
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function stringBytes(lib: PdfLib, o: PDFObject | undefined): Uint8Array | undefined {
  if (o instanceof lib.PDFString) return literalBytes(o.asString());
  if (o instanceof lib.PDFHexString) return hexBytes(o.asString());
  return undefined;
}

/** A literal string for printable text, a hex string for anything else. */
function stringObject(lib: PdfLib, b: Uint8Array): PDFObject {
  let s = '';
  for (const c of b) {
    if (c === 0x5c || c === 0x28 || c === 0x29) s += `\\${String.fromCharCode(c)}`;
    else if (c >= 0x20 && c <= 0x7e) s += String.fromCharCode(c);
    else if (c === 0x0a) s += '\\n';
    else if (c === 0x0d) s += '\\r';
    else if (c === 0x09) s += '\\t';
    else {
      let hex = '';
      for (const x of b) hex += x.toString(16).padStart(2, '0');
      return lib.PDFHexString.of(hex.toUpperCase());
    }
  }
  return lib.PDFString.of(s);
}

function trailerId(lib: PdfLib, ctx: PDFContext): Uint8Array {
  const id = ctx.lookup(ctx.trailerInfo.ID);
  if (!(id instanceof lib.PDFArray) || !id.size()) return new Uint8Array(0);
  return stringBytes(lib, ctx.lookup(id.get(0))) ?? new Uint8Array(0);
}

// ====================================================== security handler

type Method = 'none' | 'rc4' | 'aes128' | 'aes256';

interface EncryptionParams {
  v: number;
  r: number;
  o: Uint8Array;
  u: Uint8Array;
  oe: Uint8Array;
  ue: Uint8Array;
  p: number;
  id: Uint8Array;
  /** file key length in bytes (R2–R4) */
  keyLength: number;
  encryptMetadata: boolean;
  stm: Method;
  str: Method;
  eff: Method;
  filters: Map<string, Method>;
}

interface Security {
  params: EncryptionParams;
  key: Uint8Array;
  cipher?: string;
  /** the empty user password does not open the file */
  needsPassword: boolean;
}

function readEncryption(lib: PdfLib, d: PDFDict, id: Uint8Array): EncryptionParams {
  const name = (k: string) => {
    const v = d.lookup(lib.PDFName.of(k));
    return v instanceof lib.PDFName ? v.decodeText() : undefined;
  };
  const num = (k: string, dict: PDFDict = d) => {
    const v = dict.lookup(lib.PDFName.of(k));
    return v instanceof lib.PDFNumber ? v.asNumber() : undefined;
  };
  const bytes = (k: string) => stringBytes(lib, d.lookup(lib.PDFName.of(k))) ?? new Uint8Array(0);

  const filter = name('Filter');
  if (filter !== 'Standard') {
    const sub = name('SubFilter') ?? '';
    if (filter === 'Adobe.PubSec' || sub.startsWith('adbe.pkcs7')) {
      throw new MetadataError(
        'This PDF is encrypted for specific recipients with a digital certificate (public-key security), which BlueExif cannot open.',
      );
    }
    throw new MetadataError(`This PDF uses an unsupported security handler (${filter ?? 'none'}) and cannot be opened.`);
  }
  const v = num('V') ?? 0;
  const r = num('R') ?? 0;
  const supported = ((v === 1 || v === 2) && (r === 2 || r === 3)) || (v === 4 && r === 4) || (v === 5 && (r === 5 || r === 6));
  if (!supported) throw new MetadataError(`This PDF uses an unsupported encryption revision (V${v}, R${r}) and cannot be opened.`);

  const damaged = () => new MetadataError('This PDF has a damaged encryption dictionary and cannot be opened.');
  const filters = new Map<string, Method>([['Identity', 'none']]);
  const cf = d.lookup(lib.PDFName.of('CF'));
  let cfStmLength: number | undefined;
  if (v >= 4 && cf instanceof lib.PDFDict) {
    for (const [k, f] of cf.entries()) {
      const fd = d.context.lookup(f);
      if (!(fd instanceof lib.PDFDict)) continue;
      const cfm = fd.lookup(lib.PDFName.of('CFM'));
      const m = cfm instanceof lib.PDFName ? cfm.decodeText() : 'None';
      const method: Method | undefined =
        m === 'None' ? 'none' : m === 'V2' ? 'rc4' : m === 'AESV2' ? 'aes128' : m === 'AESV3' ? 'aes256' : undefined;
      if (!method) throw new MetadataError(`This PDF uses an unsupported encryption method (${m}) and cannot be opened.`);
      if (method === 'aes256' && v < 5) throw damaged(); // needs the 256-bit key of V5
      filters.set(k.decodeText(), method);
      if (k.decodeText() === name('StmF')) cfStmLength = num('Length', fd);
    }
  }
  const pick = (n: string | undefined, fallback: Method): Method => (n === undefined ? fallback : (filters.get(n) ?? 'none'));
  const legacy = v < 4;
  const stm = legacy ? 'rc4' : pick(name('StmF'), 'none');
  const str = legacy ? 'rc4' : pick(name('StrF'), 'none');
  const eff = legacy ? 'rc4' : pick(name('EFF'), stm);

  let bits = num('Length') ?? (v === 1 ? 40 : v >= 4 ? (cfStmLength === undefined ? 128 : cfStmLength < 40 ? cfStmLength * 8 : cfStmLength) : 40);
  if (v === 1) bits = 40;
  const keyLength = r === 2 ? 5 : Math.min(16, Math.max(5, Math.floor(bits / 8)));
  const em = d.lookup(lib.PDFName.of('EncryptMetadata'));
  const o = bytes('O');
  const u = bytes('U');
  const oe = bytes('OE');
  const ue = bytes('UE');
  // Too short to check any password: say so instead of asking for one. (Longer is tolerated.)
  if (r >= 5 ? o.length < 48 || u.length < 48 || oe.length < 32 || ue.length < 32 : o.length < 32 || u.length < (r === 2 ? 32 : 16)) {
    throw damaged();
  }
  return {
    v,
    r,
    o,
    u,
    oe,
    ue,
    p: (num('P') ?? 0) | 0,
    id,
    keyLength,
    encryptMetadata: !(v >= 4 && em instanceof lib.PDFBool && !em.asBoolean()),
    stm,
    str,
    eff,
    filters,
  };
}

function cipherName(p: EncryptionParams): string | undefined {
  const m = p.stm !== 'none' ? p.stm : p.str !== 'none' ? p.str : p.eff;
  if (m === 'rc4') return `RC4 ${p.keyLength * 8}-bit`;
  if (m === 'aes128') return 'AES-128';
  if (m === 'aes256') return 'AES-256';
  return undefined;
}

const fileKey = (p: EncryptionParams, pw: string) => (p.r >= 5 ? authenticateAes256(p, pw) : authenticateLegacy(p, pw));

function authenticate(p: EncryptionParams, password?: string): Security {
  const tries = password ? [password, ''] : [''];
  for (const pw of tries) {
    const key = fileKey(p, pw);
    if (key) return { params: p, key, cipher: cipherName(p), needsPassword: pw !== '' && !fileKey(p, '') };
  }
  if (password) throw new MetadataError('The password is incorrect.', 'wrong-password');
  throw new MetadataError('This PDF is password protected. Enter its password to open it.', 'password-required');
}

// --------------------------------------------------- R2–R4 (Algorithms 2–7)

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** PDFDocEncoding characters outside Latin-1: 0x18–0x1F, and 0x80–0x9E then 0xA0. */
const PDFDOC_LOW = '˘ˇˆ˙˝˛˚˜';
const PDFDOC_HIGH = '•†‡…—–ƒ⁄‹›−‰„“”‘’‚™ﬁﬂŁŒŠŸŽıłœšž';

/** PDFDocEncoding bytes; unencodable characters become "?". Only the first 32 bytes are ever used. */
function pdfDocBytes(s: string): Uint8Array {
  const chars = [...s.slice(0, 64)].slice(0, 32);
  return Uint8Array.from(chars, (ch) => {
    const c = ch.codePointAt(0)!;
    const lo = PDFDOC_LOW.indexOf(ch);
    const hi = PDFDOC_HIGH.indexOf(ch);
    if (lo >= 0) return 0x18 + lo;
    if (hi >= 0) return 0x80 + hi;
    if (ch === '€') return 0xa0;
    return c <= 0xff && !(c >= 0x18 && c <= 0x1f) && !(c >= 0x7f && c <= 0xa0) && c !== 0xad ? c : 0x3f;
  });
}

/**
 * RFC 4013 SASLprep: non-ASCII spaces become U+0020, "commonly mapped to nothing"
 * characters go, then NFKC. Its prohibited-character and bidi checks are skipped:
 * a password that fails them simply does not match.
 */
export function saslPrep(s: string): string {
  return s
    .replace(/[\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000]/g, ' ')
    .replace(/[\u00ad\u034f\u1806\u180b-\u180d\u200b-\u200d\u2060\ufe00-\ufe0f\ufeff]/g, '')
    .normalize('NFKC');
}

/**
 * Byte encodings to try for a password: PDFDocEncoding for R2–R4 and SASLprep'd
 * UTF-8 (at most 127 bytes) for R5/R6, as ISO 32000-2 §7.6.4.3 requires, then plain
 * UTF-8, which some writers (Ghostscript for RC4, for one) use instead.
 */
function passwordVariants(pw: string, aes256: boolean): Uint8Array[] {
  const list = aes256 ? [encodeUtf8(saslPrep(pw)), encodeUtf8(pw)] : [pdfDocBytes(pw), encodeUtf8(pw)];
  const cut = list.map((b) => b.subarray(0, aes256 ? 127 : 32));
  return cut.filter((b, i) => cut.findIndex((x) => equalBytes(x, b)) === i);
}

const padPassword = (pw: Uint8Array) => concat([pw.subarray(0, 32), PAD.subarray(0, Math.max(0, 32 - pw.length))]);

const xorKey = (key: Uint8Array, x: number) => key.map((b) => b ^ x);

/** Algorithm 2: file key from a (user) password. */
function legacyFileKey(p: EncryptionParams, pw: Uint8Array): Uint8Array {
  const pBytes = Uint8Array.of(p.p & 0xff, (p.p >> 8) & 0xff, (p.p >> 16) & 0xff, (p.p >>> 24) & 0xff);
  const parts = [padPassword(pw), p.o.subarray(0, 32), pBytes, p.id];
  if (p.r >= 4 && !p.encryptMetadata) parts.push(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
  let h = md5(concat(parts));
  const n = p.keyLength;
  if (p.r >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  return h.slice(0, n);
}

/** Algorithms 4/5/6: does `key` reproduce /U? */
function userKeyMatches(p: EncryptionParams, key: Uint8Array): boolean {
  if (p.r === 2) return equalBytes(rc4(key, PAD), p.u.subarray(0, 32));
  let x = md5(concat([PAD, p.id]));
  for (let i = 0; i < 20; i++) x = rc4(xorKey(key, i), x);
  return equalBytes(x, p.u.subarray(0, 16));
}

/**
 * Algorithm 7: the (padded) user password recovered from an owner password.
 * Writers disagree on whether Algorithm 3's 50 extra MD5 rounds hash the first
 * n bytes (Acrobat, Quartz, Ghostscript, qpdf) or all 16 (pdf.js); this only
 * matters for keys shorter than 128 bits.
 */
function userFromOwner(p: EncryptionParams, pw: Uint8Array, wholeDigest: boolean): Uint8Array {
  let h = md5(padPassword(pw));
  const n = p.keyLength;
  if (p.r >= 3) for (let i = 0; i < 50; i++) h = md5(wholeDigest ? h : h.subarray(0, n));
  const key = h.subarray(0, n);
  let x = p.o.subarray(0, 32);
  if (p.r === 2) return rc4(key, x);
  for (let i = 19; i >= 0; i--) x = rc4(xorKey(key, i), x);
  return x;
}

function authenticateLegacy(p: EncryptionParams, password: string): Uint8Array | null {
  for (const pw of passwordVariants(password, false)) {
    const userKey = legacyFileKey(p, pw);
    if (userKeyMatches(p, userKey)) return userKey;
    for (const whole of p.r >= 3 && p.keyLength < 16 ? [false, true] : [false]) {
      const ownerKey = legacyFileKey(p, userFromOwner(p, pw, whole));
      if (userKeyMatches(p, ownerKey)) return ownerKey;
    }
  }
  return null;
}

// --------------------------------------------- R5/R6 (Algorithms 2.A, 2.B)

/** Algorithm 2.B (R6) or plain SHA-256 (R5). */
function hashR6(r: number, pw: Uint8Array, salt: Uint8Array, udata: Uint8Array): Uint8Array {
  let k = sha256(concat([pw, salt, udata]));
  if (r === 5) return k;
  let e: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < 64 || e[e.length - 1] > i - 32; i++) {
    const unit = concat([pw, k, udata]);
    const k1 = new Uint8Array(unit.length * 64);
    for (let j = 0; j < 64; j++) k1.set(unit, j * unit.length);
    e = aesCbcEncrypt(k.subarray(0, 16), k.subarray(16, 32), k1);
    let mod = 0;
    for (let j = 0; j < 16; j++) mod += e[j];
    k = mod % 3 === 0 ? sha256(e) : mod % 3 === 1 ? sha384(e) : sha512(e);
  }
  return k.subarray(0, 32);
}

function authenticateAes256(p: EncryptionParams, password: string): Uint8Array | null {
  const u48 = p.u.subarray(0, 48);
  const iv = new Uint8Array(16);
  for (const pw of passwordVariants(password, true)) {
    if (equalBytes(hashR6(p.r, pw, p.u.subarray(32, 40), new Uint8Array(0)), p.u.subarray(0, 32))) {
      return aesCbcDecrypt(hashR6(p.r, pw, p.u.subarray(40, 48), new Uint8Array(0)), iv, p.ue.subarray(0, 32));
    }
    if (equalBytes(hashR6(p.r, pw, p.o.subarray(32, 40), u48), p.o.subarray(0, 32))) {
      return aesCbcDecrypt(hashR6(p.r, pw, p.o.subarray(40, 48), u48), iv, p.oe.subarray(0, 32));
    }
  }
  return null;
}

// ------------------------------------------------------------ decryption

class Decryptor {
  private readonly keys = new Map<string, Uint8Array>();

  constructor(
    private readonly lib: PdfLib,
    private readonly sec: Security,
  ) {}

  /** Algorithm 1: per-object key (R2–R4); the file key itself for AES-256. */
  private key(ref: PDFRef, m: Method): Uint8Array {
    if (m === 'aes256') return this.sec.key;
    const id = `${ref.objectNumber} ${ref.generationNumber} ${m}`;
    let k = this.keys.get(id);
    if (!k) {
      const { objectNumber: n, generationNumber: g } = ref;
      const parts = [this.sec.key, Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, g & 0xff, (g >> 8) & 0xff)];
      if (m === 'aes128') parts.push(Uint8Array.of(0x73, 0x41, 0x6c, 0x54)); // "sAlT"
      k = md5(concat(parts)).slice(0, Math.min(this.sec.key.length + 5, 16));
      this.keys.set(id, k);
    }
    return k;
  }

  private bytes(ref: PDFRef, m: Method, data: Uint8Array): Uint8Array {
    if (m === 'none') return data;
    if (m === 'rc4') return rc4(this.key(ref, m), data);
    if (data.length < 16) return new Uint8Array(0);
    return unpad(aesCbcDecrypt(this.key(ref, m), data.subarray(0, 16), data.subarray(16)));
  }

  /** Decrypted replacement for a top-level object (containers are updated in place). */
  object(ref: PDFRef, o: PDFObject): PDFObject {
    const { lib } = this;
    if (o instanceof lib.PDFRawStream) return this.stream(ref, o);
    if (o instanceof lib.PDFString || o instanceof lib.PDFHexString) {
      return stringObject(lib, this.bytes(ref, this.sec.params.str, stringBytes(lib, o)!));
    }
    if (o instanceof lib.PDFDict) this.dict(ref, o);
    else if (o instanceof lib.PDFArray) this.array(ref, o);
    return o;
  }

  private dict(ref: PDFRef, d: PDFDict): void {
    const { lib } = this;
    const type = d.get(lib.PDFName.of('Type'));
    const signature =
      type === lib.PDFName.of('Sig') ||
      type === lib.PDFName.of('DocTimeStamp') ||
      (d.get(lib.PDFName.of('ByteRange')) instanceof lib.PDFArray && d.get(lib.PDFName.of('Contents')) instanceof lib.PDFHexString);
    for (const [k, v] of d.entries()) {
      if (signature && k === lib.PDFName.of('Contents')) continue;
      const out = this.direct(ref, v);
      if (out !== v) d.set(k, out);
    }
  }

  private array(ref: PDFRef, a: PDFArray): void {
    for (let i = 0; i < a.size(); i++) {
      const v = a.get(i);
      const out = this.direct(ref, v);
      if (out !== v) a.set(i, out);
    }
  }

  private direct(ref: PDFRef, v: PDFObject): PDFObject {
    const { lib } = this;
    if (v instanceof lib.PDFString || v instanceof lib.PDFHexString || v instanceof lib.PDFRawStream) return this.object(ref, v);
    if (v instanceof lib.PDFDict) this.dict(ref, v);
    else if (v instanceof lib.PDFArray) this.array(ref, v);
    return v;
  }

  /** Decrypt a stream's dictionary strings and data; removes a /Crypt filter. */
  stream(ref: PDFRef, s: PDFRawStream): PDFRawStream {
    const { lib } = this;
    const { dict } = s;
    this.dict(ref, dict);
    const m = this.streamMethod(dict, s.contents);
    if (m === 'none') return s;
    const data = this.bytes(ref, m, s.contents);
    dict.set(lib.PDFName.of('Length'), lib.PDFNumber.of(data.length));
    return lib.PDFRawStream.of(dict, data);
  }

  private streamMethod(dict: PDFDict, data: Uint8Array): Method {
    const { lib } = this;
    const p = this.sec.params;
    const F = lib.PDFName.of('Filter');
    const DP = lib.PDFName.of('DecodeParms');
    const filter = dict.lookup(F);
    const first = filter instanceof lib.PDFArray ? dict.context.lookup(filter.get(0)) : filter;
    if (first === lib.PDFName.of('Crypt')) {
      const parms = dict.lookup(DP);
      const p0 = parms instanceof lib.PDFArray ? dict.context.lookup(parms.get(0)) : parms;
      const nm = p0 instanceof lib.PDFDict ? p0.lookup(lib.PDFName.of('Name')) : undefined;
      // The crypt filter is consumed here, so the saved (plain) stream must not name it.
      if (filter instanceof lib.PDFArray && filter.size() > 1) {
        filter.remove(0);
        if (parms instanceof lib.PDFArray && parms.size()) parms.remove(0);
        else dict.delete(DP);
      } else {
        dict.delete(F);
        dict.delete(DP);
      }
      return nm instanceof lib.PDFName ? (p.filters.get(nm.decodeText()) ?? 'none') : 'none';
    }
    const type = dict.lookup(lib.PDFName.of('Type'));
    if (type === lib.PDFName.of('Metadata')) {
      if (!p.encryptMetadata) return 'none';
      // Ghostscript leaves XMP in the clear even where it must be encrypted;
      // ciphertext practically never starts like an XML packet.
      if (!filter && plainXml(data)) return 'none';
    }
    if (type === lib.PDFName.of('EmbeddedFile')) return p.eff;
    return p.stm;
  }
}

/** Unencrypted XML: optional BOM and whitespace, then "<?xpacket", "<?xml" or "<x:xmpmeta". */
function plainXml(b: Uint8Array): boolean {
  let i = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  while (i < b.length && isWhite(b[i])) i++;
  const head = latin1(b.subarray(i, i + 10));
  return head.startsWith('<?xpacket') || head.startsWith('<?xml') || head.startsWith('<x:xmpmeta');
}

/** Strip PKCS#5 padding when it is well-formed (some writers get it wrong). */
function unpad(b: Uint8Array): Uint8Array {
  const n = b[b.length - 1];
  if (!n || n > 16 || n > b.length) return b;
  for (let i = b.length - n; i < b.length; i++) if (b[i] !== n) return b;
  return b.subarray(0, b.length - n);
}

// ================================================================= crypto
// Small, synchronous implementations (see the header for why not WebCrypto).
// Exported for tests, which check them against node:crypto.

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

/** Message padded to whole `block`s with a 0x80 byte and the bit length (LE for MD5, BE otherwise). */
function mdPad(data: Uint8Array, block: number, lenBytes: number, le: boolean): DataView {
  const buf = new Uint8Array(Math.ceil((data.length + 1 + lenBytes) / block) * block);
  buf.set(data);
  buf[data.length] = 0x80;
  const v = new DataView(buf.buffer);
  const bits = data.length * 8;
  const hi = Math.floor(bits / 0x100000000);
  if (le) {
    v.setUint32(buf.length - 8, bits >>> 0, true);
    v.setUint32(buf.length - 4, hi, true);
  } else {
    v.setUint32(buf.length - 8, hi);
    v.setUint32(buf.length - 4, bits >>> 0);
  }
  return v;
}

export function md5(data: Uint8Array): Uint8Array {
  const v = mdPad(data, 64, 8, true);
  const h = Int32Array.of(0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476);
  const m = new Int32Array(16);
  for (let off = 0; off < v.byteLength; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = v.getInt32(off + i * 4, true);
    let [a, b, c, d] = h;
    for (let i = 0; i < 64; i++) {
      const f = i < 16 ? (b & c) | (~b & d) : i < 32 ? (d & b) | (~d & c) : i < 48 ? b ^ c ^ d : c ^ (b | ~d);
      const g = i < 16 ? i : i < 32 ? (5 * i + 1) & 15 : i < 48 ? (3 * i + 5) & 15 : (7 * i) & 15;
      const t = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + MD5_K[i] + m[g]) | 0, MD5_S[(i >> 4) * 4 + (i & 3)])) | 0;
      a = t;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) ov.setInt32(i * 4, h[i], true);
  return out;
}

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
    out[k] = data[k] ^ s[(s[i] + t) & 255];
  }
  return out;
}

/** SHA-512 round constants as (high, low) 32-bit pairs; SHA-256 uses the high halves of the first 64. */
const K512 = [
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
  0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
  0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
  0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
  0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
  0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
  0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
  0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
  0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
  0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
  0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
  0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
  0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
  0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
  0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
  0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
];
const H512 = [
  0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
  0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179,
];
const H384 = [
  0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939,
  0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4,
];

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export function sha256(data: Uint8Array): Uint8Array {
  const v = mdPad(data, 64, 8, false);
  const h = Int32Array.from({ length: 8 }, (_, i) => H512[i * 2]);
  const w = new Int32Array(64);
  for (let off = 0; off < v.byteLength; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = v.getInt32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K512[i * 2] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((x, i) => (h[i] += x));
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setInt32(i * 4, h[i]);
  return out;
}

const TWO32 = 0x100000000;

/** SHA-512, or SHA-384 with `bits` 384; 64-bit words as (hi, lo) int32 pairs. */
function sha2x64(data: Uint8Array, bits: 384 | 512): Uint8Array {
  const v = mdPad(data, 128, 16, false);
  const init = bits === 384 ? H384 : H512;
  const hh = Int32Array.from({ length: 8 }, (_, i) => init[i * 2]);
  const hl = Int32Array.from({ length: 8 }, (_, i) => init[i * 2 + 1]);
  const wh = new Int32Array(80);
  const wl = new Int32Array(80);
  for (let off = 0; off < v.byteLength; off += 128) {
    for (let i = 0; i < 16; i++) {
      wh[i] = v.getInt32(off + i * 8);
      wl[i] = v.getInt32(off + i * 8 + 4);
    }
    for (let i = 16; i < 80; i++) {
      const xh = wh[i - 15];
      const xl = wl[i - 15];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      const yh = wh[i - 2];
      const yl = wl[i - 2];
      const s1h = ((yh >>> 19) | (yl << 13)) ^ ((yl >>> 29) | (yh << 3)) ^ (yh >>> 6);
      const s1l = ((yl >>> 19) | (yh << 13)) ^ ((yh >>> 29) | (yl << 3)) ^ ((yl >>> 6) | (yh << 26));
      const lo = (wl[i - 16] >>> 0) + (s0l >>> 0) + (wl[i - 7] >>> 0) + (s1l >>> 0);
      wh[i] = wh[i - 16] + s0h + wh[i - 7] + s1h + Math.floor(lo / TWO32);
      wl[i] = lo;
    }
    let [a, b, c, d, e, f, g, h] = hh;
    let [a1, b1, c1, d1, e1, f1, g1, h1] = hl;
    for (let i = 0; i < 80; i++) {
      const S1h = ((e >>> 14) | (e1 << 18)) ^ ((e >>> 18) | (e1 << 14)) ^ ((e1 >>> 9) | (e << 23));
      const S1l = ((e1 >>> 14) | (e << 18)) ^ ((e1 >>> 18) | (e << 14)) ^ ((e >>> 9) | (e1 << 23));
      const chh = (e & f) ^ (~e & g);
      const chl = (e1 & f1) ^ (~e1 & g1);
      let lo = (h1 >>> 0) + (S1l >>> 0) + (chl >>> 0) + K512[i * 2 + 1] + (wl[i] >>> 0);
      const t1h = (h + S1h + chh + K512[i * 2] + wh[i] + Math.floor(lo / TWO32)) | 0;
      const t1l = lo | 0;
      const S0h = ((a >>> 28) | (a1 << 4)) ^ ((a1 >>> 2) | (a << 30)) ^ ((a1 >>> 7) | (a << 25));
      const S0l = ((a1 >>> 28) | (a << 4)) ^ ((a >>> 2) | (a1 << 30)) ^ ((a >>> 7) | (a1 << 25));
      lo = (S0l >>> 0) + (((a1 & b1) ^ (a1 & c1) ^ (b1 & c1)) >>> 0);
      const t2h = (S0h + ((a & b) ^ (a & c) ^ (b & c)) + Math.floor(lo / TWO32)) | 0;
      const t2l = lo | 0;
      h = g;
      h1 = g1;
      g = f;
      g1 = f1;
      f = e;
      f1 = e1;
      lo = (d1 >>> 0) + (t1l >>> 0);
      e = (d + t1h + Math.floor(lo / TWO32)) | 0;
      e1 = lo | 0;
      d = c;
      d1 = c1;
      c = b;
      c1 = b1;
      b = a;
      b1 = a1;
      lo = (t1l >>> 0) + (t2l >>> 0);
      a = (t1h + t2h + Math.floor(lo / TWO32)) | 0;
      a1 = lo | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((x, i) => {
      const lo = (hl[i] >>> 0) + ([a1, b1, c1, d1, e1, f1, g1, h1][i] >>> 0);
      hh[i] = hh[i] + x + Math.floor(lo / TWO32);
      hl[i] = lo;
    });
  }
  const out = new Uint8Array(64);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    ov.setInt32(i * 8, hh[i]);
    ov.setInt32(i * 8 + 4, hl[i]);
  }
  return out.subarray(0, bits / 8);
}

export const sha384 = (data: Uint8Array) => sha2x64(data, 384);
export const sha512 = (data: Uint8Array) => sha2x64(data, 512);

// ------------------------------------------------------------------- AES
// Table-driven AES after the Stanford JavaScript Crypto Library.

interface AesTables {
  enc: Uint32Array[];
  dec: Uint32Array[];
  sbox: Uint8Array;
  inv: Uint8Array;
}

let aesTables: AesTables | null = null;

function tables(): AesTables {
  if (aesTables) return aesTables;
  const enc = [0, 1, 2, 3].map(() => new Uint32Array(256));
  const dec = [0, 1, 2, 3].map(() => new Uint32Array(256));
  const sbox = new Uint8Array(256);
  const inv = new Uint8Array(256);
  const d = new Uint8Array(256);
  const th = new Uint8Array(256);
  for (let i = 0; i < 256; i++) th[(d[i] = (i << 1) ^ ((i >> 7) * 283)) ^ i] = i;
  for (let n = 0, x = 0, xInv = 0; n < 256; n++) {
    let s = xInv ^ (xInv << 1) ^ (xInv << 2) ^ (xInv << 3) ^ (xInv << 4);
    s = (s >> 8) ^ (s & 255) ^ 99;
    sbox[x] = s;
    inv[s] = x;
    const x2 = d[x];
    const x4 = d[x2];
    const x8 = d[x4];
    let tDec = (x8 * 0x1010101) ^ (x4 * 0x10001) ^ (x2 * 0x101) ^ (x * 0x1010100);
    let tEnc = (d[s] * 0x101) ^ (s * 0x1010100);
    for (let i = 0; i < 4; i++) {
      enc[i][x] = tEnc = (tEnc << 24) ^ (tEnc >>> 8);
      dec[i][s] = tDec = (tDec << 24) ^ (tDec >>> 8);
    }
    x ^= x2 || 1;
    xInv = th[xInv] || 1;
  }
  return (aesTables = { enc, dec, sbox, inv });
}

class Aes {
  private readonly ek: Uint32Array;
  private readonly dk: Uint32Array;

  constructor(key: Uint8Array) {
    if (key.length !== 16 && key.length !== 24 && key.length !== 32) throw new MetadataError('Invalid AES key.');
    const { sbox, dec } = tables();
    const kl = key.length / 4;
    const total = 4 * kl + 28;
    const ek = new Uint32Array(total);
    const kv = new DataView(key.buffer, key.byteOffset, key.byteLength);
    for (let i = 0; i < kl; i++) ek[i] = kv.getUint32(i * 4);
    for (let i = kl, rcon = 1; i < total; i++) {
      let t = ek[i - 1];
      if (i % kl === 0 || (kl === 8 && i % kl === 4)) {
        t = (sbox[t >>> 24] << 24) ^ (sbox[(t >> 16) & 255] << 16) ^ (sbox[(t >> 8) & 255] << 8) ^ sbox[t & 255];
        if (i % kl === 0) {
          t = (t << 8) ^ (t >>> 24) ^ (rcon << 24);
          rcon = (rcon << 1) ^ ((rcon >> 7) * 283);
        }
      }
      ek[i] = ek[i - kl] ^ t;
    }
    const dk = new Uint32Array(total);
    for (let j = 0, i = total; i; j++, i--) {
      const t = ek[j & 3 ? i : i - 4];
      dk[j] =
        i <= 4 || j < 4
          ? t
          : dec[0][sbox[t >>> 24]] ^ dec[1][sbox[(t >> 16) & 255]] ^ dec[2][sbox[(t >> 8) & 255]] ^ dec[3][sbox[t & 255]];
    }
    this.ek = ek;
    this.dk = dk;
  }

  /** Encrypt (dir 0) or decrypt (dir 1) one block of four big-endian words in place. */
  crypt(w: Uint32Array, dir: 0 | 1): void {
    const t = tables();
    const key = dir ? this.dk : this.ek;
    const [t0, t1, t2, t3] = dir ? t.dec : t.enc;
    const sbox = dir ? t.inv : t.sbox;
    let a = w[0] ^ key[0];
    let b = w[dir ? 3 : 1] ^ key[1];
    let c = w[2] ^ key[2];
    let d = w[dir ? 1 : 3] ^ key[3];
    let k = 4;
    for (let i = key.length / 4 - 2; i > 0; i--) {
      const a2 = t0[a >>> 24] ^ t1[(b >> 16) & 255] ^ t2[(c >> 8) & 255] ^ t3[d & 255] ^ key[k];
      const b2 = t0[b >>> 24] ^ t1[(c >> 16) & 255] ^ t2[(d >> 8) & 255] ^ t3[a & 255] ^ key[k + 1];
      const c2 = t0[c >>> 24] ^ t1[(d >> 16) & 255] ^ t2[(a >> 8) & 255] ^ t3[b & 255] ^ key[k + 2];
      d = t0[d >>> 24] ^ t1[(a >> 16) & 255] ^ t2[(b >> 8) & 255] ^ t3[c & 255] ^ key[k + 3];
      k += 4;
      a = a2;
      b = b2;
      c = c2;
    }
    for (let i = 0; i < 4; i++) {
      w[dir ? 3 & -i : i] =
        (sbox[a >>> 24] << 24) ^ (sbox[(b >> 16) & 255] << 16) ^ (sbox[(c >> 8) & 255] << 8) ^ sbox[d & 255] ^ key[k++];
      const a2 = a;
      a = b;
      b = c;
      c = d;
      d = a2;
    }
  }
}

/** AES-CBC without padding; a trailing partial block is ignored. */
function aesCbc(key: Uint8Array, iv: Uint8Array, data: Uint8Array, dir: 0 | 1): Uint8Array {
  const aes = new Aes(key);
  const n = data.length >> 4;
  const out = new Uint8Array(n * 16);
  const dv = new DataView(data.buffer, data.byteOffset, n * 16);
  const ov = new DataView(out.buffer);
  const ivv = new DataView(iv.buffer, iv.byteOffset, 16);
  const prev = Uint32Array.from({ length: 4 }, (_, i) => ivv.getUint32(i * 4));
  const w = new Uint32Array(4);
  const c = new Uint32Array(4);
  for (let b = 0; b < n; b++) {
    for (let i = 0; i < 4; i++) c[i] = dv.getUint32(b * 16 + i * 4);
    if (dir) {
      w.set(c);
      aes.crypt(w, 1);
      for (let i = 0; i < 4; i++) ov.setUint32(b * 16 + i * 4, w[i] ^ prev[i]);
      prev.set(c);
    } else {
      for (let i = 0; i < 4; i++) w[i] = c[i] ^ prev[i];
      aes.crypt(w, 0);
      for (let i = 0; i < 4; i++) ov.setUint32(b * 16 + i * 4, w[i]);
      prev.set(w);
    }
  }
  return out;
}

export const aesCbcEncrypt = (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => aesCbc(key, iv, data, 0);
export const aesCbcDecrypt = (key: Uint8Array, iv: Uint8Array, data: Uint8Array) => aesCbc(key, iv, data, 1);
