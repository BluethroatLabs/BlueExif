// ISO base media fixtures: MP4 / MOV / M4A / 3GP (ffmpeg + ExifTool) and
// HEIC / AVIF (sips, ffmpeg + ExifTool). Every file carries the marker
// "SECRET-MARKER-42" somewhere in its metadata unless it is a "plain" file.
import { writeFileSync } from 'node:fs';

const MARKER = 'SECRET-MARKER-42';

const be32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const utf8 = (s) => new TextEncoder().encode(s);
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const box = (type, ...payload) => {
  const body = cat(...payload);
  return cat(be32(body.length + 8), latin1(type), body);
};
const u32at = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const typeAt = (b, p) => String.fromCharCode(...b.subarray(p + 4, p + 8));

function children(b, start, end) {
  const out = [];
  for (let p = start; p + 8 <= end; ) {
    const size = u32at(b, p);
    if (size < 8) break;
    out.push({ type: typeAt(b, p), start: p, end: p + size });
    p += size;
  }
  return out;
}

/**
 * Append `add` at the end of moov/<path…>. moov must be the last top-level
 * box (ffmpeg's default layout), so no chunk offsets move. Missing containers
 * along the path are not created.
 */
function appendInMoov(b, path, add) {
  const moov = children(b, 0, b.length).find((x) => x.type === 'moov');
  if (!moov || moov.end !== b.length) throw new Error('moov must be the last box');
  const chain = [moov];
  let cur = moov;
  for (const t of path) {
    const head = cur.type === 'meta' ? 12 : 8;
    const next = children(b, cur.start + head, cur.end).find((x) => x.type === t);
    if (!next) throw new Error(`missing ${t}`);
    chain.push(next);
    cur = next;
  }
  const out = cat(b.subarray(0, cur.end), add, b.subarray(cur.end));
  for (const c of chain) out.set(be32(u32at(out, c.start) + add.length), c.start);
  return out;
}

export default async function (ctx) {
  const v = ['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10'];
  const a = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050'];
  const enc = ['-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '24k'];
  const tmp = (n) => ctx.tmpPath(n);

  // ---- tagged.mp4: faststart, iTunes tags + 3GPP loci + XMP uuid + Apple ID
  ctx.ffmpeg([...v, ...a, ...enc, '-metadata', 'title=My Title', '-metadata', 'artist=Jane Doe', '-metadata', `comment=${MARKER}`,
    '-metadata', 'location=+37.7749-122.4194/', '-movflags', '+faststart', tmp('tagged.mp4')]);
  const tagged = await ctx.exiftoolWrite(ctx.read(tmp('tagged.mp4')), 'tagged.mp4', {
    'ItemList:AppleStoreAccount': 'jane@example.com',
    'ItemList:Genre': 'Documentary',
    'XMP-dc:Title': 'XMP title',
    'XMP-dc:Creator': 'Jane Doe',
    'XMP-dc:Description': MARKER,
  });
  ctx.write('tagged.mp4', tagged);

  // ---- moovlast.mp4: moov after mdat, freeform tag, vendor atom, top-level
  // uuid box and a Samsung-style trailer
  ctx.ffmpeg([...v, ...a, ...enc, '-metadata', 'title=Moov last', tmp('moovlast.mp4')]);
  let last = ctx.read(tmp('moovlast.mp4'));
  const ff = box('----', box('mean', new Uint8Array(4), utf8('com.apple.iTunes')), box('name', new Uint8Array(4), utf8('MY_TAG')),
    box('data', be32(1), be32(0), utf8(`custom ${MARKER}`)));
  last = appendInMoov(last, ['udta', 'meta', 'ilst'], ff);
  last = appendInMoov(last, ['udta'], box('smta', utf8(`samsung ${MARKER}`)));
  const uuid = new Uint8Array([0x50, 0x52, 0x4f, 0x46, 0x21, 0xd2, 0x4f, 0xce, 0xbb, 0x88, 0x69, 0x5c, 0xfa, 0xc9, 0xc7, 0x40]);
  last = cat(last, box('uuid', uuid, utf8(`vendor ${MARKER}`)), latin1('SEFH\x01\x02\x03\x04'), utf8(MARKER), latin1('SEFT'));
  ctx.write('moovlast.mp4', last);

  // ---- iphone.mov: QuickTime keys (location/make/model), ©xyz, XMP_, dates
  ctx.ffmpeg([...v, ...a, ...enc, tmp('iphone.mov')]);
  const iphone = await ctx.exiftoolWrite(ctx.read(tmp('iphone.mov')), 'iphone.mov', {
    'Keys:GPSCoordinates': '37.3349 N, 122.0090 W, 20.5',
    'Keys:Make': 'Apple',
    'Keys:Model': 'iPhone 15 Pro',
    'Keys:Software': '17.4.1',
    'Keys:CreationDate': '2024:05:01 18:29:59-07:00',
    'Keys:Description': MARKER,
    'UserData:GPSCoordinates': '37.3349 N, 122.0090 W',
    'UserData:Make': 'Apple',
    'XMP-dc:Title': 'Golden hour',
    'QuickTime:CreateDate': '2024:05:02 01:29:59',
    'QuickTime:ModifyDate': '2024:05:02 01:30:00',
    'Track1:TrackCreateDate': '2024:05:02 01:29:59',
    'Track1:MediaCreateDate': '2024:05:02 01:29:59',
  }, ['-api', 'QuickTimeUTC=1']);
  ctx.write('iphone.mov', iphone);

  // ---- frag.mp4 (explicit tfhd base offsets + mfra) / fragsidx.mp4 (sidx, moof-relative)
  ctx.ffmpeg([...v, ...a, ...enc, '-g', '5', '-metadata', `title=${MARKER}`, '-movflags', 'frag_keyframe+empty_moov', tmp('frag.mp4')]);
  ctx.write('frag.mp4', ctx.read(tmp('frag.mp4')));
  ctx.ffmpeg([...v, ...a, ...enc, '-g', '5', '-metadata', `title=${MARKER}`,
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+global_sidx', tmp('fragsidx.mp4')]);
  ctx.write('fragsidx.mp4', ctx.read(tmp('fragsidx.mp4')));

  // ---- audio.m4a: AAC + cover art + music tags + purchase/account atoms
  ctx.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=32x32', '-frames:v', '1', tmp('cover.jpg')]);
  ctx.ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-i', tmp('cover.jpg'),
    '-t', '1', '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-b:a', '24k', '-c:v', 'copy',
    '-disposition:v', 'attached_pic', '-metadata', 'title=Song', '-metadata', 'artist=Jane Doe', '-metadata', 'album=Album',
    '-metadata', 'track=3/12', '-metadata', 'disc=1/2', '-metadata', 'genre=Rock', '-metadata', 'date=2024',
    '-metadata', `comment=${MARKER}`, tmp('audio.m4a')]);
  const m4a = await ctx.exiftoolWrite(ctx.read(tmp('audio.m4a')), 'audio.m4a', {
    'ItemList:AppleStoreAccount': 'jane@example.com',
    'ItemList:Owner': 'Jane Owner',
    'ItemList:PurchaseDate': '2024-01-02 10:00:00',
    'ItemList:Lyrics': 'La la la',
    'ItemList:BeatsPerMinute': 120,
    'ItemList:Compilation': 'Yes',
    'ItemList:AlbumArtist': 'Various',
  });
  ctx.write('audio.m4a', m4a);

  // ---- t.3gp: 3GPP asset atoms (titl/auth/perf/albm/cprt/loci)
  ctx.ffmpeg([...v, ...a, ...enc, '-metadata', 'title=3GP Title', '-metadata', 'artist=Jane Doe', '-metadata', `author=${MARKER}`,
    '-metadata', 'copyright=(c) Jane', '-metadata', 'album=Alb', '-metadata', 'location=+48.8584+002.2945/', '-f', '3gp', tmp('t.3gp')]);
  ctx.write('t.3gp', ctx.read(tmp('t.3gp')));

  // ---- HEIF / AVIF
  ctx.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x120', '-frames:v', '1', '-q:v', '5', tmp('src.jpg')]);
  const camJpg = await ctx.exiftoolWrite(ctx.read(tmp('src.jpg')), 'cam.jpg', {
    'IFD0:Make': 'Apple',
    'IFD0:Model': 'iPhone 15 Pro',
    'IFD0:Orientation#': 6,
    'IFD0:Artist': 'Jane Doe',
    'IFD0:ImageDescription': MARKER,
    'ExifIFD:DateTimeOriginal': '2024:05:01 18:29:59',
    'ExifIFD:SerialNumber': 'F2LXK1234567',
    'GPS:GPSLatitude': 37.8199,
    'GPS:GPSLatitudeRef': 'N',
    'GPS:GPSLongitude': 122.4783,
    'GPS:GPSLongitudeRef': 'W',
    'XMP-dc:Title': 'Golden Gate',
    'XMP-dc:Description': MARKER,
    'XMP-photoshop:City': 'San Francisco',
  });
  writeFileSync(tmp('cam.jpg'), camJpg);
  const sips = (input, format, out, extra = []) =>
    ctx.run('sips', ['-s', 'format', format, ...extra, input, '--out', out], { timeout: 60_000 });
  sips(tmp('cam.jpg'), 'heic', tmp('camera.heic'));
  ctx.write('camera.heic', ctx.read(tmp('camera.heic')));
  // Display P3 ICC profile embedded as a colr/prof property.
  sips(tmp('cam.jpg'), 'heic', tmp('icc.heic'), ['-e', '/System/Library/ColorSync/Profiles/Display P3.icc']);
  ctx.write('icc.heic', ctx.read(tmp('icc.heic')));
  sips(tmp('src.jpg'), 'heic', tmp('plain.heic'));
  ctx.write('plain.heic', ctx.read(tmp('plain.heic')));
  sips(tmp('cam.jpg'), 'avif', tmp('camera.avif'));
  ctx.write('camera.avif', ctx.read(tmp('camera.avif')));
  ctx.ffmpeg(['-i', tmp('src.jpg'), '-c:v', 'libsvtav1', '-svtav1-params', 'log-level=0', '-frames:v', '1', '-f', 'avif', tmp('plain.avif')]);
  const plainAvif = ctx.read(tmp('plain.avif'));
  ctx.write('plain.avif', plainAvif);
  // ExifTool re-lays the file out (metadata items before the image in mdat).
  const etAvif = await ctx.exiftoolWrite(plainAvif, 'et.avif', {
    'IFD0:Make': 'Canon',
    'IFD0:Artist': MARKER,
    'GPS:GPSLatitude': 10.5,
    'GPS:GPSLatitudeRef': 'N',
    'GPS:GPSLongitude': 20.25,
    'GPS:GPSLongitudeRef': 'E',
    'XMP-dc:Title': 'ExifTool title',
  });
  ctx.write('et.avif', etAvif);
  // Grid image: 6 tiles, iloc version 1 with an idat-stored grid descriptor.
  ctx.ffmpeg(['-f', 'lavfi', '-i', 'color=c=gray:size=1100x600', '-frames:v', '1', '-q:v', '10', tmp('big.jpg')]);
  sips(tmp('big.jpg'), 'heic', tmp('grid.heic'), ['-s', 'formatOptions', '10']);
  ctx.write('grid.heic', ctx.read(tmp('grid.heic')));
  ctx.cleanup();
}
