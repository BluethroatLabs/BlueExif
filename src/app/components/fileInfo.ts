import type { Field, ImageValue, Metadata, Sensitivity } from '../../engine/core/types';
import { groupKey } from '../../engine/core/types';
import type { FileEntry } from '../store';
import type { IconName } from './Icon';

const CATEGORY_ICON: Record<string, IconName> = { image: 'image', audio: 'audio', video: 'video', document: 'document' };

export function categoryIcon(meta?: Metadata): IconName {
  return (meta && CATEGORY_ICON[meta.format.category]) || 'file';
}

/** First embedded picture (cover art, EXIF thumbnail) — used as a preview fallback. */
export function firstPicture(meta?: Metadata): ImageValue | null {
  for (const g of meta?.groups ?? []) {
    for (const f of g.fields) {
      if (f.kind === 'image' && f.value && typeof f.value === 'object' && 'data' in f.value) return f.value as ImageValue;
    }
  }
  return null;
}

/** Fields still present (not queued for removal). */
export function liveFields(f: FileEntry): Field[] {
  if (!f.meta) return [];
  const out: Field[] = [];
  for (const g of f.meta.groups) {
    if (f.edits.has(groupKey(g.id))) continue;
    for (const x of g.fields) if (f.edits.get(x.id)?.op !== 'remove') out.push(x);
  }
  return out;
}

export function sensitivityCounts(f: FileEntry): Map<Sensitivity, number> {
  const counts = new Map<Sensitivity, number>();
  for (const x of liveFields(f)) if (x.sensitivity) counts.set(x.sensitivity, (counts.get(x.sensitivity) ?? 0) + 1);
  return counts;
}
