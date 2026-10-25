import {
  createRevocationList,
  env,
  envBool,
  envInt,
  startService,
} from '@lrfe/common';
import {buildApp} from './app.js';
import {setupFromEnv} from './setup.js';

const {service, worker, checks, sequelize, jwtSecret} = setupFromEnv();

const app = await buildApp({
  service,
  jwtSecret,
  linkSecret: env('INTAKE_LINK_SECRET', jwtSecret),
  fileLinkBase: env('INTAKE_FILE_LINK_BASE', '/api/intake/files'),
  maxFileBytes: envInt('INTAKE_MAX_FILE_MB', 50) * 1024 * 1024,
  revocations: createRevocationList({events: service.events}),
  logger: {level: env('LOG_LEVEL', 'info')},
});
worker.logger = app.log;

// Local work: run the extraction worker inside the service. In production, run `npm run worker`
// separately (and set INTAKE_RUN_WORKER=false here) so extraction scales on its own.
const runWorker = envBool('INTAKE_RUN_WORKER', true);

// Page text read before API-798 moves from the database into encrypted files, in the background;
// tried again every minute while the document store (or the database) is unavailable.
const migrateTranscriptions = () =>
  service.migrateTranscriptions().then(
    n => {
      if (n) {
        app.log.info({documents: n}, 'page text moved into encrypted files');
      }
    },
    err => {
      app.log.warn(
        {err: err.message},
        'page text not moved into files yet; trying again in a minute',
      );
      setTimeout(migrateTranscriptions, 60_000).unref();
    },
  );

await startService(app, {
  port: envInt('PORT', 3504),
  checks: [
    ...checks,
    async () => {
      if (runWorker) worker.start();
      migrateTranscriptions();
    },
  ],
  onClose: async () => {
    worker.stop();
    await service.events.close();
    await sequelize?.close();
  },
});
