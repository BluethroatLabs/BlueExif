// Document fixtures: PDF (pdf-lib + Quartz via Swift), OOXML/ODF (textutil +
// Python stdlib), EPUB 2/3 (Python stdlib) and SVG/SVGZ (hand-written, in the
// style of Inkscape, Illustrator and Sketch output).
//
// Every identifying value contains SECRET-MARKER-42 so tests can assert that
// strip removed it; OLD-REVISION-TITLE only exists in a superseded PDF revision.
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { PDFDocument, PDFHexString, PDFName, PDFRef, PDFString, StandardFonts } from 'pdf-lib';

const MARK = 'SECRET-MARKER-42';

export default async function (ctx) {
  await pdfFixtures(ctx);
  quartzFixtures(ctx);
  officeFixtures(ctx);
  svgFixtures(ctx);
  ctx.cleanup();
}

// ------------------------------------------------------------------- PDF

const xmpPacket = (body) =>
  `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.6-c015">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
${body}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const catalogXmp = (title) =>
  xmpPacket(`   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>Jane ${MARK} Doe</rdf:li></rdf:Seq></dc:creator>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">Quarterly numbers</rdf:li></rdf:Alt></dc:description>
   <xmp:CreatorTool>Microsoft Word for Microsoft 365</xmp:CreatorTool>
   <xmp:CreateDate>2024-05-01T10:30:00+02:00</xmp:CreateDate>
   <xmp:ModifyDate>2024-05-02T11:00:00Z</xmp:ModifyDate>
   <pdf:Producer>Acme PDF Engine 1.0</pdf:Producer>
   <pdf:Keywords>finance, q3</pdf:Keywords>
   <xmpMM:DocumentID>uuid:${MARK}-document</xmpMM:DocumentID>
   <pdfaid:part>2</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>`);

const pageXmp = xmpPacket(`   <dc:creator><rdf:Seq><rdf:li>Page author ${MARK}</rdf:li></rdf:Seq></dc:creator>
   <xmp:CreatorTool>Adobe Photoshop 25.0</xmp:CreatorTool>`);

async function buildPdf({ objectStreams, title }) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Quarterly report - page ${i + 1}`, { x: 50, y: 780, size: 18, font });
    pages.push(page);
  }
  const info = {
    Title: PDFString.of(title),
    Author: PDFString.of(`Jane ${MARK} Doe`),
    Subject: PDFString.of('Quarterly numbers'),
    Keywords: PDFString.of('finance, q3'),
    Creator: PDFHexString.fromText('Microsoft® Word for Microsoft 365'),
    Producer: PDFString.of('Acme PDF Engine 1.0'),
    CreationDate: PDFString.of("D:20240501103000+02'00'"),
    ModDate: PDFString.of('D:20240502110000Z'),
    Trapped: PDFName.of('False'),
    Company: PDFString.of(`Acme ${MARK} Inc`),
    SourceModified: PDFString.of('D:20240501083000'),
  };
  ctx.trailerInfo.Info = ctx.register(ctx.obj(info));
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of('5EC4E7AA42424242DEADBEEF00112233'), PDFHexString.of('5EC4E7AA42424242DEADBEEF00112233')]);
  doc.catalog.set(PDFName.of('Metadata'), ctx.register(ctx.stream(catalogXmp(title), { Type: 'Metadata', Subtype: 'XML' })));

  const p1 = pages[0].node;
  const note = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [100, 600, 120, 620],
      Contents: PDFString.of('Please check the totals'),
      T: PDFString.of(`Reviewer ${MARK}`),
      M: PDFString.of('D:20240503090000Z'),
      Name: 'Comment',
    }),
  );
  const hl = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [50, 775, 300, 800],
      QuadPoints: [50, 800, 300, 800, 50, 775, 300, 775],
      C: [1, 1, 0],
      T: PDFString.of('Bob Example'),
    }),
  );
  p1.set(PDFName.of('Annots'), ctx.obj([note, hl]));
  // A form field: its widget /T is a field name and must survive strip.
  const field = doc.getForm().createTextField('customer.name');
  field.setText('ACME');
  field.addToPage(pages[1], { x: 50, y: 700, width: 200, height: 20, font });

  const priv = ctx.register(ctx.flateStream(`%AI private data of ${MARK}\n`.repeat(20)));
  p1.set(PDFName.of('PieceInfo'), ctx.obj({ Illustrator: { LastModified: PDFString.of('D:20240501103000Z'), Private: priv } }));
  p1.set(PDFName.of('LastModified'), PDFString.of('D:20240501103000Z'));
  p1.set(PDFName.of('Metadata'), ctx.register(ctx.stream(pageXmp, { Type: 'Metadata', Subtype: 'XML' })));

  await doc.attach(new TextEncoder().encode('Meeting notes: totals look fine.\n'), 'notes.txt', {
    mimeType: 'text/plain',
    description: 'Meeting notes',
    creationDate: new Date('2024-05-01T08:00:00Z'),
    modificationDate: new Date('2024-05-02T08:00:00Z'),
  });
  return doc.save({ useObjectStreams: objectStreams, addDefaultPage: false, updateFieldAppearances: true });
}

/**
 * Append an incremental update that (a) redefines the Info object under the
 * same number with a new title and (b) points the catalog at a new XMP stream,
 * orphaning the old one. The old title stays in the file's first revision.
 */
async function appendRevision(bytes, newTitle) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const text = Buffer.from(bytes).toString('latin1');
  const prev = +/startxref\s+(\d+)\s+%%EOF\s*$/.exec(text)[1];
  const infoRef = ctx.trailerInfo.Info;
  const rootRef = ctx.trailerInfo.Root;
  const info = ctx.lookup(infoRef);
  info.set(PDFName.of('Title'), PDFString.of(newTitle));
  const xmpNum = ctx.largestObjectNumber + 1;
  doc.catalog.set(PDFName.of('Metadata'), PDFRef.of(xmpNum));
  const xmp = catalogXmp(newTitle);
  const xmpLen = Buffer.byteLength(xmp, 'utf8');
  const catText = doc.catalog.toString();
  const out = Buffer.from(text, 'latin1');
  const parts = [out];
  let offset = out.length;
  const entries = [];
  const push = (num, body) => {
    const chunk = Buffer.from(`\n${num} 0 obj\n`, 'latin1');
    entries.push([num, offset + 1]);
    const buf = Buffer.concat([chunk, Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(buf);
    offset += buf.length;
  };
  push(infoRef.objectNumber, info.toString());
  push(rootRef.objectNumber, catText);
  push(xmpNum, Buffer.concat([Buffer.from(`<< /Type /Metadata /Subtype /XML /Length ${xmpLen} >>\nstream\n`, 'latin1'), Buffer.from(xmp, 'utf8'), Buffer.from('\nendstream', 'latin1')]));
  const xrefAt = offset;
  let xref = 'xref\n';
  for (const [num, off] of entries.sort((a, b) => a[0] - b[0])) xref += `${num} 1\n${String(off).padStart(10, '0')} 00000 n\r\n`;
  const id = '<5EC4E7AA42424242DEADBEEF00112233>';
  xref += `trailer\n<< /Size ${xmpNum + 1} /Root ${rootRef.objectNumber} 0 R /Info ${infoRef.objectNumber} 0 R /ID [${id} ${id}] /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}

async function pdfFixtures(ctx) {
  const original = await buildPdf({ objectStreams: false, title: 'Draft OLD-REVISION-TITLE' });
  ctx.write('report.pdf', await appendRevision(original, 'Quarterly Report'));
  ctx.write('objstm.pdf', await buildPdf({ objectStreams: true, title: 'Object streams' }));
}

function quartzFixtures(ctx) {
  // Real-world producer: Quartz PDFContext (classic xref, compressed content).
  const swift = `
import Foundation
import CoreGraphics
let out = CommandLine.arguments[1]
func make(_ name: String, _ extra: [CFString: Any]) {
  var box = CGRect(x: 0, y: 0, width: 612, height: 792)
  var info: [CFString: Any] = [
    kCGPDFContextTitle: "Quartz Title",
    kCGPDFContextAuthor: "Quartz Author ${MARK}",
    kCGPDFContextCreator: "BlueExif fixture generator",
    kCGPDFContextSubject: "Quartz subject",
    kCGPDFContextKeywords: "alpha, beta",
  ]
  for (k, v) in extra { info[k] = v }
  let url = URL(fileURLWithPath: out + "/" + name) as CFURL
  guard let c = CGContext(url, mediaBox: &box, info as CFDictionary) else { fatalError("context") }
  c.beginPDFPage(nil)
  c.setFillColor(red: 0.8, green: 0.2, blue: 0.2, alpha: 1)
  c.fill(CGRect(x: 100, y: 100, width: 200, height: 100))
  c.endPDFPage()
  c.closePDF()
}
make("quartz.pdf", [:])
make("encrypted.pdf", [kCGPDFContextOwnerPassword: "owner", kCGPDFContextUserPassword: "user"])
`;
  const script = ctx.tmpPath('quartz.swift');
  writeFileSync(script, swift);
  ctx.run('swift', [script, ctx.tmp], { timeout: 300_000 });
  ctx.write('quartz.pdf', ctx.read(ctx.tmpPath('quartz.pdf')));
  ctx.write('encrypted.pdf', ctx.read(ctx.tmpPath('encrypted.pdf')));
}

// ---------------------------------------------------------------- Office

function officeFixtures(ctx) {
  // textutil writes real-world Cocoa OOXML / ODF; the Python script enriches
  // them and builds xlsx/pptx/ods/odp/epub with the stdlib zipfile module.
  const txt = ctx.tmpPath('body.txt');
  writeFileSync(txt, 'Hello world, this is the body text.\n');
  const meta = [
    '-title', 'Plain textutil document',
    '-author', `Jane ${MARK} Doe`,
    '-subject', 'Testing',
    '-keywords', '(alpha, beta)',
    '-comment', 'Converted with textutil',
    '-editor', `Bob ${MARK}`,
    '-company', `Acme ${MARK} Inc`,
    '-creationtime', '2024-05-01T10:00:00Z',
    '-modificationtime', '2024-05-02T11:00:00Z',
  ];
  for (const fmt of ['docx', 'odt']) {
    ctx.run('textutil', ['-convert', fmt, ...meta, '-output', ctx.tmpPath(`plain.${fmt}`), txt], { timeout: 60_000 });
    ctx.write(`plain.${fmt}`, ctx.read(ctx.tmpPath(`plain.${fmt}`)));
  }
  const script = new URL('./documents_office.py', import.meta.url).pathname;
  ctx.run('python3', ['-I', script, ctx.dir, ctx.tmpPath('plain.docx'), ctx.tmpPath('plain.odt')], { timeout: 120_000 });
  for (const f of ['rich.docx', 'book.xlsx', 'deck.pptx', 'rich.odt', 'sheet.ods', 'slides.odp', 'book2.epub', 'book3.epub']) ctx.write(f, ctx.read(ctx.path(f)));
}

// ------------------------------------------------------------------- SVG

const INKSCAPE_SVG = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!-- Created with Inkscape (http://www.inkscape.org/) -->

<svg
   width="64mm"
   height="48mm"
   viewBox="0 0 64 48"
   version="1.1"
   id="svg1"
   inkscape:version="1.3.2 (091e20e, 2023-11-25, custom)"
   sodipodi:docname="logo-${MARK}.svg"
   inkscape:export-filename="/home/${MARK}/Pictures/logo.png"
   inkscape:export-xdpi="96"
   inkscape:export-ydpi="96"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns="http://www.w3.org/2000/svg"
   xmlns:svg="http://www.w3.org/2000/svg"
   xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
   xmlns:cc="http://creativecommons.org/ns#"
   xmlns:dc="http://purl.org/dc/elements/1.1/">
  <title
     id="title1">Company logo</title>
  <desc
     id="desc1">Draft by ${MARK}</desc>
  <sodipodi:namedview
     id="namedview1"
     pagecolor="#ffffff"
     bordercolor="#000000"
     inkscape:zoom="2.5"
     inkscape:cx="120"
     inkscape:cy="90"
     inkscape:window-width="1920"
     inkscape:window-height="1011"
     inkscape:current-layer="layer1"
     inkscape:document-units="mm" />
  <defs
     id="defs1">
    <inkscape:path-effect
       effect="spiro"
       id="path-effect1"
       is_visible="true"
       lpeversion="1" />
    <linearGradient
       id="grad1"
       inkscape:collect="always">
      <stop
         offset="0"
         style="stop-color:#3366cc;stop-opacity:1" />
      <stop
         offset="1"
         style="stop-color:#99ccff;stop-opacity:1" />
    </linearGradient>
  </defs>
  <metadata
     id="metadata1">
    <rdf:RDF>
      <cc:Work
         rdf:about="">
        <dc:format>image/svg+xml</dc:format>
        <dc:type
           rdf:resource="http://purl.org/dc/dcmitype/StillImage" />
        <dc:title>Company logo</dc:title>
        <dc:creator>
          <cc:Agent>
            <dc:title>Jane ${MARK} Doe</dc:title>
          </cc:Agent>
        </dc:creator>
        <dc:rights>
          <cc:Agent>
            <dc:title>Acme ${MARK} Inc</dc:title>
          </cc:Agent>
        </dc:rights>
        <dc:date>2024-05-01</dc:date>
        <dc:subject>
          <rdf:Bag>
            <rdf:li>logo</rdf:li>
            <rdf:li>brand</rdf:li>
          </rdf:Bag>
        </dc:subject>
        <dc:description>Primary logo</dc:description>
        <cc:license
           rdf:resource="http://creativecommons.org/licenses/by-sa/4.0/" />
      </cc:Work>
      <cc:License
         rdf:about="http://creativecommons.org/licenses/by-sa/4.0/">
        <cc:permits
           rdf:resource="http://creativecommons.org/ns#Reproduction" />
        <cc:permits
           rdf:resource="http://creativecommons.org/ns#Distribution" />
        <cc:requires
           rdf:resource="http://creativecommons.org/ns#Notice" />
      </cc:License>
    </rdf:RDF>
  </metadata>
  <g
     inkscape:label="Layer 1 (${MARK})"
     inkscape:groupmode="layer"
     id="layer1">
    <rect
       style="fill:url(#grad1);stroke:#003366;stroke-width:1"
       id="rect1"
       width="40"
       height="30"
       x="12"
       y="9"
       ry="4" />
    <path
       sodipodi:type="arc"
       style="fill:#ffcc00"
       id="path1"
       sodipodi:cx="32"
       sodipodi:cy="24"
       sodipodi:rx="6"
       sodipodi:ry="6"
       d="M 38,24 A 6,6 0 0 1 32,30 6,6 0 0 1 26,24 6,6 0 0 1 32,18 6,6 0 0 1 38,24 Z" />
  </g>
</svg>
`;

const ILLUSTRATOR_SVG = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 24.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [
	<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">
	<!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/">
	<!ENTITY ns_graphs "http://ns.adobe.com/Graphs/1.0/">
	<!ENTITY ns_vars "http://ns.adobe.com/Variables/1.0/">
	<!ENTITY ns_imrep "http://ns.adobe.com/ImageReplacement/1.0/">
	<!ENTITY ns_sfw "http://ns.adobe.com/SaveForWeb/1.0/">
	<!ENTITY ns_custom "http://ns.adobe.com/GenericCustomNamespace/1.0/">
	<!ENTITY ns_adobe_xpath "http://ns.adobe.com/XPath/1.0/">
]>
<svg version="1.1" id="Layer_1" xmlns:x="&ns_extend;" xmlns:i="&ns_ai;" xmlns:graph="&ns_graphs;"
	 xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" width="100px"
	 height="100px" viewBox="0 0 100 100" style="enable-background:new 0 0 100 100;" xml:space="preserve">
<metadata>
	<sfw  xmlns="&ns_sfw;">
		<slices></slices>
		<sliceSourceBounds  bottomLeftOrigin="true" height="100" width="100" x="0" y="0"></sliceSourceBounds>
	</sfw>
	<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.6-c014 79.156797, 2014/08/20-09:53:02">
		<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
			<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">
				<dc:creator><rdf:Seq><rdf:li>Illustrator user ${MARK}</rdf:li></rdf:Seq></dc:creator>
				<xmp:CreatorTool>Adobe Illustrator 24.0 (Macintosh)</xmp:CreatorTool>
				<xmp:CreateDate>2024-05-01T10:00:00+02:00</xmp:CreateDate>
				<xmpMM:DocumentID>xmp.did:${MARK}-0001</xmpMM:DocumentID>
			</rdf:Description>
		</rdf:RDF>
	</x:xmpmeta>
</metadata>
<switch>
	<foreignObject requiredExtensions="&ns_ai;" x="0" y="0" width="1" height="1">
		<i:pgfRef  xlink:href="#adobe_illustrator_pgf">
		</i:pgfRef>
	</foreignObject>
	<g i:extraneous="self">
		<circle style="fill:#CC3333;" cx="50" cy="50" r="40" data-name="Red dot ${MARK}"/>
		<rect x="30" y="44" width="40" height="12" style="fill:#FFFFFF;"/>
	</g>
</switch>
<i:pgf  id="adobe_illustrator_pgf">
	<![CDATA[
	eJzLSM3JyVcozy/KSQEAGgsEXQ== ${MARK} private document data
	]]>
</i:pgf>
</svg>
`;

const SKETCH_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="48px" height="48px" viewBox="0 0 48 48" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:sketch="http://www.bohemiancoding.com/sketch/ns">
    <!-- Generator: Sketch 52.5 (67469) - http://www.bohemiancoding.com/sketch -->
    <title>icon/user ${MARK}</title>
    <desc>Created with Sketch.</desc>
    <defs>
        <linearGradient x1="50%" y1="0%" x2="50%" y2="100%" id="linearGradient-1">
            <stop stop-color="#5AC8FA" offset="0%"></stop>
            <stop stop-color="#007AFF" offset="100%"></stop>
        </linearGradient>
    </defs>
    <g id="Page-1" stroke="none" stroke-width="1" fill="none" fill-rule="evenodd" sketch:type="MSPage">
        <g id="Artboard" sketch:type="MSArtboardGroup" fill="url(#linearGradient-1)">
            <circle id="Oval" sketch:type="MSShapeGroup" cx="24" cy="24" r="20"></circle>
        </g>
    </g>
</svg>
`;

const PLAIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <rect x="4" y="4" width="24" height="24" rx="3" fill="#2a7"/>
</svg>
`;

function svgFixtures(ctx) {
  ctx.write('inkscape.svg', INKSCAPE_SVG);
  ctx.write('illustrator.svg', ILLUSTRATOR_SVG);
  ctx.write('sketch.svg', SKETCH_SVG);
  ctx.write('plain.svg', PLAIN_SVG);
  ctx.write('inkscape.svgz', gzipSync(Buffer.from(INKSCAPE_SVG, 'utf8'), { level: 9 }));
}
