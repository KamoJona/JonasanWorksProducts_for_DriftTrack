// 標高タイル (AWS Terrain Tiles / Terrarium 形式) の読み込みとサンプリング
// elev(m) = R*256 + G + B/256 - 32768

const TILE_SIZE = 256;
const TILE_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const D2R = Math.PI / 180;

export function lonLatToPixel(lon, lat, z) {
  const n = TILE_SIZE * 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const s = Math.sin(lat * D2R);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return [x, y];
}

export function pixelToLonLat(px, py, z) {
  const n = TILE_SIZE * 2 ** z;
  const lon = (px / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) / D2R;
  return [lon, lat];
}

// 赤道で 1px あたりのメートル数 (256px タイル, z=0)
export function metersPerPixel(lat, z) {
  return (156543.03392 * Math.cos(lat * D2R)) / 2 ** z;
}

async function loadTile(z, x, y) {
  const res = await fetch(TILE_URL(z, x, y), { mode: 'cors' });
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${res.status}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const cv = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
    : Object.assign(document.createElement('canvas'), { width: TILE_SIZE, height: TILE_SIZE });
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
  const out = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const h = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
    out[i] = h > 0 ? h : 0; // 海面下 (海底地形) は海面 0m とみなす
  }
  return out;
}

export class DEM {
  constructor(z) {
    this.z = z;
    this.grid = [];
    this.tx0 = 0; this.ty0 = 0; this.nx = 0; this.ny = 0;
    this.maxElev = 0;
  }

  async loadArea(lat, lon, radiusM, onProgress) {
    const z = this.z;
    const dLat = radiusM / 111320;
    const dLon = radiusM / (111320 * Math.cos(lat * D2R));
    const [x0, y0] = lonLatToPixel(lon - dLon, Math.min(85, lat + dLat), z);
    const [x1, y1] = lonLatToPixel(lon + dLon, Math.max(-85, lat - dLat), z);
    this.tx0 = Math.floor(x0 / TILE_SIZE);
    this.ty0 = Math.floor(y0 / TILE_SIZE);
    this.nx = Math.floor(x1 / TILE_SIZE) - this.tx0 + 1;
    this.ny = Math.floor(y1 / TILE_SIZE) - this.ty0 + 1;
    const jobs = [];
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) jobs.push([i, j]);
    this.grid = new Array(jobs.length).fill(null);
    let done = 0, failed = 0, next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const [i, j] = jobs[next++];
        try {
          const t = await loadTile(z, this.tx0 + i, this.ty0 + j);
          this.grid[j * this.nx + i] = t;
          for (let k = 0; k < t.length; k++) if (t[k] > this.maxElev) this.maxElev = t[k];
        } catch (e) {
          failed++;
          console.warn(e);
        }
        done++;
        onProgress?.(done, jobs.length);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    if (failed === jobs.length) throw new Error('標高タイルを取得できませんでした');
    return { tiles: jobs.length, failed };
  }

  // 整数ピクセルの標高 (タイル外は 0)
  px(ix, iy) {
    const tx = (ix >> 8) - this.tx0, ty = (iy >> 8) - this.ty0;
    if (tx < 0 || ty < 0 || tx >= this.nx || ty >= this.ny) return 0;
    const t = this.grid[ty * this.nx + tx];
    return t ? t[(iy & 255) * TILE_SIZE + (ix & 255)] : 0;
  }

  // 双線形補間 (ピクセル中心基準)
  sample(px, py) {
    const x = px - 0.5, y = py - 0.5;
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const a = this.px(ix, iy), b = this.px(ix + 1, iy);
    const c = this.px(ix, iy + 1), d = this.px(ix + 1, iy + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }

  elevation(lat, lon) {
    const [x, y] = lonLatToPixel(lon, lat, this.z);
    return this.sample(x, y);
  }
}

// 半径に応じたズームレベル (タイル数を数十枚に抑える)
export function zoomForRadius(r) {
  if (r <= 25000) return 12;
  if (r <= 50000) return 11;
  if (r <= 100000) return 10;
  return 9;
}
