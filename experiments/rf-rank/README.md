# Experimental RF ranking service (`experiments/rf-rank`)

**Status: experimental. Not deployed. Not a production endpoint. Not enabled by default.**

This directory contains the isolated implementation of the frozen `realworld1` ranking ensemble, built
to evaluate whether it improves repeater-placement decisions. It is deliberately out-of-process: the
model and its Python featuriser are research artefacts, not part of this application's runtime
contract.

## What it does

Given a proposed repeater location and a list of existing repeaters, it returns the candidate's links
to those repeaters **ranked by relative promise**:

```
rank-avg( distance, Model B, ITM_bandcorrected, heightflag )
```

Each term is converted to a percentile rank within the candidate's own list, then averaged with equal
weights. Ties break on distance, then repeater id.

## What it must never claim

The response contains **no probability, percentage or guaranteed-connectivity claim**. The field
`semantics` states this. A high rank means "more promising candidate link than the others in this
list", not "this link will work". The underlying label in training was *recorded adjacency*, and only
5.2% of positives had decoded-path corroboration.

## Model identity

| item | value |
|---|---|
| candidate | `realworld1-candidate-v` |
| B booster | `model/b_rank.txt`, sha256 `c3e5aeff5283a3276c0e1c43…` |
| heightflag booster | `model/hf_rank.txt`, sha256 `b3c3e0837bddf686e9a8a8f2…` |
| band table | `model/BANDS.json`, sha256 `6dc0598a6435c11e0b78ebb8…` |
| features | 51 terrain/DEM features + 5 (B) / 7 (HF) metadata columns |
| environment | Python 3.12, lightgbm 4.7.0, numpy 2.5.4 |

## Runtime requirements

- The **51-feature featuriser** from the research workspace
  (`campaigns/post-beta-validation/webui/serve_lib.py`) and its DEM mosaic (~3.8 GB, external).
  Set `RANK_SERVE_DIR` to that directory (default points at the research box layout).
- `RANK_MODEL_DIR` defaults to `./model`.
- CPU only; no GPU, no network, no database.

```bash
RANK_SERVE_DIR=/path/to/webui RANK_PORT=8799 python rank_service.py
curl -s localhost:8799/healthz
curl -s -X POST localhost:8799/rank -H 'Content-Type: application/json' -d @request.json
```

## Request / response

```json
{
  "candidate": {"lat": 54.97, "lon": -1.61, "antenna_height_m": 10, "role": 2},
  "repeaters": [{"id": "A", "lat": 54.9, "lon": -1.7, "antenna_height_m": null, "role": 2}],
  "top_k": 20
}
```

Response: `model` identity, `semantics`, `candidate` metadata completeness, `ranking[]` with
`rank`, `score`, `terms` (distance, ITM path loss, band score, B score, heightflag score) and
`warnings[]` (missing metadata, out-of-range distance, sub-200 m pairs).

## Measured performance (research box, single thread)

- 60 repeaters: **26.4 ms median** end-to-end (0.44 ms/candidate), p95 28.3 ms
- Peak RSS **717 MB**, dominated by the memory-mapped DEM mosaic
- Includes terrain sampling for every candidate and both boosters

## Tests

```bash
python -m unittest discover -s experiments/rf-rank/tests -v   # 14 tests
```

Covers determinism, tie-breaking, top-k, missing metadata, invalid coordinates, empty/duplicate
candidates, no-probability language, range warnings and finite terms.

## Integration path (not done here)

A native planner integration needs the 51-feature vector in TypeScript, or a precomputed feature
export per candidate. This service exists to evaluate the ranking behaviour first; it is not the
shape of the eventual production integration. See
`~/meshcore-ml-research/campaigns/planner-validation1/INTEGRATION.md`.

## Provenance

- Campaign: `~/meshcore-ml-research/campaigns/planner-validation1/`
- Parent evidence: `campaigns/realworld1/` (FINAL-REPORT, SEALED-SCORE, NEGATIVE-RESULTS)
- Model never retrained after the sealed evaluation; this is a frozen artefact.
