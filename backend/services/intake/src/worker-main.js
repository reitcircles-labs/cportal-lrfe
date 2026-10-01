// Standalone extraction worker: `npm run worker -w @lrfe/intake`. Same .env as the service.
// `node src/worker-main.js --once` processes the queue until empty, then exits.
import { setupFromEnv } from './setup.js';

const { worker, checks, sequelize } = setupFromEnv();
for (const check of checks) await check();

if (process.argv.includes('--once')) {
    const n = await worker.drain();
    console.log(`processed ${n} job(s)`);
    await sequelize?.close();
} else {
    worker.start();
    const stop = async () => { worker.stop(); await sequelize?.close(); process.exit(0); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
}
