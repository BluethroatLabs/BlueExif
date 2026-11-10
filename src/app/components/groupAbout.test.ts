import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMetadata } from '../../engine';
import { FIXTURES, fixtureBytes } from '../../engine/test/helpers';
import { aboutGroup } from './groupAbout';

const isGeneric = (what: string) => what.startsWith('Metadata stored in') || what.includes('does not recognise');

function allFixtures(): string[] {
  const out: string[] = [];
  for (const area of readdirSync(FIXTURES)) {
    const dir = join(FIXTURES, area);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) if (!f.startsWith('.') && !f.endsWith('.json')) out.push(`${area}/${f}`);
  }
  return out.sort();
}

describe('aboutGroup', () => {
  it('explains PDF/UA and PDF/A identification', () => {
    const ua = aboutGroup({ id: 'xmp.pdfuaid', label: 'PDF/UA', source: 'XMP', fields: [] });
    expect(ua.what).toMatch(/accessib/i);
    expect(ua.standard?.name).toBe('XMP');
    expect(aboutGroup({ id: 'xmp.pdfaid', label: 'PDF/A', source: 'XMP', fields: [] }).what).toMatch(/archiv/i);
  });

  it('falls back to the packet prefix, then to a generic note, for unknown namespaces', () => {
    const byPrefix = aboutGroup({ id: 'xmp.http://ns.example.com/pdfuaid/', label: 'pdfuaid', source: 'XMP', fields: [] });
    expect(byPrefix.what).toMatch(/accessib/i);
    const unknown = aboutGroup({ id: 'xmp.http://ns.example.com/x/', label: 'acme', source: 'XMP', fields: [] });
    expect(unknown.what).toContain('“acme”');
    expect(unknown.what).toContain('http://ns.example.com/x/');
  });

  it('explains every section found in the fixtures', async () => {
    const generic: string[] = [];
    for (const rel of allFixtures()) {
      let groups;
      try {
        groups = (await readMetadata(new Blob([fixtureBytes(rel) as BlobPart]), rel.split('/').pop()!)).groups;
      } catch {
        continue; // unreadable / encrypted fixtures are covered elsewhere
      }
      for (const g of groups) {
        const a = aboutGroup(g);
        if (isGeneric(a.what)) generic.push(`${rel}: ${g.id} (${g.label}, ${g.source})`);
      }
    }
    expect(generic).toEqual([]);
  }, 60_000);
});
