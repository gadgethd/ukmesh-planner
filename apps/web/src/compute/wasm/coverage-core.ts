/**
 * WASM coverage kernel (AssemblyScript, f64) — Tier B fallback backend.
 *
 * A faithful port of the shared TypeScript core (packages/rf-core) restricted
 * to what the coverage preview needs: great-circle profile sampling over a
 * pre-assembled DEM window, Deygout-3 diffraction, link budget and the same
 * classification rules. All arithmetic is f64, mirroring the CPU oracle's
 * JS-number semantics, so wasm-vs-cpu parity is expected to be near-exact.
 *
 * Interface (no AS loader required):
 *   allocDem(len) / allocMargins(len) / allocCodes(len) / allocParams()
 *     -> byte offsets into `memory` the caller writes into.
 *   runBand(row0, rows) -> evaluates that band of output rows.
 * Keep every allocation in the alloc* phase; runBand must not allocate, so
 * the caller's typed-array views stay valid across the whole run.
 */

const EARTH_RADIUS_M: f64 = 6371008.8;
const EFFECTIVE_EARTH_RADIUS_M: f64 = (EARTH_RADIUS_M * 4.0) / 3.0;
const SPEED_OF_LIGHT_M_S: f64 = 299792458.0;
const WORLD_PX: f64 = 1048576.0; // 2^12 * 256

// Cell codes (mirror coverage/codes.ts).
const CELL_LIKELY: u8 = 0;
const CELL_MARGINAL: u8 = 1;
const CELL_UNLIKELY: u8 = 2;
const CELL_BLOCKED: u8 = 3;
const CELL_UNKNOWN: u8 = 4;
const CELL_OUT_OF_RANGE: u8 = 5;

// --- shared state (allocated once; runBand never allocates) ------------------
let dem: Float32Array = new Float32Array(0);
let outMargins: Float32Array = new Float32Array(0);
let outCodes: Uint8Array = new Uint8Array(0);
let params: Float64Array = new Float64Array(0);
const PROF_MAX: i32 = 512;
const profTerrain: Float64Array = new Float64Array(PROF_MAX);
const profBulge: Float64Array = new Float64Array(PROF_MAX);
const profDist: Float64Array = new Float64Array(PROF_MAX);
const segI0: Int32Array = new Int32Array(8);
const segI1: Int32Array = new Int32Array(8);
const segT0: Float64Array = new Float64Array(8);
const segT1: Float64Array = new Float64Array(8);
const slerpOut: Float64Array = new Float64Array(2);

// Params layout (indices into `params`):
//  0 siteLon  1 siteLat  2 siteTopM  3 rxHeightAglM
//  4 demOriginX  5 demOriginY  6 demW  7 demH
//  8 areaOriginX 9 areaOriginY 10 cellPx 11 outW 12 outH
// 13 txPowerDbm 14 txGainDbi 15 rxGainDbi 16 rxSensitivityDbm
// 17 marginGreenDb 18 marginMarginalDb 19 maxRangeKm 20 frequencyMhz
// 21 targetSpacingM 22 minSamples 23 maxSamples

export function allocDem(len: i32): usize {
  dem = new Float32Array(len);
  return dem.dataStart;
}
export function allocMargins(len: i32): usize {
  outMargins = new Float32Array(len);
  return outMargins.dataStart;
}
export function allocCodes(len: i32): usize {
  outCodes = new Uint8Array(len);
  return outCodes.dataStart;
}
export function allocParams(): usize {
  params = new Float64Array(24);
  return params.dataStart;
}

// --- geodesy ----------------------------------------------------------------
function clampI(v: i32, lo: i32, hi: i32): i32 {
  return v < lo ? lo : v > hi ? hi : v;
}

function toRad(deg: f64): f64 { return (deg * Math.PI) / 180.0; }
function toDeg(rad: f64): f64 { return (rad * 180.0) / Math.PI; }

function normalizeLon(lon: f64): f64 {
  let l = lon;
  while (l > 180.0) l -= 360.0;
  while (l < -180.0) l += 360.0;
  return l;
}

function haversineM(lat1: f64, lon1: f64, lat2: f64, lon2: f64): f64 {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(normalizeLon(lon2 - lon1));
  const sp = Math.sin(dPhi / 2.0);
  const sl = Math.sin(dLambda / 2.0);
  const s = sp * sp + Math.cos(phi1) * Math.cos(phi2) * sl * sl;
  return 2.0 * EARTH_RADIUS_M * Math.asin(Math.min(1.0, Math.sqrt(s)));
}

// Slerp output written into slerpOut (avoids object allocation).
function slerp(lat1: f64, lon1: f64, lat2: f64, lon2: f64, f: f64): void {
  const phi1 = toRad(lat1);
  const lambda1 = toRad(lon1);
  const phi2 = toRad(lat2);
  const lambda2 = toRad(lon2);
  const d = haversineM(lat1, lon1, lat2, lon2) / EARTH_RADIUS_M;
  if (d == 0.0) {
    slerpOut[0] = lon1;
    slerpOut[1] = lat1;
    return;
  }
  const sinD = Math.sin(d);
  const A = Math.sin((1.0 - f) * d) / sinD;
  const B = Math.sin(f * d) / sinD;
  const x = A * Math.cos(phi1) * Math.cos(lambda1) + B * Math.cos(phi2) * Math.cos(lambda2);
  const y = A * Math.cos(phi1) * Math.sin(lambda1) + B * Math.cos(phi2) * Math.sin(lambda2);
  const z = A * Math.sin(phi1) + B * Math.sin(phi2);
  slerpOut[0] = normalizeLon(toDeg(Math.atan2(y, x)));
  slerpOut[1] = toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)));
}

function lonToPxX(lon: f64): f64 { return ((lon + 180.0) / 360.0) * WORLD_PX; }
function latToPxY(lat: f64): f64 {
  const latRad = toRad(lat);
  return ((1.0 - Math.log(Math.tan(latRad) + 1.0 / Math.cos(latRad)) / Math.PI) / 2.0) * WORLD_PX;
}
function pxYToLat(y: f64): f64 {
  const n = Math.PI - 2.0 * Math.PI * (y / WORLD_PX);
  return (180.0 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
function pxXToLon(x: f64): f64 { return (x / WORLD_PX) * 360.0 - 180.0; }

// --- terrain sampling (window-relative; tile-local clamp, NaN = unknown) -----
function sampleDem(px: f64, py: f64): f64 {
  const oX = params[4];
  const oY = params[5];
  const w = i32(params[6]);
  const h = i32(params[7]);
  const clx = Math.min(Math.max(px, oX), oX + f64(w) - 1.0);
  const cly = Math.min(Math.max(py, oY), oY + f64(h) - 1.0);
  const tileX = Math.floor(clx / 256.0);
  const tileY = Math.floor(cly / 256.0);
  const lx = Math.min(Math.max(clx - tileX * 256.0, 0.0), 255.0);
  const ly = Math.min(Math.max(cly - tileY * 256.0, 0.0), 255.0);
  const x0 = i32(Math.floor(lx));
  const y0 = i32(Math.floor(ly));
  const x1 = clampI(x0 + 1, 0, 255);
  const y1 = clampI(y0 + 1, 0, 255);
  const ox = i32(tileX * 256.0) - i32(oX);
  const oy = i32(tileY * 256.0) - i32(oY);
  const v00 = f64(dem[(oy + y0) * w + (ox + x0)]);
  const v10 = f64(dem[(oy + y0) * w + (ox + x1)]);
  const v01 = f64(dem[(oy + y1) * w + (ox + x0)]);
  const v11 = f64(dem[(oy + y1) * w + (ox + x1)]);
  if (v00 != v00 || v10 != v10 || v01 != v01 || v11 != v11) return f64.NaN;
  const fx = lx - f64(x0);
  const fy = ly - f64(y0);
  const top = v00 * (1.0 - fx) + v10 * fx;
  const bottom = v01 * (1.0 - fx) + v11 * fx;
  return top * (1.0 - fy) + bottom * fy;
}

// --- link budget primitives -------------------------------------------------
function knifeEdgeLossDb(v: f64): f64 {
  if (v <= -0.7) return 0.0;
  return 6.9 + 20.0 * Math.log10(Math.sqrt((v - 0.1) * (v - 0.1) + 1.0) + v - 0.1);
}
function fresnelRadiusM(lambdaM: f64, d1M: f64, d2M: f64): f64 {
  const d = d1M + d2M;
  if (d <= 0.0) return 0.0;
  return Math.sqrt((lambdaM * d1M * d2M) / d);
}
function freeSpaceLossDb(distanceKm: f64, frequencyMhz: f64): f64 {
  if (distanceKm <= 0.0) return 0.0;
  return 32.44 + 20.0 * Math.log10(distanceKm) + 20.0 * Math.log10(frequencyMhz);
}

// --- Deygout-3 over the sampled profile (mirrors diffraction.ts) -------------
function deygoutLossDb(n: i32, topStart: f64, topEnd: f64, lambdaM: f64): f64 {
  if (n < 3) return 0.0;
  if (!(topStart == topStart) || !(topEnd == topEnd)) return 0.0;

  segI0[0] = 0;
  segI1[0] = n - 1;
  segT0[0] = topStart;
  segT1[0] = topEnd;
  let segCount = 1;
  let edgesFound = 0;
  let totalLossDb = 0.0;

  while (segCount > 0 && edgesFound < 3) {
    segCount -= 1;
    const i0 = segI0[segCount];
    const i1 = segI1[segCount];
    const t0 = segT0[segCount];
    const t1 = segT1[segCount];
    const d0 = profDist[i0];
    const d1 = profDist[i1];
    const span = d1 - d0;
    if (span <= 0.0 || i1 - i0 < 2) continue;

    let bestV = f64.NEGATIVE_INFINITY;
    let bestI = -1;
    for (let i = i0 + 1; i < i1; i += 1) {
      const terrainM = profTerrain[i];
      if (!(terrainM == terrainM)) continue;
      const di = profDist[i] - d0;
      const dj = d1 - profDist[i];
      if (di <= 0.0 || dj <= 0.0) continue;
      const lineAtI = t0 + ((t1 - t0) * di) / span;
      const effTerrain = terrainM + profBulge[i]; // full-path bulge (oracle semantics)
      const h = effTerrain - lineAtI;
      if (h <= 0.0) continue;
      const v = h * Math.sqrt((2.0 * (1.0 / di + 1.0 / dj)) / lambdaM);
      if (v > bestV) {
        bestV = v;
        bestI = i;
      }
    }

    if (bestI == -1 || bestV <= -0.7) continue;

    totalLossDb += knifeEdgeLossDb(bestV);
    edgesFound += 1;

    const edgeTop = profTerrain[bestI] + profBulge[bestI];
    // Push right then left; pops take left first — same order as the CPU.
    segI0[segCount] = bestI;
    segI1[segCount] = i1;
    segT0[segCount] = edgeTop;
    segT1[segCount] = t1;
    segCount += 1;
    segI0[segCount] = i0;
    segI1[segCount] = bestI;
    segT0[segCount] = t0;
    segT1[segCount] = edgeTop;
    segCount += 1;
  }
  return totalLossDb;
}

// --- per-cell evaluation ----------------------------------------------------
// Writes one (margin, code) pair at `idx`.
function assessCell(lat: f64, lon: f64, idx: i32): void {
  const siteLon = params[0];
  const siteLat = params[1];
  const siteTop = params[2];
  const rxHeight = params[3];
  const lambdaM = SPEED_OF_LIGHT_M_S / (params[20] * 1000000.0);
  const dTotal = haversineM(siteLat, siteLon, lat, lon);

  const cellGround = sampleDem(lonToPxX(lon), latToPxY(lat));
  const cellTop = cellGround + rxHeight;
  const topsKnown = siteTop == siteTop && cellTop == cellTop;

  let n = i32(Math.ceil(dTotal / params[21])) + 1;
  n = clampI(n, i32(params[22]), i32(params[23]));

  let unknownCount = 0;
  let worstRatio = f64.POSITIVE_INFINITY;
  let hasWorst = false;
  const nf = f64(n - 1);
  for (let i = 0; i < n; i += 1) {
    const f = f64(i) / nf;
    slerp(siteLat, siteLon, lat, lon, f);
    const g = sampleDem(lonToPxX(slerpOut[0]), latToPxY(slerpOut[1]));
    profTerrain[i] = g;
    const d1 = dTotal * f;
    const d2 = dTotal - d1;
    const bulge = (d1 * d2) / (2.0 * EFFECTIVE_EARTH_RADIUS_M);
    profDist[i] = d1;
    profBulge[i] = bulge;
    const known = g == g && topsKnown;
    if (!known) unknownCount += 1;
    if (known && i > 0 && i + 1 < n) {
      const lineH = siteTop + (cellTop - siteTop) * f;
      const f1 = fresnelRadiusM(lambdaM, d1, d2);
      if (f1 > 0.0) {
        const ratio = (lineH - g - bulge) / f1;
        if (!hasWorst || ratio < worstRatio) {
          worstRatio = ratio;
          hasWorst = true;
        }
      }
    }
  }

  if (!topsKnown || unknownCount > 0) {
    outCodes[idx] = CELL_UNKNOWN;
    outMargins[idx] = f32.NaN;
    return;
  }

  const diffractionDb = deygoutLossDb(n, siteTop, cellTop, lambdaM);
  const fspl = freeSpaceLossDb(dTotal / 1000.0, params[20]);
  const rxPower = params[13] + params[14] + params[15] - (fspl + diffractionDb);
  const margin = rxPower - params[16];

  let code: u8 = CELL_UNLIKELY;
  if (margin >= params[17]) {
    code = CELL_LIKELY;
  } else if (margin >= params[18] && (!hasWorst || worstRatio >= 0.0)) {
    code = CELL_MARGINAL;
  } else if (hasWorst && worstRatio < 0.0) {
    code = CELL_BLOCKED;
  }
  outCodes[idx] = code;
  outMargins[idx] = f32(margin);
}

// --- banded driver ----------------------------------------------------------
export function runBand(row0: i32, rows: i32): void {
  const outW = i32(params[11]);
  const outH = i32(params[12]);
  const rowEnd = clampI(row0 + rows, 0, outH);
  for (let cy = row0; cy < rowEnd; cy += 1) {
    const cellPxY = params[9] + (f64(cy) + 0.5) * params[10];
    const lat = pxYToLat(cellPxY);
    for (let cx = 0; cx < outW; cx += 1) {
      const cellPxX = params[8] + (f64(cx) + 0.5) * params[10];
      const lon = pxXToLon(cellPxX);
      const idx = cy * outW + cx;
      const d = haversineM(params[1], params[0], lat, lon);
      if (d / 1000.0 > params[19]) {
        outCodes[idx] = CELL_OUT_OF_RANGE;
        outMargins[idx] = f32.NaN;
        continue;
      }
      assessCell(lat, lon, idx);
    }
  }
}
