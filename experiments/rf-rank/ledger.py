#!/usr/bin/env python3
"""Append-only prediction ledger for prospective validation.

Every record is hash-chained: changing or removing an earlier prediction breaks `verify`.
The ledger stores the *prediction as made* — never a retro-fitted outcome.

Record fields:
  seq, ts_utc, candidate_id, model_sha256, input_hash, region,
  request, ranking, notes, prev_hash, hash

Usage:
  python ledger.py append --ledger ledger.jsonl --input request.json [--region NE] [--note "..."]
  python ledger.py verify --ledger ledger.jsonl
  python ledger.py show   --ledger ledger.jsonl [--limit 5]
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path

MODEL_ID = "realworld1-candidate-v"


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha(obj) -> str:
    return hashlib.sha256(canonical(obj).encode()).hexdigest()


def read_all(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for i, line in enumerate(path.read_text().splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError as e:
            raise SystemExit(f"ledger line {i}: invalid JSON ({e})")
    return out


def append(path: Path, request: dict, result: dict, region: str | None, note: str | None) -> dict:
    rows = read_all(path)
    prev = rows[-1]["hash"] if rows else "0" * 64
    body = {
        "seq": len(rows) + 1,
        "ts_utc": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "candidate_id": MODEL_ID,
        "model_sha256": result.get("model", {}).get("artifact_sha256"),
        "input_hash": sha(request),
        "region": region,
        "request": request,
        "ranking": result.get("ranking"),
        "warnings": result.get("warnings", []),
        "notes": note,
        "prev_hash": prev,
    }
    body["hash"] = sha(body)
    with path.open("a") as f:
        f.write(canonical(body) + "\n")
    return body


def verify(path: Path) -> dict:
    rows = read_all(path)
    prev = "0" * 64
    for i, r in enumerate(rows, start=1):
        if r.get("seq") != i:
            return {"ok": False, "error": f"sequence break at line {i}"}
        if r.get("prev_hash") != prev:
            return {"ok": False, "error": f"chain break at line {i}"}
        body = {k: v for k, v in r.items() if k != "hash"}
        if sha(body) != r.get("hash"):
            return {"ok": False, "error": f"hash mismatch at line {i}"}
        prev = r["hash"]
    return {"ok": True, "records": len(rows), "head": prev}


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("append")
    a.add_argument("--ledger", required=True)
    a.add_argument("--input", required=True, help="JSON file with the request payload")
    a.add_argument("--result", required=True, help="JSON file with the service response")
    a.add_argument("--region")
    a.add_argument("--note")
    v = sub.add_parser("verify")
    v.add_argument("--ledger", required=True)
    s = sub.add_parser("show")
    s.add_argument("--ledger", required=True)
    s.add_argument("--limit", type=int, default=5)
    args = ap.parse_args()

    p = Path(args.ledger)
    if args.cmd == "append":
        req = json.loads(Path(args.input).read_text())
        res = json.loads(Path(args.result).read_text())
        rec = append(p, req, res, args.region, args.note)
        print(json.dumps({"seq": rec["seq"], "hash": rec["hash"]}, indent=1))
    elif args.cmd == "verify":
        print(json.dumps(verify(p), indent=1))
    else:
        for r in read_all(p)[-args.limit:]:
            print(json.dumps({k: r[k] for k in ("seq", "ts_utc", "region", "input_hash", "hash")}, indent=1))


if __name__ == "__main__":
    main()
