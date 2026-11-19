// Token Radar 01 v3 — Size Curve + Launch Odds
// Reads a frozen DefiLlama snapshot, fits a log-log size curve on traded
// comps, prices launch odds with a piecewise-constant hazard, and ranks
// 198 pre-token protocols by expected value. Node 22+, stdlib only,
// fully deterministic: no clock, no Math.random in outputs.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";

const REF_DATE = "2026-11-14";
const REF_DAYS = daysFromEpoch(2026, 11, 14);
const FLOOR_USD = 50000000;
const DISCOUNT = 0.85;
const MULT_LO = 0.08;
const MULT_HI = 1.2;
const SHRINK = 8; // category-offset pseudo-observations: ablation reference (k=8).
// Final value model (variant no-age, 19 Nov): NO age term, NO category offsets —
// both failed the 3-leg guard; see ablation() and NOTES-v3 "Varian no-age".
const USE_AGE = false;
const USE_OFFSETS = false;
const GROWTH_W = 0; // growth weight: guard chose 0 (0.3 improved only LOO, worsened TS+WF)
const SPLIT_SEED = 20261114;
const BOOT_SEED = 20261119;
const N_BOOT = 200;
const HORIZON_DAYS = 730;
const SHARE = 0.000025; // 0.0025%
const GAS_USD = 14;
const DEPOSIT_REF = 200;
const TBILL_REF = 0.04;
const FARM_DAYS = 90;
const WORK_MIN = 80;
const REVIEW_DATE = "2027-02-12"; // REF_DATE + 90 days

type Proto = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl: number; chg: number | null; mcap: number | null;
  listed: string | null; gecko: string | null; symbol: string | null;
  age: number | null; tokened: boolean;
};

function daysFromEpoch(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
function parseAge(listed: string | null): number | null {
  if (!listed) return null;
  const [y, m, d] = listed.split("-").map(Number);
  return Math.max(0, REF_DAYS - daysFromEpoch(y, m, d));
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function geoMean(xs: number[]): number { return Math.exp(mean(xs.map(Math.log))); }
function pstdev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))));
}
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }
function fm(pred: number, actual: number): number { return Math.max(pred, actual) / Math.min(pred, actual); }
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fmtUsd(x: number): string {
  return "$" + Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function fmtPct(x: number): string { return (x >= 0 ? "+" : "") + x.toFixed(1) + "%"; }

// ---------- snapshot ----------
function loadSnapshot(inputPath: string): { protocols: Proto[]; watchlist: string[] } {
  const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const protocols: Proto[] = raw.protocols.map((p: any) => ({
    slug: p.slug, name: p.name, category: p.category ?? null,
    chains: [...p.chains], tvl: p.tvl_usd,
    chg: p.change_7d ?? null, mcap: p.mcap_usd ?? null,
    listed: p.listed_at ?? null, gecko: p.gecko_id ?? null, symbol: p.symbol ?? null,
    age: parseAge(p.listed_at ?? null),
    tokened: Boolean(p.gecko_id || p.symbol),
  }));
  protocols.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return { protocols, watchlist: [...raw.watchlist].sort() };
}

// ---------- comps ----------
function selectComps(protocols: Proto[]): Proto[] {
  const byKey = new Map<string, Proto>();
  for (const p of protocols) {
    if (!p.mcap || p.mcap <= 0 || p.tvl <= 0) continue;
    const key = p.gecko || p.symbol || p.slug;
    const cur = byKey.get(key);
    if (!cur || p.tvl > cur.tvl) byKey.set(key, p);
  }
  const out: Proto[] = [];
  for (const p of byKey.values()) {
    const r = (p.mcap as number) / p.tvl;
    if (r >= 0.02 && r <= 20) out.push(p);
  }
  out.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return out;
}

// ---------- value model: OLS log-log + shrunk category offsets ----------
type ValueModel = {
  beta: number[]; offsets: Map<string, number>; medAge: number;
  useAge: boolean; useChain: boolean; shrink: number;
  predLog: (p: Proto) => number;
};
function fitValue(rows: Proto[], useAge: boolean, useChain: boolean, shrink: number, useOffsets: boolean): ValueModel {
  const medAge = median(rows.filter((p) => p.age !== null).map((p) => p.age as number));
  const feats = (p: Proto): number[] => {
    const a = p.age !== null ? p.age : medAge;
    const f = [1, Math.log(p.tvl)];
    if (useAge) f.push(Math.log(Math.max(1, a)));
    if (useChain) f.push(Math.log(Math.max(1, p.chains.length)));
    return f;
  };
  const X = rows.map(feats);
  const y = rows.map((p) => Math.log(p.mcap as number));
  const k = X[0].length;
  const A: number[][] = [];
  for (let i = 0; i < k; i++) {
    A.push([]);
    for (let j = 0; j < k; j++) {
      let s = 0;
      for (let r = 0; r < X.length; r++) s += X[r][i] * X[r][j];
      A[i].push(s);
    }
    A[i][i] += 1e-9; // numerical ridge, negligible
  }
  const b = Array.from({ length: k }, (_, i) => {
    let s = 0;
    for (let r = 0; r < X.length; r++) s += X[r][i] * y[r];
    return s;
  });
  // Gaussian elimination with partial pivoting
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= k; j++) M[r][j] -= f * M[c][j];
    }
  }
  const beta = M.map((row, i) => row[k] / row[i]);
  const resid = new Map<string, number[]>();
  for (const p of rows) {
    const f = feats(p);
    let pred = 0;
    for (let i = 0; i < k; i++) pred += beta[i] * f[i];
    const key = p.category ?? "";
    if (!resid.has(key)) resid.set(key, []);
    resid.get(key)?.push(Math.log(p.mcap as number) - pred);
  }
  const offsets = new Map<string, number>();
  if (useOffsets) {
    for (const [cat, rs] of [...resid.entries()].sort()) {
      offsets.set(cat, (rs.length * mean(rs)) / (rs.length + shrink));
    }
  }
  const predLog = (p: Proto): number => {
    const f = feats(p);
    let s = 0;
    for (let i = 0; i < k; i++) s += beta[i] * f[i];
    return s + (offsets.get(p.category ?? "") ?? 0);
  };
  return { beta, offsets, medAge, useAge, useChain, shrink, predLog };
}
function growthMult(p: Proto, w: number): number {
  const c = clamp(p.chg ?? 0, -60, 120);
  return 1 + (w * c) / 100;
}
function condValue(p: Proto, m: ValueModel, w: number): { cond: number; mult: number } {
  const mult = clamp(Math.exp(m.predLog(p)) / p.tvl, MULT_LO, MULT_HI);
  return { cond: p.tvl * mult * growthMult(p, w) * DISCOUNT, mult };
}
function fmSummary(vals: number[]): { geo: number; med: number; le2: number; le3: number } {
  const s = [...vals].sort((a, b) => a - b);
  return {
    geo: geoMean(vals), med: median(vals),
    le2: vals.filter((v) => v <= 2).length / vals.length,
    le3: vals.filter((v) => v <= 3).length / vals.length,
  };
}

// ---------- validation legs (factor-miss, geometric mean is the headline) ----------
type Leg = { geo: number; med: number; le2: number; le3: number };
const CUT_DAYS = daysFromEpoch(2024, 2, 6);
function listedDays(p: Proto): number { return daysFromEpoch(...(p.listed as string).split("-").map(Number) as [number, number, number]); }

function looLeg(rows: Proto[], w: number, useAge: boolean, useChain: boolean, shrink: number, useOffsets: boolean): { full: Leg; raw: Leg } {
  const full: number[] = []; const raw: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const rest = rows.filter((_, j) => j !== i);
    const m = fitValue(rest, useAge, useChain, shrink, useOffsets);
    const { cond, mult } = condValue(rows[i], m, w);
    full.push(fm(cond, rows[i].mcap as number));
    raw.push(fm(rows[i].tvl * mult, rows[i].mcap as number));
  }
  return { full: fmSummary(full), raw: fmSummary(raw) };
}
function timeSplitLeg(rows: Proto[], w: number, useAge: boolean, useChain: boolean, shrink: number, useOffsets: boolean): { nTrain: number; nTest: number; full: Leg; raw: Leg } {
  const dated = rows.filter((p) => p.age !== null);
  const tr = dated.filter((p) => listedDays(p) < CUT_DAYS);
  const te = dated.filter((p) => listedDays(p) >= CUT_DAYS);
  const m = fitValue(tr, useAge, useChain, shrink, useOffsets);
  const full: number[] = []; const raw: number[] = [];
  for (const p of te) {
    const { cond, mult } = condValue(p, m, w);
    full.push(fm(cond, p.mcap as number));
    raw.push(fm(p.tvl * mult, p.mcap as number));
  }
  return { nTrain: tr.length, nTest: te.length, full: fmSummary(full), raw: fmSummary(raw) };
}
function walkForwardLeg(rows: Proto[], w: number, useAge: boolean, useChain: boolean, shrink: number, rolling: boolean, useOffsets: boolean): { full: Leg; raw: Leg } {
  const dated = rows.filter((p) => p.age !== null)
    .sort((a, b) => (a.listed as string) < (b.listed as string) ? -1 : (a.listed as string) > (b.listed as string) ? 1 : (a.slug < b.slug ? -1 : 1));
  const full: number[] = []; const raw: number[] = [];
  for (const start of [40, 50, 60]) {
    const test = dated.slice(start, start + 10);
    let train = rolling ? dated.slice(Math.max(0, start - 40), start) : dated.slice(0, start);
    train = train.slice(0, train.length - 2); // 2-comp embargo
    const m = fitValue(train, useAge, useChain, shrink, useOffsets);
    for (const p of test) {
      const { cond, mult } = condValue(p, m, w);
      full.push(fm(cond, p.mcap as number));
      raw.push(fm(p.tvl * mult, p.mcap as number));
    }
  }
  return { full: fmSummary(full), raw: fmSummary(raw) };
}
function baselineLegs(rows: Proto[]): {
  flat: { loo: Leg; ts: Leg; wf: Leg }; med: { loo: Leg; ts: Leg; wf: Leg };
} {
  const flatLoo: number[] = []; const medLoo: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    flatLoo.push(fm(p.tvl, p.mcap as number));
    const rest = rows.filter((_, j) => j !== i);
    medLoo.push(fm(p.tvl * median(rest.map((q) => (q.mcap as number) / q.tvl)), p.mcap as number));
  }
  const dated = rows.filter((p) => p.age !== null);
  const tr = dated.filter((p) => listedDays(p) < CUT_DAYS);
  const te = dated.filter((p) => listedDays(p) >= CUT_DAYS);
  const medTr = median(tr.map((q) => (q.mcap as number) / q.tvl));
  const flatTs = te.map((p) => fm(p.tvl, p.mcap as number));
  const medTs = te.map((p) => fm(p.tvl * medTr, p.mcap as number));
  const sorted = [...dated].sort((a, b) => (a.listed as string) < (b.listed as string) ? -1 : (a.listed as string) > (b.listed as string) ? 1 : (a.slug < b.slug ? -1 : 1));
  const flatWf: number[] = []; const medWf: number[] = [];
  for (const start of [40, 50, 60]) {
    const test = sorted.slice(start, start + 10);
    const train = sorted.slice(0, start).slice(0, start - 2);
    const mm = median(train.map((q) => (q.mcap as number) / q.tvl));
    for (const p of test) {
      flatWf.push(fm(p.tvl, p.mcap as number));
      medWf.push(fm(p.tvl * mm, p.mcap as number));
    }
  }
  return {
    flat: { loo: fmSummary(flatLoo), ts: fmSummary(flatTs), wf: fmSummary(flatWf) },
    med: { loo: fmSummary(medLoo), ts: fmSummary(medTs), wf: fmSummary(medWf) },
  };
}
type AblRow = { label: string; loo: number; ts: number; wf: number; note: string };
function ablation(comps: Proto[]): AblRow[] {
  const rows: AblRow[] = [];
  const run = (label: string, w: number, useAge: boolean, useChain: boolean, shrink: number, useOffsets: boolean, note: string) => {
    const l = looLeg(comps, w, useAge, useChain, shrink, useOffsets);
    const t = timeSplitLeg(comps, w, useAge, useChain, shrink, useOffsets);
    const wf = walkForwardLeg(comps, w, useAge, useChain, shrink, false, useOffsets);
    rows.push({ label, loo: l.full.geo, ts: t.full.geo, wf: wf.full.geo, note });
  };
  run("Final: no age, no offsets (logTVL only, w=0)", 0, false, false, 8, false, "CHOSEN — lowest 3-leg mean (3.281)");
  run("No age + offsets k=8 (variant A)", 0, false, false, 8, true, "beats full on all 3 legs; loses to final on LOO+TS and on mean");
  run("Full model (logTVL + logAge + offsets k=8, w=0)", 0, true, false, 8, true, "structural reference; loses to no-age on all 3 legs");
  run("No category offsets (with age)", 0, true, false, 8, false, "beats full on LOO+TS, loses WF");
  run("Growth w=0 (chosen)", 0, false, false, 8, false, "CHOSEN");
  run("Growth w=0.3 (on final basis)", 0.3, false, false, 8, false, "LOO unchanged, worsens TS+WF — rejected");
  run("Growth w=0.6 (on final basis)", 0.6, false, false, 8, false, "worsens TS+WF — rejected");
  run("Without log chains", 0, false, false, 8, false, "CHOSEN (baseline row)");
  run("With log chains (on final basis)", 0, false, true, 8, false, "worsens all 3 legs — rejected");
  run("Shrink k=4 (no-age, with offsets)", 0, false, false, 4, true, "best WF of the k-sweep, worst LOO/TS");
  run("Shrink k=16 (no-age, with offsets)", 0, false, false, 16, true, "best LOO/TS of the k-sweep, worst WF; mean 3.298");
  const bl = baselineLegs(comps);
  rows.push({ label: "Baseline: flat TVL multiple (pred = TVL)", loo: bl.flat.loo.geo, ts: bl.flat.ts.geo, wf: bl.flat.wf.geo, note: "model beats it on all 3 legs" });
  rows.push({ label: "Baseline: median multiple (train median mcap/TVL)", loo: bl.med.loo.geo, ts: bl.med.ts.geo, wf: bl.med.wf.geo, note: "model beats it on all 3 legs" });
  return rows;
}

// ---------- launch odds: piecewise-constant hazard, current-status MLE ----------
const HAZ_BINS: [number, number][] = [[0, 180], [181, 365], [366, 730], [731, 1095], [1096, 1460], [1461, 1e9]];
function exposure(ageDays: number): number[] {
  return HAZ_BINS.map(([lo, hi]) => {
    const ov = ageDays >= lo ? Math.max(0, Math.min(ageDays, hi) - lo + 1) : 0;
    return ov / 365;
  });
}
function survFromExp(exp: number[], lam: number[]): number {
  let s = 0;
  for (let i = 0; i < 6; i++) s += lam[i] * exp[i];
  return Math.exp(-s);
}
function fitHazard(rows: Proto[]): { lam: number[]; sweeps: number } {
  const exps = rows.map((p) => exposure(p.age as number));
  const tok = rows.map((p) => (p.tokened ? 1 : 0));
  const totExp = exps.reduce((a, e) => a + e.reduce((x, y) => x + y, 0), 0);
  const g = tok.reduce((a, b) => a + b, 0) / totExp;
  const lam = Array(6).fill(clamp(g, 0.05, 8));
  const loglik = (lv: number[]): number => {
    let ll = 0;
    for (let i = 0; i < rows.length; i++) {
      const s = clamp(survFromExp(exps[i], lv), 1e-12, 1 - 1e-12);
      ll += tok[i] ? Math.log(1 - s) : Math.log(s);
    }
    return ll;
  };
  const LO = 0.05, HI = 8;
  const GR = (Math.sqrt(5) - 1) / 2;
  let sweeps = 0;
  for (let sweep = 0; sweep < 200; sweep++) {
    sweeps = sweep + 1;
    let maxChg = 0;
    for (let b = 0; b < 6; b++) {
      const f = (x: number): number => { const t = [...lam]; t[b] = x; return loglik(t); };
      let a = LO, bb = HI;
      let c = bb - GR * (bb - a), d = a + GR * (bb - a);
      let fc = f(c), fd = f(d);
      for (let it = 0; it < 60; it++) {
        if (fc > fd) { bb = d; d = c; fd = fc; c = bb - GR * (bb - a); fc = f(c); }
        else { a = c; c = d; fc = fd; d = a + GR * (bb - a); fd = f(d); }
      }
      const x = (a + bb) / 2;
      maxChg = Math.max(maxChg, Math.abs(x - lam[b]));
      lam[b] = x;
    }
    if (maxChg < 1e-9) break;
  }
  return { lam, sweeps };
}
function catMultipliers(rows: Proto[]): { global: number; mult: Map<string, number> } {
  const global = rows.filter((p) => p.tokened).length / rows.length;
  const byCat = new Map<string, { t: number; n: number }>();
  for (const p of rows) {
    const key = p.category ?? "";
    const cur = byCat.get(key) ?? { t: 0, n: 0 };
    cur.t += p.tokened ? 1 : 0; cur.n += 1;
    byCat.set(key, cur);
  }
  const mult = new Map<string, number>();
  for (const [cat, { t, n }] of [...byCat.entries()].sort()) {
    mult.set(cat, ((t + 10 * global) / (n + 10)) / global);
  }
  return { global, mult };
}
function probTokenedByAge(ageDays: number, cat: string | null, lam: number[], mult: Map<string, number>): number {
  const m = mult.get(cat ?? "") ?? 1;
  const lv = lam.map((x) => x * m);
  return 1 - survFromExp(exposure(ageDays), lv);
}
function condLaunchProb(p: Proto, lam: number[], mult: Map<string, number>, medPreAge: number): number {
  const m = mult.get(p.category ?? "") ?? 1;
  const lv = lam.map((x) => x * m);
  const a = p.age !== null ? p.age : medPreAge;
  const sNow = survFromExp(exposure(a), lv);
  const sFut = survFromExp(exposure(a + HORIZON_DAYS), lv);
  return clamp(1 - sFut / sNow, 0.01, 0.98);
}
function hazardValidation(dated: Proto[]): {
  hit: number; brier: number; base: number; nTrain: number; nTest: number;
  everHit: number; everBrier: number; lamTrain: number[];
} {
  const idx = dated.map((_, i) => i);
  const rnd = mulberry32(SPLIT_SEED);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const nTest = Math.floor(0.3 * dated.length);
  const test = idx.slice(0, nTest).map((i) => dated[i]);
  const train = idx.slice(nTest).map((i) => dated[i]);
  const { lam } = fitHazard(train);
  const { global, mult } = catMultipliers(train);
  const preds = test.map((p) => probTokenedByAge(p.age as number, p.category, lam, mult));
  const act = test.map((p) => (p.tokened ? 1 : 0));
  const hit = preds.filter((pr, i) => (pr > 0.5) === Boolean(act[i])).length / test.length;
  const brier = mean(preds.map((pr, i) => (pr - act[i]) * (pr - act[i])));
  const base = mean(act);
  // Ever-rate comparator: shrunk category ever-rate x age-bin factor (bin tokened share / global), clamped
  const binTot = [0, 0, 0, 0, 0, 0], binTok = [0, 0, 0, 0, 0, 0];
  for (const p of train) {
    const b = HAZ_BINS.findIndex(([lo, hi]) => (p.age as number) >= lo && (p.age as number) <= hi);
    binTot[b] += 1; binTok[b] += p.tokened ? 1 : 0;
  }
  const binF = binTot.map((n, b) => (n ? (binTok[b] / n) / global : 1));
  const everPreds = test.map((p) => {
    const b = HAZ_BINS.findIndex(([lo, hi]) => (p.age as number) >= lo && (p.age as number) <= hi);
    const m = mult.get(p.category ?? "") ?? 1;
    const shrunkCat = m * global;
    return clamp(shrunkCat * binF[b], 0.01, 0.98);
  });
  const everHit = everPreds.filter((pr, i) => (pr > 0.5) === Boolean(act[i])).length / test.length;
  const everBrier = mean(everPreds.map((pr, i) => (pr - act[i]) * (pr - act[i])));
  return { hit, brier, base, nTrain: train.length, nTest: test.length, everHit, everBrier, lamTrain: lam };
}

// ---------- ledger ----------
const FORBIDDEN = new Set(["CEX", "Bridge", "Canonical Bridge", "Liquid Staking", "Liquid Restaking", "Restaked BTC"]);
const VER_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAP_RE = /\b(wrapped|staked|staking)\b/i;
const EXCHANGES = ["Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini"];
type Group = "tokened" | "forbidden" | "versioned" | "wrapped" | "exchange" | "watchlist" | "abovefloor" | "belowfloor";
function groupOf(p: Proto, watch: Set<string>): Group {
  if (p.tokened) return "tokened";
  if (p.category !== null && FORBIDDEN.has(p.category)) return "forbidden";
  if (VER_RE.test(p.name)) return "versioned";
  if (WRAP_RE.test(p.name)) return "wrapped";
  if (EXCHANGES.some((e) => p.name.startsWith(e))) return "exchange";
  if (watch.has(p.slug)) return "watchlist";
  if (p.tvl >= FLOOR_USD) return "abovefloor";
  return "belowfloor";
}

// ---------- farm plans ----------
const CAT_ACTION: Record<string, [string, string]> = {
  "Dexs": ["tukar $200 menjadi aset pool lalu sediakan likuiditas di pool utama", "lakukan satu swap kecil di pool yang sama untuk menjaga aktivitas"],
  "Lending": ["deposit $200 sebagai collateral lalu pinjam aset kecil senilai $50", "setorkan atau tarik $20 collateral agar posisi tetap aktif"],
  "Yield": ["deposit $200 ke vault yield utama dan biarkan bunga berjalan", "klaim dan tanam ulang (re-stake) reward kecil yang masuk"],
  "Yield Aggregator": ["deposit $200 ke vault agregator utama", "pindahkan $20 antar-strategi vault untuk mencatat aktivitas"],
  "Derivatives": ["buka posisi kecil $200 di pasar perps utama dengan leverage 1x", "tutup dan buka ulang posisi kecil $20 untuk mencatat aktivitas"],
  "RWA": ["beli atau mint aset RWA senilai $200 dari penawaran utama", "periksa laporan aset dasar dan catat nilainya"],
  "CDP": ["kunci $200 collateral lalu mint stablecoin senilai $100", "sesuaikan collateral $20 untuk menjaga rasio tetap sehat"],
  "Basis Trading": ["deposit $200 ke strategi basis (spot + short) utama", "periksa funding dan catat selisih basis minggu ini"],
  "Risk Curators": ["deposit $200 ke vault kurator dengan profil risiko moderat", "tinjau ulang alokasi kurator dan catat perubahannya"],
  "Onchain Capital Allocator": ["alokasikan $200 ke strategi utama yang dikelola allocator", "tinjau laporan alokasi dan catat pergeseran dananya"],
  "Chain": ["bridge $200 ke jaringan utama lalu pakai dApp flagship-nya", "lakukan satu transaksi kecil di dApp flagship jaringan itu"],
  "Staking Pool": ["stake $200 di pool staking utama", "klaim reward staking kecil dan tanam ulang"],
  "Liquidity Manager": ["deposit $200 ke vault manajemen likuiditas aktif", "tinjau ulang rentang likuiditas dan catat penyesuaiannya"],
  "Leveraged Farming": ["buka posisi farming $200 dengan leverage rendah (1,5x)", "sesuaikan posisi $20 agar rasio leverage tetap rendah"],
  "Restaking": ["restake $200 aset ke operator utama", "periksa status operator dan catat imbalannya"],
  "Prediction Market": ["pasang posisi $200 di pasar prediksi paling likuid", "tutup atau tambah posisi kecil $20 di pasar yang sama"],
  "Stablecoin Wrapper": ["bungkus (wrap) $200 stablecoin ke versi protokol", "periksa peg dan catat selisihnya"],
  "Farm": ["deposit $200 ke farm utama dan mulai panen reward", "panen reward kecil dan tanam ulang ke farm yang sama"],
  "Insurance": ["beli cover $200 untuk posisi di protokol terkait", "periksa status cover dan catat masa berlakunya"],
  "Payments": ["lakukan pembayaran $200 lewat rel pembayaran utama", "lakukan satu pembayaran kecil $20 untuk menjaga aktivitas"],
  "Indexes": ["beli $200 token indeks utama", "rebalance $20 mengikuti komposisi indeks terbaru"],
  "CeDeFi": ["deposit $200 ke produk CeDeFi utama", "periksa laporan kustodian dan catat imbalannya"],
};
function catAction(cat: string | null): [string, string] {
  if (cat && CAT_ACTION[cat]) return CAT_ACTION[cat];
  return ["gunakan fitur utama dengan modal $200 dan catat setiap langkah", "ulangi satu aksi kecil di fitur utama untuk menjaga aktivitas"];
}
function money(x: number): string { return "$" + Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function farmSteps(p: Proto): string[] {
  const chain = p.chains[0] ?? "Ethereum";
  const [main, touch] = catAction(p.category);
  const threshold = money(p.tvl * 0.5);
  const steps = [
    `Hari 1 (15 mnt, $0): Siapkan dompet segar khusus ${p.name} di ${chain}; simpan seed offline, jangan campur dengan dompet utama.`,
    `Hari 1 (10 mnt, gas $4, 2 tx): Di ${p.name} (${chain}), ${main}; approve lalu deposit dalam satu sesi, simpan hash kedua transaksi.`,
    `Minggu 2 (10 mnt, gas $2, 1 tx): ${capFirst(touch)}; catat tanggal, hash, dan saldo posisi setelah aksi.`,
    `Minggu 4 (10 mnt, gas $2, 1 tx): ${capFirst(touch)}; bandingkan TVL ${p.name} dengan posisi awal Anda.`,
    `Minggu 6 (10 mnt, gas $2, 1 tx): ${capFirst(touch)}; pastikan posisi masih di atas ambang stop ${threshold} TVL.`,
    `Minggu 8 (10 mnt, gas $2, 1 tx): ${capFirst(touch)}; periksa halaman poin ${p.name} sebelum menarik dana apa pun.`,
    `Hari 90 (10 mnt, gas $2, 1 tx): Klaim reward/poin ${p.name} bila tersedia, lalu tarik dana pokok bila token belum meluncur.`,
    `Hari 90 (5 mnt, $0): Catat dompet, tanggal, dan semua hash transaksi. STOP lebih awal bila TVL jatuh di bawah ${threshold}; KELUAR setelah token meluncur atau musim berakhir; tinjau ulang ${REVIEW_DATE}.`,
  ];
  for (const s of steps) {
    if (s.length < 20 || s.length > 600) throw new Error(`farm step length ${s.length} for ${p.slug}: ${s}`);
  }
  return steps;
}
function capFirst(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------- board build ----------
type BoardRow = {
  p: Proto; cond: number; mult: number; prob: number; ev: number; evInt: number;
  bandLo: number; bandHi: number; rankLo: number; rankHi: number;
  sliceFloor: number; net: number; netHr: number; breakeven: number; verdict: number;
  off: number; ageImp: boolean; near: number[];
};
function verdictOf(net: number): number { return net >= 60 ? 2 : net > 0 ? 1 : 0; }

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const inputFlag = argv.indexOf("--input");
  const inputPath = inputFlag >= 0 ? argv[inputFlag + 1] : "input/snapshot.json";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "out";
  const rootDir = path.dirname(fileURLToPath(import.meta.url));
  const { protocols, watchlist } = loadSnapshot(inputPath);
  const watch = new Set(watchlist);

  // ledger
  const ledger: Record<string, number> = { tokened: 0, forbidden: 0, versioned: 0, wrapped: 0, exchange: 0, watchlist: 0, abovefloor: 0, belowfloor: 0 };
  const groups = new Map<string, Group>();
  for (const p of protocols) { const g = groupOf(p, watch); groups.set(p.slug, g); ledger[g] += 1; }
  const tokenedMcap = protocols.filter((p) => p.tokened && p.mcap && p.mcap > 0).length;
  const tokenedNoMcap = protocols.filter((p) => p.tokened && !(p.mcap && p.mcap > 0)).length;

  // comps + value model
  const comps = selectComps(protocols);
  const compsImp = comps.filter((p) => p.age === null).length;
  const model = fitValue(comps, USE_AGE, false, SHRINK, USE_OFFSETS);

  // validation legs (chosen config + baselines + ablation)
  const loo = looLeg(comps, GROWTH_W, USE_AGE, false, SHRINK, USE_OFFSETS);
  const ts = timeSplitLeg(comps, GROWTH_W, USE_AGE, false, SHRINK, USE_OFFSETS);
  const wf = walkForwardLeg(comps, GROWTH_W, USE_AGE, false, SHRINK, false, USE_OFFSETS);
  const wfRoll = walkForwardLeg(comps, GROWTH_W, USE_AGE, false, SHRINK, true, USE_OFFSETS);
  const abl = ablation(comps);
  const looErrs: number[] = [];
  const looFmByComp: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const rest = comps.filter((_, j) => j !== i);
    const m = fitValue(rest, USE_AGE, false, SHRINK, USE_OFFSETS);
    const { cond } = condValue(comps[i], m, GROWTH_W);
    looErrs.push(Math.log10(cond / (comps[i].mcap as number)));
    looFmByComp.push(fm(cond, comps[i].mcap as number));
  }
  const band = Math.pow(10, pstdev(looErrs));

  // launch odds
  const dated = protocols.filter((p) => p.age !== null);
  const { lam, sweeps } = fitHazard(dated);
  const { global, mult } = catMultipliers(protocols);
  const hazVal = hazardValidation(dated);
  const medPreAge = median(protocols.filter((p) => !p.tokened && p.age !== null).map((p) => p.age as number));

  // board rows
  const boardProtos = protocols.filter((p) => {
    const g = groups.get(p.slug);
    return g === "watchlist" || g === "abovefloor" || g === "belowfloor";
  });
  const boardImp = boardProtos.filter((p) => p.age === null).length;
  const rows: BoardRow[] = boardProtos.map((p) => {
    const { cond, mult: m } = condValue(p, model, GROWTH_W);
    const prob = condLaunchProb(p, lam, mult, medPreAge);
    const ev = cond * prob;
    return {
      p, cond, mult: m, prob, ev, evInt: 0, bandLo: 0, bandHi: 0, rankLo: 0, rankHi: 0,
      sliceFloor: 0, net: 0, netHr: 0, breakeven: 0, verdict: 0,
      off: model.offsets.get(p.category ?? "") ?? 0,
      ageImp: p.age === null, near: [],
    };
  });
  rows.sort((a, b) => (b.ev - a.ev) || (a.p.slug < b.p.slug ? -1 : 1));
  // local bands from 20 nearest comps by |log TVL|
  const compLogTvl = comps.map((c) => Math.log(c.tvl));
  for (const r of rows) {
    const lt = Math.log(r.p.tvl);
    const order = comps.map((_, i) => i).sort((i, j) => Math.abs(compLogTvl[i] - lt) - Math.abs(compLogTvl[j] - lt));
    const near = order.slice(0, 20);
    r.near = near.slice(0, 3);
    const errs = near.map((i) => looErrs[i]).sort((a, b) => a - b);
    const p25 = quantile(errs, 0.25), p75 = quantile(errs, 0.75);
    r.bandLo = r.ev / Math.pow(10, p75);
    r.bandHi = r.ev / Math.pow(10, p25);
  }
  // local-band coverage on comps (band around LOO prediction, 20 nearest others)
  let covered = 0;
  for (let i = 0; i < comps.length; i++) {
    const lt = compLogTvl[i];
    const order = comps.map((_, j) => j).filter((j) => j !== i)
      .sort((a, b) => Math.abs(compLogTvl[a] - lt) - Math.abs(compLogTvl[b] - lt));
    const near = order.slice(0, 20);
    const errs = near.map((j) => looErrs[j]).sort((a, b) => a - b);
    const rest = comps.filter((_, j) => j !== i);
    const m = fitValue(rest, USE_AGE, false, SHRINK, USE_OFFSETS);
    const { cond } = condValue(comps[i], m, GROWTH_W);
    const lo = cond / Math.pow(10, quantile(errs, 0.75));
    const hi = cond / Math.pow(10, quantile(errs, 0.25));
    if ((comps[i].mcap as number) >= lo && (comps[i].mcap as number) <= hi) covered += 1;
  }
  const coverage = covered / comps.length;
  // farm math (reference deposit $200, T-bill 4%, 90 days)
  const costRef = GAS_USD + (DEPOSIT_REF * TBILL_REF * FARM_DAYS) / 365;
  let adjusted = 0;
  rows.forEach((r, i) => {
    r.evInt = Math.round(r.ev);
    if (i > 0 && r.evInt >= rows[i - 1].evInt) { r.evInt = rows[i - 1].evInt - 1; adjusted += 1; }
    const slice = r.evInt * SHARE; // slice from the rounded board value, so dashboard what-if matches exactly
    r.sliceFloor = slice / band;
    r.net = r.sliceFloor - costRef;
    r.netHr = r.net / (WORK_MIN / 60);
    r.breakeven = (costRef * band) / (r.cond * SHARE);
    r.verdict = verdictOf(r.net);
  });
  const nFarm = rows.filter((r) => r.verdict === 2).length;
  const nThin = rows.filter((r) => r.verdict === 1).length;
  const nSkip = rows.filter((r) => r.verdict === 0).length;
  const totalEV = rows.reduce((a, r) => a + r.ev, 0);
  const bestNetHr = Math.max(...rows.map((r) => r.netHr));
  const farmThin = rows.filter((r) => r.verdict >= 1);
  const portfolio = {
    n: farmThin.length,
    cost: farmThin.length * costRef,
    net: farmThin.reduce((a, r) => a + r.net, 0),
    hours: (farmThin.length * WORK_MIN) / 60,
  };
  // bootstrap rank ranges (launch odds held fixed)
  const bootRanks: number[][] = rows.map(() => []);
  const rndB = mulberry32(BOOT_SEED);
  const medRank: number[] = [];
  {
    const medEvs: number[] = rows.map(() => 0);
    const allEvs: number[][] = rows.map(() => []);
    for (let b = 0; b < N_BOOT; b++) {
      const sample: Proto[] = [];
      for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rndB() * comps.length)]);
      const m = fitValue(sample, USE_AGE, false, SHRINK, USE_OFFSETS);
      const evs = rows.map((r) => condValue(r.p, m, GROWTH_W).cond * r.prob);
      const order = rows.map((_, i) => i).sort((i, j) => (evs[j] - evs[i]) || (rows[i].p.slug < rows[j].p.slug ? -1 : 1));
      order.forEach((ri, pos) => { bootRanks[ri].push(pos + 1); allEvs[ri].push(evs[ri]); });
    }
    rows.forEach((_, i) => {
      medRank[i] = median(bootRanks[i]);
      medEvs[i] = median(allEvs[i]);
    });
    rows.forEach((r, i) => {
      const s = [...bootRanks[i]].sort((a, b) => a - b);
      r.rankLo = quantile(s, 0.05); r.rankHi = quantile(s, 0.95);
    });
  }
  const rankWidthMed = median(rows.map((r) => r.rankHi - r.rankLo));
  const bandWidthMed = median(rows.map((r) => (r.bandHi - r.bandLo) / r.ev)) * 100;
  const top10Med = rows.map((_, i) => i).sort((a, b) => medRank[a] - medRank[b]).slice(0, 10);
  const top10Stable = top10Med.filter((i) => bootRanks[i].filter((rk) => rk <= 10).length / N_BOOT >= 0.8).length / 10;
  const rank1Idx = rows.map((_, i) => i).sort((a, b) => medRank[a] - medRank[b])[0];
  const rank1Stays = bootRanks[rank1Idx].filter((rk) => rk === 1).length / N_BOOT;

  // ---------- outputs ----------
  fs.mkdirSync(outDir, { recursive: true });
  const boardJson = {
    rows: rows.map((r, i) => ({
      slug: r.p.slug, name: r.p.name, rank: i + 1,
      implied_value_usd: r.evInt, farm_steps: farmSteps(r.p),
    })),
  };
  fs.writeFileSync(path.join(outDir, "board.json"), JSON.stringify(boardJson, null, 2) + "\n");
  // compact dashboard data
  const cats = [...new Set(rows.map((r) => r.p.category ?? ""))].sort();
  const chains = [...new Set(rows.map((r) => r.p.chains[0] ?? ""))].sort();
  const compIdx = new Map(comps.map((c, i) => [c.slug, i]));
  const data = {
    m: {
      beta: model.beta.map((x) => +x.toFixed(4)),
      shrink: SHRINK, growthW: GROWTH_W, band: +band.toFixed(6),
      loo, ts, wf, wfRoll, coverage: +coverage.toFixed(4),
      nRows: rows.length, totalEV: Math.round(totalEV),
      nFarm, nThin, nSkip, bestNetHr: +bestNetHr.toFixed(2),
      compsN: comps.length, compsImp, compsMedAge: model.medAge, boardImp, medPreAge,
      splitSeed: SPLIT_SEED, bootSeed: BOOT_SEED, nBoot: N_BOOT,
      hazLam: lam.map((x) => +x.toFixed(4)), hazSweeps: sweeps,
      hazVal: { ...hazVal, lamTrain: hazVal.lamTrain.map((x) => +x.toFixed(4)) },
      ledger, tokenedMcap, tokenedNoMcap, adjusted,
      rankWidthMed: +rankWidthMed.toFixed(1), bandWidthMed: +bandWidthMed.toFixed(1),
      top10Stable: +top10Stable.toFixed(2), rank1Stays: +rank1Stays.toFixed(2),
      portfolio: { n: portfolio.n, cost: +portfolio.cost.toFixed(2), net: +portfolio.net.toFixed(2), hours: +portfolio.hours.toFixed(1) },
      abl: abl.map((a) => [a.label, +a.loo.toFixed(3), +a.ts.toFixed(3), +a.wf.toFixed(3), a.note]),
      offsets: [...model.offsets.entries()].sort().map(([k, v]) => [k, +v.toFixed(3)]),
    },
    cats, chains,
    rows: rows.map((r, i) => [
      r.p.slug, r.p.name, cats.indexOf(r.p.category ?? ""), r.p.chains.length,
      chains.indexOf(r.p.chains[0] ?? ""), r.p.tvl,
      r.p.chg === null ? null : Math.round(r.p.chg * 100),
      r.p.age === null ? medPreAge : r.p.age, r.ageImp ? 1 : 0,
      Math.round(r.prob * 1000),
      r.breakeven > 1 ? 9999 : Math.round(r.breakeven * 1000),
      r.evInt, Math.round(r.bandLo), Math.round(r.bandHi),
      Math.round(r.rankLo), Math.round(r.rankHi),
      Math.round(r.sliceFloor * 100), Math.round(r.net * 100), Math.round(r.netHr * 100),
      r.verdict, Math.round(r.cond),
      Math.round(r.mult * 10000), Math.round(r.off * 1000),
      compIdx.get(comps[r.near[0]].slug), compIdx.get(comps[r.near[1]].slug), compIdx.get(comps[r.near[2]].slug),
    ]),
    comps: comps.map((c, i) => [c.slug, c.tvl, c.mcap, Math.round(looFmByComp[i] * 1000)]),
    live: protocols.filter((p) => p.tokened && p.mcap && p.mcap > 0)
      .sort((a, b) => (b.mcap as number) - (a.mcap as number)).slice(0, 40)
      .map((p) => [p.slug, p.name, p.mcap]),
  };
  const dashOut = path.join(outDir, "dashboard");
  fs.mkdirSync(dashOut, { recursive: true });
  for (const f of ["index.html", "app.css", "app.js"]) {
    fs.copyFileSync(path.join(rootDir, "dashboard", f), path.join(dashOut, f));
  }
  fs.writeFileSync(path.join(dashOut, "data.js"), "window.RADAR_DATA=" + JSON.stringify(data) + ";\n");
  const shotsSrc = path.join(rootDir, "screenshots");
  const shotsOut = path.join(outDir, "screenshots");
  if (fs.existsSync(shotsSrc) && fs.readdirSync(shotsSrc).filter((f) => !f.startsWith(".")).length > 0) {
    fs.mkdirSync(shotsOut, { recursive: true });
    for (const f of fs.readdirSync(shotsSrc)) {
      if (f.startsWith(".")) continue;
      fs.copyFileSync(path.join(shotsSrc, f), path.join(shotsOut, f));
    }
  }
  const dossierBytes = await buildDossier(outDir, { text_max_bytes: 65536 });
  fs.writeFileSync(path.join(outDir, "dossier.json"), dossierBytes);

  // ---------- stdout report (for NOTES-v3) ----------
  const rep = [
    `comps=${comps.length} (dated ${comps.length - compsImp}, imputed age ${compsImp}, median age ${model.medAge})`,
    `beta intercept=${model.beta[0].toFixed(4)} logTVL=${model.beta[1].toFixed(4)} (no age term, no offsets)`,
    `LOO full geo=${loo.full.geo.toFixed(3)} med=${loo.full.med.toFixed(3)} le2=${loo.full.le2.toFixed(3)} le3=${loo.full.le3.toFixed(3)} | raw geo=${loo.raw.geo.toFixed(3)}`,
    `TS n=${ts.nTrain}/${ts.nTest} full geo=${ts.full.geo.toFixed(3)} med=${ts.full.med.toFixed(3)} | raw geo=${ts.raw.geo.toFixed(3)}`,
    `WF-exp full geo=${wf.full.geo.toFixed(3)} | raw geo=${wf.raw.geo.toFixed(3)} | WF-roll full geo=${wfRoll.full.geo.toFixed(3)}`,
    `hazard lam=[${lam.map((x) => x.toFixed(4)).join(", ")}] sweeps=${sweeps}`,
    `hazard val hit=${hazVal.hit.toFixed(4)} brier=${hazVal.brier.toFixed(4)} base=${hazVal.base.toFixed(4)} | ever hit=${hazVal.everHit.toFixed(4)} brier=${hazVal.everBrier.toFixed(4)} n=${hazVal.nTrain}/${hazVal.nTest}`,
    `band=${band.toFixed(3)} coverage=${coverage.toFixed(3)} boardImp=${boardImp} adjusted=${adjusted}`,
    `verdicts Farm=${nFarm} Thin=${nThin} Skip=${nSkip} totalEV=${Math.round(totalEV)} bestNetHr=${bestNetHr.toFixed(2)}`,
    `top3=${rows.slice(0, 3).map((r) => r.p.slug + ":" + fmtUsd(r.ev)).join(" | ")}`,
    `rankWidthMed=${rankWidthMed.toFixed(1)} bandWidthMed=${bandWidthMed.toFixed(1)}% top10Stable=${top10Stable.toFixed(2)} rank1Stays=${rank1Stays.toFixed(2)}`,
    `ledger=${JSON.stringify(ledger)}`,
  ];
  for (const line of rep) console.log(line);
  for (const a of abl) console.log(`ABL ${a.label} | LOO ${a.loo.toFixed(3)} TS ${a.ts.toFixed(3)} WF ${a.wf.toFixed(3)} | ${a.note}`);
  const dossier = JSON.parse(fs.readFileSync(path.join(outDir, "dossier.json"), "utf8"));
  console.log(`dossier bytes=${fs.statSync(path.join(outDir, "dossier.json")).size}`);
  void dossier;
}

main();
