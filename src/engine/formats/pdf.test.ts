import { beforeAll, describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFString, StandardFonts, decodePDFRawStream, type PDFObject, type PDFPage } from 'pdf-lib';
import { Source, groupKey, type DetectContext, type Metadata } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etMetaKeys, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { HAS_QLMANAGE, HAS_SWIFT, pdfKitPages, preparePdfKit, qlRender } from '../test/docOracles';
import { formatPdfDate, parsePdfDate, pdfHandler } from './pdf';

const MARK = 'SECRET-MARKER-42';
const XMP_TITLE = 'xmp:http://purl.org/dc/elements/1.1/|title';
const XMP_CREATOR = 'xmp:http://purl.org/dc/elements/1.1/|creator';

function detectCtx(rel: string): DetectContext {
  const b = fixtureBytes(rel);
  const name = rel.split('/').pop()!;
  return { head: b.subarray(0, 65536), name, ext: name.split('.').pop()!, size: b.length };
}

/** Raw bytes plus every decoded stream, so compressed leftovers are found too. */
async function pdfAllText(bytes: Uint8Array): Promise<string> {
  let s = Buffer.from(bytes).toString('latin1');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const [, o] of doc.context.enumerateIndirectObjects()) {
    if (o instanceof PDFRawStream) {
      try {
        s += Buffer.from(decodePDFRawStream(o).decode()).toString('latin1');
      } catch {
        /* undecodable image data */
      }
    }
  }
  return s;
}

const read = async (b: Blob | Uint8Array) => pdfHandler.read(b instanceof Blob ? new Source(b) : Source.fromBytes(b));

describe('pdf dates', () => {
  it('parses and formats PDF date strings', () => {
    expect(parsePdfDate("D:20240501103000+02'00'")).toEqual({ year: 2024, month: 5, day: 1, hour: 10, minute: 30, second: 0, tz: 120 });
    expect(parsePdfDate('D:20240502110000Z')?.tz).toBe(0);
    expect(parsePdfDate("D:20240502110000Z00'00'")?.tz).toBe(0);
    expect(parsePdfDate("D:20240502110000-05'30")?.tz).toBe(-330);
    expect(parsePdfDate('D:2024')).toEqual({ year: 2024 });
    expect(parsePdfDate('garbage')).toBeNull();
    expect(formatPdfDate({ year: 2023, month: 12, day: 24, hour: 20, minute: 15, second: 0, tz: 60 })).toBe("D:20231224201500+01'00'");
    expect(formatPdfDate({ year: 2023, month: 12, day: 24, hour: 20, minute: 15, tz: 0 })).toBe('D:20231224201500Z');
    expect(formatPdfDate({ year: 2023, month: 12, day: 24 })).toBe('D:20231224');
  });
});

describe('pdf', () => {
  let baseline: string[] = [];
  beforeAll(async () => {
    // ExifTool already warns about the page-level XMP packet in the fixture.
    baseline = etProblems(await exiftool(fixtureBytes('documents/report.pdf'), 'report.pdf'));
    if (HAS_SWIFT) preparePdfKit();
  }, 300_000);

  it('detects PDFs', () => {
    expect(pdfHandler.detect(detectCtx('documents/report.pdf'))).toBe(3);
    expect(pdfHandler.detect({ head: new Uint8Array(4), name: 'x.pdf', ext: 'pdf', size: 4 })).toBe(1);
    expect(pdfHandler.detect({ head: new Uint8Array(4), name: 'x.txt', ext: 'txt', size: 4 })).toBe(0);
  });

  it('reads Info, XMP, technical info and privacy extras', async () => {
    const m = await pdfHandler.read(fixture('documents/report.pdf'));
    expect(m.format.id).toBe('pdf');
    const info = Object.fromEntries(m.info.map((i) => [i.label, i.value]));
    expect(info.Pages).toBe('2');
    expect(info['Page size']).toMatch(/^595 × 842 pt \(A4/);
    expect(info['PDF/A']).toBe('PDF/A-2b');
    expect(info['Form fields']).toBe('1');
    expect(field(m, 'pdf:Title')?.value).toBe('Quarterly Report');
    expect(field(m, 'pdf:Author')?.value).toBe(`Jane ${MARK} Doe`);
    expect(field(m, 'pdf:Creator')?.value).toBe('Microsoft® Word for Microsoft 365');
    expect(field(m, 'pdf:CreationDate')?.value).toBe('2024-05-01T10:30:00+02:00');
    expect(field(m, 'pdf:ModDate')?.value).toBe('2024-05-02T11:00:00Z');
    expect(field(m, 'pdf:Trapped')?.value).toBe('False');
    expect(field(m, 'pdf:Company')?.value).toBe(`Acme ${MARK} Inc`);
    expect(field(m, 'pdf:SourceModified')?.kind).toBe('datetime');
    expect(field(m, 'pdf:SourceModified')?.value).toBe('2024-05-01T08:30:00');
    expect(field(m, XMP_TITLE)?.value).toBe('Quarterly Report');
    expect(field(m, XMP_CREATOR)?.value).toEqual([`Jane ${MARK} Doe`]);
    expect(field(m, 'pdfdoc:attachments')?.display).toBe('notes.txt (33 B)');
    expect(field(m, 'pdfdoc:annotations')?.display).toBe(`Reviewer ${MARK} (1), Bob Example (1)`);
    expect(field(m, 'pdfdoc:pieceinfo')?.display).toMatch(/^Illustrator — .* on 1 object$/);
    expect(field(m, 'pdfdoc:object-xmp')?.display).toBe('1 on page');
    expect(field(m, 'pdfdoc:id')?.display).toBe('5EC4E7AA42424242DEADBEEF00112233'.toLowerCase());
    expect(field(m, 'pdfdoc:revisions')?.display).toMatch(/^1 incremental update/);
    // every field id is unique and addable specs are not present fields
    const ids = allFields(m).map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const addable = m.groups.find((g) => g.id === 'pdf.info')!.addable!.map((a) => a.id);
    expect(addable).toEqual(['pdf-custom:new']);
    expect(m.warnings).toEqual([]);
  });

  it('reads a Quartz PDF (keywords array) and an object-stream PDF', async () => {
    const q = await pdfHandler.read(fixture('documents/quartz.pdf'));
    expect(field(q, 'pdf:Producer')?.value).toMatch(/Quartz PDFContext/);
    expect(field(q, 'pdf:Author')?.value).toBe(`Quartz Author ${MARK}`);
    expect(field(q, 'pdf:Keywords')?.value).toBe('alpha, beta');
    expect(q.info.find((i) => i.label === 'Page size')?.value).toMatch(/Letter/);
    const o = await pdfHandler.read(fixture('documents/objstm.pdf'));
    expect(field(o, 'pdf:Title')?.value).toBe('Object streams');
    expect(field(o, XMP_TITLE)?.value).toBe('Object streams');
  });

  it('asks for a password for encrypted PDFs', async () => {
    await expect(pdfHandler.read(fixture('documents/encrypted.pdf'))).rejects.toMatchObject({
      name: 'MetadataError',
      code: 'password-required',
    });
    await expect(pdfHandler.strip!(fixture('documents/encrypted.pdf'), strip())).rejects.toMatchObject({ name: 'MetadataError' });
  });

  it('edits Info with XMP kept in sync and flattens earlier revisions', async () => {
    const out = await pdfHandler.write!(
      fixture('documents/report.pdf'),
      edits({
        'pdf:Title': 'Annual Report',
        'pdf:Author': 'Zoë Smith; Max Mustermann',
        'pdf:Subject': 'Zürich — 東京 (draft) \\ test',
        'pdf:Company': REMOVE,
        'pdf:CreationDate': '2023-12-24T20:15:00+01:00',
        'pdf:Trapped': 'True',
        'pdf-custom:new': 'Project=Apollo (1)',
        'pdfdoc:annotations': REMOVE,
      }),
    );
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'out.pdf');
    expect(etProblems(et).filter((p) => !baseline.includes(p))).toEqual([]);
    expect(et['PDF:Title']).toBe('Annual Report');
    expect(et['XMP-dc:Title']).toBe('Annual Report');
    expect(et['PDF:Author']).toBe('Zoë Smith; Max Mustermann');
    expect(et['XMP-dc:Creator']).toEqual(['Zoë Smith', 'Max Mustermann']);
    expect(et['PDF:Subject']).toBe('Zürich — 東京 (draft) \\ test');
    expect(et['XMP-dc:Description']).toBe('Zürich — 東京 (draft) \\ test');
    expect(et['PDF:CreateDate']).toBe('2023:12:24 20:15:00+01:00');
    expect(et['XMP-xmp:CreateDate']).toBe('2023:12:24 20:15:00+01:00');
    expect(et['PDF:Trapped']).toBe(true);
    expect(et['PDF:Project']).toBe('Apollo (1)');
    expect(et['PDF:Company']).toBeUndefined();
    expect(et['PDF:Producer']).toBe('Acme PDF Engine 1.0');
    expect(et['XMP-pdfaid:Part']).toBe(2);

    const all = await pdfAllText(bytes);
    expect(all).not.toContain('OLD-REVISION-TITLE');
    expect(all).not.toContain(`Reviewer ${MARK}`);
    expect(all).toContain('/T <FEFF006E0061006D0065>'); // form field "name" survives

    const m = await read(bytes);
    expect(field(m, 'pdf:Title')?.value).toBe('Annual Report');
    expect(field(m, 'pdf:Subject')?.value).toBe('Zürich — 東京 (draft) \\ test');
    expect(field(m, 'pdf:CreationDate')?.value).toBe('2023-12-24T20:15:00+01:00');
    expect(field(m, 'pdf:Project')?.value).toBe('Apollo (1)');
    expect(field(m, 'pdfdoc:revisions')).toBeUndefined();
    expect(field(m, 'pdfdoc:annotations')).toBeUndefined();
    expect(field(m, 'pdfdoc:attachments')).toBeDefined();
    if (HAS_SWIFT) expect(pdfKitPages(bytes)).toBe(2);
  });

  it('propagates XMP edits to Info and removes groups', async () => {
    const out = await pdfHandler.write!(fixture('documents/report.pdf'), edits({ [XMP_TITLE]: 'From XMP', [XMP_CREATOR]: ['A', 'B'] }));
    const et = await exiftool(out, 'out.pdf');
    expect(et['PDF:Title']).toBe('From XMP');
    expect(et['PDF:Author']).toBe('A; B');

    const out2 = await pdfHandler.write!(fixture('documents/report.pdf'), edits({ [groupKey('pdf.info')]: REMOVE, [groupKey('xmp')]: REMOVE }));
    const et2 = await exiftool(out2, 'out.pdf');
    expect(etProblems(et2).filter((p) => !baseline.includes(p))).toEqual([]);
    expect(Object.keys(et2).filter((k) => /^(PDF:(Title|Author|Producer)|XMP-dc:Title|XMP-pdf)/.test(k))).toEqual([]);
    // only the page-level packet (a separate field) is left
    expect(et2['XMP-dc:Creator']).toBe(`Page author ${MARK}`);
    if (HAS_SWIFT) expect(pdfKitPages(await bytesOf(out2))).toBe(2);
  });

  it('adds Info to an object-stream PDF and removes extras', async () => {
    const out = await pdfHandler.write!(
      fixture('documents/objstm.pdf'),
      edits({
        'pdf:Title': 'Renamed',
        'pdfdoc:attachments': REMOVE,
        'pdfdoc:pieceinfo': REMOVE,
        'pdfdoc:object-xmp': REMOVE,
        'pdfdoc:id': REMOVE,
      }),
    );
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'o.pdf');
    expect(etProblems(et)).toEqual([]);
    expect(et['PDF:Title']).toBe('Renamed');
    const m = await read(bytes);
    expect(m.groups.find((g) => g.id === 'pdf.other')?.fields.map((f) => f.id) ?? []).toEqual(['pdfdoc:annotations']);
    expect(await pdfAllText(bytes)).not.toContain('AI private data');
    if (HAS_SWIFT) expect(pdfKitPages(bytes)).toBe(2);
  });

  it('strips everything identifying while keeping pages, forms and PDF/A identification', async () => {
    const out = await pdfHandler.strip!(fixture('documents/report.pdf'), strip());
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 's.pdf');
    expect(etProblems(et)).toEqual([]);
    expect(etMetaKeys(et).sort()).toEqual(['PDF:HasXFA', 'PDF:Linearized', 'PDF:PDFVersion', 'PDF:PageCount', 'XMP-pdfaid:Conformance', 'XMP-pdfaid:Part']);
    const all = await pdfAllText(bytes);
    expect(all).not.toContain(MARK);
    expect(all).not.toContain('OLD-REVISION-TITLE');
    expect(all).not.toContain('Bob Example');
    expect(all).not.toContain('5EC4E7AA42424242');
    expect(all).toContain('/T <FEFF006E0061006D0065>'); // form field "name" survives
    expect(all).toContain('Meeting notes: totals look fine.');

    const m = await read(bytes);
    expect(allFields(m).map((f) => f.id).sort()).toEqual([
      'pdfdoc:attachments',
      'pdfdoc:id',
      'xmp:http://www.aiim.org/pdfa/ns/id/|conformance',
      'xmp:http://www.aiim.org/pdfa/ns/id/|part',
    ]);
    expect(m.info.find((i) => i.label === 'Pages')?.value).toBe('2');
    if (HAS_SWIFT) expect(pdfKitPages(bytes)).toBe(2);
    // QuickLook renders the first page identically
    if (HAS_QLMANAGE) expect(Buffer.from(qlRender(bytes, 'pdf')).equals(Buffer.from(qlRender(fixtureBytes('documents/report.pdf'), 'pdf')))).toBe(true);
  });

  it('strips a Quartz PDF', async () => {
    const out = await pdfHandler.strip!(fixture('documents/quartz.pdf'), strip());
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'q.pdf');
    expect(etProblems(et)).toEqual([]);
    expect(Object.keys(et).filter((k) => k.startsWith('PDF:') && !/PDFVersion|Linearized|PageCount|MediaBox|HasXFA/.test(k))).toEqual([]);
    expect(await pdfAllText(bytes)).not.toContain(MARK);
    if (HAS_SWIFT) expect(pdfKitPages(bytes)).toBe(1);
  });
});

// ------------------------------------------- signatures, scripts, actions

const hexOf = (t: string) => Buffer.from(t).toString('hex');

/** DER element (definite length). */
function tlv(tag: number, ...parts: Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
}
const seq = (...p: Uint8Array[]) => tlv(0x30, ...p);
const set = (...p: Uint8Array[]) => tlv(0x31, ...p);
const oid = (hex: string) => tlv(0x06, Buffer.from(hex, 'hex'));
const int = (hex: string) => tlv(0x02, Buffer.from(hex, 'hex'));
const utf8 = (t: string) => tlv(0x0c, Buffer.from(t, 'utf8'));
const dn = (...attrs: Array<[string, Buffer]>) => seq(...attrs.map(([o, v]) => set(seq(oid(o), v))));
const RSA_SHA256 = seq(oid('2a864886f70d01010b'), tlv(0x05));
const SHA256 = seq(oid('608648016503040201'));

function cert(serial: string, issuer: Buffer, subject: Buffer): Buffer {
  const validity = seq(tlv(0x17, Buffer.from('240101000000Z')), tlv(0x17, Buffer.from('340101000000Z')));
  const key = seq(seq(oid('2a864886f70d010101'), tlv(0x05)), tlv(0x03, Buffer.from([0, 1, 2, 3])));
  return seq(seq(tlv(0xa0, int('02')), int(serial), RSA_SHA256, issuer, validity, subject, key), RSA_SHA256, tlv(0x03, Buffer.from([0, 9, 9])));
}

const CA = dn(['550403', utf8('Example Root CA')]);
const SIGNER = dn(['550403', utf8(`Alice ${MARK}`)], ['55040a', utf8('Acme GmbH')], ['2a864886f70d010901', tlv(0x16, Buffer.from('alice@example.com'))]);
const SIGNER_CERT = cert('2a', CA, SIGNER);
/** PKCS#7 SignedData: the CA certificate comes first, the SignerInfo names the signer's by serial number. */
const PKCS7 = seq(
  oid('2a864886f70d010702'),
  tlv(0xa0, seq(int('01'), set(SHA256), seq(oid('2a864886f70d010701')), tlv(0xa0, cert('01', CA, CA), SIGNER_CERT), set(seq(int('01'), seq(CA, int('2a')), SHA256, RSA_SHA256, tlv(0x04, Buffer.from('sig')))))),
);

/**
 * Two pages with a signed signature field (+ /Perms, /DSS), document JavaScript, a JavaScript open action
 * chained to a GoTo, catalog/page/field additional actions, links (Launch, GoToR, file: URI, JavaScript, web,
 * internal) and files associated with a page and an annotation. Kept content (field value, attachments, web
 * link) carries no marker.
 */
async function activePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([400, 400]);
  const p2 = doc.addPage([400, 400]);
  p1.drawText('Signed contract', { x: 20, y: 350, size: 18, font });
  p2.drawText('Second page', { x: 20, y: 350, size: 18, font });
  const fit = (p: PDFPage) => ctx.obj([p.ref, 'Fit']);
  const js = (code: string, extra: Record<string, PDFObject> = {}) => ctx.obj({ S: 'JavaScript', JS: PDFString.of(code), ...extra });

  const form = doc.getForm();
  const amount = form.createTextField('amount');
  amount.setText('42.00');
  amount.addToPage(p2, { x: 20, y: 200, width: 100, height: 20, font });
  amount.acroField.dict.set(PDFName.of('AA'), ctx.obj({ K: js('AFNumber_Keystroke(2)'), F: js(`AFNumber_Format(2) // ${MARK}`) }));

  const sig = ctx.register(
    ctx.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'adbe.pkcs7.detached',
      ByteRange: [0, 0, 0, 0],
      Contents: PDFHexString.of(PKCS7.toString('hex') + '0'.repeat(512)),
      Name: PDFString.of(`Alice ${MARK}`),
      M: PDFString.of("D:20240601120000+02'00'"),
      Location: PDFString.of(`Berlin ${MARK}`),
      Reason: PDFString.of(`Approved ${MARK}`),
      ContactInfo: PDFString.of(`alice-${MARK}@example.com`),
      Prop_Build: { App: { Name: `SignerApp-${MARK}` } },
    }),
  );
  const ap = ctx.register(ctx.stream('0 0 1 rg 0 0 120 30 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 120, 30] }));
  const widget = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature1'), V: sig, F: 4, Rect: [20, 20, 140, 50], P: p1.ref, AP: { N: ap } }),
  );
  form.acroForm.addField(widget);
  form.acroForm.dict.set(PDFName.of('SigFlags'), ctx.obj(3));
  doc.catalog.set(PDFName.of('Perms'), ctx.obj({ DocMDP: sig }));
  doc.catalog.set(
    PDFName.of('DSS'),
    ctx.obj({
      Certs: [ctx.register(ctx.flateStream(SIGNER_CERT))],
      OCSPs: [ctx.register(ctx.flateStream(`OCSP response for ${MARK}`))],
      CRLs: [ctx.register(ctx.flateStream('CRL'))],
    }),
  );

  const embedded = (name: string, text: string, path = name) =>
    ctx.register(
      ctx.obj({
        Type: 'Filespec',
        F: PDFString.of(path),
        UF: PDFHexString.fromText(name),
        AFRelationship: 'Data',
        EF: { F: ctx.register(ctx.flateStream(text, { Type: 'EmbeddedFile', Params: { Size: text.length, ModDate: PDFString.of('D:20240601120000Z') } })) },
      }),
    );
  p1.node.set(PDFName.of('AF'), ctx.obj([embedded('page-data.csv', 'page data 1,2,3\n', '/Users/alice/exports/page-data.csv')]));

  const annot = (nmKey: string, extra: Record<string, PDFObject>) =>
    ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', NM: PDFString.of(nmKey), Rect: [20, 100, 60, 120], Border: [0, 0, 0], ...extra }));
  const annots = [
    widget,
    annot('launch', {
      A: ctx.obj({
        S: 'Launch',
        F: { Type: 'Filespec', F: PDFString.of('file:///Users/alice/secret.pdf'), UF: PDFHexString.fromText('/Users/alice/secret.pdf') },
        Win: { F: PDFHexString.fromText('C:\\Users\\alice\\secret.pdf'), D: PDFHexString.fromText('C:\\Users\\alice') },
      }),
    }),
    annot('gotor', { A: ctx.obj({ S: 'GoToR', F: PDFString.of('/C/Users/alice/Documents/other.pdf'), D: [0, 'Fit'] }) }),
    annot('file-uri', { A: ctx.obj({ S: 'URI', URI: PDFString.of('file:///home/alice/notes.txt') }) }),
    annot('script', { A: js(`app.launchURL("https://tracker.example/${MARK}")`) }),
    annot('web', { A: ctx.obj({ S: 'URI', URI: PDFString.of('https://example.com/terms') }) }),
    annot('internal', { A: ctx.obj({ S: 'GoTo', D: fit(p2) }) }),
    annot('square', { Subtype: PDFName.of('Square'), AF: ctx.obj([embedded('annot-note.txt', 'annotation file\n')]) }),
  ];
  p1.node.set(PDFName.of('Annots'), ctx.obj(annots));
  p1.node.set(PDFName.of('AA'), ctx.obj({ O: js(`console.println("${MARK}")`), C: { S: 'URI', URI: PDFString.of('https://tracker.example/close') } }));

  const util = ctx.register(ctx.obj({ S: 'JavaScript', JS: ctx.register(ctx.flateStream(`function owner() { return "${MARK}"; }`)) }));
  doc.catalog.set(PDFName.of('Names'), ctx.obj({ JavaScript: { Names: [PDFString.of('init'), ctx.register(js(`var who = "${MARK}";`)), PDFString.of('util'), util] } }));
  doc.catalog.set(PDFName.of('OpenAction'), js(`app.alert("${MARK}")`, { Next: ctx.obj({ S: 'GoTo', D: fit(p2) }) }));
  doc.catalog.set(PDFName.of('AA'), ctx.obj({ WC: js(`app.alert("bye ${MARK}")`) }));
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: true });
}

const shown = (m: Metadata, id: string) => {
  const f = field(m, id);
  return f && (f.kind === 'raw' ? f.display : f.value);
};

/** Resolve `keys` from `o` through references. */
function dig(doc: PDFDocument, o: unknown, ...keys: string[]): unknown {
  let cur = o instanceof PDFRef ? doc.context.lookup(o) : o;
  for (const k of keys) {
    if (!(cur instanceof PDFDict)) return undefined;
    cur = cur.get(PDFName.of(k));
    if (cur instanceof PDFRef) cur = doc.context.lookup(cur);
  }
  return cur;
}

const str = (o: unknown) => (o instanceof PDFString || o instanceof PDFHexString || o instanceof PDFName ? o.decodeText() : undefined);

/** The links of page 1 by their /NM, and the signature widget. */
function page1(doc: PDFDocument) {
  const annots = (doc.getPages()[0].node.Annots()?.asArray() ?? []).map((r) => doc.context.lookup(r) as PDFDict);
  const byName = Object.fromEntries(annots.filter((a) => a.has(PDFName.of('NM'))).map((a) => [str(a.get(PDFName.of('NM'))), a]));
  return { byName, widget: annots.find((a) => str(a.get(PDFName.of('FT'))) === 'Sig') };
}

describe('pdf active content', () => {
  let input: Uint8Array;
  beforeAll(async () => {
    input = await activePdf();
    if (HAS_SWIFT) preparePdfKit();
  }, 300_000);

  it('reads signatures, scripts, local file links and associated files', async () => {
    expect(Buffer.from(input).toString('latin1').toLowerCase()).toContain(hexOf(MARK)); // inside the hex /Contents
    const m = await read(input);
    expect(m.info.find((i) => i.label === 'Digital signatures')?.value).toBe('1');
    expect(m.warnings).toEqual([expect.stringMatching(/digitally signed/)]);
    const sig = m.groups.find((g) => g.id === 'pdf.signatures')!;
    expect(sig.removable).toBe(true);
    expect(sig.fields.map((f) => [f.id, f.sensitivity, f.editable, f.removable])).toEqual([
      ['pdfsig:1:Name', 'identity', false, true],
      ['pdfsig:1:M', 'time', false, true],
      ['pdfsig:1:Location', 'location', false, true],
      ['pdfsig:1:Reason', 'content', false, true],
      ['pdfsig:1:ContactInfo', 'identity', false, true],
      ['pdfsig:1:cert', 'identity', false, true],
      ['pdfsig:dss', 'identity', false, true],
      ['pdfsig:perms', 'software', false, true],
    ]);
    expect(shown(m, 'pdfsig:1:Name')).toBe(`Alice ${MARK}`);
    expect(shown(m, 'pdfsig:1:M')).toBe('2024-06-01T12:00:00+02:00');
    expect(shown(m, 'pdfsig:1:Location')).toBe(`Berlin ${MARK}`);
    expect(shown(m, 'pdfsig:1:Reason')).toBe(`Approved ${MARK}`);
    expect(shown(m, 'pdfsig:1:ContactInfo')).toBe(`alice-${MARK}@example.com`);
    // the signer's certificate (not the CA's, which comes first), and the blob without its zero padding
    expect(shown(m, 'pdfsig:1:cert')).toBe(`Alice ${MARK} <alice@example.com>, Acme GmbH — adbe.pkcs7.detached (${PKCS7.length} B)`);
    expect(shown(m, 'pdfsig:dss')).toBe('1 certificate, 1 OCSP response, 1 revocation list');
    expect(shown(m, 'pdfsig:perms')).toBe('DocMDP');

    const js = field(m, 'pdfdoc:javascript')!;
    expect(js.sensitivity).toBe('content');
    // open action + script link; catalog WC, page O and C, field K and F
    expect(js.display).toMatch(/^2 document scripts \(init, util\), 2 script actions, 5 automatic actions — \d+ B of JavaScript$/);
    const links = field(m, 'pdfdoc:file-links')!;
    expect(links.sensitivity).toBe('identity');
    expect(links.display!.split(', ').sort()).toEqual([
      '/C/Users/alice/Documents/other.pdf (GoToR)',
      '/Users/alice/secret.pdf (Launch)',
      'C:\\Users\\alice (Launch)',
      'C:\\Users\\alice\\secret.pdf (Launch)',
      'file:///Users/alice/secret.pdf (Launch)',
      'file:///home/alice/notes.txt (URI)',
    ]);
    expect(field(m, 'pdfdoc:attachments')?.display).toBe('page-data.csv (16 B), annot-note.txt (16 B)');
    const ids = allFields(m).map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('strips signature values, validation data, scripts and folder paths but keeps pages, links, forms and files', async () => {
    const out = await bytesOf(await pdfHandler.strip!(Source.fromBytes(input), strip()));
    const et = await exiftool(out, 'active.pdf');
    expect(etProblems(et)).toEqual([]);
    expect(et['PDF:PageCount']).toBe(2);
    const all = await pdfAllText(out);
    expect(all).not.toContain(MARK);
    expect(all.toLowerCase()).not.toContain(hexOf(MARK));
    expect(all).not.toMatch(/alice|tracker\.example|SignerApp/i);
    expect(all.toLowerCase()).not.toContain(Buffer.from('alice', 'utf16le').swap16().toString('hex'));
    expect(all).toContain('page data 1,2,3');
    expect(all).toContain('annotation file');

    const doc = await PDFDocument.load(out, { updateMetadata: false });
    const cat = doc.catalog;
    for (const k of ['Perms', 'DSS', 'AA', 'Names']) expect(cat.has(PDFName.of(k)), k).toBe(false);
    // the JavaScript open action is gone, the GoTo it was chained to takes its place
    expect(str(dig(doc, cat, 'OpenAction', 'S'))).toBe('GoTo');
    expect(dig(doc, cat, 'OpenAction', 'Next')).toBeUndefined();
    const { byName, widget } = page1(doc);
    // the signature field stays, unsigned, with its appearance
    expect(str(widget?.get(PDFName.of('FT')))).toBe('Sig');
    expect(widget?.has(PDFName.of('V'))).toBe(false);
    expect(dig(doc, widget, 'AP', 'N')).toBeInstanceOf(PDFRawStream);
    expect(dig(doc, cat, 'AcroForm', 'SigFlags')).toBeUndefined();
    // local paths become file names, web and internal links are untouched
    expect(str(dig(doc, byName.launch, 'A', 'F', 'F'))).toBe('secret.pdf');
    expect(str(dig(doc, byName.launch, 'A', 'F', 'UF'))).toBe('secret.pdf');
    expect(str(dig(doc, byName.launch, 'A', 'Win', 'F'))).toBe('secret.pdf');
    expect(dig(doc, byName.launch, 'A', 'Win', 'D')).toBeUndefined();
    expect(str(dig(doc, byName.gotor, 'A', 'F'))).toBe('other.pdf');
    expect(str(dig(doc, byName['file-uri'], 'A', 'URI'))).toBe('notes.txt');
    expect(str(dig(doc, byName.web, 'A', 'URI'))).toBe('https://example.com/terms');
    expect(str(dig(doc, byName.internal, 'A', 'S'))).toBe('GoTo');
    expect(byName.script.has(PDFName.of('A'))).toBe(false);
    expect(doc.getPages()[0].node.has(PDFName.of('AA'))).toBe(false);
    // the form keeps its value but loses its scripts
    const amount = doc.getForm().getTextField('amount');
    expect(amount.getText()).toBe('42.00');
    expect(amount.acroField.dict.has(PDFName.of('AA'))).toBe(false);
    // associated files are content: kept, without dates and folders
    const spec = dig(doc, doc.getPages()[0].node.get(PDFName.of('AF')));
    expect(spec).toBeInstanceOf(PDFArray);
    expect(str(dig(doc, (spec as PDFArray).get(0), 'F'))).toBe('page-data.csv');
    expect(dig(doc, (spec as PDFArray).get(0), 'EF', 'F')).toBeInstanceOf(PDFRawStream);
    expect(all).not.toContain('D:20240601120000Z');

    const m = await read(out);
    expect(allFields(m).map((f) => f.id).sort()).toEqual(['pdfdoc:attachments', 'pdfdoc:id']);
    expect(m.warnings).toEqual([]);
    expect(m.info.find((i) => i.label === 'Form fields')?.value).toBe('2');
    if (HAS_SWIFT) expect(pdfKitPages(out)).toBe(2);
    if (HAS_QLMANAGE) expect(Buffer.from(qlRender(out, 'pdf')).equals(Buffer.from(qlRender(input, 'pdf')))).toBe(true);
  });

  it('removes single signature entries, a signature value, or the whole group', async () => {
    const one = await bytesOf(await pdfHandler.write!(Source.fromBytes(input), edits({ 'pdfsig:1:Location': REMOVE, 'pdfsig:1:Reason': REMOVE })));
    expect(etProblems(await exiftool(one, 'one.pdf'))).toEqual([]);
    let m = await read(one);
    expect(m.groups.find((g) => g.id === 'pdf.signatures')!.fields.map((f) => f.id)).toEqual([
      'pdfsig:1:Name',
      'pdfsig:1:M',
      'pdfsig:1:ContactInfo',
      'pdfsig:1:cert',
      'pdfsig:dss',
      'pdfsig:perms',
    ]);
    expect(await pdfAllText(one)).not.toContain(`Berlin ${MARK}`);

    const value = await bytesOf(await pdfHandler.write!(Source.fromBytes(input), edits({ 'pdfsig:1:cert': REMOVE })));
    m = await read(value);
    // the certification entry pointed at the removed value; the validation data is a field of its own
    expect(m.groups.find((g) => g.id === 'pdf.signatures')!.fields.map((f) => f.id)).toEqual(['pdfsig:dss']);
    expect(m.info.find((i) => i.label === 'Digital signatures')).toBeUndefined();
    expect((await pdfAllText(value)).toLowerCase()).not.toContain(hexOf(MARK));
    expect(field(m, 'pdfdoc:javascript')).toBeDefined(); // nothing else changes

    const group = await bytesOf(await pdfHandler.write!(Source.fromBytes(input), edits({ [groupKey('pdf.signatures')]: REMOVE })));
    expect(etProblems(await exiftool(group, 'group.pdf'))).toEqual([]);
    m = await read(group);
    expect(m.groups.find((g) => g.id === 'pdf.signatures')).toBeUndefined();
    const all = await pdfAllText(group);
    expect(all.toLowerCase()).not.toContain(hexOf(MARK));
    expect(all).not.toContain(`OCSP response for ${MARK}`);
    expect(all).not.toContain(`Alice ${MARK}`);
    if (HAS_SWIFT) expect(pdfKitPages(group)).toBe(2);
  });

  it('removes scripts, local paths and associated files separately', async () => {
    const scripts = await bytesOf(await pdfHandler.write!(Source.fromBytes(input), edits({ 'pdfdoc:javascript': REMOVE })));
    expect(etProblems(await exiftool(scripts, 's.pdf'))).toEqual([]);
    let m = await read(scripts);
    expect(field(m, 'pdfdoc:javascript')).toBeUndefined();
    expect(field(m, 'pdfdoc:file-links')).toBeDefined();
    expect(field(m, 'pdfsig:1:Name')).toBeDefined();
    let all = await pdfAllText(scripts);
    expect(all).not.toMatch(/app\.alert|AFNumber_|console\.println|function owner/);

    const paths = await bytesOf(await pdfHandler.write!(Source.fromBytes(input), edits({ 'pdfdoc:file-links': REMOVE })));
    m = await read(paths);
    expect(field(m, 'pdfdoc:file-links')).toBeUndefined();
    expect(field(m, 'pdfdoc:javascript')).toBeDefined();
    all = await pdfAllText(paths);
    expect(all).not.toContain('Users/alice/secret');
    expect(all).toContain('/Users/alice/exports/page-data.csv'); // an attachment, not a link

    const files = await bytesOf(await pdfHandler.write!(Source.fromBytes(input), edits({ 'pdfdoc:attachments': REMOVE })));
    expect(etProblems(await exiftool(files, 'f.pdf'))).toEqual([]);
    m = await read(files);
    expect(field(m, 'pdfdoc:attachments')).toBeUndefined();
    all = await pdfAllText(files);
    expect(all).not.toContain('page data 1,2,3');
    expect(all).not.toContain('annotation file');
    expect(all).not.toContain('/AF');
    if (HAS_SWIFT) expect(pdfKitPages(files)).toBe(2);
  });

  it('finds signatures outside the field tree and keeps the actions chained to a removed script', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const ctx = doc.context;
    const page = doc.addPage([200, 200]);
    const sig = ctx.register(ctx.obj({ Type: 'Sig', SubFilter: 'adbe.pkcs7.detached', Contents: PDFHexString.of(PKCS7.toString('hex')), Name: PDFString.of(`Bob ${MARK}`) }));
    // the value sits on a parent field that no /AcroForm lists; only its widget is on the page
    const parent = ctx.register(ctx.obj({ FT: 'Sig', T: PDFString.of('Hidden'), V: sig }));
    const kid = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Widget', Parent: parent, Rect: [0, 0, 10, 10], P: page.ref }));
    (ctx.lookup(parent) as PDFDict).set(PDFName.of('Kids'), ctx.obj([kid]));
    page.node.set(PDFName.of('Annots'), ctx.obj([kid]));
    const next = ctx.obj([ctx.obj({ S: 'GoTo', D: [page.ref, 'Fit'] }), ctx.obj({ S: 'Named', N: 'LastPage' })]);
    doc.catalog.set(PDFName.of('OpenAction'), ctx.obj({ S: 'JavaScript', JS: PDFString.of(`app.alert("${MARK}")`), Next: next }));
    const bytes = await doc.save({ addDefaultPage: false });

    const m = await read(bytes);
    expect(field(m, 'pdfsig:1:Name')?.value).toBe(`Bob ${MARK}`);
    expect(field(m, 'pdfsig:1:cert')?.display).toMatch(new RegExp(`^Alice ${MARK} <alice@example.com>, Acme GmbH — `));
    expect(field(m, 'pdfdoc:javascript')?.display).toMatch(/^1 script action — \d+ B of JavaScript$/);

    const out = await bytesOf(await pdfHandler.strip!(Source.fromBytes(bytes), strip()));
    expect(etProblems(await exiftool(out, 'o.pdf'))).toEqual([]);
    const all = await pdfAllText(out);
    expect(all).not.toContain(MARK);
    expect(all.toLowerCase()).not.toContain(hexOf(MARK));
    const d = await PDFDocument.load(out, { updateMetadata: false });
    // GoTo runs first, then the named action that followed it
    expect(str(dig(d, d.catalog, 'OpenAction', 'S'))).toBe('GoTo');
    expect(str(dig(d, dig(d, d.catalog, 'OpenAction', 'Next'), 'N'))).toBe('LastPage');
    expect(allFields(await read(out)).map((f) => f.id)).toEqual(['pdfdoc:id']);
    if (HAS_SWIFT) expect(pdfKitPages(out)).toBe(1);
  });
});
