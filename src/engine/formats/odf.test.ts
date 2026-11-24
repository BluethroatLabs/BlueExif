import { beforeAll, describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { equalBytes } from '../core/binary';
import { Source, groupKey, type ImageValue } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { HAS_PYTHON, HAS_TEXTUTIL, exiftoolPart, pyZip, textutilText } from '../test/docOracles';
import { inspectEmbedded } from './embedded';
import { parseJpeg } from './jpeg';
import { odfHandler } from './odf';

const MARK = 'SECRET-MARKER-42';
const META_NS = 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0';
const read = (b: Uint8Array | Blob) => odfHandler.read(b instanceof Blob ? new Source(b) : Source.fromBytes(b));

function detect(rel: string): number {
  const b = fixtureBytes(rel);
  const name = rel.split('/').pop()!;
  return odfHandler.detect({ head: b.subarray(0, 65536), name, ext: name.split('.').pop()!, size: b.length });
}

function texts(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(unzipSync(bytes))) out[k] = strFromU8(v, true);
  return out;
}

const FILE_TYPE: Record<string, string> = { odt: 'ODT', ods: 'ODS', odp: 'ODP' };

describe('odf', () => {
  const baseline: Record<string, string[]> = {};
  beforeAll(async () => {
    for (const f of ['rich.odt', 'plain.odt', 'sheet.ods', 'slides.odp']) {
      baseline[f] = etProblems(await exiftool(fixtureBytes(`documents/${f}`), f));
    }
  });

  /** ExifTool identifies ODF only when `mimetype` is the first, stored entry. */
  async function checkContainer(bytes: Uint8Array, name: string) {
    const et = await exiftool(bytes, name);
    expect(et['File:FileType']).toBe(FILE_TYPE[name.split('.').pop()!]);
    expect(et['ZIP:ZipFileName']).toBe('mimetype');
    expect(et['ZIP:ZipCompression']).toBe('None');
    expect(etProblems(et).filter((p) => !baseline[name].includes(p))).toEqual([]);
    return et;
  }

  it('detects OpenDocument packages', () => {
    expect(detect('documents/rich.odt')).toBe(3);
    expect(detect('documents/plain.odt')).toBe(3);
    expect(detect('documents/sheet.ods')).toBe(3);
    expect(detect('documents/slides.odp')).toBe(3);
    expect(detect('documents/book2.epub')).toBe(0);
    expect(detect('documents/rich.docx')).toBe(0);
  });

  it('reads meta.xml, user properties, thumbnail and hidden information', async () => {
    const m = await odfHandler.read(fixture('documents/rich.odt'));
    expect(m.format).toMatchObject({ id: 'odf', name: 'OpenDocument text', mime: 'application/vnd.oasis.opendocument.text' });
    const info = Object.fromEntries(m.info.map((i) => [i.label, i.value]));
    expect(info).toMatchObject({ 'ODF version': '1.2', Pages: '1', Words: '9', Characters: '52' });
    expect(field(m, 'odf:meta:generator')?.value).toMatch(/^LibreOffice\/7\.6/);
    expect(field(m, 'odf:dc:title')?.value).toBe('Quarterly ODF report');
    expect(field(m, 'odf:meta:keyword')?.value).toEqual(['finance', 'q3']);
    expect(field(m, 'odf:meta:initial-creator')?.value).toBe(`Jane ${MARK} Doe`);
    expect(field(m, 'odf:dc:creator')?.value).toBe(`Bob ${MARK}`);
    expect(field(m, 'odf:meta:printed-by')?.value).toBe(`Printer user ${MARK}`);
    expect(field(m, 'odf:meta:creation-date')?.value).toBe('2024-05-01T10:00:00.123456789');
    expect(field(m, 'odf:dc:date')?.value).toBe('2024-05-02T11:30:00');
    expect(field(m, 'odf:meta:editing-cycles')?.value).toBe(12);
    expect(field(m, 'odf:meta:editing-duration')).toMatchObject({ value: 'PT1H2M3S', display: '1 h 2 min 3 s' });
    expect(field(m, 'odf:meta:template')?.display).toBe(`Letter — file:///home/${MARK}/Templates/Letter.ott`);
    expect(field(m, 'odf:user:Client')?.value).toBe(`Client ${MARK}`);
    expect(field(m, 'odf:user:Budget')).toMatchObject({ kind: 'number', value: 12000.5 });
    expect(field(m, 'odf:user:Approved')).toMatchObject({ kind: 'enum', value: 'true' });
    expect(field(m, 'odf:user:Due')).toMatchObject({ kind: 'datetime', value: '2024-06-01' });
    expect(field(m, 'odf:thumbnail')?.value as ImageValue).toMatchObject({ mime: 'image/png', width: 16, height: 12 });
    expect(field(m, 'odf:hidden:authors')?.display).toBe(`Editor ${MARK}, Reviewer ${MARK} — 1 comment, 1 tracked change`);
    expect(field(m, 'odf:hidden:rsid')?.display).toBe('5 rsid values');
    expect(field(m, 'odf:hidden:printer')?.display).toBe(`HP LaserJet ${MARK}`);
    const ids = allFields(m).map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(m.warnings).toEqual([]);
  });

  it('reads textutil, spreadsheet and presentation documents', async () => {
    const p = await odfHandler.read(fixture('documents/plain.odt'));
    expect(field(p, 'odf:meta:generator')?.value).toMatch(/^CocoaODFWriter/);
    expect(field(p, 'odf:meta:keyword')?.value).toEqual(['alpha', 'beta']);
    expect(field(p, 'odf:meta:initial-creator')?.value).toBe(`Jane ${MARK} Doe`);
    const s = await odfHandler.read(fixture('documents/sheet.ods'));
    expect(s.format.name).toBe('OpenDocument spreadsheet');
    expect(s.info.find((i) => i.label === 'Tables')?.value).toBe('1');
    const d = await odfHandler.read(fixture('documents/slides.odp'));
    expect(d.format.name).toBe('OpenDocument presentation');
    expect(field(d, 'odf:hidden:authors')?.display).toBe(`Presenter ${MARK} — 1 comment`);
  });

  it('edits meta and user properties, keeps mimetype first and the manifest in sync', async () => {
    const out = await odfHandler.write!(
      fixture('documents/rich.odt'),
      edits({
        'odf:dc:title': 'Annual <report> & “summary”',
        'odf:meta:keyword': ['one', 'two', 'three'],
        'odf:meta:printed-by': REMOVE,
        'odf:meta:creation-date': '2023-12-24T20:15:00+01:00',
        'odf:meta:editing-cycles': 3,
        'odf:user:Budget': 99.5,
        'odf:user:Approved': 'no',
        'odf:user:Client': REMOVE,
        'odf:user-new': 'Project=Apollo',
        'odf:meta:template': REMOVE,
        'odf:thumbnail': REMOVE,
        'odf:hidden:printer': REMOVE,
      }),
    );
    const bytes = await bytesOf(out);
    await checkContainer(bytes, 'rich.odt');
    const m = await read(bytes);
    expect(field(m, 'odf:dc:title')?.value).toBe('Annual <report> & “summary”');
    expect(field(m, 'odf:meta:keyword')?.value).toEqual(['one', 'two', 'three']);
    expect(field(m, 'odf:meta:printed-by')).toBeUndefined();
    expect(field(m, 'odf:meta:creation-date')?.value).toBe('2023-12-24T20:15:00+01:00');
    expect(field(m, 'odf:meta:editing-cycles')?.value).toBe(3);
    expect(field(m, 'odf:user:Budget')?.value).toBe(99.5);
    expect(field(m, 'odf:user:Approved')?.value).toBe('false');
    expect(field(m, 'odf:user:Client')).toBeUndefined();
    expect(field(m, 'odf:user:Project')?.value).toBe('Apollo');
    expect(field(m, 'odf:meta:template')).toBeUndefined();
    expect(field(m, 'odf:thumbnail')).toBeUndefined();
    expect(field(m, 'odf:hidden:printer')).toBeUndefined();
    expect(field(m, 'odf:dc:creator')?.value).toBe(`Bob ${MARK}`);
    const meta = await exiftoolPart(bytes, 'meta.xml');
    expect(etProblems(meta)).toEqual([]);
    expect(meta['XMP-dc:Title']).toBe('Annual <report> & “summary”');
    expect(meta['XMP-meta:Creation-date']).toBe('2023:12:24 20:15:00+01:00');
    expect(meta['XMP-meta:Editing-cycles']).toBe(3);
    expect(meta['XMP-meta:Printed-by']).toBeUndefined();
    expect(meta['XMP-meta:TemplateHref']).toBeUndefined();
    const t = texts(bytes);
    expect(t['Thumbnails/thumbnail.png']).toBeUndefined();
    expect(t['META-INF/manifest.xml']).not.toContain('Thumbnails');
    expect(t['content.xml']).toBe(texts(fixtureBytes('documents/rich.odt'))['content.xml']);
    if (HAS_PYTHON) {
      const py = pyZip(bytes, ['meta.xml']);
      expect(py.bad).toBeNull();
      expect(py.xmlErrors).toEqual({});
      expect(py.first).toEqual({ name: 'mimetype', stored: true });
      expect(py.parts['meta.xml'].filter((e) => e.tag === `{${META_NS}}keyword`).map((e) => e.text)).toEqual(['one', 'two', 'three']);
    }
    if (HAS_TEXTUTIL) expect(textutilText(bytes, 'odt')).toContain('Revenue grew strongly this quarter.');
  });

  it('validates values', async () => {
    await expect(odfHandler.write!(fixture('documents/rich.odt'), edits({ 'odf:meta:editing-duration': '2 hours' }))).rejects.toThrow(/ISO 8601/);
    await expect(odfHandler.write!(fixture('documents/rich.odt'), edits({ 'odf:user:Approved': 'maybe' }))).rejects.toThrow(/true or false/);
  });

  it('creates meta.xml (and its manifest entry) when missing', async () => {
    const out = await odfHandler.write!(fixture('documents/slides.odp'), edits({ 'odf:dc:title': 'Deck', 'odf:meta:initial-creator': 'Max' }));
    const bytes = await bytesOf(out);
    await checkContainer(bytes, 'slides.odp');
    const m = await read(bytes);
    expect(field(m, 'odf:dc:title')?.value).toBe('Deck');
    expect(field(m, 'odf:meta:initial-creator')?.value).toBe('Max');
    expect(texts(bytes)['META-INF/manifest.xml']).toContain('manifest:full-path="meta.xml"');

    const cleared = await odfHandler.write!(Source.fromBytes(bytes), edits({ [groupKey('odf.meta')]: REMOVE }));
    expect(allFields(await read(cleared)).filter((f) => /^odf:(dc|meta):/.test(f.id))).toEqual([]);
  });

  for (const name of ['rich.odt', 'plain.odt', 'sheet.ods', 'slides.odp']) {
    it(`strips ${name} completely`, async () => {
      const out = await odfHandler.strip!(fixture(`documents/${name}`), strip());
      const bytes = await bytesOf(out);
      const et = await checkContainer(bytes, name);
      expect(et['ZIP:ZipModifyDate']).toBe('1980:01:01 00:00:00');
      const t = texts(bytes);
      for (const [part, text] of Object.entries(t)) expect(text.includes(MARK), `${part} still contains the marker`).toBe(false);
      expect(t['Thumbnails/thumbnail.png']).toBeUndefined();
      if (t['meta.xml']) {
        const meta = await exiftoolPart(bytes, 'meta.xml');
        expect(etProblems(meta)).toEqual([]);
        expect(Object.keys(meta).filter((k) => /^XMP-(dc|meta):/.test(k) && !/Document-statistic/.test(k))).toEqual([]);
      }
      const m = await read(bytes);
      expect(allFields(m)).toEqual([]);
      if (HAS_PYTHON) {
        const py = pyZip(bytes);
        expect(py.bad).toBeNull();
        expect(py.xmlErrors).toEqual({});
        expect(py.first).toEqual({ name: 'mimetype', stored: true });
      }
      if (name.endsWith('.odt') && HAS_TEXTUTIL) expect(textutilText(bytes, 'odt')).toContain('Hello world, this is the body text.');
    });
  }
});

// ------------------------------------ versions, embedded objects, pictures

const CAMERA = fixtureBytes('jpeg/camera.jpg');
const OFFICE = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"';
const VERSIONS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE VL:version-list PUBLIC "-//OpenOffice.org//DTD Manifest 1.0//EN" "VersionList.dtd">
<VL:version-list xmlns:VL="http://openoffice.org/2001/versions-list" xmlns:dc="http://purl.org/dc/elements/1.1/"><VL:version-entry VL:title="Version1" VL:comment="First draft ${MARK}" VL:creator="Jane ${MARK} Doe" dc:date="2024-05-01T10:00:00"/><VL:version-entry VL:title="Version2" VL:comment="" VL:creator="Bob" dc:date="2024-05-03T09:00:00"/></VL:version-list>`;
const OBJECT_META = `<?xml version="1.0" encoding="UTF-8"?><office:document-meta ${OFFICE} xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.2"><office:meta><meta:generator>LibreOffice/7.6 ${MARK}</meta:generator><meta:initial-creator>Chart ${MARK}</meta:initial-creator><meta:document-statistic meta:object-count="1"/></office:meta></office:document-meta>`;

/** rich.odt plus a GPS photo, a version history with two stored copies and an embedded chart object. */
function richerOdt(): Uint8Array {
  const f = unzipSync(fixtureBytes('documents/rich.odt'));
  const entry = (path: string, type: string) => `<manifest:file-entry manifest:full-path="${path}" manifest:media-type="${type}"/>`;
  const manifest = strFromU8(f['META-INF/manifest.xml']).replace(
    '</manifest:manifest>',
    `${entry('Pictures/photo.jpg', 'image/jpeg')}${entry('Object 1/', 'application/vnd.oasis.opendocument.chart')}${entry('Object 1/content.xml', 'text/xml')}${entry('Object 1/meta.xml', 'text/xml')}${entry('VersionList.xml', 'text/xml')}</manifest:manifest>`,
  );
  const out: Zippable = { mimetype: [f.mimetype, { level: 0 }] };
  for (const [k, v] of Object.entries(f)) if (k !== 'mimetype') out[k] = k === 'META-INF/manifest.xml' ? strToU8(manifest) : v;
  out['Pictures/photo.jpg'] = [CAMERA, { level: 0 }];
  out['Object 1/content.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${OFFICE} office:version="1.2"><office:body><office:chart/></office:body></office:document-content>`,
  );
  out['Object 1/meta.xml'] = strToU8(OBJECT_META);
  out['VersionList.xml'] = strToU8(VERSIONS);
  out['Versions/Version1'] = [fixtureBytes('documents/plain.odt'), { level: 0 }];
  out['Versions/Version2'] = [fixtureBytes('documents/rich.odt'), { level: 0 }];
  return zipSync(out);
}

const jpegScan = (b: Uint8Array) => {
  const j = parseJpeg(b);
  return { scan: b.subarray(j.scanStart, j.scanEnd), size: [j.sof?.width, j.sof?.height] };
};

describe('odf: versions, embedded objects and pictures', () => {
  it('reads them', async () => {
    const m = await read(richerOdt());
    expect(m.warnings).toEqual([]);
    const media = m.groups.find((g) => g.id === 'odf.media');
    expect(media).toMatchObject({ label: 'Embedded images', removable: true });
    expect(media?.fields.map((f) => f.id)).toEqual(['odf:media:Pictures/photo.jpg']);
    expect(media?.fields[0]).toMatchObject({ sensitivity: 'location', removable: true });
    const versions = field(m, 'odf:versions');
    expect(versions).toMatchObject({ sensitivity: 'identity', removable: true });
    expect(versions?.display).toMatch(new RegExp(`^2 earlier versions \\(.+\\) · saved by Jane ${MARK} Doe, Bob · .+ – .+ · “First draft ${MARK}”$`));
    expect(field(m, 'odf:objects:meta')).toMatchObject({ display: 'Object 1: Generator, Author', sensitivity: 'identity' });
  });

  it('strips them, keeping the picture data and the object', async () => {
    const bytes = await bytesOf(await odfHandler.strip!(Source.fromBytes(richerOdt(), 'r.odt'), strip()));
    const et = await exiftool(bytes, 'r.odt');
    expect(et['File:FileType']).toBe('ODT');
    expect(et['ZIP:ZipFileName']).toBe('mimetype');
    const t = texts(bytes);
    for (const [part, text] of Object.entries(t)) expect(text.includes(MARK), `${part} still contains the marker`).toBe(false);
    expect(Object.keys(t).filter((k) => /Version/.test(k))).toEqual([]);
    expect(t['META-INF/manifest.xml']).not.toContain('Version');
    expect(t['Object 1/meta.xml']).not.toMatch(/initial-creator|generator/);
    expect(t['Object 1/meta.xml']).toContain('<meta:document-statistic meta:object-count="1"/>');
    expect(t['META-INF/manifest.xml']).toContain('manifest:full-path="Object 1/meta.xml"');
    expect(t['META-INF/manifest.xml']).toContain('manifest:full-path="Pictures/photo.jpg"');
    const pic = unzipSync(bytes)['Pictures/photo.jpg'];
    expect(await inspectEmbedded(pic, 'photo.jpg')).toBeNull();
    const before = jpegScan(CAMERA);
    const after = jpegScan(pic);
    expect(after.size).toEqual(before.size);
    expect(equalBytes(after.scan, before.scan)).toBe(true);
    expect(allFields(await read(bytes))).toEqual([]);
    if (HAS_PYTHON) {
      const py = pyZip(bytes);
      expect(py.bad).toBeNull();
      expect(py.xmlErrors).toEqual({});
      expect(py.first).toEqual({ name: 'mimetype', stored: true });
    }
    if (HAS_TEXTUTIL) expect(textutilText(bytes, 'odt')).toContain('Revenue grew strongly this quarter.');
  });

  it('removes each on request', async () => {
    const src = () => Source.fromBytes(richerOdt(), 'r.odt');
    const v = await bytesOf(await odfHandler.write!(src(), edits({ 'odf:versions': REMOVE })));
    const mv = await read(v);
    expect(field(mv, 'odf:versions')).toBeUndefined();
    expect(field(mv, 'odf:objects:meta')).toBeDefined();
    expect(Object.keys(texts(v)).filter((k) => /Version/.test(k))).toEqual([]);

    const o = await bytesOf(await odfHandler.write!(src(), edits({ 'odf:objects:meta': REMOVE, [groupKey('odf.media')]: REMOVE })));
    const mo = await read(o);
    expect(field(mo, 'odf:objects:meta')).toBeUndefined();
    expect(mo.groups.find((g) => g.id === 'odf.media')).toBeUndefined();
    expect(field(mo, 'odf:versions')).toBeDefined();
    expect(field(mo, 'odf:meta:initial-creator')?.value).toBe(`Jane ${MARK} Doe`);
  });

  it('refuses to strip when a picture cannot be cleaned, naming it', async () => {
    const f = unzipSync(richerOdt());
    const out: Zippable = { mimetype: [f.mimetype, { level: 0 }] };
    for (const [k, v] of Object.entries(f)) if (k !== 'mimetype') out[k] = k === 'Pictures/photo.jpg' ? CAMERA.slice(0, 300) : v;
    await expect(odfHandler.strip!(Source.fromBytes(zipSync(out), 'b.odt'), strip())).rejects.toThrow(/Pictures\/photo\.jpg cannot be cleaned/);
  });
});
