import {env, envInt, envList, startService} from '@lrfe/common';
import {PUBLIC_RATE_LIMIT, buildApp} from './app.js';

const app = await buildApp({
  upstreams: {
    identity: env('IDENTITY_URL', 'http://localhost:3501'),
    edrms: env('EDRMS_URL', 'http://localhost:3502'),
    bpm: env('BPM_URL', 'http://localhost:3503'),
    intake: env('INTAKE_URL', 'http://localhost:3504'),
    'land-records': env('RECORDS_URL', 'http://localhost:3505'),
    audit: env('AUDIT_URL', 'http://localhost:3506'),
    extracts: env('EXTRACTS_URL', 'http://localhost:3507'),
  },
  corsOrigins: envList('CORS_ORIGINS', 'http://localhost:4200'),
  // the public check of an extract: requests per client address per window (API-693)
  publicRateLimit: {
    max: envInt('PUBLIC_RATE_LIMIT_MAX', PUBLIC_RATE_LIMIT.max),
    timeWindow: envInt(
      'PUBLIC_RATE_LIMIT_WINDOW_MS',
      PUBLIC_RATE_LIMIT.timeWindow,
    ),
  },
  logger: {level: env('LOG_LEVEL', 'info')},
});

await startService(app, {port: envInt('PORT', 3500)});
