/**
 * External validity oracles for document formats (tests only): PDFKit (Swift),
 * Python's zipfile + ElementTree, textutil and QuickLook (qlmanage). Each is
 * optional — tests skip when the tool is unavailable.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { exiftool, type EtTags } from './helpers';

function which(cmd: string): boolean {
  try {
    execFileSync('/usr/bin/which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const HAS_SWIFT = process.platform === 'darwin' && which('swiftc');
export const HAS_PYTHON = which('python3');
export const HAS_TEXTUTIL = process.platform === 'darwin' && which('textutil');
export const HAS_QLMANAGE = process.platform === 'darwin' && which('qlmanage');

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'blueexif-oracle-'));
}

function withFile<T>(bytes: Uint8Array, name: string, fn: (path: string, dir: string) => T): T {
  const dir = scratch();
  try {
    const p = join(dir, name);
    writeFileSync(p, bytes);
    return fn(p, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ PDFKit

const PDFKIT_SRC = `import Foundation
import PDFKit
let p = CommandLine.arguments[1]
guard let d = PDFDocument(url: URL(fileURLWithPath: p)) else { print("FAIL"); exit(1) }
print("\\(d.pageCount) \\(d.isEncrypted ? 1 : 0)")
`;

let pdfKitBin: string | null = null;

/** Compile (once, cached in the temp dir) the PDFKit checker. Slow the first time. */
export function preparePdfKit(): string {
  if (pdfKitBin) return pdfKitBin;
  const hash = createHash('sha1').update(PDFKIT_SRC).digest('hex').slice(0, 10);
  const dir = join(tmpdir(), `blueexif-pdfkit-${hash}`);
  const bin = join(dir, 'pdfcheck');
  if (!existsSync(bin)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'check.swift'), PDFKIT_SRC);
    execFileSync('swiftc', ['-O', join(dir, 'check.swift'), '-o', bin], { stdio: 'pipe', timeout: 300_000 });
  }
  pdfKitBin = bin;
  return bin;
}

/** Open with PDFKit; returns the page count or null when PDFKit cannot open it. */
export function pdfKitPages(bytes: Uint8Array): number | null {
  const bin = preparePdfKit();
  return withFile(bytes, 'x.pdf', (p) => {
    try {
      const out = execFileSync(bin, [p], { encoding: 'utf8', timeout: 60_000 }).trim();
      return Number(out.split(' ')[0]);
    } catch {
      return null;
    }
  });
}

// ------------------------------------------------------------------ Python

export interface PyElement {
  tag: string;
  text: string;
  attrib: Record<string, string>;
}

export interface PyZipReport {
  /** zipfile.testzip(): first bad entry or null */
  bad: string | null;
  names: string[];
  first: { name: string; stored: boolean };
  /** XML parts that ElementTree failed to parse: name -> error */
  xmlErrors: Record<string, string>;
  /** requested parts flattened to elements (Clark notation tags) */
  parts: Record<string, PyElement[]>;
}

const PY_ZIP = `
import sys, json, zipfile, io
import xml.etree.ElementTree as ET
data = sys.stdin.buffer.read()
want = json.loads(sys.argv[1])
z = zipfile.ZipFile(io.BytesIO(data))
infos = z.infolist()
rep = {"bad": z.testzip(), "names": [i.filename for i in infos],
       "first": {"name": infos[0].filename, "stored": infos[0].compress_type == zipfile.ZIP_STORED},
       "xmlErrors": {}, "parts": {}}
for i in infos:
    n = i.filename
    if n.endswith(('.xml', '.rels', '.opf', '.ncx', '.xhtml', '.svg')):
        try:
            root = ET.fromstring(z.read(n))
            if n in want:
                rep["parts"][n] = [{"tag": e.tag, "text": (e.text or ""), "attrib": dict(e.attrib)} for e in root.iter()]
        except Exception as ex:
            rep["xmlErrors"][n] = str(ex)
print(json.dumps(rep))
`;

/** Independent ZIP + XML check with Python's stdlib. */
export function pyZip(bytes: Uint8Array, parts: string[] = []): PyZipReport {
  const out = execFileSync('python3', ['-I', '-c', PY_ZIP, JSON.stringify(parts)], {
    input: bytes,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 << 20,
  });
  return JSON.parse(out) as PyZipReport;
}

/** Text of the first element with Clark tag `tag` in a pyZip part. */
export function pyText(rep: PyZipReport, part: string, tag: string): string | undefined {
  return rep.parts[part]?.find((e) => e.tag === tag)?.text;
}

// ---------------------------------------------------------------- textutil

/** Convert a document to plain text with textutil (throws when it cannot). */
export function textutilText(bytes: Uint8Array, ext: string): string {
  return withFile(bytes, `doc.${ext}`, (p) =>
    execFileSync('textutil', ['-convert', 'txt', '-stdout', p], { encoding: 'utf8', timeout: 60_000 }),
  );
}

// --------------------------------------------------------------- QuickLook

/** Render an SVG thumbnail with QuickLook; returns the PNG bytes. */
export function qlRender(bytes: Uint8Array, ext = 'svg', size = 128): Uint8Array {
  return withFile(bytes, `img.${ext}`, (p, dir) => {
    const out = join(dir, 'out');
    mkdirSync(out);
    execFileSync('qlmanage', ['-t', '-s', String(size), '-o', out, p], { stdio: 'ignore', timeout: 60_000 });
    const png = readdirSync(out).find((f) => f.endsWith('.png'));
    if (!png) throw new Error('qlmanage produced no thumbnail');
    return new Uint8Array(readFileSync(join(out, png)));
  });
}

// ------------------------------------------------------------ ExifTool

/**
 * ExifTool (WASM) lacks Archive::Zip, so it cannot open OOXML/ODF/EPUB
 * containers itself; it does parse their XML parts (core.xml, meta.xml, OPF)
 * when given one directly. Returns its tags for the extracted part.
 */
export async function exiftoolPart(zip: Uint8Array, part: string): Promise<EtTags> {
  const data = unzipSync(zip, { filter: (f) => f.name === part })[part];
  if (!data) throw new Error(`${part} not found in archive`);
  return exiftool(data, `${part.split('/').pop()!.replace(/\.\w+$/, '')}.xml`);
}
