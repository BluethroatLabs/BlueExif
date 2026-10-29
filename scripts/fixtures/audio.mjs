// Audio fixtures: MP3 (ID3v2.2/2.3/2.4, ID3v1, APE, Lyrics3), FLAC, Ogg
// (Vorbis, Opus, FLAC), WAV (INFO, bext, id3, iXML, XMP, RF64) and AIFF/AIFC.
// Rich or exotic tags are assembled by hand below (independently of the
// engine) on top of ffmpeg-encoded ~0.5 s mono audio.
import { deflateSync } from 'node:zlib';

const MARK = 'SECRET-MARKER-42';

// ------------------------------------------------------------ byte helpers
const enc = new TextEncoder();
const latin1 = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u8 = (...b) => Uint8Array.from(b);
const be32 = (n) => u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const le32 = (n) => u8(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
const be16 = (n) => u8((n >> 8) & 255, n & 255);
const ss = (n) => u8((n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127);
const utf16bom = (s) => {
  const out = [0xff, 0xfe];
  for (const c of s) {
    for (let i = 0; i < c.length; i++) out.push(c.charCodeAt(i) & 255, c.charCodeAt(i) >> 8);
  }
  return Uint8Array.from(out);
};
const b64 = (b) => Buffer.from(b).toString('base64');

// ----------------------------------------------------------------- ID3v2
/** Frame for v2.3/2.4; opts.flags (2 bytes), opts.v = 3|4 */
function frame(v, id, body, flags = 0) {
  return cat(latin1(id), v === 4 ? ss(body.length) : be32(body.length), be16(flags), body);
}
const t0 = (s) => cat(u8(0), latin1(s)); // Latin-1 text
const t1 = (s) => cat(u8(1), utf16bom(s)); // UTF-16 text
const t3 = (...vals) => cat(u8(3), enc.encode(vals.join('\0'))); // UTF-8 multi-value
function unsync(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b[i]);
    if (b[i] === 0xff && (i + 1 === b.length || b[i + 1] >= 0xe0 || b[i + 1] === 0)) out.push(0);
  }
  return Uint8Array.from(out);
}
function id3(v, frames, { flags = 0, footer = false, padding = 0 } = {}) {
  const body = cat(...frames, new Uint8Array(padding));
  const f = flags | (footer ? 0x10 : 0);
  const head = cat(latin1('ID3'), u8(v, 0, f), ss(body.length));
  return footer ? cat(head, body, latin1('3DI'), u8(v, 0, f), ss(body.length)) : cat(head, body);
}
function apic(v, mime, type, desc, data) {
  return frame(v, 'APIC', cat(u8(0), latin1(mime), u8(0, type), latin1(desc), u8(0), data));
}
function comm(v, lang, desc, text) {
  return frame(v, 'COMM', cat(u8(0), latin1(lang), latin1(desc), u8(0), latin1(text)));
}

// ------------------------------------------------------------- trailers
function apeTag(items) {
  const body = cat(...items.map(([k, v]) => cat(le32(enc.encode(v).length), le32(0), latin1(k), u8(0), enc.encode(v))));
  const block = (flags) => cat(latin1('APETAGEX'), le32(2000), le32(body.length + 32), le32(items.length), le32(flags), new Uint8Array(8));
  return cat(block(0xa0000000), body, block(0x80000000));
}
function lyrics3(text) {
  const fields = `IND0000210LYR${String(text.length).padStart(5, '0')}${text}`;
  const body = `LYRICSBEGIN${fields}`;
  return latin1(`${body}${String(body.length).padStart(6, '0')}LYRICS200`);
}
function id3v1({ title = '', artist = '', album = '', year = '', comment = '', track = 0, genre = 255 }) {
  const t = new Uint8Array(128);
  t.set(latin1('TAG'));
  t.set(latin1(title).subarray(0, 30), 3);
  t.set(latin1(artist).subarray(0, 30), 33);
  t.set(latin1(album).subarray(0, 30), 63);
  t.set(latin1(year).subarray(0, 4), 93);
  t.set(latin1(comment).subarray(0, 28), 97);
  t[126] = track;
  t[127] = genre;
  return t;
}

// ------------------------------------------------------------------ FLAC
function flacPicture(type, mime, desc, w, h, data) {
  const d = enc.encode(desc);
  return cat(be32(type), be32(mime.length), latin1(mime), be32(d.length), d, be32(w), be32(h), be32(24), be32(0), be32(data.length), data);
}
function vorbisComment(vendor, pairs) {
  const v = enc.encode(vendor);
  return cat(le32(v.length), v, le32(pairs.length), ...pairs.map(([k, val]) => {
    const s = enc.encode(`${k}=${val}`);
    return cat(le32(s.length), s);
  }));
}
/** Split a native FLAC file into [blocks, audio]. */
function flacBlocks(b) {
  let p = 4;
  const blocks = [];
  for (;;) {
    const last = b[p] & 0x80;
    const type = b[p] & 0x7f;
    const len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    blocks.push({ type, data: b.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
    if (last) break;
  }
  return { blocks, audio: b.subarray(p) };
}
function flacJoin(blocks, audio) {
  const parts = [latin1('fLaC')];
  blocks.forEach((bl, i) => {
    const n = bl.data.length;
    parts.push(u8((i === blocks.length - 1 ? 0x80 : 0) | bl.type, (n >> 16) & 255, (n >> 8) & 255, n & 255), bl.data);
  });
  return cat(...parts, audio);
}

// ------------------------------------------------------------- RIFF/AIFF
const pad2 = (b) => (b.length & 1 ? cat(b, u8(0)) : b);
const riffChunk = (id, data) => cat(latin1(id), le32(data.length), pad2(data));
const aiffChunk = (id, data) => cat(latin1(id), be32(data.length), pad2(data));
/** Insert chunks into a RIFF/FORM file before the chunk `beforeId` (or append) and fix the outer size. */
function addChunks(file, chunks, { be = false, beforeId = null } = {}) {
  const rd = (p) => (be ? (file[p] << 24) | (file[p + 1] << 16) | (file[p + 2] << 8) | file[p + 3] : file[p] | (file[p + 1] << 8) | (file[p + 2] << 16) | (file[p + 3] << 24)) >>> 0;
  let p = 12;
  let at = file.length;
  while (p + 8 <= file.length) {
    const id = String.fromCharCode(...file.subarray(p, p + 4));
    if (id === beforeId) {
      at = p;
      break;
    }
    p += 8 + rd(p + 4) + (rd(p + 4) & 1);
  }
  const out = cat(file.subarray(0, at), ...chunks, file.subarray(at));
  const size = out.length - 8;
  out.set(be ? be32(size) : le32(size), 4);
  return out;
}

const XMP = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
<dc:creator><rdf:Seq><rdf:li>Jane Doe</rdf:li></rdf:Seq></dc:creator>
<xmp:CreatorTool>Adobe Audition 24.0</xmp:CreatorTool>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;

export default async function (ctx) {
  const sine = (rate, d = 0.5) => ['-f', 'lavfi', '-i', `sine=f=440:d=${d}:r=${rate}`];
  const meta = (o) => Object.entries(o).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
  const tmp = (n) => ctx.tmpPath(n);

  ctx.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=64x64', '-frames:v', '1', '-q:v', '8', '-flags', '+bitexact', tmp('cover.jpg')]);
  const cover = ctx.read(tmp('cover.jpg'));
  const common = {
    title: 'Test Song',
    artist: 'Zoë Smith',
    album: 'Demo Album',
    date: '2024-05-01',
    genre: 'Rock',
    track: '3/12',
    comment: MARK,
    copyright: '2024 Jane Doe',
    encoded_by: 'Studio Person',
  };

  // ------------------------------------------------------------------ MP3
  const lame = ['-c:a', 'libmp3lame', '-b:a', '32k', '-ac', '1'];
  ctx.ffmpeg([...sine(32000), ...lame, '-id3v2_version', '0', '-write_xing', '1', tmp('plain.mp3')]);
  const plainMp3 = ctx.read(tmp('plain.mp3'));
  ctx.write('plain.mp3', plainMp3);

  // ffmpeg: ID3v2.3 + ID3v1 + attached picture
  ctx.ffmpeg([...sine(32000), '-i', tmp('cover.jpg'), ...lame, '-map', '0', '-map', '1', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic',
    '-id3v2_version', '3', '-write_id3v1', '1', ...meta(common), tmp('v23.mp3')]);
  ctx.write('v23.mp3', ctx.read(tmp('v23.mp3')));

  // ffmpeg: ID3v2.4, VBR (Xing header)
  ctx.ffmpeg([...sine(22050), '-c:a', 'libmp3lame', '-q:a', '7', '-ac', '1', '-id3v2_version', '4', ...meta(common), tmp('v24.mp3')]);
  ctx.write('v24.mp3', ctx.read(tmp('v24.mp3')));

  // Hand-made rich ID3v2.3: unsynchronised, compressed frame,
  // COMM/USLT/TXXX/W***/APIC/POPM/PRIV/UFID/GEOB/TOWN, plus APE + Lyrics3 + ID3v1.
  const v = 3;
  const compressed = deflateSync(Buffer.from(t0('A compressed subtitle')));
  const rich = id3(
    v,
    [
      frame(v, 'TIT2', t0('Rich Title')),
      frame(v, 'TPE1', t1('Zoë Smith')),
      frame(v, 'TALB', t0('Rich Album')),
      frame(v, 'TYER', t0('2023')),
      frame(v, 'TDAT', t0('2412')),
      frame(v, 'TIME', t0('2015')),
      frame(v, 'TCON', t0('(17)')),
      frame(v, 'TRCK', t0('7/9')),
      frame(v, 'TIT3', cat(be32(t0('A compressed subtitle').length), compressed), 0x0080),
      frame(v, 'TOWN', t0(`Owner ${MARK}`)),
      frame(v, 'TENC', t0('Encoder Person')),
      frame(v, 'TSSE', t0('LAME 3.100 -V2')),
      comm(v, 'eng', '', `Comment ${MARK}`),
      comm(v, 'eng', 'iTunNORM', ' 00000001 00000002'),
      frame(v, 'USLT', cat(u8(0), latin1('eng'), u8(0), latin1('Some lyrics\nline two'))),
      frame(v, 'TXXX', cat(u8(0), latin1('MusicBrainz Album Id'), u8(0), latin1('abc-123'))),
      frame(v, 'WOAR', latin1('https://artist.example')),
      frame(v, 'WXXX', cat(u8(0), latin1('shop'), u8(0), latin1('https://shop.example'))),
      apic(v, 'image/jpeg', 3, 'front', cover),
      frame(v, 'POPM', cat(latin1('jane@example.com'), u8(0, 196, 0, 0, 0, 5))),
      frame(v, 'PRIV', cat(latin1('www.amazon.com'), u8(0), latin1(`customer=${MARK}`))),
      frame(v, 'UFID', cat(latin1('http://musicbrainz.org'), u8(0), latin1('0d8f-1234'))),
      frame(v, 'GEOB', cat(u8(0), latin1('text/plain'), u8(0), latin1('notes.txt'), u8(0), latin1('notes'), u8(0), latin1('hello'))),
    ],
  );
  // Apply tag-level unsynchronisation to the body (header stays plain).
  const richBody = unsync(rich.subarray(10));
  const richTag = cat(latin1('ID3'), u8(3, 0, 0x80), ss(richBody.length), richBody);
  const richMp3 = cat(
    richTag,
    plainMp3,
    apeTag([['Title', 'Ape Title'], ['Artist', `Ape ${MARK}`]]),
    lyrics3(`Lyrics3 ${MARK}`),
    id3v1({ title: 'V1 Title', artist: 'V1 Artist', album: 'V1 Album', year: '2023', comment: `V1 ${MARK}`, track: 7, genre: 17 }),
  );
  ctx.write('rich.mp3', richMp3);

  // ID3v2.2 tag followed by a stacked ID3v2.3 tag.
  const f22 = (id, body) => cat(latin1(id), u8((body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255), body);
  const v22 = cat(
    latin1('ID3'),
    u8(2, 0, 0),
    ss(0), // patched below
  );
  const v22body = cat(
    f22('TT2', t0('Old Title')),
    f22('TP1', t0('Old Artist')),
    f22('TAL', t0('Old Album')),
    f22('TYE', t0('1999')),
    f22('TCO', t0('(13)')),
    f22('COM', cat(u8(0), latin1('eng'), u8(0), latin1(`Old ${MARK}`))),
    f22('PIC', cat(u8(0), latin1('JPG'), u8(3), latin1('cover'), u8(0), cover)),
    new Uint8Array(32),
  );
  v22.set(ss(v22body.length), 6);
  const stacked = id3(3, [frame(3, 'TPE2', t0('Stacked Album Artist')), frame(3, 'TIT2', t0('Stacked Title'))]);
  ctx.write('v22.mp3', cat(v22, v22body, stacked, plainMp3));

  // ID3v2.4: extended header, frame-level unsync + data length indicator, UTF-8 multi-values,
  // numeric genre, TDRC timestamp; appended copy with footer at the end.
  const apicBody = cat(u8(0), latin1('image/jpeg'), u8(0, 3), u8(0), cover);
  const uns = unsync(apicBody);
  const v24 = id3(4, [
    u8(0, 0, 0, 6, 1, 0), // extended header (size incl. itself, 1 flag byte, no flags)
    frame(4, 'TIT2', t3('Vier')),
    frame(4, 'TPE1', t3('Anna', 'Bert')),
    frame(4, 'TCON', t3('17', 'Synthwave')),
    frame(4, 'TDRC', t3('2022-03-04T05:06:07')),
    frame(4, 'TXXX', cat(u8(3), enc.encode('MOOD\0calm'))),
    frame(4, 'APIC', cat(ss(apicBody.length), uns), 0x0002 | 0x0001),
  ], { padding: 64, flags: 0x40 });
  ctx.write('v24-unsync.mp3', cat(v24, plainMp3));
  const footerTag = id3(4, [frame(4, 'TIT2', t3('Appended')), frame(4, 'TPE1', t3(`Tail ${MARK}`))], { footer: true });
  ctx.write('appended.mp3', cat(plainMp3, footerTag, id3v1({ title: 'Appended', track: 1, genre: 12 })));

  // ----------------------------------------------------------------- FLAC
  ctx.ffmpeg([...sine(8000), '-i', tmp('cover.jpg'), '-c:a', 'flac', '-ac', '1', '-map', '0', '-map', '1', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic',
    ...meta({ ...common, LOCATION: 'Berlin, Germany', CONTACT: 'jane@example.com', ISRC: 'USRC17607839' }), tmp('tagged.flac')]);
  ctx.write('tagged.flac', ctx.read(tmp('tagged.flac')));
  ctx.ffmpeg([...sine(8000), '-c:a', 'flac', '-ac', '1', '-fflags', '+bitexact', tmp('plain.flac')]);
  const plainFlac = ctx.read(tmp('plain.flac'));
  ctx.write('plain.flac', plainFlac);
  // Hand-made: prepended ID3v2 tag, repeated ARTIST, APPLICATION block, picture, small padding.
  {
    const { blocks, audio } = flacBlocks(plainFlac);
    const si = blocks.find((b) => b.type === 0);
    const vc = vorbisComment('reference libFLAC 1.4.3 20230623', [
      ['TITLE', 'Multi'],
      ['ARTIST', 'First Artist'],
      ['artist', 'Second Artist'],
      ['DATE', '2021'],
      ['COMMENT', MARK],
      ['ENCODER', 'SecretEncoder 9'],
    ]);
    const out = flacJoin(
      [
        si,
        { type: 3, data: new Uint8Array(18) }, // SEEKTABLE with one placeholder point
        { type: 4, data: vc },
        { type: 2, data: cat(latin1('ATCH'), latin1(`app ${MARK}`)) },
        { type: 6, data: flacPicture(4, 'image/jpeg', 'back', 64, 64, cover) },
        { type: 1, data: new Uint8Array(100) },
      ],
      audio,
    );
    const id3tag = id3(3, [frame(3, 'TIT2', t0('ID3 in FLAC')), frame(3, 'TPE1', t0(`ID3 ${MARK}`))]);
    const fixed = cat(id3tag, out);
    // Make the SEEKTABLE entry a placeholder point.
    const st = id3tag.length + 4 + 4 + 34 + 4;
    fixed.fill(0xff, st, st + 8);
    ctx.write('id3.flac', fixed);
  }

  // ------------------------------------------------------------------ Ogg
  const mbp = b64(flacPicture(3, 'image/jpeg', 'Cover', 64, 64, cover));
  ctx.ffmpeg([...sine(8000), '-c:a', 'vorbis', '-strict', '-2', '-ac', '2', ...meta({ ...common, LOCATION: 'Paris', METADATA_BLOCK_PICTURE: mbp }), tmp('vorbis.ogg')]);
  ctx.write('vorbis.ogg', ctx.read(tmp('vorbis.ogg')));
  ctx.ffmpeg([...sine(8000), '-c:a', 'libopus', '-b:a', '16k', '-ac', '1', ...meta({ ...common, METADATA_BLOCK_PICTURE: mbp }), tmp('opus.opus')]);
  ctx.write('opus.opus', ctx.read(tmp('opus.opus')));
  ctx.ffmpeg([...sine(8000), '-c:a', 'flac', '-ac', '1', ...meta(common), '-f', 'ogg', tmp('flac.oga')]);
  ctx.write('flac.oga', ctx.read(tmp('flac.oga')));

  // ------------------------------------------------------------------ WAV
  const wavInfo = { title: 'Wave Title', artist: 'Jane Doe', album: 'Wave Album', comment: MARK, copyright: '2024 Jane Doe', genre: 'Speech', date: '2024-05-01', encoded_by: 'Tech Person' };
  ctx.ffmpeg([...sine(8000), '-c:a', 'pcm_s16le', '-fflags', '+bitexact', tmp('plain.wav')]);
  ctx.write('plain.wav', ctx.read(tmp('plain.wav')));
  ctx.ffmpeg([...sine(8000), '-c:a', 'pcm_s16le', '-write_bext', '1', ...meta({
    ...wavInfo,
    description: 'Field recording',
    originator: 'Jane Doe',
    originator_reference: `REF-${MARK}`,
    origination_date: '2024-05-01',
    origination_time: '10:11:12',
    coding_history: 'A=PCM,F=8000,W=16,M=mono,T=SecretRecorder',
  }), tmp('bwf.wav')]);
  {
    const id3chunk = id3(3, [frame(3, 'TIT2', t0('ID3 Title')), frame(3, 'TPE1', t1('Zoë')), comm(3, 'eng', '', `ID3 ${MARK}`)]);
    const ixml = latin1(`<?xml version="1.0"?><BWFXML><PROJECT>${MARK}</PROJECT><TAPE>T1</TAPE></BWFXML>`);
    const cue = cat(le32(1), le32(1), le32(0), latin1('data'), le32(0), le32(0), le32(400));
    const wav = addChunks(ctx.read(tmp('bwf.wav')), [riffChunk('cue ', cue), riffChunk('iXML', ixml), riffChunk('_PMX', enc.encode(XMP)), riffChunk('abcd', latin1('odd')), riffChunk('id3 ', id3chunk)]);
    ctx.write('bwf.wav', wav);
  }
  ctx.ffmpeg([...sine(8000), '-c:a', 'pcm_s16le', '-rf64', 'always', ...meta({ title: 'RF64 Title', comment: MARK }), tmp('rf64.wav')]);
  ctx.write('rf64.wav', ctx.read(tmp('rf64.wav')));

  // ----------------------------------------------------------------- AIFF
  ctx.ffmpeg([...sine(8000), '-c:a', 'pcm_s16be', '-write_id3v2', '1', ...meta({ ...common, author: 'Jane Doe' }), tmp('tagged.aiff')]);
  {
    const comt = cat(be16(1), be32(3_800_000_000), be16(0), be16(`Note ${MARK}`.length), latin1(`Note ${MARK}`));
    const appl = cat(latin1('pdos'), latin1(`app ${MARK}`));
    const aiff = addChunks(ctx.read(tmp('tagged.aiff')), [aiffChunk('COMT', comt), aiffChunk('APPL', appl), aiffChunk('ANNO', latin1('Second annotation'))], { be: true, beforeId: 'SSND' });
    ctx.write('tagged.aiff', aiff);
  }
  ctx.ffmpeg([...sine(8000), '-c:a', 'pcm_s16le', ...meta({ title: 'AIFC Title', comment: MARK }), '-f', 'aiff', tmp('sowt.aifc')]);
  ctx.write('sowt.aifc', ctx.read(tmp('sowt.aifc')));
  ctx.ffmpeg([...sine(8000), '-c:a', 'pcm_s16be', '-fflags', '+bitexact', tmp('plain.aiff')]);
  ctx.write('plain.aiff', ctx.read(tmp('plain.aiff')));

  ctx.cleanup();
}
