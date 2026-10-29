import { describe, expect, it } from 'vitest';
import { fixtureBytes, strip } from '../test/helpers';
import { cleanEmbedded, inspectEmbedded } from './embedded';

describe('embedded pictures', () => {
  it('reports what a picture reveals and cleans it with its own handler', async () => {
    for (const rel of ['jpeg/camera.jpg', 'images/rich.png', 'images/rich.webp', 'isobmff/camera.heic']) {
      const bytes = fixtureBytes(rel);
      const name = `media/${rel.split('/').pop()}`;
      const info = await inspectEmbedded(bytes, name);
      expect(info, rel).not.toBeNull();
      expect(info!.summary, rel).toMatch(/ · /);
      const clean = await cleanEmbedded(bytes, name, strip());
      expect(clean, rel).not.toBeNull();
      expect(await inspectEmbedded(clean!, name), rel).toBeNull();
      expect(await cleanEmbedded(clean!, name, strip()), rel).toBeNull(); // already clean: nothing to change
    }
    expect((await inspectEmbedded(fixtureBytes('jpeg/camera.jpg'), 'x.jpg'))!.sensitivity).toBe('location');
  });

  it('cleans SVG pictures too', async () => {
    const svg = fixtureBytes('documents/inkscape.svg');
    expect((await inspectEmbedded(svg, 'media/image1.svg'))!.summary).toMatch(/^SVG image · /);
    const clean = await cleanEmbedded(svg, 'media/image1.svg', strip());
    expect(await inspectEmbedded(clean!, 'media/image1.svg')).toBeNull();
  });

  it('says when a picture cannot be read, rather than calling it clean', async () => {
    const jpeg = fixtureBytes('jpeg/camera.jpg');
    const broken = jpeg.slice(0, 40); // SOI and the start of APP1, nothing more
    await expect(inspectEmbedded(broken, 'media/broken.jpg')).rejects.toThrow();
    await expect(cleanEmbedded(broken, 'media/broken.jpg', strip())).rejects.toThrow();
  });

  it('ignores what is not a picture, whatever its name says', async () => {
    const text = new TextEncoder().encode('not an image at all');
    expect(await inspectEmbedded(text, 'photo.jpg')).toBeNull();
    expect(await cleanEmbedded(text, 'photo.jpg', strip())).toBeNull();
  });
});
