import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate';
import { concat, encodeUtf16, equalBytes } from '../core/binary';
import { Source, groupKey, type ImageValue } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { HAS_PYTHON, HAS_TEXTUTIL, exiftoolPart, pyText, pyZip, textutilText } from '../test/docOracles';
import { inspectEmbedded } from './embedded';
import { parseJpeg } from './jpeg';
import { ooxmlHandler } from './ooxml';

const MARK = 'SECRET-MARKER-42';
const CP = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
const DC = 'http://purl.org/dc/elements/1.1/';
const DCTERMS = 'http://purl.org/dc/terms/';
const APP = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';

const read = (b: Uint8Array | Blob) => ooxmlHandler.read(b instanceof Blob ? new Source(b) : Source.fromBytes(b));

function detect(rel: string): number {
  const b = fixtureBytes(rel);
  const name = rel.split('/').pop()!;
  return ooxmlHandler.detect({ head: b.subarray(0, 65536), name, ext: name.split('.').pop()!, size: b.length });
}

/** Every entry decompressed as text. */
function texts(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(unzipSync(bytes))) out[k] = strFromU8(v, true);
  return out;
}

/** ExifTool (WASM) has no Archive::Zip: it can only check the ZIP container. */
async function zipProblems(bytes: Uint8Array | Blob, name: string): Promise<string[]> {
  return etProblems(await exiftool(bytes, name)).filter((p) => !/Archive::Zip/.test(p));
}

describe('ooxml', () => {
  it('detects Word, Excel and PowerPoint packages', () => {
    expect(detect('documents/rich.docx')).toBe(3);
    expect(detect('documents/plain.docx')).toBe(3);
    expect(detect('documents/book.xlsx')).toBe(3);
    expect(detect('documents/deck.pptx')).toBe(3);
    expect(detect('documents/rich.odt')).toBe(0);
    expect(ooxmlHandler.detect({ head: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), name: 'x.docx', ext: 'docx', size: 4 })).toBe(1);
  });

  it('reads core, app, custom properties, thumbnail and hidden personal info of a docx', async () => {
    const m = await ooxmlHandler.read(fixture('documents/rich.docx'));
    expect(m.format.name).toBe('Word document');
    expect(m.format.mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(field(m, 'ooxml:core:dc:title')?.value).toBe('Quarterly Word report');
    expect(field(m, 'ooxml:core:dc:creator')?.value).toBe(`Jane ${MARK} Doe`);
    expect(field(m, 'ooxml:core:dc:description')?.value).toBe('Internal draft & notes');
    expect(field(m, 'ooxml:core:cp:lastModifiedBy')?.value).toBe(`Bob ${MARK}`);
    expect(field(m, 'ooxml:core:cp:revision')?.value).toBe('7');
    expect(field(m, 'ooxml:core:dcterms:created')?.value).toBe('2024-05-01T10:00:00Z');
    expect(field(m, 'ooxml:core:cp:lastPrinted')?.kind).toBe('datetime');
    expect(field(m, 'ooxml:core:dc:identifier')?.value).toBe(`DOC-${MARK}`);
    expect(field(m, 'ooxml:app:Company')?.value).toBe(`Acme ${MARK} Inc`);
    expect(field(m, 'ooxml:app:Template')?.value).toBe('Normal.dotm');
    expect(field(m, 'ooxml:app:TotalTime')?.value).toBe(42);
    expect(field(m, 'ooxml:app:HyperlinkBase')?.value).toBe(`https://intranet.example/${MARK}/`);
    const info = Object.fromEntries(m.info.map((i) => [i.label, i.value]));
    expect(info.Words).toBe('12');
    expect(info.Pages).toBe('1');
    expect(field(m, 'ooxml:custom:Client')?.value).toBe(`Client ${MARK}`);
    expect(field(m, 'ooxml:custom:Budget')).toMatchObject({ kind: 'integer', value: 12000 });
    expect(field(m, 'ooxml:custom:Approved')).toMatchObject({ kind: 'enum', value: 'true' });
    expect(field(m, 'ooxml:custom:Due')).toMatchObject({ kind: 'datetime', value: '2024-06-01T00:00:00Z' });
    expect(field(m, 'ooxml:custom:Rate')).toMatchObject({ kind: 'number', value: 0.25 });
    const thumb = field(m, 'ooxml:thumbnail')?.value as ImageValue;
    expect(thumb).toMatchObject({ mime: 'image/png', width: 16, height: 12 });
    expect(field(m, 'ooxml:hidden:authors')?.display).toBe(`Editor ${MARK}, Reviewer ${MARK} — 1 comment, 2 tracked changes`);
    expect(field(m, 'ooxml:hidden:rsid')?.display).toBe('2 revision session ids + document id');
    expect(field(m, 'ooxml:hidden:template')?.display).toBe(`file:///C:\\Users\\${MARK}\\AppData\\Roaming\\Microsoft\\Templates\\Normal.dotm`);
    expect(field(m, 'ooxml:part:docProps/meta.xml')?.display).toMatch(/^CocoaOOXMLWriter/);
    const ids = allFields(m).map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(m.warnings).toEqual([]);
  });

  it('reads textutil, Excel and PowerPoint packages', async () => {
    const plain = await ooxmlHandler.read(fixture('documents/plain.docx'));
    expect(field(plain, 'ooxml:core:dc:title')?.value).toBe('Plain textutil document');
    expect(field(plain, 'ooxml:core:cp:keywords')?.value).toBe('alpha, beta');
    expect(field(plain, 'ooxml:app:Company')?.value).toBe(`Acme ${MARK} Inc`);

    const x = await ooxmlHandler.read(fixture('documents/book.xlsx'));
    expect(x.format.name).toBe('Excel workbook');
    expect(x.info.find((i) => i.label === 'Titles of parts')?.value).toBe('Sheet1');
    expect(field(x, 'ooxml:hidden:authors')?.display).toBe(`Owner ${MARK}, Reviewer ${MARK} — 1 comment`);
    expect(field(x, 'ooxml:hidden:abspath')?.display).toBe(`C:\\Users\\${MARK}\\Documents\\`);

    const p = await ooxmlHandler.read(fixture('documents/deck.pptx'));
    expect(p.format.name).toBe('PowerPoint presentation');
    expect(p.info.find((i) => i.label === 'Slides')?.value).toBe('1');
    expect(field(p, 'ooxml:hidden:authors')?.display).toBe(`Presenter ${MARK} — 1 comment`);
  });

  it('edits core, app and custom properties and removes parts', async () => {
    const out = await ooxmlHandler.write!(
      fixture('documents/rich.docx'),
      edits({
        'ooxml:core:dc:title': 'Annual <report> & “summary”',
        'ooxml:core:dc:creator': 'Zoë Smith',
        'ooxml:core:cp:keywords': REMOVE,
        'ooxml:core:dcterms:created': '2023-12-24T20:15:00+01:00',
        'ooxml:app:Company': 'New Co',
        'ooxml:app:Manager': REMOVE,
        'ooxml:app:TotalTime': 5,
        'ooxml:custom:Budget': 99,
        'ooxml:custom:Approved': 'no',
        'ooxml:custom:Client': REMOVE,
        'ooxml:custom-new': 'Project=Apollo',
        'ooxml:thumbnail': REMOVE,
        'ooxml:hidden:template': REMOVE,
      }),
    );
    const bytes = await bytesOf(out);
    expect(await zipProblems(bytes, 'out.docx')).toEqual([]);
    const m = await read(bytes);
    expect(field(m, 'ooxml:core:dc:title')?.value).toBe('Annual <report> & “summary”');
    expect(field(m, 'ooxml:core:dc:creator')?.value).toBe('Zoë Smith');
    expect(field(m, 'ooxml:core:cp:keywords')).toBeUndefined();
    expect(field(m, 'ooxml:core:dcterms:created')?.value).toBe('2023-12-24T19:15:00Z');
    expect(field(m, 'ooxml:app:Company')?.value).toBe('New Co');
    expect(field(m, 'ooxml:app:Manager')).toBeUndefined();
    expect(field(m, 'ooxml:app:TotalTime')?.value).toBe(5);
    expect(field(m, 'ooxml:custom:Budget')?.value).toBe(99);
    expect(field(m, 'ooxml:custom:Approved')?.value).toBe('false');
    expect(field(m, 'ooxml:custom:Client')).toBeUndefined();
    expect(field(m, 'ooxml:custom:Project')?.value).toBe('Apollo');
    expect(field(m, 'ooxml:thumbnail')).toBeUndefined();
    expect(field(m, 'ooxml:hidden:template')).toBeUndefined();
    expect(field(m, 'ooxml:hidden:authors')).toBeDefined();

    // ExifTool reading the property parts
    const core = await exiftoolPart(bytes, 'docProps/core.xml');
    expect(etProblems(core)).toEqual([]);
    expect(core['XMP-cp:CorePropertiesTitle']).toBe('Annual <report> & “summary”');
    expect(core['XMP-cp:CorePropertiesCreator']).toBe('Zoë Smith');
    expect(core['XMP-cp:CorePropertiesKeywords']).toBeUndefined();
    expect(core['XMP-cp:CorePropertiesCreated']).toBe('2023:12:24 19:15:00Z');
    expect(core['XMP-cp:CorePropertiesCreatedType']).toBe('dcterms:W3CDTF');
    const app = await exiftoolPart(bytes, 'docProps/app.xml');
    expect(etProblems(app)).toEqual([]);
    expect(app['XMP:PropertiesCompany']).toBe('New Co');
    expect(app['XMP:PropertiesManager']).toBeUndefined();
    expect(app['XMP:PropertiesTotalTime']).toBe(5);
    const custom = await exiftoolPart(bytes, 'docProps/custom.xml');
    expect(etProblems(custom)).toEqual([]);
    expect(custom['XMP-vt:PropertiesPropertyI4']).toBe(99);

    const t = texts(bytes);
    expect(t['docProps/thumbnail.png']).toBeUndefined();
    expect(t['_rels/.rels']).not.toContain('thumbnail');
    expect(t['word/_rels/settings.xml.rels']).not.toContain('attachedTemplate');
    expect(t['word/settings.xml']).not.toContain('attachedTemplate');
    expect(t['word/document.xml']).toBe(texts(fixtureBytes('documents/rich.docx'))['word/document.xml']);

    if (HAS_PYTHON) {
      const py = pyZip(bytes, ['docProps/core.xml', 'docProps/custom.xml']);
      expect(py.bad).toBeNull();
      expect(py.xmlErrors).toEqual({});
      expect(pyText(py, 'docProps/core.xml', `{${DC}}title`)).toBe('Annual <report> & “summary”');
      const created = py.parts['docProps/core.xml'].find((e) => e.tag === `{${DCTERMS}}created`);
      expect(created?.text).toBe('2023-12-24T19:15:00Z');
      expect(created?.attrib[`{${XSI}}type`]).toBe('dcterms:W3CDTF');
      const props = py.parts['docProps/custom.xml'].filter((e) => e.tag.endsWith('}property'));
      expect(props.map((p) => p.attrib.name)).toEqual(['Budget', 'Approved', 'Due', 'Rate', 'Project']);
      expect(new Set(props.map((p) => p.attrib.pid)).size).toBe(5);
    }
    if (HAS_TEXTUTIL) expect(textutilText(bytes, 'docx')).toContain('Revenue grew strongly this quarter.');
  });

  it('adds core and custom properties to a package without them', async () => {
    const out = await ooxmlHandler.write!(
      fixture('documents/plain.docx'),
      edits({ 'ooxml:core:cp:category': 'Letters', 'ooxml:custom-new': 'Reviewed=yes', 'ooxml:app:Manager': 'Max' }),
    );
    const bytes = await bytesOf(out);
    const m = await read(bytes);
    expect(field(m, 'ooxml:core:cp:category')?.value).toBe('Letters');
    expect(field(m, 'ooxml:custom:Reviewed')?.value).toBe('yes');
    expect(field(m, 'ooxml:app:Manager')?.value).toBe('Max');
    const t = texts(bytes);
    expect(t['[Content_Types].xml']).toContain(
      'PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"',
    );
    expect(t['_rels/.rels']).toMatch(
      /Type="http:\/\/schemas.openxmlformats.org\/officeDocument\/2006\/relationships\/custom-properties" Target="docProps\/custom.xml"/,
    );
    if (HAS_PYTHON) {
      const py = pyZip(bytes, ['docProps/core.xml']);
      expect(py.xmlErrors).toEqual({});
      expect(pyText(py, 'docProps/core.xml', `{${CP}}category`)).toBe('Letters');
      expect(py.names.at(-1)).toBe('docProps/custom.xml');
    }
    if (HAS_TEXTUTIL) expect(textutilText(bytes, 'docx')).toContain('Hello world');

    const removed = await ooxmlHandler.write!(Source.fromBytes(bytes), edits({ [groupKey('ooxml.custom')]: REMOVE }));
    const t2 = texts(await bytesOf(removed));
    expect(t2['docProps/custom.xml']).toBeUndefined();
    expect(t2['[Content_Types].xml']).not.toContain('custom.xml');
    expect(t2['_rels/.rels']).not.toContain('custom.xml');
  });

  it('creates app.xml (with relationship and content type) when adding app properties', async () => {
    const plain = texts(fixtureBytes('documents/plain.docx'));
    // build a package without app.xml from the textutil document
    const { zipSync, strToU8 } = await import('fflate');
    const files: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(plain)) {
      if (k === 'docProps/app.xml') continue;
      files[k] = strToU8(
        k === '_rels/.rels'
          ? v.replace(/<Relationship[^>]*extended-properties[^>]*\/>/, '')
          : k === '[Content_Types].xml'
            ? v.replace(/<Override PartName="\/docProps\/app.xml"[^>]*\/>/, '')
            : v,
      );
    }
    const noApp = zipSync(files);
    expect((await read(noApp)).groups.find((g) => g.id === 'ooxml.app')?.fields).toEqual([]);
    const out = await ooxmlHandler.write!(Source.fromBytes(noApp), edits({ 'ooxml:app:Company': 'Added Co' }));
    const bytes = await bytesOf(out);
    expect(field(await read(bytes), 'ooxml:app:Company')?.value).toBe('Added Co');
    const t = texts(bytes);
    expect(t['[Content_Types].xml']).toContain('PartName="/docProps/app.xml"');
    expect(t['_rels/.rels']).toContain('Target="docProps/app.xml"');
  });

  it('anonymises comment and revision authors on request', async () => {
    const out = await ooxmlHandler.write!(fixture('documents/rich.docx'), edits({ 'ooxml:hidden:authors': REMOVE, 'ooxml:hidden:rsid': REMOVE }));
    const t = texts(await bytesOf(out));
    expect(t['word/document.xml']).toContain('w:author="Author"');
    expect(t['word/document.xml']).not.toMatch(/w:rsid|w:date=/);
    expect(t['word/comments.xml']).toContain('w:author="Author"');
    expect(t['word/comments.xml']).not.toContain('w:initials');
    expect(t['word/people.xml']).not.toContain('presenceInfo');
    expect(t['word/settings.xml']).not.toMatch(/rsid|docId/);
    const m = await read(out);
    expect(field(m, 'ooxml:hidden:authors')?.display).toBe('Author — 1 comment, 2 tracked changes');
    expect(field(m, 'ooxml:hidden:rsid')).toBeUndefined();
  });

  for (const name of ['rich.docx', 'book.xlsx', 'deck.pptx', 'plain.docx']) {
    it(`strips ${name} completely`, async () => {
      const src = fixture(`documents/${name}`);
      const out = await ooxmlHandler.strip!(src, strip());
      const bytes = await bytesOf(out);
      expect(await zipProblems(bytes, name)).toEqual([]);
      const t = texts(bytes);
      for (const [part, text] of Object.entries(t)) expect(text.includes(MARK), `${part} still contains the marker`).toBe(false);
      expect(t['docProps/custom.xml']).toBeUndefined();
      expect(t['docProps/thumbnail.png']).toBeUndefined();
      expect(t['docProps/meta.xml']).toBeUndefined();
      expect(t['[Content_Types].xml']).not.toMatch(/custom\.xml|meta\.xml/);
      for (const [part, text] of Object.entries(t)) {
        if (part.endsWith('.rels')) expect(text).not.toMatch(/custom\.xml|thumbnail|meta\.xml|attachedTemplate/);
      }
      const core = await exiftoolPart(bytes, 'docProps/core.xml');
      expect(etProblems(core)).toEqual([]);
      expect(Object.keys(core).filter((k) => /CoreProperties\w/.test(k))).toEqual([]);
      const app = await exiftoolPart(bytes, 'docProps/app.xml');
      expect(Object.keys(app).filter((k) => /Properties(Company|Manager|Template|TotalTime|Application|AppVersion|HyperlinkBase)$/.test(k))).toEqual([]);
      const m = await read(bytes);
      const left = allFields(m).map((f) => f.id);
      expect(left.filter((id) => !id.startsWith('ooxml:hidden:authors'))).toEqual([]);
      if (left.length) expect(field(m, 'ooxml:hidden:authors')?.display).toMatch(/^Author/);
      if (HAS_PYTHON) {
        const py = pyZip(bytes, ['docProps/core.xml', 'docProps/app.xml']);
        expect(py.bad).toBeNull();
        expect(py.xmlErrors).toEqual({});
        expect(py.parts['docProps/core.xml'].length).toBe(1);
        expect(py.parts['docProps/app.xml'].map((e) => e.tag.replace(`{${APP}}`, ''))).not.toContain('Company');
      }
      // timestamps normalised
      const z = unzipSync(bytes);
      expect(Object.keys(z).length).toBeGreaterThan(3);
      if (name.endsWith('docx') && HAS_TEXTUTIL) expect(textutilText(bytes, 'docx')).toContain('Hello world');
    });
  }

  it('normalises ZIP timestamps on strip', async () => {
    const out = await ooxmlHandler.strip!(fixture('documents/rich.docx'), strip());
    const et = await exiftool(out, 's.docx');
    expect(et['ZIP:ZipModifyDate']).toBe('1980:01:01 00:00:00');
  });

  it('rejects password-protected (OLE) Office files with a friendly error', async () => {
    const ole = new Uint8Array(512);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await expect(ooxmlHandler.read(Source.fromBytes(ole, 'x.docx'))).rejects.toThrow(/password protected/);
  });
});

describe('ooxml: hostile parts', () => {
  it('refuses deeply nested XML with a clear error, not a stack overflow', async () => {
    const parts = unzipSync(fixtureBytes('documents/plain.docx'));
    const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    parts['word/document.xml'] = strToU8(`<w:document ${w}><w:body>${'<w:p>'.repeat(200_000)}${'</w:p>'.repeat(200_000)}</w:body></w:document>`);
    const deep = Source.fromBytes(zipSync(parts), 'deep.docx');
    await expect(ooxmlHandler.read(deep)).rejects.toThrow(/nested more than 512 levels deep/);
    await expect(ooxmlHandler.strip!(deep, strip())).rejects.toThrow(/nested more than 512 levels deep/);
  });
});

// ------------------------------------------------- hidden parts, pictures

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CAMERA = fixtureBytes('jpeg/camera.jpg');
const RICH_PNG = fixtureBytes('images/rich.png');

const addRels = (xml: string, rels: string) => xml.replace('</Relationships>', `${rels}</Relationships>`);
const addTypes = (xml: string, types: string) => xml.replace('</Types>', `${types}</Types>`);
const relsXml = (rels: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;

/** A Windows DEVMODE with `name` as dmDeviceName. */
function devmode(name: string): Uint8Array {
  const out = new Uint8Array(220);
  out.set(encodeUtf16(name, true));
  return out;
}

const itemProps = (id: string, uri: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="no"?><ds:datastoreItem ds:itemID="{${id}}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml"><ds:schemaRefs><ds:schemaRef ds:uri="${uri}"/></ds:schemaRefs></ds:datastoreItem>`;
const SP_PROPS = `<?xml version="1.0"?><p:properties xmlns:p="http://schemas.microsoft.com/office/2006/metadata/properties" xmlns:pc="http://schemas.microsoft.com/office/infopath/2007/PartnerControls"><documentManagement><Owner xmlns="0ab1"><UserInfo><DisplayName>Owner ${MARK}</DisplayName><AccountId>12</AccountId><AccountType/></UserInfo></Owner></documentManagement></p:properties>`;
const SP_SCHEMA = `<?xml version="1.0"?><ct:contentTypeSchema ct:_="" ma:_="" ma:contentTypeName="Document" ma:contentTypeID="0x0101" ma:contentTypeDescription="Site ${MARK}" xmlns:ct="http://schemas.microsoft.com/office/2006/metadata/contentType" xmlns:ma="http://schemas.microsoft.com/office/2006/metadata/properties/metaAttributes"><xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="http://schemas.microsoft.com/office/2006/metadata/properties"/></ct:contentTypeSchema>`;
const BIBLIO = `<?xml version="1.0" standalone="no"?><b:Sources SelectedStyle="\\APA.xsl" StyleName="APA" xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography" xmlns="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"></b:Sources>`;
const PROPS_CT = 'application/vnd.openxmlformats-officedocument.customXmlProperties+xml';

/** rich.docx plus a GPS photo, SharePoint customXml, a bibliography, printer settings, local links, docVars and HLinks. */
function richerDocx(extra: Record<string, Uint8Array> = {}): Uint8Array {
  const f: Record<string, Uint8Array> = unzipSync(fixtureBytes('documents/rich.docx'));
  const text = (k: string) => strFromU8(f[k], true);
  f['word/media/image1.jpeg'] = CAMERA;
  f['word/printerSettings/printerSettings1.bin'] = devmode(`HP LaserJet ${MARK}`);
  const items: Array<[string, string]> = [
    [SP_PROPS, 'http://schemas.microsoft.com/office/2006/metadata/properties'],
    [BIBLIO, 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography'],
    [SP_SCHEMA, 'http://schemas.microsoft.com/office/2006/metadata/contentType'],
  ];
  let docRels = '';
  let types = `<Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.printerSettings"/>`;
  items.forEach(([xml, uri], i) => {
    const n = i + 1;
    f[`customXml/item${n}.xml`] = strToU8(xml);
    f[`customXml/itemProps${n}.xml`] = strToU8(itemProps(`1111111${n}-0000-0000-0000-000000000000`, uri));
    f[`customXml/_rels/item${n}.xml.rels`] = strToU8(relsXml(`<Relationship Id="rId1" Type="${REL_NS}/customXmlProps" Target="itemProps${n}.xml"/>`));
    docRels += `<Relationship Id="rIdC${n}" Type="${REL_NS}/customXml" Target="../customXml/item${n}.xml"/>`;
    types += `<Override PartName="/customXml/itemProps${n}.xml" ContentType="${PROPS_CT}"/>`;
  });
  docRels +=
    `<Relationship Id="rIdImg" Type="${REL_NS}/image" Target="media/image1.jpeg"/>` +
    `<Relationship Id="rIdPrn" Type="${REL_NS}/printerSettings" Target="printerSettings/printerSettings1.bin"/>` +
    `<Relationship Id="rIdL1" Type="${REL_NS}/hyperlink" Target="file:///C:/Users/${MARK}/Budget%20Q1.xlsx" TargetMode="External"/>` +
    `<Relationship Id="rIdL2" Type="${REL_NS}/hyperlink" Target="\\\\fileserver\\${MARK}\\Plan.docx" TargetMode="External"/>` +
    `<Relationship Id="rIdL3" Type="${REL_NS}/hyperlink" Target="https://example.com/page" TargetMode="External"/>`;
  for (const [k, v] of Object.entries(extra)) f[k] = v;
  f['word/_rels/document.xml.rels'] = strToU8(addRels(text('word/_rels/document.xml.rels'), docRels));
  f['[Content_Types].xml'] = strToU8(addTypes(text('[Content_Types].xml'), types));
  f['word/settings.xml'] = strToU8(
    text('word/settings.xml').replace('<w:rsids>', `<w:docVars><w:docVar w:name="ClientId" w:val="Client ${MARK}"/></w:docVars><w:rsids>`),
  );
  const hlinks = `<HLinks><vt:vector size="6" baseType="variant"><vt:variant><vt:i4>1</vt:i4></vt:variant><vt:variant><vt:i4>0</vt:i4></vt:variant><vt:variant><vt:i4>0</vt:i4></vt:variant><vt:variant><vt:i4>5</vt:i4></vt:variant><vt:variant><vt:lpwstr>file:///C:/Users/${MARK}/Budget%20Q1.xlsx</vt:lpwstr></vt:variant><vt:variant><vt:lpwstr></vt:lpwstr></vt:variant></vt:vector></HLinks>`;
  f['docProps/app.xml'] = strToU8(text('docProps/app.xml').replace('</Properties>', `${hlinks}</Properties>`));
  return zipSync(f);
}

const scanData = (b: Uint8Array) => {
  const j = parseJpeg(b);
  return { scan: b.subarray(j.scanStart, j.scanEnd), width: j.sof?.width, height: j.sof?.height };
};

/** Concatenated IDAT payloads of a PNG. */
function idat(png: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [];
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  for (let p = 8; p + 8 <= png.length; p += 12 + dv.getUint32(p)) {
    if (strFromU8(png.subarray(p + 4, p + 8), true) === 'IDAT') out.push(png.subarray(p + 8, p + 8 + dv.getUint32(p)));
  }
  return concat(out);
}

describe('ooxml: hidden parts and embedded pictures', () => {
  it('reads pictures, server properties, printer, local links, document variables and the hyperlink list', async () => {
    const m = await read(richerDocx());
    expect(m.warnings).toEqual([]);
    const media = m.groups.find((g) => g.id === 'ooxml.media');
    expect(media).toMatchObject({ label: 'Embedded images', removable: true });
    expect(media?.fields.map((f) => f.id)).toEqual(['ooxml:media:word/media/image1.jpeg']);
    expect(media?.fields[0]).toMatchObject({ sensitivity: 'location', removable: true, label: 'image1.jpeg' });
    expect(media?.fields[0].display).toMatch(/^word\/media\/image1\.jpeg · JPEG image · location, people, device/);
    const server = field(m, 'ooxml:hidden:server');
    expect(server).toMatchObject({ sensitivity: 'identity', removable: true });
    expect(server?.display).toBe(`document-management properties (Owner ${MARK} 12), content type`);
    expect(field(m, 'ooxml:hidden:printer')).toMatchObject({ display: `HP LaserJet ${MARK}`, sensitivity: 'device' });
    expect(field(m, 'ooxml:hidden:links')).toMatchObject({
      display: `file:///C:/Users/${MARK}/Budget%20Q1.xlsx, \\\\fileserver\\${MARK}\\Plan.docx`,
      sensitivity: 'identity',
    });
    expect(field(m, 'ooxml:hidden:docvars')?.display).toBe('1 variable: ClientId');
    expect(field(m, 'ooxml:app:HLinks')).toMatchObject({ display: `file:///C:/Users/${MARK}/Budget%20Q1.xlsx`, sensitivity: 'identity' });
    // the template keeps its own field
    expect(field(m, 'ooxml:hidden:template')).toBeDefined();
  });

  it('strips them all, keeping other custom XML and the picture data', async () => {
    const out = await ooxmlHandler.strip!(Source.fromBytes(richerDocx(), 'r.docx'), strip());
    const bytes = await bytesOf(out);
    expect(await zipProblems(bytes, 'r.docx')).toEqual([]);
    const t = texts(bytes);
    for (const [part, text] of Object.entries(t)) expect(text.includes(MARK), `${part} still contains the marker`).toBe(false);
    // picture: metadata gone, scan data and size unchanged
    const pic = unzipSync(bytes)['word/media/image1.jpeg'];
    expect(t['word/media/image1.jpeg']).not.toMatch(/F2LXK1234567|Golden Gate|Jane Doe/);
    expect(await inspectEmbedded(pic, 'image1.jpeg')).toBeNull();
    const before = scanData(CAMERA);
    const after = scanData(pic);
    expect([after.width, after.height]).toEqual([before.width, before.height]);
    expect(equalBytes(after.scan, before.scan)).toBe(true);
    // SharePoint parts gone with props, rels and content types; the bibliography stays
    for (const n of [1, 3]) {
      expect(t[`customXml/item${n}.xml`]).toBeUndefined();
      expect(t[`customXml/itemProps${n}.xml`]).toBeUndefined();
      expect(t[`customXml/_rels/item${n}.xml.rels`]).toBeUndefined();
      expect(t['[Content_Types].xml']).not.toContain(`itemProps${n}.xml`);
      expect(t['word/_rels/document.xml.rels']).not.toContain(`item${n}.xml`);
    }
    expect(t['customXml/item2.xml']).toBe(BIBLIO);
    expect(t['customXml/itemProps2.xml']).toBeDefined();
    expect(t['[Content_Types].xml']).toContain('itemProps2.xml');
    expect(t['word/_rels/document.xml.rels']).toContain('Target="../customXml/item2.xml"');
    // printer settings with relationship and content type
    expect(t['word/printerSettings/printerSettings1.bin']).toBeUndefined();
    expect(t['word/_rels/document.xml.rels']).not.toContain('printerSettings');
    expect(t['[Content_Types].xml']).not.toContain('printerSettings');
    // local links reduced to file names, web links untouched
    expect(t['word/_rels/document.xml.rels']).toContain(
      'Id="rIdL1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="Budget%20Q1.xlsx" TargetMode="External"',
    );
    expect(t['word/_rels/document.xml.rels']).toContain('Target="Plan.docx"');
    expect(t['word/_rels/document.xml.rels']).toContain('Target="https://example.com/page"');
    expect(t['word/_rels/document.xml.rels']).toContain('Target="media/image1.jpeg"');
    expect(t['word/settings.xml']).not.toContain('docVar');
    expect(t['docProps/app.xml']).not.toMatch(/HLinks|HyperlinkBase/);
    const m = await read(bytes);
    expect(
      allFields(m)
        .map((f) => f.id)
        .filter((id) => id !== 'ooxml:hidden:authors'),
    ).toEqual([]);
    if (HAS_PYTHON) {
      const py = pyZip(bytes, ['word/_rels/document.xml.rels', 'word/settings.xml', '[Content_Types].xml']);
      expect(py.bad).toBeNull();
      expect(py.xmlErrors).toEqual({});
    }
    if (HAS_TEXTUTIL) expect(textutilText(bytes, 'docx')).toContain('Revenue grew strongly this quarter.');
  });

  it('removes each item on request', async () => {
    const src = () => Source.fromBytes(richerDocx(), 'r.docx');
    const pic = await bytesOf(await ooxmlHandler.write!(src(), edits({ 'ooxml:media:word/media/image1.jpeg': REMOVE })));
    const m1 = await read(pic);
    expect(m1.groups.find((g) => g.id === 'ooxml.media')).toBeUndefined();
    expect(field(m1, 'ooxml:hidden:server')).toBeDefined();
    expect(equalBytes(scanData(unzipSync(pic)['word/media/image1.jpeg']).scan, scanData(CAMERA).scan)).toBe(true);
    const group = await ooxmlHandler.write!(src(), edits({ [groupKey('ooxml.media')]: REMOVE }));
    expect((await read(group)).groups.find((g) => g.id === 'ooxml.media')).toBeUndefined();

    const out = await bytesOf(
      await ooxmlHandler.write!(
        src(),
        edits({
          'ooxml:hidden:server': REMOVE,
          'ooxml:hidden:printer': REMOVE,
          'ooxml:hidden:links': REMOVE,
          'ooxml:hidden:docvars': REMOVE,
          'ooxml:app:HLinks': REMOVE,
        }),
      ),
    );
    const m = await read(out);
    for (const id of ['ooxml:hidden:server', 'ooxml:hidden:printer', 'ooxml:hidden:links', 'ooxml:hidden:docvars', 'ooxml:app:HLinks'])
      expect(field(m, id), id).toBeUndefined();
    expect(field(m, 'ooxml:media:word/media/image1.jpeg')).toBeDefined();
    expect(field(m, 'ooxml:hidden:template')).toBeDefined();
    const t = texts(out);
    expect(t['customXml/item2.xml']).toBe(BIBLIO);
    expect(t['customXml/item1.xml']).toBeUndefined();
    expect(t['word/_rels/document.xml.rels']).toContain('Target="Plan.docx"');
  });

  it('refuses to strip when a picture cannot be cleaned, naming it', async () => {
    const bad = richerDocx({ 'word/media/bad.jpeg': CAMERA.slice(0, 300) });
    await expect(ooxmlHandler.strip!(Source.fromBytes(bad, 'b.docx'), strip())).rejects.toThrow(/word\/media\/bad\.jpeg cannot be cleaned/);
  });

  it('anonymises the author run of Excel notes, unlinks printer settings from sheets and cleans xl/media', async () => {
    const f: Record<string, Uint8Array> = unzipSync(fixtureBytes('documents/book.xlsx'));
    const text = (k: string) => strFromU8(f[k], true);
    f['xl/comments1.xml'] = strToU8(
      text('xl/comments1.xml').replace(
        '<text><r><t>Check this number</t></r></text>',
        `<text><r><rPr><b/><sz val="9"/></rPr><t>Reviewer ${MARK}:</t></r><r><rPr><sz val="9"/></rPr><t xml:space="preserve">\nCheck this number</t></r></text>`,
      ),
    );
    f['xl/printerSettings/printerSettings1.bin'] = devmode(`Office printer ${MARK}`);
    f['xl/media/image1.png'] = RICH_PNG;
    f['xl/worksheets/sheet1.xml'] = strToU8(
      text('xl/worksheets/sheet1.xml').replace('<legacyDrawing', '<pageSetup orientation="landscape" r:id="rId3"/><legacyDrawing'),
    );
    f['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8(
      addRels(
        text('xl/worksheets/_rels/sheet1.xml.rels'),
        `<Relationship Id="rId3" Type="${REL_NS}/printerSettings" Target="../printerSettings/printerSettings1.bin"/>`,
      ),
    );
    f['[Content_Types].xml'] = strToU8(
      addTypes(
        text('[Content_Types].xml'),
        '<Default Extension="png" ContentType="image/png"/><Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/>',
      ),
    );
    const book = zipSync(f);
    const m = await read(book);
    expect(field(m, 'ooxml:hidden:printer')?.display).toBe(`Office printer ${MARK}`);
    expect(field(m, 'ooxml:media:xl/media/image1.png')?.sensitivity).toBeDefined();

    const anon = texts(await bytesOf(await ooxmlHandler.write!(Source.fromBytes(book), edits({ 'ooxml:hidden:authors': REMOVE }))));
    expect(anon['xl/comments1.xml']).toContain('<t>Author:</t>');
    expect(anon['xl/comments1.xml']).not.toContain(MARK);

    const bytes = await bytesOf(await ooxmlHandler.strip!(Source.fromBytes(book, 'b.xlsx'), strip()));
    expect(await zipProblems(bytes, 'b.xlsx')).toEqual([]);
    const t = texts(bytes);
    for (const [part, s] of Object.entries(t)) expect(s.includes(MARK), `${part} still contains the marker`).toBe(false);
    expect(t['xl/comments1.xml']).toContain('<t>Author:</t></r><r><rPr><sz val="9"/></rPr><t xml:space="preserve">\nCheck this number</t>');
    expect(t['xl/printerSettings/printerSettings1.bin']).toBeUndefined();
    expect(t['xl/worksheets/sheet1.xml']).toContain('<pageSetup orientation="landscape"/><legacyDrawing r:id="rId2"/>');
    expect(t['xl/worksheets/_rels/sheet1.xml.rels']).not.toContain('printerSettings');
    expect(t['[Content_Types].xml']).not.toContain('printerSettings');
    const png = unzipSync(bytes)['xl/media/image1.png'];
    expect(await inspectEmbedded(png, 'image1.png')).toBeNull();
    expect(equalBytes(idat(png), idat(RICH_PNG))).toBe(true);
    expect(
      allFields(await read(bytes))
        .map((x) => x.id)
        .filter((id) => id !== 'ooxml:hidden:authors'),
    ).toEqual([]);
  });

  it('scans Visio comment authors', async () => {
    const vsdx = zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/><Override PartName="/visio/comments.xml" ContentType="application/vnd.ms-visio.comments+xml"/></Types>',
      ),
      '_rels/.rels': strToU8(relsXml(`<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="visio/document.xml"/>`)),
      'visio/document.xml': strToU8('<?xml version="1.0" encoding="utf-8"?><VisioDocument xmlns="http://schemas.microsoft.com/office/visio/2012/main"/>'),
      'visio/_rels/document.xml.rels': strToU8(
        relsXml('<Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/comments" Target="comments.xml"/>'),
      ),
      'visio/comments.xml': strToU8(
        `<?xml version="1.0" encoding="utf-8"?><Comments xmlns="http://schemas.microsoft.com/office/visio/2012/main"><AuthorList><AuthorEntry ID="0" Name="Jane ${MARK}" Initials="JS" ResolutionID="jane@${MARK}.example"/></AuthorList><CommentList><CommentEntry AuthorID="0" PageID="0" ShapeID="1" Date="2024-05-01T10:00:00" EditDate="2024-05-02T10:00:00">Move this box</CommentEntry></CommentList></Comments>`,
      ),
    });
    const m = await read(vsdx);
    expect(m.format.name).toBe('Visio drawing');
    expect(field(m, 'ooxml:hidden:authors')?.display).toBe(`Jane ${MARK} — 1 comment`);
    const t = texts(await bytesOf(await ooxmlHandler.strip!(Source.fromBytes(vsdx, 'd.vsdx'), strip())));
    expect(t['visio/comments.xml']).toContain('<AuthorEntry ID="0" Name="Author" Initials="A"/>');
    expect(t['visio/comments.xml']).toContain('<CommentEntry AuthorID="0" PageID="0" ShapeID="1" Date="1970-01-01T00:00:00">Move this box</CommentEntry>');
    expect(t['visio/comments.xml']).not.toContain(MARK);
  });

  it('warns that binary workbooks are not fully scanned', async () => {
    const xlsb = zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/vnd.ms-excel.sheetBinaryMacroEnabled.main"/><Override PartName="/xl/workbook.bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>',
      ),
      '_rels/.rels': strToU8(relsXml(`<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.bin"/>`)),
      'xl/workbook.bin': new Uint8Array(16),
    });
    const m = await read(xlsb);
    expect(m.format.name).toBe('Excel binary workbook');
    expect(m.warnings.join(' ')).toMatch(/binary parts BlueExif cannot read/);
    const stripped = await read(await ooxmlHandler.strip!(Source.fromBytes(xlsb, 'b.xlsb'), strip()));
    expect(stripped.warnings.join(' ')).toMatch(/binary parts BlueExif cannot read/);
  });
});
