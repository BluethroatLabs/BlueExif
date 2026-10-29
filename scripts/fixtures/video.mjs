// Matroska / WebM / AVI fixtures: tiny 1 s 64×48 clips with rich metadata.
// Every privacy-relevant value contains SECRET-MARKER-42 so strip tests can
// assert it is gone from the output bytes.
import { writeFileSync } from 'node:fs';

const MARK = 'SECRET-MARKER-42';
const VIDEO = ['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10:duration=1'];
const AUDIO = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000'];

export default async function (ctx) {
  // Attachments and ffmetadata (global tags + chapters)
  ctx.ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:size=32x32', '-frames:v', '1', '-q:v', '8', ctx.tmpPath('cover.jpg')]);
  writeFileSync(ctx.tmpPath('font.ttf'), Buffer.from(`\x00\x01\x00\x00FAKEFONT glyf data 0123456789`, 'latin1'));
  writeFileSync(
    ctx.tmpPath('meta.txt'),
    [
      ';FFMETADATA1',
      `title=Movie ${MARK}`,
      `artist=Jane ${MARK}`,
      `comment=Shot on the beach ${MARK}`,
      'copyright=(c) 2024 Jane',
      `encoded_by=Studio ${MARK}`,
      'date_released=2024-05-01',
      '',
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      'START=0',
      'END=500',
      'title=Intro',
      '',
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      'START=500',
      'END=1000',
      'title=Main',
      '',
    ].join('\n'),
  );

  // Matroska: H.264 + AAC, several clusters/cues, tags, chapters, cover + font.
  ctx.ffmpeg([
    ...VIDEO,
    ...AUDIO,
    '-i', ctx.tmpPath('meta.txt'),
    '-attach', ctx.tmpPath('cover.jpg'),
    '-attach', ctx.tmpPath('font.ttf'),
    '-map', '0:v', '-map', '1:a', '-map_metadata', '2', '-map_chapters', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '3', '-c:a', 'aac', '-b:a', '24k',
    '-cluster_time_limit', '250',
    '-metadata', 'creation_time=2024-05-01T10:00:00Z',
    '-metadata:s:v:0', `title=Main video ${MARK}`,
    '-metadata:s:a:0', 'title=Commentary',
    '-metadata:s:a:0', 'language=fra',
    '-metadata:s:t:0', 'mimetype=image/jpeg',
    '-metadata:s:t:0', 'filename=cover.jpg',
    '-metadata:s:t:1', 'mimetype=application/x-truetype-font',
    '-metadata:s:t:1', 'filename=font.ttf',
    ctx.tmpPath('tagged.mkv'),
  ]);
  ctx.write('tagged.mkv', ctx.read(ctx.tmpPath('tagged.mkv')));

  // Matroska with Cues in front of the clusters and no CRC-32 elements.
  ctx.ffmpeg([
    ...VIDEO,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '3',
    '-cluster_time_limit', '250', '-cues_to_front', '1', '-write_crc32', '0',
    '-metadata', `title=Front ${MARK}`,
    '-metadata', `artist=Jane ${MARK}`,
    ctx.tmpPath('front.mkv'),
  ]);
  const front = ctx.read(ctx.tmpPath('front.mkv'));
  ctx.write('front.mkv', front);
  // …and a copy with a second Tags element appended after the clusters, indexed
  // by a SeekHead rewritten inside its Void padding (as mkvpropedit does).
  ctx.write('tags-at-end.mkv', appendTags(front, `Late ${MARK}`));

  // WebM: VP9 + Opus with tags and chapters.
  ctx.ffmpeg([
    ...VIDEO,
    ...AUDIO,
    '-i', ctx.tmpPath('meta.txt'),
    '-map', '0:v', '-map', '1:a', '-map_metadata', '2', '-map_chapters', '2',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-g', '3', '-c:a', 'libopus', '-b:a', '24k',
    '-cluster_time_limit', '250',
    '-metadata:s:v:0', `title=Camera ${MARK}`,
    '-f', 'webm', ctx.tmpPath('tagged.webm'),
  ]);
  ctx.write('tagged.webm', ctx.read(ctx.tmpPath('tagged.webm')));

  // Audio-only Matroska with cover art.
  ctx.ffmpeg([
    ...AUDIO,
    '-attach', ctx.tmpPath('cover.jpg'),
    '-c:a', 'libopus', '-b:a', '24k',
    '-metadata', `title=Song ${MARK}`,
    '-metadata', `artist=Singer ${MARK}`,
    '-metadata', 'album=Album',
    '-metadata:s:t:0', 'mimetype=image/jpeg',
    '-metadata:s:t:0', 'filename=cover.jpg',
    ctx.tmpPath('audio.mka'),
  ]);
  ctx.write('audio.mka', ctx.read(ctx.tmpPath('audio.mka')));

  // Live WebM: written to a pipe (unknown-size Segment, no Cues), then every
  // Cluster size is turned into "unknown" as MediaRecorder does.
  const live = ctx.run('ffmpeg', [
    '-v', 'error', ...VIDEO,
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-g', '3',
    '-cluster_time_limit', '250', '-metadata', `title=Live ${MARK}`,
    '-f', 'webm', 'pipe:1',
  ]);
  ctx.write('live.webm', unknownClusterSizes(new Uint8Array(live)));

  // AVI: MJPEG + PCM with a RIFF INFO list (ffmpeg adds ISFT).
  ctx.ffmpeg([
    ...VIDEO,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=8000',
    '-c:v', 'mjpeg', '-q:v', '20', '-c:a', 'pcm_u8',
    '-metadata', `title=Clip ${MARK}`,
    '-metadata', `artist=Jane ${MARK}`,
    '-metadata', `comment=Holiday ${MARK}`,
    '-metadata', 'copyright=(c) 2024 Jane',
    '-metadata', 'date=2024-05-01',
    '-metadata', 'genre=Home video',
    ctx.tmpPath('tagged.avi'),
  ]);
  const avi = ctx.read(ctx.tmpPath('tagged.avi'));
  ctx.write('tagged.avi', avi);

  // Camera-style AVI: IDIT in hdrl, vendor 'strd' in the video stream, 'strn'
  // stream name — carved out of ffmpeg's JUNK placeholders so movi never moves.
  ctx.write('camera.avi', cameraAvi(avi));

  // Bit-exact AVI without any INFO list (new INFO must be hosted in JUNK).
  ctx.ffmpeg([...VIDEO, '-c:v', 'mjpeg', '-q:v', '20', '-fflags', '+bitexact', '-flags', '+bitexact', ctx.tmpPath('bare.avi')]);
  ctx.write('bare.avi', ctx.read(ctx.tmpPath('bare.avi')));

  ctx.cleanup();
}

// ------------------------------------------------------------------- EBML

function vint(b, p) {
  let len = 1;
  while (len <= 8 && !(b[p] & (0x80 >> (len - 1)))) len++;
  return len;
}

/** Rewrite each top-level Cluster's size field as "unknown" (same width). */
function unknownClusterSizes(b) {
  const out = b.slice();
  const readSize = (p, n) => {
    let v = out[p] & (0xff >> n);
    for (let i = 1; i < n; i++) v = v * 256 + out[p + i];
    return v;
  };
  // EBML header
  let p = 0;
  let il = vint(out, p);
  let sl = vint(out, p + il);
  p += il + sl + readSize(p + il, sl);
  // Segment header (unknown size already)
  il = vint(out, p);
  sl = vint(out, p + il);
  p += il + sl;
  while (p < out.length) {
    il = vint(out, p);
    sl = vint(out, p + il);
    const id = Buffer.from(out.subarray(p, p + il)).toString('hex');
    const size = readSize(p + il, sl);
    if (id === '1f43b675') {
      out[p + il] = (0x80 >> (sl - 1)) | (0xff >> sl);
      for (let i = 1; i < sl; i++) out[p + il + i] = 0xff;
    }
    p += il + sl + size;
  }
  return out;
}

const ebmlId = (hex) => Buffer.from(hex, 'hex');
function size8(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  b[0] = 0x01;
  return b;
}
/** Shortest EBML size vint (sizes used here stay below 2^14). */
const vsize = (n) => (n < 127 ? Buffer.from([0x80 | n]) : n < 16383 ? Buffer.from([0x40 | (n >> 8), n & 0xff]) : size8(n));
const el = (hex, ...payload) => {
  const p = Buffer.concat(payload);
  return Buffer.concat([ebmlId(hex), vsize(p.length), p]);
};
const uint = (hex, n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return el(hex, b);
};
const str = (hex, s) => el(hex, Buffer.from(s, 'utf8'));

/** Top-level children between start and end: [{ id, pos, end, data }]. */
function ebmlChildren(b, start, end) {
  const out = [];
  let p = start;
  while (p < end) {
    const il = vint(b, p);
    const sl = vint(b, p + il);
    let size = b[p + il] & (0xff >> sl);
    for (let i = 1; i < sl; i++) size = size * 256 + b[p + il + i];
    const id = Buffer.from(b.subarray(p, p + il)).toString('hex');
    out.push({ id, pos: p, end: p + il + sl + size, data: b.subarray(p + il + sl, p + il + sl + size) });
    p += il + sl + size;
  }
  return out;
}

function appendTags(src, comment) {
  const b = Buffer.from(src);
  const [ebml] = ebmlChildren(b, 0, b.length);
  const segData = ebml.end + 12; // ffmpeg writes an 8-byte Segment size
  const top = ebmlChildren(b, segData, b.length);
  const [seekHead, pad] = top;
  if (seekHead.id !== '114d9b74' || pad.id !== 'ec') throw new Error('unexpected layout');
  const entries = ebmlChildren(seekHead.data, 0, seekHead.data.length)
    .filter((e) => e.id === '4dbb')
    .map((e) => {
      const [sid, spos] = ebmlChildren(e.data, 0, e.data.length);
      return [Buffer.from(sid.data).toString('hex'), Number(Buffer.from(spos.data).readUIntBE(0, spos.data.length))];
    });
  const tags = el('1254c367', el('7373', el('63c0'), el('67c8', str('45a3', 'COMMENT'), str('4487', comment))));
  entries.push(['1254c367', b.length - segData]);
  const sh = el('114d9b74', ...entries.map(([id, pos]) => el('4dbb', el('53ab', ebmlId(id)), uint('53ac', pos))));
  const room = pad.end - seekHead.pos - sh.length;
  const out = Buffer.concat([b.subarray(0, seekHead.pos), sh, Buffer.from([0xec]), size8(room - 9), Buffer.alloc(room - 9), b.subarray(pad.end), tags]);
  out.set(size8(out.length - segData), ebml.end + 4);
  return new Uint8Array(out);
}

// -------------------------------------------------------------------- RIFF

function chunks(b, start, end) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    const id = Buffer.from(b.subarray(p, p + 4)).toString('latin1');
    const size = dv.getUint32(p + 4, true);
    const type = id === 'LIST' || id === 'RIFF' ? Buffer.from(b.subarray(p + 8, p + 12)).toString('latin1') : '';
    out.push({ id, type, pos: p, size });
    p += 8 + size + (size & 1);
  }
  return out;
}

function chunk(id, data) {
  const pad = data.length & 1;
  const out = new Uint8Array(8 + data.length + pad);
  out.set(Buffer.from(id, 'latin1'), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

/** Replace a JUNK chunk with `payload` chunk + smaller JUNK of the same total size. */
function carve(b, junk, payload) {
  const total = 8 + junk.size;
  if (payload.length + 8 > total) throw new Error('JUNK too small');
  b.set(payload, junk.pos);
  b.set(chunk('JUNK', new Uint8Array(total - payload.length - 8)), junk.pos + payload.length);
}

function cameraAvi(src) {
  const b = src.slice();
  const hdrl = chunks(b, 12, b.length).find((c) => c.type === 'hdrl');
  const inHdrl = chunks(b, hdrl.pos + 12, hdrl.pos + 8 + hdrl.size);
  const strls = inHdrl.filter((c) => c.type === 'strl');
  const hdrlJunk = inHdrl.find((c) => c.id === 'JUNK');
  carve(b, hdrlJunk, chunk('IDIT', Buffer.from('Mon May 01 10:20:30 2023\n\0', 'latin1')));

  // strd: "AVIF" + pad + little-endian IFD { Make = "Cam" } + vendor bytes
  const ifd = new Uint8Array(2 + 12 + 4);
  const dv = new DataView(ifd.buffer);
  dv.setUint16(0, 1, true);
  dv.setUint16(2, 0x010f, true);
  dv.setUint16(4, 2, true);
  dv.setUint32(6, 4, true);
  ifd.set(Buffer.from('Cam\0', 'latin1'), 10);
  const strd = Buffer.concat([Buffer.from('AVIF\0\0\0\0', 'latin1'), ifd, Buffer.from(`serial ${MARK}`, 'latin1')]);
  const videoJunk = chunks(b, strls[0].pos + 12, strls[0].pos + 8 + strls[0].size).find((c) => c.id === 'JUNK');
  carve(b, videoJunk, chunk('strd', strd));

  const audioJunk = chunks(b, strls[1].pos + 12, strls[1].pos + 8 + strls[1].size).find((c) => c.id === 'JUNK');
  carve(b, audioJunk, chunk('strn', Buffer.from(`Audio ${MARK}\0`, 'latin1')));
  return b;
}
