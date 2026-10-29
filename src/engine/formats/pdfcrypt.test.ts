import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as PdfLib from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { MetadataError, Source } from '../core/types';
import { REMOVE, bytesOf, edits, etProblems, exiftool, field, fixtureBytes, fixturePath, strip } from '../test/helpers';
import { HAS_SWIFT, pdfKitPages, preparePdfKit } from '../test/docOracles';
import { pdfHandler } from './pdf';
import { aesCbcDecrypt, aesCbcEncrypt, md5, openPdf, rc4, saslPrep, sha256, sha384, sha512 } from './pdfcrypt';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('pdfcrypt primitives', () => {
  const sizes = [0, 1, 55, 56, 63, 64, 65, 111, 112, 119, 120, 127, 128, 129, 1000, 5000];
  it('hashes match node:crypto', () => {
    for (const n of sizes) {
      const d = new Uint8Array(randomBytes(n));
      expect(hex(md5(d))).toBe(createHash('md5').update(d).digest('hex'));
      expect(hex(sha256(d))).toBe(createHash('sha256').update(d).digest('hex'));
      expect(hex(sha384(d))).toBe(createHash('sha384').update(d).digest('hex'));
      expect(hex(sha512(d))).toBe(createHash('sha512').update(d).digest('hex'));
    }
  });
  it('AES-CBC matches node:crypto', () => {
    for (const bits of [128, 256]) {
      for (const blocks of [1, 2, 7, 64]) {
        const key = new Uint8Array(randomBytes(bits / 8));
        const iv = new Uint8Array(randomBytes(16));
        const data = new Uint8Array(randomBytes(blocks * 16));
        const c = createCipheriv(`aes-${bits}-cbc`, key, iv).setAutoPadding(false);
        const ref = new Uint8Array(Buffer.concat([c.update(data), c.final()]));
        expect(hex(aesCbcEncrypt(key, iv, data))).toBe(hex(ref));
        expect(hex(aesCbcDecrypt(key, iv, ref))).toBe(hex(data));
      }
    }
  });
  it('RC4 matches the RFC 6229 vectors', () => {
    const ks = (key: number[]) => hex(rc4(Uint8Array.from(key), new Uint8Array(16)));
    expect(ks([1, 2, 3, 4, 5])).toBe('b2396305f03dc027ccc3524a0a1118a8');
    expect(ks([...Array(16)].map((_, i) => i + 1))).toBe('9ac7cc9a609d1ef7b2932899cde41b97');
    expect(hex(rc4(new TextEncoder().encode('Key'), new TextEncoder().encode('Plaintext')))).toBe('bbf316e8d940af0ad3');
  });
  it('SASLprep matches the RFC 4013 examples', () => {
    expect(saslPrep('I\u00adX')).toBe('IX');
    expect(saslPrep('user')).toBe('user');
    expect(saslPrep('USER')).toBe('USER');
    expect(saslPrep('\u00aa')).toBe('a');
    expect(saslPrep('\u2168')).toBe('IX');
    expect(saslPrep('a\u00a0b\u1680c\u3000d')).toBe('a b c d');
    expect(saslPrep('\ufeffpass\u200dword\ufe0f')).toBe('password');
  });
});

// ------------------------------------------------------------------ oracles

/** One fixture from scripts/fixtures/pdfcrypt.mjs. */
interface Fixture {
  file: string;
  tool: string;
  cipher: string;
  /** "" when only an owner password is set */
  user: string;
  owner: string;
  title: string;
  author: string;
  pages: number;
  objectStreams: boolean;
  /** XMP dc:title equals `title` */
  xmp?: boolean;
  /** carries the notes.txt attachment */
  attachment?: boolean;
  /** page n draws "(Encrypted page n of pages) Tj ET\n" */
  pageText?: boolean;
  /** has a stream with the /Identity crypt filter */
  identityStream?: boolean;
  /** has a signature dictionary, whose /Contents is never encrypted */
  signature?: boolean;
  /** PDFKit cannot open the encrypted original */
  pdfkit?: false;
  /** a non-ASCII RC4/AES-128 password: the spec's PDFDocEncoding, or the UTF-8 Ghostscript uses */
  passwordEncoding?: 'PDFDocEncoding' | 'UTF-8';
}

const MARK = 'SECRET-MARKER-42';
const XMP_TITLE = 'xmp:http://purl.org/dc/elements/1.1/|title';
const XMP_CREATOR = 'xmp:http://purl.org/dc/elements/1.1/|creator';
const NOTES = 'Meeting notes: totals look fine.';
const PASSWORD_WARNING = 'This PDF is password protected. Copies saved by BlueExif will not have a password.';
const OWNER_WARNING = 'This PDF has an owner password that limits printing, copying or editing. Copies saved by BlueExif will not have these restrictions.';

const manifest = JSON.parse(readFileSync(fixturePath('pdfcrypt/manifest.json'), 'utf8')) as Fixture[];

function which(cmd: string): boolean {
  try {
    execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_GS = which('gs');

/** PDFKit and ExifTool only take ASCII passwords. */
const asciiPassword = (f: Fixture) => [f.user, f.owner].find((p) => p && /^[\x20-\x7e]+$/.test(p)) ?? '';

function withFile<T>(bytes: Uint8Array, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'blueexif-pdfcrypt-'));
  try {
    const p = join(dir, 'x.pdf');
    writeFileSync(p, bytes);
    return fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Ghostscript's text extraction (it decrypts with `password`). */
function gsText(bytes: Uint8Array, password?: string): string {
  return withFile(bytes, (p) =>
    execFileSync('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=txtwrite', ...(password ? [`-sPDFPassword=${password}`] : []), '-sOutputFile=-', p], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}

interface PdfKitView {
  opened: boolean;
  encrypted?: boolean;
  locked?: boolean;
  unlocked?: boolean;
  pages?: number;
  title?: string | null;
  author?: string | null;
  /** grayscale page renderings, base64 */
  renders?: string[];
}

const TOOLS_SRC = join(__dirname, '../../../scripts/fixtures/pdfcrypt_tools.swift');
let toolsBin: string | null = null;

/** Compile (once, cached in the temp dir) the PDFKit unlock/render tool used by the fixture script. */
function prepareTools(): string {
  if (toolsBin) return toolsBin;
  const hash = createHash('sha1').update(readFileSync(TOOLS_SRC)).digest('hex').slice(0, 10);
  const dir = join(tmpdir(), `blueexif-pdfcrypt-tools-${hash}`);
  const bin = join(dir, 'pdfcrypt_tools');
  if (!existsSync(bin)) {
    mkdirSync(dir, { recursive: true });
    const tmp = `${bin}.${process.pid}`;
    execFileSync('swiftc', ['-O', TOOLS_SRC, '-o', tmp], { stdio: 'pipe', timeout: 600_000 });
    renameSync(tmp, bin);
  }
  return (toolsBin = bin);
}

/** PDFKit's view of a file: lock state, page count, title and renderings (unlocking with `password`). */
function pdfKitView(bytes: Uint8Array, password?: string): PdfKitView {
  const bin = prepareTools();
  return withFile(bytes, (p) => {
    const args = ['check', p, ...(password === undefined ? [] : [password])];
    // stderr: CoreGraphics chatter about the encrypted originals
    const out = execFileSync(bin, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out) as PdfKitView;
  });
}

/** Decoded content streams of every page (unencrypted files only). */
async function pageContents(bytes: Uint8Array): Promise<string[][]> {
  const doc = await PdfLib.PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((page) => {
    const c = page.node.Contents();
    const list = c instanceof PdfLib.PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
    return list
      .filter((s): s is PdfLib.PDFRawStream => s instanceof PdfLib.PDFRawStream)
      .map((s) => Buffer.from(PdfLib.decodePDFRawStream(s).decode()).toString('latin1'));
  });
}

/** Raw bytes plus every decoded stream, so compressed leftovers are found too. */
async function allText(bytes: Uint8Array): Promise<string> {
  let s = Buffer.from(bytes).toString('latin1');
  const doc = await PdfLib.PDFDocument.load(bytes, { updateMetadata: false });
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PdfLib.PDFRawStream)) continue;
    try {
      s += Buffer.from(PdfLib.decodePDFRawStream(o).decode()).toString('latin1');
    } catch {
      /* image data */
    }
  }
  return s;
}

const src = (bytes: Uint8Array, name: string, password?: string) => Source.fromBytes(bytes, name, { password });
const infoOf = (m: { info: { label: string; value: string }[] }, label: string) => m.info.find((i) => i.label === label)?.value;

/** The output is a plain PDF that BlueExif, pdf-lib and PDFKit open without a password. */
async function expectUnencrypted(bytes: Uint8Array, f: Fixture): Promise<void> {
  expect(Buffer.from(bytes).includes('/Encrypt')).toBe(false);
  const doc = await PdfLib.PDFDocument.load(bytes, { updateMetadata: false });
  expect(doc.isEncrypted).toBe(false);
  expect(doc.getPageCount()).toBe(f.pages);
  expect(infoOf(await pdfHandler.read(src(bytes, 'out.pdf')), 'Encrypted')).toBe('No');
  if (HAS_SWIFT) expect(pdfKitPages(bytes)).toBe(f.pages);
  if (HAS_GS) expect(gsText(bytes).match(/Encrypted page \d/g)?.length).toBe(f.pages);
}

// ------------------------------------------------------------ the fixtures

describe('encrypted PDFs', () => {
  beforeAll(() => {
    if (HAS_SWIFT) {
      preparePdfKit();
      prepareTools();
    }
  }, 900_000);

  it('has every variant the security handler supports', () => {
    const ciphers = new Set(manifest.map((f) => f.cipher));
    expect([...ciphers].sort()).toEqual(['AES-128', 'AES-256', 'RC4 128-bit', 'RC4 40-bit']);
    expect(manifest.some((f) => !f.user)).toBe(true);
    expect(manifest.some((f) => f.objectStreams)).toBe(true);
    expect(manifest.some((f) => f.identityStream)).toBe(true);
    expect(manifest.map((f) => f.passwordEncoding).filter(Boolean).sort()).toEqual(['PDFDocEncoding', 'UTF-8']);
    expect(manifest.some((f) => f.cipher === 'AES-256' && /[^\x20-\x7e]/.test(f.user))).toBe(true);
  });

  for (const f of manifest) {
    const bytes = fixtureBytes(`pdfcrypt/${f.file}`);

    describe(`${f.file} — ${f.tool}`, () => {
      it('needs the user or owner password', async () => {
        if (f.user) {
          await expect(pdfHandler.read(src(bytes, f.file))).rejects.toMatchObject({ name: 'MetadataError', code: 'password-required' });
          await expect(pdfHandler.read(src(bytes, f.file, 'not the password'))).rejects.toMatchObject({ name: 'MetadataError', code: 'wrong-password' });
          await expect(pdfHandler.strip!(src(bytes, f.file), strip())).rejects.toMatchObject({ code: 'password-required' });
        } else {
          // The empty user password is tried first, so no prompt is needed (and any password works).
          expect(infoOf(await pdfHandler.read(src(bytes, f.file)), 'Encrypted')).toBe(`Yes (${f.cipher}) — unlocked`);
          expect(infoOf(await pdfHandler.read(src(bytes, f.file, 'not the password')), 'Encrypted')).toBe(`Yes (${f.cipher}) — unlocked`);
        }
        for (const pw of new Set([f.user, f.owner])) {
          const m = await pdfHandler.read(src(bytes, f.file, pw));
          expect(infoOf(m, 'Encrypted')).toBe(`Yes (${f.cipher}) — unlocked`);
          expect(infoOf(m, 'Pages')).toBe(String(f.pages));
          expect(field(m, 'pdf:Title')?.value).toBe(f.title);
          expect(field(m, 'pdf:Author')?.value).toBe(f.author);
          if (f.xmp) expect(field(m, XMP_TITLE)?.value).toBe(f.title);
          if (f.pageText) expect(field(m, XMP_CREATOR)?.value).toEqual([f.author]);
          if (f.attachment) expect(field(m, 'pdfdoc:attachments')?.display).toBe('notes.txt (33 B)');
          // files that open without a password only lose their permission restrictions
          expect(m.warnings).toEqual([f.user ? PASSWORD_WARNING : OWNER_WARNING, ...(f.signature ? [expect.stringMatching(/digitally signed/)] : [])]);
          if (f.signature) {
            // the signature dictionary's strings are decrypted, its /Contents never was encrypted
            expect(field(m, 'pdfsig:1:Name')?.value).toBe('Jane Signer');
            expect(field(m, 'pdfsig:1:M')?.value).toBe('2024-05-04T12:00:00Z');
            expect(field(m, 'pdfsig:1:cert')?.display).toBe('adbe.pkcs7.detached (29 B)');
          }
        }
      });

      it('strips to an unencrypted file without the marker', async () => {
        const out = await bytesOf(await pdfHandler.strip!(src(bytes, f.file, f.user || undefined), strip()));
        await expectUnencrypted(out, f);
        const et = await exiftool(out, 'stripped.pdf');
        expect(etProblems(et)).toEqual([]);
        expect(et['PDF:Encryption']).toBeUndefined();
        expect(et['PDF:PageCount']).toBe(f.pages);
        expect(Object.keys(et).filter((k) => /^PDF:(Title|Author|Creator|Producer|Subject|Keywords)$|^XMP-dc:/.test(k))).toEqual([]);
        const all = await allText(out);
        expect(all).not.toContain(MARK);
        expect(all).not.toContain('OLD-REVISION-TITLE');
        if (f.attachment) expect(all).toContain(NOTES);
        if (f.signature) {
          expect(all).not.toContain('Jane Signer');
          expect(all.toLowerCase()).not.toContain(Buffer.from('SIGNATURE-BYTES').toString('hex'));
        }
      });

      it('edits with the owner password and keeps every page intact', async () => {
        const title = 'Renamed – ✓';
        const out = await bytesOf(await pdfHandler.write!(src(bytes, f.file, f.owner), edits({ 'pdf:Title': title, 'pdf:Subject': REMOVE })));
        await expectUnencrypted(out, f);
        const et = await exiftool(out, 'edited.pdf');
        expect(etProblems(et)).toEqual([]);
        expect(et['PDF:Title']).toBe(title);
        expect(et['PDF:Author']).toBe(f.author);
        expect(et['PDF:Subject']).toBeUndefined();
        expect(et['PDF:Keywords']).toEqual(['alpha', 'beta']);
        const m = await pdfHandler.read(src(out, 'edited.pdf'));
        expect(field(m, 'pdf:Title')?.value).toBe(title);
        expect(field(m, 'pdf:Author')?.value).toBe(f.author);
        const all = await allText(out);
        expect(all).not.toContain('OLD-REVISION-TITLE'); // the superseded revision is gone
        if (f.attachment) expect(all).toContain(NOTES);
        if (f.pageText) {
          // exact plaintext, including a ciphertext that ended in CR before "endstream"
          const pages = await pageContents(out);
          pages.forEach((streams, i) => expect(streams[0]).toMatch(new RegExp(`\\(Encrypted page ${i + 1} of ${f.pages}\\) Tj ET\\n$`)));
          if (f.identityStream) {
            expect(pages[0][1]).toBe('0 0 1 rg 200 20 60 30 re f\n');
            expect(all).not.toContain('/Crypt');
          }
        }
        if (f.signature) {
          // the signature value comes through byte for byte; its other strings are decrypted
          const value = Buffer.from('SIGNATURE-BYTES-NOT-ENCRYPTED').toString('hex');
          expect(all).toMatch(new RegExp(`/Contents\\s*<${value}(00)+>`, 'i'));
          expect(all).toContain('/Name (Jane Signer)');
        }
        if (HAS_SWIFT && f.pdfkit !== false) {
          // PDFKit renders the decrypted copy exactly like the original it unlocks itself.
          const before = pdfKitView(bytes, asciiPassword(f));
          const after = pdfKitView(out);
          expect(before.pages).toBe(f.pages);
          expect(after).toMatchObject({ opened: true, encrypted: false, locked: false, pages: f.pages, title });
          expect(after.renders).toEqual(before.renders);
        }
      });
    });
  }

  it('agrees with ExifTool on the AES-256 originals', async () => {
    for (const f of manifest.filter((x) => x.cipher === 'AES-256')) {
      const et = await exiftool(fixtureBytes(`pdfcrypt/${f.file}`), f.file, ['-password', asciiPassword(f)]);
      expect(et['PDF:Title']).toBe(f.title);
      expect(et['PDF:Author']).toBe(f.author);
      expect(et['XMP-dc:Title']).toBe(f.title);
    }
  }, 300_000);

  it('opens the documents fixture with either password', async () => {
    const bytes = fixtureBytes('documents/encrypted.pdf');
    for (const pw of ['user', 'owner']) {
      const m = await pdfHandler.read(src(bytes, 'encrypted.pdf', pw));
      expect(infoOf(m, 'Encrypted')).toMatch(/^Yes \(.+\) — unlocked$/);
    }
  });

  it('normalizes AES-256 passwords (SASLprep)', async () => {
    const f = manifest.find((x) => x.file === 'aes-256-r6-objstm.pdf')!;
    expect(f.user).toBe('pässwörd');
    const m = await pdfHandler.read(src(fixtureBytes(`pdfcrypt/${f.file}`), f.file, f.user.normalize('NFD')));
    expect(field(m, 'pdf:Title')?.value).toBe(f.title);
    // The owner password "ﬁle Ωwner" (ligature, ohm sign) was prepared to "file Ωwner" by the writer.
    const r5 = manifest.find((x) => x.file === 'aes-256-r5.pdf')!;
    const r5bytes = fixtureBytes(`pdfcrypt/${r5.file}`);
    for (const typed of ['file \u03a9wner', '\ufb01\u00adle\u1680\u2126wner', 'ｆｉｌｅ\u3000Ωwner']) {
      expect(field(await pdfHandler.read(src(r5bytes, r5.file, typed)), 'pdf:Title')?.value).toBe(r5.title);
    }
    await expect(pdfHandler.read(src(r5bytes, r5.file, 'file\u03a9wner'))).rejects.toMatchObject({ code: 'wrong-password' });
  });

  it('encodes RC4 passwords in PDFDocEncoding, and accepts UTF-8 ones', async () => {
    // "Grüße–€" is 47 72 FC DF 65 85 A0 in PDFDocEncoding (the en dash and euro sign are not Latin-1)
    const latin = manifest.find((x) => x.passwordEncoding === 'PDFDocEncoding')!;
    const latinBytes = fixtureBytes(`pdfcrypt/${latin.file}`);
    expect(latin.user).toBe('Grüße–€');
    expect(field(await pdfHandler.read(src(latinBytes, latin.file, latin.user)), 'pdf:Title')?.value).toBe(latin.title);
    for (const near of ['Grüße-€', 'Grüße–', 'Grusse–€']) {
      await expect(pdfHandler.read(src(latinBytes, latin.file, near))).rejects.toMatchObject({ code: 'wrong-password' });
    }
    // Ghostscript hashes the UTF-8 bytes instead
    const utf8 = manifest.find((x) => x.passwordEncoding === 'UTF-8')!;
    expect(field(await pdfHandler.read(src(fixtureBytes(`pdfcrypt/${utf8.file}`), utf8.file, 'Grüße')), 'pdf:Title')?.value).toBe(utf8.title);
  });

  it('opens unencrypted PDFs untouched', async () => {
    const r = await openPdf(PdfLib, fixtureBytes('documents/objstm.pdf'));
    expect(r.encrypted).toBe(false);
    expect(r.cipher).toBeUndefined();
  });
});

// ------------------------------------------------------- unsupported, damaged

/** A fixture with byte-exact changes, each `from` matching exactly once (`to` may use $1). */
function patched(file: string, ...changes: [from: string | RegExp, to: string][]): Uint8Array {
  let s = Buffer.from(fixtureBytes(file.includes('/') ? file : `pdfcrypt/${file}`)).toString('latin1');
  for (const [from, to] of changes) {
    const re = new RegExp(typeof from === 'string' ? from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : from.source, 'g');
    expect(s.match(re)?.length, String(from)).toBe(1);
    s = s.replace(re, to);
  }
  return new Uint8Array(Buffer.from(s, 'latin1'));
}

/** openPdf's outcome: the title it read, or the MetadataError it threw (anything else fails the test). */
async function outcome(bytes: Uint8Array, password?: string): Promise<string | MetadataError> {
  try {
    const { doc } = await openPdf(PdfLib, bytes, password);
    return doc.getTitle() ?? '';
  } catch (e) {
    if (!(e instanceof MetadataError)) throw new Error(`not a MetadataError: ${String(e)}`);
    return e;
  }
}

async function failure(bytes: Uint8Array, password?: string): Promise<MetadataError> {
  try {
    await pdfHandler.read(src(bytes, 'x.pdf', password));
  } catch (e) {
    expect(e).toBeInstanceOf(MetadataError);
    return e as MetadataError;
  }
  throw new Error('expected a MetadataError');
}

const DAMAGED = /damaged encryption dictionary/;

describe('unsupported encryption', () => {
  it('explains public-key security', async () => {
    const e = await failure(patched('rc4-40-r2.pdf', ['/Filter /Standard', '/Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5']), 'user');
    expect(e.code).toBeUndefined();
    expect(e.message).toMatch(/digital certificate/);
  });

  it('names an unknown security handler', async () => {
    const e = await failure(patched('rc4-40-r2.pdf', ['/Filter /Standard', '/Filter /FooSecurity']));
    expect(e.code).toBeUndefined();
    expect(e.message).toMatch(/unsupported security handler \(FooSecurity\)/);
    const none = await failure(patched('rc4-40-r2.pdf', ['/Filter /Standard', '/Filter (Standard)']));
    expect(none.message).toMatch(/unsupported security handler \(none\)/);
  });

  it('rejects unknown revisions and crypt filter methods', async () => {
    const r7 = await failure(patched('aes-256-r6.pdf', ['/R 6', '/R 7']), 'user');
    expect(r7.code).toBeUndefined();
    expect(r7.message).toMatch(/unsupported encryption revision \(V5, R7\)/);
    const cfm = await failure(patched('aes-128-crypt-filters.pdf', ['/CFM /AESV2', '/CFM /AESV9']), 'user');
    expect(cfm.message).toMatch(/unsupported encryption method \(AESV9\)/);
  });
});

describe('damaged and crafted encryption', () => {
  const LATIN = 'rc4-128-latin1.pdf'; // V2 R3, classic xref table
  const LATIN_PW = 'Grüße–€';
  const R6 = 'aes-256-r6-owner-only.pdf'; // V5 R6, xref and object streams, opens without a password

  it('rejects absurd /V, /R, /Length and /P values', async () => {
    for (const [from, to] of [
      ['/R 3', '/R 99999999999999999999'],
      ['/R 3', '/R -3'],
      ['/V 2', '/V 2.5'],
      ['/V 2', '/V 4'], // V4 without crypt filters
    ] as const) {
      const r = await outcome(patched(LATIN, [from, to]), LATIN_PW);
      expect(r, to).toBeInstanceOf(MetadataError);
      expect((r as MetadataError).code, to).toBeUndefined();
    }
    // Key lengths are clamped to 40–128 bits: an absurd 128-bit /Length still opens, a negative one cannot.
    expect(await outcome(patched(LATIN, ['/Length 128\n', '/Length 4294967296\n']), LATIN_PW)).toBe('Latin-1 password');
    expect(await outcome(patched(LATIN, ['/Length 128\n', '/Length -128\n']), LATIN_PW)).toMatchObject({ code: 'wrong-password' });
    expect(await outcome(patched(LATIN, ['/P -4', '/P 99999999999999']), LATIN_PW)).toMatchObject({ code: 'wrong-password' });
  });

  it('reports truncated or missing /O, /U, /OE and /UE instead of asking for a password', async () => {
    const cases: [string, RegExp, string][] = [
      [LATIN, /\/O <[0-9A-F]+>/, '/O <0123>'],
      [LATIN, /\/U <[0-9A-F]+>/, '/U 5'],
      [R6, /\/UE <[0-9A-F]+>/, '/UE <0123>'],
      [R6, /\/OE <[0-9A-F]+>/, ''],
      [R6, /\/U <[0-9A-F]+>/, '/U <00>'],
    ];
    for (const [file, from, to] of cases) {
      const r = await outcome(patched(file, [from, to]), 'owner');
      expect(r, `${file} ${to}`).toBeInstanceOf(MetadataError);
      expect((r as MetadataError).message).toMatch(DAMAGED);
      expect((r as MetadataError).code).toBeUndefined();
    }
    const v4 = await outcome(patched('aes-128-crypt-filters.pdf', ['/CFM /AESV2', '/CFM /AESV3']), 'user');
    expect((v4 as MetadataError).message).toMatch(DAMAGED);
  });

  it('ignores oversized /O, /U, /OE, /UE and /Perms past their defined length', async () => {
    const big = (n: number) => 'AB'.repeat(n);
    const r6 = patched(
      R6,
      [/\/Perms <[0-9A-F]+>/, `/Perms <${big(1 << 20)}>`],
      [/(\/OE <[0-9A-F]+)>/, `$1${big(1 << 18)}>`],
      [/(\/UE <[0-9A-F]+)>/, `$1${big(1 << 18)}>`],
      [/(\/O <[0-9A-F]+)>/, `$1${big(1 << 18)}>`],
      [/(\/U <[0-9A-F]+)>/, `$1${big(1 << 18)}>`],
    );
    expect(await outcome(r6)).toBe('Owner only');
    const rc4 = patched(LATIN, [/(\/O <[0-9A-F]+)>/, `$1${big(1 << 18)}>`], [/(\/U <[0-9A-F]+)>/, `$1${big(1 << 18)}>`]);
    expect(await outcome(rc4, LATIN_PW)).toBe('Latin-1 password');
  });

  it('handles a missing /ID', async () => {
    // RC4 keys are derived from it: without it no password can match (the file is damaged).
    const rc4 = patched(LATIN, [/\/ID \[[^\]]*\]/, '']);
    expect(await outcome(rc4)).toMatchObject({ code: 'password-required' });
    expect(await outcome(rc4, LATIN_PW)).toMatchObject({ code: 'wrong-password' });
    // AES-256 does not use it.
    expect(await outcome(patched(R6, [/\/ID \[[^\]]*\]/, '']))).toBe('Owner only');
  });

  it('reports a dangling or malformed /Encrypt', async () => {
    const dangling = await failure(patched(LATIN, [/\/Encrypt \d+ 0 R/, '/Encrypt 999 0 R']), LATIN_PW);
    expect(dangling.message).toMatch(/encryption dictionary is missing/);
    const notDict = await failure(patched(LATIN, [/\/Encrypt \d+ 0 R/, '/Encrypt [1 2 3]']), LATIN_PW);
    expect(notDict.message).toMatch(/encryption dictionary is missing/);
  });

  it('does not loop over crafted xref and object stream sizes', async () => {
    const huge = '2000000000';
    const xref = patched(R6, ['/Index [0 14]', `/Index [0 ${huge} 7 ${huge}]`], ['/Size 14', `/Size ${huge}`], ['/W [1 4 2]', '/W [1 9999 2]']);
    expect(await outcome(xref)).toBe('Owner only');
    const objStm = patched(R6, ['/N 6', `/N ${huge}`]);
    expect(await outcome(objStm)).toBe('Owner only');
    const first = await outcome(patched(R6, ['/First 34', `/First ${huge}`]));
    expect(typeof first === 'string' || first instanceof MetadataError).toBe(true);
    // the same for unencrypted files
    const plain = patched('documents/objstm.pdf', ['/Index [ 0 26 ]', `/Index [ 0 ${huge} ]`]);
    const r = await openPdf(PdfLib, plain);
    expect(r.encrypted).toBe(false);
    expect(r.doc.getPageCount()).toBeGreaterThan(0);
  }, 10_000);

  it('survives deeply nested objects', async () => {
    for (const depth of [500, 100_000]) {
      const nested = `${'['.repeat(depth)}(x)${']'.repeat(depth)}`;
      const bytes = patched(LATIN, ['\nxref\n', `\n99 0 obj\n${nested}\nendobj\nxref\n`]);
      expect(await outcome(bytes, LATIN_PW)).toBe('Latin-1 password');
    }
  });

  it('throws only MetadataErrors for corrupted files', async () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    let failures = 0;
    for (const f of manifest.filter((x) => /^(rc4-40-r2|rc4-128-v4|aes-128-crypt-filters|aes-256-r6|gs-rc4-40-r2|quartz-aes-128)\.pdf$/.test(x.file))) {
      const orig = fixtureBytes(`pdfcrypt/${f.file}`);
      const enc = Buffer.from(orig).indexOf('/Filter /Standard');
      expect(enc).toBeGreaterThan(0);
      for (let i = 0; i < 40; i++) {
        let b = new Uint8Array(orig);
        // half of the changes land in the encryption dictionary
        const at = i % 2 ? enc + rand(300) : rand(b.length);
        const kind = rand(3);
        if (kind === 0) for (let k = rand(8) + 1; k > 0; k--) b[Math.min(b.length - 1, at + rand(16))] = rand(256);
        else if (kind === 1) b = b.slice(0, at);
        else b = new Uint8Array([...b.subarray(0, at), ...b.subarray(Math.min(b.length, at + rand(64) + 1))]);
        if ((await outcome(b, f.user || undefined)) instanceof MetadataError) failures++;
      }
    }
    expect(failures).toBeGreaterThan(0);
  }, 120_000);
});
