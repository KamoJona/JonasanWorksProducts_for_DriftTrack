// =====================================================================
// 天体位置の計算 (宇宙飛行版とプラネタリウム版で共用)
//
// 座標系 (Three.js 用の赤道座標, J2000):
//   x = 春分点方向, y = 天の北極, z = -(赤道座標の y)
//   HYG の恒星も同じ軸に変換してある (tools/build_stars.py)。
//
// 精度の目安 (astronomy-engine との比較):
//   太陽 0.01°、月 0.1°、惑星 0.05° 前後 (1800〜2050 年)
// =====================================================================
import * as THREE from 'three';

export const KM = 1000;
export const AU = 1.495978707e11;
export const M_PER_PC = 3.0857e16;
export const M_PER_LY = 9.4607e15;
export const R_EARTH = 6371 * KM, R_MOON = 1737.4 * KM, R_SUN = 696000 * KM;
export const DEG = Math.PI / 180;
const OBLIQUITY_J2000 = 23.4393 * DEG;

// 黄道座標 (J2000) の直交成分 → Three.js 赤道座標
export function eclipticXYZToScene(x, y, z) {
  const ye = y * Math.cos(OBLIQUITY_J2000) - z * Math.sin(OBLIQUITY_J2000);
  const ze = y * Math.sin(OBLIQUITY_J2000) + z * Math.cos(OBLIQUITY_J2000);
  return new THREE.Vector3(x, ze, -ye);
}
export function eclipticToScene(lon, lat, r) {
  return eclipticXYZToScene(
    r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat));
}
// 赤経 [時]・赤緯 [度] (J2000) → Three.js 赤道座標の単位ベクトル
export function raDecToScene(raHours, decDeg) {
  const ra = raHours * 15 * DEG, dec = decDeg * DEG;
  return new THREE.Vector3(Math.cos(dec) * Math.cos(ra), Math.sin(dec), -Math.cos(dec) * Math.sin(ra));
}

// ---------------------------------------------------------------------
// 惑星: JPL "Approximate Positions of the Planets" 表 1 (1800〜2050 年用)
//   [a (AU), e, I, L, 近日点黄経 ϖ, 昇交点黄経 Ω] とその 1 世紀あたりの変化量
//   等級: V = H + 5 log10(r Δ)  (位相による変化は省略)
// ---------------------------------------------------------------------
export const PLANETS = [
  { key: 'mercury', name: '水星', H: -0.42, color: [0.85, 0.82, 0.78],
    el: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
    rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081] },
  { key: 'venus', name: '金星', H: -4.40, color: [1.0, 0.97, 0.88],
    el: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
    rate: [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418] },
  { key: 'mars', name: '火星', H: -1.52, color: [1.0, 0.62, 0.45],
    el: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343] },
  { key: 'jupiter', name: '木星', H: -9.40, color: [1.0, 0.93, 0.82],
    el: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106] },
  { key: 'saturn', name: '土星', H: -8.88, color: [1.0, 0.9, 0.7],
    el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    rate: [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794] },
  { key: 'uranus', name: '天王星', H: -7.19, color: [0.75, 0.92, 1.0],
    el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
    rate: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589] },
  { key: 'neptune', name: '海王星', H: -6.87, color: [0.6, 0.72, 1.0],
    el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    rate: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664] },
];

function keplerHelio(p, T) {
  const [a, e, I, L, wbar, node] = p.el.map((v, i) => v + p.rate[i] * T);
  const w = (wbar - node) * DEG, O = node * DEG, inc = I * DEG;
  let M = ((L - wbar) % 360) * DEG;
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 6; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(inc), sI = Math.sin(inc);
  const x = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
  const y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
  const z = (sw * sI) * xp + (cw * sI) * yp;
  return eclipticXYZToScene(x * AU, y * AU, z * AU);
}

// ---------------------------------------------------------------------
// date の時点の天体位置。すべて太陽中心・J2000・メートル。
//   太陽・月: Astronomical Almanac の低精度式
// ---------------------------------------------------------------------
export function ephemeris(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const T = n / 36525;
  const precess = 1.397 * T * DEG;                 // 黄経の歳差 (日付の分点 → J2000)
  const sin = (d) => Math.sin(d * DEG), cos = (d) => Math.cos(d * DEG);

  // 地心から見た太陽
  const L = 280.460 + 0.9856474 * n;
  const g = 357.528 + 0.9856003 * n;
  const sunLon = (L + 1.915 * sin(g) + 0.020 * sin(2 * g)) * DEG - precess;
  const sunR = (1.00014 - 0.01671 * cos(g) - 0.00014 * cos(2 * g)) * AU;
  const sunGeo = eclipticToScene(sunLon, 0, sunR);

  // 地心から見た月
  const moonLon = (218.32 + 481267.881 * T
    + 6.29 * sin(135.0 + 477198.87 * T) - 1.27 * sin(259.3 - 413335.36 * T)
    + 0.66 * sin(235.7 + 890534.22 * T) + 0.21 * sin(269.9 + 954397.74 * T)
    - 0.19 * sin(357.5 + 35999.05 * T) - 0.11 * sin(186.5 + 966404.03 * T)) * DEG - precess;
  const moonLat = (5.13 * sin(93.3 + 483202.02 * T) + 0.28 * sin(228.2 + 960400.89 * T)
    - 0.28 * sin(318.3 + 6003.15 * T) - 0.17 * sin(217.6 - 407332.21 * T)) * DEG;
  const moonPar = (0.9508 + 0.0518 * cos(135.0 + 477198.87 * T) + 0.0095 * cos(259.3 - 413335.36 * T)
    + 0.0078 * cos(235.7 + 890534.22 * T) + 0.0028 * cos(269.9 + 954397.74 * T)) * DEG;
  const moonGeo = eclipticToScene(moonLon, moonLat, R_EARTH / Math.sin(moonPar));

  const earth = sunGeo.clone().negate();
  const moon = earth.clone().add(moonGeo);
  const planets = Object.fromEntries(PLANETS.map((p) => [p.key, keplerHelio(p, T)]));
  // グリニッジ平均恒星時 (日付の分点基準)
  const gmst = ((280.46061837 + 360.98564736629 * n) % 360) * DEG;
  return { T, sun: new THREE.Vector3(), earth, moon, planets, gmst };
}

// ---------------------------------------------------------------------
// J2000 赤道座標 (Three.js 軸) → 観測地点の地平座標 (Three.js 軸) の回転行列
//   地平座標: x = 東, y = 天頂, -z = 北
//   歳差 (IAU 1976 の 1 次の項) と地方恒星時を含む。章動・光行差・大気差は省略。
// ---------------------------------------------------------------------
export function horizonMatrix(T, gmst, latDeg, lonDeg) {
  const as = (a) => (a / 3600) * DEG;
  const zeta = as(2306.2181 * T), z = as(2306.2181 * T + 1.09468 * T * T), theta = as(2004.3109 * T);
  const lst = gmst + lonDeg * DEG, lat = latDeg * DEG;
  // 標準の赤道座標 (X, Y, Z = 北極) で計算する
  const rotZ = (v, a) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a), v[2]];
  const rotY = (v, a) => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];
  const precessV = (v) => rotZ(rotY(rotZ(v, zeta), -theta), z);   // J2000 → 日付の分点
  const zen = [Math.cos(lat) * Math.cos(lst), Math.cos(lat) * Math.sin(lst), Math.sin(lat)];
  const east = [-Math.sin(lst), Math.cos(lst), 0];
  const north = [-Math.sin(lat) * Math.cos(lst), -Math.sin(lat) * Math.sin(lst), Math.cos(lat)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // Three.js 赤道軸の基底ベクトルを順に変換して列にする
  const cols = [[1, 0, 0], [0, 0, 1], [0, -1, 0]].map((std) => {
    const v = precessV(std);
    return new THREE.Vector3(dot(v, east), dot(v, zen), -dot(v, north));
  });
  return new THREE.Matrix4().makeBasis(cols[0], cols[1], cols[2]);
}
