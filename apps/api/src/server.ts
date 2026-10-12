import { buildApp } from './app.js';

const port = Number(process.env['PORT'] ?? 8080);
const host = process.env['HOST'] ?? '0.0.0.0';

const app = buildApp();

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
