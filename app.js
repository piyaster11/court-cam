// Court Cam — live sports HUD over the iPhone camera.
// All speeds / distances are ESTIMATES from a single camera.
import { FilesetResolver, PoseLandmarker, ObjectDetector } from './vendor/vision_bundle.mjs';
import { BallTracker } from './balltrack.js';
import { BallDisplay } from './balldisplay.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const TSLOW = Math.max(1, +new URLSearchParams(location.search).get('slow') || 1); // test hook: footage replayed at 1/N speed
const now = () => performance.now() / TSLOW;
const QS = new URLSearchParams(location.search);

/* ---------------- sports ---------------- */
const SPORTS = {
  badminton: {
    name: 'BADMINTON', accent: '#29e6ff', dims: [6.10, 13.40], dimsLabel: 'Doubles court corners (width × length, m)',
    dimsNote: 'Tap the 4 outer corners of the full doubles court (6.10 × 13.40 m). For half court use 6.10 × 6.70.',
    maxPlayers: 4, ball: false, timeLabel: 'RALLY TIME', countLabel: 'RALLY COUNT', speedLabel: 'SHOT SPEED',
    mapLabel: 'COURT MAP', hitLabel: 'HIT', speed: [40, 330], swingFactor: 4.6, hasHit: true,
  },
  tennis: {
    name: 'TENNIS', accent: '#c6ff3d', dims: [10.97, 23.77], dimsLabel: 'Doubles court corners (width × length, m)',
    dimsNote: 'Tap the 4 outer corners of the doubles court (10.97 × 23.77 m). Singles: 8.23 × 23.77.',
    maxPlayers: 4, ball: true, ballKind: 'tennis', timeLabel: 'RALLY TIME', countLabel: 'RALLY', speedLabel: 'BALL SPEED',
    mapLabel: 'COURT MAP', hitLabel: 'SHOT', speed: [15, 240], swingFactor: 3.6, hasHit: true, shotKmh: 28,
  },
  football: {
    name: 'FOOTBALL', accent: '#3dff9e', dims: [20, 40], dimsLabel: 'Pitch / area rectangle (width × length, m)',
    dimsNote: 'Tap 4 corners of any rectangle you know the size of (e.g. 5-a-side pitch 20 × 40, penalty box 40.3 × 16.5).',
    maxPlayers: 6, ball: true, ballKind: 'football', timeLabel: 'MATCH TIME', countLabel: 'POSSESSION', speedLabel: 'SHOT SPEED',
    mapLabel: 'FIELD MAP', hitLabel: 'SHOT', speed: [8, 140], swingFactor: 0, hasHit: false, shotKmh: 22,
  },
};
const PALETTE = ['#29b6ff', '#3dff7a', '#ffd23d', '#c77dff', '#ff5d8f', '#ff9a3d'];
const DEFAULT_NAMES = { badminton: ['โฟม', 'บลู', 'โคตตี้', 'คู่แข่ง'], tennis: ['P1', 'P2', 'P3', 'P4'], football: ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'] };

/* ---------------- persisted settings ---------------- */
const store = JSON.parse(localStorage.getItem('courtcam.v1') || '{}');
const S = Object.assign({ sport: 'badminton', players: {}, calib: {}, dims: {}, mic: false, swing: false, lines: true }, store);
const save = () => localStorage.setItem('courtcam.v1', JSON.stringify({ sport: S.sport, players: S.players, calib: S.calib, dims: S.dims, mic: S.mic, swing: S.swing, lines: S.lines }));
function sp() { return SPORTS[S.sport]; }
function players() {
  if (!S.players[S.sport]) {
    const n = S.sport === 'football' ? 6 : S.sport === 'tennis' ? 2 : 4;
    S.players[S.sport] = DEFAULT_NAMES[S.sport].slice(0, n).map((name, i) => ({
      name, rating: [88, 95, 90, 90, 86, 84][i], color: PALETTE[i], team: S.sport === 'football' ? (i < 3 ? 'A' : 'B') : (i < 2 ? 'A' : 'B'),
    }));
  }
  return S.players[S.sport];
}
function dims() { return S.dims[S.sport] || sp().dims; }

/* ---------------- toast / status ---------------- */
let toastT;
function toast(msg, ms = 2200) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
function status(msg) { $('status').textContent = msg || ''; }
function show(id) { document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id)); }
function buzz(el) { if (navigator.vibrate) navigator.vibrate(12); if (el) { el.classList.add('pressed'); setTimeout(() => el.classList.remove('pressed'), 130); } }

/* ---------------- intro & setup ---------------- */
document.querySelectorAll('.sport-card').forEach((b) => b.addEventListener('click', () => { buzz(); S.sport = b.dataset.sport; save(); openSetup(); }));
$('setupBack').onclick = () => show('intro');
function openSetup() {
  const s = sp();
  $('setupTitle').textContent = s.name; $('setupTitle').style.color = s.accent; $('setupTitle').style.textShadow = `0 0 14px ${s.accent}`;
  $('maxNote').textContent = `up to ${s.maxPlayers}`;
  $('optMic').checked = S.mic; $('optSwing').checked = S.swing; $('optLines').checked = S.lines;
  $('optSwing').closest('label').style.display = S.sport === 'football' ? 'none' : '';
  $('dimsLabel').textContent = s.dimsLabel; $('dimsNote').textContent = s.dimsNote;
  const d = dims(); $('dimW').value = d[0]; $('dimL').value = d[1];
  renderRows(); show('setup');
}
function renderRows() {
  const ps = players(), box = $('playerRows'); box.innerHTML = '';
  ps.forEach((p, i) => {
    const r = document.createElement('div'); r.className = 'prow'; r.style.setProperty('--c', p.color);
    r.innerHTML = `<div class="num">${i + 1}</div><input type="text" maxlength="12" placeholder="Name" value="${p.name.replace(/"/g, '&quot;')}">
      <input type="number" min="0" max="99" value="${p.rating}"><select>${['A', 'B'].map((t) => `<option ${p.team === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <button class="del" title="remove">✕</button>`;
    const [nm, rt] = r.querySelectorAll('input'); const sel = r.querySelector('select');
    nm.oninput = () => { p.name = nm.value || `P${i + 1}`; save(); };
    rt.oninput = () => { p.rating = clamp(parseInt(rt.value || '0', 10), 0, 99); save(); };
    sel.onchange = () => { p.team = sel.value; save(); };
    r.querySelector('.num').onclick = () => { p.color = PALETTE[(PALETTE.indexOf(p.color) + 1) % PALETTE.length]; save(); renderRows(); };
    r.querySelector('.del').onclick = () => { if (ps.length > 1) { ps.splice(i, 1); save(); renderRows(); } };
    box.appendChild(r);
  });
  $('addPlayer').style.display = ps.length >= sp().maxPlayers ? 'none' : '';
}
$('addPlayer').onclick = () => {
  const ps = players(); if (ps.length >= sp().maxPlayers) return;
  const used = new Set(ps.map((p) => p.color));
  ps.push({ name: `P${ps.length + 1}`, rating: 80, color: PALETTE.find((c) => !used.has(c)) || PALETTE[0], team: ps.length % 2 ? 'B' : 'A' }); save(); renderRows();
};
$('optMic').onchange = (e) => { S.mic = e.target.checked; save(); };
$('optSwing').onchange = (e) => { S.swing = e.target.checked; save(); };
$('optLines').onchange = (e) => { S.lines = e.target.checked; save(); };
const onDims = () => { const w = parseFloat($('dimW').value), l = parseFloat($('dimL').value); if (w > 0 && l > 0) { S.dims[S.sport] = [w, l]; save(); } };
$('dimW').oninput = onDims; $('dimL').oninput = onDims;
$('goCam').onclick = () => { buzz(); startLive(null); };
$('fileIn').onchange = (e) => { const f = e.target.files[0]; if (f) startLive(URL.createObjectURL(f)); e.target.value = ''; };

/* ---------------- live state ---------------- */
const video = $('vid'), cv = $('cv'), ctx = cv.getContext('2d');
let camStream = null, micStream = null, running = false, srcIsFile = false;
const G = {
  rally: { on: false, t0: 0, acc: 0, count: 0, lastHit: 0 },
  shot: { val: 0, disp: 0, t: 0 },
  lock: { tid: -1, t: 0, kmh: 0, tag: 0 },
  poss: { A: 0, B: 0, last: null },
  stats: [], // per player slot {dist, stamina}
  tracks: [], nextId: 1,
  ball: null,
  fps: 0, inferMs: 0, debug: false,
};
function resetStats() { G.stats = players().map(() => ({ dist: 0, stam: 100, dDisp: 0, sDisp: 100 })); }

/* ---------------- models ---------------- */
let pose = null, det = null, modelsLoading = null, delegateUsed = '';
async function loadModels() {
  if (modelsLoading) return modelsLoading;
  modelsLoading = (async () => {
    const base = new URL('./', location.href).href;
    const fs = await FilesetResolver.forVisionTasks(base + 'vendor/wasm');
    const mk = async (delegate) => {
      const p = await PoseLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetPath: base + 'models/pose_landmarker_lite.task', delegate },
        runningMode: 'VIDEO', numPoses: 6, minPoseDetectionConfidence: 0.45, minPosePresenceConfidence: 0.45, minTrackingConfidence: 0.4,
      });
      const d = await ObjectDetector.createFromOptions(fs, {
        baseOptions: { modelAssetPath: base + 'models/efficientdet_lite0.tflite', delegate },
        runningMode: 'VIDEO', scoreThreshold: 0.2, maxResults: 12, categoryAllowlist: ['sports ball', 'person'],
      });
      return [p, d];
    };
    const forceCPU = QS.get('cpu') === '1';
    try { if (forceCPU) throw new Error('cpu forced'); [pose, det] = await mk('GPU'); delegateUsed = 'GPU'; }
    catch (e) { console.warn('GPU delegate failed, using CPU', e); [pose, det] = await mk('CPU'); delegateUsed = 'CPU'; }
  })();
  return modelsLoading;
}

/* ---------------- start / stop live ---------------- */
async function startLive(fileUrl) {
  show('live'); resetStats(); syncControls(); status('Starting camera…');
  G.tracks = []; G.ball = null; G.poss = { A: 0, B: 0, last: null }; if (G.bd) G.bd.reset(); G.fx = [];
  try {
    stopSource();
    if (fileUrl) {
      srcIsFile = true; video.srcObject = null; video.src = fileUrl; video.loop = true; video.muted = true;
    } else {
      srcIsFile = false;
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false,
      });
      video.srcObject = camStream;
    }
    await video.play().catch(() => {});
    await new Promise((r) => (video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true })));
  } catch (e) {
    status('Camera blocked: ' + (e.message || e.name) + '. Allow camera access in Settings › Safari › Camera, then reload.'); return;
  }
  status('Loading AI tracking…');
  if (!running) { running = true; requestAnimationFrame(frame); startFrameCb(); }
  try { await loadModels(); status(''); toast(`Tracking ready (${delegateUsed})${calib() ? '' : ' · Menu › Calibrate for better speed/distance'}`, 3200); scheduleInfer(0); }
  catch (e) { console.error(e); status('Tracking failed to load: ' + e.message + '. HUD still works with manual controls.'); }
  if (S.mic) enableMic();
}
function stopSource() {
  if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; }
  if (video.src && video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
  video.removeAttribute('src'); video.srcObject = null;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('live').classList.contains('active') && video.paused) video.play().catch(() => {}); });

/* ---------------- geometry: video <-> canvas ---------------- */
let W = 0, H = 0, DPR = 1, VW = 1, VH = 1, vs = 1, vox = 0, voy = 0, U = 1, safe = { t: 0, b: 0, l: 0, r: 0 }, ctrlH = 80;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  const cw = window.innerWidth, ch = window.innerHeight;
  let k = DPR; const longSide = Math.max(cw, ch) * k; if (longSide > 1920) k = 1920 / Math.max(cw, ch);
  DPR = k; W = Math.round(cw * k); H = Math.round(ch * k);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const probe = getComputedStyle(document.documentElement);
  const px = (v) => (parseFloat(probe.getPropertyValue(v)) || 0) * k;
  safe = { t: px('--st'), b: px('--sb'), l: px('--sl'), r: px('--sr') };
  measureCtrl();
  U = Math.min(W, H) / 100;
}
let ctrlW = 0;
function measureCtrl() { const c = $('controls'), side = c.offsetHeight > c.offsetWidth; ctrlH = side ? 0 : (c.offsetHeight || 80) * DPR; ctrlW = side ? c.offsetWidth * DPR : 0; }
// css custom props hold env() strings; resolve them via a probe element
(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'; document.body.appendChild(d);
  const upd = () => { const c = getComputedStyle(d); document.documentElement.style.setProperty('--st', c.paddingTop); document.documentElement.style.setProperty('--sb', c.paddingBottom); document.documentElement.style.setProperty('--sl', c.paddingLeft); document.documentElement.style.setProperty('--sr', c.paddingRight); };
  upd(); addEventListener('resize', upd); })();
addEventListener('resize', resize); addEventListener('orientationchange', () => setTimeout(resize, 300)); resize();
function fitVideo() {
  VW = video.videoWidth || 1280; VH = video.videoHeight || 720;
  vs = Math.max(W / VW, H / VH); vox = (W - VW * vs) / 2; voy = (H - VH * vs) / 2;
}
const v2c = (x, y) => [vox + x * vs, voy + y * vs];
const c2v = (x, y) => [(x - vox) / vs, (y - voy) / vs];

/* ---------------- homography (image px -> court metres) ---------------- */
function solveH(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) { // gaussian elimination
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
  }
  const h = b.map((v, i) => v / A[i][i]); return [...h, 1];
}
const applyH = (h, x, y) => { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };
function calib() { const c = S.calib[S.sport]; return c && c.H ? c : null; }
function buildCalib(ptsN) {
  const [w, l] = dims();
  const src = ptsN.map(([x, y]) => [x * VW, y * VH]);
  // order: near-left, near-right, far-right, far-left  -> court coords (x across width, y along length; near baseline y=0)
  const dst = [[0, 0], [w, 0], [w, l], [0, l]];
  const Hm = solveH(src, dst), Hi = solveH(dst, src);
  if (!Hm || !Hi) return null;
  return { pts: ptsN, H: Hm, Hi, vw: VW, vh: VH, dims: [w, l] };
}
function calibValid() { const c = calib(); return c && Math.abs(c.vw / c.vh - VW / VH) < 0.02 ? c : null; }
const toCourt = (x, y) => { const c = calibValid(); return c ? applyH(c.H, x * c.vw / VW, y * c.vh / VH) : null; };
const fromCourt = (X, Y) => { const c = calibValid(); if (!c) return null; const [x, y] = applyH(c.Hi, X, Y); return [x * VW / c.vw, y * VH / c.vh]; };

/* ---------------- inference loop ---------------- */
let inferTimer = null, tick = 0, tsPose = 0, tsDet = 0;
function scheduleInfer(ms) { clearTimeout(inferTimer); inferTimer = setTimeout(infer, ms); }
function infer() {
  if (!$('live').classList.contains('active') || !pose) return scheduleInfer(250);
  if (video.readyState < 2) return scheduleInfer(80);
  fitVideo();
  const t0 = now(), s = sp(); tick++;
  try {
    // people + ball come from the object detector; pose (racquet sports) adds wrist motion for swing / shot-speed estimates
    if (S.sport === 'football' || tick % 2) runDet(t0); else runPose(t0);
  } catch (e) { console.warn('infer', e); }
  const cost = now() - t0; G.inferMs = lerp(G.inferMs || cost, cost, 0.2);
  const target = S.sport === 'football' ? 1000 / 12 : 1000 / 22;
  // ball sports: when inference is slow (CPU), leave the main thread free between runs so the per-frame ball tracker keeps up
  const yieldK = s.ball && G.inferMs > 30 ? 1.3 : 0.5;
  scheduleInfer(Math.max(target - cost, cost * yieldK, 12));
}
function runPose(t) {
  tsPose = Math.max(tsPose + 1, Math.round(t));
  const r = pose.detectForVideo(video, tsPose);
  const dets = (r.landmarks || []).map(poseToDet).filter(Boolean);
  G.nPose = dets.length;
  // attach each pose to the nearest live track (tracks themselves come from the detector)
  const used = new Set();
  for (const d of dets) {
    let best = null, bd = 0.8;
    for (const k of G.tracks) { if (used.has(k)) continue; const c = Math.hypot(d.x - k.x, d.y - k.y) / Math.max(30, k.h); if (c < bd) { bd = c; best = k; } }
    if (best) { used.add(best); const dt = Math.max((t - (best.pt || 0)) / 1000, 0.016); swingCheck(best, d, t, dt); best.pt = t; best.top = lerp(best.top, d.top, 0.5); }
  }
}
function poseToDet(lm) {
  let minY = 1e9, maxFoot = -1e9;
  for (let i = 0; i < 33; i++) if (lm[i].y * VH < minY) minY = lm[i].y * VH;
  for (const i of [27, 28, 29, 30, 31, 32]) maxFoot = Math.max(maxFoot, lm[i].y * VH);
  const fx = (lm[27].x + lm[28].x + lm[29].x + lm[30].x) / 4 * VW;
  const h = maxFoot - minY; if (h < VH * 0.04) return null;
  const vis = (lm[0].visibility ?? 1) + (lm[11].visibility ?? 1) + (lm[12].visibility ?? 1);
  if (vis < 0.9) return null;
  return {
    x: fx, y: maxFoot, h: h * 1.1, top: minY - h * 0.1,
    wr: [[lm[15].x * VW, lm[15].y * VH], [lm[16].x * VW, lm[16].y * VH]],
    hip: [(lm[23].x + lm[24].x) / 2 * VW, (lm[23].y + lm[24].y) / 2 * VH],
  };
}
function filterDets(dets) {
  // drop near-duplicates, drop people far outside a calibrated court, keep biggest N
  dets.sort((a, b) => b.h - a.h);
  const out = [];
  for (const d of dets) {
    if (out.some((o) => Math.hypot(o.x - d.x, o.y - d.y) < 0.35 * Math.max(o.h, d.h))) continue;
    const [cx_, cy_] = v2c(d.x, d.y); if (cx_ < -0.02 * W || cx_ > W * 1.02 || cy_ < 0 || cy_ > H * 1.05) continue; // cropped out of view
    const c = toCourt(d.x, d.y);
    if (c) {
      const [w, l] = dims(), ms = S.sport === 'football' ? 4 : S.sport === 'tennis' ? 3 : 2.5, me = S.sport === 'football' ? 4 : S.sport === 'tennis' ? 7.5 : 2.5;
      if (c[0] < -ms || c[0] > w + ms || c[1] < -me || c[1] > l + me) continue;
      // tennis: umpire chair, benches and net-post ball kids sit just outside the sidelines near the net
      if (S.sport === 'tennis' && Math.abs(c[1] - l / 2) < 3.5 && (c[0] < -0.4 || c[0] > w + 0.4)) continue;
    }
    out.push(d);
  }
  return out.slice(0, Math.max(players().length + 2, 4));
}
const mppOf = (h) => 1.72 / Math.max(h, 1); // metres per video px at a person's depth (assumes ~1.72 m tall)

function updateTracks(dets, t) {
  const tr = G.tracks, pairs = [];
  tr.forEach((k, i) => {
    const dt = Math.min((t - k.t) / 1000, 0.3), px = k.x + k.vx * dt, py = k.y + k.vy * dt;
    dets.forEach((d, j) => {
      const c = Math.hypot(d.x - px, d.y - py) / Math.max(30, (k.h + d.h) / 2) + 0.5 * Math.abs(Math.log(d.h / k.h));
      if (c < 0.9) pairs.push([c, i, j]);
    });
  });
  pairs.sort((a, b) => a[0] - b[0]);
  const ut = new Set(), ud = new Set();
  for (const [, i, j] of pairs) {
    if (ut.has(i) || ud.has(j)) continue; ut.add(i); ud.add(j);
    const k = tr[i], d = dets[j], dt = Math.max((t - k.t) / 1000, 0.016);
    k.vx = lerp(k.vx, (d.x - k.x) / dt, 0.35); k.vy = lerp(k.vy, (d.y - k.y) / dt, 0.35);
    k.x = d.x; k.y = d.y; k.h = lerp(k.h, d.h, 0.35); k.top = d.top; k.t = t; k.seen++;
    if (k.seen === 2) k.appear = t;
  }
  dets.forEach((d, j) => {
    if (ud.has(j)) return;
    tr.push({ id: G.nextId++, x: d.x, y: d.y, h: d.h, top: d.top, vx: 0, vy: 0, t, born: t, seen: 1, slot: -1, appear: 0,
      sx: d.x, sy: d.y, sh: d.h, stop: d.top, ex: d.x, ey: d.y, lastWr: null, lastSwing: 0 });
  });
  G.tracks = tr.filter((k) => t - k.t < 1600);
  assignSlots();
  // distance / stamina per player slot (from an EMA-smoothed foot point)
  for (const k of G.tracks) {
    if (k.slot < 0 || k.t !== t) continue;
    k.ex = lerp(k.ex, k.x, 0.45); k.ey = lerp(k.ey, k.y, 0.45);
    const st = G.stats[k.slot]; if (!st) continue;
    const c = toCourt(k.ex, k.ey);
    const pos = c ? c : [k.ex * mppOf(k.h), k.ey * mppOf(k.h) * 2.2]; // uncalibrated: depth axis foreshortened ~2x
    st.lastPos = [k.x, k.y]; st.court = c;
    if (st.mpos && t - st.mt < 600) {
      const step = Math.hypot(pos[0] - st.mpos[0], pos[1] - st.mpos[1]), sp_ = step / ((t - st.mt) / 1000);
      if (step > 0.18 && sp_ < 9) {
        st.dist += step; st.mpos = pos; st.mt = t;
        st.stam = Math.max(5, st.stam - step * ({ badminton: 0.9, tennis: 0.55, football: 0.22 })[S.sport]);
      } else if (step <= 0.18) { st.stam = Math.min(100, st.stam + 0.004 * (t - st.mt) / 16); st.mt = t; }
      else { st.mpos = pos; st.mt = t; }
    } else { st.mpos = pos; st.mt = t; }
    (st.trail ||= []).push(c ? [...c] : [k.x / VW, k.y / VH]); if (st.trail.length > 14) st.trail.shift();
  }
}
function assignSlots() {
  const n = players().length, taken = new Set(G.tracks.filter((k) => k.slot >= 0 && k.slot < n).map((k) => k.slot));
  G.tracks.forEach((k) => { if (k.slot >= n) k.slot = -1; });
  const cands = G.tracks.filter((k) => k.slot < 0 && k.seen >= 3).sort((a, b) => b.h - a.h);
  for (const k of cands) {
    let best = -1, bd = 1e12;
    for (let s = 0; s < n; s++) {
      if (taken.has(s)) continue;
      const lp = G.stats[s] && G.stats[s].lastPos, d = lp ? Math.hypot(lp[0] - k.x, lp[1] - k.y) : 1e9 + s;
      if (d < bd) { bd = d; best = s; }
    }
    if (best >= 0) { k.slot = best; taken.add(best); k.appear = now(); }
  }
}
function swingCheck(k, d, t, dt) {
  if (!SPORTS[S.sport].swingFactor) return;
  const hipD = k.lastHip ? [d.hip[0] - k.lastHip[0], d.hip[1] - k.lastHip[1]] : [0, 0];
  if (k.lastWr && dt < 0.35) {
    let v = 0;
    for (let w = 0; w < 2; w++) v = Math.max(v, Math.hypot(d.wr[w][0] - k.lastWr[w][0] - hipD[0], d.wr[w][1] - k.lastWr[w][1] - hipD[1]) / dt);
    const ms = v * mppOf(k.h); // wrist speed m/s (est.)
    if (ms > 22) { k.lastWr = d.wr; k.lastHip = d.hip; return; } // implausible jump = pose matched to someone else
    k.wristMs = ms;
    if (ms > 5.5 && t - k.lastSwing > 700) {
      k.lastSwing = t;
      const s = sp(), kmh = clamp(ms * 3.6 * s.swingFactor, s.speed[0], s.speed[1]);
      if (S.sport === 'badminton') { setShot(kmh, t); lockOn(k, kmh, t); }
      else lockOn(k, G.ball && t - G.ball.t < 400 && G.ball.kmh > 10 ? G.ball.kmh : kmh, t);
      if (S.swing) hit(true);
    }
  }
  k.lastWr = d.wr; k.lastHip = d.hip;
}
function lockOn(k, kmh, t) { G.lock = { tid: k.id, t, kmh: Math.round(kmh) }; }
function setShot(kmh, t) { G.shot.val = Math.round(kmh); G.shot.t = t; }

/* ---------------- ball tracking (tennis / football) ---------------- */
let tiny = null, tctx = null, prevLuma = null, TW = 160, TH = 90;
function runDet(t) {
  tsDet = Math.max(tsDet + 1, Math.round(t));
  const r = det.detectForVideo(video, tsDet);
  const balls = [], people = [];
  for (const d of r.detections || []) {
    const c = d.categories[0], b = d.boundingBox;
    if (c.categoryName === 'sports ball') balls.push({ x: b.originX + b.width / 2, y: b.originY + b.height / 2, r: Math.max(b.width, b.height) / 2, score: c.score, src: 'det' });
    else if (c.categoryName === 'person' && c.score > 0.3) people.push({ x: b.originX + b.width / 2, y: b.originY + b.height, h: b.height, top: b.originY });
  }
  G.nPeople = people.length; G.nBalls = balls.length; G.peopleBoxes = people; G.peopleT = t;
  updateTracks(filterDets(people), t);
  if (!sp().ball) return;
  const m = pickBall(balls, t);
  if (m && m.score > 0.35) btSeed(m, t); // the per-frame motion tracker (btFrame) does the rest
}
function predBall(t) { const b = G.ball; if (!b) return null; const dt = Math.min((t - b.t) / 1000, 0.5); return [b.x + b.vx * dt, b.y + b.vy * dt]; }
function pickBall(balls, t) {
  if (!balls.length) return null;
  const p = predBall(t);
  if (p && t - G.ball.t < 900) {
    let best = null, bd = 1e9;
    for (const b of balls) { const d = Math.hypot(b.x - p[0], b.y - p[1]) - b.score * 50; if (d < bd) { bd = d; best = b; } }
    return best;
  }
  balls.sort((a, b) => b.score - a.score);
  return balls[0].score > 0.28 ? balls[0] : null;
}
/* Per-frame ball tracker (balltrack.js): motion-compensated 3-frame differencing at ~800 px inside the court ROI,
   small-blob candidates, flicker heat-map suppression, multi-hypothesis tracklets; a tracklet is reported once it
   has been consistent for 6 frames. Works for balls far too small for the object detector (2-6 px). */
const BT = { cv: null, cx: null, w: 0, h: 0, roi: null, tr: new BallTracker({ tennis: true, T: 16, confirmN: 6 }), frames: 0, hits: 0, busy: 0 };
G.bt = BT;
const BD = new BallDisplay(); G.bd = BD; G.fx = [];
function btRoi(scale, w, h) {
  // court bounding box (+ margins and air space above it) in tracker pixels; whole frame when uncalibrated
  const c = calibValid(); if (!c) return [0, Math.round(h * 0.08), w, h];
  const [cw, cl] = dims(), mx = S.sport === 'tennis' ? 5 : 4, my = S.sport === 'tennis' ? 9 : 5;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [X, Y] of [[-mx, -my], [cw + mx, -my], [cw + mx, cl + my], [-mx, cl + my], [cw / 2, -my], [cw / 2, cl + my]]) {
    const p = fromCourt(X, Y); if (!p) continue; x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
  }
  const air = (y1 - y0) * 0.55; y0 -= air; // balls fly well above the court plane
  const r = [x0 * scale, y0 * scale, x1 * scale, y1 * scale].map(Math.round);
  r[0] = clamp(r[0], 0, w); r[2] = clamp(r[2], 0, w); r[1] = clamp(r[1], 0, h); r[3] = clamp(r[3], 0, h);
  return r[2] - r[0] < 32 || r[3] - r[1] < 32 ? [0, 0, w, h] : r;
}
function btSeed(m, t) { updateBall(m, t); BT.hitT = t; BD.setFrame(VW, VH); BD.meas(m.x, m.y, t, { id: 'det' }); }
function btFrame(t) {
  if (!sp().ball || video.readyState < 2 || !VW) return;
  const scale = Math.min(1, 800 / Math.max(VW, VH)), w = Math.round(VW * scale), h = Math.round(VH * scale);
  if (!BT.cv) { BT.cv = document.createElement('canvas'); BT.cx = BT.cv.getContext('2d', { willReadFrequently: true }); }
  if (BT.w !== w || BT.h !== h) { BT.cv.width = w; BT.cv.height = h; BT.w = w; BT.h = h; BT.roi = null; }
  const roi = btRoi(scale, w, h);
  if (!BT.roi || roi.some((v, k) => Math.abs(v - BT.roi[k]) > 6)) BT.roi = roi; // tracker resets itself when the ROI size changes
  const [rx, ry, rx1, ry1] = BT.roi, rw = rx1 - rx, rh = ry1 - ry;
  BT.cx.drawImage(video, 0, 0, w, h);
  const px = BT.cx.getImageData(rx, ry, rw, rh).data;
  const boxes = [];
  for (const d of (t - (G.peopleT || 0) < 600 ? G.peopleBoxes || [] : [])) boxes.push([(d.x - d.h * 0.42) * scale - rx, (d.top - d.h * 0.12) * scale - ry, (d.x + d.h * 0.42) * scale - rx, (d.y + d.h * 0.06) * scale - ry]);
  const tr = BT.tr, got = tr.push(px, rw, rh, t, boxes);
  BT.frames = tr.frames; BT.busy = tr.skipped;
  if (window.__btLog && window.__btLog.length < 400) window.__btLog.push([Math.round(t), rw, rh, tr.c1.length, tr.tracks.length, Math.max(0, ...tr.tracks.map((k) => k.n)), tr.sh1.join(',')]);
  if (!got) return;
  const gx = got.x + rx, gy = got.y + ry;
  if (window.__btDbg && BT.hits % 2 === 0 && window.__btDbg.length < 72) { const c = document.createElement('canvas'); c.width = c.height = 48; const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(BT.cv, gx - 12, gy - 12, 24, 24, 0, 0, 48, 48); g.strokeStyle = got.turn ? '#0ff' : '#f0f'; g.strokeRect(18, 18, 12, 12); window.__btDbg.push(c.toDataURL()); }
  BT.hits++; BT.hitT = t;
  updateBall({ x: gx / scale, y: gy / scale, r: clamp(Math.sqrt(got.a) * 0.7 / scale, 2.5 / scale, 10 / scale), score: 0.3, src: 'motion', turn: !!got.turn }, t);
  BD.setFrame(VW, VH);
  BD.meas(gx / scale, gy / scale, t, { turn: !!got.turn, id: got.id, back: got.back && got.back.map(([x, y, tt]) => [(x + rx) / scale, (y + ry) / scale, tt]) });
}
function ballMetric(x, y) {
  const c = toCourt(x, y); if (c) return c;
  let mpp = 0, bd = 1e12; // scale from nearest person; fallback: frame width ≈ court width
  for (const k of G.tracks) { const d = Math.hypot(k.x - x, k.y - y); if (d < bd) { bd = d; mpp = mppOf(k.h); } }
  if (!mpp) mpp = dims()[0] * 1.3 / VW;
  return [x * mpp, y * mpp];
}
function updateBall(m, t) {
  const s = sp();
  let b = G.ball;
  if (!m) { if (b && t - b.t > 1000) G.ball = null; return; }
  if (!b || t - b.t > 1000) { G.ball = { x: m.x, y: m.y, vx: 0, vy: 0, t, r: m.r, trail: [{ x: m.x, y: m.y, t }], hist: [{ t, p: ballMetric(m.x, m.y) }], kmh: 0, src: m.src, born: t }; return; }
  const dt = Math.max((t - b.t) / 1000, 0.016), p = predBall(t);
  const gate = Math.max(VW * (b.hist.length < 3 ? 0.2 : 0.12), Math.hypot(b.vx, b.vy) * dt * 1.6);
  if (Math.hypot(m.x - p[0], m.y - p[1]) > gate && !m.turn && !(m.src === 'det' && m.score > 0.5)) return;
  const k_ = m.turn ? 1 : 0.6; b.vx = lerp(b.vx, (m.x - b.x) / dt, k_); b.vy = lerp(b.vy, (m.y - b.y) / dt, k_);
  b.x = m.x; b.y = m.y; b.t = t; b.r = lerp(b.r, m.r, 0.3); b.src = m.src;
  b.trail.push({ x: b.x, y: b.y, t }); while (b.trail.length && t - b.trail[0].t > 700) b.trail.shift();
  b.hist.push({ t, p: ballMetric(b.x, b.y) }); while (b.hist.length && t - b.hist[0].t > 1200) b.hist.shift();
  // speed over the last ~0.15-0.4 s
  let ref = null; for (let i = b.hist.length - 2; i >= 0; i--) { if (t - b.hist[i].t >= 150) { ref = b.hist[i]; break; } }
  if (ref && t - ref.t < 450) {
    const kmh = Math.hypot(b.hist[b.hist.length - 1].p[0] - ref.p[0], b.hist[b.hist.length - 1].p[1] - ref.p[1]) / ((t - ref.t) / 1000) * 3.6;
    if (kmh <= s.speed[1] * 1.15) {
      b.kmh = lerp(b.kmh, kmh, 0.6);
      (b.ks ||= []).push(kmh); if (b.ks.length > 7) b.ks.shift();
      const med = b.ks.slice().sort((p, q) => p - q)[b.ks.length >> 1]; b.kmhS = lerp(b.kmhS || med, med, 0.25);
    }
  }
  // shot events: a burst of speed => SHOT/BALL SPEED + lock on nearest player
  const sh = G.shot;
  if (!sh.win && b.kmh > s.shotKmh && t - (sh.evT || 0) > 900) {
    let near = null, nd = 1e12; for (const k of G.tracks) { if (k.slot < 0) continue; const d = Math.hypot(k.x - b.x, (k.y - k.h * 0.4) - b.y) / k.h; if (d < nd) { nd = d; near = k; } }
    sh.win = { t0: t, peak: b.kmh, ks: [b.kmh], who: nd < 2.5 ? near : null };
  }
  if (sh.win) {
    sh.win.peak = Math.max(sh.win.peak, b.kmh); sh.win.ks.push(b.kmh);
    if (t - sh.win.t0 > 350) {
      const ks = sh.win.ks.slice().sort((p, q) => p - q), robust = ks[Math.min(ks.length - 1, Math.floor(ks.length * 0.75))];
      const v = clamp(robust, s.speed[0], s.speed[1]); setShot(v, t); sh.evT = t; sh.burst = { x: b.x, y: b.y, t, kmh: Math.round(v) };
      if (sh.win.who) lockOn(sh.win.who, v, t);
      sh.win = null;
    }
  }
  // possession (football): nearest player's team within ~1 body height of the ball
  if (S.sport === 'football') {
    let near = null, nd = 1e12; for (const k of G.tracks) { if (k.slot < 0) continue; const d = Math.hypot(k.x - b.x, k.y - b.y) / k.h; if (d < nd) { nd = d; near = k; } }
    if (near && nd < 1.1) { const team = players()[near.slot].team; if (G.poss.lastT) G.poss[team] += Math.min(t - G.poss.lastT, 300); G.poss.last = team; }
    G.poss.lastT = t;
  }
}

/* ---------------- rally / clock ---------------- */
function rallyMs() { return G.rally.acc + (G.rally.on ? now() - G.rally.t0 : 0); }
function toggleRally() {
  const r = G.rally;
  if (r.on) { r.acc += now() - r.t0; r.on = false; }
  else { if (S.sport !== 'football') { r.acc = 0; r.count = 0; } r.on = true; r.t0 = now(); }
  syncControls();
}
function hit(auto) {
  const r = G.rally, t = now();
  if (auto && t - r.lastHit < 260) return;
  if (!r.on && S.sport !== 'football') { r.acc = 0; r.count = 0; r.on = true; r.t0 = t; syncControls(); }
  r.count++; r.lastHit = t; r.bump = t;
  // if pose didn't catch the swing: lock on the most active nearby player, speed unknown (—)
  if (S.sport === 'badminton' && t - G.shot.t > 600) {
    let best = null, bv = -1;
    for (const k of G.tracks) { if (k.slot < 0 || t - k.t > 800) continue; const v = Math.hypot(k.vx, k.vy) * mppOf(k.h) + (k.wristMs || 0) * 0.5; if (v > bv) { bv = v; best = k; } }
    // no swing was measured => show a dash, never a made-up number
    if (best) { G.shot.val = 0; G.shot.t = t; lockOn(best, 0, t); }
  }
}
let seed_ = 7; function k_rand() { seed_ = (seed_ * 16807) % 2147483647; return seed_ / 2147483647; }
function resetAll() { G.rally = { on: false, t0: 0, acc: 0, count: 0, lastHit: 0 }; G.shot = { val: 0, disp: 0, t: 0 }; G.poss = { A: 0, B: 0, last: null }; G.lock = { tid: -1, t: 0 }; syncControls(); }
function syncControls() {
  const fb = S.sport === 'football';
  $('bRally').classList.toggle('on', G.rally.on);
  $('bRally').querySelector('.ci').textContent = G.rally.on ? '■' : '▶';
  $('bRallyL').textContent = G.rally.on ? (fb ? 'PAUSE' : 'STOP') : (fb && G.rally.acc ? 'RESUME' : 'START');
  $('bHit').style.display = sp().hasHit ? '' : 'none';
  $('bHit').querySelector('.cl').textContent = sp().hitLabel;
}

/* ---------------- drawing helpers ---------------- */
const FONT = "'Chakra Petch', -apple-system, 'Helvetica Neue', Thonburi, sans-serif";
const F = (px, w = 700, it = false) => `${it ? 'italic ' : ''}${w} ${Math.round(px)}px ${FONT}`;
const easeOutBack = (x) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
function rr(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
let scanPat = null, scanDpr = 0;
function scan() {
  if (!scanPat || scanDpr !== DPR) { const c = document.createElement('canvas'); c.width = 2; c.height = Math.max(3, Math.round(3 * DPR)); const g = c.getContext('2d'); g.fillStyle = 'rgba(140,220,255,0.07)'; g.fillRect(0, 0, 2, Math.max(1, Math.round(DPR))); scanPat = ctx.createPattern(c, 'repeat'); scanDpr = DPR; }
  return scanPat;
}
function glass(x, y, w, h, accent = '#29e6ff') {
  const r = 1.2 * U;
  ctx.save(); rr(x, y, w, h, r); ctx.fillStyle = 'rgba(5,14,36,0.72)'; ctx.fill(); ctx.clip();
  ctx.fillStyle = scan(); ctx.fillRect(x, y, w, h);
  const g = ctx.createLinearGradient(x, y, x, y + h); g.addColorStop(0, 'rgba(120,220,255,0.16)'); g.addColorStop(0.35, 'rgba(120,220,255,0)'); ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  ctx.restore();
  rr(x, y, w, h, r); ctx.strokeStyle = 'rgba(41,230,255,0.38)'; ctx.lineWidth = Math.max(1, 0.18 * U); ctx.stroke();
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = accent; ctx.shadowColor = accent; ctx.shadowBlur = 1.2 * U;
  ctx.fillRect(x + r, y, Math.min(w * 0.3, 18 * U), Math.max(2, 0.35 * U)); ctx.restore();
}
function glowText(txt, x, y, color, blur) { ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = blur; ctx.fillStyle = '#fff'; ctx.fillText(txt, x, y); ctx.restore(); }
function fmtTime(ms, cs = true) { const s = Math.floor(ms / 1000), m = Math.floor(s / 60); const base = `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; return cs ? `${base}.${String(Math.floor(ms / 10) % 100).padStart(2, '0')}` : base; }

/* ---------------- court geometry ---------------- */
function courtLines(w, l) {
  const L = [], seg = (a, b, c, d) => L.push([[a, b], [c, d]]);
  seg(0, 0, w, 0); seg(w, 0, w, l); seg(w, l, 0, l); seg(0, l, 0, 0);
  if (S.sport === 'badminton' && Math.abs(w - 6.1) < 0.05) {
    const m = l / 2; seg(0, m, w, m);
    if (Math.abs(l - 13.4) < 0.1) { seg(0.46, 0, 0.46, l); seg(w - 0.46, 0, w - 0.46, l); seg(0, m - 1.98, w, m - 1.98); seg(0, m + 1.98, w, m + 1.98); seg(0, 0.76, w, 0.76); seg(0, l - 0.76, w, l - 0.76); seg(w / 2, 0, w / 2, m - 1.98); seg(w / 2, m + 1.98, w / 2, l); }
  } else if (S.sport === 'tennis') {
    const m = l / 2, sx = Math.abs(w - 10.97) < 0.05 ? 1.37 : 0; seg(0, m, w, m);
    if (sx) { seg(sx, 0, sx, l); seg(w - sx, 0, w - sx, l); }
    if (Math.abs(l - 23.77) < 0.1) { seg(sx, m - 6.4, w - sx, m - 6.4); seg(sx, m + 6.4, w - sx, m + 6.4); seg(w / 2, m - 6.4, w / 2, m + 6.4); }
  } else {
    seg(0, l / 2, w, l / 2); const R = Math.min(w, l) * 0.13;
    for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2, b = (i + 1) / 24 * Math.PI * 2; seg(w / 2 + R * Math.cos(a), l / 2 + R * Math.sin(a), w / 2 + R * Math.cos(b), l / 2 + R * Math.sin(b)); }
  }
  return L;
}
function drawCourtOverlay(t) {
  if (!S.lines || !calibValid()) return;
  const [w, l] = dims();
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
  const a = 0.22 + 0.06 * Math.sin(t / 700);
  for (const [lw, al] of [[0.9 * U, a * 0.35], [0.28 * U, a]]) {
    ctx.strokeStyle = hexA(sp().accent, al); ctx.lineWidth = lw; ctx.beginPath();
    for (const [p, q] of courtLines(w, l)) { const A = fromCourt(...p), B = fromCourt(...q); if (!A || !B) continue; const [ax, ay] = v2c(...A), [bx, by] = v2c(...B); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); }
    ctx.stroke();
  }
  ctx.restore();
}

/* ---------------- rings, tags, lock-on ---------------- */
function ringPts(k, rm, n = 36) {
  const pts = [], c = toCourt(k.sx, k.sy);
  if (c) {
    for (let i = 0; i <= n; i++) { const a = i / n * Math.PI * 2, p = fromCourt(c[0] + rm * Math.cos(a), c[1] + rm * Math.sin(a)); pts.push(v2c(...p)); }
  } else {
    const [cx, cy] = v2c(k.sx, k.sy), rx = k.sh * vs * 0.34 * (rm / 0.6), ry = rx * 0.3;
    for (let i = 0; i <= n; i++) { const a = i / n * Math.PI * 2; pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
  }
  return pts;
}
function pathPts(pts) { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
function drawRing(k, col, t, locked) {
  const pop = k.appear ? easeOutBack(clamp((t - k.appear) / 450, 0, 1)) : 0; if (pop <= 0) return;
  const R = 0.6 * pop;
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineJoin = 'round';
  const base = ringPts(k, R);
  pathPts(base);
  const [cx, cy] = v2c(k.sx, k.sy);
  const span = Math.max(4, Math.abs(base[0][0] - cx));
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, span); g.addColorStop(0, hexA(col, 0.32)); g.addColorStop(1, hexA(col, 0.04)); ctx.fillStyle = g; ctx.fill();
  for (const [lw, a] of [[1.6, 0.14], [0.8, 0.3], [0.32, 0.95]]) { ctx.strokeStyle = hexA(col, a); ctx.lineWidth = lw * U; ctx.stroke(); }
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 0.12 * U; ctx.stroke();
  // inner ring
  pathPts(ringPts(k, R * 0.55)); ctx.strokeStyle = hexA(col, 0.55); ctx.lineWidth = 0.18 * U; ctx.stroke();
  // rotating dashes
  pathPts(ringPts(k, R * 1.32)); ctx.setLineDash([1.8 * U, 1.2 * U]); ctx.lineDashOffset = -t * 0.012 * U; ctx.strokeStyle = hexA(col, locked ? 0.95 : 0.7); ctx.lineWidth = 0.32 * U; ctx.stroke(); ctx.setLineDash([]);
  // pulse
  const p = ((t / 1500) + k.id * 0.37) % 1; pathPts(ringPts(k, R * (1 + p * 0.9), 28)); ctx.strokeStyle = hexA(col, (1 - p) * 0.55); ctx.lineWidth = 0.25 * U; ctx.stroke();
  if (locked) { const q = ((t / 600) % 1); pathPts(ringPts(k, R * (1.5 + q * 0.4), 28)); ctx.strokeStyle = hexA('#ffd23d', (1 - q) * 0.8); ctx.lineWidth = 0.3 * U; ctx.stroke(); }
  ctx.restore();
}
function drawTag(k, pl, t, locked) {
  const pop = k.appear ? clamp((t - k.appear) / 380, 0, 1) : 0; if (pop <= 0) return;
  const s = easeOutBack(pop);
  const [hx, hy] = v2c(k.sx, k.stop);
  const fs = 2.7 * U, padX = 1.1 * U, hgt = 4.6 * U;
  ctx.font = F(fs, 700); const nw = Math.max(ctx.measureText(pl.name).width, 4 * U);
  ctx.font = F(fs * 1.05, 700, true); const rw = ctx.measureText(String(pl.rating)).width + padX * 2;
  const w = nw + padX * 2 + rw, x = -w / 2, y = -hgt - 2.2 * U;
  ctx.save(); ctx.translate(hx, hy - 0.5 * U); ctx.scale(s, s); ctx.globalAlpha = Math.min(1, pop * 1.6);
  // glow box
  ctx.save(); ctx.shadowColor = pl.color; ctx.shadowBlur = 1.6 * U; rr(x, y, w, hgt, 0.7 * U); ctx.fillStyle = 'rgba(5,14,36,0.86)'; ctx.fill(); ctx.restore();
  ctx.save(); rr(x, y, w, hgt, 0.7 * U); ctx.clip(); ctx.fillStyle = scan(); ctx.fillRect(x, y, w, hgt);
  ctx.fillStyle = hexA(pl.color, 0.9); ctx.fillRect(x + nw + padX * 2, y, rw, hgt); // rating block
  ctx.fillStyle = pl.color; ctx.fillRect(x, y, 0.45 * U, hgt);
  ctx.restore();
  rr(x, y, w, hgt, 0.7 * U); ctx.strokeStyle = hexA(locked ? '#ffd23d' : pl.color, 0.9); ctx.lineWidth = 0.2 * U; ctx.stroke();
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.font = F(fs, 700); ctx.fillStyle = '#eaf8ff'; ctx.fillText(pl.name, x + padX + 0.2 * U, y + hgt / 2 + 0.1 * U);
  ctx.font = F(fs * 1.05, 700, true); ctx.fillStyle = '#03121f'; ctx.textAlign = 'center'; ctx.fillText(String(pl.rating), x + nw + padX * 2 + rw / 2, y + hgt / 2 + 0.1 * U);
  // pointer
  const bob = Math.sin(t / 260 + k.id) * 0.35 * U;
  ctx.beginPath(); ctx.moveTo(-1.1 * U, y + hgt + 0.7 * U + bob); ctx.lineTo(1.1 * U, y + hgt + 0.7 * U + bob); ctx.lineTo(0, y + hgt + 1.9 * U + bob); ctx.closePath();
  ctx.fillStyle = pl.color; ctx.shadowColor = pl.color; ctx.shadowBlur = U; ctx.fill();
  ctx.restore();
  return { x: hx + x * s, y: hy - 0.5 * U + y * s, w: w * s, h: hgt * s };
}
function drawLock(k, pl, t, tagBox) {
  const L = G.lock, age = t - L.t; if (age > 3200) return;
  const p = easeOutCubic(clamp(age / 320, 0, 1)), fade = age > 2600 ? 1 - (age - 2600) / 600 : 1;
  const [fx, fy] = v2c(k.sx, k.sy), [, ty] = v2c(k.sx, k.stop);
  const bh = (fy - ty) * 1.02, bw = bh * 0.55, cx = fx, cy = ty + bh / 2;
  const sc = lerp(1.9, 1, p), w = bw * sc, h = bh * sc, len = Math.min(w, h) * 0.18;
  ctx.save(); ctx.globalAlpha = fade * p; ctx.globalCompositeOperation = 'lighter';
  ctx.translate(cx, cy); ctx.rotate((1 - p) * 0.5);
  ctx.strokeStyle = '#ffd23d'; ctx.lineWidth = 0.45 * U; ctx.shadowColor = '#ffd23d'; ctx.shadowBlur = 1.4 * U; ctx.lineCap = 'square';
  const x0 = -w / 2, y0 = -h / 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0 + len); ctx.lineTo(x0, y0); ctx.lineTo(x0 + len, y0);
  ctx.moveTo(-x0 - len, y0); ctx.lineTo(-x0, y0); ctx.lineTo(-x0, y0 + len);
  ctx.moveTo(-x0, -y0 - len); ctx.lineTo(-x0, -y0); ctx.lineTo(-x0 - len, -y0);
  ctx.moveTo(x0 + len, -y0); ctx.lineTo(x0, -y0); ctx.lineTo(x0, -y0 - len);
  ctx.stroke();
  // centre tick marks
  ctx.lineWidth = 0.2 * U; ctx.beginPath(); ctx.moveTo(-w / 2 - U, 0); ctx.lineTo(-w / 2 + U * 0.6, 0); ctx.moveTo(w / 2 + U, 0); ctx.lineTo(w / 2 - U * 0.6, 0); ctx.stroke();
  ctx.restore();
  // LOCK ON label
  const lx = (tagBox ? tagBox.x + tagBox.w : cx + w / 2) + 1 * U, ly = tagBox ? tagBox.y : cy - h / 2;
  const s2 = easeOutBack(clamp((age - 120) / 380, 0, 1)); if (s2 <= 0) return;
  ctx.save(); ctx.globalAlpha = fade; ctx.translate(lx, ly); ctx.scale(s2, s2);
  const lw = 17 * U, lh = 7.4 * U;
  ctx.save(); ctx.shadowColor = '#ffd23d'; ctx.shadowBlur = 1.5 * U; rr(0, 0, lw, lh, 0.7 * U); ctx.fillStyle = 'rgba(5,14,36,0.9)'; ctx.fill(); ctx.restore();
  ctx.save(); rr(0, 0, lw, lh, 0.7 * U); ctx.clip(); ctx.fillStyle = scan(); ctx.fillRect(0, 0, lw, lh); ctx.fillStyle = '#ffd23d'; ctx.fillRect(0, 0, lw, 2.4 * U); ctx.restore();
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.font = F(1.8 * U, 700); ctx.fillStyle = '#1a1400'; ctx.fillText('LOCK ON', 1 * U, 1.25 * U);
  ctx.textAlign = 'right'; ctx.fillText(pl.name, lw - U, 1.25 * U);
  ctx.textAlign = 'left'; ctx.font = F(3.6 * U, 700, true);
  const kmh = L.kmh ? Math.round(L.kmh * clamp(age / 450, 0, 1)) : '—'; // count-up; — when not measured
  ctx.fillStyle = '#fff'; ctx.fillText(`${kmh}`, 1 * U, 4.9 * U);
  const kw = ctx.measureText(`${kmh}`).width; ctx.font = F(1.9 * U, 700); ctx.fillStyle = '#9fe9ff'; ctx.fillText('km/h', 1.6 * U + kw, 5.3 * U);
  ctx.font = F(1.6 * U, 700); ctx.fillStyle = '#ffd23d'; ctx.textAlign = 'right'; ctx.fillText('est.', lw - U, 5.3 * U);
  ctx.restore();
}

/* ---------------- ball ---------------- */
/* ---------------- ball: game-style smooth marker, arcing trail, impact bursts, speed pop ---------------- */
const SPD_STOPS = [[0, [216, 255, 61]], [70, [180, 255, 90]], [110, [255, 226, 77]], [150, [255, 150, 46]], [190, [255, 61, 110]], [230, [255, 77, 255]]];
function spdRGB(k) {
  if (!(k > 0)) return SPD_STOPS[0][1];
  for (let i = 1; i < SPD_STOPS.length; i++) if (k <= SPD_STOPS[i][0]) { const [k0, c0] = SPD_STOPS[i - 1], [k1, c1] = SPD_STOPS[i], q = (k - k0) / (k1 - k0); return c0.map((v, j) => Math.round(v + (c1[j] - v) * q)); }
  return SPD_STOPS[SPD_STOPS.length - 1][1];
}
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
// Catmull-Rom (centripetal-ish, uniform here) through screen points -> dense polyline
function crSample(P, per) {
  const out = []; if (P.length < 2) return P.slice();
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    for (let s = 0; s < per; s++) {
      const u = s / per, u2 = u * u, u3 = u2 * u;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y), t: p1.t + (p2.t - p1.t) * u, a: p1.a + (p2.a - p1.a) * u, k: p1.k + (p2.k - p1.k) * u });
    }
  }
  out.push(P[P.length - 1]); return out;
}
const popEase = (q) => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(q - 1, 3) + c1 * Math.pow(q - 1, 2); };
let lastBurstT = 0, lastEvT = 0, popShotT = 0;
function addFx(x, y, t, kind, k) { if (G.fx.length > 8) G.fx.shift(); G.fx.push({ x, y, t, kind, k }); }
function drawBall(t) {
  const s = sp(), b = G.ball;
  BD.setFrame(VW, VH); BD.kmh = b && b.kmhS ? b.kmhS : (b ? b.kmh : 0);
  const r = BD.render(t), TR = BD.trailPts(t), TMS = BD.o.trailMs;
  const football = S.sport === 'football';
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // ---- trail: per segment, decimate to ~30 ms knots, spline, tapered + glow, colour by speed
  let seg = [];
  const flush = () => {
    if (seg.length < 2) { seg = []; return; }
    const knots = [seg[0]]; for (const p of seg) if (p.t - knots[knots.length - 1].t >= 28) knots.push(p);
    if (knots[knots.length - 1] !== seg[seg.length - 1]) knots.push(seg[seg.length - 1]);
    const P = crSample(knots.map((p) => { const [x, y] = v2c(p.x, p.y); return { x, y, t: p.t, a: p.a, k: p.k }; }), 6);
    for (let pass = 0; pass < 2; pass++) for (let i = 1; i < P.length; i++) {
      const q = 1 - (t - P[i].t) / TMS; if (q <= 0) continue; // 0 = oldest .. 1 = newest
      const al = q * q * P[i].a, c = spdRGB(P[i].k);
      ctx.beginPath(); ctx.moveTo(P[i - 1].x, P[i - 1].y); ctx.lineTo(P[i].x, P[i].y);
      if (pass === 0) { ctx.strokeStyle = rgba(c, al * 0.32); ctx.lineWidth = (0.5 + 2.6 * q) * U; } // soft glow
      else { ctx.strokeStyle = rgba([255, 255, 255].map((v, j) => Math.round(v * 0.55 + c[j] * 0.45)), al * 0.95); ctx.lineWidth = (0.12 + 0.75 * q) * U; } // bright core
      ctx.stroke();
    }
    seg = [];
  };
  for (const p of TR) { if (seg.length && p.seg !== seg[seg.length - 1].seg) flush(); seg.push(p); }
  if (r && seg.length) seg.push({ x: r.x, y: r.y, t, a: r.a, seg: r.seg, k: BD.kmh }); // trail ends exactly at the marker
  flush();
  // ---- impacts: hits / bounces from the smoother + shot events
  if (BD.ev && BD.ev.t !== lastEvT) { lastEvT = BD.ev.t; addFx(BD.ev.x, BD.ev.y, t, BD.ev.kind, BD.kmh); }
  const sb = G.shot.burst; if (sb && sb.t !== lastBurstT) { lastBurstT = sb.t; const v = BD.vis && t - BD.vis.t < 100 ? BD.vis : sb; addFx(v.x, v.y, t, 'shot', sb.kmh); popShotT = t; }
  G.fx = G.fx.filter((f) => t - f.t < 650);
  for (const f of G.fx) {
    const q = (t - f.t) / 650, e = 1 - Math.pow(1 - q, 3), [fx, fy] = v2c(f.x, f.y), c = f.kind === 'shot' ? spdRGB(f.k) : [255, 255, 255];
    const big = f.kind === 'shot' ? 1.4 : 0.8;
    if (q < 0.18) { const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, 4.5 * U * big); g.addColorStop(0, rgba([255, 255, 255], 0.6 * (1 - q / 0.18))); g.addColorStop(1, rgba(c, 0)); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(fx, fy, 4.5 * U * big, 0, 7); ctx.fill(); } // flash
    ctx.strokeStyle = rgba(c, (1 - q) * 0.9); ctx.lineWidth = (1 - q) * 0.9 * U * big;
    ctx.beginPath(); ctx.arc(fx, fy, (1.5 + e * 9) * U * big, 0, 7); ctx.stroke();
    ctx.strokeStyle = rgba([255, 255, 255], (1 - q) * 0.6); ctx.lineWidth = (1 - q) * 0.35 * U;
    ctx.beginPath(); ctx.arc(fx, fy, (1 + e * 5.5) * U * big, 0, 7); ctx.stroke();
    for (let i = 0; i < 8; i++) { // sparks
      const an = i * Math.PI / 4 + f.t * 0.001, r0 = (2 + e * 6) * U * big, r1 = r0 + (1 - q) * 2.2 * U * big;
      ctx.beginPath(); ctx.moveTo(fx + Math.cos(an) * r0, fy + Math.sin(an) * r0); ctx.lineTo(fx + Math.cos(an) * r1, fy + Math.sin(an) * r1); ctx.stroke();
    }
  }
  // ---- the ball: soft glowing halo, stretched along its motion, gentle pulse
  if (r) {
    const [bx, by] = v2c(r.x, r.y), c = spdRGB(BD.kmh), al = r.a;
    const rad = Math.max(0.9 * U, (b ? b.r : 4) * vs) * (1 + 0.06 * Math.sin(t * 0.012));
    const sp_ = Math.hypot(r.vx, r.vy) * vs, stretch = clamp(1 + sp_ / (900 * U / 3), 1, 2.2), ang = Math.atan2(r.vy, r.vx);
    ctx.save(); ctx.translate(bx, by); ctx.rotate(ang); ctx.scale(stretch, 1 / Math.sqrt(stretch));
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rad * 4.2);
    g.addColorStop(0, rgba([255, 255, 255], 0.95 * al)); g.addColorStop(0.18, rgba(c, 0.8 * al)); g.addColorStop(0.5, rgba(c, 0.22 * al)); g.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rad * 4.2, 0, 7); ctx.fill();
    ctx.restore();
    ctx.fillStyle = rgba(football ? [255, 255, 255] : [235, 255, 150], al); ctx.beginPath(); ctx.arc(bx, by, rad * 0.9, 0, 7); ctx.fill();
    ctx.strokeStyle = rgba(c, 0.85 * al); ctx.lineWidth = 0.22 * U; ctx.setLineDash([1.2 * U, 0.9 * U]); ctx.lineDashOffset = t * 0.02 * U;
    ctx.beginPath(); ctx.arc(bx, by, rad * 2.3, 0, 7); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();
  // ---- game-style speed pop: scales in on each shot, follows the ball, then fades (no live jitter)
  const pt = t - popShotT;
  if (popShotT && G.shot.val && pt < 1700) {
    const at = r ? v2c(r.x, r.y) : (sb ? v2c(sb.x, sb.y) : null);
    if (at) {
      const sc = pt < 260 ? popEase(pt / 260) : 1, al = pt > 1300 ? 1 - (pt - 1300) / 400 : 1, c = spdRGB(G.shot.val);
      const txt = `${G.shot.val}`;
      ctx.save(); ctx.globalAlpha = Math.max(0, al);
      const px = at[0] + 3.2 * U, py = at[1] - 5.5 * U; ctx.translate(px, py); ctx.scale(sc, sc); ctx.rotate(-0.06);
      ctx.font = F(4.2 * U, 800, true); const tw = ctx.measureText(txt).width; ctx.font = F(1.5 * U, 800); const uw = ctx.measureText('km/h est.').width;
      const w = tw + uw + 4.6 * U, h = 5.4 * U;
      ctx.save(); ctx.shadowColor = rgba(c, 0.9); ctx.shadowBlur = 1.6 * U; rr(0, -h, w, h, h / 2); ctx.fillStyle = 'rgba(6,12,32,0.88)'; ctx.fill(); ctx.restore();
      rr(0, -h, w, h, h / 2); ctx.strokeStyle = rgba(c, 1); ctx.lineWidth = 0.32 * U; ctx.stroke();
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.font = F(4.2 * U, 800, true);
      ctx.fillStyle = rgba(c, 1); ctx.fillText(txt, 1.6 * U + 0.15 * U, -h / 2 + 0.15 * U); ctx.fillStyle = '#fff'; ctx.fillText(txt, 1.6 * U, -h / 2);
      ctx.font = F(1.5 * U, 800); ctx.fillStyle = rgba(c, 1); ctx.fillText('km/h est.', 2.4 * U + tw, -h / 2 + 0.5 * U);
      ctx.restore();
    }
  }
}

/* ---------------- top bar / panels / map ---------------- */
function drawTopBar(t, dt) {
  const s = sp(), portrait = H >= W;
  const avail = W - safe.l - Math.max(safe.r, ctrlW) - 3 * U, bw = portrait ? avail : Math.min(avail, 150 * U), bh = 11 * U;
  const x = safe.l + 1.5 * U + (avail - bw) / 2, y = safe.t + 1.2 * U;
  glass(x, y, bw, bh, s.accent);
  const seg = bw / 3;
  ctx.strokeStyle = 'rgba(41,230,255,0.3)'; ctx.lineWidth = Math.max(1, 0.15 * U);
  for (let i = 1; i < 3; i++) { ctx.beginPath(); ctx.moveTo(x + seg * i, y + 1.6 * U); ctx.lineTo(x + seg * i, y + bh - 1.6 * U); ctx.stroke(); }
  const lab = (txt, i) => { ctx.font = F(2.1 * U, 700); ctx.fillStyle = s.accent; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(txt, x + seg * i + 1.6 * U, y + 3.4 * U); };
  const valY = y + bh - 1.6 * U, big = Math.min(6.4 * U, seg * 0.2);
  // 1: time
  lab(s.timeLabel, 0);
  ctx.font = F(big, 700, true); ctx.textAlign = 'left';
  glowText(fmtTime(rallyMs(), S.sport !== 'football'), x + 1.4 * U, valY, s.accent, 1.2 * U);
  if (G.rally.on) { ctx.fillStyle = `rgba(255,70,100,${0.5 + 0.5 * Math.sin(t / 180)})`; ctx.beginPath(); ctx.arc(x + seg - 1.8 * U, y + 2.6 * U, 0.7 * U, 0, 7); ctx.fill(); }
  // 2: count / possession
  lab(s.countLabel, 1);
  if (S.sport === 'football') {
    const tot = G.poss.A + G.poss.B, a = tot ? Math.round(G.poss.A / tot * 100) : 50, ps = players();
    const ca = (ps.find((p) => p.team === 'A') || {}).color || '#29b6ff', cb = (ps.find((p) => p.team === 'B') || {}).color || '#ff5d8f';
    G.possDisp = lerp(G.possDisp ?? 50, a, Math.min(1, dt * 4));
    const bx = x + seg + 1.6 * U, bwid = seg - 3.2 * U, by = y + bh - 3 * U;
    ctx.font = F(big * 0.72, 700, true); ctx.textAlign = 'left'; glowText(`${Math.round(G.possDisp)}%`, bx, by - 1.2 * U, ca, U);
    ctx.textAlign = 'right'; glowText(`${100 - Math.round(G.possDisp)}%`, bx + bwid, by - 1.2 * U, cb, U);
    ctx.fillStyle = ca; ctx.fillRect(bx, by, bwid * G.possDisp / 100, 0.9 * U); ctx.fillStyle = cb; ctx.fillRect(bx + bwid * G.possDisp / 100, by, bwid * (1 - G.possDisp / 100), 0.9 * U);
    ctx.font = F(1.5 * U, 700); ctx.fillStyle = '#9fe9ff'; ctx.textAlign = 'center'; ctx.fillText('est.', bx + bwid / 2, y + 3.4 * U);
  } else {
    const bump = G.rally.bump ? 1 + 0.35 * Math.max(0, 1 - (t - G.rally.bump) / 260) : 1;
    ctx.save(); ctx.translate(x + seg + 1.6 * U, valY); ctx.scale(bump, bump); ctx.font = F(big, 700, true); ctx.textAlign = 'left'; glowText(String(G.rally.count), 0, 0, s.accent, 1.2 * U * bump); ctx.restore();
  }
  // 3: speed
  lab(s.speedLabel, 2);
  G.shot.disp = lerp(G.shot.disp, G.shot.val, Math.min(1, dt * 7));
  const sx = x + seg * 2 + 1.6 * U;
  ctx.font = F(big, 700, true); ctx.textAlign = 'left';
  const sv = G.shot.val ? String(Math.round(G.shot.disp)) : '—';
  const fl = G.shot.t && t - G.shot.t < 500 ? 1 - (t - G.shot.t) / 500 : 0;
  glowText(sv, sx, valY, fl ? '#ffd23d' : s.accent, (1.2 + fl * 2) * U);
  const vw = ctx.measureText(sv).width;
  ctx.font = F(1.9 * U, 700); ctx.fillStyle = '#9fe9ff'; ctx.fillText('km/h', Math.min(sx + vw + 0.8 * U, x + bw - 7 * U), valY);
  // est. pill
  const px = x + bw - 6.2 * U, py = y + 1.3 * U; rr(px, py, 4.8 * U, 2.6 * U, 1.3 * U); ctx.fillStyle = 'rgba(255,210,61,0.18)'; ctx.fill(); ctx.strokeStyle = '#ffd23d'; ctx.lineWidth = 0.15 * U; ctx.stroke();
  ctx.font = F(1.6 * U, 700); ctx.fillStyle = '#ffd23d'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('est.', px + 2.4 * U, py + 1.35 * U); ctx.textBaseline = 'alphabetic';
}
function panelRects() {
  const portrait = H >= W, avail = W - safe.l - Math.max(safe.r, ctrlW) - 3 * U, n = players().length;
  const rowH = n > 4 ? 6 * U : 7.4 * U, ph = rowH * n + 2.2 * U;
  const bottom = H - Math.max(ctrlH, safe.b) - 1.2 * U;
  if (portrait) { const w = (avail - 1.5 * U) / 2; return { rowH, p: [safe.l + 1.5 * U, bottom - ph, w, ph], m: [safe.l + 1.5 * U + w + 1.5 * U, bottom - Math.max(ph, 26 * U), w, Math.max(ph, 26 * U)] }; }
  const w = Math.min(avail * 0.3, 64 * U), mh = Math.max(ph, 30 * U);
  return { rowH, p: [safe.l + 1.5 * U, bottom - ph, w, ph], m: [W - Math.max(safe.r, ctrlW) - 1.5 * U - w, bottom - mh, w, mh] };
}
function drawPlayers(t, dt, R) {
  const [x, y, w, h] = R.p, ps = players(), s = sp(); glass(x, y, w, h, s.accent);
  ps.forEach((p, i) => {
    const st = G.stats[i] || { dist: 0, stam: 100 }; st.dDisp = lerp(st.dDisp ?? 0, st.dist, Math.min(1, dt * 5)); st.sDisp = lerp(st.sDisp ?? 100, st.stam, Math.min(1, dt * 5));
    const ry = y + 1.1 * U + i * R.rowH, live = G.tracks.some((k) => k.slot === i && t - k.t < 600);
    ctx.fillStyle = p.color; ctx.globalAlpha = live ? 1 : 0.35; ctx.fillRect(x + 0.8 * U, ry + 0.5 * U, 0.5 * U, R.rowH - 1.6 * U); ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    const nameX = x + 2 * U, ly = ry + R.rowH * 0.46;
    ctx.font = F(R.rowH * 0.2, 700); const chip = ctx.measureText(p.team).width + 1 * U;
    rr(nameX, ly - R.rowH * 0.3, chip, R.rowH * 0.32, 0.4 * U); ctx.fillStyle = hexA(p.color, 0.25); ctx.fill();
    ctx.fillStyle = p.color; ctx.textAlign = 'center'; ctx.fillText(p.team, nameX + chip / 2, ly - R.rowH * 0.07);
    ctx.textAlign = 'left'; ctx.font = F(R.rowH * 0.34, 700); ctx.fillStyle = live ? '#fff' : '#8aa';
    ctx.fillText(p.name, nameX + chip + 0.8 * U, ly);
    const nmW = ctx.measureText(p.name).width;
    ctx.textAlign = 'right'; ctx.font = F(R.rowH * 0.42, 700, true); ctx.fillStyle = p.color; ctx.fillText(String(p.rating), x + w - 1.2 * U, ly);
    const rtW = ctx.measureText(String(p.rating)).width;
    ctx.font = F(R.rowH * 0.19, 500); ctx.fillStyle = '#8fc6dc';
    const lab = 'พลังกาย'; if (nameX + chip + nmW + ctx.measureText(lab).width + rtW + 4 * U < x + w) ctx.fillText(lab, x + w - 2.2 * U - rtW, ly - R.rowH * 0.02);
    // stamina
    const bx = nameX, by = ry + R.rowH * 0.6, bw = w - 12.5 * U, bh = Math.max(2, R.rowH * 0.14);
    ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(bx, by, bw, bh);
    const f = st.sDisp / 100, g = ctx.createLinearGradient(bx, 0, bx + bw, 0); g.addColorStop(0, hexA(p.color, 0.6)); g.addColorStop(1, p.color);
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.shadowColor = p.color; ctx.shadowBlur = 0.8 * U; ctx.fillStyle = f < 0.3 ? '#ff4d6d' : g; ctx.fillRect(bx, by, bw * f, bh); ctx.restore();
    for (let q = 1; q < 10; q++) { ctx.fillStyle = 'rgba(5,14,36,0.7)'; ctx.fillRect(bx + bw * q / 10, by, Math.max(1, 0.15 * U), bh); }
    ctx.textAlign = 'right'; ctx.font = F(R.rowH * 0.27, 700); ctx.fillStyle = '#dff6ff'; ctx.fillText(`${st.dDisp.toFixed(1)} m`, x + w - 1.2 * U, by + bh);
  });
}
function drawMap(t, R) {
  const [x, y, w, h] = R.m, s = sp(), [cw_, cl_] = dims(), cal = !!calibValid(); glass(x, y, w, h, s.accent);
  ctx.textBaseline = 'alphabetic'; ctx.font = F(2.1 * U, 700); ctx.fillStyle = s.accent; ctx.textAlign = 'left'; ctx.fillText(s.mapLabel, x + 1.4 * U, y + 3.3 * U);
  ctx.font = F(1.6 * U, 700); ctx.textAlign = 'right'; ctx.fillStyle = cal ? '#3dff9e' : '#ffd23d'; ctx.fillText(cal ? 'CALIBRATED' : 'APPROX · tap Menu › Calibrate', x + w - 1.2 * U, y + 3.3 * U);
  // court box keeps aspect, length horizontal
  const ix = x + 1.6 * U, iy = y + 5 * U, iw = w - 3.2 * U, ih = h - 6.6 * U, k = Math.min(iw / cl_, ih / cw_);
  const ox = ix + (iw - cl_ * k) / 2, oy = iy + (ih - cw_ * k) / 2;
  const M = (X, Y) => [ox + Y * k, oy + (cw_ - X) * k];
  ctx.fillStyle = hexA(s.accent, 0.06); ctx.fillRect(ox, oy, cl_ * k, cw_ * k);
  ctx.strokeStyle = 'rgba(200,240,255,0.55)'; ctx.lineWidth = Math.max(1, 0.15 * U); ctx.beginPath();
  for (const [p, q] of courtLines(cw_, cl_)) { const A = M(...p), B = M(...q); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); }
  ctx.stroke();
  // net glow
  if (S.sport !== 'football') { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = hexA(s.accent, 0.8); ctx.lineWidth = 0.4 * U; ctx.shadowColor = s.accent; ctx.shadowBlur = U; const A = M(0, cl_ / 2), B = M(cw_, cl_ / 2); ctx.beginPath(); ctx.moveTo(...A); ctx.lineTo(...B); ctx.stroke(); ctx.restore(); }
  const toMap = (fx, fy, court) => {
    if (court) return M(clamp(court[0], -1, cw_ + 1), clamp(court[1], -1, cl_ + 1));
    return M(fx / VW * cw_, (1 - fy / VH) * cl_ * 1.0); // rough: lower in frame = nearer baseline
  };
  ctx.save(); ctx.beginPath(); ctx.rect(x, y + 4 * U, w, h - 4 * U); ctx.clip();
  players().forEach((p, i) => {
    const k_ = G.tracks.find((q) => q.slot === i && t - q.t < 1200); if (!k_) return;
    const c = toCourt(k_.sx, k_.sy), [mx, my] = toMap(k_.sx, k_.sy, c);
    const st = G.stats[i];
    if (st && st.trail && st.trail.length > 1) {
      ctx.strokeStyle = hexA(p.color, 0.45); ctx.lineWidth = 0.3 * U; ctx.beginPath();
      st.trail.forEach((q, j) => { const [a, b] = c ? M(q[0], q[1]) : toMap(q[0] * VW, q[1] * VH, null); j ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }); ctx.stroke();
    }
    const pr = 1.2 * U * (1 + 0.15 * Math.sin(t / 250 + i));
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = hexA(p.color, 0.35); ctx.beginPath(); ctx.arc(mx, my, pr * 2, 0, 7); ctx.fill(); ctx.restore();
    ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(mx, my, pr, 0, 7); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.2 * U; ctx.stroke();
    if (G.lock.tid === k_.id && t - G.lock.t < 3000) { ctx.strokeStyle = '#ffd23d'; ctx.lineWidth = 0.25 * U; ctx.beginPath(); ctx.arc(mx, my, pr * 2.2, 0, 7); ctx.stroke(); }
  });
  if (BD.vis && t - BD.vis.t < 60) { const c = toCourt(BD.vis.x, BD.vis.y); if (c || true) { const [mx, my] = toMap(BD.vis.x, BD.vis.y, c); ctx.fillStyle = S.sport === 'tennis' ? '#d8ff3d' : '#fff'; ctx.beginPath(); ctx.arc(mx, my, 0.7 * U, 0, 7); ctx.fill(); } }
  ctx.restore();
  ctx.font = F(1.5 * U, 500); ctx.fillStyle = '#7fb6cc'; ctx.textAlign = 'left'; ctx.fillText('ทีม A', x + 1.4 * U, y + h - 0.8 * U); ctx.textAlign = 'right'; ctx.fillText('ทีม B', x + w - 1.4 * U, y + h - 0.8 * U);
}

/* ---------------- calibration UI ---------------- */
const CORNERS = ['NEAR-LEFT corner (closest to you, left)', 'NEAR-RIGHT corner', 'FAR-RIGHT corner', 'FAR-LEFT corner'];
let calibPts = null;
function startCalib() { calibPts = []; $('menu').classList.add('hidden'); $('calibBar').classList.remove('hidden'); updCalibMsg(); }
function updCalibMsg() { const [w, l] = dims(); $('calibMsg').innerHTML = `📐 Tap ${calibPts.length + 1}/4: <b>${CORNERS[calibPts.length]}</b><br><small>Rectangle ${w} × ${l} m · keep the phone still after calibrating</small>`; }
function endCalib() { calibPts = null; $('calibBar').classList.add('hidden'); }
$('calibUndo').onclick = () => { if (calibPts && calibPts.length) { calibPts.pop(); updCalibMsg(); } };
$('calibCancel').onclick = endCalib;
function drawCalib(t) {
  if (!calibPts) return;
  ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0, 0, W, H);
  const pts = calibPts.map(([x, y]) => v2c(x * VW, y * VH));
  ctx.strokeStyle = '#ffd23d'; ctx.lineWidth = 0.35 * U; ctx.setLineDash([U, 0.7 * U]); ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (pts.length === 4) ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
  pts.forEach(([x, y], i) => {
    ctx.strokeStyle = '#ffd23d'; ctx.lineWidth = 0.3 * U; ctx.beginPath(); ctx.arc(x, y, 2 * U + Math.sin(t / 200) * 0.3 * U, 0, 7); ctx.moveTo(x - 3.5 * U, y); ctx.lineTo(x + 3.5 * U, y); ctx.moveTo(x, y - 3.5 * U); ctx.lineTo(x, y + 3.5 * U); ctx.stroke();
    ctx.font = F(2.4 * U, 700); ctx.fillStyle = '#ffd23d'; ctx.textAlign = 'left'; ctx.fillText(String(i + 1), x + 2.4 * U, y - 2.4 * U);
  });
}

/* ---------------- canvas taps ---------------- */
cv.addEventListener('pointerdown', (e) => {
  const x = e.clientX * DPR, y = e.clientY * DPR;
  if (calibPts) {
    const [vx, vy] = c2v(x, y); calibPts.push([clamp(vx / VW, 0, 1), clamp(vy / VH, 0, 1)]); buzz();
    if (calibPts.length === 4) {
      const c = buildCalib(calibPts);
      if (c) { S.calib[S.sport] = c; save(); toast('✓ Court calibrated — distances, map & speeds now use real metres (still est.)', 3500); resetStats(); }
      else toast('Calibration failed — tap the 4 corners in order', 3000);
      endCalib();
    } else updCalibMsg();
    return;
  }
  // tap a player to swap identities
  const [vx, vy] = c2v(x, y), n = players().length;
  let best = null, bd = 1e9;
  for (const k of G.tracks) { if (vx < k.x - k.h * 0.4 || vx > k.x + k.h * 0.4 || vy < k.top - k.h * 0.25 || vy > k.y + k.h * 0.15) continue; const d = Math.abs(vx - k.x); if (d < bd) { bd = d; best = k; } }
  if (best && n) {
    const next = (best.slot + 1) % n, other = G.tracks.find((k) => k.slot === next);
    if (other) other.slot = best.slot >= 0 ? best.slot : -1;
    best.slot = next; best.appear = now(); buzz(); toast(`Now: ${players()[next].name}`, 1200);
  }
});

/* ---------------- frame loop ---------------- */
let lastF = now(), fpsAcc = 0, fpsN = 0;
let lastVT = -1, rvfc = false;
function startFrameCb() {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
  rvfc = true; const cb = (n) => { video.requestVideoFrameCallback(cb); if ($('live').classList.contains('active')) { try { btFrame(now()); } catch (e) { console.warn('bt', e); } } };
  video.requestVideoFrameCallback(cb);
}
function frame() {
  requestAnimationFrame(frame);
  if (!rvfc && video.currentTime !== lastVT) { lastVT = video.currentTime; try { btFrame(now()); } catch (e) {} }
  if (!$('live').classList.contains('active')) return;
  const t = now(), dt = Math.min(0.1, (t - lastF) / 1000); lastF = t;
  fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { G.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  if (cv.width !== W || cv.height !== H) resize();
  measureCtrl();
  fitVideo();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  if (video.readyState >= 2) ctx.drawImage(video, vox, voy, VW * vs, VH * vs); else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
  // vignette
  const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,8,24,0.45)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  // smooth track display positions
  const ps = players(), a = 1 - Math.exp(-dt * 12);
  for (const k of G.tracks) {
    const lag = Math.min((t - k.t) / 1000, 0.15), tx = k.x + k.vx * lag, ty = k.y + k.vy * lag;
    k.sx = lerp(k.sx, tx, a); k.sy = lerp(k.sy, ty, a); k.sh = lerp(k.sh, k.h, a); k.stop = lerp(k.stop, k.top + (ty - k.y), a);
  }
  drawCourtOverlay(t);
  const vis = G.tracks.filter((k) => k.slot >= 0 && k.slot < ps.length && t - k.t < 900).sort((p, q) => p.sy - q.sy);
  const lockK = G.tracks.find((k) => k.id === G.lock.tid);
  for (const k of vis) drawRing(k, ps[k.slot].color, t, k === lockK && t - G.lock.t < 3000);
  drawBall(t);
  const boxes = new Map(); for (const k of vis) boxes.set(k.id, drawTag(k, ps[k.slot], t, k === lockK));
  if (lockK && lockK.slot >= 0 && vis.includes(lockK)) drawLock(lockK, ps[lockK.slot], t, boxes.get(lockK.id));
  if (G.debug) drawDebug(t);
  drawTopBar(t, dt);
  const R = panelRects(); drawPlayers(t, dt, R); drawMap(t, R);
  drawCalib(t);
  if (micOn) pollMic(t);
  if (rec) $('recTime').textContent = fmtTime(t - recT0, false);
}
function drawDebug(t) {
  ctx.save(); ctx.lineWidth = 2; ctx.font = F(2 * U, 500);
  for (const k of G.tracks) { const [x0, y0] = v2c(k.x - k.h * 0.25, k.top), [x1, y1] = v2c(k.x + k.h * 0.25, k.y); ctx.strokeStyle = k.slot >= 0 ? '#0f0' : '#f80'; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(`#${k.id} s${k.slot} ${(k.wristMs || 0).toFixed(1)}m/s`, x0, y0 - 4); }
  if (G.ball) { const [bx, by] = v2c(G.ball.x, G.ball.y); ctx.strokeStyle = '#f0f'; ctx.strokeRect(bx - 10, by - 10, 20, 20); ctx.fillText(`${G.ball.src} ${G.ball.kmh.toFixed(0)}`, bx + 12, by); }
  ctx.fillStyle = '#ff0'; ctx.textAlign = 'left'; ctx.fillText(`fps ${G.fps.toFixed(0)} · infer ${G.inferMs.toFixed(0)}ms · ${delegateUsed} · ${VW}x${VH} · tracks ${G.tracks.length}`, safe.l + 2 * U, safe.t + 15 * U);
  ctx.restore();
}

/* ---------------- controls ---------------- */
$('bRally').onclick = (e) => { buzz(e.currentTarget); getAudioCtx(); toggleRally(); };
$('bHit').onclick = (e) => { buzz(e.currentTarget); hit(false); };
$('bReset').onclick = (e) => { buzz(e.currentTarget); resetAll(); };
$('bMenu').onclick = (e) => { buzz(e.currentTarget); $('mMic').checked = S.mic; $('mSwing').checked = S.swing; $('mLines').checked = S.lines; $('mDebug').checked = G.debug; $('mSwing').closest('label').style.display = S.sport === 'football' ? 'none' : ''; $('menu').classList.toggle('hidden'); };
$('mClose').onclick = () => $('menu').classList.add('hidden');
$('mCalib').onclick = startCalib;
$('mClearCalib').onclick = () => { delete S.calib[S.sport]; save(); resetStats(); toast('Calibration cleared'); };
$('mMic').onchange = (e) => { S.mic = e.target.checked; save(); if (S.mic) { getAudioCtx(); enableMic(); } else micOn = false; };
$('mSwing').onchange = (e) => { S.swing = e.target.checked; save(); };
$('mLines').onchange = (e) => { S.lines = e.target.checked; save(); };
$('mDebug').onchange = (e) => { G.debug = e.target.checked; };
$('mResetStats').onclick = () => { resetStats(); toast('Distance & stamina reset'); };
$('mSetup').onclick = () => { $('menu').classList.add('hidden'); if (rec) stopRec(); stopSource(); openSetup(); };

/* ---------------- mic: shuttle / ball hit detection (beta) ---------------- */
let actx = null, analyser = null, micOn = false, abuf = null, aBase = 0.01, lastPeakT = 0;
function getAudioCtx() { try { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) {} return actx; }
async function ensureMic() {
  if (micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live')) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  return micStream;
}
async function enableMic() {
  try {
    await ensureMic(); const ac = getAudioCtx(); if (!ac) throw new Error('no AudioContext');
    if (!analyser) {
      const src = ac.createMediaStreamSource(micStream), hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
      analyser = ac.createAnalyser(); analyser.fftSize = 1024; src.connect(hp); hp.connect(analyser); abuf = new Float32Array(analyser.fftSize);
    }
    micOn = true; toast('🎙 Mic hit-count on (beta) — sharp hit sounds add +1');
  } catch (e) { micOn = false; S.mic = false; save(); toast('Mic not available: ' + e.message, 3000); }
}
function pollMic(t) {
  if (!analyser) return;
  analyser.getFloatTimeDomainData(abuf);
  let pk = 0, sum = 0; for (let i = 0; i < abuf.length; i++) { const v = Math.abs(abuf[i]); if (v > pk) pk = v; sum += v * v; }
  const rms = Math.sqrt(sum / abuf.length);
  if (pk > Math.max(0.06, aBase * 7) && t - lastPeakT > 280) { lastPeakT = t; hit(true); }
  aBase = lerp(aBase, rms, 0.02);
}

/* ---------------- recording ---------------- */
let rec = null, recChunks = [], recT0 = 0, recUrl = null, recFile = null;
function pickMime() {
  const c = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
}
$('bRec').onclick = async (e) => { buzz(e.currentTarget); if (rec) stopRec(); else startRec(); };
async function startRec() {
  if (!window.MediaRecorder || !cv.captureStream) { toast('Recording is not supported in this browser', 3000); return; }
  getAudioCtx();
  const stream = cv.captureStream(30);
  let audio = false;
  try { await ensureMic(); micStream.getAudioTracks().forEach((t) => stream.addTrack(t)); audio = true; } catch (e) { toast('Recording without sound (mic not allowed)', 2500); }
  const mimeType = pickMime();
  try { rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 128_000 }); }
  catch (e) { rec = new MediaRecorder(stream); }
  recChunks = []; rec.ondataavailable = (ev) => ev.data && ev.data.size && recChunks.push(ev.data);
  const r0 = rec; rec.onstop = () => finishRec(r0.mimeType || mimeType, audio);
  rec.start(1000); recT0 = now();
  $('bRec').classList.add('on'); $('bRecL').textContent = 'SAVE'; $('recBadge').classList.remove('hidden');
}
function stopRec() { if (!rec) return; const r = rec; rec = null; try { r.stop(); } catch (e) {} $('bRec').classList.remove('on'); $('bRecL').textContent = 'REC'; $('recBadge').classList.add('hidden'); }
function finishRec(mime, audio) {
  const type = (mime || 'video/mp4').split(';')[0], ext = type.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(recChunks, { type });
  if (recUrl) URL.revokeObjectURL(recUrl);
  recUrl = URL.createObjectURL(blob);
  const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  recFile = new File([blob], `court-cam-${S.sport}-${stamp}.${ext}`, { type });
  $('resVid').src = recUrl; $('rDl').href = recUrl; $('rDl').download = recFile.name;
  $('rNote').textContent = `${(blob.size / 1e6).toFixed(1)} MB · ${ext.toUpperCase()}${audio ? ' · with mic audio' : ' · no audio'}. On iPhone tap Save → “Save Video” to put it in Photos.`;
  $('result').classList.remove('hidden');
  window.__lastRec = { size: blob.size, type, name: recFile.name }; window.__lastRecBlob = blob;
}
$('rShare').onclick = async () => {
  if (!recFile) return;
  try {
    if (navigator.canShare && navigator.canShare({ files: [recFile] })) await navigator.share({ files: [recFile], title: 'Court Cam clip' });
    else { $('rDl').click(); }
  } catch (e) { if (e.name !== 'AbortError') toast('Share failed: ' + e.message, 3000); }
};
$('rClose').onclick = () => $('result').classList.add('hidden');

/* ---------------- boot ---------------- */
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
document.fonts && document.fonts.load(F(20, 700, true)).catch(() => {});
window.__G = G; window.__S = S; window.__vid = () => video;
if (QS.get('sport') && SPORTS[QS.get('sport')]) { S.sport = QS.get('sport'); }
if (QS.get('auto') === '1') startLive(QS.get('src') || null);
else if (QS.get('setup') === '1') openSetup();
