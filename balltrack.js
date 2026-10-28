// Court Cam ball tracker (tennis / football) — pure JS, no DOM, so it can be unit-tested in Node.
// Per video frame: motion-compensated 3-frame differencing on a small (~640 px) luma image,
// small-blob candidates, flicker heat-map suppression, multi-hypothesis tracklets with
// constant-velocity prediction; a tracklet is reported once it has been consistent for a few frames.
export class BallTracker {
  constructor(opt = {}) {
    this.o = Object.assign({ T: 16, cell: 8, heatDecay: 0.965, heatMax: 2.5, confirmN: 4, maxTracks: 8, shiftR: 8, tennis: true }, opt);
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
    const cands = this.blobs(mask, L, rgba, rw, rh);
    const dt = Math.max((t - t1) / 1000, 0.005);
    this.dtAvg = this.dtAvg ? this.dtAvg * 0.9 + dt * 0.1 : dt;
    const best = this.track(cands, t, dt, rw);
    this.c2 = this.c1; this.c1 = cands;
    if (best) this.hits++;
    return best;
  }
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
        k.vx += (vx - k.vx) * a; k.vy += (vy - k.vy) * a; k.x = got.x; k.y = got.y; k.t = t; k.miss = 0; k.n++; k.a = got.a; k.turn = turn; k.col = k.col * 0.7 + got.col * 0.3; k.h.push([got.x, got.y, t]); if (k.h.length > 12) k.h.shift();
        k.slow = Math.hypot(k.vx, k.vy) * dt < minStep * 0.6 ? k.slow + 1 : 0;
      } else { k.miss++; k.turn = false; }
    }
    this.tracks = this.tracks.filter((k) => k.miss <= (k.n >= o.confirmN ? 6 : 1) && k.slow < 3 && t - k.t < 300);
    // 2. births: three detections in a straight, evenly spaced line over consecutive frames
    if (this.c1.length && this.c2.length) {
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
    for (const k of this.tracks) if (k.n >= o.confirmN && k.t === t && (!rep || k.n > rep.n)) rep = k;
    if (!rep) return null;
    const back = rep.rep ? null : rep.h.slice(0, -1); rep.rep = true; // first report: hand back the frames it took to confirm
    return { x: rep.x, y: rep.y, a: rep.a, turn: rep.turn, id: rep.id, n: rep.n, col: rep.col, back };
  }
}
