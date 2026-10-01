import { env, envInt, envList, startService } from '@lrfe/common';
import { buildApp } from './app.js';

const app = await buildApp({
    upstreams: {
        identity: env('IDENTITY_URL', 'http://localhost:3501'),
        edrms: env('EDRMS_URL', 'http://localhost:3502'),
        bpm: env('BPM_URL', 'http://localhost:3503'),
        intake: env('INTAKE_URL', 'http://localhost:3504')
    },
    corsOrigins: envList('CORS_ORIGINS', 'http://localhost:4200'),
    logger: { level: env('LOG_LEVEL', 'info') }
});

await startService(app, { port: envInt('PORT', 3500) });
