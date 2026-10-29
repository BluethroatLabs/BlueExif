/** Registry of all format handlers. Order matters only for equal detect scores. */

import type { FormatHandler } from '../core/types';
import { aiffHandler } from './aiff';
import { aviHandler } from './avi';
import { epubHandler } from './epub';
import { flacHandler } from './flac';
import { gifHandler } from './gif';
import { heifHandler } from './heif';
import { jpegHandler } from './jpeg';
import { matroskaHandler } from './matroska';
import { mp3Handler } from './mp3';
import { mp4Handler } from './mp4';
import { odfHandler } from './odf';
import { oggHandler } from './ogg';
import { ooxmlHandler } from './ooxml';
import { pdfHandler } from './pdf';
import { pngHandler } from './png';
import { svgHandler } from './svg';
import { tiffHandler } from './tiff';
import { wavHandler } from './wav';
import { webpHandler } from './webp';

export const HANDLERS: FormatHandler[] = [
  // images
  jpegHandler,
  pngHandler,
  webpHandler,
  gifHandler,
  tiffHandler,
  heifHandler,
  svgHandler,
  // audio
  mp3Handler,
  flacHandler,
  oggHandler,
  wavHandler,
  aiffHandler,
  // video (MP4 also covers M4A/M4B audio)
  mp4Handler,
  matroskaHandler,
  aviHandler,
  // documents
  pdfHandler,
  ooxmlHandler,
  odfHandler,
  epubHandler,
];
