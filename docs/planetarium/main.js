import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

// =====================================================================
// 座標と単位
//   シーンの 1 = 1 メートル。VR で頭を動かしても宇宙のスケールでは無視できる。
//   観測者の位置 obs は JS の倍精度で「太陽中心・赤道座標 (J2000)」に持ち、
//   描画するときは天体を obs からの相対位置に置く (floating origin)。
//   これで地球周辺の数 km から 10 万光年先まで、GPU の単精度でも破綻しない。
//   軸: x = 春分点方向, y = 天の北極, z = -(赤道座標の y)
//   天体位置の計算は astro.js
// =====================================================================
import { ephemeris, M_PER_PC, M_PER_LY, KM, R_EARTH, R_MOON, R_SUN, DEG } from './astro.js';

const startDate = new Date();
const eph = ephemeris(startDate);

// ---------- 基本セットアップ ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 1, 1e15);
// rig は常に原点。向きだけを持ち、移動は obs (観測者位置) を動かして表現する
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- 地球・月・太陽 ----------
const texUrl = (name) => window.EMBED_TEXTURES?.[name] ?? `./textures/${name}.jpg`;
const loader = new THREE.TextureLoader();
const loadTex = (name) => { const t = loader.load(texUrl(name)); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; };

const earthMesh = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH, 96, 48),
  new THREE.MeshLambertMaterial({ map: loadTex('earth') }));
// SphereGeometry の経度 0 は +x、東経 90° は -z を向く → y 軸回転 = 恒星時
earthMesh.rotation.y = eph.gmst;
scene.add(earthMesh);

// 大気の薄い光の縁
const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH * 1.025, 64, 32), new THREE.ShaderMaterial({
  vertexShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_vertex>
    varying vec3 vN; varying vec3 vV;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */`
    #include <logdepthbuf_pars_fragment>
    varying vec3 vN; varying vec3 vV;
    void main() {
      #include <logdepthbuf_fragment>
      float rim = pow(1.0 - abs(dot(vN, vV)), 3.0);
      gl_FragColor = vec4(vec3(0.35, 0.6, 1.0) * rim, rim);
    }`,
  blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
}));
scene.add(atmosphere);

const moonMesh = new THREE.Mesh(new THREE.SphereGeometry(R_MOON, 64, 32),
  new THREE.MeshLambertMaterial({ map: loadTex('moon') }));
{
  // 潮汐固定: 月面の経度 0 (表側の中心) を地球に向け、北をおおよそ天の北に合わせる
  const x = eph.earth.clone().sub(eph.moon).normalize();
  const z = new THREE.Vector3().crossVectors(x, new THREE.Vector3(0, 1, 0)).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  moonMesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
scene.add(moonMesh);

const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(R_SUN, 48, 24),
  new THREE.MeshBasicMaterial({ color: 0xfff4e0 }));
scene.add(sunMesh);
const glowTex = (() => {
  const c = Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(255,245,220,1)');
  grd.addColorStop(0.15, 'rgba(255,220,160,0.6)');
  grd.addColorStop(0.4, 'rgba(255,180,90,0.12)');
  grd.addColorStop(1, 'rgba(255,160,60,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
})();
const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
sunGlow.scale.setScalar(R_SUN * 12);
scene.add(sunGlow);

const sunLight = new THREE.DirectionalLight(0xffffff, 3.0);
scene.add(sunLight, sunLight.target);
scene.add(new THREE.AmbientLight(0x50607a, 0.25));   // 夜側・月の影側がわずかに見える程度 (地球照の代わり)

// 名前ラベル (画面上の大きさ一定。天体が小さく見えるときだけ表示)
function makeLabel(text) {
  const c = Object.assign(document.createElement('canvas'), { width: 256, height: 64 });
  const g = c.getContext('2d');
  g.font = '600 34px sans-serif';
  g.textAlign = 'center';
  g.fillStyle = 'rgba(200,225,255,0.9)';
  g.fillText(text, 128, 30);
  g.strokeStyle = 'rgba(200,225,255,0.6)';
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(128, 40); g.lineTo(128, 62); g.stroke();
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true, sizeAttenuation: false }));
  sp.center.set(0.5, -0.05);
  sp.scale.set(0.32, 0.08, 1);
  sp.renderOrder = 5;
  scene.add(sp);
  return sp;
}

const bodies = [
  { mesh: earthMesh, pos: eph.earth, r: R_EARTH, extra: [atmosphere], label: makeLabel('地球') },
  { mesh: moonMesh, pos: eph.moon, r: R_MOON, label: makeLabel('月') },
  { mesh: sunMesh, pos: eph.sun, r: R_SUN, extra: [sunGlow], label: makeLabel('太陽') },
];

// ---------- 恒星 ----------
async function loadStars(url) {
  const buf = window.STARS_B64
    ? Uint8Array.from(atob(window.STARS_B64), (c) => c.charCodeAt(0)).buffer
    : await (await fetch(url)).arrayBuffer();
  const n = new DataView(buf).getUint32(0, true);
  const data = new Float32Array(buf, 4, n * 4);            // x, y, z [pc], 絶対等級
  const color = new Uint8Array(buf, 4 + n * 16, n * 4);    // r, g, b, a
  const geo = new THREE.BufferGeometry();
  const ib = new THREE.InterleavedBuffer(data, 4);
  geo.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
  geo.setAttribute('absmag', new THREE.InterleavedBufferAttribute(ib, 1, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(color, 4, true));
  return geo;
}

// 恒星は観測者からの「方向」に、十分遠い固定距離 STAR_SHELL で描く。
// 明るさは実際の距離 (パーセク) から見かけの等級を計算して決める。
const STAR_SHELL = 1e14;
const starMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uObsPc:    { value: new THREE.Vector3() },  // 観測者位置 [pc]
    uLimitMag: { value: 6.5 },   // この等級で「ちょうど見える」
    uFloor:    { value: 0.03 },  // 暗い星も少しだけ描いて 3D 構造を見せる
    uScale:    { value: renderer.getPixelRatio() },
    uShell:    { value: STAR_SHELL },
  },
  vertexShader: /* glsl */`
    #include <common>
    #include <logdepthbuf_pars_vertex>
    attribute float absmag;
    attribute vec4 color;
    uniform vec3 uObsPc;
    uniform float uLimitMag, uFloor, uScale, uShell;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vec3 rel = position - uObsPc;
      float d = max(length(rel), 1e-6);                          // pc
      float m = absmag + 5.0 * log(d / 10.0) / log(10.0);        // 見かけの等級
      float b = pow(10.0, -0.4 * (m - uLimitMag));               // 限界等級を 1 とした明るさ
      if (d < 1e-3) b = 0.0;   // 約 200 AU 以内の太陽は 3D の球で描くので点は消す
      vAlpha = b == 0.0 ? 0.0 : max(min(b, 1.0), uFloor);
      vColor = color.rgb;
      gl_PointSize = clamp(1.5 + 2.5 * pow(b, 0.35), 1.0, 40.0) * uScale;
      vec3 world = cameraPosition + normalize(rel) * uShell;
      gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */`
    #include <logdepthbuf_pars_fragment>
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      #include <logdepthbuf_fragment>
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float r2 = dot(p, p);
      if (r2 > 1.0) discard;
      gl_FragColor = vec4(vColor * exp(-r2 * 6.0) * vAlpha, 1.0);
    }`,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  transparent: true,
});

loadStars('./data/stars.bin').then((geo) => {
  const pts = new THREE.Points(geo, starMaterial);
  pts.frustumCulled = false;
  pts.renderOrder = -1;
  scene.add(pts);
});

// ---------- 開始位置: 地球のそばから月の方を向く ----------
// 地球の 3 万 km 後方・1.2 万 km 上に置き、地球が視界の下に入るようにする
const obs = new THREE.Vector3();
let yaw = 0, pitch = 0;
{
  const toMoon = eph.moon.clone().sub(eph.earth).normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const up = worldUp.clone().sub(toMoon.clone().multiplyScalar(worldUp.dot(toMoon))).normalize();
  obs.copy(eph.earth).addScaledVector(toMoon, -30000 * KM).addScaledVector(up, 12000 * KM);
  const dir = eph.moon.clone().sub(obs).normalize();
  // rotation 'YXZ' で -z が前方: dir = (-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch))
  pitch = Math.asin(dir.y);
  yaw = Math.atan2(-dir.x, -dir.z);
}

// ---------- 速度 ----------
// 内部は m/s。表示は遅いうちは km/h、速くなったら光年/h
let speed = 1e8 * KM / 3600;                     // 時速 1 億 km (月まで約 14 秒)
const SPEED_MIN = 1e3 * KM / 3600, SPEED_MAX = 1e8 * M_PER_LY / 3600;
const clampSpeed = (v) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, v));
function fmtJa(v) {
  const units = [[1e12, '兆'], [1e8, '億'], [1e4, '万']];
  for (const [u, s] of units) if (v >= u) return `${(v / u).toLocaleString('ja-JP', { maximumFractionDigits: v / u < 10 ? 1 : 0 })}${s}`;
  return Math.round(v).toLocaleString('ja-JP');
}
function speedText() {
  const kmh = speed * 3600 / KM;
  const lyh = speed * 3600 / M_PER_LY;
  return lyh >= 0.01 ? `時速 ${fmtJa(lyh)} 光年` : `時速 ${fmtJa(kmh)} km`;
}

// ---------- デスクトップ / スマホ操作 ----------
// マウスでもタッチでも同じく、ドラッグで視点を回す (指の動きに星空がついてくる)
let drag = null, touchMove = 0;
const keys = new Set();
const canvas = renderer.domElement;
canvas.style.touchAction = 'none';
canvas.addEventListener('pointerdown', (e) => { drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => (drag = null));
canvas.addEventListener('pointercancel', () => (drag = null));
canvas.addEventListener('pointermove', (e) => {
  if (!drag || drag.id !== e.pointerId || renderer.xr.isPresenting) return;
  const k = (e.pointerType === 'touch' ? 0.005 : 0.003) * camera.fov / 70;
  yaw += (e.clientX - drag.x) * k;
  pitch = Math.max(-1.55, Math.min(1.55, pitch + (e.clientY - drag.y) * k));
  drag.x = e.clientX; drag.y = e.clientY;
});
addEventListener('keydown', (e) => keys.add(e.code));
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('wheel', (e) => (speed = clampSpeed(speed * Math.exp(-e.deltaY * 0.003))));

// 画面上のボタン: 前進・後退は押している間だけ、速度は 1 回押すごとに ×10 / ÷10
for (const b of document.querySelectorAll('[data-move]')) {
  const v = Number(b.dataset.move);
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); touchMove = v; b.setPointerCapture(e.pointerId); });
  for (const ev of ['pointerup', 'pointercancel']) b.addEventListener(ev, () => (touchMove = 0));
}
for (const b of document.querySelectorAll('[data-speed]')) {
  b.addEventListener('click', () => (speed = clampSpeed(speed * Number(b.dataset.speed))));
}

// VR 開始時はデスクトップで付けた上下の傾きを外す (酔い防止)
renderer.xr.addEventListener('sessionstart', () => { pitch = 0; });

// ---------- XR コントローラー / ハンドトラッキング ----------
// select (トリガー、または Android XR のピンチ) を押している間、その入力が指す方向へ進む
const controllers = [0, 1].map((i) => {
  const c = renderer.xr.getController(i);
  c.userData.active = false;
  c.addEventListener('selectstart', () => (c.userData.active = true));
  c.addEventListener('selectend', () => (c.userData.active = false));
  c.addEventListener('connected', (e) => (c.userData.source = e.data));
  c.addEventListener('disconnected', () => { c.userData.source = null; c.userData.active = false; });
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x66aaff, transparent: true, opacity: 0.5 }));
  line.scale.z = 0.5;
  c.add(line);
  rig.add(c);
  return c;
});

// VR 内の速度表示 (ヘッドに追従する小さなパネル)
const hudCanvas = Object.assign(document.createElement('canvas'), { width: 640, height: 120 });
const hudTex = new THREE.CanvasTexture(hudCanvas);
const hudMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.094),
  new THREE.MeshBasicMaterial({ map: hudTex, transparent: true, depthTest: false }));
hudMesh.position.set(0, -0.22, -0.8);
hudMesh.renderOrder = 10;
camera.add(hudMesh);

const speedEl = document.getElementById('speed');
const posEl = document.getElementById('pos');
const timeEl = document.getElementById('epoch');
if (timeEl) timeEl.textContent = `${startDate.toLocaleString('ja-JP', { dateStyle: 'medium', timeStyle: 'short' })} の配置`;

function whereText() {
  const fromSunLy = obs.length() / M_PER_LY;
  if (fromSunLy >= 0.01) return `太陽から ${fmtJa(fromSunLy)} 光年`;
  const dEarth = (obs.distanceTo(eph.earth) - R_EARTH) / KM;
  const dMoon = (obs.distanceTo(eph.moon) - R_MOON) / KM;
  if (dEarth < 5e7 || dMoon < 5e7) return `地球まで ${fmtJa(dEarth)} km ・ 月まで ${fmtJa(dMoon)} km`;
  return `太陽まで ${fmtJa((obs.length() - R_SUN) / KM)} km`;
}

let lastHud = '';
function updateHud() {
  const text = speedText();
  const sub = whereText();
  if (text + sub === lastHud) return;
  lastHud = text + sub;
  speedEl.textContent = text;
  posEl.textContent = sub;
  const g = hudCanvas.getContext('2d');
  g.clearRect(0, 0, 640, 120);
  g.fillStyle = 'rgba(0,10,30,0.55)';
  g.fillRect(0, 0, 640, 120);
  g.fillStyle = '#fff';
  g.font = 'bold 44px sans-serif';
  g.fillText(text, 18, 52);
  g.font = '30px sans-serif';
  g.fillStyle = '#9bd';
  g.fillText(sub, 18, 100);
  hudTex.needsUpdate = true;
}

// ---------- ループ ----------
const clock = new THREE.Clock();
const dir = new THREE.Vector3();
const q = new THREE.Quaternion();
const tmp = new THREE.Vector3();

function move(direction, dist) {
  obs.addScaledVector(direction, dist);
  // 地球や月にめり込まないように押し戻す
  for (const b of bodies) {
    tmp.subVectors(obs, b.pos);
    const min = b.r * 1.01;
    if (tmp.length() < min) obs.copy(b.pos).addScaledVector(tmp.normalize(), min);
  }
}

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const step = speed * dt;

  if (renderer.xr.isPresenting) {
    hudMesh.visible = true;
    rig.rotation.set(0, yaw, 0, 'YXZ');
    for (const c of controllers) {
      const gp = c.userData.source?.gamepad;
      // スティック上下 (xr-standard では axes[3]) で速度を指数的に変更
      if (gp && gp.axes.length >= 4 && Math.abs(gp.axes[3]) > 0.2) {
        speed = clampSpeed(speed * Math.exp(-gp.axes[3] * dt * 2.5));
      }
      if (c.userData.active) {
        c.getWorldQuaternion(q);
        move(dir.set(0, 0, -1).applyQuaternion(q), step);
      }
    }
  } else {
    hudMesh.visible = false;
    rig.rotation.set(pitch, yaw, 0, 'YXZ');
    const fwd = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) + touchMove;
    if (fwd) move(camera.getWorldDirection(dir), step * fwd);
  }

  // 天体を観測者からの相対位置に置く
  for (const b of bodies) {
    b.mesh.position.subVectors(b.pos, obs);
    for (const e of b.extra ?? []) e.position.copy(b.mesh.position);
    const dist = b.mesh.position.length();
    b.label.position.copy(b.mesh.position);
    // 見かけの半径が 2° 未満、かつ 0.1 光年以内のときだけラベルを出す
    b.label.visible = b.r / dist < Math.sin(2 * DEG) && dist < 0.1 * M_PER_LY;
  }
  sunLight.position.copy(sunMesh.position);
  sunLight.target.position.set(0, 0, 0);
  starMaterial.uniforms.uObsPc.value.copy(obs).divideScalar(M_PER_PC);

  updateHud();
  renderer.render(scene, camera);
});
