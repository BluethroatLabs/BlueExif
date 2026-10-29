import { describe, expect, it } from 'vitest';
import { gunzipSync, gzipSync } from 'fflate';
import { Source, groupKey } from '../core/types';
import { REMOVE, allFields, bytesOf, edits, etMetaKeys, etProblems, exiftool, field, fixture, fixtureBytes, strip } from '../test/helpers';
import { HAS_QLMANAGE, qlRender } from '../test/docOracles';
import { inspectEmbedded } from './embedded';
import { containsText, pixelHash } from './images.testutil';
import { parseJpeg } from './jpeg';
import { pngHandler } from './png';
import { svgHandler } from './svg';

const MARK = 'SECRET-MARKER-42';
const DC = 'http://purl.org/dc/elements/1.1/';
const CC = 'http://creativecommons.org/ns#';
const rdf = (ns: string, local: string) => `svg:rdf:${ns}|${local}`;
const XMP_CREATOR = 'xmp:http://purl.org/dc/elements/1.1/|creator';

const read = (b: Uint8Array | Blob) => svgHandler.read(b instanceof Blob ? new Source(b) : Source.fromBytes(b));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function detect(bytes: Uint8Array, name: string): number {
  return svgHandler.detect({ head: bytes.subarray(0, 65536), name, ext: name.split('.').pop()!, size: bytes.length });
}

/** QuickLook renders must be pixel-identical (identical PNG bytes) to the original's. */
function sameRender(a: Uint8Array, b: Uint8Array): void {
  if (!HAS_QLMANAGE) return;
  expect(Buffer.from(qlRender(b)).equals(Buffer.from(qlRender(a)))).toBe(true);
}

describe('svg', () => {
  it('detects SVG and SVGZ but not HTML with inline SVG', () => {
    for (const f of ['inkscape.svg', 'illustrator.svg', 'sketch.svg', 'plain.svg', 'inkscape.svgz']) {
      expect(detect(fixtureBytes(`documents/${f}`), f), f).toBe(3);
    }
    const html = new TextEncoder().encode('<!DOCTYPE html><html><body><svg xmlns="http://www.w3.org/2000/svg"></svg></body></html>');
    expect(detect(html, 'page.html')).toBe(0);
    expect(detect(new Uint8Array([0x1f, 0x8b, 8, 0]), 'archive.gz')).toBe(0);
  });

  it('gives up on a prolog left open in the sniffed head instead of looping', () => {
    // Every dropped file is sniffed, whatever its type: this once hung the engine for good.
    for (const head of ['\n\n<!-- never closed', '  <?xml never closed', '\t<!DOCTYPE svg [ never closed', '<!-- a -->  <!-- b']) {
      const bytes = new TextEncoder().encode(head);
      expect(detect(bytes, 'notes.txt'), head).toBe(0);
      expect(detect(bytes, 'drawing.svg'), head).toBe(1);
      expect(detect(gzipSync(bytes), 'notes.gz'), head).toBe(0);
    }
  });

  it('refuses deeply nested groups with a clear error, not a stack overflow', async () => {
    const deep = `<svg xmlns="http://www.w3.org/2000/svg">${'<g>'.repeat(20_000)}${'</g>'.repeat(20_000)}</svg>`;
    await expect(svgHandler.read(Source.fromBytes(new TextEncoder().encode(deep), 'deep.svg'))).rejects.toThrow(/nested more than 512 levels deep/);
  });

  it('refuses an SVGZ that expands beyond the limit', async () => {
    // 300 gzip members of 1 MB of zeros each: about 300 KB that would decompress to 300 MB.
    const member = gzipSync(new Uint8Array(1 << 20));
    const bomb = new Uint8Array(member.length * 300);
    for (let i = 0; i < 300; i++) bomb.set(member, i * member.length);
    await expect(svgHandler.read(Source.fromBytes(bomb, 'bomb.svgz'))).rejects.toThrow(/cannot be decompressed: compressed data expands to more than 256 MB/);
  });

  it('reads an Inkscape SVG: title, desc, Creative Commons RDF and editor data', async () => {
    const m = await svgHandler.read(fixture('documents/inkscape.svg'));
    expect(m.format).toMatchObject({ id: 'svg', name: 'SVG image' });
    expect(m.info.find((i) => i.label === 'Dimensions')?.value).toBe('64mm × 48mm');
    expect(field(m, 'svg:title')?.value).toBe('Company logo');
    expect(field(m, 'svg:desc')?.value).toBe(`Draft by ${MARK}`);
    expect(field(m, rdf(DC, 'title'))?.value).toBe('Company logo');
    expect(field(m, rdf(DC, 'creator'))?.value).toBe(`Jane ${MARK} Doe`);
    expect(field(m, rdf(DC, 'rights'))?.value).toBe(`Acme ${MARK} Inc`);
    expect(field(m, rdf(DC, 'date'))?.value).toBe('2024-05-01');
    expect(field(m, rdf(DC, 'subject'))?.value).toEqual(['logo', 'brand']);
    expect(field(m, rdf(CC, 'license'))?.value).toBe('http://creativecommons.org/licenses/by-sa/4.0/');
    expect(field(m, rdf(DC, 'format'))).toBeUndefined();
    expect(field(m, 'svg:rdf:other')?.display).toBe('License: permits Reproduction, permits Distribution, requires Notice');
    expect(field(m, 'svg:editor:inkscape')?.display).toBe(
      `Inkscape 1.3.2 (091e20e, 2023-11-25, custom), file “logo-${MARK}.svg”, 2 elements, 13 attributes`,
    );
    expect(field(m, 'svg:paths')?.display).toBe(`/home/${MARK}/Pictures/logo.png`);
    expect(field(m, 'svg:comments')?.display).toBe('Created with Inkscape (http://www.inkscape.org/)');
    expect(m.warnings).toEqual([]);
    expect(m.canWrite).toBe(true);
  });

  it('reads an Illustrator SVG with DOCTYPE entities and embedded XMP', async () => {
    const m = await svgHandler.read(fixture('documents/illustrator.svg'));
    expect(m.warnings).toEqual([]);
    expect(field(m, XMP_CREATOR)?.value).toEqual([`Illustrator user ${MARK}`]);
    expect(field(m, 'svg:editor:illustrator')?.display).toMatch(/^2 elements, 1 attribute, private document copy \(\d+ B\)$/);
    expect(field(m, 'svg:editor:other')).toBeUndefined();
    expect(field(m, 'svg:names')?.display).toBe(`Red dot ${MARK}`);
    expect(field(m, 'svg:doctype')?.display).toBe('8 entity declarations');
    expect(field(m, 'svg:comments')?.display).toMatch(/^Generator: Adobe Illustrator 24\.0\.0/);
  });

  it('reads Sketch output and SVGZ', async () => {
    const s = await svgHandler.read(fixture('documents/sketch.svg'));
    expect(field(s, 'svg:title')?.value).toBe(`icon/user ${MARK}`);
    expect(field(s, 'svg:desc')?.value).toBe('Created with Sketch.');
    expect(field(s, 'svg:editor:sketch')?.display).toBe('3 attributes');
    const z = await svgHandler.read(fixture('documents/inkscape.svgz'));
    expect(z.format.name).toBe('SVGZ image');
    expect(z.info.find((i) => i.label === 'Compression')?.value).toBe('gzip (SVGZ)');
    expect(field(z, rdf(DC, 'creator'))?.value).toBe(`Jane ${MARK} Doe`);
  });

  it('edits title, description and RDF; ExifTool agrees and the image renders the same', async () => {
    const orig = fixtureBytes('documents/inkscape.svg');
    const out = await svgHandler.write!(
      fixture('documents/inkscape.svg'),
      edits({
        'svg:title': 'New <logo> & “mark”',
        'svg:desc': REMOVE,
        [rdf(DC, 'creator')]: 'Zoë Smith',
        [rdf(DC, 'publisher')]: 'Example Press',
        [rdf(DC, 'subject')]: ['a', 'b', 'c'],
        [rdf(DC, 'date')]: REMOVE,
        [rdf(CC, 'license')]: 'http://creativecommons.org/publicdomain/zero/1.0/',
        'svg:paths': REMOVE,
      }),
    );
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'out.svg');
    expect(etProblems(et)).toEqual([]);
    expect(et['SVG:Title']).toBe('New <logo> & “mark”');
    expect(et['SVG:Desc']).toBeUndefined();
    expect(et['XMP-cc:WorkCreatorAgentTitle']).toBe('Zoë Smith');
    expect(et['XMP-cc:WorkPublisherAgentTitle']).toBe('Example Press');
    expect(et['XMP-cc:WorkSubject']).toEqual(['a', 'b', 'c']);
    expect(et['XMP-cc:WorkDate']).toBeUndefined();
    expect(et['XMP-cc:WorkLicense']).toBe('http://creativecommons.org/publicdomain/zero/1.0/');
    expect(et['SVG-inkscape:Export-filename']).toBeUndefined();
    expect(et['SVG-inkscape:Version']).toBe('1.3.2 (091e20e, 2023-11-25, custom)');
    const m = await read(bytes);
    expect(field(m, 'svg:title')?.value).toBe('New <logo> & “mark”');
    expect(field(m, rdf(DC, 'creator'))?.value).toBe('Zoë Smith');
    expect(field(m, 'svg:paths')).toBeUndefined();
    sameRender(orig, bytes);
  });

  it('adds title, description and RDF metadata to a bare SVG', async () => {
    const out = await svgHandler.write!(
      fixture('documents/plain.svg'),
      edits({ 'svg:desc': 'A green square', 'svg:title': 'Square', [rdf(DC, 'creator')]: 'Max', [rdf(DC, 'subject')]: ['shape'] }),
    );
    const bytes = await bytesOf(out);
    const et = await exiftool(bytes, 'p.svg');
    expect(etProblems(et)).toEqual([]);
    expect(et['SVG:Title']).toBe('Square');
    expect(et['SVG:Desc']).toBe('A green square');
    expect(et['XMP-cc:WorkCreatorAgentTitle']).toBe('Max');
    expect(et['XMP-cc:WorkSubject']).toBe('shape');
    expect(text(bytes)).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg[^>]*>\n {2}<title>Square<\/title>\n {2}<desc>A green square<\/desc>\n {2}<metadata>/);
    sameRender(fixtureBytes('documents/plain.svg'), bytes);

    const removed = await svgHandler.write!(Source.fromBytes(bytes), edits({ [groupKey('svg.rdf')]: REMOVE }));
    expect(text(await bytesOf(removed))).not.toContain('metadata');
  });

  it('edits XMP inside an Illustrator SVG while keeping entity-declared namespaces intact', async () => {
    const orig = fixtureBytes('documents/illustrator.svg');
    const out = await svgHandler.write!(fixture('documents/illustrator.svg'), edits({ [XMP_CREATOR]: ['Someone Else'], 'svg:names': REMOVE }));
    const bytes = await bytesOf(out);
    const s = text(bytes);
    expect(s).toContain('xmlns:i="http://ns.adobe.com/AdobeIllustrator/10.0/"');
    expect(s).toContain('requiredExtensions="http://ns.adobe.com/AdobeIllustrator/10.0/"');
    expect(s).not.toContain('&amp;ns_');
    expect(s).not.toContain('data-name');
    const et = await exiftool(bytes, 'ai.svg');
    expect(etProblems(et)).toEqual([]);
    expect(et['XMP-dc:Creator']).toBe('Someone Else');
    expect(et['XMP-xmp:CreatorTool']).toBe('Adobe Illustrator 24.0 (Macintosh)');
    sameRender(orig, bytes);
  });

  for (const name of ['inkscape.svg', 'illustrator.svg', 'sketch.svg']) {
    it(`strips ${name} without changing the rendering`, async () => {
      const orig = fixtureBytes(`documents/${name}`);
      const out = await svgHandler.strip!(fixture(`documents/${name}`), strip());
      const bytes = await bytesOf(out);
      const s = text(bytes);
      expect(s).not.toContain(MARK);
      expect(s).not.toMatch(/<!--|<!DOCTYPE|inkscape|sodipodi|sketch|i:pgf|<metadata|<title|<desc|data-name|xmlns:(i|x|graph|rdf|cc|dc)=/);
      const et = await exiftool(bytes, name);
      expect(etProblems(et)).toEqual([]);
      expect(etMetaKeys(et).filter((k) => !/^SVG:(ImageWidth|ImageHeight|ViewBox|SVGVersion|Xmlns|ID|TagX|TagY|Style|XmlSpace)$/.test(k))).toEqual([]);
      const m = await read(bytes);
      expect(allFields(m)).toEqual([]);
      sameRender(orig, bytes);
    });
  }

  it('strips SVGZ and writes a gzip header without name or time', async () => {
    const out = await bytesOf(await svgHandler.strip!(fixture('documents/inkscape.svgz'), strip()));
    expect([out[0], out[1]]).toEqual([0x1f, 0x8b]);
    expect(out[3] & 0x08).toBe(0); // no FNAME
    expect([...out.subarray(4, 8)]).toEqual([0, 0, 0, 0]); // MTIME
    const s = text(gunzipSync(out));
    expect(s).not.toContain(MARK);
    expect(s).toContain('<path');
    const m = await read(out);
    expect(m.format.name).toBe('SVGZ image');
    expect(allFields(m)).toEqual([]);
  });

  it('refuses to rewrite files whose entities cannot be preserved', async () => {
    const enc = new TextEncoder();
    const markup = enc.encode(`<?xml version="1.0"?>\n<!DOCTYPE svg [<!ENTITY box "<rect width='1' height='1'/>">]>\n<svg xmlns="http://www.w3.org/2000/svg"><title>x</title>&box;</svg>`);
    const m = await read(markup);
    expect(m.canWrite).toBe(false);
    expect(m.warnings[0]).toMatch(/entity &box; containing markup/);
    await expect(svgHandler.write!(Source.fromBytes(markup), edits({ 'svg:title': 'y' }))).rejects.toThrow(/cannot be rewritten/);
    const undeclared = enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><text>a&nbsp;b</text></svg>');
    await expect(svgHandler.strip!(Source.fromBytes(undeclared), strip())).rejects.toThrow(/undeclared entity &nbsp;/);
  });

  it('normalises literal newlines in attributes instead of escaping them', async () => {
    const src = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><path d="M0,0\n\t\tL10,10" fill="red"/></svg>');
    const out = text(await bytesOf(await svgHandler.strip!(Source.fromBytes(src), strip())));
    expect(out).toContain('d="M0,0   L10,10"');
    expect(out).not.toContain('&#x');
  });

  it('reads legacy encodings and writes UTF-8', async () => {
    const head = '<?xml version="1.0" encoding="ISO-8859-1"?>\n<svg xmlns="http://www.w3.org/2000/svg"><title>Caf';
    const latin = new Uint8Array([...new TextEncoder().encode(head), 0xe9, ...new TextEncoder().encode('</title></svg>')]);
    const m = await read(latin);
    expect(field(m, 'svg:title')?.value).toBe('Café');
    const out = await bytesOf(await svgHandler.write!(Source.fromBytes(latin), edits({ 'svg:title': 'Café ✓' })));
    expect(text(out)).toContain('encoding="UTF-8"');
    expect(text(out)).toContain('<title>Café ✓</title>');
  });
});

// ------------------------------------------------------------- links

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

/** The data: URIs of an SVG, in document order. */
function dataUris(svg: string): Array<{ head: string; bytes: Uint8Array }> {
  return [...svg.matchAll(/(?:xlink:)?href="(data:[^,"]*),([^"#]*)"/g)].map((m) => ({ head: m[1], bytes: m[1].endsWith(';base64') ? unb64(m[2]) : new TextEncoder().encode(decodeURIComponent(m[2])) }));
}

const svgDoc = (body: string) =>
  new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="320" height="240" viewBox="0 0 320 240">\n${body}\n</svg>\n`,
  );

/** SOS..EOI of a JPEG. */
const scanOf = (b: Uint8Array) => {
  const j = parseJpeg(b);
  return Buffer.from(b.subarray(j.scanStart, j.scanEnd));
};

describe('svg: embedded pictures and linked files', () => {
  const jpeg = fixtureBytes('jpeg/camera.jpg');
  const png = fixtureBytes('images/rich.png');
  const photo = `  <image id="photo" x="0" y="0" width="160" height="120" xlink:href="data:image/jpeg;base64,${b64(jpeg)}"/>`;
  const links = [
    '  <image x="0" y="120" width="10" height="10" href="file:///Users/alice/Pictures/holiday%20photo.jpg"/>',
    '  <image x="10" y="120" width="10" height="10" xlink:href="C:\\Users\\alice\\Desktop\\scan.png"/>',
    '  <a href="\\\\fileserver\\alice\\report.pdf"><rect x="20" y="120" width="10" height="10" fill="red"/></a>',
    '  <use href="/home/alice/icons.svg#star" x="30" y="120"/>',
    '  <image x="40" y="120" width="10" height="10" href="images/ok.png"/>',
    '  <a href="/about/team.html"><rect x="50" y="120" width="10" height="10" fill="blue"/></a>',
  ];
  const doc = svgDoc(
    [photo, `  <image id="badge" x="160" y="0" width="32" height="24" href="data:image/png;base64,${b64(png).replace(/(.{76})/g, '$1\n')}"/>`, ...links].join('\n'),
  );

  it('lists what embedded pictures reveal and the local files that are linked', async () => {
    const m = await read(doc);
    const g = m.groups.find((x) => x.id === 'svg.images');
    expect(g).toMatchObject({ label: 'Embedded images', removable: true });
    expect(g!.fields.map((f) => f.id)).toEqual(['svg:image:0', 'svg:image:1']);
    expect(field(m, 'svg:image:0')).toMatchObject({ label: 'JPEG image', sensitivity: 'location', tag: 'xlink:href', removable: true });
    expect(field(m, 'svg:image:0')?.display).toMatch(/^<image id="photo"> · location, people, device, dates.* · 8\.9 KB$/);
    expect(field(m, 'svg:image:1')).toMatchObject({ label: 'PNG image', tag: 'href' });
    expect(field(m, 'svg:paths')).toMatchObject({
      sensitivity: 'identity',
      display: 'file:///Users/alice/Pictures/holiday%20photo.jpg; C:\\Users\\alice\\Desktop\\scan.png; \\\\fileserver\\alice\\report.pdf; /home/alice/icons.svg#star',
      tag: 'href, xlink:href',
    });
    expect(m.warnings).toEqual([]);
  });

  it('strips the pictures with their own handlers, keeping pixels and media types, and cuts paths to file names', async () => {
    const out = await bytesOf(await svgHandler.strip!(Source.fromBytes(doc, 'pic.svg'), strip()));
    const s = text(out);
    expect(s).not.toContain('alice');
    expect(s).not.toContain('fileserver');
    expect(s).toContain('href="holiday%20photo.jpg"');
    expect(s).toContain('xlink:href="scan.png"');
    expect(s).toContain('href="report.pdf"');
    expect(s).toContain('href="icons.svg#star"');
    expect(s).toContain('href="images/ok.png"');
    expect(s).toContain('href="/about/team.html"');
    const [j, p] = dataUris(s);
    expect(j.head).toBe('data:image/jpeg;base64');
    expect(p.head).toBe('data:image/png;base64');
    expect(await inspectEmbedded(j.bytes, 'x.jpg')).toBeNull();
    expect(await inspectEmbedded(p.bytes, 'x.png')).toBeNull();
    expect(containsText(j.bytes, 'Jane Doe')).toBe(false);
    expect(containsText(p.bytes, MARK)).toBe(false);
    expect(scanOf(j.bytes).equals(scanOf(jpeg))).toBe(true);
    expect(pixelHash(j.bytes, 'jpg')).toBe(pixelHash(jpeg, 'jpg'));
    expect(pixelHash(p.bytes, 'png')).toBe(pixelHash(png, 'png'));
    // cleaned exactly like a stand-alone file
    expect(Buffer.from(p.bytes).equals(Buffer.from(await bytesOf(await pngHandler.strip!(Source.fromBytes(png, 'x.png'), strip()))))).toBe(true);
    expect(allFields(await read(out))).toEqual([]);
    expect(etProblems(await exiftool(out, 'pic.svg'))).toEqual([]);
    // (the PNG is left out: Apple's renderer ignores rich.png's orientation until its text chunks are gone)
    const shown = svgDoc([photo, ...links].join('\n'));
    sameRender(shown, await bytesOf(await svgHandler.strip!(Source.fromBytes(shown, 'pic.svg'), strip())));
  });

  it('cleans single pictures, all pictures and the paths on request', async () => {
    const one = text(await bytesOf(await svgHandler.write!(Source.fromBytes(doc, 'pic.svg'), edits({ 'svg:image:0': REMOVE }))));
    const [j, p] = dataUris(one);
    expect(containsText(j.bytes, 'Jane Doe')).toBe(false);
    expect(parseJpeg(j.bytes).segments.some((x) => x.kind === 'exif')).toBe(true); // orientation is kept on edit
    expect(Buffer.from(p.bytes).equals(Buffer.from(png))).toBe(true);
    expect(one).toContain('alice');
    const m = await read(new TextEncoder().encode(one));
    expect(m.groups.find((g) => g.id === 'svg.images')?.fields.map((f) => f.id)).toEqual(['svg:image:1']);

    const all = text(await bytesOf(await svgHandler.write!(Source.fromBytes(doc, 'pic.svg'), edits({ [groupKey('svg.images')]: REMOVE, 'svg:paths': REMOVE }))));
    expect(all).not.toContain('alice');
    expect(allFields(await read(new TextEncoder().encode(all)))).toEqual([]);
  });

  it('cleans SVG pictures embedded in SVG, base64 or percent-encoded', async () => {
    const inner = fixtureBytes('documents/inkscape.svg');
    const titled = `<svg xmlns="http://www.w3.org/2000/svg"><title>by ${MARK}</title><rect width="5" height="5"/></svg>`;
    const doc2 = svgDoc(
      `  <image width="64" height="48" href="data:image/svg+xml;base64,${b64(inner)}"/>\n  <image width="5" height="5" href="data:image/svg+xml;charset=utf-8,${encodeURIComponent(titled)}"/>`,
    );
    const m = await read(doc2);
    expect(field(m, 'svg:image:0')).toMatchObject({ label: 'SVG image', sensitivity: 'identity' });
    expect(field(m, 'svg:image:1')?.display).toMatch(/^<image> · descriptions · /);
    const out = text(await bytesOf(await svgHandler.strip!(Source.fromBytes(doc2, 'n.svg'), strip())));
    const [a, b] = dataUris(out);
    expect(b.head).toBe('data:image/svg+xml;charset=utf-8;base64');
    for (const x of [a, b]) {
      expect(containsText(x.bytes, MARK)).toBe(false);
      expect(text(x.bytes)).toContain('<rect');
    }
    expect(allFields(await read(new TextEncoder().encode(out)))).toEqual([]);
  });

  it('refuses to strip when an embedded picture cannot be cleaned, naming it', async () => {
    const broken = svgDoc(`  <image id="broken" width="5" height="5" href="data:image/jpeg;base64,${b64(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1, 2]))}"/>`);
    await expect(svgHandler.strip!(Source.fromBytes(broken, 'b.svg'), strip())).rejects.toThrow(/picture embedded in <image id="broken"> \(image\/jpeg\) cannot be cleaned/);

    // SVG pictures nested deeper than BlueExif follows them
    let nested = '<svg xmlns="http://www.w3.org/2000/svg"><title>deep</title></svg>';
    for (let i = 0; i < 6; i++) nested = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,${b64(new TextEncoder().encode(nested))}"/></svg>`;
    const m = await read(new TextEncoder().encode(nested));
    expect(m.warnings).toEqual(['1 embedded picture cannot be cleaned; stripping this file will fail.']);
    expect(field(m, 'svg:image:0')).toMatchObject({ removable: false, description: 'BlueExif cannot clean this picture: a picture inside it cannot be checked. Its metadata stays in saved copies.' });
    await expect(svgHandler.strip!(Source.fromBytes(new TextEncoder().encode(nested), 'd.svg'), strip())).rejects.toThrow(/nested too deeply/);

    // an SVG picture whose entities cannot be preserved
    const markup = `<?xml version="1.0"?>\n<!DOCTYPE svg [<!ENTITY box "<rect width='1' height='1'/>">]>\n<svg xmlns="http://www.w3.org/2000/svg"><title>${MARK}</title>&box;</svg>`;
    const withMarkup = svgDoc(`  <image id="ent" href="data:image/svg+xml;base64,${b64(new TextEncoder().encode(markup))}"/>`);
    const e = await read(withMarkup);
    expect(field(e, 'svg:image:0')?.description).toMatch(/^BlueExif cannot clean this picture: This SVG uses entity &box; containing markup/);
    await expect(svgHandler.strip!(Source.fromBytes(withMarkup, 'e.svg'), strip())).rejects.toThrow(/<image id="ent"> \(image\/svg\+xml\) cannot be cleaned: This SVG uses entity &box;/);
  });
});
