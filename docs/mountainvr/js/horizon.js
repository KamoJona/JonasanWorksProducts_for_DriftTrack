// 観測点から 360° 方向にレイを飛ばし、見える稜線 (スカイライン) を求める
import { lonLatToPixel, pixelToLonLat, metersPerPixel } from './terrain.js';

const D2R = Math.PI / 180;
const EARTH_R = 6371000;

/**
 * @returns {{
 *  n:number, azStep:number, h0:number, ground:number,
 *  angle:Float32Array, dist:Float32Array, elev:Float32Array,
 *  px:Float32Array, py:Float32Array
 * }}
 */
export function computeHorizon(dem, lat, lon, {
  radius = 40000, azStep = 0.25, eyeHeight = 1.7, refraction = 0.13, minDist = 80,
} = {}) {
  const z = dem.z;
  const mpp = metersPerPixel(lat, z);
  const [ox, oy] = lonLatToPixel(lon, lat, z);
  const ground = dem.sample(ox, oy);
  const h0 = ground + eyeHeight;
  const curv = (1 - refraction) / (2 * EARTH_R); // 地球の丸み + 大気差
  const n = Math.round(360 / azStep);
  const angle = new Float32Array(n), dist = new Float32Array(n), elev = new Float32Array(n);
  const pxA = new Float32Array(n), pyA = new Float32Array(n);
  const maxH = dem.maxElev;
  const minStep = mpp * 0.5;

  for (let i = 0; i < n; i++) {
    const az = i * azStep * D2R;
    const sx = Math.sin(az) / mpp, sy = -Math.cos(az) / mpp; // 画像の y は南向き
    let maxT = -Infinity, bd = minDist, bh = ground;
    let d = minDist;
    while (d <= radius) {
      // これ以上遠くに今の仰角を超える地形があり得なければ打ち切り
      if ((maxH - h0) / d - d * curv < maxT) break;
      const h = dem.sample(ox + sx * d, oy + sy * d);
      const t = (h - h0) / d - d * curv;
      if (t > maxT) { maxT = t; bd = d; bh = h; }
      d += Math.max(minStep, d * 0.0015);
    }
    angle[i] = Math.atan(maxT);
    dist[i] = bd;
    elev[i] = bh;
    pxA[i] = ox + sx * bd;
    pyA[i] = oy + sy * bd;
  }
  return { n, azStep, h0, ground, angle, dist, elev, px: pxA, py: pyA, z, lat, lon, mpp };
}

/**
 * スカイライン上で最も標高が高い点 (= 見える範囲で一番高い山の山頂付近) と
 * その山の稜線区間を抽出する。
 * 遠い点ほど仰角を稼ぐには高さが必要なので、観測点より高い「見える最高点」は
 * 必ずスカイライン上にある。
 */
export function findHighestRidge(hz, { minDist = 500, maxSpanDeg = 120 } = {}) {
  const { n, dist, elev, h0, mpp } = hz;
  let best = -1;
  for (let i = 0; i < n; i++) {
    if (dist[i] < minDist) continue;
    if (best < 0 || elev[i] > elev[best]) best = i;
  }
  if (best < 0) return null;

  const peakH = elev[best];
  // 山頂からの比高がこの割合以下まで下がったら「別の山 / 麓」とみなす
  const relief = Math.max(peakH - h0, 200);
  const floorH = peakH - Math.max(relief * 0.55, 150);
  const maxSteps = Math.round(maxSpanDeg / 2 / hz.azStep);

  const walk = (dir) => {
    const out = [];
    let prev = best;
    for (let s = 1; s <= maxSteps; s++) {
      const j = (best + dir * s + n) % n;
      const jump = Math.abs(dist[j] - dist[prev]);
      if (jump > dist[prev] * 0.15 + 3 * mpp) break; // 手前/奥の別の地形に切り替わった
      if (elev[j] < floorH) break;
      out.push(j);
      prev = j;
    }
    return out;
  };
  const left = walk(-1).reverse();
  const right = walk(1);
  const indices = [...left, best, ...right];

  const [plon, plat] = pixelToLonLat(hz.px[best], hz.py[best], hz.z);
  return {
    peakIndex: best,
    indices,
    azimuth: best * hz.azStep,
    angle: hz.angle[best],
    elevation: peakH,
    distance: dist[best],
    lat: plat, lon: plon,
  };
}

// OpenStreetMap (Overpass API) から山頂付近の山名を取得 (失敗しても null)
export async function lookupPeakName(lat, lon, radius = 2000) {
  const q = `[out:json][timeout:10];node["natural"="peak"](around:${radius},${lat.toFixed(5)},${lon.toFixed(5)});out body;`;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const js = await res.json();
    let best = null, bestScore = -Infinity;
    for (const el of js.elements || []) {
      const name = el.tags?.['name:ja'] || el.tags?.name;
      if (!name) continue;
      const ele = parseFloat(el.tags.ele) || 0;
      const dLat = (el.lat - lat) * 111320, dLon = (el.lon - lon) * 111320 * Math.cos(lat * D2R);
      const score = ele - Math.hypot(dLat, dLon) * 0.3; // 高くて近いものを優先
      if (score > bestScore) { bestScore = score; best = { name, ele: ele || null }; }
    }
    return best;
  } catch {
    return null;
  }
}
