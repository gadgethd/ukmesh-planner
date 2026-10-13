import { buildApp } from './app.js';
import { makePlannerStore } from './snapshot.js';

const port = Number(process.env['PORT'] ?? 8080);
const host = process.env['HOST'] ?? '0.0.0.0';
const dbUrl = process.env['PLANNER_DB_URL'] ?? '';
const rateLimit = {
  windowMs: Number(process.env['RATE_LIMIT_WINDOW_MS'] ?? 60_000),
  max: Number(process.env['RATE_LIMIT_MAX'] ?? 240),
};

const store = dbUrl ? makePlannerStore(dbUrl) : null;
const app = buildApp(
  store
    ? {
        getSnapshotMeta: () => store.getSnapshotMeta(),
        getRepeaters: store.getRepeaters.bind(store),
        getObservedLinks: store.getObservedLinks.bind(store),
        rateLimit,
      }
    : { rateLimit },
);

app
  .listen({ port, host })
  .then((address) => {
    // eslint-disable-next-line no-console
    console.log(`[ukmesh-planner-api] listening on ${address}`);
  })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[ukmesh-planner-api] failed to start', err);
    process.exit(1);
  });

async function shutdown(): Promise<void> {
  await store?.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
