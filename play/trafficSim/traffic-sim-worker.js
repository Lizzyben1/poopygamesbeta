/* traffic-sim-worker.js — off-main-thread half of the driving brain.
   Per tick the page transfers ONE Float32Array holding every vehicle (S floats per row, layout below). The worker then
     1. bins the fleet into a typed-array spatial hash,
     2. casts the left / right blind-spot clearance rays (network inputs 6 and 7),
     3. runs the vehicle-vehicle OBB collision test,
     4. appends flagged rows to the imitation-learning memory (v1),
     5. evaluates the v1 gate and the v2 strategic network, each in one batched forward pass,
     6. v1 RL fine-tuning: per-car (inputs, intent, reward) steps -> discounted returns -> advantage-weighted cross-entropy,
     7. v2 PPO: per-car trajectories -> GAE -> clipped actor-critic update (see ppoUpdate),
   and transfers the results back. Behavioural-cloning training also runs here, one epoch per task so ticks keep flowing.
   Row: [0..19] network inputs (v1 uses the first 12) | X | Z | FX | FZ | LEN | WID | ID | FL | LAB teacher label | REW reward since the last decision
   Flags: 1 evaluate v1, 2 record sample, 4 already crashed, 8 skip collisions (player), 16 turning inside a junction, 32 v1 RL decision,
          64 v2 decision (sample all heads), 128 v2 peek (forward only, for the inspector), 256 the v2 turn head is being used at this decision */
importScripts('neural-brain.js');
const F = 12, F2 = 20, X = 20, Z = 21, FX = 22, FZ = 23, LEN = 24, WID = 25, ID = 26, FL = 27, LAB = 28, REW = 29, S = 30;
const CAP = 60000, HS = 8192, CELL = 8;
const H = 8, GAMMA = 0.8, RLB = 2048, EPS = 0.03;             // v1 RL: return horizon (decisions), discount per decision, on-policy batch, exploration floor
const PPO = { gamma: 0.9, lambda: 0.9, clip: 0.2, cv: 0.5, ce: 0.01, lr: 3e-4, batch: 4096, minibatch: 256, epochs: 4, flush: 16 };
const HEADS = Brain.HEADS, VAL = Brain.VAL;
let rnd = Math.random;                                       // sampler; re-seeded per benchmark run so that runs are reproducible

/* ---------- v1: tactical gate ---------- */
let model = Brain.create(7), trained = null;
const memX = new Float32Array(CAP * F), memY = new Uint8Array(CAP), counts = [0, 0, 0, 0];
let memN = 0, memW = 0;
const traj = new Map(), rlX = new Float32Array(RLB * F), rlA = new Uint8Array(RLB), rlG = new Float32Array(RLB), rlW = new Float32Array(RLB), rlIdx = Int32Array.from({ length: RLB }, (_, i) => i);
const base = new Float32Array(12), baseN = new Uint8Array(12);
let rlN = 0, rlOpt = null, rlUpd = 0, rlBase = null, rlLr = 2e-4;
// ponytail: tabular baseline over 12 coarse states (signal ahead x inside the decision zone); v2 has a learned value head instead
const stateOf = i => { const g = rlX[i * F + 5]; return (g < -0.5 ? 0 : g < 0.12 ? 1 : g < 0.37 ? 2 : g < 0.62 ? 3 : g < 0.87 ? 4 : 5) * 2 + (rlX[i * F + 4] < 1 ? 1 : 0); };

function rlUpdate() {
  if (!rlBase) rlBase = Brain.serialize(model, { trained });   // the cloned starting point, for 'rlRevert'
  if (!rlOpt) rlOpt = Brain.makeOpt(model, rlLr, 128);
  rlOpt.lr = rlLr;
  const sum = new Float32Array(12), cnt = new Float32Array(12); let mean = 0, sq = 0;
  for (let i = 0; i < rlN; i++) { const b = stateOf(i); sum[b] += rlG[i]; cnt[b]++; mean += rlG[i]; }
  mean /= rlN;
  for (let i = 0; i < rlN; i++) { const b = stateOf(i); rlW[i] = rlG[i] - (baseN[b] ? base[b] : sum[b] / cnt[b]); sq += rlW[i] * rlW[i]; }   // advantage
  const sd = Math.sqrt(sq / rlN) + 1e-6;
  for (let i = 0; i < rlN; i++) rlW[i] = Math.max(-2.5, Math.min(2.5, rlW[i] / sd));
  for (let b = 0; b < 12; b++) if (cnt[b]) { base[b] = baseN[b] ? 0.7 * base[b] + 0.3 * sum[b] / cnt[b] : sum[b] / cnt[b]; baseN[b] = 1; }
  for (let e = 0; e < 2; e++) Brain.trainEpoch(model, rlOpt, rlX, rlA, rlIdx, rlN, null, Math.random, rlW);
  rlUpd++; trained = Object.assign({}, trained, { rlUpdates: rlUpd, rlMeanReturn: +mean.toFixed(3) });
  postMessage({ type: 'rl', upd: rlUpd, ret: mean, n: rlN });
  postMessage({ type: 'model', ok: true, version: 1, model: Brain.serialize(model, { trained }) });
  rlN = 0;
}
// move the first n steps of a car's trajectory into the on-policy batch with their (truncated) discounted returns
function rlEmit(t, n) {
  for (let i = 0; i < n; i++) {
    let g = 0, d = 1; for (let k = i; k < t.R.length && k < i + H; k++) { g += d * t.R[k]; d *= GAMMA; }
    rlX.set(t.X[i], rlN * F); rlA[rlN] = t.A[i]; rlG[rlN] = g; if (++rlN === RLB) rlUpdate();
  }
  t.X.splice(0, n); t.A.splice(0, n); t.R.splice(0, n);
}

/* ---------- v2: strategic network, PPO actor-critic ---------- */
let model2 = null, opt2 = null, upd2 = 0, trained2 = null, bN = 0;
const traj2 = new Map(), NB = PPO.batch;
const bat = { X: new Float32Array(NB * F2), A: new Uint8Array(NB * 4), M: new Uint8Array(NB), LP: new Float32Array(NB), ADV: new Float32Array(NB), RET: new Float32Array(NB) };
const bIdx = Int32Array.from({ length: NB }, (_, i) => i);
function reset2() { opt2 = null; traj2.clear(); bN = 0; }

function ppoUpdate() {
  if (!opt2) opt2 = Brain.makeOpt(model2, PPO.lr, PPO.minibatch);
  let mu = 0, sq = 0, ret = 0;
  for (let i = 0; i < bN; i++) { mu += bat.ADV[i]; ret += bat.RET[i]; }
  mu /= bN; ret /= bN;
  for (let i = 0; i < bN; i++) sq += (bat.ADV[i] - mu) ** 2;
  const sd = Math.sqrt(sq / bN) + 1e-6;
  for (let i = 0; i < bN; i++) bat.ADV[i] = (bat.ADV[i] - mu) / sd;                 // normalised advantages
  let st;
  for (let e = 0; e < PPO.epochs; e++) st = Brain.ppoEpoch(model2, opt2, bat, bIdx, bN, PPO, Math.random);
  upd2++; trained2 = { scratch: true, algorithm: 'PPO', ppoUpdates: upd2, decisions: upd2 * NB, meanReturn: +ret.toFixed(3), entropy: +st.entropy.toFixed(3) };
  postMessage({ type: 'rl2', upd: upd2, ret, entropy: st.entropy, valueLoss: st.valueLoss, clipFrac: st.clipFrac });
  bN = 0;
}
// A car's finished steps -> batch. Generalised advantage estimation, bootstrapped with the value of the state the car is in now (0 if it left).
function flush2(t, bootV) {
  const n = t.R.length; let adv = 0; const advs = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const delta = t.R[i] + PPO.gamma * (i === n - 1 ? bootV : t.V[i + 1]) - t.V[i];
    adv = delta + PPO.gamma * PPO.lambda * adv; advs[i] = adv;
  }
  for (let i = 0; i < n; i++) {
    bat.X.set(t.X[i], bN * F2); bat.A.set(t.A[i], bN * 4); bat.M[bN] = t.M[i]; bat.LP[bN] = t.LP[i]; bat.ADV[bN] = advs[i]; bat.RET[bN] = advs[i] + t.V[i];
    if (++bN === NB) ppoUpdate();
  }
  for (const k of ['X', 'A', 'M', 'LP', 'V', 'R']) t[k].splice(0, n);
}

/* ---------- per-tick work ---------- */
const head = new Int32Array(HS);
let next = new Int32Array(2048), rows = new Int32Array(2048), rows2 = new Int32Array(2048), Xb = new Float32Array(2048 * F), Pb = new Float32Array(2048 * 4), X2 = new Float32Array(2048 * F2), Z2 = new Float32Array(2048 * 14);
const bucket = (cx, cz) => ((Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) >>> 0) & (HS - 1);

function obb(A, o, q, k) {                                    // SAT overlap of two oriented boxes
  const dx = A[q + X] - A[o + X], dz = A[q + Z] - A[o + Z], afx = A[o + FX], afz = A[o + FZ], bfx = A[q + FX], bfz = A[q + FZ];
  const ha = A[o + LEN] / 2 * k, wa = A[o + WID] / 2 * k, hb = A[q + LEN] / 2 * k, wb = A[q + WID] / 2 * k;
  const c = Math.abs(afx * bfx + afz * bfz), s = Math.abs(afx * bfz - afz * bfx);
  return !(Math.abs(dx * afx + dz * afz) > ha + hb * c + wb * s || Math.abs(-dx * afz + dz * afx) > wa + hb * s + wb * c ||
           Math.abs(dx * bfx + dz * bfz) > hb + ha * c + wa * s || Math.abs(-dx * bfz + dz * bfx) > wb + ha * s + wa * c);
}

function tick(d) {
  const t0 = performance.now(), A = d.buf, n = d.n;
  if (next.length < n) { next = new Int32Array(n * 2); rows = new Int32Array(n * 2); rows2 = new Int32Array(n * 2); Xb = new Float32Array(n * 2 * F); Pb = new Float32Array(n * 2 * 4); X2 = new Float32Array(n * 2 * F2); Z2 = new Float32Array(n * 2 * 14); }
  head.fill(-1);
  for (let i = 0; i < n; i++) { const o = i * S, b = bucket(Math.floor(A[o + X] / CELL), Math.floor(A[o + Z] / CELL)); next[i] = head[b]; head[b] = i; }

  const R = d.bsR, rc = Math.ceil(R / CELL); let m = 0, m2 = 0, selIn = null;
  for (let i = 0; i < n; i++) {
    const o = i * S, fl = A[o + FL] | 0; if (!(fl & 227)) continue;                 // 1 | 2 | 32 | 64 | 128
    // blind-spot clearance: nearest vehicle inside the 100..135 degree sector behind the B/C pillar on each side
    const x = A[o + X], z = A[o + Z], fx = A[o + FX], fz = A[o + FZ], cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    let occL = 0, occR = 0;
    for (let a = -rc; a <= rc; a++) for (let c = -rc; c <= rc; c++) for (let j = head[bucket(cx + a, cz + c)]; j >= 0; j = next[j]) {
      if (j === i) continue;
      const q = j * S, dx = A[q + X] - x, dz = A[q + Z] - z, dd = Math.hypot(dx, dz); if (dd >= R || dd < 0.1) continue;
      const cs = (dx * fx + dz * fz) / dd; if (cs > -0.174 || cs < -0.707) continue;
      const occ = 1 - dd / R;
      if (-dx * fz + dz * fx < 0) { if (occ > occL) occL = occ; } else if (occ > occR) occR = occ;
    }
    A[o + 6] = occL; A[o + 7] = occR;
    if (fl & 2) {                                              // imitation recorder (ring buffer)
      const y = A[o + LAB] | 0;
      if (memN === CAP) counts[memY[memW]]--; else memN++;
      memX.set(A.subarray(o, o + F), memW * F); memY[memW] = y; counts[y]++; memW = (memW + 1) % CAP;
    }
    if (fl & 1) { rows[m] = i; Xb.set(A.subarray(o, o + F), m * F); m++; }
    if ((fl & 192) && model2) { rows2[m2] = i; X2.set(A.subarray(o, o + F2), m2 * F2); m2++; }
    if (A[o + ID] === d.sel) selIn = A.slice(o, o + S);
  }

  const pairs = [];
  if (d.collide) for (let i = 0; i < n; i++) {
    const o = i * S, fi = A[o + FL] | 0; if (fi & 8) continue;
    const cx = Math.floor(A[o + X] / CELL), cz = Math.floor(A[o + Z] / CELL);
    for (let a = -2; a <= 2; a++) for (let c = -2; c <= 2; c++) for (let j = head[bucket(cx + a, cz + c)]; j >= 0; j = next[j]) {
      if (j <= i) continue;
      const q = j * S, fj = A[q + FL] | 0; if ((fj & 8) || ((fi & 4) && (fj & 4))) continue;
      if (Math.hypot(A[q + X] - A[o + X], A[q + Z] - A[o + Z]) >= (A[o + LEN] + A[q + LEN]) / 2 + 0.5) continue;
      if (obb(A, o, q, (fi | fj) & 16 ? 0.8 : 0.92)) pairs.push(A[o + ID], A[q + ID]);
    }
  }

  let out = null;
  if (m) {                                                     // v1: one batched forward pass for the whole near fleet
    Brain.forward(model, Xb, m, Pb);
    out = new Float32Array(m * 6);                             // id, p0..p3, sampled intent (-1 = none)
    for (let r = 0; r < m; r++) {
      const o = rows[r] * S, id = A[o + ID]; out[r * 6] = id; out[r * 6 + 5] = -1;
      for (let j = 0; j < 4; j++) out[r * 6 + 1 + j] = Pb[r * 4 + j];
      if ((A[o + FL] | 0) & 32) {                              // v1 RL decision: close the previous step with its reward, then sample the next intent
        let t = traj.get(id);
        if (!t) { t = { X: [], A: [], R: [] }; traj.set(id, t); }
        else { t.R.push(A[o + REW]); if (t.R.length >= H) rlEmit(t, t.R.length - H + 1); }
        let a = 0;
        if (rnd() < EPS) a = (rnd() * 4) | 0;
        else { let c = rnd(); while (a < 3 && (c -= Pb[r * 4 + a]) > 0) a++; }
        t.X.push(A.slice(o, o + F)); t.A.push(a); out[r * 6 + 5] = a;
      }
    }
  }
  let out2 = null;
  if (m2) {                                                    // v2: one batched forward pass; decisions sample every head from its softmax
    Brain.forward2(model2, X2, m2, Z2);
    out2 = new Float32Array(m2 * 20);                          // id, kind (1 decision / 0 peek), 4 actions, 13 head probabilities, value
    for (let r = 0; r < m2; r++) {
      const o = rows2[r] * S, q = r * 14, p = r * 20, id = A[o + ID], fl = A[o + FL] | 0, dec = fl & 64, turnUsed = fl & 256 ? 1 : 0, V = Z2[q + VAL];
      out2[p] = id; out2[p + 1] = dec ? 1 : 0; for (let j = 0; j < 14; j++) out2[p + 6 + j] = Z2[q + j];
      if (!dec) continue;
      const act = new Uint8Array(4); let lp = 0;
      for (let h = 0; h < 4; h++) {
        const off = HEADS[h][0], len = HEADS[h][1]; let a = 0, c = rnd(); while (a < len - 1 && (c -= Z2[q + off + a]) > 0) a++;
        act[h] = a; out2[p + 2 + h] = a; if (h !== 1 || turnUsed) lp += Math.log(Math.max(Z2[q + off + a], 1e-9));
      }
      if (!d.train2) continue;
      let t = traj2.get(id);
      if (!t) { t = { X: [], A: [], M: [], LP: [], V: [], R: [] }; traj2.set(id, t); }
      else { t.R.push(A[o + REW]); if (t.R.length >= PPO.flush) flush2(t, V); }
      t.X.push(A.slice(o, o + F2)); t.A.push(act); t.M.push(turnUsed); t.LP.push(lp); t.V.push(V);
    }
  }
  if (d.gone) for (let i = 0; i < d.gone.length; i += 2) {      // cars that left the simulation: flush what they had (final reward included)
    const id = d.gone[i], t = traj.get(id), t2 = traj2.get(id);
    if (t) { if (t.X.length > t.R.length) t.R.push(d.gone[i + 1]); rlEmit(t, t.X.length); traj.delete(id); }
    if (t2) { if (t2.X.length > t2.R.length) t2.R.push(d.gone[i + 1]); flush2(t2, 0); traj2.delete(id); }
  }
  const pr = Int32Array.from(pairs), tr = [pr.buffer]; if (out) tr.push(out.buffer); if (out2) tr.push(out2.buffer); if (selIn) tr.push(selIn.buffer);
  postMessage({ type: 'tick', out, m, out2, m2, pairs: pr, selIn, memN, counts, ms: performance.now() - t0 }, tr);
}

/* ---------- v1 behavioural cloning ---------- */
let training = null;
function train(d) {
  if (training) return;
  if (memN < 1000) { postMessage({ type: 'error', error: 'Need at least 1000 recorded samples (have ' + memN + '). Run Training Mode first.' }); return; }
  const r = Brain.rng((Math.random() * 1e9) | 0), all = Int32Array.from({ length: memN }, (_, i) => i);
  for (let i = memN - 1; i > 0; i--) { const j = (r() * (i + 1)) | 0, t = all[i]; all[i] = all[j]; all[j] = t; }
  const N = Math.min(memN, d.maxSamples || 24000), idx = all.subarray(0, N), nVal = (N / 10) | 0, nTr = N - nVal;
  const cnt = [0, 0, 0, 0]; for (let i = 0; i < nTr; i++) cnt[memY[idx[i]]]++;
  const cw = cnt.map(c => c ? Math.min(3, Math.max(0.5, Math.sqrt(nTr / (4 * c)))) : 1);       // mild re-weighting of rare intents
  model = Brain.create((r() * 1e9) | 0);
  const lr = d.lr || 0.004, opt = Brain.makeOpt(model, lr, 128), epochs = d.epochs || 200, t0 = performance.now();
  training = { ep: 0 };
  const step = () => {
    opt.lr = lr * (training.ep > epochs * 0.6 ? 0.3 : 1);
    const e = Brain.trainEpoch(model, opt, memX, memY, idx, nTr, cw, r), v = Brain.evaluate(model, memX, memY, idx, nTr, N);
    training.ep++;
    postMessage({ type: 'progress', epoch: training.ep, epochs, loss: e.loss, acc: e.acc, val: v.acc, recall: v.recall });
    if (training.ep < epochs) { setTimeout(step, 0); return; }
    trained = { samples: N, epochs, trainAcc: +e.acc.toFixed(4), valAcc: +v.acc.toFixed(4), recall: v.recall, seconds: +((performance.now() - t0) / 1000).toFixed(1) };
    training = null; rlBase = null; rlOpt = null; rlUpd = 0;
    postMessage({ type: 'trained', model: Brain.serialize(model, { trained }) });
  };
  step();
}

const send = version => postMessage({ type: 'model', ok: true, version, model: version === 2 ? Brain.serialize(model2, { trained: trained2 }) : Brain.serialize(model, { trained }) });
onmessage = e => {
  const d = e.data;
  if (d.type === 'tick') tick(d);
  else if (d.type === 'train') train(d);
  else if (d.type === 'clear') { memN = memW = 0; counts.fill(0); }
  else if (d.type === 'seed') rnd = d.seed == null ? Math.random : Brain.rng(d.seed);
  else if (d.type === 'rlReset') { traj.clear(); rlN = 0; traj2.clear(); bN = 0; }
  else if (d.type === 'rlConfig') { if (d.lr > 0 && d.lr < 0.1) rlLr = d.lr; }
  else if (d.type === 'rlRevert') {
    if (!rlBase) { postMessage({ type: 'error', error: 'No RL updates have been applied yet' }); return; }
    model = Brain.deserialize(rlBase); trained = rlBase.trained || null; rlBase = null; rlOpt = null; rlUpd = 0; rlN = 0; traj.clear(); baseN.fill(0);
    postMessage({ type: 'model', ok: true, version: 1, model: Brain.serialize(model, { trained }), imported: true });
  }
  else if (d.type === 'init2') {                               // strategic network: forget everything, start from random weights
    model2 = Brain.create((Math.random() * 1e9) | 0, Brain.SIZES2); trained2 = { scratch: true, algorithm: 'PPO', ppoUpdates: 0 }; upd2 = 0; reset2(); send(2);
  }
  else if (d.type === 'getModel') { if (d.version === 2 && !model2) postMessage({ type: 'error', error: 'No strategic (v2) network yet: train one with PURE RL or import one' }); else send(d.version === 2 ? 2 : 1); }
  else if (d.type === 'setModel') {
    try {
      const mm = Brain.deserialize(d.model);                   // throws on a wrong version, shape or value
      if (mm.sizes[0] === F2) { model2 = mm; trained2 = d.model.trained || { imported: true }; upd2 = trained2.ppoUpdates || 0; reset2(); }
      else { model = mm; trained = d.model.trained || { imported: true }; rlBase = null; rlOpt = null; rlUpd = 0; }
      postMessage({ type: 'model', ok: true, version: mm.sizes[0] === F2 ? 2 : 1, model: Brain.serialize(mm, { trained: mm.sizes[0] === F2 ? trained2 : trained }), imported: true });
    } catch (x) { postMessage({ type: 'error', error: 'Model rejected: ' + x.message }); }
  }
};
postMessage({ type: 'ready' });
