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
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> dem: array<f32>;
@group(0) @binding(2) var<storage, read_write> outMargins: array<f32>;
@group(0) @binding(3) var<storage, read_write> outCodes: array<u32>;

fn lonLatToGlobalPx(lon: f32, lat: f32) -> vec2f {
  let x = (lon + 180.0) / 360.0 * WORLD_PX;
  let latRad = lat * PI_F / 180.0;
  let y = (1.0 - log(tan(latRad) + 1.0 / cos(latRad)) / PI_F) / 2.0 * WORLD_PX;
  return vec2f(x, y);
}

fn globalPxToLonLat(p: vec2f) -> vec2f {
  let lon = p.x / WORLD_PX * 360.0 - 180.0;
  let nn = PI_F - 2.0 * PI_F * (p.y / WORLD_PX);
  let lat = 180.0 / PI_F * atan(0.5 * (exp(nn) - exp(-nn)));
  return vec2f(lon, lat);
}

fn haversineM(a: vec2f, b: vec2f) -> f32 {
  let p1 = a.y * PI_F / 180.0;
  let p2 = b.y * PI_F / 180.0;
  let dPhi = (b.y - a.y) * PI_F / 180.0;
  var dLam = (b.x - a.x) * PI_F / 180.0;
  if (dLam > PI_F) { dLam -= 2.0 * PI_F; }
  if (dLam < -PI_F) { dLam += 2.0 * PI_F; }
  let s = sin(dPhi / 2.0) * sin(dPhi / 2.0) + cos(p1) * cos(p2) * sin(dLam / 2.0) * sin(dLam / 2.0);
  return 2.0 * R_EARTH_M * asin(min(1.0, sqrt(s)));
}

// Great-circle interpolation — mirrors rf-core interpolateGreatCircle.
fn slerp(a: vec2f, b: vec2f, f: f32, dRad: f32) -> vec2f {
  if (dRad == 0.0) { return a; }
  let p1 = a.y * PI_F / 180.0;
  let l1 = a.x * PI_F / 180.0;
  let p2 = b.y * PI_F / 180.0;
  let l2 = b.x * PI_F / 180.0;
  let sinD = sin(dRad);
  let A = sin((1.0 - f) * dRad) / sinD;
  let B = sin(f * dRad) / sinD;
  let x = A * cos(p1) * cos(l1) + B * cos(p2) * cos(l2);
  let y = A * cos(p1) * sin(l1) + B * cos(p2) * sin(l2);
  let z = A * sin(p1) + B * sin(p2);
  var lon = degrees(atan2(y, x));
  if (lon > 180.0) { lon -= 360.0; }
  if (lon < -180.0) { lon += 360.0; }
  return vec2f(lon, degrees(atan2(z, sqrt(x * x + y * y))));
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
  if (v00 != v00 || v10 != v10 || v01 != v01 || v11 != v11) { return bitcast<f32>(0x7fc00000u); }
  let top = v00 * (1.0 - fx) + v10 * fx;
  let bottom = v01 * (1.0 - fx) + v11 * fx;
  return top * (1.0 - fy) + bottom * fy;
}

fn knifeEdgeLossDb(v: f32) -> f32 {
  if (v <= -0.7) { return 0.0; }
  let t = v - 0.1;
  return 6.9 + 20.0 * log10(sqrt(t * t + 1.0) + t);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let cx = gid.x;
  let cy = gid.y + u32(params.rowOffset);
  if (cx >= u32(params.outW) || cy >= u32(params.outH)) { return; }
  let idx = cy * u32(params.outW) + cx;

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
    outMargins[idx] = bitcast<f32>(0x7fc00000u);
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
    outMargins[idx] = bitcast<f32>(0x7fc00000u);
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
      let effT = t + di * dj / (2.0 * R_EFF_M);
      let h = effT - lineAtI;
      if (h <= 0.0) { continue; }
      let v = h * sqrt((2.0 * (1.0 / di + 1.0 / dj)) / lambdaM);
      if (v > bestV) { bestV = v; bestI = i; }
    }

    if (bestI < 0 || bestV <= -0.7) { continue; }
    lossDb = lossDb + knifeEdgeLossDb(bestV);
    edges = edges + 1;

    let diB = dTotal * f32(bestI) / nf - d0;
    let djB = d1m - dTotal * f32(bestI) / nf;
    let edgeTop = prof[bestI] + diB * djB / (2.0 * R_EFF_M);
    // Push right then left; pops take left first — same order as the CPU.
    segI0[segCount] = bestI; segI1[segCount] = i1; segT0[segCount] = edgeTop; segT1[segCount] = top1;
    segCount = segCount + 1;
    segI0[segCount] = i0; segI1[segCount] = bestI; segT0[segCount] = top0; segT1[segCount] = edgeTop;
    segCount = segCount + 1;
  }

  let distKm = dTotal / 1000.0;
  let fspl = 32.44 + 20.0 * log10(distKm) + 20.0 * log10(params.frequencyMhz);
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
