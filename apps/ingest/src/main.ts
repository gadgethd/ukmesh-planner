/**
 * Source snapshot ingester.
 *
 * Stage 2 implementation: reads `planner_export.public_repeaters_v1` /
 * `public_observed_links_v1` / `visibility_fence_v1` through the dedicated
 * `ukmesh_planner_reader` role (SELECT-only, ≤2 connections), validates the
 * privacy fence, and publishes sanitized snapshots into the planner datastore.
 *
 * Stage 1: configuration skeleton only — deliberately performs NO database
 * work and touches no live service. Run with `--once` for a single pass.
 */

const once = process.argv.includes('--once');

const report = {
  service: 'ukmesh-planner-ingest',
  stage: 'skeleton',
  mode: once ? 'once' : 'loop',
  configured: {
    sourceDb: Boolean(process.env['SOURCE_DB_READONLY_URL']),
    plannerDb: Boolean(process.env['PLANNER_DB_URL']),
  },
  note: 'stage-1 skeleton: no database work performed',
};

// eslint-disable-next-line no-console
console.log(JSON.stringify(report, null, 2));

if (once) {
  process.exit(0);
} else {
  // Keep-alive holder for container deployments; real schedule arrives in Stage 2.
  setInterval(() => {
    /* scheduled ingestion lands here */
  }, 60_000);
}
