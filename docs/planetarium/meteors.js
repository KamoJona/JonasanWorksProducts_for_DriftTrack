// =====================================================================
// 流星群 (国際流星機構 IMO の流星群カレンダーの値をもとにした近似)
//
//   peak / start / end: 極大日・活動の始まりと終わり (月, 日)。年による 1 日程度のずれは無視
//   ra / dec: 極大時の放射点 (J2000, 度)
//   dRa / dDec: 放射点の 1 日あたりの移動 (度/日)
//   v: 対地速度 (km/s)。速いほど短く鋭い流星になる
//   zhr: 極大時の ZHR (天頂・限界等級 6.5 の理想条件での 1 時間あたりの数)
//   width: 極大からの減り方 (日)。ZHR は exp(-|Δ日| / width) で減るとする
// =====================================================================
export const SHOWERS = [
  { key: 'QUA', name: 'しぶんぎ座流星群', start: [12, 28], peak: [1, 3.5], end: [1, 12], ra: 230.1, dec: 48.5, dRa: 0.8, dDec: -0.2, v: 41, zhr: 110, width: 0.4 },
  { key: 'LYR', name: 'こと座流星群', start: [4, 14], peak: [4, 22.5], end: [4, 30], ra: 271.4, dec: 33.6, dRa: 1.1, dDec: 0.0, v: 49, zhr: 18, width: 0.8 },
  { key: 'ETA', name: 'みずがめ座η流星群', start: [4, 19], peak: [5, 6], end: [5, 28], ra: 338.0, dec: -1.0, dRa: 0.9, dDec: 0.4, v: 66, zhr: 50, width: 4 },
  { key: 'SDA', name: 'みずがめ座δ南流星群', start: [7, 12], peak: [7, 30], end: [8, 23], ra: 340.0, dec: -16.0, dRa: 0.75, dDec: 0.18, v: 41, zhr: 25, width: 5 },
  { key: 'PER', name: 'ペルセウス座流星群', start: [7, 17], peak: [8, 12.8], end: [8, 24], ra: 48.0, dec: 58.0, dRa: 1.35, dDec: 0.12, v: 59, zhr: 100, width: 2 },
  { key: 'DRA', name: 'りゅう座流星群', start: [10, 6], peak: [10, 8.5], end: [10, 10], ra: 262.0, dec: 54.0, dRa: 0, dDec: 0, v: 20, zhr: 10, width: 0.4 },
  { key: 'STA', name: 'おうし座南流星群', start: [9, 10], peak: [10, 10], end: [11, 20], ra: 32.0, dec: 9.0, dRa: 0.8, dDec: 0.25, v: 27, zhr: 5, width: 15 },
  { key: 'ORI', name: 'オリオン座流星群', start: [10, 2], peak: [10, 21.5], end: [11, 7], ra: 95.0, dec: 16.0, dRa: 0.7, dDec: 0.1, v: 66, zhr: 20, width: 3 },
  { key: 'NTA', name: 'おうし座北流星群', start: [10, 20], peak: [11, 12], end: [12, 10], ra: 58.0, dec: 22.0, dRa: 0.8, dDec: 0.15, v: 29, zhr: 5, width: 12 },
  { key: 'LEO', name: 'しし座流星群', start: [11, 6], peak: [11, 17.5], end: [11, 30], ra: 152.0, dec: 22.0, dRa: 0.7, dDec: -0.42, v: 71, zhr: 15, width: 1 },
  { key: 'GEM', name: 'ふたご座流星群', start: [12, 4], peak: [12, 14.3], end: [12, 20], ra: 112.0, dec: 33.0, dRa: 1.0, dDec: -0.15, v: 35, zhr: 150, width: 1 },
  { key: 'URS', name: 'こぐま座流星群', start: [12, 17], peak: [12, 22.4], end: [12, 26], ra: 217.0, dec: 76.0, dRa: 0, dDec: 0, v: 33, zhr: 10, width: 0.6 },
];

// 散在流星 (どの流星群にも属さないもの) の ZHR
export const SPORADIC_ZHR = 8;

const DAY = 86400000;
// date に最も近い年の (月, 日) の日時 [ms]。年末年始をまたぐ流星群のため前後の年も見る
function nearestMonthDay(date, [m, d]) {
  const y = date.getUTCFullYear();
  let best = null;
  for (const yy of [y - 1, y, y + 1]) {
    const t = Date.UTC(yy, m - 1, 1) + (d - 1) * DAY;
    if (best === null || Math.abs(t - date) < Math.abs(best - date)) best = t;
  }
  return best;
}

// date の時点で活動している流星群と、その ZHR・放射点 (J2000, 度)
export function activeShowers(date) {
  const out = [];
  for (const s of SHOWERS) {
    const peak = nearestMonthDay(date, s.peak);
    const dDays = (date - peak) / DAY;
    const start = peak + daysBetween(s.start, s.peak) * DAY * -1;
    const end = peak + daysBetween(s.peak, s.end) * DAY;
    if (date < start || date > end) continue;
    // 活動期間中は少なくとも 1 個/時 (極大の鋭い群でも、期間の端でわずかに流れる)
    const zhr = Math.max(1, s.zhr * Math.exp(-Math.abs(dDays) / s.width));
    out.push({ shower: s, zhr, dDays, ra: s.ra + s.dRa * dDays, dec: s.dec + s.dDec * dDays, peakMs: peak });
  }
  return out.sort((a, b) => b.zhr - a.zhr);
}

// 次に極大を迎える流星群 (活動中のものがないときの案内用)
export function nextShower(date) {
  let best = null;
  for (const s of SHOWERS) {
    let peak = nearestMonthDay(date, s.peak);
    if (peak < date) peak = nearestMonthDay(new Date(peak + 200 * DAY), s.peak);
    if (!best || peak < best.peakMs) best = { shower: s, peakMs: peak };
  }
  return best;
}

// (月, 日) a から b までの日数 (b が翌年でもよい)
function daysBetween([m1, d1], [m2, d2]) {
  const t1 = Date.UTC(2001, m1 - 1, 1) + (d1 - 1) * DAY;
  let t2 = Date.UTC(2001, m2 - 1, 1) + (d2 - 1) * DAY;
  if (t2 < t1) t2 = Date.UTC(2002, m2 - 1, 1) + (d2 - 1) * DAY;
  return (t2 - t1) / DAY;
}
