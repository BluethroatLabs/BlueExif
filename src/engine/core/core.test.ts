import { describe, expect, it } from 'vitest';
import { gzipSync, zipSync, zlibSync, strToU8 } from 'fflate';
import { crc32, encodeUtf16, inflateLimited, utf16Bom, Reader, Writer } from './binary';
import { iccDescription } from './icc';
import { formatGps, parseDate, parseGpsString, parseIso6709, toExifDate, toIso, toIso6709 } from './fields';
import { MAX_XML_DEPTH, child, getAttrNs, nsOf, parseXml, serializeDetached, serializeXml, textContent } from './xml';
import { ZipArchive, rewriteZip } from './zip';
import { Source } from './types';
import { applyXmpEdits, parseXmp, serializeXmp, xmpGroups, xmpValue } from '../xmp/xmp';
import { applyIptcEdits, iptcGroups, parseIptc, serializeIptc } from '../iptc/iptc';
import { exifGroups, applyExifEdits } from '../exif/fields';
import { parseTiff, writeTiff, emptyExif, toRational } from '../exif/tiff';
import { edits, REMOVE } from '../test/helpers';

describe('binary', () => {
  it('reads and writes both endiannesses', () => {
    const w = new Writer(true);
    w.u16(0x1234).u32(0xdeadbeef).u64(2 ** 40 + 5).u24(0xabcdef);
    const r = new Reader(w.finish(), true);
    expect(r.u16()).toBe(0x1234);
    expect(r.u32()).toBe(0xdeadbeef);
    expect(r.u64()).toBe(2 ** 40 + 5);
    expect(r.u24()).toBe(0xabcdef);
  });
  it('crc32 matches the zlib reference', () => {
    expect(crc32(strToU8('123456789'))).toBe(0xcbf43926);
  });
  it('inflates zlib and gzip data within a size limit', () => {
    const data = new Uint8Array(100_000).map((_, i) => (i * 7) & 0xff);
    expect(inflateLimited(zlibSync(data), 'zlib')).toEqual(data);
    expect(inflateLimited(gzipSync(data), 'gzip')).toEqual(data);
    const bomb = zlibSync(new Uint8Array(8 << 20));
    expect(() => inflateLimited(bomb, 'zlib', 1 << 20)).toThrow(/expands to more than 1.0 MB/);
    expect(inflateLimited(bomb, 'zlib', 8 << 20).length).toBe(8 << 20);
    expect(() => inflateLimited(strToU8('not zlib'), 'zlib')).toThrow(/corrupt/);
  });
  it('reads an ICC description whatever record count the profile claims', () => {
    const icc = new Uint8Array(200);
    const v = new DataView(icc.buffer);
    icc.set(strToU8('acsp'), 36);
    v.setUint32(128, 1); // one tag: desc at 144
    icc.set(strToU8('desc'), 132);
    v.setUint32(136, 144);
    v.setUint32(140, 56);
    icc.set(strToU8('mluc'), 144);
    v.setUint32(152, 0xffffffff); // record count (only one exists); scanning them all once took minutes
    v.setUint32(156, 12);
    icc.set(strToU8('deDE'), 160); // no English record, so the search runs to the end
    v.setUint32(164, 8);
    v.setUint32(168, 28);
    icc.set([0, 0x54, 0, 0x65, 0, 0x73, 0, 0x74], 172); // "Test", UTF-16BE
    expect(iccDescription(icc)).toBe('Test');
  });
  it('utf16 with BOM round-trips', () => {
    expect(utf16Bom(encodeUtf16('héllo ✓', true, true))).toBe('héllo ✓');
    expect(utf16Bom(encodeUtf16('héllo ✓', false, true))).toBe('héllo ✓');
  });
});

describe('dates and gps', () => {
  it('parses ISO and EXIF dates', () => {
    expect(parseDate('2024:05:01 18:29:59')).toMatchObject({ year: 2024, month: 5, day: 1, hour: 18, minute: 29, second: 59 });
    expect(parseDate('2024-05-01T18:29:59.123+02:00')).toMatchObject({ fraction: '123', tz: 120 });
    expect(parseDate('2024')).toEqual({ year: 2024 });
    expect(parseDate('2024-13-01')).toBeNull();
    expect(parseDate('yesterday')).toBeNull();
    expect(toIso(parseDate('2024:05:01 18:29:59')!)).toBe('2024-05-01T18:29:59');
    expect(toExifDate(parseDate('2024-05-01T18:29')!)).toBe('2024:05:01 18:29:00');
    expect(toIso(parseDate('2024-05-01T18:29:00Z')!)).toBe('2024-05-01T18:29:00Z');
  });
  it('parses coordinate strings', () => {
    expect(parseGpsString('48.8584, 2.2945')).toEqual({ lat: 48.8584, lon: 2.2945 });
    const dms = parseGpsString(`48°51'30"N 2°17'40"E`)!;
    expect(dms.lat).toBeCloseTo(48.858333, 5);
    expect(dms.lon).toBeCloseTo(2.294444, 5);
    expect(parseGpsString('33.9 S, 151.2 E')).toEqual({ lat: -33.9, lon: 151.2 });
    expect(parseGpsString('100, 200')).toBeNull();
    expect(formatGps({ lat: -33.9, lon: 151.2 })).toBe('33.900000° S, 151.200000° E');
  });
  it('round-trips ISO 6709', () => {
    const g = parseIso6709('+37.7749-122.4194+010.500/')!;
    expect(g).toEqual({ lat: 37.7749, lon: -122.4194, alt: 10.5 });
    expect(parseIso6709(toIso6709(g))).toEqual(g);
  });
});

describe('xml', () => {
  const src = `<?xml version="1.0"?>\n<!-- hi --><root xmlns="urn:a" xmlns:b="urn:b" b:attr="1 &amp; 2"><b:item>x &lt; y</b:item><![CDATA[<raw>]]><empty/></root>`;
  it('parses with namespaces and entities', () => {
    const doc = parseXml(src);
    expect(nsOf(doc.root)).toBe('urn:a');
    expect(getAttrNs(doc.root, 'urn:b', 'attr')).toBe('1 & 2');
    const item = child(doc.root, 'urn:b', 'item')!;
    expect(textContent(item)).toBe('x < y');
  });
  it('serializes faithfully', () => {
    const out = serializeXml(parseXml(src));
    expect(parseXml(out).root.children.length).toBe(3);
    expect(out).toContain('<![CDATA[<raw>]]>');
    expect(out).toContain('b:attr="1 &amp; 2"');
  });
  it('detached serialization re-declares namespaces', () => {
    const doc = parseXml(src);
    const s = serializeDetached(child(doc.root, 'urn:b', 'item')!);
    expect(s).toBe('<b:item xmlns:b="urn:b">x &lt; y</b:item>');
  });
  it('refuses nesting deeper than the tree walkers can recurse', () => {
    const nest = (n: number) => `${'<a>'.repeat(n)}x${'</a>'.repeat(n)}`;
    const doc = parseXml(nest(MAX_XML_DEPTH));
    expect(textContent(doc.root)).toBe('x');
    expect(serializeXml(doc)).toContain(nest(MAX_XML_DEPTH));
    expect(() => parseXml(nest(MAX_XML_DEPTH + 1))).toThrow(/nested more than 512 levels deep/);
    expect(() => parseXml(nest(200_000))).toThrow(/nested more than 512 levels deep/);
  });
  it('rejects malformed XML', () => {
    expect(() => parseXml('<a><b></a>')).toThrow();
    expect(() => parseXml('<a/><b/>')).toThrow();
  });
});

describe('zip', () => {
  const make = () =>
    zipSync({
      mimetype: [strToU8('application/x-test'), { level: 0 }],
      'a.xml': strToU8('<a>hello</a>'),
      'dir/b.bin': new Uint8Array(1000).fill(7),
    });
  it('reads entries', async () => {
    const z = await ZipArchive.open(Source.fromBytes(make()));
    expect(z.entries.map((e) => e.name)).toEqual(['mimetype', 'a.xml', 'dir/b.bin']);
    expect(await z.readText('a.xml')).toBe('<a>hello</a>');
    expect((await z.read('dir/b.bin')).every((b) => b === 7)).toBe(true);
  });
  it('rewrites surgically (replace, delete, add, normalise times)', async () => {
    const z = await ZipArchive.open(Source.fromBytes(make()));
    const out = await rewriteZip(z, {
      replace: new Map([
        ['a.xml', strToU8('<a>bye</a>')],
        ['dir/b.bin', null],
      ]),
      add: [{ name: 'new.txt', data: strToU8('new') }],
      normalizeTime: new Date(1980, 0, 1),
    });
    const z2 = await ZipArchive.open(new Source(out));
    expect(z2.entries.map((e) => e.name)).toEqual(['mimetype', 'a.xml', 'new.txt']);
    expect(z2.get('mimetype')!.method).toBe(0);
    expect(await z2.readText('a.xml')).toBe('<a>bye</a>');
    expect(await z2.readText('new.txt')).toBe('new');
    expect(z2.entries.every((e) => e.modDate === ((0 << 9) | (1 << 5) | 1))).toBe(true);
  });
  it('checks declared sizes instead of trusting them', async () => {
    /** The archive with a.xml's uncompressed size in the central directory set to `size`. */
    const withSize = (size: number) => {
      const b = zipSync({ 'a.xml': strToU8(`<a>${'x'.repeat(5000)}</a>`) });
      const v = new DataView(b.buffer);
      for (let p = b.length - 22; p >= 0; p--) {
        if (v.getUint32(p, true) === 0x02014b50) {
          v.setUint32(p + 24, size, true);
          break;
        }
      }
      return ZipArchive.open(Source.fromBytes(b));
    };
    expect(await (await withSize(5007)).readText('a.xml')).toMatch(/^<a>x+<\/a>$/);
    await expect((await withSize(0x7ffffffe)).read('a.xml')).rejects.toThrow(/a.xml is too large to process/);
    await expect((await withSize(10)).read('a.xml')).rejects.toThrow(/a.xml cannot be decompressed: compressed data expands to more than 10 B/);
  });
});

describe('exif', () => {
  it('copies each value range about once, however many entries point at it', () => {
    // IFD0 with 1,000 UNDEFINED entries that all point at the same 60 KB: 60 MB of copies before.
    const n = 1000;
    const region = 8 + 2 + n * 12 + 4;
    const b = new Uint8Array(region + 60_000);
    const v = new DataView(b.buffer);
    b.set([0x49, 0x49, 0x2a, 0], 0);
    v.setUint32(4, 8, true);
    v.setUint16(8, n, true);
    for (let i = 0; i < n; i++) {
      const p = 10 + i * 12;
      v.setUint16(p, 0xc000 + i, true);
      v.setUint16(p + 2, 7, true);
      v.setUint32(p + 4, 60_000, true);
      v.setUint32(p + 8, region, true);
    }
    const d = parseTiff(b);
    expect(d.ifd0.entries.length).toBeLessThan(5);
    expect(d.warnings.filter((w) => /overlaps other values/.test(w)).length).toBeGreaterThan(990);
  });
  it('builds EXIF from scratch and reads it back', () => {
    const d = emptyExif(false);
    applyExifEdits(
      d,
      edits({
        'exif:ifd0:013b': 'Ada',
        'exif:ifd0:0112': '6',
        'exif:exif:829a': '1/250',
        'exif:exif:9003': '2020-01-02T03:04:05-05:00',
        'exif:gps:location': { lat: 51.5007, lon: -0.1246, alt: 12 },
        'exif:ifd0:9c9b': 'Tîtle',
      }),
    );
    const back = parseTiff(writeTiff(d));
    const fields = exifGroups(back).flatMap((g) => g.fields);
    const get = (id: string) => fields.find((f) => f.id === id);
    expect(get('exif:ifd0:013b')?.value).toBe('Ada');
    expect(get('exif:ifd0:0112')?.value).toBe('6');
    expect(get('exif:exif:829a')?.display).toBe('1/250 s');
    expect(get('exif:exif:9003')?.value).toBe('2020-01-02T03:04:05');
    expect(get('exif:exif:9011')?.value).toBe('-05:00');
    expect(get('exif:ifd0:9c9b')?.value).toBe('Tîtle');
    expect(get('exif:gps:location')?.value).toEqual({ lat: 51.5007, lon: -0.1246, alt: 12 });
    applyExifEdits(back, edits({ 'exif:gps:location': REMOVE }));
    expect(back.gps).toBeNull();
  });
  it('approximates rationals', () => {
    expect(toRational(0.5)).toEqual([1, 2]);
    expect(toRational(1 / 3)).toEqual([1, 3]);
    expect(toRational(2.8)).toEqual([14, 5]);
  });
});

describe('xmp', () => {
  const packet = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Test">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Tool &amp; Co" xmp:Rating="3"/>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Hello</rdf:li><rdf:li xml:lang="de">Hallo</rdf:li></rdf:Alt></dc:title>
   <dc:subject><rdf:Bag><rdf:li>a</rdf:li><rdf:li>b</rdf:li></rdf:Bag></dc:subject>
   <Iptc4xmpCore:CreatorContactInfo rdf:parseType="Resource"><Iptc4xmpCore:CiEmailWork>me@example.com</Iptc4xmpCore:CiEmailWork></Iptc4xmpCore:CreatorContactInfo>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  it('parses simple, alt, bag and complex properties', () => {
    const p = parseXmp(packet);
    expect(p.toolkit).toBe('Test');
    expect(xmpValue(p, 'xmp:CreatorTool')).toBe('Tool & Co');
    expect(xmpValue(p, 'dc:title')).toBe('Hello');
    expect(xmpValue(p, 'dc:subject')).toBe('a; b');
    const fields = xmpGroups(p).flatMap((g) => g.fields);
    const contact = fields.find((f) => f.tag === 'Iptc4xmpCore:CreatorContactInfo')!;
    expect(contact.kind).toBe('raw');
    expect(contact.display).toContain('me@example.com');
    expect(contact.sensitivity).toBe('identity');
  });
  it('edits and re-serializes, keeping translations and structures', () => {
    const p = parseXmp(packet);
    applyXmpEdits(
      p,
      edits({
        'xmp:http://purl.org/dc/elements/1.1/|title': 'Bonjour',
        'xmp:http://purl.org/dc/elements/1.1/|subject': ['x'],
        'xmp:http://ns.adobe.com/xap/1.0/|Rating': REMOVE,
        'xmp:http://purl.org/dc/elements/1.1/|creator': ['Me'],
      }),
    );
    const again = parseXmp(serializeXmp(p));
    expect(xmpValue(again, 'dc:title')).toBe('Bonjour');
    expect(again.props.find((x) => x.name === 'title')!.alt).toEqual([
      { lang: 'x-default', value: 'Bonjour' },
      { lang: 'de', value: 'Hallo' },
    ]);
    expect(xmpValue(again, 'dc:subject')).toBe('x');
    expect(xmpValue(again, 'dc:creator')).toBe('Me');
    expect(xmpValue(again, 'xmp:Rating')).toBeUndefined();
    expect(again.props.find((x) => x.name === 'CreatorContactInfo')?.kind).toBe('complex');
  });
});

describe('iptc', () => {
  it('edits datasets and transcodes to UTF-8', () => {
    // Latin-1 encoded caption without a 1:90 declaration
    const latin = new Uint8Array([0x1c, 2, 120, 0, 4, 0x63, 0x61, 0x66, 0xe9]);
    const d = parseIptc(latin);
    expect(iptcGroups(d)[0].fields[0].value).toBe('café');
    applyIptcEdits(d, edits({ 'iptc:2:25': ['ünï', 'two'], 'iptc:2:55': '2021-02-03T04:05:06+01:00' }));
    const back = parseIptc(serializeIptc(d));
    const fields = iptcGroups(back)[0].fields;
    expect(fields.find((f) => f.id === 'iptc:2:120')?.value).toBe('café');
    expect(fields.find((f) => f.id === 'iptc:2:25')?.value).toEqual(['ünï', 'two']);
    expect(fields.find((f) => f.id === 'iptc:2:55')?.value).toBe('2021-02-03T04:05:06+01:00');
  });
});
