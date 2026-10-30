# RF ranking service (external, experimental)

The planner can optionally consume a **separate** RF ranking service. This document defines the
contract only; the service does not live in this repository and is not deployed by it.

## Why external

The ranking model is a research artefact with its own lifecycle, Python runtime and DEM dependency. It
lives in its own project so that changing or withdrawing the model never changes this application's
build, tests or deployment.

## Enablement

Disabled by default. The routes exist only when a URL is passed explicitly:

```ts
buildApp({ experimentalRank: { url: 'http://127.0.0.1:8799', timeoutMs: 5000 } })
```

With no URL the endpoints return 404, exactly as if they were never added.

## Endpoints

| method | path | purpose |
|---|---|---|
| `POST` | `/api/v1/experimental/rank` | validate and proxy a ranking request |
| `GET` | `/api/v1/experimental/rank/health` | service liveness and model identity |

## Request

```json
{
  "candidate": {"lat": 54.97, "lon": -1.61, "antenna_height_m": 10, "role": 2},
  "repeaters": [{"id": "A", "lat": 54.9, "lon": -1.7, "antenna_height_m": null, "role": 2}],
  "top_k": 20
}
```

Bounds enforced here: valid coordinates, 1–500 repeaters, `top_k` 1–100.

## Response

```json
{
  "model": {"version": "...", "artifact_sha256": "..."},
  "semantics": "relative link ranking only; no probability, no guaranteed connectivity",
  "candidate": {"lat": 54.97, "lon": -1.61, "metadata_complete": true},
  "ranking": [
    {"repeater_id": "A", "rank": 1, "score": 0.87,
     "terms": {"distance_km": 12.4, "itm_path_loss_db": 128.1,
               "itm_band_score": -117.6, "b_rank_score": 0.19,
               "heightflag_rank_score": 0.38},
     "warnings": []}
  ],
  "warnings": []
}
```

`score` is a **relative rank within this candidate's list**, not a probability. The UI must present
"more promising candidate link", never a percentage or a connectivity guarantee.

## Failure handling

| condition | planner response |
|---|---|
| service unreachable / 5xx | `502` |
| timeout | `504` |
| invalid request | `400` before any network call |
| service absent | route not mounted (`404`) |

Core planner features must never depend on this route.

## Deployment

1. Run the ranking service on the planner host, bound to loopback.
2. Set the URL in the API configuration.
3. Keep it behind a feature flag in the UI.

**Not authorised by this document.** No deployment, no production enablement.
