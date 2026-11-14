// 観測点から 360° 方向にレイを飛ばし、見える稜線 (スカイライン) と山並みを求める
import { lonLatToPixel, pixelToLonLat, metersPerPixel } from './terrain.js';

const D2R = Math.PI / 180;
const EARTH_R = 6371000;

// 建物の高さが混じる標高データ (AWS) 用: 近距離で観測点の地面からこの高さ未満の起伏は平地とみなす
const DSM_FLATTEN_DIST = 10000, DSM_FLATTEN_H = 60;

/**
 * 複数解像度の DEM をまとめ、観測点からの「方位ベクトル × 距離」で標高を引けるようにする。
 * layers: [{ dem, maxDist }] (maxDist の昇順)。近い距離ほど細かい DEM を使う。
 */
export function makeSampler(layers, lat, lon) {
  const L = layers.map(({ dem, maxDist }) => {
    const [ox, oy] = lonLatToPixel(lon, lat, dem.z);
    return { dem, maxDist, ox, oy, mpp: metersPerPixel(lat, dem.z) };
  });
  const last = L[L.length - 1];
  const ground = L[0].dem.sample(L[0].ox, L[0].oy);
  const dsm = L[0].dem.sources.aws > 0; // 近距離に建物入りのデータを使っているか
  const maxElev = Math.max(...L.map((l) => l.dem.maxElev));
  // ex, ey: 東・南方向の単位ベクトル成分 (m あたり)
  const sample = (ex, ey, d) => {
    let l = L[0];
    for (let k = 0; k < L.length && d > L[k].maxDist; k++) l = L[k + 1] || last;
    let h = l.dem.sample(l.ox + (ex * d) / l.mpp, l.oy + (ey * d) / l.mpp);
    if (dsm && d < DSM_FLATTEN_DIST && h - ground < DSM_FLATTEN_H) h = Math.min(h, ground);
    return h;
  };
  const stepAt = (d) => {
    let l = L[0];
    for (let k = 0; k < L.length && d > L[k].maxDist; k++) l = L[k + 1] || last;
    return Math.max(l.mpp * 0.5, d * 0.0015);
  };
  // 観測点から見た (東, 南) 方向の距離 [m] (最も粗い DEM のピクセル座標系で一貫させる)
  const offset = (plat, plon) => {
    const [px, py] = lonLatToPixel(plon, plat, last.dem.z);
    return [(px - last.ox) * last.mpp, (py - last.oy) * last.mpp];
  };
  const toLonLat = (ex, ey, d) =>
    pixelToLonLat(last.ox + (ex * d) / last.mpp, last.oy + (ey * d) / last.mpp, last.dem.z);
  return { sample, stepAt, offset, toLonLat, ground, maxElev, dsm, finestMpp: L[0].mpp };
}

export function computeHorizon(sampler, {
  radius = 150000, azStep = 0.25, eyeHeight = 1.7, refraction = 0.13, minDist = 80,
  bandCount = 56, bandNear = 400,
} = {}) {
  const { sample, stepAt, ground, maxElev: maxH } = sampler;
  const h0 = ground + eyeHeight;
  const curv = (1 - refraction) / (2 * EARTH_R); // 地球の丸み + 大気差
  const n = Math.round(360 / azStep);
  const angle = new Float32Array(n), dist = new Float32Array(n), elev = new Float32Array(n);

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
    const ex = Math.sin(az), ey = -Math.cos(az); // 東, 南 (ピクセル y は南向き)
    let maxT = -Infinity, bd = minDist, bh = ground;
    let d = minDist;
    while (d <= radius) {
      // これ以上遠くに今の仰角を超える地形があり得なければ打ち切り
      if ((maxH - h0) / d - d * curv < maxT) break;
      const h = sample(ex, ey, d);
      const t = (h - h0) / d - d * curv;
      if (t > maxT) { maxT = t; bd = d; bh = h; }
      const bi = bandOf(d) * n + i; // 隠れた部分は手前の帯が上から塗るので区別しない
      if (t > bands[bi]) bands[bi] = t;
      d += stepAt(d);
    }
    angle[i] = Math.atan(maxT);
    dist[i] = bd;
    elev[i] = bh;
  }
  return {
    n, azStep, h0, ground, angle, dist, elev, curv, radius, sampler,
    bands, bandCount: B, bandDist, mpp: sampler.finestMpp,
  };
}

/**
 * OSM の山頂リストのうち、観測点から実際に見える (手前の地形に隠れない) ものを返す
 */
export function visiblePeaks(hz, peaks) {
  const { h0, curv, radius, sampler } = hz;
  const { sample, stepAt, offset } = sampler;
  const out = [];
  for (const p of peaks) {
    const [dx, dy] = offset(p.lat, p.lon);
    const d = Math.hypot(dx, dy);
    if (d < 300 || d > radius) continue;
    const ex = dx / d, ey = dy / d;
    // OSM の山頂位置のずれ・DEM の平滑化を考慮して前後左右の最大値を使う
    const r = Math.max(60, stepAt(d) * 2);
    let hp = 0;
    for (const [a, b] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
      const ddx = dx + a, ddy = dy + b, dd = Math.hypot(ddx, ddy);
      hp = Math.max(hp, sample(ddx / dd, ddy / dd, dd));
    }
    if (p.ele && hp < p.ele - 400) hp = Math.max(hp, p.ele - 400); // DEM が粗すぎる場合の保険
    const tp = (hp - h0) / d - d * curv;
    let maxT = -Infinity, s = 80;
    // 山頂直前の自分の斜面で隠れたと誤判定しないよう、手前で打ち切る
    const end = d - Math.max(4 * stepAt(d), d * 0.04);
    while (s < end) {
      const t = (sample(ex, ey, s) - h0) / s - s * curv;
      if (t > maxT) { maxT = t; if (t > tp + 0.003) break; }
      s += stepAt(s);
    }
    if (tp < maxT - 0.003) continue; // 隠れている
    const az = ((Math.atan2(ex, -ey) / D2R) + 360) % 360;
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
  const { n, dist, elev, h0 } = hz;
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
      if (jump > dist[prev] * 0.15 + 300) break; // 手前/奥の別の地形に切り替わった
      if (elev[j] < floorH) break;
      out.push(j);
      prev = j;
    }
    return out;
  };
  const left = walk(-1).reverse();
  const right = walk(1);
  const indices = [...left, best, ...right];

  const az = best * hz.azStep * D2R;
  const [plon, plat] = hz.sampler.toLonLat(Math.sin(az), -Math.cos(az), dist[best]);
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
