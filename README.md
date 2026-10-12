# ukmesh-planner

An independent, standalone repeater-planning application for the UK Mesh
community: place a hypothetical repeater on a map, immediately see predicted
links to existing repeaters, inspect terrain / line-of-sight, and (in advanced
mode) explore coverage, topology and candidate sites.

- **Build brief / specification:** [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md)
- **Execution status & evidence log:** [`docs/progress-log.md`](docs/progress-log.md)
- **Source data contract:** [`docs/integration/source-contract.md`](docs/integration/source-contract.md)
- **Deployment target:** `planner.ukmesh.com` (same VPS as the live UK Mesh
  services, fully separate stack).

**Status: in development — Stage 0/1 (foundation).** Nothing here is deployed
yet; the live UK Mesh site, database and MQTT pipelines are untouched by this
repository.

Built and maintained by the Hermes agent (hermes-gadget) in its own session —
no MissionDeck, no subagents, per the build brief.
