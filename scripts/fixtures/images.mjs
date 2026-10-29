// PNG / WebP / GIF / TIFF fixtures.
//
// Needs ffmpeg, sips (macOS) and the libwebp tools (cwebp, img2webp — e.g.
// `brew install webp`), because ffmpeg has no WebP encoder here. Metadata is
// written with ExifTool (WASM); chunks ExifTool cannot create (iCCP, ICC GIF
// extensions, ImageMagick raw profiles, unknown chunks) are spliced in below.
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

export const MARKER = 'SECRET-MARKER-42';
const ICC = readFileSync('/System/Library/ColorSync/Profiles/Display P3.icc');
const enc = (s) => new TextEncoder().encode(s);
const latin = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const cat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u32be = (v) => Uint8Array.of(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
const u32le = (v) => Uint8Array.of(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24);

// ------------------------------------------------------------------ PNG
function pngChunks(b) {
  const out = [];
  let p = 8;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (p < b.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...b.subarray(p + 4, p + 8));
    out.push({ type, data: b.slice(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}
function pngChunk(type, data) {
  const td = cat([latin(type), data]);
  return cat([u32be(data.length), td, u32be(crc32(td))]);
}
function buildPng(chunks, trailer = new Uint8Array(0)) {
  return cat([Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), ...chunks.map((c) => pngChunk(c.type, c.data)), trailer]);
}
/** ImageMagick "Raw profile type …" text: "\n<name>\n<len>\n<hex lines>\n". */
function rawProfile(name, data) {
  let hex = '';
  for (let i = 0; i < data.length; i++) hex += (i % 36 === 0 ? '\n' : '') + data[i].toString(16).padStart(2, '0');
  return `\n${name}\n${String(data.length).padStart(8)}${hex}\n`;
}
const zTXt = (keyword, text) => ({ type: 'zTXt', data: cat([latin(keyword), Uint8Array.of(0, 0), deflateSync(latin(text))]) });

// ------------------------------------------------------------------ WebP
function riffChunks(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = [];
  let p = 12;
  while (p + 8 <= b.length) {
    const id = String.fromCharCode(...b.subarray(p, p + 4));
    const size = dv.getUint32(p + 4, true);
    out.push({ id, data: b.slice(p + 8, p + 8 + size) });
    p += 8 + size + (size & 1);
  }
  return out;
}
function buildWebp(chunks) {
  const body = chunks.map((c) => cat([latin(c.id), u32le(c.data.length), c.data, c.data.length & 1 ? Uint8Array.of(0) : new Uint8Array(0)]));
  const payload = cat([latin('WEBP'), ...body]);
  return cat([latin('RIFF'), u32le(payload.length), payload]);
}

// ------------------------------------------------------------------ GIF
function subBlocks(data) {
  const parts = [];
  for (let i = 0; i < data.length; i += 255) {
    const s = data.subarray(i, i + 255);
    parts.push(Uint8Array.of(s.length), s);
  }
  parts.push(Uint8Array.of(0));
  return cat(parts);
}
const gifApp = (ident, data) => cat([Uint8Array.of(0x21, 0xff, 11), latin(ident), subBlocks(data)]);
/** Offset of the first block after the header, LSD and global colour table. */
function gifBodyStart(b) {
  const packed = b[10];
  return 13 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
}
/** Offset of the first graphic control extension or image descriptor. */
function gifFirstFrame(b) {
  let p = gifBodyStart(b);
  while (p < b.length) {
    if (b[p] === 0x2c || (b[p] === 0x21 && b[p + 1] === 0xf9)) return p;
    if (b[p] !== 0x21) throw new Error('unexpected GIF block');
    p += 2;
    while (b[p]) p += b[p] + 1;
    p++;
  }
  throw new Error('GIF has no frames');
}

// ------------------------------------------------------------------ TIFF
/** Tiny big-endian two-page RGB TIFF with page-level text tags. */
function multipageTiff(pages) {
  const parts = [];
  let pos = 8;
  const pixelsAt = [];
  for (const pg of pages) {
    pixelsAt.push(pos);
    parts.push(pg.pixels);
    pos += pg.pixels.length;
  }
  if (pos % 2) {
    parts.push(Uint8Array.of(0));
    pos++;
  }
  const be16 = (v) => Uint8Array.of(v >> 8, v & 255);
  const ifdOffsets = [];
  const ifds = [];
  pages.forEach((pg, i) => {
    const ascii = Object.entries(pg.text).map(([tag, s]) => [+tag, cat([enc(s), Uint8Array.of(0)])]);
    const entries = [
      [256, 3, 1, be16(pg.w)],
      [257, 3, 1, be16(pg.h)],
      [258, 3, 3, cat([be16(8), be16(8), be16(8)])],
      [259, 3, 1, be16(1)],
      [262, 3, 1, be16(2)],
      [273, 4, 1, u32be(pixelsAt[i])],
      [277, 3, 1, be16(3)],
      [278, 3, 1, be16(pg.h)],
      [279, 4, 1, u32be(pg.pixels.length)],
      ...ascii.map(([tag, d]) => [tag, 2, d.length, d]),
    ].sort((a, b) => a[0] - b[0]);
    ifds.push(entries);
  });
  // lay out: IFD table followed by its out-of-line values, per page
  const blobs = [];
  for (const entries of ifds) {
    const at = pos;
    ifdOffsets.push(at);
    let vpos = at + 2 + entries.length * 12 + 4;
    const values = [];
    const table = [be16(entries.length)];
    for (const [tag, type, count, data] of entries) {
      table.push(be16(tag), be16(type), u32be(count));
      if (data.length <= 4) table.push(cat([data, new Uint8Array(4 - data.length)]));
      else {
        table.push(u32be(vpos));
        values.push(data);
        vpos += data.length;
        if (vpos % 2) {
          values.push(Uint8Array.of(0));
          vpos++;
        }
      }
    }
    blobs.push({ table, values });
    pos = vpos;
  }
  blobs.forEach((b, i) => {
    b.table.push(u32be(i + 1 < ifdOffsets.length ? ifdOffsets[i + 1] : 0));
    parts.push(...b.table, ...b.values);
  });
  return cat([latin('MM'), Uint8Array.of(0, 42), u32be(ifdOffsets[0]), ...parts]);
}

export default async function (ctx) {
  const src = ['-f', 'lavfi', '-i', 'testsrc2=size=32x24', '-frames:v', '1'];

  // ================================================================ PNG
  ctx.ffmpeg([...src, '-pix_fmt', 'rgb24', ctx.tmpPath('plain.png')]);
  const plainPng = ctx.read(ctx.tmpPath('plain.png'));
  ctx.write('plain.png', plainPng);

  const richBase = await ctx.exiftoolWrite(
    plainPng,
    'rich.png',
    {
      'PNG:Title': 'Sunset over the bay',
      'PNG:Author': 'Jane Doe',
      'PNG:Copyright': '© 2024 Jane Doe',
      'PNG:Software': 'SecretPaint 3.1',
      'PNG:Comment': `note ${MARKER}`,
      'PNG:CreationTime': '2024:05:01 18:29:59',
      'PNG:Description': 'Grüße ☃ from the bay',
      'PNG:ModifyDate': '2024:05:02 01:29:59',
      'IFD0:Make': 'Apple',
      'IFD0:Model': 'iPhone 15 Pro',
      'IFD0:Artist': 'Jane Doe',
      'IFD0:Orientation#': 6,
      'ExifIFD:DateTimeOriginal': '2024:05:01 18:29:59',
      'ExifIFD:UserComment': MARKER,
      'GPS:GPSLatitude': 37.8199,
      'GPS:GPSLatitudeRef': 'N',
      'GPS:GPSLongitude': 122.4783,
      'GPS:GPSLongitudeRef': 'W',
      'XMP-dc:Title': 'Golden Gate',
      'XMP-dc:Creator': 'Jane Doe',
      'XMP-dc:Subject': ['bridge', MARKER],
      'IPTC:Keywords': ['bridge', 'sunset'],
      'IPTC:City': 'San Francisco',
    },
    ['-m', '-codedcharacterset=utf8'],
  );
  {
    // splice in an ICC profile, an unknown private chunk and trailing data
    const chunks = pngChunks(richBase);
    const iccp = { type: 'iCCP', data: cat([latin('Display P3'), Uint8Array.of(0, 0), deflateSync(ICC)]) };
    chunks.splice(1, 0, iccp);
    const idat = chunks.findIndex((c) => c.type === 'IDAT');
    chunks.splice(idat, 0, { type: 'tEXt', data: latin(`parameters\0prompt: ${MARKER}`) }, { type: 'prVt', data: enc(`private ${MARKER}`) });
    ctx.write('rich.png', buildPng(chunks, enc(`TRAILER ${MARKER}`)));
  }

  // ImageMagick-style legacy profiles (EXIF + XMP as hex in zTXt)
  {
    const withExif = await ctx.exiftoolWrite(plainPng, 'x.png', { 'IFD0:Artist': `Legacy ${MARKER}`, 'IFD0:Make': 'Nikon' }, ['-m']);
    const exif = pngChunks(withExif).find((c) => c.type === 'eXIf').data;
    const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Legacy title</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const chunks = pngChunks(plainPng);
    const idat = chunks.findIndex((c) => c.type === 'IDAT');
    chunks.splice(
      idat,
      0,
      zTXt('Raw profile type exif', rawProfile('exif', cat([latin('Exif\0\0'), exif]))),
      zTXt('Raw profile type xmp', rawProfile('xmp', enc(xmp))),
      { type: 'tEXt', data: latin('date:create\x002024-05-01T18:29:59+00:00') },
    );
    ctx.write('legacy.png', buildPng(chunks));
  }

  // APNG (3 frames) with a palette, plus a title
  ctx.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=16x16:rate=5', '-frames:v', '3', '-pix_fmt', 'pal8', '-plays', '0', '-f', 'apng', ctx.tmpPath('anim.png')]);
  ctx.write('anim.png', await ctx.exiftoolWrite(ctx.read(ctx.tmpPath('anim.png')), 'anim.png', { 'PNG:Title': `Anim ${MARKER}` }, ['-m']));

  // ================================================================ WebP
  ctx.ffmpeg([...src, '-pix_fmt', 'rgb24', ctx.tmpPath('w.png')]);
  ctx.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=32x24', '-vf', 'format=rgba,geq=r=r(X\\,Y):g=g(X\\,Y):b=b(X\\,Y):a=X*8', '-frames:v', '1', ctx.tmpPath('wa.png')]);
  ctx.run('cwebp', ['-quiet', '-q', '60', ctx.tmpPath('w.png'), '-o', ctx.tmpPath('lossy.webp')]);
  ctx.run('cwebp', ['-quiet', '-lossless', ctx.tmpPath('w.png'), '-o', ctx.tmpPath('lossless.webp')]);
  ctx.run('cwebp', ['-quiet', '-q', '60', ctx.tmpPath('wa.png'), '-o', ctx.tmpPath('alpha.webp')]);
  const lossy = ctx.read(ctx.tmpPath('lossy.webp'));
  ctx.write('lossy.webp', lossy);
  ctx.write('lossless.webp', ctx.read(ctx.tmpPath('lossless.webp')));
  ctx.write('alpha.webp', ctx.read(ctx.tmpPath('alpha.webp')));

  {
    const tagged = await ctx.exiftoolWrite(
      lossy,
      'rich.webp',
      {
        'IFD0:Make': 'Google',
        'IFD0:Model': 'Pixel 8',
        'IFD0:Artist': 'Jane Doe',
        'IFD0:Orientation#': 6,
        'ExifIFD:DateTimeOriginal': '2024:05:01 18:29:59',
        'ExifIFD:SerialNumber': MARKER,
        'GPS:GPSLatitude': 48.8584,
        'GPS:GPSLatitudeRef': 'N',
        'GPS:GPSLongitude': 2.2945,
        'GPS:GPSLongitudeRef': 'E',
        'XMP-dc:Title': 'Eiffel',
        'XMP-dc:Creator': 'Jane Doe',
        'XMP-dc:Description': MARKER,
      },
      ['-m'],
    );
    // add an ICC profile (+ VP8X flag) and an unknown chunk
    const chunks = riffChunks(tagged);
    chunks[0].data[0] |= 0x20;
    chunks.splice(1, 0, { id: 'ICCP', data: new Uint8Array(ICC) });
    chunks.push({ id: 'PRIV', data: enc(`private ${MARKER}!`) });
    ctx.write('rich.webp', buildWebp(chunks));
  }

  {
    const frames = [0, 1, 2].map((i) => {
      const p = ctx.tmpPath(`f${i}.png`);
      ctx.ffmpeg(['-f', 'lavfi', '-i', `testsrc2=size=16x16`, '-vf', `hue=h=${i * 120}`, '-frames:v', '1', p]);
      return p;
    });
    ctx.run('img2webp', ['-loop', '0', '-d', '100', '-lossy', '-q', '50', ...frames, '-o', ctx.tmpPath('anim.webp')]);
    ctx.write(
      'anim.webp',
      await ctx.exiftoolWrite(ctx.read(ctx.tmpPath('anim.webp')), 'anim.webp', { 'XMP-dc:Title': `Anim ${MARKER}`, 'IFD0:Artist': 'Jane Doe' }, ['-m']),
    );
  }

  // ================================================================ GIF
  ctx.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=32x24:rate=5', '-frames:v', '3', '-loop', '0', ctx.tmpPath('anim.gif')]);
  const animGif = ctx.read(ctx.tmpPath('anim.gif'));
  ctx.write('anim.gif', animGif);
  ctx.ffmpeg([...src, ctx.tmpPath('still.gif')]);
  ctx.write('still.gif', ctx.read(ctx.tmpPath('still.gif')));
  {
    const tagged = await ctx.exiftoolWrite(
      animGif,
      'rich.gif',
      { Comment: `Made by Jane ${MARKER}`, 'XMP-dc:Title': 'Test pattern', 'XMP-dc:Creator': 'Jane Doe', 'XMP-dc:Rights': MARKER },
      ['-m'],
    );
    // ICC profile + an ImageMagick-style private block + plain text + trailer
    const start = gifBodyStart(tagged);
    const plainText = cat([
      Uint8Array.of(0x21, 0x01, 12, 0, 0, 0, 0, 32, 0, 24, 0, 8, 8, 1, 0),
      subBlocks(latin(`caption ${MARKER}`)),
    ]);
    const gce = gifFirstFrame(tagged);
    const body = cat([
      tagged.subarray(0, start),
      gifApp('ICCRGBG1012', new Uint8Array(ICC)),
      tagged.subarray(start, gce),
      gifApp('MGK8BIM0000', enc(`private ${MARKER}`)),
      plainText,
      tagged.subarray(gce),
      enc(`TRAILER ${MARKER}`),
    ]);
    ctx.write('rich.gif', body);
  }

  // ================================================================ TIFF
  ctx.ffmpeg([...src, '-pix_fmt', 'rgb24', '-compression_algo', 'lzw', ctx.tmpPath('plain.tif')]);
  const plainTif = ctx.read(ctx.tmpPath('plain.tif'));
  ctx.write('plain.tif', plainTif);
  // sips: Apple-style big-endian TIFF with an Exif IFD and an ICC profile
  ctx.run('sips', ['--embedProfile', '/System/Library/ColorSync/Profiles/Display P3.icc', ctx.tmpPath('plain.tif'), '--out', ctx.tmpPath('icc.tif')]);
  const richTif = await ctx.exiftoolWrite(
    ctx.read(ctx.tmpPath('icc.tif')),
    'rich.tif',
    {
      'IFD0:Make': 'Nikon',
      'IFD0:Model': 'Z 8',
      'IFD0:Artist': 'Jane Doe',
      'IFD0:Copyright': '© 2024 Jane Doe',
      'IFD0:ImageDescription': `Scan ${MARKER}`,
      'IFD0:Orientation#': 6,
      'ExifIFD:DateTimeOriginal': '2024:05:01 18:29:59',
      'ExifIFD:SerialNumber': '3001234',
      'GPS:GPSLatitude': 51.5007,
      'GPS:GPSLatitudeRef': 'N',
      'GPS:GPSLongitude': 0.1246,
      'GPS:GPSLongitudeRef': 'W',
      'XMP-dc:Title': 'Big Ben',
      'XMP-dc:Creator': 'Jane Doe',
      'IPTC:Keywords': ['clock', 'london'],
      'IPTC:City': MARKER,
    },
    ['-m', '-codedcharacterset=utf8'],
  );
  ctx.write('rich.tif', richTif);

  const px = (w, h, f) => {
    const out = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) out.set(f(i % w, Math.floor(i / w)), i * 3);
    return out;
  };
  ctx.write(
    'multipage.tif',
    multipageTiff([
      { w: 8, h: 8, pixels: px(8, 8, (x, y) => [x * 32, y * 32, 128]), text: { 305: 'PageMaker 1.0', 315: 'Page One Artist' } },
      { w: 6, h: 4, pixels: px(6, 4, (x, y) => [255 - x * 40, y * 60, 0]), text: { 305: `Scanner ${MARKER}`, 306: '2024:05:01 10:00:00' } },
    ]),
  );

  // read-only RAW variants: a DNG-tagged TIFF and an ORF-style header
  ctx.write(
    'fake.dng',
    await ctx.exiftoolWrite(plainTif, 'fake.dng', { 'IFD0:DNGVersion': '1.4.0.0', 'IFD0:Make': 'Canon', 'IFD0:Model': 'EOS R5', 'IFD0:UniqueCameraModel': 'Canon EOS R5', 'ExifIFD:SerialNumber': '0123' }, ['-m']),
  );
  const orf = richTif.slice();
  orf.set(orf[0] === 0x4d ? latin('OR') : latin('RO'), 2);
  ctx.write('fake.orf', orf);
  ctx.cleanup();
}
