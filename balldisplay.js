// Court Cam ball display smoother — pure JS (no DOM) so it can be tested in Node.
// Detections (video px, ms) go in through meas(); render(t) is called every display frame (requestAnimationFrame)
// and returns a smoothly predicted position. Per axis it is a constant-acceleration Kalman filter (the image-space
// acceleration absorbs gravity + perspective). Short gaps coast along the predicted curve and fade slightly;
// re-acquisition eases back instead of snapping; far-off hits are gated out so false hits can't teleport the marker.
class K1 {
  constructor(p, v, R) { this.x = [p, v, 0]; this.P = [[R, 0, 0], [0, 4e5, 0], [0, 0, 4e5]]; }
  predict(dt, q) {
    const [p, v, a] = this.x, P = this.P, d2 = dt * dt / 2;
    this.x = [p + v * dt + a * d2, v + a * dt, a];
    const F = [[1, dt, d2], [0, 1, dt], [0, 0, 1]];
    const FP = F.map((r) => [0, 1, 2].map((j) => r[0] * P[0][j] + r[1] * P[1][j] + r[2] * P[2][j]));
    const N = FP.map((r) => [0, 1, 2].map((j) => r[0] * F[j][0] + r[1] * F[j][1] + r[2] * F[j][2]));
    const t2 = dt * dt, t3 = t2 * dt, t4 = t3 * dt, t5 = t4 * dt;
    const Q = [[t5 / 20, t4 / 8, t3 / 6], [t4 / 8, t3 / 3, t2 / 2], [t3 / 6, t2 / 2, dt]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) N[i][j] += q * Q[i][j];
    this.P = N;
  }
  S(R) { return this.P[0][0] + R; }
  update(z, R) {
    const P = this.P, s = P[0][0] + R, K = [P[0][0] / s, P[1][0] / s, P[2][0] / s], y = z - this.x[0];
    this.x = this.x.map((v, i) => v + K[i] * y);
    this.P = P.map((r, i) => r.map((v, j) => v - K[i] * P[0][j]));
  }
  at(dt) { const [p, v, a] = this.x, da = Math.min(dt, 0.2); return p + v * dt + a * (da * da / 2 + da * (dt - da)); } // acceleration only trusted for 0.2 s
}
export class BallDisplay {
  constructor(opt = {}) {
    this.o = Object.assign({ coast: 600, fadeStart: 180, R: 4, q: 3e6, trailMs: 650, ease: 80, gateK: 6, gateMin: 0.03, turnGate: 0.07, maxAcc: 9000 }, opt);
    this.reset();
  }
  reset() { this.kx = this.ky = null; this.alive = false; this.trail = []; this.seg = 0; this.off = [0, 0]; this.offT = 0; this.tm = 0; this.t0 = 0; this.n = 0; this.rej = 0; this.id = null; this.last = null; this.vis = null; }
  setFrame(W, H) { this.W = W; this.H = H; }
  _init(x, y, t, vx = 0, vy = 0) {
    const R = this.o.R * this.o.R;
    this.kx = new K1(x, vx, R); this.ky = new K1(y, vy, R);
    if (vx || vy) { this.kx.P[1][1] = this.ky.P[1][1] = 4e4; }
    this.t0 = this.tm = t; this.alive = true; this.seg++; this.off = [0, 0]; this.n = 1; this.rej = 0; this.last = [x, y, t];
  }
  // x,y video px; info: {turn, id}. Returns true when the measurement was used.
  meas(x, y, t, info = {}) {
    const o = this.o, W = this.W || 1280, R = o.R * o.R;
    // a newly confirmed tracklet arrives with the frames it took to confirm (info.back = [[x,y,t],...])
    if (info.back && info.back.length && info.id !== this.id) return this._newTrack([...info.back, [x, y, t]], info);
    if (!this.alive || t - this.tm > o.coast) {
      // re-acquired after a gap: start from where the coasting marker was (if close) so it eases in
      const was = this.vis && t - this.vis.t < 120 ? this.vis : null;
      this._init(x, y, t); this.id = info.id;
      if (was && Math.hypot(was.x - x, was.y - y) < W * o.turnGate) { this.seg--; this.off = [was.x - x, was.y - y]; this.offT = t; }
      return true;
    }
    if (t <= this.tm) return false;
    const dt = (t - this.tm) / 1000, kx = this.kx, ky = this.ky;
    const px = kx.at(dt), py = ky.at(dt), d = Math.hypot(x - px, y - py);
    const before = this.render(t, true);
    kx.predict(dt, o.q); ky.predict(dt, o.q);
    const gate = Math.max(W * o.gateMin, o.gateK * Math.sqrt((kx.S(R) + ky.S(R)) / 2));
    const near = Math.hypot(x - this.last[0], y - this.last[1]) < W * o.turnGate;
    if (d > gate) {
      if (info.turn && near) { // hit / bounce: keep position continuity, restart velocity from the last two points
        const vx = (x - this.last[0]) / dt, vy = (y - this.last[1]) / dt;
        this.ev = { x: this.last[0], y: this.last[1], t, kind: 'turn' };
        kx.x = [kx.x[0], vx, 0]; ky.x = [ky.x[0], vy, 0]; kx.P[1][1] = ky.P[1][1] = 1e5; kx.P[2][2] = ky.P[2][2] = 1e6;
      } else {
        this.rej++;
        // a different track that keeps coming while ours is going stale: switch (new trail segment, no line between)
        if (info.id != null && info.id !== this.id && this.rej >= 2 && t - this.tm > 150) { this._init(x, y, t); this.id = info.id; return true; }
        // undo the predict (state stays at the last good update)
        this._rollback(dt);
        return false;
      }
    }
    kx.update(x, R); ky.update(y, R);
    // clamp absurd accelerations (a single noisy point shouldn't bend the curve wildly)
    for (const k of [kx, ky]) k.x[2] = Math.max(-this.o.maxAcc, Math.min(this.o.maxAcc, k.x[2]));
    this.tm = t; this.n++; this.rej = 0; this.id = info.id ?? this.id; this.last = [x, y, t];
    if (before) { const nx = kx.x[0], ny = ky.x[0]; this.off = [before.x - nx, before.y - ny]; this.offT = t; }
    return true;
  }
  _newTrack(pts, info) {
    const o = this.o, W = this.W || 1280, R = o.R * o.R, t = pts[pts.length - 1][2];
    const live = this.alive && t - this.tm <= o.coast;
    const cont = live && Math.hypot(pts[0][0] - this.last[0], pts[0][1] - this.last[1]) < W * o.turnGate * 1.5;
    // a far-away tracklet while ours is still being updated is more likely a false hit: ignore it
    if (live && !cont && t - this.tm < 100) { this.rej++; return false; }
    const was = live ? this.render(t, true) : (this.vis && t - this.vis.t < 120 ? this.vis : null);
    const seg = this.seg;
    this._init(pts[0][0], pts[0][1], pts[0][2]);
    for (let i = 1; i < pts.length; i++) { // replay the history without gating
      const dt = Math.max(0.001, (pts[i][2] - this.tm) / 1000);
      this.kx.predict(dt, o.q); this.ky.predict(dt, o.q); this.kx.update(pts[i][0], R); this.ky.update(pts[i][1], R); this.tm = pts[i][2];
    }
    for (const k of [this.kx, this.ky]) k.x[2] = Math.max(-o.maxAcc, Math.min(o.maxAcc, k.x[2]));
    this.n = pts.length; this.id = info.id; this.last = pts[pts.length - 1];
    if (cont) this.ev = { x: pts[0][0], y: pts[0][1], t, kind: 'hit' };
    if (was && (cont || Math.hypot(was.x - this.kx.x[0], was.y - this.ky.x[0]) < W * o.turnGate)) { this.seg = seg; this.off = [was.x - this.kx.x[0], was.y - this.ky.x[0]]; this.offT = t; }
    return true;
  }
  _rollback(dt) { // revert one predict step by predicting backwards (state only; covariance kept inflated = more open gate next time)
    for (const k of [this.kx, this.ky]) { const [p, v, a] = k.x; const v0 = v - a * dt; k.x = [p - v0 * dt - a * dt * dt / 2, v0, a]; }
  }
  // position to draw at display time t (ms). peek=true: no side effects.
  render(t, peek = false) {
    if (!this.alive) return null;
    const o = this.o, dtc = t - this.tm;
    if (dtc > o.coast) { if (!peek) this.alive = false; return null; }
    const dt = Math.max(0, dtc) / 1000;
    const e = Math.exp(-(t - this.offT) / o.ease);
    let x = this.kx.at(dt) + this.off[0] * e, y = this.ky.at(dt) + this.off[1] * e;
    const W = this.W || 1e5, H = this.H || 1e5;
    if (dtc > 60 && (x < -20 || y < -20 || x > W + 20 || y > H + 20)) { if (!peek) this.alive = false; return null; }
    let a = 1;
    if (dtc > o.fadeStart) a = 1 - 0.55 * (dtc - o.fadeStart) / (o.coast - o.fadeStart);
    if (dtc > o.coast - 80) a *= (o.coast - dtc) / 80;
    const r = { x, y, a, coasting: dtc > 70, t, seg: this.seg, vx: this.kx.x[1] + this.kx.x[2] * dt, vy: this.ky.x[1] + this.ky.x[2] * dt };
    if (!peek) {
      this.vis = r;
      const L = this.trail[this.trail.length - 1];
      if (!L || t - L.t >= 10) this.trail.push({ x, y, t, a, seg: this.seg, k: this.kmh || 0 });
    }
    return r;
  }
  trailPts(t) { const o = this.o; while (this.trail.length && t - this.trail[0].t > o.trailMs) this.trail.shift(); return this.trail; }
}
