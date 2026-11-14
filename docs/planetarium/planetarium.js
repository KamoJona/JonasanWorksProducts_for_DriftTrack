import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { ephemeris, horizonMatrix, raDecToScene, eclipticXYZToScene, PLANETS, AU, R_EARTH, R_MOON, R_SUN, DEG } from './astro.js';
import { SHOWERS, SPORADIC_ZHR, activeShowers, nextShower } from './meteors.js';

// =====================================================================
// プラネタリウム
//   観測者は地表の 1 点。シーンは地平座標 (x = 東, y = 天頂, -z = 北)。
//   天体はすべて group `sky` (J2000 赤道座標) の中に置き、sky の行列で
//   「歳差 + 地方恒星時 + 緯度」の回転をかけて地平座標に向ける。
//   距離は描き分けのための殻の半径 (地面 < 月 < 太陽 < 恒星 < 空) で、
//   見かけの大きさだけを実際の角直径に合わせる。
// =====================================================================
const R_GROUND = 400, R_MOON_SHELL = 500, R_SUN_SHELL = 600, R_LABEL = 900, R_STARS = 1000, R_SKY = 3000;

// ---------- 状態 ----------
const state = {
  simMs: Date.now(),
  meteors: true,
  rate: 1,               // 実時間の何倍で進めるか
  sunOn: true,
  labels: true,
  lat: 35.6812, lon: 139.7671, placeName: '東京',
};

// URL で日時・場所を指定できる (例: ?t=2026-08-13T02:00:00%2B09:00&lat=35.68&lon=139.77)
{
  const q = new URLSearchParams(location.search);
  const t = Date.parse(q.get('t') ?? '');
  if (Number.isFinite(t)) state.simMs = t;
  const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
  if (q.has('lat') && q.has('lon') && Number.isFinite(lat) && Number.isFinite(lon)) {
    Object.assign(state, { lat, lon, placeName: '指定地点' });
  }
}

// ---------- 基本セットアップ ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
const vrButton = VRButton.createButton(renderer);
document.getElementById('vrSlot').appendChild(vrButton);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 10000);
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const sky = new THREE.Group();
sky.matrixAutoUpdate = false;
scene.add(sky);

// ---------- 空の色 ----------
// 太陽高度から昼の青空・薄明の夕焼け・夜空を合成する簡易モデル
const skyMaterial = new THREE.ShaderMaterial({
  uniforms: { uSunDir: { value: new THREE.Vector3(0, -1, 0) }, uSunOn: { value: 1 } },
  vertexShader: /* glsl */`
    varying vec3 vDir;
    void main() {
      vDir = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 uSunDir;
    uniform float uSunOn;
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      float s = uSunDir.y;                                     // 太陽高度の sin
      float h = clamp(d.y, 0.0, 1.0);
      float day = smoothstep(-0.105, 0.17, s) * uSunOn;        // -6° 〜 +10°
      float twi = smoothstep(-0.31, -0.05, s) * (1.0 - smoothstep(0.05, 0.35, s)) * uSunOn;  // -18° 〜 +20°
      float c = dot(d, uSunDir);

      vec3 night = vec3(0.003, 0.005, 0.012) * (1.0 + 1.5 * (1.0 - h));
      vec3 dayCol = mix(vec3(0.60, 0.76, 0.95), vec3(0.16, 0.38, 0.82), pow(h, 0.45));
      dayCol += vec3(1.0, 0.95, 0.85) * (0.55 * pow(max(c, 0.0), 80.0) + 0.18 * pow(max(c, 0.0), 6.0));
      vec3 sunH = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(1e-5));
      float toward = max(dot(normalize(vec3(d.x, 0.0, d.z) + vec3(1e-5)), sunH), 0.0);
      vec3 twiCol = mix(vec3(0.04, 0.06, 0.16), vec3(0.98, 0.45, 0.16), pow(1.0 - h, 5.0) * (0.25 + 0.75 * toward));

      vec3 col = mix(night, twiCol, twi * 0.85);
      col = mix(col, dayCol, day);
      gl_FragColor = vec4(col, 1.0);
    }`,
  side: THREE.BackSide,
  depthWrite: false,
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(R_SKY, 64, 32), skyMaterial);
skyDome.renderOrder = -2;
scene.add(skyDome);

// ---------- 地面 ----------
const ground = new THREE.Mesh(
  new THREE.SphereGeometry(R_GROUND, 64, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x050806, side: THREE.BackSide }));
scene.add(ground);
const horizonRing = new THREE.Mesh(new THREE.TorusGeometry(R_GROUND * 0.999, 0.6, 4, 256),
  new THREE.MeshBasicMaterial({ color: 0x2a3a50 }));
horizonRing.rotation.x = Math.PI / 2;
scene.add(horizonRing);

// ---------- 恒星と惑星 (同じシェーダ) ----------
// position は pc 単位。太陽 (= ほぼ地球) から見た見かけの等級を計算し、
// 大気による減光と、空の明るさで決まる限界等級で明るさを決める。
const pointMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uLimitMag: { value: 6.5 },
    uScale: { value: renderer.getPixelRatio() },
    uShell: { value: R_STARS },
  },
  vertexShader: /* glsl */`
    attribute float absmag;
    attribute vec4 color;
    uniform float uLimitMag, uScale, uShell;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      float d = length(position);
      vec3 dir = normalize(mat3(modelMatrix) * position);
      float m = absmag + 5.0 * log(max(d, 1e-9) / 10.0) / log(10.0);
      float s = max(dir.y, 0.0);
      float airmass = 1.0 / (s + 0.025 * exp(-11.0 * s));
      m += 0.2 * (airmass - 1.0);                                // 大気減光 0.2 等/エアマス
      float b = pow(10.0, -0.4 * (m - uLimitMag));
      if (d < 1e-3) b = 0.0;                                     // 太陽は別に描く
      vAlpha = min(b, 1.0);
      vColor = color.rgb;
      gl_PointSize = b < 0.02 ? 0.0 : clamp(1.4 + 2.6 * pow(b, 0.33), 1.0, 30.0) * uScale;
      gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + dir * uShell, 1.0);
    }`,
  fragmentShader: /* glsl */`
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float r2 = dot(p, p);
      if (r2 > 1.0) discard;
      gl_FragColor = vec4(vColor * exp(-r2 * 5.0) * vAlpha, 1.0);
    }`,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  transparent: true,
});

async function loadStars(url) {
  const buf = window.STARS_B64
    ? Uint8Array.from(atob(window.STARS_B64), (c) => c.charCodeAt(0)).buffer
    : await (await fetch(url)).arrayBuffer();
  const n = new DataView(buf).getUint32(0, true);
  const data = new Float32Array(buf, 4, n * 4);
  const color = new Uint8Array(buf, 4 + n * 16, n * 4);
  const geo = new THREE.BufferGeometry();
  const ib = new THREE.InterleavedBuffer(data, 4);
  geo.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
  geo.setAttribute('absmag', new THREE.InterleavedBufferAttribute(ib, 1, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 4, true));
  return geo;
}
loadStars('./data/stars.bin').then((geo) => {
  const pts = new THREE.Points(geo, pointMaterial);
  pts.frustumCulled = false;
  sky.add(pts);
});

// 惑星: 10 pc の位置に置けば「絶対等級 = 見かけの等級」になるので同じシェーダで描ける
const planetGeo = new THREE.BufferGeometry();
planetGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PLANETS.length * 3), 3));
planetGeo.setAttribute('absmag', new THREE.BufferAttribute(new Float32Array(PLANETS.length), 1));
planetGeo.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(PLANETS.flatMap((p) => [...p.color.map((c) => c * 255), 255])), 4, true));
const planetPoints = new THREE.Points(planetGeo, pointMaterial);
planetPoints.frustumCulled = false;
sky.add(planetPoints);

// ---------- 太陽・月 ----------
const loader = new THREE.TextureLoader();
const texUrl = (name) => window.EMBED_TEXTURES?.[name] ?? `./textures/${name}.jpg`;
const moonTex = loader.load(texUrl('moon'));
moonTex.colorSpace = THREE.SRGBColorSpace;
// 加算合成: 影の側は空の色が透けて見える (昼の月)。深度は書くので背後の恒星は隠れる
const moonMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32),
  new THREE.MeshLambertMaterial({ map: moonTex, blending: THREE.AdditiveBlending }));
sky.add(moonMesh);

const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshBasicMaterial({ color: 0xfff6e6 }));
sky.add(sunMesh);
const glowTex = (() => {
  const c = Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(255,250,235,1)');
  grd.addColorStop(0.12, 'rgba(255,235,190,0.7)');
  grd.addColorStop(0.35, 'rgba(255,200,120,0.15)');
  grd.addColorStop(1, 'rgba(255,180,90,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
})();
const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
sky.add(sunGlow);

const sunLight = new THREE.DirectionalLight(0xffffff, 3.2);
scene.add(sunLight, sunLight.target);
scene.add(new THREE.AmbientLight(0x6070a0, 0.06));   // 地球照の代わり

// ---------- 名前ラベル ----------
function makeLabel(text, color = 'rgba(200,225,255,0.92)', parent = sky) {
  const c = Object.assign(document.createElement('canvas'), { width: 256, height: 64 });
  const g = c.getContext('2d');
  g.font = '600 30px system-ui, sans-serif';
  g.textAlign = 'center';
  g.shadowColor = '#000'; g.shadowBlur = 6;
  g.fillStyle = color;
  g.fillText(text, 128, 40);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true, sizeAttenuation: false }));
  sp.center.set(0.5, -0.25);
  sp.scale.set(0.24, 0.06, 1);
  sp.renderOrder = 5;
  parent.add(sp);
  return sp;
}

const BRIGHT_STARS = [
  ['シリウス', 6.7525, -16.716], ['カノープス', 6.3992, -52.696], ['アークトゥルス', 14.2610, 19.182],
  ['ベガ', 18.6156, 38.784], ['カペラ', 5.2782, 45.998], ['リゲル', 5.2423, -8.202],
  ['プロキオン', 7.6550, 5.225], ['ベテルギウス', 5.9195, 7.407], ['アケルナル', 1.6286, -57.237],
  ['アルタイル', 19.8464, 8.868], ['アルデバラン', 4.5987, 16.509], ['アンタレス', 16.4901, -26.432],
  ['スピカ', 13.4199, -11.161], ['ポルックス', 7.7553, 28.026], ['フォーマルハウト', 22.9608, -29.622],
  ['デネブ', 20.6905, 45.280], ['レグルス', 10.1395, 11.967], ['北極星', 2.5303, 89.264],
];
const skyLabels = BRIGHT_STARS.map(([name, ra, dec]) => {
  const l = makeLabel(name, 'rgba(190,210,240,0.8)');
  l.position.copy(raDecToScene(ra, dec)).multiplyScalar(R_LABEL);
  return l;
});
const planetLabels = PLANETS.map((p) => makeLabel(p.name, 'rgba(255,215,140,0.95)'));
const sunLabel = makeLabel('太陽', 'rgba(255,220,150,0.95)');
const moonLabel = makeLabel('月', 'rgba(230,235,255,0.95)');
skyLabels.push(...planetLabels, sunLabel, moonLabel);

const cardinalLabels = [['北', 0, -1], ['東', 1, 0], ['南', 0, 1], ['西', -1, 0]].map(([t, x, z]) => {
  const l = makeLabel(t, 'rgba(255,170,120,0.95)', scene);
  l.position.set(x * R_GROUND * 0.95, 4, z * R_GROUND * 0.95);
  l.center.set(0.5, 0);
  return l;
});

// ---------- 天体位置の更新 ----------
const ECL_NORTH = eclipticXYZToScene(0, 0, 1);
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
const skyInv = new THREE.Matrix4();
let lastInfo = { sunAlt: 0, moonAge: 0, moonIllum: 0 };

function updateSky() {
  const date = new Date(state.simMs);
  const e = ephemeris(date);
  sky.matrix.copy(horizonMatrix(e.T, e.gmst, state.lat, state.lon));
  sky.matrixWorldNeedsUpdate = true;
  skyInv.copy(sky.matrix).transpose();

  // 観測者の位置 (地心からの天頂方向 × 地球半径) — 月の視差に効く
  const zenith = new THREE.Vector3(0, 1, 0).applyMatrix4(skyInv).multiplyScalar(R_EARTH);
  const observer = e.earth.clone().add(zenith);

  // 太陽
  const sunRel = e.sun.clone().sub(observer);
  const sunDist = sunRel.length();
  const sunDir = sunRel.clone().normalize();
  sunMesh.position.copy(sunDir).multiplyScalar(R_SUN_SHELL);
  sunMesh.scale.setScalar(R_SUN_SHELL * R_SUN / sunDist);
  sunGlow.position.copy(sunMesh.position);
  sunGlow.scale.setScalar(R_SUN_SHELL * R_SUN / sunDist * 14);
  sunLabel.position.copy(sunDir).multiplyScalar(R_LABEL);
  const sunWorld = sunDir.clone().applyMatrix4(sky.matrix);
  skyMaterial.uniforms.uSunDir.value.copy(sunWorld);
  sunLight.position.copy(sunWorld).multiplyScalar(1000);

  // 月 (地表から見た位置。表側を地球に向ける)
  const moonRel = e.moon.clone().sub(observer);
  const moonDist = moonRel.length();
  const moonDir = moonRel.clone().normalize();
  moonMesh.position.copy(moonDir).multiplyScalar(R_MOON_SHELL);
  moonMesh.scale.setScalar(R_MOON_SHELL * R_MOON / moonDist);
  {
    const x = moonDir.clone().negate();
    const z = new THREE.Vector3().crossVectors(x, new THREE.Vector3(0, 1, 0)).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    moonMesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  }
  moonLabel.position.copy(moonDir).multiplyScalar(R_LABEL);

  // 月齢 (黄道上で太陽から東へ何度離れたか) と輝面比
  const sG = e.sun.clone().sub(e.earth), mG = e.moon.clone().sub(e.earth);
  const sP = sG.clone().projectOnPlane(ECL_NORTH).normalize(), mP = mG.clone().projectOnPlane(ECL_NORTH).normalize();
  let elong = Math.atan2(tmp.crossVectors(sP, mP).dot(ECL_NORTH), sP.dot(mP));
  if (elong < 0) elong += 2 * Math.PI;
  const phaseAngle = tmp.copy(e.sun).sub(e.moon).angleTo(tmp2.copy(e.earth).sub(e.moon));

  // 惑星
  const pos = planetGeo.attributes.position, mag = planetGeo.attributes.absmag;
  PLANETS.forEach((p, i) => {
    const rel = e.planets[p.key].clone().sub(observer);
    const r = e.planets[p.key].length() / AU, delta = rel.length() / AU;
    const dir = rel.normalize();
    pos.setXYZ(i, dir.x * 10, dir.y * 10, dir.z * 10);
    mag.setX(i, p.H + 5 * Math.log10(r * delta));
    planetLabels[i].position.copy(dir).multiplyScalar(R_LABEL);
  });
  pos.needsUpdate = true;
  mag.needsUpdate = true;

  lastInfo = {
    sunAlt: Math.asin(THREE.MathUtils.clamp(sunWorld.y, -1, 1)) / DEG,
    moonAge: elong / (2 * Math.PI) * 29.53,
    moonIllum: (1 + Math.cos(phaseAngle)) / 2,
  };
}

// 空の明るさから決める肉眼の限界等級 (太陽 OFF なら常に夜空)
function limitingMagnitude(sunAlt) {
  if (!state.sunOn) return 6.5;
  const pts = [[-90, 6.5], [-18, 6.5], [-12, 5.0], [-6, 3.0], [0, 0.0], [10, -3.5], [90, -3.5]];
  for (let i = 1; i < pts.length; i++) {
    const [a1, m1] = pts[i - 1], [a2, m2] = pts[i];
    if (sunAlt <= a2) return m1 + (m2 - m1) * (sunAlt - a1) / (a2 - a1);
  }
  return -3.5;
}
function twilightName(a) {
  if (a > 0) return '昼';
  if (a > -6) return '市民薄明';
  if (a > -12) return '航海薄明';
  if (a > -18) return '天文薄明';
  return '夜';
}

// ---------- 操作: 見回す・ズーム ----------
let yaw = Math.PI, pitch = 20 * DEG;   // 南の空を見上げた状態から
{
  // URL で視線を指定できる (?az=45&alt=40 … 方位は北 0°・東 90°、高度は度)
  const q = new URLSearchParams(location.search);
  if (q.has('az') && Number.isFinite(Number(q.get('az')))) yaw = -Number(q.get('az')) * DEG;
  if (q.has('alt') && Number.isFinite(Number(q.get('alt')))) pitch = THREE.MathUtils.clamp(Number(q.get('alt')), -17, 90) * DEG;
}
const pointers = new Map();
let pinchStart = null;
const canvas = renderer.domElement;
canvas.style.touchAction = 'none';
canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), fov: camera.fov };
  }
});
const endPointer = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinchStart = null; };
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p || renderer.xr.isPresenting) return;
  if (pointers.size === 2 && pinchStart) {
    p.x = e.clientX; p.y = e.clientY;
    const [a, b] = [...pointers.values()];
    setFov(pinchStart.fov * pinchStart.d / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)));
    return;
  }
  const k = (e.pointerType === 'touch' ? 0.005 : 0.003) * camera.fov / 70;
  if (sensor.on) {
    // センサー使用中の左右ドラッグは方位の補正 (コンパスのずれを手で合わせる)
    sensor.offset += (e.clientX - p.x) * k / DEG;
    p.x = e.clientX; p.y = e.clientY;
    return;
  }
  yaw += (e.clientX - p.x) * k;
  pitch = THREE.MathUtils.clamp(pitch + (e.clientY - p.y) * k, -0.3, Math.PI / 2);
  p.x = e.clientX; p.y = e.clientY;
});
function setFov(f) {
  camera.fov = THREE.MathUtils.clamp(f, 5, 100);
  camera.updateProjectionMatrix();
}
canvas.addEventListener('wheel', (e) => { e.preventDefault(); setFov(camera.fov * Math.exp(e.deltaY * 0.001)); }, { passive: false });

// ---------- 操作: スマホの向きで見る ----------
// DeviceOrientation (方位・傾き) からカメラの向きを作る。地平座標 (x = 東, y = 天頂, -z = 北) と
// W3C の地球座標 (x = 東, y = 北, z = 上) は、three.js の旧 DeviceOrientationControls と同じ変換で合う。
const sensor = { on: false, has: false, absolute: false, offset: 0, evt: null, q: new THREE.Quaternion() };
const Z_AXIS = new THREE.Vector3(0, 0, 1), Y_AXIS = new THREE.Vector3(0, 1, 0);
const Q_BACK = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));   // 画面の裏側 (背面カメラ側) を見る
const sEuler = new THREE.Euler(), qScreen = new THREE.Quaternion(), qHeading = new THREE.Quaternion();
const sensorBtn = document.getElementById('sensorToggle');
const sensorMsg = document.getElementById('sensorMsg');

// 日本付近の偏角 (西偏, 度)。国土地理院の 2020.0 年値の近似式。コンパスは磁北を指すので真北に直す
function declinationWest(lat, lon) {
  if (lat < 20 || lat > 46 || lon < 122 || lon > 154) return 0;
  const dp = lat - 37, dl = lon - 138;
  return 7 + 57.201 / 60 + (18.750 * dp - 6.761 * dl - 0.059 * dp * dp - 0.014 * dp * dl - 0.579 * dl * dl) / 60;
}

function onOrientation(e) {
  let alpha = e.alpha;
  const ios = typeof e.webkitCompassHeading === 'number';
  if (ios) alpha = 360 - e.webkitCompassHeading;              // iOS: 磁北から時計回りの方位
  if (alpha == null || e.beta == null || e.gamma == null) return;
  const orient = (screen.orientation?.angle ?? window.orientation ?? 0) * DEG;
  sEuler.set(e.beta * DEG, alpha * DEG, -e.gamma * DEG, 'YXZ');
  sensor.q.setFromEuler(sEuler).multiply(Q_BACK).multiply(qScreen.setFromAxisAngle(Z_AXIS, -orient));
  qHeading.setFromAxisAngle(Y_AXIS, (declinationWest(state.lat, state.lon) + sensor.offset) * DEG);
  sensor.q.premultiply(qHeading);
  sensor.absolute = ios || e.absolute === true || e.type === 'deviceorientationabsolute';
  if (!sensor.has) { sensor.has = true; camera.quaternion.copy(sensor.q); }
  updateSensorMsg();
}

function updateSensorMsg() {
  if (!sensor.on) { sensorMsg.textContent = ''; return; }
  if (!sensor.has) { sensorMsg.textContent = 'センサーを待っています…'; return; }
  const off = sensor.offset >= 0 ? `+${sensor.offset.toFixed(1)}` : sensor.offset.toFixed(1);
  sensorMsg.textContent = (sensor.absolute ? '' : '方位が北に合っていない可能性があります。') +
    `方位補正 ${off}°（左右ドラッグで調整）`;
}

function sensorFail(msg) {
  stopSensor();
  sensorMsg.textContent = msg;
}

async function startSensor() {
  if (typeof DeviceOrientationEvent === 'undefined') return sensorFail('このブラウザは方位センサーに対応していません');
  // iOS はボタン操作の中で許可を求める必要がある
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      if (await DeviceOrientationEvent.requestPermission() !== 'granted') return sensorFail('センサーの使用が許可されませんでした');
    } catch { return sensorFail('センサーの使用が許可されませんでした'); }
  }
  sensor.evt = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
  addEventListener(sensor.evt, onOrientation);
  sensor.on = true; sensor.has = false;
  sensorBtn.setAttribute('aria-pressed', 'true');
  updateSensorMsg();
  setTimeout(() => {
    if (sensor.on && !sensor.has) sensorFail('方位センサーの値が届きません。claude.ai のページ内ではセンサーが使えないため、GitHub Pages など HTTPS で直接開いてください');
  }, 2500);
}

function stopSensor() {
  if (sensor.evt) removeEventListener(sensor.evt, onOrientation);
  if (sensor.on && sensor.has) {
    // いま見ている向きからドラッグ操作を続けられるようにする
    const d = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    pitch = THREE.MathUtils.clamp(Math.asin(d.y), -0.3, Math.PI / 2);
    yaw = Math.atan2(-d.x, -d.z);
  }
  sensor.on = false; sensor.has = false; sensor.evt = null;
  camera.quaternion.identity();
  sensorBtn.setAttribute('aria-pressed', 'false');
  updateSensorMsg();
}
sensorBtn.addEventListener('click', () => (sensor.on ? stopSensor() : startSensor()));

// ---------- 操作: 時間・太陽・場所 ----------
const RATES = [0, 1, 60, 600, 3600, 86400];
const RATE_NAMES = { 0: '停止中', 1: '実時間', 60: '1分/秒', 600: '10分/秒', 3600: '1時間/秒', 86400: '1日/秒' };
const rateButtons = [...document.querySelectorAll('[data-rate]')];
function setRate(r) {
  state.rate = r;
  for (const b of rateButtons) b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === r));
}
for (const b of rateButtons) b.addEventListener('click', () => setRate(Number(b.dataset.rate)));
document.getElementById('now').addEventListener('click', () => { state.simMs = Date.now(); setRate(1); });
setRate(1);

const sunBtn = document.getElementById('sunToggle');
sunBtn.addEventListener('click', () => {
  state.sunOn = !state.sunOn;
  sunBtn.setAttribute('aria-pressed', String(state.sunOn));
  sunBtn.textContent = state.sunOn ? '太陽 ON' : '太陽 OFF';
});
const meteorBtn = document.getElementById('meteorToggle');
meteorBtn.addEventListener('click', () => {
  state.meteors = !state.meteors;
  meteorBtn.setAttribute('aria-pressed', String(state.meteors));
  if (!state.meteors) meteors.length = 0;
});
const labelBtn = document.getElementById('labelToggle');
labelBtn.addEventListener('click', () => {
  state.labels = !state.labels;
  labelBtn.setAttribute('aria-pressed', String(state.labels));
});

const locSel = document.getElementById('loc');
const custom = document.getElementById('custom');
const latIn = document.getElementById('lat'), lonIn = document.getElementById('lon');
function setPlace(lat, lon, name) {
  state.lat = THREE.MathUtils.clamp(lat, -90, 90);
  state.lon = ((lon + 540) % 360) - 180;
  state.placeName = name;
  latIn.value = state.lat.toFixed(4);
  lonIn.value = state.lon.toFixed(4);
}
locSel.addEventListener('change', () => {
  const v = locSel.value;
  custom.hidden = v !== 'custom';
  if (v === 'custom') { setPlace(Number(latIn.value), Number(lonIn.value), '指定地点'); return; }
  if (v === 'here') {
    const fail = () => { document.getElementById('place').textContent = '現在地を取得できません。緯度経度を入力してください'; locSel.value = 'custom'; custom.hidden = false; };
    if (!navigator.geolocation) return fail();
    navigator.geolocation.getCurrentPosition((p) => setPlace(p.coords.latitude, p.coords.longitude, '現在地'), fail, { timeout: 8000 });
    return;
  }
  const [lat, lon] = v.split(',').map(Number);
  setPlace(lat, lon, locSel.selectedOptions[0].textContent);
});
for (const inp of [latIn, lonIn]) inp.addEventListener('change', () => {
  if (Number.isFinite(Number(latIn.value)) && Number.isFinite(Number(lonIn.value))) setPlace(Number(latIn.value), Number(lonIn.value), '指定地点');
});
setPlace(state.lat, state.lon, state.placeName);

// ---------- VR ----------
// どちらかのトリガー (ピンチ) で時間の速さを順に切り替える
for (const i of [0, 1]) {
  const c = renderer.xr.getController(i);
  c.addEventListener('select', () => setRate(RATES[(RATES.indexOf(state.rate) + 1) % RATES.length]));
  rig.add(c);
}
renderer.xr.addEventListener('sessionstart', () => { pitch = 0; });

const hudCanvas = Object.assign(document.createElement('canvas'), { width: 640, height: 120 });
const hudTex = new THREE.CanvasTexture(hudCanvas);
const hudMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.094),
  new THREE.MeshBasicMaterial({ map: hudTex, transparent: true, depthTest: false }));
hudMesh.position.set(0, -0.25, -0.8);
hudMesh.renderOrder = 10;
camera.add(hudMesh);

// ---------- 表示 ----------
const clockEl = document.getElementById('clock');
const rateEl = document.getElementById('rateText');
const placeEl = document.getElementById('place');
const sunInfoEl = document.getElementById('sunInfo');
const meteorInfoEl = document.getElementById('meteorInfo');
let lastHud = '';
function updateHud() {
  const d = new Date(state.simMs);
  const clock = d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', second: state.rate <= 1 ? '2-digit' : undefined });
  const live = state.rate === 1 && Math.abs(state.simMs - Date.now()) < 2000;
  const rate = live ? '現在時刻' : RATE_NAMES[state.rate];
  const ns = state.lat >= 0 ? `北緯${state.lat.toFixed(2)}°` : `南緯${(-state.lat).toFixed(2)}°`;
  const ew = state.lon >= 0 ? `東経${state.lon.toFixed(2)}°` : `西経${(-state.lon).toFixed(2)}°`;
  const info = `太陽高度 ${lastInfo.sunAlt.toFixed(1)}°（${twilightName(lastInfo.sunAlt)}）・ 月齢 ${lastInfo.moonAge.toFixed(1)}（輝面 ${Math.round(lastInfo.moonIllum * 100)}%）`;
  const mText = meteorText();
  const key = clock + rate + info + state.placeName + ns + ew + mText;
  if (key === lastHud) return;
  lastHud = key;
  clockEl.textContent = clock;
  rateEl.textContent = rate;
  placeEl.textContent = `${state.placeName}（${ns} ${ew}）`;
  sunInfoEl.textContent = info;
  meteorInfoEl.textContent = mText;
  const g = hudCanvas.getContext('2d');
  g.clearRect(0, 0, 640, 120);
  g.fillStyle = 'rgba(0,10,30,0.55)'; g.fillRect(0, 0, 640, 120);
  g.fillStyle = '#fff'; g.font = 'bold 40px sans-serif'; g.fillText(clock, 18, 50);
  g.fillStyle = '#f2c46d'; g.font = '30px sans-serif'; g.fillText(`${rate} ・ ${state.placeName}`, 18, 100);
  hudTex.needsUpdate = true;
}

// ---------- 流星 ----------
// 放射点から大円に沿って外向きに流す。1 本の流星は太さのある帯 (先端が明るく尾が消える) で描く。
// 実際の頻度 (ペルセウス座流星群の極大でも 1 分に 1 個程度) では見ごたえがないので、
// 演出として METEOR_BOOST 倍で流す (倍率は画面に表示する)。
const METEOR_BOOST = 60;
const R_METEOR = 800, MAX_METEORS = 64, SEG = 20;
const meteorGeo = new THREE.BufferGeometry();
const mPos = new Float32Array(MAX_METEORS * (SEG + 1) * 2 * 3);
const mCol = new Float32Array(MAX_METEORS * (SEG + 1) * 2 * 3);
meteorGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3).setUsage(THREE.DynamicDrawUsage));
meteorGeo.setAttribute('color', new THREE.BufferAttribute(mCol, 3).setUsage(THREE.DynamicDrawUsage));
{
  const idx = [];
  for (let m = 0; m < MAX_METEORS; m++) for (let i = 0; i < SEG; i++) {
    const a = (m * (SEG + 1) + i) * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  meteorGeo.setIndex(idx);
}
const meteorMesh = new THREE.Mesh(meteorGeo, new THREE.MeshBasicMaterial({
  vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
meteorMesh.frustumCulled = false;
meteorMesh.renderOrder = 3;
scene.add(meteorMesh);

const meteors = [];
const rnd = Math.random;
const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vD = new THREE.Vector3(), vT = new THREE.Vector3(), vS = new THREE.Vector3();

// radiant: 放射点 (地平座標の単位ベクトル)、v: 対地速度 km/s
function spawnMeteor(radiant, v) {
  if (meteors.length >= MAX_METEORS) return;
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(radiant.x) > 0.9) u.set(0, 1, 0);
  u.sub(radiant.clone().multiplyScalar(u.dot(radiant))).normalize();
  const w = new THREE.Vector3().crossVectors(radiant, u);
  // 見ている方向で流れやすくする (演出)。8 割は視野の中に出るまで候補を選び直す
  const view = camera.getWorldDirection(new THREE.Vector3());
  const wantInView = rnd() < 0.8;
  const viewCos = Math.cos(Math.min(camera.fov * 0.6, 50) * DEG);
  for (let tries = 0; tries < 40; tries++) {
    // 放射点からの角距離 d。放射点の近くは短く、離れるほど長い流星になる
    const d = (8 + 92 * rnd()) * DEG, phi = rnd() * Math.PI * 2;
    const A = radiant.clone().multiplyScalar(Math.cos(d))
      .addScaledVector(u, Math.cos(phi) * Math.sin(d)).addScaledVector(w, Math.sin(phi) * Math.sin(d));
    if (A.y < Math.sin(6 * DEG)) continue;                    // 地平線すれすれ・下は流さない
    if (wantInView && A.dot(view) < viewCos && tries < 39) continue;
    const B = A.clone().multiplyScalar(A.dot(radiant)).sub(radiant).normalize();   // 放射点から離れる向き
    const L = (6 + 24 * Math.sin(d) * Math.sqrt(rnd())) * DEG;                       // 経路の長さ
    const omega = ((v / 70) * 38 * Math.sin(d) + 6) * DEG;                            // 角速度 rad/s
    const fireball = rnd() < 0.05;
    meteors.push({
      A, B, L, T: THREE.MathUtils.clamp(L / omega, 0.25, 1.8), t: 0,
      trail: L * (0.5 + 0.3 * rnd()),
      bright: fireball ? 2.4 : 0.8 + 0.8 * rnd() ** 2,
      width: fireball ? 2.4 : 1.3,
      color: v > 55 ? [0.78, 0.92, 1.0] : v < 35 ? [1.0, 0.86, 0.62] : [0.95, 0.95, 0.92],
    });
    return;
  }
}

function drawMeteors(dt) {
  const pixel = camera.fov * DEG / innerHeight * R_METEOR;     // 画面 1 px に相当する長さ
  mPos.fill(0); mCol.fill(0);
  for (let m = meteors.length - 1; m >= 0; m--) {
    const me = meteors[m];
    me.t += dt;
    if (me.t >= me.T) { meteors.splice(m, 1); continue; }
  }
  meteors.forEach((me, m) => {
    const f = me.t / me.T;
    const head = me.L * f, tail = Math.max(0, head - me.trail);
    const env = Math.pow(Math.sin(Math.PI * f), 0.6) * me.bright;
    for (let i = 0; i <= SEG; i++) {
      const k = i / SEG, s = tail + (head - tail) * k;
      vD.copy(me.A).multiplyScalar(Math.cos(s)).addScaledVector(me.B, Math.sin(s));
      vT.copy(me.A).multiplyScalar(-Math.sin(s)).addScaledVector(me.B, Math.cos(s));
      vS.crossVectors(vT, vD).normalize().multiplyScalar(pixel * me.width * (0.5 + 1.5 * k * k));
      const c = env * Math.pow(k, 1.5);
      const o = ((m * (SEG + 1) + i) * 2) * 3;
      for (const [j, sign] of [[0, 1], [3, -1]]) {
        mPos[o + j] = vD.x * R_METEOR + vS.x * sign;
        mPos[o + j + 1] = vD.y * R_METEOR + vS.y * sign;
        mPos[o + j + 2] = vD.z * R_METEOR + vS.z * sign;
        mCol[o + j] = me.color[0] * c; mCol[o + j + 1] = me.color[1] * c; mCol[o + j + 2] = me.color[2] * c;
      }
    }
  });
  meteorGeo.attributes.position.needsUpdate = true;
  meteorGeo.attributes.color.needsUpdate = true;
}

// 放射点の印 (活動中の流星群だけ表示)
function makeRadiantLabel(name) {
  const c = Object.assign(document.createElement('canvas'), { width: 512, height: 128 });
  const g = c.getContext('2d');
  g.textAlign = 'center';
  g.shadowColor = '#000'; g.shadowBlur = 6;
  g.fillStyle = 'rgba(150,255,190,0.95)';
  g.font = '600 44px system-ui, sans-serif';
  g.fillText('✦', 256, 46);                       // 放射点の位置 (キャンバスの中央)
  g.font = '600 30px system-ui, sans-serif';
  g.fillText(`${name}の放射点`, 256, 100);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true, sizeAttenuation: false }));
  sp.center.set(0.5, 0.75);                       // ✦ の中心を放射点に合わせる
  sp.scale.set(0.48, 0.12, 1);
  sp.renderOrder = 5;
  sp.visible = false;
  sky.add(sp);
  return sp;
}
const radiantLabels = new Map(SHOWERS.map((s) => [s.key, makeRadiantLabel(s.name)]));

let meteorInfo = { list: [], text: '' };
// 実時間 1 秒あたりに流す数。空の明るさ (限界等級) と放射点の高さで実際の数を見積もり、演出倍率をかける
function updateMeteorShowers(dt, limitMag) {
  const date = new Date(state.simMs);
  const act = activeShowers(date);
  const lmFactor = Math.pow(2.5, Math.min(0, limitMag - 6.5));   // 空が明るいほど見える数が減る
  const list = [];
  for (const [key, l] of radiantLabels) l.visible = false;
  for (const a of act) {
    const dirJ2000 = raDecToScene(a.ra / 15, a.dec);
    const radiant = dirJ2000.clone().applyMatrix4(sky.matrix);
    const alt = Math.asin(THREE.MathUtils.clamp(radiant.y, -1, 1)) / DEG;
    const hr = a.zhr * Math.max(0, Math.sin(alt * DEG)) * lmFactor;
    list.push({ ...a, alt, hr });
    const l = radiantLabels.get(a.shower.key);
    l.position.copy(dirJ2000).multiplyScalar(R_LABEL);
    l.visible = state.labels && alt > -2;
    if (state.meteors && rnd() < hr / 3600 * METEOR_BOOST * dt) spawnMeteor(radiant, a.shower.v);
  }
  // 散在流星: 放射点はばらばら
  if (state.meteors && rnd() < SPORADIC_ZHR * lmFactor / 3600 * METEOR_BOOST * 0.5 * dt) {
    spawnMeteor(new THREE.Vector3().randomDirection(), 25 + 45 * rnd());
  }
  meteorInfo.list = list;
}

function meteorText() {
  const list = meteorInfo.list;
  if (!list.length) {
    const n = nextShower(new Date(state.simMs));
    const d = new Date(n.peakMs);
    return `流星群: 活動中のものなし（次は${n.shower.name} ${d.getMonth() + 1}/${d.getDate()} 頃が極大）`;
  }
  const top = list[0];
  const pd = new Date(top.peakMs);
  const others = list.length > 1 ? ` ほか${list.length - 1}群` : '';
  const where = top.alt > 0 ? `放射点の高さ ${top.alt.toFixed(0)}°・見える数 約${Math.round(top.hr)}個/時` : '放射点は地平線の下';
  return `${top.shower.name} 活動中（極大 ${pd.getMonth() + 1}/${pd.getDate()}・ZHR ${Math.round(top.zhr)}）${where}${others}` +
    (state.meteors ? `　※演出: 実際の約${METEOR_BOOST}倍の頻度で、見ている方向に流しています` : '');
}

// ---------- ループ ----------
const clock = new THREE.Clock();
const worldPos = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  state.simMs += dt * 1000 * state.rate;

  updateSky();
  updateMeteorShowers(dt, limitingMagnitude(lastInfo.sunAlt));
  drawMeteors(dt);
  pointMaterial.uniforms.uLimitMag.value = limitingMagnitude(lastInfo.sunAlt);
  skyMaterial.uniforms.uSunOn.value = state.sunOn ? 1 : 0;
  sunMesh.visible = sunGlow.visible = state.sunOn;

  // 昼は地面も少し明るく
  const day = state.sunOn ? THREE.MathUtils.smoothstep(lastInfo.sunAlt, -8, 10) : 0;
  ground.material.color.setRGB(0.02 + 0.10 * day, 0.03 + 0.12 * day, 0.025 + 0.08 * day);

  // ラベル: 地平線より上にあるものだけ
  sky.updateMatrixWorld(true);
  for (const l of skyLabels) {
    l.getWorldPosition(worldPos);
    l.visible = state.labels && worldPos.y > -5;
  }
  sunLabel.visible &&= state.sunOn;
  for (const l of cardinalLabels) l.visible = state.labels;

  if (renderer.xr.isPresenting) {
    hudMesh.visible = true;
    rig.rotation.set(0, yaw, 0, 'YXZ');
  } else if (sensor.on && sensor.has) {
    hudMesh.visible = false;
    rig.rotation.set(0, 0, 0);
    camera.quaternion.slerp(sensor.q, 0.35);                    // 手ぶれを少しなめらかに
  } else {
    hudMesh.visible = false;
    rig.rotation.set(pitch, yaw, 0, 'YXZ');
  }
  updateHud();
  renderer.render(scene, camera);
});
