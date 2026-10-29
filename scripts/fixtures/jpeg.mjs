// JPEG fixtures.
export default async function (ctx) {
  // plain: ffmpeg output (JFIF + "Lavc" COM comment)
  ctx.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x120', '-frames:v', '1', '-q:v', '5', ctx.tmpPath('plain.jpg')]);
  const plain = ctx.read(ctx.tmpPath('plain.jpg'));
  ctx.write('plain.jpg', plain);

  // camera: rich EXIF/GPS/XMP/IPTC as a phone/camera would write it
  const camera = await ctx.exiftoolWrite(plain, 'camera.jpg', {
    'IFD0:Make': 'Apple',
    'IFD0:Model': 'iPhone 15 Pro',
    'IFD0:Software': '17.4.1',
    'IFD0:Orientation#': 6,
    'IFD0:Artist': 'Jane Doe',
    'IFD0:Copyright': '© 2024 Jane Doe',
    'IFD0:ImageDescription': 'Golden Gate at dusk',
    'IFD0:ModifyDate': '2024:05:01 18:30:00',
    'IFD0:XPTitle': 'Brücke',
    'ExifIFD:DateTimeOriginal': '2024:05:01 18:29:59',
    'ExifIFD:CreateDate': '2024:05:01 18:29:59',
    'ExifIFD:OffsetTimeOriginal': '-07:00',
    'ExifIFD:ExposureTime': '1/125',
    'ExifIFD:FNumber': 1.8,
    'ExifIFD:ISO': 64,
    'ExifIFD:FocalLength': 6.86,
    'ExifIFD:LensModel': 'iPhone 15 Pro back triple camera 6.86mm f/1.78',
    'ExifIFD:LensMake': 'Apple',
    'ExifIFD:SerialNumber': 'F2LXK1234567',
    'ExifIFD:UserComment': 'Shot from the north tower',
    'ExifIFD:Flash#': 16,
    'GPS:GPSLatitude': 37.8199,
    'GPS:GPSLatitudeRef': 'N',
    'GPS:GPSLongitude': 122.4783,
    'GPS:GPSLongitudeRef': 'W',
    'GPS:GPSAltitude': 67.5,
    'GPS:GPSAltitudeRef#': 0,
    'GPS:GPSDateStamp': '2024:05:02',
    'GPS:GPSTimeStamp': '01:29:59',
    'XMP-dc:Title': 'Golden Gate',
    'XMP-dc:Creator': 'Jane Doe',
    'XMP-dc:Subject': ['bridge', 'sunset', 'San Francisco'],
    'XMP-dc:Description': 'Golden Gate at dusk',
    'XMP-xmp:CreatorTool': 'Adobe Lightroom 7.2',
    'XMP-photoshop:City': 'San Francisco',
    'XMP-xmpMM:DocumentID': 'xmp.did:1234-5678',
    'IPTC:Keywords': ['bridge', 'sunset'],
    'IPTC:By-line': 'Jane Doe',
    'IPTC:City': 'San Francisco',
    'IPTC:Caption-Abstract': 'Golden Gate at dusk',
    'IPTC:CopyrightNotice': '© 2024 Jane Doe',
    'File:Comment': 'Edited with secret-tool v1',
  }, ['-codedcharacterset=utf8']);
  ctx.write('camera.jpg', camera);

  // big-endian vs little-endian EXIF (exiftool writes MM by default; force II)
  const le = await ctx.exiftoolWrite(plain, 'le.jpg', { 'IFD0:Make': 'Canon', 'IFD0:Model': 'EOS R5', 'ExifIFD:ISO': 400 }, ['-ExifByteOrder=Little-endian']);
  ctx.write('le.jpg', le);

  // progressive JPEG without JFIF
  ctx.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=96x64', '-frames:v', '1', '-q:v', '8', '-flags', '+bitexact', ctx.tmpPath('p.jpg')]);
  ctx.write('bitexact.jpg', ctx.read(ctx.tmpPath('p.jpg')));
  ctx.cleanup();
}
