import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { unzlibSync } from 'fflate';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { Source, groupKey, type Field, type FieldGroup, type Metadata } from '../core/types';
import { REMOVE, bytesOf, edits, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { HAS_QLMANAGE, HAS_SWIFT, pdfKitPages, preparePdfKit, qlRender } from '../test/docOracles';
import { parseJpeg } from './jpeg';
import { pdfHandler } from './pdf';

const PHOTOS = 'pdfimages/photos.pdf';
const JPX = 'pdfimages/jpx.pdf';
const MARKERS = ['Jane Doe', 'F2LXK1234567'];
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

const read = (b: Uint8Array) => pdfHandler.read(Source.fromBytes(b, 'x.pdf'));
const imagesOf = (m: Metadata): FieldGroup | undefined => m.groups.find((g) => g.id === 'pdf.images');
const refOf = (f: Field) => {
  const m = /^pdfimg:(\d+)-(\d+)$/.exec(f.id);
  if (!m) throw new Error(`bad id ${f.id}`);
  return `${m[1]} ${m[2]}`;
};

interface Stream {
  filters: string[];
  dict: PDFRawStream['dict'];
  /** contents with every filter before DCT/JPX undone */
  data: Uint8Array;
  raw: Uint8Array;
}

/** Every stream of a PDF by "num gen", with Flate layers inflated (image codecs left encoded). */
async function streams(bytes: Uint8Array): Promise<Map<string, Stream>> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const out = new Map<string, Stream>();
  for (const [ref, o] of doc.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream)) continue;
    const f = o.dict.lookup(PDFName.of('Filter'));
    const filters =
      f instanceof PDFArray ? f.asArray().map((x) => (x instanceof PDFName ? x.decodeText() : String(x))) : f instanceof PDFName ? [f.decodeText()] : [];
    let data = o.contents;
    try {
      if (filters.every((x) => x === 'FlateDecode' || x === 'DCTDecode' || x === 'JPXDecode')) {
        for (const x of filters) if (x === 'FlateDecode') data = unzlibSync(data);
      } else data = decodePDFRawStream(o).decode();
    } catch {
      /* other image codecs, broken streams */
    }
    out.set(`${ref.objectNumber} ${ref.generationNumber}`, { filters, dict: o.dict, data, raw: o.contents });
  }
  return out;
}

/** Streams whose direct /Length does not end right before "endstream" (pdf-lib's own parser tolerates that). */
function badLengths(bytes: Uint8Array): string[] {
  const s = Buffer.from(bytes).toString('latin1');
  const bad: string[] = [];
  let checked = 0;
  for (const m of s.matchAll(/(\d+) (\d+) obj\s*<<((?:(?!endobj)[\s\S])*?)>>\s*stream\r?\n/g)) {
    const len = /\/Length (\d+)/.exec(m[3]);
    const end = m.index + m[0].length + Number(len?.[1]);
    if (!len || !/^(\r\n|\n|\r)endstream/.test(s.slice(end, end + 12))) bad.push(`${m[1]} ${m[2]}`);
    checked++;
  }
  return checked ? bad : ['no streams found'];
}

/**
 * Raw file text plus every decoded stream, so compressed leftovers are found
 * too: the streams pdf-lib parses, and every zlib stream found by scanning the
 * bytes (object streams included).
 */
async function allText(bytes: Uint8Array): Promise<string> {
  const raw = Buffer.from(bytes).toString('latin1');
  let s = raw;
  for (const st of (await streams(bytes)).values()) s += Buffer.from(st.data).toString('latin1');
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      s += Buffer.from(unzlibSync(bytes.subarray(start, end))).toString('latin1');
    } catch {
      /* not Flate */
    }
  }
  return s;
}

const scanOf = (jpeg: Uint8Array) => {
  const j = parseJpeg(jpeg);
  return jpeg.subarray(j.scanStart, j.scanEnd);
};
const kinds = (jpeg: Uint8Array) => parseJpeg(jpeg).segments.map((s) => s.kind);
const META_KINDS = ['exif', 'xmp', 'xmpext', 'irb', 'com', 'c2pa', 'ducky', 'app', 'mpf', 'jfxx'];

/** Decoded-pixel MD5 from ffmpeg (no EXIF auto-rotation). */
function pixels(bytes: Uint8Array, ext: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'blueexif-pdfimg-'));
  try {
    const p = join(dir, `x.${ext}`);
    writeFileSync(p, bytes);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-noautorotate', '-i', p, '-frames:v', '1', '-f', 'md5', '-'], { encoding: 'utf8', timeout: 60_000 });
    const out = r.stdout.trim() + r.stderr.trim();
    expect(out).toMatch(/^MD5=[0-9a-f]{32}$/);
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Metadata tags ExifTool finds in an extracted image (COM markers show up as File:Comment). */
async function etMeta(bytes: Uint8Array, name: string): Promise<string[]> {
  return Object.keys(await exiftool(bytes, name)).filter(
    (k) => k === 'File:Comment' || /^(IFD\d|ExifIFD|InteropIFD|GPS|XMP|IPTC|Photoshop|JUMBF|MPF|MakerNotes):/.test(k),
  );
}

/** Top-level JP2 box types. */
function jp2Boxes(b: Uint8Array): string[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: string[] = [];
  for (let p = 0; p + 8 <= b.length; ) {
    let len = v.getUint32(p);
    if (len === 0) len = b.length - p;
    out.push(Buffer.from(b.subarray(p + 4, p + 8)).toString('latin1'));
    p += len;
  }
  return out;
}

function codestream(b: Uint8Array): Uint8Array {
  if (b[0] === 0xff && b[1] === 0x4f) return b;
  const i = Buffer.from(b).indexOf('jp2c');
  return b.subarray(i + 4);
}

/** J2K main-header marker codes (up to the first SOT) and the data from SOT on. */
function j2k(cs: Uint8Array): { markers: number[]; tiles: Uint8Array } {
  const markers: number[] = [];
  let p = 2;
  while (cs[p + 1] !== 0x90) {
    markers.push(cs[p + 1]);
    p += 2 + ((cs[p + 2] << 8) | cs[p + 3]);
  }
  return { markers, tiles: cs.subarray(p) };
}

const isImage = (s: Stream) => s.dict.lookup(PDFName.of('Subtype'))?.toString() === '/Image';
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const metaKinds = (jpeg: Uint8Array) => kinds(jpeg).filter((k) => META_KINDS.includes(k));

describe('pdf embedded images', () => {
  let original: Map<string, Stream>;
  let group: FieldGroup;
  let photo: Field; // one DCT XObject on pages 1 (twice) and 2
  let flate: Field; // [/FlateDecode /DCTDecode] with ICC + Adobe
  let form: Field; // inside a Form XObject, with its own /Metadata
  let thumb: Field; // page thumbnail
  let stamp: Field; // annotation appearance, with data after EOI
  const all = () => [photo, flate, form, thumb, stamp];
  /** Cleaning every image drops page thumbnails (viewers draw their own); the other images stay, cleaned. */
  const kept = () => [photo, flate, form, stamp];

  /** Every listed JPEG is clean, keeps JFIF and has the original scan data, pixels and no /Metadata. */
  async function expectClean(after: Map<string, Stream>, fields: Field[]) {
    for (const f of fields) {
      const before = original.get(refOf(f))!;
      const now = after.get(refOf(f))!;
      expect(await etMeta(before.data, 'x.jpg')).not.toEqual([]);
      expect(metaKinds(now.data)).toEqual([]);
      expect(kinds(now.data)).toContain('jfif');
      expect(parseJpeg(now.data).trailer.length).toBe(0);
      expect(same(scanOf(now.data), scanOf(before.data))).toBe(true);
      expect(now.dict.has(PDFName.of('Metadata'))).toBe(false);
      expect(await etMeta(now.data, 'x.jpg')).toEqual([]);
      if (HAS_FFMPEG) expect(pixels(now.data, 'jpg')).toBe(pixels(before.data, 'jpg'));
    }
  }

  beforeAll(async () => {
    if (HAS_SWIFT) preparePdfKit();
    original = await streams(fixtureBytes(PHOTOS));
    group = imagesOf(await pdfHandler.read(fixture(PHOTOS)))!;
    const find = (re: RegExp) => group.fields.find((f) => re.test(f.display ?? ''))!;
    photo = find(/^Pages 1, 2 · /);
    flate = find(/^Page 2 · /);
    form = find(/Canon/);
    thumb = group.fields.find((f) => f.label === 'Page thumbnail')!;
    stamp = find(/data after image/);
  }, 300_000);

  it('lists the images that carry metadata, with pages, size, summary and sensitivity', () => {
    expect(group).toMatchObject({ id: 'pdf.images', label: 'Embedded images', source: 'PDF', removable: true });
    expect(group.fields).toHaveLength(5);
    for (const f of group.fields) {
      expect(f).toMatchObject({ kind: 'raw', editable: false, removable: true });
      expect(f.tag).toBe(`Image XObject ${refOf(f)} R`);
    }
    const camera = 'EXIF: Apple iPhone 15 Pro, by Jane Doe, taken 2024-05-01 18:29, GPS 37.8199° N 122.4783° W · XMP · IPTC · comment';
    expect(photo.display).toBe(`Pages 1, 2 · 160×120 JPEG · ${camera}`);
    expect(flate.display).toBe(`Page 2 · 160×120 JPEG · ${camera}`);
    expect(form.display).toBe('Page 3 · 160×120 JPEG · EXIF: Canon EOS R5 · comment · XMP stream');
    expect(thumb.display).toBe('Page 1 · 40×30 JPEG · EXIF: by Jane Doe · comment');
    expect(stamp.display).toBe('Page 3 · 160×120 JPEG · EXIF: taken 2024-05-01 18:29 · comment · data after image');
    expect(all().map((f) => f.sensitivity)).toEqual(['location', 'location', 'identity', 'identity', 'time']);
    expect(original.get(refOf(flate))!.filters).toEqual(['FlateDecode', 'DCTDecode']);
    // The PNG (Flate samples) and its soft mask carry nothing and are not listed.
    const listed = new Set(group.fields.map(refOf));
    const samples = [...original].filter(([, s]) => isImage(s) && s.filters.join() === 'FlateDecode');
    expect(samples).toHaveLength(2);
    for (const [ref] of samples) expect(listed.has(ref)).toBe(false);
  });

  it('strips every image: no EXIF/XMP/IPTC/comments left, scan data and pixels identical', async () => {
    const bytes = await bytesOf(await pdfHandler.strip!(fixture(PHOTOS), strip()));
    const text = await allText(bytes);
    for (const s of [...MARKERS, 'Canon', 'Lavc', 'TRAILER']) expect(text).not.toContain(s);
    const m = await read(bytes);
    expect(imagesOf(m)).toBeUndefined();
    expect(field(m, 'pdfdoc:object-xmp')).toBeUndefined();

    const after = await streams(bytes);
    await expectClean(after, kept());
    expect(after.has(refOf(thumb))).toBe(false);
    // The Flate+DCT image is re-encoded with Flate and keeps its ICC profile and Adobe segment.
    const fl = after.get(refOf(flate))!;
    expect(fl.filters).toEqual(['FlateDecode', 'DCTDecode']);
    expect(kinds(fl.data)).toEqual(expect.arrayContaining(['adobe', 'icc']));
    // Images without metadata are untouched.
    for (const [ref, s] of original) if (isImage(s) && s.filters.join() === 'FlateDecode') expect(same(after.get(ref)!.data, s.data)).toBe(true);

    expect(badLengths(bytes)).toEqual([]);
    expect(etProblems(await exiftool(bytes, 's.pdf'))).toEqual([]);
    if (HAS_SWIFT) expect(pdfKitPages(bytes)).toBe(3);
    // PDF viewers ignore EXIF orientation: the first page renders exactly as before.
    if (HAS_QLMANAGE) expect(same(qlRender(bytes, 'pdf', 400), qlRender(fixtureBytes(PHOTOS), 'pdf', 400))).toBe(true);

    // Clean images are left alone: stripping again changes no image stream.
    const again = await streams(await bytesOf(await pdfHandler.strip!(Source.fromBytes(bytes), strip())));
    for (const [ref, s] of after) if (isImage(s)) expect(same(again.get(ref)!.raw, s.raw)).toBe(true);
  });

  it('drops colour profiles only when asked to', async () => {
    const bytes = await bytesOf(await pdfHandler.strip!(fixture(PHOTOS), strip({ keepColorProfile: false })));
    const fl = (await streams(bytes)).get(refOf(flate))!;
    expect(kinds(fl.data)).toContain('adobe');
    expect(kinds(fl.data)).not.toContain('icc');
    expect(same(scanOf(fl.data), scanOf(original.get(refOf(flate))!.data))).toBe(true);
    if (HAS_SWIFT) expect(pdfKitPages(bytes)).toBe(3);
  });

  it('cleans a single image, then all of them through the group', async () => {
    const one = await bytesOf(await pdfHandler.write!(fixture(PHOTOS), edits({ [photo.id]: REMOVE })));
    const m1 = await read(one);
    expect(
      imagesOf(m1)!
        .fields.map((f) => f.id)
        .sort(),
    ).toEqual([flate, form, thumb, stamp].map((f) => f.id).sort());
    const s1 = await streams(one);
    await expectClean(s1, [photo]);
    expect(kinds(s1.get(refOf(flate))!.data)).toContain('exif');
    expect(await allText(one)).toContain('F2LXK1234567'); // still in the other copy
    expect(etProblems(await exiftool(one, 'one.pdf'))).toEqual([]);
    if (HAS_SWIFT) expect(pdfKitPages(one)).toBe(3);

    const every = await bytesOf(await pdfHandler.write!(fixture(PHOTOS), edits({ [groupKey('pdf.images')]: REMOVE })));
    const m2 = await read(every);
    expect(imagesOf(m2)).toBeUndefined();
    expect(field(m2, 'pdfdoc:object-xmp')).toBeUndefined(); // the image's own XMP stream went too
    const text = await allText(every);
    for (const s of MARKERS) expect(text).not.toContain(s);
    const s2 = await streams(every);
    await expectClean(s2, kept());
    expect(s2.has(refOf(thumb))).toBe(false);
    expect(kinds(s2.get(refOf(flate))!.data)).toContain('icc'); // edits keep colour profiles
    expect(etProblems(await exiftool(every, 'all.pdf'))).toEqual([]);
    if (HAS_SWIFT) expect(pdfKitPages(every)).toBe(3);
  });

  it('undoes any filter chain before DCTDecode and keeps the DCT decode parameters', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const jpeg = fixtureBytes('jpeg/camera.jpg');
    const hex = `${Buffer.from(jpeg)
      .toString('hex')
      .replace(/.{1,64}/g, '$&\n')}>`;
    const ref = doc.context.register(
      doc.context.stream(hex, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 160,
        Height: 120,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: ['ASCIIHexDecode', 'DCTDecode'],
        DecodeParms: [null, { ColorTransform: 1 }],
      }),
    );
    const page = doc.addPage([200, 200]);
    page.node.newXObject('Im', ref);
    const bytes = await doc.save({ useObjectStreams: false });
    const id = `pdfimg:${ref.objectNumber}-0`;
    expect(field(await read(bytes), id)?.sensitivity).toBe('location');

    const out = await bytesOf(await pdfHandler.strip!(Source.fromBytes(bytes), strip()));
    const st = (await streams(out)).get(`${ref.objectNumber} 0`)!;
    expect(st.filters).toEqual(['FlateDecode', 'DCTDecode']);
    expect(st.dict.lookup(PDFName.of('DecodeParms'))?.toString().replace(/\s+/g, ' ')).toBe('[ null << /ColorTransform 1 >> ]');
    expect(metaKinds(st.data)).toEqual([]);
    expect(same(scanOf(st.data), scanOf(jpeg))).toBe(true);
    expect(field(await read(out), id)).toBeUndefined();
    expect(badLengths(out)).toEqual([]);
    if (HAS_SWIFT) expect(pdfKitPages(out)).toBe(1);
  });

  it.skipIf(!HAS_FFMPEG)('reads a large Flate-wrapped JPEG from its leading bytes and cleans it in full', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blueexif-pdfimg-'));
    let big: Uint8Array;
    try {
      const p = join(dir, 'big.jpg');
      const lavfi = 'color=c=gray:s=1200x900,noise=alls=100:allf=t';
      spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', lavfi, '-frames:v', '1', '-q:v', '2', p], { timeout: 60_000 });
      big = new Uint8Array(readFileSync(p));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(big.length).toBeGreaterThan(300_000);
    const camera = fixtureBytes('jpeg/camera.jpg');
    const exif = parseJpeg(camera).segments.find((x) => x.kind === 'exif')!;
    const jpeg = new Uint8Array(Buffer.concat([big.subarray(0, 2), camera.subarray(exif.offset, exif.offset + 4 + exif.data.length), big.subarray(2)]));
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ref = doc.context.register(
      doc.context.stream(deflateSync(jpeg), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 1200,
        Height: 900,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: ['FlateDecode', 'DCTDecode'],
      }),
    );
    doc.addPage([200, 200]).node.newXObject('Im', ref);
    const bytes = await doc.save({ useObjectStreams: false });
    const id = `pdfimg:${ref.objectNumber}-0`;
    expect(field(await read(bytes), id)?.display).toMatch(/^Page 1 · 1200×900 JPEG · EXIF: Apple iPhone 15 Pro, .*GPS 37\.8199° N/);

    const out = await bytesOf(await pdfHandler.strip!(Source.fromBytes(bytes), strip()));
    const st = (await streams(out)).get(`${ref.objectNumber} 0`)!;
    expect(metaKinds(st.data)).toEqual([]);
    expect(same(scanOf(st.data), scanOf(jpeg))).toBe(true);
    expect(field(await read(out), id)).toBeUndefined();
  });

  it('tolerates broken image streams and leaves them as they are', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    const base = { Type: 'XObject', Subtype: 'Image', Width: 8, Height: 8, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 };
    const garbage = new Uint8Array(4096).map((_, i) => (i * 37) & 0xff);
    const camera = fixtureBytes('jpeg/camera.jpg');
    const broken = [
      ctx.stream(garbage, { ...base, Filter: 'DCTDecode' }),
      ctx.stream(camera.subarray(0, 600), { ...base, Filter: 'DCTDecode' }), // truncated inside the EXIF segment
      ctx.stream(garbage, { ...base, Filter: ['FlateDecode', 'DCTDecode'] }), // not zlib
      ctx.stream(deflateSync(garbage), { ...base, Filter: ['FlateDecode', 'DCTDecode'] }), // zlib, not a JPEG
      ctx.stream(garbage, { ...base, Filter: 'JPXDecode' }),
      ctx.stream(garbage, { ...base, Filter: ['LZWDecode', 'DCTDecode'] }),
      ctx.stream(garbage, { ...base, Filter: ctx.obj([7]) }),
    ].map((s) => ctx.register(s));
    const page = doc.addPage([200, 200]);
    broken.forEach((ref) => page.node.newXObject('Im', ref));
    const bytes = await doc.save({ useObjectStreams: false });

    expect(imagesOf(await read(bytes))).toBeUndefined();
    const out = await bytesOf(await pdfHandler.strip!(Source.fromBytes(bytes), strip()));
    const before = await streams(bytes);
    const after = await streams(out);
    for (const ref of broken) {
      const key = `${ref.objectNumber} 0`;
      expect(same(after.get(key)!.raw, before.get(key)!.raw)).toBe(true);
    }
    if (HAS_SWIFT) expect(pdfKitPages(out)).toBe(1);
  });

  it('reads hundreds of photos from their headers only', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const jpeg = fixtureBytes('jpeg/camera.jpg');
    const logo = await doc.embedJpg(fixtureBytes('jpeg/le.jpg'));
    for (let p = 0; p < 30; p++) {
      const page = doc.addPage([400, 300]);
      for (let i = 0; i < 10; i++) page.drawImage(await doc.embedJpg(jpeg), { x: i * 30, y: 10, width: 30, height: 20 });
      if (p !== 3) page.drawImage(logo, { x: 0, y: 200, width: 30, height: 20 });
    }
    const bytes = await doc.save();
    const t = performance.now();
    const g = imagesOf(await read(bytes))!;
    const ms = performance.now() - t;
    expect(g.fields).toHaveLength(301);
    expect(g.fields[0].display).toMatch(/^Pages 1–3, 5–30 · 160×120 JPEG · EXIF: Canon EOS R5/);
    expect(g.fields[300].display).toMatch(/^Page 30 · 160×120 JPEG · EXIF: Apple/);
    expect(ms).toBeLessThan(5000);
  });
});

describe('pdf embedded JPEG 2000 images', () => {
  it('lists JP2 metadata boxes and codestream comments, and strips them', async () => {
    const g = imagesOf(await pdfHandler.read(fixture(JPX)))!;
    expect(g.fields).toHaveLength(2);
    const jp2 = g.fields.find((f) => /XMP/.test(f.display ?? ''))!;
    const raw = g.fields.find((f) => f !== jp2)!;
    expect(jp2.display).toBe('Page 1 · 160×120 JPEG 2000 · EXIF: Apple iPhone 15 Pro, GPS 37.8199° N 122.4783° W · XMP · comment “Kakadu-v5.2.1”');
    expect(jp2.sensitivity).toBe('location');
    expect(raw.display).toBe('Page 1 · 160×120 JPEG 2000 · comment “Scanned by Jane Doe; Kakadu-v5.2.1”');
    expect(raw.sensitivity).toBe('content');

    const before = await streams(fixtureBytes(JPX));
    expect(jp2Boxes(before.get(refOf(jp2))!.data)).toEqual(['jP  ', 'ftyp', 'jp2h', 'uuid', 'uuid', 'jp2c']);
    const bytes = await bytesOf(await pdfHandler.strip!(fixture(JPX), strip()));
    const after = await streams(bytes);
    const text = await allText(bytes);
    for (const s of [...MARKERS, 'Kakadu']) expect(text).not.toContain(s);
    expect(imagesOf(await read(bytes))).toBeUndefined();

    const a = after.get(refOf(jp2))!.data;
    expect(jp2Boxes(a)).toEqual(['jP  ', 'ftyp', 'jp2h', 'jp2c']);
    for (const [f, ext] of [
      [jp2, 'jp2'],
      [raw, 'j2k'],
    ] as const) {
      const was = j2k(codestream(before.get(refOf(f))!.data));
      const now = j2k(codestream(after.get(refOf(f))!.data));
      expect(was.markers).toContain(0x64);
      expect(now.markers).toEqual(was.markers.filter((m) => m !== 0x64));
      expect(same(now.tiles, was.tiles)).toBe(true);
      expect(await etMeta(before.get(refOf(f))!.data, `x.${ext}`)).not.toEqual([]);
      expect(await etMeta(after.get(refOf(f))!.data, `x.${ext}`)).toEqual([]);
      if (HAS_FFMPEG) expect(pixels(after.get(refOf(f))!.data, ext)).toBe(pixels(before.get(refOf(f))!.data, ext));
    }
    expect(badLengths(bytes)).toEqual([]);
    expect(etProblems(await exiftool(bytes, 'j.pdf'))).toEqual([]);
    if (HAS_SWIFT) expect(pdfKitPages(bytes)).toBe(1);
    if (HAS_QLMANAGE) expect(same(qlRender(bytes, 'pdf', 400), qlRender(fixtureBytes(JPX), 'pdf', 400))).toBe(true);
  });
});

describe('pdf embedded JPEGs: JFIF thumbnails and segments among the scans', () => {
  const seg = (marker: number, d: Uint8Array | number[]) =>
    Buffer.concat([Buffer.from([0xff, marker, (d.length + 2) >> 8, (d.length + 2) & 0xff]), Buffer.from(d)]);
  const plain = fixtureBytes('jpeg/plain.jpg');
  const [jfif, com] = parseJpeg(plain).segments;
  // plain.jpg without its encoder comment: JFIF (no thumbnail) and coding segments only
  const base = Buffer.concat([plain.subarray(0, com.offset), plain.subarray(com.offset + 4 + com.data.length)]);
  const after = base.subarray(jfif.offset + 4 + jfif.data.length);
  // JFIF 1.02, 72×72 dpi, with a 2×2 RGB thumbnail
  const thumbJfif = seg(0xe0, [...Buffer.from('JFIF\0'), 1, 2, 1, 0, 72, 0, 72, 2, 2, ...[255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]]);
  const withThumb = new Uint8Array(Buffer.concat([base.subarray(0, 2), thumbJfif, after]));
  // a comment and an EXIF segment after the scan, before EOI
  const late = Buffer.concat([seg(0xfe, Buffer.from('hidden LATE-MARKER')), seg(0xe1, Buffer.from('Exif\0\0junk LATE-EXIF'))]);
  const withLate = new Uint8Array(Buffer.concat([base.subarray(0, base.length - 2), late, base.subarray(base.length - 2)]));

  it('lists and cleans them, leaving clean images untouched', async () => {
    expect(metaKinds(base)).toEqual([]);
    expect(parseJpeg(withLate).late.map((s) => s.kind)).toEqual(['com', 'exif']);
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    const image = (data: Uint8Array, flate = false) =>
      ctx.register(
        ctx.stream(flate ? deflateSync(data) : data, {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 160,
          Height: 120,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
          Filter: flate ? ['FlateDecode', 'DCTDecode'] : 'DCTDecode',
        }),
      );
    const refs = { clean: image(base), thumb: image(withThumb), late: image(withLate), flate: image(withLate, true) };
    const page = doc.addPage([200, 200]);
    for (const ref of Object.values(refs)) page.node.newXObject('Im', ref);
    const bytes = await doc.save({ useObjectStreams: false });
    const key = (r: (typeof refs)['clean']) => `${r.objectNumber} 0`;

    const g = imagesOf(await read(bytes))!;
    const shown = (r: (typeof refs)['clean']) => g.fields.find((f) => refOf(f) === key(r));
    expect(shown(refs.clean)).toBeUndefined();
    expect(shown(refs.thumb)).toMatchObject({ display: 'Page 1 · 160×120 JPEG · thumbnail', sensitivity: 'content' });
    for (const r of [refs.late, refs.flate]) expect(shown(r)?.display).toMatch(/^Page 1 · 160×120 JPEG · data among the scans \(.*comment.*\)$/);

    const out = await bytesOf(await pdfHandler.strip!(Source.fromBytes(bytes), strip()));
    expect(await allText(out)).not.toMatch(/LATE-MARKER|LATE-EXIF/);
    const before = await streams(bytes);
    const now = await streams(out);
    expect(same(now.get(key(refs.clean))!.raw, before.get(key(refs.clean))!.raw)).toBe(true);
    const thumb = parseJpeg(now.get(key(refs.thumb))!.data);
    expect([...thumb.segments[0].data]).toEqual([...Buffer.from('JFIF\0'), 1, 2, 1, 0, 72, 0, 72, 0, 0]);
    for (const r of [refs.thumb, refs.late, refs.flate]) {
      const data = now.get(key(r))!.data;
      expect(parseJpeg(data).late).toEqual([]);
      expect(metaKinds(data)).toEqual([]);
      expect(same(scanOf(data), scanOf(base))).toBe(true);
      if (HAS_FFMPEG) expect(pixels(data, 'jpg')).toBe(pixels(base, 'jpg'));
    }
    expect(now.get(key(refs.flate))!.filters).toEqual(['FlateDecode', 'DCTDecode']);
    expect(imagesOf(await read(out))).toBeUndefined();
    expect(badLengths(out)).toEqual([]);
    expect(etProblems(await exiftool(out, 'l.pdf'))).toEqual([]);
    if (HAS_SWIFT) expect(pdfKitPages(out)).toBe(1);
  });
});
