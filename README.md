# BlueExif

**See and control what your files say about you.** BlueExif is a client-side
metadata viewer, editor and stripper for images, audio, video and documents.
Everything happens in your browser — files are never uploaded.

- **View** EXIF, GPS, XMP, IPTC, ID3, Vorbis comments, QuickTime/iTunes atoms,
  Matroska tags, PDF/Office/OpenDocument properties and more, in plain language.
- **Edit** titles, authors, dates, keywords, comments, GPS coordinates, cover
  art… and add fields that are missing.
- **Strip** everything that isn't needed to display or play the file — in one
  click, for one file or a whole batch. Pixels, audio and video streams are
  copied byte-for-byte, never re-encoded.
- **Privacy summary** flags what each file reveals: location, people, devices,
  dates, software and hidden content (thumbnails, comments, edit history).

## Design

BlueExif uses the Bluethroat Labs design system shared with
[BlueMask](https://bluemask.bluethroatlabs.com/) and
[BlueSkills](https://blueskills.bluethroatlabs.com/): monochrome paper/ink
tokens with dark and light appearances (following the OS until the user picks
one), Geist Mono for interface text, Instrument Serif for display type, square
corners, a 1px ruled grid and 44px touch targets. Fonts are self-hosted and
split by script (`src/app/assets/fonts`, SIL OFL 1.1 — see `src/app/assets/fonts/OFL.txt`,
also shown in the app under “Font licences”).

## Privacy model

- No server, no accounts, no analytics. The production build ships a
  `Content-Security-Policy` that only allows the app's own origin, so the page
  cannot send your files anywhere even by accident.
- The hosted site is the single-file build (below): save the page, or download
  `/blueexif.html`, and that one file runs offline from disk. The multi-file
  `npm run build` instead caches itself with a network-first service worker.
- Processing runs in a Web Worker; large audio/video payloads are carried over
  as zero-copy `Blob` slices instead of being loaded into memory.
- Writers rebuild containers instead of appending: e.g. PDFs are fully
  rewritten so metadata from earlier revisions disappears, and ZIP-based
  documents get normalised entry timestamps when stripped.
- Password-protected PDFs are always saved decrypted, so a copy of a PDF that
  only had an owner password also loses its printing, copying and editing
  restrictions.
- PDF previews (page 1 in the file header and the file list) are drawn by
  [pdf.js](https://mozilla.github.io/pdf.js/) onto a canvas, loaded only once a
  PDF is shown (`src/app/pdfPreview.ts`). No scripts, forms, XFA or annotation
  layer; pdf.js never fetches anything, so non-embedded fonts fall back to
  system fonts (Symbol/Dingbats and CMap-dependent CJK text may be missing),
  JPEG 2000/JBIG2/CCITT images are left out and ICC colours use their alternate
  space. A page that cannot be drawn within 10 s, or comes out blank, keeps the
  document icon.

## Supported formats

| Category | Format | View | Edit | Strip | What's covered |
| -------- | ------ | :--: | :--: | :---: | -------------- |
| Images | JPEG | ✓ | ✓ | ✓ | EXIF + GPS, XMP, IPTC, comments, ICC, MPF/motion-photo trailers, C2PA, JFIF thumbnails, segments between scans |
| | PNG / APNG | ✓ | ✓ | ✓ | text chunks (incl. AI prompts), eXIf, XMP, tIME, ICC, legacy raw profiles |
| | WebP | ✓ | ✓ | ✓ | EXIF, XMP, ICC (simple ↔ extended format conversion) |
| | GIF | ✓ | ✓ | ✓ | comments, XMP, application extensions (looping kept) |
| | HEIC / HEIF / AVIF | ✓ | ✓ | ✓ | EXIF + GPS, XMP, ICC; orientation stays in `irot` |
| | TIFF | ✓ | ✓ | ✓ | EXIF, GPS, XMP, IPTC, ICC, Photoshop blocks, JPEG thumbnails; multi-page |
| | Camera RAW (DNG, CR2, NEF, ARW, ORF, RW2, PEF) | ✓ | | | EXIF, GPS, XMP, maker notes |
| | SVG / SVGZ | ✓ | ✓ | ✓ | title/desc, RDF metadata, Inkscape/Illustrator/Sketch editor data, embedded photos, local file links |
| Audio | MP3 | ✓ | ✓ | ✓ | ID3v2.2–2.4, ID3v1, APEv2, Lyrics3, cover art |
| | FLAC | ✓ | ✓ | ✓ | Vorbis comments, pictures, prepended ID3, appended ID3v1/APEv2 |
| | Ogg Vorbis / Opus / FLAC | ✓ | ✓ | ✓ | comments, cover art (single-stream files) |
| | WAV / RF64 | ✓ | ✓ | ✓ | LIST/INFO, Broadcast WAV (bext), ID3, XMP, iXML |
| | AIFF / AIFC | ✓ | ✓ | ✓ | NAME/AUTH/(c)/ANNO/COMT, ID3 |
| | M4A / M4B | ✓ | ✓ | ✓ | iTunes atoms, cover art, account/purchase data |
| Video | MP4 / MOV / M4V / 3GP | ✓ | ✓ | ✓ | iTunes + QuickTime user data, iPhone location keys, XMP, header dates, GPS/sensor tracks, encoder names |
| | MKV / WebM / MKA | ✓ | ✓ | ✓ | title, dates, tags, track names, attachments (fonts kept) |
| | AVI | ✓ | ✓ | ✓ | INFO list, camera date (IDIT), vendor stream data |
| Documents | PDF | ✓ | ✓ | ✓ | Info + XMP (kept in sync), comment authors, attachments, old revisions, embedded images, signatures, JavaScript, local file links |
| | Word / Excel / PowerPoint | ✓ | ✓ | ✓ | core/app/custom properties, thumbnail, comment & revision authors, paths, embedded images, SharePoint properties, printer settings |
| | OpenDocument (ODT/ODS/ODP/ODG) | ✓ | ✓ | ✓ | meta.xml, thumbnail, printer settings, comment authors, embedded images, version history |
| | EPUB 2/3 | ✓ | ✓ | ✓ | OPF Dublin Core metadata, calibre data (required fields kept), embedded images |

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine and app tests (vitest + ExifTool oracle)
npm run build      # typecheck + production build into dist/
npm run build:single  # one self-contained HTML file in dist-single/
npm run fixtures   # regenerate test fixtures (see below); `-- jpeg audio` for some areas
npm run sample     # regenerate the "Try a sample photo" image (ffmpeg)
npm run icons      # regenerate the app icons in public/ (macOS sips)
```

### Single-file build

```bash
npm run build:single   # → dist-single/blueexif.html
```

Produces one self-contained `blueexif.html` (~3.2 MB, ~1.2 MB gzipped, about
half of it pdf.js for PDF previews) with every script, style, font, image and
the whole engine inlined. Open it straight
from disk (double-click) or drop it on any static host — it makes no requests at
all. Its Content-Security-Policy allows only the inlined code (by SHA-256 hash)
and sets `connect-src 'none'`. Differences from the hosted build: the engine
and pdf.js run on the page instead of in Web Workers (browsers refuse Blob
workers for pages opened from `file://`), so very large files can briefly pause
the interface;
there is no service worker or install-as-app (a single file is offline already).

Fixtures are committed. The media tests also need `ffmpeg`/`ffprobe` on the
PATH for decode and payload-integrity checks; document and WebP oracles (PDFKit,
`textutil`, QuickLook, `webpinfo`) are skipped when unavailable. Regenerating
fixtures needs ffmpeg, Homebrew `webp` tools (`cwebp`, `img2webp`), and macOS
`sips`, `textutil` and `swift`.

### Architecture

```
src/engine/   pure TypeScript metadata engine (no DOM) — see src/engine/README.md
  core/       binary I/O, field model, XML DOM, ZIP rewriter, ISO-BMFF boxes, EBML
  exif/ xmp/ iptc/   shared metadata standards
  formats/    one handler per container format + tests
src/app/      React UI; the engine runs in a Web Worker (engine.worker.ts)
scripts/      fixture, sample-photo and icon generators (ffmpeg, sips, textutil, ExifTool WASM)
fixtures/     tiny generated sample files used by the tests
```

Every format handler implements `read`, `write` and `strip` against one
contract (`src/engine/core/types.ts`). Tests verify every writer with an
independent oracle — [ExifTool](https://exiftool.org) compiled to WebAssembly
— plus ffmpeg/ffprobe decode checks for media, and assert that stripped files
no longer contain marker strings planted in the fixtures.

## Deployment

The single-file `blueexif.html` is served from its own Azure Storage static
website in BlueMask's resource group (`rg-bluemask-wehi-sandbox`,
`infra/main.bicep`), behind the Front Door profile the Bluethroat sites share
(`bluepaper-fd` in `rg-blueskills-wehi-aci-sandbox`, `infra/frontdoor.bicep`),
at `blueexif.bluethroatlabs.com`: as `/`, and as `/blueexif.html` with
`Content-Disposition: attachment` (and `noindex`) for downloading — the footer's
“Offline edition ↓” link, hidden in the downloaded copy. BlueExif adds its own
endpoint, origin group, rule set, custom domain and route to that profile and
leaves the other sites' alone. Its rule set adds `Referrer-Policy`,
`X-Content-Type-Options`, `X-Frame-Options`, `Permissions-Policy` and
`frame-ancestors 'none'`; the rest of the Content-Security-Policy ships in the
page.

```bash
just deploy   # npm ci, then infra/deploy.sh: build:single, deploy storage, upload, deploy Front Door
```

The script uploads both copies as `must-revalidate` and removes every other blob
in BlueExif's `$web` (its own storage account, so BlueMask's files are never
touched). It needs Contributor on both resource groups. `SUBSCRIPTION`, `RG`,
`PREFIX`, `LOCATION` and `DEPLOY_FRONT_DOOR=false` (upload only) override the
defaults. On first deploy it prints the CNAME and `_dnsauth` TXT records the
custom domain needs before Front Door can issue its certificate.

GitHub Actions (`.github/workflows/ci.yml`) typechecks, runs the tests, builds,
and uploads from `main` over OIDC with `DEPLOY_FRONT_DOOR=false`: the CI
identity has Contributor on BlueMask's group only, never on the shared Front
Door group, so Front Door changes go out with `just deploy`.
`./infra/setup-github-oidc.sh` creates the Entra app, its federated credential
and that role, and sets the `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and
`AZURE_SUBSCRIPTION_ID` repository secrets.
