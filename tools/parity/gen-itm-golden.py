#!/usr/bin/env python3
"""Generate golden values for the rf-core ITM port (`packages/rf-core/src/itm.ts`).

The model under test is the MeshCore-analytics scalar path-loss model.  This
script carries a verbatim copy of ``compute_path_loss_from_profile`` from
``ukmesh-planner-work/reference/loss.py`` (lines ~282-350) and of the profile
sampling convention from ``compute_path_loss`` (lines ~223-267), with only
these changes:

  * the ``rf.config`` imports are replaced by literal constants (identical
    values; see the copy of config.py constants below);
  * ``current_usable_path_loss_db()`` is parameterised so the fixture can
    cover the default (137.5 dB) and a calibrated (139.5 dB) threshold;
  * the ``@dataclass`` result wrapper and the ``include_profile`` tuple are
    dropped - the function returns ``(path_loss_db, viable)``;
  * ``osgeo``/gdal is never imported (not installed on this VM); the sampled
    terrain read is replaced by ``elevation_at(lat, lon)`` - the same
    contract as the TypeScript port's sampler.

``replicate_max_v`` mirrors the reference's own max_v computation (same
filter and branch conditions, same formulas) because the scalar function
does not return it.  Where the reference returns before computing vs, the
sentinel -999.0 is returned - the same value its prefix implementation
initialises max_v to (loss.py, compute_prefix_path_losses).

Usage (from the repo root; deterministic, no arguments):

    python3 tools/parity/gen-itm-golden.py > packages/rf-core/src/itm.fixture.json

JSON goes to stdout; per-case diagnostics and corpus assertions go to stderr.
Non-finite numbers appear as the strings "NaN" / "Infinity" / "-Infinity"
(JSON cannot represent them); the test decodes those.

Known deviation: the reference's gdal path casts the sampled profile arrays to
float32 before calling the scalar model (loss.py ~line 274).  The port keeps
float64 (it has no float32 stage), so this generator also feeds float64 -
both sides then see identical inputs up to the platform cos() ulp.
"""
from __future__ import annotations

import json
import math
import random
import sys

import numpy as np

SEED = 20261013
THRESHOLDS_DB = [137.5, 139.5]

# --- constants from ukmesh-planner-work/reference/config.py -------------------
LINK_LOS_MAX_V = 1.12
K_FACTOR = 4 / 3
R_EARTH_M = 6_371_000
FREQ_MHZ = 868.0
LAMBDA_M = 3e8 / (FREQ_MHZ * 1e6)
PROFILE_STEP_M = 100.0
DEFAULT_USABLE_PATH_LOSS_DB = 137.5
PATH_LOSS_BIAS_DB = 0.0
TERRAIN_ROUGHNESS_FACTOR = 0.08
NO_MAX_V = -999.0


def current_usable_path_loss_db(usable_threshold_db: float | None = None) -> float:
    return float(DEFAULT_USABLE_PATH_LOSS_DB if usable_threshold_db is None else usable_threshold_db)


def compute_path_loss_from_profile(dists, heights, h_tx, h_rx, *, usable_threshold_db=None):
    """Verbatim copy of reference loss.py compute_path_loss_from_profile."""
    if len(dists) != len(heights) or len(dists) == 0:
        return float('inf'), False
    finite = np.isfinite(dists) & np.isfinite(heights)
    if np.count_nonzero(finite) < 2:
        return float('inf'), False
    dists = dists[finite]
    heights = heights[finite]
    order = np.argsort(dists)
    dists = dists[order]
    heights = heights[order]
    d_total = float(dists[-1])
    usable = current_usable_path_loss_db(usable_threshold_db)
    if d_total < 1.0:
        return 0.0, True

    fspl = 20 * math.log10(4 * math.pi * d_total / LAMBDA_M)

    if len(dists) <= 2:
        viable = fspl < usable
        return fspl, viable

    d1 = dists[1:-1].astype(np.float64)
    d2 = d_total - d1
    valid = (d1 > 0) & (d2 > 0)
    if not np.any(valid):
        viable = fspl < usable
        return fspl, viable

    d1 = d1[valid]
    d2 = d2[valid]
    profile_h = heights[1:-1].astype(np.float64)[valid]
    los_h = h_tx + (h_rx - h_tx) * (d1 / d_total)
    earth_bulge = (d1 * d2) / (2 * K_FACTOR * R_EARTH_M)
    excess_h = profile_h + earth_bulge - los_h
    with np.errstate(divide='ignore', invalid='ignore'):
        vs = excess_h * np.sqrt(2 * (d1 + d2) / (LAMBDA_M * d1 * d2))
    max_v = float(np.max(vs)) if vs.size else NO_MAX_V

    if max_v <= -0.78:
        diff_loss = 0.0
    else:
        diff_loss = max(0.0, 6.9 + 20 * math.log10(
            math.sqrt((max_v - 0.1) ** 2 + 1) + max_v - 0.1
        ))

    terrain_roughness = float(np.percentile(np.abs(np.diff(heights)), 75)) if len(heights) > 3 else 0.0
    roughness_loss = min(6.0, math.log1p(max(0.0, terrain_roughness)) * TERRAIN_ROUGHNESS_FACTOR)
    total_loss = max(fspl, fspl + diff_loss + roughness_loss + PATH_LOSS_BIAS_DB)
    clear_los = max_v <= LINK_LOS_MAX_V
    viable = clear_los and total_loss < usable
    return total_loss, viable


def replicate_max_v(dists, heights, h_tx, h_rx) -> float:
    """Mirror of the reference's max_v computation (loss.py lines ~319-334).

    The value is only produced where the scalar model reaches the interior
    Fresnel loop; every earlier return yields the -999.0 sentinel.
    """
    if len(dists) != len(heights) or len(dists) == 0:
        return NO_MAX_V
    finite = np.isfinite(dists) & np.isfinite(heights)
    if np.count_nonzero(finite) < 2:
        return NO_MAX_V
    dists = dists[finite]
    heights = heights[finite]
    order = np.argsort(dists)
    dists = dists[order]
    heights = heights[order]
    d_total = float(dists[-1])
    if d_total < 1.0:
        return NO_MAX_V
    if len(dists) <= 2:
        return NO_MAX_V
    d1 = dists[1:-1].astype(np.float64)
    d2 = d_total - d1
    valid = (d1 > 0) & (d2 > 0)
    if not np.any(valid):
        return NO_MAX_V
    d1 = d1[valid]
    d2 = d2[valid]
    profile_h = heights[1:-1].astype(np.float64)[valid]
    los_h = h_tx + (h_rx - h_tx) * (d1 / d_total)
    earth_bulge = (d1 * d2) / (2 * K_FACTOR * R_EARTH_M)
    excess_h = profile_h + earth_bulge - los_h
    with np.errstate(divide='ignore', invalid='ignore'):
        vs = excess_h * np.sqrt(2 * (d1 + d2) / (LAMBDA_M * d1 * d2))
    return float(np.max(vs)) if vs.size else NO_MAX_V


def clean_height(h) -> float:
    """Reference sanitising (loss.py ~262-265): bad samples become 0, clamp >= 0."""
    h = float(h)
    if not math.isfinite(h) or h < -500 or h > 9_000:
        h = 0.0
    return max(0.0, h)


def sample_itm_profile(lat1, lon1, lat2, lon2, elevation_at):
    """Mirror of the reference sampling convention (loss.py ~223-267)."""
    cos_mid = math.cos(math.radians((lat1 + lat2) / 2))
    dlat = (lat2 - lat1) * 111_320
    dlon = (lon2 - lon1) * 111_320 * cos_mid
    d_total = math.sqrt(dlat * dlat + dlon * dlon)

    if d_total < 1.0:
        return [0.0], [clean_height(elevation_at(lat1, lon1))]

    n_samples = max(20, min(200, int(d_total / PROFILE_STEP_M)))
    heights: list[float] = []
    dists: list[float] = []
    for i in range(n_samples + 1):
        t = i / n_samples
        la = lat1 + t * (lat2 - lat1)
        lo = lon1 + t * (lon2 - lon1)
        heights.append(clean_height(elevation_at(la, lo)))
        dists.append(t * d_total)
    return dists, heights


# --- elevation fixture for the "sampled" cases (reproduced by the TS test) ---
def make_node_sampler(nodes):
    """Piecewise-linear elevation in latitude, flat outside the node range.

    Only IEEE basic operations are used, so the TypeScript replica in
    itm.test.ts produces bit-identical heights.
    """
    def elevation_at(lat, _lon):
        if lat <= nodes[0][0]:
            return float(nodes[0][1])
        for idx in range(len(nodes) - 1):
            la0, h0 = nodes[idx]
            la1, h1 = nodes[idx + 1]
            if lat <= la1:
                return float(h0 + (h1 - h0) * (lat - la0) / (la1 - la0))
        return float(nodes[-1][1])

    return elevation_at


SAMPLED_RIDGE_NODES = [
    [53.0, 120.0],
    [53.03, 170.0],
    [53.045, 355.0],
    [53.06, 210.0],
    [53.09, 150.0],
]
SAMPLED_SHORT_NODES = [
    [53.0, 95.0],
    [53.004, 180.0],
    [53.008, 120.0],
    [53.01, 105.0],
]
SAMPLED_LONG_NODES = [
    [53.0, 90.0],
    [53.06, 140.0],
    [53.12, 700.0],
    [53.17, 110.0],
]
SAMPLED_CLAMP_NODES = [
    [53.0, -600.0],
    [53.0015, 9500.0],
    [53.003, -30.0],
    [53.005, 2800.0],
]


# --- case construction --------------------------------------------------------
def profile_case(name, dists, heights, h_tx, h_rx):
    return {
        'name': name,
        'kind': 'profile',
        'dists': [float(d) for d in dists],
        'heights': [float(h) for h in heights],
        'h_tx': float(h_tx),
        'h_rx': float(h_rx),
    }


def sampled_case(name, lat_a, lon_a, lat_b, lon_b, nodes, h_tx, h_rx):
    return {
        'name': name,
        'kind': 'sampled',
        'lat_a': float(lat_a),
        'lon_a': float(lon_a),
        'lat_b': float(lat_b),
        'lon_b': float(lon_b),
        'elevation_nodes': [[float(la), float(h)] for la, h in nodes],
        'h_tx': float(h_tx),
        'h_rx': float(h_rx),
    }


def build_fixed_cases():
    cases = []
    add = cases.append

    # Flat 5 km, no relief: roughness 0 and a clear chord (antennas above
    # the 50 m plateau, so max_v < 0 and the FSPL dominates).
    add(profile_case('flat-5km-21pt', [i * 250.0 for i in range(21)], [50.0] * 21, 58.0, 56.0))

    # Rolling 20 km terrain with tall masts clearing the summits: roughness
    # present, max_v < 0 - a realistic "viable" rural link.
    add(profile_case(
        'rolling-20km-viable-101pt',
        [i * 200.0 for i in range(101)],
        [100.0 + 40.0 * math.sin(i / 7.0) for i in range(101)],
        155.0, 152.0,
    ))

    # Single Gaussian ridge at mid-path (~10 km).
    add(profile_case(
        'single-ridge-10km-41pt',
        [i * 250.0 for i in range(41)],
        [50.0 + 350.0 * math.exp(-(((i - 20) / 3.0) ** 2)) for i in range(41)],
        5.0, 12.0,
    ))

    # Deep valley (terrain dips ~300 m below the endpoints).
    add(profile_case(
        'deep-valley-12p5km-51pt',
        [i * 250.0 for i in range(51)],
        [320.0 - 300.0 * math.exp(-(((i - 25) / 8.0) ** 2)) for i in range(51)],
        30.0, 30.0,
    ))

    # Two ridges of different heights (~15 km).
    add(profile_case(
        'two-ridges-15km-61pt',
        [i * 250.0 for i in range(61)],
        [
            80.0
            + 300.0 * math.exp(-(((i - 15) / 3.0) ** 2))
            + 250.0 * math.exp(-(((i - 45) / 3.5) ** 2))
            for i in range(61)
        ],
        8.0, 8.0,
    ))

    # Monotonic slope, low TX / high RX.
    add(profile_case(
        'monotonic-slope-15km-51pt',
        [i * 300.0 for i in range(51)],
        [i * 12.0 for i in range(51)],
        2.0, 30.0,
    ))

    # Exactly one interior point.
    add(profile_case('three-point-single-interior', [0.0, 2500.0, 5000.0], [100.0, 300.0, 100.0], 5.0, 5.0))

    # Two points: FSPL branch, no diffraction.
    add(profile_case('two-point-800m', [0.0, 800.0], [10.0, 20.0], 5.0, 5.0))

    # One point: fewer than two finite samples -> +inf, not viable.
    add(profile_case('single-point', [0.0], [12.0], 5.0, 5.0))

    # Length mismatch -> reference guard returns +inf, not viable.
    add(profile_case('length-mismatch', [0.0, 500.0, 1000.0], [10.0, 20.0], 5.0, 5.0))

    # Sub-metre separation -> d_total < 1 -> (0.0, True).
    add(profile_case('sub-metre-pair', [0.0, 0.5], [5.0, 5.0], 5.0, 5.0))

    # NaN entries mixed in; two finite pairs remain.
    add(profile_case(
        'nan-mixed-two-finite',
        [0.0, float('nan'), 2000.0, 4000.0],
        [10.0, 30.0, float('nan'), 40.0],
        4.0, 7.0,
    ))

    # +inf / NaN combination; two finite pairs remain.
    add(profile_case(
        'inf-mixed-two-finite',
        [0.0, float('inf'), 1000.0, 12000.0],
        [40.0, float('nan'), 55.0, 60.0],
        20.0, 3.0,
    ))

    # Interior sample at distance 0 -> no valid interior -> FSPL branch.
    add(profile_case('interior-zero-distance', [0.0, 0.0, 5000.0], [10.0, 20.0, 30.0], 5.0, 5.0))

    # Duplicate distances with equal heights (tie order cannot matter).
    add(profile_case('duplicate-points', [0.0, 1000.0, 1000.0, 2000.0], [10.0, 50.0, 50.0, 10.0], 5.0, 5.0))

    # All heights identical over 14 km -> roughness exactly 0.
    add(profile_case('identical-heights-14km-71pt', [i * 200.0 for i in range(71)], [123.0] * 71, 5.0, 5.0))

    # One 3000 m spike on a 10 km path: knife-edge dominated, max_v >> 1.12.
    spike = [30.0] * 41
    spike[20] = 3030.0
    add(profile_case('huge-spike-10km-41pt', [i * 250.0 for i in range(41)], spike, 5.0, 5.0))

    return cases


def build_ridge_straddle_case():
    """45 km ridge profile tuned to sit between the two thresholds with clear LOS.

    Scanning the ridge peak keeps |loss - threshold| comfortable at both
    thresholds and max_v <= 1.10 (< LINK_LOS_MAX_V), so the two threshold
    variants disagree on `viable` - exercising both sides of the formula.
    """
    dists = [i * 450.0 for i in range(101)]
    for step in range(0, 101):
        mid = 14.0 + step * 0.05
        heights = [
            5.0 if abs(i - 50) > 4 else 5.0 + mid * (1.0 - abs(i - 50) / 5.0)
            for i in range(101)
        ]
        arr_d = np.asarray(dists, dtype=np.float64)
        arr_h = np.asarray(heights, dtype=np.float64)
        loss, _ = compute_path_loss_from_profile(arr_d, arr_h, 5.0, 5.0, usable_threshold_db=137.5)
        max_v = replicate_max_v(arr_d, arr_h, 5.0, 5.0)
        if math.isfinite(loss) and 138.2 <= loss <= 139.0 and max_v <= 1.10:
            return profile_case('ridge-straddle-45km-101pt', dists, heights, 5.0, 5.0)
    raise AssertionError('ridge-straddle search found no profile in the target band')


def build_fspl_straddle_case():
    """Two-point path whose FSPL alone sits between the two thresholds."""
    target_db = 138.5
    distance_m = LAMBDA_M / (4 * math.pi) * 10 ** (target_db / 20)
    return profile_case('fspl-straddle-long', [0.0, distance_m], [40.0, 60.0], 30.0, 5.0)


def build_random_cases(rng):
    lengths = [3, 5, 8, 13, 21, 34, 55, 89, 144, 200]
    cases = []
    for idx, n_pts in enumerate(lengths):
        dists = sorted(rng.uniform(500.0, 20000.0) for _ in range(n_pts))
        for i in range(1, n_pts):
            if dists[i] <= dists[i - 1]:
                dists[i] = dists[i - 1] + 1.0
        heights = [rng.uniform(0.0, 800.0) for _ in range(n_pts)]
        cases.append(profile_case(
            f'rand-{idx:02d}-len{n_pts}',
            dists,
            heights,
            rng.uniform(2.0, 30.0),
            rng.uniform(2.0, 30.0),
        ))
    return cases


def build_sampled_cases():
    return [
        sampled_case('sampled-ridge-10km', 53.0, -2.0, 53.09, -2.0, SAMPLED_RIDGE_NODES, 5.0, 5.0),
        sampled_case('sampled-short-1p3km', 53.0, -2.0, 53.01, -2.01, SAMPLED_SHORT_NODES, 5.0, 5.0),
        sampled_case('sampled-long-19km', 53.0, -2.0, 53.17, -2.0, SAMPLED_LONG_NODES, 12.0, 5.0),
        sampled_case('sampled-submetre', 53.0, -2.0, 53.000002, -2.0, SAMPLED_RIDGE_NODES, 5.0, 5.0),
        sampled_case('sampled-clamp-extremes', 53.0, -2.0, 53.005, -2.0, SAMPLED_CLAMP_NODES, 5.0, 5.0),
    ]


def build_cases(rng):
    cases = build_fixed_cases()
    cases.append(build_ridge_straddle_case())
    cases.append(build_fspl_straddle_case())
    cases.extend(build_random_cases(rng))
    cases.extend(build_sampled_cases())
    return cases


# --- golden computation -------------------------------------------------------
def fill_results(case):
    if case['kind'] == 'profile':
        dists = case['dists']
        heights = case['heights']
    else:
        elevation_at = make_node_sampler(case['elevation_nodes'])
        dists, heights = sample_itm_profile(
            case['lat_a'], case['lon_a'], case['lat_b'], case['lon_b'], elevation_at
        )
        case['sampled_dists'] = [float(v) for v in dists]
        case['sampled_heights'] = [float(v) for v in heights]
        guard_sampling(case)

    arr_d = np.asarray(dists, dtype=np.float64)
    arr_h = np.asarray(heights, dtype=np.float64)
    results = []
    for threshold in THRESHOLDS_DB:
        loss, viable = compute_path_loss_from_profile(
            arr_d, arr_h, case['h_tx'], case['h_rx'], usable_threshold_db=threshold
        )
        max_v = replicate_max_v(arr_d, arr_h, case['h_tx'], case['h_rx'])
        results.append({
            'usable_threshold_db': float(threshold),
            'path_loss_db': float(loss),
            'viable': bool(viable),
            'max_v': float(max_v),
        })
    case['results'] = results
    guard_results(case)
    return case


def guard_sampling(case):
    """Keep the sampled cases away from decisions the platform cos() ulp could shift."""
    lat1, lon1 = case['lat_a'], case['lon_a']
    lat2, lon2 = case['lat_b'], case['lon_b']
    cos_mid = math.cos(math.radians((lat1 + lat2) / 2))
    dlat = (lat2 - lat1) * 111_320
    dlon = (lon2 - lon1) * 111_320 * cos_mid
    d_total = math.sqrt(dlat * dlat + dlon * dlon)
    assert abs(d_total - 1.0) > 1e-3, f"{case['name']}: d_total too close to the 1 m cutoff"
    if d_total >= 1.0:
        frac = (d_total / PROFILE_STEP_M) % 1.0
        assert min(frac, 1.0 - frac) > 1e-5, f"{case['name']}: d_total near a sample-count step"


def guard_results(case):
    """Assert no golden value sits on a decision boundary within float noise."""
    for result in case['results']:
        loss = result['path_loss_db']
        max_v = result['max_v']
        threshold = result['usable_threshold_db']
        name = case['name']
        if math.isfinite(loss):
            assert abs(loss - threshold) > 1e-6, f'{name}: loss {loss} too close to threshold {threshold}'
        assert abs(max_v - LINK_LOS_MAX_V) > 1e-6, f'{name}: max_v {max_v} too close to LINK_LOS_MAX_V'
        assert abs(max_v + 0.78) > 1e-6, f'{name}: max_v {max_v} too close to the -0.78 knife-edge cutoff'


def json_safe(value):
    """Encode non-finite floats as JSON strings (JSON has no non-finite literals)."""
    if isinstance(value, float):
        if math.isnan(value):
            return 'NaN'
        if math.isinf(value):
            return 'Infinity' if value > 0 else '-Infinity'
        return value
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    return value


def check_corpus(cases):
    """Assert the corpus covers what the spec requires."""
    names = [case['name'] for case in cases]
    n_random = sum(1 for name in names if name.startswith('rand-'))
    n_sampled = sum(1 for case in cases if case['kind'] == 'sampled')
    assert n_random >= 8, f'only {n_random} random profiles'
    assert n_sampled >= 4, f'only {n_sampled} sampled profiles'

    flat = [result for case in cases for result in case['results']]
    assert any(result['viable'] for result in flat), 'no viable=true golden result'
    assert any(not result['viable'] for result in flat), 'no viable=false golden result'
    assert any(not math.isfinite(result['path_loss_db']) for result in flat), 'no +inf golden result'
    assert any(result['path_loss_db'] == 0.0 for result in flat), 'no d_total<1 zero-loss golden result'
    assert any(result['max_v'] == NO_MAX_V for result in flat), 'no max_v sentinel golden result'
    assert any(result['max_v'] > LINK_LOS_MAX_V for result in flat), 'no max_v>1.12 golden result'
    assert any(0 < result['max_v'] <= LINK_LOS_MAX_V for result in flat), 'no clear-LOS golden result'

    for name in ('ridge-straddle-45km-101pt', 'fspl-straddle-long'):
        case = next(case for case in cases if case['name'] == name)
        v0, v1 = case['results'][0]['viable'], case['results'][1]['viable']
        assert v0 != v1, f'{name}: thresholds do not straddle (viable {v0}/{v1})'

    assert len(set(names)) == len(names), 'duplicate case names'


def main():
    rng = random.Random(SEED)
    cases = [fill_results(case) for case in build_cases(rng)]
    check_corpus(cases)

    fixture = {
        '_note': (
            'Golden values for packages/rf-core/src/itm.ts - generated, do not edit by hand. '
            'Non-finite numbers are encoded as the strings "NaN", "Infinity", "-Infinity".'
        ),
        'generator': 'tools/parity/gen-itm-golden.py',
        'reference': 'ukmesh-planner-work/reference/loss.py (compute_path_loss_from_profile + compute_path_loss sampling; osgeo/gdal import trimmed)',
        'seed': SEED,
        'tolerance_abs': 1e-09,
        'thresholds_db': THRESHOLDS_DB,
        'cases': cases,
    }

    for case in cases:
        loss0, loss1 = case['results'][0]['path_loss_db'], case['results'][1]['path_loss_db']
        v0, v1 = case['results'][0]['viable'], case['results'][1]['viable']
        max_v = case['results'][0]['max_v']
        print(
            f"  {case['name']:<28} loss@137.5={loss0:>10.5f} loss@139.5={loss1:>10.5f} "
            f"viable={int(v0)}/{int(v1)} max_v={max_v:>9.4f}",
            file=sys.stderr,
        )
    n_random = sum(1 for case in cases if case['name'].startswith('rand-'))
    n_sampled = sum(1 for case in cases if case['kind'] == 'sampled')
    print(
        f'  {len(cases)} cases ({n_random} seeded random, {n_sampled} sampled from endpoints)',
        file=sys.stderr,
    )

    json.dump(json_safe(fixture), sys.stdout, indent=2, allow_nan=False)
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
