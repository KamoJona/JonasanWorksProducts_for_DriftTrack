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
  bandCount = 48, bandNear = 400,
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

  // 距離帯ごとのシルエット (VR 表示用): bands[k*n+i] = 帯 k・方位 i の最大 tan(仰角)
  // 帯 0 は bandNear まで、それ以降は対数間隔で radius まで
  const B = bandCount;
  const bands = new Float32Array(B * n).fill(-Infinity);
  const logSpan = Math.log(radius / bandNear);
  const bandOf = (d) => d <= bandNear ? 0
    : Math.min(B - 1, 1 + Math.floor((Math.log(d / bandNear) / logSpan) * (B - 1)));
  const bandDist = Float32Array.from({ length: B }, (_, k) =>
    k === 0 ? bandNear / 2 : bandNear * Math.exp(((k - 0.5) / (B - 1)) * logSpan));

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
      // 手前の地形に完全に隠れていない点だけ帯に記録 (隠れた点は手前の帯が上書きする)
      const bi = bandOf(d) * n + i;
      if (t > bands[bi]) bands[bi] = t;
      d += Math.max(minStep, d * 0.0015);
    }
    angle[i] = Math.atan(maxT);
    dist[i] = bd;
    elev[i] = bh;
    pxA[i] = ox + sx * bd;
    pyA[i] = oy + sy * bd;
  }
  return {
    n, azStep, h0, ground, angle, dist, elev, px: pxA, py: pyA, z, lat, lon, mpp,
    ox, oy, curv, radius, bands, bandCount: B, bandDist,
  };
}

/**
 * OSM の山頂リストのうち、観測点から実際に見える (手前の地形に隠れない) ものを返す
 */
export function visiblePeaks(dem, hz, peaks) {
  const { ox, oy, h0, curv, mpp, radius } = hz;
  const [lx, ly] = [ox, oy];
  const out = [];
  for (const p of peaks) {
    const [px, py] = lonLatToPixel(p.lon, p.lat, hz.z);
    const dx = (px - lx) * mpp, dy = (py - ly) * mpp;
    const d = Math.hypot(dx, dy);
    if (d < 300 || d > radius) continue;
    // OSM の山頂位置のずれ・DEM の平滑化を考慮して周囲 (約 ±2px) の最大値を使う
    let hp = 0, hx = px, hy = py;
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      const v = dem.sample(px + a, py + b);
      if (v > hp) { hp = v; hx = px + a; hy = py + b; }
    }
    const tp = (hp - h0) / d - d * curv;
    const ux = dx / d / mpp, uy = dy / d / mpp;
    let maxT = -Infinity, s = 80;
    // 山頂直前の自分の斜面で隠れたと誤判定しないよう、手前で打ち切る
    const end = d - Math.max(4 * mpp, d * 0.04);
    while (s < end) {
      const h = dem.sample(lx + ux * s, ly + uy * s);
      const t = (h - h0) / s - s * curv;
      if (t > maxT) { maxT = t; if (t > tp + 0.002) break; }
      s += Math.max(mpp * 0.5, s * 0.0015);
    }
    if (tp < maxT - 0.003) continue; // 隠れている
    const az = ((Math.atan2(dx, -dy) / D2R) + 360) % 360;
    out.push({ ...p, distance: d, azimuth: az, angle: Math.atan(tp) / D2R, demElev: hp });
  }
  return out;
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

// 半径内の名前付き山頂を OSM から一括取得 (失敗時は null)
export async function fetchPeaks(lat, lon, radius) {
  const dLat = radius / 111320, dLon = radius / (111320 * Math.cos(lat * D2R));
  const bbox = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((v) => v.toFixed(4)).join(',');
  const q = `[out:json][timeout:25];node["natural"~"^(peak|volcano)$"]["name"](${bbox});out body;`;
  const urls = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  for (const url of urls) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30000);
      const res = await fetch(url, {
        method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const js = await res.json();
      return (js.elements || []).map((el) => ({
        lat: el.lat, lon: el.lon,
        name: el.tags['name:ja'] || el.tags.name,
        ele: parseFloat(String(el.tags.ele || '').replace(/[^0-9.]/g, '')) || null,
      }));
    } catch (e) {
      console.warn('overpass', url, e);
    }
  }
  return null;
}
