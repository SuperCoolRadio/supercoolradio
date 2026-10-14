import L from 'leaflet';

// A raster tile layer that keeps working far past its deepest tile level.
//
// Leaflet's own maxNativeZoom stretching rounds the stretched level's
// origin to whole pixels before multiplying by the stretch factor, so at
// extreme magnification (a factor of 2^21 at map zoom 30 for Blue Marble)
// tiles land far from where they belong. Instead, every tile deeper than
// maxLevel is drawn on a canvas by cropping the matching piece of its
// deepest available ancestor tile. Tiles at or above maxLevel load exactly
// as an ordinary L.tileLayer would.
export class DeepTileLayer extends L.TileLayer {
  private readonly url: string;
  private readonly maxLevel: number;

  constructor(url: string, maxLevel: number, options: L.TileLayerOptions) {
    super(url, options);
    this.url = url;
    this.maxLevel = maxLevel;
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const level = coords.z + (this.options.zoomOffset ?? 0);
    const d = level - this.maxLevel;
    if (d <= 0) return super.createTile(coords, done);

    const size = this.getTileSize();
    const canvas = document.createElement('canvas');
    canvas.width = size.x;
    canvas.height = size.y;
    const n = 2 ** d;
    const ax = Math.floor(coords.x / n);
    const ay = Math.floor(coords.y / n);
    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        // Our piece of the ancestor, in its pixels. Browsers draw nothing
        // from a source rectangle far below one pixel; by then the whole
        // tile lies inside one source pixel anyway, so sample a slightly
        // larger window centred on the true one.
        const sub = img.naturalWidth / n;
        const w = Math.max(sub, 1 / 64);
        const off = (w - sub) / 2;
        ctx.drawImage(
          img,
          (coords.x - ax * n) * sub - off,
          (coords.y - ay * n) * sub - off,
          w,
          w,
          0,
          0,
          size.x,
          size.y,
        );
      }
      done(undefined, canvas);
    };
    img.onerror = () => done(new Error('tile failed to load'), canvas);
    img.src = L.Util.template(this.url, { z: this.maxLevel, x: ax, y: ay });
    return canvas;
  }
}
