// Password-protected PDF fixtures for src/engine/formats/pdfcrypt.ts.
//
// Real tools where they exist on macOS: Quartz (CGPDFContext: RC4 40-bit R3,
// AES-128 R4), PDFKit (PDFDocument.write: RC4 128-bit R3) and Ghostscript
// pdfwrite (RC4 R2/R3 with object streams, xref streams and indirect /Length).
// Everything else comes from an independent encryptor written in Swift with
// CommonCrypto/CryptoKit (pdfcrypt_encrypt.swift): AES-256 R5/R6, crypt
// filters (/V2, /AESV2, /Identity, /EFF), /EncryptMetadata false, object and
// xref streams, indirect /Length objects (also inside object streams, as
// Ghostscript writes them), incremental updates and a signature /Contents.
//
// Every fixture is checked with PDFKit and/or Ghostscript using its passwords,
// so the files are known-good before BlueExif's decryptor ever sees them.
// Non-ASCII passwords: ISO 32000-2 wants PDFDocEncoding for RC4/AES-128 and
// SASLprep'd UTF-8 for AES-256. Ghostscript hashes the UTF-8 bytes of its
// argument for RC4 (gs-rc4-128-utf8.pdf) and PDFKit takes ASCII only, so
// PDFDocEncoding passwords are checked by CoreGraphics with the raw bytes.
// manifest.json lists them with passwords, expected values and what else each
// one contains (xmp, attachment, pageText, identityStream, signature) for the tests.
// Every identifying value contains SECRET-MARKER-42; OLD-REVISION-TITLE only
// exists in a superseded revision.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MARK = 'SECRET-MARKER-42';
const here = new URL('.', import.meta.url).pathname;

export default async function (ctx) {
  const tools = compile(ctx, 'pdfcrypt_tools.swift');
  const encryptor = compile(ctx, 'pdfcrypt_encrypt.swift');
  const manifest = [];
  const add = (file, bytes, meta) => {
    ctx.write(file, bytes);
    manifest.push({ file, ...meta });
  };

  // ---------------------------------------------------- Quartz + PDFKit
  ctx.run(tools, ['make', ctx.tmp, MARK], { timeout: 120_000 });
  const quartz = { title: 'Quartz encrypted', author: `Quartz Author ${MARK}`, pages: 2, objectStreams: false };
  add('quartz-rc4-40.pdf', ctx.read(ctx.tmpPath('quartz-rc4-40.pdf')), {
    ...quartz, tool: 'Quartz CGPDFContext, key length 40', cipher: 'RC4 40-bit', user: 'user', owner: 'owner',
  });
  add('quartz-aes-128.pdf', ctx.read(ctx.tmpPath('quartz-aes-128.pdf')), {
    ...quartz, tool: 'Quartz CGPDFContext', cipher: 'AES-128', user: 'user', owner: 'owner',
  });
  add('quartz-owner-only.pdf', ctx.read(ctx.tmpPath('quartz-owner-only.pdf')), {
    ...quartz, tool: 'Quartz CGPDFContext, owner password only', cipher: 'AES-128', user: '', owner: 'owner',
  });
  add('pdfkit-rc4-128.pdf', ctx.read(ctx.tmpPath('pdfkit-rc4-128.pdf')), {
    ...quartz, title: 'PDFKit encrypted', tool: 'PDFKit PDFDocument.write', cipher: 'RC4 128-bit', user: 'user', owner: 'owner',
  });

  // -------------------------------------------------------- Ghostscript
  const gs = (file, args) => {
    const out = ctx.tmpPath(file);
    ctx.run('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=pdfwrite', '-dWriteObjStms=true', '-dWriteXRefStm=true', ...args, '-o', out, ctx.tmpPath('source.pdf')], {
      timeout: 120_000,
    });
    return ctx.read(out);
  };
  // Ghostscript derives XMP from Info (and leaves it unencrypted, against the spec).
  const ghost = { title: 'Quartz encrypted', author: `Quartz Author ${MARK}`, pages: 2, objectStreams: true, xmp: true };
  add('gs-rc4-40-r2.pdf', gs('gs-rc4-40-r2.pdf', ['-dEncryptionR=2', '-dKeyLength=40', '-sOwnerPassword=owner', '-sUserPassword=user']), {
    ...ghost, tool: 'Ghostscript pdfwrite, R2', cipher: 'RC4 40-bit', user: 'user', owner: 'owner',
  });
  add('gs-rc4-128-owner-only.pdf', gs('gs-rc4-128-owner-only.pdf', ['-dKeyLength=128', '-dEncryptionR=3', '-sOwnerPassword=owner']), {
    ...ghost, tool: 'Ghostscript pdfwrite, R3, owner password only', cipher: 'RC4 128-bit', user: '', owner: 'owner',
  });
  add('gs-rc4-128-utf8.pdf', gs('gs-rc4-128-utf8.pdf', ['-dKeyLength=128', '-dEncryptionR=3', '-sOwnerPassword=owner', '-sUserPassword=Grüße']), {
    ...ghost, tool: 'Ghostscript pdfwrite, R3, UTF-8 user password', cipher: 'RC4 128-bit', user: 'Grüße', owner: 'owner', passwordEncoding: 'UTF-8',
  });

  // ------------------------------------------- independent Swift encryptor
  const base = { author: `Jane ${MARK} Doe`, marker: MARK, encryptMetadata: true, identityStream: false, xrefStream: false, pages: 1 };
  const specs = [
    { file: 'aes-256-r6.pdf', v: 5, r: 6, bits: 256, user: 'user', owner: 'owner', title: 'Zürich – 東京 report', pages: 2, signature: true, cipher: 'AES-256' },
    {
      file: 'aes-256-r6-objstm.pdf', v: 5, r: 6, bits: 256, user: 'pässwörd', owner: 'owner', title: 'OLD-REVISION-TITLE',
      updateTitle: 'Object streams', pages: 3, xrefStream: true, catalogInObjStm: true, cipher: 'AES-256',
      // the update redefines the (top-level, encrypted) Info inside an object stream (not encrypted)
      infoTopLevel: 'base',
      // PDFKit needs the catalog before unlocking and cannot read it from an encrypted object stream.
      pdfkit: false,
    },
    { file: 'aes-256-r6-owner-only.pdf', v: 5, r: 6, bits: 256, user: '', owner: 'owner', title: 'Owner only', xrefStream: true, cipher: 'AES-256' },
    // SASLprep (NFKC) turns the ligature and the ohm sign into "fi" and "Ω"
    { file: 'aes-256-r5.pdf', v: 5, r: 5, bits: 256, user: 'user', owner: '\ufb01le \u2126wner', title: 'Revision 5', cipher: 'AES-256' },
    {
      file: 'aes-128-crypt-filters.pdf', v: 4, r: 4, bits: 128, cfm: 'AESV2', user: 'user', owner: 'owner', title: 'OLD-REVISION-TITLE',
      updateTitle: 'Crypt filters', pages: 2, encryptMetadata: false, identityStream: true, indirectLengths: true, cipher: 'AES-128',
    },
    {
      file: 'rc4-128-v4.pdf', v: 4, r: 4, bits: 128, cfm: 'V2', user: 'user', owner: 'owner', title: 'OLD-REVISION-TITLE',
      updateTitle: 'RC4 crypt filter', xrefStream: true, eff: 'Identity', cipher: 'RC4 128-bit',
      // like Ghostscript: /Length objects inside the (encrypted) object stream
      indirectLengths: true,
      // the update redefines the packed Info as a top-level object
      infoTopLevel: 'update',
    },
    { file: 'rc4-40-r2.pdf', v: 1, r: 2, bits: 40, user: 'user', owner: 'owner', title: 'RC4 40', cipher: 'RC4 40-bit' },
    {
      file: 'rc4-128-latin1.pdf', v: 2, r: 3, bits: 128, user: 'Grüße–€', owner: 'owner', title: 'Latin-1 password', cipher: 'RC4 128-bit',
      // PDFDocEncoding: Latin-1 for "Grüße", 0x85 for the en dash, 0xA0 for the euro sign
      passwordEncoding: 'PDFDocEncoding',
    },
  ].map((s) => ({ ...base, ...s }));
  const specFile = ctx.tmpPath('specs.json');
  writeFileSync(specFile, JSON.stringify(specs.map(({ file, cipher, pdfkit, passwordEncoding, ...s }) => ({ ...s, out: ctx.tmpPath(file) }))));
  ctx.run(encryptor, [specFile], { timeout: 120_000 });
  for (const s of specs) {
    add(s.file, ctx.read(ctx.tmpPath(s.file)), {
      tool: `independent Swift encryptor (V${s.v} R${s.r}${s.cfm ? ` ${s.cfm}` : ''})`,
      cipher: s.cipher,
      user: s.user,
      owner: s.owner,
      title: s.updateTitle ?? s.title,
      author: s.author,
      pages: s.pages,
      objectStreams: s.xrefStream,
      // XMP dc:title = title; notes.txt attachment; page n draws "(Encrypted page n of pages) Tj ET\n"
      xmp: true,
      attachment: true,
      pageText: true,
      ...(s.identityStream ? { identityStream: true } : {}),
      ...(s.signature ? { signature: true } : {}),
      ...(s.pdfkit === false ? { pdfkit: false } : {}),
      ...(s.passwordEncoding ? { passwordEncoding: s.passwordEncoding } : {}),
    });
  }

  // ------------------------------------------------------------ verify
  for (const m of manifest) verify(ctx, tools, m);
  ctx.write('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  ctx.cleanup();
}

function compile(ctx, src) {
  const bin = ctx.tmpPath(src.replace(/\.swift$/, ''));
  ctx.run('swiftc', ['-O', join(here, src), '-o', bin], { timeout: 600_000 });
  return bin;
}

/** The bytes a writer hashed for `pw` (see the header). */
function passwordBytes(m, pw) {
  if (m.cipher === 'AES-256') return Buffer.from(pw.normalize('NFKC'), 'utf8');
  if (m.passwordEncoding === 'UTF-8') return Buffer.from(pw, 'utf8');
  const pdfDoc = { '–': 0x85, '€': 0xa0 };
  return Buffer.from(
    [...pw].map((c) => {
      const b = pdfDoc[c] ?? c.charCodeAt(0);
      if (b > 0xff) throw new Error(`${m.file}: ${c} is not in this PDFDocEncoding subset`);
      return b;
    }),
  );
}

/** Each fixture must open with each of its passwords in PDFKit (or CoreGraphics) and Ghostscript and show the expected pages and title. */
function verify(ctx, tools, m) {
  const path = ctx.path(m.file);
  const fail = (why) => {
    throw new Error(`${m.file}: ${why}`);
  };
  for (const pw of [m.user, m.owner]) {
    const ascii = /^[\x20-\x7e]*$/.test(pw);
    if (ascii || m.passwordEncoding !== 'PDFDocEncoding') {
      // Ghostscript 10.08 crashes when its SASLprep changes a password: give it the prepared one.
      const gsPw = m.cipher === 'AES-256' ? pw.normalize('NFKC') : pw;
      const text = execFileSync('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=txtwrite', ...(gsPw ? [`-sPDFPassword=${gsPw}`] : []), '-sOutputFile=-', path], {
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if ((text.match(/Encrypted page/g) ?? []).length !== m.pages) fail(`Ghostscript did not read ${m.pages} pages with "${pw}"`);
    }
    if (m.pdfkit === false) continue;
    const arg = ascii ? pw : `hex:${passwordBytes(m, pw).toString('hex')}`;
    const r = JSON.parse(ctx.run(tools, ['check', path, arg], { encoding: 'utf8', timeout: 60_000 }));
    if (!r.encrypted) fail('PDFKit does not see it as encrypted');
    if (r.locked && !r.unlocked) fail(`PDFKit did not unlock it with "${pw}"`);
    if (r.pages !== m.pages || r.title !== m.title) fail(`PDFKit read ${r.pages} pages, title ${r.title}`);
  }
  if (m.user) {
    const r = JSON.parse(ctx.run(tools, ['check', path, 'not the password'], { encoding: 'utf8', timeout: 60_000 }));
    if (r.opened && (!r.locked || r.unlocked)) fail('PDFKit opened it with a wrong password');
  }
}
