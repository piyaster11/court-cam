// Court Cam ball tracker (tennis / football) — pure JS, no DOM, so it can be unit-tested in Node.
// Per video frame: motion-compensated 3-frame differencing on a small (~640 px) luma image,
// small-blob candidates, flicker heat-map suppression, multi-hypothesis tracklets with
// constant-velocity prediction; a tracklet is reported once it has been consistent for a few frames.
// RMS residual of a least-squares polynomial (deg 1 or 2) fit of coordinate j (0=x,1=y) against time
function fitRes(P, j, deg) {
  const n = P.length, t0 = P[0][2]; let S = [0, 0, 0, 0, 0], B = [0, 0, 0];
  for (const p of P) { const t = (p[2] - t0) / 100, v = p[j]; let tp = 1; for (let e = 0; e <= 4; e++) { S[e] += tp; if (e <= 2) B[e] += tp * v; tp *= t; } }
  let c;
  if (deg === 1) { const d = S[0] * S[2] - S[1] * S[1] || 1e-9; c = [(B[0] * S[2] - S[1] * B[1]) / d, (S[0] * B[1] - S[1] * B[0]) / d, 0]; }
  else {
    const M = [[S[0], S[1], S[2], B[0]], [S[1], S[2], S[3], B[1]], [S[2], S[3], S[4], B[2]]];
    for (let i = 0; i < 3; i++) { let m = i; for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[m][i])) m = r; [M[i], M[m]] = [M[m], M[i]]; const d = M[i][i] || 1e-9; for (let r = 0; r < 3; r++) if (r !== i) { const f = M[r][i] / d; for (let q = i; q < 4; q++) M[r][q] -= f * M[i][q]; } }
    c = [M[0][3] / (M[0][0] || 1e-9), M[1][3] / (M[1][1] || 1e-9), M[2][3] / (M[2][2] || 1e-9)];
  }
  let e = 0; for (const p of P) { const t = (p[2] - t0) / 100; e += (c[0] + c[1] * t + c[2] * t * t - p[j]) ** 2; }
  return Math.sqrt(e / n);
}
// Play volume in tracker pixels: per column, the band [top, bot] where a ball can be — the court (+ margins) on the
// ground plus the air above it up to a sensible height. fromCourt(X,Y) -> [x,y] tracker px; dims = [width, length] m.
// Geometric smoothness, independent of frame timing jitter: rotate onto the chord, require the points to advance
// monotonically along it and the sideways offset to follow a quadratic (a flight arc) within a few px.
function pathRes(P) {
  const n = P.length, a = P[0], b = P[n - 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-6, ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  const Q = P.map((p) => [(p[0] - a[0]) * ux + (p[1] - a[1]) * uy, -(p[0] - a[0]) * uy + (p[1] - a[1]) * ux, p[2]]);
  for (let i = 1; i < n; i++) if (Q[i][0] < Q[i - 1][0] - 1.5) return 99; // goes backwards along its own path
  // fit offset = c0 + c1 u + c2 u^2 (u normalised) via fitRes on [u, off] pairs (time slot reused for u)
  return fitRes(Q.map((q) => [0, q[1], q[0] * 100 / L]), 1, n >= 5 ? 2 : 1);
}
export function buildZone(fromCourt, dims, rw, rh, ox = 0, oy = 0, opt = {}) {
  const [w, l] = dims, ms = opt.side ?? 3.5, me = opt.end ?? 5, Hin = opt.hIn ?? 7, Hout = opt.hOut ?? 2.5;
  const top = new Float32Array(rw).fill(1e9), bot = new Float32Array(rw).fill(-1e9);
  for (let X = -ms; X <= w + ms + 1e-6; X += 0.5) for (let Y = -me; Y <= l + me + 1e-6; Y += 0.5) {
    const g = fromCourt(X, Y), a = fromCourt(X - 0.5, Y), b = fromCourt(X + 0.5, Y); if (!g || !a || !b) continue;
    const s = Math.hypot(b[0] - a[0], b[1] - a[1]); // px per metre here (also used as vertical scale)
    const out = Math.max(0, -X, X - w, -Y, Y - l), mx = Math.max(ms, me);
    const hh = out <= 0 ? Hin : Hin + (Hout - Hin) * Math.min(1, out / Math.min(mx, 3));
    const x = g[0] - ox, yb = g[1] - oy + 0.3 * s, yt = g[1] - oy - hh * s, r = Math.max(1, s * 0.5);
    for (let xi = Math.max(0, Math.floor(x - r)); xi <= Math.min(rw - 1, Math.ceil(x + r)); xi++) { if (yt < top[xi]) top[xi] = yt; if (yb > bot[xi]) bot[xi] = yb; }
  }
  return { w: rw, h: rh, top, bot };
}
export class BallTracker {
  constructor(opt = {}) {
    this.o = Object.assign({ fitTol: 1.6, panPx: 3, minPxS: 70, T: 16, cell: 8, heatDecay: 0.965, heatMax: 2.5, confirmN: 4, maxTracks: 8, shiftR: 8, tennis: true }, opt);
    this.reset();
    this.frames = 0; this.hits = 0; this.skipped = 0;
  }
  reset() { this.L1 = this.L2 = this.D1 = this.D2 = null; this.c1 = []; this.c2 = []; this.tracks = []; this.sh1 = [0, 0]; this.dims = null; this.nextId = 1; }
  // rgba: Uint8ClampedArray of the ROI (rw x rh), t: ms, boxes: [[x0,y0,x1,y1]] in ROI px to ignore (people)
  push(rgba, rw, rh, t, boxes = []) {
    const o = this.o, n = rw * rh;
    if (!this.dims || this.dims[0] !== rw || this.dims[1] !== rh) { this.reset(); this.dims = [rw, rh]; this.hw = Math.ceil(rw / o.cell); this.heat = new Float32Array(this.hw * Math.ceil(rh / o.cell)); }
    const L = new Uint8Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j++) L[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    // 3x3 max filter: compare against the neighbourhood so sub-pixel shake and edges don't fire
    const D = new Uint8Array(n), tmp = new Uint8Array(n);
    for (let y = 0; y < rh; y++) { const r = y * rw; for (let x = 0; x < rw; x++) { const j = r + x; let m = L[j]; if (x > 0 && L[j - 1] > m) m = L[j - 1]; if (x < rw - 1 && L[j + 1] > m) m = L[j + 1]; tmp[j] = m; } }
    for (let y = 0; y < rh; y++) { const r = y * rw; for (let x = 0; x < rw; x++) { const j = r + x; let m = tmp[j]; if (y > 0 && tmp[j - rw] > m) m = tmp[j - rw]; if (y < rh - 1 && tmp[j + rw] > m) m = tmp[j + rw]; D[j] = m; } }
    const L1 = this.L1, D1 = this.D1, D2 = this.D2, t1 = this.t1, t2 = this.t2;
    let sh = [0, 0];
    if (L1) sh = this.shift(L, L1, rw, rh);
    const sh2 = [sh[0] + this.sh1[0], sh[1] + this.sh1[1]];
    this.pt = [this.t2, t1]; this.L2 = L1; this.D2 = D1; this.t2 = t1; this.L1 = L; this.D1 = D; this.t1 = t; this.sh1 = sh;
    if (!D1 || !D2) return null;
    this.frames++;
    // candidates: brighter than the (motion-compensated) neighbourhood in BOTH previous frames
    const T = o.T, mask = new Uint8Array(n), o1 = sh[1] * rw + sh[0], o2 = sh2[1] * rw + sh2[0];
    const mx0 = Math.max(Math.abs(sh[0]), Math.abs(sh2[0])) + 1, my0 = Math.max(Math.abs(sh[1]), Math.abs(sh2[1])) + 1;
    let flagged = 0;
    for (let y = my0; y < rh - my0; y++) {
      const rowB = boxes.filter((b) => y >= b[1] && y <= b[3]);
      for (let x = mx0, j = y * rw + mx0; x < rw - mx0; x++, j++) {
        const l = L[j]; if (l - D1[j + o1] <= T || l - D2[j + o2] <= T) continue;
        if (rowB.length) { let inB = false; for (const b of rowB) if (x >= b[0] && x <= b[2]) { inB = true; break; } if (inB) continue; }
        mask[j] = 1; flagged++;
      }
    }
    if (flagged > n * 0.03) { this.skipped++; this.c1 = []; this.tracks = []; return null; }
    this.rw = rw; let cands = this.blobs(mask, L, rgba, rw, rh);
    // play-volume gate (court + margins + air above it, from calibration): nothing over the stands / scoreboard
    const Z = this.zone;
    if (Z && Z.w === rw) cands = cands.filter((c) => { const xi = Math.min(rw - 1, Math.max(0, Math.round(c.x))); return c.y >= Z.top[xi] && c.y <= Z.bot[xi]; });
    // camera pans: no new tracks while (and just after) the view is moving
    const pan = Math.hypot(sh[0], sh[1]) >= this.o.panPx * rw / 800;
    this.panHold = pan ? 4 : Math.max(0, (this.panHold || 0) - 1);
    this.births = this.panHold === 0;
    const dt = Math.max((t - t1) / 1000, 0.005);
    this.dtAvg = this.dtAvg ? this.dtAvg * 0.9 + dt * 0.1 : dt;
    let best = this.track(cands, t, dt, rw);
    if (best && Math.hypot(sh[0], sh[1]) >= this.o.panPx * 1.7 * rw / 800) best = null; // fast pan: frame differencing is unreliable, show nothing
    this.c2 = this.c1; this.c1 = cands;
    if (best) this.hits++;
    return best;
  }
  // physics check before anything is shown: the points since the last hit/bounce must be dense in time and lie on a
  // smooth (quadratic in t) path. Crowd / scoreboard / shoe flicker is sparse and erratic and fails this.
  verify(k) {
    const h = k.h, sc = (this.rw || 800) / 800, tol = this.o.fitTol * sc, V = (this.vf ||= { short: 0, gap: 0, slow: 0, fit: 0, ok: 0 }), dtA = this.dtAvg || 0.033;
    const test = (seg, need) => {
      if (seg.length < need) return 'short';
      const span = (seg[seg.length - 1][2] - seg[0][2]) / 1000 || 1e-3;
      if (span > (seg.length - 1) * dtA * 1.8 + 0.02) return 'gap'; // too gappy
      if (!k.ok && Math.hypot(seg[seg.length - 1][0] - seg[0][0], seg[seg.length - 1][1] - seg[0][1]) / span < this.o.minPxS * sc) return 'slow'; // heads, chairs, shoes
      return pathRes(seg) > tol ? 'fit' : 'ok';
    };
    // whole recent history first (a "turn" flagged by timing jitter is fine if the path is still one smooth arc) ...
    let r = test(h.slice(-8), 6);
    if (r !== 'ok') { // ... else only the part after the last hit / bounce
      let s = h.length - 1; while (s > 0 && !h[s][3]) s--;
      if (s > 0) r = test(h.slice(s).slice(-8), k.ok ? 3 : 6);
    }
    V[r]++;
    k.ok = r === 'ok' || (r === 'short' && k.ok); // a just-bounced verified track stays verified but is not shown until 3 clean points
    return r === 'ok';
  }
  setZone(z) { this.zone = z; }
  shift(L, L1, rw, rh) {
    const R = this.o.shiftR, stp = 4, m0 = R + 1;
    const sad = (dx, dy) => { let e = 0; for (let y = m0; y < rh - m0; y += stp) { const a = y * rw, b = (y + dy) * rw + dx; for (let x = m0; x < rw - m0; x += stp) e += Math.abs(L[a + x] - L1[b + x]); } return e; };
    let be = sad(0, 0), sh = [0, 0];
    for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) { if (!dx && !dy) continue; const e = sad(dx, dy); if (e < be * 0.97) { be = e; sh = [dx, dy]; } }
    const c = sh.slice();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const e = sad(c[0] + dx, c[1] + dy); if (e < be) { be = e; sh = [c[0] + dx, c[1] + dy]; } }
    return sh;
  }
  blobs(mask, L, rgba, rw, rh) {
    const o = this.o, n = rw * rh, st = [], out = [], amax = Math.max(14, n * 0.00035), dmax = Math.max(6, rw * 0.045);
    for (let q = 0; q < n; q++) {
      if (mask[q] !== 1) continue;
      let a = 0, sx = 0, sy = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, col = 0; st.push(q); mask[q] = 2;
      while (st.length) {
        const u = st.pop(), ux = u % rw, uy = (u / rw) | 0; a++; sx += ux; sy += uy;
        if (ux < x0) x0 = ux; if (ux > x1) x1 = ux; if (uy < y0) y0 = uy; if (uy > y1) y1 = uy;
        const i = u * 4; col += (rgba[i] + rgba[i + 1]) / 2 - rgba[i + 2];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const vx = ux + dx, vy = uy + dy; if (vx < 0 || vy < 0 || vx >= rw || vy >= rh) continue; const v = vy * rw + vx; if (mask[v] === 1) { mask[v] = 2; st.push(v); } }
      }
      if (a > amax || x1 - x0 > dmax || y1 - y0 > dmax) continue;
      const cx = sx / a, cy = sy / a, gx = (cx / o.cell) | 0, gy = (cy / o.cell) | 0;
      let ht = 0; for (let yy = gy - 1; yy <= gy + 1; yy++) for (let xx = gx - 1; xx <= gx + 1; xx++) { if (xx < 0 || xx >= this.hw || yy < 0) continue; ht += this.heat[yy * this.hw + xx] || 0; }
      out.push({ x: cx, y: cy, a, col: col / a, heat: ht, hi: gy * this.hw + gx });
    }
    const hz = this.heat; for (let k = 0; k < hz.length; k++) hz[k] *= o.heatDecay;
    for (const c of out) hz[c.hi] += 1;
    let C = out.filter((c) => c.heat < o.heatMax);
    if (out.length > 60) C = C.filter((c) => c.heat < 1);
    return C.sort((p, q) => p.heat - q.heat).slice(0, 20);
  }
  track(C, t, dt, rw) {
    const o = Object.assign({}, this.o, { confirmN: this.o.confirmN - (this.dtAvg > 0.05 ? 1 : 0) }), minStep = 1.6, maxStep = rw * 0.12 * Math.min(4, dt * 30);
    const used = new Set();
    // 1. extend existing tracklets (confirmed first, then longest)
    this.tracks.sort((a, b) => (b.n >= o.confirmN) - (a.n >= o.confirmN) || b.n - a.n);
    for (const k of this.tracks) {
      const kt = Math.max((t - k.t) / 1000, 0.005), px = k.x + k.vx * kt, py = k.y + k.vy * kt, step = Math.hypot(k.vx, k.vy) * kt;
      const gate = 3 + step * 0.45 + k.miss * 2;
      let got = null, bd = 1e9;
      for (const c of C) { if (used.has(c)) continue; const d = Math.hypot(c.x - px, c.y - py) + c.heat * 2; if (d < gate && d < bd) { bd = d; got = c; } }
      let turn = false;
      if (!got && k.n >= o.confirmN) { // hit / bounce: direction change near the last position
        const near = C.filter((c) => { if (used.has(c)) return false; const d = Math.hypot(c.x - k.x, c.y - k.y); return d > minStep && d < Math.max(step * 1.4, 6) + 4; });
        if (near.length === 1) { got = near[0]; turn = true; }
      }
      if (got) {
        used.add(got);
        const vx = (got.x - k.x) / kt, vy = (got.y - k.y) / kt, a = turn ? 1 : 0.6;
        k.vx += (vx - k.vx) * a; k.vy += (vy - k.vy) * a; k.x = got.x; k.y = got.y; k.t = t; k.miss = 0; k.n++; k.a = got.a; k.turn = turn; k.col = k.col * 0.7 + got.col * 0.3; k.h.push([got.x, got.y, t, turn ? 1 : 0]); if (k.h.length > 14) k.h.shift();
        k.slow = Math.hypot(k.vx, k.vy) * dt < minStep * 0.6 ? k.slow + 1 : 0;
      } else { k.miss++; k.turn = false; }
    }
    this.tracks = this.tracks.filter((k) => k.miss <= (k.n >= o.confirmN ? 6 : 1) && k.slow < 3 && t - k.t < 300);
    // 2. births: three detections in a straight, evenly spaced line over consecutive frames
    if (this.births !== false && this.c1.length && this.c2.length) {
      const d1 = Math.max(((this.pt[1] || 0) - (this.pt[0] || 0)) / 1000, 0.005) || dt;
      const births = [];
      for (const c2 of C) {
        if (used.has(c2)) continue;
        let best = null, bs = 1e9;
        for (const c1 of this.c1) {
          const s2 = Math.hypot(c2.x - c1.x, c2.y - c1.y); if (s2 < minStep || s2 > maxStep) continue;
          const vx = (c2.x - c1.x) / dt, vy = (c2.y - c1.y) / dt;
          for (const c0 of this.c2) {
            const s1 = Math.hypot(c1.x - c0.x, c1.y - c0.y); if (s1 < minStep || s1 > maxStep) continue;
            const ex = c1.x - vx * d1 - c0.x, ey = c1.y - vy * d1 - c0.y, err = Math.hypot(ex, ey);
            if (err > 0.35 * s2 + 2) continue;
            const sc = err / (s2 + 1) + (c0.heat + c1.heat + c2.heat) * 0.3;
            if (sc < bs) { bs = sc; best = { c0, c1, vx, vy, col: (c0.col + c1.col + c2.col) / 3 }; }
          }
        }
        if (best) births.push({ id: this.nextId++, x: c2.x, y: c2.y, vx: best.vx, vy: best.vy, t, n: 3, miss: 0, slow: 0, a: c2.a, sc: bs, col: best.col, h: [[best.c0.x, best.c0.y, this.pt[0]], [best.c1.x, best.c1.y, this.pt[1]], [c2.x, c2.y, t]] });
      }
      births.sort((a, b) => a.sc - b.sc);
      for (const b of births) { if (this.tracks.length >= o.maxTracks) break; if (this.tracks.some((k) => Math.hypot(k.x - b.x, k.y - b.y) < 4)) continue; this.tracks.push(b); }
    }
    // 3. report the best confirmed tracklet updated this frame
    let rep = null;
    for (const k of this.tracks) if (k.n >= o.confirmN && k.t === t && this.verify(k) && (!rep || k.n > rep.n)) rep = k;
    if (!rep) return null;
    const back = rep.rep ? null : rep.h.slice(0, -1); rep.rep = true; // first report: hand back the frames it took to confirm
    return { x: rep.x, y: rep.y, a: rep.a, turn: rep.turn, id: rep.id, n: rep.n, col: rep.col, back };
  }
}
