#!/usr/bin/env python3
"""Experimental UKMesh planner ranking service (isolated, read-only, CPU).

Ranks a proposed repeater's candidate links to existing repeaters using the frozen
realworld1 ensemble: rank-average(distance, B, ITM_bandcorrected, heightflag).

HTTP:
  GET  /healthz  -> model identity, no data
  POST /rank     -> {"candidate": {...}, "repeaters": [...], "top_k": 20}

Hard rules:
  * never returns a probability, percentage or guaranteed-connectivity claim
  * deterministic: ties broken by distance then repeater id
  * missing metadata is tolerated and reported, never invented
  * no database access; inputs come from the caller
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import lightgbm as lgb

MODEL_DIR = Path(os.environ.get("RANK_MODEL_DIR", Path(__file__).parent / "model"))
SERVE_DIR = Path(os.environ.get("RANK_SERVE_DIR",
                                "/home/ben/meshcore-ml-research/campaigns/post-beta-validation/webui"))
MAX_REPEATERS = 500
MAX_DISTANCE_KM = 200.0
MODEL_VERSION = "realworld1-candidate-v"

sys.path.insert(0, str(SERVE_DIR))
import serve_lib  # noqa: E402

FEAT = serve_lib.Featurizer(str(SERVE_DIR / "data" / "uk_mosaic.i2"),
                            str(SERVE_DIR / "data" / "uk_mosaic.json"))
NAMES = list(serve_lib.S.FT_COLS) + list(serve_lib.S.PF_COLS)
assert len(NAMES) == 51, len(NAMES)

B_BOOST = lgb.Booster(model_file=str(MODEL_DIR / "b_rank.txt"))
HF_BOOST = lgb.Booster(model_file=str(MODEL_DIR / "hf_rank.txt"))
BANDS = json.loads((MODEL_DIR / "BANDS.json").read_text())
MU = np.asarray(BANDS["mu_db"], dtype=np.float64)
MODEL_SHA = hashlib.sha256((MODEL_DIR / "b_rank.txt").read_bytes()).hexdigest()


class BadRequest(Exception):
    pass


def _fin(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _haversine(lat1, lon1, lat2, lon2):
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _bearing(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _features(lat1, lon1, lat2, lon2):
    ft, pf, _ = FEAT.features(lat1, lon1, lat2, lon2)
    return np.hstack([ft, pf]).astype(np.float32)


def _rankdata(x):
    order = np.argsort(x, kind="mergesort")
    ranks = np.empty(len(x), np.float64)
    ranks[order] = np.arange(len(x), dtype=np.float64)
    # average ties
    _, inv, counts = np.unique(x, return_inverse=True, return_counts=True)
    sums = np.zeros(len(counts))
    np.add.at(sums, inv, ranks)
    return (sums / counts)[inv]


def _pct(x):
    return (_rankdata(np.asarray(x, dtype=np.float64)) + 0.5) / len(x)


def rank(payload: dict) -> dict:
    cand = payload.get("candidate")
    reps = payload.get("repeaters")
    if not isinstance(cand, dict):
        raise BadRequest("candidate must be an object")
    if not isinstance(reps, list):
        raise BadRequest("repeaters must be a list")
    if len(reps) == 0:
        raise BadRequest("repeaters must not be empty")
    if len(reps) > MAX_REPEATERS:
        raise BadRequest(f"at most {MAX_REPEATERS} repeaters per request")

    lat = _fin(cand.get("lat"))
    lon = _fin(cand.get("lon"))
    if lat is None or lon is None or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        raise BadRequest("candidate lat/lon invalid")
    ch = _fin(cand.get("antenna_height_m"))
    c_role = _fin(cand.get("role"))
    c_role = 2.0 if c_role is None else c_role

    top_k = payload.get("top_k", 20)
    try:
        top_k = int(top_k)
    except (TypeError, ValueError):
        raise BadRequest("top_k must be an integer")
    top_k = max(1, min(top_k, len(reps)))

    warnings = []
    if ch is None:
        warnings.append("candidate antenna height unknown; scored with missing-height handling")
    if c_role != 2:
        warnings.append("candidate role is not repeater (role=2)")

    rows = []
    for r in reps:
        rid = r.get("id")
        if not isinstance(rid, str) or not rid:
            raise BadRequest("every repeater needs a non-empty string id")
        rlat, rlon = _fin(r.get("lat")), _fin(r.get("lon"))
        if rlat is None or rlon is None:
            raise BadRequest(f"repeater {rid}: invalid coordinates")
        rh = _fin(r.get("antenna_height_m"))
        rrole = _fin(r.get("role"))
        rrole = -1.0 if rrole is None else rrole
        rows.append((rid, rlat, rlon, rh, rrole))

    if any(r[3] is None or not math.isfinite(r[3]) for r in rows):
        warnings.append(f"{sum(1 for r in rows if r[3] is None or not math.isfinite(r[3]))} existing repeater(s) "
                        "have no antenna-height metadata; scored with missing-height handling")

    ids = [x[0] for x in rows]
    if len(set(ids)) != len(ids):
        raise BadRequest("repeater ids must be unique")

    dist = np.array([_haversine(lat, lon, r[1], r[2]) for r in rows], dtype=np.float64)
    if (dist > MAX_DISTANCE_KM).any():
        warnings.append(f"{int((dist > MAX_DISTANCE_KM).sum())} candidate(s) exceed the validated "
                        f"{MAX_DISTANCE_KM:.0f} km range; scores are extrapolation")
    if (dist < 0.2).any():
        warnings.append(f"{int((dist < 0.2).sum())} candidate(s) are closer than the 200 m floor")

    X = np.stack([_features(lat, lon, r[1], r[2]) for r in rows])
    itm = X[:, NAMES.index("t_path_loss_db")].astype(np.float64)
    fspl = X[:, NAMES.index("fspl")].astype(np.float64)
    band = np.minimum((dist // 10).astype(int), 20)

    bh = np.array([ch if ch is not None else np.nan for _ in rows], dtype=np.float64)
    rh = np.array([r[3] if r[3] is not None else np.nan for r in rows], dtype=np.float64)
    role_a = np.full(len(rows), c_role, np.float64)
    role_b = np.array([r[4] for r in rows], np.float64)
    both = ((role_a == 2) & (role_b == 2)).astype(np.float64)
    ant_known = (np.isfinite(bh) & np.isfinite(rh)).astype(np.float64)
    delev = np.full(len(rows), np.nan)  # candidate elevation metadata not supplied

    def col(name):
        return X[:, NAMES.index(name)] if name in NAMES else None

    Xb = np.column_stack([X, bh, rh, role_a, role_b, both]).astype(np.float32)
    Xhf = np.column_stack([X, dist, np.array([_bearing(lat, lon, r[1], r[2]) for r in rows]),
                           delev, ant_known, role_a, role_b, both]).astype(np.float32)
    assert Xb.shape[1] == 56 and Xhf.shape[1] == 58

    b = B_BOOST.predict(Xb, num_threads=1).astype(np.float64)
    hf = HF_BOOST.predict(Xhf, num_threads=1).astype(np.float64)
    itm_bc = MU[band] - itm

    terms = {"distance": -dist, "B": b, "ITM_bc": itm_bc, "heightflag": hf}
    score = np.mean([_pct(v) for v in terms.values()], axis=0)

    order = sorted(range(len(rows)), key=lambda i: (-score[i], dist[i], ids[i]))
    out = []
    for pos, i in enumerate(order[:top_k], start=1):
        w = []
        if not np.isfinite(rh[i]):
            w.append("existing repeater antenna height unknown")
        if dist[i] > MAX_DISTANCE_KM:
            w.append("outside validated distance range")
        out.append({
            "repeater_id": ids[i],
            "rank": pos,
            "score": round(float(score[i]), 6),
            "terms": {
                "distance_km": round(float(dist[i]), 3),
                "itm_path_loss_db": round(float(itm[i]), 2),
                "itm_band_score": round(float(itm_bc[i]), 2),
                "b_rank_score": round(float(b[i]), 6),
                "heightflag_rank_score": round(float(hf[i]), 6),
            },
            "warnings": w,
        })

    return {
        "model": {"version": MODEL_VERSION, "artifact_sha256": MODEL_SHA,
                  "features": 51, "ensemble": "rank-avg(distance, B, ITM_bc, heightflag)"},
        "semantics": "relative link ranking only; no probability, no guaranteed connectivity",
        "candidate": {"lat": lat, "lon": lon,
                      "antenna_height_m": ch, "role": c_role,
                      "metadata_complete": bool(ch is not None and np.isfinite(ch))},
        "ranking": out,
        "warnings": warnings,
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            self._send(200, {"ok": True, "model": MODEL_VERSION, "artifact_sha256": MODEL_SHA})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/rank":
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n <= 0 or n > 2_000_000:
                raise BadRequest("invalid body length")
            payload = json.loads(self.rfile.read(n))
            self._send(200, rank(payload))
        except BadRequest as e:
            self._send(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": f"internal error: {type(e).__name__}"})

    def log_message(self, fmt, *args):
        sys.stderr.write("[rank] " + (fmt % args) + "\n")


def main():
    host = os.environ.get("RANK_HOST", "127.0.0.1")
    port = int(os.environ.get("RANK_PORT", "8799"))
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"[rank] listening on {host}:{port} model {MODEL_VERSION} sha {MODEL_SHA[:12]}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
