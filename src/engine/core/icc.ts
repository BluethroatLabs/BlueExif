/** Extract a human-readable description from an ICC profile. */

import { Reader, latin1, utf16 } from './binary';

export function iccDescription(icc: Uint8Array): string | null {
  try {
    if (icc.length < 132 || latin1(icc.subarray(36, 40)) !== 'acsp') return null;
    const r = new Reader(icc);
    const n = r.u32(128);
    for (let i = 0; i < Math.min(n, 200); i++) {
      const p = 132 + i * 12;
      if (latin1(icc.subarray(p, p + 4)) !== 'desc') continue;
      const off = r.u32(p + 4);
      const type = latin1(icc.subarray(off, off + 4));
      if (type === 'desc') {
        const len = r.u32(off + 8);
        return (
          latin1(icc.subarray(off + 12, off + 12 + len))
            .replace(/\0+$/, '')
            .trim() || null
        );
      }
      if (type === 'mluc') {
        const count = r.u32(off + 8);
        if (!count) return null;
        const recSize = r.u32(off + 12);
        let rec = off + 16;
        // prefer English (among the records that fit in the profile: `count` comes from the file)
        const fit = recSize ? Math.floor((icc.length - rec) / recSize) : 0;
        for (let k = 0; k < Math.min(count, fit); k++) {
          if (latin1(icc.subarray(rec + k * recSize, rec + k * recSize + 2)) === 'en') {
            rec += k * recSize;
            break;
          }
        }
        const len = r.u32(rec + 4);
        const o = r.u32(rec + 8);
        return (
          utf16(icc.subarray(off + o, off + o + len), false)
            .replace(/\0+$/, '')
            .trim() || null
        );
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}
