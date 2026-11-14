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

// 国土地理院 標高タイル (DEM10B, 地表面=建物を含まない)。日本国内のみ
const GSI_URL = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`;

async function fetchPixels(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const blob = await res.blob();
  // 色空間変換・アルファ乗算をしない (標高値が壊れないように)
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const cv = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
    : Object.assign(document.createElement('canvas'), { width: TILE_SIZE, height: TILE_SIZE });
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
}

export function decodeTerrarium(d) {
  const out = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const h = d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
    out[i] = h > 0 ? h : 0; // 海面下 (海底地形) は海面 0m とみなす
  }
  return out;
}

export function decodeGsi(d) {
  const out = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const x = d[j] * 65536 + d[j + 1] * 256 + d[j + 2];
    let h = x === 8388608 ? 0 : (x > 8388608 ? x - 16777216 : x) * 0.01; // 2^23 は欠測 (海など)
    out[i] = h > 0 ? h : 0;
  }
  return out;
}

function inJapan(z, x, y) {
  const n = 2 ** z;
  const lon = ((x + 0.5) / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n))) / D2R;
  return lat > 20 && lat < 46.5 && lon > 122 && lon < 154.5;
}

// 日本国内は国土地理院 (地表面)、それ以外・取得失敗時は AWS Terrain Tiles (建物を一部含む)
async function loadTile(z, x, y) {
  if (inJapan(z, x, y)) {
    try {
      return { data: decodeGsi(await fetchPixels(GSI_URL(z, x, y))), source: 'gsi' };
    } catch (e) {
      // 海だけのタイルは 404 になる → AWS で補う
    }
  }
  return { data: decodeTerrarium(await fetchPixels(TILE_URL(z, x, y))), source: 'aws' };
}

export class DEM {
  constructor(z) {
    this.z = z;
    this.grid = [];
    this.tx0 = 0; this.ty0 = 0; this.nx = 0; this.ny = 0;
    this.maxElev = 0;
    this.sources = { gsi: 0, aws: 0 };
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
          const { data: t, source } = await loadTile(z, this.tx0 + i, this.ty0 + j);
          this.grid[j * this.nx + i] = t;
          this.sources[source]++;
          for (let k = 0; k < t.length; k++) if (t[k] > this.maxElev) this.maxElev = t[k];
        } catch (e) {
          failed++;
          console.warn(e);
        }
        done++;
        onProgress?.(1);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
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

// 近距離は高解像度、遠距離は低解像度の 2 段構成 (タイル数を数十枚に抑える)
export function layerPlan(radius) {
  const nearR = Math.min(radius, 20000);
  const plan = [{ z: 11, maxDist: nearR }];
  if (radius > nearR) plan.push({ z: radius <= 80000 ? 10 : 9, maxDist: radius });
  return plan;
}

export function tileCount(lat, lon, radiusM, z) {
  const dLat = radiusM / 111320, dLon = radiusM / (111320 * Math.cos(lat * D2R));
  const [x0, y0] = lonLatToPixel(lon - dLon, Math.min(85, lat + dLat), z);
  const [x1, y1] = lonLatToPixel(lon + dLon, Math.max(-85, lat - dLat), z);
  return (Math.floor(x1 / 256) - Math.floor(x0 / 256) + 1) * (Math.floor(y1 / 256) - Math.floor(y0 / 256) + 1);
}
