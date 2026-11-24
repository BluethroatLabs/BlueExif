import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { concat, equalBytes } from '../core/binary';
import { Source, groupKey, type ImageValue } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { HAS_PYTHON, exiftoolPart, pyZip } from '../test/docOracles';
import { inspectEmbedded } from './embedded';
import { epubHandler } from './epub';
import { parseJpeg } from './jpeg';

const MARK = 'SECRET-MARKER-42';
const OPF = 'OEBPS/content.opf';
const DC = 'http://purl.org/dc/elements/1.1/';
const read = (b: Uint8Array | Blob) => epubHandler.read(b instanceof Blob ? new Source(b) : Source.fromBytes(b));

function detect(rel: string): number {
  const b = fixtureBytes(rel);
  const name = rel.split('/').pop()!;
  return epubHandler.detect({ head: b.subarray(0, 65536), name, ext: name.split('.').pop()!, size: b.length });
}

function texts(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(unzipSync(bytes))) out[k] = strFromU8(v, true);
  return out;
}

/** ExifTool identifies EPUB only when `mimetype` is the first, stored entry. */
async function checkContainer(bytes: Uint8Array) {
  const et = await exiftool(bytes, 'book.epub');
  expect(et['File:FileType']).toBe('EPUB');
  expect(et['ZIP:ZipFileName']).toBe('mimetype');
  expect(et['ZIP:ZipCompression']).toBe('None');
  expect(etProblems(et).filter((p) => !/Archive::Zip/.test(p))).toEqual([]);
  if (HAS_PYTHON) {
    const py = pyZip(bytes);
    expect(py.bad).toBeNull();
    expect(py.xmlErrors).toEqual({});
    expect(py.first).toEqual({ name: 'mimetype', stored: true });
  }
  return et;
}

describe('epub', () => {
  it('detects EPUBs', () => {
    expect(detect('documents/book2.epub')).toBe(3);
    expect(detect('documents/book3.epub')).toBe(3);
    expect(detect('documents/rich.odt')).toBe(0);
  });

  it('reads an EPUB 2 package with calibre metadata and vendor files', async () => {
    const m = await epubHandler.read(fixture('documents/book2.epub'));
    expect(m.format.id).toBe('epub');
    expect(m.info.find((i) => i.label === 'EPUB version')?.value).toBe('2.0');
    expect(field(m, 'epub:dc:title')).toMatchObject({ value: 'The Stormy Night', removable: false });
    expect(field(m, 'epub:dc:creator')).toMatchObject({
      value: [`Jane ${MARK} Doe`, 'Ann Artist'],
      display: `Jane ${MARK} Doe (aut, file as “Doe, Jane ${MARK}”); Ann Artist (ill)`,
    });
    expect(field(m, 'epub:dc:contributor')?.display).toBe('calibre (6.29.0) [https://calibre-ebook.com] (bkp)');
    expect(field(m, 'epub:dc:publisher')?.value).toBe(`Publisher ${MARK}`);
    expect(field(m, 'epub:dc:date')?.value).toBe('2024-05-01T00:00:00Z');
    expect(field(m, 'epub:dc:subject')?.value).toEqual(['Fiction', 'Weather']);
    expect(field(m, 'epub:dc:language')).toMatchObject({ value: ['en'], removable: false });
    expect(field(m, 'epub:dc:identifier:0')).toMatchObject({ label: 'Identifier (unique)', removable: false });
    expect(field(m, 'epub:dc:identifier:1')).toMatchObject({ label: 'Identifier (calibre)', value: `${MARK}-calibre-id`, removable: true });
    expect(field(m, 'epub:dc:identifier:2')?.label).toBe('Identifier (ISBN)');
    const metas = allFields(m).filter((f) => /^epub:meta:\d+$/.test(f.id));
    expect(metas.map((f) => f.label)).toEqual(['calibre:timestamp', 'calibre:title_sort', 'calibre:author_link_map', 'calibre:user_metadata:#reader']);
    expect(field(m, 'epub:cover')?.value as ImageValue).toMatchObject({ mime: 'image/png', width: 24, height: 32 });
    expect(field(m, 'epub:cover')).toMatchObject({ editable: false, removable: false });
    expect(field(m, 'epub:ncx:docAuthor')?.display).toBe(`Jane ${MARK} Doe`);
    expect(field(m, 'epub:file:iTunesMetadata.plist')?.display).toBe(`Apple ID buyer@${MARK}.example, purchased 2024-05-01T10:00:00Z`);
    expect(field(m, 'epub:file:META-INF/calibre_bookmarks.txt')).toBeDefined();
    expect(m.groups.find((g) => g.id === 'epub.dc')?.addable?.map((a) => a.id)).toEqual([
      'epub:dc:source',
      'epub:dc:coverage',
      'epub:dc:relation',
      'epub:dc:type',
      'epub:dc:format',
    ]);
  });

  it('reads an EPUB 3 package with refinements', async () => {
    const m = await epubHandler.read(fixture('documents/book3.epub'));
    expect(m.info.find((i) => i.label === 'Layout')?.value).toBe('reflowable');
    expect(field(m, 'epub:dc:creator')?.display).toBe(`Jane ${MARK} Doe (aut, file as “Doe, Jane ${MARK}”)`);
    expect(field(m, 'epub:dc:contributor')?.display).toBe(`Editor ${MARK} (edt)`);
    expect(field(m, 'epub:meta:dcterms:modified')).toMatchObject({ value: '2024-05-02T11:30:00Z', removable: false });
    expect(field(m, 'epub:dc:identifier:1')?.label).toBe('Identifier (ISBN)');
    expect(field(m, 'epub:dc:date')?.value).toBe('2024-05-01');
    const metas = allFields(m).filter((f) => /^epub:meta:\d+$/.test(f.id));
    expect(metas.map((f) => f.label)).toEqual(['calibre:timestamp', 'belongs-to-collection']);
    expect(field(m, 'epub:cover')?.tag).toBe('OEBPS/images/cover.png');
  });

  it('edits Dublin Core, identifiers and dcterms:modified', async () => {
    const before = await epubHandler.read(fixture('documents/book3.epub'));
    const calibreTs = allFields(before).find((f) => f.label === 'calibre:timestamp')!.id;
    const out = await epubHandler.write!(
      fixture('documents/book3.epub'),
      edits({
        'epub:dc:title': 'A <Calm> & “Quiet” Day',
        'epub:dc:creator': ['Zoë Smith', 'Max Mustermann'],
        'epub:dc:publisher': REMOVE,
        'epub:dc:date': '2023-12-24',
        'epub:dc:subject': ['Calm'],
        'epub:dc:coverage': 'Europe',
        'epub:dc:identifier:0': 'urn:uuid:00000000-0000-4000-8000-000000000001',
        'epub:dc:identifier:1': REMOVE,
        'epub:meta:dcterms:modified': '2025-01-02T03:04:05+01:00',
        [calibreTs]: REMOVE,
      }),
    );
    const bytes = await bytesOf(out);
    await checkContainer(bytes);
    const m = await read(bytes);
    expect(field(m, 'epub:dc:title')?.value).toBe('A <Calm> & “Quiet” Day');
    expect(field(m, 'epub:dc:creator')).toMatchObject({ value: ['Zoë Smith', 'Max Mustermann'], display: 'Zoë Smith (aut); Max Mustermann' });
    expect(field(m, 'epub:dc:publisher')).toBeUndefined();
    expect(field(m, 'epub:dc:date')?.value).toBe('2023-12-24');
    expect(field(m, 'epub:dc:subject')?.value).toEqual(['Calm']);
    expect(field(m, 'epub:dc:coverage')?.value).toBe('Europe');
    expect(field(m, 'epub:dc:identifier:0')?.value).toBe('urn:uuid:00000000-0000-4000-8000-000000000001');
    expect(field(m, 'epub:dc:identifier:1')).toBeUndefined();
    expect(field(m, 'epub:meta:dcterms:modified')?.value).toBe('2025-01-02T02:04:05Z');
    const et = await exiftoolPart(bytes, OPF);
    expect(etProblems(et)).toEqual([]);
    expect(et['XMP-dc:PackageMetadataTitle']).toBe('A <Calm> & “Quiet” Day');
    expect(et['XMP-dc:PackageMetadataCoverage']).toBe('Europe');
    expect(et['XMP-dc:PackageMetadataPublisher']).toBeUndefined();
    const opf = texts(bytes)[OPF];
    expect(opf).not.toContain('calibre:timestamp');
    expect(opf).not.toContain(`Doe, Jane ${MARK}`); // stale file-as of the renamed creator
    expect(opf).toContain('<meta refines="#creator01" property="role" scheme="marc:relators">aut</meta>');
    expect(opf).toContain('rendition:layout');
    if (HAS_PYTHON) {
      const py = pyZip(bytes, [OPF]);
      expect(py.parts[OPF].filter((e) => e.tag === `{${DC}}creator`).map((e) => e.text)).toEqual(['Zoë Smith', 'Max Mustermann']);
      expect(py.parts[OPF].find((e) => e.tag === `{${DC}}coverage`)?.text).toBe('Europe');
    }
  });

  it('removes vendor files and NCX authors from an EPUB 2 package', async () => {
    const out = await epubHandler.write!(
      fixture('documents/book2.epub'),
      edits({ 'epub:file:iTunesMetadata.plist': REMOVE, 'epub:ncx:docAuthor': REMOVE, 'epub:dc:creator': ['Solo'] }),
    );
    const bytes = await bytesOf(out);
    await checkContainer(bytes);
    const t = texts(bytes);
    expect(t['iTunesMetadata.plist']).toBeUndefined();
    expect(t['OEBPS/toc.ncx']).not.toContain('docAuthor');
    expect(t[OPF]).not.toContain('Ann Artist');
    expect(t[OPF]).not.toContain('opf:file-as');
    const m = await read(bytes);
    expect(field(m, 'epub:dc:creator')).toMatchObject({ value: ['Solo'], display: 'Solo (aut)' });
  });

  it('refuses to remove required metadata', async () => {
    const src = () => fixture('documents/book3.epub');
    await expect(epubHandler.write!(src(), edits({ 'epub:dc:title': REMOVE }))).rejects.toThrow(/required/);
    await expect(epubHandler.write!(src(), edits({ 'epub:dc:language': REMOVE }))).rejects.toThrow(/required/);
    await expect(epubHandler.write!(src(), edits({ 'epub:dc:identifier:0': REMOVE }))).rejects.toThrow(/required/);
    await expect(epubHandler.write!(src(), edits({ 'epub:meta:dcterms:modified': REMOVE }))).rejects.toThrow(/required/);
    await expect(epubHandler.write!(src(), edits({ 'epub:dc:date': 'someday' }))).rejects.toThrow(/not a valid date/);
  });

  it('removes the descriptive group but keeps required elements', async () => {
    const out = await epubHandler.write!(fixture('documents/book2.epub'), edits({ [groupKey('epub.dc')]: REMOVE }));
    const m = await read(out);
    expect(m.groups.find((g) => g.id === 'epub.dc')?.fields.map((f) => f.id)).toEqual(['epub:dc:title', 'epub:dc:language', 'epub:dc:identifier:0']);
  });

  it('applies edits to the fields they were made on after the group is removed', async () => {
    // Removing the group drops the refinements of creator and contributor, which
    // come before the collection meta and used to shift its position.
    const before = await read(fixtureBytes('documents/book3.epub'));
    const collection = allFields(before).find((f) => f.label === 'belongs-to-collection')!.id;
    const out = await epubHandler.write!(fixture('documents/book3.epub'), edits({ [groupKey('epub.dc')]: REMOVE, [collection]: REMOVE }));
    const m = await read(out);
    expect(
      allFields(m)
        .filter((f) => /^epub:meta:\d+$/.test(f.id))
        .map((f) => f.label),
    ).toEqual(['calibre:timestamp']);
    expect(texts(await bytesOf(out))[OPF]).not.toContain('Weather Tales');
  });

  it('resolves indexed fields before removing any of them', async () => {
    const f = unzipSync(fixtureBytes('documents/book3.epub'));
    const opf = strFromU8(f[OPF]).replace(
      '<dc:date>2024-05-01</dc:date>',
      '<dc:date>2024-05-01</dc:date><dc:date>2019-02-03</dc:date><dc:date>2018-04-05</dc:date>',
    );
    const out: Zippable = { mimetype: [f.mimetype, { level: 0 }] };
    for (const [k, v] of Object.entries(f)) if (k !== 'mimetype') out[k] = k === OPF ? strToU8(opf) : v;
    const dated = zipSync(out);
    expect(field(await read(dated), 'epub:dc:date:2')?.value).toBe('2018-04-05');
    const m = await read(
      await epubHandler.write!(Source.fromBytes(dated, 'b.epub'), edits({ 'epub:dc:date': REMOVE, 'epub:dc:date:1': REMOVE, 'epub:dc:date:2': '2020-06-07' })),
    );
    expect(
      allFields(m)
        .filter((x) => x.id.startsWith('epub:dc:date'))
        .map((x) => x.value),
    ).toEqual(['2020-06-07']);
  });

  for (const name of ['book2.epub', 'book3.epub']) {
    it(`strips ${name}`, async () => {
      const out = await epubHandler.strip!(fixture(`documents/${name}`), strip());
      const bytes = await bytesOf(out);
      const et = await checkContainer(bytes);
      expect(et['ZIP:ZipModifyDate']).toBe('1980:01:01 00:00:00');
      const t = texts(bytes);
      for (const [part, text] of Object.entries(t)) expect(text.includes(MARK), `${part} still contains the marker`).toBe(false);
      expect(t[OPF]).not.toMatch(/calibre:|dc:publisher|dc:creator|dc:rights/);
      const opfTags = await exiftoolPart(bytes, OPF);
      expect(etProblems(opfTags)).toEqual([]);
      expect(Object.keys(opfTags).filter((k) => /PackageMetadata(Creator|Contributor|Publisher|Rights|Date|Description|Subject)/.test(k))).toEqual([]);
      expect(opfTags['XMP-dc:PackageMetadataTitle']).toBe('The Stormy Night');
      const m = await read(bytes);
      const ids = allFields(m).map((f) => f.id);
      const v3 = name === 'book3.epub';
      expect(ids).toEqual(['epub:dc:title', 'epub:dc:language', 'epub:dc:identifier:0', ...(v3 ? ['epub:meta:dcterms:modified'] : []), 'epub:cover']);
      if (v3) {
        expect(field(m, 'epub:meta:dcterms:modified')?.value).toBe('2000-01-01T00:00:00Z');
        expect(t[OPF]).toContain('<meta property="rendition:layout">reflowable</meta>');
        expect(t[OPF]).toContain('<meta refines="#t1" property="title-type">main</meta>');
      } else {
        expect(t[OPF]).toContain('<meta name="cover" content="cover"/>');
        expect(t['OEBPS/toc.ncx']).not.toContain('dtb:generator');
        expect(t['OEBPS/toc.ncx']).toContain('dtb:uid');
      }
      expect(t['OEBPS/chapter1.xhtml']).toBe(texts(fixtureBytes(`documents/${name}`))['OEBPS/chapter1.xhtml']);
    });
  }
});

// ------------------------------------------------------ pictures and DRM

const CAMERA = fixtureBytes('jpeg/camera.jpg');
const RICH_PNG = fixtureBytes('images/rich.png');
const LOCKED = new Uint8Array(64).fill(0x5a);
const RIGHTS = `<?xml version="1.0"?><adept:rights xmlns:adept="http://ns.adobe.com/adept"><licenseToken xmlns="http://ns.adobe.com/adept"><user>urn:uuid:0b0b0b0b-1111-2222-3333-444444444444</user><resource>urn:uuid:5ec4e7aa-0042-4242-9999-000000000043</resource><operatorURL>https://acs.example/fulfillment</operatorURL></licenseToken></adept:rights>`;
const ENCRYPTION = `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="OEBPS/images/locked.jpg"/></enc:CipherData></enc:EncryptedData></encryption>`;

/** book3.epub with a cover carrying metadata, a GPS photo, a DRM-encrypted picture and an Adobe licence. */
function richerEpub(photo = CAMERA): Uint8Array {
  const f = unzipSync(fixtureBytes('documents/book3.epub'));
  const opf = strFromU8(f[OPF]).replace(
    '</manifest>',
    '<item id="photo" href="images/photo.jpg" media-type="image/jpeg"/><item id="locked" href="images/locked.jpg" media-type="image/jpeg"/></manifest>',
  );
  const out: Zippable = { mimetype: [f.mimetype, { level: 0 }] };
  for (const [k, v] of Object.entries(f)) if (k !== 'mimetype') out[k] = k === OPF ? strToU8(opf) : v;
  out['OEBPS/images/cover.png'] = RICH_PNG;
  out['OEBPS/images/photo.jpg'] = photo;
  out['OEBPS/images/locked.jpg'] = LOCKED;
  out['META-INF/rights.xml'] = strToU8(RIGHTS);
  out['META-INF/encryption.xml'] = strToU8(ENCRYPTION);
  return zipSync(out);
}

const jpegScan = (b: Uint8Array) => {
  const j = parseJpeg(b);
  return b.subarray(j.scanStart, j.scanEnd);
};

function idat(png: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [];
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let p = 8; p + 8 <= png.length; p += 12 + dv.getUint32(p)) {
    if (strFromU8(png.subarray(p + 4, p + 8), true) === 'IDAT') out.push(png.subarray(p + 8, p + 8 + dv.getUint32(p)));
  }
  return concat(out);
}

describe('epub: pictures and DRM licence', () => {
  it('lists pictures (cover included), the licence and pictures it cannot check', async () => {
    const m = await read(richerEpub());
    const media = m.groups.find((g) => g.id === 'epub.media');
    expect(media).toMatchObject({ label: 'Embedded images', removable: true });
    expect(media?.fields.map((f) => f.id)).toEqual(['epub:media:OEBPS/images/cover.png', 'epub:media:OEBPS/images/photo.jpg']);
    expect(field(m, 'epub:media:OEBPS/images/photo.jpg')?.sensitivity).toBe('location');
    expect(field(m, 'epub:media:OEBPS/images/cover.png')?.display).toMatch(/^OEBPS\/images\/cover\.png · PNG image · /);
    expect(field(m, 'epub:drm:rights')).toMatchObject({
      display: 'Adobe DRM licence for account urn:uuid:0b0b0b0b-1111-2222-3333-444444444444, issued by https://acs.example/fulfillment',
      sensitivity: 'identity',
      removable: false,
    });
    expect(m.warnings).toEqual(['1 picture is encrypted (DRM) and could not be checked for metadata.']);
  });

  it('strips the pictures, keeps their image data, the licence and encrypted files', async () => {
    const bytes = await bytesOf(await epubHandler.strip!(Source.fromBytes(richerEpub(), 'b.epub'), strip()));
    await checkContainer(bytes);
    const t = texts(bytes);
    for (const [part, text] of Object.entries(t)) expect(text.includes(MARK), `${part} still contains the marker`).toBe(false);
    const z = unzipSync(bytes);
    expect(await inspectEmbedded(z['OEBPS/images/photo.jpg'], 'photo.jpg')).toBeNull();
    expect(await inspectEmbedded(z['OEBPS/images/cover.png'], 'cover.png')).toBeNull();
    expect(equalBytes(jpegScan(z['OEBPS/images/photo.jpg']), jpegScan(CAMERA))).toBe(true);
    expect(equalBytes(idat(z['OEBPS/images/cover.png']), idat(RICH_PNG))).toBe(true);
    expect(z['OEBPS/images/locked.jpg']).toEqual(LOCKED);
    expect(t['META-INF/rights.xml']).toBe(RIGHTS);
    expect(t['META-INF/encryption.xml']).toBe(ENCRYPTION);
    const m = await read(bytes);
    expect(allFields(m).map((f) => f.id)).toEqual([
      'epub:dc:title',
      'epub:dc:language',
      'epub:dc:identifier:0',
      'epub:meta:dcterms:modified',
      'epub:cover',
      'epub:drm:rights',
    ]);
    expect(field(m, 'epub:cover')?.value as ImageValue).toMatchObject({ mime: 'image/png' });
  });

  it('cleans one picture on request and never removes the licence', async () => {
    const out = await bytesOf(
      await epubHandler.write!(Source.fromBytes(richerEpub(), 'b.epub'), edits({ 'epub:media:OEBPS/images/photo.jpg': REMOVE, 'epub:drm:rights': REMOVE })),
    );
    await checkContainer(out);
    const m = await read(out);
    expect(m.groups.find((g) => g.id === 'epub.media')?.fields.map((f) => f.id)).toEqual(['epub:media:OEBPS/images/cover.png']);
    expect(field(m, 'epub:drm:rights')).toBeDefined();
    expect(equalBytes(jpegScan(unzipSync(out)['OEBPS/images/photo.jpg']), jpegScan(CAMERA))).toBe(true);
    const all = await epubHandler.write!(Source.fromBytes(richerEpub(), 'b.epub'), edits({ [groupKey('epub.media')]: REMOVE }));
    expect((await read(all)).groups.find((g) => g.id === 'epub.media')).toBeUndefined();
  });

  it('refuses to strip when a picture cannot be cleaned, naming it', async () => {
    const bad = richerEpub(CAMERA.slice(0, 300));
    await expect(epubHandler.strip!(Source.fromBytes(bad, 'b.epub'), strip())).rejects.toThrow(/OEBPS\/images\/photo\.jpg cannot be cleaned/);
  });
});
