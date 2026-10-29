// Builds src/app/assets/sample-photo.jpg: a generated image carrying fictional but
// realistic phone-camera metadata (GPS, device, author) for the "Try a sample" button.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeMetadata } from '@uswriting/exiftool';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'blueexif-sample-'));
const raw = join(tmp, 'raw.jpg');
execFileSync('ffmpeg', [
  '-v', 'error', '-y', '-f', 'lavfi',
  '-i', 'mandelbrot=size=960x640:start_scale=0.0035:end_scale=0.0035:outer=normalized_iteration_count:inner=convergence',
  '-frames:v', '1', '-vf', 'hue=s=0,eq=contrast=1.15', '-q:v', '5', raw,
]);
const tags = {
  'IFD0:Make': 'Apple',
  'IFD0:Model': 'iPhone 15 Pro',
  'IFD0:Software': '17.4.1',
  'IFD0:Artist': 'Jane Doe',
  'IFD0:Copyright': '© 2024 Jane Doe',
  'IFD0:ImageDescription': 'Evening walk',
  'IFD0:ModifyDate': '2024:05:01 18:30:00',
  'ExifIFD:DateTimeOriginal': '2024:05:01 18:29:59',
  'ExifIFD:CreateDate': '2024:05:01 18:29:59',
  'ExifIFD:OffsetTimeOriginal': '-07:00',
  'ExifIFD:ExposureTime': '1/125',
  'ExifIFD:FNumber': 1.8,
  'ExifIFD:ISO': 64,
  'ExifIFD:FocalLength': 6.86,
  'ExifIFD:LensMake': 'Apple',
  'ExifIFD:LensModel': 'iPhone 15 Pro back triple camera 6.86mm f/1.78',
  'ExifIFD:SerialNumber': 'F2LXK1234567',
  'ExifIFD:OwnerName': 'Jane Doe',
  'GPS:GPSLatitude': 37.8199,
  'GPS:GPSLatitudeRef': 'N',
  'GPS:GPSLongitude': 122.4783,
  'GPS:GPSLongitudeRef': 'W',
  'GPS:GPSAltitude': 67.5,
  'GPS:GPSAltitudeRef#': 0,
  'XMP-dc:Title': 'Evening walk',
  'XMP-dc:Creator': 'Jane Doe',
  'XMP-dc:Subject': ['bridge', 'sunset', 'San Francisco'],
  'XMP-xmp:CreatorTool': 'Adobe Lightroom 7.2',
  'XMP-photoshop:City': 'San Francisco',
  'IPTC:By-line': 'Jane Doe',
  'IPTC:City': 'San Francisco',
  'IPTC:Keywords': ['bridge', 'sunset'],
};
const r = await writeMetadata({ name: 'sample.jpg', data: new Uint8Array(readFileSync(raw)) }, tags, { args: ['-codedcharacterset=utf8'] });
if (!r.success) throw new Error(r.error);
writeFileSync(join(root, 'src/app/assets/sample-photo.jpg'), new Uint8Array(r.data));
rmSync(tmp, { recursive: true, force: true });
console.log('src/app/assets/sample-photo.jpg written');
