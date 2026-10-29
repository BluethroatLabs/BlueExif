// Fixtures for metadata inside images embedded in PDFs (pdf-lib + ExifTool WASM
// + sips). Identifying values reuse fixtures/jpeg/camera.jpg ("Jane Doe",
// serial "F2LXK1234567", GPS 37.8199 N 122.4783 W) so tests can assert that
// they are gone after stripping.
//
// photos.pdf (3 pages, no object streams)
//   camera.jpg as one DCTDecode XObject, drawn twice on page 1 and once on page 2
//   camera.jpg + APP2 ICC + APP14 Adobe, as [/FlateDecode /DCTDecode] (page 2)
//   PNG with alpha (Flate samples + SMask, no metadata) (page 1)
//   le.jpg inside a Form XObject, with its own /Metadata XMP stream (page 3)
//   a JPEG page thumbnail (/Thumb, no /Subtype) with an Artist (page 1)
//   a stamp annotation whose appearance shows a JPEG with a date and a trailer (page 3)
// jpx.pdf (1 page, object streams)
//   JP2 (sips) with XMP + EXIF uuid boxes (ExifTool) as /JPXDecode
//   raw J2K codestream with COM markers as /JPXDecode
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import {
  PDFDocument,
  PDFName,
  PDFString,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';

const ICC = '/System/Library/ColorSync/Profiles/Display P3.icc';

export default async function (ctx) {
  const jpegDir = join(ctx.dir, '../jpeg');
  const camera = ctx.read(join(jpegDir, 'camera.jpg'));
  const le = ctx.read(join(jpegDir, 'le.jpg'));
  const plain = ctx.read(join(jpegDir, 'plain.jpg'));

  // JPEG variants
  const adobe = insertAfterJfif(camera, [iccSegment(new Uint8Array(readFileSync(ICC))), adobeSegment()]);
  ctx.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=40x30', '-frames:v', '1', '-q:v', '5', ctx.tmpPath('thumb.jpg')]);
  const thumb = await ctx.exiftoolWrite(ctx.read(ctx.tmpPath('thumb.jpg')), 'thumb.jpg', { 'IFD0:Artist': 'Jane Doe' });
  const dated = await ctx.exiftoolWrite(plain, 'stamp.jpg', { 'ExifIFD:DateTimeOriginal': '2024:05:01 18:29:59' });
  const stamp = concat([dated, new TextEncoder().encode('TRAILER '.repeat(8))]);
  ctx.ffmpeg(['-f', 'lavfi', '-i', 'color=c=red@0.5:s=32x32,format=rgba', '-frames:v', '1', ctx.tmpPath('alpha.png')]);
  const png = ctx.read(ctx.tmpPath('alpha.png'));

  await photosPdf(ctx, { camera, adobe, le, thumb, stamp, png });

  // JPEG 2000
  ctx.run('sips', ['-s', 'format', 'jp2', join(jpegDir, 'plain.jpg'), '--out', ctx.tmpPath('plain.jp2')]);
  const jp2 = ctx.read(ctx.tmpPath('plain.jp2'));
  const jp2Meta = await ctx.exiftoolWrite(jp2, 'photo.jp2', {
    'XMP-dc:Creator': 'Jane Doe',
    'XMP-dc:Title': 'Golden Gate',
    'IFD0:Make': 'Apple',
    'IFD0:Model': 'iPhone 15 Pro',
    'ExifIFD:SerialNumber': 'F2LXK1234567',
    'GPS:GPSLatitude': 37.8199,
    'GPS:GPSLatitudeRef': 'N',
    'GPS:GPSLongitude': 122.4783,
    'GPS:GPSLongitudeRef': 'W',
  });
  const j2k = addJ2kComment(codestreamOf(jp2), 'Scanned by Jane Doe');
  await jpxPdf(ctx, { jp2: jp2Meta, j2k });
  ctx.cleanup();
}

// ------------------------------------------------------------------ PDFs

async function photosPdf(ctx, img) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const pdf = doc.context;
  const pages = [0, 1, 2].map(() => doc.addPage([400, 300]));

  // 1. the same DCT XObject on pages 1 (twice) and 2
  const photo = await doc.embedJpg(img.camera);
  pages[0].drawImage(photo, { x: 10, y: 150, width: 160, height: 120 });
  pages[0].drawImage(photo, { x: 200, y: 150, width: 80, height: 60 });
  pages[1].drawImage(photo, { x: 10, y: 150, width: 160, height: 120 });

  // 2. PNG with alpha: Flate samples + SMask, no metadata
  const png = await doc.embedPng(img.png);
  pages[0].drawImage(png, { x: 10, y: 10, width: 32, height: 32 });

  // 3. [/FlateDecode /DCTDecode] with ICC + Adobe segments
  const flate = pdf.register(
    pdf.stream(deflateSync(img.adobe), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 160,
      Height: 120,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      Filter: ['FlateDecode', 'DCTDecode'],
    }),
  );
  place(pages[1], pages[1].node.newXObject('Im', flate), 200, 150, 160, 120);

  // 4. le.jpg inside a Form XObject; the image carries its own /Metadata packet
  const inner = await doc.embedJpg(img.le);
  await doc.flush(); // materialise the embedded image so we can annotate its dict
  const innerDict = pdf.lookup(inner.ref).dict;
  innerDict.set(PDFName.of('Metadata'), pdf.register(pdf.stream(xmp('Jane Doe'), { Type: 'Metadata', Subtype: 'XML' })));
  const form = pdf.register(
    pdf.formXObject([pushGraphicsState(), concatTransformationMatrix(160, 0, 0, 120, 0, 0), drawObject('Im0'), popGraphicsState()], {
      BBox: [0, 0, 160, 120],
      Resources: { XObject: { Im0: inner.ref } },
    }),
  );
  place(pages[2], pages[2].node.newXObject('Fm', form), 10, 150, 1, 1);

  // 5. page thumbnail (thumbnail images need no /Type or /Subtype)
  const thumb = pdf.register(
    pdf.stream(img.thumb, { Width: 40, Height: 30, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' }),
  );
  pages[0].node.set(PDFName.of('Thumb'), thumb);

  // 6. stamp annotation whose appearance stream shows a JPEG
  const stampImg = pdf.register(
    pdf.stream(img.stamp, { Type: 'XObject', Subtype: 'Image', Width: 160, Height: 120, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' }),
  );
  const ap = pdf.register(
    pdf.formXObject([pushGraphicsState(), concatTransformationMatrix(80, 0, 0, 60, 0, 0), drawObject('Im0'), popGraphicsState()], {
      BBox: [0, 0, 80, 60],
      Resources: { XObject: { Im0: stampImg } },
    }),
  );
  const annot = pdf.register(
    pdf.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [200, 20, 280, 80], Contents: PDFString.of('Approved'), AP: { N: ap } }),
  );
  pages[2].node.set(PDFName.of('Annots'), pdf.obj([annot]));

  ctx.write('photos.pdf', await doc.save({ useObjectStreams: false, addDefaultPage: false }));
}

async function jpxPdf(ctx, img) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const pdf = doc.context;
  const page = doc.addPage([400, 300]);
  const jp2 = pdf.register(pdf.stream(img.jp2, { Type: 'XObject', Subtype: 'Image', Width: 160, Height: 120, Filter: 'JPXDecode' }));
  place(page, page.node.newXObject('Im', jp2), 10, 150, 160, 120);
  const j2k = pdf.register(
    pdf.stream(img.j2k, { Type: 'XObject', Subtype: 'Image', Width: 160, Height: 120, ColorSpace: 'DeviceRGB', Filter: 'JPXDecode' }),
  );
  place(page, page.node.newXObject('Im', j2k), 200, 150, 160, 120);
  ctx.write('jpx.pdf', await doc.save({ useObjectStreams: true, addDefaultPage: false }));
}

function place(page, name, x, y, w, h) {
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, x, y), drawObject(name), popGraphicsState());
}

const xmp = (creator) =>
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:creator><rdf:Seq><rdf:li>${creator}</rdf:li></rdf:Seq></dc:creator>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

// ------------------------------------------------------------------ bytes

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function segment(marker, payload) {
  const len = payload.length + 2;
  return concat([new Uint8Array([0xff, marker, len >> 8, len & 0xff]), payload]);
}

const ascii = (s) => new TextEncoder().encode(s);

function iccSegment(profile) {
  return segment(0xe2, concat([ascii('ICC_PROFILE\0'), new Uint8Array([1, 1]), profile]));
}

/** APP14 "Adobe": version 100, no flags, transform 1 (YCbCr) — as Photoshop writes it. */
function adobeSegment() {
  return segment(0xee, concat([ascii('Adobe'), new Uint8Array([0, 100, 0, 0, 0, 0, 1])]));
}

/** Insert segments after SOI + JFIF APP0 (the JPEG must start with them). */
function insertAfterJfif(jpeg, segs) {
  if (jpeg[2] !== 0xff || jpeg[3] !== 0xe0) throw new Error('expected JFIF APP0');
  const at = 4 + ((jpeg[4] << 8) | jpeg[5]);
  return concat([jpeg.subarray(0, at), ...segs, jpeg.subarray(at)]);
}

/** The contiguous codestream of a JP2 file (payload of its 'jp2c' box). */
function codestreamOf(jp2) {
  const view = new DataView(jp2.buffer, jp2.byteOffset, jp2.byteLength);
  for (let p = 0; p + 8 <= jp2.length; ) {
    let len = view.getUint32(p);
    const type = String.fromCharCode(...jp2.subarray(p + 4, p + 8));
    let head = 8;
    if (len === 1) {
      len = Number(view.getBigUint64(p + 8));
      head = 16;
    } else if (len === 0) len = jp2.length - p;
    if (type === 'jp2c') return jp2.slice(p + head, p + len);
    p += len;
  }
  throw new Error('no jp2c box');
}

/** Add a Latin-1 COM marker segment right after SIZ in a J2K codestream. */
function addJ2kComment(cs, text) {
  if (cs[0] !== 0xff || cs[1] !== 0x4f || cs[2] !== 0xff || cs[3] !== 0x51) throw new Error('expected SOC + SIZ');
  const at = 4 + ((cs[4] << 8) | cs[5]);
  const body = concat([new Uint8Array([0, 1]), ascii(text)]);
  return concat([cs.subarray(0, at), new Uint8Array([0xff, 0x64, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body, cs.subarray(at)]);
}
