/* neural-brain.js — the two driving networks, on flat Float32Array buffers (one contiguous row-major buffer per batch, no per-agent objects).
     v1  tactical gate      12 -> 32 -> 16 -> 4 softmax (intent)                              behavioural cloning / policy-gradient fine-tuning
     v2  strategic network  20 -> 64 -> 32 -> [intent 4 | turn 3 | lane 3 | assertiveness 3 | value 1]   PPO actor-critic, trained from scratch
   Loaded by traffic-sim-worker.js via importScripts; `node neural-brain.js` runs the self-check. */
(function (G) {
'use strict';
const SIZES = [12, 32, 16, 4];
const SIZES2 = [20, 64, 32, 14], HEADS = [[0, 4], [4, 3], [7, 3], [10, 3]], VAL = 13;      // [offset, size] of each categorical head; index 13 = state value
const FORMAT = { 1: 'traffic-brain-mlp-v1', 2: 'traffic-brain-strategic-v2' };

function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function blank(sizes) { return { sizes: sizes.slice(), W: [], b: [], h: [], cap: 0 }; }
function create(seed = 1, sizes = SIZES) {                    // He initialisation; the v2 output layer starts small so every head begins near uniform
  const r = rng(seed), m = blank(sizes), L = sizes.length - 1;
  for (let l = 0; l < L; l++) {
    const fi = sizes[l], W = new Float32Array(fi * sizes[l + 1]), sc = Math.sqrt(2 / fi) * (l === L - 1 && sizes[0] === SIZES2[0] ? 0.1 : 1);
    for (let i = 0; i < W.length; i++) W[i] = (r() + r() + r() + r() - 2) * 1.73 * sc;
    m.W.push(W); m.b.push(new Float32Array(sizes[l + 1]));
  }
  return m;
}

// Z[n x fo] = act(A[n x fi] . W^T + b)   (W is fo x fi, row-major)
function dense(A, fi, W, b, Z, fo, n, relu) {
  for (let r = 0; r < n; r++) {
    const ao = r * fi, zo = r * fo;
    for (let j = 0; j < fo; j++) {
      let s = b[j]; const wo = j * fi;
      for (let i = 0; i < fi; i++) s += W[wo + i] * A[ao + i];
      Z[zo + j] = relu && s < 0 ? 0 : s;
    }
  }
}
function raw(m, X, n, Z) {                                     // batched forward pass, linear outputs
  const s = m.sizes, L = m.W.length;
  if (m.cap < n) { m.cap = n; for (let l = 0; l < L - 1; l++) m.h[l] = new Float32Array(n * s[l + 1]); }
  let A = X;
  for (let l = 0; l < L; l++) { const Zl = l === L - 1 ? Z : m.h[l]; dense(A, s[l], m.W[l], m.b[l], Zl, s[l + 1], n, l < L - 1); A = Zl; }
  return Z;
}
function softmax(Z, n, stride, off, len) {
  for (let r = 0; r < n; r++) {
    const o = r * stride + off; let mx = Z[o], s = 0;
    for (let j = 1; j < len; j++) if (Z[o + j] > mx) mx = Z[o + j];
    for (let j = 0; j < len; j++) s += (Z[o + j] = Math.exp(Z[o + j] - mx));
    for (let j = 0; j < len; j++) Z[o + j] /= s;
  }
}
// v1: X = n rows of 12 inputs -> P = n rows of 4 intent probabilities
function forward(m, X, n, P) { raw(m, X, n, P); softmax(P, n, 4, 0, 4); return P; }
// v2: X = n rows of 20 inputs -> Z = n rows of 14: probabilities of the four heads, then the state value
function forward2(m, X, n, Z) { raw(m, X, n, Z); for (const [o, k] of HEADS) softmax(Z, n, 14, o, k); return Z; }

function makeOpt(m, lr = 0.004, batch = 128) {
  const z = a => new Float32Array(a.length), s = m.sizes, L = m.W.length;
  return { lr, batch, t: 0, gW: m.W.map(z), gb: m.b.map(z), mW: m.W.map(z), vW: m.W.map(z), mb: m.b.map(z), vb: m.b.map(z),
    X: new Float32Array(batch * s[0]), Y: new Uint8Array(batch), Wt: new Float32Array(batch), P: new Float32Array(batch * s[L]),
    d: m.W.map((_, l) => new Float32Array(batch * s[l + 1])) };                 // d[l]: loss gradient at the output of layer l
}
// gradients of one dense layer; dA (delta for the layer below, masked by its ReLU) is optional
function back(dZ, fo, A, fi, W, gW, gb, dA, B) {
  gW.fill(0); gb.fill(0); if (dA) dA.fill(0, 0, B * fi);
  for (let r = 0; r < B; r++) {
    const ao = r * fi;
    for (let j = 0; j < fo; j++) {
      const d = dZ[r * fo + j]; if (d === 0) continue;
      gb[j] += d; const wo = j * fi;
      for (let i = 0; i < fi; i++) { gW[wo + i] += d * A[ao + i]; if (dA) dA[ao + i] += d * W[wo + i]; }
    }
  }
  if (dA) for (let k = 0; k < B * fi; k++) if (A[k] <= 0) dA[k] = 0;
}
function adam(p, g, m1, m2, lr, t) {
  const c1 = 1 - Math.pow(0.9, t), c2 = 1 - Math.pow(0.999, t);
  for (let i = 0; i < p.length; i++) {
    const gi = g[i]; m1[i] = 0.9 * m1[i] + 0.1 * gi; m2[i] = 0.999 * m2[i] + 0.001 * gi * gi;
    p[i] -= lr * (m1[i] / c1) / (Math.sqrt(m2[i] / c2) + 1e-8);
  }
}
// backpropagate o.d[last] (already filled for B rows whose inputs are in o.X and whose activations are in m.h) and take one Adam step
function step(m, o, B) {
  const s = m.sizes, L = m.W.length;
  for (let l = L - 1; l >= 0; l--) back(o.d[l], s[l + 1], l ? m.h[l - 1] : o.X, s[l], m.W[l], o.gW[l], o.gb[l], l ? o.d[l - 1] : null, B);
  o.t++;
  for (let l = 0; l < L; l++) { adam(m.W[l], o.gW[l], o.mW[l], o.vW[l], o.lr, o.t); adam(m.b[l], o.gb[l], o.mb[l], o.vb[l], o.lr, o.t); }
}
function shuffle(idx, n, rnd) { for (let i = n - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0, t = idx[i]; idx[i] = idx[j]; idx[j] = t; } }

// v1: one epoch of minibatch Adam on weighted cross-entropy. idx[0..n) = training sample indices into X/Y (shuffled in place).
// Weights: per class (cw, behavioural cloning) or per sample (sw, may be negative: advantage-weighted policy gradient).
function trainEpoch(m, o, X, Y, idx, n, cw, rnd, sw) {
  const F = m.sizes[0], K = m.sizes[m.sizes.length - 1], dOut = o.d[o.d.length - 1];
  shuffle(idx, n, rnd); let loss = 0, ok = 0;
  for (let s = 0; s < n; s += o.batch) {
    const B = Math.min(o.batch, n - s);
    for (let r = 0; r < B; r++) { const k = idx[s + r]; o.X.set(X.subarray(k * F, k * F + F), r * F); o.Y[r] = Y[k]; if (sw) o.Wt[r] = sw[k]; }
    forward(m, o.X, B, o.P);
    for (let r = 0; r < B; r++) {
      const y = o.Y[r], w = sw ? o.Wt[r] : cw[y], q = r * K; let am = 0;
      for (let j = 1; j < K; j++) if (o.P[q + j] > o.P[q + am]) am = j;
      if (am === y) ok++;
      loss -= Math.log(Math.max(o.P[q + y], 1e-9)) * w;
      for (let j = 0; j < K; j++) dOut[q + j] = (o.P[q + j] - (j === y ? 1 : 0)) * w / B;
    }
    step(m, o, B);
  }
  return { loss: loss / n, acc: ok / n };
}
// accuracy + per-class recall over idx[from..to)  (v1)
function evaluate(m, X, Y, idx, from, to) {
  const B = 256, F = m.sizes[0], Xb = new Float32Array(B * F), P = new Float32Array(B * 4), hit = [0, 0, 0, 0], tot = [0, 0, 0, 0]; let ok = 0;
  for (let s = from; s < to; s += B) {
    const n = Math.min(B, to - s);
    for (let r = 0; r < n; r++) { const k = idx[s + r]; Xb.set(X.subarray(k * F, k * F + F), r * F); }
    forward(m, Xb, n, P);
    for (let r = 0; r < n; r++) {
      const y = Y[idx[s + r]], q = r * 4; let am = 0;
      for (let j = 1; j < 4; j++) if (P[q + j] > P[q + am]) am = j;
      tot[y]++; if (am === y) { ok++; hit[y]++; }
    }
  }
  return { acc: ok / Math.max(1, to - from), recall: hit.map((h, c) => tot[c] ? h / tot[c] : null) };
}

/* v2: one PPO epoch over a batch D = { X (n x 20), A (n x 4 actions), M (n: 1 if the turn head was actually used), LP (old joint log-prob),
   ADV (normalised advantages), RET (value targets) }. Loss = -clipped surrogate (joint over the heads that acted) + cv * value MSE / 2
   - ce * entropy of every head. Returns the batch statistics. */
function ppoEpoch(m, o, D, idx, n, cfg, rnd) {
  const clip = cfg.clip, cv = cfg.cv, ce = cfg.ce, dOut = o.d[o.d.length - 1];
  shuffle(idx, n, rnd); let pl = 0, vl = 0, ent = 0, clipped = 0;
  for (let s = 0; s < n; s += o.batch) {
    const B = Math.min(o.batch, n - s);
    for (let r = 0; r < B; r++) { const k = idx[s + r]; o.X.set(D.X.subarray(k * 20, k * 20 + 20), r * 20); }
    forward2(m, o.X, B, o.P);
    for (let r = 0; r < B; r++) {
      const k = idx[s + r], q = r * 14, used = D.M[k]; let lp = 0;
      for (let h = 0; h < 4; h++) if (h !== 1 || used) lp += Math.log(Math.max(o.P[q + HEADS[h][0] + D.A[k * 4 + h]], 1e-9));
      const ratio = Math.exp(lp - D.LP[k]), adv = D.ADV[k];
      // clipped surrogate: once the ratio has left the trust region in the direction that helps, the gradient is cut
      const live = adv >= 0 ? ratio <= 1 + clip : ratio >= 1 - clip, g = live ? ratio * adv : 0;
      if (!live) clipped++; pl -= Math.min(ratio * adv, Math.max(1 - clip, Math.min(1 + clip, ratio)) * adv);
      for (let h = 0; h < 4; h++) {
        const off = HEADS[h][0], len = HEADS[h][1], a = D.A[k * 4 + h], acts = h !== 1 || used; let H = 0;
        for (let j = 0; j < len; j++) { const p = o.P[q + off + j]; H -= p * Math.log(Math.max(p, 1e-9)); }
        ent += H;
        for (let j = 0; j < len; j++) {
          const p = o.P[q + off + j];
          dOut[q + off + j] = ((acts ? g * (p - (j === a ? 1 : 0)) : 0) + ce * p * (Math.log(Math.max(p, 1e-9)) + H)) / B;
        }
      }
      const dv = o.P[q + VAL] - D.RET[k]; vl += dv * dv; dOut[q + VAL] = cv * dv / B;
    }
    step(m, o, B);
  }
  return { policyLoss: pl / n, valueLoss: vl / n, entropy: ent / n / 4, clipFrac: clipped / n };
}

function serialize(m, extra) {
  const version = m.sizes[0] === SIZES2[0] ? 2 : 1;
  return Object.assign({ format: FORMAT[version], version, layers: m.sizes.slice(),
    activations: version === 2 ? ['relu', 'relu', 'softmax x4 + linear value'] : ['relu', 'relu', 'softmax'],
    heads: version === 2 ? { intent: [0, 4], turn: [4, 3], lane: [7, 3], assertiveness: [10, 3], value: [13, 1] } : { intent: [0, 4] },
    weights: m.W.map(w => Array.from(w, x => +x.toFixed(5))), biases: m.b.map(b => Array.from(b, x => +x.toFixed(5))) }, extra);
}
// Trust boundary: imported files are validated (version, layer shapes, sizes, finite numbers) before any weight reaches the simulation.
function deserialize(o) {
  if (!o || typeof o !== 'object') throw new Error('not a model file');
  const version = o.version !== undefined ? o.version : o.format === FORMAT[2] ? 2 : 1;      // files from before the version field are v1
  if (version !== 1 && version !== 2) throw new Error('unsupported model version ' + o.version);
  if (o.format !== undefined && o.format !== FORMAT[version]) throw new Error('format "' + o.format + '" does not match version ' + version);
  const sizes = version === 2 ? SIZES2 : SIZES;
  if (!Array.isArray(o.layers) || o.layers.join() !== sizes.join()) throw new Error('layer shapes must be ' + sizes.join('-') + ' for version ' + version);
  if (!Array.isArray(o.weights) || !Array.isArray(o.biases) || o.weights.length !== 3 || o.biases.length !== 3) throw new Error('weights/biases missing');
  const m = blank(sizes);
  for (let l = 0; l < 3; l++) {
    const w = o.weights[l], b = o.biases[l];
    if (!Array.isArray(w) || w.length !== sizes[l] * sizes[l + 1] || !Array.isArray(b) || b.length !== sizes[l + 1]) throw new Error('layer ' + l + ' has the wrong size');
    if (!w.every(Number.isFinite) || !b.every(Number.isFinite)) throw new Error('layer ' + l + ' contains non-numeric values');
    m.W.push(Float32Array.from(w)); m.b.push(Float32Array.from(b));
  }
  return m;
}

G.Brain = { SIZES, SIZES2, HEADS, VAL, rng, create, forward, forward2, makeOpt, trainEpoch, evaluate, ppoEpoch, serialize, deserialize };

/* ------------------------------------------------ self-check: node neural-brain.js ------------------------------------------------ */
if (typeof module !== 'undefined' && typeof require !== 'undefined' && require.main === module) {
  const fails = [], check = (ok, what) => { if (!ok) { fails.push(what); console.error('FAIL:', what); } };
  // 1. v1 cross-entropy: learn a synthetic 4-way rule, then round-trip the weights
  const r = rng(42), N = 6000, X = new Float32Array(N * 12), Y = new Uint8Array(N), idx = Int32Array.from({ length: N }, (_, i) => i);
  for (let i = 0; i < N; i++) { for (let k = 0; k < 12; k++) X[i * 12 + k] = r() * 2 - 1; const x = X.subarray(i * 12, i * 12 + 12); Y[i] = x[5] > 0.3 ? (x[4] < 0 ? 1 : 0) : x[11] > 0.4 ? 3 : x[2] > 0.5 ? 2 : 0; }
  const m = create(3), o = makeOpt(m), nTr = 5000; let e;
  for (let ep = 0; ep < 60; ep++) e = trainEpoch(m, o, X, Y, idx, nTr, [1, 1, 1, 1], r);
  const val = evaluate(m, X, Y, idx, nTr, N), s1 = serialize(m), m1 = deserialize(JSON.parse(JSON.stringify(s1)));
  const P1 = forward(m, X, 8, new Float32Array(32)).slice(), P2 = forward(m1, X, 8, new Float32Array(32));
  const drift = Math.max(...P1.map((p, i) => Math.abs(p - P2[i])));
  console.log('v1  train acc', e.acc.toFixed(3), 'val acc', val.acc.toFixed(3), 'round-trip drift', drift.toExponential(1));
  check(val.acc > 0.93, 'v1 failed to learn the synthetic rule');
  check(drift < 1e-3 && s1.version === 1, 'v1 serialisation round-trip');
  // 2. v1 advantage-weighted update: a bandit where only action 2 pays
  const pb = create(5), ob = makeOpt(pb, 0.01, 64), M = 512, XB = X.subarray(0, M * 12), AB = new Uint8Array(M), WB = new Float32Array(M), ib = Int32Array.from({ length: M }, (_, i) => i), PB = new Float32Array(M * 4);
  for (let u = 0; u < 30; u++) { forward(pb, XB, M, PB); for (let i = 0; i < M; i++) { let a = 0, c = r(); while (a < 3 && (c -= PB[i * 4 + a]) > 0) a++; AB[i] = a; WB[i] = (a === 2 ? 1 : 0) - 0.25; } trainEpoch(pb, ob, XB, AB, ib, M, null, r, WB); }
  forward(pb, XB, M, PB); let p2 = 0; for (let i = 0; i < M; i++) p2 += PB[i * 4 + 2] / M;
  console.log('v1  bandit P(action 2) ->', p2.toFixed(2));
  check(p2 > 0.8, 'v1 advantage-weighted update');
  // 3. v2 PPO, multi-head + value: contextual bandit. Reward = [intent==2] + [turn==0, only when the turn head is used]
  //    + [lane == (x0>0 ? 0 : 2)] (state-dependent) ; assertiveness is irrelevant. The value head must learn the expected reward.
  const n2 = 2048, X2 = new Float32Array(n2 * 20), D = { X: X2, A: new Uint8Array(n2 * 4), M: new Uint8Array(n2), LP: new Float32Array(n2), ADV: new Float32Array(n2), RET: new Float32Array(n2) };
  const m2 = create(9, SIZES2), o2 = makeOpt(m2, 3e-3, 256), Z = new Float32Array(n2 * 14), i2 = Int32Array.from({ length: n2 }, (_, i) => i);
  const sample = (q, off, len) => { let a = 0, c = r(); while (a < len - 1 && (c -= Z[q + off + a]) > 0) a++; return a; };
  let stats, vErr0 = 0, vErr = 0, meanR = 0;
  for (let it = 0; it < 60; it++) {
    for (let i = 0; i < n2 * 20; i++) X2[i] = r() * 2 - 1;
    forward2(m2, X2, n2, Z); let sum = 0, sq = 0; vErr = 0;
    for (let i = 0; i < n2; i++) {
      const q = i * 14, used = r() < 0.5 ? 1 : 0; let lp = 0, rew = 0; D.M[i] = used;
      for (let h = 0; h < 4; h++) { const a = sample(q, HEADS[h][0], HEADS[h][1]); D.A[i * 4 + h] = a; if (h !== 1 || used) lp += Math.log(Math.max(Z[q + HEADS[h][0] + a], 1e-9)); }
      rew += D.A[i * 4] === 2 ? 1 : 0; if (used) rew += D.A[i * 4 + 1] === 0 ? 1 : 0; rew += D.A[i * 4 + 2] === (X2[i * 20] > 0 ? 0 : 2) ? 1 : 0;
      D.LP[i] = lp; D.RET[i] = rew; D.ADV[i] = rew - Z[q + VAL]; sum += D.ADV[i]; sq += D.ADV[i] * D.ADV[i]; vErr += (rew - Z[q + VAL]) ** 2 / n2; meanR += it === 59 ? rew / n2 : 0;
    }
    if (it === 0) vErr0 = vErr;
    const mu = sum / n2, sd = Math.sqrt(sq / n2 - mu * mu) + 1e-6; for (let i = 0; i < n2; i++) D.ADV[i] = (D.ADV[i] - mu) / sd;
    for (let ep = 0; ep < 4; ep++) stats = ppoEpoch(m2, o2, D, i2, n2, { clip: 0.2, cv: 0.5, ce: 0.01 }, r);
  }
  forward2(m2, X2, n2, Z); let pI = 0, pT = 0, pL = 0, pA = 0;
  for (let i = 0; i < n2; i++) { const q = i * 14; pI += Z[q + 2] / n2; pT += Z[q + 4] / n2; pL += Z[q + 7 + (X2[i * 20] > 0 ? 0 : 2)] / n2; pA += Math.max(Z[q + 10], Z[q + 11], Z[q + 12]) / n2; }
  console.log('v2  PPO: P(intent=2)', pI.toFixed(2), ' P(turn=0)', pT.toFixed(2), ' P(lane=state-dependent target)', pL.toFixed(2), ' assertiveness max-prob', pA.toFixed(2),
    ' value MSE', vErr0.toFixed(2), '->', vErr.toFixed(2), ' mean reward', meanR.toFixed(2), '/ 2.5  entropy', stats.entropy.toFixed(2));
  check(pI > 0.8, 'v2 intent head did not learn the rewarded action');
  check(pT > 0.8, 'v2 masked turn head did not learn from the steps where it acted');
  check(pL > 0.8, 'v2 lane head did not learn the state-dependent action');
  check(vErr < vErr0 * 0.5 && vErr < 0.6, 'v2 value head did not learn the expected reward');
  // 4. versioned serialisation: v2 round-trip, and rejection of wrong shapes / versions / values
  const s2 = serialize(m2), m2b = deserialize(JSON.parse(JSON.stringify(s2))), Za = forward2(m2, X2, 4, new Float32Array(56)).slice(), Zb = forward2(m2b, X2, 4, new Float32Array(56));
  check(s2.version === 2 && s2.layers.join() === '20,64,32,14' && Math.max(...Za.map((p, i) => Math.abs(p - Zb[i]))) < 1e-3, 'v2 serialisation round-trip');
  const rejects = bad => { try { deserialize(bad); return false; } catch (x) { return true; } };
  check(rejects({ layers: [12, 8, 4], weights: [], biases: [] }), 'accepted a wrong topology');
  check(rejects(Object.assign({}, s2, { version: 1, format: undefined })), 'accepted v2 weights labelled as version 1');
  check(rejects(Object.assign({}, s1, { version: 2, format: undefined })), 'accepted v1 weights labelled as version 2');
  check(rejects(Object.assign({}, s2, { version: 3 })), 'accepted an unknown version');
  check(rejects(Object.assign({}, s2, { weights: [s2.weights[0], s2.weights[1], s2.weights[2].map((x, i) => i === 3 ? 'x' : x)] })), 'accepted non-numeric weights');
  console.log(fails.length ? fails.length + ' check(s) FAILED' : 'all checks passed');
  if (fails.length) process.exit(1);
}
})(typeof self !== 'undefined' ? self : globalThis);
