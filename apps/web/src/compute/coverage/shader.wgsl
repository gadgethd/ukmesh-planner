// Coverage compute shader — one invocation per output cell.
//
// Mirrors the CPU oracle (rf-core buildProfile + deygoutLossDb + assessLink)
// exactly in structure and constants; f32 arithmetic throughout, so small
// numerical deviations vs the f64 CPU core are expected and bounded by the
// documented parity tolerance (docs/performance/benchmarks.md).
//
// Layout conventions mirror the TypeScript side (params.ts / kernel-cpu.ts):
//  - coordinates: global Web-Mercator pixels at z12 (WORLD_PX across)
//  - cell (x,y) centre: areaOrigin + (xy + 0.5) * cellPx
//  - terrain sampling: tile-local clamp (0..255) + bilinear, NaN = NODATA

const WORLD_PX: f32 = 1048576.0; // 2^12 * 256
const PI_F: f32 = 3.141592653589793;
const R_EARTH_M: f32 = 6371008.8;
const R_EFF_M: f32 = 8494678.4; // 4/3 * earth radius
const SPEED_OF_LIGHT: f32 = 299792458.0;

struct Params {
  siteLonLat: vec2f,
  siteTopM: f32,          // site terrain + antenna height (ASL)
  rxHeightAglM: f32,
  demOriginX: f32,
  demOriginY: f32,
  demW: f32,
  demH: f32,
  areaOriginX: f32,
  areaOriginY: f32,
  cellPx: f32,
  outW: f32,
  outH: f32,
  txPowerDbm: f32,
  txGainDbi: f32,
  rxGainDbi: f32,
  rxSensitivityDbm: f32,
  marginGreenDb: f32,
  marginMarginalDb: f32,
  maxRangeKm: f32,
  frequencyMhz: f32,
  targetSpacingM: f32,
  minSamples: f32,
  maxSamples: f32,
  rowOffset: f32,
  nanValue: f32, // runtime NaN (constant NaN is rejected by WGSL const-eval)
  bandRows: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> dem: array<f32>;
@group(0) @binding(2) var<storage, read_write> outMargins: array<f32>;
@group(0) @binding(3) var<storage, read_write> outCodes: array<u32>;


// --- precision-safe transcendentals -----------------------------------------
// Driver/sandbox transcendentals vary wildly in precision (SwiftShader's
// runtime sin/cos measured ~3e-5 absolute error, non-normalised — enough to
// displace great-circle sample points by >200 m and wreck terrain clearance
// on hilly paths). The kernel must produce device-independent results, so
// sin/cos/atan2 are implemented here with Cody-Waite range reduction and
// short Taylor polynomials (accurate to ~1 ulp of f32 over our argument
// ranges). exp/log/sqrt are left to the implementation (measured accurate).
const HALF_PI_F: f32 = 1.5707963267948966;
const HALF_PI_HI: f32 = 1.5707964; // f32(pi/2)
const HALF_PI_LO: f32 = -4.371139e-8; // pi/2 - f32(pi/2)
const INV_HALF_PI: f32 = 0.63661975; // f32(2/pi)
const ATAN_TAN_PI_12: f32 = 0.26794919; // tan(pi/12)
const ATAN_TAN_PI_6: f32 = 0.57735027; // tan(pi/6)

fn atanPoly(v: f32) -> f32 {
  // atan(v) for |v| <= tan(pi/12); Taylor to v^9, error < 2e-8.
  let v2 = v * v;
  return v * (1.0 + v2 * (-0.333333333 + v2 * (0.2 + v2 * (-0.142857143 + v2 * 0.111111111))));
}

fn atanPos(a: f32) -> f32 {
  // atan(a) for a >= 0, any magnitude.
  if (a > 1.0) {
    let ia = 1.0 / a;
    if (ia <= ATAN_TAN_PI_12) { return HALF_PI_F - atanPoly(ia); }
    let v = (ia - ATAN_TAN_PI_6) / (1.0 + ATAN_TAN_PI_6 * ia);
    return HALF_PI_F - (0.52359878 + atanPoly(v));
  }
  if (a <= ATAN_TAN_PI_12) { return atanPoly(a); }
  let v = (a - ATAN_TAN_PI_6) / (1.0 + ATAN_TAN_PI_6 * a);
  return 0.52359878 + atanPoly(v);
}

fn atanF(r: f32) -> f32 {
  return select(-atanPos(-r), atanPos(r), r >= 0.0);
}

fn atan2F(y: f32, x: f32) -> f32 {
  if (x == 0.0 && y == 0.0) { return 0.0; }
  let ax = abs(x);
  let ay = abs(y);
  if (ay <= ax) {
    let a = atanPos(abs(y / x)); // a = |atan(y/x)| >= 0
    if (x >= 0.0) {
      return select(-a, a, y >= 0.0); // x>0: atan2 = sign(y) * a
    }
    // x < 0: atan2 = pi - a (y >= 0) or a - pi (y < 0)
    return select(a - PI_F, PI_F - a, y >= 0.0);
  }
  let t = atanPos(abs(x / y));
  // y != 0 here. atan2 = sign(y) * (pi/2 - sign(x) * atan(|x/y|))
  if (y > 0.0) {
    return select(HALF_PI_F - t, HALF_PI_F + t, x < 0.0);
  }
  return select(-(HALF_PI_F + t), -(HALF_PI_F - t), x >= 0.0);
}

fn sinCosF(x: f32) -> vec2f {
  // Returns (sin x, cos x); accurate to ~1 ulp of f32 for |x| < ~100.
  let k = round(x * INV_HALF_PI);
  let r = x - k * HALF_PI_HI - k * HALF_PI_LO;
  let r2 = r * r;
  let s = r * (1.0 + r2 * (-0.166666667 + r2 * (0.008333333 + r2 * (-0.000198413 + r2 * 0.000002756))));
  let c = 1.0 + r2 * (-0.5 + r2 * (0.041666667 + r2 * (-0.001388889 + r2 * 0.000024802)));
  let q = i32(k) & 3;
  var so = s;
  var co = c;
  if (q == 1) { so = c; co = -s; }
  else if (q == 2) { so = -s; co = -c; }
  else if (q == 3) { so = -c; co = s; }
  return vec2f(so, co);
}

fn sinF(x: f32) -> f32 { return sinCosF(x).x; }
fn cosF(x: f32) -> f32 { return sinCosF(x).y; }

fn lonLatToGlobalPx(lon: f32, lat: f32) -> vec2f {
  let x = (lon + 180.0) / 360.0 * WORLD_PX;
  let latRad = lat * PI_F / 180.0;
  let sc = sinCosF(latRad);
  let y = (1.0 - log((sc.x + 1.0) / sc.y) / PI_F) / 2.0 * WORLD_PX;
  return vec2f(x, y);
}

fn globalPxToLonLat(p: vec2f) -> vec2f {
  let lon = p.x / WORLD_PX * 360.0 - 180.0;
  let nn = PI_F - 2.0 * PI_F * (p.y / WORLD_PX);
  let lat = 180.0 / PI_F * atanF(0.5 * (exp(nn) - exp(-nn)));
  return vec2f(lon, lat);
}

fn haversineM(a: vec2f, b: vec2f) -> f32 {
  let p1 = a.y * PI_F / 180.0;
  let p2 = b.y * PI_F / 180.0;
  let dPhi = (b.y - a.y) * PI_F / 180.0;
  var dLam = (b.x - a.x) * PI_F / 180.0;
  if (dLam > PI_F) { dLam -= 2.0 * PI_F; }
  if (dLam < -PI_F) { dLam += 2.0 * PI_F; }
  let sp = sinF(dPhi / 2.0);
  let sl = sinF(dLam / 2.0);
  let s = sp * sp + cosF(p1) * cosF(p2) * sl * sl;
  return 2.0 * R_EARTH_M * asin(min(1.0, sqrt(s)));
}

// Great-circle interpolation — mirrors rf-core interpolateGreatCircle.
fn slerp(a: vec2f, b: vec2f, f: f32, dRad: f32) -> vec2f {
  if (dRad == 0.0) { return a; }
  let p1 = a.y * PI_F / 180.0;
  let l1 = a.x * PI_F / 180.0;
  let p2 = b.y * PI_F / 180.0;
  let l2 = b.x * PI_F / 180.0;
  let sinD = sinF(dRad);
  let A = sinF((1.0 - f) * dRad) / sinD;
  let B = sinF(f * dRad) / sinD;
  let sc1 = sinCosF(p1);
  let sc2 = sinCosF(p2);
  let sc3 = sinCosF(l1);
  let sc4 = sinCosF(l2);
  let x = A * sc1.y * sc3.y + B * sc2.y * sc4.y;
  let y = A * sc1.y * sc3.x + B * sc2.y * sc4.x;
  let z = A * sc1.x + B * sc2.x;
  var lon = degrees(atan2F(y, x));
  if (lon > 180.0) { lon -= 360.0; }
  if (lon < -180.0) { lon += 360.0; }
  return vec2f(lon, degrees(atan2F(z, sqrt(x * x + y * y))));
}

fn demAt(ix: i32, iy: i32) -> f32 {
  let x = clamp(ix, 0, i32(params.demW) - 1);
  let y = clamp(iy, 0, i32(params.demH) - 1);
  return dem[u32(y) * u32(params.demW) + u32(x)];
}

// Bilinear sample with the same tile-local clamp semantics as the CPU
// provider: local pixel coordinates are clamped to [0, 255] within the
// containing 256-px tile before interpolating.
fn sampleDem(gpx: vec2f) -> f32 {
  let clamped = vec2f(
    clamp(gpx.x, params.demOriginX, params.demOriginX + params.demW - 1.0),
    clamp(gpx.y, params.demOriginY, params.demOriginY + params.demH - 1.0),
  );
  let tileX = floor(clamped.x / 256.0);
  let tileY = floor(clamped.y / 256.0);
  let local = vec2f(
    clamp(clamped.x - tileX * 256.0, 0.0, 255.0),
    clamp(clamped.y - tileY * 256.0, 0.0, 255.0),
  );
  let x0 = i32(floor(local.x));
  let y0 = i32(floor(local.y));
  let x1 = min(x0 + 1, 255);
  let y1 = min(y0 + 1, 255);
  let fx = local.x - f32(x0);
  let fy = local.y - f32(y0);
  let ox = i32(tileX * 256.0) - i32(params.demOriginX);
  let oy = i32(tileY * 256.0) - i32(params.demOriginY);
  let v00 = demAt(ox + x0, oy + y0);
  let v10 = demAt(ox + x1, oy + y0);
  let v01 = demAt(ox + x0, oy + y1);
  let v11 = demAt(ox + x1, oy + y1);
  if (v00 != v00 || v10 != v10 || v01 != v01 || v11 != v11) { return params.nanValue; }
  let top = v00 * (1.0 - fx) + v10 * fx;
  let bottom = v01 * (1.0 - fx) + v11 * fx;
  return top * (1.0 - fy) + bottom * fy;
}

// WGSL has no log10 builtin; log10(x) = ln(x) / ln(10).
fn log10f(x: f32) -> f32 {
  return log(x) * 0.4342944819032518;
}

fn knifeEdgeLossDb(v: f32) -> f32 {
  if (v <= -0.7) { return 0.0; }
  let t = v - 0.1;
  return 6.9 + 20.0 * log10f(sqrt(t * t + 1.0) + t);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let cx = gid.x;
  let cy = gid.y + u32(params.rowOffset);
  if (cx >= u32(params.outW) || cy >= u32(params.outH) || gid.y >= u32(params.bandRows)) { return; }
  // Output buffers contain only this band; world coordinates still use cy.
  let idx = gid.y * u32(params.outW) + cx;

  // Cell centre (mirrors cellCenterLonLat).
  let cellPx = vec2f(
    params.areaOriginX + (f32(cx) + 0.5) * params.cellPx,
    params.areaOriginY + (f32(cy) + 0.5) * params.cellPx,
  );
  let cellLonLat = globalPxToLonLat(cellPx);
  let siteLonLat = params.siteLonLat;

  let dTotal = haversineM(siteLonLat, cellLonLat);
  if (dTotal / 1000.0 > params.maxRangeKm) {
    outCodes[idx] = 5u;
    outMargins[idx] = params.nanValue;
    return;
  }

  let cellGround = sampleDem(cellPx);
  let siteTop = params.siteTopM;
  let cellTop = cellGround + params.rxHeightAglM;

  // Unknown terrain anywhere on the chord -> unknown cell (fail closed).
  let topsKnown = (siteTop == siteTop) && (cellTop == cellTop);

  let lambdaM = SPEED_OF_LIGHT / (params.frequencyMhz * 1000000.0);
  let dRad = dTotal / R_EARTH_M;
  var n = i32(ceil(dTotal / params.targetSpacingM)) + 1;
  n = max(i32(params.minSamples), min(i32(params.maxSamples), n));

  // Pass 1: sample the profile once; track unknown samples and the worst
  // interior clearance ratio (mirrors buildProfile).
  var prof: array<f32, 512>;
  var unknownCount = 0u;
  var worstRatio = 1.0e30;
  var hasWorst = false;
  let nf = f32(n - 1);
  for (var i = 0; i < n; i = i + 1) {
    let f = f32(i) / nf;
    let p = slerp(siteLonLat, cellLonLat, f, dRad);
    let g = sampleDem(lonLatToGlobalPx(p.x, p.y));
    prof[i] = g;
    let known = (g == g) && topsKnown;
    if (!known) { unknownCount = unknownCount + 1u; }
    if (known && i > 0 && i + 1 < n) {
      let d1 = dTotal * f;
      let d2 = dTotal - d1;
      let lineH = siteTop + (cellTop - siteTop) * f;
      let bulge = d1 * d2 / (2.0 * R_EFF_M);
      let f1 = sqrt(lambdaM * d1 * d2 / dTotal);
      if (f1 > 0.0) {
        let ratio = (lineH - g - bulge) / f1;
        if (!hasWorst || ratio < worstRatio) { worstRatio = ratio; hasWorst = true; }
      }
    }
  }

  if (!topsKnown || unknownCount > 0u) {
    outCodes[idx] = 4u;
    outMargins[idx] = params.nanValue;
    return;
  }

  // Pass 2: Deygout-3 over the sampled profile (mirrors deygoutLossDb).
  var segI0: array<i32, 8>;
  var segI1: array<i32, 8>;
  var segT0: array<f32, 8>;
  var segT1: array<f32, 8>;
  segI0[0] = 0; segI1[0] = n - 1; segT0[0] = siteTop; segT1[0] = cellTop;
  var segCount = 1;
  var lossDb = 0.0;
  var edges = 0;
  while (segCount > 0 && edges < 3) {
    segCount = segCount - 1;
    let i0 = segI0[segCount];
    let i1 = segI1[segCount];
    let top0 = segT0[segCount];
    let top1 = segT1[segCount];
    let d0 = dTotal * f32(i0) / nf;
    let d1m = dTotal * f32(i1) / nf;
    let span = d1m - d0;
    if (span <= 0.0 || i1 - i0 < 2) { continue; }

    var bestV = -1.0e30;
    var bestI = -1;
    for (var i = i0 + 1; i < i1; i = i + 1) {
      let t = prof[i];
      if (t != t) { continue; }
      let di = dTotal * f32(i) / nf - d0;
      let dj = d1m - dTotal * f32(i) / nf;
      if (di <= 0.0 || dj <= 0.0) { continue; }
      let lineAtI = top0 + (top1 - top0) * di / span;
      // Mirror the CPU oracle: obstacle tops use the FULL-PATH bulge
      // (terrainM + earthBulgeAdjM from buildProfile), not a segment-relative
      // bulge — see rf-core/diffraction.ts.
      let d1f = dTotal * f32(i) / nf;
      let effT = t + d1f * (dTotal - d1f) / (2.0 * R_EFF_M);
      let h = effT - lineAtI;
      if (h <= 0.0) { continue; }
      let v = h * sqrt((2.0 * (1.0 / di + 1.0 / dj)) / lambdaM);
      if (v > bestV) { bestV = v; bestI = i; }
    }

    if (bestI < 0 || bestV <= -0.7) { continue; }
    lossDb = lossDb + knifeEdgeLossDb(bestV);
    edges = edges + 1;

    let d1b = dTotal * f32(bestI) / nf;
    let edgeTop = prof[bestI] + d1b * (dTotal - d1b) / (2.0 * R_EFF_M);
    // Push right then left; pops take left first — same order as the CPU.
    segI0[segCount] = bestI; segI1[segCount] = i1; segT0[segCount] = edgeTop; segT1[segCount] = top1;
    segCount = segCount + 1;
    segI0[segCount] = i0; segI1[segCount] = bestI; segT0[segCount] = top0; segT1[segCount] = edgeTop;
    segCount = segCount + 1;
  }

  let distKm = dTotal / 1000.0;
  let fspl = 32.44 + 20.0 * log10f(distKm) + 20.0 * log10f(params.frequencyMhz);
  let rxPower = params.txPowerDbm + params.txGainDbi + params.rxGainDbi - (fspl + lossDb);
  let margin = rxPower - params.rxSensitivityDbm;

  var code = 2u; // unlikely
  if (margin >= params.marginGreenDb) {
    code = 0u; // likely
  } else if (margin >= params.marginMarginalDb && (!hasWorst || worstRatio >= 0.0)) {
    code = 1u; // marginal
  } else if (hasWorst && worstRatio < 0.0) {
    code = 3u; // blocked
  }
  outCodes[idx] = code;
  outMargins[idx] = margin;
}
