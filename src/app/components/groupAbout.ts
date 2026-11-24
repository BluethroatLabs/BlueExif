/**
 * Plain-language explanations for the field groups the engine produces, shown
 * in each section's "About" dialog. Two layers:
 *  - the section itself (what these particular fields are), and
 *  - the standard it belongs to (what EXIF, Dublin Core, ID3… actually are).
 *
 * Lookups go by group id first, then by label, so new groups from the engine
 * still get a sensible (if generic) explanation.
 */
import type { FieldGroup } from '../../engine/core/types';

export interface AboutText {
  /** What this section holds, in one or two sentences. */
  what: string;
  /** Optional "good to know" about editing or removing it. */
  tip?: string;
}

export interface GroupAbout extends AboutText {
  /** The standard / container the section belongs to, when worth explaining separately. */
  standard?: { name: string; text: string };
}

// ------------------------------------------------------------- standards

const STD = {
  exif: {
    name: 'EXIF',
    text: 'EXIF (Exchangeable Image File Format) is the set of notes a camera or phone writes into every photo: make and model, lens, exposure settings, when it was taken and — if location was on — where. Almost every photo app reads and keeps it.',
  },
  xmp: {
    name: 'XMP',
    text: 'XMP (Extensible Metadata Platform) is an Adobe-created format that stores metadata as a small block of XML text inside the file. It is split into namespaces — named vocabularies such as Dublin Core or IPTC — so different apps can add their own fields without clashing. BlueExif shows each namespace as its own section.',
  },
  iptc: {
    name: 'IPTC',
    text: 'IPTC is a standard from the International Press Telecommunications Council, the news-industry body. This older IIM (Information Interchange Model) block was designed in the 1990s so news photos could carry captions, credits, keywords and copyright. Photoshop and photo agencies still write it.',
  },
  id3v2: {
    name: 'ID3v2',
    text: 'ID3 is the tagging system for MP3 files, also used in some WAV and AIFF files. Version 2 sits at the start of the file and stores title, artist, album, cover art, lyrics and more in small labelled “frames” — TIT2 is the title, APIC a picture, and so on.',
  },
  id3v1: {
    name: 'ID3v1',
    text: 'The original MP3 tag from 1996: a fixed 128-byte block at the very end of the file, with room for only 30 characters per field. It is kept for very old players and usually duplicates the ID3v2 tag.',
  },
  ape: {
    name: 'APE tags',
    text: 'APE tags come from the Monkey’s Audio format and also turn up in Musepack and some MP3 files. They sit at the end of the file and store free-form “name = value” text.',
  },
  lyrics3: {
    name: 'Lyrics3',
    text: 'An old add-on format that stores song lyrics (and sometimes extra tags) just before the ID3v1 tag at the end of an MP3. Few modern players read it.',
  },
  vorbis: {
    name: 'Vorbis comments',
    text: 'Vorbis comments are the tags used by FLAC, Ogg Vorbis and Opus files: simple NAME=value text pairs such as ARTIST=… or DATE=…. Any name is allowed, so encoders and taggers sometimes add their own.',
  },
  riffInfo: {
    name: 'RIFF INFO',
    text: 'RIFF is the container behind WAV and AVI files. Its INFO list holds short text tags named by four-letter codes, such as INAM (name), IART (artist), ICRD (creation date) or ISFT (software).',
  },
  riff: {
    name: 'RIFF',
    text: 'RIFF is the container behind WAV and AVI files: the file is a sequence of labelled chunks, and players simply skip the chunks they do not understand.',
  },
  bwf: {
    name: 'Broadcast Wave',
    text: 'Broadcast Wave Format (BWF) is a WAV extension from the European Broadcasting Union. Its “bext” chunk records who made a recording, on what equipment, when, and a timecode. It is mostly used in radio, TV and film production.',
  },
  aiff: {
    name: 'AIFF',
    text: 'AIFF is Apple’s uncompressed audio format. Besides the sound it can hold small text chunks for the name, author, copyright and free-form annotations.',
  },
  flac: {
    name: 'FLAC',
    text: 'FLAC is a lossless audio format. Alongside the audio it stores “metadata blocks”: tags, pictures, seek tables, cue sheets, padding and app-specific data.',
  },
  mp4Ilst: {
    name: 'iTunes-style tags',
    text: 'The “ilst” list is the tag set inside MP4 and M4A files — title, artist, album, artwork and so on. Apple popularised it with iTunes and nearly every player reads it.',
  },
  qtKeys: {
    name: 'QuickTime metadata keys',
    text: 'Apple’s newer QuickTime metadata, written by iPhones and Macs. Entries have readable names such as com.apple.quicktime.make or com.apple.quicktime.location.ISO6709.',
  },
  quicktime: {
    name: 'QuickTime / MP4',
    text: 'QuickTime is Apple’s movie format and the basis of MP4. Files are built from nested “boxes” (also called atoms); some hold the video and sound, others hold dates, names and tags.',
  },
  heif: {
    name: 'HEIF',
    text: 'HEIF is the modern image format used for iPhone photos (.heic) and AVIF. It is built from the same box structure as MP4 and can carry EXIF and XMP just like a JPEG.',
  },
  matroska: {
    name: 'Matroska / WebM',
    text: 'Matroska (.mkv, .mka) is an open media container; WebM is a trimmed-down version of it for the web. It stores general segment information, a list of tracks, optional tags and attached files such as fonts or cover art.',
  },
  ooxml: {
    name: 'Office Open XML',
    text: 'Office Open XML is the format behind Word (.docx), Excel (.xlsx) and PowerPoint (.pptx). Each file is really a zip archive of XML parts; the metadata lives in a few of those parts.',
  },
  odf: {
    name: 'OpenDocument',
    text: 'OpenDocument (ODF) is the open standard used by LibreOffice and others (.odt, .ods, .odp). Like Office files it is a zip of XML parts, and meta.xml holds the document properties.',
  },
  epub: {
    name: 'EPUB',
    text: 'EPUB is the standard e-book format: a zip of web pages plus a “package” (OPF) file describing the book. That package uses Dublin Core fields for the title, author, publisher and so on.',
  },
  pdfInfo: {
    name: 'PDF Info dictionary',
    text: 'The Info dictionary is the PDF format’s original, built-in property list: Title, Author, Subject, Keywords, Creator (the app that made the content), Producer (the app that wrote the PDF) and dates. Newer PDFs also copy these into XMP.',
  },
  pdf: {
    name: 'PDF',
    text: 'PDF (Portable Document Format) is a page-description format. Besides the pages it can hold properties, XMP metadata, signatures, attachments and other embedded objects.',
  },
  svg: {
    name: 'SVG',
    text: 'SVG is a vector image format written as XML text. Because it is plain text, editors often leave extra information inside it — titles, licence blocks and their own settings.',
  },
  png: {
    name: 'PNG',
    text: 'PNG is a lossless image format made of chunks. Text chunks (tEXt, zTXt, iTXt) store keyword/value notes; other chunks can hold EXIF, XMP or a colour profile.',
  },
  jpeg: {
    name: 'JPEG',
    text: 'JPEG is the most common photo format. Besides the image it carries “segments”: APP1 for EXIF and XMP, APP13 for IPTC, COM for plain comments, plus others from camera makers and apps.',
  },
  gif: {
    name: 'GIF',
    text: 'GIF is the classic animated image format. Comment extensions hold plain text; application extensions hold things like loop settings or XMP.',
  },
  webp: {
    name: 'WebP',
    text: 'WebP is Google’s image format for the web. It is a RIFF container whose chunks can hold EXIF, XMP and a colour profile alongside the image.',
  },
  tiff: {
    name: 'TIFF',
    text: 'TIFF is a flexible image format used for scans, print and camera RAW files. Its tags are the same system EXIF is built on.',
  },
  avi: {
    name: 'AVI',
    text: 'AVI is Microsoft’s classic video container, built on RIFF. Some cameras store extra information in their own chunks inside it.',
  },
} satisfies Record<string, { name: string; text: string }>;

function standardFor(source: string | undefined): GroupAbout['standard'] {
  if (!source) return undefined;
  const s = source.toLowerCase();
  if (s === 'exif') return STD.exif;
  if (s.startsWith('xmp')) return STD.xmp;
  if (s.startsWith('iptc')) return STD.iptc;
  if (s.startsWith('id3v2')) return STD.id3v2;
  if (s.startsWith('id3v1 /')) return undefined; // FLAC trailers: explained by the section
  if (s.startsWith('id3v1')) return STD.id3v1;
  if (s.startsWith('ape')) return STD.ape;
  if (s === 'lyrics3') return STD.lyrics3;
  if (s === 'vorbis comment' || s === 'opus tags') return STD.vorbis;
  if (s === 'riff info') return STD.riffInfo;
  if (s === 'riff') return STD.riff;
  if (s.startsWith('bwf')) return STD.bwf;
  if (s === 'aiff') return STD.aiff;
  if (s === 'flac' || s === 'ogg flac') return STD.flac;
  if (s.startsWith('mp4 (ilst)')) return STD.mp4Ilst;
  if (s === 'quicktime keys') return STD.qtKeys;
  if (s === 'quicktime' || s === 'mp4') return STD.quicktime;
  if (s.startsWith('heif')) return STD.heif;
  if (s.startsWith('matroska') || s === 'webm') return STD.matroska;
  if (s.startsWith('ooxml')) return STD.ooxml;
  if (s.startsWith('odf')) return STD.odf;
  if (s.startsWith('epub')) return STD.epub;
  if (s === 'pdf info') return STD.pdfInfo;
  if (s === 'pdf') return STD.pdf;
  if (s.startsWith('svg')) return STD.svg;
  if (s === 'png') return STD.png;
  if (s === 'jpeg') return STD.jpeg;
  if (s === 'gif') return STD.gif;
  if (s === 'webp') return STD.webp;
  if (s === 'tiff') return STD.tiff;
  if (s === 'avi') return STD.avi;
  return undefined;
}

// --------------------------------------------------------- EXIF sections

const EXIF_SECTIONS: Record<string, AboutText> = {
  description: {
    what: 'Text that a person or an app added to the photo: a caption, the artist’s name, a copyright notice and similar.',
  },
  dates: {
    what: 'When the photo was taken, when it was digitised and when it was last changed — often to the second, sometimes with the time zone.',
  },
  camera: {
    what: 'The device and software behind the photo: camera or phone make and model, lens, and the editing app. Serial numbers here can tie photos to one specific device.',
  },
  exposure: {
    what: 'The camera settings for the shot: shutter speed, aperture (f-number), ISO, focal length, flash and metering. Useful to photographers, rarely sensitive.',
  },
  image: {
    what: 'Basic facts about the picture: size, resolution, colour space and orientation (which way up it should be shown).',
    tip: 'Removing the orientation can make the photo display sideways.',
  },
  location: {
    what: 'GPS data: where the photo was taken (latitude, longitude, altitude), and sometimes the direction the camera faced and how fast it was moving. For photos taken at home this can reveal an address.',
    tip: 'Removing location is the biggest single privacy win for photos you share.',
  },
  thumbnail: {
    what: 'A small preview image saved alongside the photo. It can still show the original, uncropped picture even after the main image has been edited.',
  },
  other: {
    what: 'Less common EXIF tags, including “maker notes” — private, undocumented data from the camera maker that can include serial numbers and internal settings.',
  },
};

// --------------------------------------------------- XMP namespace sections

const XMP_NS: Record<string, AboutText> = {
  dc: {
    what: 'Dublin Core is a small, widely used set of basic descriptive fields — title, creator, subject (keywords), description, rights, date and a few more. It was created by librarians at a 1995 meeting in Dublin, Ohio, and nearly every app understands it.',
  },
  xmp: {
    what: 'Core XMP fields: which app created the file (CreatorTool), when it was created and modified, and when its metadata last changed. Ratings and colour labels live here too.',
  },
  xmpRights: {
    what: 'Copyright and usage information: whether the work is copyrighted, who owns it, the usage terms and a link to the licence or owner’s web page.',
  },
  xmpMM: {
    what: 'An editing trail: unique document and instance IDs, the original file this one was derived from, and a history of save and convert actions. These IDs can link different versions of a file back to each other.',
  },
  photoshop: {
    what: 'Fields defined by Adobe Photoshop, mostly copies of IPTC fields: headline, credit, source, city, country, instructions and the date the photo was created.',
  },
  tiff: {
    what: 'Basic image facts copied from EXIF/TIFF into XMP: camera make and model, dimensions, orientation and resolution.',
  },
  exif: {
    what: 'EXIF data copied into XMP form: exposure settings, capture dates, flash and sometimes GPS location.',
  },
  exifEX: {
    what: 'Newer EXIF 2.3 fields stored in XMP: lens model and serial number, camera body serial number and the owner’s name.',
  },
  aux: {
    what: 'Adobe’s “auxiliary” camera fields: lens details, lens and camera serial numbers, and firmware version.',
  },
  crs: {
    what: 'The edit settings from Adobe Camera Raw or Lightroom: exposure, contrast, white balance, crop and more. They show how the photo was edited but are otherwise harmless.',
  },
  Iptc4xmpCore: {
    what: 'The modern XMP version of the IPTC news-photo standard: the creator’s contact details, the location shown, scene and subject codes.',
  },
  Iptc4xmpExt: {
    what: 'IPTC Extension: richer fields such as the people and organisations shown, artwork in the picture, model releases and detailed location.',
  },
  plus: {
    what: 'PLUS (Picture Licensing Universal System) fields describing image licences, licensors and model or property releases. Used mainly by stock-photo agencies.',
  },
  pdf: {
    what: 'PDF properties stored in XMP: keywords, the Producer (the app that wrote the PDF) and the PDF version.',
  },
  pdfx: {
    what: 'Custom document properties added by the app or person who made the PDF. The names are free-form, so what is in here varies.',
  },
  pdfaid: {
    what: 'A declaration that this PDF follows PDF/A — the ISO standard for long-term archiving. PDF/A files embed their fonts and avoid anything that could stop them opening in future. “Part” and “conformance” give the level, e.g. PDF/A-2b.',
    tip: 'Removing it does not change how the PDF looks, but archiving systems may stop treating the file as PDF/A.',
  },
  pdfuaid: {
    what: 'A declaration that this PDF follows PDF/UA (“Universal Accessibility”, ISO 14289) — the standard for PDFs that work well with screen readers and other assistive technology: tagged structure, a set reading order and text alternatives for images. “Part” is the version of the standard.',
    tip: 'Removing it does not change the document itself, only the claim that it meets PDF/UA.',
  },
  pdfaExtension: {
    what: 'Descriptions of any custom metadata fields this PDF uses. PDF/A requires these so archives can make sense of fields outside the standard set.',
  },
  xmpDM: {
    what: 'Fields for audio and video: artist, album, track number, tempo, duration and production notes such as scene or take.',
  },
  xmpTPg: {
    what: 'Information about paged documents: page count, the fonts used and the colour plates. Written by apps such as InDesign and Illustrator.',
  },
  xmpNote: {
    what: 'A housekeeping field Adobe uses when the XMP is too big for one block and continues elsewhere in the file.',
  },
  lr: {
    what: 'Adobe Lightroom fields, mainly hierarchical keywords such as Places|France|Paris.',
  },
  GPano: {
    what: 'Google’s Photo Sphere fields for 360° panoramas: the projection type and how the image wraps around.',
  },
  GCamera: {
    what: 'Google camera fields, for example marking a “motion photo” that has a short video attached, or portrait-mode depth data.',
  },
  GContainer: {
    what: 'A list of extra items packed inside the file — such as a motion-photo video or a depth map — and where to find them.',
  },
  hdrgm: {
    what: 'HDR gain-map settings: extra brightness information that lets the photo look brighter on HDR screens while still looking normal on regular ones.',
  },
  'mwg-rs': {
    what: 'Regions marked on the image by a photo manager — usually faces, together with the person’s name. Sensitive, because it names who is in the picture.',
  },
  MicrosoftPhoto: {
    what: 'Fields from Windows Photos / Photo Gallery: ratings, people tags and keywords.',
  },
  digiKam: {
    what: 'Fields from the digiKam photo manager, mainly its tag hierarchy.',
  },
  cc: {
    what: 'Creative Commons licence information: which licence applies and how to credit the author.',
  },
  dcterms: {
    what: 'Dublin Core Terms — an extended version of Dublin Core with fields such as license, modified and rightsHolder.',
  },
  c2pa: {
    what: 'Content Credentials (C2PA): a provenance record describing how the content was made and edited, sometimes noting the use of AI tools.',
  },
  apple_desktop: {
    what: 'Apple fields used by macOS for dynamic desktop wallpapers (which image to show at which time of day).',
  },
  photomechanic: {
    what: 'Fields from Photo Mechanic, a press-photo app: colour class, tagged and preferred flags.',
  },
  prism: {
    what: 'PRISM publishing fields: magazine or journal name, issue, volume and page numbers.',
  },
  xmpBJ: {
    what: 'A “basic job ticket” linking the file to production or print jobs.',
  },
};

// ------------------------------------------------------ other sections

const DATES_HEADER: AboutText = {
  what: 'Creation and modification times stored in the file’s header boxes (movie, track and media headers). Phones and cameras fill these with the recording time.',
};
const EMBEDDED_IMAGES: AboutText = {
  what: 'Pictures placed inside the file. Each one can carry its own metadata — a phone photo pasted into a document may still contain the camera model and GPS location.',
};
const COVER_ART: AboutText = {
  what: 'Pictures stored in the file, usually the album cover. They can be large and may carry their own metadata.',
  tip: 'Keep cover art if you want players to keep showing it.',
};
const COMMENTS: AboutText = {
  what: 'Plain-text comments stored in the file. Some apps and scanners write their name or settings here, and people sometimes leave notes.',
};
const EMBEDDED_DATA: AboutText = {
  what: 'Other blocks of data inside the file that are not ordinary tags — for example colour profiles, app- or maker-specific data and previews. BlueExif lists them so you can see they are there.',
  tip: 'Some of these (like a colour profile) help the file display correctly; the strip options let you keep them.',
};
const OTHER_CHUNKS: AboutText = {
  what: 'Other chunks or blocks in the file that BlueExif does not show as editable tags — app-specific data, padding, cue points and similar.',
};
const RIFF_INFO: AboutText = {
  what: 'Short text tags such as the title, artist, comments, creation date and the software that wrote the file.',
};

const SECTIONS: Record<string, AboutText> = {
  // IPTC
  iptc: {
    what: 'Caption, headline, keywords, byline (photographer), credit, copyright, and where the photo was taken — the fields news agencies use to describe a photo.',
  },
  // Images
  'jpeg.comments': COMMENTS,
  'gif.comments': COMMENTS,
  png: {
    what: 'Keyword/value text notes such as Title, Author, Description, Software or Creation Time. Screenshot tools and image editors often add their name here.',
  },
  'heif.dates': DATES_HEADER,
  // Audio
  id3: { what: 'The main tag: title, artist, album, year, genre, comments, lyrics and other text frames.' },
  'id3.pictures': COVER_ART,
  'id3.other': {
    what: 'Less common ID3 frames: private data from apps and music stores (PRIV), unique file IDs (UFID), play counters, ratings, embedded objects (GEOB) and similar. They are shown but not editable.',
  },
  id3v1: { what: 'A short duplicate of the main tag: title, artist, album, year, comment and genre.' },
  ape: { what: 'Free-form tags such as Title, Artist and Album, plus anything else a tagger chose to write.' },
  'mp3.other': { what: 'A Lyrics3 block near the end of the file, holding lyrics and sometimes extra tags.' },
  vorbis: {
    what: 'The file’s tags: title, artist, album, date, track number and any custom fields. Encoders also leave their name in the vendor string or an ENCODER tag.',
  },
  'vorbis.pictures': COVER_ART,
  'flac.trailing': {
    what: 'Tags found after the audio (ID3v1 or APEv2). They are not part of the FLAC standard — they are usually left behind by other tagging tools, and most FLAC players ignore them.',
  },
  'wav.info': RIFF_INFO,
  'avi.info': RIFF_INFO,
  'wav.bext': {
    what: 'The broadcast description: a text description, the originator (person or organisation) and their reference, the origination date and time, a timecode and coding history.',
  },
  'aiff.text': { what: 'Name, author, copyright and annotation text chunks.' },
  // Video
  'mp4.ilst': { what: 'Tags such as title, artist, album, genre, artwork and the encoding tool.' },
  'mp4.mdta': {
    what: 'Device and capture details written by phones and cameras: make, model, software version, recording location and creation date.',
  },
  'mp4.udta': {
    what: 'Classic QuickTime text atoms such as ©nam (name), ©day (date), ©xyz (location) and ©too (encoder), plus 3GPP tags on phone videos.',
  },
  'mp4.dates': DATES_HEADER,
  'avi.camera': { what: 'Camera details some camcorders and cameras store inside AVI files: make, model and recording settings.' },
  'mkv.info': { what: 'General information about the file: its title, the apps that muxed and wrote it, and the date it was made.' },
  'mkv.tracks': { what: 'Per-track details: names and languages of the video, audio and subtitle tracks.' },
  'mkv.attachments': { what: 'Files bundled inside the video, such as subtitle fonts or cover images.' },
  // Documents
  'pdf.info': {
    what: 'The PDF’s document properties — what you see under File › Properties in a PDF reader: title, author, subject, keywords, the apps that created it, and dates.',
  },
  'pdf.signatures': {
    what: 'Digital signatures applied to the PDF. They include the signer’s name and certificate, and often the time, place and reason for signing.',
    tip: 'Changing a signed PDF invalidates its signatures; removing them makes the PDF unsigned.',
  },
  'pdf.images': EMBEDDED_IMAGES,
  'ooxml.core': {
    what: 'Document properties — what Office shows under File › Info: title, subject, author, who last saved it, revision number and dates.',
  },
  'ooxml.app': {
    what: 'Application properties: which program and version made the file, the company name, total editing time, page and word counts, and the template used.',
  },
  'ooxml.custom': {
    what: 'Extra name/value fields added by a person, a company template or a document-management system — for example sensitivity labels or client IDs.',
  },
  'ooxml.hidden': {
    what: 'Personal information hidden in the document itself rather than its properties: comment and tracked-change authors, people mentioned, printer names and file paths. Office’s “Inspect Document” looks for the same things.',
  },
  'ooxml.media': EMBEDDED_IMAGES,
  'odf.meta': {
    what: 'Document properties from meta.xml: title, subject, keywords, initial author, last editor, dates, total editing time and the app that generated the file.',
  },
  'odf.user': { what: 'Custom (user-defined) properties added by a person or a template.' },
  'odf.media': EMBEDDED_IMAGES,
  'epub.dc': { what: 'The book’s main description: title, author, publisher, language, identifiers such as the ISBN, dates and rights.' },
  'epub.other': { what: 'Other entries in the book’s package file, often added by the tool that made it (such as Calibre).' },
  'epub.media': EMBEDDED_IMAGES,
  'svg.doc': { what: 'The image’s own title and description, which browsers and screen readers can show.' },
  'svg.rdf': {
    what: 'An RDF block inside the image’s <metadata> element, often written by Inkscape: title, creator, date, licence (such as Creative Commons) and similar.',
  },
  'svg.editor': {
    what: 'Settings saved by the editor that made the file (Inkscape, Illustrator, Sketch…): window size, layers, grid and file paths. They are not needed to display the image, and file paths can reveal user names.',
  },
  'svg.images': EMBEDDED_IMAGES,
};

const BY_LABEL: Record<string, AboutText> = {
  'Embedded data': EMBEDDED_DATA,
  'Embedded images': EMBEDDED_IMAGES,
  'Other chunks': OTHER_CHUNKS,
  'Other metadata blocks': OTHER_CHUNKS,
  'Cover art': COVER_ART,
  Comments: COMMENTS,
  Dates: DATES_HEADER,
};

const MKV_TAGS: AboutText = {
  what: 'Free-form tags such as TITLE, ARTIST, DATE_RECORDED or ENCODER, attached either to the whole file or to a single track.',
};

// -------------------------------------------------------------- lookup

export function aboutGroup(g: FieldGroup): GroupAbout {
  const standard = standardFor(g.source);

  if (standard === STD.xmp) {
    if (!g.id.includes('.')) {
      return { what: 'All of the file’s XMP fields, shown together because there are only a few of them.', standard };
    }
    // id is "<prefix>.<namespace prefix>" for known namespaces, "<prefix>.<namespace URI>" otherwise
    const ns = g.id.slice(g.id.indexOf('.') + 1);
    const known = XMP_NS[ns] ?? XMP_NS[g.label];
    if (known) return { ...known, standard };
    return {
      what: `Fields from the “${g.label}” XMP namespace, which BlueExif does not recognise. Apps are free to invent their own namespaces, so this is usually data specific to the app that made the file.${ns.includes('/') || ns.includes(':') ? ` Its identifier is ${ns}.` : ''}`,
      standard,
    };
  }

  if (standard === STD.exif) {
    const key = g.id.slice(g.id.lastIndexOf('.') + 1);
    return { ...(EXIF_SECTIONS[key] ?? EXIF_SECTIONS.other), standard };
  }

  const section = SECTIONS[g.id] ??
    (g.id.startsWith('mkv.tags.') ? MKV_TAGS : undefined) ??
    BY_LABEL[g.label] ?? {
      what: standard ? `Metadata stored in the file’s ${standard.name} data.` : 'Metadata stored in this file.',
    };
  return { ...section, standard };
}
