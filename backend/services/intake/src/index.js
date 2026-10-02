import { env, envBool, envInt, startService } from '@lrfe/common';
import { buildApp } from './app.js';
import { setupFromEnv } from './setup.js';

const { service, worker, checks, sequelize, jwtSecret } = setupFromEnv();

const app = await buildApp({
    service, jwtSecret,
    linkSecret: env('INTAKE_LINK_SECRET', jwtSecret),
    fileLinkBase: env('INTAKE_FILE_LINK_BASE', '/api/intake/files'),
    maxFileBytes: envInt('INTAKE_MAX_FILE_MB', 50) * 1024 * 1024,
    logger: { level: env('LOG_LEVEL', 'info') }
});
worker.logger = app.log;

// Local work: run the extraction worker inside the service. In production, run `npm run worker`
// separately (and set INTAKE_RUN_WORKER=false here) so extraction scales on its own.
const runWorker = envBool('INTAKE_RUN_WORKER', true);

await startService(app, {
    port: envInt('PORT', 3504),
    checks: [...checks, async () => { if (runWorker) worker.start(); }],
    onClose: async () => { worker.stop(); await sequelize?.close(); }
});
