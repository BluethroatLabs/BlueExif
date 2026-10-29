/** EXIF / TIFF tag dictionary. */

import type { Sensitivity } from '../core/types';

export type IfdName = 'ifd0' | 'exif' | 'gps' | 'interop' | 'ifd1';

/** Semantic display groups for EXIF fields. */
export type ExifGroup = 'description' | 'dates' | 'camera' | 'exposure' | 'image' | 'location' | 'thumbnail' | 'other';

export const EXIF_GROUP_LABELS: Record<ExifGroup, string> = {
  description: 'Description & rights',
  dates: 'Dates',
  camera: 'Camera & software',
  exposure: 'Exposure',
  image: 'Image',
  location: 'Location',
  thumbnail: 'Thumbnail',
  other: 'Other EXIF',
};

/** How a tag can be edited through the UI. */
export type EditAs =
  | 'text' // ASCII string
  | 'multiline' // ASCII string, long
  | 'datetime' // "YYYY:MM:DD HH:MM:SS"
  | 'xp' // Windows XP* UCS-2 BYTE array
  | 'usercomment' // UNDEFINED with 8-byte charset header
  | 'integer' // SHORT/LONG single value
  | 'rational' // RATIONAL single value ("1/125" or "2.8")
  | 'srational' // SRATIONAL single value
  | 'enum'; // SHORT single value from `values`

export interface TagDef {
  name: string;
  label: string;
  group: ExifGroup;
  sens?: Sensitivity;
  edit?: EditAs;
  values?: Record<number, string>;
  /** display unit suffix for numbers */
  unit?: string;
}

export const ORIENTATION: Record<number, string> = {
  1: 'Normal',
  2: 'Mirrored horizontally',
  3: 'Rotated 180°',
  4: 'Mirrored vertically',
  5: 'Mirrored horizontally, rotated 270° CW',
  6: 'Rotated 90° CW',
  7: 'Mirrored horizontally, rotated 90° CW',
  8: 'Rotated 270° CW',
};

const RES_UNIT = { 1: 'None', 2: 'inches', 3: 'cm' };

const T = (name: string, label: string, group: ExifGroup, extra: Partial<TagDef> = {}): TagDef => ({
  name,
  label,
  group,
  ...extra,
});

export const IFD0_TAGS: Record<number, TagDef> = {
  0x000b: T('ProcessingSoftware', 'Processing software', 'camera', { sens: 'software', edit: 'text' }),
  0x00fe: T('SubfileType', 'Subfile type', 'image'),
  0x0100: T('ImageWidth', 'Image width', 'image', { unit: 'px' }),
  0x0101: T('ImageHeight', 'Image height', 'image', { unit: 'px' }),
  0x0102: T('BitsPerSample', 'Bits per sample', 'image'),
  0x0103: T('Compression', 'Compression', 'image', {
    values: { 1: 'Uncompressed', 5: 'LZW', 6: 'JPEG (old-style)', 7: 'JPEG', 8: 'Adobe Deflate', 32773: 'PackBits' },
  }),
  0x0106: T('PhotometricInterpretation', 'Photometric interpretation', 'image', {
    values: { 0: 'WhiteIsZero', 1: 'BlackIsZero', 2: 'RGB', 3: 'Palette', 4: 'Mask', 5: 'CMYK', 6: 'YCbCr', 8: 'CIELab' },
  }),
  0x010d: T('DocumentName', 'Document name', 'description', { sens: 'content', edit: 'text' }),
  0x010e: T('ImageDescription', 'Description', 'description', { sens: 'content', edit: 'multiline' }),
  0x010f: T('Make', 'Camera make', 'camera', { sens: 'device', edit: 'text' }),
  0x0110: T('Model', 'Camera model', 'camera', { sens: 'device', edit: 'text' }),
  0x0111: T('StripOffsets', 'Strip offsets', 'image'),
  0x0112: T('Orientation', 'Orientation', 'image', { edit: 'enum', values: ORIENTATION }),
  0x0115: T('SamplesPerPixel', 'Samples per pixel', 'image'),
  0x0116: T('RowsPerStrip', 'Rows per strip', 'image'),
  0x0117: T('StripByteCounts', 'Strip byte counts', 'image'),
  0x011a: T('XResolution', 'Horizontal resolution', 'image', { edit: 'rational' }),
  0x011b: T('YResolution', 'Vertical resolution', 'image', { edit: 'rational' }),
  0x011c: T('PlanarConfiguration', 'Planar configuration', 'image', { values: { 1: 'Chunky', 2: 'Planar' } }),
  0x011d: T('PageName', 'Page name', 'description', { sens: 'content', edit: 'text' }),
  0x0128: T('ResolutionUnit', 'Resolution unit', 'image', { edit: 'enum', values: RES_UNIT }),
  0x0131: T('Software', 'Software', 'camera', { sens: 'software', edit: 'text' }),
  0x0132: T('DateTime', 'Modified', 'dates', { sens: 'time', edit: 'datetime' }),
  0x013b: T('Artist', 'Artist', 'description', { sens: 'identity', edit: 'text' }),
  0x013c: T('HostComputer', 'Host computer', 'camera', { sens: 'device', edit: 'text' }),
  0x013e: T('WhitePoint', 'White point', 'image'),
  0x013f: T('PrimaryChromaticities', 'Primary chromaticities', 'image'),
  0x0201: T('ThumbnailOffset', 'Thumbnail offset', 'thumbnail'),
  0x0202: T('ThumbnailLength', 'Thumbnail length', 'thumbnail', { unit: 'bytes' }),
  0x0211: T('YCbCrCoefficients', 'YCbCr coefficients', 'image'),
  0x0212: T('YCbCrSubSampling', 'YCbCr subsampling', 'image'),
  0x0213: T('YCbCrPositioning', 'YCbCr positioning', 'image', { values: { 1: 'Centered', 2: 'Co-sited' } }),
  0x0214: T('ReferenceBlackWhite', 'Reference black/white', 'image'),
  0x02bc: T('ApplicationNotes', 'Embedded XMP', 'other', { sens: 'content' }),
  0x4746: T('Rating', 'Rating', 'description', { edit: 'integer' }),
  0x4749: T('RatingPercent', 'Rating (%)', 'description', { edit: 'integer' }),
  0x8298: T('Copyright', 'Copyright', 'description', { sens: 'identity', edit: 'text' }),
  0x83bb: T('IPTC-NAA', 'Embedded IPTC', 'other', { sens: 'content' }),
  0x8649: T('PhotoshopSettings', 'Photoshop settings', 'other', { sens: 'software' }),
  0x8769: T('ExifOffset', 'EXIF IFD pointer', 'other'),
  0x8773: T('ICC_Profile', 'ICC profile', 'image'),
  0x8825: T('GPSInfo', 'GPS IFD pointer', 'location'),
  0x9c9b: T('XPTitle', 'Title (Windows)', 'description', { sens: 'content', edit: 'xp' }),
  0x9c9c: T('XPComment', 'Comment (Windows)', 'description', { sens: 'content', edit: 'xp' }),
  0x9c9d: T('XPAuthor', 'Author (Windows)', 'description', { sens: 'identity', edit: 'xp' }),
  0x9c9e: T('XPKeywords', 'Keywords (Windows)', 'description', { sens: 'content', edit: 'xp' }),
  0x9c9f: T('XPSubject', 'Subject (Windows)', 'description', { sens: 'content', edit: 'xp' }),
  0xc4a5: T('PrintIM', 'Print Image Matching', 'other'),
  0xc612: T('DNGVersion', 'DNG version', 'image'),
  0xc614: T('UniqueCameraModel', 'Unique camera model', 'camera', { sens: 'device', edit: 'text' }),
  0xea1c: T('Padding', 'Padding', 'other'),
};

const FLASH_VALUES: Record<number, string> = {};

export const EXIF_TAGS: Record<number, TagDef> = {
  0x829a: T('ExposureTime', 'Exposure time', 'exposure', { edit: 'rational', unit: 's' }),
  0x829d: T('FNumber', 'F-number', 'exposure', { edit: 'rational' }),
  0x8822: T('ExposureProgram', 'Exposure program', 'exposure', {
    values: {
      0: 'Not defined',
      1: 'Manual',
      2: 'Program AE',
      3: 'Aperture-priority AE',
      4: 'Shutter speed priority AE',
      5: 'Creative (slow speed)',
      6: 'Action (high speed)',
      7: 'Portrait',
      8: 'Landscape',
      9: 'Bulb',
    },
  }),
  0x8824: T('SpectralSensitivity', 'Spectral sensitivity', 'exposure'),
  0x8827: T('ISO', 'ISO', 'exposure', { edit: 'integer' }),
  0x8828: T('OECF', 'Opto-electric conversion factor', 'exposure'),
  0x8830: T('SensitivityType', 'Sensitivity type', 'exposure', {
    values: {
      0: 'Unknown',
      1: 'Standard output sensitivity',
      2: 'Recommended exposure index',
      3: 'ISO speed',
      4: 'SOS and REI',
      5: 'SOS and ISO speed',
      6: 'REI and ISO speed',
      7: 'SOS, REI and ISO speed',
    },
  }),
  0x8831: T('StandardOutputSensitivity', 'Standard output sensitivity', 'exposure'),
  0x8832: T('RecommendedExposureIndex', 'Recommended exposure index', 'exposure'),
  0x9000: T('ExifVersion', 'EXIF version', 'image'),
  0x9003: T('DateTimeOriginal', 'Taken', 'dates', { sens: 'time', edit: 'datetime' }),
  0x9004: T('DateTimeDigitized', 'Digitized', 'dates', { sens: 'time', edit: 'datetime' }),
  0x9010: T('OffsetTime', 'Time zone (modified)', 'dates', { sens: 'location', edit: 'text' }),
  0x9011: T('OffsetTimeOriginal', 'Time zone (taken)', 'dates', { sens: 'location', edit: 'text' }),
  0x9012: T('OffsetTimeDigitized', 'Time zone (digitized)', 'dates', { sens: 'location', edit: 'text' }),
  0x9101: T('ComponentsConfiguration', 'Components configuration', 'image'),
  0x9102: T('CompressedBitsPerPixel', 'Compressed bits per pixel', 'image'),
  0x9201: T('ShutterSpeedValue', 'Shutter speed (APEX)', 'exposure'),
  0x9202: T('ApertureValue', 'Aperture (APEX)', 'exposure'),
  0x9203: T('BrightnessValue', 'Brightness (APEX)', 'exposure'),
  0x9204: T('ExposureBiasValue', 'Exposure compensation', 'exposure', { edit: 'srational', unit: 'EV' }),
  0x9205: T('MaxApertureValue', 'Max aperture (APEX)', 'exposure'),
  0x9206: T('SubjectDistance', 'Subject distance', 'exposure', { unit: 'm' }),
  0x9207: T('MeteringMode', 'Metering mode', 'exposure', {
    values: {
      0: 'Unknown',
      1: 'Average',
      2: 'Center-weighted average',
      3: 'Spot',
      4: 'Multi-spot',
      5: 'Multi-segment',
      6: 'Partial',
      255: 'Other',
    },
  }),
  0x9208: T('LightSource', 'Light source', 'exposure', {
    values: {
      0: 'Unknown',
      1: 'Daylight',
      2: 'Fluorescent',
      3: 'Tungsten',
      4: 'Flash',
      9: 'Fine weather',
      10: 'Cloudy',
      11: 'Shade',
      12: 'Daylight fluorescent',
      13: 'Day white fluorescent',
      14: 'Cool white fluorescent',
      15: 'White fluorescent',
      17: 'Standard light A',
      18: 'Standard light B',
      19: 'Standard light C',
      20: 'D55',
      21: 'D65',
      22: 'D75',
      23: 'D50',
      24: 'ISO studio tungsten',
      255: 'Other',
    },
  }),
  0x9209: T('Flash', 'Flash', 'exposure', { values: FLASH_VALUES }),
  0x920a: T('FocalLength', 'Focal length', 'exposure', { edit: 'rational', unit: 'mm' }),
  0x9214: T('SubjectArea', 'Subject area', 'exposure'),
  0x927c: T('MakerNote', 'Maker notes', 'camera', {
    sens: 'device',
  }),
  0x9286: T('UserComment', 'User comment', 'description', { sens: 'content', edit: 'usercomment' }),
  0x9290: T('SubSecTime', 'Sub-second (modified)', 'dates', { sens: 'time', edit: 'text' }),
  0x9291: T('SubSecTimeOriginal', 'Sub-second (taken)', 'dates', { sens: 'time', edit: 'text' }),
  0x9292: T('SubSecTimeDigitized', 'Sub-second (digitized)', 'dates', { sens: 'time', edit: 'text' }),
  0x9400: T('AmbientTemperature', 'Ambient temperature', 'exposure', { unit: '°C' }),
  0x9401: T('Humidity', 'Humidity', 'exposure', { unit: '%' }),
  0x9402: T('Pressure', 'Pressure', 'exposure', { unit: 'hPa' }),
  0x9403: T('WaterDepth', 'Water depth', 'location', { sens: 'location', unit: 'm' }),
  0x9404: T('Acceleration', 'Acceleration', 'exposure'),
  0x9405: T('CameraElevationAngle', 'Camera elevation angle', 'exposure', { unit: '°' }),
  0x9999: T('SamsungInfo', 'Vendor JSON (Samsung/Xiaomi)', 'camera', { sens: 'device' }),
  0xa000: T('FlashpixVersion', 'FlashPix version', 'image'),
  0xa001: T('ColorSpace', 'Color space', 'image', { values: { 1: 'sRGB', 2: 'Adobe RGB', 0xffff: 'Uncalibrated' } }),
  0xa002: T('PixelXDimension', 'Image width', 'image', { unit: 'px' }),
  0xa003: T('PixelYDimension', 'Image height', 'image', { unit: 'px' }),
  0xa004: T('RelatedSoundFile', 'Related sound file', 'other', { edit: 'text' }),
  0xa005: T('InteropOffset', 'Interop IFD pointer', 'other'),
  0xa20b: T('FlashEnergy', 'Flash energy', 'exposure'),
  0xa20e: T('FocalPlaneXResolution', 'Focal plane X resolution', 'exposure'),
  0xa20f: T('FocalPlaneYResolution', 'Focal plane Y resolution', 'exposure'),
  0xa210: T('FocalPlaneResolutionUnit', 'Focal plane resolution unit', 'exposure', {
    values: { ...RES_UNIT, 4: 'mm', 5: 'µm' },
  }),
  0xa214: T('SubjectLocation', 'Subject location', 'exposure'),
  0xa215: T('ExposureIndex', 'Exposure index', 'exposure'),
  0xa217: T('SensingMethod', 'Sensing method', 'camera', {
    values: {
      1: 'Not defined',
      2: 'One-chip color area',
      3: 'Two-chip color area',
      4: 'Three-chip color area',
      5: 'Color sequential area',
      7: 'Trilinear',
      8: 'Color sequential linear',
    },
  }),
  0xa300: T('FileSource', 'File source', 'camera', {
    values: { 1: 'Film scanner', 2: 'Reflection print scanner', 3: 'Digital camera' },
  }),
  0xa301: T('SceneType', 'Scene type', 'exposure', { values: { 1: 'Directly photographed' } }),
  0xa302: T('CFAPattern', 'CFA pattern', 'camera'),
  0xa401: T('CustomRendered', 'Custom rendered', 'exposure', { values: { 0: 'Normal', 1: 'Custom' } }),
  0xa402: T('ExposureMode', 'Exposure mode', 'exposure', { values: { 0: 'Auto', 1: 'Manual', 2: 'Auto bracket' } }),
  0xa403: T('WhiteBalance', 'White balance', 'exposure', { values: { 0: 'Auto', 1: 'Manual' } }),
  0xa404: T('DigitalZoomRatio', 'Digital zoom ratio', 'exposure'),
  0xa405: T('FocalLengthIn35mmFormat', 'Focal length (35 mm equiv.)', 'exposure', { edit: 'integer', unit: 'mm' }),
  0xa406: T('SceneCaptureType', 'Scene capture type', 'exposure', {
    values: { 0: 'Standard', 1: 'Landscape', 2: 'Portrait', 3: 'Night' },
  }),
  0xa407: T('GainControl', 'Gain control', 'exposure', {
    values: { 0: 'None', 1: 'Low gain up', 2: 'High gain up', 3: 'Low gain down', 4: 'High gain down' },
  }),
  0xa408: T('Contrast', 'Contrast', 'exposure', { values: { 0: 'Normal', 1: 'Low', 2: 'High' } }),
  0xa409: T('Saturation', 'Saturation', 'exposure', { values: { 0: 'Normal', 1: 'Low', 2: 'High' } }),
  0xa40a: T('Sharpness', 'Sharpness', 'exposure', { values: { 0: 'Normal', 1: 'Soft', 2: 'Hard' } }),
  0xa40b: T('DeviceSettingDescription', 'Device setting description', 'camera'),
  0xa40c: T('SubjectDistanceRange', 'Subject distance range', 'exposure', {
    values: { 0: 'Unknown', 1: 'Macro', 2: 'Close', 3: 'Distant' },
  }),
  0xa420: T('ImageUniqueID', 'Image unique ID', 'camera', { sens: 'device', edit: 'text' }),
  0xa430: T('CameraOwnerName', 'Camera owner', 'description', { sens: 'identity', edit: 'text' }),
  0xa431: T('BodySerialNumber', 'Camera serial number', 'camera', { sens: 'device', edit: 'text' }),
  0xa432: T('LensSpecification', 'Lens specification', 'camera'),
  0xa433: T('LensMake', 'Lens make', 'camera', { sens: 'device', edit: 'text' }),
  0xa434: T('LensModel', 'Lens model', 'camera', { sens: 'device', edit: 'text' }),
  0xa435: T('LensSerialNumber', 'Lens serial number', 'camera', { sens: 'device', edit: 'text' }),
  0xa436: T('ImageTitle', 'Title', 'description', { sens: 'content', edit: 'text' }),
  0xa437: T('Photographer', 'Photographer', 'description', { sens: 'identity', edit: 'text' }),
  0xa438: T('ImageEditor', 'Image editor', 'description', { sens: 'identity', edit: 'text' }),
  0xa439: T('CameraFirmware', 'Camera firmware', 'camera', { sens: 'software', edit: 'text' }),
  0xa43a: T('RAWDevelopingSoftware', 'RAW developing software', 'camera', { sens: 'software', edit: 'text' }),
  0xa43b: T('ImageEditingSoftware', 'Image editing software', 'camera', { sens: 'software', edit: 'text' }),
  0xa43c: T('MetadataEditingSoftware', 'Metadata editing software', 'camera', { sens: 'software', edit: 'text' }),
  0xa460: T('CompositeImage', 'Composite image', 'exposure', {
    values: { 0: 'Unknown', 1: 'Not a composite image', 2: 'General composite image', 3: 'Composite image captured while shooting' },
  }),
  0xa500: T('Gamma', 'Gamma', 'image'),
  0xea1c: T('Padding', 'Padding', 'other'),
  0xea1d: T('OffsetSchema', 'Offset schema', 'other'),
};

export const GPS_TAGS: Record<number, TagDef> = {
  0x00: T('GPSVersionID', 'GPS version', 'location', { sens: 'location' }),
  0x01: T('GPSLatitudeRef', 'Latitude ref', 'location', { sens: 'location' }),
  0x02: T('GPSLatitude', 'Latitude', 'location', { sens: 'location' }),
  0x03: T('GPSLongitudeRef', 'Longitude ref', 'location', { sens: 'location' }),
  0x04: T('GPSLongitude', 'Longitude', 'location', { sens: 'location' }),
  0x05: T('GPSAltitudeRef', 'Altitude ref', 'location', {
    sens: 'location',
    values: { 0: 'Above sea level', 1: 'Below sea level' },
  }),
  0x06: T('GPSAltitude', 'Altitude', 'location', { sens: 'location', unit: 'm' }),
  0x07: T('GPSTimeStamp', 'GPS time (UTC)', 'location', { sens: 'time' }),
  0x08: T('GPSSatellites', 'Satellites', 'location', { sens: 'location', edit: 'text' }),
  0x09: T('GPSStatus', 'GPS status', 'location', { sens: 'location' }),
  0x0a: T('GPSMeasureMode', 'Measure mode', 'location', { sens: 'location' }),
  0x0b: T('GPSDOP', 'Dilution of precision', 'location', { sens: 'location' }),
  0x0c: T('GPSSpeedRef', 'Speed unit', 'location', { sens: 'location' }),
  0x0d: T('GPSSpeed', 'Speed', 'location', { sens: 'location' }),
  0x0e: T('GPSTrackRef', 'Track ref', 'location', { sens: 'location' }),
  0x0f: T('GPSTrack', 'Track', 'location', { sens: 'location', unit: '°' }),
  0x10: T('GPSImgDirectionRef', 'Image direction ref', 'location', { sens: 'location' }),
  0x11: T('GPSImgDirection', 'Image direction', 'location', { sens: 'location', unit: '°' }),
  0x12: T('GPSMapDatum', 'Map datum', 'location', { sens: 'location', edit: 'text' }),
  0x13: T('GPSDestLatitudeRef', 'Destination latitude ref', 'location', { sens: 'location' }),
  0x14: T('GPSDestLatitude', 'Destination latitude', 'location', { sens: 'location' }),
  0x15: T('GPSDestLongitudeRef', 'Destination longitude ref', 'location', { sens: 'location' }),
  0x16: T('GPSDestLongitude', 'Destination longitude', 'location', { sens: 'location' }),
  0x17: T('GPSDestBearingRef', 'Destination bearing ref', 'location', { sens: 'location' }),
  0x18: T('GPSDestBearing', 'Destination bearing', 'location', { sens: 'location', unit: '°' }),
  0x19: T('GPSDestDistanceRef', 'Destination distance unit', 'location', { sens: 'location' }),
  0x1a: T('GPSDestDistance', 'Destination distance', 'location', { sens: 'location' }),
  0x1b: T('GPSProcessingMethod', 'Processing method', 'location', { sens: 'location' }),
  0x1c: T('GPSAreaInformation', 'Area information', 'location', { sens: 'location' }),
  0x1d: T('GPSDateStamp', 'GPS date (UTC)', 'location', { sens: 'time', edit: 'text' }),
  0x1e: T('GPSDifferential', 'Differential correction', 'location', {
    sens: 'location',
    values: { 0: 'No correction', 1: 'Differential corrected' },
  }),
  0x1f: T('GPSHPositioningError', 'Horizontal positioning error', 'location', { sens: 'location', unit: 'm' }),
};

export const INTEROP_TAGS: Record<number, TagDef> = {
  0x0001: T('InteropIndex', 'Interoperability index', 'image'),
  0x0002: T('InteropVersion', 'Interoperability version', 'image'),
  0x1000: T('RelatedImageFileFormat', 'Related image file format', 'image'),
  0x1001: T('RelatedImageWidth', 'Related image width', 'image'),
  0x1002: T('RelatedImageHeight', 'Related image height', 'image'),
};

export const TAGS_BY_IFD: Record<IfdName, Record<number, TagDef>> = {
  ifd0: IFD0_TAGS,
  ifd1: IFD0_TAGS,
  exif: EXIF_TAGS,
  gps: GPS_TAGS,
  interop: INTEROP_TAGS,
};

/** Tags that may be added to a file that lacks them, per IFD. */
export const ADDABLE: Array<[IfdName, number]> = [
  ['ifd0', 0x010e],
  ['ifd0', 0x013b],
  ['ifd0', 0x8298],
  ['exif', 0xa436],
  ['exif', 0x9286],
  ['ifd0', 0x9c9b],
  ['ifd0', 0x9c9e],
  ['ifd0', 0x4746],
  ['exif', 0x9003],
  ['exif', 0x9004],
  ['ifd0', 0x0132],
  ['exif', 0x9011],
  ['ifd0', 0x010f],
  ['ifd0', 0x0110],
  ['ifd0', 0x0131],
  ['exif', 0xa433],
  ['exif', 0xa434],
  ['exif', 0xa430],
  ['ifd0', 0x0112],
];

/** Pointer/offset tags that cannot be carried over when rebuilding a TIFF block. */
export const UNRELOCATABLE = new Set([0x0111, 0x0117, 0x0144, 0x0145, 0x014a, 0xea1c, 0xea1d]);

export function flashDescription(v: number): string {
  if (v === 0x20) return 'No flash function';
  const fired = v & 1 ? 'Fired' : 'Did not fire';
  const mode = [null, 'On', 'Off', 'Auto'][(v >> 3) & 3];
  const ret = [null, null, 'return not detected', 'return detected'][(v >> 1) & 3];
  const parts = [mode, fired, ret, v & 0x40 ? 'red-eye reduction' : null].filter(Boolean);
  return parts.join(', ');
}
