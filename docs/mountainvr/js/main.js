import { DEM, zoomForRadius } from './terrain.js';
import { computeHorizon, findHighestRidge, lookupPeakName } from './horizon.js';
import { OrientationSensor, matFromYawPitch, cameraDirection } from './orientation.js';

const D2R = Math.PI / 180;
const $ = (id) => document.getElementById(id);
const video = $('camera'), canvas = $('overlay'), ctx = canvas.getContext('2d');
const params = new URLSearchParams(location.search);

const S = {
  mode: null,            // 'ar' | 'sim'
  sensor: new OrientationSensor(),
  useSensor: false,
  lat: null, lon: null,
  radius: 40000, eyeHeight: 1.7,
  hz: null, ridge: null, peakName: null,
  angleDeg: null,
  yawOffset: 0, pitchOffset: 0,   // 手動補正 (度)
  fov: 67,                         // カメラ長辺の画角 (度)
  simFov: 60, simYaw: 0, simPitch: 2,
  cam: { heading: 0, pitch: 0 },
};

// ---------- 起動 ----------
function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = !msg;
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    document.body.classList.add('has-camera');
  } catch (e) {
    console.warn(e);
    setStatus('カメラを使用できません (背景なしで表示します)');
  }
}

function getPosition() {
  const lat = parseFloat($('in-lat').value || params.get('lat'));
  const lon = parseFloat($('in-lon').value || params.get('lon'));
  if (Number.isFinite(lat) && Number.isFinite(lon)) return Promise.resolve({ lat, lon });
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('位置情報が使えません'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => reject(new Error('位置情報を取得できません: ' + e.message)),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 },
    );
  });
}

async function start(mode) {
  S.mode = mode;
  S.radius = parseInt($('in-radius').value, 10) || 40000;
  S.eyeHeight = parseFloat($('in-eye').value) || 1.7;
  $('start').hidden = true;
  $('hud').hidden = false;
  document.body.classList.add('running', 'mode-' + mode);
  try {
    if (mode === 'ar') {
      // iOS では許可ダイアログをユーザー操作の直後に出す必要がある
      await OrientationSensor.requestPermission().catch((e) => setStatus(e.message, true));
      S.sensor.start();
      S.useSensor = true;
      startCamera();
      setTimeout(() => {
        if (!S.sensor.q) {
          S.useSensor = false;
          document.body.classList.add('no-sensor');
          setStatus('方位センサーが使えないため、ドラッグで見回すモードにしました');
        }
      }, 3000);
    }
    requestAnimationFrame(frame);
    await compute();
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e), true);
  }
}

async function compute() {
  setStatus('現在地を取得中…');
  const pos = await getPosition();
  S.lat = pos.lat; S.lon = pos.lon;
  const z = zoomForRadius(S.radius);
  const dem = new DEM(z);
  setStatus('標高データを読み込み中…');
  await dem.loadArea(S.lat, S.lon, S.radius, (d, t) => setStatus(`標高データを読み込み中… ${d}/${t}`));
  setStatus('稜線を計算中…');
  await new Promise((r) => setTimeout(r, 30));
  const t0 = performance.now();
  S.hz = computeHorizon(dem, S.lat, S.lon, { radius: S.radius, eyeHeight: S.eyeHeight });
  S.angleDeg = Float32Array.from(S.hz.angle, (a) => a / D2R);
  S.ridge = findHighestRidge(S.hz);
  S.peakName = null;
  console.log(`horizon: ${(performance.now() - t0).toFixed(0)} ms, z=${z}`, S.ridge);
  if (!S.ridge) throw new Error('見える山が見つかりませんでした');
  if (S.mode === 'sim' || !S.useSensor) {
    S.simYaw = S.ridge.azimuth;
    S.simPitch = S.ridge.angle / D2R;
  }
  updateInfo();
  setStatus('');
  lookupPeakName(S.ridge.lat, S.ridge.lon).then((p) => { S.peakName = p; updateInfo(); });
}

// ---------- 表示 ----------
const DIRS = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
  '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
const dirName = (az) => DIRS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];
const wrap180 = (a) => ((a % 360) + 540) % 360 - 180;

function peakTitle() {
  const r = S.ridge;
  if (!r) return '';
  return S.peakName?.name || '最高峰';
}

function updateInfo() {
  const r = S.ridge;
  if (!r) return;
  const ele = S.peakName?.ele ? `${Math.round(S.peakName.ele)} m` : `約 ${Math.round(r.elevation)} m`;
  $('peak-name').textContent = peakTitle();
  $('peak-detail').textContent =
    `${ele} ・ ${(r.distance / 1000).toFixed(1)} km ・ ${dirName(r.azimuth)} ${r.azimuth.toFixed(0)}°`;
  $('here').textContent =
    `現在地 ${S.lat.toFixed(4)}, ${S.lon.toFixed(4)} ・ 標高 約 ${Math.round(S.hz.ground)} m ・ 半径 ${S.radius / 1000} km`;
}

function screenAngle() {
  if (!S.useSensor) return 0;
  const a = screen.orientation?.angle ?? window.orientation ?? 0;
  return a * D2R;
}

function focal(W, H) {
  if (!S.useSensor) return (H / 2) / Math.tan((S.simFov / 2) * D2R);
  const vw = video.videoWidth, vh = video.videoHeight;
  const t = Math.tan((S.fov / 2) * D2R);
  if (vw && vh) {
    const scale = Math.max(W / vw, H / vh); // object-fit: cover
    return (Math.max(vw, vh) / 2 / t) * scale;
  }
  return (Math.max(W, H) / 2) / t;
}

function frame() {
  requestAnimationFrame(frame);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth, H = window.innerHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const m = S.useSensor ? S.sensor.matrix : matFromYawPitch(S.simYaw, S.simPitch);
  if (!m) return;
  const th = screenAngle(), cT = Math.cos(th), sT = Math.sin(th);
  const f = focal(W, H), cx = W / 2, cy = H / 2;
  const yawOff = S.useSensor ? S.yawOffset : 0, pitchOff = S.useSensor ? S.pitchOffset : 0;
  const raw = cameraDirection(m);
  S.cam = { heading: (raw.heading + yawOff + 360) % 360, pitch: raw.pitch + pitchOff };

  const project = (azDeg, elDeg) => {
    const az = (azDeg - yawOff) * D2R, el = (elDeg - pitchOff) * D2R;
    const ce = Math.cos(el);
    const w0 = Math.sin(az) * ce, w1 = Math.cos(az) * ce, w2 = Math.sin(el);
    const dx = m[0] * w0 + m[3] * w1 + m[6] * w2;
    const dy = m[1] * w0 + m[4] * w1 + m[7] * w2;
    const dz = m[2] * w0 + m[5] * w1 + m[8] * w2;
    if (dz > -0.05) return null;
    const x = dx * cT - dy * sT, y = dx * sT + dy * cT;
    return [cx + (f * x) / -dz, cy - (f * y) / -dz];
  };

  if (!S.hz) { drawCrosshair(cx, cy); return; }
  const { n, azStep } = S.hz;
  const A = S.angleDeg;

  // 視野内の方位だけ投影 (端末の傾きを考慮して広めに)
  const halfSpan = Math.min(180, (Math.atan(Math.hypot(W, H) / 2 / f) / D2R) + 15);
  const span = Math.ceil(halfSpan / azStep);
  const c0 = Math.round(S.cam.heading / azStep);
  const pts = [];
  for (let k = -span; k <= span; k++) {
    const i = (((c0 + k) % n) + n) % n;
    pts.push(project(i * azStep, A[i]));
  }

  // シミュレーション時は地面を塗る
  if (!S.useSensor || !document.body.classList.contains('has-camera')) {
    ctx.fillStyle = 'rgba(20, 28, 38, 0.92)';
    ctx.beginPath();
    let open = false;
    for (const p of pts) {
      if (!p) continue;
      if (!open) { ctx.moveTo(p[0], H + 10); ctx.lineTo(p[0], p[1]); open = true; }
      else ctx.lineTo(p[0], p[1]);
    }
    if (open) { ctx.lineTo(pts.filter(Boolean).at(-1)[0], H + 10); ctx.closePath(); ctx.fill(); }
  }

  // 全周スカイライン (細線)
  strokePolyline(pts, W, 'rgba(255,255,255,0.55)', 1.5);

  // 最高峰の稜線 (太線)
  const r = S.ridge;
  if (r) {
    const rp = r.indices.map((i) => project(i * azStep, A[i]));
    ctx.save();
    ctx.shadowColor = 'rgba(255, 170, 0, 0.9)';
    ctx.shadowBlur = 14;
    strokePolyline(rp, W, '#ffb020', 5);
    ctx.restore();
    strokePolyline(rp, W, '#fff3c4', 1.5);

    const p = project(r.azimuth, A[r.peakIndex]);
    if (p && p[0] > -20 && p[0] < W + 20 && p[1] > -20 && p[1] < H + 20) drawPeakLabel(p, W);
    else drawOffscreenArrow(W, H);
  }
  drawCrosshair(cx, cy);
  drawPanorama(W, H, halfSpan);
}

function strokePolyline(pts, W, color, width) {
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  let prev = null;
  for (const p of pts) {
    if (p && prev && Math.abs(p[0] - prev[0]) < W * 0.5) ctx.lineTo(p[0], p[1]);
    else if (p) ctx.moveTo(p[0], p[1]);
    prev = p;
  }
  ctx.stroke();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function drawPeakLabel([x, y], W) {
  const r = S.ridge;
  // 山頂マーカー
  ctx.fillStyle = '#ffb020';
  ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x - 7, y - 18); ctx.lineTo(x + 7, y - 18); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y - 18); ctx.lineTo(x, y - 40); ctx.stroke();

  const title = peakTitle();
  const ele = S.peakName?.ele ? Math.round(S.peakName.ele) : Math.round(r.elevation);
  const sub = `${ele} m ・ ${(r.distance / 1000).toFixed(1)} km`;
  ctx.font = '600 16px system-ui, sans-serif';
  const w1 = ctx.measureText(title).width;
  ctx.font = '13px system-ui, sans-serif';
  const w2 = ctx.measureText(sub).width;
  const bw = Math.max(w1, w2) + 20, bh = 46;
  const bx = Math.max(8, Math.min(W - bw - 8, x - bw / 2)), by = y - 40 - bh;
  ctx.fillStyle = 'rgba(12, 16, 22, 0.78)';
  roundRect(bx, by, bw, bh, 10); ctx.fill();
  ctx.strokeStyle = 'rgba(255, 176, 32, 0.8)'; ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '600 16px system-ui, sans-serif'; ctx.fillText(title, bx + 10, by + 20);
  ctx.fillStyle = '#ffd88a';
  ctx.font = '13px system-ui, sans-serif'; ctx.fillText(sub, bx + 10, by + 38);
}

function drawOffscreenArrow(W, H) {
  const r = S.ridge;
  const rel = wrap180(r.azimuth - S.cam.heading);
  const left = rel < 0;
  const x = left ? 28 : W - 28, y = H / 2;
  ctx.fillStyle = 'rgba(255, 176, 32, 0.95)';
  ctx.beginPath();
  if (left) { ctx.moveTo(x - 14, y); ctx.lineTo(x + 8, y - 14); ctx.lineTo(x + 8, y + 14); }
  else { ctx.moveTo(x + 14, y); ctx.lineTo(x - 8, y - 14); ctx.lineTo(x - 8, y + 14); }
  ctx.closePath(); ctx.fill();
  ctx.font = '600 13px system-ui, sans-serif';
  ctx.textAlign = left ? 'left' : 'right';
  ctx.fillStyle = '#fff';
  ctx.fillText(`${peakTitle()} ${Math.abs(rel).toFixed(0)}°`, left ? 14 : W - 14, y + 34);
  ctx.textAlign = 'start';
}

function drawCrosshair(cx, cy) {
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy); ctx.lineTo(cx - 4, cy); ctx.moveTo(cx + 4, cy); ctx.lineTo(cx + 12, cy);
  ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy - 4); ctx.moveTo(cx, cy + 4); ctx.lineTo(cx, cy + 12);
  ctx.stroke();
}

// 画面下部の 360° パノラマ (全周の稜線と今見ている範囲)
function drawPanorama(W, H, halfSpan) {
  const { n, azStep } = S.hz, A = S.angleDeg;
  const pad = 12, pw = W - pad * 2, ph = 56;
  const py = H - ph - pad - (parseFloat(getComputedStyle(document.body).getPropertyValue('--sab')) || 0);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { if (A[i] < lo) lo = A[i]; if (A[i] > hi) hi = A[i]; }
  hi = Math.max(hi, lo + 1);
  const X = (az) => pad + (az / 360) * pw;
  const Y = (a) => py + ph - 6 - ((a - lo) / (hi - lo)) * (ph - 18);

  ctx.fillStyle = 'rgba(12, 16, 22, 0.6)';
  roundRect(pad, py, pw, ph, 8); ctx.fill();

  // 視野枠
  const hfov = Math.min(halfSpan - 15, 90);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  const h0 = S.cam.heading - hfov, h1 = S.cam.heading + hfov;
  for (const off of [-360, 0, 360]) {
    const a = Math.max(0, h0 + off), b = Math.min(360, h1 + off);
    if (b > a) ctx.fillRect(X(a), py, X(b) - X(a), ph);
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(i * azStep), Y(A[i]));
  ctx.stroke();

  if (S.ridge) {
    ctx.strokeStyle = '#ffb020'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    let prev = null;
    for (const i of S.ridge.indices) {
      const x = X(i * azStep), y = Y(A[i]);
      if (prev !== null && Math.abs(i - prev) === 1) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      prev = i;
    }
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ['北', '東', '南', '西', '北'].forEach((t, k) => ctx.fillText(t, X(k * 90), py + 11));
  ctx.textAlign = 'start';
}

// ---------- HUD 更新 ----------
setInterval(() => {
  if (!S.mode) return;
  $('heading').textContent = `${dirName(S.cam.heading)} ${S.cam.heading.toFixed(0)}°`;
  $('pitch').textContent = `仰角 ${S.cam.pitch.toFixed(1)}°`;
  const off = S.useSensor && (S.yawOffset || S.pitchOffset)
    ? `補正 ${S.yawOffset >= 0 ? '+' : ''}${S.yawOffset.toFixed(1)}° / ${S.pitchOffset >= 0 ? '+' : ''}${S.pitchOffset.toFixed(1)}°` : '';
  $('offset').textContent = off;
}, 200);

// ---------- 操作 ----------
const pointers = new Map();
let pinchStart = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), fov: S.useSensor ? S.fov : S.simFov };
  }
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 2 && pinchStart) {
    const [a, b] = [...pointers.values()];
    const fov = Math.max(20, Math.min(110, pinchStart.fov * pinchStart.d / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y))));
    if (S.useSensor) { S.fov = fov; $('in-fov').value = fov; } else S.simFov = fov;
    return;
  }
  const f = focal(window.innerWidth, window.innerHeight);
  const ddeg = (v) => Math.atan(v / f) / D2R;
  if (S.useSensor) {
    // 手動キャリブレーション: 稜線を実際の山に重ねる
    S.yawOffset -= ddeg(dx);
    S.pitchOffset += ddeg(dy);
  } else {
    S.simYaw = (S.simYaw - ddeg(dx) + 360) % 360;
    S.simPitch = Math.max(-80, Math.min(80, S.simPitch + ddeg(dy)));
  }
});
const endPointer = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinchStart = null; };
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const k = Math.exp(e.deltaY * 0.001);
  if (S.useSensor) S.fov = Math.max(20, Math.min(110, S.fov * k));
  else S.simFov = Math.max(10, Math.min(110, S.simFov * k));
}, { passive: false });

$('btn-ar').addEventListener('click', () => start('ar'));
$('btn-sim').addEventListener('click', () => start('sim'));
$('btn-align').addEventListener('click', () => {
  // 画面中央の十字を実際の山頂に向けた状態で押す → 方位・仰角のずれを補正
  if (!S.ridge || !S.useSensor) return;
  const raw = cameraDirection(S.sensor.matrix);
  S.yawOffset = wrap180(S.ridge.azimuth - raw.heading);
  S.pitchOffset = S.angleDeg[S.ridge.peakIndex] - raw.pitch;
});
$('btn-reset').addEventListener('click', () => { S.yawOffset = 0; S.pitchOffset = 0; });
$('btn-recalc').addEventListener('click', () => {
  if (S.mode === 'ar') {
    // AR では GPS で取り直す
    $('in-lat').value = ''; $('in-lon').value = '';
    params.delete('lat'); params.delete('lon');
  }
  compute().catch((e) => setStatus(e.message, true));
});
$('btn-settings').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; });
$('in-fov').addEventListener('input', (e) => { S.fov = parseFloat(e.target.value); });

// 初期値 / URL パラメータ
if (params.get('radius')) $('in-radius').value = params.get('radius');
if (params.get('lat')) $('in-lat').value = params.get('lat');
if (params.get('lon')) $('in-lon').value = params.get('lon');
if (!window.isSecureContext) $('secure-warn').hidden = false;
$('btn-sim').addEventListener('click', () => { $('hint').textContent = 'ドラッグ: 見回す / ホイール: ズーム'; });
if (params.get('sim') === '1') { $('hint').textContent = 'ドラッグ: 見回す / ホイール: ズーム'; start('sim'); }
