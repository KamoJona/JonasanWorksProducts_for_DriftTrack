// 端末の向き (DeviceOrientation) → 端末座標から地球座標 (東・北・上) への回転
const D2R = Math.PI / 180;

export function quatFromEuler(alpha, beta, gamma) {
  // W3C 仕様の Z-X'-Y'' 内因性回転
  const x = beta * D2R / 2, y = gamma * D2R / 2, z = alpha * D2R / 2;
  const cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z);
  const sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
  return [
    cX * cY * cZ - sX * sY * sZ, // w
    sX * cY * cZ - cX * sY * sZ, // x
    cX * sY * cZ + sX * cY * sZ, // y
    cX * cY * sZ + sX * sY * cZ, // z
  ];
}

export function slerp(a, b, t) {
  let [aw, ax, ay, az] = a, [bw, bx, by, bz] = b;
  let dot = aw * bw + ax * bx + ay * by + az * bz;
  if (dot < 0) { bw = -bw; bx = -bx; by = -by; bz = -bz; dot = -dot; }
  let k0, k1;
  if (dot > 0.9995) { k0 = 1 - t; k1 = t; }
  else {
    const th = Math.acos(dot), s = Math.sin(th);
    k0 = Math.sin((1 - t) * th) / s; k1 = Math.sin(t * th) / s;
  }
  const r = [aw * k0 + bw * k1, ax * k0 + bx * k1, ay * k0 + by * k1, az * k0 + bz * k1];
  const l = Math.hypot(...r);
  return r.map((v) => v / l);
}

// 回転行列 (行優先 3x3)。列 = 端末の x,y,z 軸を地球座標で表したもの
export function matFromQuat([w, x, y, z]) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

// 方位 yaw / 仰角 pitch (度) を向いて縦持ちしている端末の回転行列 (シミュレーション用)
export function matFromYawPitch(yawDeg, pitchDeg) {
  const yw = yawDeg * D2R, p = pitchDeg * D2R;
  const f = [Math.sin(yw) * Math.cos(p), Math.cos(yw) * Math.cos(p), Math.sin(p)]; // カメラ前方 = -z
  const xa = [Math.cos(yw), -Math.sin(yw), 0];
  const za = [-f[0], -f[1], -f[2]];
  const ya = [za[1] * xa[2] - za[2] * xa[1], za[2] * xa[0] - za[0] * xa[2], za[0] * xa[1] - za[1] * xa[0]];
  return [xa[0], ya[0], za[0], xa[1], ya[1], za[1], xa[2], ya[2], za[2]];
}

// カメラ (背面, 端末 -z 方向) が向いている方位・仰角 (度)
export function cameraDirection(m) {
  const e = -m[2], n = -m[5], u = -m[8];
  return {
    heading: ((Math.atan2(e, n) / D2R) + 360) % 360,
    pitch: Math.asin(Math.max(-1, Math.min(1, u))) / D2R,
  };
}

function wrap180(a) { return ((a + 540) % 360) - 180; }

export class OrientationSensor {
  constructor() {
    this.q = null;
    this.absolute = false;
    this.iosOffset = null; // iOS: webkitCompassHeading と相対 alpha の差
    this.lastEvent = 0;
    this._onEvent = this._onEvent.bind(this);
  }

  static async requestPermission() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      const r = await DOE.requestPermission();
      if (r !== 'granted') throw new Error('方位センサーの使用が許可されませんでした');
    }
  }

  start() {
    if ('ondeviceorientationabsolute' in window) {
      window.addEventListener('deviceorientationabsolute', this._onEvent);
      this.absolute = true;
    } else {
      window.addEventListener('deviceorientation', this._onEvent);
    }
  }

  stop() {
    window.removeEventListener('deviceorientationabsolute', this._onEvent);
    window.removeEventListener('deviceorientation', this._onEvent);
  }

  _onEvent(e) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    let alpha = e.alpha;
    if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) {
      // iOS: alpha は任意基準なので、コンパス方位との差で北基準に補正する。
      // webkitCompassHeading は傾き補正済みの「カメラ/端末上端の向く方位」
      const raw = cameraDirection(matFromQuat(quatFromEuler(e.alpha, e.beta, e.gamma)));
      // 端末をほぼ水平に置いた状態ではカメラ方位が定まらないので更新しない
      if (Math.abs(raw.pitch) < 60 || this.iosOffset == null) {
        const offset = wrap180(e.webkitCompassHeading - raw.heading);
        this.iosOffset = this.iosOffset == null ? offset
          : this.iosOffset + wrap180(offset - this.iosOffset) * 0.05;
      }
      if (this.iosOffset == null) return;
      // 方位は時計回り、alpha は反時計回りなので符号が逆になる
      alpha = e.alpha - this.iosOffset;
      this.absolute = true;
    } else if (!this.absolute && e.absolute) {
      this.absolute = true;
    }
    const q = quatFromEuler(alpha, e.beta, e.gamma);
    this.q = this.q ? slerp(this.q, q, 0.25) : q;
    this.lastEvent = performance.now();
  }

  get matrix() { return this.q ? matFromQuat(this.q) : null; }
}
